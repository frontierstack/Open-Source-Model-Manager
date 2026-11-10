'use strict';
/**
 * What to do when a site's bot protection refuses every live fetch layer.
 *
 * A human check cannot be waited out, and this module does not try to defeat
 * one. It gets the information by routes that need no check, for any site:
 *   1. an Internet Archive snapshot,
 *   2. what search engines hold for that exact page, plus readable pages about
 *      the same thing elsewhere.
 * Each result says plainly what it is, so a search excerpt is never passed off
 * as the page. All network access comes in through `deps`.
 */

// Words that describe a site's URL layout, not the page's subject.
const LAYOUT_WORDS = new Set(['product', 'products', 'item', 'items', 'question', 'questions', 'search', 'site', 'sites', 'page', 'pages', 'index', 'html', 'htm', 'php', 'aspx', 'asp', 'jsp', 'shtml']);
// Parameters that steer a page rather than name its subject.
const NON_SUBJECT_PARAM = /^(?:utm_|ref|src|source|sid|session|token|sort|order|page|p$|offset|limit|start|lang|locale|fmt|format|view|tab|cid|gclid|fbclid|osq)/i;
const TWO_PART_TLD = /\.(?:co|com|org|net|ac|gov)\.[a-z]{2}$/i;

function parse(url) { try { return new URL(String(url)); } catch (_) { return null; } }

function hostOf(url) {
    const u = parse(url);
    return u ? u.hostname.toLowerCase().replace(/^www\d?\./, '') : '';
}

function brandOf(host) {
    const trimmed = String(host || '').replace(TWO_PART_TLD, '.x').split('.');
    return trimmed.length >= 2 ? trimmed[trimmed.length - 2] : (trimmed[0] || '');
}

/** An opaque id in a URL says nothing a search engine can use. */
function isOpaqueToken(t) {
    if (/^\d{4,}$/.test(t)) return true;
    if (/^[a-z]{0,3}\d{4,}[a-z]*$/i.test(t)) return true;                 // g60763, e1651
    if (t.length >= 8 && /\d/.test(t) && /[a-z]/i.test(t)) return true;   // b0bshf7whw
    return /^[0-9a-f]{8,}$/i.test(t);
}

function splitWords(s) {
    let text = String(s || '');
    try { text = decodeURIComponent(text); } catch (_) { /* keep as written */ }
    return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Search identity of a URL: what the page is about, read from its address. */
function identityFromUrl(url) {
    const u = parse(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^www\d?\./, '');
    const brand = brandOf(host);
    const pathTokens = [];
    for (const seg of u.pathname.split('/').filter(Boolean)) {
        const words = splitWords(seg);
        // A lone very short segment is a routing prefix (/p/, /dp/), not a subject.
        if (words.length === 1 && words[0].length <= 3) continue;
        for (const w of words) {
            if (w.length < 2 || LAYOUT_WORDS.has(w) || isOpaqueToken(w) || w === brand) continue;
            if (!pathTokens.includes(w)) pathTokens.push(w);
        }
    }
    const queryTokens = [];
    for (const [k, v] of u.searchParams) {
        if (NON_SUBJECT_PARAM.test(k)) continue;
        const words = splitWords(v);
        if (!words.some(w => /\p{L}/u.test(w) && !isOpaqueToken(w))) continue;
        for (const w of words) {
            if (w.length >= 2 && !queryTokens.includes(w)) queryTokens.push(w);
        }
    }
    const tokens = [...pathTokens, ...queryTokens.filter(t => !pathTokens.includes(t))].slice(0, 8);
    return { host, brand, tokens, queryTokens, query: [brand, ...tokens].filter(Boolean).join(' ') };
}

function hitText(hit) {
    return `${hit && hit.title || ''} ${hit && hit.snippet || ''} ${hit && hit.url || ''}`.toLowerCase();
}

function tokenCoverage(text, tokens) {
    if (!tokens.length) return 0;
    const low = String(text || '').toLowerCase();
    return tokens.filter(t => low.includes(t)).length / tokens.length;
}

/** Same page, ignoring scheme, www, trailing slash and tracking parameters. */
function sameDocument(target, candidate, identity) {
    const a = parse(target);
    const b = parse(candidate);
    if (!a || !b) return false;
    const norm = (u) => `${u.hostname.toLowerCase().replace(/^www\d?\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
    if (norm(a) !== norm(b)) return false;
    const wanted = identity && identity.queryTokens || [];
    return !wanted.length || tokenCoverage(decodeURIComponent(b.search || ''), wanted) === 1;
}

/**
 * Search excerpts for the blocked page + readable pages about the same subject.
 * Returns null unless there is something real: the exact page in the index, or
 * at least two results that match what the URL names.
 */
async function fromSearchIndex(url, maxLength, deps) {
    const identity = identityFromUrl(url);
    if (!identity || !identity.tokens.length || !deps.search) return null;
    const found = await deps.search(identity.query);
    const hits = (found && Array.isArray(found.results) ? found.results : []).filter(h => h && h.url);
    const relevant = hits.filter(h => tokenCoverage(hitText(h), identity.tokens) >= 0.6);
    const exact = relevant.filter(h => sameDocument(url, h.url, identity));
    const sameHost = relevant.filter(h => hostOf(h.url) === identity.host && !exact.includes(h));
    const elsewhere = relevant.filter(h => hostOf(h.url) !== identity.host);
    if (!exact.length && relevant.length < 2) return null;

    // Read the best outside pages so the model gets text rather than a lead.
    const readable = elsewhere.filter(h => !(deps.isBlockedHost && deps.isBlockedHost(h.url)));
    const pages = [];
    if (deps.readPage) {
        const reads = await Promise.all(readable.slice(0, 3).map(h => deps.readPage(h.url).catch(() => null)));
        reads.forEach((r, i) => {
            if (pages.length >= 2 || !r || !r.success || !r.content || r.obstacle) return;
            if (tokenCoverage(r.content, identity.tokens) < 0.5) return;
            pages.push({ url: readable[i].url, title: r.title || readable[i].title || '', content: String(r.content) });
        });
    }

    const line = (h) => `- ${h.title || h.url}: ${h.snippet || '(no excerpt)'} (${h.url})`;
    const sections = [`[The live page ${url} refused automated access. What follows is NOT that page. It is what search engines hold for it, plus other sources on the same subject.]`];
    if (exact.length) sections.push(`Search-engine excerpt of this exact page:\n${exact.map(line).join('\n')}`);
    if (sameHost.length) sections.push(`Other ${identity.host} pages in the search index:\n${sameHost.slice(0, 3).map(line).join('\n')}`);
    for (const p of pages) sections.push(`Read in full from ${p.url}${p.title ? ` (${p.title})` : ''}:\n${p.content}`);
    const readUrls = new Set(pages.map(p => p.url));
    const unread = elsewhere.filter(h => !readUrls.has(h.url));
    if (unread.length) sections.push(`Other sources, not read yet:\n${unread.slice(0, 5).map(line).join('\n')}`);

    return {
        success: true, url, source: 'search-index', partial: true,
        title: (exact[0] && exact[0].title) || identity.tokens.join(' '),
        exactPageFound: exact.length > 0,
        content: sections.join('\n\n').slice(0, maxLength),
        alternatives: elsewhere.slice(0, 6).map(h => ({ url: h.url, title: h.title || '', read: readUrls.has(h.url) })),
        note: `${identity.host} refused automated access, so this is NOT the page itself. It holds search-engine excerpts${pages.length ? ` and ${pages.length} other page(s) read in full` : ''}. Tell the user the page could not be opened, attribute each fact to the source it appears under, and do not state ratings, prices or reviews that are not written here. Read an "Other sources" url if you need more; do not retry ${identity.host}.`,
    };
}

function isBlockedResult(r) {
    if (!r || r.success !== false) return false;
    if (r.error === 'bot_protected') return true;
    if (/^HTTP (?:401|403|451|503)\b/.test(String(r.error || ''))) return true;
    const kind = r.obstacle && r.obstacle.kind;
    return !!kind && ['bot_challenge', 'blocked', 'login', 'paywall', 'geo'].includes(kind);
}

const ARCHIVE_STALE_DAYS = parseInt(process.env.BLOCKED_ARCHIVE_STALE_DAYS, 10) || 730;
const FALLBACK_BUDGET_MS = parseInt(process.env.BLOCKED_FALLBACK_BUDGET_MS, 10) || 30000;

function archiveAgeDays(archivedAt, now) {
    const t = Date.parse(archivedAt);
    return Number.isNaN(t) ? 0 : Math.floor((now - t) / 86400000);
}

/**
 * Walk the fallbacks for a failed read. Returns a replacement result, or the
 * original result when nothing usable exists.
 * deps: { archive(url), search(query), readPage(url), isBlockedHost(url), now() }
 */
async function recoverBlockedPage({ url, result, maxLength = 15000, deps }) {
    const clock = (deps && deps.now) || Date.now;
    const started = clock();
    const inBudget = () => clock() - started < FALLBACK_BUDGET_MS;
    const max = Math.min(100000, Math.max(1000, parseInt(maxLength, 10) || 15000));
    const label = (out, step) => ({
        ...out, liveResult: 'failed',
        ...(result && result.obstacle ? { liveObstacle: result.obstacle } : {}),
        tried: `${(result && result.tried) || (result && result.error) || 'live'} → ${step}:ok`,
    });
    const attempt = async (fn) => { try { return await fn(); } catch (_) { return null; } };

    let staleArchive = null;
    if (deps.archive && inBudget()) {
        const arch = await attempt(() => deps.archive(url));
        if (arch && arch.success) {
            const age = archiveAgeDays(arch.archivedAt, clock());
            const out = {
                ...arch,
                note: `The live page refused automated access; this is the Internet Archive snapshot from ${arch.archivedAt}${age > 365 ? ` (${Math.round(age / 365)} years old)` : ''}. Cite it as an archived copy (${arch.archiveUrl}) and say the content may be out of date.`,
            };
            if (age <= ARCHIVE_STALE_DAYS) return label(out, 'archive');
            staleArchive = out;
        }
    }

    if (inBudget()) {
        const indexed = await attempt(() => fromSearchIndex(url, max, deps));
        if (indexed) {
            return label({
                ...indexed,
                ...(staleArchive ? { olderArchive: { archivedAt: staleArchive.archivedAt, archiveUrl: staleArchive.archiveUrl } } : {}),
            }, 'search-index');
        }
    }
    return staleArchive ? label(staleArchive, 'archive') : result;
}

module.exports = {
    identityFromUrl, sameDocument, fromSearchIndex, isBlockedResult, recoverBlockedPage, tokenCoverage, hostOf,
};
