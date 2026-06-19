#!/usr/bin/env node
// Model Server MCP server for Hermes Agent (https://hermes-agent.nousresearch.com).
//
// Hermes consumes external tools over the Model Context Protocol. This stdio
// MCP server is launched by Hermes (via the `mcp_servers.modelserver` entry in
// ~/.hermes/config.yaml) and on connect:
//   1. Pulls the user's skill catalog from /api/skills with the bearer key.
//   2. Exposes every enabled skill as an MCP tool whose call proxies to
//      /api/skills/:name/execute, so the 120+ default skills become callable
//      from any Hermes conversation.
//   3. Adds a host<->server-workspace file bridge (auto-upload host paths,
//      workspace_get to pull outputs back), so server-side sandbox skills
//      (create_pdf, read_pdf, transform_image, …) Just Work on host files.
//
// The OpenAI-compatible provider itself is configured separately as a native
// Hermes `custom_providers` entry pointing at <baseUrl>/v1 — no code needed for
// that half (Hermes speaks OpenAI natively). This server is only the tools half.
//
// Required env vars (set by Hermes from the mcp_servers.env block):
//   MODELSERVER_BASE_URL   e.g. https://localhost:3001
//   MODELSERVER_API_KEY    bearer-mode key created in the API Keys tab
//
// Optional:
//   MODELSERVER_INSECURE_TLS=1         accept self-signed certs (default for
//                                      localhost / RFC-1918 addresses)
//   MODELSERVER_INCLUDE_LOCAL_SHADOW=1 also register skills that shadow Hermes'
//                                      built-in local tools (read_file,
//                                      list_directory, run_*, git_*, …). Off by
//                                      default — the modelserver versions target
//                                      /workspace inside the webapp container,
//                                      not the user's $PWD.
//
// IMPORTANT (stdio MCP): stdout is the JSON-RPC channel. NEVER write to stdout
// (no console.log). All diagnostics go to stderr via console.error.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { basename, dirname } from "path";

// Largest host file the auto-bridge will upload into the server workspace.
const MAX_BRIDGE_BYTES = 50 * 1024 * 1024;

// __MODELSERVER_BASE_URL__ is replaced by the webapp at serve time
// (/api/hermes/files/modelserver-mcp.mjs) so the file already knows where to
// phone home even when the env var is missing.
const SERVER_BAKED_BASE_URL = "__MODELSERVER_BASE_URL__";

// A few catalog entries are stubs (no def execute) because the real
// implementation is a chat-side native registered in webapp/services/
// chatTools.js, reachable only via /api/chat/stream. From Hermes we route
// around the stub and hit the relevant first-party endpoint directly.
const NATIVE_TOOL_ROUTES = {
    web_search: {
        method: "GET",
        path: (a) => {
            const q = encodeURIComponent(String(a?.query ?? a?.q ?? ""));
            const limit = Number(a?.maxResults ?? a?.limit ?? 5);
            const fc = a?.fetchContent === false ? "false" : "true";
            return `/api/search?q=${q}&limit=${limit}&fetchContent=${fc}`;
        }
    },
    playwright_fetch: { method: "POST", path: "/api/playwright/fetch" },
    playwright_interact: { method: "POST", path: "/api/playwright/interact" },
};

// Skills that look like local-cwd ops but actually execute inside the webapp
// container's sandbox — the model would call list_directory and see
// /workspace, not the user's $PWD. Hermes ships its own built-in tools (read,
// bash, edit, write, search) for local files; skipping these keeps the model
// on Hermes' local-file path by default.
//
// Set MODELSERVER_INCLUDE_LOCAL_SHADOW=1 to register these too. Useful when
// running Hermes on the same box as the modelserver and you actually want
// server-side fs access (e.g. to inspect /workspace artifacts).
const LOCAL_SHADOW_SKILLS = new Set([
    // file r/w
    "read_file", "tail_file", "head_file",
    "create_file", "update_file", "append_to_file", "write_to_file",
    "delete_file", "delete_directory", "create_directory",
    "move_file", "copy_file",
    "list_directory", "search_files",
    "get_file_metadata", "hash_file",
    // edit
    "search_replace_file", "replace_lines",
    // code navigation (server fs)
    "grep_code", "outline_file", "scan_source_files", "analyze_code",
    // shell / exec
    "run_python", "run_node", "run_npm", "run_powershell",
    // git (operates on server-side repos cloned via git_clone_shallow)
    "git_status", "git_diff", "git_log", "git_branch",
    "git_clone_shallow", "git_show_commit", "git_blame",
    "git_file_history", "git_list_tree",
    // archives (server fs)
    "tar_extract", "tar_create", "unzip_file", "zip_files",
    "diff_files",
    // host inventory — server's, not user's
    "system_info", "list_processes", "disk_usage", "get_uptime",
    "list_ports", "list_services", "which_command",
    "get_env_var", "set_env_var",
    // chat-only artifact plumbing
    "make_downloadable", "screenshot", "download_file",
]);

// Canonical working model, attached to workspace_get (always registered).
const HOST_FIRST_DOCTRINE =
    "[HOST-FIRST WORKING MODEL] Your primary filesystem is the user's LOCAL HOST — " +
    "use your built-in read / write / edit / bash for ALL file work (the user's " +
    "files live on the host: the current directory, /mnt/c/..., etc.). The model " +
    "server's skills (create_pdf, html_to_pdf, transform_image, read_pdf, read_xlsx, " +
    "query_sqlite, …) run in a SEPARATE sandbox; you do NOT manage its filesystem. " +
    "Pass real HOST paths to those skills — host files are uploaded for you " +
    "automatically. Use workspace_get(workspacePath, hostPath) to copy a skill's " +
    "OUTPUT (e.g. 'artifacts/<name>') back to the host. Never create, list, or rely " +
    "on files under /workspace yourself.";

// Shorter override prepended to any sandbox skill whose prompt still talks about
// /workspace or create_file (those notes are written for the web chat UI).
const HOST_FIRST_OVERRIDE =
    "[HERMES: HOST-FIRST] Pass real host file paths to this skill — they are uploaded " +
    "to the sandbox automatically; do NOT use create_file or /workspace. Retrieve " +
    "any output with workspace_get(workspacePath, hostPath). The /workspace and " +
    "create_file mentions below are for the web chat UI only — ignore them here.\n\n";

const baseUrl = (process.env.MODELSERVER_BASE_URL || SERVER_BAKED_BASE_URL).replace(/\/+$/, "");
const apiKey = process.env.MODELSERVER_API_KEY;

const insecure = process.env.MODELSERVER_INSECURE_TLS === "1" || isPrivateOrLoopbackUrl(baseUrl);
if (insecure && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const authedFetch = (path, init = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
        "Authorization": `Bearer ${apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {})
    }
});

// ---- host <-> server-workspace bridge ---------------------------------------
const uploadHostFileToWorkspace = async (hostPath) => {
    const base = basename(hostPath);
    const buf = fs.readFileSync(hostPath);
    const r = await fetch(`${baseUrl}/api/agent-workspaces/file?path=${encodeURIComponent(base)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/octet-stream" },
        body: buf,
    });
    if (!r.ok) throw new Error(`workspace upload failed: HTTP ${r.status}`);
    return base;
};

// Heuristic: a string that names an existing host FILE, small enough to ship.
// Gate purely on real host existence so ordinary string args are never touched.
// We intentionally do NOT exclude "/workspace/..." paths: Hermes' own write tool
// can create a host file under a /workspace dir, and the agent then passes that
// path to a server skill — the server's /workspace is a different filesystem, so
// that file must still be uploaded. A path that's only in the SERVER workspace
// won't exist on the host, so statSync fails and we leave it alone.
const isBridgeableHostFile = (v) => {
    if (typeof v !== "string" || !v) return false;
    if (!(v.includes("/") || v.includes("\\") || /^[A-Za-z]:/.test(v))) return false;
    try {
        const st = fs.statSync(v);
        return st.isFile() && st.size > 0 && st.size <= MAX_BRIDGE_BYTES;
    } catch { return false; }
};

// Transparently upload any host-file path argument to the workspace and rewrite
// the arg to the ABSOLUTE /workspace/<basename>. Best-effort: on any failure the
// original arg is left untouched.
const autoBridgeHostFiles = async (args) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    let out = null;
    for (const [k, v] of Object.entries(args)) {
        if (!isBridgeableHostFile(v)) continue;
        try {
            const base = await uploadHostFileToWorkspace(v);
            if (!out) out = { ...args };
            out[k] = "/workspace/" + base;
            console.error(`[modelserver-mcp] auto-bridged host file ${v} -> /workspace/${base}`);
        } catch (e) {
            console.error(`[modelserver-mcp] auto-bridge failed for ${v}:`, e.message);
        }
    }
    return out || args;
};

// Build the tool catalog once (memoized). Mirrors the Pi extension: register
// every enabled skill that has a real `def execute` or a native HTTP fallback,
// skipping stub entries and local-shadow skills.
let catalogPromise = null;
function loadCatalog() {
    if (!catalogPromise) catalogPromise = buildCatalog();
    return catalogPromise;
}

async function buildCatalog() {
    const includeLocalShadow = process.env.MODELSERVER_INCLUDE_LOCAL_SHADOW === "1";
    const tools = [];           // MCP tool descriptors for tools/list
    const dispatch = new Map();  // name -> { nativeRoute }
    let skippedStub = 0, skippedShadow = 0;

    let skills = [];
    try {
        const r = await authedFetch("/api/skills");
        if (!r.ok) {
            console.error(`[modelserver-mcp] /api/skills returned ${r.status}; tool catalog empty.`);
        } else {
            skills = await r.json();
        }
    } catch (e) {
        console.error("[modelserver-mcp] failed to load skill catalog:", e.message);
    }

    for (const skill of (Array.isArray(skills) ? skills : [])) {
        if (!skill || !skill.name || skill.enabled === false) continue;

        const nativeRoute = NATIVE_TOOL_ROUTES[skill.name];
        const code = String(skill.code || "");
        const hasExecute = /\bdef\s+execute\s*\(/.test(code);

        if (!hasExecute && !nativeRoute) { skippedStub++; continue; }
        if (!includeLocalShadow && LOCAL_SHADOW_SKILLS.has(skill.name)) { skippedShadow++; continue; }

        const baseDescription = skill.description
            || (skill.systemPrompt ? skill.systemPrompt.split(/[.\n]/)[0] : skill.name);
        const rawPrompt = skill.systemPrompt || "";
        const pushesWorkspace = /\/workspace|create_file|append_to_file/.test(rawPrompt + " " + baseDescription);
        const promptSnippet = pushesWorkspace ? HOST_FIRST_OVERRIDE + rawPrompt : rawPrompt;
        // MCP has no separate "prompt snippet" field — fold the skill's guidance
        // into the tool description (the model reads it the same way).
        const description = promptSnippet
            ? `${baseDescription}\n\n${promptSnippet}`.slice(0, 8000)
            : baseDescription;

        tools.push({
            name: skill.name,
            description,
            inputSchema: jsonSchemaForParams(skill.parameters || {}),
        });
        dispatch.set(skill.name, { nativeRoute });
    }

    // workspace_get: pull a file from the server workspace back to the host.
    tools.push({
        name: "workspace_get",
        description:
            "Copy a file FROM the server workspace TO your local machine. " +
            "Use it to deliver outputs that server skills produced — e.g. after create_pdf, " +
            "workspace_get('artifacts/report.pdf', '/mnt/c/Users/you/Desktop/report.pdf'). " +
            "workspacePath is relative to /workspace (rendered files land under 'artifacts/'). " +
            "The reverse direction is automatic — when you pass a host path to a server skill " +
            "(read_pdf, create_pdf contentFile, transform_image, …) the file is uploaded for you.\n\n" +
            HOST_FIRST_DOCTRINE,
        inputSchema: {
            type: "object",
            properties: {
                workspacePath: { type: "string", description: "Path inside the server workspace, e.g. 'artifacts/report.pdf' or 'report.md'" },
                hostPath: { type: "string", description: "Absolute destination path on the local machine" },
            },
            required: ["workspacePath", "hostPath"],
        },
    });
    dispatch.set("workspace_get", { builtin: "workspace_get" });

    if (skippedStub > 0) console.error(`[modelserver-mcp] skipped ${skippedStub} stub skill(s) with no def execute and no native route`);
    if (skippedShadow > 0) console.error(`[modelserver-mcp] skipped ${skippedShadow} skill(s) that shadow local tools (set MODELSERVER_INCLUDE_LOCAL_SHADOW=1 to register them)`);
    console.error(`[modelserver-mcp] exposing ${tools.length} tool(s) from ${baseUrl}`);
    return { tools, dispatch };
}

async function callSkill(name, args, signal) {
    const { dispatch } = await loadCatalog();
    const entry = dispatch.get(name);
    if (!entry) throw new Error(`unknown tool: ${name}`);

    if (entry.builtin === "workspace_get") return workspaceGet(args, signal);

    const { nativeRoute } = entry;
    let r;
    if (nativeRoute) {
        const path = typeof nativeRoute.path === "function" ? nativeRoute.path(args) : nativeRoute.path;
        const init = { method: nativeRoute.method, signal };
        if (nativeRoute.method === "POST") {
            const body = nativeRoute.mapBody ? nativeRoute.mapBody(args) : args;
            init.body = JSON.stringify(body ?? {});
        }
        r = await authedFetch(path, init);
    } else {
        // Auto-bridge host-file path args into the server workspace first.
        const bridged = await autoBridgeHostFiles(args);
        r = await authedFetch(`/api/skills/${encodeURIComponent(name)}/execute`, {
            method: "POST",
            body: JSON.stringify(bridged ?? {}),
            signal,
        });
    }
    const raw = await r.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
    if (!r.ok) {
        const msg = (parsed && parsed.error) ? parsed.error : `HTTP ${r.status}`;
        throw new Error(`[${name}] ${msg}`);
    }
    // Skills that write files drop them in the sandbox at /workspace/artifacts/
    // and return `_artifacts`. Absolutize the URL, drop the misleading chat-UI
    // note, and rewrite into host-correct download guidance.
    if (parsed && typeof parsed === "object" && Array.isArray(parsed._artifacts) && parsed._artifacts.length) {
        for (const a of parsed._artifacts) {
            if (a && typeof a.url === "string" && a.url.startsWith("/")) a.url = `${baseUrl}${a.url}`;
        }
        if ("note" in parsed) delete parsed.note;
        return describeArtifacts(parsed, insecure);
    }
    return summarize(parsed);
}

async function workspaceGet(a, signal) {
    const wp = String(a?.workspacePath || "").replace(/^\/workspace\/?/, "");
    const hp = String(a?.hostPath || "");
    if (!wp || !hp) throw new Error("workspace_get needs workspacePath and hostPath");
    const r = await fetch(`${baseUrl}/api/agent-workspaces/file?path=${encodeURIComponent(wp)}`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal,
    });
    if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(`[workspace_get] ${msg}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(dirname(hp), { recursive: true });
    fs.writeFileSync(hp, buf);
    return `Saved ${buf.length} bytes to ${hp}`;
}

// ---- MCP wiring -------------------------------------------------------------
async function main() {
    if (!apiKey) {
        console.error("[modelserver-mcp] MODELSERVER_API_KEY not set; refusing to start.");
        process.exit(1);
    }
    const server = new Server(
        { name: "modelserver", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const { tools } = await loadCatalog();
        return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};
        try {
            const text = await callSkill(name, args, undefined);
            return { content: [{ type: "text", text: text ?? "" }] };
        } catch (e) {
            return { content: [{ type: "text", text: String(e?.message || e) }], isError: true };
        }
    });

    await server.connect(new StdioServerTransport());
    console.error(`[modelserver-mcp] connected (base ${baseUrl}${insecure ? ", insecure TLS" : ""})`);
}

main().catch((e) => {
    console.error("[modelserver-mcp] fatal:", e);
    process.exit(1);
});

// ---- helpers ----------------------------------------------------------------

// Self-hosted modelserver deployments typically use a self-signed cert. Any URL
// pointing at localhost or an RFC-1918 / IPv6 unique-local address is almost
// certainly an internal install — auto-relax TLS so LAN users don't have to set
// MODELSERVER_INSECURE_TLS=1. Public-IP / DNS hostnames keep strict verification.
function isPrivateOrLoopbackUrl(u) {
    try {
        const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
        if (host === "localhost") return true;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const [a, b] = host.split(".").map(Number);
            if (a === 127) return true;
            if (a === 10) return true;
            if (a === 192 && b === 168) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            if (a === 169 && b === 254) return true;
            return false;
        }
        if (host === "::1") return true;
        const lower = host.toLowerCase();
        if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
        if (lower.startsWith("fe80:")) return true;
        return false;
    } catch {
        return false;
    }
}

function jsonSchemaForParams(params) {
    const properties = {};
    for (const [key, decl] of Object.entries(params)) {
        const typeName = (typeof decl === "string" ? decl : decl?.type || "string").toLowerCase();
        switch (typeName) {
            case "number": case "integer": case "int": case "float":
                properties[key] = { type: "number" }; break;
            case "boolean": case "bool":
                properties[key] = { type: "boolean" }; break;
            case "array": case "list":
                properties[key] = { type: "array", items: {} }; break;
            case "object": case "dict": case "map":
                properties[key] = { type: "object" }; break;
            default:
                properties[key] = { type: "string" };
        }
    }
    return { type: "object", properties };
}

// Server-side skills write generated files into the webapp container's sandbox
// (/workspace/artifacts/) and return `_artifacts` with a download URL. In the
// web chat UI those surface as download chips; in Hermes there is no chip and
// the sandbox is a different filesystem, so the only way to deliver a file is to
// pull it via workspace_get (or curl with the bearer key).
function describeArtifacts(parsed, insecure) {
    const arts = (parsed._artifacts || []);
    const kFlag = insecure ? " -k" : "";
    const lines = [];
    lines.push(
        `Generated ${arts.length} file(s) on the model server — these live in the ` +
        `server-side sandbox, NOT on your local filesystem. The /workspace/... path in ` +
        `the result does not exist on your machine, so do NOT cp it. To deliver a file ` +
        `to the location the user asked for, call workspace_get:`
    );
    for (const a of arts) {
        const sz = typeof a.size === "number" ? ` (${a.size} bytes)` : "";
        lines.push("");
        lines.push(`• ${a.name}${sz}`);
        lines.push(`  workspace_get("artifacts/${a.name}", "<DEST_PATH>/${a.name}")`);
        lines.push(`  (or: curl -fsSL${kFlag} -H "Authorization: Bearer $MODELSERVER_API_KEY" "${a.url}" -o "<DEST_PATH>/${a.name}")`);
    }
    lines.push("");
    lines.push(`Replace <DEST_PATH> with the directory the user wants. workspace_get creates parent dirs for you and needs no auth handling.`);
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        lines.push("");
        lines.push(parsed.summary.trim());
    }
    return lines.join("\n");
}

function summarize(payload) {
    if (payload == null) return "";
    if (typeof payload === "string") return payload;
    if (typeof payload.content === "string") return payload.content;
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.output === "string") return payload.output;
    if (payload.success === false && payload.error) return `Error: ${payload.error}`;
    try {
        const json = JSON.stringify(payload, null, 2);
        return json.length > 12000 ? json.slice(0, 12000) + "\n…[truncated]" : json;
    } catch {
        return String(payload);
    }
}
