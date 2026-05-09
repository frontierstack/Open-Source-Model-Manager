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
//   MODELSERVER_INSECURE_TLS=1  accept self-signed certs (default for localhost)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
                apiKey: "MODELSERVER_API_KEY",
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

    let registered = 0;
    let skipped = 0;
    for (const skill of skills) {
        if (!skill || !skill.name || skill.enabled === false) continue;

        const nativeRoute = NATIVE_TOOL_ROUTES[skill.name];
        const code = String(skill.code || "");
        const hasExecute = /\bdef\s+execute\s*\(/.test(code);

        // Skip stub catalog entries that have no working Python and no
        // native HTTP fallback — registering them would just give the
        // model "name 'execute' is not defined" on dispatch.
        if (!hasExecute && !nativeRoute) {
            skipped++;
            continue;
        }

        const params = toTypeboxSchema(skill.parameters || {});
        const description = skill.description
            || (skill.systemPrompt ? skill.systemPrompt.split(/[.\n]/)[0] : skill.name);

        try {
            (pi as any).registerTool({
                name: skill.name,
                label: skill.name,
                description,
                promptSnippet: skill.systemPrompt || undefined,
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
                        r = await authedFetch(`/api/skills/${encodeURIComponent(skill.name)}/execute`, {
                            method: "POST",
                            body: JSON.stringify(args ?? {}),
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
    if (skipped > 0) {
        console.warn(`[modelserver] skipped ${skipped} stub skill(s) with no def execute and no native route`);
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
