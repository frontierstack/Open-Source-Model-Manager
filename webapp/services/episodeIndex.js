/**
 * Episode index — a per-account VECTOR archive of every finished task.
 *
 * Core memory (coreMemory.js) keeps one small record per theme and only the
 * last 8 episodes of each, so a task done well two months ago is forgotten.
 * This archive keeps every eligible episode (task line + the tool path that
 * worked + outcome), embeds the task line with the resident embedding engine
 * (model2vec, embedding_engine.py), and at recall time hands back the one or
 * two past tasks MOST SIMILAR to the new ask — above a similarity floor, so a
 * weak match injects nothing.
 *
 * Deliberately NOT a fact store: the store this replaced as "memory" retrieved
 * extracted facts ("the user is 50 or older") and steered answers wrong. Only
 * episodes — what was done, which tools, did it work — are archived, and only
 * converged, non-rough runs with a real tool path. Secrets typed into an ask
 * are redacted before anything is written or embedded.
 *
 * Storage: /models/.modelserver/episode-index/<userIdSafe>/
 *   episodes.json — { episodes: {id: ep}, backfilled }
 *   index.sqlite  — the embedding engine's chunk table (docId = episode id)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = '/models/.modelserver';
const ROOT = path.join(DATA_DIR, 'episode-index');

const MAX_EPISODES = parseInt(process.env.EPISODE_INDEX_MAX, 10) || 2000;
// Measured on real episodes with potion-retrieval-32M: true matches scored
// 0.37–0.81, unrelated asks 0.03–0.25, borderline neighbours 0.29–0.33.
const MIN_SIM = parseFloat(process.env.EPISODE_RECALL_MIN_SIM) || 0.35;
// An ask no theme claims needs a clearer match to inject anything at all.
const MIN_SIM_NO_THEME = parseFloat(process.env.EPISODE_RECALL_MIN_SIM_NO_THEME) || 0.45;
const RECALL_K = parseInt(process.env.EPISODE_RECALL_K, 10) || 2;
const RECALL_TIMEOUT_MS = parseInt(process.env.EPISODE_RECALL_TIMEOUT_MS, 10) || 1500;
const APPROACH_MAX_CHARS = 320;

let engine = null;
function eng() { if (!engine) engine = require('./embeddingEngine'); return engine; }
function log(...a) { console.log('[episodeIndex]', ...a); }

function userIdSafe(userId) { return String(userId || 'anon').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120); }
function userDir(userId) { return path.join(ROOT, userIdSafe(userId)); }
function archivePath(userId) { return path.join(userDir(userId), 'episodes.json'); }

// ---------------------------------------------------------------------------
// Cleaning (pure)
// ---------------------------------------------------------------------------

const SECRET_KV_RE = /\b(password|passwd|passphrase|pwd|pin|secret|token|api[ _-]?key|api[ _-]?secret|bearer|credentials?)\b(\s*(?:is|was|=|:)\s*|\s+)(["']?)[^\s"',;]{4,}\3/gi;
const SECRET_TOKEN_RE = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,})\b/g;
// A long run that mixes letters, digits (and maybe symbols) and is not a word,
// path or URL fragment: a key, hash or password. Ids in URLs stay (they are
// part of the task's shape), the URL itself is kept.
const OPAQUE_RE = /(?<![\w\/.:=?&-])(?=[A-Za-z0-9!@#$%^&*+=_-]{20,}(?![\w\/.]))(?=\S*\d)(?=\S*[A-Za-z])[A-Za-z0-9!@#$%^&*+=_-]{20,}/g;

function redactSecrets(text) {
    return String(text || '')
        .replace(SECRET_TOKEN_RE, '[redacted]')
        .replace(SECRET_KV_RE, (_m, k, sep) => `${k}${/\s+$/.test(sep) && !/[=:]/.test(sep) ? ' ' : sep}[redacted]`)
        .replace(OPAQUE_RE, '[redacted]');
}

// omp/Pi wrap runtime context in <system-reminder>/<system-interrupt> tags;
// those are not the user's task.
function stripRuntimeTags(text) {
    return String(text || '')
        .replace(/<system-[a-z-]+\b[^>]*>[\s\S]*?<\/system-[a-z-]+>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanTask(task) {
    let t = stripRuntimeTags(task);
    if (!t || /^<system-/i.test(t)) return '';
    t = redactSecrets(t).slice(0, 220).trim();
    // Something worth matching against: a few real words, not just a redaction.
    const words = t.replace(/\[redacted\]/g, ' ').match(/[A-Za-z]{2,}/g) || [];
    if (words.length < 3) return '';
    return t;
}

function isRough(o) {
    const calls = o.calls || 0, failed = o.failed || 0;
    return (o.guards || 0) > 0 || (calls + failed >= 6 && failed / (calls + failed) >= 0.4);
}

function toolsFromApproachText(text) {
    return String(text || '').split(' → ')
        .map(s => s.replace(/[×(][\s\S]*$/, '').trim())
        .filter(t => t && t !== '…' && /^[a-z_][a-z0-9_]*$/i.test(t));
}

/** The archive record for an episode, or null when it is not worth keeping. */
function toRecord({ episode, theme, convId = null, taskKey = null, approachText = '', tools = null, at = null }) {
    if (!episode) return null;
    const o = episode.outcome || {};
    if (o.converged === false || isRough(o)) return null;
    const approach = redactSecrets(approachText || '').slice(0, APPROACH_MAX_CHARS);
    if (!approach) return null;
    const task = cleanTask(episode.task);
    if (!task) return null;
    const id = taskKey
        ? 'k' + crypto.createHash('sha1').update(String(taskKey)).digest('hex').slice(0, 24)
        : 'e' + crypto.randomBytes(12).toString('hex');
    return {
        id, task, theme: theme || 'general', approach,
        tools: Array.isArray(tools) ? tools.slice(0, 12) : toolsFromApproachText(approach),
        calls: Number.isFinite(o.calls) ? o.calls : null,
        seconds: Number.isFinite(o.seconds) ? o.seconds : null,
        pitfalls: (episode.pitfalls || []).map(p => redactSecrets(String(p)).slice(0, 120)).slice(0, 3),
        convId: convId || null, taskKey: taskKey || null,
        at: at || new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Store (one write queue per user)
// ---------------------------------------------------------------------------

async function readArchive(userId) {
    try {
        const parsed = JSON.parse(await fsp.readFile(archivePath(userId), 'utf8'));
        if (!parsed || typeof parsed.episodes !== 'object' || !parsed.episodes) return { episodes: {}, backfilled: !!(parsed && parsed.backfilled) };
        return parsed;
    } catch (e) {
        if (e.code !== 'ENOENT') log(`read failed for ${userIdSafe(userId)}: ${e.message}`);
        return { episodes: {}, backfilled: false };
    }
}

async function writeArchive(userId, arc) {
    const dir = userDir(userId);
    await fsp.mkdir(dir, { recursive: true });
    const target = archivePath(userId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(arc), 'utf8');
    await fsp.rename(tmp, target);
}

const queues = new Map();
function serial(userId, fn) {
    const key = userIdSafe(userId);
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    queues.set(key, run);
    run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    return run;
}

// Insert/replace records in the archive AND the vector index; evict the oldest
// past the cap. Caller holds the user's queue.
async function upsertLocked(userId, arc, records) {
    if (!records.length) return 0;
    const indexDir = userDir(userId);
    for (const r of records) {
        if (arc.episodes[r.id]) await eng().call('/delete_doc', { indexDir, docId: r.id });
        arc.episodes[r.id] = r;
    }
    await eng().call('/ingest_bulk', { indexDir, docs: records.map(r => ({ docId: r.id, filename: r.theme, chunks: [r.task] })) });
    const all = Object.values(arc.episodes);
    if (all.length > MAX_EPISODES) {
        all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        for (const old of all.slice(0, all.length - MAX_EPISODES)) {
            delete arc.episodes[old.id];
            await eng().call('/delete_doc', { indexDir, docId: old.id }).catch(() => {});
        }
    }
    return records.length;
}

/**
 * Seed the archive once from the episodes core memory already holds (the last
 * 8 per theme), so recall works from day one instead of after weeks of new runs.
 */
async function ensureBackfilled(userId, arc) {
    if (arc.backfilled) return false;
    let shard = null;
    try {
        const coreMemory = require('./coreMemory');
        shard = JSON.parse(await fsp.readFile(path.join(coreMemory.STORE_DIR, `${coreMemory.userIdSafe(userId)}.json`), 'utf8'));
    } catch (_) { /* no core memory yet */ }
    const records = [];
    for (const m of (shard && Array.isArray(shard.memories) ? shard.memories : [])) {
        for (const e of (m.episodes || [])) {
            if (!e || e.rough || e.converged === false || e.provisional) continue;
            const r = toRecord({
                episode: { task: e.task, outcome: { calls: e.calls, failed: e.failed, seconds: e.seconds, converged: e.converged } },
                theme: m.theme, convId: e.convId, taskKey: e.taskKey, approachText: e.approach, at: e.at,
            });
            if (r) records.push(r);
        }
    }
    await upsertLocked(userId, arc, records);
    arc.backfilled = true;
    if (records.length) log(`backfilled ${records.length} episode(s) for ${userIdSafe(userId)}`);
    return true;
}

/** Archive one finished (or, for the /v1 bridge, in-progress) task. */
async function archiveEpisode(userId, { episode, theme, convId = null, taskKey = null, approachText = '', tools = null }) {
    if (!userId) return null;
    const rec = toRecord({ episode, theme, convId, taskKey, approachText, tools });
    return serial(userId, async () => {
        const arc = await readArchive(userId);
        const seeded = await ensureBackfilled(userId, arc);
        if (rec) await upsertLocked(userId, arc, [rec]);
        if (rec || seeded) await writeArchive(userId, arc);
        return rec ? { id: rec.id, count: Object.keys(arc.episodes).length } : null;
    });
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

function ago(iso) {
    const ms = Date.now() - Date.parse(iso || '');
    if (!Number.isFinite(ms) || ms < 0) return '';
    const d = Math.floor(ms / 86400000);
    if (d >= 60) return `${Math.round(d / 30)} months ago`;
    if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ago`;
    const h = Math.floor(ms / 3600000);
    return h >= 1 ? `${h} hour${h === 1 ? '' : 's'} ago` : 'just now';
}

/**
 * The past tasks most similar to `query`: [{...record, score}], best first.
 * `excludeConvId` skips episodes of the current conversation (they are in the
 * history already); `skipApproach` drops a match that only repeats the theme's
 * proven approach.
 */
async function recallSimilar(userId, { query, theme = null, excludeConvId = null, skipApproach = '', k = RECALL_K, hostAgent = false } = {}) {
    const q = cleanTask(query);
    if (!userId || !q) return [];
    const work = (async () => {
        let arc = await readArchive(userId);
        if (!arc.backfilled) {
            await serial(userId, async () => {
                arc = await readArchive(userId);
                if (await ensureBackfilled(userId, arc)) await writeArchive(userId, arc);
            });
        }
        if (!Object.keys(arc.episodes).length) return [];
        const res = await eng().call('/search', { indexDir: userDir(userId), query: q, k: Math.max(8, k * 4) });
        const floor = theme ? MIN_SIM : MIN_SIM_NO_THEME;
        const out = [];
        const seenApproach = new Set(skipApproach ? [skipApproach] : []);
        const seenTask = new Set();
        for (const hit of (res.results || [])) {
            if (hit.score < floor) break;
            const r = arc.episodes[hit.docId];
            if (!r) continue;
            if (excludeConvId && r.convId && r.convId === excludeConvId) continue;
            // Work on the user's own machine is useless (and misleading) to the web chat.
            if (!hostAgent && r.theme === 'host') continue;
            const taskKey = r.task.toLowerCase().replace(/https?:\/\/\S+/g, 'URL').slice(0, 60);
            if (seenApproach.has(r.approach) || seenTask.has(taskKey)) continue;
            seenApproach.add(r.approach); seenTask.add(taskKey);
            out.push({ ...r, score: hit.score });
            if (out.length >= k) break;
        }
        return out;
    })();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), RECALL_TIMEOUT_MS); if (timer.unref) timer.unref(); });
    try {
        const r = await Promise.race([work, timeout]);
        if (r === null) { log('recall timed out'); return []; }
        return r;
    } finally { clearTimeout(timer); }
}

function estimateTokens(s) { return Math.ceil(String(s || '').length / 3.5); }

/** Render matches within a token budget (drops the weakest first). */
function renderSimilar(matches, tokenBudget = 400, { standalone = false } = {}) {
    let list = (matches || []).slice();
    const head = standalone
        ? 'PAST TASKS LIKE THIS ONE — your own earlier runs for this account, matched by similarity. Reuse what worked and adapt to what differs; this is runtime context, not part of the user\'s message, and the user\'s request always takes precedence.'
        : 'Similar past tasks (matched by similarity — reuse what worked, adapt to what differs):';
    const line = (m) => {
        const oc = [];
        if (m.calls != null) oc.push(`${m.calls} call${m.calls === 1 ? '' : 's'}`);
        if (m.seconds) oc.push(`${m.seconds} s`);
        const when = ago(m.at);
        if (when) oc.push(when);
        let s = `• "${m.task}" (${oc.join(', ')}): ${m.approach}`;
        if (m.pitfalls && m.pitfalls.length) s += ` — watch out: ${m.pitfalls.join('; ')}`;
        return s;
    };
    while (list.length) {
        const text = [head, ...list.map(line)].join('\n');
        if (estimateTokens(text) <= tokenBudget || list.length === 1) return { text, used: list };
        list = list.slice(0, -1);
    }
    return { text: '', used: [] };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

async function removeTheme(userId, theme) {
    return serial(userId, async () => {
        const arc = await readArchive(userId);
        const ids = Object.values(arc.episodes).filter(r => r.theme === theme).map(r => r.id);
        for (const id of ids) {
            delete arc.episodes[id];
            await eng().call('/delete_doc', { indexDir: userDir(userId), docId: id }).catch(() => {});
        }
        arc.backfilled = true;   // never re-seed what the user just reset
        await writeArchive(userId, arc);
        return ids.length;
    });
}

async function clearAll(userId) {
    return serial(userId, async () => {
        const arc = await readArchive(userId);
        const n = Object.keys(arc.episodes).length;
        await fsp.rm(userDir(userId), { recursive: true, force: true });
        await writeArchive(userId, { episodes: {}, backfilled: true });
        return n;
    });
}

/** Archived episodes, newest first, optionally for one theme. */
async function listEpisodes(userId, { theme = null, limit = 500 } = {}) {
    let arc = await readArchive(userId);
    if (!arc.backfilled) {
        await serial(userId, async () => {
            arc = await readArchive(userId);
            if (await ensureBackfilled(userId, arc)) await writeArchive(userId, arc);
        });
    }
    const all = Object.values(arc.episodes)
        .filter(r => !theme || r.theme === theme)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { total: all.length, episodes: all.slice(0, Math.max(1, Math.min(limit, 2000))) };
}

async function count(userId) {
    const arc = await readArchive(userId);
    return Object.keys(arc.episodes).length;
}

/** Re-theme archived episodes: `themeOf(record)` returns the new theme or null. */
async function retheme(userId, themeOf) {
    return serial(userId, async () => {
        const arc = await readArchive(userId);
        let n = 0;
        for (const r of Object.values(arc.episodes)) {
            const t = themeOf(r);
            if (t && t !== r.theme) { r.theme = t; n++; }
        }
        if (n) await writeArchive(userId, arc);
        return n;
    });
}

module.exports = {
    retheme,
    archiveEpisode, recallSimilar, renderSimilar, removeTheme, clearAll, count, listEpisodes,
    // pure, exported for tests
    cleanTask, redactSecrets, stripRuntimeTags, toRecord, toolsFromApproachText,
    MIN_SIM, MIN_SIM_NO_THEME, ROOT,
};
