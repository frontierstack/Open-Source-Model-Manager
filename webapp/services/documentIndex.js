// Document index for the agentic large-content flow.
//
// When chat input exceeds the model's context, we no longer feed it through
// a fixed map-reduce pipeline. Instead we stash the full text in the
// attachment store, build a lightweight TF-IDF index alongside it, and
// expose two native tools (`query_document`, `read_document_chunk`) that
// let the model walk the content inside its normal tool loop. This module
// owns the index format, the build pass, and the query/read helpers.
//
// Layout (alongside attachmentStore's <userIdSafe>/<aid>/):
//   file         — raw UTF-8 bytes (written by attachmentStore.save)
//   meta.json    — attachment metadata, with `documentIndex: true`
//   index.json   — this module's output (chunks + tf/df + line offsets)
//
// The chunk content itself is NEVER duplicated into index.json — chunks
// are byte-offset views over `file`, materialised on read. This keeps
// index.json small (~50–500 KB even for big documents) and avoids
// double-writing payloads that may be megabytes.
//
// Sizing knobs intentionally conservative: chunk size targets ~3.5K chars
// (~1K tokens) so a tool call returning 1–3 chunks fits comfortably in
// any realistic model context with room for the model's own response.
// Overlap of 200 chars preserves sentence boundaries across chunk seams
// without bloating storage.

const fs = require('fs').promises;
const path = require('path');
const attachmentStore = require('./attachmentStore');

const INDEX_VERSION = 1;
const DEFAULT_CHUNK_CHARS = 3500;
const DEFAULT_OVERLAP_CHARS = 200;
// Per-chunk cap on how many distinct terms we persist in the TF map.
// Documents with code or tabular data can produce thousands of unique
// tokens per chunk; trimming to the most-frequent N keeps index.json
// linear in chunk count rather than vocabulary size.
const MAX_TF_TERMS_PER_CHUNK = 120;
// Stop words excluded from TF/DF (English) — same set used by content
// condensation so the relevance scorer treats short-words consistently.
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'to', 'and', 'or',
    'but', 'if', 'so', 'than', 'then', 'this', 'that', 'these', 'those',
    'it', 'its', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them',
    'their', 'his', 'her', 'i', 'me', 'my',
]);

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

function tokenize(text) {
    // Lowercase, split on non-alphanumeric, drop short / stopword tokens.
    // Numbers preserved (often the most distinctive terms in technical docs).
    const out = [];
    const lower = text.toLowerCase();
    const re = /[a-z0-9_]{2,}/g;
    let m;
    while ((m = re.exec(lower)) !== null) {
        const tok = m[0];
        if (tok.length < 2) continue;
        if (STOP_WORDS.has(tok)) continue;
        out.push(tok);
    }
    return out;
}

// Trim a TF map to the top-N most frequent terms. Mutates none — returns
// a new object so the caller can safely write it to disk.
function topTerms(tfMap, limit) {
    const entries = Object.entries(tfMap);
    if (entries.length <= limit) return tfMap;
    entries.sort((a, b) => b[1] - a[1]);
    const out = {};
    for (let i = 0; i < limit; i++) out[entries[i][0]] = entries[i][1];
    return out;
}

// ---------------------------------------------------------------------------
// Chunk slicing
// ---------------------------------------------------------------------------
//
// Slice on character boundaries with a small grace zone that prefers a
// sentence/paragraph break within ±200 chars of the target boundary. This
// avoids cutting mid-word or mid-statement, which is what makes condensed
// chunks read naturally when the model sees them in a tool result.

function findGracefulBoundary(text, targetIdx, grace = 200) {
    const lo = Math.max(0, targetIdx - grace);
    const hi = Math.min(text.length, targetIdx + grace);
    // Prefer paragraph break, then sentence end, then line break.
    const slice = text.slice(lo, hi);
    const candidates = [
        /\n\s*\n/g,    // paragraph break
        /[.!?]\s+/g,   // sentence end
        /\n/g,         // line break
    ];
    for (const re of candidates) {
        let m;
        let bestOffset = -1;
        let bestDist = Infinity;
        re.lastIndex = 0;
        while ((m = re.exec(slice)) !== null) {
            const abs = lo + m.index + m[0].length;
            const dist = Math.abs(abs - targetIdx);
            if (dist < bestDist) {
                bestDist = dist;
                bestOffset = abs;
            }
        }
        if (bestOffset >= 0) return bestOffset;
    }
    return targetIdx;
}

function buildChunks(text, chunkChars, overlapChars) {
    const chunks = [];
    if (!text || !text.length) return chunks;
    let pos = 0;
    let i = 0;
    while (pos < text.length) {
        const targetEnd = Math.min(text.length, pos + chunkChars);
        const end = targetEnd >= text.length
            ? text.length
            : findGracefulBoundary(text, targetEnd, 200);
        chunks.push({ i, offset: pos, len: end - pos });
        i++;
        if (end >= text.length) break;
        pos = Math.max(pos + 1, end - overlapChars);
    }
    return chunks;
}

// ---------------------------------------------------------------------------
// Line-range computation
// ---------------------------------------------------------------------------
//
// One pass over the text to map every chunk's [offset, offset+len) range
// to a 1-indexed line range. Cheap (single linear walk over the buffer)
// and lets `read_document_chunk` results carry "lines 1234–1287" so the
// model's citations stay grounded.

function annotateLineRanges(text, chunks) {
    let line = 1;
    let charIdx = 0;
    let chunkIdx = 0;
    // For each chunk, find lineStart by walking until we pass chunk.offset,
    // then continue to find lineEnd at chunk.offset+chunk.len. Chunks are
    // monotonic in offset, so a single pass with a moving cursor suffices.
    for (const ch of chunks) {
        // Walk to chunk.offset, counting newlines.
        while (charIdx < ch.offset && charIdx < text.length) {
            if (text.charCodeAt(charIdx) === 10) line++;
            charIdx++;
        }
        ch.lineStart = line;
        const endTarget = ch.offset + ch.len;
        while (charIdx < endTarget && charIdx < text.length) {
            if (text.charCodeAt(charIdx) === 10) line++;
            charIdx++;
        }
        ch.lineEnd = line;
        chunkIdx++;
    }
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

// Save a large text body as an attachment + a sidecar TF-IDF index.
// Returns the attachmentId so the caller can hand it to the model.
async function saveAndIndex(userId, {
    text,
    filename = 'large-content.txt',
    mimeType = 'text/plain; charset=utf-8',
    conversationId = null,
    chunkChars = DEFAULT_CHUNK_CHARS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
} = {}) {
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('saveAndIndex: text is required');
    }
    const bytes = Buffer.from(text, 'utf8');
    const id = await attachmentStore.save(userId, {
        filename,
        mimeType,
        type: 'document',
        bytes,
        meta: {
            documentIndex: true,
            conversationId,
            charCount: text.length,
            indexedAt: Date.now(),
        },
    });
    const chunks = buildChunks(text, chunkChars, overlapChars);
    annotateLineRanges(text, chunks);

    // Per-chunk TF + document-wide DF in one pass.
    const df = Object.create(null);
    for (const ch of chunks) {
        const slice = text.slice(ch.offset, ch.offset + ch.len);
        const tokens = tokenize(slice);
        const tf = Object.create(null);
        for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
        for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
        ch.tf = topTerms(tf, MAX_TF_TERMS_PER_CHUNK);
        ch.preview = slice.slice(0, 200).replace(/\s+/g, ' ').trim();
    }

    const indexDoc = {
        version: INDEX_VERSION,
        createdAt: Date.now(),
        totalChunks: chunks.length,
        totalChars: text.length,
        chunkChars,
        overlapChars,
        chunks,
        df,
    };
    const dir = path.join(attachmentStore.ROOT, attachmentStore.userIdSafe(userId), id);
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(indexDoc), { mode: 0o600 });
    return { id, totalChunks: chunks.length, totalChars: text.length };
}

async function loadIndex(userId, attachmentId) {
    if (!attachmentStore.isValidId(attachmentId)) return null;
    const dir = path.join(attachmentStore.ROOT, attachmentStore.userIdSafe(userId), attachmentId);
    try {
        const txt = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
        return JSON.parse(txt);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[documentIndex] loadIndex failed:', e.message);
        return null;
    }
}

async function loadText(userId, attachmentId) {
    const loaded = await attachmentStore.loadBytes(userId, attachmentId);
    if (!loaded) return null;
    return loaded.bytes.toString('utf8');
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// TF-IDF cosine ranking over chunks given a query. Returns top-K with
// chunk text materialised from the on-disk file. Each result text is
// truncated to `snippetChars` to keep tool replies bounded.
async function queryDocument(userId, attachmentId, query, {
    topK = 3,
    snippetChars = 1500,
} = {}) {
    const index = await loadIndex(userId, attachmentId);
    if (!index) return { error: `No index for documentId "${attachmentId}".` };
    const text = await loadText(userId, attachmentId);
    if (text === null) return { error: `No content for documentId "${attachmentId}".` };

    const qTokens = tokenize(String(query || ''));
    if (!qTokens.length) {
        return { error: 'Query produced no usable terms (all stopwords or empty).' };
    }
    const qTf = Object.create(null);
    for (const t of qTokens) qTf[t] = (qTf[t] || 0) + 1;

    const N = index.totalChunks;
    const scored = [];
    for (const ch of index.chunks) {
        let score = 0;
        let qNorm = 0;
        let dNorm = 0;
        for (const t of Object.keys(qTf)) {
            const df = index.df[t] || 0;
            // Add-one smoothing on IDF so single-term queries against
            // common terms still rank, but documents that mention the
            // term in many chunks see proportional dampening.
            const idf = Math.log((N + 1) / (df + 1)) + 1;
            const qWeight = qTf[t] * idf;
            const dWeight = (ch.tf[t] || 0) * idf;
            score += qWeight * dWeight;
            qNorm += qWeight * qWeight;
        }
        // Doc norm: full TF × IDF magnitude. Approximation since we
        // truncated each chunk's TF to the top-N terms — fine for
        // ranking, where the heavy-hitters dominate the magnitude.
        for (const t of Object.keys(ch.tf)) {
            const df = index.df[t] || 0;
            const idf = Math.log((N + 1) / (df + 1)) + 1;
            const dW = ch.tf[t] * idf;
            dNorm += dW * dW;
        }
        if (score > 0 && qNorm > 0 && dNorm > 0) {
            const cos = score / (Math.sqrt(qNorm) * Math.sqrt(dNorm));
            scored.push({ chunkIndex: ch.i, score: cos, ch });
        }
    }
    scored.sort((a, b) => b.score - a.score);

    const k = Math.max(1, Math.min(topK, 10));
    const out = scored.slice(0, k).map(({ chunkIndex, score, ch }) => {
        const slice = text.slice(ch.offset, ch.offset + ch.len);
        const snippet = slice.length > snippetChars
            ? slice.slice(0, snippetChars) + '\n…[truncated for relevance return — call read_document_chunk to read this chunk in full]'
            : slice;
        return {
            chunkIndex,
            score: Number(score.toFixed(4)),
            lineRange: `${ch.lineStart}-${ch.lineEnd}`,
            text: snippet,
        };
    });

    return {
        documentId: attachmentId,
        query: String(query),
        totalChunks: N,
        matches: out,
    };
}

// Sequential read of one or more chunks. `count` is capped to keep tool
// replies bounded; the model is expected to iterate via subsequent calls
// when it needs more.
async function readChunk(userId, attachmentId, chunkIndex, {
    count = 1,
    maxChars = 12000,
} = {}) {
    const index = await loadIndex(userId, attachmentId);
    if (!index) return { error: `No index for documentId "${attachmentId}".` };
    const text = await loadText(userId, attachmentId);
    if (text === null) return { error: `No content for documentId "${attachmentId}".` };

    const N = index.totalChunks;
    const start = Math.max(0, Math.min(parseInt(chunkIndex, 10) || 0, N - 1));
    const reqCount = Math.max(1, Math.min(parseInt(count, 10) || 1, 5));
    const end = Math.min(N, start + reqCount);

    const out = [];
    let combined = '';
    for (let i = start; i < end; i++) {
        const ch = index.chunks[i];
        if (!ch) break;
        const slice = text.slice(ch.offset, ch.offset + ch.len);
        if (combined.length + slice.length > maxChars && out.length > 0) {
            // Stop once we'd exceed maxChars to keep the tool reply bounded.
            // The model can call again with a higher chunkIndex if needed.
            break;
        }
        out.push({
            chunkIndex: i,
            lineRange: `${ch.lineStart}-${ch.lineEnd}`,
            text: slice,
        });
        combined += slice;
    }
    return {
        documentId: attachmentId,
        totalChunks: N,
        nextChunkIndex: out.length ? (out[out.length - 1].chunkIndex + 1) : start,
        chunks: out,
    };
}

module.exports = {
    saveAndIndex,
    loadIndex,
    loadText,
    queryDocument,
    readChunk,
    INDEX_VERSION,
    DEFAULT_CHUNK_CHARS,
    DEFAULT_OVERLAP_CHARS,
};
