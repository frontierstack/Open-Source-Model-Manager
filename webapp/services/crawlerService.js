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

async function crawlUrlPattern(baseUrl, options = {}) {
    const {
        maxPages = 5,
        timeout = 20000,
        maxLength = 30000,
        includeLinks = false,
        stealth = false,
    } = options;

    const capped = Math.min(20, Math.max(1, parseInt(maxPages, 10) || 5));
    const perPageCap = Math.max(500, Math.floor(maxLength / capped));

    const detected = detectUrlPattern(baseUrl);
    const pages = [];
    let total = 0;
    let currentUrl = baseUrl;
    let prevHash = '';

    const hash = (s) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h;
    };

    for (let i = 0; i < capped; i++) {
        const result = await fetchWithFallback(currentUrl, {
            timeout,
            includeLinks,
            maxLength: perPageCap,
            preferStealth: stealth,
        });
        if (!result.success) {
            if (i === 0) return { success: false, url: baseUrl, error: result.error };
            break;
        }
        const content = result.content || '';
        const thisHash = `${hash(content)}|${content.length}`;
        if (i > 0 && thisHash === prevHash) break; // same page repeated — exhausted
        prevHash = thisHash;

        pages.push({
            index: i,
            url: currentUrl,
            title: result.title || '',
            content: content.slice(0, perPageCap),
        });
        total += content.length;
        if (total >= maxLength) break;
        if (i === capped - 1) break;

        const advanced = detected ? advanceUrl(currentUrl, options.offsetStep) : null;
        currentUrl = advanced || appendPageParam(baseUrl, i + 2);
    }

    if (pages.length === 0) {
        return { success: false, url: baseUrl, error: 'no pages extracted' };
    }
    return {
        success: true,
        url: baseUrl,
        mode: 'url-pattern',
        pagesVisited: pages.length,
        pages,
    };
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
    } = options;

    // Auto mode: prefer the fast URL-pattern path when the URL already has
    // a pagination marker. Otherwise hand off to Playwright so it can
    // inspect the DOM for next links / load-more / infinite scroll.
    let resolvedMode = mode;
    if (mode === 'auto') {
        if (detectUrlPattern(url)) resolvedMode = 'url-pattern';
    }

    if (resolvedMode === 'url-pattern') {
        return crawlUrlPattern(url, { maxPages, timeout, maxLength, includeLinks, stealth });
    }

    // Everything else is stateful — delegate to playwrightService.crawlPages.
    return playwrightService.crawlPages(url, {
        mode: resolvedMode === 'auto' ? 'auto' : resolvedMode,
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
};
