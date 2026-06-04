/**
 * Memory service — account-scoped persona/fact memory for the chat model.
 *
 * This replaces the old per-CONVERSATION memory store: memories now belong to
 * the ACCOUNT (userId) so they follow the user across every conversation. The
 * design intentionally mirrors knowledgeBaseService.js — a single owner-tagged
 * metadata file plus a write-serializer — so ownership/admin routing and the
 * webapp Memory tab can reuse the exact Knowledge Base patterns.
 *
 * Responsibilities (STORAGE only — the heuristics that PRODUCE memories, i.e.
 * factuality scoring / shorthand / sentence splitting / keyword extraction,
 * stay in server.js where they already live):
 *   - own memories.json: list / get / create / update / delete records, each
 *     tagged with its owner userId.
 *   - account-wide dedup + prune so a user's set stays bounded.
 *   - per-conversation extraction cursors (which assistant message we last
 *     processed) so re-saves don't re-extract the same turns.
 *   - one-time migration of the legacy per-conversation memory directories
 *     into the account store.
 *
 * Records (one per memory):
 *   { id, userId, text, keywords[], tokens, score,
 *     source: 'auto'|'manual'|'model',
 *     type:  null|'feedback'|'issue'|'preference'|'workaround'|'correction'|'limitation'|'learning'|'fact',
 *     impact: null|'important'|'medium'|'low',     // model learnings
 *     sourceRole: 'user'|'assistant'|null,
 *     sourceConvId, sourceTurnId,
 *     createdAt, updatedAt }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = '/models/.modelserver';
const MEMORY_META_FILE = path.join(DATA_DIR, 'memories.json');
const CURSOR_FILE = path.join(DATA_DIR, 'memory-cursors.json');
const MIGRATED_FILE = path.join(DATA_DIR, 'memory-migrated.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

// Per-account cap. The old store capped at 200 PER CONVERSATION; an account
// spans many conversations, so the budget is larger. When exceeded we drop the
// lowest-score, oldest entries first (model 'important' learnings are floored
// so they survive pruning — they shape the persona).
const ACCOUNT_MEMORY_MAX = 2000;
const MEMORY_TEXT_MAX = 2000;
// Account-wide dedup threshold on keyword Jaccard overlap.
const DEDUP_THRESHOLD = 0.75;

const VALID_SOURCES = new Set(['auto', 'manual', 'model']);
const VALID_TYPES = new Set([
    'feedback', 'issue', 'preference', 'workaround', 'correction', 'limitation', 'learning', 'fact',
]);
const VALID_IMPACTS = new Set(['important', 'medium', 'low']);

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

// Decode a possibly base64-wrapped JSON blob (legacy .mem files) — mirrors
// server.js decodeConversationData so migration can read old memories.
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
// Metadata file (memories.json) — serialized read-modify-write
// --------------------------------------------------------------------------

let writeChain = Promise.resolve();

async function readMeta() {
    try {
        const parsed = JSON.parse(await fsp.readFile(MEMORY_META_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

/** Serialize read-modify-write so concurrent saves don't clobber the file. */
function mutateMeta(fn) {
    const next = writeChain.then(async () => {
        const list = await readMeta();
        const result = await fn(list);
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(MEMORY_META_FILE, JSON.stringify(list, null, 2));
        return result;
    });
    writeChain = next.catch(() => {});
    return next;
}

// --------------------------------------------------------------------------
// CRUD
// --------------------------------------------------------------------------

async function listMemories(userId, { all = false } = {}) {
    const list = await readMeta();
    if (all) return list;
    return list.filter((m) => m.userId === userId);
}

async function getMemory(id) {
    const list = await readMeta();
    return list.find((m) => m.id === id) || null;
}

function normalizeRecord(input) {
    const text = String(input.text || '').slice(0, MEMORY_TEXT_MAX);
    const source = VALID_SOURCES.has(input.source) ? input.source : 'manual';
    const type = input.type && VALID_TYPES.has(input.type) ? input.type : null;
    const impact = input.impact && VALID_IMPACTS.has(input.impact) ? input.impact : null;
    return {
        id: input.id || crypto.randomUUID(),
        userId: input.userId ?? null,
        text,
        keywords: Array.isArray(input.keywords) ? input.keywords.slice(0, 40) : [],
        tokens: Number.isFinite(input.tokens) ? input.tokens : estimateTokens(text),
        score: Number.isFinite(input.score) ? input.score : 0,
        source,
        type,
        impact,
        sourceRole: input.sourceRole || null,
        sourceConvId: input.sourceConvId || null,
        sourceTurnId: input.sourceTurnId || null,
        createdAt: input.createdAt || nowIso(),
        updatedAt: input.updatedAt || nowIso(),
    };
}

/** Create one memory (manual add or a model learning). Returns the record. */
async function createMemory(input) {
    const rec = normalizeRecord(input);
    if (!rec.text.trim()) throw new Error('memory text is required');
    await mutateMeta((list) => {
        list.push(rec);
        pruneUser(list, rec.userId);
    });
    return rec;
}

async function updateMemory(id, patch) {
    return mutateMeta((list) => {
        const m = list.find((x) => x.id === id);
        if (!m) return null;
        if (patch.text != null) m.text = String(patch.text).slice(0, MEMORY_TEXT_MAX);
        if (Array.isArray(patch.keywords)) m.keywords = patch.keywords.slice(0, 40);
        if (Number.isFinite(patch.tokens)) m.tokens = patch.tokens;
        if (Number.isFinite(patch.score)) m.score = patch.score;
        if (patch.type !== undefined) m.type = patch.type && VALID_TYPES.has(patch.type) ? patch.type : null;
        if (patch.impact !== undefined) m.impact = patch.impact && VALID_IMPACTS.has(patch.impact) ? patch.impact : null;
        m.updatedAt = nowIso();
        return { ...m };
    });
}

async function deleteMemory(id) {
    return mutateMeta((list) => {
        const i = list.findIndex((m) => m.id === id);
        if (i < 0) return false;
        list.splice(i, 1);
        return true;
    });
}

/** Remove all memories for a user (used by the "clear all" route). */
async function clearMemories(userId) {
    return mutateMeta((list) => {
        let removed = 0;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].userId === userId) { list.splice(i, 1); removed++; }
        }
        return removed;
    });
}

// In-place prune of one user's entries down to the cap. Drops lowest-score,
// oldest first; model 'important' learnings get a high synthetic score so they
// survive. Mutates `list` (called inside mutateMeta).
function pruneUser(list, userId) {
    const mine = [];
    for (let i = 0; i < list.length; i++) if (list[i].userId === userId) mine.push(i);
    if (mine.length <= ACCOUNT_MEMORY_MAX) return;
    const weight = (m) => (m.source === 'model' && m.impact === 'important')
        ? 1000 + (m.score || 0)
        : (m.score || 0);
    // Sort the user's indices by keep-priority (high first); the tail is dropped.
    mine.sort((ia, ib) => {
        const wa = weight(list[ia]); const wb = weight(list[ib]);
        if (wb !== wa) return wb - wa;
        // tie-break: newer kept over older
        return (list[ib].updatedAt || '').localeCompare(list[ia].updatedAt || '');
    });
    const dropIdx = new Set(mine.slice(ACCOUNT_MEMORY_MAX));
    // Rebuild list excluding dropped indices (descending splice to keep indices valid).
    const toDrop = [...dropIdx].sort((a, b) => b - a);
    for (const i of toDrop) list.splice(i, 1);
}

/**
 * Bulk-add auto-extracted memory candidates for a user, deduping account-wide
 * against existing entries (and within the batch) by keyword overlap. Each
 * candidate: { text, keywords, tokens, score, sourceRole, sourceTurnId,
 * sourceConvId }. Returns { added }.
 */
async function addAutoMemories(userId, candidates, { sourceConvId = null } = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return { added: 0 };
    let added = 0;
    await mutateMeta((list) => {
        const mine = list.filter((m) => m.userId === userId);
        const acceptedKeywords = mine.map((m) => m.keywords || []);
        for (const c of candidates) {
            const kw = Array.isArray(c.keywords) ? c.keywords : [];
            if (!kw.length) continue;
            const dup = acceptedKeywords.some((k) => jaccardSimilarity(k, kw) >= DEDUP_THRESHOLD);
            if (dup) continue;
            const rec = normalizeRecord({
                userId,
                text: c.text,
                keywords: kw,
                tokens: c.tokens,
                score: c.score,
                source: 'auto',
                // Heuristic classification from the extractor (server.js
                // classifyMemoryHeuristic). Falls back to a plain fact so a
                // caller that doesn't classify still works.
                type: c.type || 'fact',
                impact: c.impact || null,
                sourceRole: c.sourceRole || null,
                sourceConvId: c.sourceConvId || sourceConvId,
                sourceTurnId: c.sourceTurnId || null,
            });
            list.push(rec);
            acceptedKeywords.push(kw);
            added++;
        }
        if (added) pruneUser(list, userId);
    });
    return { added };
}

async function countForUser(userId) {
    const list = await readMeta();
    return list.reduce((n, m) => n + (m.userId === userId ? 1 : 0), 0);
}

const IMPACT_RANK = { important: 3, medium: 2, low: 1 };
function scoreForImpact(impact) {
    return impact === 'important' ? 7 : (impact === 'low' ? 3 : 5);
}

/**
 * Record a MODEL learning, but CONSOLIDATE instead of blindly appending — this
 * is what makes account memory a continual-learning store rather than an
 * ever-growing pile of near-duplicates. The whole read-modify-write runs inside
 * mutateMeta so the find-target + update/create is atomic (no lost-update race).
 *
 * Target selection (a memory to REFINE in place):
 *   1. `opts.replaces` — an explicit [#handle] the model surfaced from its
 *      injected context. May target ANY of THIS user's memories (incl. ones the
 *      user authored manually) — a deliberate, model-driven edit.
 *   2. otherwise auto-detect the closest existing MODEL learning by keyword
 *      Jaccard ≥ autoMergeThreshold. Auto-merge NEVER touches a manual memory —
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

    return mutateMeta((list) => {
        const mine = list.filter((m) => m.userId === userId);
        let target = null;
        const handle = String(replaces || '').replace(/^#/, '').trim().toLowerCase();
        if (handle) {
            target = mine.find((m) => {
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
            for (const m of mine) {
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
            target.updatedAt = nowIso();
            return { id: target.id, updated: true, impact: mergedImpact };
        }

        const rec = normalizeRecord({
            userId, text, keywords, tokens,
            score: scoreForImpact(reqImpact),
            source: 'model', type: reqType, impact: reqImpact,
            sourceConvId: input.sourceConvId || null,
        });
        list.push(rec);
        pruneUser(list, userId);
        return { id: rec.id, updated: false, impact: rec.impact };
    });
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
    if (candidates.length) {
        await mutateMeta((list) => {
            const acceptedKeywords = list.filter((m) => m.userId === userId).map((m) => m.keywords || []);
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
                imported++;
            }
            if (imported) pruneUser(list, userId);
        });
    }
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
    countForUser,
    // cursors
    getCursor,
    setCursor,
    // migration
    migrateLegacyForUser,
    // helpers / constants exposed for callers/tests
    jaccardSimilarity,
    userIdSafe,
    estimateTokens,
    ACCOUNT_MEMORY_MAX,
    MEMORY_TEXT_MAX,
    VALID_TYPES,
    VALID_IMPACTS,
};
