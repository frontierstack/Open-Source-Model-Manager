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

const THEMES = [
    {
        key: 'security', label: 'Security analysis',
        description: 'Malware and packet-capture analysis, OSINT, binary/CTF work, IOC and vulnerability audits, log forensics.',
        tools: ['hex_dump', 'extract_strings', 'xor_bytes', 'hex_convert', 'virustotal_lookup', 'dns_lookup', 'whois_lookup', 'analyze_pe', 'yara_scan'],
        text: /\b(malware|malicious|ioc|c2\b|beacon|pcap(ng)?|packet capture|wireshark|tcpdump|osint|ctf\b|reverse[- ]?engineer\w*|disassembl\w+|shellcode|exploit|vulnerab\w+|cve[- ]?\d|phishing|ransomware|trojan|backdoor|infected|suspicious|threat|forensic\w*|virustotal|evtx|event logs?|security (audit|review|analysis)|pentest|penetration|attacker|compromise[ds]?|indicators? of compromise)\b/i,
        textWeight: 3,
        attachments: ['capture'],
    },
    {
        key: 'data-analysis', label: 'Data analysis',
        description: 'Spreadsheets, CSV/SQL, statistics, charts and time series.',
        tools: ['read_xlsx', 'create_xlsx', 'query_sqlite', 'csv_describe', 'spreadsheet_query', 'render_chart', 'fetch_timeseries', 'chart_plot', 'read_csv'],
        text: /\b(spreadsheet|excel|csv|tsv|xlsx?|pivot|charts?|graph(s| it| this)?|plot|visuali[sz]e|dashboard|histogram|scatter|dataset|statistic\w*|averages?|median|sql query|time ?series|stock (price|chart)|ticker|correlat\w+|forecast)\b/i,
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
        text: /\b(code|codebase|repo(sitory)?|scripts?|functions?|class(es)?|bug|debug|refactor|compile|build (me |a |an )?(app|game|page|site|tool|script|cli)|python|javascript|typescript|node\.?js|react|html|css|api|endpoint|regex|sql|npm|package\.json|library|unit tests?|stack ?trace|traceback|game|website|web ?app)\b/i,
        textWeight: 1.5,
        attachments: ['code', 'archive'],
    },
    {
        key: 'research', label: 'Research',
        description: 'Looking things up on the web, comparing options, gathering sources, current events.',
        tools: ['web', 'web_search', 'fetch_url', 'crawl_pages', 'scrapling_fetch', 'playwright_fetch', 'playwright_interact', 'download_html', 'parse_rss'],
        text: /\b(research|search(es)?|look ?(it )?up|find (out|me|the|a|info)|latest|news|current|recent|who is|what is (the )?(price|cost|status)|compare|comparison|reviews? of|release date|best .{0,30} for|sources?|cite|citations?|articles?|according to|website|online|google|wikipedia|trending|announced)\b/i,
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
function classifyTheme({ toolLabels = [], userText = '', attachmentKinds = new Set(), hasTools = null } = {}) {
    const scores = new Map();
    const bump = (k, w) => scores.set(k, (scores.get(k) || 0) + w);
    const q = clean(userText, 4000);
    for (const label of toolLabels) {
        const k = TOOL_THEME.get(label);
        if (k) bump(k, 1);
    }
    for (const t of THEMES) {
        if (t.text && q && t.text.test(q)) bump(t.key, t.textWeight || 1.5);
        for (const kind of t.attachments) if (attachmentKinds && attachmentKinds.has && attachmentKinds.has(kind)) bump(t.key, 2);
    }
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
function mutate(userId, fn) {
    const key = userIdSafe(userId);
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const shard = await readShard(userId);
        const out = await fn(shard);
        await writeShard(userId, shard);
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
async function recordEpisode(userId, { episode, theme, convId = null, recalled = null, taskKey = null, provisional = false }) {
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
        rec.dirty = true;               // playbook refinement pending
        rec.updatedAt = t;
        return { id: rec.id, theme: rec.theme, label: rec.label, runs: s.runs, newBest, improvedVsBest, followed, provisional: !!provisional, sameRun, bestCalls: s.bestCalls, calls };
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
        shard.memories = shard.memories.filter(m => m.id !== id);
        return shard.memories.length < before;
    });
}

async function clearAll(userId) {
    return mutate(userId, (shard) => {
        const n = shard.memories.length;
        shard.memories = [];
        shard.cursors = {};
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
async function recall(userId, { userText = '', attachmentKinds = new Set(), toolLabels = [], tokenBudget = 700, theme = null } = {}) {
    if (!userId) return null;
    const cls = theme ? { theme, label: themeInfo(theme).label } : classifyTheme({ toolLabels, userText, attachmentKinds, hasTools: toolLabels.length > 0 });
    if (!cls) return null;
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

module.exports = {
    THEMES, GENERAL_THEME, themeInfo, allThemes, classifyTheme, deriveAttachmentKinds,
    list, get, getByTheme, listAllUsers,
    recordEpisode, addLesson, setNotes, setEnabled, remove, clearAll,
    getCursor, setCursor,
    REFINE_PROMPT, refinementInput, parseRefinement, applyRefinement,
    recall, renderBlock,
    estimateTokens, userIdSafe, STORE_DIR, PAIR_TOOLS, scrubPairTools,
    PLAYBOOK_MAX_CHARS, NOTES_MAX_CHARS, MAX_LESSONS, MIN_REFINE_RUNS,
};
