'use strict';

// render_chart argument normalization. The tool does no I/O: it validates the
// model's chart arguments and echoes back a `chartSpec` the chat renders with
// Recharts (chat/src/components/chat/ChartBlock.jsx).
//
// Why this is stricter than "echo it back": a model asked for "a line and bar
// graph" sent series [{name:"Breaches", type:"bar", dataKey:"breaches"},
// {name:"Cumulative", type:"line", dataKey:"breaches", cumulative:true}] —
// the old tool kept only `name`, so the line vanished, the series names
// matched no row key, and the tool still reported success while the model
// told the user the chart showed a cumulative line. Now per-series marks,
// data keys and running totals are honoured, and a series that plots a key
// the rows do not have is an ERROR the model can fix.

const TYPES = ['line', 'bar', 'area', 'pie', 'scatter', 'combo'];
const MARKS = ['bar', 'line', 'area'];
const MAX_POINTS = 1000;
const X_KEYS = ['x', 'date', 'label', 'month', 'period', 'time', 'year', 'name', 'category'];

function rowKeys(data) {
    const keys = new Set();
    for (const row of data.slice(0, 50)) if (row && typeof row === 'object') for (const k of Object.keys(row)) keys.add(k);
    return [...keys];
}

function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
    return null;
}

// Resolve a series' key against the row keys: exact, then case/punctuation-
// insensitive ("Breaches" → "breaches", "new_posts" → "newPosts").
function resolveKey(want, keys) {
    if (!want) return null;
    if (keys.includes(want)) return want;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const w = norm(want);
    const hit = keys.filter(k => norm(k) === w);
    return hit.length === 1 ? hit[0] : null;
}

function xKeyOf(data, keys) {
    const sample = data.find(r => r && typeof r === 'object') || {};
    for (const k of X_KEYS) if (k in sample) return k;
    // First non-numeric key, else the first key.
    const nonNum = keys.find(k => toNumber(sample[k]) === null);
    return nonNum || keys[0] || 'x';
}

// A running total only when the user asked for one. "A line and bar graph"
// means a line TRACING THE BAR TOPS (user, 2026-10-05: "the line should be
// lined up at the top of the bars and flow in the trending direction"); a
// cumulative line on a second axis floats above the bars and reads as noise.
const CUMULATIVE_ASK_RE = /\b(cumulative|running (?:total|sum|count)|accumulat\w*|total so far|to date|year[- ]to[- ]date|ytd|grand total over time)\b/i;

const LINE_ON_BARS_RE = /\b(line (?:on|over|at|along|into|in|across|through|on top of) (?:the )?(?:top of )?(?:the )?bars?|line and bars?|bars? and (?:a )?line|line(?:\s*\+\s*|\s*\/\s*)bar|bar(?:\s*\+\s*|\s*\/\s*)line|combo)\b/i;

function normalizeChartArgs(args, opts = {}) {
    const askText = String(opts.askText || '');
    const userWantsCumulative = !askText || CUMULATIVE_ASK_RE.test(askText);
    const notes = [];
    let type = String(args?.type || '').toLowerCase();
    if (type === 'composed' || type === 'mixed' || type === 'bar+line' || type === 'barline') type = 'combo';
    if (!TYPES.includes(type)) {
        return { error: `Unsupported chart type "${args?.type}". Use line, bar, area, pie, scatter, or combo (bars + line).` };
    }
    let data = Array.isArray(args?.data) ? args.data.filter(r => r && typeof r === 'object' && !Array.isArray(r)) : null;
    if (!data || data.length === 0) return { error: 'data must be a non-empty array of row objects.' };
    // Hard cap to keep the tool_result SSE event under the 32 KB
    // serialization cap that gates structured payload shipping.
    const truncated = data.length > MAX_POINTS;
    data = (truncated ? data.slice(0, MAX_POINTS) : data).map(r => ({ ...r }));
    const keys = rowKeys(data);

    let series = null;
    if (Array.isArray(args?.series) && args.series.length && type !== 'pie' && type !== 'scatter') {
        const errors = [];
        series = [];
        const usedKeys = new Set(keys);
        // Legend-only names (series [{name:"Close"}] over rows {x, y}): when NO
        // series names a row key, map them in order onto the numeric columns,
        // as the renderer always did — only when the counts line up.
        const raws = args.series.filter(r => r && typeof r === 'object');
        const xk = xKeyOf(data, keys);
        const numericKeys = keys.filter(k => k !== xk && data.some(r => toNumber(r[k]) !== null));
        const noneResolve = raws.every(r => !resolveKey(['dataKey', 'key', 'y', 'field', 'column', 'value'].map(k => r[k]).find(v => typeof v === 'string' && v) || r.name, keys));
        const byOrder = noneResolve && raws.length === numericKeys.length;
        args.series.forEach((raw, i) => {
            if (!raw || typeof raw !== 'object') return;
            const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim()
                : (typeof raw.dataKey === 'string' ? raw.dataKey : `Series ${i + 1}`);
            // Models spell the row key several ways: dataKey, key, y, field, column.
            const alias = ['dataKey', 'key', 'y', 'field', 'column', 'value'].map(k => raw[k]).find(v => typeof v === 'string' && v);
            const want = alias || name;
            const key = resolveKey(want, keys) || resolveKey(name, keys) || (byOrder ? numericKeys[raws.indexOf(raw)] : null);
            if (!key) {
                errors.push(`series "${name}" plots "${want}", which no row has`);
                return;
            }
            let mark = String(raw.type || raw.mark || '').toLowerCase();
            if (!MARKS.includes(mark)) mark = null;
            const out = { name, dataKey: key };
            let wantsCumulative = raw.cumulative === true;
            // A precomputed running-total column ("cumulative") counts too.
            const precomputed = !wantsCumulative && /cumul|running|total/i.test(key) && /cumul|running/i.test(`${key} ${name}`);
            if ((wantsCumulative || precomputed) && !userWantsCumulative) {
                // Trace the bars instead: the first numeric key another series
                // (a bar) plots, else this series' own source key.
                const barKey = (args.series || []).map(x => x && (['dataKey', 'key', 'y', 'field', 'column', 'value'].map(k => x[k]).find(v => typeof v === 'string' && v) || x.name))
                    .map(k => resolveKey(k, keys)).find(k => k && k !== key && !/cumul|running/i.test(k));
                notes.push(`"${name}" was a running total, but the user did not ask for one — it now traces the ${barKey || key} values (the tops of the bars).`);
                if (barKey) out.dataKey = barKey;
                if (/cumul|running|total/i.test(out.name)) out.name = 'Trend';
                wantsCumulative = false;
                out.traceOfBars = true;
            }
            if (wantsCumulative) {
                // Running total, stored in its own column so the chart and the
                // tooltip show it like any other value.
                let col = `${key}_cumulative`;
                while (usedKeys.has(col)) col += '_';
                usedKeys.add(col);
                let sum = 0;
                for (const row of data) {
                    const v = toNumber(row[key]);
                    if (v !== null) sum += v;
                    row[col] = Math.round(sum * 1e6) / 1e6;
                }
                out.dataKey = col;
                out.cumulative = true;
                out.sourceKey = key;
            }
            if (mark) out.type = mark;
            const axis = String(raw.yAxis || raw.axis || '').toLowerCase();
            // One shared axis by default, so a line over bars meets the bar
            // tops. A second axis only on request, and never for a line that
            // plots the same values as a bar series.
            if (axis === 'right' && !out.traceOfBars) out.yAxis = 'right';
            if (typeof raw.color === 'string') out.color = raw.color;
            series.push(out);
        });
        if (errors.length) {
            return {
                error: `Chart not drawn: ${errors.join('; ')}. The rows have these keys: ${keys.join(', ')}. Set each series' dataKey to one of them (or add that key to every row).`,
                rowKeys: keys,
            };
        }
        if (!series.length) series = null;
        if (series) {
            const bars = series.filter(x => x.type === 'bar');
            const barKeys = new Set(bars.map(x => x.dataKey));
            // Same values as a bar series (the key itself, or a copied column)
            // → same axis, so the points sit on the bar tops.
            const tracesBar = (x) => barKeys.has(x.dataKey) || bars.some(b => data.every(r => toNumber(r[b.dataKey]) === toNumber(r[x.dataKey])));
            const lineOnBars = LINE_ON_BARS_RE.test(askText);
            for (const x of series) if (x.yAxis === 'right' && x.type !== 'bar' && (lineOnBars || tracesBar(x))) delete x.yAxis;
            for (const x of series) delete x.traceOfBars;
        }
    }

    // A combo needs a mark per series; mixed marks on a plain type make it a combo.
    if (series) {
        const marks = new Set(series.map(s => s.type).filter(Boolean));
        if (type === 'combo') {
            series.forEach((s, i) => { if (!s.type) s.type = i === 0 ? 'bar' : 'line'; });
        } else if (marks.size > 1 || [...marks].some(m => m !== type)) {
            series.forEach(s => { if (!s.type) s.type = type; });
            type = 'combo';
        }
    } else if (type === 'combo') {
        return { error: `A combo chart needs \`series\`, one per mark, e.g. [{name:"Posts", dataKey:"<key>", type:"bar"}, {name:"Cumulative", dataKey:"<key>", type:"line", cumulative:true}]. The rows have these keys: ${keys.join(', ')}.`, rowKeys: keys };
    }

    // A combo goes out as its first series' mark + combo:true: a chat page
    // still running an older bundle (no combo renderer) then draws a plain
    // bar/line chart instead of "Unsupported chart type: combo".
    const combo = type === 'combo';
    const chartSpec = {
        type: combo ? (series[0].type || 'bar') : type,
        ...(combo ? { combo: true } : {}),
        title: typeof args?.title === 'string' ? args.title : '',
        xLabel: typeof args?.xLabel === 'string' ? args.xLabel : '',
        yLabel: typeof args?.yLabel === 'string' ? args.yLabel : '',
        ...(typeof args?.y2Label === 'string' && args.y2Label ? { y2Label: args.y2Label } : {}),
        xKey: xKeyOf(data, keys),
        data,
        ...(series ? { series } : {}),
    };
    return {
        chartSpec,
        summary: typeof args?.summary === 'string' ? args.summary : '',
        pointCount: data.length,
        truncated,
        ...(notes.length ? { notes } : {}),
        ...(series ? { drawn: series.map(s => `${s.name}: ${s.type || type}${s.cumulative ? ' (running total)' : ''}${s.yAxis === 'right' ? ', right axis' : ''}`) } : {}),
    };
}

module.exports = { normalizeChartArgs };
