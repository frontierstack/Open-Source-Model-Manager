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
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { basename, dirname, join, resolve as resolvePath } from "path";

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
    "[HOST-FIRST WORKING MODEL] You work across TWO filesystems. (1) The user's " +
    "LOCAL HOST is primary — your built-in read / write / edit / ls / grep / bash " +
    "act ONLY here (the current directory, /mnt/c/..., etc.). (2) The model " +
    "server's SANDBOX is a separate machine where the server skills run " +
    "(create_pdf, html_to_pdf, transform_image, read_pdf, read_xlsx, query_sqlite, " +
    "sandbox_bash, …); its files live under /workspace and your built-in tools " +
    "CANNOT see them. Pass real HOST paths to server skills — host files are " +
    "uploaded for you automatically. Use workspace_list to see what the sandbox " +
    "holds, workspace_get(workspacePath, hostPath) to bring a skill's OUTPUT " +
    "(e.g. 'artifacts/<name>') back to the host, and workspace_put(hostPath) to " +
    "push a file in explicitly. The sandbox persists for your whole session.";

// Shorter override prepended to any sandbox skill whose prompt still talks about
// /workspace or create_file (those notes are written for the web chat UI).
const HOST_FIRST_OVERRIDE =
    "[PI: HOST-FIRST] Pass real host file paths to this skill — they are uploaded " +
    "to the sandbox automatically; do NOT use create_file. Inspect the sandbox with " +
    "workspace_list and retrieve output with workspace_get(workspacePath, hostPath). " +
    "The create_file mentions below are for the web chat UI only — ignore them here. " +
    "/workspace paths below refer to the SERVER sandbox, never to your host.\n\n";

// Sandbox skills whose NAME reads like one of Pi's own local tools while they
// actually execute inside the model server's container. "run_bash" sitting next
// to Pi's built-in "bash" is the single most expensive confusion in a long
// session: the agent interleaves the two, sees a file with one and ENOENT with
// the other, decides the filesystem is corrupt, and starts inventing results.
// Registering them under an unmistakable `sandbox_` name puts the target
// filesystem in every call. The server-side skill name (the dispatch path) is
// unchanged, so this is purely what the model sees.
const SANDBOX_TOOL_RENAMES: Record<string, string> = {
    run_bash: "sandbox_bash",
    run_powershell: "sandbox_powershell",
    run_cmd: "sandbox_cmd",
    // Shadowed by default; renamed too so MODELSERVER_INCLUDE_LOCAL_SHADOW=1
    // can't reintroduce the ambiguity.
    run_python: "sandbox_python",
    run_node: "sandbox_node",
    run_npm: "sandbox_npm",
};

// Appended to the description of every registered skill that takes a path
// argument. Systemic on purpose: any skill the operator enables later (skills
// are user-toggleable, and `run_bash` reached this session precisely because it
// was enabled after the fact) gets the disambiguation without a code change.
const SANDBOX_FS_MARKER =
    " [Runs in the MODEL SERVER SANDBOX, not on your machine: its paths are " +
    "/workspace/... on the server. Host paths you pass are uploaded automatically; " +
    "call workspace_list to see what the sandbox already holds.]";

// Stronger wording for the shell family, where picking the wrong one silently
// runs the command on the wrong computer.
const SANDBOX_SHELL_MARKER =
    " [Runs INSIDE the model server's sandbox container — NOT on the user's machine. " +
    "Use it to inspect or manipulate /workspace on the server. To run a command on the " +
    "machine the user is sitting at, use your own built-in bash tool instead.]";

// Param names that denote a filesystem path (mirrors the server's PATH_ARG_NAMES
// policy, which is what decides that an arg gets rewritten into /workspace).
const PATHY_PARAM_RE = /(path|file|dir|directory|folder)s?\d*$/i;

// Pi's own built-in tools. These act on the HOST, always.
const HOST_BUILTIN_TOOLS = new Set([
    "read", "write", "edit", "multiedit", "ls", "grep", "find", "bash",
]);

// Where a Windows drive shows up on a POSIX host, in probe order:
// WSL, cygwin, then git-bash/msys (loosest, tried last).
const WIN_MOUNT_PREFIXES = ["/mnt/", "/cygdrive/", "/"];

/**
 * Resolve a destination path supplied by the model or the user into something
 * this process can actually write to.
 *
 * The failure this closes is silent, which is why it cost a whole session:
 * `fs.writeFileSync("C:\\Users\\me\\Desktop\\r.pdf", buf)` on Linux/WSL does
 * NOT throw. Backslash and colon are legal filename characters on POSIX, so it
 * cheerfully creates a single file literally named `C:\Users\me\Desktop\r.pdf`
 * in the process cwd and returns success. The user is told the report is on
 * their Desktop, finds nothing, and there is no error anywhere to explain it.
 */
export function resolveHostPath(input: string): { path: string; note?: string } {
    let p = String(input || "").trim().replace(/^["']|["']$/g, "");
    if (!p) throw new Error("empty path");

    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
        p = join(os.homedir(), p.slice(1).replace(/^[\\/]+/, ""));
    }

    // On real Windows a drive-letter path is already correct.
    if (process.platform === "win32") return { path: resolvePath(p) };

    const drive = p.match(/^([A-Za-z]):[\\/]?(.*)$/);
    if (drive) {
        const letter = drive[1].toLowerCase();
        const rest = drive[2].replace(/\\/g, "/").replace(/^\/+/, "");
        for (const prefix of WIN_MOUNT_PREFIXES) {
            const root = `${prefix}${letter}`;
            try {
                if (fs.statSync(root).isDirectory()) {
                    const mapped = rest ? `${root}/${rest}` : root;
                    return { path: mapped, note: `Windows path ${input} resolved to ${mapped}` };
                }
            } catch { /* drive not mounted under this prefix — try the next */ }
        }
        throw new Error(
            `"${input}" is a Windows path, but this machine has no ${letter.toUpperCase()}: drive mounted ` +
            `(checked ${WIN_MOUNT_PREFIXES.map((x) => x + letter).join(", ")}). ` +
            `Pi is running on ${process.platform}; give a path that exists here, ` +
            `e.g. ${join(os.homedir(), "Desktop", "file.ext")}. Writing the Windows path verbatim ` +
            `would create one oddly-named file in the current directory instead of delivering it.`
        );
    }

    if (p.includes("\\") && !p.includes("/")) {
        throw new Error(
            `"${input}" looks like a Windows path but carries no drive letter, so it cannot be mapped ` +
            `onto this machine. Use a path valid here, e.g. ${join(os.homedir(), "file.ext")}.`
        );
    }

    return { path: resolvePath(p) };
}

/** Does this path exist on the machine pi is running on? */
export function existsOnHost(p: string): boolean {
    try { fs.statSync(p); return true; } catch { return false; }
}

/**
 * Collect every "/workspace..." reference in a tool's arguments.
 *
 * The trailing boundary matters: devcontainers put real host projects under
 * "/workspaces/<name>", so matching "/workspace" as a prefix would flag — and
 * then block — perfectly valid local paths. Require the next character to end
 * the segment.
 */
export function collectWorkspaceRefs(input: unknown, out: string[] = []): string[] {
    if (typeof input === "string") {
        for (const m of input.matchAll(/(^|[\s"'`=(:,])(\/workspace(?![A-Za-z0-9_.-])(?:\/[^\s"'`;|)&,]*)?)/g)) {
            if (!out.includes(m[2])) out.push(m[2]);
        }
    } else if (Array.isArray(input)) {
        for (const v of input) collectWorkspaceRefs(v, out);
    } else if (input && typeof input === "object") {
        for (const v of Object.values(input)) collectWorkspaceRefs(v, out);
    }
    return out;
}

export function humanBytes(n: number | null | undefined): string {
    if (typeof n !== "number" || !isFinite(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

interface WorkspaceInventory {
    bucket: string;
    mountPath: string;
    empty: boolean;
    repos: Array<{ path: string; url: string | null; ref: string | null }>;
    files: Array<{ rel: string; size: number | null }>;
    dirs: Array<{ rel: string; fileCount: number; capped: boolean }>;
    truncated: boolean;
}

const MAX_LISTED_WORKSPACE_FILES = 40;

/**
 * The sandbox-state block appended to the system prompt on every turn.
 *
 * Why the system prompt and not a message: pi's compaction summarizes old
 * messages away, and tool results are truncated to 2000 chars before the
 * summarizer even sees them. So everything the agent learned about the sandbox
 * from tool output — which files it uploaded, that /workspace means the server
 * and not the host — is gone after a /compact. That is exactly when a long
 * session starts insisting the workspace was wiped, "re-discovers" a same-named
 * host directory, and reconstructs deliverables from a stale summary instead of
 * re-reading the files that are still sitting there.
 *
 * The system prompt is rebuilt and re-sent on every request, so state stated
 * here survives compaction by construction.
 */
export function renderSandboxStateBlock(
    inv: WorkspaceInventory | null,
    opts: { hostHasWorkspaceDir: boolean; justCompacted: boolean; unreachable: boolean }
): string {
    const L: string[] = [];
    L.push("[MODEL SERVER SANDBOX — live inventory, re-read every turn]");
    L.push(
        "This is a SECOND filesystem, separate from the host that your built-in " +
        "read / write / edit / ls / grep / bash act on. It belongs to your API key and " +
        "PERSISTS for the whole session: across turns, across compaction, across restarts."
    );

    if (opts.justCompacted) {
        L.push(
            "NOTE: the conversation was just compacted. Older tool output is no longer in your " +
            "context, but the sandbox itself was untouched — everything listed below is still on " +
            "disk. Do not conclude that files were lost, and do not rebuild a deliverable from " +
            "remembered/summarized content: re-read the real files with the server skills."
        );
    }

    if (opts.unreachable) {
        L.push(
            "The inventory could not be refreshed this turn (the model server did not answer). " +
            "Treat the listing below as possibly stale and re-check with workspace_list before " +
            "concluding anything about what the sandbox contains."
        );
    }

    if (inv) {
        L.push("");
        L.push(`Bucket ${inv.bucket}, mounted at ${inv.mountPath} inside every server skill.`);
        if (inv.empty) {
            L.push("The sandbox is currently EMPTY — nothing has been uploaded or generated yet.");
        } else {
            const rows: string[] = [];
            for (const r of inv.repos) {
                rows.push(`  ${r.path}/  (git repo${r.url ? ` — ${r.url}` : ""}${r.ref ? ` @ ${r.ref}` : ""})`);
            }
            for (const d of inv.dirs) {
                rows.push(`  ${d.rel}/  (${d.fileCount}${d.capped ? "+" : ""} files)`);
            }
            for (const f of inv.files) {
                const sz = humanBytes(f.size);
                rows.push(`  ${f.rel}${sz ? `  ${sz}` : ""}`);
            }
            const shown = rows.slice(0, MAX_LISTED_WORKSPACE_FILES);
            const hidden = rows.length - shown.length;
            L.push(`Contents of ${inv.mountPath} (${rows.length}${inv.truncated ? "+" : ""} entries):`);
            L.push(...shown);
            if (hidden > 0) L.push(`  …and ${hidden} more — call workspace_list for the full listing.`);
            if (inv.truncated) L.push("  (server-side listing was truncated; workspace_list can show more)");
        }
    }

    L.push("");
    L.push("Reaching it:");
    L.push("  workspace_list()                    re-read this inventory");
    L.push("  workspace_get(wsPath, hostPath)     copy sandbox -> host (deliver a result)");
    L.push("  workspace_put(hostPath[, wsPath])   copy host -> sandbox (also automatic whenever");
    L.push("                                      you pass a host path to a server skill)");
    L.push(
        "  server skills (read_pdf, create_pdf, sandbox_bash, query_sqlite, …) see these paths directly."
    );
    L.push(
        "Your OWN read / write / edit / ls / grep / bash CANNOT see any of it — they run on the host. " +
        "A /workspace path handed to one of them is a bug, not a missing file."
    );

    if (opts.hostHasWorkspaceDir) {
        L.push("");
        L.push(
            "WARNING: this host ALSO has a directory literally named /workspace. It is a DIFFERENT " +
            "directory with different contents from the sandbox above. Listing it with your own bash " +
            "tells you nothing about the sandbox — the two are unrelated despite the identical path."
        );
    }

    return L.join("\n");
}

export default async function (pi: ExtensionAPI) {
    const baseUrl = (process.env.MODELSERVER_BASE_URL || SERVER_BAKED_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env.MODELSERVER_API_KEY;

    // Interactive shell sessions (ssh_connect / shell_open / shell_exec /
    // shell_send / shell_read / shell_close / shell_list). Purely local —
    // register FIRST so they work even when the server is unreachable or
    // the API key is missing.
    registerInteractiveShellTools(pi);

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

    // ---- live sandbox state (the anti-compaction machinery) -----------------
    // Everything the agent learns about the sandbox arrives as tool OUTPUT, and
    // tool output is what compaction throws away first (results are truncated to
    // 2000 chars before the summarizer even reads them). So a long session
    // reliably reaches a point where the agent still has filenames but no longer
    // knows they live on the server — it probes them with its own host tools,
    // gets ENOENT, decides the workspace was wiped, and starts fabricating.
    //
    // Fix: restate the sandbox in the SYSTEM PROMPT every turn. Pi writes a
    // before_agent_start override into agent.state.systemPrompt, which is re-sent
    // on every LLM call for that turn — including calls after a mid-turn
    // auto-compaction — so this state cannot be summarized away.
    const INVENTORY_TTL_MS = 5000;
    const INVENTORY_TIMEOUT_MS = 4000;
    let inventoryCache: { at: number; inv: WorkspaceInventory | null } | null = null;
    let lastGoodInventory: WorkspaceInventory | null = null;
    let justCompacted = false;

    // Does the HOST have its own directory called /workspace? If so the agent can
    // list it with its own bash, get a completely different set of files, and
    // "confirm" that the sandbox lost everything. Cheap to detect, worth warning
    // about explicitly.
    const hostHasWorkspaceDir = (() => {
        try { return fs.statSync("/workspace").isDirectory(); } catch { return false; }
    })();

    const invalidateWorkspaceInventory = () => { inventoryCache = null; };

    const fetchWorkspaceInventory = async (): Promise<WorkspaceInventory | null> => {
        const now = Date.now();
        if (inventoryCache && now - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.inv;
        let inv: WorkspaceInventory | null = null;
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), INVENTORY_TIMEOUT_MS);
            try {
                const r = await authedFetch("/api/agent-workspaces/inventory?maxEntries=80", { signal: ac.signal });
                if (r.ok) inv = await r.json() as WorkspaceInventory;
            } finally { clearTimeout(timer); }
        } catch { /* server down / slow — fall back to last known good */ }
        if (inv) lastGoodInventory = inv;
        inventoryCache = { at: now, inv };
        return inv;
    };

    const sandboxStateBlock = async (): Promise<string> => {
        const inv = await fetchWorkspaceInventory();
        return renderSandboxStateBlock(inv || lastGoodInventory, {
            hostHasWorkspaceDir,
            justCompacted,
            unreachable: !inv,
        });
    };

    // Never let a slow or broken server break the user's turn: on any failure the
    // block is simply omitted for that turn.
    pi.on("before_agent_start", async (event: any) => {
        try {
            const block = await sandboxStateBlock();
            justCompacted = false;
            return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
        } catch (e) {
            console.error("[modelserver] sandbox state injection failed:", (e as Error).message);
            return undefined;
        }
    });

    // Compaction is precisely when the agent loses the thread. Re-read the
    // inventory and flag the next system prompt so it says, in as many words,
    // that the sandbox was not touched.
    pi.on("session_compact", () => {
        justCompacted = true;
        invalidateWorkspaceInventory();
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
    const uploadHostFileToWorkspace = async (hostPath: string, destRel?: string): Promise<string> => {
        const rel = (destRel || basename(hostPath)).replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
        const buf = fs.readFileSync(hostPath);
        const r = await fetch(`${baseUrl}/api/agent-workspaces/file?path=${encodeURIComponent(rel)}`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/octet-stream" },
            body: buf,
        });
        if (!r.ok) {
            let msg = `HTTP ${r.status}`;
            try { const j = await r.json() as any; if (j?.error) msg = j.error; } catch { /* keep status */ }
            throw new Error(`workspace upload failed: ${msg}`);
        }
        invalidateWorkspaceInventory();
        return rel;
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

    // ---- cross-filesystem guardrails ----------------------------------------
    // Handing a /workspace path to one of Pi's OWN tools is the concrete symptom
    // of the two-filesystem confusion. Left alone it yields a bare ENOENT, which
    // teaches the model nothing: in the session that motivated this work the
    // agent reissued that same class of call dozens of times — rotating between
    // read, bash, python and back — before concluding the files were gone and
    // writing a report from a stale summary. Replace the useless error with one
    // that names the tool that CAN reach the path.

    // Unreachable = neither the path nor its parent exists here. The parent check
    // matters: when the host has its own /workspace, writing a NEW file under it
    // is perfectly legitimate and must not be blocked.
    const unreachableOnHost = (p: string) => !existsOnHost(p) && !existsOnHost(dirname(p));

    const sandboxRedirectHint = (refs: string[]): string => {
        const inv = lastGoodInventory;
        const L: string[] = [];
        L.push(
            `${refs.join(", ")} ${refs.length > 1 ? "are paths" : "is a path"} in the MODEL SERVER ` +
            `SANDBOX, which is a different machine from the one you are running on. Your built-in ` +
            `read / write / edit / ls / grep / bash only see this host, so they will never find it.`
        );
        const wanted = refs.map((r) => r.replace(/^\/workspace\/?/, "")).filter(Boolean);
        const known = inv && !inv.empty
            ? wanted.filter((w) => inv.files.some((f) => f.rel === w || basename(f.rel) === basename(w)))
            : [];
        if (known.length) {
            L.push(`The sandbox does currently contain: ${known.join(", ")} — the file exists, you are just asking the wrong machine.`);
        }
        L.push("Use instead:");
        L.push("  workspace_list()                      see what the sandbox holds");
        L.push("  workspace_get(wsPath, hostPath)       copy it here, then use your own tools");
        L.push("  read_pdf / read_xlsx / sandbox_bash / … read it in place, on the server");
        return L.join("\n");
    };

    pi.on("tool_call", (event: any) => {
        try {
            if (!HOST_BUILTIN_TOOLS.has(event.toolName)) return;
            // bash commands are compound ("cd /workspace && ..."); blocking one
            // outright is too blunt, so it gets an explanatory note on the result.
            if (event.toolName === "bash") return;
            const refs = collectWorkspaceRefs(event.input).filter(unreachableOnHost);
            if (!refs.length) return;
            return { block: true, reason: sandboxRedirectHint(refs) };
        } catch { return; }
    });

    // When the host has its own /workspace the call SUCCEEDS and returns a
    // different directory's contents — the worst case, because it looks like
    // proof that the sandbox changed. Annotate the result so the agent cannot
    // mistake one for the other.
    pi.on("tool_result", (event: any) => {
        try {
            if (!hostHasWorkspaceDir) return;
            if (!HOST_BUILTIN_TOOLS.has(event.toolName)) return;
            if (!collectWorkspaceRefs(event.input).length) return;
            const inv = lastGoodInventory;
            const note =
                `[modelserver] This is the /workspace directory on the LOCAL HOST. It is NOT the ` +
                `model server sandbox, which has its own unrelated /workspace` +
                (inv && !inv.empty ? ` (bucket ${inv.bucket}, ${inv.files.length} file(s) — call workspace_list)` : "") +
                `. What you see above says nothing about what the sandbox contains.`;
            return { content: [...(event.content || []), { type: "text", text: note }] };
        } catch { return; }
    });

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
        const promptSnippet = pushesWorkspace
            ? HOST_FIRST_OVERRIDE + rawPrompt
            : (rawPrompt || undefined);

        // Which filesystem does this tool act on? Anything taking a path arg is
        // rewritten into /workspace server-side, so it is sandbox-scoped by
        // definition. Stating that in the description is systemic: a skill the
        // operator enables later inherits the disambiguation with no code change
        // (run_bash reached the failing session exactly that way — it ships
        // disabled and was turned on in the UI afterwards).
        const toolName = SANDBOX_TOOL_RENAMES[skill.name] || skill.name;
        const isRenamedShell = toolName !== skill.name;
        const takesPath = Object.keys(skill.parameters || {}).some((k) => PATHY_PARAM_RE.test(k));
        const description = baseDescription
            + (isRenamedShell ? SANDBOX_SHELL_MARKER : (takesPath ? SANDBOX_FS_MARKER : ""));

        try {
            (pi as any).registerTool({
                // The model-facing name may be rewritten (run_bash -> sandbox_bash);
                // dispatch below still uses the real skill name.
                name: toolName,
                label: toolName,
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
                        throw new Error(`[${toolName}] ${msg}`);
                    }
                    // Any server skill may have written into the sandbox; make the
                    // next system-prompt block reflect it rather than a cached view.
                    invalidateWorkspaceInventory();
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
    // ---- the explicit half of the bridge ------------------------------------
    // host->workspace is automatic (any host path passed to a server skill is
    // uploaded), but the agent still needs to SEE the sandbox and to deliver
    // results back to a chosen place on the user's machine.
    try {
        (pi as any).registerTool({
            name: "workspace_list",
            label: "workspace_list",
            description:
                "List what is currently in the model server's sandbox workspace — the /workspace that " +
                "server skills (read_pdf, create_pdf, sandbox_bash, …) read and write. Use it whenever " +
                "you are unsure whether a file is still there, and after a compaction: the sandbox " +
                "persists for the whole session even when the conversation history describing it does not. " +
                "Your own ls/bash cannot see this — they run on the host.",
            promptSnippet: HOST_FIRST_DOCTRINE,
            parameters: Type.Object({}),
            async execute() {
                invalidateWorkspaceInventory();
                const inv = await fetchWorkspaceInventory();
                if (!inv) {
                    throw new Error(
                        "[workspace_list] could not reach the model server. The sandbox contents are " +
                        "unknown right now — do not assume the workspace is empty."
                    );
                }
                const L: string[] = [`Sandbox workspace ${inv.bucket} (mounted at ${inv.mountPath}):`];
                if (inv.empty) {
                    L.push("  (empty — nothing uploaded or generated yet)");
                } else {
                    for (const r of inv.repos) {
                        L.push(`  ${r.path}/  git repo${r.url ? ` — ${r.url}` : ""}${r.ref ? ` @ ${r.ref}` : ""}`);
                    }
                    for (const d of inv.dirs) L.push(`  ${d.rel}/  (${d.fileCount}${d.capped ? "+" : ""} files)`);
                    for (const f of inv.files) {
                        const sz = humanBytes(f.size);
                        L.push(`  ${f.rel}${sz ? `  ${sz}` : ""}`);
                    }
                    if (inv.truncated) L.push("  …listing truncated");
                }
                L.push("");
                L.push("These are SERVER paths. To use one on this machine, workspace_get it first.");
                return { content: [{ type: "text", text: L.join("\n") }], details: inv };
            },
        });
        registered++;

        (pi as any).registerTool({
            name: "workspace_put",
            label: "workspace_put",
            description:
                "Copy a file FROM this machine INTO the model server's sandbox workspace, so server " +
                "skills can operate on it. Usually unnecessary — passing a host path straight to a " +
                "server skill uploads it for you — but useful to stage several files up front or to " +
                "control the name they get in the sandbox.",
            promptSnippet: HOST_FIRST_DOCTRINE,
            parameters: Type.Object({
                hostPath: Type.String({ description: "Path of the file on this machine" }),
                workspacePath: Type.Optional(Type.String({ description: "Destination inside the sandbox, relative to /workspace. Defaults to the file's basename." })),
            }),
            async execute(_id: string, a: any) {
                const resolved = resolveHostPath(String(a?.hostPath || ""));
                const st = fs.statSync(resolved.path);
                if (!st.isFile()) throw new Error(`[workspace_put] ${resolved.path} is not a file`);
                if (st.size > MAX_BRIDGE_BYTES) {
                    throw new Error(`[workspace_put] ${resolved.path} is ${humanBytes(st.size)}, over the ${humanBytes(MAX_BRIDGE_BYTES)} bridge limit`);
                }
                const rel = await uploadHostFileToWorkspace(resolved.path, a?.workspacePath ? String(a.workspacePath) : undefined);
                const lines = [`Uploaded ${humanBytes(st.size)} to /workspace/${rel} in the sandbox.`];
                if (resolved.note) lines.push(resolved.note);
                lines.push(`Server skills should now be given the path /workspace/${rel}.`);
                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: { hostPath: resolved.path, workspacePath: `/workspace/${rel}`, bytes: st.size },
                };
            },
        });
        registered++;

        (pi as any).registerTool({
            name: "workspace_get",
            label: "workspace_get",
            description:
                "Copy a file FROM the server workspace TO this machine. " +
                "Use it to deliver outputs that server skills produced — e.g. after create_pdf, " +
                "workspace_get('artifacts/report.pdf', '~/Desktop/report.pdf'). " +
                "workspacePath is relative to /workspace (rendered files land under 'artifacts/'). " +
                "hostPath must be valid on the machine pi is running on; if that is WSL, a Windows " +
                "path like C:\\Users\\you\\Desktop is translated to /mnt/c/... automatically. " +
                "The reverse direction is automatic — when you pass a host path to a server skill " +
                "(read_pdf, create_pdf contentFile, transform_image, …) the file is uploaded for you.",
            promptSnippet: HOST_FIRST_DOCTRINE,
            parameters: Type.Object({
                workspacePath: Type.String({ description: "Path inside the server workspace, e.g. 'artifacts/report.pdf' or 'report.md'" }),
                hostPath: Type.String({ description: "Destination on this machine — a file path, or a directory to drop the file into" }),
            }),
            async execute(_id: string, a: any, signal: AbortSignal | undefined) {
                const wp = String(a?.workspacePath || "").replace(/^\/workspace\/?/, "");
                if (!wp || !String(a?.hostPath || "").trim()) {
                    throw new Error("workspace_get needs workspacePath and hostPath");
                }
                // Resolve BEFORE downloading so a bad destination fails fast and
                // loudly. Writing a Windows path verbatim on WSL does not throw —
                // it silently creates one file named "C:\Users\..." in the cwd and
                // reports success, which is how a delivered file goes missing.
                const resolved = resolveHostPath(String(a.hostPath));
                let target = resolved.path;
                try {
                    if (fs.statSync(target).isDirectory()) target = join(target, basename(wp));
                } catch { /* doesn't exist yet — treated as a file path */ }

                const r = await fetch(`${baseUrl}/api/agent-workspaces/file?path=${encodeURIComponent(wp)}`, {
                    headers: { "Authorization": `Bearer ${apiKey}` },
                    signal,
                });
                if (!r.ok) {
                    let msg = `HTTP ${r.status}`;
                    try { const j = await r.json() as any; if (j?.error) msg = j.error; } catch { /* keep status */ }
                    if (r.status === 404) {
                        msg += ` — '${wp}' is not in the sandbox. Call workspace_list to see what is.`;
                    }
                    throw new Error(`[workspace_get] ${msg}`);
                }
                const buf = Buffer.from(await r.arrayBuffer());
                fs.mkdirSync(dirname(target), { recursive: true });
                fs.writeFileSync(target, buf);

                // Confirm it actually landed, and report the path we really wrote.
                let written: number;
                try { written = fs.statSync(target).size; } catch {
                    throw new Error(`[workspace_get] wrote ${target} but it is not there afterwards — the destination is not writable`);
                }
                if (written !== buf.length) {
                    throw new Error(`[workspace_get] ${target} is ${written} bytes, expected ${buf.length} — the write was incomplete`);
                }
                const lines = [`Saved ${humanBytes(written)} to ${target}`];
                if (resolved.note) lines.push(resolved.note);
                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: { hostPath: target, requestedHostPath: String(a.hostPath), bytes: written },
                };
            },
        });
        registered++;
    } catch (e) {
        console.error("[modelserver] failed to register workspace bridge tools:", e);
    }

    if (skippedStub > 0) {
        console.warn(`[modelserver] skipped ${skippedStub} stub skill(s) with no def execute and no native route`);
    }
    if (skippedShadow > 0) {
        console.warn(`[modelserver] skipped ${skippedShadow} skill(s) that shadow Pi's local tools (set MODELSERVER_INCLUDE_LOCAL_SHADOW=1 to register them)`);
    }
    void registered;
}

// ============================================================================
// Interactive shell sessions
// ============================================================================
// Pi's built-in bash tool is one-shot: every call is a fresh process, so
// state (cwd, env, an SSH connection, a REPL) is lost between calls and the
// model compensates by writing throwaway scripts — slow and brittle. These
// tools hold a PERSISTENT interactive process open across turns and let the
// model drive it like a human at a terminal:
//
//   ssh_connect  – open a persistent SSH session (the dedicated remote-shell
//                  path: ssh -tt + keepalive, one connection reused for the
//                  whole task)
//   shell_open   – same mechanism for any long-lived interactive process
//                  (local bash, docker exec -it, mysql, python, a serial
//                  console via picocom, …)
//   shell_exec   – type a command line into the session and wait for the
//                  output to settle (the fast path for navigation)
//   shell_send   – raw keystrokes: password prompts, y/n confirmations,
//                  REPL input, control keys (ctrl-c, arrows, tab, …)
//   shell_read   – poll a long-running command for new output
//   shell_close / shell_list
//
// PTY without native modules: on Linux/macOS the process is wrapped in
// `script` (util-linux / BSD), which allocates a real pty — so remote
// programs see a terminal, prompts appear, and interactive tools behave.
// No node-pty, so the installer never needs a compiler toolchain. On
// platforms without `script` we fall back to plain pipes (ssh still works
// because ssh_connect always passes -tt).

interface ShellSession {
    id: string;
    proc: ChildProcess;
    command: string;
    pending: string;          // unread output (post-ANSI-strip), capped
    lastDataAt: number;       // ms timestamp of last output chunk
    lastUsedAt: number;
    alive: boolean;
    exit: string | null;      // "exit 0" / "signal SIGKILL" once dead
    truncated: boolean;       // pending overflowed and lost its head
}

const shellSessions = new Map<string, ShellSession>();
let shellSessionSeq = 0;
let lastShellSessionId: string | null = null;

const SHELL_MAX_SESSIONS = 8;
const SHELL_PENDING_CAP = 200_000;   // chars buffered per session
const SHELL_RETURN_CAP = 12_000;     // chars returned per tool call (tail)
const SHELL_IDLE_KILL_MS = 30 * 60_000;

const SHELL_CONTROL_KEYS: Record<string, string> = {
    "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a", "ctrl-l": "\x0c",
    "ctrl-r": "\x12", "ctrl-u": "\x15",
    "esc": "\x1b", "tab": "\t", "enter": "\r", "space": " ", "backspace": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
};

// Strip ANSI escapes and resolve carriage-return overwrites so the model
// reads clean text instead of raw terminal control noise.
function cleanTerminalOutput(s: string): string {
    let out = s
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")       // OSC (title etc.)
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")               // CSI
        .replace(/\x1b[@-Z\\-_]/g, "")                            // 2-byte escapes
        .replace(/\r\n/g, "\n")
        .replace(/[\x00\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");
    // Progress bars redraw lines with bare \r — keep only the final draw.
    out = out.split("\n").map((line) => {
        const i = line.lastIndexOf("\r");
        return i >= 0 ? line.slice(i + 1) : line;
    }).join("\n");
    return out;
}

// Spawn `command` under a pty when the platform allows it.
function spawnInteractive(command: string, cwd?: string): ChildProcess {
    const env = { ...process.env, TERM: "xterm-256color" };
    const plat = os.platform();
    try {
        if (plat === "linux") {
            // util-linux script: -q quiet, -e propagate exit code, -f flush,
            // -c run command; log to /dev/null.
            return spawn("script", ["-qefc", command, "/dev/null"], { cwd, env });
        }
        if (plat === "darwin") {
            // BSD script: -q quiet, -F flush; command follows the log file.
            return spawn("script", ["-qF", "/dev/null", "/bin/sh", "-c", command], { cwd, env });
        }
    } catch { /* fall through to pipes */ }
    return spawn(command, { shell: true, cwd, env: { ...process.env, TERM: "dumb" } });
}

function openShellSession(command: string, cwd?: string): ShellSession | { error: string } {
    // Reap dead sessions first so their slots free up.
    for (const [id, s] of shellSessions) {
        if (!s.alive && !s.pending) shellSessions.delete(id);
    }
    if (shellSessions.size >= SHELL_MAX_SESSIONS) {
        return { error: `Session limit (${SHELL_MAX_SESSIONS}) reached — shell_close an old session first (see shell_list).` };
    }
    let proc: ChildProcess;
    try {
        proc = spawnInteractive(command, cwd);
    } catch (e) {
        return { error: `Failed to spawn: ${(e as Error).message}` };
    }
    const id = `s${++shellSessionSeq}`;
    const sess: ShellSession = {
        id, proc, command,
        pending: "", lastDataAt: Date.now(), lastUsedAt: Date.now(),
        alive: true, exit: null, truncated: false,
    };
    const onData = (chunk: Buffer) => {
        sess.pending += cleanTerminalOutput(chunk.toString("utf8"));
        sess.lastDataAt = Date.now();
        if (sess.pending.length > SHELL_PENDING_CAP) {
            sess.pending = sess.pending.slice(-SHELL_PENDING_CAP);
            sess.truncated = true;
        }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => {
        sess.pending += `\n[spawn error: ${e.message}]`;
        sess.alive = false;
        sess.exit = sess.exit || "spawn-error";
    });
    proc.on("exit", (code, signal) => {
        sess.alive = false;
        sess.exit = signal ? `signal ${signal}` : `exit ${code}`;
        sess.lastDataAt = Date.now();
    });
    shellSessions.set(id, sess);
    lastShellSessionId = id;
    return sess;
}

function getShellSession(idArg: unknown): ShellSession | { error: string } {
    const id = (typeof idArg === "string" && idArg.trim()) ? idArg.trim() : lastShellSessionId;
    if (!id) return { error: "No shell session open — call ssh_connect or shell_open first." };
    const s = shellSessions.get(id);
    if (!s) {
        const open = [...shellSessions.keys()].join(", ") || "none";
        return { error: `Unknown session '${id}'. Open sessions: ${open}.` };
    }
    s.lastUsedAt = Date.now();
    lastShellSessionId = s.id;
    return s;
}

// Collect output until it goes quiet (no new bytes for settleMs) or
// timeoutMs elapses. Returns whatever accumulated either way.
// silentAfterMs: give up on a command that produces NOTHING after this long
// (e.g. a cd that prints nothing — though pty echo usually yields at least
// the echoed command). shell_read overrides it to the full timeout so
// polling a quiet long-running job actually waits for the first byte.
async function waitForQuiet(sess: ShellSession, timeoutMs: number, settleMs: number, silentAfterMs?: number): Promise<void> {
    const start = Date.now();
    const silentCutoff = silentAfterMs ?? Math.max(settleMs * 4, 2000);
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
        if (!sess.alive) return;
        const sinceData = Date.now() - sess.lastDataAt;
        if (sess.pending.length > 0 && sinceData >= settleMs) return;
        if (sess.pending.length === 0 && Date.now() - start >= silentCutoff) return;
    }
}

function takePending(sess: ShellSession): { output: string; note?: string } {
    let out = sess.pending;
    const wasTruncated = sess.truncated;
    sess.pending = "";
    sess.truncated = false;
    let note: string | undefined;
    if (out.length > SHELL_RETURN_CAP) {
        out = "…[earlier output omitted — " + (out.length - SHELL_RETURN_CAP) + " chars]…\n" + out.slice(-SHELL_RETURN_CAP);
    }
    if (wasTruncated) note = "Output buffer overflowed; oldest output was dropped.";
    return { output: out, note };
}

function shellResult(sess: ShellSession, extra?: Record<string, unknown>) {
    const { output, note } = takePending(sess);
    const status = sess.alive ? "running" : `ended (${sess.exit})`;
    const details: Record<string, unknown> = {
        session: sess.id, status, command: sess.command, ...(note ? { note } : {}), ...extra,
    };
    const head = `[session ${sess.id} — ${status}]`;
    const hint = sess.alive && !output.trim()
        ? "\n(no new output yet — a long-running command may still be working; call shell_read to poll, or shell_send a key if it is waiting at a prompt)"
        : "";
    return {
        content: [{ type: "text", text: `${head}\n${output || ""}${hint}${note ? `\n[${note}]` : ""}` }],
        details,
    };
}

// Idle reaper — kill sessions nobody has touched in 30 minutes.
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of shellSessions) {
        if (s.alive && now - s.lastUsedAt > SHELL_IDLE_KILL_MS) {
            try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
            s.alive = false;
            s.exit = s.exit || "idle-killed";
        }
        if (!s.alive && now - s.lastUsedAt > SHELL_IDLE_KILL_MS * 2) shellSessions.delete(id);
    }
}, 60_000).unref?.();

// Make sure children die with Pi.
process.on("exit", () => {
    for (const s of shellSessions.values()) {
        if (s.alive) { try { s.proc.kill("SIGKILL"); } catch { /* ignore */ } }
    }
});

const SHELL_DOCTRINE =
    "[INTERACTIVE SHELL SESSIONS] For remote/interactive shell work, do NOT write " +
    "throwaway scripts and do NOT re-run ssh per command. Open ONE persistent session " +
    "(ssh_connect for remote hosts, shell_open for local bash / docker exec / REPLs / " +
    "consoles) and drive it: shell_exec runs a command line and returns its output with " +
    "cwd/env/connection state preserved between calls; shell_send types raw keystrokes " +
    "(passwords, y/n prompts, REPL input, ctrl-c); shell_read polls a long-running " +
    "command. Sessions persist across your turns until shell_close.";

function registerInteractiveShellTools(pi: ExtensionAPI): number {
    let n = 0;
    const reg = (def: any) => {
        try { (pi as any).registerTool(def); n++; }
        catch (e) { console.error(`[modelserver] failed to register ${def.name}:`, e); }
    };

    reg({
        name: "ssh_connect",
        label: "ssh_connect",
        description:
            "Open a PERSISTENT interactive SSH session to a remote host and keep it open across turns. " +
            "Use this (not one-off ssh commands, not scripts) whenever the user asks you to connect to / " +
            "work on a remote machine. Returns a session id — then run commands with shell_exec, answer " +
            "prompts (passwords, y/n) with shell_send, poll long jobs with shell_read.",
        promptSnippet: SHELL_DOCTRINE,
        parameters: Type.Object({
            destination: Type.String({ description: "SSH destination, e.g. user@host or a Host alias from ~/.ssh/config" }),
            port: Type.Optional(Type.Number({ description: "SSH port (default 22)" })),
            identityFile: Type.Optional(Type.String({ description: "Path to a private key file" })),
            extraArgs: Type.Optional(Type.String({ description: "Extra ssh CLI arguments, e.g. '-J jumphost' or '-o ProxyCommand=…'" })),
        }),
        async execute(_id: string, a: any) {
            const dest = String(a?.destination || a?.host || "").trim();
            if (!dest) throw new Error("ssh_connect needs a destination (user@host)");
            if (/[;|&`$<>\n]/.test(dest)) throw new Error("destination contains shell metacharacters");
            const parts = ["ssh", "-tt",
                "-o", "ServerAliveInterval=30",
                "-o", "StrictHostKeyChecking=accept-new"];
            if (a?.port) parts.push("-p", String(Math.floor(Number(a.port))));
            if (a?.identityFile) parts.push("-i", String(a.identityFile));
            const extra = String(a?.extraArgs || "").trim();
            parts.push(dest);
            const cmd = parts.map(shq).join(" ") + (extra ? ` ${extra}` : "");
            const sess = openShellSession(cmd);
            if ("error" in sess) throw new Error(sess.error);
            // First connect can involve banner + auth prompt — wait generously.
            await waitForQuiet(sess, 15_000, 900);
            return shellResult(sess, { opened: true });
        },
    });

    reg({
        name: "shell_open",
        label: "shell_open",
        description:
            "Open a persistent interactive terminal session for ANY long-lived process — a local shell " +
            "(default: bash), 'docker exec -it …', a database/REPL client, a serial console — and keep it " +
            "open across turns. Drive it with shell_exec / shell_send / shell_read. For SSH prefer ssh_connect.",
        promptSnippet: SHELL_DOCTRINE,
        parameters: Type.Object({
            command: Type.Optional(Type.String({ description: "Process to run interactively (default: your login shell / bash)" })),
            cwd: Type.Optional(Type.String({ description: "Working directory to start in" })),
        }),
        async execute(_id: string, a: any) {
            const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell" : "bash");
            const command = String(a?.command || "").trim() || shell;
            const cwd = a?.cwd ? String(a.cwd) : undefined;
            const sess = openShellSession(command, cwd);
            if ("error" in sess) throw new Error(sess.error);
            await waitForQuiet(sess, 6_000, 600);
            return shellResult(sess, { opened: true });
        },
    });

    reg({
        name: "shell_exec",
        label: "shell_exec",
        description:
            "Type a command line into an open interactive session (from ssh_connect/shell_open) and return " +
            "the output once it settles. State persists between calls — cd, env vars, the SSH connection, " +
            "your place in a REPL. If output says the command is still running, poll with shell_read.",
        parameters: Type.Object({
            command: Type.String({ description: "The command line to run in the session" }),
            session: Type.Optional(Type.String({ description: "Session id (default: most recently used)" })),
            timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for output to settle (default 15000)" })),
        }),
        async execute(_id: string, a: any) {
            const sess = getShellSession(a?.session);
            if ("error" in sess) throw new Error(sess.error);
            if (!sess.alive) return shellResult(sess, { warning: "session already ended" });
            sess.proc.stdin?.write(String(a?.command ?? "") + "\n");
            const timeout = Math.min(Math.max(Number(a?.timeoutMs) || 15_000, 1_000), 120_000);
            await waitForQuiet(sess, timeout, 700);
            return shellResult(sess);
        },
    });

    reg({
        name: "shell_send",
        label: "shell_send",
        description:
            "Send raw keystrokes to an open session — for password prompts, y/n confirmations, REPL input, " +
            "menu navigation, or interrupting with ctrl-c. Text is sent as typed; set enter=false to omit " +
            "the trailing newline; use key for control keys (ctrl-c, ctrl-d, esc, tab, enter, up, down, left, right).",
        parameters: Type.Object({
            text: Type.Optional(Type.String({ description: "Text to type (sent before 'key' if both given)" })),
            key: Type.Optional(Type.String({ description: "Control key: ctrl-c|ctrl-d|ctrl-z|ctrl-l|ctrl-r|ctrl-u|esc|tab|enter|space|backspace|up|down|left|right" })),
            enter: Type.Optional(Type.Boolean({ description: "Append newline after text (default true; ignored when only 'key' is sent)" })),
            session: Type.Optional(Type.String({ description: "Session id (default: most recently used)" })),
            timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for resulting output (default 8000)" })),
        }),
        async execute(_id: string, a: any) {
            const sess = getShellSession(a?.session);
            if ("error" in sess) throw new Error(sess.error);
            if (!sess.alive) return shellResult(sess, { warning: "session already ended" });
            let payload = "";
            if (typeof a?.text === "string" && a.text.length) {
                payload += a.text + (a?.enter === false ? "" : "\n");
            }
            if (typeof a?.key === "string" && a.key.trim()) {
                const seq = SHELL_CONTROL_KEYS[a.key.trim().toLowerCase()];
                if (!seq) throw new Error(`Unknown key '${a.key}'. Valid: ${Object.keys(SHELL_CONTROL_KEYS).join(", ")}`);
                payload += seq;
            }
            if (!payload) throw new Error("shell_send needs text and/or key");
            sess.proc.stdin?.write(payload);
            const timeout = Math.min(Math.max(Number(a?.timeoutMs) || 8_000, 500), 60_000);
            await waitForQuiet(sess, timeout, 600);
            return shellResult(sess);
        },
    });

    reg({
        name: "shell_read",
        label: "shell_read",
        description:
            "Read any NEW output from an open session without sending input — poll a long-running command " +
            "(build, download, deploy) or check whether a prompt appeared. Waits up to timeoutMs for output.",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Session id (default: most recently used)" })),
            timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for new output (default 5000; 0 = return immediately)" })),
        }),
        async execute(_id: string, a: any) {
            const sess = getShellSession(a?.session);
            if ("error" in sess) throw new Error(sess.error);
            const timeout = Math.min(Math.max(Number(a?.timeoutMs ?? 5_000), 0), 120_000);
            if (timeout > 0 && !sess.pending) await waitForQuiet(sess, timeout, 500, timeout);
            return shellResult(sess);
        },
    });

    reg({
        name: "shell_close",
        label: "shell_close",
        description: "Close an interactive session opened with ssh_connect/shell_open (sends SIGTERM, then SIGKILL).",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Session id (default: most recently used)" })),
        }),
        async execute(_id: string, a: any) {
            const sess = getShellSession(a?.session);
            if ("error" in sess) throw new Error(sess.error);
            if (sess.alive) {
                try { sess.proc.kill("SIGTERM"); } catch { /* ignore */ }
                setTimeout(() => { if (sess.alive) { try { sess.proc.kill("SIGKILL"); } catch { /* ignore */ } } }, 2_000).unref?.();
            }
            const { output } = takePending(sess);
            shellSessions.delete(sess.id);
            if (lastShellSessionId === sess.id) lastShellSessionId = null;
            return {
                content: [{ type: "text", text: `Closed session ${sess.id} (${sess.command}).${output.trim() ? `\nFinal output:\n${output.slice(-2000)}` : ""}` }],
                details: { session: sess.id, closed: true },
            };
        },
    });

    reg({
        name: "shell_list",
        label: "shell_list",
        description: "List open interactive shell sessions (id, command, status, idle time, unread output size).",
        parameters: Type.Object({}),
        async execute() {
            const now = Date.now();
            const rows = [...shellSessions.values()].map((s) =>
                `${s.id}${s.id === lastShellSessionId ? "*" : ""}  ${s.alive ? "running" : `ended (${s.exit})`}  ` +
                `idle ${Math.round((now - s.lastUsedAt) / 1000)}s  unread ${s.pending.length}B  ${s.command}`);
            return {
                content: [{ type: "text", text: rows.length ? rows.join("\n") : "No open sessions." }],
                details: { sessions: rows.length },
            };
        },
    });

    return n;
}

// Shell-escape an arg for embedding in the command string handed to
// `script -c` / `spawn(…, {shell:true})`. POSIX single-quoting on Unix;
// conservative double-quoting on the Windows pipe-fallback path (cmd.exe
// doesn't understand single quotes).
function shq(s: string): string {
    if (os.platform() === "win32") {
        return /[ \t"^&|<>()%!]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
    }
    return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
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
        `the result does not exist on your machine, so do NOT cp it. They stay in the ` +
        `sandbox for the rest of the session, so you can fetch them later too. To ` +
        `deliver a file to the location the user asked for, call workspace_get:`
    );
    for (const a of arts) {
        const sz = typeof a.size === "number" ? ` (${a.size} bytes)` : "";
        lines.push("");
        lines.push(`• ${a.name}${sz}`);
        lines.push(
            `  workspace_get("artifacts/${a.name}", "<DEST_PATH>/${a.name}")`
        );
        lines.push(
            `  (fallback, run with YOUR OWN bash tool on the user's machine — never with ` +
            `sandbox_bash, which runs on the server and cannot reach it: ` +
            `curl -fsSL${kFlag} -H "Authorization: Bearer $MODELSERVER_API_KEY" "${a.url}" -o "<DEST_PATH>/${a.name}")`
        );
    }
    lines.push("");
    lines.push(
        `Replace <DEST_PATH> with a directory that exists on the machine pi is running on. ` +
        `workspace_get creates parent dirs, translates a Windows path to its /mnt/... mount ` +
        `when running under WSL, verifies the bytes landed, and needs no auth handling — ` +
        `prefer it over curl.`
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
