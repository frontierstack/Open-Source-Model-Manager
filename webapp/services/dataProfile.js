'use strict';
// Data profile pre-flight: what the model needs to know about a CSV/TSV/XLSX
// BEFORE it writes analysis code.
//
// Measured (2026-11-06): data-analysis turns over an uploaded app-console CSV
// took 9 and 13 tool calls; run_python ran 7 and 10 times. The model opened
// the file with read_file, guessed the layout, hand-parsed it with
// csv.DictReader + strptime and crashed on what it had not seen: a title row
// above the header, US dates, "1,234" thousands separators, blank cells, a
// trailing "Total" row (IndexError, ZeroDivisionError, ValueError on dates),
// then rewrote the script each time. This module reads the file once,
// server-side, and states those facts plus a pandas loader line that already
// handles them, so the first script can be the right one.
//
// profileTable(rows, opts)  → profile of an array-of-arrays table
// profileFile(path)         → reads csv/tsv/txt/xlsx/xls from disk
// renderProfileNote(p, workspacePath) → the text the model sees

const fs = require('fs');
const path = require('path');

const MAX_BYTES = parseInt(process.env.DATA_PROFILE_MAX_BYTES, 10) || 64 * 1024 * 1024;
const SAMPLE_ROWS = 5000;          // rows inspected for types/formats
const MAX_COLS_SHOWN = 30;

// ---------------------------------------------------------------- CSV parsing

function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 30);
    let best = ',', bestScore = -1;
    for (const d of [',', '\t', ';', '|']) {
        const counts = lines.map(l => splitCsvLine(l, d).length);
        // The delimiter that gives the most rows with the SAME (>1) column count.
        const freq = new Map();
        for (const c of counts) if (c > 1) freq.set(c, (freq.get(c) || 0) + 1);
        let score = 0;
        for (const [cols, n] of freq) score = Math.max(score, n * 100 + cols);
        if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
}

function splitCsvLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
            } else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

// Full parse that respects quoted newlines.
function parseCsv(text, delim) {
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
            } else cur += ch;
            continue;
        }
        if (ch === '"') { q = true; continue; }
        if (ch === delim) { row.push(cur); cur = ''; continue; }
        if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); rows.push(row); row = []; cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

// ---------------------------------------------------------- value inference

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
// Each candidate: test regex → strptime/pandas format. Order matters only for
// display; the format that fits ALL non-empty samples wins.
const DATE_FORMATS = [
    { re: /^\d{4}-\d{2}-\d{2}$/, fmt: '%Y-%m-%d' },
    { re: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, fmt: 'ISO8601' },
    { re: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/, fmt: '%Y-%m-%d %H:%M' },
    { re: /^\d{4}\/\d{1,2}\/\d{1,2}$/, fmt: '%Y/%m/%d' },
    { re: /^\d{1,2}\/\d{1,2}\/\d{4}$/, fmt: 'MDY/' },        // resolved below
    { re: /^\d{1,2}\/\d{1,2}\/\d{2}$/, fmt: 'MDy/' },
    { re: /^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}(:\d{2})?$/, fmt: 'MDYT/' },
    { re: /^\d{1,2}\.\d{1,2}\.\d{4}$/, fmt: '%d.%m.%Y' },
    { re: /^\d{1,2}-\d{1,2}-\d{4}$/, fmt: 'MDY-' },
    { re: new RegExp(`^\\d{1,2}[ -](${MONTHS})[a-z]*[ -,]+\\d{4}$`, 'i'), fmt: '%d %b %Y' },
    { re: new RegExp(`^(${MONTHS})[a-z]* \\d{1,2},? \\d{4}$`, 'i'), fmt: '%b %d, %Y' },
    { re: /^\d{4}-\d{2}$/, fmt: '%Y-%m' },
    { re: /^\d{8}$/, fmt: '%Y%m%d' },
];

function resolveDayMonth(values, sep, yearFmt, withTime) {
    // Decide month-first vs day-first from the values themselves.
    let firstOver12 = false, secondOver12 = false;
    for (const v of values) {
        const [a, b] = v.split(sep).map(Number);
        if (a > 12) firstOver12 = true;
        if (b > 12) secondOver12 = true;
    }
    const s = sep;
    const time = withTime ? ' %H:%M' : '';
    if (firstOver12 && !secondOver12) return { fmt: `%d${s}%m${s}${yearFmt}${time}`, ambiguous: false };
    if (secondOver12 && !firstOver12) return { fmt: `%m${s}%d${s}${yearFmt}${time}`, ambiguous: false };
    return { fmt: `%m${s}%d${s}${yearFmt}${time}`, ambiguous: true };
}

function inferDate(values) {
    if (!values.length) return null;
    for (const cand of DATE_FORMATS) {
        if (!values.every(v => cand.re.test(v))) continue;
        let fmt = cand.fmt, ambiguous = false;
        if (fmt === 'MDY/') ({ fmt, ambiguous } = resolveDayMonth(values, '/', '%Y'));
        else if (fmt === 'MDy/') ({ fmt, ambiguous } = resolveDayMonth(values, '/', '%y'));
        else if (fmt === 'MDYT/') ({ fmt, ambiguous } = resolveDayMonth(values.map(v => v.split(' ')[0]), '/', '%Y', true));
        else if (fmt === 'MDY-') ({ fmt, ambiguous } = resolveDayMonth(values, '-', '%Y'));
        // Seconds in a "M/D/Y H:M:S" stamp.
        if (/%H:%M$/.test(fmt) && values.some(v => /\d:\d{2}:\d{2}$/.test(v))) fmt += ':%S';
        return { fmt, ambiguous };
    }
    return null;
}

const NUM_RE = /^[-+(]?\s*[$€£¥₹]?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*%?\)?$/;
// European style: "1.234,5" / "980,25" (decimal comma, dot thousands).
const NUM_EU_RE = /^[-+(]?\s*[$€£¥₹]?\s*(\d{1,3}(\.\d{3})+|\d+)(,\d+)?\s*%?\)?$/;
function parseNumber(v, eu = false) {
    let s = v.trim();
    const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
    s = s.replace(/[()$€£¥₹%+\s-]/g, '');
    s = eu ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function isBlank(v) { return v == null || String(v).trim() === '' || /^(na|n\/a|null|none|nan|-|—)$/i.test(String(v).trim()); }

// ------------------------------------------------------------------ profile

function findHeader(rows) {
    // The header is the first row, within the first 15, whose width equals the
    // table's dominant width and which is mostly non-numeric text.
    const widths = new Map();
    for (const r of rows.slice(0, 200)) {
        const w = r.filter(c => !isBlank(c)).length > 0 ? r.length : 0;
        if (w > 1) widths.set(w, (widths.get(w) || 0) + 1);
    }
    let width = 0, best = 0;
    for (const [w, n] of widths) if (n > best) { best = n; width = w; }
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const r = rows[i];
        if (r.length !== width) continue;
        const filled = r.filter(c => !isBlank(c));
        if (filled.length < Math.max(2, Math.ceil(width * 0.6))) continue;
        const textual = filled.filter(c => !NUM_RE.test(String(c).trim()) && !inferDate([String(c).trim()])).length;
        if (textual / filled.length >= 0.7) return { index: i, width };
    }
    return { index: 0, width: width || (rows[0] ? rows[0].length : 0) };
}

const TOTAL_RE = /^(grand )?totals?$|^sum$|^all$|^overall$|^subtotal$/i;

function profileTable(rows, { sheet = null, sourceRows = null } = {}) {
    const clean = rows.map(r => (Array.isArray(r) ? r : []).map(c => (c == null ? '' : String(c))));
    const { index: headerIdx, width } = findHeader(clean);
    const header = (clean[headerIdx] || []).map((h, i) => (h.trim() || `Unnamed: ${i}`));
    let body = clean.slice(headerIdx + 1);
    // Trailing blank rows are noise; blank rows inside are reported.
    while (body.length && body[body.length - 1].every(isBlank)) body.pop();
    const blankRows = body.filter(r => r.every(isBlank)).length;
    body = body.filter(r => !r.every(isBlank));
    // Footer rows: a "Total"-like first cell in the last 3 rows.
    const footer = [];
    for (let k = Math.max(0, body.length - 3); k < body.length; k++) {
        const first = (body[k].find(c => !isBlank(c)) || '').trim();
        if (TOTAL_RE.test(first)) footer.push(k);
    }
    const dataRows = body.filter((_, k) => !footer.includes(k));
    const ragged = dataRows.filter(r => r.length !== width).length;
    const sample = dataRows.slice(0, SAMPLE_ROWS);

    let thousands = false, currency = false, percent = false, decimalComma = false;
    const columns = header.map((name, ci) => {
        const vals = sample.map(r => (r[ci] == null ? '' : String(r[ci]).trim()));
        const filled = vals.filter(v => !isBlank(v));
        const blanks = vals.length - filled.length;
        const col = { name, blanks, filled: filled.length };
        if (!filled.length) { col.type = 'empty'; return col; }
        const date = inferDate(filled);
        if (date) {
            col.type = 'date';
            col.format = date.fmt;
            if (date.ambiguous) col.ambiguous = true;
            const sorted = [...filled].sort();
            col.first = filled[0]; col.last = filled[filled.length - 1];
            col.examples = [sorted[0], sorted[sorted.length - 1]];
            return col;
        }
        // Decimal comma only when some value actually has one (",5"), and none
        // reads as US thousands ("1,234" with exactly 3 digits after).
        const eu = !filled.every(v => NUM_RE.test(v)) && filled.every(v => NUM_EU_RE.test(v)) && filled.some(v => /,\d+\s*%?\)?$/.test(v));
        if (eu) {
            const nums = filled.map(v => parseNumber(v, true)).filter(n => n != null);
            col.type = 'decimal'; col.decimalComma = true; decimalComma = true;
            if (filled.some(v => /\d\.\d{3}/.test(v))) col.dotThousands = true;
            col.min = Math.min(...nums); col.max = Math.max(...nums);
            col.sum = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
            return col;
        }
        if (filled.every(v => NUM_RE.test(v))) {
            const nums = filled.map(v => parseNumber(v)).filter(n => n != null);
            col.type = nums.every(n => Number.isInteger(n)) ? 'integer' : 'decimal';
            if (filled.some(v => /\d,\d{3}/.test(v))) { col.thousands = true; thousands = true; }
            if (filled.some(v => /[$€£¥₹]/.test(v))) { col.currency = true; currency = true; }
            if (filled.some(v => /%/.test(v))) { col.percent = true; percent = true; }
            col.min = Math.min(...nums); col.max = Math.max(...nums);
            col.sum = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
            return col;
        }
        col.type = 'text';
        const counts = new Map();
        for (const v of filled) counts.set(v, (counts.get(v) || 0) + 1);
        col.unique = counts.size;
        col.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([v, n]) => `${v.slice(0, 40)} (${n})`);
        return col;
    });

    return {
        sheet,
        headerRow: headerIdx,           // 0-based index of the header line
        skipRows: headerIdx,            // lines above the header
        preamble: clean.slice(0, headerIdx).map(r => r.filter(c => !isBlank(c)).join(' ').slice(0, 120)).filter(Boolean),
        rows: dataRows.length,
        totalRows: sourceRows != null ? sourceRows : clean.length,
        blankRows,
        footerRows: footer.map(k => (body[k].find(c => !isBlank(c)) || '').trim()),
        ragged,
        width,
        thousands, currency, percent, decimalComma,
        columns,
        head: dataRows.slice(0, 3).map(r => r.slice(0, MAX_COLS_SHOWN)),
    };
}

function profileFile(file) {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES || st.size === 0) return null;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
        let XLSX;
        try { XLSX = require('@e965/xlsx'); } catch (_) { try { XLSX = require('xlsx'); } catch (_e) { return null; } }
        const wb = XLSX.readFile(file, { cellDates: true, sheetRows: SAMPLE_ROWS + 50 });
        const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        const sheets = wb.SheetNames.slice(0, 4).map((name) => {
            // RAW cell values: a real number cell stays a number (read_excel
            // returns it as one), so a "$1,200" seen here is genuinely text.
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true })
                .map(r => r.map(c => (c instanceof Date ? iso(c) : c)));
            if (!rows.length) return null;
            return profileTable(rows, { sheet: name });
        }).filter(Boolean);
        if (!sheets.length) return null;
        return { kind: 'excel', file, bytes: st.size, sheetNames: wb.SheetNames, sheets, delimiter: null };
    }
    // Text table.
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    let encoding = 'utf-8';
    if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); encoding = 'utf-8-sig'; }
    if (len < st.size) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const delim = ext === '.tsv' ? '\t' : detectDelimiter(text);
    const rows = parseCsv(text, delim);
    if (rows.length < 2) return null;
    let lineCount = null;
    if (len < st.size) {
        // Count the rest without parsing (row count of a big file).
        lineCount = 0;
        const all = fs.readFileSync(file);
        for (let i = 0; i < all.length; i++) if (all[i] === 10) lineCount++;
    }
    const p = profileTable(rows, { sourceRows: lineCount });
    if (p.width < 2) return null;
    return { kind: 'text', file, bytes: st.size, delimiter: delim, encoding, truncatedRead: len < st.size, sheets: [p] };
}

// --------------------------------------------------------------- rendering

function pyStr(s) { return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

function loaderLines(prof, wsPath, sheet) {
    const p = sheet;
    const args = [];
    if (prof.kind === 'excel') {
        args.push(pyStr(wsPath));
        if (prof.sheetNames.length > 1) args.push(`sheet_name=${pyStr(p.sheet)}`);
        if (p.skipRows) args.push(`skiprows=${p.skipRows}`);
        if (p.thousands && !p.currency && !p.percent) args.push(`thousands=','`);
    } else {
        args.push(pyStr(wsPath));
        if (prof.delimiter !== ',') args.push(`sep=${prof.delimiter === '\t' ? "'\\t'" : pyStr(prof.delimiter)}`);
        if (p.skipRows) args.push(`skiprows=${p.skipRows}`);
        if (p.decimalComma) {
            args.push(`decimal=','`);
            if (p.columns.some(c => c.dotThousands)) args.push(`thousands='.'`);
        } else if (p.thousands) args.push(`thousands=','`);
        if (prof.encoding === 'utf-8-sig') args.push(`encoding='utf-8-sig'`);
        if (p.blankRows) args.push('skip_blank_lines=True');
    }
    const lines = [`df = pd.${prof.kind === 'excel' ? 'read_excel' : 'read_csv'}(${args.join(', ')})`];
    if (p.footerRows.length) {
        const first = p.columns[0] && p.columns[0].name;
        lines.push(`df = df[~df[${pyStr(first)}].astype(str).str.strip().str.lower().isin([${p.footerRows.map(f => pyStr(f.toLowerCase())).join(', ')}])]  # drop the ${p.footerRows.join('/')} row`);
    }
    for (const c of p.columns) {
        if (c.type === 'date') {
            lines.push(c.format === 'ISO8601'
                ? `df[${pyStr(c.name)}] = pd.to_datetime(df[${pyStr(c.name)}], format='ISO8601')`
                : `df[${pyStr(c.name)}] = pd.to_datetime(df[${pyStr(c.name)}], format=${pyStr(c.format)})`);
        }
        if ((c.type === 'integer' || c.type === 'decimal') && (c.currency || c.percent || (prof.kind === 'excel' && c.thousands))) {
            lines.push(`df[${pyStr(c.name)}] = pd.to_numeric(df[${pyStr(c.name)}].astype(str).str.replace(r'[^0-9.\\-]', '', regex=True), errors='coerce')`);
        }
    }
    return lines;
}

function describeColumn(c) {
    const bl = c.blanks ? `, ${c.blanks} blank` : '';
    if (c.type === 'date') return `${c.name}: date, format ${c.format}${c.ambiguous ? ' (day/month order ambiguous — month-first assumed)' : ''}, ${c.first} … ${c.last}${bl}`;
    if (c.type === 'integer' || c.type === 'decimal') {
        const marks = [c.decimalComma && 'a decimal COMMA ("980,5")', c.thousands && '"1,234" thousands separators', c.currency && 'currency symbols', c.percent && '% signs (the cleanup below keeps 12% as 12)'].filter(Boolean);
        return `${c.name}: ${c.type}, ${c.min} … ${c.max}${marks.length ? `, written with ${marks.join(' and ')}` : ''}${bl}`;
    }
    if (c.type === 'text') return `${c.name}: text, ${c.unique} distinct${c.unique <= 12 ? ` (${c.top.join(', ')})` : ` e.g. ${c.top.slice(0, 2).join(', ')}`}${bl}`;
    return `${c.name}: empty`;
}

function renderProfileNote(prof, wsPath) {
    if (!prof || !prof.sheets.length) return '';
    const parts = [];
    const sheets = prof.sheets.slice(0, prof.kind === 'excel' ? 3 : 1);
    parts.push(`Data profile of ${wsPath} (${prof.kind === 'excel' ? `Excel, sheets: ${prof.sheetNames.join(', ')}` : prof.delimiter === '\t' ? 'tab-separated' : prof.delimiter === ',' ? 'CSV' : `delimiter "${prof.delimiter}"`}), read by the server so you do not have to inspect it:`);
    for (const p of sheets) {
        const quirks = [];
        if (p.skipRows) quirks.push(`${p.skipRows} line(s) above the header (${p.preamble.join(' | ') || 'blank'}) — skip them`);
        if (p.footerRows.length) quirks.push(`a trailing "${p.footerRows.join('", "')}" row — drop it before aggregating`);
        if (p.blankRows) quirks.push(`${p.blankRows} blank row(s)`);
        if (p.ragged) quirks.push(`${p.ragged} row(s) with a different column count`);
        const head = p.sheet ? `Sheet "${p.sheet}": ` : '';
        parts.push(`${head}${p.rows.toLocaleString()} data rows × ${p.columns.length} columns.${quirks.length ? ' Watch out for: ' + quirks.join('; ') + '.' : ''}`);
        parts.push('Columns:\n' + p.columns.slice(0, MAX_COLS_SHOWN).map(c => '- ' + describeColumn(c)).join('\n') +
            (p.columns.length > MAX_COLS_SHOWN ? `\n- … ${p.columns.length - MAX_COLS_SHOWN} more` : ''));
        parts.push('Load it with pandas (installed in run_python) exactly like this — it already handles the points above:\n' +
            'import pandas as pd\n' + loaderLines(prof, wsPath, p).join('\n'));
    }
    if (sheets.some(p => p.columns.some(c => /[^A-Za-z0-9_]/.test(c.name)))) {
        parts.push('Column names contain spaces or symbols: always index them as df[\'Column Name\'] — never as attributes (row.Column_Name, df.Column) and never via itertuples(), which renames them.');
    }
    parts.push('Do all the analysis in ONE run_python script that loads the file this way, computes every number the user asked for and prints them; do not read_file the data or parse it by hand with csv/strptime. Chart from the printed numbers with render_chart.');
    return parts.join('\n');
}

module.exports = { profileFile, profileTable, renderProfileNote, parseCsv, detectDelimiter, inferDate, loaderLines };
