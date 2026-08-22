/**
 * Recover the URL the model MEANT from the one it typed.
 *
 * Local models do not copy a URL — they REGENERATE it from meaning, so a slug
 * comes back paraphrased or mistyped: `14-trojanized-npm-packages-drop-redc2`
 * became `...-npm-registry-packs-...`, `...-npmpackages-...`, `...-pacakges-...`
 * and `...packagdrop...` across a single turn. Every mangle is a NEW string, so
 * the fingerprint-keyed loop guards never fire; the observed turn burned 17 web
 * calls over 262 s and never read the article the user had pasted verbatim.
 *
 * Same class as the archive-id (`_closestArchiveRef`), clone-dir
 * (`_auto_resolve_dir`) and workspace-path (`resolveMissingReadPaths`)
 * recoveries: match what was typed against the strings the model has actually
 * SEEN (the user's own message, earlier search results) and hand back the real
 * one. Re-reading a URL to the model does not help — reproducing it is exactly
 * what it cannot do.
 *
 * Thresholds are calibrated on the real garbles vs. genuinely different
 * articles on the same site (the false positive that matters — the model often
 * wants a DIFFERENT page on a host it has already read):
 *   real garbles          0.884 – 1.000
 *   different articles    0.488 – 0.656
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;

// Trailing punctuation that belongs to the sentence, not the URL.
function trimUrlPunctuation(u) {
    return String(u).replace(/[.,;:!?]+$/, '').replace(/\)+$/, m => (u.includes('(') ? m : ''));
}

/** Every http(s) URL in a blob of text, de-duplicated, order preserved. */
function extractUrls(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(URL_RE)) {
        const u = trimUrlPunctuation(m[0]);
        if (u.length < 12) continue;
        const k = u.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(u);
    }
    return out;
}

function hostOf(u) {
    try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** Path+query, case- and punctuation-insensitive: `npm-packages`, `npmpackages`
 *  and `npm-packag-es` all collapse to the same string, which is precisely the
 *  difference between what the model typed and what the site serves. */
function normalizeUrlForMatch(u) {
    let s = String(u || '');
    try {
        const p = new URL(s);
        s = p.pathname + p.search;
    } catch { /* not parseable — compare the whole string */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Dice coefficient over character bigrams. Cheap, dependency-free, and
 *  order-sensitive enough to keep two same-site articles apart. */
function diceSimilarity(a, b) {
    const A = normalizeUrlForMatch(a);
    const B = normalizeUrlForMatch(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.length < 2 || B.length < 2) return 0;
    const counts = new Map();
    for (let i = 0; i < A.length - 1; i++) {
        const g = A.slice(i, i + 2);
        counts.set(g, (counts.get(g) || 0) + 1);
    }
    let hits = 0;
    for (let i = 0; i < B.length - 1; i++) {
        const g = B.slice(i, i + 2);
        const c = counts.get(g) || 0;
        if (c > 0) { counts.set(g, c - 1); hits++; }
    }
    return (2 * hits) / (A.length - 1 + B.length - 1);
}

const URL_MIN_SIMILARITY = Number(process.env.URL_RESOLVE_MIN_SIMILARITY || 0.78);
const URL_MIN_MARGIN = Number(process.env.URL_RESOLVE_MIN_MARGIN || 0.08);

/**
 * The candidate `wanted` most plausibly meant, or null when the answer is not
 * obvious. Deliberately strict:
 *   - the HOST must match (a garbled slug is not a reason to change site), and
 *   - a candidate identical to `wanted` means there is nothing to fix, and
 *   - two candidates within MARGIN of each other refuse rather than guess —
 *     the caller's own "not found" beats reading the wrong article.
 */
function pickBestUrlMatch(wanted, candidates, opts = {}) {
    const minScore = opts.minScore ?? URL_MIN_SIMILARITY;
    const minMargin = opts.minMargin ?? URL_MIN_MARGIN;
    const want = String(wanted || '');
    if (!want) return null;
    const wantHost = hostOf(want);
    const wantNorm = normalizeUrlForMatch(want);

    const pool = [];
    const seen = new Set();
    for (const c of candidates || []) {
        const u = String(c || '');
        if (!u || seen.has(u)) continue;
        seen.add(u);
        if (u === want) return null;             // already correct
        if (wantHost && hostOf(u) !== wantHost) continue;
        if (normalizeUrlForMatch(u) === wantNorm) return { url: u, score: 1, exact: true };
        pool.push({ url: u, score: diceSimilarity(want, u) });
    }
    if (!pool.length) return null;
    pool.sort((a, b) => b.score - a.score);
    if (pool[0].score < minScore) return null;
    if (pool.length > 1 && pool[0].score - pool[1].score < minMargin) return null;
    return pool[0];
}

module.exports = {
    extractUrls,
    normalizeUrlForMatch,
    diceSimilarity,
    pickBestUrlMatch,
    hostOf,
    URL_MIN_SIMILARITY,
    URL_MIN_MARGIN,
};
