'use strict';
// Page content that a site ships as JSON inside its HTML.
//
// GitHub renders commits, a commit's diff, pull requests, issues and much of a
// repo through React, and the server sends that data in
// <script type="application/json" data-target="react-app.embeddedData">. The
// visible markup is a near-empty shell, so the fast fetch layer judged every
// such page "thin" and the cascade opened a real browser: 5–8 s per read
// (measured 2026-11-07; a repo audit read six of them, ~60 s), while a plain GET
// returns the same page in 0.5–0.8 s with all the data in that one block.
//
// extract(html) turns those blocks into readable lines. Only the marked block
// is read: a generic "any application/json script" rule would also pick up
// feature flags and analytics config that every page carries.

const BLOCK_RE = /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/g;

// Routes that describe the page chrome, not its content.
const SKIP_ROUTE = /LayoutRoute$|^csrf|^currentUser$/i;
// Fields that are identifiers, styling or UI plumbing.
const SKIP_KEY = /^(?:avatarUrl|ownerAvatar|globalId|globalRelayId|id|color|commitHeadShaChannel|.*Channel|csrf_tokens|currentUser|currentUserCan.*|.*Html|shortMessageMarkdownLink|nameHtml|titleHtml|isGitHub|hovercardUrl|ariaLabel|tabIndex|.*Url$|linkedIssueUrl|profileName|showPusherAttribution|committerAttribution|blobLineNumber|leftLineNumber|rightLineNumber|.*Expanded.*|.*Collapsed.*|toc|navigation|symbols|headerInfo|selectedPage|pageTitle|expanded|page|repository|refInfo|fileTree|treeExpanded|issueTemplate|discussionTemplate|csvError|renderedFileInfo|richTextTruncated)$/;
// Less than this is navigation or a header, not the page's content: the
// releases page carries only a table of contents (its notes are plain HTML),
// and letting that pass made the page look complete when it was not.
const MIN_CONTENT_CHARS = 400;

function stripMarkup(s) {
    return String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const OPAQUE = /^[A-Za-z0-9+/=_-]{48,}$/;

function renderDiff(entries, out, budget) {
    for (const e of entries) {
        if (out.len() > budget) break;
        const path = e.path || e.pathDigest || e.newTreeEntry?.path || '';
        const lines = Array.isArray(e.diffLines) ? e.diffLines : [];
        const adds = e.linesAdded ?? lines.filter(l => l && l.type === 'ADDITION').length;
        const dels = e.linesDeleted ?? lines.filter(l => l && l.type === 'DELETION').length;
        out.push(`--- ${path || '(file)'} (+${adds} −${dels})`);
        for (const l of lines) {
            if (!l || out.len() > budget) break;
            const text = stripMarkup(l.text || l.html || '');
            if (l.type === 'HUNK') out.push(text.trim());
            else out.push(text);
        }
    }
}

function render(value, out, indent, depth, budget) {
    if (out.len() > budget || depth > 7 || value == null) return;
    const pad = '  '.repeat(indent);
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 60)) {
            if (out.len() > budget) break;
            if (item && typeof item === 'object') {
                const start = out.lines.length;
                render(item, out, indent + 1, depth + 1, budget);
                if (out.lines.length > start) out.lines[start] = `${pad}- ${out.lines[start].trimStart()}`;
            } else if (item != null && item !== '') out.push(`${pad}- ${scalar(item)}`);
        }
        if (value.length > 60) out.push(`${pad}… ${value.length - 60} more`);
        return;
    }
    if (typeof value !== 'object') { out.push(`${pad}${scalar(value)}`); return; }
    for (const [k, v] of Object.entries(value)) {
        if (out.len() > budget) break;
        if (SKIP_KEY.test(k) || v == null || v === '' || v === false) continue;
        if (k === 'diffEntryData' && Array.isArray(v)) { renderDiff(v, out, budget); continue; }
        if (typeof v === 'object') {
            if (Array.isArray(v) && !v.length) continue;
            if (!Array.isArray(v) && !Object.keys(v).length) continue;
            // A one-field wrapper ({ value: "..." }) reads better inline.
            if (!Array.isArray(v) && Object.keys(v).length === 1 && typeof Object.values(v)[0] !== 'object') {
                out.push(`${pad}${k}: ${scalar(Object.values(v)[0])}`);
                continue;
            }
            out.push(`${pad}${k}:`);
            render(v, out, indent + 1, depth + 1, budget);
        } else {
            const s = scalar(v);
            if (!s || OPAQUE.test(s)) continue;
            out.push(`${pad}${k}: ${s}`);
        }
    }
}

function scalar(v) {
    let s = typeof v === 'string' ? stripMarkup(v) : String(v);
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

/**
 * Readable text of the content JSON embedded in a page, or '' when the page
 * carries none. `maxChars` bounds the output.
 */
function extract(html, maxChars = 12000) {
    const h = String(html || '');
    if (!h.includes('react-app.embeddedData')) return '';
    const lines = [];
    let size = 0;
    const out = { lines, push: (l) => { lines.push(l); size += l.length + 1; }, len: () => size };
    let m;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(h)) && size < maxChars) {
        let data;
        try { data = JSON.parse(m[1]); } catch (_) { continue; }
        const payload = data && data.payload;
        if (!payload || typeof payload !== 'object') continue;
        for (const [route, body] of Object.entries(payload)) {
            if (SKIP_ROUTE.test(route) || !body || typeof body !== 'object') continue;
            render(body, out, 0, 0, maxChars);
        }
    }
    const text = lines.join('\n');
    if (text.replace(/\s+/g, ' ').length < MIN_CONTENT_CHARS) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [page data truncated]` : text;
}

module.exports = { extract };
