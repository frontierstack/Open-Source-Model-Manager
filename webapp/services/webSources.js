'use strict';
// The pages a web tool call returned, as a small list the chat can show under
// the answer ({url, title, snippet}). Computed on the server because the
// tool_result frame drops the full `result` once it passes 32 KB, and a page
// read is usually bigger than that — so the client could not build the list
// itself, and the site icons never appeared. Same shapes as the chat's own
// extractSources.

const MAX_SOURCES = 25;
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
const entry = (r) => ({
    url: r.url,
    title: clip(r.title, 200),
    snippet: clip(r.snippet, 300) || clip(r.content, 220),
});

function webSourcesFromResult(toolName, result) {
    if (!result || typeof result !== 'object') return null;
    let list = null;
    if (toolName === 'web' || toolName === 'web_search' || toolName === 'fetch_url'
        || toolName === 'scrapling_fetch' || toolName === 'playwright_fetch'
        || toolName === 'playwright_interact' || toolName === 'crawl_pages') {
        if (Array.isArray(result.results)) list = result.results.filter(r => r && isHttp(r.url)).map(entry);
        else if (Array.isArray(result.pages)) list = result.pages.filter(p => p && isHttp(p.url)).map(entry);
        else if (isHttp(result.url)) list = [entry(result)];
    }
    if (!list || !list.length) return null;
    return list.slice(0, MAX_SOURCES);
}

module.exports = { webSourcesFromResult };
