'use strict';

// Exact counts of the dated entries on a page — posts per month, releases per
// year, incidents per week — computed from the page's OWN data, never from a
// model reading the text.
//
// Why this exists: asked to chart a leak site's posts per month, two local
// models read the page text and counted by eye in every attempt, even when
// told to count with code — 81 (and runs with whole months at zero) against
// the 136 the page itself lists. Listing pages almost always carry their
// entries as data: an embedded JSON block (<script type="application/json">,
// __NEXT_DATA__, ld+json), the JSON API a single-page app loads, or one
// table row / list item / card per entry with a <time datetime> or a date in
// it. Counting THAT is exact.
//
// extractRecords(): the best set of dated records on a page, from
//   1. JSON (embedded or API): the largest array of objects whose items carry
//      a date field;
//   2. HTML: the most common repeated element (tr / li / article / div with a
//      shared class) where each instance holds exactly one date.
// tallyRecords(): counts per day / week / month / quarter / year (gaps
// filled with 0 across the range) or per value of a field.

const MAX_JSON_SCAN = 200;
const MIN_RECORDS = 3;
const DATE_KEY_RE = /(date|time|published|created|discovered|posted|released?|updated|modified|timestamp|added|seen|reported|occurred|when|day)/i;
const PREFERRED_DATE_KEY_RE = /(published|discovered|posted|created|released?|reported|occurred|date)/i;
const DEMOTED_DATE_KEY_RE = /(updated|modified|last|expires|scraped|fetched|crawled)/i;
const TITLE_KEY_RE = /^(post_?title|title|name|headline|subject|label|victim|company|organization|organisation|summary|text)$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// ── dates ────────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
}
/** A date-like value → 'YYYY-MM-DD', or null. Never treats a bare number string (an id) as a date. */
function parseDateLike(v) {
    if (v == null || typeof v === 'boolean') return null;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        const ms = v > 1e12 && v < 4.2e12 ? v : (v > 6.3e8 && v < 4.2e9 ? v * 1000 : null);
        if (ms == null) return null;
        const d = new Date(ms);
        return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (s.length < 6 || s.length > 64) return null;
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s_])/.exec(s);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = /^(\d{4})(\d{2})(\d{2})T\d{2}/.exec(s);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    // Month-name forms: "Jan 5, 2026", "5 January 2026", "Mon, 05 Jan 2026 10:00:00 GMT".
    m = new RegExp(`^(?:[a-z]{3,9},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE_SRC}\\.?,?\\s+(\\d{4})\\b`, 'i').exec(s)
        || new RegExp(`^(?:[a-z]{3,9},?\\s+)?${MONTH_RE_SRC}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i').exec(s);
    if (m) {
        const mon = monthIndex(s);
        if (mon) return ymd(+m[2], mon, +m[1]);
    }
    return null;
}
function monthIndex(s) {
    const m = new RegExp(MONTH_RE_SRC, 'i').exec(s);
    if (!m) return 0;
    return MONTHS.findIndex(x => x.toLowerCase() === m[0].slice(0, 3).toLowerCase()) + 1;
}
/** Dates written inside free text (an HTML row's text). */
function datesInText(text) {
    const out = [];
    const t = String(text || '');
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    let m;
    while ((m = iso.exec(t))) { const d = ymd(+m[1], +m[2], +m[3]); if (d) out.push(d); }
    const named = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE_SRC}\\.?,?\\s+(\\d{4})|${MONTH_RE_SRC}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}))\\b`, 'gi');
    while ((m = named.exec(t))) {
        const mon = monthIndex(m[0]);
        const d = m[1] ? ymd(+m[2], mon, +m[1]) : ymd(+m[4], mon, +m[3]);
        if (d) out.push(d);
    }
    return out;
}

// ── JSON ─────────────────────────────────────────────────────────────────────
function decodeEntities(s) {
    return String(s || '').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function tryParse(text) {
    try { return JSON.parse(text); } catch (_) { return undefined; }
}
/** JSON documents embedded in a page: JSON script blocks, then JSON literals assigned in inline scripts. */
function jsonFromHtml(html) {
    const docs = [];
    const h = String(html || '');
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(h)) && docs.length < MAX_JSON_SCAN) {
        const attrs = m[1] || '';
        const body = (m[2] || '').trim();
        if (!body || body.length < 20) continue;
        if (/type\s*=\s*["']?application\/(?:ld\+)?json|type\s*=\s*["']?text\/json|id\s*=\s*["']?__(?:NEXT|NUXT)_DATA__/i.test(attrs)) {
            const v = tryParse(body) ?? tryParse(decodeEntities(body));
            if (v !== undefined) { docs.push(v); continue; }
        }
        if (/\bsrc\s*=/.test(attrs)) continue;
        // window.__DATA__ = {...}; const posts = [...]; JSON.parse('...')
        const assignRe = /(?:=|:|\()\s*(\[\s*\{|\{\s*")/g;
        let a, tries = 0;
        while ((a = assignRe.exec(body)) && tries < 20) {
            tries++;
            const start = a.index + a[0].length - a[1].length;
            const end = matchBracket(body, start);
            if (end < 0) continue;
            const v = tryParse(body.slice(start, end + 1));
            if (v !== undefined && typeof v === 'object') { docs.push(v); assignRe.lastIndex = end + 1; }
        }
    }
    return docs;
}
function matchBracket(s, start) {
    const open = s[start], close = open === '[' ? ']' : '}';
    let depth = 0, inStr = null;
    for (let i = start; i < s.length && i < start + 5_000_000; i++) {
        const c = s[i];
        if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { depth--; if (depth === 0) return c === close ? i : -1; }
    }
    return -1;
}
/** Every array of objects (≥ MIN_RECORDS) anywhere in a JSON value. */
function objectArrays(v, path = '$', out = [], depth = 0) {
    if (depth > 10 || v == null || typeof v !== 'object') return out;
    if (Array.isArray(v)) {
        const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
        if (objs.length >= MIN_RECORDS && objs.length >= v.length * 0.8) out.push({ path, items: objs });
        v.slice(0, 2000).forEach((x, i) => { if (x && typeof x === 'object') objectArrays(x, `${path}[${i}]`, out, depth + 1); });
        return out;
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object') objectArrays(x, `${path}.${k}`, out, depth + 1);
    return out;
}
function pickDateKey(items) {
    const keys = new Set();
    for (const it of items.slice(0, 50)) for (const k of Object.keys(it)) keys.add(k);
    let best = null;
    for (const k of keys) {
        let dated = 0;
        for (const it of items) if (parseDateLike(it[k])) dated++;
        const frac = dated / items.length;
        if (frac < 0.6) continue;
        // Numbers count as dates only under a date-ish key name (ids are numbers too).
        if (items.some(it => typeof it[k] === 'number') && !DATE_KEY_RE.test(k)) continue;
        const score = frac * 10 + (PREFERRED_DATE_KEY_RE.test(k) ? 2 : 0) + (DATE_KEY_RE.test(k) ? 1 : 0) - (DEMOTED_DATE_KEY_RE.test(k) ? 3 : 0);
        if (!best || score > best.score) best = { key: k, score, dated };
    }
    return best;
}
function pickTitleKey(items) {
    const keys = Object.keys(items[0] || {});
    const named = keys.find(k => TITLE_KEY_RE.test(k) && typeof items[0][k] === 'string');
    if (named) return named;
    // Else the shortest-on-average string field that varies between items.
    let best = null;
    for (const k of keys) {
        const vals = items.slice(0, 40).map(it => it[k]).filter(x => typeof x === 'string' && x.trim());
        if (vals.length < Math.min(items.length, 40) * 0.8) continue;
        if (new Set(vals).size < vals.length * 0.5 || vals.some(x => /^https?:/i.test(x))) continue;
        const avg = vals.reduce((a, x) => a + x.length, 0) / vals.length;
        if (avg < 2 || avg > 200 || parseDateLike(vals[0])) continue;
        if (!best || avg < best.avg) best = { key: k, avg };
    }
    return best ? best.key : null;
}
function recordsFromJsonDocs(docs, source) {
    let best = null;
    docs.forEach((doc, di) => {
        for (const arr of objectArrays(doc, `doc${di}`)) {
            const dk = pickDateKey(arr.items);
            if (!dk) continue;
            if (!best || dk.dated > best.dk.dated) best = { arr, dk };
        }
    });
    if (!best) return null;
    const titleKey = pickTitleKey(best.arr.items);
    const seen = new Set();
    const records = [];
    for (const it of best.arr.items) {
        const date = parseDateLike(it[best.dk.key]);
        if (!date) continue;
        const sig = JSON.stringify(it);
        if (seen.has(sig)) continue;
        seen.add(sig);
        records.push({ date, title: titleKey && typeof it[titleKey] === 'string' ? it[titleKey].slice(0, 160) : '', fields: it });
    }
    return { source, records, dateField: best.dk.key, titleField: titleKey, path: best.arr.path, totalItems: best.arr.items.length };
}

// ── HTML rows ────────────────────────────────────────────────────────────────
function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
// End of the <div> that opens at `start` (balanced), capped — so a card is
// exactly its own markup, never the next card's.
function divEnd(h, start, cap = 30000) {
    const re = /<div\b|<\/div\s*>/gi;
    re.lastIndex = start;
    let depth = 0, m;
    while ((m = re.exec(h)) && m.index < start + cap) {
        if (m[0][1] === '/') { depth--; if (depth === 0) return m.index + m[0].length; }
        else depth++;
    }
    return Math.min(h.length, start + 4000);
}
function recordsFromHtml(html) {
    const h = String(html || '').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
    const groups = [];
    for (const tag of ['tr', 'li', 'article', 'section', 'item', 'entry']) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
        groups.push({ kind: tag, parts: [...h.matchAll(re)].map(m => ({ html: m[1], start: m.index, end: m.index + m[0].length })) });
    }
    // Cards: <div class="X ..."> repeated with the same first class.
    const divRe = /<div\b[^>]*\bclass\s*=\s*["']([^"' ]+)[^"']*["'][^>]*>/gi;
    const byClass = new Map();
    let m;
    while ((m = divRe.exec(h))) {
        const list = byClass.get(m[1]) || [];
        list.push(m.index);
        byClass.set(m[1], list);
    }
    for (const [cls, idxs] of byClass) {
        if (idxs.length < MIN_RECORDS || idxs.length > 5000) continue;
        const parts = idxs.map(start => { const end = divEnd(h, start); return { html: h.slice(start, end), start, end }; });
        groups.push({ kind: `div.${cls}`, parts });
    }
    const scored = [];
    for (const g of groups) {
        const records = [];
        const spans = [];
        const seenSig = new Set();
        for (const seg of g.parts) {
            const part = seg.html;
            // Any element's datetime attribute (<time>, GitHub's <relative-time>, …).
            const timeAttr = [...part.matchAll(/<[a-z][\w-]*\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/gi)].map(x => parseDateLike(x[1])).filter(Boolean);
            const text = stripTags(part);
            let dates = timeAttr.length ? timeAttr : datesInText(text);
            // Blogs often show "Oct. 2" with the year only in the post link:
            // /2026/10/02/slug/.
            if (!dates.length) {
                dates = [...part.matchAll(/href\s*=\s*["'][^"']*?\/(\d{4})\/(\d{2})\/(\d{2})\//gi)].map(x => ymd(+x[1], +x[2], +x[3])).filter(Boolean);
            }
            // A datetime attribute is markup for THIS element's own date; when
            // there are several (a release card with signed-commit footers),
            // the first in document order is the entry's — headers precede
            // bodies. Dates found in TEXT stay strict: two of them is a range
            // or a summary row, not an entry.
            const distinct = timeAttr.length ? [timeAttr[0]] : [...new Set(dates)];
            if (distinct.length !== 1) continue; // 0 = not an entry; 2+ = a range or a summary row
            const title = text.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+)?\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
            // The same entry rendered twice in one group (nested list items,
            // a mobile + desktop copy) must count once.
            const sig = `${distinct[0]}|${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;
            if (seenSig.has(sig)) continue;
            seenSig.add(sig);
            records.push({ date: distinct[0], title });
            spans.push([seg.start, seg.end]);
        }
        if (records.length < MIN_RECORDS) continue;
        // Size alone picks the wrong group: a footer repeated in every card
        // ("This commit was signed…", one date each) outnumbers the cards
        // themselves. Real entries have distinct titles; boilerplate does not.
        const heads = new Set(records.map(r => r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)));
        const diversity = heads.size / records.length;
        const semantic = /^(tr|li|article|section|item|entry)$/.test(g.kind) ? 1.15 : 1;
        scored.push({ kind: g.kind, records, spans, score: records.length * diversity * semantic, diversity });
    }
    // Parts of an entry are not entries: when most of a group's elements sit
    // INSIDE another group's elements, at no more than 3 per container (two
    // signed-commit footers per GitHub release section), the outer group is
    // the list. A few year sections that each hold hundreds of rows keep the
    // rows (more than 3 per container).
    const inside = (inner, outer) => {
        let j = 0, hit = 0;
        const outs = outer.spans;
        for (const [a, b] of inner.spans) {
            while (j < outs.length && outs[j][1] < b) j++;
            if (j < outs.length && outs[j][0] <= a && b <= outs[j][1]) hit++;
        }
        return hit / inner.spans.length;
    };
    for (const inner of scored) {
        for (const outer of scored) {
            if (outer === inner || outer.records.length < MIN_RECORDS) continue;
            if (inner.records.length <= outer.records.length * 3 && inside(inner, outer) >= 0.8) { inner.suppressed = true; break; }
        }
    }
    let best = null;
    for (const c of scored) if (!c.suppressed && (!best || c.score > best.score)) best = c;
    if (!best) return null;
    return { source: `html:${best.kind}`, records: best.records, dateField: best.kind, titleField: null, totalItems: best.records.length };
}

/**
 * The best set of dated records on a page.
 * @param {{html?:string, json?:any[], url?:string}} input  json = API responses / a JSON body
 */
function extractRecords({ html = '', json = [] } = {}) {
    const candidates = [];
    const api = recordsFromJsonDocs((json || []).filter(x => x && typeof x === 'object'), 'api-json');
    if (api) candidates.push(api);
    const embedded = recordsFromJsonDocs(jsonFromHtml(html), 'embedded-json');
    if (embedded) candidates.push(embedded);
    const rows = recordsFromHtml(html);
    if (rows) candidates.push(rows);
    if (!candidates.length) return null;
    // JSON wins over HTML rows unless the rows hold clearly more entries
    // (the JSON may be a "latest 10" widget).
    candidates.sort((a, b) => {
        const ja = a.source.endsWith('json') ? 1 : 0, jb = b.source.endsWith('json') ? 1 : 0;
        if (ja !== jb) {
            const [j, r] = ja ? [a, b] : [b, a];
            const jsonWins = j.records.length >= r.records.length * 0.9;
            return (ja ? -1 : 1) * (jsonWins ? 1 : -1);
        }
        return b.records.length - a.records.length;
    });
    const best = candidates[0];
    return { ...best, alternatives: candidates.slice(1).map(c => ({ source: c.source, records: c.records.length })) };
}

// ── counting ─────────────────────────────────────────────────────────────────
function isoWeek(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${pad(week)}`;
}
function periodKey(dateStr, groupBy) {
    const [y, mo] = dateStr.split('-');
    switch (groupBy) {
        case 'day': return dateStr;
        case 'week': return isoWeek(dateStr);
        case 'quarter': return `${y}-Q${Math.ceil(+mo / 3)}`;
        case 'year': return y;
        default: return `${y}-${mo}`;
    }
}
function periodLabel(key, groupBy) {
    if (groupBy === 'month') { const [y, mo] = key.split('-'); return `${MONTHS[+mo - 1]} ${y}`; }
    return key;
}
function nextPeriod(key, groupBy) {
    if (groupBy === 'year') return String(+key + 1);
    if (groupBy === 'quarter') { const [y, q] = key.split('-Q'); return +q === 4 ? `${+y + 1}-Q1` : `${y}-Q${+q + 1}`; }
    if (groupBy === 'month') { const [y, mo] = key.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`; }
    if (groupBy === 'day') { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
    // week
    const [y, w] = key.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const monday = new Date(jan4); monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7 + 7);
    return isoWeek(monday.toISOString().slice(0, 10));
}
/** "2026-01", "Jan 2026", "2026", "2026-01-15" → a full date at the start (or end) of that span. */
function boundDate(v, end) {
    if (!v) return null;
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (m) return end ? lastDay(+m[1], +m[2]) : ymd(+m[1], +m[2], 1);
    m = /^(\d{4})$/.exec(s);
    if (m) return end ? ymd(+m[1], 12, 31) : ymd(+m[1], 1, 1);
    const mon = monthIndex(s);
    m = /(\d{4})/.exec(s);
    if (mon && m) return end ? lastDay(+m[1], mon) : ymd(+m[1], mon, 1);
    return parseDateLike(s);
}
function lastDay(y, mo) { return ymd(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()); }

/**
 * Count records per period (or per field value).
 * @param {Array<{date:string,title?:string,fields?:object}>} records
 * @param {{groupBy?:string, field?:string, from?:string, to?:string, match?:string}} opts
 */
function tallyRecords(records, { groupBy = 'month', field = null, from = null, to = null, match = null } = {}) {
    const g = ['day', 'week', 'month', 'quarter', 'year', 'field'].includes(groupBy) ? groupBy : 'month';
    const lo = boundDate(from, false), hi = boundDate(to, true);
    const needle = match ? String(match).toLowerCase() : null;
    let outside = 0, unmatched = 0;
    const kept = [];
    for (const r of records || []) {
        if (needle) {
            const hay = `${r.title || ''} ${r.fields ? JSON.stringify(r.fields) : ''}`.toLowerCase();
            if (!hay.includes(needle)) { unmatched++; continue; }
        }
        if ((lo && r.date < lo) || (hi && r.date > hi)) { outside++; continue; }
        kept.push(r);
    }
    const counts = new Map();
    const samples = new Map();
    for (const r of kept) {
        let key;
        if (g === 'field') {
            const v = r.fields && field ? r.fields[field] : undefined;
            key = v == null || v === '' ? '(none)' : String(v).slice(0, 80);
        } else key = periodKey(r.date, g);
        counts.set(key, (counts.get(key) || 0) + 1);
        const s = samples.get(key) || [];
        if (r.title && s.length < 3) s.push(r.title);
        samples.set(key, s);
    }
    let keys;
    if (g === 'field') {
        keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    } else {
        // Every period across the range, zeros included — a chart needs them.
        const present = [...counts.keys()].sort();
        const start = lo ? periodKey(lo, g) : present[0];
        const stop = hi ? periodKey(hi, g) : present[present.length - 1];
        keys = [];
        if (start && stop) {
            for (let k = start, n = 0; n < 2000; n++) {
                keys.push(k);
                if (k >= stop) break;
                k = nextPeriod(k, g);
            }
        }
    }
    const rows = keys.map(k => ({ period: g === 'field' ? k : periodLabel(k, g), key: k, count: counts.get(k) || 0, ...(samples.get(k) && samples.get(k).length ? { examples: samples.get(k) } : {}) }));
    const dates = kept.map(r => r.date).sort();
    return {
        groupBy: g,
        total: kept.length,
        rows,
        earliest: dates[0] || null,
        latest: dates[dates.length - 1] || null,
        excludedOutsideRange: outside,
        ...(needle ? { excludedNoMatch: unmatched } : {}),
    };
}

module.exports = { extractRecords, tallyRecords, parseDateLike, datesInText, jsonFromHtml, boundDate };
