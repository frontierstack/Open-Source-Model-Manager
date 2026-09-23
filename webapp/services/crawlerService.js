// Multi-page crawler. Walks paginated listings using the fastest viable
// strategy:
//
//   url-pattern    — stateless fetch loop, increments a page number in the
//                    URL (?page=N, /page/N/, ?offset=N, etc.). Fastest.
//   link-follow    — stateful Playwright session that clicks the next
//                    link. Used when the URL has no pagination marker but
//                    the page has a "Next" control.
//   load-more      — stateful Playwright session that clicks a "Load
//                    more" button N times.
//   infinite-scroll — stateful Playwright session that scrolls to the
//                     bottom N times.
//
// Mode `auto` (the default) picks one: URL pattern if present, else it
// loads the first page with Playwright and inspects the DOM.

const playwrightService = require('./playwrightService');
const paginationSvc = require('./pagination');

let scraplingService = null;
try { scraplingService = require('./scraplingService'); } catch (_) { /* optional */ }

const URL_PATTERNS = [
    { regex: /([?&])page=(\d+)/i,   step: () => 1,   replace: (m, n) => `${m[1]}page=${n}` },
    { regex: /([?&])p=(\d+)/i,      step: () => 1,   replace: (m, n) => `${m[1]}p=${n}` },
    { regex: /([?&])pg=(\d+)/i,     step: () => 1,   replace: (m, n) => `${m[1]}pg=${n}` },
    { regex: /([?&])offset=(\d+)/i, step: (m, limit) => limit || 20, replace: (m, n) => `${m[1]}offset=${n}` },
    { regex: /([?&])start=(\d+)/i,  step: (m, limit) => limit || 20, replace: (m, n) => `${m[1]}start=${n}` },
    { regex: /\/page\/(\d+)\/?/i,   step: () => 1,   replace: (m, n) => `/page/${n}${m[0].endsWith('/') ? '/' : ''}` },
    { regex: /\/page-(\d+)/i,       step: () => 1,   replace: (m, n) => `/page-${n}` },
];

function detectUrlPattern(url) {
    for (const pat of URL_PATTERNS) {
        const m = url.match(pat.regex);
        if (m) {
            const current = parseInt(m[2] ?? m[1], 10); // offset/start use m[2], /page/N uses m[1]
            // The path patterns capture (\d+) as m[1], query patterns as m[2].
            const numIdx = /\([?&]\)/.test(pat.regex.source) ? 2 : 1;
            return {
                pattern: pat,
                match: m,
                current: parseInt(m[numIdx], 10),
                numIdx,
            };
        }
    }
    return null;
}

function advanceUrl(url, limitHint) {
    const detected = detectUrlPattern(url);
    if (!detected) return null;
    const { pattern, match, current } = detected;
    const stepVal = pattern.step(match, limitHint);
    const next = current + stepVal;
    return url.replace(pattern.regex, pattern.replace(match, next));
}

function appendPageParam(url, pageNum) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}page=${pageNum}`;
}

async function fetchWithFallback(url, { timeout, includeLinks, maxLength, preferStealth }) {
    // Mirror the fetch_url pipeline: Scrapling (stealth) → Playwright → fail.
    // When preferStealth is true, try scrapling first even without a failure
    // signal — useful once the caller has already seen a bot challenge.
    if (preferStealth && scraplingService) {
        try {
            const sr = await scraplingService.fetchUrl(url, { timeout, extractLinks: includeLinks });
            if (sr?.success && (sr.content || '').length > 200) {
                return { success: true, url, title: sr.title || '', content: sr.content || '', source: 'scrapling' };
            }
        } catch (_) { /* fall through */ }
    }
    try {
        const pw = await playwrightService.fetchUrlContent(url, { timeout, includeLinks, maxLength });
        if (pw?.success) return { ...pw, source: 'playwright' };
    } catch (_) { /* fall through */ }
    if (scraplingService) {
        try {
            const sr = await scraplingService.fetchUrl(url, { timeout, extractLinks: includeLinks });
            if (sr?.success) return { success: true, url, title: sr.title || '', content: sr.content || '', source: 'scrapling' };
        } catch (_) { /* fall through */ }
    }
    return { success: false, url, error: 'all fetch engines failed' };
}

// Stateless multi-page walk: fetch a page, follow ITS real next-page link
// (services/pagination.js), repeat. Falls back to incrementing a ?page=N-style
// URL marker only when the page offers no next link. Each later page has page
// 1's header/footer lines stripped, so the pages carry the ITEMS, not the same
// nav chrome N times.
async function crawlLinks(baseUrl, options = {}) {
    const {
        maxPages = 5,
        timeout = 20000,
        maxLength = 30000,
        includeLinks = false,
        stealth = false,
        first = null,
        explicitPattern = false,
        guard = null,
    } = options;
    const capped = Math.min(20, Math.max(1, parseInt(maxPages, 10) || 5));
    const perPageCap = Math.max(500, Math.floor(maxLength / capped));
    const fetchPage = options.fetchPage || ((u) => fetchWithFallback(u, { timeout, includeLinks, maxLength: perPageCap * 2, preferStealth: stealth }));
    const norm = (u) => String(u || '').split('#')[0].replace(/\/+$/, '');

    const r0 = first || await fetchPage(baseUrl);
    if (!r0 || !r0.success) return { success: false, url: baseUrl, error: (r0 && r0.error) || 'first page failed' };

    const pages = [{ index: 0, url: baseUrl, title: r0.title || '', content: String(r0.content || '').slice(0, perPageCap) }];
    const firstLines = String(r0.content || '').split('\n');
    const visited = new Set([norm(baseUrl)]);
    let total = pages[0].content.length;
    let cur = r0;
    let curUrl = baseUrl;
    let prevContent = null;
    let stoppedBecause = null;
    let usedPattern = false;

    for (let i = 1; i < capped; i++) {
        if (total >= maxLength) { stoppedBecause = 'length budget reached'; break; }
        const pg = cur.pagination || null;
        let next = pg && pg.next ? pg.next : null;
        if (!next) {
            const detected = detectUrlPattern(curUrl);
            if (detected && pg && pg.last && detected.current >= pg.last) { stoppedBecause = 'reached the last page'; break; }
            if (detected) { next = advanceUrl(curUrl, options.offsetStep); usedPattern = true; }
            else if (explicitPattern) { next = appendPageParam(baseUrl, i + 1); usedPattern = true; }
        }
        if (!next) { stoppedBecause = pg && pg.current && pg.last && pg.current >= pg.last ? 'reached the last page' : 'no next page link'; break; }
        if (visited.has(norm(next))) { stoppedBecause = 'pagination loops back to a page already read'; break; }
        if (guard) { const why = guard(next); if (why) { stoppedBecause = `next page refused: ${why}`; break; } }
        visited.add(norm(next));
        const r = await fetchPage(next);
        if (!r || !r.success) { stoppedBecause = `page ${i + 1} failed (${(r && r.error) || 'fetch failed'})`; break; }
        const content = paginationSvc.stripRepeatedChrome(r.content || '', firstLines);
        if (paginationSvc.meaningfulLength(content) < 40) { stoppedBecause = 'no new content on the next page'; break; }
        if (prevContent !== null && content === prevContent) { stoppedBecause = 'the next page repeated the previous one'; break; }
        prevContent = content;
        pages.push({ index: i, url: next, title: r.title || '', content: content.slice(0, perPageCap) });
        total += Math.min(content.length, perPageCap);
        cur = r;
        curUrl = next;
        if (i === capped - 1) stoppedBecause = 'maxPages reached';
    }

    return {
        success: true,
        url: baseUrl,
        finalUrl: curUrl,
        mode: usedPattern ? 'url-pattern' : 'link-follow',
        pagesVisited: pages.length,
        pages,
        ...(stoppedBecause ? { stoppedBecause } : {}),
        ...(cur.pagination ? { pagination: cur.pagination } : {}),
    };
}

// Back-compat name.
function crawlUrlPattern(baseUrl, options = {}) {
    return crawlLinks(baseUrl, { ...options, explicitPattern: true });
}

async function crawl(url, options = {}) {
    const {
        mode = 'auto',
        maxPages = 5,
        maxLength = 30000,
        timeout = 20000,
        includeLinks = false,
        nextSelector,
        loadMoreSelector,
        waitForSelector,
        stealth = false,
        fetchPage,
        guard,
    } = options;

    const common = { maxPages, timeout, maxLength, includeLinks, stealth, fetchPage, guard };
    if (mode === 'url-pattern') return crawlUrlPattern(url, common);

    // auto: read page 1 through the fast cascade first. When it has a real
    // next-page link (or a ?page=N marker), walk the listing WITHOUT a browser
    // session — seconds instead of a browser click per page. Only a JS pager
    // (no href), a load-more button or infinite scroll needs the stateful path.
    if (mode === 'auto' && !nextSelector && !loadMoreSelector && !waitForSelector && fetchPage) {
        const first = await fetchPage(url).catch(() => null);
        if (first && first.success && ((first.pagination && first.pagination.next) || detectUrlPattern(url))) {
            return crawlLinks(url, { ...common, first });
        }
    } else if (mode === 'auto' && detectUrlPattern(url) && !nextSelector && !loadMoreSelector) {
        return crawlLinks(url, common);
    }

    return playwrightService.crawlPages(url, {
        mode: mode === 'auto' ? 'auto' : mode,
        maxPages,
        timeout,
        maxLength,
        includeLinks,
        nextSelector,
        loadMoreSelector,
        waitForSelector,
    });
}

module.exports = {
    crawl,
    detectUrlPattern, // exposed for tests
    crawlLinks,
};
