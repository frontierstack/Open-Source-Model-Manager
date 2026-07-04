/**
 * Tool router — per-turn selection of a small RELEVANT subset of the native tool
 * catalog to ADVERTISE to the chat model, instead of shipping the whole
 * ~133-tool / ~18.8k-token catalog on every /api/chat/stream request.
 *
 * WHY: the full catalog is wasteful (huge prompt every turn -> slower, dilutes
 * attention) and for small-context models it is fatal — the block-diffusion
 * model must fit its WHOLE prompt in one ~4096-token compute batch, so it cannot
 * carry the catalog at all and today can't call tools.
 *
 * WHAT IT DOES NOT TOUCH (the no-regression contract): the tool REGISTRY and
 * name-based dispatch (chatTools.toolRegistry / executeToolCall / the automation
 * engine / /v1 passthrough / load_skill) are unchanged — a tool the model names
 * still dispatches whether or not it was advertised. This module only decides
 * which tool SCHEMAS ride in the request `tools` array for a chat turn.
 *
 * SELECTION = CORE (always-on) ∪ STICKY (used earlier this conversation) ∪
 * INTENT-RULE deterministic hits ∪ SEMANTIC top-K (toolIndex), assembled under a
 * context/backend-adaptive token budget, always with find_tools appended so any
 * dropped tool is reachable in-conversation. Any error -> the caller fails OPEN
 * to the full catalog, so routing can only ADD efficiency, never subtract
 * capability.
 *
 * Semantic half lives in toolIndex.js; this file is the policy + compaction +
 * profile + sticky/recovery + the find_tools meta-tool.
 */

const toolIndex = require('./toolIndex');

// ---- tunables (all env-overridable at turn time, no rebuild) --------------
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const MODE = () => (process.env.TOOL_ROUTER_MODE || 'auto').toLowerCase();  // auto | on | off
// The chat-stream estimator over-counts tool schemas ~2.7x (field names -> 1 token);
// convert to a realistic token count before the skip/budget decisions.
const REAL_DIVISOR = () => num('TOOL_ROUTER_REAL_DIVISOR', 2.7);
const SKIP_ABS_TOK = () => num('TOOL_ROUTER_SKIP_ABS_TOK', 1200); // tiny catalogs never route
const SKIP_FRAC = () => num('TOOL_ROUTER_SKIP_FRAC', 0.04);       // route unless catalog < 4% of ctx
const BUDGET_FRAC = () => num('TOOL_ROUTER_BUDGET_FRAC', 0.06);
const BUDGET_MIN = () => num('TOOL_ROUTER_BUDGET_MIN', 1500);
const BUDGET_MAX = () => num('TOOL_ROUTER_BUDGET_MAX', 4500);
const KMAX = () => num('TOOL_ROUTER_KMAX', 48);
const SEM_STRONG = () => num('ROUTER_SEM_STRONG', 0.45);
const SEM_KEEP = () => num('ROUTER_SEM_KEEP', 0.28);   // calibrated on measured potion cosines; do NOT raise to 0.35
const SEM_FLOOR_N = () => num('ROUTER_SEM_FLOOR_N', 6);
const DIFFUSION_K = () => num('TOOL_ROUTER_DIFFUSION_K', 7);
const DIFFUSION_MAX_TOK = () => num('TOOL_ROUTER_DIFFUSION_MAX_TOK', 1100);

// Cheap token estimate — MUST match the chat-stream estimator (4 chars/token) so
// the router's budget math and the request's toolCatalogTokens agree.
function estTokens(s) { return Math.ceil(String(s || '').length / 4); }

// ---- CORE: always advertised when routing is active AND the tool is present.
// Cheap, high-utility, or load-bearing for a deterministic server pre-step.
const CORE = [
    'web',                    // the one consolidated retrieval tool — highest per-turn utility
    'base64_decode',          // UNCONDITIONAL: the pre-flight relies on it staying callable for a slipped blob
    'load_skill',             // progressive disclosure of the whole skill catalog at ~1 tool's cost
    'search_knowledge_base',  // only present when the user has a KB (build() null-gates it)
    'record_learning',        // only present when memory enabled (build() null-gates it)
    'make_downloadable',      // systemPrompt mandates it for file delivery
];
// Diffusion runs on a tiny budget — a leaner core (drop record_learning/make_downloadable).
const CORE_DIFFUSION = ['web', 'base64_decode', 'run_python', 'read_file', 'load_skill'];

// ---- INTENT RULES: deterministic capability -> tool names, GUARANTEED recall
// for known-critical intents regardless of embeddings. GENERIC capability
// triggers only (no topics/domains). A rule fires if its regex hits the query.
const INTENT_RULES = [
    [/\b(search|google|look ?up|latest|current|news|headline|today'?s|recent)\b|https?:\/\/|www\./i, ['web']],
    [/\bdns\b|\b(a|mx|txt|ns|cname)\s+record|nslookup|resolve .*(domain|host)/i, ['dns_lookup']],
    [/\bvirus\s*total\b|malware|reputation|\b[a-f0-9]{32,64}\b/i, ['virustotal_lookup']],
    [/\bbase ?64\b|decode this/i, ['base64_decode']],
    [/\b(graph|chart|plot|visuali[sz]e|bar chart|line chart|pie chart|scatter)\b/i, ['render_chart']],
    [/\b(picture|image|photo|drawing|logo|icon) of\b|show me (a|an) (picture|image|photo)/i, ['find_image']],
    // Image EXTRACTION from a page ("extract/grab the main image from <url>")
    // and screenshot asks — without these the model flails with generic
    // web/parse_html loops and never reaches find_image's browser extraction
    // (observed: 15 tool calls, no image, on a "extract the main image" ask).
    [/\b(extract|grab|pull|capture|fetch|scrape|display|show|save)\b[^.\n]{0,60}\b(main |hero |lead |og:?|cover )?(image|picture|photo|img|thumbnail)s?\b|\b(image|picture|photo)s?\b[^.\n]{0,40}\bfrom (this|that|the|a) (page|site|url|link|article|listing)/i, ['find_image']],
    [/\bscreen ?shot|\bsnapshot of\b/i, ['find_image']],
    [/\b(video|clip|movie|footage|trailer)\b|play (me )?a|watch a/i, ['find_video']],
    [/\.(xlsx|xls|csv)\b|spreadsheet|excel/i, ['read_xlsx', 'create_xlsx']],
    [/\btranscri|\.(mp3|wav|m4a|flac|ogg)\b|audio (file|clip)/i, ['transcribe_audio']],
    [/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)\b|archiveId=|\[Archive uploaded/i, ['extract_archive']],
    [/\b(grep|find in|search) (the )?code|where is .* (defined|function)|outline (the|this) file|read the file\b/i, ['grep_code', 'read_file', 'outline_file']],
    [/\b(xor|hex ?dump|hex ?convert|extract strings|carve|entropy|magic bytes)\b/i, ['xor_bytes', 'hex_dump', 'extract_strings']],
    [/\b(stock|ticker|share price|time ?series|ohlc|market data)\b|\$[A-Z]{1,5}\b/i, ['fetch_timeseries']],
    [/\b(remember|note that|keep in mind|i prefer|from now on)\b/i, ['record_learning']],
    [/\b(download|save (this|it) as|export (to|as)) (a )?(pdf|csv|file|xlsx)\b/i, ['make_downloadable', 'create_file', 'download_file']],
    // Download of a remote FILE / package / tarball / archive / repo (not just
    // doc formats) — download_file preserves original bytes; extract_archive
    // unpacks it. Without this the model reaches for http_request/web on a .tgz,
    // gets a binary descriptor telling it to "use download_file", and — if the
    // router didn't advertise download_file — reasons "I don't have download_file"
    // and dead-ends (observed on an npm-package malware review).
    [/\b(download|fetch|grab|pull|retrieve|save|get)\b[\s\S]{0,40}?\b(tarball|\.tgz|\.tar\b|\.zip|\.gz|package|archive|repo|repositor|binary|dependenc|module|source|npm|pypi|gem|crate)\b|registry\.npmjs\.org|files\.pythonhosted\.org|codeload\.github|\.tgz(\b|$)/i, ['download_file', 'extract_archive']],
    // Package / repo static-analysis & malware-review workflow: get the files,
    // unpack, grep across them, read, decode base64. Forces the whole path so a
    // "review this npm package for malware" turn never strands on a missing tool.
    [/\bmalware|malicious|suspicious|payload|\bc2\b|postinstall|obfuscat|exfiltrat|backdoor|\b(analy[sz]e|review|inspect|audit|examine|scan)\b[\s\S]{0,40}?\b(npm|package|repo|repositor|tarball|library|module|dependenc|source ?code|codebase|files?)\b/i, ['download_file', 'extract_archive', 'grep_code', 'scan_source_files', 'read_file', 'base64_decode']],
    // Document CREATION — "give me this as a pdf report", "make a docx", "turn this
    // into a pdf". The creator tools MUST ride along whenever a document format is
    // named with a creation-ish verb: make_downloadable is core-always but can only
    // PUBLISH an existing file, and a catalog with the publisher but no creator
    // strands the model (observed: 4 failed make_downloadable calls on a nonexistent
    // .html, 20 web loops, then "I don't have a create_file tool" — no PDF delivered).
    [/\b(make|create|generate|write|produce|prepare|give|format|turn|convert|export|save|download|render|compile)\b[\s\S]{0,80}?\b(pdf|docx|word document)\b|\bpdf\b[\s\S]{0,40}?\b(report|version|file|document|copy)\b/i, ['create_pdf', 'html_to_pdf', 'create_docx', 'create_file', 'append_to_file']],
    [/\b(my|the) (documents?|notes?|files?|knowledge ?base|kb)\b/i, ['search_knowledge_base']],
];

// ---- find_tools discovery meta-tool (the universal reachability backstop).
// Registered hidden (build()->null) so routing-OFF stays byte-identical and the
// registry still dispatches it by name; selectForTurn injects its def directly
// when a profile is active. Its execute searches the FULL catalog and pushes the
// matches into ctx._forcedToolNames so the grow-only loop advertises them next round.
const FIND_TOOLS_DESC = 'Discover more tools by capability when the tool you need is not in the current list. ' +
    'Describe what you want to do; returns matching tool names + one-line descriptions, and makes them ' +
    'available to call on your next step. Use this before saying a capability is unavailable.';
const FIND_TOOLS_PARAMS = {
    type: 'object',
    properties: { need: { type: 'string', description: 'what you want to do, e.g. "convert an image to grayscale"' } },
    required: ['need'],
};
async function findToolsExecute(args, ctx) {
    const need = String(args?.need || '').trim();
    const full = (ctx && ctx.fullToolCatalog) || [];
    if (!need || !full.length) return { tools: [], note: 'no query or no catalog' };
    let ranked;
    const sem = await toolIndex.search(full, need, 12).catch(() => null);
    if (sem && sem.size) ranked = [...sem.entries()];
    else ranked = [...toolIndex.keywordScore(full, need).entries()];
    ranked.sort((a, b) => b[1] - a[1]);
    const names = ranked.slice(0, 8).map(([n]) => n);
    const byName = new Map(full.map(d => [d.function.name, d]));
    if (ctx && ctx._forcedToolNames) names.forEach(n => ctx._forcedToolNames.add(n));
    return {
        tools: names.map(n => ({ name: n, description: toolIndex.trimDescription(byName.get(n)?.function?.description) })),
        note: 'These tools are now available to call on your next step.',
    };
}
// OpenAI schema — what selectForTurn ADVERTISES (compactSchema reads {type,function}).
const findToolsDef = {
    type: 'function',
    function: { name: 'find_tools', description: FIND_TOOLS_DESC, parameters: FIND_TOOLS_PARAMS },
};
// Registry def (flat shape chatTools.registerTool expects). build()->null keeps
// it HIDDEN from the normal catalog (routing-OFF stays byte-identical) while
// executeToolCall still dispatches it by name.
const findToolsTool = {
    name: 'find_tools',
    description: FIND_TOOLS_DESC,
    parameters: FIND_TOOLS_PARAMS,
    build: () => null,
    execute: findToolsExecute,
};

// ---------------------------------------------------------------------------
// Schema compaction — SHALLOW COPY, never mutates the registry def.
// ---------------------------------------------------------------------------
function firstSentence(s, cap) {
    let t = toolIndex.trimDescription(s);
    return t.length > cap ? t.slice(0, cap).replace(/\s+\S*$/, '') : t;
}

/** level: 'off' (verbatim) | 'light' | 'aggressive'. Returns a new def object. */
function compactSchema(def, level) {
    if (level === 'off' || !def?.function) return def;
    const fn = def.function;
    const descCap = level === 'aggressive' ? 90 : 150;
    const params = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
    const props = params.properties || {};
    const newProps = {};
    for (const [k, v] of Object.entries(props)) {
        const nv = { type: v && v.type ? v.type : 'string' };
        if (v && v.enum) nv.enum = v.enum;                         // enums are load-bearing — keep verbatim
        if (level === 'light' && v && typeof v.description === 'string') {
            nv.description = firstSentence(v.description, 80);       // light keeps a short param hint
        }
        if (v && v.items && v.type === 'array') nv.items = { type: v.items.type || 'string' };
        newProps[k] = nv;
    }
    const newParams = { type: 'object', properties: newProps };
    if (Array.isArray(params.required)) newParams.required = params.required;  // NEVER drop required names
    return {
        type: 'function',
        function: { name: fn.name, description: firstSentence(fn.description, descCap), parameters: newParams },
    };
}

// ---------------------------------------------------------------------------
// Sticky: tools this conversation has used stay available (mandatory tier).
// ---------------------------------------------------------------------------
const STICKY_CAP = 16;
const sticky = new Map();  // convId -> { names: Set, at: ts }
setInterval(() => {
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const [k, v] of sticky) if (v.at < cutoff) sticky.delete(k);
    while (sticky.size > 500) sticky.delete(sticky.keys().next().value);
}, 30 * 60 * 1000).unref?.();

function recordConversationToolUse(convId, name) {
    if (!convId || !name) return;
    let e = sticky.get(convId);
    if (!e) { e = { names: new Set(), at: 0 }; sticky.set(convId, e); }
    e.names.add(name);
    e.at = Date.now();
    // keep the most recent STICKY_CAP
    if (e.names.size > STICKY_CAP) {
        const arr = [...e.names];
        e.names = new Set(arr.slice(arr.length - STICKY_CAP));
    }
}

// ---------------------------------------------------------------------------
// Per-conversation selection stability (prompt-cache friendliness).
//
// llama.cpp reuses the KV cache for the LONGEST COMMON PREFIX of consecutive
// requests on a slot. The tool schemas render into the chat-template prefix
// (before the history), so a per-turn re-selection that changes even ONE tool
// (or their order) invalidates the whole cache and forces a full prompt
// re-eval — measured 2,842 tokens / 10.4s of dead "Thinking..." time on a
// 2-turn Qwen-35B conversation. To keep the prefix byte-identical across
// turns, a conversation REUSES its previous advertised array verbatim while
// it still covers the new turn's needs, and otherwise GROWS it append-only
// (old order preserved, new tools at the end) so the prefix diverges as late
// as possible. Falls back to a fresh selection when the union would blow the
// budget (accepting one re-eval).
// ---------------------------------------------------------------------------
function getSelectionCache(convId) {
    const e = convId && sticky.get(convId);
    return (e && e.lastSel) || null;
}
function setSelectionCache(convId, sel, level) {
    if (!convId) return;
    let e = sticky.get(convId);
    if (!e) { e = { names: new Set(), at: 0 }; sticky.set(convId, e); }
    e.at = Date.now();
    e.lastSel = {
        level,
        names: sel.tools.map(t => t.function.name),
        tools: sel.tools.slice(),
        advertisedNames: new Set(sel.advertisedNames),
    };
}

/** Sticky names for a conversation, SEEDED from inbound history tool_calls so a
 *  fresh process / background turn / reconnect still preserves in-use tools. */
function getSticky(convId, chatMessages) {
    const out = new Set();
    const e = convId && sticky.get(convId);
    if (e) e.names.forEach(n => out.add(n));
    for (const m of (chatMessages || [])) {
        if (m && Array.isArray(m.tool_calls)) {
            for (const c of m.tool_calls) { const n = c?.function?.name; if (n) out.add(n); }
        }
        if (m && m.role === 'tool' && m.name) out.add(m.name);
    }
    // cap
    return new Set([...out].slice(-STICKY_CAP));
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------
/** -> 'off' | 'balanced' | 'aggressive'. */
function resolveProfile({ instance, contextSize, fullCatalogTokens, reqOverride }) {
    if (MODE() === 'off') return 'off';
    if (reqOverride === false) return 'off';
    const isDiffusion = !!(instance && instance.isDiffusion);
    if (isDiffusion) return 'aggressive';           // forced — cannot fit the catalog otherwise
    const ctx = Number(contextSize) || 4096;
    const realTok = (Number(fullCatalogTokens) || 0) / REAL_DIVISOR();
    if (MODE() !== 'on') {
        // 'auto': skip only when the catalog is genuinely tiny relative to context.
        if (realTok <= Math.max(SKIP_ABS_TOK(), ctx * SKIP_FRAC())) return 'off';
    }
    return ctx <= 8192 ? 'aggressive' : 'balanced';
}

// ---------------------------------------------------------------------------
// Core selection
// ---------------------------------------------------------------------------
/**
 * selectForTurn -> { tools, advertisedNames:Set, mode, droppedCount }
 *  fullCatalog     : the full built catalog (array of OpenAI tool defs)
 *  query           : clean latest user text
 *  contextSize     : model ctx
 *  profile         : 'balanced' | 'aggressive'
 *  isDiffusion     : bool
 *  stickyNames     : Set (getSticky)
 *  forcedNames     : Set (server pre-flights that NAMED a tool this turn)
 *  hardCeilingTok  : optional absolute token ceiling for the tool block (diffusion ubatch fit)
 */
async function selectForTurn(opts) {
    const {
        fullCatalog = [], query = '', contextSize = 4096, profile = 'balanced',
        isDiffusion = false, stickyNames = new Set(), forcedNames = new Set(),
        hardCeilingTok = null, convId = null, intentText = null,
    } = opts || {};
    // Intent rules match against the user query PLUS (optionally) the system
    // prompt, so a persona ("you are to download a copy, then grep_code the
    // files") reliably gets its capability tools every turn even when the
    // per-turn user message is terse. Semantic search still uses `query` only
    // (mixing the whole system prompt in would dilute the embedding).
    const intentQuery = intentText ? (String(query) + '\n' + String(intentText)) : query;

    // Defensive: drop malformed defs (no .function.name) instead of throwing —
    // a single bad entry would otherwise trip the seam's fail-open and silently
    // disable routing for the whole turn.
    const validCatalog = fullCatalog.filter(d => d && d.function && d.function.name);
    const present = new Map(validCatalog.map(d => [d.function.name, d]));
    const level = profile === 'aggressive' ? 'aggressive' : (profile === 'balanced' ? 'light' : 'off');

    // budget
    let budget;
    if (isDiffusion) {
        budget = Math.min(DIFFUSION_MAX_TOK(), hardCeilingTok != null ? hardCeilingTok : DIFFUSION_MAX_TOK());
    } else if (profile === 'aggressive') {
        budget = Math.max(800, Math.min(1800, Math.floor(contextSize * 0.15)));
    } else {
        budget = Math.max(BUDGET_MIN(), Math.min(BUDGET_MAX(), Math.floor(contextSize * BUDGET_FRAC())));
    }
    const kmax = isDiffusion ? DIFFUSION_K() : KMAX();

    // 1) semantic (may be null -> keyword)
    let sem = await toolIndex.search(fullCatalog, query, Math.min(60, fullCatalog.length)).catch(() => null);
    let mode = 'semantic';
    if (!sem) { sem = toolIndex.keywordScore(fullCatalog, query); mode = query ? 'keyword' : 'none'; }

    // 2) intent rules
    const intent = new Set();
    for (const [re, names] of INTENT_RULES) {
        if (re.test(intentQuery)) names.forEach(n => present.has(n) && intent.add(n));
    }

    // 3) assemble mandatory tiers (bypass soft budget, honor hard ceiling)
    const coreList = isDiffusion ? CORE_DIFFUSION : CORE;
    const mandatory = [];
    const seen = new Set();
    const pushIf = (n) => { if (n && present.has(n) && !seen.has(n)) { seen.add(n); mandatory.push(n); } };
    forcedNames.forEach(pushIf);          // server pre-flights that named a tool
    coreList.forEach(pushIf);             // core (present-gated)
    stickyNames.forEach(pushIf);          // used earlier this conversation
    intent.forEach(pushIf);               // deterministic intent hits

    // 4) semantic tail by score
    const semRanked = [...sem.entries()].filter(([n]) => present.has(n)).sort((a, b) => b[1] - a[1]);
    const strong = [], keep = [], floor = [];
    semRanked.forEach(([n, s], i) => {
        if (seen.has(n)) return;
        if (s >= SEM_STRONG()) strong.push(n);
        else if (s >= SEM_KEEP()) keep.push(n);
        else if (i < SEM_FLOOR_N()) floor.push(n);
    });

    // 5) fill under budget: mandatory first (honor hard ceiling), then strong, keep, floor.
    const chosen = [];
    const chosenSet = new Set();
    let spent = 0;
    const compactOf = new Map();
    const costOf = (n) => {
        if (compactOf.has(n)) return estTokens(JSON.stringify(compactOf.get(n)));
        const c = compactSchema(present.get(n), level);
        compactOf.set(n, c);
        return estTokens(JSON.stringify(c));
    };
    const hardCeil = hardCeilingTok != null ? hardCeilingTok : Infinity;
    const take = (n, mandatoryTier) => {
        if (chosenSet.has(n) || !present.has(n)) return;
        const c = costOf(n);
        if (mandatoryTier) {
            if (spent + c > hardCeil && chosen.length) return;  // hard ceiling can still drop lowest-priority mandatory
        } else {
            if (chosen.length >= kmax) return;
            if (spent + c > Math.min(budget, hardCeil)) return;
        }
        chosen.push(n); chosenSet.add(n); spent += c;
    };
    mandatory.forEach(n => take(n, true));
    strong.forEach(n => take(n, false));
    keep.forEach(n => take(n, false));
    floor.forEach(n => take(n, false));

    // 6) always append find_tools (its own def, bypassing the present-gate) when routing is active.
    const outTools = chosen.map(n => compactOf.get(n) || compactSchema(present.get(n), level));
    const ftCost = estTokens(JSON.stringify(compactSchema(findToolsDef, level)));
    if (spent + ftCost <= hardCeil || !outTools.length) {
        outTools.push(compactSchema(findToolsDef, level));
        chosenSet.add('find_tools');
    }

    // 7) Per-conversation prompt-cache stability (see getSelectionCache): reuse
    // the previous turn's array VERBATIM when it still covers this turn's picks;
    // otherwise grow it append-only. A byte-identical tools block keeps the
    // rendered prompt prefix identical -> llama.cpp reuses the KV cache instead
    // of re-evaluating the whole history (measured ~10s/turn on a 35B model).
    if (convId) {
        const cached = getSelectionCache(convId);
        if (cached && cached.level === level) {
            const stale = cached.names.some(n => n !== 'find_tools' && !present.has(n));
            if (!stale) {
                const cachedSet = new Set(cached.names);
                // Coverage = what this turn genuinely NEEDS: the mandatory tiers
                // (forced/core/sticky/intent) + STRONG semantic picks. The
                // borderline KEEP/FLOOR tail differs on every query — chasing it
                // would grow (and invalidate) the block every turn, and a full
                // prompt re-eval (~10s on a 35B) costs far more than the tail is
                // worth; find_tools + name-dispatch + grow-on-use recover it.
                const needed = [...new Set([...mandatory, ...strong])].filter(n => present.has(n));
                const missing = needed.filter(n => !cachedSet.has(n));
                if (!missing.length) {
                    // full coverage -> byte-identical reuse
                    return {
                        tools: cached.tools.slice(),
                        advertisedNames: new Set(cached.advertisedNames),
                        mode: mode + '+stable',
                        droppedCount: fullCatalog.length - cached.names.length,
                    };
                }
                // append-only grow, bounded so a long conversation can't bloat the block
                const grownCount = cached.names.length + missing.length;
                const grownTools = [...cached.tools, ...missing.map(n => compactOf.get(n) || compactSchema(present.get(n), level))];
                const grownCost = estTokens(JSON.stringify(grownTools));
                if (grownCount <= Math.ceil(kmax * 1.5) && grownCost <= Math.min(budget * 1.5, hardCeil)) {
                    const grown = {
                        tools: grownTools,
                        advertisedNames: new Set([...cached.advertisedNames, ...missing]),
                        mode: mode + '+grown',
                        droppedCount: fullCatalog.length - grownCount,
                    };
                    setSelectionCache(convId, grown, level);
                    return grown;
                }
                // fall through: union too big -> fresh selection (one re-eval)
            }
        }
    }

    const fresh = {
        tools: outTools.slice(),   // plain mutable array (forced-synthesis length=0/push restore still works)
        advertisedNames: chosenSet,
        mode,
        droppedCount: fullCatalog.length - chosen.length,
    };
    if (convId) setSelectionCache(convId, fresh, level);
    return fresh;
}

module.exports = {
    resolveProfile,
    selectForTurn,
    compactSchema,
    recordConversationToolUse,
    getSticky,
    findToolsDef,
    findToolsTool,
    CORE,
    INTENT_RULES,
    estTokens,
};
