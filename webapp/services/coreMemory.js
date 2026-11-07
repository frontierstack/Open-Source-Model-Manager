/**
 * Core memory — ONE living memory per THEME of work, per account.
 *
 * The model's memory of this account is not a pile of facts, preferences and
 * one-off lessons. It is a small set of CORE MEMORIES, one per kind of work
 * it does for the user — research, coding, data analysis, documents, media,
 * security analysis, automations — and every task the model completes flows
 * into the core memory for its theme and refines it: the run statistics move,
 * the best approach is kept, pitfalls and lessons accrue, and a background
 * refinement rewrites the theme's PLAYBOOK (the living guidance the model
 * reads on the next task of that theme) from the accumulated evidence. So the
 * research memory is "how I do research for this user", and it changes and
 * improves over time instead of sprawling.
 *
 * Why this replaced the fact/preference/limitation store (2026-09-22): the
 * user watched auto-extracted facts and typed "learnings" surface on turns
 * they had nothing to do with and steer answers wrong, while the experience
 * that would actually have helped (how the last research task went) was
 * fragmented across dozens of task-similarity records that rarely matched.
 * A theme is coarse enough to ALWAYS match when it applies and narrow enough
 * to be about the work at hand.
 *
 * What is injected on a turn: the ONE core memory whose theme the ask belongs
 * to (nothing when the ask has no theme — a greeting, a plain question),
 * rendered lean (playbook, proven approach, lessons, avoid list, the user's
 * own notes for that theme) and framed as the model's own working experience,
 * never as facts about the user.
 *
 * Pure logic + the JSON store live here. `server.js` wires the turn hooks and
 * the routes, and injects the LLM (refinement is optional: the deterministic
 * parts — stats, best approach, lessons, pitfalls — always land).
 *
 * Storage: /models/.modelserver/core-memory/<userIdSafe>.json (plain JSON,
 * temp+rename, one write queue per user). One file = all of an account's
 * core memories + its Pi cursors.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const memoryStats = require('./memoryStats');
const selfCorrect = require('./selfCorrect');
const experienceMemory = require('./experienceMemory');

const DATA_DIR = '/models/.modelserver';
const STORE_DIR = path.join(DATA_DIR, 'core-memory');

const MAX_LESSONS = parseInt(process.env.CORE_MEMORY_MAX_LESSONS, 10) || 8;
const MAX_AVOID = parseInt(process.env.CORE_MEMORY_MAX_AVOID, 10) || 6;
const MAX_EPISODES = parseInt(process.env.CORE_MEMORY_MAX_EPISODES, 10) || 8;
const MAX_HISTORY = 6;                 // playbook versions kept for the panel
const PLAYBOOK_MAX_CHARS = parseInt(process.env.CORE_MEMORY_PLAYBOOK_CHARS, 10) || 1100;
const NOTES_MAX_CHARS = 1500;
const LESSON_MAX_CHARS = 220;
// The model rewrites a playbook only once a theme has this many completed
// tasks. Measured on the first live run: refining from ONE task produced
// specifics that would have hurt the next one ("switch to <that site>",
// "never retry web") — a single task cannot tell a pattern from an accident.
const MIN_REFINE_RUNS = parseInt(process.env.CORE_MEMORY_REFINE_MIN_RUNS, 10) || 2;

function log(...a) { console.log('[coreMemory]', ...a); }
function nowIso() { return new Date().toISOString(); }
function userIdSafe(userId) { return String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); }
function estimateTokens(text) { return Math.ceil(String(text || '').length / 3); }
function clean(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------
// Ordered most-specific → most-generic; the order is the tie-break. Each theme
// owns a set of tools (a tool call is one vote), a text pattern (the ask), and
// the attachment kinds that imply it. Security sits FIRST and its text cue
// weighs more because its tools are coding's tools (run_python over a pcap).

// Tools of a terminal agent (omp/Pi) running on the USER'S OWN machine. Chat
// never has these names (its file tools are read_file/grep_code/run_bash), so a
// vote for them can only come from the /v1 bridge.
const HOST_TOOLS = ['bash', 'powershell', 'read', 'write', 'edit', 'grep', 'glob', 'find', 'ls', 'task', 'todo_write',
    'shell_open', 'shell_exec', 'shell_send', 'shell_read', 'shell_close', 'shell_list', 'ssh_connect', 'notebook_edit'];
const HOST_TEXT_RE = /\b((my|this|the) (computer|machine|pc|laptop|desktop|system|box)|on my (pc|computer|machine|laptop)|installed (apps|programs|software)|task manager|event viewer|registry|powershell|windows (defender|update|firewall|services?)|startup (apps|items|programs)|my (files|folders|downloads|desktop)|appdata)\b|[a-z]:[\\/]|%[a-z]+%/i;

const THEMES = [
    {
        // Work done by a terminal agent on the user's own computer. Kept apart
        // from everything else: its steps (bash/PowerShell on Windows, local
        // file reads) mean nothing to the web chat, and mixed in they filled the
        // Research/Coding playbooks with "validate via bash first" (2026-11-06).
        key: 'host', label: 'Your computer',
        description: 'Work the terminal agent (omp) does on your own machine: shell commands, PowerShell, local files, system checks.',
        tools: HOST_TOOLS,
        text: HOST_TEXT_RE,
        textWeight: 3,
        agentOnly: true,      // the text cue counts only on the terminal-agent surface
        attachments: [],
    },
    {
        key: 'security', label: 'Security analysis',
        description: 'Malware and packet-capture analysis, OSINT, binary/CTF work, IOC and vulnerability audits, log forensics.',
        // The reverse-engineering toolchain belongs here (2026-11-07): owned by
        // no theme, "reverse engineer the .exe in this repo" scored Coding on
        // the clone/scan/extract steps around it.
        tools: ['hex_dump', 'extract_strings', 'xor_bytes', 'hex_convert', 'virustotal_lookup', 'dns_lookup', 'whois_lookup', 'analyze_pe', 'yara_scan',
            'disassemble', 'decompile', 'binary_info', 'gdb_batch', 'unpack_upx', 'inspect_msi', 'parse_pem'],
        text: /\b(malware|malicious|ioc|c2\b|beacon|pcap(ng)?|packet capture|wireshark|tcpdump|osint|ctf\b|reverse[- ]?engineer\w*|disassembl\w+|decompil\w+|keygen|shellcode|exploit|vulnerab\w+|cve[- ]?\d|phishing|ransomware|trojan|backdoor|infected|suspicious|threat|forensic\w*|virustotal|evtx|event logs?|security (audit|review|analysis)|pentest|penetration|attacker|compromise[ds]?|indicators? of compromise)\b/i,
        textWeight: 3,
        attachments: ['capture'],
    },
    {
        key: 'data-analysis', label: 'Data analysis',
        description: 'Spreadsheets, CSV/SQL, statistics, charts and time series.',
        tools: ['read_xlsx', 'create_xlsx', 'query_sqlite', 'csv_describe', 'spreadsheet_query', 'render_chart', 'fetch_timeseries', 'chart_plot', 'read_csv'],
        text: /\b(spreadsheet|excel|csv|tsv|xlsx?|pivot|charts?|graph(s| it| this)?|plot|visuali[sz]e|dashboard|histogram|scatter|dataset|statistic\w*|averages?|median|sql query|time ?series|stock (price|chart)|ticker|correlat\w+|forecast|retention|cohorts?|churn|funnel|conversion rates?|kpis?|metrics|installs|analy[sz]e (this|the|my) (data|csv|numbers|results)|(data|csv|spreadsheet) analysis|(new|newer|latest|updated) data)\b/i,
        textWeight: 1.5,
        attachments: ['spreadsheet'],
    },
    {
        key: 'media', label: 'Images, audio & video',
        description: 'Images and screenshots (OCR, transforms, finding pictures), audio transcription, video.',
        tools: ['ocr_image', 'transform_image', 'find_image', 'find_video', 'sniff_media_streams', 'transcribe_audio', 'analyze_video', 'download_video', 'screenshot', 'image_info'],
        text: /\b(images?|pictures?|photos?|screenshots?|ocr|videos?|audio|transcri\w+|voice memo|podcast|thumbnail|resize|crop|rotate|mp4|mp3|wav|png|jpe?g|gif|logo|wallpaper)\b/i,
        textWeight: 1.5,
        attachments: ['image', 'audio', 'video'],
    },
    {
        key: 'documents', label: 'Documents & email',
        description: 'Reading PDFs, Word files and emails; writing reports and documents.',
        tools: ['read_pdf', 'create_pdf', 'html_to_pdf', 'create_docx', 'read_docx', 'read_email_file', 'create_email', 'read_document_chunk', 'markdown_to_docx'],
        text: /\b(pdf|docx?|word (document|file)|report|emails?|\.eml|\.msg|inbox|memo|letter|invoice|contract|whitepaper|summari[sz]e (this|the) (document|file|paper|pdf)|write[- ]?up|documentation)\b/i,
        textWeight: 1.5,
        attachments: ['pdf', 'document', 'email'],
    },
    {
        key: 'automation', label: 'Automations',
        description: 'Building scheduled or event-driven workflows (monitors, digests, alerts).',
        tools: ['build_automation'],
        text: /\b(automat(e|ion|ions)|every (morning|day|hour|week|night|monday|weekday)|schedule[ds]?|recurring|cron|alert me|notify me|remind me|monitor (a|the|this|my) |digest|when(ever)? .{0,30}(changes|updates|posts))\b/i,
        textWeight: 2,
        attachments: [],
    },
    {
        key: 'coding', label: 'Coding',
        description: 'Writing, running, debugging and reviewing code; exploring repositories and archives.',
        tools: ['run_python', 'run_node', 'run_npm', 'run_bash', 'run_powershell', 'create_file', 'append_to_file', 'replace_lines', 'preview_html', 'grep_code', 'outline_file', 'scan_source_files', 'git_clone_shallow', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_blame', 'list_directory', 'read_file', 'head_file', 'tail_file', 'extract_archive', 'tar_extract', 'unzip_file', 'search_files', 'get_file_metadata', 'move_file', 'copy_file', 'make_downloadable'],
        // Coding WORK (write, fix, build, run). Naming a language or a runtime
        // is only a TOPIC: "the latest versions of Node.js, Bun and Deno" is a
        // research question, and with the names counted as work it tied with
        // Research and won on list order, so research asks recalled the
        // Coding playbook (npm-tarball and decompiler tips).
        text: /\b(code|codebase|repo(sitory)?|scripts?|functions?|class(es)?|bug|debug|refactor|compile|(build|make|write|create) (me )?(a |an )?([\w-]+ ){0,2}(app|game|page|web ?site|site|tool|script|cli|program|bot|extension|plugin|web ?app)|endpoint|regex|package\.json|unit tests?|stack ?trace|traceback|web ?app|syntax error|exception|implement\w*)\b/i,
        textWeight: 1.5,
        topic: /\b(python|javascript|typescript|node\.?js|deno|bun|react|vue|angular|svelte|html|css|api|sql|npm|pip|library|framework|rust|golang|java|c\+\+|c#|php|ruby|kotlin|swift|game|website)\b/i,
        topicWeight: 0.5,
        attachments: ['code', 'archive'],
    },
    {
        key: 'research', label: 'Research',
        description: 'Looking things up on the web, comparing options, gathering sources, current events.',
        tools: ['web', 'web_search', 'fetch_url', 'crawl_pages', 'scrapling_fetch', 'playwright_fetch', 'playwright_interact', 'download_html', 'parse_rss'],
        text: /\b(research|search(es)?|look ?(it )?up|find (out|me|the|a|info)|latest|newest|news|current|recent|who is|what is (the )?(price|cost|status)|compare|comparison|vs\.?|versus|reviews? of|release dates?|released|versions?|what'?s new|changelog|best .{0,30} for|sources?|cite|citations?|articles?|according to|online|google|wikipedia|trending|announced|benchmarks?|(summari[sz]e|read|explain|what does) (this |the |that )?(article|page|post|blog|link|thread))\b/i,
        textWeight: 1.5,
        attachments: [],
    },
];
const GENERAL_THEME = { key: 'general', label: 'General tasks', description: 'Tool-using work that fits no other theme.' };
const THEME_BY_KEY = new Map(THEMES.map(t => [t.key, t]));
THEME_BY_KEY.set(GENERAL_THEME.key, GENERAL_THEME);
const TOOL_THEME = new Map();
for (const t of THEMES) for (const tool of t.tools) if (!TOOL_THEME.has(tool)) TOOL_THEME.set(tool, t.key);

function themeInfo(key) {
    const t = THEME_BY_KEY.get(key) || GENERAL_THEME;
    return { key: t.key, label: t.label, description: t.description };
}
function allThemes() { return [...THEMES.map(t => themeInfo(t.key)), themeInfo('general')]; }

/** Attachment kinds from the request's attachments (names + mime types). */
function deriveAttachmentKinds(attachments) {
    const kinds = new Set();
    let archiveRe = null;
    try { archiveRe = require('./archiveExtractor').ARCHIVE_EXT_RE; } catch (_) { archiveRe = /\.(zip|tar|tgz|gz|7z|rar)$/i; }
    for (const a of (Array.isArray(attachments) ? attachments : [])) {
        const name = String(a?.filename || a?.name || '').toLowerCase();
        const mime = String(a?.mimeType || a?.type || '').toLowerCase();
        if (/\.(eml|msg)$/.test(name) || mime.includes('message/')) kinds.add('email');
        else if (/\.(pcap|pcapng|cap|evtx|etl)$/.test(name)) kinds.add('capture');
        else if (/\.(xlsx|xls|csv|tsv)$/.test(name) || mime.includes('spreadsheet') || mime.includes('csv')) kinds.add('spreadsheet');
        else if (/\.pdf$/.test(name) || mime.includes('pdf')) kinds.add('pdf');
        else if (/\.(docx?|odt|rtf)$/.test(name) || mime.includes('word') || mime.includes('officedocument.wordprocessing')) kinds.add('document');
        else if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/.test(name) || mime.startsWith('image/')) kinds.add('image');
        else if (/\.(mp4|mov|webm|mkv|avi|m4v|mpe?g)$/.test(name) || mime.startsWith('video/')) kinds.add('video');
        else if (/\.(mp3|wav|m4a|flac|ogg|aac)$/.test(name) || mime.startsWith('audio/')) kinds.add('audio');
        else if (archiveRe && archiveRe.test(name)) kinds.add('archive');
        else if (/\.(jsx?|tsx?|py|go|rs|java|c|cpp|h|hpp|rb|php|sh|json|ya?ml|toml)$/.test(name)) kinds.add('code');
    }
    return kinds;
}

/**
 * Which theme a turn belongs to. Post-turn: the tools that ran carry the
 * decision (one vote each, successful calls only), the ask and attachments
 * add weight. Pre-turn (no tools yet): the ask + attachments alone, and a
 * plain question with no theme cue returns null so NOTHING is injected.
 * `{ theme, label, scores, confident }`.
 */
// Phrases whose "code" is not programming ("What area is zip code 55904" was
// filed under Coding and became its proven approach).
const NON_CODE_RE = /\b(zip|postal|post|area|country|dialing|promo|promotional|discount|coupon|voucher|gift|referral|qr|bar|morse|dress|tax|error|status|verification|confirmation|access|security|activation|product|license|airport|iata|naics|sic|icd|cpt)[ -]?codes?\b/gi;

const GENERIC_TOOLS = new Set(['run_python', 'run_node', 'run_bash', 'read_file', 'head_file', 'tail_file', 'list_directory',
    'search_files', 'get_file_metadata', 'make_downloadable', 'extract_archive', 'unzip_file', 'tar_extract', 'copy_file', 'move_file']);

function classifyTheme({ toolLabels = [], userText = '', attachmentKinds = new Set(), hasTools = null, hostAgent = false } = {}) {
    const scores = new Map();
    const bump = (k, w) => scores.set(k, (scores.get(k) || 0) + w);
    // Words inside a URL are its path, not the user's intent: the ".html"
    // of an article link filed "summarize <article>" under Coding.
    const q = clean(String(userText || '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' link ').replace(NON_CODE_RE, ' '), 4000);
    for (const label of toolLabels) {
        const k = TOOL_THEME.get(label);
        // Interpreters and plain file reads serve every kind of work (a CSV
        // retention analysis is run_python + read_file); they lean, the ask decides.
        if (k) bump(k, GENERIC_TOOLS.has(label) ? 0.5 : 1);
    }
    for (const t of THEMES) {
        if (t.agentOnly && !hostAgent) continue;
        if (t.text && q && t.text.test(q)) bump(t.key, t.textWeight || 1.5);
        if (t.topic && q && t.topic.test(q)) bump(t.key, t.topicWeight || 0.5);
        for (const kind of t.attachments) if (attachmentKinds && attachmentKinds.has && attachmentKinds.has(kind)) bump(t.key, 2);
    }
    // Asking for reverse engineering IS the task, whatever repo/file tools get
    // the binary onto disk first (clone, scan, extract all score Coding).
    if (q && RE_TEXT.test(q)) bump('security', 2);
    let best = null;
    for (const t of THEMES) {
        const s = scores.get(t.key) || 0;
        if (s <= 0) continue;
        if (!best || s > best.score) best = { key: t.key, score: s };
    }
    const usedTools = hasTools == null ? toolLabels.length > 0 : !!hasTools;
    if (!best) {
        if (usedTools) return { theme: 'general', label: GENERAL_THEME.label, scores: Object.fromEntries(scores), confident: false };
        return null;
    }
    const second = [...scores.entries()].filter(([k]) => k !== best.key).reduce((m, [, v]) => Math.max(m, v), 0);
    return { theme: best.key, label: themeInfo(best.key).label, scores: Object.fromEntries(scores), confident: best.score >= second + 1 };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// The two-model hand-off's own chips. They are the pair's plumbing (a brief,
// jobs handed to the other model), never a step of the task, and first_pass is
// not a tool any model can call. Older records learned them as method ("first
// use first_pass to prepare a brief"); scrubPairTools removes that on read.
const PAIR_TOOLS = ['first_pass', 'ask_assistant', 'await_assistant'];
const PAIR_TOOL_RE = /\b(?:first_pass|ask_assistant|await_assistant)\b/;

function scrubApproachText(text) {
    return String(text || '')
        .split(/\s*→\s*/)
        .filter(seg => seg && !/^(?:first_pass|ask_assistant|await_assistant)\b/.test(seg.trim()))
        .join(' → ');
}

// Returns true when the record changed. The playbook loses only the sentences
// that name a pair tool; a changed playbook is marked dirty so the next
// recorded task re-refines it from clean evidence.
function scrubPairTools(rec) {
    if (!rec || typeof rec !== 'object') return false;
    let changed = false;
    if (rec.bestApproach && Array.isArray(rec.bestApproach.steps)) {
        const steps = rec.bestApproach.steps.filter(s => !(s && PAIR_TOOLS.includes(s.tool)));
        if (steps.length !== rec.bestApproach.steps.length) {
            changed = true;
            if (steps.length) rec.bestApproach.steps = steps;
            else rec.bestApproach = null;
        }
    }
    if (Array.isArray(rec.episodes)) {
        for (const e of rec.episodes) {
            if (e && typeof e.approach === 'string' && PAIR_TOOL_RE.test(e.approach)) {
                e.approach = scrubApproachText(e.approach);
                changed = true;
            }
        }
    }
    if (Array.isArray(rec.lessons)) {
        const kept = rec.lessons.filter(l => !(l && PAIR_TOOL_RE.test(String(l.text || ''))));
        if (kept.length !== rec.lessons.length) { rec.lessons = kept; changed = true; }
    }
    if (typeof rec.playbook === 'string' && PAIR_TOOL_RE.test(rec.playbook)) {
        rec.playbook = rec.playbook
            .split(/(?<=[.!?])\s+|\n+/)
            .filter(s => s.trim() && !PAIR_TOOL_RE.test(s))
            .join(' ')
            .trim()
            .replace(/^(?:then|next|after that),?\s+(\w)/i, (_m, c) => c.toUpperCase());
        rec.dirty = true;
        changed = true;
    }
    return changed;
}

function shardPath(userId) { return path.join(STORE_DIR, `${userIdSafe(userId)}.json`); }

function emptyShard(userId) { return { userId: String(userId), memories: [], cursors: {}, updatedAt: nowIso() }; }

async function readShard(userId) {
    try {
        const raw = await fsp.readFile(shardPath(userId), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyShard(userId);
        if (!Array.isArray(parsed.memories)) parsed.memories = [];
        if (!parsed.cursors || typeof parsed.cursors !== 'object') parsed.cursors = {};
        for (const rec of parsed.memories) scrubPairTools(rec);
        return parsed;
    } catch (e) {
        if (e.code !== 'ENOENT') log(`read failed for ${userIdSafe(userId)}: ${e.message} — starting empty`);
        return emptyShard(userId);
    }
}

async function writeShard(userId, shard) {
    await fsp.mkdir(STORE_DIR, { recursive: true });
    const target = shardPath(userId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    shard.updatedAt = nowIso();
    await fsp.writeFile(tmp, JSON.stringify(shard, null, 2), 'utf8');
    await fsp.rename(tmp, target);
}

// One write queue per user so two concurrent turns cannot lose each other's
// update (read → mutate → write is not atomic).
const queues = new Map();
// Live feed: every write that changes what the Stats view shows queues a
// change on the shard (noteChange); mutate emits them once the write landed.
const EventEmitter = require('events');
const events = new EventEmitter();
events.setMaxListeners(200);
function noteChange(shard, ev) {
    Object.defineProperty(shard, '__changes', { value: (shard.__changes || []).concat([{ ...ev, at: nowIso() }]), writable: true, configurable: true, enumerable: false });
}
function mutate(userId, fn) {
    const key = userIdSafe(userId);
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const shard = await readShard(userId);
        const out = await fn(shard);
        await writeShard(userId, shard);
        const changes = shard.__changes || [];
        for (const ev of changes) { try { events.emit('change', { userId: String(userId), ...ev }); } catch (_) { /* listeners are best-effort */ } }
        return out;
    });
    queues.set(key, run);
    run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    return run;
}

function newRecord(userId, themeKey) {
    const info = themeInfo(themeKey);
    const t = nowIso();
    return {
        id: crypto.randomUUID(),
        userId: String(userId),
        theme: info.key,
        label: info.label,
        playbook: '',
        playbookVersion: 0,
        playbookUpdatedAt: null,
        playbookHistory: [],
        bestApproach: null,           // { steps, calls, seconds, task, at }
        lessons: [],                  // [{ text, source:'auto'|'model'|'user', at, hits }]
        avoid: [],                    // [{ text, at, count }]
        stats: { runs: 0, converged: 0, failedRuns: 0, totalCalls: 0, totalSeconds: 0, bestCalls: null, lastCalls: null, recalled: 0, followed: 0, firstRunAt: null, lastRunAt: null },
        episodes: [],                 // most recent last
        notes: '',                    // the user's own guidance for this theme
        enabled: true,
        createdAt: t,
        updatedAt: t,
    };
}

function findByTheme(shard, themeKey) { return shard.memories.find(m => m.theme === themeKey) || null; }
function ensureTheme(shard, userId, themeKey) {
    let rec = findByTheme(shard, themeKey);
    if (!rec) { rec = newRecord(userId, themeKey); shard.memories.push(rec); }
    return rec;
}

async function list(userId) {
    const shard = await readShard(userId);
    return shard.memories.slice().sort((a, b) => (b.stats?.lastRunAt || b.updatedAt || '').localeCompare(a.stats?.lastRunAt || a.updatedAt || ''));
}
async function get(userId, id) {
    const shard = await readShard(userId);
    return shard.memories.find(m => m.id === id) || null;
}
async function getByTheme(userId, themeKey) {
    const shard = await readShard(userId);
    return findByTheme(shard, themeKey);
}

/** Every account that has a core-memory shard (admin listing). */
async function listAllUsers() {
    try {
        const files = await fsp.readdir(STORE_DIR);
        const out = [];
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try { const s = JSON.parse(await fsp.readFile(path.join(STORE_DIR, f), 'utf8')); if (s && s.userId) out.push(s.userId); } catch (_) { /* skip */ }
        }
        return out;
    } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// Episodes → core memory (deterministic part)
// ---------------------------------------------------------------------------

function addUnique(arr, text, cap, extra = {}) {
    const t = clean(text, LESSON_MAX_CHARS);
    if (!t) return arr;
    const low = t.toLowerCase();
    const at = arr.findIndex(x => String(x.text || '').toLowerCase() === low);
    if (at >= 0) {
        const [seen] = arr.splice(at, 1);
        seen.hits = (seen.hits || 1) + 1; seen.count = (seen.count || 1) + 1; seen.at = nowIso();
        arr.push(seen);
        return arr;
    }
    // Evict the oldest AUTO entry first; a user- or model-authored lesson is
    // deliberate and outlives automatic ones.
    while (arr.length >= cap) {
        const idx = arr.findIndex(x => (x.source || 'auto') === 'auto' || x.source === 'refined');
        arr.splice(idx >= 0 ? idx : 0, 1);
    }
    arr.push({ text: t, at: nowIso(), hits: 1, ...extra });
    return arr;
}

/**
 * Fold one finished turn into its theme's core memory.
 *   episode  — experienceMemory.buildEpisode output (task, approach, outcome, pitfalls, lessons)
 *   theme    — classifyTheme(...).theme
 *   recalled — { id, tools } the recall handed the turn (adherence accounting)
 *   taskKey  — /v1 in-progress snapshot key: the same task re-records ONE episode
 * Returns { id, theme, label, runs, newBest, improvedVsBest, followed, provisional }.
 */
async function recordEpisode(userId, { episode, theme, convId = null, recalled = null, taskKey = null, provisional = false, meta = null }) {
    if (!userId || !episode) return null;
    const themeKey = THEME_BY_KEY.has(theme) ? theme : 'general';
    return mutate(userId, (shard) => {
        const rec = ensureTheme(shard, userId, themeKey);
        const s = rec.stats;
        const o = episode.outcome || {};
        const calls = Number.isFinite(o.calls) ? o.calls : 0;
        const seconds = Number.isFinite(o.seconds) ? o.seconds : null;
        const converged = o.converged !== false;
        const approachText = experienceMemory.renderApproach(episode.approach);
        const t = nowIso();

        // Same in-flight task (Pi snapshots) → replace its own episode, no new run.
        const sameRun = !!(taskKey && rec.episodes.some(e => e.taskKey === taskKey));
        // A ROUGH run converged but flailed on the way: the loop guard had to
        // step in, or a large share of its calls failed. It still counts (it
        // happened) but it never sets the proven approach, and the refiner is
        // told to discount it — measured live, one such run (a greeting the
        // model turned into 35 web calls) otherwise wrote its noise into the
        // theme's avoid-list.
        const failedCalls = o.failed || 0;
        const rough = (o.guards || 0) > 0 || (calls + failedCalls >= 6 && failedCalls / (calls + failedCalls) >= 0.4);
        const ep = {
            task: clean(episode.task, 200), approach: approachText.slice(0, 600), calls, failed: failedCalls,
            seconds, converged, rough, at: t, convId: convId || null, taskKey: taskKey || null, provisional: !!provisional,
        };
        if (sameRun) {
            const idx = rec.episodes.findIndex(e => e.taskKey === taskKey);
            // A later snapshot of the same task: the counters follow its growth
            // (they used to keep the FIRST snapshot's calls, so a 32-call omp
            // task was counted as 1).
            const prev = rec.episodes[idx] || {};
            s.totalCalls += calls - (Number.isFinite(prev.calls) ? prev.calls : 0);
            if (seconds != null) s.totalSeconds += seconds - (Number.isFinite(prev.seconds) ? prev.seconds : 0);
            s.lastCalls = calls;
            rec.episodes[idx] = ep;
        } else {
            rec.episodes.push(ep);
            while (rec.episodes.length > MAX_EPISODES) rec.episodes.shift();
            s.runs += 1;
            if (converged) s.converged += 1; else s.failedRuns += 1;
            s.totalCalls += calls;
            if (seconds != null) s.totalSeconds += seconds;
            s.lastCalls = calls;
            s.firstRunAt = s.firstRunAt || t;
            s.lastRunAt = t;
        }

        // Best approach: a complete, converged run with fewer calls (then fewer
        // failures, then faster) becomes the proven approach. Provisional
        // snapshots may only SEED it.
        let newBest = false;
        const bestBefore = rec.bestApproach && !rec.bestApproach.provisional ? rec.bestApproach.calls : null;
        const hasApproach = Array.isArray(episode.approach) && episode.approach.length > 0;
        if (hasApproach && converged && !rough) {
            const cur = rec.bestApproach;
            const better = !cur
                || (!provisional && (cur.provisional
                    || calls < cur.calls
                    || (calls === cur.calls && (o.failed || 0) < (cur.failed || 0))
                    || (calls === cur.calls && (o.failed || 0) === (cur.failed || 0) && seconds != null && cur.seconds != null && seconds < cur.seconds)));
            if (better) {
                rec.bestApproach = { steps: episode.approach.slice(0, 10), calls, failed: o.failed || 0, seconds, task: ep.task, at: t, provisional: !!provisional };
                newBest = !!cur;
            }
            if (!provisional) s.bestCalls = s.bestCalls == null ? calls : Math.min(s.bestCalls, calls);
        }
        // Improvement vs the remembered best BEFORE this run — the panel's proof.
        const improvedVsBest = (recalled && Number.isFinite(recalled.bestCalls)) ? recalled.bestCalls - calls : null;

        for (const l of (episode.lessons || [])) addUnique(rec.lessons, l, MAX_LESSONS, { source: 'auto' });
        // The avoid-list holds observed ERROR CLASSES ("web: http-404"), which
        // recur across tasks and can be counted. A raw error message carrying a
        // path or a URL, or a host-specific detour, is an anecdote of one task —
        // it lives in that task's episode, not in the theme's memory.
        for (const p of (episode.pitfalls || [])) {
            const text = String(p || '');
            if (text.length > 90 || /[\/]|https?:|\.[a-z]{2,4}\b/i.test(text.replace(/^[^:]+:/, ''))) continue;
            addUnique(rec.avoid, text, MAX_AVOID, { count: 1 });
        }

        // Adherence: the memory was handed to this turn — did the model follow it?
        let followed = null;
        if (recalled && recalled.id === rec.id) {
            s.recalled += 1;
            const adh = experienceMemory.pathAdherence(recalled.steps || [], episode.approach || []);
            followed = !!adh.followed;
            if (followed) s.followed += 1;
        }
        try {
            memoryStats.logRun(shard, {
                t, th: rec.theme, c: calls, f: failedCalls, s: seconds, ok: converged, rough,
                prov: !!provisional, k: taskKey || null,
                tools: [...new Set(experienceMemory.approachTools(episode.approach || []))].slice(0, 8),
                r: !!recalled, rt: !!(recalled && recalled.id === rec.id), fo: followed,
                pv: rec.playbookVersion || 0,
                m: meta && meta.model, ac: meta && meta.answerChars, src: meta && meta.source,
                cv: provisional || taskKey ? null : convId,
            });
            if (newBest) memoryStats.logEvent(shard, { t, th: rec.theme, kind: 'best', calls, from: bestBefore });
        } catch (e) { log(`stats log failed: ${e.message}`); }
        noteChange(shard, { kind: 'task', theme: rec.theme, label: rec.label, newBest, followed, sameRun,
            task: { t, c: calls, f: failedCalls, s: seconds, rough, ok: converged, rt: !!(recalled && recalled.id === rec.id), fo: followed, src: meta && meta.source, prov: !!provisional, title: ep.task.slice(0, 120) } });
        rec.dirty = true;               // playbook refinement pending
        rec.updatedAt = t;
        return { id: rec.id, theme: rec.theme, label: rec.label, runs: s.runs, newBest, improvedVsBest, followed, provisional: !!provisional, sameRun, bestCalls: s.bestCalls, calls };
    });
}

/** The user's next message corrected the newest task of this conversation. */
async function markCorrection(userId, convId) {
    if (!userId || !convId) return false;
    return mutate(userId, (shard) => {
        const hit = memoryStats.markCorrection(shard, convId);
        if (hit) noteChange(shard, { kind: 'correction' });
        return hit;
    });
}

/** A lesson the model (record_learning) or the user adds to a theme. */
async function addLesson(userId, { theme, lesson, source = 'model', convId = null }) {
    const text = clean(lesson, LESSON_MAX_CHARS);
    if (!userId || !text) return null;
    const themeKey = THEME_BY_KEY.has(theme) ? theme : 'general';
    return mutate(userId, (shard) => {
        const rec = ensureTheme(shard, userId, themeKey);
        const before = rec.lessons.length;
        const low = text.toLowerCase();
        const existing = rec.lessons.find(x => String(x.text).toLowerCase() === low);
        addUnique(rec.lessons, text, MAX_LESSONS, { source, convId });
        rec.dirty = true;
        rec.updatedAt = nowIso();
        return { id: rec.id, theme: rec.theme, label: rec.label, reinforced: !!existing, lessons: rec.lessons.length, added: rec.lessons.length > before };
    });
}

async function setNotes(userId, theme, notes) {
    const themeKey = THEME_BY_KEY.has(theme) ? theme : 'general';
    const text = String(notes || '').trim().slice(0, NOTES_MAX_CHARS);
    return mutate(userId, (shard) => {
        const rec = ensureTheme(shard, userId, themeKey);
        rec.notes = text;
        rec.updatedAt = nowIso();
        return rec;
    });
}

async function setEnabled(userId, id, enabled) {
    return mutate(userId, (shard) => {
        const rec = shard.memories.find(m => m.id === id);
        if (!rec) return null;
        rec.enabled = enabled !== false;
        rec.updatedAt = nowIso();
        return rec;
    });
}

async function remove(userId, id) {
    return mutate(userId, (shard) => {
        const before = shard.memories.length;
        const gone = shard.memories.find(m => m.id === id);
        shard.memories = shard.memories.filter(m => m.id !== id);
        if (gone) {
            // A reset theme starts its record over; its stats go with it.
            if (Array.isArray(shard.statsLog)) shard.statsLog = shard.statsLog.filter(r => r.th !== gone.theme);
            if (Array.isArray(shard.statsEvents)) shard.statsEvents = shard.statsEvents.filter(e => e.th !== gone.theme);
        }
        return shard.memories.length < before;
    });
}

async function clearAll(userId) {
    return mutate(userId, (shard) => {
        const n = shard.memories.length;
        shard.memories = [];
        shard.cursors = {};
        shard.statsLog = [];
        shard.statsEvents = [];
        shard.statsSeeded = true;   // nothing left to seed from
        return n;
    });
}

// Pi bridge cursors (taskId:toolCount per key) live in the same shard.
async function getCursor(userId, key) { const s = await readShard(userId); return s.cursors[key] || null; }
async function setCursor(userId, key, value) { return mutate(userId, (shard) => { shard.cursors[key] = value; }); }

// ---------------------------------------------------------------------------
// Playbook refinement (the LLM part — optional, injected by the caller)
// ---------------------------------------------------------------------------

const REFINE_PROMPT = [
    'You maintain ONE core memory for how an AI assistant does a THEME of work for one account.',
    'You will get the current playbook (may be empty), run statistics, the proven best approach, the lessons and the observed failures gathered so far, and the most recent tasks with the tool path each one took.',
    'Rewrite the playbook so the assistant does the NEXT task of this theme faster and better. It must GENERALIZE across the tasks: describe the method that works for this kind of work, never one task.',
    'Hard rules: (1) never name a specific website, domain, product, person or topic that appears in only one task — a pattern needs at least two tasks; (2) only name tools that appear in the evidence; (3) a lesson must be supported by what happened in the tasks or be a lesson marked source "model" or "user" (keep those unless contradicted); do not invent causes; (4) never write a step for the user to do on their own device; (5) prefer the approach with the fewest tool calls that still converged, and say what to do when a call fails (retry differently, then move on) rather than "never retry"; (6) no placeholders, no praise, no restating the statistics; (7) a task marked ROUGH RUN is evidence of what went wrong, never of a method to repeat.',
    'Output ONLY JSON: {"playbook": "<≤900 chars, imperative, 3-7 short sentences or bullets>", "lessons": ["<≤160 chars each, at most 6, the most useful first>"]}',
].join(' ');

function refinementInput(rec) {
    const s = rec.stats || {};
    const lines = [];
    lines.push(`THEME: ${rec.label} — ${themeInfo(rec.theme).description}`);
    lines.push(`STATS: ${s.runs} tasks (${s.converged} converged, ${s.failedRuns} not), best ${s.bestCalls ?? '?'} calls, avg ${s.runs ? (s.totalCalls / s.runs).toFixed(1) : '?'} calls, recalled ${s.recalled}× followed ${s.followed}×`);
    lines.push(`CURRENT PLAYBOOK (v${rec.playbookVersion}): ${rec.playbook || '(empty)'}`);
    if (rec.correction && rec.correction.note) lines.push(`ACTIVE CORRECTION (measured — keep addressing it): ${rec.correction.note}`);
    if (rec.bestApproach) lines.push(`PROVEN APPROACH (${rec.bestApproach.calls} calls${rec.bestApproach.seconds != null ? `, ${rec.bestApproach.seconds} s` : ''}) for "${rec.bestApproach.task}": ${experienceMemory.renderApproach(rec.bestApproach.steps)}`);
    if (rec.lessons.length) lines.push('LESSONS:\n' + rec.lessons.map(l => `- [${l.source || 'auto'}] ${l.text}`).join('\n'));
    if (rec.avoid.length) lines.push('AVOID:\n' + rec.avoid.map(a => `- ${a.text}`).join('\n'));
    const eps = rec.episodes.slice(-6);
    if (eps.length) {
        lines.push('RECENT TASKS (oldest first):\n' + eps.map(e =>
            `- "${e.task}" → ${e.calls} call${e.calls === 1 ? '' : 's'}${e.failed ? ` (${e.failed} failed)` : ''}${e.seconds != null ? `, ${e.seconds} s` : ''}${e.converged ? '' : ', did NOT converge'}${e.rough ? ' [ROUGH RUN — the model flailed; discount it]' : ''}: ${e.approach || 'no tools'}`).join('\n'));
    }
    return lines.join('\n\n');
}

function parseRefinement(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let obj = null;
    try { obj = JSON.parse(text.slice(a, b + 1)); }
    catch (_) {
        try { const { jsonrepair } = require('jsonrepair'); obj = JSON.parse(jsonrepair(text.slice(a, b + 1))); } catch (_e) { return null; }
    }
    if (!obj || typeof obj !== 'object') return null;
    const playbook = clean(obj.playbook, PLAYBOOK_MAX_CHARS);
    const arr = (v, max, cap) => (Array.isArray(v) ? v : []).map(x => clean(x, max)).filter(Boolean).slice(0, cap);
    const lessons = arr(obj.lessons, 160, 6);
    if (!playbook && !lessons.length) return null;
    // A model that echoes the template is not a refinement.
    if (/<≤|<placeholder|\bTODO\b/i.test(playbook)) return null;
    // The avoid-list is observation-only (failed calls, detours) — the model
    // does not get to turn it into rules.
    return { playbook, lessons };
}

/** Apply a refinement: new playbook version (history kept), lessons/avoid
 *  replaced by the model's curated lists — but user/model-authored lessons the
 *  model dropped are kept (they are deliberate). */
async function applyRefinement(userId, id, ref) {
    if (!ref) return null;
    return mutate(userId, (shard) => {
        const rec = shard.memories.find(m => m.id === id);
        if (!rec) return null;
        const t = nowIso();
        if (ref.playbook && ref.playbook !== rec.playbook) {
            if (rec.playbook) {
                rec.playbookHistory.push({ version: rec.playbookVersion, at: rec.playbookUpdatedAt, runs: rec.stats.runs, playbook: rec.playbook });
                while (rec.playbookHistory.length > MAX_HISTORY) rec.playbookHistory.shift();
            }
            rec.playbook = ref.playbook;
            rec.playbookVersion += 1;
            rec.playbookUpdatedAt = t;
            try { memoryStats.logEvent(shard, { t, th: rec.theme, kind: 'refine', v: rec.playbookVersion, runs: rec.stats.runs }); } catch (_) { /* stats only */ }
            noteChange(shard, { kind: 'refine', theme: rec.theme, label: rec.label, v: rec.playbookVersion });
        }
        if (ref.lessons && ref.lessons.length) {
            const keep = rec.lessons.filter(l => l.source === 'user' || l.source === 'model');
            const merged = [];
            for (const l of ref.lessons) {
                const low = l.toLowerCase();
                const prior = rec.lessons.find(x => String(x.text).toLowerCase() === low);
                merged.push(prior || { text: l, source: 'refined', at: t, hits: 1 });
            }
            for (const k of keep) if (!merged.some(m => m.text.toLowerCase() === k.text.toLowerCase())) merged.push(k);
            rec.lessons = merged.slice(-MAX_LESSONS);
        }
        rec.dirty = false;
        rec.updatedAt = t;
        return rec;
    });
}

// ---------------------------------------------------------------------------
// Recall (what the model reads)
// ---------------------------------------------------------------------------

function renderBlock(rec, tokenBudget) {
    const s = rec.stats || {};
    const head = `CORE MEMORY — ${rec.label.toUpperCase()}: how you have done this kind of work for this account before` +
        (s.runs ? ` (${s.runs} task${s.runs === 1 ? '' : 's'}${s.bestCalls != null ? `, best run ${s.bestCalls} tool call${s.bestCalls === 1 ? '' : 's'}` : ''})` : '') +
        '. This is your own working experience — use it to work efficiently and skip what already failed. It is runtime context, not part of the user\'s message; the user\'s request always takes precedence.';
    const parts = [head];
    if (rec.notes) parts.push(`User guidance for this theme (follow it): ${rec.notes}`);
    if (rec.playbook) parts.push(`Playbook: ${rec.playbook}`);
    if (rec.bestApproach && rec.bestApproach.steps && rec.bestApproach.steps.length) {
        const oc = [`${rec.bestApproach.calls} call${rec.bestApproach.calls === 1 ? '' : 's'}`];
        if (rec.bestApproach.seconds != null) oc.push(`${rec.bestApproach.seconds} s`);
        parts.push(`Proven approach (${oc.join(', ')}, for "${rec.bestApproach.task}"): ${experienceMemory.renderApproach(rec.bestApproach.steps)}`);
    }
    let lessons = rec.lessons.slice().reverse();
    let avoid = rec.avoid.slice().reverse();
    const build = () => {
        const out = parts.slice();
        if (lessons.length) out.push('Lessons: ' + lessons.map(l => `• ${l.text}`).join(' '));
        if (avoid.length) out.push('Avoid (already tried, did not work): ' + avoid.map(a => `• ${a.text}`).join(' '));
        return out.join('\n');
    };
    let text = build();
    // Shed lessons/avoid before anything else when over budget; the playbook
    // and the user's notes are what matter.
    while (estimateTokens(text) > tokenBudget && (lessons.length || avoid.length)) {
        if (avoid.length >= lessons.length) avoid.pop(); else lessons.pop();
        text = build();
    }
    if (estimateTokens(text) > tokenBudget && rec.bestApproach) {
        const i = parts.findIndex(p => p.startsWith('Proven approach'));
        if (i >= 0) parts.splice(i, 1);
        text = build();
    }
    return text;
}

/**
 * The block for THIS turn, or null. Nothing is injected when the ask has no
 * theme, the theme has no memory yet, the memory is disabled, or it holds
 * nothing to say (no runs, no notes, no lessons).
 */
async function recall(userId, { userText = '', attachmentKinds = new Set(), toolLabels = [], tokenBudget = 700, theme = null, hostAgent = false } = {}) {
    if (!userId) return null;
    const cls = theme ? { theme, label: themeInfo(theme).label } : classifyTheme({ toolLabels, userText, attachmentKinds, hasTools: toolLabels.length > 0, hostAgent });
    if (!cls) return null;
    // The host memory describes the user's own machine; the web chat cannot act on it.
    if (cls.theme === 'host' && !hostAgent) return null;
    const shard = await readShard(userId);
    const rec = findByTheme(shard, cls.theme);
    if (!rec || rec.enabled === false) return null;
    const hasContent = (rec.stats && rec.stats.runs > 0) || rec.notes || rec.lessons.length || rec.playbook;
    if (!hasContent) return null;
    const block = renderBlock(rec, Math.max(200, tokenBudget));
    return {
        block,
        theme: rec.theme,
        label: rec.label,
        id: rec.id,
        tokens: estimateTokens(block),
        runs: rec.stats.runs,
        bestCalls: rec.stats.bestCalls,
        steps: rec.bestApproach ? rec.bestApproach.steps : [],
        tools: rec.bestApproach ? experienceMemory.approachTools(rec.bestApproach.steps) : [],
        playbookVersion: rec.playbookVersion,
    };
}

/** The theme's proven approach rendered as text ('' when none). */
async function peekBestApproach(userId, themeKey) {
    const shard = await readShard(userId);
    const rec = findByTheme(shard, themeKey);
    if (!rec || rec.enabled === false || !rec.bestApproach || !rec.bestApproach.steps) return '';
    return experienceMemory.renderApproach(rec.bestApproach.steps);
}

// ---------------------------------------------------------------------------
// One-time repair: re-file stored tasks under the right theme (2026-11-06)
// ---------------------------------------------------------------------------
// Before the `host` theme existed, terminal-agent work on the user's machine
// (bash/PowerShell/local greps) was filed under Research, Coding and General,
// and "zip code" asks counted as Coding. That made those themes look heavier
// and put host-only advice ("validate via bash first") into playbooks the web
// chat follows. This re-classifies every known task (held episodes + the
// archive), moves counters and held episodes, re-themes the stats rows, and
// clears the host advice from the themes it leaked into so the refiner
// rebuilds them. `toolsOf(approachText)` lists an episode's tools.
const THEME_VERSION = 3;
// v3 (2026-11-07): reverse-engineering tasks filed under Coding/General/
// Research move to Security analysis.
const RE_TOOLS = new Set(['disassemble', 'decompile', 'binary_info', 'gdb_batch', 'unpack_upx', 'inspect_msi']);
const RE_TEXT = /\b(reverse[- ]?engineer\w*|disassembl\w+|decompil\w+|keygen)\b/i;
const RE_FROM = new Set(['coding', 'general', 'research']);
const HOST_ADVICE_RE = /\b(bash|powershell|glob|git bash)\b/i;

// Only the two defects found are corrected; everything else keeps the theme it
// was filed under with its full context (attachments, earlier tools), which a
// re-guess from the stored task line alone does not have.
function themeOfEpisode(e, toolsOf, fromTheme, fromVersion = 1) {
    const tools = Array.isArray(e.tools) && e.tools.length ? e.tools : toolsOf(e.approach || '');
    const hostAgent = String(e.convId || '').startsWith('pi-');
    const task = experienceMemory.summarizeTask(e.task || '');
    if (fromVersion >= 2) {
        if (RE_FROM.has(fromTheme) && !hostAgent && (tools.some(t => RE_TOOLS.has(t)) || RE_TEXT.test(task))) return 'security';
        return fromTheme;
    }
    if (RE_FROM.has(fromTheme) && !hostAgent && (tools.some(t => RE_TOOLS.has(t)) || RE_TEXT.test(task))) return 'security';
    if (hostAgent && tools.length && tools.filter(t => HOST_TOOLS.includes(t)).length * 2 >= tools.length) return 'host';
    // Coding over-claimed two kinds of task: "zip code"-style asks, and data
    // analysis done with run_python/read_file (generic tools now weigh half).
    // Only those corrections are taken; any other re-guess keeps the old theme.
    if (fromTheme === 'coding') {
        const cls = classifyTheme({ toolLabels: tools, userText: task, hasTools: tools.length > 0, hostAgent });
        if (cls && (cls.theme === 'research' || cls.theme === 'data-analysis')) return cls.theme;
    }
    return fromTheme;
}

async function rethemeStored(userId, { archived = [], toolsOf = () => [] } = {}) {
    return mutate(userId, (shard) => {
        const fromVersion = shard.themeVersion || 1;
        if (fromVersion >= THEME_VERSION) return null;
        const moves = new Map();            // `${theme}|${at19}` -> newTheme
        const report = { moved: 0, byPair: {}, cleaned: [] };
        const seen = new Set();
        const consider = (fromTheme, e) => {
            if (!e || !e.at) return;
            const key = `${fromTheme}|${String(e.at).slice(0, 19)}`;
            if (seen.has(key)) return;
            seen.add(key);
            const to = themeOfEpisode(e, toolsOf, fromTheme, fromVersion);
            if (to === fromTheme) return;
            moves.set(key, to);
            // Lifetime counters follow the task.
            const src = findByTheme(shard, fromTheme);
            const dst = ensureTheme(shard, userId, to);
            const calls = Number.isFinite(e.calls) ? e.calls : 0;
            const secs = Number.isFinite(e.seconds) ? e.seconds : 0;
            const ok = e.converged !== false;
            // A provisional omp snapshot was counted with its FIRST snapshot's
            // calls (fixed in recordEpisode now), so only one call is taken back.
            const counted = e.provisional ? Math.min(1, calls) : calls;
            if (src) {
                const s = src.stats;
                s.runs = Math.max(0, s.runs - 1);
                s.totalCalls = Math.max(0, s.totalCalls - counted);
                s.totalSeconds = Math.max(0, s.totalSeconds - secs);
                if (ok) s.converged = Math.max(0, s.converged - 1); else s.failedRuns = Math.max(0, s.failedRuns - 1);
            }
            const d = dst.stats;
            d.runs += 1; d.totalCalls += calls; d.totalSeconds += secs;
            if (ok) d.converged += 1; else d.failedRuns += 1;
            if (!d.firstRunAt || e.at < d.firstRunAt) d.firstRunAt = e.at;
            if (!d.lastRunAt || e.at > d.lastRunAt) d.lastRunAt = e.at;
            d.lastCalls = calls;
            report.moved += 1;
            const pair = `${fromTheme}→${to}`;
            report.byPair[pair] = (report.byPair[pair] || 0) + 1;
        };
        for (const rec of [...shard.memories]) for (const e of rec.episodes || []) consider(rec.theme, e);
        for (const e of archived || []) consider(e.theme || 'general', e);

        // Move the held episodes themselves.
        for (const rec of [...shard.memories]) {
            const keep = [];
            for (const e of rec.episodes || []) {
                const to = moves.get(`${rec.theme}|${String(e.at).slice(0, 19)}`);
                if (!to) { keep.push(e); continue; }
                const dst = ensureTheme(shard, userId, to);
                dst.episodes.push(e);
                dst.episodes.sort((a, b) => String(a.at).localeCompare(String(b.at)));
                while (dst.episodes.length > MAX_EPISODES) dst.episodes.shift();
            }
            rec.episodes = keep;
        }
        // A proven approach that came from a moved task goes with it.
        for (const rec of [...shard.memories]) {
            const b = rec.bestApproach;
            if (!b || !b.at) continue;
            const to = moves.get(`${rec.theme}|${String(b.at).slice(0, 19)}`)
                || (rec.theme !== 'host' && (b.steps || []).length && (b.steps || []).every(st => HOST_TOOLS.includes(st.tool)) ? 'host' : null);
            if (!to) continue;
            const dst = ensureTheme(shard, userId, to);
            if (!dst.bestApproach || (b.calls ?? 1e9) < (dst.bestApproach.calls ?? 1e9)) {
                dst.bestApproach = b;
                dst.stats.bestCalls = b.calls ?? dst.stats.bestCalls;
            }
            rec.bestApproach = null;
            rec.stats.bestCalls = null;     // re-established by the next clean run
        }
        // Stats rows follow the task. A row whose episode is no longer held or
        // archived (only 8 per theme are kept) is judged by its own fields: its
        // tools when recorded, else an omp task key (every omp task recorded
        // before this theme existed was work on the user's machine).
        for (const r of shard.statsLog || []) {
            const to = moves.get(`${r.th}|${String(r.t).slice(0, 19)}`);
            if (to) { r.th = to; continue; }
            if (r.th === 'host') continue;
            if (RE_FROM.has(r.th) && Array.isArray(r.tools) && r.tools.some(t => RE_TOOLS.has(t))) { r.th = 'security'; report.rowsOnly = (report.rowsOnly || 0) + 1; continue; }
            if (fromVersion >= 2) continue;
            const tools = Array.isArray(r.tools) ? r.tools : null;
            const hostish = tools ? (tools.length && tools.filter(t => HOST_TOOLS.includes(t)).length * 2 >= tools.length)
                : String(r.k || '').startsWith('pi-');
            if (hostish) { r.th = 'host'; report.rowsOnly = (report.rowsOnly || 0) + 1; }
        }
        // Clear host advice from the themes it leaked into; the refiner rewrites
        // them from the tasks that remain. The user's own guidance is kept.
        // Themes that gave or received tasks are re-refined from what they hold now.
        const touched = new Set([...moves.values(), ...[...moves.keys()].map(k => k.split('|')[0])]);
        for (const rec of shard.memories) if (touched.has(rec.theme) && rec.episodes.length) rec.dirty = true;
        for (const rec of (fromVersion >= 2 ? [] : shard.memories)) {
            if (rec.theme === 'host') { if (rec.episodes.length) rec.dirty = true; continue; }
            let changed = false;
            if (rec.playbook && HOST_ADVICE_RE.test(rec.playbook)) {
                rec.playbookHistory.push({ version: rec.playbookVersion, at: rec.playbookUpdatedAt, runs: rec.stats.runs, playbook: rec.playbook, note: 'cleared: mixed with work on the user\'s machine' });
                while (rec.playbookHistory.length > MAX_HISTORY) rec.playbookHistory.shift();
                rec.playbook = '';
                changed = true;
            }
            const lessons = rec.lessons.filter(l => l.source === 'user' || !HOST_ADVICE_RE.test(l.text));
            if (lessons.length !== rec.lessons.length) { rec.lessons = lessons; changed = true; }
            const avoid = rec.avoid.filter(a => !HOST_TOOLS.includes(String(a.text).split(':')[0].trim()));
            if (avoid.length !== rec.avoid.length) { rec.avoid = avoid; changed = true; }
            if (changed) { rec.dirty = true; report.cleaned.push(rec.theme); }
            rec.updatedAt = nowIso();
        }
        // A theme left with no tasks at all is removed.
        shard.memories = shard.memories.filter(m => m.stats.runs > 0 || m.notes || m.episodes.length);
        shard.themeVersion = THEME_VERSION;
        report.moves = moves;
        return report;
    });
}

/** Theme records waiting for a refinement (after a repair). */
async function dirtyRecords(userId) {
    const shard = await readShard(userId);
    return shard.memories.filter(m => m.dirty).map(m => m.id);
}

/** Stats for the Memory tab's Stats view; seeds the log from the archive once. */
async function stats(userId, archived = null) {
    let shard = await readShard(userId);
    if (!shard.statsSeeded && archived) {
        shard = await mutate(userId, (sh) => { memoryStats.seedFromHistory(sh, archived); return sh; });
    }
    const out = memoryStats.computeStats(shard, allThemes());
    return { ...out, selfCorrect: selfCorrect.publicState(shard, (out.findings || {}).worsening) };
}

// ---------------------------------------------------------------------------
// Self-correction (services/selfCorrect.js decides; these apply)
// ---------------------------------------------------------------------------

/** Judge finished corrections, roll back the ones that made things worse, and
 *  return what should be done next. One write. */
async function checkCorrections(userId, { now = Date.now() } = {}) {
    if (!userId) return { judged: [], plan: [] };
    const shard0 = await readShard(userId);
    const findings = (memoryStats.computeStats(shard0, allThemes()).findings || {}).worsening || [];
    return mutate(userId, (shard) => {
        const st = selfCorrect.state(shard);
        st.lastCheckAt = new Date(now).toISOString();
        const judged = selfCorrect.evaluate(shard, { now });
        for (const a of judged) {
            const rec = shard.memories.find(r => r.theme === a.th);
            if (rec && rec.correction && rec.correction.actionId === a.id) delete rec.correction;
            if (a.rollback && rec && a.prevPlaybook) {
                setPlaybook(rec, a.prevPlaybook, 'rolled back: the correction made this theme worse');
                a.status = 'rolled_back';
                a.rolledBackTo = rec.playbookVersion;
                memoryStats.logEvent(shard, { t: nowIso(), th: rec.theme, kind: 'correct', action: 'rollback', metric: a.metric, v: rec.playbookVersion });
            }
            delete a.rollback;
            noteChange(shard, { kind: 'self_correct', phase: 'judged', theme: a.th, label: a.label, action: { id: a.id, kind: a.kind, status: a.status, metricLabel: a.metricLabel, after: a.after } });
        }
        return { judged, plan: selfCorrect.plan(shard, findings, { now }) };
    });
}

function setPlaybook(rec, text, note) {
    if (rec.playbook) {
        rec.playbookHistory.push({ version: rec.playbookVersion, at: rec.playbookUpdatedAt, runs: rec.stats.runs, playbook: rec.playbook, note });
        while (rec.playbookHistory.length > MAX_HISTORY) rec.playbookHistory.shift();
    }
    rec.playbook = clean(text, PLAYBOOK_MAX_CHARS);
    rec.playbookVersion += 1;
    rec.playbookUpdatedAt = nowIso();
    rec.updatedAt = rec.playbookUpdatedAt;
}

/** Apply one planned correction. For a refine, `ref` is the parsed model output. */
async function applyCorrection(userId, d, { ref = null, now = Date.now() } = {}) {
    return mutate(userId, (shard) => {
        const rec = shard.memories.find(r => r.theme === d.th);
        if (!rec) return null;
        const fromVersion = rec.playbookVersion;
        const prev = rec.playbook || null;
        if (d.kind === 'revert') {
            setPlaybook(rec, d.text, `replaced by self-correction (restored v${d.toVersion})`);
        } else {
            if (!ref || !ref.playbook || ref.playbook === rec.playbook) return null;
            setPlaybook(rec, ref.playbook, `replaced by self-correction (${d.metricLabel})`);
            if (Array.isArray(ref.lessons)) for (const l of ref.lessons.slice(0, 3)) addUnique(rec.lessons, l, MAX_LESSONS, { source: 'refined' });
        }
        rec.dirty = false;
        const a = selfCorrect.recordAction(shard, d, { now, fromVersion, toVersion: rec.playbookVersion, prevPlaybook: prev });
        rec.correction = {
            actionId: a.id,
            note: d.kind === 'revert'
                ? `${d.metricLabel} got worse under the newer playbook; it was restored from v${d.toVersion}, which measured better. Keep its method unless the tasks show a clear reason to change it.`
                : `${d.metricLabel} was getting worse (${selfCorrect.fmtMetric(d.metric, d.trigger.from)} → ${selfCorrect.fmtMetric(d.metric, d.trigger.to)}); this playbook was rewritten to bring it back down. Keep that focus.`,
        };
        memoryStats.logEvent(shard, { t: a.t, th: rec.theme, kind: 'correct', action: d.kind, metric: d.metric, v: rec.playbookVersion });
        noteChange(shard, { kind: 'self_correct', phase: 'applied', theme: rec.theme, label: rec.label, action: { id: a.id, kind: a.kind, metricLabel: a.metricLabel, why: a.why, toVersion: a.toVersion } });
        return a;
    });
}

module.exports = {
    events, checkCorrections, applyCorrection,
    stats, rethemeStored, dirtyRecords, HOST_TOOLS, THEME_VERSION,
    peekBestApproach,
    THEMES, GENERAL_THEME, themeInfo, allThemes, classifyTheme, deriveAttachmentKinds,
    list, get, getByTheme, listAllUsers,
    recordEpisode, markCorrection, addLesson, setNotes, setEnabled, remove, clearAll,
    getCursor, setCursor,
    REFINE_PROMPT, refinementInput, parseRefinement, applyRefinement,
    recall, renderBlock,
    estimateTokens, userIdSafe, STORE_DIR, PAIR_TOOLS, scrubPairTools,
    PLAYBOOK_MAX_CHARS, NOTES_MAX_CHARS, MAX_LESSONS, MIN_REFINE_RUNS,
};
