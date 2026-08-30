/**
 * rehypeWordTags — a dependency-free rehype plugin that "tags" meaningful
 * tokens in a finalized assistant message so a wall of prose/tables reads at a
 * glance:
 *
 *   1. STATUS / SEVERITY words that the model emphasised (`**Critical**`,
 *      `**Passed**`) or put in a table cell ("| Status | Failed |") become
 *      colored pills. Matching is WHOLE-ELEMENT only — the entire trimmed text
 *      of the <strong>/<em>/<td>/<th> must BE the keyword — so "critical
 *      thinking" in ordinary prose is never touched (that whole-match rule is
 *      what keeps this from becoming noise; do not relax it to substring).
 *
 *   2. Unambiguous technical IDENTIFIERS in plain text — CVE ids, IPv4
 *      addresses, 32/40/64-char hex hashes, and semver versions — get a subtle
 *      monospace pill so they stand out from the sentence around them.
 *
 * Runs ONLY on the finalized render (never mid-stream — a half-typed token
 * would tag wrong). Skips anything inside code/pre/links/kbd/katex and never
 * re-tags an already-tagged node. Pure hast walking (no unist-util dep), so it
 * works offline with the pinned toolchain.
 */

// keyword (already lowercased, alphanumerics + a couple of separators) → kind
const KEYWORD_KIND = (() => {
    const m = {};
    const add = (kind, words) => words.forEach((w) => { m[w] = kind; });
    add('ok', ['success', 'successful', 'passed', 'pass', 'ok', 'okay', 'healthy', 'enabled',
        'secure', 'safe', 'valid', 'verified', 'resolved', 'fixed', 'complete', 'completed',
        'done', 'online', 'allowed', 'granted', 'yes', 'true', 'available', 'supported', 'stable']);
    add('warn', ['warning', 'warn', 'caution', 'high', 'medium', 'moderate', 'partial',
        'degraded', 'pending', 'unstable', 'beta', 'deprecated', 'review', 'limited', 'throttled']);
    add('danger', ['critical', 'malicious', 'malware', 'failed', 'failure', 'error', 'errors',
        'fatal', 'denied', 'blocked', 'rejected', 'vulnerable', 'insecure', 'unsafe', 'offline',
        'no', 'false', 'severe', 'exploit', 'compromised', 'suspicious', 'unsupported', 'missing']);
    add('info', ['low', 'info', 'note', 'notice', 'new', 'optional', 'default', 'n/a', 'na',
        'unknown', 'disabled', 'inactive', 'skipped', 'neutral', 'todo', 'tbd', 'experimental']);
    return m;
})();

// A whole label like "Critical", "PASSED", "N/A", "Failed:" → its kind.
function classifyKeyword(text) {
    if (!text) return null;
    let s = String(text).trim().toLowerCase();
    // Strip a single trailing/leading punctuation the model attaches to a label
    // ("Failed:", "(High)") but keep internal separators ("n/a").
    s = s.replace(/^[\s([{"'*~]+/, '').replace(/[\s)\]}"'*~:;.,!]+$/, '');
    if (s.length < 2 || s.length > 14) return null;
    return KEYWORD_KIND[s] || null;
}

// Ordered so a longer/more-specific pattern wins its span. Each has a `kind`
// used for the pill color. `g` flag; the walker resets lastIndex per node.
const ID_PATTERNS = [
    { kind: 'id', re: /\bCVE-\d{4}-\d{4,7}\b/g },                                  // CVE id
    { kind: 'id', re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g },               // IPv4 (+ optional port)
    { kind: 'id', re: /\b[0-9a-fA-F]{64}\b|\b[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{32}\b/g }, // sha256/sha1/md5
    { kind: 'id', re: /(?<![\w.-])v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?![\w-])/g },  // semver — require a leading v so a version glued into a filename (boost-1.0.0.jar) is not chipped
];

const SKIP_TAGS = new Set(['code', 'pre', 'a', 'kbd', 'script', 'style']);
const KEYWORD_HOSTS = new Set(['strong', 'b', 'em', 'i', 'td', 'th', 'mark']);

function addClass(node, ...cls) {
    node.properties = node.properties || {};
    const cur = node.properties.className;
    const arr = Array.isArray(cur) ? cur.slice() : (typeof cur === 'string' && cur ? cur.split(/\s+/) : []);
    for (const c of cls) if (!arr.includes(c)) arr.push(c);
    node.properties.className = arr;
}

function elementText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.value || '';
    if (node.children) return node.children.map(elementText).join('');
    return '';
}

function hasClass(node, cls) {
    const c = node && node.properties && node.properties.className;
    if (!c) return false;
    return Array.isArray(c) ? c.includes(cls) : String(c).split(/\s+/).includes(cls);
}

// Build the replacement children for a text node, wrapping every identifier
// match in a <span class="wtag wtag-id">. Returns null when nothing matched.
function tagIdentifiersInText(value) {
    // Collect all matches across patterns, keep the earliest-starting,
    // non-overlapping set (first pattern wins a tie).
    const hits = [];
    for (const { re } of ID_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(value)) !== null) {
            hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
            if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
        }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    let cursor = -1;
    for (const h of hits) {
        if (h.start < cursor) continue; // overlaps a kept span
        kept.push(h); cursor = h.end;
    }
    if (!kept.length) return null;
    const out = [];
    let pos = 0;
    for (const h of kept) {
        if (h.start > pos) out.push({ type: 'text', value: value.slice(pos, h.start) });
        out.push({
            type: 'element', tagName: 'span',
            properties: { className: ['wtag', 'wtag-id'] },
            children: [{ type: 'text', value: h.text }],
        });
        pos = h.end;
    }
    if (pos < value.length) out.push({ type: 'text', value: value.slice(pos) });
    return out;
}

export default function rehypeWordTags() {
    return function transform(tree) {
        const walk = (node, skip) => {
            if (!node || !node.children) return;
            const tag = node.tagName;
            // Whole-element keyword pill (strong/em/td/th that IS a status word).
            if (!skip && KEYWORD_HOSTS.has(tag) && !hasClass(node, 'wtag')) {
                const kind = classifyKeyword(elementText(node));
                if (kind) {
                    const cell = tag === 'td' || tag === 'th';
                    addClass(node, 'wtag', `wtag-${kind}`);
                    if (cell) addClass(node, 'wtag-cell');
                    // A tagged status cell/word never also gets identifier
                    // tagging inside it — its text is the keyword.
                    return;
                }
            }
            const childSkip = skip || SKIP_TAGS.has(tag) || hasClass(node, 'katex');
            const kids = node.children;
            for (let i = 0; i < kids.length; i++) {
                const child = kids[i];
                if (child.type === 'text') {
                    if (childSkip || !child.value) continue;
                    const replaced = tagIdentifiersInText(child.value);
                    if (replaced) { kids.splice(i, 1, ...replaced); i += replaced.length - 1; }
                } else if (child.type === 'element') {
                    walk(child, childSkip);
                }
            }
        };
        walk(tree, false);
        return tree;
    };
}

// Exported for unit tests.
export const __test = { classifyKeyword, tagIdentifiersInText, elementText };
