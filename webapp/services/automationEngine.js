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
    { key: 'trigger.schedule', type: 'trigger.schedule', category: 'trigger', label: 'Schedule',         description: 'Starts on a fixed interval (intervalMs), a single cron, multiple crons (crons:[]) for different days/times, or one-off ISO timestamps (runAt:[]).', outputs: ['out'], defaults: { intervalMs: 300000 }, fields: ['cron', 'crons', 'runAt', 'intervalMs'] },
    { key: 'trigger.webhook',  type: 'trigger.webhook',  category: 'trigger', label: 'Inbound Webhook',  description: 'Starts when its (token-gated) webhook URL is POSTed to. The request body becomes the run input.', outputs: ['out'] },
    { key: 'trigger.event',    type: 'trigger.event',    category: 'trigger', label: 'On Event',         description: 'Starts on a system event (e.g. model.loaded). The event payload becomes the run input.', outputs: ['out'], fields: ['event'] },
    { key: 'trigger.telegram', type: 'trigger.telegram', category: 'trigger', label: 'Telegram Message', description: 'Starts when the bot receives a message (optionally matching a keyword). Polls getUpdates; the message becomes the run input ({{input.text}}, {{input.chat.id}}).', outputs: ['out'], fields: ['botToken', 'chatId', 'keyword', 'match'] },
    { key: 'trigger.slack', type: 'trigger.slack', category: 'trigger', label: 'Slack: New Message', description: 'Starts when a new message appears in a Slack channel (optionally matching a keyword). Polls conversations.history with a bot token (xoxb-…) that is a member of the channel and has the channels:history scope. The message becomes the run input ({{input.text}}, {{input.user}}, {{input.channel}}).', outputs: ['out'], fields: ['botToken', 'channel', 'keyword', 'match'] },

    // --- Connectors (do work) ---
    { key: 'model',       type: 'model',      category: 'connector', label: 'Model / LLM call', description: 'Runs a prompt through a loaded model.', inputs: ['in'], outputs: ['out'], fields: ['prompt', 'systemPrompt', 'model', 'temperature', 'maxTokens'] },
    { key: 'web_search',  type: 'web_search', category: 'connector', label: 'Web Search',       description: 'Searches the web (DuckDuckGo → Brave fallback).', inputs: ['in'], outputs: ['out'], fields: ['query', 'limit'] },
    { key: 'fetch_url',   type: 'fetch_url',  category: 'connector', label: 'Fetch URL',        description: 'Fetches and extracts the content of a URL. Automatically handles JavaScript/SPA pages and bot protection (static fetch → stealth → real browser) — no separate Playwright/Scrapling node needed.', inputs: ['in'], outputs: ['out'], fields: ['url', 'maxLength'] },
    { key: 'playwright_fetch', type: 'tool', category: 'connector', label: 'Playwright Fetch', description: 'Fetches a JS-rendered page with a real browser (Playwright + stealth). Use for SPAs / lazy-loaded / dynamic pages where Fetch URL returns empty or wrong content. Args: { "url": "https://…", "timeout": 15000, "maxLength": 8000, "waitForJS": true }.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'playwright_fetch' }, fields: ['args'] },
    { key: 'scrapling_fetch', type: 'tool', category: 'connector', label: 'Scrapling Fetch', description: 'Fetches a page with Scrapling stealth — the strongest anti-bot option (Cloudflare / DataDome / "Just a moment" / CAPTCHA-gated sites). Slower; use when Fetch URL or Playwright Fetch come back thin/blocked. Args: { "url": "https://…", "timeout": 30000, "maxLength": 15000 }.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'scrapling_fetch' }, fields: ['args'] },
    { key: 'parse_json',  type: 'parse_json', category: 'connector', label: 'Parse JSON',       description: 'Parses a JSON string (or passes an object through) and optionally extracts a dotted path.', inputs: ['in'], outputs: ['out'], fields: ['source', 'path'] },
    { key: 'parse_rss',   type: 'tool',       category: 'connector', label: 'Parse RSS / Atom Feed', description: 'Fetches and parses an RSS or Atom news/blog feed into a clean list of items. Args: { "url": "https://site.com/feed" } (the feed is fetched for you) — or pass raw feed XML as "content". Returns { feedTitle, count, items: [{title, link, summary, published, id}] }. Use this for ANY RSS/Atom feed — NOT http_request+parse_json (which cannot parse XML) and NOT a run_python XML parser. Then db_store the items with key="link" (or "id") to report only newly-published stories.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'parse_rss' }, fields: ['args'] },
    { key: 'render_html', type: 'render_html',category: 'connector', label: 'Render HTML',      description: 'Renders HTML (or wraps text/JSON) into a viewable HTML result.', inputs: ['in'], outputs: ['out'], fields: ['html'] },
    { key: 'export_file', type: 'export_file',category: 'connector', label: 'Export File',      description: 'Writes the incoming data to a downloadable file (pdf, csv, txt, md, html, json).', inputs: ['in'], outputs: ['out'], fields: ['format', 'filename', 'content'] },
    { key: 'slack',       type: 'slack',      category: 'connector', label: 'Slack Message',    description: 'Posts a message to Slack. If a previous step produced a file (PDF/image/CSV…) it is uploaded as an attachment — this needs a bot token (xoxb-…) + channel id; otherwise it posts text to an incoming-webhook URL.', inputs: ['in'], outputs: ['out'], fields: ['webhookUrl', 'text', 'botToken', 'channel', 'attachFile'] },
    { key: 'telegram',    type: 'telegram',   category: 'connector', label: 'Telegram Message', description: 'Sends a message via a Telegram bot (Bot API token + chat id). If a previous step produced a file (e.g. Create PDF), it is sent as a document automatically with any text as the caption — just wire "Create PDF → Telegram".', inputs: ['in'], outputs: ['out'], fields: ['botToken', 'chatId', 'text', 'attachFile'] },
    { key: 'telegram_get',type: 'telegram_get',category: 'connector', label: 'Get Telegram Messages', description: 'Fetches the bot\'s recent messages on demand (getUpdates). Do NOT use on a bot that also has a Telegram trigger — getUpdates conflicts.', inputs: ['in'], outputs: ['out'], fields: ['botToken', 'limit'] },
    { key: 'send_file',   type: 'send_file',  category: 'connector', label: 'Send File',        description: 'Sends a file produced by a previous step (PDF, image, CSV…) to Telegram, Slack, or any HTTP endpoint. Auto-uses the upstream node\'s generated file. Set "to": telegram (botToken+chatId), slack (botToken xoxb- + channel), or http (url).', inputs: ['in'], outputs: ['out'], fields: ['to', 'botToken', 'chatId', 'channel', 'url', 'caption'] },
    { key: 'http_request',type: 'tool',       category: 'connector', label: 'HTTP Request',     description: 'Calls an HTTP endpoint (SSRF-guarded — private IPs blocked).', inputs: ['in'], outputs: ['out'], defaults: { tool: 'http_request' }, fields: ['args'] },
    { key: 'crawl',       type: 'tool',       category: 'connector', label: 'Crawl Pages',      description: 'Crawls and extracts content from multiple linked pages. Args: { "url": "https://…", "maxPages": 5 }.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'crawl_pages' }, fields: ['args'] },
    { key: 'sqlite',      type: 'tool',       category: 'connector', label: 'SQLite Query',     description: 'Runs SQL against an EXISTING SQLite file. Args: { "path": "/workspace/<file>.db", "query": "SELECT …" } — "path" is required. For this automation\'s own collected data use the Database Store / Database Query nodes instead.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'query_sqlite' }, fields: ['args'] },
    { key: 'render_chart',type: 'tool',       category: 'connector', label: 'Render Chart',     description: 'Renders a chart SPEC for inline display in chat (not a file). For a chart IMAGE you can embed in a PDF, use chart_plot instead.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'render_chart' }, fields: ['args'] },
    { key: 'chart_plot',  type: 'tool',       category: 'connector', label: 'Plot Chart (PNG)', description: 'Renders a chart as a real PNG image saved into the workspace (downloadable, and embeddable in a PDF). Args: { "type": "line|bar|scatter|pie", "x": [...], "y": [...], "title": "...", "xlabel": "...", "ylabel": "..." } (or a CSV "path" + "x_col"/"y_col"). Returns { file, workspacePath, data_url }. To put the chart IN a PDF: chart_plot → create_pdf whose markdown content embeds it as ![chart]({{nodes.<chartId>.file}}) — always reference .file, never a hand-written filename (the PNG name is generated at run time).', inputs: ['in'], outputs: ['out'], defaults: { tool: 'chart_plot' }, fields: ['args'] },
    { key: 'fetch_timeseries', type: 'tool',  category: 'connector', label: 'Fetch Time Series', description: 'Fetches free OHLC price history (stocks, indices, FX, crypto) from Yahoo Finance — no API key. Args: { "symbol": "AAPL", "period": "1mo|3mo|6mo|1y|2y|5y|ytd|max", "interval": "d|w|m" } (daily/weekly/monthly; NO intraday). Indices use ^GSPC / ^DJI / ^IXIC; FX like EURUSD=X; crypto like BTC-USD. Returns { symbol, count, data: [{date, close, open, high, low, volume}] } — the rows are in .data. Feed .data into chart_plot (x = .data.*.date, y = .data.*.close) for a graph and into a model for the written analysis.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'fetch_timeseries' }, fields: ['args'] },
    { key: 'create_pdf',  type: 'tool',       category: 'connector', label: 'Create PDF',       description: 'Generates a PDF from MARKDOWN content (headings, tables, bullets, code, links). For styled HTML (CSS layouts/fonts) use the "HTML to PDF" node instead. Leave args.content blank to use the previous step\'s output. The PDF is downloadable; to send or process it, connect another node after this (a Telegram/Slack/Send File node auto-sends the file as a document; any other node receives it too). Optional "sendMode": "pdf" (default, file only) | "both" (data + file) | "data" (the rendered text only, no file) controls what flows to the next node.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'create_pdf' }, fields: ['args'] },
    { key: 'html_to_pdf', type: 'tool',       category: 'connector', label: 'HTML to PDF',      description: 'Renders styled HTML (CSS layouts, web fonts, tables) to a PDF via WeasyPrint. Use this for HTML; use Create PDF for markdown. Args: { "content": "<html>…</html>", "outputName": "report.pdf" } (or "htmlPath": a /workspace HTML file). Leave args.content blank to use the previous step\'s output. The PDF is downloadable; to send or process it, connect another node after this (a Telegram/Slack/Send File node auto-sends the file as a document; any other node receives it too). Optional "sendMode": "pdf" (default) | "both" | "data" controls what flows to the next node.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'html_to_pdf' }, fields: ['args'] },
    { key: 'create_file', type: 'tool',       category: 'connector', label: 'Create File',      description: 'Writes a file into the run workspace. Args: { "filePath": "artifacts/<name>.<ext>", "content": "…" } — the arg is "filePath" (NOT "filename"), and it must be under artifacts/ to be downloadable. For a CSV/TXT/MD/JSON download prefer the Export File node.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'create_file' }, fields: ['args'] },
    { key: 'run_python',  type: 'tool',       category: 'connector', label: 'Script Block',      description: 'Runs a Python script in the sandbox for data transforms / glue between nodes (stdlib + Pillow/openpyxl, ffmpeg, requests). The script is shown and editable in the node settings panel. Args: { "code": "print(...)", "timeout": 30000 }. Reference upstream output via {{last}} / {{nodes.<id>}} inside the code string.', inputs: ['in'], outputs: ['out'], defaults: { tool: 'run_python' }, fields: ['args'] },
    { key: 'db_store',    type: 'db_store',   category: 'connector', label: 'Database: Store',   description: 'Appends the incoming data to a persistent per-automation database table (auto-created, lives in this workflow\'s workspace). Each item of a list becomes its own row, so "fetch/search → Store" collects results across runs. Set a Unique key field (e.g. "url" or "id") to deduplicate — only unseen records are stored and the new ones are returned in `.new` (use this to track changes between runs). The key can be a comma-separated fallback list (first non-empty wins, e.g. "link,post_title") so a stable id is used when present. For a stable identity (so re-listed/edited records don\'t re-appear as new) add Ignore-words (e.g. "NEW") and/or turn on Normalize. Defaults: table "records", db "automation.db".', inputs: ['in'], outputs: ['out'], fields: ['table', 'db', 'value', 'key', 'keyStrip', 'keyNormalize'] },
    { key: 'db_query',    type: 'db_query',   category: 'connector', label: 'Database: Query',   description: 'Reads rows back from the database (newest first) so you can feed the collected data into a model / Telegram / file. Defaults: table "records", limit 100, order "id DESC". For advanced reads provide a raw SELECT (records are JSON in a `data` column alongside `id`,`ts`; filter with json_extract(data,\'$.field\')) — a model node can generate this SQL. Output is the array of stored records.', inputs: ['in'], outputs: ['out'], fields: ['table', 'db', 'limit', 'order', 'sql'] },
    { key: 'track_changes', type: 'track_changes', category: 'connector', label: 'Track Changes', description: 'Watches a SINGLE source (a web page, an API response, or any text) for changes BETWEEN runs and reports WHAT changed. Give it a stable "key" (e.g. the page URL) and the "content" to watch (leave blank to use the previous step\'s output — it auto-reads a Fetch URL page body or an HTTP Request body). It stores the latest snapshot per key; when the content differs from the last run it returns changed=true plus a human-readable diff, the added/removed lines, and a revision number. The FIRST run stores a baseline (changed=false) so nothing fires until there is a real change. This is the node for "monitor a page and tell me what changed" — use db_store instead only for FEEDS where new ITEMS appear over time. Pair with: gate.if on {{nodes.<id>.changed}} (op not_empty / == true) → model (summarize {{nodes.<id>.diff}}) → telegram/slack. Volatile content (session tokens, uuids, timestamps, "N hours ago") is ignored by default so a dynamic page does not read as "changed" on every fetch — set ignoreVolatile=false only when the volatile bytes ARE the thing being watched (e.g. a checksum). Set ignoreWhitespace to ignore pure spacing changes.', inputs: ['in'], outputs: ['out'], fields: ['key', 'content', 'table', 'ignoreWhitespace', 'ignoreVolatile'] },
    { key: 'tool',        type: 'tool',       category: 'connector', label: 'Run Tool / Skill', description: 'Invokes any enabled skill or native tool by name.', inputs: ['in'], outputs: ['out'], fields: ['tool', 'args'] },
    { key: 'delay',       type: 'delay',      category: 'connector', label: 'Delay / Wait',     description: 'Pauses the workflow for N milliseconds.', inputs: ['in'], outputs: ['out'], fields: ['ms'] },
    { key: 'set',         type: 'set',        category: 'connector', label: 'Set Variable',     description: 'Stores a value in the run scope for later nodes.', inputs: ['in'], outputs: ['out'], fields: ['name', 'value'] },
    { key: 'map',         type: 'map',        category: 'connector', label: 'Loop / Map',       description: 'Runs an action for each item of a list (e.g. fetch each search-result URL) and collects the results. Each item is available as {{item}} (and {{index}}).', inputs: ['in'], outputs: ['out'], fields: ['items', 'action', 'tool', 'args', 'prompt', 'systemPrompt', 'model', 'maxConcurrency'] },

    // --- Logic gates ---
    { key: 'gate.if',     type: 'gate.if',     category: 'gate', label: 'If / Else', description: 'Branches on a condition (true / false handles).', inputs: ['in'], outputs: ['true', 'false'], fields: ['condition'] },
    { key: 'gate.switch', type: 'gate.switch', category: 'gate', label: 'Switch',    description: 'N-way branch: routes to the handle of the first matching case, else "default".', inputs: ['in'], outputs: ['default'], fields: ['value', 'cases'] },
    { key: 'gate.filter', type: 'gate.filter', category: 'gate', label: 'Filter',    description: 'Continues only when its condition holds; otherwise that branch stops.', inputs: ['in'], outputs: ['out'], fields: ['condition'] },
    { key: 'merge',       type: 'merge',       category: 'gate', label: 'Merge',     description: 'Joins multiple branches: collects all incoming outputs into one list.', inputs: ['in'], outputs: ['out'] },

    // --- Terminal ---
    { key: 'output', type: 'output', category: 'output', label: 'Output / End', description: 'Marks a workflow result.', inputs: ['in'] },
];

const MAX_DELAY_MS = 5 * 60 * 1000; // a delay node can wait at most 5 minutes
const MAX_PARALLEL_NODES = 8;       // max nodes run concurrently within one wave

// Run async work over `items` with a fixed concurrency cap, preserving order.
async function runWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

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
    // Normalize bracket indexing to dotted form so the natural shapes a model
    // emits resolve: a[0].b → a.0.b, a["k"]/a['k'] → a.k, a[*] → a.*.
    const normalized = String(pathStr).trim()
        .replace(/\[\s*(\d+)\s*\]/g, '.$1')
        .replace(/\[\s*["']([^"']+)["']\s*\]/g, '.$1')
        .replace(/\[\s*\*\s*\]/g, '.*');
    const parts = normalized.split('.').filter(Boolean);
    if (!parts.length) return undefined;
    const head = parts[0];
    // A bare field ref — anything that isn't input/vars/nodes/last — resolves
    // against the previous node's output, so {{title}} means {{last.title}}
    // (what users intuitively type). Falls back to the top scope if not found.
    if (!['input', 'vars', 'nodes', 'last'].includes(head) && scope && scope.last != null && typeof scope.last === 'object') {
        const viaLast = resolveParts(scope.last, parts);
        if (viaLast !== undefined) return viaLast;
    }
    return resolveParts(scope, parts);
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

// Operator aliases → canonical form, so friendly UI labels ("equals", "regex")
// and raw JSON ("==", "matches") both work.
function normalizeOp(op) {
    const o = String(op == null ? '==' : op).trim();
    const aliases = {
        equals: '==', eq: '==', is: '==', not_equals: '!=', neq: '!=', ne: '!=', isnt: '!=',
        greater: '>', gt: '>', less: '<', lt: '<', gte: '>=', at_least: '>=', lte: '<=', at_most: '<=',
        regex: 'matches', regexp: 'matches', notContains: 'not_contains',
        starts_with: 'startsWith', ends_with: 'endsWith', is_empty: 'empty', is_not_empty: 'not_empty',
    };
    return aliases[o] || o;
}

// Compare two already-resolved values by operator (no eval). Shared by gate.if,
// gate.filter (through evalCondition) and gate.switch cases. Text operators
// (contains / starts / ends / regex) are case-insensitive for friendly matching;
// `==` / `!=` stay exact.
function compareOp(left, right, op) {
    const ls = toComparable(left), rs = toComparable(right);
    const L = String(ls).toLowerCase(), R = String(rs).toLowerCase();
    switch (normalizeOp(op)) {
        case '==':                       return String(ls) === String(rs);
        case '!=':                       return String(ls) !== String(rs);
        case '>':                        { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a > b; }
        case '<':                        { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a < b; }
        case '>=':                       { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a >= b; }
        case '<=':                       { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a <= b; }
        case 'contains':                 return L.includes(R);
        case 'not_contains':             return !L.includes(R);
        case 'startsWith':               return L.startsWith(R);
        case 'endsWith':                 return L.endsWith(R);
        case 'matches':                  { try { return new RegExp(String(rs), 'i').test(String(ls)); } catch { return false; } }
        case 'empty':                    return !truthy(left);
        case 'not_empty': case 'truthy': return truthy(left);
        default:                         return false;
    }
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
        // A blank "Value to check" defaults to the previous node's output, so
        // "is not empty" / "contains" etc. work against the incoming data without
        // having to type {{last}} — matching the blank=previous-output convention
        // used by every other node.
        const hasLeft = condition.left !== undefined && condition.left !== null && String(condition.left).trim() !== '';
        const left = hasLeft ? interpolate(condition.left, scope) : scope.last;
        const right = interpolate(condition.right, scope);
        return compareOp(left, right, condition.op);
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

// Split `text` into chunks no longer than `max` chars, preferring to break on
// paragraph, then line, then word boundaries so messages stay readable. Caps the
// result at `maxParts` chunks (the last one is hard-truncated with an ellipsis)
// so a pathological input can't fan out into hundreds of sends. Used to keep
// Telegram messages under its 4096-char hard limit.
function chunkText(text, max = 4000, maxParts = 20) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return [s];
    const chunks = [];
    let rest = s;
    while (rest.length > max && chunks.length < maxParts - 1) {
        let cut = rest.lastIndexOf('\n\n', max);
        if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max; // no good boundary — hard cut
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest.length > max) rest = rest.slice(0, max - 1).trimEnd() + '…';
    if (rest) chunks.push(rest);
    return chunks;
}

// Detect a generated file (a sandboxed skill's `_artifacts` entry) among the
// given candidate values. Handles a node's whole output ({ _artifacts:[…] }) and
// a forwarded artifacts array ([{ name, url, … }]) so "Create PDF → Telegram"
// works whether the PDF node forwards its full output or just its artifacts.
// Returns the first artifact { name, url, size, runId } or null.
function firstArtifact(...candidates) {
    const isArt = (a) => a && typeof a === 'object' && a.name && (a.url || a.runId);
    for (const c of candidates) {
        if (!c) continue;
        if (Array.isArray(c)) { if (isArt(c[0])) return c[0]; continue; }
        if (typeof c === 'object' && Array.isArray(c._artifacts) && isArt(c._artifacts[0])) return c._artifacts[0];
    }
    return null;
}

// Like firstArtifact, but also returns the send preferences a PDF node tagged
// onto its output: `sendMode` ('pdf' | 'both' | 'data') and `pdfData` (the text
// that was rendered into the file). Lets a downstream Telegram/Slack node honor
// the Create PDF node's "what to send" choice. sendMode is null when the carrier
// didn't set one (any non-PDF artifact) → callers default to file-only.
function upstreamFileInfo(...candidates) {
    const isArt = (a) => a && typeof a === 'object' && a.name && (a.url || a.runId);
    for (const c of candidates) {
        if (!c) continue;
        if (Array.isArray(c)) { if (isArt(c[0])) return { art: c[0], sendMode: null, pdfData: null }; continue; }
        if (typeof c === 'object' && Array.isArray(c._artifacts) && isArt(c._artifacts[0])) {
            return {
                art: c._artifacts[0],
                sendMode: (c._sendMode === 'pdf' || c._sendMode === 'both' || c._sendMode === 'data') ? c._sendMode : null,
                pdfData: (typeof c._pdfData === 'string' && c._pdfData) ? c._pdfData : null,
            };
        }
    }
    return { art: null, sendMode: null, pdfData: null };
}

// Send `text` to a Telegram chat, splitting over the 4096-char limit into
// chunks (see chunkText). Shared by the plain-text path and the "data + PDF" /
// "data only" send modes. Throws with a helpful hint on failure.
async function sendTelegramText(deps, ctx, node, token, chatId, text) {
    const chunks = chunkText(text, 4000, 20);
    let response;
    for (const part of chunks) {
        response = await dispatchTool(deps, ctx, node, 'http_request', {
            url: `https://api.telegram.org/bot${token}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: part }),
        });
        const fail = httpFailureMessage(response);
        if (fail) {
            const hint = /403|forbidden/i.test(fail)
                ? ' (the chat must message the bot first, or check the chat id / that the bot is a channel admin)'
                : '';
            throw new Error(`Telegram send failed — ${fail}${hint}`);
        }
    }
    return { response, parts: chunks.length };
}

// Upload a workspace artifact to telegram / slack / http via the send_file skill.
// Shared by the smart Telegram/Slack send nodes and the Create PDF "Send to"
// delivery option. Throws on a skill-level failure so the user sees it.
async function deliverArtifact(deps, ctx, node, destination, opts, artifactName, caption) {
    const args = { destination, path: 'artifacts/' + artifactName, caption: caption || '' };
    if (destination === 'telegram') { args.botToken = opts.botToken; args.chatId = opts.chatId; }
    else if (destination === 'slack') { args.botToken = opts.botToken; args.channel = opts.channel; }
    else if (destination === 'http') { args.url = opts.url; }
    const r = await dispatchTool(deps, ctx, node, 'send_file', args);
    if (r && r.success === false) throw new Error(`couldn't send the file — ${r.error || 'unknown error'}`);
    return r;
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

// A gate's own output is a ROUTING object ({result,_handle} / {pass,_handle,value}),
// not the data that flowed through it. Anything consuming "the previous output"
// must see the DATA the gate let past — otherwise a `… → gate.if → model` with a
// bare prompt hands the model the literal {"result":true,"_handle":"true"} and it
// dutifully explains that object to the user (and a create_pdf after a gate
// typesets it). Unwrap routing objects back to their payload.
// Tools whose whole purpose is to RETRIEVE the thing the workflow reasons about.
// If one of these fails, everything downstream is reasoning about an error object,
// so the node must fail rather than pass the failure off as content. (Deliberately
// NOT every tool: a create_pdf/db_store failure is already thrown by its own
// handler, and a generic skill may use `success:false` to mean a legitimate
// negative result.)
const RETRIEVAL_TOOLS = new Set(['fetch_url', 'web_search', 'http_request', 'parse_rss',
    'crawl_pages', 'scrapling_fetch', 'playwright_fetch', 'fetch_timeseries']);

// null when the payload looks like a successful retrieval, else why it failed.
function retrievalFailureMessage(out) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
    if (out.success === false) return String(out.error || out.message || 'the request did not succeed');
    if (typeof out.status === 'number' && out.status >= 400) {
        return `HTTP ${out.status}${out.error ? ` — ${out.error}` : ''}`;
    }
    // web_search's rate-limit / all-backends-down shape: { error, retryable }
    if (typeof out.error === 'string' && out.error) return out.error;
    return null;
}

// Reads the DEDICATED `_payload` key, never `value`: gate.switch's `value` is its
// comparison OPERAND (the interpolated thing it matched on), not the data that
// flowed through — unwrapping to that would hand the next node the compare string
// instead of its content. A routing object with no `_payload` yields undefined and
// is dropped, so a bare {result,_handle} can never leak downstream.
function unwrapGateValue(v) {
    if (v && typeof v === 'object' && typeof v._handle === 'string') {
        return v._payload;
    }
    return v;
}

// The output of THIS node's own active upstream — not `scope.last`, which is a
// single run-global slot overwritten by whichever node happened to finish last in
// the parallel wave. With N independent branches in one wave (the canonical "watch
// these 3 pages" shape) every blank-default node was reading a SIBLING's output:
// e.g. three track_changes nodes all snapshotted the same page's body.
function previousOutput(scope, inputs) {
    const vals = (Array.isArray(inputs) ? inputs : [])
        .map(unwrapGateValue)
        .filter(v => v !== undefined);
    if (vals.length === 1) return vals[0];
    if (vals.length > 1) return vals;
    return scope.last;   // entry nodes / no active input
}

async function runNode(node, runScope, deps, ctx, rawInputs = []) {
    const type = node.type || 'output';
    // Per-node view of the run scope: `last` (and therefore every blank
    // "use the previous output" default, plus {{last}} in any template) resolves
    // to THIS node's own upstream. `nodes`/`vars`/`input` stay the shared objects
    // by reference, so a `set` node still writes through to the run scope.
    const inputs = (Array.isArray(rawInputs) ? rawInputs : []).map(unwrapGateValue).filter(v => v !== undefined);
    const scope = { ...runScope, last: previousOutput(runScope, rawInputs) };
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
                // Suppress chain-of-thought by default: a model step's output is the
                // ANSWER that flows downstream, and reasoning just adds latency (and
                // can truncate the answer at small max_tokens). Opt back in per node
                // with data.enableThinking:true for an analytical step that benefits.
                disableThinking: data.enableThinking ? false : true,
            });
            // The model's response IS the node's output, so it flows cleanly to the
            // next node (and the Output box defaults to forwarding it as-is). The
            // author can still reshape it with {{last}} / text in the Output box.
            return text != null ? String(text) : '';
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
                args = (data.args && typeof data.args === 'object') ? { ...data.args } : {};
                // Tolerate the common authoring/LLM mistake of putting a tool's
                // parameters at the node-data TOP LEVEL instead of under `args`
                // (e.g. create_pdf with content/filename as siblings of `tool`).
                // Fold any non-reserved top-level data field into args without
                // clobbering an explicit args entry — so the tool gets its params
                // either way and we stop hitting "content … is required".
                const RESERVED = new Set(['args', 'tool', 'label', 'kind', 'status', 'forward', 'description', 'model', 'temperature', 'maxTokens', 'delivery', 'botToken', 'chatId', 'channel', 'caption', 'sendMode']);
                for (const k of Object.keys(data)) {
                    if (!RESERVED.has(k) && !(k in args)) args[k] = data[k];
                }
                // Auto-flow for the PDF connectors: if `content` is left blank (and
                // no workspace file is referenced), default it to the incoming node
                // output(s) so a connected "<node> → Create PDF / HTML to PDF" just
                // works without manual templating — mirroring the Model node's
                // auto-attach. Explicit content (or contentFile/htmlPath) opts out.
                if (toolName === 'create_pdf' || toolName === 'html_to_pdf') {
                    const hasContent = args.content != null && String(args.content).trim() !== '';
                    const hasFileRef = (args.contentFile != null && String(args.contentFile).trim() !== '')
                        || (args.htmlPath != null && String(args.htmlPath).trim() !== '');
                    if (!hasContent && !hasFileRef && Array.isArray(inputs) && inputs.length) {
                        args.content = inputs.map(v => stringifyValue(v)).join('\n\n');
                    }
                }
            }
            const msg = await deps.executeToolCall(
                { id: `auto-${node.id}`, function: { name: toolName, arguments: JSON.stringify(args) } },
                { userId: ctx.userId, apiKeyData: ctx.apiKeyData, conversationId: null, workspaceBucket: ctx.workspaceBucket }
            );
            let parsed;
            try { parsed = JSON.parse(msg.content); } catch { parsed = { raw: msg.content }; }
            // "Send to" delivery built into the PDF connectors: after the file is
            // generated, optionally upload it to Telegram/Slack (one node builds +
            // sends). The artifact chip is still returned so it stays downloadable.
            if ((toolName === 'create_pdf' || toolName === 'html_to_pdf') && data.delivery && data.delivery !== 'download') {
                const art = firstArtifact(parsed);
                if (art) {
                    const dest = String(data.delivery);
                    const opts = { botToken: data.botToken, chatId: data.chatId, channel: data.channel };
                    const caption = (data.caption !== undefined && data.caption !== '') ? String(data.caption) : '';
                    const r = await deliverArtifact(deps, ctx, node, dest, opts, art.name, caption);
                    parsed._delivered = { to: dest, file: art.name, ok: !(r && r.success === false) };
                }
            }
            // Tag the PDF output with the "what to send" choice + the rendered
            // content so a downstream Telegram/Slack node can send the file only,
            // the data + file, or the data only. The artifact is always returned
            // (the file stays downloadable) regardless of the mode.
            if ((toolName === 'create_pdf' || toolName === 'html_to_pdf') && parsed && typeof parsed === 'object') {
                parsed._sendMode = (data.sendMode === 'both' || data.sendMode === 'data') ? data.sendMode : 'pdf';
                const rendered = args.content != null ? String(args.content) : '';
                if (rendered.trim()) parsed._pdfData = rendered;
            }
            // A FAILED retrieval must FAIL THE NODE — never flow downstream as data.
            //
            // This is what made monitoring automations LIE. fetch_url returns
            // { success:false, error:'HTTP 404' } and that object used to flow on as
            // if it were the page: track_changes then snapshots the ERROR TEXT, so
            // the moment the site comes back the diff "changes" and the user gets
            // "the page changed!"; a release-monitor's db_store stores the error row
            // and announces "New release!"; an in-stock verdict model sees empty
            // content and answers "IT'S AVAILABLE". All three were reproduced live.
            // A monitor that fires false alerts is worse than one that is silent, so
            // fail loudly and let the run surface the broken source.
            if (RETRIEVAL_TOOLS.has(toolName)) {
                const why = retrievalFailureMessage(parsed);
                if (why) throw new Error(`${toolName} failed — ${why}`);
            }
            return parsed;
        }

        case 'db_store': {
            // Append incoming data to a persistent per-workflow SQLite collection.
            // With `key`, only unseen records are stored and returned in `.new`.
            const value = (data.value === undefined || data.value === '') ? scope.last : data.value;
            const args = {
                action: 'store',
                db: data.db || 'automation.db',
                table: data.table || 'records',
                value,
            };
            if (data.key && String(data.key).trim()) args.key = String(data.key).trim();
            if (data.keyStrip && String(data.keyStrip).trim()) args.keyStrip = String(data.keyStrip).trim();
            if (data.keyNormalize === true || data.keyNormalize === 'true') args.keyNormalize = true;
            const r = await dispatchTool(deps, ctx, node, 'workspace_db', args);
            if (r && r.success === false) throw new Error(`Database store failed — ${r.error || 'unknown error'}`);
            // The store FAILS OPEN when the configured `key` isn't a field of the
            // records: it inserts them unkeyed, so every run re-reports every row as
            // "new" and the dedupe gate downstream fires forever. The skill now
            // reports keyMissing; make it visible on the node output so assessRunHealth
            // can flag it and the repair loop gets told the real field names.
            return r; // { stored, skipped, total, new, table, db, keyFields?, keyMissing?, keyWarning? }
        }

        case 'db_query': {
            // Read rows back (newest first) so they can flow to a model/Telegram/etc.
            const args = { action: 'query', db: data.db || 'automation.db', table: data.table || 'records' };
            if (data.sql && String(data.sql).trim()) {
                args.sql = String(data.sql);
                if (Array.isArray(data.params)) args.params = data.params;
            } else {
                args.limit = (data.limit != null && data.limit !== '') ? Number(data.limit) : 100;
                args.order = data.order || 'id DESC';
            }
            const r = await dispatchTool(deps, ctx, node, 'workspace_db', args);
            if (r && r.success === false) throw new Error(`Database query failed — ${r.error || 'unknown error'}`);
            // Output the array of records directly so downstream nodes (model fan-in,
            // {{nodes.id}} / {{nodes.id.*.field}}) get clean data.
            return (r && Array.isArray(r.rows)) ? r.rows : (r || []);
        }

        case 'track_changes': {
            // Watch ONE source for changes between runs and emit the diff. The
            // content defaults to the previous node's output; fetch_url puts the
            // page in .content and http_request in .data, so unwrap those so a
            // bare "<fetch> → Track Changes" wiring just works.
            let content = (data.content === undefined || data.content === '') ? scope.last : data.content;
            if (content && typeof content === 'object' && !Array.isArray(content)) {
                if (typeof content.content === 'string') content = content.content;      // fetch_url
                else if (typeof content.data === 'string') content = content.data;       // http_request
                else if (typeof content.text === 'string') content = content.text;       // model node
                else content = stringifyValue(content);
            } else if (content != null && typeof content !== 'string') {
                content = stringifyValue(content);
            }
            const args = {
                action: 'track',
                db: data.db || 'automation.db',
                table: data.table || 'snapshots',
                key: (data.key && String(data.key).trim()) || 'page',
                content: content == null ? '' : String(content),
            };
            if (data.ignoreWhitespace === true || data.ignoreWhitespace === 'true') args.ignoreWhitespace = true;
            // Volatile masking is ON by default in the skill (session tokens /
            // uuids / "N hours ago" churn otherwise makes every run "changed");
            // only an explicit opt-out is forwarded.
            if (data.ignoreVolatile === false || data.ignoreVolatile === 'false') args.ignoreVolatile = false;
            const r = await dispatchTool(deps, ctx, node, 'track_changes', args);
            if (r && r.success === false) throw new Error(`Change tracking failed — ${r.error || 'unknown error'}`);
            return r; // { changed, firstSeen, diff, added, removed, revision, ... }
        }

        case 'parse_json': {
            // source: explicit value/template, else the previous node's output.
            let src = (data.source === undefined || data.source === '') ? scope.last : data.source;
            let obj = src;
            if (typeof src === 'string') {
                let s = src.trim();
                // Tolerate a model/LLM upstream that wraps its JSON in a ```json
                // code fence or pads it with a sentence of prose — strip the fence,
                // then fall back to slicing the outermost [...] / {...} so a clean
                // structure survives. Plain JSON.parse alone left these as a raw
                // string, so a "<model emits JSON> → parse_json → db_store" wiring
                // silently stored one junk row instead of the rows.
                try { obj = JSON.parse(s); }
                catch {
                    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
                    if (fence) s = fence[1].trim();
                    const a = s.indexOf('['), b = s.lastIndexOf(']');
                    const c = s.indexOf('{'), d = s.lastIndexOf('}');
                    // Prefer an array slice when it encloses the object slice (a list
                    // of records), else the object slice.
                    let cand = null;
                    if (a !== -1 && b > a && (c === -1 || a < c)) cand = s.slice(a, b + 1);
                    else if (c !== -1 && d > c) cand = s.slice(c, d + 1);
                    if (cand) { try { obj = JSON.parse(cand); } catch { obj = src; } }
                    else obj = src;
                }
            }
            // Tolerate JSONPath-style paths (a common model instinct): strip a
            // leading "$"/"$." root and convert ['key']/[0] bracket notation to
            // our dotted form, so "$.posts", "$['posts']" and "$.items[0].url"
            // all resolve like "posts" / "items.0.url". "$" alone → whole object.
            let path = String(data.path == null ? '' : data.path).trim();
            if (path) {
                path = path
                    .replace(/^\$/, '')                       // drop JSONPath root
                    .replace(/\[\s*'([^']*)'\s*\]/g, '.$1')   // ['key'] → .key
                    .replace(/\[\s*"([^"]*)"\s*\]/g, '.$1')   // ["key"] → .key
                    .replace(/\[\s*(\d+)\s*\]/g, '.$1')       // [0]     → .0
                    .replace(/^\.+/, '');                     // drop leading dots
            }
            if (path) {
                const val = resolvePath(obj, path);
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
            // File from a previous step → upload via files.upload (needs an xoxb-
            // bot token + channel; an incoming-webhook URL can only post text). A
            // Create PDF node carries a sendMode: pdf=file only, both=file with the
            // rendered data as its comment, data=the data as text (webhook) with no
            // file. The "Attach upstream file" toggle (default on) opts out.
            const url = String(data.webhookUrl || '').trim();
            const postText = async (text) => {
                if (!url) throw new Error('Slack: posting text needs a webhook URL (a bot token + channel can only upload files).');
                const response = await dispatchTool(deps, ctx, node, 'http_request', {
                    url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
                });
                const fail = httpFailureMessage(response);
                if (fail) throw new Error(`Slack send failed — ${fail}`);
                return response;
            };
            const info = (data.attachFile === false) ? { art: null } : upstreamFileInfo(scope.last, ...(Array.isArray(inputs) ? inputs : []));
            if (info.art) {
                const mode = info.sendMode || 'pdf';
                if (mode === 'data') {
                    const body = info.pdfData != null ? info.pdfData : ((data.text !== undefined && data.text !== '') ? String(data.text) : stringifyValue(scope.last));
                    const response = await postText(body);
                    return { sent: true, mode: 'text', response };
                }
                const botToken = String(data.botToken || '').trim();
                const channel = String(data.channel || '').trim();
                if (!botToken || !channel) {
                    throw new Error('Slack: to send a file, add a bot token (xoxb-…) and channel id — an incoming-webhook URL can only post text.');
                }
                // "both" puts the full data in the file's comment (Slack allows a
                // long initial_comment); "pdf" uses the node's text field if set.
                const caption = (mode === 'both' && info.pdfData) ? info.pdfData
                    : ((data.text !== undefined && data.text !== '') ? String(data.text) : '');
                const r = await deliverArtifact(deps, ctx, node, 'slack', { botToken, channel }, info.art.name, caption);
                // Propagate the upstream artifact so the node's "Last result" card
                // (and any further downstream node) can still surface a download chip.
                return { sent: true, mode: mode === 'both' ? 'document+text' : 'document', file: info.art.name, response: r, _artifacts: [info.art], _delivered: { to: 'slack', file: info.art.name } };
            }
            const text = (data.text === undefined || data.text === '') ? stringifyValue(scope.last) : String(data.text);
            const response = await postText(text);
            return { sent: true, response };
        }

        case 'telegram': {
            if (!deps.executeToolCall) throw new Error('Telegram node needs the tool dispatcher.');
            const token = String(data.botToken || '').trim();
            const chatId = String(data.chatId || '').trim();
            if (!token || !chatId) throw new Error('Telegram node requires a bot token and chat id.');
            // If a previous step produced a file (PDF/image/CSV…), send it — so
            // "Create PDF → Telegram" just works. A Create PDF node also carries a
            // "what to send" choice (sendMode): pdf=file only, both=file + the
            // rendered data as text, data=the data as text with no file. Other
            // artifacts (no sendMode) default to file-only. The "Attach upstream
            // file" toggle (default on) opts out of file detection entirely.
            const info = (data.attachFile === false) ? { art: null } : upstreamFileInfo(scope.last, ...(Array.isArray(inputs) ? inputs : []));
            if (info.art) {
                const mode = info.sendMode || 'pdf';
                const captionText = (data.text !== undefined && data.text !== '') ? String(data.text) : '';
                if (mode === 'data') {
                    // Data only — skip the file, send the rendered content as text.
                    const body = info.pdfData != null ? info.pdfData : (captionText || stringifyValue(scope.last));
                    const { parts } = await sendTelegramText(deps, ctx, node, token, chatId, body);
                    return { sent: true, mode: 'text', parts };
                }
                // pdf / both — send the document (Telegram caps captions at ~1024,
                // so the full data goes as separate message(s) for "both").
                const r = await deliverArtifact(deps, ctx, node, 'telegram', { botToken: token, chatId }, info.art.name, captionText);
                if (mode === 'both' && info.pdfData) {
                    const { parts } = await sendTelegramText(deps, ctx, node, token, chatId, info.pdfData);
                    return { sent: true, mode: 'document+text', file: info.art.name, parts, response: r, _artifacts: [info.art], _delivered: { to: 'telegram', file: info.art.name } };
                }
                return { sent: true, mode: 'document', file: info.art.name, response: r, _artifacts: [info.art], _delivered: { to: 'telegram', file: info.art.name } };
            }
            // No file upstream — plain text send (chunked under the 4096 limit).
            const text = (data.text === undefined || data.text === '') ? stringifyValue(scope.last) : String(data.text);
            const { response, parts } = await sendTelegramText(deps, ctx, node, token, chatId, text);
            return { sent: true, parts, response };
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

        case 'send_file': {
            if (!deps.executeToolCall) throw new Error('Send File needs the tool dispatcher.');
            const to = String(data.to || 'telegram').trim();
            // Auto-detect the file the previous step produced (its _artifacts).
            let filePath = String(data.path || '').trim();
            if (!filePath) {
                // Use the array-safe helper: `scope.last` is an ARRAY when this node
                // has more than one active input (a fan-in), and reading ._artifacts
                // straight off it would find nothing and send an empty path.
                const art = firstArtifact(scope.last, ...(Array.isArray(inputs) ? inputs : []));
                if (art && art.name) filePath = 'artifacts/' + art.name;
            }
            // `destination` (not `to`) — `to` is a sandbox PATH_ARG_NAME and would
            // be rewritten to /workspace/telegram.
            const args = { destination: to, path: filePath, caption: (data.caption !== undefined && data.caption !== '') ? String(data.caption) : '' };
            if (to === 'telegram') { args.botToken = data.botToken; args.chatId = data.chatId; }
            else if (to === 'slack') { args.botToken = data.botToken; args.channel = data.channel; }
            else if (to === 'http') { args.url = data.url; }
            const r = await dispatchTool(deps, ctx, node, 'send_file', args);
            if (r && r.success === false) throw new Error(`Send File failed — ${r.error || 'unknown error'}`);
            // Propagate the upstream artifact so it stays downloadable on the
            // Send File node card / Last result panel.
            const upstreamArt = firstArtifact(scope.last, ...(Array.isArray(inputs) ? inputs : []));
            if (upstreamArt && r && typeof r === 'object' && !Array.isArray(r._artifacts)) {
                r._artifacts = [upstreamArt];
                r._delivered = { to, file: upstreamArt.name };
            }
            return r;
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
            // Carry the gated payload through as `value` (mirrors gate.filter) so a
            // downstream node that relies on "blank = previous output" receives the
            // DATA, not this routing object. unwrapGateValue reads it back.
            return { result, _handle: result ? 'true' : 'false', _payload: scope.last ?? {} };
        }

        case 'gate.switch': {
            // Compare `value` against each case by the case's own operator
            // (default: equals). cases: [{ op?, value|equals, handle? }]. First
            // match wins, else route to 'default'. Operands are interpolated so
            // a case can reference {{...}} too.
            const raw = node.data || {};
            const value = interpolate(raw.value, scope);
            const cases = Array.isArray(raw.cases) ? raw.cases : [];
            const caseVal = (c) => (c.value !== undefined && c.value !== '') ? c.value : c.equals;
            const hit = cases.find(c => c && compareOp(value, interpolate(caseVal(c), scope), c.op || c.match || '=='));
            const handle = hit ? (hit.handle || String(interpolate(caseVal(hit), scope))) : 'default';
            return { value, matched: !!hit, _handle: handle, _payload: scope.last ?? {} };
        }

        case 'gate.filter': {
            // Continue down the 'out' handle only when the condition holds;
            // otherwise route to 'blocked' (usually unwired → branch stops).
            const pass = evalCondition(node.data ? node.data.condition : null, scope);
            return { pass, _handle: pass ? 'out' : 'blocked', value: scope.last ?? {}, _payload: scope.last ?? {} };
        }

        case 'merge': {
            // Collect every active incoming branch's output into one list.
            return { items: inputs, count: inputs.length };
        }

        case 'map': {
            // Loop/Map: run a per-item action over a list and collect results.
            // `items` resolves against the run scope; the per-item action templates
            // (args / prompt) are interpolated PER ITEM with {{item}}/{{index}} in
            // scope — so they must come from the RAW node.data (the top-of-runNode
            // `data` already stripped {{item}} against the item-less scope).
            let items = (data.items === undefined || data.items === '') ? scope.last : data.items;
            if (!Array.isArray(items)) items = (items == null) ? [] : [items];
            const MAX_ITEMS = 50;
            if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
            const action = data.action || 'tool';
            // Default concurrency raised 3 → 6 (2026-05-27) to match the
            // chat-side TOOL_PARALLELISM pool. Map's per-item work is
            // already independent (results array is index-keyed), so the
            // higher default is a strict speedup on N≥3 fan-outs.
            const conc = Math.max(1, Math.min(8, Number(data.maxConcurrency) || 6));
            const itemVar = (node.data && node.data.itemVar) || 'item';
            const rawArgs = node.data ? node.data.args : undefined;
            const rawPrompt = node.data ? node.data.prompt : '';
            const rawSystem = node.data ? node.data.systemPrompt : '';
            const results = new Array(items.length);
            let next = 0;
            const worker = async () => {
                for (;;) {
                    const i = next++;
                    if (i >= items.length) return;
                    const item = items[i];
                    const itemScope = { ...scope, [itemVar]: item, index: i };
                    try {
                        if (action === 'model') {
                            if (!deps.runModelCompletion) throw new Error('Map model action needs the model runner.');
                            const sys = interpolate(rawSystem || '', itemScope);
                            let prompt = interpolate(rawPrompt || '', itemScope);
                            if (!prompt) prompt = (typeof item === 'string') ? item : JSON.stringify(item);
                            const messages = [];
                            if (sys) messages.push({ role: 'system', content: String(sys) });
                            messages.push({ role: 'user', content: String(prompt) });
                            const text = await deps.runModelCompletion({
                                messages, model: data.model || undefined,
                                temperature: data.temperature != null ? Number(data.temperature) : undefined,
                                maxTokens: data.maxTokens != null ? Number(data.maxTokens) : undefined,
                                userId: ctx.userId,
                                // Thinking off per item by default (see model node); opt back
                                // in with data.enableThinking:true.
                                disableThinking: data.enableThinking ? false : true,
                            });
                            results[i] = text != null ? String(text) : '';
                        } else {
                            if (!deps.executeToolCall) throw new Error('Map tool action needs the tool dispatcher.');
                            const toolName = data.tool;
                            if (!toolName) throw new Error('Map "tool" action needs a tool/skill name.');
                            const args = (rawArgs && typeof rawArgs === 'object') ? interpolate(rawArgs, itemScope) : {};
                            results[i] = await dispatchTool(deps, ctx, node, toolName, args);
                        }
                    } catch (e) {
                        results[i] = { error: e.message || String(e) };
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
            return { count: results.length, results };
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
// ============================================================
// Library chips — post-process a node's output (parse / transform / filter).
// A node carries data.chips = [chipId, …]; after it runs, each chip is applied
// in order. Ids MUST match the chat app's CHIP_LIBRARY. Best-effort: a transform
// that throws leaves the value unchanged rather than failing the run.
// ============================================================
function chipText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(x => (x == null ? '' : (typeof x === 'string' ? x : JSON.stringify(x)))).join('\n');
    try { return JSON.stringify(v); } catch { return String(v); }
}
function chipList(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v === 'string') return v.split(/\r?\n/);
    if (typeof v === 'object') { for (const k of ['results', 'items', 'new', 'rows']) if (Array.isArray(v[k])) return v[k]; }
    return [v];
}
function chipNum(v, fn) {
    if (Array.isArray(v)) return v.map(x => chipNum(x, fn));
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? fn(n) : v;
}
const CHIP_URL_RE = /https?:\/\/[^\s)<>"']+/g;
const CHIP_OPS = {
    trim: v => chipText(v).trim(),
    uppercase: v => chipText(v).toUpperCase(),
    lowercase: v => chipText(v).toLowerCase(),
    titlecase: v => chipText(v).replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
    capitalize: v => { const s = chipText(v); return s.charAt(0).toUpperCase() + s.slice(1); },
    collapse_ws: v => chipText(v).replace(/\s+/g, ' ').trim(),
    remove_blank_lines: v => chipText(v).split(/\r?\n/).filter(l => l.trim()).join('\n'),
    strip_html: v => chipText(v).replace(/<[^>]*>/g, ''),
    slugify: v => chipText(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    reverse_text: v => [...chipText(v)].reverse().join(''),
    truncate_280: v => { const s = chipText(v); return s.length > 280 ? s.slice(0, 279) + '…' : s; },
    word_count: v => (chipText(v).trim().match(/\S+/g) || []).length,
    char_count: v => chipText(v).length,
    dedent: v => { const lines = chipText(v).split(/\r?\n/); const ind = lines.filter(l => l.trim()).map(l => (l.match(/^\s*/)[0] || '').length); const m = ind.length ? Math.min(...ind) : 0; return lines.map(l => l.slice(m)).join('\n'); },
    normalize_quotes: v => chipText(v).replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    parse_json: v => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; },
    to_json: v => { try { return JSON.stringify(v); } catch { return chipText(v); } },
    extract_urls: v => chipText(v).match(CHIP_URL_RE) || [],
    extract_emails: v => chipText(v).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [],
    extract_numbers: v => (chipText(v).match(/-?\d+(?:\.\d+)?/g) || []).map(Number),
    extract_hashtags: v => chipText(v).match(/#[A-Za-z0-9_]+/g) || [],
    first_url: v => (chipText(v).match(CHIP_URL_RE) || [''])[0],
    domain_of: v => { const s = chipText(v).trim(); try { return new URL(s).hostname; } catch { const m = s.match(/^(?:https?:\/\/)?([^/\s]+)/i); return m ? m[1] : s; } },
    md_to_text: v => chipText(v).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]+/g, '').replace(/^\s*[-+*]\s+/gm, '').trim(),
    html_to_text: v => chipText(v).replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    csv_to_rows: v => { const lines = chipText(v).split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return []; const split = l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')); const headers = split(lines[0]); return lines.slice(1).map(l => { const cells = split(l); const o = {}; headers.forEach((h, i) => { o[h] = cells[i]; }); return o; }); },
    lines_to_list: v => chipText(v).split(/\r?\n/),
    split_commas: v => chipText(v).split(',').map(s => s.trim()),
    extract_dates: v => chipText(v).match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [],
    first: v => chipList(v)[0],
    last: v => { const a = chipList(v); return a[a.length - 1]; },
    first_5: v => chipList(v).slice(0, 5),
    first_10: v => chipList(v).slice(0, 10),
    skip_1: v => chipList(v).slice(1),
    reverse_list: v => chipList(v).slice().reverse(),
    sort_az: v => chipList(v).slice().sort((a, b) => chipText(a).localeCompare(chipText(b))),
    sort_za: v => chipList(v).slice().sort((a, b) => chipText(b).localeCompare(chipText(a))),
    sort_numeric: v => chipList(v).slice().sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0)),
    dedupe: v => { const seen = new Set(); return chipList(v).filter(x => { const k = typeof x === 'object' ? JSON.stringify(x) : String(x); if (seen.has(k)) return false; seen.add(k); return true; }); },
    remove_empties: v => chipList(v).filter(x => x != null && !(typeof x === 'string' && !x.trim()) && !(Array.isArray(x) && !x.length)),
    count_items: v => chipList(v).length,
    join_commas: v => chipList(v).map(chipText).join(', '),
    join_newlines: v => chipList(v).map(chipText).join('\n'),
    join_bullets: v => chipList(v).map(x => '- ' + chipText(x)).join('\n'),
    flatten: v => chipList(v).reduce((a, x) => a.concat(Array.isArray(x) ? x : [x]), []),
    shuffle: v => { const a = chipList(v).slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; },
    filter_nonempty: v => chipList(v).filter(x => x != null && !(typeof x === 'string' && !x.trim()) && !(typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0)),
    filter_has_url: v => chipList(v).filter(x => /https?:\/\//i.test(typeof x === 'string' ? x : JSON.stringify(x))),
    filter_unique: v => CHIP_OPS.dedupe(v),
    drop_nulls: v => { const clean = o => { if (Array.isArray(o)) return o.map(clean); if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) { const val = o[k]; if (val != null && val !== '') r[k] = clean(val); } return r; } return o; }; return clean(v); },
    round: v => chipNum(v, Math.round),
    round_2: v => chipNum(v, n => Math.round(n * 100) / 100),
    floor: v => chipNum(v, Math.floor),
    ceil: v => chipNum(v, Math.ceil),
    abs: v => chipNum(v, Math.abs),
    to_currency: v => chipNum(v, n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    to_percent: v => chipNum(v, n => (n * 100).toFixed(1) + '%'),
    wrap_code: v => '```\n' + chipText(v) + '\n```',
    wrap_quotes: v => '"' + chipText(v) + '"',
    to_uppercase_first: v => { const s = chipText(v).toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); },
    now_timestamp: v => chipText(v) + '\n\n' + new Date().toISOString(),
    pretty_json: v => { let o = v; if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return v; } } try { return JSON.stringify(o, null, 2); } catch { return chipText(v); } },
    // add_prefix / add_suffix need a parameter (not in the chip model yet) → no-op.
};
function applyNodeChips(output, chips) {
    // Common fetch/http outputs wrap the useful payload in .content/.data — unwrap
    // so "Fetch URL → Parse JSON" transforms the fetched body, not the envelope.
    let cur = output;
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
        if (typeof cur.content === 'string') cur = cur.content;
        else if (typeof cur.data === 'string') cur = cur.data;
    }
    for (const id of chips) {
        const fn = CHIP_OPS[id];
        if (typeof fn !== 'function') continue;
        try { cur = fn(cur); } catch (_) { /* keep last good value on a transform error */ }
    }
    return cur;
}

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

    // Serialize stateful SQLite nodes (db_store / track_changes). Two of them
    // writing the SAME per-workflow SQLite file concurrently within one parallel
    // wave (e.g. "watch these N pages" → N track_changes side by side) trips
    // SQLITE_BUSY / "disk I/O error". A tiny promise-chain mutex runs them
    // one-at-a-time without serializing the rest of the wave.
    const STATEFUL_NODE_TYPES = new Set(['db_store', 'track_changes']);
    let statefulTail = Promise.resolve();
    const withStatefulLock = (fn) => {
        const run = statefulTail.then(fn, fn);
        statefulTail = run.then(() => {}, () => {}); // never let a failure poison the chain
        return run;
    };

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
                // Per-node power toggle: a disabled node never runs. Skip it and
                // prune its outgoing edges so downstream branches that depend on
                // it don't run either (a merge with another active input still
                // runs, via the normal resolved/active edge logic below).
                if (n.data && n.data.disabled) {
                    nodeState.set(n.id, 'skipped');
                    for (const e of outgoing.get(n.id)) edgeState.set(edgeKey(e), 'pruned');
                    changed = true;
                    continue;
                }
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

            // 2. Find ALL runnable nodes: valid entries, OR every incoming edge
            //    resolved with at least one active. Independent nodes at the same
            //    depth form a "wave" and run concurrently — e.g. two fetch_url
            //    nodes feeding one model node both fire in parallel.
            const runnables = nodes.filter(n => {
                if (nodeState.get(n.id) !== 'pending') return false;
                const inc = incoming.get(n.id);
                if (inc.length === 0) return isEntry(n);
                return inc.every(isResolved) && inc.some(isActive);
            });

            if (runnables.length === 0) {
                if (changed) continue; // pruning may have unblocked something
                break;                 // nothing left to do
            }

            // 3. Launch the whole wave concurrently (capped). Each node
            //    interpolates its data against the pre-wave scope synchronously
            //    when launched, so siblings never race on scope; outputs are
            //    committed only after the wave settles. Handlers never reject
            //    here — errors are captured and surfaced in the commit phase.
            for (const node of runnables) {
                nodeState.set(node.id, 'running');
                onEvent({ type: 'node_start', nodeId: node.id, nodeType: node.type });
            }
            const waveResults = await runWithConcurrency(runnables, MAX_PARALLEL_NODES, async (node) => {
                const startedAt = new Date().toISOString();
                const entry = { nodeId: node.id, type: node.type, label: (node.data && node.data.label) || node.type, status: 'running', startedAt, finishedAt: null };
                // Outputs of the active incoming branches (used by merge and by
                // model fan-in; available to any handler that wants them).
                const activeInputs = incoming.get(node.id)
                    .filter(isActive)
                    .map(e => scope.nodes[e.source])
                    .filter(v => v !== undefined);
                try {
                    const output = STATEFUL_NODE_TYPES.has(node.type)
                        ? await withStatefulLock(() => runNode(node, scope, deps, ctx, activeInputs))
                        : await runNode(node, scope, deps, ctx, activeInputs);
                    return { node, entry, output, error: null };
                } catch (err) {
                    return { node, entry, output: undefined, error: err };
                }
            });

            // 4. Commit wave results in deterministic order: update scope, apply
            //    the per-node `forward` mapping, emit node_finish, route edges. A
            //    failed node fails the whole run (after its siblings settle).
            let waveError = null;
            for (const r of waveResults) {
                const { node, entry } = r;
                if (r.error) {
                    entry.status = 'failed';
                    entry.finishedAt = new Date().toISOString();
                    entry.error = r.error.message || String(r.error);
                    timeline.push(entry);
                    onEvent({ type: 'node_finish', nodeId: node.id, status: 'failed', error: entry.error });
                    if (!waveError) waveError = new Error(`Node "${entry.label}" (${node.type}) failed: ${entry.error}`);
                    continue;
                }
                let output = r.output;
                // Apply attached library chips (parse/transform/filter) in order.
                // Skipped for gate routing outputs so branch handles are preserved.
                const chipIds = (node.data && Array.isArray(node.data.chips)) ? node.data.chips : [];
                if (chipIds.length && !(output && typeof output === 'object' && output._handle)) {
                    output = applyNodeChips(output, chipIds);
                }
                nodeState.set(node.id, 'done');
                scope.nodes[node.id] = output;
                scope.last = output;
                // Per-node output mapping: an optional `forward` template shapes
                // what flows downstream (drag data tags into the node's Output
                // box). Blank → forward the whole raw output. Skipped when the
                // output carries a gate `_handle` so branch routing is preserved.
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
                timeline.push(entry);
                onEvent({ type: 'node_finish', nodeId: node.id, status: 'completed', output: entry.output });

                // Activate/prune outgoing edges. Any node whose output carries a
                // `_handle` (gate.if / gate.switch / gate.filter) routes only the
                // edges leaving that handle; edges with no sourceHandle stay active.
                const chosenHandle = (output && typeof output._handle === 'string') ? output._handle : null;
                for (const e of outgoing.get(node.id)) {
                    let active = true;
                    if (chosenHandle != null) {
                        if (e.sourceHandle != null) {
                            active = (e.sourceHandle === chosenHandle);
                        } else if (POSITIVE_HANDLE[node.type]) {
                            // A gate edge with NO sourceHandle used to stay ACTIVE on
                            // both branches — which makes the gate a NO-OP and
                            // silently defeats the whole "only notify me when there is
                            // something new / when it changed" contract (the model has
                            // to remember one `sourceHandle:"true"` string; when it
                            // forgets, the workflow notifies on EVERY run forever).
                            // Treat a handle-less edge as the node's POSITIVE branch.
                            active = (POSITIVE_HANDLE[node.type] === chosenHandle);
                        }
                        // No positive branch defined for this type (gate.switch, whose
                        // handles are user-defined case names): keep the pre-existing
                        // lenient behavior — a handle-less edge stays active. Defaulting
                        // it to a branch would prune the switch's entire downstream.
                    }
                    edgeState.set(edgeKey(e), active ? 'active' : 'pruned');
                    if (active) onEvent({ type: 'edge_active', edgeId: e.id, source: e.source, target: e.target });
                }
            }
            if (waveError) throw waveError;
        }

        onEvent({ type: 'run_finish', status: 'completed' });
        return { status: 'completed', result, error: null, timeline };
    } catch (err) {
        const message = err.message === 'aborted' ? 'Run cancelled' : (err.message || String(err));
        onEvent({ type: 'run_finish', status: 'failed', error: message });
        return { status: 'failed', result, error: message, timeline };
    }
}

// Keep persisted/streamed node outputs from ballooning — cap large blobs. The
// in-memory scope passed downstream keeps the FULL output; this only shapes what
// is stored in the run record / streamed to the UI. Small UI-relevant metadata
// (the artifact list that drives the download chip, the delivery/send tags) is
// PRESERVED through truncation so a large output — e.g. a Create PDF node that
// also carries the rendered content — still shows its download chip.
function summarizeOutput(output) {
    try {
        const s = JSON.stringify(output);
        if (s.length <= 4000) return output;
        const out = { _truncated: true, preview: s.slice(0, 4000) + '…' };
        if (output && typeof output === 'object' && !Array.isArray(output)) {
            if (Array.isArray(output._artifacts)) out._artifacts = output._artifacts;
            if (output._delivered) out._delivered = output._delivered;
            if (output._sendMode) out._sendMode = output._sendMode;
        }
        return out;
    } catch {
        return { _unserializable: true };
    }
}

// ---------------------------------------------------------------------------
// Run-health assessment — the core of result-aware "Test & improve".
//
// A workflow run can report status:'completed' yet have produced ZERO real data:
// web_search nodes return {error:"rate-limited …"} (caught internally, not
// thrown), a parse_json with the wrong path returns [], a misconfigured map
// returns {results:[{error:'…needs a tool name'}]}, and a model node then writes
// "Error Retrieving Content" into the final artifact. None of those throw, so the
// engine declares success. This pure assessor scans the per-node outputs of a run
// record and flags those silent failures so the repair loop can iterate.
// ---------------------------------------------------------------------------

// Phrases a model emits when it had no real source data to work from. Kept as a
// named constant so it's easy to extend. Case-insensitive.
const MODEL_NO_DATA_RE = /error retrieving|no content|unable to (retrieve|fetch|access)|couldn't (fetch|retrieve|access)|could not (fetch|retrieve|access)|no (data|articles|results|items|records|posts|entries|new \w+) ((was|were|to) )?(found|available|retrieved|list|report|show|display)|(is|are|contains?) (an? )?empty( json)? (array|object|list)|(contains?|provided|received|got|there (is|are|was|were)) no (data|items|records|entries|results|content|new )/i;

// Tell-tale signs of an unhandled exception in a script node's stderr/stdout
// (run_python / run_node). Used to flag a tool node that "succeeded" (the
// dispatcher ran) but whose code actually crashed.
const TRACEBACK_RE = /Traceback \(most recent call last\)|\b(?:Name|Type|Key|Value|Index|Attribute|Syntax|Indentation|Import|ModuleNotFound|Runtime|ZeroDivision|FileNotFound|Connection|Timeout)Error\b|ReferenceError|Uncaught \w*Error|Exception:/;

// Node types that are SUPPOSED to produce data — an empty result from one of
// these is a problem worth flagging; an empty `set`/`delay`/`output` is fine.
// Types whose empty output means the workflow did nothing useful. `model`,
// `db_store` and the delivery/file types were MISSING here, which is why a run
// that stored 0 rows and wrote an empty report still scored "ok, no issues" —
// emptyDataReason was never even called on them. ('crawl'/'http_request' are
// dead entries: those builtins materialize to engine type 'tool'.)
const DATA_PRODUCING_TYPES = new Set([
    'web_search', 'fetch_url', 'parse_json', 'map', 'merge', 'db_query',
    'crawl', 'http_request', 'tool',
    'model', 'db_store', 'export_file', 'render_html', 'track_changes',
]);

// True when a node type is a model node (engine type is 'model').
function isModelNodeType(t) { return t === 'model'; }

// "Empty data" detector for an object/array node output. Returns the reason
// string when the value carries no usable data, else null.
function emptyDataReason(o) {
    if (typeof o === 'string') {
        // Only a genuinely EMPTY string is a defect. A short one is not: the
        // "alert when it becomes true" pattern the builder prompt teaches has the
        // model emit a deliberate one-word sentinel ("NONE"), and flagging that
        // would send the repair loop chasing a working workflow.
        return o.trim() ? null : 'produced an empty string';
    }
    if (Array.isArray(o)) return o.length === 0 ? 'returned an empty array' : null;
    if (o && typeof o === 'object') {
        // db_store that stored nothing. `stored:0` on the FIRST run of a fresh
        // table means the value it was handed was empty — the upstream is broken.
        // (A later run legitimately stores 0 once everything is already seen, but
        // the test loop resets the table before each pass, so 0 here is a defect.)
        if (typeof o.stored === 'number' && o.stored === 0 && typeof o.total === 'number' && o.total === 0) {
            return 'stored 0 records (the data handed to it was empty — check the node feeding its "value")';
        }
        // fetch_url / http_request that came back with no body.
        if (typeof o.content === 'string' && o.content.trim().length < 200 && ('url' in o || 'title' in o)) {
            return `fetched only ${o.content.trim().length} characters of page content — the page is empty, blocked, or JS-only`;
        }
        // Common engine output shapes: merge {items,count}, web_search {results},
        // map {count,results}, db_query (array, handled above).
        if (Array.isArray(o.results) && o.results.length === 0) return 'results is empty';
        if (Array.isArray(o.items) && o.items.length === 0) return 'items is empty';
        if (typeof o.count === 'number' && o.count === 0) return 'count is 0';
        // parse_json wraps a scalar/empty value as { value: ... }; an empty array
        // or null value there means the path matched nothing.
        if ('value' in o && (o.value == null || (Array.isArray(o.value) && o.value.length === 0))) {
            return 'extracted no value (path matched nothing)';
        }
        // An object with no own keys at all ({}). parse_json returns this when the
        // dotted "path" matched nothing on the parsed source — the classic
        // wrong-path bug (e.g. path "$.posts" against a top-level array). Without
        // this it slips through as "not empty" and the failure only surfaces as a
        // garbage downstream message.
        if (Object.keys(o).length === 0) return 'is an empty object (path matched nothing?)';
    }
    return null;
}

// Assess the health of a finished run record. Pure (no I/O).
//   runRecord.nodes = [{ nodeId, type, status, error?, output? }]
// Returns { ok, issues:[{nodeId,type,severity,detail}], score }.
//
// `ok` definition: NO high-severity issues anywhere, AND no medium-severity
// issue on a TERMINAL node (a node with no outgoing edges / the last data
// producer). Rationale: a mid-graph empty result is sometimes legitimate (a
// dedupe gate may legitimately yield nothing this run), but the user-facing
// END of the workflow producing nothing means the run was useless. We don't have
// edge info on the run record, so "terminal" is approximated as the LAST node in
// the timeline (runs append nodes in completion order) plus any explicit model
// node (the model is what writes the artifact, so its emptiness is always
// user-facing). High-severity issues always fail `ok` regardless of position.
function assessRunHealth(runRecord) {
    const issues = [];
    const nodes = (runRecord && Array.isArray(runRecord.nodes)) ? runRecord.nodes : [];

    nodes.forEach((n, idx) => {
        const type = n.type || '';
        const out = n.output;
        const isLast = idx === nodes.length - 1;
        const push = (severity, detail) => issues.push({ nodeId: n.nodeId, type, severity, detail });

        // 1. Hard failure: the engine marked the node failed or set an error.
        if (n.status === 'failed' || n.error) {
            push('high', `node ${n.status === 'failed' ? 'failed' : 'errored'}${n.error ? ': ' + String(n.error).slice(0, 200) : ''}`);
            // Don't double-flag the same node for its output below.
            return;
        }

        // 2. The handler RETURNED an {error} payload instead of throwing
        //    (web_search rate-limit, fetch fallbacks exhausted, etc.).
        if (out && typeof out === 'object' && !Array.isArray(out) && typeof out.error === 'string' && out.error) {
            push('high', `output carries an error: ${String(out.error).slice(0, 200)}`);
            return;
        }

        // 2b. A tool/script node whose dispatcher succeeded (status='completed',
        //     success:true) but whose PAYLOAD signals failure: a non-zero exit
        //     code, a Python/Node traceback in stderr, an HTTP error status, or
        //     an explicit success/ok=false. Without this the broken node slips
        //     through — run_python returns {success:true, returncode:1,
        //     stderr:"Traceback…"} — and the failure only surfaces vaguely at the
        //     downstream model. Flagging it HERE points the repair model at the
        //     real root cause node.
        if (out && typeof out === 'object' && !Array.isArray(out)) {
            const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            const rc = (typeof out.returncode === 'number') ? out.returncode
                : (typeof out.exitCode === 'number') ? out.exitCode
                    : (typeof out.code === 'number') ? out.code : null;
            const stderr = typeof out.stderr === 'string' ? out.stderr : '';
            const tracebacky = TRACEBACK_RE.test(stderr);
            if (rc != null && rc !== 0) {
                push('high', `script exited with code ${rc}${stderr ? ': ' + trim(stderr) : ''}`);
                return;
            }
            if (tracebacky) {
                push('high', `script raised an error: ${trim(stderr)}`);
                return;
            }
            const httpStatus = typeof out.status === 'number' ? out.status : null;
            if (httpStatus != null && httpStatus >= 400) {
                push('high', `request failed with HTTP ${httpStatus}`);
                return;
            }
            if (out.success === false || out.ok === false) {
                const m = out.message || out.error_message || out.detail || '';
                push('high', `node reported failure${m ? ': ' + trim(m) : ''}`);
                return;
            }
            // A large output is stored as { _truncated:true, preview:"<json>" };
            // the returncode/traceback then hides inside the preview string.
            if (out._truncated && typeof out.preview === 'string'
                && (/"return_?code"\s*:\s*[1-9]/.test(out.preview) || TRACEBACK_RE.test(out.preview))) {
                push('high', `script error: ${trim(out.preview)}`);
                return;
            }
        }

        // 2c. db_store whose dedupe FAILED OPEN: a `key` is configured but the records
        //     don't carry that field, so they went in unkeyed. The node "succeeds",
        //     stores everything, and reports it all as new — on every run, forever.
        //     The gate downstream ("only if .new is not empty") therefore always fires.
        //     Silent, and the #1 way a "notify me only about NEW items" workflow ends
        //     up notifying about everything.
        if (type === 'db_store' && out && typeof out === 'object' && typeof out.keyMissing === 'number' && out.keyMissing > 0) {
            const fields = Array.isArray(out.recordFields) && out.recordFields.length
                ? ` The records actually have: ${out.recordFields.join(', ')}.`
                : '';
            push('high', `dedupe is NOT working — the "key" is "${(out.keyFields || []).join(',')}" but ${out.keyMissing} record(s) have no such field, so they were stored WITHOUT a unique key and will be reported as new on EVERY run.${fields} Set "key" to a field the records really have.`);
            return;
        }

        // 3. A map node whose EVERY item failed (each slot is an {error} object).
        if (type === 'map' && out && typeof out === 'object' && Array.isArray(out.results) && out.results.length) {
            const allErr = out.results.every(r => r && typeof r === 'object' && typeof r.error === 'string' && r.error);
            if (allErr) {
                const sample = String(out.results[0].error).slice(0, 200);
                push('high', `every map item failed (e.g. "${sample}")`);
                return;
            }
        }

        // 4. A model/terminal node whose text reads like a "no data" apology.
        if (typeof out === 'string' && MODEL_NO_DATA_RE.test(out)) {
            push('high', `${isModelNodeType(type) ? 'model' : 'node'} reported missing data: "${out.slice(0, 160).replace(/\s+/g, ' ').trim()}"`);
            return;
        }

        // 5. A data-producing node that yielded nothing (medium). Severity is
        //    medium because a mid-graph empty can be legitimate; `ok` only fails
        //    on medium issues at the terminal node (see header comment).
        if (DATA_PRODUCING_TYPES.has(type)) {
            const reason = emptyDataReason(out);
            if (reason) push('medium', `produced no data — ${reason}`);
        }
    });

    // score: weighted issue count (high=3, medium=1).
    const score = issues.reduce((s, i) => s + (i.severity === 'high' ? 3 : 1), 0);
    const hasHigh = issues.some(i => i.severity === 'high');
    const lastNodeId = nodes.length ? nodes[nodes.length - 1].nodeId : null;
    // Medium issue is disqualifying only when it sits on a model node or the
    // terminal node — i.e. the workflow's user-facing output is empty.
    // db_store joins the disqualifying set: the test loop resets its table before
    // every pass, so "stored 0 records" on a fresh table means NOTHING reached the
    // collection step — the pipeline produced no data at all. That run must not be
    // reported as healthy (it used to be: 0 rows stored + an empty report file
    // still scored "ok, no issues").
    const terminalMedium = issues.some(i =>
        i.severity === 'medium' && (isModelNodeType(i.type) || i.type === 'db_store' || i.nodeId === lastNodeId));
    const ok = !hasHigh && !terminalMedium;
    return { ok, issues, score };
}

// Pure decision helper for the repair loop (kept here so it's unit-testable
// without booting the server). Returns true when another model repair pass is
// warranted: the run is unhealthy, it's NOT a pure-config error the user must
// fix (token/credential/etc.), and we still have passes left.
//   pass    — the pass index just completed (1-based)
//   maxPass — MAX_REPAIR_PASSES
function shouldRepair(assess, pass, maxPass, configError) {
    if (configError) return false;          // user must supply the missing config
    if (assess && assess.ok) return false;  // data is flowing — stop
    return pass < maxPass;                   // unhealthy and passes remain
}

// Condense an assessment's issues into a short, node-grouped line for buildLog,
// e.g. "n2/n3/n4 web_search rate-limited; n6 parse_json produced 0 items".
function summarizeIssues(issues) {
    if (!issues || !issues.length) return 'no issues';
    return issues.map(i => `${i.nodeId}${i.type ? ' (' + i.type + ')' : ''}: ${i.detail}`).join('; ');
}

// Identify nodes whose PURPOSE is cross-run state — dedup feeds (db_store with
// a key) and change trackers (track_changes). The build-test loop re-runs the
// workflow once more and checks these behaved (run-2 suppressed already-seen
// items / reported no change). It's the only way to verify an "only notify on
// NEW content" / "report what changed" requirement actually works — a single
// run can never demonstrate cross-run dedup.
function findStatefulNodes(wf) {
    const storeKeyIds = [], trackIds = [];
    for (const n of (wf && Array.isArray(wf.nodes) ? wf.nodes : [])) {
        const t = n.type, d = n.data || {};
        if (t === 'db_store' && d.key != null && String(d.key).trim() !== '') storeKeyIds.push(n.id);
        else if (t === 'track_changes') trackIds.push(n.id);
    }
    return { storeKeyIds, trackIds, any: storeKeyIds.length + trackIds.length > 0 };
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

// ---------------------------------------------------------------------------
// "Build with LLM" — turn a natural-language request into a workflow
// ---------------------------------------------------------------------------

// System prompt enumerating the node catalog (from BUILTIN_NODE_TYPES) plus the
// JSON shape, wiring rules, per-node data shapes, and one worked example.
function buildBuilderSystemPrompt() {
    const cat = { trigger: [], tools: [], connector: [], gate: [], output: [] };
    // mirror the chat palette grouping so the model sees sensible categories
    const TOOLS = new Set(['model','web_search','fetch_url','playwright_fetch','scrapling_fetch','render_html','parse_json','parse_rss','export_file','http_request','crawl','sqlite','render_chart','chart_plot','fetch_timeseries','create_pdf','html_to_pdf','create_file','run_python','db_store','db_query','track_changes','tool']);
    const GATEX = new Set(['delay','set']);
    for (const b of BUILTIN_NODE_TYPES) {
        if (b.key === 'output') continue; // hidden / not needed
        let g = b.category;
        if (TOOLS.has(b.key)) g = 'tools';
        else if (GATEX.has(b.key)) g = 'gate';
        (cat[g] || cat.tools).push(b);
    }
    const line = (b) => `- ${b.key} — ${b.description}${Array.isArray(b.fields) && b.fields.length ? ` [fields: ${b.fields.join(', ')}]` : ''}`;
    const section = (label, arr) => arr.length ? `\n${label}:\n${arr.map(line).join('\n')}` : '';
    return [
        'You build automation workflows. Given a user request, output a SINGLE JSON object and NOTHING else — no markdown, no code fences, no commentary.',
        '',
        'JSON shape:',
        '{"name":"<short title>","nodes":[{"id":"n1","type":"<type>","data":{...}}],"edges":[{"source":"n1","target":"n2"}]}',
        '',
        // ── The seven rules that break a workflow SILENTLY when missed. They lead
        //    the list on purpose: the small builder model reliably applies what it
        //    reads first and skips what is buried 20 rules deep.
        'THE 7 HARD RULES (breaking any of these produces a workflow that looks right, runs "successfully", and does nothing):',
        '1. IDS: node ids MUST be literally n1, n2, n3 … contiguous, in flow order, and every {{nodes.nX}} reference must name one of them. A non-nN id or a gap silently unbinds every template that points at it.',
        '2. EDGES: wire EVERY node with an edge (source→target), trigger → … → the final delivery step. A node with no incoming edge NEVER RUNS — it is skipped silently, and a workflow whose last step (the PDF, the message) is unwired reports success while delivering nothing. The LAST node must be the thing the user actually asked for (the file, the notification, the stored row) — never a model node whose text goes nowhere.',
        '3. EXACTLY ONE trigger node. A WATCH / MONITOR / TRACK / "keep an eye on" / "alert me when" / "check for new …" request is inherently RECURRING — it MUST use trigger.schedule (pick a sensible cadence yourself if the user did not say one); a trigger.manual there means the automation never fires and can never watch anything. Use trigger.manual ONLY for a genuine one-off "run this when I click it" task.',
        '4. REFERENCES: pull a previous step\'s data in with {{nodes.<id>.<field>}}. Exact {{nodes.<id>}} is that node\'s whole output. {{vars.<name>}} is a value stored by a "set" node. Only reference a node that is UPSTREAM of the one referencing it. TRIGGER PAYLOAD — use the EXACT envelope: trigger.webhook → the run input is { body, query, receivedAt }, so the POSTed JSON fields are {{input.body.<field>}} (NOT {{input.<field>}}); trigger.telegram / trigger.slack → the incoming message is {{input.text}} (plus {{input.chat.id}} / {{input.channel}}).',
        '5. A GATE IS A SWITCH, NOT A DATA STEP. gate.if\'s OWN output is {result,_handle,value} — so NEVER read a data field off a gate (there is no {{nodes.<gate>.new}} / {{nodes.<gate>.items}}). After a gate, reference the real PRODUCER explicitly: model prompt "…{{nodes.<the node that made the data>}}", create_pdf args.content "{{nodes.<producer>}}". Condition operands read the producer too: {"left":"{{nodes.<store>.new}}","op":"not_empty"}.',
        '6. BRANCH HANDLES BELONG ONLY TO GATES. A model / tool / connector node has exactly ONE output — NEVER put a "sourceHandle" ("true"/"false") on an edge whose source is a model/fetch/tool node; that edge is dead and never fires. To branch on a model\'s answer, send the model INTO a gate.if (condition on "{{nodes.<model>}}" contains/not_contains a sentinel word) and branch from the GATE. Gate handles: gate.if → "true"/"false"; gate.filter → "out"; gate.switch → one handle per case. A gate.if with no "true" edge does nothing when the condition holds.',
        '7. CREDENTIALS / SECRETS — LEAVE THEM BLANK: set every botToken, chatId, channel, webhookUrl, apiKey, token, password to "" (empty string). NEVER write a placeholder like "<BOT_TOKEN>", "YOUR_TOKEN_HERE" or "123456:ABC-DEF" — the engine treats it as a REAL value, the test run calls the API with it and hard-fails, whereas "" is correctly recognized as "needs configuration" for the user to fill in. (A non-secret target the user explicitly stated — a chat id or channel name they gave you — may be filled.)',
        '',
        'Rules:',
        '- NEVER db_store web_search RESULTS. A web_search result is a PAGE (often just a domain or a search-index page), not an item, and its url is the SAME on every run — so keying on it stores everything once and then reports ZERO new forever, silently suppressing the automation permanently. To collect ITEMS from a search: web_search → map(fetch_url each result) → a model node that EXTRACTS the items as a JSON array → parse_json → db_store (key = the item\'s own stable url/id). If a feed or JSON API exists for the source, use parse_rss / http_request instead — always prefer it.',
        '- A SCHEDULED WORKFLOW RUNS FOR MONTHS — never hardcode a year, a date, or today\'s current product/version names into a web_search query or a model prompt ("… 2025 reviews", "compare the iPhone 17 and Galaxy S26"). It silently goes stale. Describe the thing generically ("latest flagship phone reviews") and let the search/feed supply what is current.',
        '- WEB SEARCH IS THIN — web_search returns only titles/links/short snippets (often just a domain), NEVER the page contents, and it rate-limits complex queries. Therefore: (a) keep any web_search query to plain keywords — no parentheses, no AND, at most one OR or one site:; and (b) if the automation needs the actual CONTENT behind the results, you MUST insert a map node that fetch_url\'s each result url ({ "items":"{{nodes.<search>.results}}", "action":"tool", "tool":"fetch_url", "args":{ "url":"{{item.url}}", "maxLength":6000 } }) BEFORE any db_store/model, then feed the model "{{nodes.<map>.results}}" — never feed raw web_search results straight into db_store or a model. Whenever a structured source fits the request (an RSS/Atom feed via parse_rss, or a JSON API via http_request), PREFER it over web_search; it returns complete, clean records. When a model node extracts structured rows from that content, run its output through parse_json before db_store so the rows are stored (and deduped by key) individually.',
        '- DEDUPE A FEED / "only new or unique ITEMS on future runs" / "notify only when a new post/article/listing appears": use a db_store node with a "key" (the unique field — id or url; add "keyNormalize": true and "keyStrip" for messy text/titles). It stores only unseen records and returns them in `.new`. Then add a gate.if on `{{nodes.<store>.new}}` with op "not_empty" and continue on the "true" handle. NEVER rely on the model to remember past items — persistence is what makes it unique across runs.',
        '- DEDUPE KEY RULES (CRITICAL): the "key" MUST be a field that is UNIQUE PER ITEM and STABLE across runs — for articles/posts that is the per-item "link" (or "id"). The db_store input MUST be the LIST OF ITEMS (one row per article), never a single wrapper object. NEVER key on a value that is identical on every run — e.g. a source-page url or site title coming from a fetch_url of a HOMEPAGE/section page: that stores one row per PAGE (the page url never changes), so it reports "new" on the first run and then ZERO forever. That is not dedupe — it silently suppresses ALL content. If you only have a page (not a feed), the items aren\'t separated yet, so fetch_url→db_store CANNOT dedupe articles; use parse_rss on the site\'s feed instead (see below).',
        '- ALERT WHEN SOMETHING BECOMES TRUE / "tell me WHEN tickets go on sale / when it is back in stock / when the status flips" (a state CHANGE on a stable target, NOT a feed of new items): do NOT db_store the search/fetch results — their urls/ids are STABLE across runs, so db_store marks them all "new" on the first run and then ZERO forever, which silently suppresses the alert PERMANENTLY (it never fires even once the thing actually happens). Instead detect the STATE TRANSITION: (1) web_search / fetch_url / http_request the source, (2) a model node that emits a STRICT machine verdict — e.g. prompt it to output exactly "AVAILABLE: <urls>" when the thing is true or exactly "NONE" otherwise, and NOTHING else (pick sentinels where the negative does NOT contain the positive word — "NONE" not "NOT AVAILABLE", since contains-checks would match the substring), (3) track_changes { "key": "<a constant string id for this watch>", "content": "{{nodes.<model>}}" } to detect when that verdict TEXT changes between runs, (4) gate.if { "condition": { "left": "{{nodes.<track>.changed}}", "op": "not_empty" } } on the "true" handle (only when the verdict changed), (5) a SECOND gate.if { "condition": { "left": "{{nodes.<model>}}", "op": "not_contains", "right": "NONE" } } on its "true" handle (only when it is now the positive state), (6) telegram/slack. This alerts on the moment of the transition, never suppresses forever, and never spams the same alert every run while the state holds.',
        '- MONITOR ONE PAGE/SOURCE FOR CHANGES AND REPORT WHAT CHANGED (a single URL/API whose CONTENT mutates over time — NOT a feed of new items): use a track_changes node, NOT db_store. Wire: fetch_url (or scrapling_fetch for bot-protected sites, or http_request for a JSON API) → track_changes { "key": "<the url>" } (leave "content" blank to use the fetched body) → gate.if { "condition": { "left": "{{nodes.<track>.changed}}", "op": "not_empty", "right": "" } } → model (prompt the diff, e.g. "Summarize what changed on the page:\\n{{nodes.<track>.diff}}") on the "true" handle → a SECOND gate.if on the model verdict → telegram/slack. The model prompt MUST end with a strict machine sentinel for the quiet case — e.g. "If the diff contains no meaningful update (only counters, layout or noise), reply with exactly: NOTHING_NEW" — and the second gate is { "condition": { "left": "{{nodes.<model>}}", "op": "not_contains", "right": "NOTHING_NEW" } } with the delivery on its "true" handle. WITHOUT that second gate the model\'s "nothing new" verdict is DELIVERED as an alert on every quiet run — the exact opposite of "only notify me when there is something new". track_changes stores the previous snapshot per key and returns { changed, diff, added, removed, revision }; the FIRST run stores a baseline (changed=false) so nothing is sent until a real change, and volatile bytes (session tokens, uuids, timestamps, "N hours ago") are ignored by default so a dynamic page does not read as changed on every fetch. db_store CANNOT do this (keying a single page by its content makes every version look "new" and gives no diff).',
        '- LATEST NEWS / ARTICLES FROM A SITE (a feed): the BEST source is the site\'s own RSS/Atom FEED, parsed with the parse_rss node — parse_rss { "args": { "url": "<the feed URL for the source the user named>" } } returns clean { items:[{title, link, summary, published, id}] } with no scraping. Most sites publish a feed at a conventional path such as /feed/, /rss, /rss.xml, /atom.xml, or a /<section>/rss variant; if you are unsure of the exact URL, use the source the user specified (or a sensible feed path for it) — do not substitute an unrelated site. Do NOT use http_request+parse_json on a feed (parse_json cannot parse XML) and do NOT write a run_python XML parser. Do NOT use a site-specific web_search ("site:... latest") — DuckDuckGo rate-limits those. (Some feeds — e.g. feedburner-backed ones — can return 403 behind an egress proxy; if a feed yields nothing, fall back to a fetch_url of the site\'s news/index page.) web_search is only for open-ended "find pages about X". To report only NEW stories across runs: parse_rss → db_store(key="link") → gate.if({{nodes.<store>.new}} not_empty) → model → create_pdf.',
        '- MULTIPLE FEEDS (e.g. a daily newspaper from several sites): give each source its OWN parse_rss node, fan them all into a merge, then db_store. Because parse_rss outputs { items:[…] }, the merge holds N feed-wrapper objects, so the db_store "value" MUST FLATTEN them into one article list: value "{{nodes.<merge>.items.*.items}}" (the ".*.items" maps over every feed and flattens). Do NOT use "{{nodes.<merge>.items}}" (that stores N wrapper objects keyed on a missing field → never dedupes). key "link".',
        '- FULL ARTICLE TEXT (not just the RSS title/summary): after the gate.if(.new not_empty), add a map node that fetches each new article: { "items":"{{nodes.<store>.new}}", "action":"tool", "tool":"fetch_url", "args":{ "url":"{{item.link}}", "maxLength":6000 } } → it returns { results:[{url,title,content,…}] }. Feed the model "{{nodes.<map>.results}}". Only the genuinely-new articles get fetched (cheap + on-topic). Without this step the model only sees short feed summaries.',
        '- CHAINING search/extract → parse_json: the parse_json "path" MUST match the REAL upstream shape. A merge node outputs {items:[...],count}; web_search outputs {results:[...]}. To pull every url from MERGED searches use path "items.*.results.*.url" (NOT "*.url"); from a single web_search use "results.*.url".',
        '- A map (Loop) node\'s "action" is "tool" or "model" — NOT a tool name. For a tool action set "action":"tool" AND "tool":"<valid tool name e.g. fetch_url|crawl_pages>" AND put per-item args in "args" using {{item}} for the current list item. Never put the tool name in "action".',
        '- STRUCTURED DATA FROM A SITE (a JSON API / feed): if the source exposes a JSON endpoint (e.g. .../api/recent, .../api.json, an RSS/Atom feed), ALWAYS use http_request to that endpoint then parse_json — NEVER scrape the HTML page with run_python. parse_json\'s "source" must be the http_request output\'s data, i.e. "{{nodes.<httpId>.data}}"; leave "path" empty to keep the whole parsed array/object, or set it to the field you want (e.g. "results.*.link"). Then db_store the parsed array for dedupe.',
        '- run_python DOES NOT have access to workflow data as variables. There is NO `nodes`, `last`, `input` or any node id available as a Python/JS name — referencing them throws "NameError: name \'nodes\' is not defined". To use an upstream value inside the code you MUST interpolate it as a literal via templating, e.g. code: "import json\\ndata = json.loads(r\'\'\'{{nodes.n2.content}}\'\'\')\\n…". But prefer NOT using run_python for fetching/parsing at all — use http_request + parse_json (JSON) or fetch_url + a model node (HTML). Reserve run_python for pure local transforms on already-interpolated data.',
        '- NODE OUTPUT SHAPES — reading a field a node does not produce silently yields an EMPTY value (no error), so use exactly these: fetch_url → { url, title, content, success } (page text is in .content, NOT .data) · http_request → { success, status, data } (.data is the response body, ALREADY PARSED into an object/array for JSON APIs — use parse_json only to EXTRACT a list from it with "path") · web_search → { results:[{title,url,snippet}] } · parse_rss → { feedTitle, count, items:[{title,link,summary,published,id}] } · db_store → { new, stored, total } · db_query → the rows array · map → { results:[…], count } · merge → { items:[…], count } · fetch_timeseries → { symbol, count, data:[{date,close,open,high,low,volume}] } · chart_plot → { file } · model → a plain STRING (no fields — {{nodes.<id>}} is the whole answer; there is no .text/.output/.content on it).',
        '- track_changes outputs { changed, firstSeen, revision } on EVERY run, but diff / added / removed / addedCount / removedCount EXIST ONLY when changed is true. Read them exclusively on the gate\'s "true" branch — anywhere else they interpolate to nothing.',
        '- A REPORT WITH GRAPHS/CHARTS IN A PDF: get the numbers (fetch_timeseries for stock/market data — args.symbol/period/interval, rows come back in .data; or http_request+parse_json for a JSON API), then chart_plot { "args": { "type":"line", "x":"{{nodes.<dataId>.data.*.date}}", "y":"{{nodes.<dataId>.data.*.close}}", "title":"..." } } to render a PNG into the workspace, then create_pdf whose markdown "content" embeds it as ![Chart]({{nodes.<chartId>.file}}) alongside the written analysis. ALWAYS reference the chart with {{nodes.<chartId>.file}} — the PNG filename is generated at run time, so a hand-written path like "artifacts/chart.png" is a guess and the PDF silently renders "[missing image]". Do NOT use render_chart for a PDF (it only makes an on-screen spec, not a file). The ANALYSIS model node must read the DATA node explicitly (prompt: "…{{nodes.<dataId>.data}}") — never let it auto-attach chart_plot\'s output, which contains the raw base64 PNG bytes and will flood its context. Wire: fetch_timeseries → chart_plot → create_pdf, and fetch_timeseries → model → create_pdf.',
        '- SCHEDULES: a TIME-OF-DAY schedule is ALWAYS a cron — "every morning at 8" → { "crons": ["0 8 * * *"] }. intervalMs is ONLY for "every N minutes/hours" with no wall-clock anchor (it is epoch-aligned, so it fires at an arbitrary time of day and can never mean "every morning"). For several (days, time) groups use a "crons" ARRAY, one 5-field line per group — e.g. "Mon and Wed at 9am AND Fri at 4:30pm" → { "crons": ["0 9 * * 1,3", "30 16 * * 5"] }. NEVER set "cron" (singular) to an array — use "crons". For one-off future dates use { "runAt": ["2026-12-25T09:00:00Z", …] } (ISO UTC). Pick exactly ONE form and OMIT the others. A trigger.schedule with NO cron/runAt/intervalMs silently defaults to every 5 minutes — always set one explicitly.',
        '- COLLECTING/MONITORING DATA "over/throughout an hour": a single run is one point in time and cannot watch for an hour by itself. fetch_timeseries is DAILY/weekly/monthly only (no intraday), so for live intraday monitoring use a Schedule trigger at a short interval (e.g. every 5 minutes) that fetches the current value (http_request to the quote/price endpoint) and appends it to db_store; then a db_query (newest-N) feeds the chart/report from the rows collected across runs. If the user just wants a price trend, fetch_timeseries daily history over a period (e.g. 1mo) charted is the simple path.',
        '',
        'Per-node data (set only what is needed):',
        '- model: { "prompt": "...", "systemPrompt": "..."? }  (the answer string is the output)',
        '- fetch_url: { "url": "..." }   web_search: { "query": "...", "limit": 5 }',
        '- http_request: { "args": { "url": "...", "method": "GET" } }   run_python: { "args": { "code": "print(1)" } }',
        '- ALWAYS nest a tool node\'s parameters under "args" — e.g. { "tool": "create_pdf", "args": { "content": "{{nodes.<id>}}", "filename": "report.pdf" } }. (A top-level param is folded into args as a fallback, EXCEPT the reserved names tool/label/model/temperature/maxTokens/sendMode/delivery/botToken/chatId/channel/caption/forward, which the node consumes itself and never reach the tool — so nest them and don\'t rely on the fallback.)',
        '- FILE ARG NAMES DIFFER — get them right or the node hard-fails: create_pdf → args { content, filename } · html_to_pdf → args { content, outputName } · create_file → args { filePath, content } (it is "filePath", NOT "filename", and write it under "artifacts/…" or the user cannot download it).',
        '- A DOWNLOADABLE CSV / TXT / MD / JSON FILE: use ONE export_file node — { "format": "csv", "filename": "data.csv" } (leave content blank to use the previous step\'s output; an array of objects becomes CSV rows automatically). Do NOT build the file text with run_python, and do NOT use create_file for it.',
        '- PDF OUTPUT — pick the right node: create_pdf renders MARKDOWN (headings/tables/bullets/code/links) — feed it a markdown string. For styled HTML (CSS layout, fonts, columns) use html_to_pdf: { "tool": "html_to_pdf", "args": { "content": "{{nodes.<id>}}", "outputName": "report.pdf" } }. NEVER convert markdown→HTML just to feed create_pdf, and NEVER feed raw HTML to create_pdf (it treats it as a code block). For both, args.content may be OMITTED to default to the previous node\'s output (just wire the edge).',
        '- parse_json: { "source": "{{nodes.<id>.data}}", "path": "results.*.url"? }',
        '- parse_rss: { "args": { "url": "https://site.com/feed.xml" } } → { feedTitle, count, items:[{title, link, summary, published, id}] } (use for RSS/Atom feeds; then db_store key="link")',
        '- db_store: { "table": "items", "key": "id"?, "keyNormalize": true?, "value": "{{nodes.<id>}}"? } → outputs { new, stored, total }',
        '- db_query: { "table": "items", "limit": 100?, "order": "id DESC"?, "sql": "SELECT ..."? } → outputs the rows array',
        '- track_changes: { "key": "https://site.com/page", "content": "{{nodes.<fetchId>.content}}"? (blank = previous output), "ignoreWhitespace": true?, "ignoreVolatile": false? (volatile tokens/timestamps are ignored by default; opt out only when those bytes ARE the watch target) } → outputs { changed, firstSeen, diff, added, removed, addedCount, removedCount, revision }',
        '- fetch_timeseries: { "args": { "symbol": "AAPL", "period": "1mo", "interval": "d" } } → { count, data:[{date, close, open, high, low, volume}] } (rows in .data; daily/weekly/monthly only)',
        '- chart_plot: { "args": { "type": "line", "x": "{{nodes.<dataId>.data.*.date}}", "y": "{{nodes.<dataId>.data.*.close}}", "title": "AAPL", "xlabel": "Date", "ylabel": "Price" } } → { file } (a PNG in the workspace; embed in create_pdf as ![Chart]({{nodes.<id>.file}}))',
        '- telegram: { "botToken": "", "chatId": "", "text": "…" } · slack posting TEXT: { "webhookUrl": "", "text": "…" } · slack sending a FILE: { "botToken": "", "channel": "" } — a Slack webhookUrl can ONLY post text, so if an upstream node produced a file the slack node MUST have botToken + channel or it throws at run time. (All of these stay "" — see HARD RULE 7.)',
        '- SENDING A FILE (PDF/image/CSV) to Telegram/Slack: just wire the file step (e.g. create_pdf) → a telegram (or slack) node — it auto-detects the upstream file and sends it as a document, with "text" as the caption. Do NOT put {{...artifacts}} in "text", and do NOT add a send_file node for Telegram/Slack. (send_file is ONLY for posting the file to an arbitrary HTTP endpoint: { "to": "http", "url": "…" }.) To control what flows to the next node, set the create_pdf/html_to_pdf node\'s "sendMode": "pdf" (file only, default) | "both" (the rendered data AND the file) | "data" (the rendered text only, no file).',
        '- gate.if / gate.filter: { "condition": { "left": "{{last}}", "op": "not_empty", "right": "" } } (ops: ==,!=,>,<,>=,<=,contains,not_contains,startsWith,endsWith,matches,empty,not_empty)',
        '- gate.switch: { "value": "{{last}}", "cases": [{ "op": "==", "value": "x", "handle": "x" }] }',
        '- set: { "name": "var", "value": "..." }   delay: { "ms": 1000 }',
        '',
        'Available node types:',
        section('Triggers', cat.trigger),
        section('Tools', cat.tools),
        section('Connectors', cat.connector),
        section('Logic gates', cat.gate),
        '',
        'Example — "every morning at 8 fetch a JSON feed and DM me only new items on Telegram":',
        '{"name":"New items to Telegram","nodes":[{"id":"n1","type":"trigger.schedule","data":{"crons":["0 8 * * *"]}},{"id":"n2","type":"http_request","data":{"args":{"url":"https://example.com/feed.json","method":"GET"}}},{"id":"n3","type":"parse_json","data":{"source":"{{nodes.n2.data}}","path":"items"}},{"id":"n4","type":"db_store","data":{"table":"items","key":"id","value":"{{nodes.n3}}"}},{"id":"n5","type":"gate.if","data":{"condition":{"left":"{{nodes.n4.new}}","op":"not_empty","right":""}}},{"id":"n6","type":"model","data":{"prompt":"Summarize these new items as a short list:\\n{{nodes.n4.new}}"}},{"id":"n7","type":"telegram","data":{"botToken":"","chatId":"","text":"{{nodes.n6}}"}}],"edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5"},{"source":"n5","target":"n6","sourceHandle":"true"},{"source":"n6","target":"n7"}]}',
        '',
        'Example — "every hour check a web page and tell me on Telegram what changed":',
        '{"name":"Page change monitor","nodes":[{"id":"n1","type":"trigger.schedule","data":{"intervalMs":3600000}},{"id":"n2","type":"fetch_url","data":{"url":"https://example.com/pricing"}},{"id":"n3","type":"track_changes","data":{"key":"https://example.com/pricing"}},{"id":"n4","type":"gate.if","data":{"condition":{"left":"{{nodes.n3.changed}}","op":"not_empty","right":""}}},{"id":"n5","type":"model","data":{"prompt":"This web page changed since the last check. Summarize exactly what changed in plain language for a notification. If the diff contains no meaningful update (only counters, layout or noise), reply with exactly: NOTHING_NEW\\n\\nDIFF:\\n{{nodes.n3.diff}}"}},{"id":"n6","type":"gate.if","data":{"condition":{"left":"{{nodes.n5}}","op":"not_contains","right":"NOTHING_NEW"}}},{"id":"n7","type":"telegram","data":{"botToken":"","chatId":"","text":"{{nodes.n5}}"}}],"edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5","sourceHandle":"true"},{"source":"n5","target":"n6"},{"source":"n6","target":"n7","sourceHandle":"true"}]}',
        '',
        'Example — "every hour make a PDF of new headlines from a feed (only stories I have not seen)":',
        '{"name":"Hourly new-news PDF","nodes":[{"id":"n1","type":"trigger.schedule","data":{"intervalMs":3600000}},{"id":"n2","type":"parse_rss","data":{"args":{"url":"https://example.com/rss.xml"}}},{"id":"n3","type":"db_store","data":{"table":"stories","key":"link","value":"{{nodes.n2.items}}"}},{"id":"n4","type":"gate.if","data":{"condition":{"left":"{{nodes.n3.new}}","op":"not_empty","right":""}}},{"id":"n5","type":"model","data":{"prompt":"Write a short markdown brief of these NEW items (one bullet each: bold headline then one-line summary):\\n{{nodes.n3.new}}"}},{"id":"n6","type":"create_pdf","data":{"args":{"content":"{{nodes.n5}}","filename":"digest.pdf"}}}],"edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5","sourceHandle":"true"},{"source":"n5","target":"n6"}]}',
        '',
        'Example — "daily digest PDF from SEVERAL sites, only NEW articles, with full article text" (multi-feed + flatten + full-text fetch):',
        '{"name":"Daily digest","nodes":[{"id":"n1","type":"trigger.schedule","data":{"crons":["30 9 * * *"]}},{"id":"n2","type":"parse_rss","data":{"args":{"url":"https://example.com/feed/"}}},{"id":"n3","type":"parse_rss","data":{"args":{"url":"https://news.example.org/rss.xml"}}},{"id":"n4","type":"parse_rss","data":{"args":{"url":"https://blog.example.net/feed/"}}},{"id":"n5","type":"merge","data":{}},{"id":"n6","type":"db_store","data":{"table":"articles","key":"link","value":"{{nodes.n5.items.*.items}}"}},{"id":"n7","type":"gate.if","data":{"condition":{"left":"{{nodes.n6.new}}","op":"not_empty","right":""}}},{"id":"n8","type":"map","data":{"items":"{{nodes.n6.new}}","action":"tool","tool":"fetch_url","args":{"url":"{{item.link}}","maxLength":6000}}},{"id":"n9","type":"model","data":{"prompt":"Write a newspaper-style report from these NEW articles (full text included):\\n{{nodes.n8.results}}"}},{"id":"n10","type":"create_pdf","data":{"args":{"content":"{{nodes.n9}}","filename":"digest.pdf"}}}],"edges":[{"source":"n1","target":"n2"},{"source":"n1","target":"n3"},{"source":"n1","target":"n4"},{"source":"n2","target":"n5"},{"source":"n3","target":"n5"},{"source":"n4","target":"n5"},{"source":"n5","target":"n6"},{"source":"n6","target":"n7"},{"source":"n7","target":"n8","sourceHandle":"true"},{"source":"n8","target":"n9"},{"source":"n9","target":"n10"}]}',
    ].join('\n');
}

// ── Edit/repair field-reference compaction ────────────────────────────────────
// Edit-with-LLM (and the repair pass) round-trip the WHOLE workflow through the
// model and ask it to re-emit it. A model node carrying a multi-KB systemPrompt /
// HTML template (the "Cybersecurity Newspaper PDF" one is ~18 KB) makes that echo
// blow past the output token cap → the JSON truncates → "did not return a valid
// workflow". Compaction swaps each oversized STRING value for a short token before
// the model sees the workflow; the model is told to keep the token verbatim for
// any field it isn't changing. expandPlaceholders restores the originals after
// parsing, so big fields survive byte-for-byte and the model only has to emit the
// structure plus the bits it actually edited.
const KEEP_TOKEN_BASE = '__KEEP_FIELD_';

function compactWorkflowForLLM(current, threshold = 600) {
    const placeholders = {};
    // Secondary map keyed on the raw numeric INDEX (not the full token text), used
    // by expandPlaceholders as a tolerant fallback: a small local model frequently
    // echoes the token back slightly mangled — drops the collision-avoidance `X`s
    // (`__KEEP_FIELD_X1__` → `__KEEP_FIELD_1__`), drops an underscore, or changes
    // case. Exact-string restore then misses it and the bare token leaks into the
    // SAVED workflow (the "model explains {result:false}" bug). Recovering by index
    // restores those mangled tokens too.
    const byIndex = {};
    // Choose a token prefix that does NOT already occur anywhere in the workflow,
    // so a field whose own text happens to contain "__KEEP_FIELD_…" can never be
    // mistaken for a placeholder on the way back. Deterministic, no randomness —
    // keeps this module dependency-free. After this, placeholder VALUES (= the
    // original strings) provably can't contain `prefix`, so expansion can neither
    // misfire on user content nor re-substitute.
    const serialized = (() => { try { return JSON.stringify(current); } catch (_) { return ''; } })() || '';
    let prefix = KEEP_TOKEN_BASE;
    while (serialized.indexOf(prefix) !== -1) prefix += 'X';
    let n = 0;
    const walk = (v) => {
        if (typeof v === 'string') {
            if (v.length > threshold) {
                const idx = n++;
                const token = `${prefix}${idx}__`;
                placeholders[token] = v;
                byIndex[idx] = v;
                return token;
            }
            return v;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v)) o[k] = walk(v[k]);
            return o;
        }
        return v;
    };
    const compacted = walk(current);
    return { compacted, placeholders, byIndex, count: n, prefix };
}

// Matches a KEEP_FIELD token the model may have echoed back MANGLED: optional
// leading underscores, an optional underscore + any run of collision `X`s before
// the index, optional trailing underscores, case-insensitive. The (\d+) capture
// is the index used to recover the original value by position. Deliberately loose
// on the wrapper (that is exactly what models corrupt) but anchored on the literal
// `KEEP_FIELD` marker — which a compacted field value provably never contains — so
// it cannot misfire on restored user content.
const KEEP_TOKEN_RESIDUAL = /_{0,2}KEEP_FIELD_?X*(\d+)_{0,2}/i;
function makeResidualRe() { return new RegExp(KEEP_TOKEN_RESIDUAL.source, 'gi'); }

// True if a value (deep) still carries a KEEP_FIELD token after restore — i.e. the
// model emitted one we could not map back. Callers use this to recover from the
// original workflow (the token always stood for an UNCHANGED field) or to reject a
// corrupted edit rather than save it.
function hasResidualKeepToken(value) {
    let found = false;
    const walk = (v) => {
        if (found) return;
        if (typeof v === 'string') { if (KEEP_TOKEN_RESIDUAL.test(v)) found = true; return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); }
    };
    walk(value);
    return found;
}

// Last-resort recovery for the edit/repair routes: a KEEP token ALWAYS represents
// a field the model meant to leave UNCHANGED, so the ground truth is the matching
// node in the ORIGINAL workflow. For any string in `specNode.data` that still
// holds a residual token, pull the same field path from `originalNode.data`. This
// is keyed on node id + path (the edit prompt mandates byte-for-byte id retention)
// and complements the index-based pass in expandPlaceholders.
function recoverResidualFromOriginal(specNode, originalNode) {
    if (!specNode || !specNode.data || !originalNode || !originalNode.data) return specNode;
    const walk = (cur, orig) => {
        if (typeof cur === 'string') {
            if (typeof orig === 'string' && KEEP_TOKEN_RESIDUAL.test(cur)) return orig;
            return cur;
        }
        if (Array.isArray(cur)) return cur.map((x, i) => walk(x, Array.isArray(orig) ? orig[i] : undefined));
        if (cur && typeof cur === 'object') {
            const o = {};
            for (const k of Object.keys(cur)) o[k] = walk(cur[k], (orig && typeof orig === 'object') ? orig[k] : undefined);
            return o;
        }
        return cur;
    };
    specNode.data = walk(specNode.data, originalNode.data);
    return specNode;
}

// Restore the placeholder tokens anywhere in a value (deep). Replaces every minted
// token wherever it appears in a string (exact value OR embedded) — keyed only on
// the token text, so it's robust to the edit's id-recovery moving a field onto a
// different (recovered) node id. Since placeholder values never contain a token
// (see compactWorkflowForLLM), replace order is irrelevant and no re-substitution
// can occur. Tokens not in the map (model hallucination) are left untouched.
function expandPlaceholders(value, placeholders, byIndex) {
    const tokens = placeholders ? Object.keys(placeholders) : [];
    const hasIndex = byIndex && Object.keys(byIndex).length > 0;
    if (!tokens.length && !hasIndex) return value;
    const walk = (v) => {
        if (typeof v === 'string') {
            let s = v;
            // Pass 1 — exact token match (the common case; restored values provably
            // contain no token, so order is irrelevant and re-substitution is impossible).
            for (const t of tokens) if (s.indexOf(t) !== -1) s = s.split(t).join(placeholders[t]);
            // Pass 2 — tolerant recovery of a MANGLED token by its numeric index
            // (drops the `X`s / an underscore / changes case). Runs after pass 1, so
            // it only ever sees tokens the exact pass could not resolve.
            if (hasIndex) s = s.replace(makeResidualRe(), (m, idx) => (byIndex[idx] !== undefined ? byIndex[idx] : m));
            return s;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v)) o[k] = walk(v[k]);
            return o;
        }
        return v;
    };
    return walk(value);
}

// Lay nodes out left→right by dependency depth (Kahn levels), stacking siblings.
function layoutWorkflow(nodes, edges) {
    const adj = new Map(nodes.map(n => [n.id, []]));
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    for (const e of edges) {
        if (adj.has(e.source) && indeg.has(e.target)) { adj.get(e.source).push(e.target); indeg.set(e.target, indeg.get(e.target) + 1); }
    }
    const level = new Map();
    let frontier = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    if (!frontier.length && nodes.length) frontier = [nodes[0].id];
    const deg = new Map(indeg);
    let lvl = 0;
    const seen = new Set();
    while (frontier.length) {
        const next = [];
        for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id); level.set(id, lvl);
            for (const t of (adj.get(id) || [])) { deg.set(t, deg.get(t) - 1); if (deg.get(t) <= 0 && !seen.has(t)) next.push(t); }
        }
        frontier = next; lvl++;
    }
    for (const n of nodes) if (!level.has(n.id)) level.set(n.id, lvl);
    const byLevel = {};
    for (const n of nodes) { const L = level.get(n.id); (byLevel[L] || (byLevel[L] = [])).push(n); }
    for (const L of Object.keys(byLevel)) byLevel[L].forEach((n, idx) => { n.position = { x: Number(L) * 250, y: idx * 120 }; });
}

// Resolve a model-produced spec into a valid, laid-out { name, nodes, edges }.
// Accepts node "type" as either a builtin key (e.g. http_request) or its engine
// type (e.g. tool); merges builtin defaults; drops unknown nodes / dangling
// edges; ensures a trigger entry exists.
// Gate nodes are the ONLY nodes with named branch handles (true/false/case). A
// model/tool/connector node has exactly one output, so a sourceHandle on an edge
// leaving one is a dead/invalid branch — a real LLM-edit mistake (e.g. wiring a
// "false" handle off a model node).
const GATE_TYPES = new Set(['gate.if', 'gate.filter', 'gate.switch']);

// The branch a handle-less outgoing edge is assumed to mean. gate.switch is
// deliberately absent: its handles are user-defined case names, so there is no
// sane default and a handle-less switch edge stays inactive (surfaced by the
// validator as an unwired case).
const POSITIVE_HANDLE = { 'gate.if': 'true', 'gate.filter': 'out' };

// Remove self-contradictory leftovers from a node's merged data. Currently a
// Schedule node that specifies a calendar form (crons/cron/runAt) must NOT also
// carry intervalMs: the scheduler prioritizes the calendar (server.js hasCalendar
// check), so a stale intervalMs default (300000) is a footgun — clearing the
// calendar later silently reverts the trigger to every-5-min — and it clutters
// the edit diff. Also drops empty calendar fields so only the chosen form remains.
// Mutates and returns `data`.
function normalizeNodeData(type, data) {
    if (!data || typeof data !== 'object') return data;
    if (type === 'trigger.schedule') {
        const hasCrons = Array.isArray(data.crons) && data.crons.some(c => typeof c === 'string' && c.trim());
        const hasCron = typeof data.cron === 'string' && data.cron.trim() !== '';
        const hasRunAt = Array.isArray(data.runAt) && data.runAt.some(c => typeof c === 'string' && c.trim());
        // Drop empty calendar fields regardless (they only confuse the diff/UI).
        if (Array.isArray(data.crons) && !hasCrons) delete data.crons;
        if (data.cron === '' || (typeof data.cron === 'string' && data.cron.trim() === '')) delete data.cron;
        if (Array.isArray(data.runAt) && !hasRunAt) delete data.runAt;
        // A real calendar form wins → drop the (usually default) intervalMs.
        if (hasCrons || hasCron || hasRunAt) delete data.intervalMs;
    }
    return data;
}

// Drop branch handles the model put on edges leaving a NON-gate node (keeps the
// generic 'out'). Defends against the classic LLM-edit error of branching off a
// model/tool node, which leaves a dead edge that never fires. Mutates `edges`.
function sanitizeEdgeHandles(nodes, edges) {
    const typeById = new Map(nodes.map(n => [String(n.id), n.type]));
    for (const e of edges) {
        if (!e.sourceHandle) continue;
        const st = typeById.get(String(e.source));
        if (!GATE_TYPES.has(st) && e.sourceHandle !== 'out') delete e.sourceHandle;
    }
    return edges;
}

// The node types models actually invent, mapped to the real one. The request
// routinely names a capability ("RSS", "Discord", "a python step") and the model
// coins a plausible type for it; without an alias the node is silently dropped
// and the graph loses its data source or its delivery step, with no error.
const NODE_TYPE_ALIASES = new Map(Object.entries({
    rss: 'parse_rss', rss_feed: 'parse_rss', feed: 'parse_rss', parse_feed: 'parse_rss', atom: 'parse_rss',
    http: 'http_request', request: 'http_request', api: 'http_request', api_request: 'http_request', rest: 'http_request',
    if: 'gate.if', condition: 'gate.if', gate: 'gate.if', filter: 'gate.filter', switch: 'gate.switch', branch: 'gate.if',
    python: 'run_python', script: 'run_python', code: 'run_python', run_script: 'run_python',
    llm: 'model', ai: 'model', gpt: 'model', chat: 'model', summarize: 'model', classify: 'model',
    search: 'web_search', google: 'web_search', duckduckgo: 'web_search',
    fetch: 'fetch_url', scrape: 'fetch_url', get_url: 'fetch_url', http_get: 'fetch_url',
    pdf: 'create_pdf', make_pdf: 'create_pdf', report: 'create_pdf',
    file: 'create_file', write_file: 'create_file', save_file: 'create_file',
    csv: 'export_file', excel: 'export_file', download: 'export_file',
    store: 'db_store', save: 'db_store', database: 'db_store', db: 'db_store',
    query: 'db_query', read_db: 'db_query',
    loop: 'map', foreach: 'map', for_each: 'map', iterate: 'map',
    chart: 'chart_plot', plot: 'chart_plot', graph: 'chart_plot',
    schedule: 'trigger.schedule', cron: 'trigger.schedule', timer: 'trigger.schedule',
    webhook: 'trigger.webhook', manual: 'trigger.manual',
    wait: 'delay', sleep: 'delay',
}));

// Rewrite {{nodes.<oldId>…}} references through an id map.
//
// Both materializers rewrite node IDS (build renumbers to n1..nN; edit assigns
// fresh ids to inserted nodes) and remap EDGES through the map — but the node
// `data` holding every {{nodes.<id>.field}} template used to be copied verbatim.
// The result is silent: the template points at an id that no longer exists,
// interpolate() resolves it to '', and the step runs with empty input while the
// run reports success. Worse, a shifted id can make a template resolve to the
// WRONG node (or to the node itself). Remapping data closes that.
function remapTemplateIds(value, idMap) {
    if (typeof value === 'string') {
        if (value.indexOf('{{') === -1) return value;
        // Rebuild the match from its parts. A substring `m.replace(id, mapped)` would
        // hit the FIRST occurrence of the id text — for a single-char id like "o" or
        // "n" that lands inside the literal "nodes." prefix and corrupts the template.
        return value.replace(/(\{\{\s*nodes\.)([A-Za-z0-9_\-]+)/g, (m, pre, id) => {
            const mapped = idMap.get(String(id));
            return mapped ? pre + mapped : m;
        });
    }
    if (Array.isArray(value)) return value.map(v => remapTemplateIds(v, idMap));
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = remapTemplateIds(value[k], idMap);
        return out;
    }
    return value;
}

function materializeWorkflow(spec) {
    const byKey = new Map(), byType = new Map();
    for (const b of BUILTIN_NODE_TYPES) { byKey.set(b.key, b); byType.set(b.type, b); }
    const rawNodes = Array.isArray(spec && spec.nodes) ? spec.nodes : [];
    const idMap = new Map();
    const nodes = [];
    const unknownTypes = [];
    let i = 0;
    for (const n of rawNodes) {
        const k = String((n && (n.type || n.kind)) || '').trim();
        const alias = NODE_TYPE_ALIASES.get(k.toLowerCase());
        const b = byKey.get(k) || byType.get(k) || (alias ? (byKey.get(alias) || byType.get(alias)) : null);
        if (!b) { if (k) unknownTypes.push(k); continue; }
        const newId = `n${++i}`;
        if (n && n.id != null) idMap.set(String(n.id), newId);
        const data = { ...(b.defaults || {}), ...(n && n.data && typeof n.data === 'object' ? n.data : {}) };
        if (!data.label) data.label = b.label;
        normalizeNodeData(b.type, data);
        nodes.push({ id: newId, type: b.type, position: { x: 0, y: 0 }, data });
    }
    if (!nodes.length) throw new Error('the model produced no recognizable nodes');
    // Templates must follow the renumbering (see remapTemplateIds).
    for (const n of nodes) n.data = remapTemplateIds(n.data, idMap);
    const hasTrigger = nodes.some(n => typeof n.type === 'string' && n.type.startsWith('trigger.'));
    const ids = new Set(nodes.map(n => n.id));
    const edges = [];
    let e = 0;
    for (const ed of (Array.isArray(spec && spec.edges) ? spec.edges : [])) {
        if (!ed) continue;
        const s = idMap.get(String(ed.source)) || String(ed.source);
        const t = idMap.get(String(ed.target)) || String(ed.target);
        if (!ids.has(s) || !ids.has(t) || s === t) continue;
        const edge = { id: `e${++e}`, source: s, target: t };
        if (ed.sourceHandle) edge.sourceHandle = String(ed.sourceHandle);
        edges.push(edge);
    }
    if (!hasTrigger) {
        const trig = { id: 'n0', type: 'trigger.manual', position: { x: 0, y: 0 }, data: { label: 'Manual / Run now' } };
        nodes.unshift(trig);
        const withIncoming = new Set(edges.map(x => x.target));
        const first = nodes.find(n => n.id !== 'n0' && !withIncoming.has(n.id)) || nodes.find(n => n.id !== 'n0');
        if (first) edges.unshift({ id: `e${++e}`, source: 'n0', target: first.id });
    }
    sanitizeEdgeHandles(nodes, edges);
    layoutWorkflow(nodes, edges);
    const name = (spec && typeof spec.name === 'string' && spec.name.trim()) ? spec.name.trim().slice(0, 80) : 'Generated automation';
    // unknownTypes: node types the model invented that have no builtin and no
    // alias. They were dropped, so the graph is missing a step the user asked
    // for — the caller surfaces this instead of pretending the build is complete.
    return { name, nodes, edges, unknownTypes };
}

// Engine `type` alone doesn't identify a node — every tool-backed connector
// (http_request, create_pdf, crawl …) shares type 'tool' and is told apart only
// by data.tool. This signature is what id-recovery matches on.
function nodeSignature(type, data) {
    const t = type || '';
    if (t === 'tool') return 'tool:' + ((data && data.tool) || '');
    return t;
}

// Edit variant: resolve a model-revised spec against the EXISTING workflow —
// preserve kept nodes' ids + positions, only position genuinely-new nodes, so an
// edit doesn't renumber/relayout the whole graph (keeps the diff meaningful).
//
// Models routinely IGNORE the "keep existing ids" instruction and rename every
// node (n1 → "schedule_node"). Without recovery the diff then reads as N added +
// N removed instead of "changed" — the 7.2 bug. So we align proposed nodes back
// onto base nodes: exact id first, then by signature among still-unclaimed base
// nodes (the canonical flows have one node per signature, so this is unambiguous).
// Edges are remapped through the recovered ids.
function materializeWorkflowEdit(spec, base) {
    const byKey = new Map(), byType = new Map();
    for (const b of BUILTIN_NODE_TYPES) { byKey.set(b.key, b); byType.set(b.type, b); }
    const baseList = (base && base.nodes) || [];
    const baseNodes = new Map(baseList.map(n => [String(n.id), n]));

    // 1) resolve each proposed node to a builtin, keeping its raw (model) id +
    //    merged data so we can both match and remap edges.
    const raw = [];
    const unknownTypes = [];
    for (const n of (Array.isArray(spec && spec.nodes) ? spec.nodes : [])) {
        const k = String((n && (n.type || n.kind)) || '').trim();
        const alias = NODE_TYPE_ALIASES.get(k.toLowerCase());
        const b = byKey.get(k) || byType.get(k) || (alias ? (byKey.get(alias) || byType.get(alias)) : null);
        if (!b) { if (k) unknownTypes.push(k); continue; }
        raw.push({
            rawId: (n && n.id != null && String(n.id).trim()) ? String(n.id).trim() : '',
            b,
            data: { ...(b.defaults || {}), ...(n && n.data && typeof n.data === 'object' ? n.data : {}) },
            position: (n && n.position && typeof n.position === 'object') ? n.position : null,
        });
    }
    if (!raw.length) throw new Error('the model produced no recognizable nodes');

    // 2) align proposed → base ids. claimedBase guards 1:1 matching.
    const claimedBase = new Set();
    const finalIds = new Array(raw.length).fill(null);
    // pass A — exact id match, but ONLY when the node TYPE also matches. Without
    // the type guard, an inserted/renumbered node that reuses a shifted base id
    // (e.g. a brand-new parse_json the model emitted as "n3" where base n3 was a
    // db_store) hijacks the wrong base node, and the diff reads as a phantom
    // "type changed db_store→parse_json" cascade instead of a clean "added
    // parse_json". A genuine same-type edit (incl. a tool rename within type
    // 'tool') still matches here and shows as "changed".
    for (let i = 0; i < raw.length; i++) {
        const id = raw[i].rawId;
        if (id && baseNodes.has(id) && !claimedBase.has(id) && baseNodes.get(id).type === raw[i].b.type) {
            finalIds[i] = id; claimedBase.add(id);
        }
    }
    // pass B — by signature among unclaimed base nodes (handles dropped ids)
    for (let i = 0; i < raw.length; i++) {
        if (finalIds[i]) continue;
        const sig = nodeSignature(raw[i].b.type, raw[i].data);
        const match = baseList.find(bn => !claimedBase.has(String(bn.id)) && nodeSignature(bn.type, bn.data) === sig);
        if (match) { finalIds[i] = String(match.id); claimedBase.add(String(match.id)); }
    }
    // pass C — genuinely new nodes get a fresh, collision-free id
    const usedIds = new Set(finalIds.filter(Boolean));
    for (let i = 0; i < raw.length; i++) {
        if (finalIds[i]) continue;
        let id = raw[i].rawId;
        if (!id || usedIds.has(id) || baseNodes.has(id)) id = `n${i + 1}_${Math.random().toString(36).slice(2, 6)}`;
        finalIds[i] = id; usedIds.add(id);
    }

    // 3) build nodes, preserving the matched base node's position + label.
    const nodes = [];
    for (let i = 0; i < raw.length; i++) {
        const id = finalIds[i], r = raw[i];
        const baseN = baseNodes.get(id);
        const data = r.data;
        if (!data.label) data.label = (baseN && baseN.data && baseN.data.label) || r.b.label;
        normalizeNodeData(r.b.type, data);
        const position = (baseN && baseN.position) || r.position || null;
        nodes.push({ id, type: r.b.type, position, data });
    }
    const ids = new Set(nodes.map(n => n.id));

    // 4) remap edges through rawId → finalId (first occurrence wins); fall back
    //    to identity so edges that already reference base/final ids still resolve.
    const idMap = new Map();
    for (let i = 0; i < raw.length; i++) { if (raw[i].rawId && !idMap.has(raw[i].rawId)) idMap.set(raw[i].rawId, finalIds[i]); }
    for (const id of finalIds) if (!idMap.has(id)) idMap.set(id, id);
    // Templates must follow the same rawId → finalId remap the edges get. Without
    // this an INSERTED node (which gets a fresh random id in pass C) leaves every
    // {{nodes.<rawId>}} pointing at whichever node inherited that raw id — often
    // the referencing node itself, which then reads its own empty output.
    //
    // But remap ONLY the fields the MODEL actually authored. The edit route swaps
    // every long field for a __KEEP_FIELD_N__ token before the model sees the
    // workflow and restores the ORIGINAL text afterwards — and that restored text is
    // in BASE-id space, not the model's raw-id space. Running it through the raw-id
    // map would repoint an UNCHANGED field at whatever node happened to inherit that
    // raw id. A field byte-identical to the base node's is by definition unchanged,
    // so leave it exactly as it is.
    const same = (a, b) => {
        if (a === b) return true;
        try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
    };
    for (const n of nodes) {
        const baseN = baseNodes.get(String(n.id));
        const baseData = (baseN && baseN.data) || null;
        if (!n.data || typeof n.data !== 'object') continue;
        for (const k of Object.keys(n.data)) {
            if (baseData && same(n.data[k], baseData[k])) continue;   // unchanged → base-id space, don't touch
            n.data[k] = remapTemplateIds(n.data[k], idMap);
        }
    }
    const edges = []; let e = 0;
    for (const ed of (Array.isArray(spec && spec.edges) ? spec.edges : [])) {
        if (!ed) continue;
        const s = idMap.get(String(ed.source)) || String(ed.source);
        const t = idMap.get(String(ed.target)) || String(ed.target);
        if (!ids.has(s) || !ids.has(t) || s === t) continue;
        const edge = { id: `e${++e}`, source: s, target: t };
        if (ed.sourceHandle) edge.sourceHandle = String(ed.sourceHandle);
        edges.push(edge);
    }
    sanitizeEdgeHandles(nodes, edges);
    // place any node missing a position (new nodes) near a positioned neighbour
    let maxX = 0; for (const n of nodes) if (n.position && typeof n.position.x === 'number') maxX = Math.max(maxX, n.position.x);
    let stray = 0;
    for (const n of nodes) {
        if (n.position) continue;
        const inc = edges.find(x => x.target === n.id);
        const src = inc && nodes.find(x => x.id === inc.source && x.position);
        n.position = src ? { x: (src.position.x || 0) + 250, y: (src.position.y || 0) + 90 } : { x: maxX + 250, y: 100 + 90 * (stray++) };
    }
    const name = (spec && typeof spec.name === 'string' && spec.name.trim()) ? spec.name.trim().slice(0, 80) : ((base && base.name) || 'Automation');
    return { name, nodes, edges, unknownTypes };
}

// Human-readable diff between two workflows (for the "show changes" preview).
// Render a single field value as a short, human-readable string for a diff
// (collapses whitespace, JSON-encodes objects, truncates). null/undefined → ∅.
function briefDiffValue(v, max = 140) {
    if (v == null) return '∅';
    let s = (typeof v === 'string') ? v : (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })();
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '∅';
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function diffWorkflows(base, proposed) {
    const bN = new Map(((base && base.nodes) || []).map(n => [String(n.id), n]));
    const pN = new Map(((proposed && proposed.nodes) || []).map(n => [String(n.id), n]));
    const lbl = (n) => (n && n.data && n.data.label) || (n && n.type) || '?';
    // A compact "field: value" summary of a node's config (skips label/cosmetic
    // keys) so an added/removed node shows WHAT it does, not just its type.
    const COSMETIC = new Set(['label', 'artifactName', 'delivered']);
    const configSummary = (n) => {
        const d = (n && n.data) || {};
        const parts = [];
        for (const k of Object.keys(d)) {
            if (COSMETIC.has(k)) continue;
            parts.push(`${k}: ${briefDiffValue(d[k], 80)}`);
        }
        return parts;
    };
    const addedNodes = [...pN].filter(([id]) => !bN.has(id)).map(([id, n]) => ({ id, label: lbl(n), type: n.type, config: configSummary(n) }));
    const removedNodes = [...bN].filter(([id]) => !pN.has(id)).map(([id, n]) => ({ id, label: lbl(n), type: n.type, config: configSummary(n) }));
    // For a changed node, list which data fields actually differ (skip 'label')
    // along with their before→after values so the diff card is specific.
    const changedFields = (a, b) => {
        const keys = new Set([...Object.keys((a && a.data) || {}), ...Object.keys((b && b.data) || {})]);
        const fields = [], changes = [];
        for (const k of keys) {
            if (k === 'label' || k === 'artifactName' || k === 'delivered') continue;
            const av = (a.data || {})[k], bv = (b.data || {})[k];
            if (JSON.stringify(av) !== JSON.stringify(bv)) {
                fields.push(k);
                changes.push({ field: k, before: briefDiffValue(av), after: briefDiffValue(bv) });
            }
        }
        if ((a.type || '') !== (b.type || '')) {
            fields.unshift('type');
            changes.unshift({ field: 'type', before: a.type || '∅', after: b.type || '∅' });
        }
        return { fields, changes };
    };
    // A node is "changed" only when its type or an actual data field differs —
    // NOT when the same data merely has its keys in a different order (the merge
    // in materializeWorkflowEdit reorders keys, which a whole-object JSON.stringify
    // compare would flag as a phantom change with an empty `fields` list).
    const changedNodes = [];
    for (const [id, n] of pN) {
        if (!bN.has(id)) continue;
        const { fields, changes } = changedFields(bN.get(id), n);
        if (fields.length) changedNodes.push({ id, label: lbl(n), type: n.type, fields, changes });
    }
    const ek = (e) => `${e.source}->${e.target}${e.sourceHandle ? '[' + e.sourceHandle + ']' : ''}`;
    const bE = new Set(((base && base.edges) || []).map(ek)), pE = new Set(((proposed && proposed.edges) || []).map(ek));
    return {
        addedNodes, removedNodes, changedNodes,
        addedEdges: [...pE].filter(k => !bE.has(k)).length,
        removedEdges: [...bE].filter(k => !pE.has(k)).length,
    };
}

module.exports = {
    runWorkflow,
    evalCondition,
    interpolate,
    cronMatches,
    BUILTIN_NODE_TYPES,
    buildBuilderSystemPrompt,
    materializeWorkflow,
    materializeWorkflowEdit,
    remapTemplateIds,
    NODE_TYPE_ALIASES,
    compactWorkflowForLLM,
    expandPlaceholders,
    hasResidualKeepToken,
    recoverResidualFromOriginal,
    diffWorkflows,
    assessRunHealth,
    shouldRepair,
    summarizeIssues,
    findStatefulNodes,
    runWithConcurrency,
};
