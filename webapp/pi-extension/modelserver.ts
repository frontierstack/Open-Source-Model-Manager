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
}

interface ModelInfo {
    id: string;
    name?: string;
    context_window?: number;
    max_tokens?: number;
}

export default async function (pi: ExtensionAPI) {
    const baseUrl = (process.env.MODELSERVER_BASE_URL || "https://localhost:3001").replace(/\/+$/, "");
    const apiKey = process.env.MODELSERVER_API_KEY;

    if (!apiKey) {
        console.warn("[modelserver] MODELSERVER_API_KEY not set; skill catalog and provider registration skipped.");
        return;
    }

    const insecure = process.env.MODELSERVER_INSECURE_TLS === "1"
        || baseUrl.startsWith("https://localhost")
        || baseUrl.startsWith("https://127.")
        || baseUrl.startsWith("https://[::1]");

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

    for (const skill of skills) {
        if (!skill || !skill.name || skill.enabled === false) continue;

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
                    const body = JSON.stringify(args ?? {});
                    const r = await authedFetch(`/api/skills/${encodeURIComponent(skill.name)}/execute`, {
                        method: "POST",
                        body,
                        signal
                    });
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
        } catch (e) {
            console.error(`[modelserver] failed to register skill ${skill.name}:`, e);
        }
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
