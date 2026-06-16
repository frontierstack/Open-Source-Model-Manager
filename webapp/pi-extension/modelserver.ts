// Model Server extension for Pi (https://pi.dev).
//
// On load, this extension:
//   1. Registers the local model server as an OpenAI-compatible provider
//      named "modelserver", populated from /v1/models.
//   2. Fetches /api/skills with the user's bearer key and registers every
//      enabled skill as a Pi tool. Each tool's execute handler proxies to
//      /api/skills/:name/execute, so the 120+ default skills become callable
//      from any conversation.
//
// Required env vars (set before launching `pi`):
//   MODELSERVER_BASE_URL   e.g. https://localhost:3001
//   MODELSERVER_API_KEY    bearer-mode key created in the API Keys tab
//
// Optional:
//   MODELSERVER_INSECURE_TLS=1         accept self-signed certs (default for
//                                      localhost / RFC-1918 addresses)
//   MODELSERVER_INCLUDE_LOCAL_SHADOW=1 also register skills that shadow Pi's
//                                      built-in local tools (read_file,
//                                      list_directory, git_status, run_*, …).
//                                      Off by default so Pi operates on the
//                                      user's $PWD via Pi's own bash/read/
//                                      edit/write — the modelserver versions
//                                      target /workspace inside the webapp
//                                      container, which is rarely what you
//                                      want when running pi as a CLI agent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Pi migrated from `@sinclair/typebox` 0.34 to the rebranded `typebox` 1.x in
// 0.69.0; new extensions should import from `typebox` (the legacy
// `@sinclair/typebox` root alias still works but is deprecated). The Type
// builder API and emitted JSON-Schema shape are identical for what we use.
import { Type } from "typebox";
import * as fs from "fs";
import { basename, dirname } from "path";

// Largest host file the auto-bridge will upload into the server workspace.
const MAX_BRIDGE_BYTES = 50 * 1024 * 1024;

interface SkillParam {
    [key: string]: string | { type?: string };
}

interface Skill {
    id?: string;
    name: string;
    description?: string;
    systemPrompt?: string;
    parameters?: SkillParam;
    enabled?: boolean;
    code?: string;
}

// A few catalog entries are stubs (no def execute) because the real
// implementation is a chat-side native registered in webapp/services/
// chatTools.js, reachable only via /api/chat/stream. From Pi we route
// around the stub and hit the relevant first-party endpoint directly.
type NativeRoute = {
    method: "GET" | "POST";
    path: string | ((args: any) => string);
    mapBody?: (args: any) => any;
};
const NATIVE_TOOL_ROUTES: Record<string, NativeRoute> = {
    web_search: {
        method: "GET",
        path: (a: any) => {
            const q = encodeURIComponent(String(a?.query ?? a?.q ?? ""));
            const limit = Number(a?.maxResults ?? a?.limit ?? 5);
            const fc = a?.fetchContent === false ? "false" : "true";
            return `/api/search?q=${q}&limit=${limit}&fetchContent=${fc}`;
        }
    },
    playwright_fetch: {
        method: "POST",
        path: "/api/playwright/fetch"
    },
    playwright_interact: {
        method: "POST",
        path: "/api/playwright/interact"
    },
};

interface ModelInfo {
    id: string;
    name?: string;
    context_window?: number;
    max_tokens?: number;
}

// __MODELSERVER_BASE_URL__ is replaced by the webapp at serve time
// (/api/pi/extension/modelserver.ts) so the file already knows where
// to phone home even when the user forgets to export the env var.
const SERVER_BAKED_BASE_URL = "__MODELSERVER_BASE_URL__";

// Skills that look like local-cwd ops but actually execute inside the
// webapp container's sandbox — the model would call list_directory and
// see /workspace, not the user's $PWD. Pi already ships built-in tools
// (read, bash, edit, write, search) for local files; skipping these
// keeps the model on Pi's local-file path by default.
//
// Set MODELSERVER_INCLUDE_LOCAL_SHADOW=1 to register these too. Useful
// when running pi on the same box as the modelserver and you actually
// want server-side fs access (e.g. to inspect /workspace artifacts).
const LOCAL_SHADOW_SKILLS = new Set<string>([
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

// HOST-FIRST. We do NOT register the server's workspace file tools
// (create_file / append_to_file / read_file / list_directory) for Pi — they
// stay shadowed (LOCAL_SHADOW_SKILLS). The agent's primary filesystem is the
// user's host: it uses Pi's own read/write/edit/bash for all file work. The
// server /workspace exists only for sandbox skills (create_pdf, html_to_pdf,
// transform_image, read_pdf, …), and the auto-bridge moves host files in and
// workspace_get moves outputs back — so the agent never has to touch /workspace
// directly. (Earlier the workspace file tools were registered to assemble a
// contentFile in /workspace; the auto-bridge made that unnecessary and the
// extra tools just made the model treat /workspace as a general FS.)

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
    "[PI: HOST-FIRST] Pass real host file paths to this skill — they are uploaded " +
    "to the sandbox automatically; do NOT use create_file or /workspace. Retrieve " +
    "any output with workspace_get(workspacePath, hostPath). The /workspace and " +
    "create_file mentions below are for the web chat UI only — ignore them here.\n\n";

export default async function (pi: ExtensionAPI) {
    const baseUrl = (process.env.MODELSERVER_BASE_URL || SERVER_BAKED_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env.MODELSERVER_API_KEY;

    if (!apiKey) {
        console.warn("[modelserver] MODELSERVER_API_KEY not set; skill catalog and provider registration skipped.");
        return;
    }

    const insecure = process.env.MODELSERVER_INSECURE_TLS === "1"
        || isPrivateOrLoopbackUrl(baseUrl);

    if (insecure && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    const authedFetch = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(init.headers || {})
        }
    });

    // ---- host <-> server-workspace bridge -----------------------------------
    // Pi lives on the user's machine; the model server's skills (read_pdf,
    // create_pdf, transform_image, …) run in a sandbox whose /workspace is a
    // DIFFERENT filesystem. Without a bridge the agent can't feed a host file
    // to a server skill (it just gets "file not found" because the server
    // rewrites the path to /workspace/<basename>). These helpers carry bytes
    // across: upload pushes a host file into the caller's agent-<keyId> bucket
    // (so the very next skill call sees it at /workspace/<basename>); download
    // pulls a workspace file back out to the host.
    const uploadHostFileToWorkspace = async (hostPath: string): Promise<string> => {
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

    // Heuristic: a string that names an existing host FILE, small enough to
    // ship. Gate purely on real host existence (fs.statSync) so ordinary string
    // args are never touched. We intentionally do NOT exclude "/workspace/..."
    // paths: Pi's own write tool can create a host file under a /workspace dir
    // (e.g. /workspace/artifacts/foo.html), and the agent then passes that path
    // to a server skill — the server's /workspace is a different filesystem, so
    // that file must still be uploaded. A path that's only in the SERVER
    // workspace (created via create_file) simply won't exist on the host, so
    // statSync fails and we leave it alone.
    const isBridgeableHostFile = (v: unknown): v is string => {
        if (typeof v !== "string" || !v) return false;
        if (!(v.includes("/") || v.includes("\\") || /^[A-Za-z]:/.test(v))) return false;
        try {
            const st = fs.statSync(v);
            return st.isFile() && st.size > 0 && st.size <= MAX_BRIDGE_BYTES;
        } catch { return false; }
    };

    // Transparently upload any host-file path argument to the workspace and
    // rewrite the arg to the ABSOLUTE /workspace/<basename>, so the agent can
    // pass real host paths to server skills and have them Just Work. Absolute
    // is required because some skills resolve the path literally (html_to_pdf
    // does os.path.exists(htmlPath) with no /workspace join); absolute also
    // works for create_pdf's contentFile and for PATH_ARG_NAMES rewriting.
    // Best-effort: on any failure the original arg is left untouched.
    const autoBridgeHostFiles = async (args: any): Promise<any> => {
        if (!args || typeof args !== "object" || Array.isArray(args)) return args;
        let out: Record<string, unknown> | null = null;
        for (const [k, v] of Object.entries(args)) {
            if (!isBridgeableHostFile(v)) continue;
            try {
                const base = await uploadHostFileToWorkspace(v);
                if (!out) out = { ...args };
                out[k] = "/workspace/" + base;
                console.error(`[modelserver] auto-bridged host file ${v} -> /workspace/${base}`);
            } catch (e) {
                console.error(`[modelserver] auto-bridge failed for ${v}:`, (e as Error).message);
            }
        }
        return out || args;
    };

    // 1) Register the model server as an OpenAI-compatible provider.
    try {
        const r = await authedFetch("/v1/models");
        if (r.ok) {
            const payload = await r.json() as { data?: ModelInfo[] };
            const models = (payload.data || []).map((m) => ({
                id: m.id,
                name: m.name ?? m.id,
                reasoning: false,
                input: ["text"] as const,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: m.context_window ?? 32768,
                maxTokens: m.max_tokens ?? 4096
            }));
            (pi as any).registerProvider("modelserver", {
                baseUrl: `${baseUrl}/v1`,
                // Pi resolves `apiKey` as a config-value template: a leading
                // `$` (or `${VAR}`) interpolates the environment variable; a
                // bare string is treated as a LITERAL. So this MUST be
                // "$MODELSERVER_API_KEY" — without the `$`, Pi would send
                // `Authorization: Bearer MODELSERVER_API_KEY` (the literal
                // name) and every model call 401s.
                apiKey: "$MODELSERVER_API_KEY",
                api: "openai-completions",
                models
            });
        } else {
            console.warn(`[modelserver] /v1/models returned ${r.status}; provider not registered.`);
        }
    } catch (e) {
        console.error("[modelserver] failed to register provider:", e);
    }

    // 2) Pull the skill catalog and expose each as a Pi tool.
    let skills: Skill[] = [];
    try {
        const r = await authedFetch("/api/skills");
        if (!r.ok) {
            console.warn(`[modelserver] /api/skills returned ${r.status}; tool catalog empty.`);
            return;
        }
        skills = await r.json() as Skill[];
    } catch (e) {
        console.error("[modelserver] failed to load skill catalog:", e);
        return;
    }

    const includeLocalShadow = process.env.MODELSERVER_INCLUDE_LOCAL_SHADOW === "1";
    let registered = 0;
    let skippedStub = 0;
    let skippedShadow = 0;
    for (const skill of skills) {
        if (!skill || !skill.name || skill.enabled === false) continue;

        const nativeRoute = NATIVE_TOOL_ROUTES[skill.name];
        const code = String(skill.code || "");
        const hasExecute = /\bdef\s+execute\s*\(/.test(code);

        // Skip stub catalog entries that have no working Python and no
        // native HTTP fallback — registering them would just give the
        // model "name 'execute' is not defined" on dispatch.
        if (!hasExecute && !nativeRoute) {
            skippedStub++;
            continue;
        }

        // Skip server-fs / host-inventory skills that shadow Pi's built-in
        // local tools (read/write/edit/bash). Without this the model sees both
        // and routinely picks the modelserver one — operating on the server
        // /workspace instead of the user's host. HOST-FIRST: file ops stay
        // shadowed; the agent works on the host and the auto-bridge handles
        // sandbox skill inputs.
        if (!includeLocalShadow && LOCAL_SHADOW_SKILLS.has(skill.name)) {
            skippedShadow++;
            continue;
        }

        const params = toTypeboxSchema(skill.parameters || {});
        const baseDescription = skill.description
            || (skill.systemPrompt ? skill.systemPrompt.split(/[.\n]/)[0] : skill.name);
        // Sandbox skills whose chat-written prompt pushes /workspace or
        // create_file get a HOST-FIRST override prepended so the Pi agent
        // doesn't follow that web-chat-only guidance.
        const rawPrompt = skill.systemPrompt || "";
        const pushesWorkspace = /\/workspace|create_file|append_to_file/.test(rawPrompt + " " + baseDescription);
        const description = baseDescription;
        const promptSnippet = pushesWorkspace
            ? HOST_FIRST_OVERRIDE + rawPrompt
            : (rawPrompt || undefined);

        try {
            (pi as any).registerTool({
                name: skill.name,
                label: skill.name,
                description,
                promptSnippet,
                parameters: params,
                async execute(_toolCallId: string, args: unknown, signal: AbortSignal | undefined) {
                    let r: Response;
                    if (nativeRoute) {
                        const path = typeof nativeRoute.path === "function"
                            ? nativeRoute.path(args)
                            : nativeRoute.path;
                        const init: RequestInit = { method: nativeRoute.method, signal };
                        if (nativeRoute.method === "POST") {
                            const body = nativeRoute.mapBody ? nativeRoute.mapBody(args) : args;
                            init.body = JSON.stringify(body ?? {});
                        }
                        r = await authedFetch(path, init);
                    } else {
                        // Auto-bridge: ship any host-file path args into the
                        // server workspace first so this skill can read them.
                        const bridged = await autoBridgeHostFiles(args);
                        r = await authedFetch(`/api/skills/${encodeURIComponent(skill.name)}/execute`, {
                            method: "POST",
                            body: JSON.stringify(bridged ?? {}),
                            signal
                        });
                    }
                    const raw = await r.text();
                    let parsed: any;
                    try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
                    if (!r.ok) {
                        const msg = (parsed && parsed.error) ? parsed.error : `HTTP ${r.status}`;
                        throw new Error(`[${skill.name}] ${msg}`);
                    }
                    // Skills that write files (create_pdf, create_docx,
                    // create_xlsx, render_chart, image transforms, …) drop them
                    // in the server-side sandbox at /workspace/artifacts/ and
                    // return `_artifacts: [{ name, url, … }]`. Two things break
                    // this for Pi: (1) the URL is relative to the webapp, and
                    // (2) the skills bake in a chat-UI note ("shown as a
                    // download chip — do NOT copy_file") that is actively wrong
                    // here — there is no chip in a terminal, the copy/move
                    // skills aren't even registered (LOCAL_SHADOW_SKILLS), and
                    // the sandbox path does not exist on the user's machine.
                    // Absolutize the URL, drop the misleading note, and rewrite
                    // the result into host-correct download guidance so the
                    // agent fetches the file to wherever the user asked instead
                    // of cp-ing from a /workspace path that isn't on its fs.
                    if (parsed && typeof parsed === "object"
                        && Array.isArray(parsed._artifacts) && parsed._artifacts.length) {
                        for (const a of parsed._artifacts) {
                            if (a && typeof a.url === "string" && a.url.startsWith("/")) {
                                a.url = `${baseUrl}${a.url}`;
                            }
                        }
                        if ("note" in parsed) delete parsed.note;
                        return {
                            content: [{ type: "text", text: describeArtifacts(parsed, insecure) }],
                            details: parsed
                        };
                    }
                    return {
                        content: [{ type: "text", text: summarize(parsed) }],
                        details: parsed
                    };
                }
            });
            registered++;
        } catch (e) {
            console.error(`[modelserver] failed to register skill ${skill.name}:`, e);
        }
    }
    // workspace_get: pull a file from the server workspace back to the host.
    // The other half of the bridge — host->workspace is automatic (any host
    // path passed to a server skill is uploaded), but delivering a *result*
    // (a rendered PDF in /workspace/artifacts/, a transformed image, …) to a
    // specific place on the user's machine needs an explicit destination.
    try {
        (pi as any).registerTool({
            name: "workspace_get",
            label: "workspace_get",
            description:
                "Copy a file FROM the server workspace TO your local machine. " +
                "Use it to deliver outputs that server skills produced — e.g. after create_pdf, " +
                "workspace_get('artifacts/report.pdf', '/mnt/c/Users/you/Desktop/report.pdf'). " +
                "workspacePath is relative to /workspace (rendered files land under 'artifacts/'). " +
                "The reverse direction is automatic — when you pass a host path to a server skill " +
                "(read_pdf, create_pdf contentFile, transform_image, …) the file is uploaded for you.",
            promptSnippet: HOST_FIRST_DOCTRINE,
            parameters: Type.Object({
                workspacePath: Type.String({ description: "Path inside the server workspace, e.g. 'artifacts/report.pdf' or 'report.md'" }),
                hostPath: Type.String({ description: "Absolute destination path on the local machine" }),
            }),
            async execute(_id: string, a: any, signal: AbortSignal | undefined) {
                const wp = String(a?.workspacePath || "").replace(/^\/workspace\/?/, "");
                const hp = String(a?.hostPath || "");
                if (!wp || !hp) throw new Error("workspace_get needs workspacePath and hostPath");
                const r = await fetch(`${baseUrl}/api/agent-workspaces/file?path=${encodeURIComponent(wp)}`, {
                    headers: { "Authorization": `Bearer ${apiKey}` },
                    signal,
                });
                if (!r.ok) {
                    let msg = `HTTP ${r.status}`;
                    try { const j = await r.json() as any; if (j?.error) msg = j.error; } catch { /* ignore */ }
                    throw new Error(`[workspace_get] ${msg}`);
                }
                const buf = Buffer.from(await r.arrayBuffer());
                fs.mkdirSync(dirname(hp), { recursive: true });
                fs.writeFileSync(hp, buf);
                return {
                    content: [{ type: "text", text: `Saved ${buf.length} bytes to ${hp}` }],
                    details: { hostPath: hp, bytes: buf.length },
                };
            },
        });
        registered++;
    } catch (e) {
        console.error("[modelserver] failed to register workspace_get:", e);
    }

    if (skippedStub > 0) {
        console.warn(`[modelserver] skipped ${skippedStub} stub skill(s) with no def execute and no native route`);
    }
    if (skippedShadow > 0) {
        console.warn(`[modelserver] skipped ${skippedShadow} skill(s) that shadow Pi's local tools (set MODELSERVER_INCLUDE_LOCAL_SHADOW=1 to register them)`);
    }
    void registered;
}

// Self-hosted modelserver deployments typically use a self-signed cert.
// Any URL pointing at localhost or an RFC-1918 / IPv6 unique-local address
// is almost certainly an internal install — auto-relax TLS verification
// so users on a LAN don't have to manually export MODELSERVER_INSECURE_TLS=1.
// Public-IP / DNS hostnames keep strict verification.
function isPrivateOrLoopbackUrl(u: string): boolean {
    try {
        const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
        if (host === "localhost") return true;
        // IPv4
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const [a, b] = host.split(".").map(Number);
            if (a === 127) return true;                          // 127.0.0.0/8 loopback
            if (a === 10) return true;                           // 10.0.0.0/8
            if (a === 192 && b === 168) return true;             // 192.168.0.0/16
            if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
            if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
            return false;
        }
        // IPv6
        if (host === "::1") return true;
        const lower = host.toLowerCase();
        if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
        if (lower.startsWith("fe80:")) return true;              // link-local
        return false;
    } catch {
        return false;
    }
}

function toTypeboxSchema(params: SkillParam) {
    const props: Record<string, any> = {};
    for (const [key, decl] of Object.entries(params)) {
        const typeName = (typeof decl === "string" ? decl : decl?.type || "string").toLowerCase();
        let t: any;
        switch (typeName) {
            case "number":
            case "integer":
            case "int":
            case "float": t = Type.Number(); break;
            case "boolean":
            case "bool": t = Type.Boolean(); break;
            case "array":
            case "list": t = Type.Array(Type.Any()); break;
            case "object":
            case "dict":
            case "map": t = Type.Object({}); break;
            default: t = Type.String();
        }
        props[key] = Type.Optional(t);
    }
    return Type.Object(props);
}

// Server-side skills write generated files into the webapp container's
// sandbox (/workspace/artifacts/) and return `_artifacts` with a download
// URL. In the web chat UI those surface as download chips; in Pi there is
// no chip and the sandbox is a different filesystem from the user's host, so
// the only way to deliver a file to the path the user asked for is to
// download it from the URL. Build that instruction with a ready-to-run curl
// command — auth via the MODELSERVER_API_KEY env var Pi already has (so the
// secret never lands in the transcript), and -k when the cert is self-signed.
function describeArtifacts(parsed: any, insecure: boolean): string {
    const arts = (parsed._artifacts || []) as Array<{ name: string; size?: number; url: string }>;
    const kFlag = insecure ? " -k" : "";
    const lines: string[] = [];
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
        lines.push(
            `  workspace_get("artifacts/${a.name}", "<DEST_PATH>/${a.name}")`
        );
        lines.push(
            `  (or: curl -fsSL${kFlag} -H "Authorization: Bearer $MODELSERVER_API_KEY" "${a.url}" -o "<DEST_PATH>/${a.name}")`
        );
    }
    lines.push("");
    lines.push(
        `Replace <DEST_PATH> with the directory the user wants. workspace_get creates ` +
        `parent dirs for you and needs no auth handling.`
    );
    // Keep any human-facing summary the skill returned (the misleading
    // chat-chip note was already stripped by the caller).
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        lines.push("");
        lines.push(parsed.summary.trim());
    }
    return lines.join("\n");
}

function summarize(payload: any): string {
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
