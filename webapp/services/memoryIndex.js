/**
 * Memory embedding index — semantic retrieval for account memories.
 *
 * Rides the SAME resident kb_engine.py process the Knowledge Base feature
 * owns (via knowledgeBaseService.engineCall): model2vec potion-retrieval-32M,
 * 512-d, pure-CPU, already baked into the image. One memory = one engine
 * "document" with a single chunk, docId = the memory id, so:
 *   upsert  = delete_doc + ingest        (idempotent re-embed)
 *   search  = /search → docId + cosine   (the relevance signal retrieval uses)
 *
 * Why embeddings here: memory retrieval historically gated on keyword overlap
 * (factKeywordMatch), which can't see paraphrase — a memory keyed on
 * "render_chart, visualization" never surfaced for "can you graph this". The
 * semantic score replaces that whole heuristic stack; keywords remain only as
 * the fallback when the engine is unavailable.
 *
 * EVERY function here is best-effort and non-fatal: memory must keep working
 * (keyword mode) when the engine is down. Failures log once per burst and
 * return null/false — callers treat null as "no semantic signal".
 *
 * Storage: /models/.modelserver/memory-index/<userIdSafe>/index.sqlite,
 * created and owned by the engine (same layout as a KB dir).
 */

const path = require('path');
const fsp = require('fs/promises');
const kbService = require('./knowledgeBaseService');

const DATA_DIR = '/models/.modelserver';
const MEM_INDEX_ROOT = path.join(DATA_DIR, 'memory-index');

// How much of a memory's text we embed. Memories cap at 2000 chars and the
// engine embeds whole chunks, so this is just a safety clamp.
const EMBED_TEXT_MAX = 4000;

function log(...a) { console.log('[memIndex]', ...a); }

// Throttle failure logging — a down engine would otherwise spam every turn.
let lastFailLogAt = 0;
function logFailure(op, e) {
    if (Date.now() - lastFailLogAt > 60000) {
        lastFailLogAt = Date.now();
        log(`${op} failed (semantic memory degraded to keyword mode): ${e.message}`);
    }
}

function userIdSafe(userId) {
    return String(userId == null ? 'global' : userId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function indexDirFor(userId) {
    return path.join(MEM_INDEX_ROOT, userIdSafe(userId));
}

/** Text we embed for a record: procedures lead with their activity so the
 * recipe's domain is part of the vector; everything else embeds its text. */
function embedTextOf(rec) {
    const base = String(rec.text || '').slice(0, EMBED_TEXT_MAX);
    if (rec.type === 'procedure' && rec.activity) {
        return `${String(rec.activity).replace(/-/g, ' ')}: ${base}`;
    }
    return base;
}

/** Embed/re-embed one memory. Best-effort; returns true on success. */
async function upsert(userId, rec) {
    if (!rec || !rec.id || !String(rec.text || '').trim()) return false;
    const kbDir = indexDirFor(userId);
    try {
        await kbService.engineCall('/delete_doc', { kbDir, docId: rec.id });
        await kbService.engineCall('/ingest', {
            kbDir, docId: rec.id, filename: '', chunks: [embedTextOf(rec)],
        });
        return true;
    } catch (e) {
        logFailure('upsert', e);
        return false;
    }
}

/** Remove one memory's vector. Best-effort. */
async function remove(userId, memId) {
    if (!memId) return false;
    try {
        await kbService.engineCall('/delete_doc', { kbDir: indexDirFor(userId), docId: memId });
        return true;
    } catch (e) {
        logFailure('remove', e);
        return false;
    }
}

/** Remove several vectors (pruned/dropped ids). Best-effort, sequential. */
async function removeMany(userId, ids) {
    for (const id of (ids || [])) await remove(userId, id);
}

/** Drop a user's whole index (clear-all). The dir delete is authoritative —
 * the engine's matrix cache invalidates on file mtime, so a recreated index
 * never serves stale vectors. */
async function clearUser(userId) {
    try {
        await fsp.rm(indexDirFor(userId), { recursive: true, force: true });
        return true;
    } catch (e) {
        logFailure('clearUser', e);
        return false;
    }
}

/**
 * Semantic search over a user's memories.
 * Returns { scores: Map(memId → bestCosine), total } or null when the engine
 * is unavailable (caller falls back to keyword matching). `total` lets the
 * caller detect an EMPTY index while memories exist → trigger a reindex.
 */
async function search(userId, query, k = 32) {
    const q = String(query || '').trim();
    if (!q) return null;
    try {
        const res = await kbService.engineCall('/search', {
            kbDir: indexDirFor(userId), query: q.slice(0, 2000), k: Math.min(50, Math.max(1, k)),
        });
        const scores = new Map();
        for (const r of (res.results || [])) {
            const prev = scores.get(r.docId);
            if (prev == null || r.score > prev) scores.set(r.docId, r.score);
        }
        return { scores, total: res.total || 0 };
    } catch (e) {
        logFailure('search', e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Full reindex — wipe + re-embed every memory for a user. Used to backfill
// existing stores (first run after this feature ships) and to self-heal when
// retrieval sees an empty index for a user who has memories. Per-user
// in-flight collapse so concurrent triggers don't double-build.
// ---------------------------------------------------------------------------

const reindexInFlight = new Map();

function reindexUser(userId, memories) {
    const key = userIdSafe(userId);
    const existing = reindexInFlight.get(key);
    if (existing) return existing;
    const run = (async () => {
        try {
            await fsp.rm(indexDirFor(userId), { recursive: true, force: true });
            let ok = 0;
            for (const rec of (memories || [])) {
                if (await upsert(userId, rec)) ok++;
            }
            log(`reindexed ${ok}/${(memories || []).length} memories for ${key}`);
            return ok;
        } catch (e) {
            logFailure('reindex', e);
            return 0;
        } finally {
            reindexInFlight.delete(key);
        }
    })();
    reindexInFlight.set(key, run);
    return run;
}

module.exports = {
    upsert,
    remove,
    removeMany,
    clearUser,
    search,
    reindexUser,
    embedTextOf,
    indexDirFor,
};
