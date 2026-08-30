/**
 * Memory embedding index — semantic retrieval for account memories.
 *
 * Rides the resident embedding_engine.py process (via embeddingEngine.call): model2vec potion-retrieval-32M,
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
 * created and owned by the engine.
 */

const path = require('path');
const fsp = require('fs/promises');
const embeddingEngine = require('./embeddingEngine');

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

// EXPERIENCES live in their own index namespace (a subdirectory of the user's
// index dir, so a clear/reindex still covers both). Reason: the engine's `k` is
// over CHUNKS, not documents, and an experience is embedded as up to 12 short
// phrasings. In one shared index a handful of experiences plus a normal pile of
// auto-facts push the RIGHT experience's best chunk past the top-k cut, and it
// silently never surfaces — recall degrades exactly as the store grows, which is
// when experience is worth the most. Two small searches cost ~a millisecond each
// and give experiences their own top-k.
function expIndexDirFor(userId) {
    return path.join(indexDirFor(userId), '_experience');
}

/** An EXPERIENCE record (episodic playbook), as opposed to a fact/directive. */
function isExperienceRec(rec) {
    return !!(rec && rec.type === 'procedure' && rec.task);
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

/** Chunks to embed for a record. An EXPERIENCE (procedure with a `task`) is
 *  embedded as several SHORT phrasings — the verbatim ask, a generalized task
 *  line, the task kind, later variants — because the engine keeps the best
 *  chunk score per doc and the static embedding matches short↔short far
 *  better than a long playbook against a short ask (measured: 0.12 vs 0.49
 *  for the same pair). Everything else embeds its text once. */
function embedChunksOf(rec) {
    if (rec && rec.type === 'procedure' && rec.task) {
        try {
            const chunks = require('./experienceMemory').phrasingsFor(rec);
            if (chunks.length) return chunks;
        } catch (_) { /* fall through */ }
    }
    return [embedTextOf(rec)];
}

/** Embed/re-embed one memory. Best-effort; returns true on success. */
async function upsert(userId, rec) {
    if (!rec || !rec.id || !String(rec.text || '').trim()) return false;
    const main = indexDirFor(userId);
    const exp = expIndexDirFor(userId);
    const indexDir = isExperienceRec(rec) ? exp : main;
    const other = isExperienceRec(rec) ? main : exp;
    try {
        // Delete from BOTH namespaces first: a record that changed shape (a
        // lesson-seeded procedure that later gains a task, a legacy row) must
        // never leave a stale vector behind in the namespace it left.
        await embeddingEngine.call('/delete_doc', { indexDir, docId: rec.id });
        try { await embeddingEngine.call('/delete_doc', { indexDir: other, docId: rec.id }); } catch (_) { /* namespace may not exist yet */ }
        await embeddingEngine.call('/ingest', {
            indexDir, docId: rec.id, filename: '', chunks: embedChunksOf(rec),
        });
        return true;
    } catch (e) {
        // One retry: the engine respawns transparently on the next call, so a
        // write that lands while it is restarting would otherwise leave the
        // record in the JSON store but NOT in the index — permanently unfindable
        // by semantics, with nothing to detect it (the self-heal only fires when
        // the whole namespace is empty).
        try {
            // Full delete→ingest again: /ingest is a plain INSERT, so retrying it
            // alone after a failed delete would leave the old chunks in place
            // AND add new ones (a stale phrasing could then still win a search).
            await embeddingEngine.call('/delete_doc', { indexDir, docId: rec.id });
            await embeddingEngine.call('/ingest', {
                indexDir, docId: rec.id, filename: '', chunks: embedChunksOf(rec),
            });
            return true;
        } catch (_) { /* fall through */ }
        logFailure('upsert', e);
        return false;
    }
}

/** Remove one memory's vector. Best-effort. */
async function remove(userId, memId) {
    if (!memId) return false;
    try {
        await embeddingEngine.call('/delete_doc', { indexDir: indexDirFor(userId), docId: memId });
        try { await embeddingEngine.call('/delete_doc', { indexDir: expIndexDirFor(userId), docId: memId }); } catch (_) { /* may not exist */ }
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
    const kk = Math.min(50, Math.max(1, k));
    const scores = new Map();
    const take = (res) => {
        for (const r of ((res && res.results) || [])) {
            const prev = scores.get(r.docId);
            if (prev == null || r.score > prev) scores.set(r.docId, r.score);
        }
        return (res && res.total) || 0;
    };
    try {
        const main = await embeddingEngine.call('/search', {
            indexDir: indexDirFor(userId), query: q.slice(0, 2000), k: kk,
        });
        let total = take(main);
        let expTotal = 0;
        // Experiences get their own top-k so a growing pile of facts can never
        // crowd the right playbook out of the result set.
        try {
            const exp = await embeddingEngine.call('/search', {
                indexDir: expIndexDirFor(userId), query: q.slice(0, 2000), k: kk,
            });
            expTotal = take(exp);
            total += expTotal;
        } catch (_) { /* no experiences indexed yet */ }
        // expTotal lets the caller detect a store whose experiences predate the
        // split namespace (they still sit in the main index) and self-heal with
        // a reindex, exactly like the empty-index case.
        return { scores, total, expTotal };
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
    isExperienceRec,
    expIndexDirFor,
    remove,
    removeMany,
    clearUser,
    search,
    reindexUser,
    embedTextOf,
    embedChunksOf,
    indexDirFor,
};
