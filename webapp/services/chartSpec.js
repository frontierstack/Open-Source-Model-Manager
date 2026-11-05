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

const TYPES = ['line', 'bar', 'area', 'pie', 'scatter', 'combo',
    'donut', 'radar', 'radialBar', 'funnel', 'treemap', 'heatmap', 'waterfall', 'candlestick', 'histogram'];
// What models call these. Values: [type, extra spec fields].
const TYPE_ALIASES = {
    composed: ['combo'], mixed: ['combo'], 'bar+line': ['combo'], barline: ['combo'], 'line+bar': ['combo'], 'bar-line': ['combo'],
    column: ['bar'], columns: ['bar'], hbar: ['bar', { horizontal: true }], horizontalbar: ['bar', { horizontal: true }], 'horizontal-bar': ['bar', { horizontal: true }], 'bar-horizontal': ['bar', { horizontal: true }],
    stackedbar: ['bar', { stacked: true }], 'stacked-bar': ['bar', { stacked: true }], stacked: ['bar', { stacked: true }], stackedarea: ['area', { stacked: true }], 'stacked-area': ['area', { stacked: true }],
    doughnut: ['donut'], ring: ['donut'], radial: ['radialBar'], radialbar: ['radialBar'], 'radial-bar': ['radialBar'], gauge: ['radialBar'], polar: ['radar'], spider: ['radar'], web: ['radar'],
    bubble: ['scatter', { bubble: true }], heat: ['heatmap'], matrix: ['heatmap'], 'heat-map': ['heatmap'], ohlc: ['candlestick'], stock: ['candlestick'], candle: ['candlestick'], candles: ['candlestick'],
    bridge: ['waterfall'], hist: ['histogram'], distribution: ['histogram'], tree: ['treemap'], 'tree-map': ['treemap'], spline: ['line', { curve: 'smooth' }], step: ['line', { curve: 'step' }],
};
const CURVES = ['smooth', 'linear', 'step'];
const FORMATS = ['number', 'compact', 'percent', 'currency'];
const MAX_SLICES = 8;
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

function normalizeCartesian(args, opts, type, data, truncated, extra) {
    const askText = String(opts.askText || '');
    const userWantsCumulative = !askText || CUMULATIVE_ASK_RE.test(askText);
    const notes = extra.notes;
    const keys = rowKeys(data);

    let series = null;
    if (Array.isArray(args?.series) && args.series.length) {
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
            const curve = String(raw.curve || '').toLowerCase();
            if (CURVES.includes(curve)) out.curve = curve;
            if (raw.dashed === true) out.dashed = true;
            if (raw.labels === true || raw.showValues === true) out.labels = true;
            const trend = raw.trend === true ? 'linear' : String(raw.trend || raw.trendline || '').toLowerCase();
            if (trend === 'linear' || trend === 'average' || trend === 'moving' || trend === 'regression') out.trend = trend === 'regression' ? 'linear' : (trend === 'average' ? 'moving' : trend);
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

    return { type, data, keys, series, combo: type === 'combo' };
}

// ---------------------------------------------------------------------------
// v2 entry point (2026-11-05 revamp). Everything a model may send is
// normalized here into a spec ChartBlock.jsx draws; anything it cannot draw
// comes back as an error naming the fix, never as a blank chart.
function resolveType(raw) {
    let t = String(raw || '').trim();
    const lower = t.toLowerCase().replace(/\s+/g, '');
    if (TYPE_ALIASES[lower]) return { type: TYPE_ALIASES[lower][0], extra: TYPE_ALIASES[lower][1] || {} };
    const hit = TYPES.find(x => x.toLowerCase() === lower);
    return hit ? { type: hit, extra: {} } : { type: null, extra: {} };
}

function pickKey(args, names, keys, fallback) {
    for (const n of names) {
        const v = args && args[n];
        if (typeof v === 'string' && v) { const k = resolveKey(v, keys); if (k) return k; }
    }
    return fallback;
}

function numericKeysOf(data, keys, exclude = []) {
    return keys.filter(k => !exclude.includes(k) && data.some(r => toNumber(r[k]) !== null));
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }

// Linear regression / moving average of one column, written into its own column.
function addTrendColumn(data, key, kind, usedKeys) {
    let col = `${key}_trend`;
    while (usedKeys.has(col)) col += '_';
    usedKeys.add(col);
    const ys = data.map(r => toNumber(r[key]));
    if (kind === 'moving') {
        const w = Math.max(2, Math.min(7, Math.round(data.length / 6) || 3));
        data.forEach((r, i) => {
            const win = ys.slice(Math.max(0, i - w + 1), i + 1).filter(v => v !== null);
            r[col] = win.length ? round6(win.reduce((a, b) => a + b, 0) / win.length) : null;
        });
        return { col, label: `${w}-point average` };
    }
    const pts = ys.map((y, i) => [i, y]).filter(p => p[1] !== null);
    const n = pts.length;
    if (n < 2) return null;
    const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
    const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
    const den = n * sxx - sx * sx;
    const m = den ? (n * sxy - sx * sy) / den : 0, b = (sy - m * sx) / n;
    data.forEach((r, i) => { r[col] = round6(m * i + b); });
    return { col, label: 'Trend' };
}

function commonFields(args, extra) {
    const out = {};
    const str = (v) => (typeof v === 'string' ? v : '');
    out.title = str(args?.title);
    out.subtitle = str(args?.subtitle);
    out.xLabel = str(args?.xLabel);
    out.yLabel = str(args?.yLabel);
    if (str(args?.y2Label)) out.y2Label = args.y2Label;
    const fmt = String(args?.valueFormat || args?.format || '').toLowerCase();
    if (FORMATS.includes(fmt)) out.valueFormat = fmt;
    if (typeof args?.currency === 'string' && /^[A-Za-z]{3}$/.test(args.currency)) { out.currency = args.currency.toUpperCase(); if (!out.valueFormat) out.valueFormat = 'currency'; }
    if (typeof args?.unit === 'string' && args.unit.length <= 12) out.unit = args.unit;
    if (Number.isInteger(args?.decimals) && args.decimals >= 0 && args.decimals <= 6) out.decimals = args.decimals;
    const curve = String(args?.curve || extra.curve || '').toLowerCase();
    if (CURVES.includes(curve)) out.curve = curve;
    const stacked = args?.stacked ?? extra.stacked;
    if (stacked === true || stacked === 'true' || stacked === 'normal' || stacked === 'stacked') out.stacked = true;
    else if (stacked === 'percent' || stacked === 'expand' || stacked === '100%') out.stacked = 'percent';
    if (args?.horizontal === true || extra.horizontal || String(args?.orientation || '').toLowerCase() === 'horizontal') out.horizontal = true;
    if (args?.showValues === true || args?.labels === true || args?.dataLabels === true) out.showValues = true;
    const refs = Array.isArray(args?.referenceLines) ? args.referenceLines : (args?.referenceLine && typeof args.referenceLine === 'object' ? [args.referenceLine] : []);
    const cleanRefs = refs.filter(r => r && typeof r === 'object').map(r => {
        const y = toNumber(r.y ?? r.value), x = r.x;
        const o = {};
        if (y !== null) o.y = y; else if (x !== undefined && x !== null && x !== '') o.x = x; else return null;
        if (typeof r.label === 'string') o.label = r.label.slice(0, 40);
        return o;
    }).filter(Boolean).slice(0, 4);
    if (args?.average === true || args?.showAverage === true) cleanRefs.push({ average: true, label: 'Average' });
    if (cleanRefs.length) out.referenceLines = cleanRefs;
    return out;
}

// Parts of a whole / ranked items: pie, donut, radialBar, funnel, treemap.
function normalizeParts(args, type, data, keys, notes) {
    const nameKey = pickKey(args, ['nameKey', 'labelKey', 'xKey', 'categoryKey'], keys, null)
        || ['name', 'label', 'category', 'x', 'stage', 'segment', 'item'].find(k => keys.includes(k))
        || keys.find(k => data.some(r => toNumber(r[k]) === null)) || keys[0];
    const valueKey = pickKey(args, ['valueKey', 'dataKey', 'yKey'], keys, null)
        || ['value', 'y', 'count', 'amount', 'total', 'size'].find(k => keys.includes(k))
        || numericKeysOf(data, keys, [nameKey])[0];
    if (!valueKey) return { error: `A ${type} chart needs one numeric value per row, e.g. [{name:"A", value:12}, …]. The rows have these keys: ${keys.join(', ')}.` };
    let parts = data.map((r, i) => ({ name: r[nameKey] != null && r[nameKey] !== '' ? String(r[nameKey]) : `Item ${i + 1}`, value: toNumber(r[valueKey]), ...(r.group != null ? { group: String(r.group) } : {}) }))
        .filter(p => p.value !== null);
    if (type === 'pie' || type === 'donut') {
        const neg = parts.filter(p => p.value < 0);
        if (neg.length) notes.push(`${neg.length} negative value(s) cannot be a slice and were left out.`);
        parts = parts.filter(p => p.value > 0);
        if (parts.length > MAX_SLICES) {
            parts.sort((a, b) => b.value - a.value);
            const rest = parts.slice(MAX_SLICES - 1);
            parts = [...parts.slice(0, MAX_SLICES - 1), { name: `Other (${rest.length})`, value: round6(rest.reduce((a, p) => a + p.value, 0)), other: true }];
            notes.push(`More than ${MAX_SLICES} slices: the smallest ${rest.length} were folded into "Other". For many categories a bar chart reads better.`);
        }
    }
    if (type === 'funnel') parts.sort((a, b) => b.value - a.value);
    if (!parts.length) return { error: `No positive numeric "${valueKey}" values to draw.` };
    return { data: parts, nameKey: 'name', valueKey: 'value' };
}

function normalizeScatter(args, data, keys, extra) {
    const groupKey = pickKey(args, ['groupKey', 'seriesKey', 'colorKey', 'categoryKey'], keys, null) || (keys.includes('group') ? 'group' : (keys.includes('series') ? 'series' : null));
    const labelKey = pickKey(args, ['labelKey', 'nameKey'], keys, null) || ['label', 'name'].find(k => keys.includes(k) && k !== groupKey) || null;
    const nums = numericKeysOf(data, keys, [groupKey, labelKey].filter(Boolean));
    const xKey = pickKey(args, ['xKey'], keys, null) || (nums.includes('x') ? 'x' : nums[0]);
    const yKey = pickKey(args, ['yKey', 'dataKey'], keys, null) || (nums.includes('y') ? 'y' : nums.find(k => k !== xKey));
    const zKey = pickKey(args, ['sizeKey', 'zKey', 'radiusKey'], keys, null) || ((extra.bubble || args?.bubble) ? (['size', 'z', 'r', 'value'].find(k => nums.includes(k) && k !== xKey && k !== yKey) || nums.find(k => k !== xKey && k !== yKey)) : (nums.includes('size') ? 'size' : null));
    if (!xKey || !yKey) return { error: `A scatter chart needs two numeric columns (x and y). The rows have these keys: ${keys.join(', ')}; set xKey and yKey.` };
    const points = data.map(r => ({ x: toNumber(r[xKey]), y: toNumber(r[yKey]), ...(zKey ? { z: toNumber(r[zKey]) } : {}), ...(groupKey ? { group: r[groupKey] != null ? String(r[groupKey]) : '—' } : {}), ...(labelKey && r[labelKey] != null ? { label: String(r[labelKey]) } : {}) }))
        .filter(p => p.x !== null && p.y !== null);
    if (!points.length) return { error: `No rows with numeric "${xKey}" and "${yKey}".` };
    const groups = groupKey ? [...new Set(points.map(p => p.group))] : null;
    let trend = null;
    if (args?.trend === true || args?.trendline === true || /linear|regression/.test(String(args?.trend || args?.trendline || ''))) {
        const n = points.length;
        const sx = points.reduce((a, p) => a + p.x, 0), sy = points.reduce((a, p) => a + p.y, 0);
        const sxx = points.reduce((a, p) => a + p.x * p.x, 0), sxy = points.reduce((a, p) => a + p.x * p.y, 0);
        const den = n * sxx - sx * sx;
        if (n >= 2 && den) {
            const m = (n * sxy - sx * sy) / den, b = (sy - m * sx) / n;
            const xs = points.map(p => p.x), lo = Math.min(...xs), hi = Math.max(...xs);
            trend = [{ x: lo, y: round6(m * lo + b) }, { x: hi, y: round6(m * hi + b) }];
        }
    }
    return { data: points, xKey: 'x', yKey: 'y', sourceKeys: { x: xKey, y: yKey, ...(zKey ? { z: zKey } : {}) }, ...(zKey ? { bubble: true } : {}), ...(groups ? { groups: groups.slice(0, 8) } : {}), ...(trend ? { trend } : {}) };
}

function normalizeHeatmap(args, data, keys) {
    // Long format {x, y, value} or wide format {row, colA, colB, …}.
    const xKey = pickKey(args, ['xKey', 'colKey', 'columnKey'], keys, null) || ['x', 'col', 'column', 'day', 'hour'].find(k => keys.includes(k));
    const yKey = pickKey(args, ['yKey', 'rowKey'], keys, null) || ['y', 'row', 'week', 'category'].find(k => keys.includes(k) && k !== xKey);
    const vKey = pickKey(args, ['valueKey', 'dataKey'], keys, null) || ['value', 'count', 'z', 'v'].find(k => keys.includes(k));
    let cells = [];
    if (xKey && yKey && vKey) {
        cells = data.map(r => ({ x: String(r[xKey]), y: String(r[yKey]), v: toNumber(r[vKey]) }));
    } else {
        const rowKey = yKey || keys.find(k => data.some(r => toNumber(r[k]) === null)) || keys[0];
        const cols = numericKeysOf(data, keys, [rowKey]);
        if (!cols.length) return { error: `A heatmap needs rows like {x, y, value} or {row:"Mon", "9am":3, "10am":5, …}. The rows have these keys: ${keys.join(', ')}.` };
        for (const r of data) for (const c of cols) cells.push({ x: c, y: String(r[rowKey]), v: toNumber(r[c]) });
    }
    const xs = [...new Set(cells.map(c => c.x))], ys = [...new Set(cells.map(c => c.y))];
    if (xs.length > 60 || ys.length > 40) return { error: `Heatmap too large (${xs.length}×${ys.length}); keep it within 60 columns × 40 rows — aggregate first.` };
    const vals = cells.map(c => c.v).filter(v => v !== null);
    return { cells, xs, ys, min: Math.min(...vals), max: Math.max(...vals) };
}

function normalizeWaterfall(args, data, keys, notes) {
    const nameKey = pickKey(args, ['nameKey', 'labelKey', 'xKey'], keys, null) || ['name', 'label', 'step', 'category', 'x'].find(k => keys.includes(k)) || keys.find(k => data.some(r => toNumber(r[k]) === null)) || keys[0];
    const valueKey = pickKey(args, ['valueKey', 'dataKey', 'yKey'], keys, null) || ['value', 'change', 'delta', 'amount', 'y'].find(k => keys.includes(k)) || numericKeysOf(data, keys, [nameKey])[0];
    if (!valueKey) return { error: `A waterfall needs a signed change per row, e.g. [{name:"Start", value:100, total:true}, {name:"Sales", value:40}, {name:"Costs", value:-25}].` };
    let run = 0;
    const out = [];
    const START_RE = /^(start|starting|opening|initial|begin|beginning|base|baseline|previous|prior)\b/i;
    const END_RE = /\b(end|ending|closing|final|total|net|result)\b/i;
    const rows = data.filter(r => toNumber(r[valueKey]) !== null);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const v = toNumber(r[valueKey]);
        const nm = String(r[nameKey] ?? '');
        // A named opening balance (first row) or closing balance (last row) is
        // a total bar, not a step — else it is counted twice.
        const named = (i === 0 && START_RE.test(nm)) || (i === rows.length - 1 && i > 0 && END_RE.test(nm));
        const isTotal = r.total === true || r.isTotal === true || r.type === 'total' || named;
        if (named && i === rows.length - 1 && Math.abs(v - run) > Math.max(1e-6, Math.abs(run) * 0.005)) {
            notes.push(`"${nm}" (${v}) does not equal the running total (${round6(run)}); drawn as stated — check the steps.`);
        }
        if (isTotal) {
            // A total row either states the running value (v) or resets it.
            run = v;
            out.push({ name: String(r[nameKey]), value: v, _range: [Math.min(0, v), Math.max(0, v)], _kind: 'total', _end: v });
        } else {
            const lo = run, hi = run + v;
            run = hi;
            out.push({ name: String(r[nameKey]), value: v, _range: [Math.min(lo, hi), Math.max(lo, hi)], _kind: v >= 0 ? 'up' : 'down', _end: round6(hi) });
        }
    }
    if (args?.showTotal !== false && out.length && out[out.length - 1]._kind !== 'total') {
        out.push({ name: typeof args?.totalLabel === 'string' ? args.totalLabel : 'Total', value: round6(run), _range: [Math.min(0, run), Math.max(0, run)], _kind: 'total', _end: round6(run) });
        notes.push('A closing "Total" bar was added (showTotal:false to omit).');
    }
    if (!out.length) return { error: `No numeric "${valueKey}" values to draw.` };
    return { data: out, xKey: 'name' };
}

function normalizeCandles(args, data, keys) {
    const k = (names) => pickKey(args, names.map(n => `${n}Key`), keys, null) || keys.find(x => names.includes(x.toLowerCase()));
    const o = k(['open', 'o']), h = k(['high', 'h']), l = k(['low', 'l']), c = k(['close', 'c', 'adjclose']);
    const vol = k(['volume', 'vol', 'v']);
    if (!o || !h || !l || !c) return { error: `A candlestick chart needs open, high, low and close per row (+ a date). The rows have these keys: ${keys.join(', ')}.` };
    const xk = pickKey(args, ['xKey'], keys, null) || ['date', 'time', 'day', 'x', 'period', 'label'].find(x => keys.includes(x)) || keys.find(x => ![o, h, l, c, vol].includes(x)) || keys[0];
    const out = data.map(r => {
        const oo = toNumber(r[o]), hh = toNumber(r[h]), ll = toNumber(r[l]), cc = toNumber(r[c]);
        if ([oo, hh, ll, cc].some(v => v === null)) return null;
        return { [xk]: r[xk], open: oo, high: Math.max(hh, oo, cc), low: Math.min(ll, oo, cc), close: cc, _hl: [Math.min(ll, oo, cc), Math.max(hh, oo, cc)], ...(vol && toNumber(r[vol]) !== null ? { volume: toNumber(r[vol]) } : {}) };
    }).filter(Boolean);
    if (!out.length) return { error: 'No complete OHLC rows to draw.' };
    return { data: out, xKey: xk, hasVolume: out.some(r => r.volume != null) };
}

function normalizeHistogram(args, data, keys) {
    let values = Array.isArray(args?.values) ? args.values.map(toNumber).filter(v => v !== null) : null;
    let valueKey = null;
    if (!values || !values.length) {
        valueKey = pickKey(args, ['valueKey', 'dataKey', 'xKey'], keys, null) || ['value', 'x', 'y'].find(k => keys.includes(k)) || numericKeysOf(data || [], keys)[0];
        values = (data || []).map(r => toNumber(r[valueKey])).filter(v => v !== null);
    }
    if (!values.length) return { error: 'A histogram needs raw numbers: `values:[…]`, or rows with one numeric column (valueKey).' };
    const lo = Math.min(...values), hi = Math.max(...values);
    let bins = Number.isInteger(args?.bins) && args.bins >= 2 && args.bins <= 60 ? args.bins : Math.min(30, Math.max(5, Math.ceil(Math.log2(values.length) + 1)));
    if (lo === hi) bins = 1;
    const w = (hi - lo) / bins || 1;
    const nice = (v) => (Math.abs(w) >= 10 ? Math.round(v) : Math.round(v * 100) / 100);
    const out = Array.from({ length: bins }, (_, i) => ({ bin: `${nice(lo + i * w)}–${nice(lo + (i + 1) * w)}`, from: round6(lo + i * w), to: round6(lo + (i + 1) * w), count: 0 }));
    for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))].count++;
    return { data: out, xKey: 'bin', n: values.length, valueKey };
}

function normalizeChartArgs(args, opts = {}) {
    const notes = [];
    const { type: rt, extra } = resolveType(args?.type);
    if (!rt) {
        return { error: `Unsupported chart type "${args?.type}". Use one of: line, area, bar (horizontal/stacked), combo (bars + lines), pie, donut, scatter (bubble), radar, radialBar, funnel, treemap, heatmap, waterfall, candlestick, histogram.` };
    }
    let type = rt;
    let data = Array.isArray(args?.data) ? args.data.filter(r => r && typeof r === 'object' && !Array.isArray(r)) : null;
    if (type === 'histogram' && (!data || !data.length) && Array.isArray(args?.values)) data = [];
    const seriesCarryData = Array.isArray(args?.series) && args.series.some(sr => sr && sr.data && typeof sr.data === 'object');
    if ((!data || !data.length) && seriesCarryData) data = [];
    if (!data || (data.length === 0 && type !== 'histogram' && !seriesCarryData)) return { error: 'data must be a non-empty array of row objects.' };
    // Hard cap to keep the tool_result SSE event under the serialization cap.
    const truncated = data.length > MAX_POINTS;
    data = (truncated ? data.slice(0, MAX_POINTS) : data).map(r => ({ ...r }));
    // A nested single row {"2023": {cloud: 42, …}, "2024": {…}} → one row per key.
    if (data.length === 1) {
        const ents = Object.entries(data[0]);
        if (ents.length > 1 && ents.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(x => toNumber(x) !== null))) {
            data = ents.map(([k, v]) => ({ x: k, ...v }));
            notes.push('Nested rows were flattened to one row per category.');
        }
    }
    // Per-series data ({name, data: {x: value}} or {name, data: [..]}) when the
    // rows do not hold the series → build the rows from the series.
    if (Array.isArray(args?.series) && args.series.some(sr => sr && sr.data && typeof sr.data === 'object')) {
        const rk = rowKeys(data);
        const ownData = args.series.filter(sr => sr && sr.data && typeof sr.data === 'object');
        const missing = ownData.every(sr => !resolveKey(sr.dataKey || sr.name, rk));
        if (missing) {
            const byX = new Map();
            const order = [];
            const keyOf = (sr, i) => String(sr.dataKey || sr.name || `series${i + 1}`);
            ownData.forEach((sr, i) => {
                const pairs = Array.isArray(sr.data)
                    ? sr.data.map((v, j) => (v && typeof v === 'object' ? [v.x ?? v.label ?? v.name ?? v.date ?? j + 1, v.y ?? v.value] : [j + 1, v]))
                    : Object.entries(sr.data);
                for (const [x, v] of pairs) {
                    const xs = String(x);
                    if (!byX.has(xs)) { byX.set(xs, { x: xs }); order.push(xs); }
                    byX.get(xs)[keyOf(sr, i)] = toNumber(v);
                }
            });
            if (order.length) {
                data = order.map(x => byX.get(x));
                args = { ...args, xKey: 'x', series: args.series.map((sr, i) => (sr && sr.data ? { ...sr, data: undefined, dataKey: keyOf(sr, ownData.indexOf(sr)) } : sr)) };
                notes.push('Series carried their own data; rows were built from it.');
            }
        }
    }
    // Models often send one object per item keyed by its label —
    // [{"New sales": 180}, {"COGS": -140}] — or one wide row
    // [{rent: 1800, food: 600}]. Both become [{name, value}] rows.
    const oneKey = data.length > 1 && data.every(r => Object.keys(r).length === 1 && toNumber(Object.values(r)[0]) !== null);
    const wideParts = data.length === 1 && ['pie', 'donut', 'radialBar', 'funnel', 'treemap', 'waterfall', 'bar'].includes(type)
        && Object.keys(data[0]).length > 1 && Object.values(data[0]).every(v => toNumber(v) !== null);
    if (oneKey || wideParts) {
        data = oneKey ? data.map(r => ({ name: Object.keys(r)[0], value: toNumber(Object.values(r)[0]) }))
            : Object.entries(data[0]).map(([k, v]) => ({ name: k, value: toNumber(v) }));
        notes.push('Rows were label→value pairs; read them as [{name, value}].');
    }
    const keys = rowKeys(data);
    const common = commonFields(args, extra);
    const base = { title: common.title, xLabel: common.xLabel, yLabel: common.yLabel, v: 2 };
    const finish = (spec, extraOut = {}) => ({
        chartSpec: { ...base, ...common, ...spec },
        summary: typeof args?.summary === 'string' ? args.summary : '',
        pointCount: Array.isArray(spec.data) ? spec.data.length : (spec.cells ? spec.cells.length : 0),
        truncated,
        ...(notes.length ? { notes } : {}),
        ...extraOut,
    });

    if (['pie', 'donut', 'radialBar', 'funnel', 'treemap'].includes(type)) {
        const r = normalizeParts(args, type, data, keys, notes);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, xKey: 'name', data: r.data });
    }
    if (type === 'scatter') {
        const r = normalizeScatter(args, data, keys, extra);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, ...r });
    }
    if (type === 'heatmap') {
        const r = normalizeHeatmap(args, data, keys);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, data: [], ...r });
    }
    if (type === 'waterfall') {
        const r = normalizeWaterfall(args, data, keys, notes);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, ...r });
    }
    if (type === 'candlestick') {
        const r = normalizeCandles(args, data, keys);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, ...r });
    }
    if (type === 'histogram') {
        const r = normalizeHistogram(args, data, keys);
        if (r.error) return { ...r, rowKeys: keys };
        return finish({ type, data: r.data, xKey: r.xKey, series: [{ name: common.yLabel || 'Count', dataKey: 'count', type: 'bar' }], sampleSize: r.n }, { sampleSize: r.n });
    }

    // Cartesian: line / area / bar / combo / radar.
    // `lineOverBars` (or a bar series with `withLine`): a smooth line through
    // the bar tops — the "line that follows the bars" combo.
    if (Array.isArray(args?.series)) {
        const add = [];
        for (const s of args.series) {
            if (s && typeof s === 'object' && (s.withLine === true || s.lineOverBars === true)) {
                add.push({ name: typeof s.lineName === 'string' ? s.lineName : 'Trend', dataKey: s.dataKey || s.key || s.y || s.name, type: 'line', curve: 'smooth' });
            }
        }
        if (add.length) { args = { ...args, series: [...args.series, ...add] }; if (type !== 'radar') type = 'combo'; }
    } else if (args?.lineOverBars === true && (type === 'bar' || type === 'combo')) {
        const xk = xKeyOf(data, keys);
        const nk = numericKeysOf(data, keys, [xk])[0];
        if (nk) { args = { ...args, series: [{ name: common.yLabel || nk, dataKey: nk, type: 'bar' }, { name: 'Trend', dataKey: nk, type: 'line', curve: 'smooth' }] }; type = 'combo'; }
    }
    const c = normalizeCartesian(args, opts, type, data, truncated, { notes });
    if (c.error) return c;
    let { series } = c;
    type = c.type;
    // Trend columns (linear fit / moving average) requested per series.
    if (series) {
        const used = new Set(rowKeys(c.data));
        const trends = [];
        for (const s of series) {
            if (!s.trend) continue;
            const t = addTrendColumn(c.data, s.dataKey, s.trend, used);
            if (t) trends.push({ name: series.length > 1 ? `${s.name} ${t.label.toLowerCase()}` : t.label, dataKey: t.col, type: 'line', dashed: true, derived: true, ...(s.yAxis ? { yAxis: s.yAxis } : {}) });
            delete s.trend;
        }
        if (trends.length) {
            series = [...series, ...trends];
            if (type !== 'radar' && type !== 'combo') { series.forEach(s => { if (!s.type) s.type = type; }); type = 'combo'; }
        }
    }
    if (type === 'radar') {
        if (series) series.forEach(s => { delete s.type; delete s.yAxis; });
    }
    if (common.horizontal && type !== 'bar' && type !== 'combo') delete common.horizontal;
    if (common.stacked && !['bar', 'area', 'combo'].includes(type)) delete common.stacked;
    // A combo goes out as its first series' mark + combo:true: a chat page
    // still running an older bundle (no combo renderer) then draws a plain
    // bar/line chart instead of "Unsupported chart type: combo".
    const combo = type === 'combo';
    return finish({
        type: combo ? (series[0].type || 'bar') : type,
        ...(combo ? { combo: true } : {}),
        xKey: pickKey(args, ['xKey'], c.keys, null) || xKeyOf(c.data, c.keys),
        data: c.data,
        ...(series ? { series } : {}),
    }, series ? { drawn: series.map(s => `${s.name}: ${s.type || type}${s.cumulative ? ' (running total)' : ''}${s.yAxis === 'right' ? ', right axis' : ''}${s.derived ? ' (computed)' : ''}`) } : {});
}

module.exports = { normalizeChartArgs, TYPES, resolveType };
