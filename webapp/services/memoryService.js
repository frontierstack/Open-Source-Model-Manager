/**
 * Memory service — account-scoped persona/fact memory for the chat model.
 *
 * This is the model's CONTINUAL-LEARNING store: it accumulates experience the
 * way a person does — facts about the user, corrections and preferences
 * (directives), and EXPERIENCE memories (procedures: how a kind of task was
 * done and what worked). Records are consolidated/refined in place rather than
 * piled up, so the store self-improves instead of sprawling.
 *
 * Storage (v2 — sharded): one file PER USER at memory/<userIdSafe>.json,
 * base64-wrapped compact JSON (same obfuscation level as conversations — the
 * distilled-personal-data store shouldn't be the only plaintext one). The old
 * single memories.json is split into shards once at startup (then renamed
 * *.migrated-bak). Sharding means a turn-save rewrites ONE user's records,
 * not every user's, and writes are serialized per user instead of globally.
 *
 * Semantic index: every create/update/delete mirrors into memoryIndex.js
 * (kb_engine embeddings, docId = memory id) BEST-EFFORT — embedding failures
 * never block a write; retrieval falls back to keyword matching.
 *
 * Responsibilities (STORAGE only — the heuristics that PRODUCE memories live
 * in server.js):
 *   - own the per-user memory shards: list / get / create / update / delete.
 *   - account-wide dedup + supersedence + prune so a user's set stays bounded.
 *   - per-conversation extraction cursors.
 *   - one-time migrations (per-conversation dirs → account store; flat
 *     memories.json → per-user shards).
 *
 * Records (one per memory):
 *   { id, userId, title, text, keywords[], tokens, score,
 *     source: 'auto'|'manual'|'model',
 *     type:  null|'feedback'|'issue'|'preference'|'workaround'|'correction'|'limitation'|'learning'|'fact'|'procedure',
 *     impact: null|'important'|'medium'|'low',
 *     pinned: bool,   // user-flagged: never pruned
 *     muted: bool,    // user-flagged: kept but never injected
 *     activity, count, bestSteps, textSource,   // procedure/experience fields
 *     sourceRole, sourceConvId, sourceTurnId, createdAt, updatedAt }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const memoryIndex = require('./memoryIndex');

const DATA_DIR = '/models/.modelserver';
const LEGACY_META_FILE = path.join(DATA_DIR, 'memories.json');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const CURSOR_FILE = path.join(DATA_DIR, 'memory-cursors.json');
const MIGRATED_FILE = path.join(DATA_DIR, 'memory-migrated.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

// Per-account cap. When exceeded we drop the lowest-score, oldest entries
// first (pinned entries and the persona — procedures + important model
// learnings — are floored so they survive pruning).
const ACCOUNT_MEMORY_MAX = 2000;
const MEMORY_TEXT_MAX = 2000;
// Account-wide dedup threshold on keyword Jaccard overlap (near-identical).
const DEDUP_THRESHOLD = 0.75;
// Supersedence: same TOPIC but different content → the new fact replaces the
// old one in place (a changed fact must not coexist with its stale version).
// Two branches: keyword overlap (ratio over the smaller set), and embedding
// cosine from the memory index. The keyword branch alone missed obvious
// rewrites — LLM-extracted sentences vary their filler ("primarily consists
// of" vs "uses … gear"), which inflates both keyword sets: a measured
// same-topic pair shared 5 keywords yet scored ratio 0.455. Its cosine was
// 0.656, while the closest must-NOT-merge pair (same user, different aspect:
// job role vs network gear) measured 0.337 — hence 0.6, with a small shared-
// keyword floor as an anchor against embedding quirks.
const SUPERSEDE_RATIO = 0.6;
const SUPERSEDE_MIN_SHARED = 3;
const SUPERSEDE_SEM = 0.6;
const SUPERSEDE_SEM_MIN_SHARED = 2;
// Experience variants: how many distinct recipes one activity may hold, and
// how close a new recipe must be (topic overlap) to refine an existing one
// instead of becoming a new variant. Practice specializes: "coding" on a React
// app and "coding" on a CUDA build deserve separate recipes.
const MAX_ACTIVITY_VARIANTS = 3;
const VARIANT_MATCH_RATIO = 0.5;

const VALID_SOURCES = new Set(['auto', 'manual', 'model']);
const VALID_TYPES = new Set([
    'feedback', 'issue', 'preference', 'workaround', 'correction', 'limitation', 'learning', 'fact',
    // 'procedure' = an EXPERIENCE memory: how the model performed a high-level
    // activity ("reading emails", "web research") and the approach that worked.
    // Keyed by `activity` (up to MAX_ACTIVITY_VARIANTS variants per activity),
    // reinforced (count++) and refined each time that activity recurs — these
    // accumulate into the model's persona / skill set.
    'procedure',
]);
const VALID_IMPACTS = new Set(['important', 'medium', 'low']);

// Canonicalize a free-form activity label into a stable consolidation key.
function normalizeActivity(a) {
    return String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// --------------------------------------------------------------------------
// Title derivation — every memory carries a short, human-readable title of the
// form "<Category> — <summary>" (procedures: "Experience — <activity>"). The
// old UI rendered the raw memory text as its own title, so a captured markdown
// table row ("| `P` | Pause / Resume |") became the visible title. Titles are
// always auto-derived (not user-editable) so the Memory tab reads cleanly
// regardless of how noisy the underlying text is.
const TYPE_LABEL = {
    fact: 'Fact', preference: 'Preference', correction: 'Correction',
    limitation: 'Limitation', workaround: 'Workaround', issue: 'Issue',
    feedback: 'Feedback', learning: 'Learning', procedure: 'Experience',
};

function titleCaseWords(s) {
    return String(s || '').replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

// Condense a memory's body into a short noun-phrase summary: strip markdown /
// table / tag syntax, take the first clause, cap length on a word boundary.
function summarizeMemoryText(text, maxLen = 56) {
    let s = String(text || '')
        .replace(/<[^>]+>/g, ' ')          // html / think tags
        .replace(/`{1,3}/g, ' ')           // code fences / inline code ticks
        .replace(/[*_#>~]+/g, ' ')         // markdown emphasis / headings / quotes
        .replace(/\|/g, ' ')               // table pipes
        .replace(/^\s*[-*+]\s+/, '')       // leading list marker
        .replace(/^\s*\d+\.\s+/, '')       // leading ordinal marker
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';
    // First clause — split on sentence/clause boundaries but keep it meaningful.
    const firstClause = s.split(/\s+[—–-]\s+|[:;.]\s+/)[0].trim() || s;
    let out = firstClause.length > maxLen
        ? firstClause.slice(0, maxLen).replace(/\s+\S*$/, '').trim() + '…'
        : firstClause;
    return out;
}

// Build the "<Category> — <summary>" title for a record. Procedures lead their
// text with the activity label ("Reading emails: …"); reuse that nice label.
function deriveMemoryTitle(rec) {
    if (rec.type === 'procedure') {
        const lead = String(rec.text || '').split(':')[0].trim();
        const label = (lead && lead.length <= 42)
            ? lead
            : titleCaseWords(String(rec.activity || 'experience').replace(/-/g, ' '));
        return `Experience — ${label}`;
    }
    const typeLabel = TYPE_LABEL[rec.type] || 'Note';
    const summary = summarizeMemoryText(rec.text);
    return summary ? `${typeLabel} — ${summary}` : typeLabel;
}

function log(...a) { console.log('[memory]', ...a); }

// --------------------------------------------------------------------------
// Local helpers (kept self-contained so the service has no server.js dep)
// --------------------------------------------------------------------------

function jaccardSimilarity(aKeywords, bKeywords) {
    if (!aKeywords?.length || !bKeywords?.length) return 0;
    const a = new Set(aKeywords);
    const b = new Set(bKeywords);
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

// Overlap (Szymkiewicz–Simpson) coefficient: intersection / size of the SMALLER
// set, plus the raw intersection count. Jaccard is wrong for matching a refined
// learning to its original — a refinement is much longer, so length asymmetry
// tanks Jaccard even when the new lesson is plainly about the same topic
// ("Yahoo only" vs "Yahoo, then Stooq + others, keep searching"). Overlap is
// length-insensitive: if the shorter memory's keywords are mostly contained in
// the new one, it's the same topic. The intersection count guards against
// coincidental 1–2 shared-word merges on tiny keyword sets.
function topicOverlap(aKeywords, bKeywords) {
    if (!aKeywords?.length || !bKeywords?.length) return { ratio: 0, inter: 0 };
    const a = new Set(aKeywords);
    const b = new Set(bKeywords);
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    const denom = Math.min(a.size, b.size);
    return { ratio: denom === 0 ? 0 : inter / denom, inter };
}

// Decode a possibly base64-wrapped JSON blob — both the v2 shard files and the
// legacy .mem files use this (mirrors server.js decodeConversationData).
function decodeMaybeBase64(raw, fallback = null) {
    if (!raw || !raw.trim()) return fallback;
    const trimmed = raw.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
        try { return JSON.parse(trimmed); } catch { return fallback; }
    }
    try { return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8')); }
    catch { return fallback; }
}

function userIdSafe(userId) {
    return String(userId == null ? 'global' : userId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function nowIso() { return new Date().toISOString(); }

function estimateTokens(text) { return Math.ceil(String(text || '').length / 3); }

// --------------------------------------------------------------------------
// Sharded per-user store (memory/<userIdSafe>.json, base64-wrapped JSON)
// --------------------------------------------------------------------------

// In-process cache: userIdSafe → list. Safe because this process is the only
// writer; invalidated implicitly by being updated inside every mutate.
const userCache = new Map();
// Per-user write serializers so concurrent saves for one user don't clobber,
// while different users' writes proceed independently.
const userChains = new Map();

function shardPath(userId) {
    return path.join(MEMORY_DIR, `${userIdSafe(userId)}.json`);
}

async function readUserList(userId) {
    const key = userIdSafe(userId);
    if (userCache.has(key)) return userCache.get(key);
    let list = [];
    try {
        const raw = await fsp.readFile(shardPath(userId), 'utf8');
        const parsed = decodeMaybeBase64(raw, []);
        list = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    userCache.set(key, list);
    return list;
}

async function writeUserList(userId, list) {
    await fsp.mkdir(MEMORY_DIR, { recursive: true });
    const encoded = Buffer.from(JSON.stringify(list)).toString('base64');
    await fsp.writeFile(shardPath(userId), encoded);
    userCache.set(userIdSafe(userId), list);
}

/** Serialize read-modify-write PER USER. `fn(list)` mutates in place. */
function mutateUser(userId, fn) {
    const key = userIdSafe(userId);
    const prev = userChains.get(key) || Promise.resolve();
    const next = prev.then(async () => {
        await ensureStore();
        const list = await readUserList(userId);
        const result = await fn(list);
        await writeUserList(userId, list);
        return result;
    });
    userChains.set(key, next.catch(() => {}));
    return next;
}

// One-time store-format migration: split the flat all-users memories.json into
// per-user shards. Runs lazily before the first operation; the legacy file is
// renamed (not deleted) for rollback safety. Each migrated user's semantic
// index is built in the background.
let storeReadyPromise = null;
function ensureStore() {
    if (storeReadyPromise) return storeReadyPromise;
    storeReadyPromise = (async () => {
        let legacy = null;
        try {
            legacy = JSON.parse(await fsp.readFile(LEGACY_META_FILE, 'utf8'));
        } catch (e) {
            if (e.code !== 'ENOENT') log(`legacy store unreadable (${e.message}); starting sharded store fresh`);
            return;
        }
        if (!Array.isArray(legacy)) legacy = [];
        const byUser = new Map();
        for (const rec of legacy) {
            const key = rec.userId ?? null;
            if (!byUser.has(key)) byUser.set(key, []);
            byUser.get(key).push(normalizeRecord(rec));
        }
        await fsp.mkdir(MEMORY_DIR, { recursive: true });
        for (const [uid, list] of byUser) {
            await writeUserList(uid, list);
        }
        await fsp.rename(LEGACY_META_FILE, `${LEGACY_META_FILE}.migrated-bak`);
        log(`split legacy memories.json into ${byUser.size} per-user shard(s)`);
        // Backfill semantic indexes in the background (best-effort).
        for (const [uid, list] of byUser) {
            memoryIndex.reindexUser(uid, list).catch(() => {});
        }
    })().catch((e) => { log(`store migration failed: ${e.message}`); });
    return storeReadyPromise;
}

/** Every user shard on disk (admin list-all). */
async function readAllLists() {
    await ensureStore();
    let files = [];
    try {
        files = (await fsp.readdir(MEMORY_DIR)).filter((f) => f.endsWith('.json'));
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const out = [];
    for (const f of files) {
        const key = f.slice(0, -5);
        if (userCache.has(key)) { out.push(...userCache.get(key)); continue; }
        try {
            const parsed = decodeMaybeBase64(await fsp.readFile(path.join(MEMORY_DIR, f), 'utf8'), []);
            if (Array.isArray(parsed)) { userCache.set(key, parsed); out.push(...parsed); }
        } catch (_) { /* unreadable shard — skip */ }
    }
    return out;
}

// --------------------------------------------------------------------------
// CRUD
// --------------------------------------------------------------------------

async function listMemories(userId, { all = false } = {}) {
    await ensureStore();
    if (all) return readAllLists();
    const list = await readUserList(userId);
    // Filter defensively: distinct raw ids could sanitize to the same shard.
    return list.filter((m) => m.userId === userId);
}

async function getMemory(id) {
    const all = await readAllLists();
    return all.find((m) => m.id === id) || null;
}

function normalizeRecord(input) {
    const text = String(input.text || '').slice(0, MEMORY_TEXT_MAX);
    const source = VALID_SOURCES.has(input.source) ? input.source : 'manual';
    const type = input.type && VALID_TYPES.has(input.type) ? input.type : null;
    const impact = input.impact && VALID_IMPACTS.has(input.impact) ? input.impact : null;
    const activity = input.activity ? normalizeActivity(input.activity) : null;
    const rec = {
        id: input.id || crypto.randomUUID(),
        userId: input.userId ?? null,
        // Short, auto-derived "<Category> — <summary>" title for the Memory tab
        // (never the raw text). Always recomputed from text/type/activity so a
        // noisy body can't become the visible title.
        title: deriveMemoryTitle({ type, activity, text }),
        text,
        keywords: Array.isArray(input.keywords) ? input.keywords.slice(0, 40) : [],
        tokens: Number.isFinite(input.tokens) ? input.tokens : estimateTokens(text),
        score: Number.isFinite(input.score) ? input.score : 0,
        source,
        type,
        impact,
        // User-controlled flags: pinned = never pruned; muted = stored but
        // never injected. Together they give an escape hatch short of delete.
        pinned: input.pinned === true,
        muted: input.muted === true,
        // Experience/procedure memories: `activity` is the consolidation key,
        // `count` is how many times that activity has been reinforced (depth of
        // experience). Null/1 for ordinary memories.
        activity,
        count: Number.isFinite(input.count) ? input.count : 1,
        sourceRole: input.sourceRole || null,
        sourceConvId: input.sourceConvId || null,
        sourceTurnId: input.sourceTurnId || null,
        createdAt: input.createdAt || nowIso(),
        updatedAt: input.updatedAt || nowIso(),
    };
    if (input.textSource) rec.textSource = input.textSource;
    if (Number.isFinite(input.bestSteps)) rec.bestSteps = input.bestSteps;
    return rec;
}

/** Create one memory (manual add or a model learning). Returns the record. */
async function createMemory(input) {
    const rec = normalizeRecord(input);
    if (!rec.text.trim()) throw new Error('memory text is required');
    let dropped = [];
    await mutateUser(rec.userId, (list) => {
        list.push(rec);
        dropped = pruneUser(list, rec.userId);
    });
    memoryIndex.upsert(rec.userId, rec).catch(() => {});
    if (dropped.length) memoryIndex.removeMany(rec.userId, dropped).catch(() => {});
    return rec;
}

/** Patch one memory by id (scans shards to find the owner). */
async function updateMemory(id, patch) {
    const existing = await getMemory(id);
    if (!existing) return null;
    const result = await mutateUser(existing.userId, (list) => {
        const m = list.find((x) => x.id === id);
        if (!m) return null;
        if (patch.text != null) m.text = String(patch.text).slice(0, MEMORY_TEXT_MAX);
        if (Array.isArray(patch.keywords)) m.keywords = patch.keywords.slice(0, 40);
        if (Number.isFinite(patch.tokens)) m.tokens = patch.tokens;
        if (Number.isFinite(patch.score)) m.score = patch.score;
        if (patch.type !== undefined) m.type = patch.type && VALID_TYPES.has(patch.type) ? patch.type : null;
        if (patch.impact !== undefined) m.impact = patch.impact && VALID_IMPACTS.has(patch.impact) ? patch.impact : null;
        if (patch.activity !== undefined) m.activity = patch.activity ? normalizeActivity(patch.activity) : null;
        if (Number.isFinite(patch.count)) m.count = patch.count;
        if (patch.pinned !== undefined) m.pinned = patch.pinned === true;
        if (patch.muted !== undefined) m.muted = patch.muted === true;
        // Title is always derived — recompute whenever the body/type/activity
        // that feeds it may have changed.
        m.title = deriveMemoryTitle(m);
        m.updatedAt = nowIso();
        return { ...m };
    });
    if (result && patch.text != null) {
        memoryIndex.upsert(existing.userId, result).catch(() => {});
    }
    return result;
}

async function deleteMemory(id) {
    const existing = await getMemory(id);
    if (!existing) return false;
    const removed = await mutateUser(existing.userId, (list) => {
        const i = list.findIndex((m) => m.id === id);
        if (i < 0) return false;
        list.splice(i, 1);
        return true;
    });
    if (removed) memoryIndex.remove(existing.userId, id).catch(() => {});
    return removed;
}

/** Remove all memories for a user (used by the "clear all" route). */
async function clearMemories(userId) {
    const removed = await mutateUser(userId, (list) => {
        const n = list.length;
        list.length = 0;
        return n;
    });
    memoryIndex.clearUser(userId).catch(() => {});
    return removed;
}

/** Rebuild a user's semantic index from their current records (self-heal /
 * backfill). Fire-and-forget friendly. */
async function reindexUser(userId) {
    const list = await listMemories(userId);
    return memoryIndex.reindexUser(userId, list);
}

// In-place prune of one user's entries down to the cap. Drops lowest-score,
// oldest first. Pinned entries and the persona (procedures, important model
// learnings) are floored so they survive. Mutates `list` (called inside
// mutateUser). Returns the DROPPED record ids so callers can clean the
// semantic index.
function pruneUser(list, userId) {
    if (list.length <= ACCOUNT_MEMORY_MAX) return [];
    const weight = (m) => {
        if (m.pinned) return Infinity;                 // user said: never forget
        // Procedure/experience memories ARE the persona — they must survive
        // pruning, weighted by how reinforced they are (count).
        if (m.type === 'procedure') return 2000 + (m.count || 1);
        if (m.source === 'model' && m.impact === 'important') return 1000 + (m.score || 0);
        return m.score || 0;
    };
    const idx = list.map((_, i) => i);
    idx.sort((ia, ib) => {
        const wa = weight(list[ia]); const wb = weight(list[ib]);
        if (wb !== wa) return wb - wa;
        // tie-break: newer kept over older
        return (list[ib].updatedAt || '').localeCompare(list[ia].updatedAt || '');
    });
    const dropIdx = new Set(idx.slice(ACCOUNT_MEMORY_MAX));
    const droppedIds = [...dropIdx].map((i) => list[i].id);
    const toDrop = [...dropIdx].sort((a, b) => b - a);
    for (const i of toDrop) list.splice(i, 1);
    return droppedIds;
}

/**
 * Bulk-add auto-extracted memory candidates for a user. Three outcomes per
 * candidate, checked in order:
 *   1. NEAR-DUPLICATE (keyword Jaccard ≥ DEDUP_THRESHOLD of any existing or
 *      already-accepted entry) → skipped.
 *   2. SUPERSEDES an existing AUTO fact (same topic by overlap coefficient —
 *      SUPERSEDE_RATIO/_MIN_SHARED — but different content): the old record is
 *      UPDATED IN PLACE (id/createdAt kept). A fact that changed ("uses
 *      Windows" → "switched to Linux") must replace its stale version, not
 *      coexist with it — recency boosts are too weak to arbitrate at
 *      retrieval. Pinned / manual / model / procedure records are never
 *      auto-superseded.
 *   3. Otherwise CREATED as a new record.
 * Returns { added, superseded, items } where items briefly describes each
 * created/updated record (for process-logging what was learned this turn).
 */
async function addAutoMemories(userId, candidates, { sourceConvId = null } = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return { added: 0, superseded: 0, items: [] };
    // Pre-compute embedding similarity (candidate text → existing memories)
    // for the supersedence pass's semantic branch. Outside the mutate (the
    // callback is sync); null when the engine is down — the keyword branch
    // still applies, so supersedence degrades, never breaks. Memories first
    // added in THIS batch aren't in the index yet; cross-candidate supersede
    // within one batch falls back to keywords, which is fine.
    const candSem = [];
    for (const c of candidates) {
        let scores = null;
        try {
            const sem = await memoryIndex.search(userId, String(c.text || ''), 32);
            scores = sem ? sem.scores : null;
        } catch (_) { scores = null; }
        candSem.push(scores);
    }
    let added = 0;
    let superseded = 0;
    const items = [];
    const touched = []; // records to (re-)embed after the mutate commits
    let dropped = [];
    await mutateUser(userId, (list) => {
        const acceptedKeywords = list.map((m) => m.keywords || []);
        for (let ci = 0; ci < candidates.length; ci++) {
            const c = candidates[ci];
            const kw = Array.isArray(c.keywords) ? c.keywords : [];
            if (!kw.length) continue;
            const dup = acceptedKeywords.some((k) => jaccardSimilarity(k, kw) >= DEDUP_THRESHOLD);
            if (dup) continue;

            // Supersedence pass — same topic, different content → refine the
            // old auto fact in place instead of stacking a contradiction.
            // Keyword overlap OR embedding cosine qualifies; strongest match
            // wins on whichever signal qualified it.
            const cType = (c.type && VALID_TYPES.has(c.type)) ? c.type : 'fact';
            let target = null, bestMatch = 0;
            for (const m of list) {
                if (m.source !== 'auto' || m.pinned || m.type === 'procedure') continue;
                if ((m.type || 'fact') !== cType) continue;
                const { ratio, inter } = topicOverlap(m.keywords || [], kw);
                const sem = candSem[ci] ? (candSem[ci].get(m.id) ?? 0) : 0;
                const keywordHit = inter >= SUPERSEDE_MIN_SHARED && ratio >= SUPERSEDE_RATIO;
                const semanticHit = sem >= SUPERSEDE_SEM && inter >= SUPERSEDE_SEM_MIN_SHARED;
                const strength = Math.max(keywordHit ? ratio : 0, semanticHit ? sem : 0);
                if ((keywordHit || semanticHit) && strength > bestMatch) {
                    bestMatch = strength; target = m;
                }
            }
            if (target) {
                target.text = String(c.text || '').slice(0, MEMORY_TEXT_MAX);
                target.keywords = kw.slice(0, 40);
                target.tokens = Number.isFinite(c.tokens) ? c.tokens : estimateTokens(target.text);
                if (Number.isFinite(c.score)) target.score = c.score;
                if (c.impact && VALID_IMPACTS.has(c.impact)) target.impact = c.impact;
                target.sourceRole = c.sourceRole || target.sourceRole;
                target.sourceConvId = c.sourceConvId || sourceConvId || target.sourceConvId;
                target.sourceTurnId = c.sourceTurnId || target.sourceTurnId;
                target.title = deriveMemoryTitle(target);
                target.updatedAt = nowIso();
                acceptedKeywords.push(kw);
                touched.push({ ...target });
                items.push({ text: target.text, type: target.type, impact: target.impact, superseded: true });
                superseded++;
                continue;
            }

            const rec = normalizeRecord({
                userId,
                text: c.text,
                keywords: kw,
                tokens: c.tokens,
                score: c.score,
                source: 'auto',
                // Classification from the extractor (LLM or heuristic). Falls
                // back to a plain fact so a caller that doesn't classify works.
                type: cType,
                impact: c.impact || null,
                sourceRole: c.sourceRole || null,
                sourceConvId: c.sourceConvId || sourceConvId,
                sourceTurnId: c.sourceTurnId || null,
            });
            list.push(rec);
            acceptedKeywords.push(kw);
            touched.push(rec);
            items.push({ text: rec.text, type: rec.type, impact: rec.impact });
            added++;
        }
        if (added) dropped = pruneUser(list, userId);
    });
    for (const rec of touched) memoryIndex.upsert(userId, rec).catch(() => {});
    if (dropped.length) memoryIndex.removeMany(userId, dropped).catch(() => {});
    return { added, superseded, items };
}

async function countForUser(userId) {
    const list = await listMemories(userId);
    return list.length;
}

const IMPACT_RANK = { important: 3, medium: 2, low: 1 };
function scoreForImpact(impact) {
    return impact === 'important' ? 7 : (impact === 'low' ? 3 : 5);
}

/**
 * Record a MODEL learning, but CONSOLIDATE instead of blindly appending — this
 * is what makes account memory a continual-learning store rather than an
 * ever-growing pile of near-duplicates. The whole read-modify-write runs inside
 * mutateUser so the find-target + update/create is atomic (no lost-update race).
 *
 * Target selection (a memory to REFINE in place):
 *   1. `opts.replaces` — an explicit [#handle] the model surfaced from its
 *      injected context. May target ANY of THIS user's memories (incl. ones the
 *      user authored manually) — a deliberate, model-driven edit.
 *   2. otherwise auto-detect the closest existing MODEL learning by topic
 *      overlap ≥ autoMergeThreshold. Auto-merge NEVER touches a manual memory —
 *      only an explicit handle can — so the model can't silently overwrite what
 *      the user wrote.
 *
 * When refining, the STRONGER impact wins (an experience that proved important
 * isn't demoted by a casual re-record). Returns { id, updated, impact }.
 *
 * `input`: { text, keywords, type, impact, tokens?, sourceConvId? }
 */
async function upsertModelLearning(userId, input, opts = {}) {
    // autoMergeThreshold is an OVERLAP-coefficient floor (not Jaccard);
    // minSharedKeywords guards tiny keyword sets from coincidental merges.
    const { replaces = null, autoMergeThreshold = 0.6, minSharedKeywords = 3 } = opts;
    const text = String(input.text || '').slice(0, MEMORY_TEXT_MAX);
    if (!text.trim()) throw new Error('learning text is required');
    const keywords = Array.isArray(input.keywords) ? input.keywords.slice(0, 40) : [];
    const reqImpact = VALID_IMPACTS.has(input.impact) ? input.impact : 'medium';
    const reqType = input.type && VALID_TYPES.has(input.type) ? input.type : 'learning';
    const tokens = Number.isFinite(input.tokens) ? input.tokens : estimateTokens(text);

    let embedRec = null;
    let dropped = [];
    const result = await mutateUser(userId, (list) => {
        let target = null;
        const handle = String(replaces || '').replace(/^#/, '').trim().toLowerCase();
        if (handle) {
            target = list.find((m) => {
                const id = String(m.id).toLowerCase();
                return id === handle || id.startsWith(handle) || id.replace(/-/g, '').startsWith(handle);
            }) || null;
        }
        if (!target) {
            // Auto-detect the closest prior MODEL learning by TOPIC overlap (not
            // Jaccard — see topicOverlap). Merge when the smaller keyword set is
            // mostly contained in the new lesson AND they share enough concrete
            // terms (≥ minSharedKeywords) to be confidently the same topic.
            let best = null, bestRatio = 0;
            for (const m of list) {
                if (m.source !== 'model') continue; // never auto-clobber manual/auto entries
                const { ratio, inter } = topicOverlap(m.keywords || [], keywords);
                if (inter >= minSharedKeywords && ratio >= autoMergeThreshold && ratio > bestRatio) {
                    bestRatio = ratio; best = m;
                }
            }
            if (best) target = best;
        }

        if (target) {
            const mergedImpact = (IMPACT_RANK[reqImpact] || 2) >= (IMPACT_RANK[target.impact] || 2)
                ? reqImpact : target.impact;
            target.text = text;
            if (keywords.length) target.keywords = keywords;
            target.type = reqType;
            target.impact = mergedImpact;
            target.score = scoreForImpact(mergedImpact);
            target.tokens = tokens;
            target.title = deriveMemoryTitle(target);
            target.updatedAt = nowIso();
            embedRec = { ...target };
            return { id: target.id, updated: true, impact: mergedImpact };
        }

        const rec = normalizeRecord({
            userId, text, keywords, tokens,
            score: scoreForImpact(reqImpact),
            source: 'model', type: reqType, impact: reqImpact,
            sourceConvId: input.sourceConvId || null,
        });
        list.push(rec);
        dropped = pruneUser(list, userId);
        embedRec = rec;
        return { id: rec.id, updated: false, impact: rec.impact };
    });
    if (embedRec) memoryIndex.upsert(userId, embedRec).catch(() => {});
    if (dropped.length) memoryIndex.removeMany(userId, dropped).catch(() => {});
    return result;
}

/**
 * Record/refine an EXPERIENCE memory for a high-level ACTIVITY ("reading
 * emails", "web research"). Consolidates by the `activity` key, with up to
 * MAX_ACTIVITY_VARIANTS distinct recipes per activity — practice SPECIALIZES:
 * "coding" on a React app and "coding" on a CUDA build are different skills,
 * and one generic recipe degrades both. Variant selection: the closest
 * existing recipe by topic overlap (≥ VARIANT_MATCH_RATIO) is refined in
 * place; a genuinely different recipe becomes a NEW variant until the cap,
 * after which the closest one is refined regardless. Each refinement
 * increments `count` (depth of experience) and promotes well-practiced skills
 * to 'important'. Atomic inside mutateUser.
 * Returns { id, updated, count, impact, variant }.
 *
 * `input`: { activity, text, keywords, impact?, tokens?, source?, steps?, sourceConvId? }
 */
async function upsertActivityMemory(userId, input) {
    const activity = normalizeActivity(input.activity);
    if (!activity) throw new Error('activity is required');
    const text = String(input.text || '').slice(0, MEMORY_TEXT_MAX);
    if (!text.trim()) throw new Error('experience text is required');
    const keywords = Array.isArray(input.keywords) ? input.keywords.slice(0, 40) : [];
    const reqImpact = VALID_IMPACTS.has(input.impact) ? input.impact : 'medium';
    const tokens = Number.isFinite(input.tokens) ? input.tokens : estimateTokens(text);
    const source = VALID_SOURCES.has(input.source) ? input.source : 'auto';
    // Efficiency of THIS run (lower = better). Used to keep the BEST recipe.
    const steps = Number.isFinite(input.steps) ? input.steps : null;

    let embedRec = null;
    let dropped = [];
    const result = await mutateUser(userId, (list) => {
        const variants = list.filter((m) => m.userId === userId && m.type === 'procedure' && m.activity === activity);
        // Pick the variant this recipe belongs to: closest by topic overlap.
        let target = null, bestRatio = -1;
        for (const v of variants) {
            const { ratio, inter } = topicOverlap(v.keywords || [], keywords);
            const effective = (inter >= 2) ? ratio : 0;
            if (effective > bestRatio) { bestRatio = effective; target = v; }
        }
        const isNewVariant = !target
            || (bestRatio < VARIANT_MATCH_RATIO && variants.length < MAX_ACTIVITY_VARIANTS);
        if (!isNewVariant && target) {
            target.count = (target.count || 1) + 1;
            let mergedImpact = (IMPACT_RANK[reqImpact] || 2) >= (IMPACT_RANK[target.impact] || 2) ? reqImpact : target.impact;
            // A well-practiced activity (reinforced ≥3×) is a core skill — promote
            // it to 'important' so it's almost always surfaced as persona.
            if (target.count >= 3 && (IMPACT_RANK[mergedImpact] || 2) < IMPACT_RANK.important) mergedImpact = 'important';
            target.impact = mergedImpact;
            target.score = scoreForImpact(mergedImpact);
            // Keep the BEST recipe — don't let a mediocre later run degrade it.
            //  • A model-authored recipe (the model's own articulated lesson) is
            //    authoritative and is only overwritten by another model write.
            //  • An auto-observed recipe is replaced only by a strictly-or-equally
            //    EFFICIENT later run (fewer/equal successful tool steps).
            const existingFromModel = target.textSource === 'model';
            let updateText = false;
            if (source === 'model') updateText = true;
            else if (!existingFromModel) {
                updateText = (steps == null || target.bestSteps == null || steps <= target.bestSteps);
            }
            if (updateText && text.trim()) {
                target.text = text;
                if (keywords.length) target.keywords = keywords;
                target.tokens = tokens;
                target.textSource = source;
                target.title = deriveMemoryTitle(target);
            }
            if (steps != null) target.bestSteps = (target.bestSteps == null) ? steps : Math.min(target.bestSteps, steps);
            target.updatedAt = nowIso();
            if (updateText) embedRec = { ...target };
            return { id: target.id, updated: true, count: target.count, impact: mergedImpact, keptRecipe: !updateText, variant: variants.indexOf(target) };
        }
        const rec = normalizeRecord({
            userId, text, keywords, tokens,
            score: scoreForImpact(reqImpact),
            source, type: 'procedure', impact: reqImpact,
            activity, count: 1,
            sourceConvId: input.sourceConvId || null,
        });
        rec.textSource = source;
        rec.bestSteps = steps;
        list.push(rec);
        dropped = pruneUser(list, userId);
        embedRec = rec;
        return { id: rec.id, updated: false, count: 1, impact: rec.impact, variant: variants.length };
    });
    if (embedRec) memoryIndex.upsert(userId, embedRec).catch(() => {});
    if (dropped.length) memoryIndex.removeMany(userId, dropped).catch(() => {});
    return result;
}

// --------------------------------------------------------------------------
// Per-conversation extraction cursors (memory-cursors.json)
// --------------------------------------------------------------------------

let cursorChain = Promise.resolve();

async function readCursors() {
    try {
        const parsed = JSON.parse(await fsp.readFile(CURSOR_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
    }
}

async function getCursor(userId, convId) {
    const all = await readCursors();
    return all[userId]?.[convId] || null;
}

function setCursor(userId, convId, msgId) {
    const next = cursorChain.then(async () => {
        const all = await readCursors();
        if (!all[userId]) all[userId] = {};
        all[userId][convId] = msgId;
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(CURSOR_FILE, JSON.stringify(all, null, 2));
    });
    cursorChain = next.catch(() => {});
    return next;
}

// --------------------------------------------------------------------------
// One-time legacy migration (per-conversation dirs → account store)
// --------------------------------------------------------------------------

async function readMigrated() {
    try {
        const parsed = JSON.parse(await fsp.readFile(MIGRATED_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
    }
}

// Serialize the migrated-marker read-modify-write (mirrors cursorChain) so two
// users' markMigrated calls — or a retry — can't clobber each other's marker.
let migratedChain = Promise.resolve();
function markMigrated(userId) {
    const next = migratedChain.then(async () => {
        const all = await readMigrated();
        all[userId] = nowIso();
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(MIGRATED_FILE, JSON.stringify(all, null, 2));
    });
    migratedChain = next.catch(() => {});
    return next;
}

// Per-user in-process lock: extractNewMemoriesFromSave fire-and-forgets
// migrateLegacyForUser on EVERY save, so two near-simultaneous saves would both
// see no marker and both run the migration (double work; racing cursor seeds).
// Collapse concurrent calls for the same user onto one shared promise.
const migrationInFlight = new Map();

/**
 * Migrate one user's legacy per-conversation memories into the account store.
 * Idempotent: a per-user marker in memory-migrated.json prevents re-import, and
 * concurrent calls for the same user share one run (migrationInFlight lock).
 * Walks CONVERSATIONS_DIR/<userId>/memory/<convId>/{index.json,<id>.mem},
 * decodes each entry, dedups account-wide, and seeds extraction cursors so the
 * extractor won't re-process already-extracted turns. Legacy dirs are left in
 * place (rollback safety). Returns { migrated, imported }.
 */
function migrateLegacyForUser(userId) {
    const existing = migrationInFlight.get(userId);
    if (existing) return existing;
    const run = (async () => {
        try { return await migrateLegacyForUserImpl(userId); }
        finally { migrationInFlight.delete(userId); }
    })();
    migrationInFlight.set(userId, run);
    return run;
}

async function migrateLegacyForUserImpl(userId) {
    const migrated = await readMigrated();
    if (migrated[userId]) return { migrated: false, imported: 0 };

    const memRoot = path.join(CONVERSATIONS_DIR, userId, 'memory');
    let convDirs = [];
    try {
        convDirs = (await fsp.readdir(memRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch (e) {
        if (e.code === 'ENOENT') { await markMigrated(userId); return { migrated: true, imported: 0 }; }
        throw e;
    }

    const candidates = [];
    const cursorSeeds = {}; // convId -> cursor msgId
    for (const convId of convDirs) {
        if (!/^[a-zA-Z0-9_-]+$/.test(convId)) continue;
        const dir = path.join(memRoot, convId);
        let index = null;
        try {
            index = decodeMaybeBase64(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'), null);
        } catch (_) { /* no index — fall back to scanning .mem files */ }
        if (index?.cursor) cursorSeeds[convId] = index.cursor;

        const ids = Array.isArray(index?.entries)
            ? index.entries.map((e) => e.id)
            : (await fsp.readdir(dir).catch(() => []))
                .filter((f) => f.endsWith('.mem'))
                .map((f) => f.slice(0, -4));

        for (const memId of ids) {
            if (!/^[a-zA-Z0-9_-]+$/.test(memId)) continue;
            let full = null;
            try {
                full = decodeMaybeBase64(await fsp.readFile(path.join(dir, `${memId}.mem`), 'utf8'), null);
            } catch (_) { continue; }
            if (!full || !full.text) continue;
            const meta = (index?.entries || []).find((e) => e.id === memId) || {};
            candidates.push({
                text: full.text,
                keywords: full.keywords || meta.keywords || [],
                tokens: full.tokens || meta.tokens || estimateTokens(full.text),
                score: meta.score ?? full.score ?? 0,
                sourceRole: full.sourceRole || 'assistant',
                sourceConvId: convId,
                sourceTurnId: full.sourceTurnId || null,
                createdAt: full.ts || meta.ts || nowIso(),
            });
        }
    }

    // Import deduped (account-wide), preserving original createdAt.
    let imported = 0;
    const importedRecs = [];
    if (candidates.length) {
        await mutateUser(userId, (list) => {
            const acceptedKeywords = list.map((m) => m.keywords || []);
            for (const c of candidates) {
                const kw = Array.isArray(c.keywords) ? c.keywords : [];
                const dup = kw.length && acceptedKeywords.some((k) => jaccardSimilarity(k, kw) >= DEDUP_THRESHOLD);
                if (dup) continue;
                const rec = normalizeRecord({
                    userId,
                    text: c.text,
                    keywords: kw,
                    tokens: c.tokens,
                    score: c.score,
                    source: 'auto',
                    type: 'fact',
                    sourceRole: c.sourceRole,
                    sourceConvId: c.sourceConvId,
                    sourceTurnId: c.sourceTurnId,
                    createdAt: c.createdAt,
                    updatedAt: c.createdAt,
                });
                list.push(rec);
                acceptedKeywords.push(kw);
                importedRecs.push(rec);
                imported++;
            }
            if (imported) pruneUser(list, userId);
        });
    }
    for (const rec of importedRecs) memoryIndex.upsert(userId, rec).catch(() => {});
    // Seed cursors so the extractor skips already-processed turns. Best-effort:
    // a transient cursor-write failure must NOT abort the migration before
    // markMigrated, or the next save re-runs the whole import (deduped, but
    // wasteful). Worst case of a missed seed is the extractor re-checking a few
    // old turns, which dedup absorbs.
    for (const [convId, msgId] of Object.entries(cursorSeeds)) {
        try { await setCursor(userId, convId, msgId); }
        catch (e) { log(`cursor seed failed for ${userId}/${convId}: ${e.message}`); }
    }
    await markMigrated(userId);
    if (imported) log(`migrated ${imported} legacy memories for user ${userId} (${convDirs.length} conversations)`);
    return { migrated: true, imported };
}

module.exports = {
    // CRUD
    listMemories,
    getMemory,
    createMemory,
    updateMemory,
    deleteMemory,
    clearMemories,
    addAutoMemories,
    upsertModelLearning,
    upsertActivityMemory,
    normalizeActivity,
    deriveMemoryTitle,
    countForUser,
    reindexUser,
    // cursors
    getCursor,
    setCursor,
    // migration
    migrateLegacyForUser,
    // helpers / constants exposed for callers/tests
    jaccardSimilarity,
    topicOverlap,
    userIdSafe,
    estimateTokens,
    ACCOUNT_MEMORY_MAX,
    MEMORY_TEXT_MAX,
    VALID_TYPES,
    VALID_IMPACTS,
};
