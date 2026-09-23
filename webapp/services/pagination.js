// Pagination detection shared by every read layer.
//
// A read used to return page 1 of a listing with no sign that pages 2..N
// existed, so the model either answered from a tenth of the data or GUESSED the
// next URL (`?page=2`, `/page/2/`) — which is exactly the URL-guessing class the
// web tool refuses after a few 404s. This module finds the page's REAL
// next/previous links and where it sits in the sequence, from either the raw
// HTML (axios / impersonate layers) or the rendered DOM (browser layers), which
// both reduce to one normalized anchor list:
//
//   { href (absolute), rel, text, label (aria-label/title), cls, disabled }
//
// Only hrefs that exist on the page are ever returned — nothing is synthesized.

const MAX_ANCHORS = 2000;

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    raquo: '»', laquo: '«', rsaquo: '›', lsaquo: '‹', rarr: '→', larr: '←',
    hellip: '…', ndash: '–', mdash: '—',
};
function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch (_) { return m; }
        }
        const v = ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

function attr(attrs, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function absolutize(href, base) {
    if (!href) return null;
    const h = href.trim();
    if (!h || h[0] === '#' || /^(javascript|mailto|tel|data):/i.test(h)) return null;
    try {
        const u = new URL(h, base);
        if (!/^https?:$/.test(u.protocol)) return null;
        return u.href;
    } catch (_) { return null; }
}

// Anchors + <link rel> tags out of raw HTML. Regex, not a parser: this runs on
// every served page and only needs attributes and short link text.
function anchorsFromHtml(html, baseUrl) {
    const out = [];
    if (!html || typeof html !== 'string') return out;
    const baseTag = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html);
    const base = (() => { try { return baseTag ? new URL(baseTag[1], baseUrl).href : baseUrl; } catch (_) { return baseUrl; } })();
    const linkRe = /<link\b([^>]*)>/gi;
    let m;
    while ((m = linkRe.exec(html)) && out.length < MAX_ANCHORS) {
        const rel = attr(m[1], 'rel').toLowerCase();
        if (!/\b(next|prev|previous)\b/.test(rel)) continue;
        const href = absolutize(attr(m[1], 'href'), base);
        if (href) out.push({ href, rel, text: '', label: '', cls: '', disabled: false });
    }
    const aRe = /<a\b([^>]*)>([\s\S]{0,600}?)<\/a\s*>/gi;
    while ((m = aRe.exec(html)) && out.length < MAX_ANCHORS) {
        const attrs = m[1];
        const href = absolutize(attr(attrs, 'href'), base);
        if (!href) continue;
        const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80);
        const cls = `${attr(attrs, 'class')} ${attr(attrs, 'id')}`.trim();
        out.push({
            href,
            rel: attr(attrs, 'rel').toLowerCase(),
            text,
            label: (attr(attrs, 'aria-label') || attr(attrs, 'title')).slice(0, 80),
            cls,
            disabled: attr(attrs, 'aria-disabled') === 'true' || /\bdisabled\b/i.test(cls),
        });
    }
    return out;
}

// Link text / label that means "the next page of THIS listing". Anchored, so
// "Next article", "next slide" or a sentence that merely contains "next" never
// match — following those is not pagination.
const NEXT_TEXT = /^(?:next(?:\s+page|\s+results?)?|next\s*(?:»|›|→|>|>>|❯|⟩)|(?:»|›|→|>|>>|❯|⟩|⇨)|older(?:\s+(?:posts|entries|articles|stories|results))?|more\s+results|weiter|nächste(?:\s+seite)?|suivant(?:e)?|page\s+suivante|siguiente|próxima|proxima|avanti|successiva|volgende|次へ|下一页|下一頁|다음)$/i;
const PREV_TEXT = /^(?:prev(?:ious)?(?:\s+page|\s+results?)?|(?:«|‹|←|<|<<|❮|⟨)\s*(?:prev(?:ious)?)?|newer(?:\s+(?:posts|entries|articles|stories))?|zurück|vorherige(?:\s+seite)?|précédent(?:e)?|anterior|precedente|vorige|前へ|上一页|上一頁|이전)$/i;
const NOT_PAGER = /\b(slide|carousel|slick|swiper|gallery|photo|image|video|story|chapter|episode|track|song|article|lightbox|month|year|week|day|calendar)\b/i;
const PAGER_CTX = /pagin|pager|page-numbers|page-link|pagelink|pagerctx|\bpages?\b|nav-links/i;

function cleanLabel(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/^[\s ]+|[\s ]+$/g, '').trim();
}

function sameSite(a, b) {
    try {
        const ha = new URL(a).hostname.replace(/^www\./, '');
        const hb = new URL(b).hostname.replace(/^www\./, '');
        return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
    } catch (_) { return false; }
}

function stripHash(u) { return String(u || '').split('#')[0]; }
function samePage(a, b) {
    const n = (u) => stripHash(u).replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
    return n(a) === n(b);
}

function classify(anchor) {
    const text = cleanLabel(anchor.text);
    const label = cleanLabel(anchor.label);
    const cls = String(anchor.cls || '');
    const rel = String(anchor.rel || '');
    if (/\bnext\b/.test(rel)) return { dir: 'next', score: 100 };
    if (/\b(prev|previous)\b/.test(rel)) return { dir: 'prev', score: 100 };
    if (NOT_PAGER.test(`${label} ${cls}`) && !PAGER_CTX.test(cls)) return null;
    const pager = PAGER_CTX.test(cls);
    if (NEXT_TEXT.test(text) || (!text && NEXT_TEXT.test(label))) return { dir: 'next', score: pager ? 90 : 80 };
    if (PREV_TEXT.test(text) || (!text && PREV_TEXT.test(label))) return { dir: 'prev', score: pager ? 90 : 80 };
    if (/^next(?:\s+page|\s+results?)?$/i.test(label)) return { dir: 'next', score: 75 };
    if (/^prev(?:ious)?(?:\s+page|\s+results?)?$/i.test(label)) return { dir: 'prev', score: 75 };
    // WordPress `next page-numbers`, Bootstrap `page-item next`, etc.
    if (pager && /(^|[\s_-])next([\s_-]|$)/i.test(cls)) return { dir: 'next', score: 70 };
    if (pager && /(^|[\s_-])prev(ious)?([\s_-]|$)/i.test(cls)) return { dir: 'prev', score: 70 };
    return null;
}

// Numbered page links ("1 2 [3] 4 5 … 47"). Group anchors whose text is a page
// number by the SHAPE of their href (digit runs → #): the pager's links share
// one shape, unrelated numeric links (footnotes, ids) do not.
function numberedPages(anchors, pageUrl) {
    const groups = new Map();
    for (const a of anchors) {
        const t = cleanLabel(a.text);
        if (!/^\d{1,4}$/.test(t)) continue;
        const n = parseInt(t, 10);
        if (n < 1) continue;
        if (!sameSite(a.href, pageUrl)) continue;
        const key = stripHash(a.href).replace(/\d+/g, '#');
        if (!groups.has(key)) groups.set(key, new Map());
        const g = groups.get(key);
        if (!g.has(n)) g.set(n, { n, href: stripHash(a.href), inHref: new RegExp(`(^|\\D)${n}(\\D|$)`).test(stripHash(a.href)), pager: PAGER_CTX.test(a.cls || '') });
    }
    let best = null;
    for (const [key, g] of groups) {
        const items = [...g.values()];
        if (items.length < 2) continue;
        const inHref = items.filter(i => i.inHref).length;
        const pager = items.some(i => i.pager);
        // Either the page number is literally in the href (?page=3, /page/3/),
        // or it is an offset pager (start=20 for page 3) with enough members,
        // or the markup says it is a pager.
        if (!(inHref >= Math.ceil(items.length / 2) || items.length >= 3 || pager)) continue;
        const score = items.length + (pager ? 5 : 0) + inHref;
        if (!best || score > best.score) best = { key, items: items.sort((x, y) => x.n - y.n), score };
    }
    if (!best) return null;
    const nums = best.items.map(i => i.n);
    let current = null;
    const self = best.items.find(i => samePage(i.href, pageUrl));
    if (self) current = self.n;
    else {
        // The current page is usually rendered as plain text, i.e. the one
        // number MISSING from the linked sequence.
        if (nums[0] === 2) current = 1;
        else {
            for (let k = 1; k < nums.length; k++) {
                if (nums[k] - nums[k - 1] === 2) { current = nums[k - 1] + 1; break; }
            }
        }
    }
    const byN = new Map(best.items.map(i => [i.n, i.href]));
    return {
        current,
        last: nums[nums.length - 1],
        next: current != null ? (byN.get(current + 1) || null) : null,
        prev: current != null ? (byN.get(current - 1) || null) : null,
    };
}

/**
 * @returns {null | {next, prev, current, last, via}}
 */
function detectPagination(anchors, pageUrl) {
    if (!Array.isArray(anchors) || !anchors.length || !pageUrl) return null;
    let next = null, prev = null;
    for (const a of anchors) {
        if (!a || !a.href || a.disabled) continue;
        if (!sameSite(a.href, pageUrl) || samePage(a.href, pageUrl)) continue;
        const c = classify(a);
        if (!c) continue;
        const cand = { href: stripHash(a.href), score: c.score, via: /\b(next|prev)/.test(a.rel || '') ? 'rel' : 'link-text' };
        if (c.dir === 'next' && (!next || cand.score > next.score)) next = cand;
        if (c.dir === 'prev' && (!prev || cand.score > prev.score)) prev = cand;
    }
    const nums = numberedPages(anchors, pageUrl);
    const out = {
        next: next ? next.href : (nums && nums.next) || null,
        prev: prev ? prev.href : (nums && nums.prev) || null,
        current: nums ? nums.current : null,
        last: nums ? nums.last : null,
        via: next ? next.via : (nums && nums.next ? 'page-numbers' : null),
    };
    if (out.current != null && out.last != null && out.last < out.current) out.last = out.current;
    if (!out.next && !out.prev && out.last == null) return null;
    // A current page equal to the last visible number with no next link = end.
    return out;
}

function paginationFromHtml(html, pageUrl) {
    try { return detectPagination(anchorsFromHtml(html, pageUrl), pageUrl); } catch (_) { return null; }
}

// One sentence the model can act on. Keeps the NEXT url verbatim so it is
// copied, never re-typed.
function describePagination(p, pageUrl) {
    if (!p) return null;
    const pos = p.current != null
        ? `This is page ${p.current}${p.last && p.last >= p.current ? ` of at least ${p.last}` : ''}.`
        : (p.last ? `The listing has at least ${p.last} pages.` : 'This page is part of a paginated listing.');
    if (!p.next) return `${pos} There is no next page — this is the last one.`;
    return `${pos} More results are on the next page: ${p.next} — read it with web {url:"${p.next}"} (copy the URL exactly, never build page URLs yourself), or collect several pages in one call with web {url:"${pageUrl}", mode:"crawl", maxPages:N}.`;
}

// ---- Multi-page text assembly ------------------------------------------
// Page 2..N of a listing repeat page 1's header/nav and footer. Strip the
// LEADING and TRAILING runs of lines that page 1 also had (plus the extractor's
// own Title:/URL: preamble) — never lines in the middle, where the items live,
// so a price or a date that happens to repeat across pages is kept.
function stripRepeatedChrome(text, firstPageLines) {
    const B = String(text || '').split('\n');
    if (!Array.isArray(firstPageLines) || !firstPageLines.length) return B.join('\n').trim();
    const norm = (l) => String(l || '').trim();
    const headSet = new Set(firstPageLines.slice(0, 80).map(norm).filter(Boolean));
    const tailSet = new Set(firstPageLines.slice(-100).map(norm).filter(Boolean));
    let i = 0, meta = 0;
    while (i < B.length) {
        const k = norm(B[i]);
        if (!k || headSet.has(k)) { i++; continue; }
        if (meta < 4 && /^(title|url|summary|description|published):/i.test(k)) { i++; meta++; continue; }
        break;
    }
    let j = B.length;
    while (j > i) {
        const k = norm(B[j - 1]);
        if (!k || tailSet.has(k)) { j--; continue; }
        break;
    }
    return B.slice(i, j).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A "load more" / infinite-scroll page ACCUMULATES: every extraction holds all
// earlier items again. Keep only lines not seen in any earlier extraction.
function newLinesOnly(text, seen) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const k = line.trim();
        if (!k) { out.push(''); continue; }
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function rememberLines(text, seen) {
    for (const line of String(text || '').split('\n')) { const k = line.trim(); if (k) seen.add(k); }
    return seen;
}

function meaningfulLength(text) { return String(text || '').replace(/\s+/g, '').length; }

module.exports = {
    anchorsFromHtml,
    detectPagination,
    paginationFromHtml,
    describePagination,
    stripRepeatedChrome,
    newLinesOnly,
    rememberLines,
    meaningfulLength,
    sameSite,
    NEXT_TEXT,
    PREV_TEXT,
    NOT_PAGER,
};
