import React from 'react';
import { Check, X, Loader2 } from 'lucide-react';

// Short verb phrase per tool. Two forms — running (present continuous)
// and done (past tense) — so the milestone line mutates in place as the
// call resolves: "Reading file · utils.js" → "Read · utils.js".
const VERBS = {
    web_search:        ['Searching the web',       'Searched'],
    fetch_url:         ['Fetching',                'Fetched'],
    crawl_pages:       ['Crawling',                'Crawled'],
    playwright_fetch:  ['Loading page',            'Loaded'],
    playwright_interact:['Interacting',            'Interacted'],
    scrapling_fetch:   ['Loading page',            'Loaded'],
    download_html:     ['Downloading page',        'Downloaded'],
    download_file:     ['Downloading',             'Downloaded'],
    http_request:      ['Requesting',              'Requested'],
    dns_lookup:        ['Resolving DNS',           'Resolved'],
    virustotal_lookup: ['Checking VirusTotal',     'Checked'],
    base64_decode:     ['Decoding',                'Decoded'],
    load_skill:        ['Loading skill',           'Loaded'],
    render_chart:      ['Rendering chart',         'Rendered'],
    fetch_timeseries:  ['Fetching data',           'Fetched'],
    read_file:         ['Reading',                 'Read'],
    head_file:         ['Reading head of',         'Read head of'],
    tail_file:         ['Reading tail of',         'Read tail of'],
    write_file:        ['Writing',                 'Wrote'],
    create_file:       ['Writing',                 'Wrote'],
    append_to_file:    ['Editing',                 'Edited'],
    replace_lines:     ['Editing',                 'Edited'],
    edit_file:         ['Editing',                 'Edited'],
    update_file:       ['Editing',                 'Edited'],
    move_file:         ['Moving',                  'Moved'],
    copy_file:         ['Copying',                 'Copied'],
    delete_file:       ['Deleting',                'Deleted'],
    delete_directory:  ['Deleting directory',      'Deleted directory'],
    list_directory:    ['Listing',                 'Listed'],
    grep_code:         ['Searching code',          'Searched code for'],
    outline_file:      ['Outlining',               'Outlined'],
    create_pdf:        ['Creating PDF',            'Created PDF'],
    create_docx:       ['Creating document',       'Created document'],
    create_xlsx:       ['Creating spreadsheet',    'Created spreadsheet'],
    read_xlsx:         ['Reading spreadsheet',     'Read spreadsheet'],
    query_sqlite:      ['Querying database',       'Queried database'],
    workspace_db:      ['Querying database',       'Queried database'],
    transform_image:   ['Editing image',           'Edited image'],
    transcribe_audio:  ['Transcribing audio',      'Transcribed audio'],
    extract_archive:   ['Extracting archive',      'Extracted'],
    tar_extract:       ['Extracting tar',          'Extracted'],
    unzip_file:        ['Extracting zip',          'Extracted'],
    send_file:         ['Sending file',            'Sent file'],
    run_python:        ['Running Python',          'Ran Python'],
    run_node:          ['Running Node',            'Ran Node'],
    run_bash:          ['Running bash',            'Ran bash'],
    run_npm:           ['Running npm',             'Ran npm'],
    make_downloadable: ['Preparing download',      'Prepared download'],
};

function humanize(name) {
    if (!name) return null;
    const pretty = name.replace(/_/g, ' ');
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function verbFor(name, done) {
    const v = VERBS[name];
    if (v) return v[done ? 1 : 0];
    const base = humanize(name) || '';
    return done ? `Ran ${base}` : `Running ${base}`;
}

// Pull the single most identifying value out of the args preview string
// the server produced (`"filePath: /workspace/x/utils.js, startLine: 0..."`).
// We don't have structured args here, so cheap regex extraction.
function extractSubject(tc) {
    const q = String(tc.query || '');
    if (!q) return '';
    // URL → hostname (+ short path tail)
    const url = q.match(/https?:\/\/[^\s,]+/);
    if (url) {
        try {
            const u = new URL(url[0]);
            const tail = u.pathname.replace(/\/$/, '');
            const last = tail.split('/').filter(Boolean).slice(-1)[0] || '';
            return last ? `${u.hostname} / ${last}` : u.hostname;
        } catch { /* fall through */ }
    }
    // path-shaped argument → basename
    const pathArg = q.match(/(?:filePath|tarPath|zipPath|sourcePath|path|file)\s*:\s*([^,\s]+)/i);
    if (pathArg) {
        const p = pathArg[1].replace(/['"]/g, '');
        const base = p.split('/').pop();
        return base || p;
    }
    // pattern / query / search text
    const txt = q.match(/(?:query|pattern|search|q|text)\s*:\s*([^,]+)/i);
    if (txt) {
        let v = txt[1].trim().replace(/^['"]|['"]$/g, '');
        if (v.length > 48) v = v.slice(0, 48) + '…';
        return `"${v}"`;
    }
    // archiveId / id → short hash
    const id = q.match(/(?:archiveId|id)\s*:\s*([a-f0-9]{6,})/i);
    if (id) return id[1].slice(0, 8);
    // First k:v pair as a generic fallback
    const first = q.match(/^([a-z_]+)\s*:\s*([^,]{1,60})/i);
    if (first) {
        let v = first[2].trim().replace(/^['"]|['"]$/g, '');
        if (v.length > 60) v = v.slice(0, 60) + '…';
        return v;
    }
    return '';
}

// Tiny extra factoid we can pull from a successful tool's preview text
// to make the done-line more informative (e.g. "Extracted 6 items").
function doneDetail(tc) {
    const pv = String(tc.preview || '').trim();
    if (!pv) return '';
    const m1 = pv.match(/Extracted\s+(\d+)\s+(?:items?|files?)/i);
    if (m1) return `${m1[1]} ${m1[1] === '1' ? 'item' : 'items'}`;
    const m2 = pv.match(/(\d+)\s+(?:hits?|matches?|results?)/i);
    if (m2) return `${m2[1]} ${m2[1] === '1' ? 'hit' : 'hits'}`;
    return '';
}

// Collapse consecutive same-name calls into a single line carrying the
// LAST subject + a count badge. A group with any running call shows the
// running spinner; any failed call flips the whole group to failed;
// otherwise it's a completed group. Keeps long sequences from spamming
// the bubble (e.g. 5× "Ran Git show commit · 55f6e21…" → one line ×5).
function groupMilestones(toolCalls) {
    const groups = [];
    for (const tc of toolCalls) {
        const name = tc.label || tc.name || tc.type || 'tool';
        const last = groups[groups.length - 1];
        if (last && last.name === name) {
            last.calls.push(tc);
        } else {
            groups.push({ name, calls: [tc] });
        }
    }
    return groups;
}

export default function ToolMilestones({ toolCalls }) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
    const groups = groupMilestones(toolCalls);

    return (
        <div
            className="tool-milestones"
            aria-live="polite"
            style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                marginBottom: 8,
                paddingLeft: 2,
            }}
        >
            {groups.map((g, i) => {
                const count = g.calls.length;
                const anyRunning = g.calls.some(c => !(c.status === 'success' || c.status === 'failed'));
                const anyFailed  = g.calls.some(c => c.status === 'failed');
                const running = anyRunning;
                const failed  = !running && anyFailed;
                const done    = !running && !failed;
                const last = g.calls[g.calls.length - 1];
                const name = g.name;
                const verb = verbFor(name, done || failed);
                const subject = extractSubject(last);
                const detail = done && count === 1 ? doneDetail(last) : '';
                const totalMs = (done || failed)
                    ? g.calls.reduce((a, c) => a + (c.durationMs || 0), 0)
                    : 0;
                const dur = totalMs > 0
                    ? `${totalMs < 1000 ? totalMs + 'ms' : (totalMs / 1000).toFixed(1) + 's'}`
                    : '';

                return (
                    <div
                        key={i}
                        className="tool-milestone-line"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12,
                            color: failed ? 'var(--ink-3)' : done ? 'var(--ink-3)' : 'var(--ink-2)',
                            opacity: done ? 0.78 : 1,
                            lineHeight: 1.4,
                        }}
                    >
                        <span style={{
                            display: 'inline-flex',
                            width: 14, height: 14,
                            alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            {running ? (
                                <Loader2
                                    style={{ width: 11, height: 11, color: 'var(--accent, #6366f1)' }}
                                    strokeWidth={2.25}
                                    className="animate-spin"
                                />
                            ) : failed ? (
                                <X style={{ width: 11, height: 11, color: 'var(--danger, #ef4444)' }} strokeWidth={2.5} />
                            ) : (
                                <Check style={{ width: 11, height: 11, color: 'var(--ok, #10b981)' }} strokeWidth={2.5} />
                            )}
                        </span>
                        <span style={{ fontWeight: running ? 500 : 400 }}>{verb}</span>
                        {count > 1 && (
                            <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                padding: '0 6px',
                                height: 15,
                                borderRadius: 7,
                                background: 'color-mix(in oklab, var(--accent, #6366f1) 14%, transparent)',
                                color: 'var(--accent, #6366f1)',
                                fontSize: 10.5,
                                fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums',
                            }}>×{count}</span>
                        )}
                        {subject && (
                            <>
                                <span style={{ color: 'var(--ink-4)' }}>·</span>
                                <span
                                    style={{
                                        color: 'var(--ink-2)',
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11.5,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        maxWidth: 420,
                                    }}
                                    title={subject}
                                >
                                    {subject}
                                </span>
                            </>
                        )}
                        {detail && (
                            <>
                                <span style={{ color: 'var(--ink-4)' }}>·</span>
                                <span style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>{detail}</span>
                            </>
                        )}
                        {dur && (
                            <span style={{ color: 'var(--ink-4)', fontSize: 11, marginLeft: 'auto' }}>{dur}</span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
