// In-process DAG executor for workflow automations.
//
// A workflow is { nodes: [...], edges: [...] }. Nodes carry a `type` and a
// `data` blob; edges connect node output handles to input handles. The engine
// walks the graph from its entry node(s), runs each node's handler, threads
// outputs into a shared scope, and prunes branches that an if/else gate
// doesn't take.
//
// It is intentionally dependency-light and decoupled from server.js: the
// host injects the capabilities it needs (`runModelCompletion`,
// `executeToolCall`) via `deps`, and receives live status via `onEvent`. That
// keeps the engine unit-testable without booting the whole server.
//
// Telegram trigger/connector nodes are deliberately NOT implemented yet
// (planned for a later phase) — a `telegram.*` node fails fast with a clear
// "not implemented" error rather than silently passing through.

// ---------------------------------------------------------------------------
// Built-in node-type catalog (drives the editor palette + validation).
//
// These are TEMPLATES, not a 1:1 type map: several connector templates share
// the engine `type: 'tool'` but ship different `defaults` (the tool name) so
// the palette can present "SQLite Query", "Create PDF", etc. as distinct cards
// that all execute through the one tool handler. `key` is the unique template
// id; `type` is what the executor dispatches on at runtime. User-authored
// node-types (from node-types.json) are layered on top of this by the API.
// Telegram trigger/connector templates are intentionally omitted (later phase).
// ---------------------------------------------------------------------------
const BUILTIN_NODE_TYPES = [
    // --- Triggers (entry points; emit the run input as their output) ---
    { key: 'trigger.manual',   type: 'trigger.manual',   category: 'trigger', label: 'Manual / Run now', description: 'Starts the workflow when run manually.', outputs: ['out'] },
    { key: 'trigger.schedule', type: 'trigger.schedule', category: 'trigger', label: 'Schedule',         description: 'Starts on a fixed interval (every N seconds/minutes/hours/days) or a cron expression.', outputs: ['out'], defaults: { intervalMs: 300000 }, fields: ['cron', 'intervalMs'] },
    { key: 'trigger.webhook',  type: 'trigger.webhook',  category: 'trigger', label: 'Inbound Webhook',  description: 'Starts when its (token-gated) webhook URL is POSTed to. The request body becomes the run input.', outputs: ['out'] },
    { key: 'trigger.event',    type: 'trigger.event',    category: 'trigger', label: 'On Event',         description: 'Starts on a system event (e.g. model.loaded). The event payload becomes the run input.', outputs: ['out'], fields: ['event'] },
    { key: 'trigger.telegram', type: 'trigger.telegram', category: 'trigger', label: 'Telegram Message', description: 'Starts when the bot receives a message (optionally matching a keyword). Polls getUpdates; the message becomes the run input ({{input.text}}, {{input.chat.id}}).', outputs: ['out'], fields: ['botToken', 'chatId', 'keyword', 'match'] },

    // --- Connectors (do work) ---
    { key: 'model',       type: 'model',      category: 'connector', label: 'Model / LLM call', description: 'Runs a prompt through a loaded model.', inputs: ['in'], outputs: ['out'], fields: ['prompt', 'systemPrompt', 'model', 'temperature', 'maxTokens'] },
    { key: 'web_search',  type: 'web_search', category: 'connector', label: 'Web Search',       description: 'Searches the web (DuckDuckGo → Brave fallback).', inputs: ['in'], outputs: ['out'], fields: ['query', 'limit'] },
    { key: 'fetch_url',   type: 'fetch_url',  category: 'connector', label: 'Fetch URL',        description: 'Fetches and extracts the content of a URL.', inputs: ['in'], outputs: ['out'], fields: ['url', 'maxLength'] },
    { key: 'parse_json',  type: 'parse_json', category: 'connector', label: 'Parse JSON',       description: 'Parses a JSON string (or passes an object through) and optionally extracts a dotted path.', inputs: ['in'], outputs: ['out'], fields: ['source', 'path'] },
    { key: 'render_html', type: 'render_html',category: 'connector', label: 'Render HTML',      description: 'Renders HTML (or wraps text/JSON) into a viewable HTML result.', inputs: ['in'], outputs: ['out'], fields: ['html'] },
    { key: 'export_file', type: 'export_file',category: 'connector', label: 'Export File',      description: 'Writes the incoming data to a downloadable file (pdf, csv, txt, md, html, json).', inputs: ['in'], outputs: ['out'], fields: ['format', 'filename', 'content'] },
    { key: 'slack',       type: 'slack',      category: 'connector', label: 'Slack Message',    description: 'Posts a message to a Slack incoming-webhook URL.', inputs: ['in'], outputs: ['out'], fields: ['webhookUrl', 'text'] },
    { key: 'telegram',    type: 'telegram',   category: 'connector', label: 'Telegram Message', description: 'Sends a message via a Telegram bot (Bot API token + chat id).', inputs: ['in'], outputs: ['out'], fields: ['botToken', 'chatId', 'text'] },
    { key: 'telegram_get',type: 'telegram_get',category: 'connector', label: 'Get Telegram Messages', description: 'Fetches the bot\'s recent messages on demand (getUpdates). Do NOT use on a bot that also has a Telegram trigger — getUpdates conflicts.', inputs: ['in'], outputs: ['out'], fields: ['botToken', 'limit'] },
    { key: 'http_request',type: 'tool',       category: 'connector', label: 'HTTP Request',     description: 'Calls an HTTP endpoint (SSRF-guarded — private IPs blocked).', inputs: ['in'], outputs: ['out'], defaults: { tool: 'http_request' }, fields: ['args'] },
    { key: 'crawl',       type: 'tool',       category: 'connector', label: 'Crawl Pages',      description: 'Crawls and extracts content from multiple linked pages.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'crawl_pages' }, fields: ['args'] },
    { key: 'sqlite',      type: 'tool',       category: 'connector', label: 'SQLite Query',     description: 'Runs a SQL query against a SQLite database.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'query_sqlite' }, fields: ['args'] },
    { key: 'render_chart',type: 'tool',       category: 'connector', label: 'Render Chart',     description: 'Renders a chart spec for display/download.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'render_chart' }, fields: ['args'] },
    { key: 'create_pdf',  type: 'tool',       category: 'connector', label: 'Create PDF',       description: 'Generates a PDF from markdown/HTML content.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'create_pdf' }, fields: ['args'] },
    { key: 'create_file', type: 'tool',       category: 'connector', label: 'Create File',      description: 'Writes a file into the run workspace.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'create_file' }, fields: ['args'] },
    { key: 'tool',        type: 'tool',       category: 'connector', label: 'Run Tool / Skill', description: 'Invokes any enabled skill or native tool by name.', inputs: ['in'], outputs: ['out'], fields: ['tool', 'args'] },
    { key: 'delay',       type: 'delay',      category: 'connector', label: 'Delay / Wait',     description: 'Pauses the workflow for N milliseconds.', inputs: ['in'], outputs: ['out'], fields: ['ms'] },
    { key: 'set',         type: 'set',        category: 'connector', label: 'Set Variable',     description: 'Stores a value in the run scope for later nodes.', inputs: ['in'], outputs: ['out'], fields: ['name', 'value'] },

    // --- Logic gates ---
    { key: 'gate.if',     type: 'gate.if',     category: 'gate', label: 'If / Else', description: 'Branches on a condition (true / false handles).', inputs: ['in'], outputs: ['true', 'false'], fields: ['condition'] },
    { key: 'gate.switch', type: 'gate.switch', category: 'gate', label: 'Switch',    description: 'N-way branch: routes to the handle of the first matching case, else "default".', inputs: ['in'], outputs: ['default'], fields: ['value', 'cases'] },
    { key: 'gate.filter', type: 'gate.filter', category: 'gate', label: 'Filter',    description: 'Continues only when its condition holds; otherwise that branch stops.', inputs: ['in'], outputs: ['out'], fields: ['condition'] },
    { key: 'merge',       type: 'merge',       category: 'gate', label: 'Merge',     description: 'Joins multiple branches: collects all incoming outputs into one list.', inputs: ['in'], outputs: ['out'] },

    // --- Terminal ---
    { key: 'output', type: 'output', category: 'output', label: 'Output / End', description: 'Marks a workflow result.', inputs: ['in'] },
];

const MAX_DELAY_MS = 5 * 60 * 1000; // a delay node can wait at most 5 minutes

// ---------------------------------------------------------------------------
// Scope + templating helpers
// ---------------------------------------------------------------------------

// Resolve a dotted path ("nodes.fetch.text", "results.0.title") against scope.
// Supports a `*` (or `[]`) wildcard segment that maps the rest of the path over
// every element of an array (or every value of an object), so "results.*.url"
// returns ALL urls, not just the first. Nested wildcards flatten one level.
function resolveParts(cur, parts) {
    for (let i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        const p = parts[i];
        if (p === '*' || p === '[]') {
            const items = Array.isArray(cur) ? cur : (typeof cur === 'object' ? Object.values(cur) : [cur]);
            const rest = parts.slice(i + 1);
            if (rest.length === 0) return items;
            const mapped = items.map(item => resolveParts(item, rest)).filter(v => v !== undefined);
            // flatten one level when the remainder itself produced arrays (nested *)
            return mapped.some(Array.isArray) ? [].concat(...mapped) : mapped;
        }
        cur = cur[p];
    }
    return cur;
}
function resolvePath(scope, pathStr) {
    return resolveParts(scope, String(pathStr).trim().split('.').filter(Boolean));
}

// Interpolate {{ path }} references in a template.
//   - A string that is EXACTLY "{{ path }}" (no surrounding text OR whitespace)
//     returns the raw resolved value (preserving objects/numbers/booleans).
//   - Any surrounding text/newlines → string interpolation, so the author's
//     spacing/newlines are preserved (a leading newline must shift content down).
//   - Objects/arrays are deep-mapped.
function interpolate(template, scope) {
    if (typeof template === 'string') {
        const exact = template.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
        if (exact) {
            const val = resolvePath(scope, exact[1]);
            return val === undefined ? '' : val;
        }
        return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
            const val = resolvePath(scope, path);
            if (val === undefined || val === null) return '';
            if (Array.isArray(val)) {
                // arrays of scalars (e.g. all urls) → readable newline list;
                // arrays of objects → JSON so structure is preserved.
                return val.every(v => v === null || typeof v !== 'object') ? val.join('\n') : JSON.stringify(val, null, 2);
            }
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        });
    }
    if (Array.isArray(template)) return template.map(t => interpolate(t, scope));
    if (template && typeof template === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(template)) out[k] = interpolate(v, scope);
        return out;
    }
    return template;
}

function toComparable(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

function truthy(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'object') return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
    const s = String(v).trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== '0' && s !== 'null' && s !== 'undefined' && s !== 'no';
}

// Evaluate a gate condition WITHOUT eval(). Accepts:
//   - a string  → interpolated, then truthiness-tested
//   - an object { left, op, right } → interpolated operands compared by op
function evalCondition(condition, scope) {
    if (condition == null) return false;
    if (typeof condition === 'string') {
        return truthy(interpolate(condition, scope));
    }
    if (typeof condition === 'object') {
        const left = interpolate(condition.left, scope);
        const right = interpolate(condition.right, scope);
        const op = String(condition.op || '==').trim();
        const ls = toComparable(left), rs = toComparable(right);
        switch (op) {
            case '==': case 'eq':           return String(ls) === String(rs);
            case '!=': case 'ne':           return String(ls) !== String(rs);
            case '>':  case 'gt':           { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a > b; }
            case '<':  case 'lt':           { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a < b; }
            case '>=': case 'gte':          { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a >= b; }
            case '<=': case 'lte':          { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a <= b; }
            case 'contains':                return String(ls).includes(String(rs));
            case 'not_contains':            return !String(ls).includes(String(rs));
            case 'startsWith':              return String(ls).startsWith(String(rs));
            case 'endsWith':                return String(ls).endsWith(String(rs));
            case 'matches':                 { try { return new RegExp(String(rs)).test(String(ls)); } catch { return false; } }
            case 'empty':                   return !truthy(left);
            case 'not_empty': case 'truthy':return truthy(left);
            default:                        return false;
        }
    }
    return truthy(condition);
}

// ---------------------------------------------------------------------------
// Helpers for delivery / transform nodes
// ---------------------------------------------------------------------------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render a node's "previous output" as a string for message/file/prompt bodies.
// Arrays of scalars (e.g. all urls from results.*.url) become a clean newline
// list — no [, "", ] noise; arrays of objects keep JSON so structure survives.
function stringifyValue(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
        return v.every(x => x === null || typeof x !== 'object') ? v.filter(x => x != null).join('\n') : JSON.stringify(v, null, 2);
    }
    if (typeof v === 'object' && typeof v.text === 'string') return v.text; // model node shape
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// Best-effort array-of-objects → CSV.
function toCSV(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    const cols = [];
    for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const esc = (v) => {
        const s = v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = cols.map(esc).join(',');
    const body = rows.map(r => cols.map(c => esc(r ? r[c] : '')).join(',')).join('\n');
    return `${head}\n${body}`;
}

function toolCallCtx(ctx, node) {
    return { userId: ctx.userId, apiKeyData: ctx.apiKeyData, conversationId: null, workspaceBucket: ctx.workspaceBucket };
}

async function dispatchTool(deps, ctx, node, name, args) {
    const msg = await deps.executeToolCall(
        { id: `auto-${node.id}`, function: { name, arguments: JSON.stringify(args) } },
        toolCallCtx(ctx, node),
    );
    try { return JSON.parse(msg.content); } catch { return { raw: msg.content }; }
}

// Inspect an http_request result for an API/transport failure and return a
// human message (or null when it looks like a success). Covers the common
// shapes: { success:false, error, status }, a 4xx/5xx status, and a Telegram
// Bot-API body of { ok:false, description }.
function httpFailureMessage(response) {
    if (!response || typeof response !== 'object') return null;
    const d = response.data;
    if (d && typeof d === 'object' && d.ok === false) return d.description || `error_code ${d.error_code || '?'}`;
    if (response.success === false) return response.error || (response.status ? `HTTP ${response.status}` : 'request failed');
    if (typeof response.status === 'number' && response.status >= 400) {
        const body = (d && typeof d === 'object') ? (d.description || JSON.stringify(d)) : (typeof d === 'string' ? d.slice(0, 200) : '');
        return `HTTP ${response.status}${body ? `: ${body}` : ''}`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

async function runNode(node, scope, deps, ctx, inputs = []) {
    const type = node.type || 'output';
    const data = interpolate(node.data || {}, scope);

    // Triggers simply surface the run input as their output.
    if (type.startsWith('trigger.')) {
        return scope.input ?? {};
    }

    if (type.startsWith('telegram.')) {
        throw new Error('Telegram nodes are not implemented yet (planned for a later phase).');
    }

    switch (type) {
        case 'model': {
            if (!deps.runModelCompletion) throw new Error('Model nodes are unavailable (no model runner wired).');
            const messages = [];
            if (data.systemPrompt) messages.push({ role: 'system', content: String(data.systemPrompt) });
            let userContent = String(data.prompt ?? '');
            // Auto-flow: if the prompt doesn't explicitly pull upstream data via
            // {{...}}, attach the incoming node output(s) so a connected
            // Web Search → Model (etc.) "just works" without manual templating.
            // Explicit {{...}} references opt out (the author is in control).
            const rawPrompt = (node.data && typeof node.data.prompt === 'string') ? node.data.prompt : '';
            const hasTemplateRef = /\{\{[\s\S]*?\}\}/.test(rawPrompt);
            if (!hasTemplateRef && Array.isArray(inputs) && inputs.length) {
                let ctxText = inputs
                    .map(v => stringifyValue(v))
                    .join('\n\n');
                if (ctxText.length > 16000) ctxText = ctxText.slice(0, 16000) + '\n…[truncated]';
                userContent = userContent ? `${userContent}\n\n${ctxText}` : ctxText;
            }
            messages.push({ role: 'user', content: userContent });
            const text = await deps.runModelCompletion({
                messages,
                model: data.model || undefined,
                temperature: data.temperature != null ? Number(data.temperature) : undefined,
                maxTokens: data.maxTokens != null ? Number(data.maxTokens) : undefined,
                userId: ctx.userId,
            });
            return { text };
        }

        case 'tool':
        case 'web_search':
        case 'fetch_url': {
            if (!deps.executeToolCall) throw new Error('Tool nodes are unavailable (no tool dispatcher wired).');
            let toolName, args;
            if (type === 'web_search') {
                toolName = 'web_search';
                args = { query: data.query ?? '', limit: data.limit != null ? Number(data.limit) : 5 };
            } else if (type === 'fetch_url') {
                toolName = 'fetch_url';
                args = { url: data.url ?? '', maxLength: data.maxLength != null ? Number(data.maxLength) : undefined };
            } else {
                toolName = data.tool;
                if (!toolName) throw new Error('Tool node is missing a `tool` name.');
                args = (data.args && typeof data.args === 'object') ? data.args : {};
            }
            const msg = await deps.executeToolCall(
                { id: `auto-${node.id}`, function: { name: toolName, arguments: JSON.stringify(args) } },
                { userId: ctx.userId, apiKeyData: ctx.apiKeyData, conversationId: null, workspaceBucket: ctx.workspaceBucket }
            );
            let parsed;
            try { parsed = JSON.parse(msg.content); } catch { parsed = { raw: msg.content }; }
            return parsed;
        }

        case 'parse_json': {
            // source: explicit value/template, else the previous node's output.
            let src = (data.source === undefined || data.source === '') ? scope.last : data.source;
            let obj = src;
            if (typeof src === 'string') { try { obj = JSON.parse(src); } catch { obj = src; } }
            if (data.path) {
                const val = resolvePath(obj, data.path);
                return (val !== null && typeof val === 'object') ? val : { value: val };
            }
            return (obj !== null && typeof obj === 'object') ? obj : { value: obj };
        }

        case 'render_html': {
            let html = data.html;
            if (html === undefined || html === '') {
                const last = scope.last;
                html = typeof last === 'string' ? last : `<pre>${escapeHtml(JSON.stringify(last, null, 2))}</pre>`;
            } else {
                html = String(html);
            }
            return { html, contentType: 'text/html' };
        }

        case 'export_file': {
            if (!deps.executeToolCall) throw new Error('Export File needs the tool dispatcher.');
            const fmt = String(data.format || 'txt').toLowerCase();
            let filename = String(data.filename || `export.${fmt}`).trim();
            if (!/\.[a-z0-9]+$/i.test(filename)) filename += `.${fmt}`;
            const rawContent = (data.content === undefined || data.content === '') ? scope.last : data.content;
            let content;
            if (fmt === 'csv' && Array.isArray(rawContent)) content = toCSV(rawContent);
            else if (fmt === 'json') content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2);
            else content = stringifyValue(rawContent);
            if (fmt === 'pdf') return dispatchTool(deps, ctx, node, 'create_pdf', { content, filename });
            return dispatchTool(deps, ctx, node, 'create_file', { filePath: `artifacts/${filename}`, content });
        }

        case 'slack': {
            if (!deps.executeToolCall) throw new Error('Slack node needs the tool dispatcher.');
            const url = String(data.webhookUrl || '').trim();
            if (!url) throw new Error('Slack node requires a webhook URL.');
            const text = (data.text === undefined || data.text === '') ? stringifyValue(scope.last) : String(data.text);
            const response = await dispatchTool(deps, ctx, node, 'http_request', {
                url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
            });
            const slackFail = httpFailureMessage(response);
            if (slackFail) throw new Error(`Slack send failed — ${slackFail}`);
            return { sent: true, response };
        }

        case 'telegram': {
            if (!deps.executeToolCall) throw new Error('Telegram node needs the tool dispatcher.');
            const token = String(data.botToken || '').trim();
            const chatId = String(data.chatId || '').trim();
            if (!token || !chatId) throw new Error('Telegram node requires a bot token and chat id.');
            const text = (data.text === undefined || data.text === '') ? stringifyValue(scope.last) : String(data.text);
            const response = await dispatchTool(deps, ctx, node, 'http_request', {
                url: `https://api.telegram.org/bot${token}/sendMessage`,
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text }),
            });
            const tgFail = httpFailureMessage(response);
            if (tgFail) {
                // 403 = valid token but the bot can't message this chat.
                const hint = /403|forbidden/i.test(tgFail)
                    ? ' (the chat must message the bot first, or check the chat id / that the bot is a channel admin)'
                    : '';
                throw new Error(`Telegram send failed — ${tgFail}${hint}`);
            }
            return { sent: true, response };
        }

        case 'telegram_get': {
            if (!deps.executeToolCall) throw new Error('Get Telegram Messages needs the tool dispatcher.');
            const token = String(data.botToken || '').trim();
            if (!token) throw new Error('Get Telegram Messages requires a bot token.');
            const limit = (data.limit != null && data.limit !== '') ? Math.max(1, Number(data.limit) || 10) : 10;
            const response = await dispatchTool(deps, ctx, node, 'http_request', {
                url: `https://api.telegram.org/bot${token}/getUpdates?timeout=0`, method: 'GET',
            });
            const fail = httpFailureMessage(response);
            if (fail) throw new Error(`Telegram getUpdates failed — ${fail}`);
            const result = (response && response.data && Array.isArray(response.data.result)) ? response.data.result : [];
            const messages = result.map(u => u.message).filter(Boolean).slice(-limit);
            const latest = messages.length ? messages[messages.length - 1] : null;
            return { count: messages.length, messages, latest, text: latest ? (latest.text || latest.caption || '') : '' };
        }

        case 'delay': {
            const ms = Math.max(0, Math.min(MAX_DELAY_MS, Number(data.ms) || 0));
            if (ms > 0) await new Promise(r => setTimeout(r, ms));
            return scope.last ?? {};
        }

        case 'set': {
            const name = data.name;
            if (name) scope.vars[name] = data.value;
            return { [name || 'value']: data.value };
        }

        case 'gate.if': {
            const result = evalCondition(node.data ? node.data.condition : null, scope);
            return { result, _handle: result ? 'true' : 'false' };
        }

        case 'gate.switch': {
            // data.value is compared (as string) against each case's `equals`.
            // cases: [{ equals, handle }]. First match wins, else 'default'.
            const value = String(toComparable(data.value));
            const cases = Array.isArray(data.cases) ? data.cases : [];
            const hit = cases.find(c => String(toComparable(c.equals)) === value);
            const handle = hit ? (hit.handle || String(hit.equals)) : 'default';
            return { value: data.value, matched: !!hit, _handle: handle };
        }

        case 'gate.filter': {
            // Continue down the 'out' handle only when the condition holds;
            // otherwise route to 'blocked' (usually unwired → branch stops).
            const pass = evalCondition(node.data ? node.data.condition : null, scope);
            return { pass, _handle: pass ? 'out' : 'blocked', value: scope.last ?? {} };
        }

        case 'merge': {
            // Collect every active incoming branch's output into one list.
            return { items: inputs, count: inputs.length };
        }

        case 'output':
        case 'note':
            return scope.last ?? data ?? {};

        default:
            // Unknown type → treat as a passthrough so user-authored node-types
            // that the executor doesn't specially handle don't hard-fail.
            return { ...data };
    }
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

// runWorkflow(workflow, { input, deps, onEvent, ctx, signal })
//   workflow : { nodes:[{id,type,data}], edges:[{id,source,target,sourceHandle?,targetHandle?}] }
//   input    : payload made available as {{input.*}} (trigger output)
//   deps     : { runModelCompletion, executeToolCall }
//   onEvent  : (evt) => void   — { type, ... } status events for SSE/WS
//   ctx      : { userId, apiKeyData, workspaceBucket }
//   signal   : optional AbortSignal to cancel mid-run
// returns { status:'completed'|'failed', result, error, timeline:[...] }
async function runWorkflow(workflow, opts = {}) {
    const { input = {}, deps = {}, onEvent = () => {}, ctx = {}, signal = null } = opts;
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const outgoing = new Map(nodes.map(n => [n.id, []]));
    const incoming = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
        if (outgoing.has(e.source)) outgoing.get(e.source).push(e);
        if (incoming.has(e.target)) incoming.get(e.target).push(e);
    }

    const nodeState = new Map(nodes.map(n => [n.id, 'pending'])); // pending|running|done|skipped
    const edgeState = new Map(edges.map(e => [e.id ?? `${e.source}->${e.target}:${e.sourceHandle || ''}`, 'pending'])); // pending|active|pruned
    const edgeKey = (e) => e.id ?? `${e.source}->${e.target}:${e.sourceHandle || ''}`;

    const scope = { input, vars: {}, nodes: {}, last: input };
    const timeline = [];

    const isResolved = (e) => edgeState.get(edgeKey(e)) !== 'pending';
    const isActive = (e) => edgeState.get(edgeKey(e)) === 'active';

    const aborted = () => signal && signal.aborted;

    // A node with no incoming edges is a valid entry point only if it's a trigger
    // — or, for trigger-less manual workflows, when the graph has no triggers at
    // all. A non-trigger node left unconnected (no incoming line) is an orphan and
    // must NOT run as a stray entry.
    const isTriggerNode = (n) => typeof n.type === 'string' && n.type.startsWith('trigger.');
    const hasTrigger = nodes.some(isTriggerNode);
    const isEntry = (n) => incoming.get(n.id).length === 0 && (isTriggerNode(n) || !hasTrigger);

    onEvent({ type: 'run_start', nodeCount: nodes.length });

    let result = null;
    const stepCap = nodes.length * 3 + 20; // guard against cycles / no-progress loops
    let steps = 0;

    try {
        while (steps++ < stepCap) {
            if (aborted()) throw new Error('aborted');

            // 1. Skip orphan nodes (no incoming line, not a valid entry) and any
            //    node whose every incoming edge is resolved-and-pruned.
            let changed = false;
            for (const n of nodes) {
                if (nodeState.get(n.id) !== 'pending') continue;
                const inc = incoming.get(n.id);
                if (inc.length === 0) {
                    if (isEntry(n)) continue; // genuine entry — never auto-skipped
                    // unconnected non-trigger node: never runs; prune its outputs.
                    nodeState.set(n.id, 'skipped');
                    for (const e of outgoing.get(n.id)) edgeState.set(edgeKey(e), 'pruned');
                    changed = true;
                    continue;
                }
                if (inc.every(isResolved) && !inc.some(isActive)) {
                    nodeState.set(n.id, 'skipped');
                    for (const e of outgoing.get(n.id)) edgeState.set(edgeKey(e), 'pruned');
                    changed = true;
                }
            }

            // 2. Find a runnable node: a valid entry, OR all incoming resolved
            //    with at least one active.
            const runnable = nodes.find(n => {
                if (nodeState.get(n.id) !== 'pending') return false;
                const inc = incoming.get(n.id);
                if (inc.length === 0) return isEntry(n);
                return inc.every(isResolved) && inc.some(isActive);
            });

            if (!runnable) {
                if (changed) continue; // pruning may have unblocked something
                break;                 // nothing left to do
            }

            // 3. Run it.
            const node = runnable;
            nodeState.set(node.id, 'running');
            const startedAt = new Date().toISOString();
            const entry = { nodeId: node.id, type: node.type, label: (node.data && node.data.label) || node.type, status: 'running', startedAt, finishedAt: null };
            timeline.push(entry);
            onEvent({ type: 'node_start', nodeId: node.id, nodeType: node.type });

            // Outputs of the active incoming branches (used by merge; available
            // to any handler that wants its direct predecessors).
            const activeInputs = incoming.get(node.id)
                .filter(isActive)
                .map(e => scope.nodes[e.source])
                .filter(v => v !== undefined);

            let output;
            try {
                output = await runNode(node, scope, deps, ctx, activeInputs);
            } catch (err) {
                entry.status = 'failed';
                entry.finishedAt = new Date().toISOString();
                entry.error = err.message || String(err);
                onEvent({ type: 'node_finish', nodeId: node.id, status: 'failed', error: entry.error });
                throw new Error(`Node "${entry.label}" (${node.type}) failed: ${entry.error}`);
            }

            nodeState.set(node.id, 'done');
            scope.nodes[node.id] = output;
            scope.last = output;
            // Per-node output mapping: an optional `forward` template shapes what
            // flows downstream (drag data tags into the node's Output box). Blank
            // → forward the whole raw output. Evaluated with this node's own
            // output already available as {{last}} / {{nodes.<id>}}. Skipped when
            // the output carries a gate `_handle` so branch routing is preserved.
            const fwdTmpl = node.data ? node.data.forward : undefined;
            const hasFwd = typeof fwdTmpl === 'string' ? fwdTmpl.trim() !== '' : (fwdTmpl !== undefined && fwdTmpl !== null);
            if (hasFwd && !(output && typeof output === 'object' && output._handle)) {
                try {
                    const mapped = interpolate(fwdTmpl, scope);
                    output = mapped;
                    scope.nodes[node.id] = mapped;
                    scope.last = mapped;
                } catch (_) { /* keep raw output if the mapping template errors */ }
            }
            result = output;
            entry.status = 'completed';
            entry.finishedAt = new Date().toISOString();
            entry.output = summarizeOutput(output);
            onEvent({ type: 'node_finish', nodeId: node.id, status: 'completed', output: entry.output });

            // 4. Activate/prune outgoing edges. Any node whose output carries a
            //    `_handle` (gate.if / gate.switch / gate.filter) routes only the
            //    edges leaving that handle; edges with no sourceHandle stay active.
            const chosenHandle = (output && typeof output._handle === 'string') ? output._handle : null;
            for (const e of outgoing.get(node.id)) {
                let active = true;
                if (chosenHandle != null && e.sourceHandle != null) {
                    active = (e.sourceHandle === chosenHandle);
                }
                edgeState.set(edgeKey(e), active ? 'active' : 'pruned');
                if (active) onEvent({ type: 'edge_active', edgeId: e.id, source: e.source, target: e.target });
            }
        }

        onEvent({ type: 'run_finish', status: 'completed' });
        return { status: 'completed', result, error: null, timeline };
    } catch (err) {
        const message = err.message === 'aborted' ? 'Run cancelled' : (err.message || String(err));
        onEvent({ type: 'run_finish', status: 'failed', error: message });
        return { status: 'failed', result, error: message, timeline };
    }
}

// Keep persisted/streamed node outputs from ballooning — cap large blobs.
function summarizeOutput(output) {
    try {
        const s = JSON.stringify(output);
        if (s.length <= 4000) return output;
        return { _truncated: true, preview: s.slice(0, 4000) + '…' };
    } catch {
        return { _unserializable: true };
    }
}

// ---------------------------------------------------------------------------
// Cron matching (self-contained — no dependency). The scheduler ticks every
// 60s, so we only need "does this minute match the expression", not next-run
// computation. Supports the standard 5 fields (min hour dom month dow) with
// *, */n, a, a-b, a,b,c and combinations. Sunday is 0 or 7.
// ---------------------------------------------------------------------------
function parseCronField(field, min, max) {
    if (field === '*' || field === '?') return null; // null = wildcard (matches anything)
    const allowed = new Set();
    for (const part of String(field).split(',')) {
        let step = 1;
        let range = part;
        const slash = part.split('/');
        if (slash.length === 2) { range = slash[0]; step = parseInt(slash[1], 10) || 1; }
        let lo, hi;
        if (range === '*') { lo = min; hi = max; }
        else if (range.includes('-')) { const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10); }
        else { lo = hi = parseInt(range, 10); }
        if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
        for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) allowed.add(v);
    }
    return allowed;
}

function cronMatches(expr, date = new Date()) {
    if (!expr || typeof expr !== 'string') return false;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minF, hourF, domF, monF, dowF] = parts;
    const min = parseCronField(minF, 0, 59);
    const hour = parseCronField(hourF, 0, 23);
    const dom = parseCronField(domF, 1, 31);
    const mon = parseCronField(monF, 1, 12);
    const dow = parseCronField(dowF, 0, 7);
    const mt = (set, v) => set === null || set.has(v);

    const M = date.getMinutes(), H = date.getHours(), D = date.getDate(), MO = date.getMonth() + 1, DW = date.getDay();
    const dowMatch = dow === null ? true : (dow.has(DW) || (DW === 0 && dow.has(7)));
    // cron quirk: when BOTH day-of-month and day-of-week are restricted, the
    // day matches if EITHER does; otherwise both must hold.
    const dayMatch = (dom !== null && dow !== null) ? (mt(dom, D) || dowMatch) : (mt(dom, D) && dowMatch);

    return mt(min, M) && mt(hour, H) && dayMatch && mt(mon, MO);
}

module.exports = {
    runWorkflow,
    evalCondition,
    interpolate,
    cronMatches,
    BUILTIN_NODE_TYPES,
};
