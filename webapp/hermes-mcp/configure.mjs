#!/usr/bin/env node
// Idempotent Hermes configuration for the Model Server.
//
// Merges (without clobbering unrelated settings) into ~/.hermes/config.yaml:
//   - custom_providers[] entry "modelserver"  -> <baseUrl>/v1, key_env MODELSERVER_API_KEY
//   - model.provider = custom:modelserver      (preserves any existing model.default)
//   - mcp_servers.modelserver                  -> stdio launch of modelserver-mcp.mjs
// and writes MODELSERVER_API_KEY into ~/.hermes/.env (so the provider's key_env
// resolves). Re-running is safe — entries are replaced in place.
//
// Inputs (env, with a baked fallback for the base URL):
//   MODELSERVER_BASE_URL   e.g. https://localhost:3001   (__MODELSERVER_BASE_URL__ baked)
//   MODELSERVER_API_KEY    bearer-mode key (required)

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

const SERVER_BAKED_BASE_URL = "__MODELSERVER_BASE_URL__";

const baseUrl = (process.env.MODELSERVER_BASE_URL || SERVER_BAKED_BASE_URL).replace(/\/+$/, "");
const apiKey = process.env.MODELSERVER_API_KEY || "";

if (!apiKey) {
    console.error("[hermes-configure] MODELSERVER_API_KEY is not set; aborting.");
    process.exit(1);
}

const HERMES_DIR = path.join(os.homedir(), ".hermes");
const CONFIG_PATH = path.join(HERMES_DIR, "config.yaml");
const ENV_PATH = path.join(HERMES_DIR, ".env");

// This file is installed alongside modelserver-mcp.mjs, so resolve the server
// path relative to ourselves — wherever the installer dropped the directory.
const here = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.join(here, "modelserver-mcp.mjs");

fs.mkdirSync(HERMES_DIR, { recursive: true });

// ---- config.yaml ------------------------------------------------------------
let cfg = {};
if (fs.existsSync(CONFIG_PATH)) {
    try {
        cfg = YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
        if (typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    } catch (e) {
        console.error(`[hermes-configure] existing config.yaml is unparseable (${e.message}); backing it up to config.yaml.bak and starting fresh.`);
        try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak"); } catch { /* ignore */ }
        cfg = {};
    }
}

// model — SIMPLE custom-provider form (provider/base_url/api_key/default). This
// is the form that makes Hermes skip its interactive first-run setup wizard
// (confirmed headless workaround): with all four set, `hermes` goes straight to
// the agent instead of prompting for provider/model/key. The key is inlined so
// there's no env-resolution prompt. We preserve any other model.* keys.
// Pick the API base URL Hermes' (cert-verifying Python) client should use, and
// the default model, in one probe. For a self-hosted server on loopback/private
// IP the cert is self-signed — Hermes' httpx client can't verify it and fails
// with "APIConnectionError: Connection error" (the browser lets you click
// through; Python won't). The webapp also serves a PLAIN-HTTP mirror on :3080
// expressly to avoid SSL-verification issues, so for loopback/private hosts we
// prefer that (no TLS at all). Public/DNS hosts keep HTTPS (real cert).
const api = await probeApi(baseUrl);
if (typeof cfg.model !== "object" || cfg.model === null || Array.isArray(cfg.model)) cfg.model = {};
cfg.model.provider = "custom";
cfg.model.base_url = `${api.base}/v1`;
cfg.model.api_key = apiKey;
if (api.modelId) {
    cfg.model.default = api.modelId;    // always refresh so a stale id is corrected
} else if (!cfg.model.default) {
    console.error("[hermes-configure] WARNING: couldn't reach the model API to pick a default model.");
    console.error("[hermes-configure]   Load a model in the webapp, then run `hermes model` (or re-run this installer).");
}
console.error(`[hermes-configure] model API: ${api.base}/v1 ${api.base.startsWith("http://") ? "(plain HTTP — avoids self-signed-cert errors)" : "(HTTPS)"}`);

// Clean up the old (incorrect) array-form custom_providers entry a prior install
// may have written — the simple model form above supersedes it.
if (Array.isArray(cfg.custom_providers)) {
    cfg.custom_providers = cfg.custom_providers.filter((p) => p && p.name !== "modelserver");
    if (!cfg.custom_providers.length) delete cfg.custom_providers;
}

// approvals — only seed on FIRST install (absent), so a user's later choice is
// preserved. Default to frictionless: no per-tool approval prompts and no MCP
// reload / destructive-command confirmations, so the agent runs straight away.
// Dial it back up any time with `hermes config set approvals.mode smart` (auto-
// approves safe ops, asks on risky ones) or `manual` (asks on every tool).
if (typeof cfg.approvals !== "object" || cfg.approvals === null || Array.isArray(cfg.approvals)) {
    cfg.approvals = { mode: "off", mcp_reload_confirm: false, destructive_slash_confirm: false };
}

// mcp_servers.modelserver — stdio launch. The key is written into the env block
// (Hermes only passes this block to the subprocess); ~/.hermes is user-owned.
if (typeof cfg.mcp_servers !== "object" || cfg.mcp_servers === null || Array.isArray(cfg.mcp_servers)) cfg.mcp_servers = {};
cfg.mcp_servers.modelserver = {
    command: "node",
    args: [mcpServerPath],
    env: {
        // Use the same base the model calls use (HTTP mirror on loopback/private)
        // so the skill server also sidesteps self-signed-cert issues.
        MODELSERVER_BASE_URL: api.base,
        MODELSERVER_API_KEY: apiKey,
    },
};

// Emit with YAML 1.1 semantics to match Hermes' Python (PyYAML) parser: in 1.1,
// off/on/yes/no are boolean keywords, so the emitter quotes the STRING "off"
// (approvals.mode) instead of writing a bare `off` that PyYAML would read as the
// boolean false. Without this, approvals.mode silently becomes `false`.
fs.writeFileSync(CONFIG_PATH, YAML.stringify(cfg, { version: "1.1" }), { mode: 0o600 });
console.error(`[hermes-configure] wrote ${CONFIG_PATH}`);

// ---- .env -------------------------------------------------------------------
// Besides MODELSERVER_API_KEY (the MCP server + provider key_env), also write
// OPENAI_BASE_URL + OPENAI_API_KEY. Those two are the UNIVERSAL "a provider is
// configured" signal Hermes checks FIRST in _has_any_provider_configured() — on
// every version, including older builds whose check predates the config.yaml
// `model.provider` branch. Without them such a build decides nothing is
// configured and launches the first-run setup wizard ("How would you like to
// set up Hermes?") even though our config.yaml is complete. They also serve as
// the OpenAI-compatible fallback creds, and point at the same base/key the
// custom provider uses, so there's no runtime conflict.
const apiV1 = `${api.base}/v1`;
let envText = "";
if (fs.existsSync(ENV_PATH)) envText = fs.readFileSync(ENV_PATH, "utf8");
const managedEnvKeys = ["MODELSERVER_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY"];
const lines = envText.split("\n").filter(
    (l) => !managedEnvKeys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(l))
);
// Trim trailing blank lines, then append.
while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
lines.push(`MODELSERVER_API_KEY=${apiKey}`);
lines.push(`OPENAI_BASE_URL=${apiV1}`);
lines.push(`OPENAI_API_KEY=${apiKey}`);
fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
console.error(`[hermes-configure] wrote MODELSERVER_API_KEY, OPENAI_BASE_URL, OPENAI_API_KEY to ${ENV_PATH}`);

console.error("[hermes-configure] done. Launch Hermes with `hermes` (or `hermes --tui`).");

// ---- helpers ----------------------------------------------------------------
function isLoopbackOrPrivate(host) {
    const h = (host || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h === "::1") return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
        const [a, b] = h.split(".").map(Number);
        if (a === 127 || a === 10) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 169 && b === 254) return true;
        return false;
    }
    return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

// Fetch /v1/models from a candidate base; returns the first model id, or null.
async function modelIdFrom(base) {
    try {
        const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return null;
        const j = await r.json();
        const id = j?.data?.[0]?.id;
        return typeof id === "string" ? id : null;
    } catch {
        return null;
    }
}

// Probe which base URL the model API is reachable on. For loopback/private
// hosts, try the plain-HTTP mirror first (default port 3080, overridable via
// MODELSERVER_HTTP_PORT) so a cert-verifying client never trips on the
// self-signed cert; fall back to the original HTTPS (relaxing Node's own TLS
// check for the probe only). Returns { base, modelId }.
async function probeApi(httpsBase) {
    const candidates = [];
    try {
        const u = new URL(httpsBase);
        if ((u.protocol === "https:") && isLoopbackOrPrivate(u.hostname)) {
            const httpPort = process.env.MODELSERVER_HTTP_PORT || "3080";
            candidates.push(`http://${u.hostname}:${httpPort}`);
        }
        if (isLoopbackOrPrivate(u.hostname) && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // let the HTTPS probe succeed past a self-signed cert
        }
    } catch { /* ignore */ }
    candidates.push(httpsBase);

    let firstReachable = null;
    for (const base of candidates) {
        const id = await modelIdFrom(base);
        if (id) return { base, modelId: id };           // reachable AND has a model
        if (firstReachable === null) {
            // distinguish "reachable but no model loaded" from "unreachable"
            try {
                const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
                if (r.status < 500) firstReachable = base;
            } catch { /* unreachable */ }
        }
    }
    // Nothing had a model; prefer the first reachable base (HTTP mirror if it
    // answered), else the original HTTPS base.
    return { base: firstReachable || httpsBase, modelId: null };
}
