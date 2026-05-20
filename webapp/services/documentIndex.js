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
    // First pass: dotted alphanumeric identifiers — section numbers
    // ("17.6.2"), version strings ("v1.2.3"), decimals, dotted filenames.
    // The word regex below shreds these into fragments and discards the
    // single-char pieces ("17.6.2" → just "17"), which made it impossible
    // to locate a heading by its section number via query_document. Keep
    // the whole dotted form as one distinctive (rare → high-IDF) token.
    // Requiring ≥2 dot-joined parts with no surrounding whitespace means a
    // sentence boundary like "end. Next" never merges across the period.
    const dotted = /[a-z0-9]+(?:\.[a-z0-9]+)+/g;
    let dm;
    while ((dm = dotted.exec(lower)) !== null) {
        const tok = dm[0];
        if (tok.length >= 3) out.push(tok);
    }
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

// List every indexed document in a user's attachment bucket, most-recent
// first. Cheap (one readdir + two small JSON reads per indexed dir) and
// only walked on the fallback path below, so correct calls don't pay for
// it.
async function listIndexes(userId) {
    const dir = path.join(attachmentStore.ROOT, attachmentStore.userIdSafe(userId));
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory() || !attachmentStore.isValidId(ent.name)) continue;
        try {
            const idx = JSON.parse(await fs.readFile(path.join(dir, ent.name, 'index.json'), 'utf8'));
            let filename = '';
            let conversationId = null;
            try {
                const meta = JSON.parse(await fs.readFile(path.join(dir, ent.name, 'meta.json'), 'utf8'));
                filename = meta?.filename || '';
                conversationId = meta?.conversationId || null;
            } catch (_) { /* meta optional */ }
            out.push({ id: ent.name, filename, conversationId, totalChunks: idx.totalChunks || 0, createdAt: idx.createdAt || 0 });
        } catch (_) { /* not an indexed document — skip */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
}

// Resolve a possibly-wrong documentId to a loadable index. Smaller local
// models routinely ignore the 32-hex handle in the user-message notice and
// pass the document's *name* instead (e.g. documentId="CyBOK") or an
// outright hallucinated hex string. Hard-failing leaves the model to
// fabricate an answer or — worse — wander onto a stale document from a
// previous turn. So:
//   1. If a document was indexed for THIS turn (`activeDocumentId`), force
//      every doc-tool call onto it. The user just uploaded it and is asking
//      about it; there is no other document a tool call this turn could
//      sanely mean, and this makes the model's id-copying ability moot.
//   2. Otherwise honour a valid, loadable requested id (a correct
//      cross-turn reference).
//   3. Otherwise fall back to the user's MOST RECENT indexed document —
//      the newest upload is what a follow-up question is almost always
//      about.
// Returns { id, index, resolvedFrom? } or { error }.
async function resolveIndex(userId, requestedId, activeDocumentId = null) {
    if (activeDocumentId && attachmentStore.isValidId(activeDocumentId)) {
        const index = await loadIndex(userId, activeDocumentId);
        if (index) {
            return activeDocumentId === requestedId
                ? { id: activeDocumentId, index }
                : { id: activeDocumentId, index, resolvedFrom: requestedId };
        }
    }
    if (attachmentStore.isValidId(requestedId)) {
        const index = await loadIndex(userId, requestedId);
        if (index) return { id: requestedId, index };
    }
    const list = await listIndexes(userId); // most-recent first
    if (list.length === 0) {
        return { error: `No indexed documents are available in this session for documentId "${requestedId}".` };
    }
    const index = await loadIndex(userId, list[0].id);
    if (index) return { id: list[0].id, index, resolvedFrom: requestedId };
    return {
        error: `documentId "${requestedId}" not found. Available documents: ` +
            list.map(d => `${d.id}${d.filename ? ` ("${d.filename}")` : ''}`).join('; ') +
            `. Retry with one of these exact documentIds.`,
    };
}

// ---------------------------------------------------------------------------
// Heading-aware boost
// ---------------------------------------------------------------------------
//
// Plain TF-IDF surfaces the table of contents for a bare section-number
// query ("17.6.2"): the TOC packs every section number + a leading-dot
// run + a page number into one dense chunk, which out-scores the chunk
// holding the actual "17.6.2 <Title>" heading and its body. For "what is
// section X" / "summarise section X" that's the wrong chunk. So when the
// query carries a section number, we locate the real heading line for it
// and float that chunk to the top.

// Pull dotted numeric section numbers ("17.6.2", "1.2") out of the query
// tokens. Pure-numeric only — we don't want "v1.2" or "node.js" here.
function extractSectionNumbers(qTokens) {
    const out = [];
    for (const t of qTokens) {
        if (/^\d+(?:\.\d+)+$/.test(t)) out.push(t);
    }
    return out;
}

// A table-of-contents line carries a leader-dot run (". . . ." or
// "......") — usually with a trailing page number. Real heading lines
// don't. This is what lets us tell "17.6.2 Title . . . 563" (TOC) from
// "17.6.2 Title" (heading).
function looksLikeTocLine(line) {
    return /\.{3,}|(?:\.\s+){2,}\./.test(line);
}

// Return the chunk index whose body contains `offset`, preferring the
// latest-starting chunk that still contains it (so the heading sits near
// that chunk's start and lands inside the returned snippet). Chunks are
// sorted by offset, so we can stop once a chunk starts past the offset.
function chunkForOffset(chunks, offset) {
    let best = -1;
    for (const ch of chunks) {
        if (ch.offset > offset) break;
        if (offset < ch.offset + ch.len) best = ch.i; // keep updating → latest match wins
    }
    return best;
}

// Find chunks that contain a *heading* (not a TOC entry) for any of the
// given section numbers. Returns Map<chunkIndex, headingCharOffset> so the
// caller can both boost the chunk and start its snippet at the heading.
function findHeadingChunks(text, sectionNumbers, chunks) {
    const result = new Map();
    for (const s of sectionNumbers) {
        const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Section number at the start of a line, followed by a separator
        // (so "17.6" does not match the heading "17.6.2 …"). With the `m`
        // flag, m.index is the line start.
        const re = new RegExp('^[ \\t>]*' + esc + '(?=[ \\t]|$)', 'gm');
        let m;
        while ((m = re.exec(text)) !== null) {
            let lineEnd = text.indexOf('\n', m.index);
            if (lineEnd === -1) lineEnd = text.length;
            const line = text.slice(m.index, lineEnd);
            if (looksLikeTocLine(line)) continue; // skip TOC rows
            const ci = chunkForOffset(chunks, m.index);
            if (ci >= 0 && !result.has(ci)) result.set(ci, m.index);
        }
    }
    return result;
}

// Bonus added to a heading chunk's cosine score. Cosine maxes at 1, so a
// bonus of 1 guarantees heading chunks rank above any non-heading match
// while preserving TF-IDF order among themselves and below them.
const HEADING_MATCH_BONUS = 1;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// TF-IDF cosine ranking over chunks given a query. Returns top-K with
// chunk text materialised from the on-disk file. Each result text is
// truncated to `snippetChars` to keep tool replies bounded.
async function queryDocument(userId, attachmentId, query, {
    topK = 3,
    snippetChars = 1500,
    activeDocumentId = null,
} = {}) {
    const resolved = await resolveIndex(userId, attachmentId, activeDocumentId);
    if (resolved.error) return { error: resolved.error };
    const { index, id: realId, resolvedFrom } = resolved;
    const text = await loadText(userId, realId);
    if (text === null) return { error: `No content for documentId "${realId}".` };

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

    // Heading-aware boost: if the query names a section number, float the
    // chunk holding its real heading above the TOC chunk that would
    // otherwise win. A heading chunk may have been pruned from `scored`
    // (its lone section-number token trimmed from the chunk's top-N TF),
    // so add any missing ones too.
    const sectionNumbers = extractSectionNumbers(qTokens);
    if (sectionNumbers.length) {
        const headingChunks = findHeadingChunks(text, sectionNumbers, index.chunks);
        if (headingChunks.size) {
            const byIndex = new Map(scored.map(s => [s.chunkIndex, s]));
            for (const [ci, headingOffset] of headingChunks) {
                const existing = byIndex.get(ci);
                if (existing) {
                    existing.score += HEADING_MATCH_BONUS;
                    existing.headingOffset = headingOffset;
                } else {
                    const ch = index.chunks[ci];
                    if (ch) scored.push({ chunkIndex: ci, score: HEADING_MATCH_BONUS, ch, headingOffset });
                }
            }
        }
    }

    scored.sort((a, b) => b.score - a.score);

    const k = Math.max(1, Math.min(topK, 10));
    const out = scored.slice(0, k).map(({ chunkIndex, score, ch, headingOffset }) => {
        // For a heading-boosted chunk, start the snippet at the heading so
        // the section title is the first thing the model sees (the heading
        // can sit deep in the chunk). Otherwise start at the chunk top.
        const start = (headingOffset != null && headingOffset >= ch.offset && headingOffset < ch.offset + ch.len)
            ? headingOffset : ch.offset;
        const slice = text.slice(start, ch.offset + ch.len);
        const snippet = slice.length > snippetChars
            ? slice.slice(0, snippetChars) + '\n…[truncated for relevance return — call read_document_chunk to read this chunk in full]'
            : slice;
        let lineStart = ch.lineStart;
        if (start !== ch.offset) {
            let nl = 0;
            for (let i = ch.offset; i < start; i++) if (text.charCodeAt(i) === 10) nl++;
            lineStart += nl;
        }
        return {
            chunkIndex,
            score: Number(score.toFixed(4)),
            lineRange: `${lineStart}-${ch.lineEnd}`,
            text: snippet,
        };
    });

    return {
        documentId: realId,
        ...(resolvedFrom && resolvedFrom !== realId
            ? { note: `Resolved documentId from "${resolvedFrom}" to ${realId}; use ${realId} in any follow-up calls.` }
            : {}),
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
    activeDocumentId = null,
} = {}) {
    const resolved = await resolveIndex(userId, attachmentId, activeDocumentId);
    if (resolved.error) return { error: resolved.error };
    const { index, id: realId, resolvedFrom } = resolved;
    const text = await loadText(userId, realId);
    if (text === null) return { error: `No content for documentId "${realId}".` };

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
        documentId: realId,
        ...(resolvedFrom && resolvedFrom !== realId
            ? { note: `Resolved documentId from "${resolvedFrom}" to ${realId}; use ${realId} in any follow-up calls.` }
            : {}),
        totalChunks: N,
        nextChunkIndex: out.length ? (out[out.length - 1].chunkIndex + 1) : start,
        chunks: out,
    };
}

module.exports = {
    saveAndIndex,
    loadIndex,
    loadText,
    listIndexes,
    resolveIndex,
    queryDocument,
    readChunk,
    INDEX_VERSION,
    DEFAULT_CHUNK_CHARS,
    DEFAULT_OVERLAP_CHARS,
};
