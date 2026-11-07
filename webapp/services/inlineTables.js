'use strict';
// Large tables attached to a chat message are inlined by the client as
//   === FILE n: name.csv (8,154 bytes …) ===\n<every row>\n=== END FILE n ===
// The model analyses them with run_python on the copy in /workspace/uploads/
// anyway, so the full text only costs prefill: the Appstats turn
// (2026-11-07) carried 51.7k chars of CSV — three files attached twice as
// "- Copy" — and its first request was 58k tokens, 95 s of prefill on the 27B
// before the model wrote a word.
//
// condense(text, { fileExists }) keeps a small table whole, cuts a large one
// to its header + first and last rows with a pointer to the file on disk, and
// replaces an exact duplicate of an earlier block with a one-line reference.
// Deterministic (same input → same bytes), so earlier turns stay byte-stable
// for the prompt cache.

const crypto = require('crypto');

const TABLE_NAME_RE = /\.(?:csv|tsv)\b/i;
const BLOCK_RE = /=== FILE (\d+): ([^\n]*?) ===\n([\s\S]*?)\n=== END FILE \1 ===/g;
const MAX_INLINE_CHARS = parseInt(process.env.INLINE_TABLE_MAX_CHARS, 10) || 4000;
const HEAD_ROWS = 12;
const TAIL_ROWS = 3;

// The display name in the header ("Paid and direct.csv (8,154 bytes …)") →
// the filename part.
function fileNameOf(header) {
    const m = /^(.*?\.(?:csv|tsv))\b/i.exec(header);
    return m ? m[1].trim() : header.trim();
}

/**
 * @param {string} text
 * @param {{ fileExists: (name: string) => string|null, maxChars?: number }} opts
 *   fileExists(displayName) → the /workspace path of the uploaded copy, or
 *   null when it is not on disk (then the block is left whole).
 * @returns {{ text: string, condensed: number, duplicates: number, savedChars: number }}
 */
function condense(text, { fileExists, maxChars = MAX_INLINE_CHARS } = {}) {
    if (typeof text !== 'string' || !text.includes('=== FILE ') || typeof fileExists !== 'function') {
        return { text, condensed: 0, duplicates: 0, savedChars: 0 };
    }
    const seen = new Map();   // content hash → file number
    let condensed = 0, duplicates = 0;
    const out = text.replace(BLOCK_RE, (whole, num, header, body) => {
        if (!TABLE_NAME_RE.test(header)) return whole;
        const name = fileNameOf(header);
        const hash = crypto.createHash('sha1').update(body).digest('hex');
        const earlier = seen.get(hash);
        if (earlier == null) seen.set(hash, num);
        const path = fileExists(name);
        if (!path) return whole;
        if (earlier != null && body.length > 200) {
            duplicates++;
            return `=== FILE ${num}: ${header} ===\n[Identical to FILE ${earlier} — same data. On disk at ${path}.]\n=== END FILE ${num} ===`;
        }
        if (body.length <= maxChars) return whole;
        const lines = body.split('\n');
        if (lines.length <= HEAD_ROWS + TAIL_ROWS + 2) return whole;
        condensed++;
        const head = lines.slice(0, HEAD_ROWS);
        const tail = lines.slice(-TAIL_ROWS);
        const cut = lines.length - HEAD_ROWS - TAIL_ROWS;
        return `=== FILE ${num}: ${header} ===\n${head.join('\n')}\n` +
            `[… ${cut} more lines not shown here — ${lines.length} lines in all. The complete file is at ${path}: ` +
            `read it with run_python (pandas) for any number, total or chart, never from these sample rows.]\n` +
            `${tail.join('\n')}\n=== END FILE ${num} ===`;
    });
    return { text: out, condensed, duplicates, savedChars: text.length - out.length };
}

module.exports = { condense, fileNameOf, MAX_INLINE_CHARS };
