import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
    LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
    ScatterChart, Scatter, ZAxis, ComposedChart, RadarChart, Radar, PolarGrid,
    PolarAngleAxis, PolarRadiusAxis, RadialBarChart, RadialBar, FunnelChart, Funnel,
    Treemap, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LabelList,
    ResponsiveContainer,
} from 'recharts';

// Inline renderer for the render_chart tool (server: webapp/services/chartSpec.js).
//
// Design rules (the dataviz method): categorical hues in a FIXED, validated
// order with light and dark steps of their own (validated against this app's
// #ffffff / #161618 chart surfaces); thin marks — bars capped at 28px with a
// 4px rounded data-end, 2px lines, dots ringed in the surface colour; hairline
// solid horizontal grid only; one shared y-axis unless the user asked for two;
// text always in ink tokens, never in a series colour; a legend for 2+
// series; hover tooltips everywhere; a table view for every chart (it is also
// the relief for the three light-mode hues under 3:1 contrast).

const PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
// Sequential blue (heatmap / funnel), light → dark.
const SEQ = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const SEQ_DARK = ['#1b2533', '#1d2c40', '#1f3450', '#213c60', '#234572', '#264f86', '#2a5a9b', '#2f66b1', '#3574c6', '#3f83d6', '#5596e0', '#6da7ec', '#9ec5f4'];
const UP = { light: '#1baf7a', dark: '#199e70' };
const DOWN = { light: '#e34948', dark: '#e66767' };

const CURVE = { smooth: 'monotone', linear: 'linear', step: 'stepAfter' };

// ── theme ─────────────────────────────────────────────────────────────────
function parseColor(str) {
    const s = String(str || '').trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return m[1].split('').map(c => parseInt(c + c, 16));
    m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function surfaceIsLight() {
    if (typeof document === 'undefined') return false;
    const cs = getComputedStyle(document.body);
    const c = parseColor(cs.getPropertyValue('--bg-elevated')) || parseColor(cs.getPropertyValue('--bg-secondary')) || parseColor(cs.backgroundColor);
    if (!c) return false;
    const [r, g, b] = c.map(v => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}
function useLightSurface() {
    const [light, setLight] = useState(surfaceIsLight);
    useEffect(() => {
        const update = () => setLight(surfaceIsLight());
        const mo = new MutationObserver(update);
        mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        return () => mo.disconnect();
    }, []);
    return light;
}

// ── numbers ───────────────────────────────────────────────────────────────
function makeFormat(spec) {
    const fmt = spec.valueFormat || 'number';
    const unit = spec.unit || '';
    const dec = Number.isInteger(spec.decimals) ? spec.decimals : null;
    const currency = spec.currency || 'USD';
    const full = (v) => {
        if (v == null || !Number.isFinite(Number(v))) return v == null ? '—' : String(v);
        const n = Number(v);
        try {
            if (fmt === 'percent') {
                const p = Math.abs(n) <= 1.0000001 && spec.stacked !== 'percent' && !unit ? n * 100 : n;
                return `${p.toLocaleString(undefined, { maximumFractionDigits: dec ?? 1 })}%`;
            }
            if (fmt === 'currency') return n.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: dec ?? (Math.abs(n) >= 100 ? 0 : 2) });
            if (fmt === 'compact') return `${n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: dec ?? 1 })}${unit ? ` ${unit}` : ''}`;
            return `${n.toLocaleString(undefined, { maximumFractionDigits: dec ?? (Math.abs(n) >= 100 ? 0 : 2) })}${unit ? ` ${unit}` : ''}`;
        } catch (_) { return String(n); }
    };
    const axis = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        try {
            if (fmt === 'percent') return full(n);
            const abs = Math.abs(n);
            if (fmt === 'currency') return n.toLocaleString(undefined, { style: 'currency', currency, notation: abs >= 10000 ? 'compact' : 'standard', maximumFractionDigits: abs >= 10000 ? 1 : 0 });
            if (abs >= 10000) return n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
            return n.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 2 : 0 });
        } catch (_) { return String(n); }
    };
    return { full, axis };
}

// ── series resolution (also for older saved specs) ────────────────────────
function resolveSeries(spec, xKey) {
    const { data, series, type } = spec;
    if (Array.isArray(series) && series.length) {
        const declared = series.map(s => ({ ...s, dataKey: s.dataKey || s.name }));
        const allMissing = declared.every(s => data.every(row => !(s.dataKey in (row || {}))));
        if (!allMissing) return declared;
        const sample = data[0] || {};
        if ('y' in sample) return [{ name: declared[0].name || 'y', dataKey: 'y' }];
        const inferred = Object.keys(sample).filter(k => k !== xKey && typeof sample[k] === 'number');
        return inferred.map((k, i) => ({ name: declared[i]?.name || k, dataKey: k }));
    }
    const sample = data[0] || {};
    const keys = Object.keys(sample).filter(k => k !== xKey && !k.startsWith('_') && typeof sample[k] === 'number');
    if (!keys.length) return [{ name: type === 'bar' ? 'Value' : 'y', dataKey: 'y' }];
    return keys.map(k => ({ name: k, dataKey: k }));
}

function xKeyOf(spec) {
    const sample = (spec.data && spec.data[0]) || {};
    if (spec.xKey && spec.xKey in sample) return spec.xKey;
    for (const k of ['x', 'date', 'label', 'name']) if (k in sample) return k;
    return Object.keys(sample)[0] || 'x';
}

// ── shared pieces ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label, fmt, kind, xLabel, colorMap }) {
    if (!active || !payload || !payload.length) return null;
    const row = payload[0] && payload[0].payload ? payload[0].payload : {};
    let head = label;
    let rows = [];
    if (kind === 'candle') {
        const up = row.close >= row.open;
        rows = [['Open', row.open], ['High', row.high], ['Low', row.low], ['Close', row.close]].map(([n, v]) => ({ name: n, value: fmt.full(v) }));
        if (row.volume != null) rows.push({ name: 'Volume', value: Number(row.volume).toLocaleString(undefined, { notation: 'compact' }) });
        rows.unshift({ name: up ? 'Up' : 'Down', value: `${up ? '+' : ''}${fmt.full(row.close - row.open)}`, color: payload[0].color });
    } else if (kind === 'waterfall') {
        rows = [{ name: row._kind === 'total' ? 'Total' : 'Change', value: `${row._kind === 'up' ? '+' : ''}${fmt.full(row.value)}`, color: payload[0].color }];
        if (row._kind !== 'total') rows.push({ name: 'Running total', value: fmt.full(row._end) });
    } else if (kind === 'scatter') {
        const p = row;
        head = p.label || p.group || '';
        rows = [{ name: xLabel || 'x', value: fmt.full(p.x) }, { name: 'y', value: fmt.full(p.y) }];
        if (p.z != null) rows.push({ name: 'size', value: fmt.full(p.z) });
    } else if (kind === 'parts') {
        const p = payload[0];
        head = p.name || row.name;
        rows = [{ name: 'Value', value: fmt.full(p.value), color: p.payload?.fill || p.color }];
        if (row._share != null) rows.push({ name: 'Share', value: `${(row._share * 100).toFixed(1)}%` });
    } else {
        rows = payload.filter(p => p && p.value != null && !p.hide).map(p => ({
            name: p.name, color: (colorMap && colorMap[p.name]) || [p.color, p.stroke, p.fill].find(c => c && !String(c).startsWith('url(')),
            value: Array.isArray(p.value) ? `${fmt.full(p.value[0])} – ${fmt.full(p.value[1])}` : fmt.full(p.value),
        }));
    }
    return (
        <div className="chart-tip">
            {head !== undefined && head !== '' && <div className="chart-tip__head">{String(head)}</div>}
            {rows.map((r, i) => (
                <div className="chart-tip__row" key={i}>
                    {r.color ? <span className="chart-tip__swatch" style={{ background: r.color }} /> : <span className="chart-tip__swatch chart-tip__swatch--none" />}
                    <span className="chart-tip__name">{r.name}</span>
                    <span className="chart-tip__val">{r.value}</span>
                </div>
            ))}
        </div>
    );
}

function Legend({ items, hidden, onToggle }) {
    if (!items || items.length < 2) return null;
    return (
        <div className="chart-legend" role="list">
            {items.map(it => {
                const off = hidden.has(it.key);
                return (
                    <button type="button" key={it.key} role="listitem" className={`chart-legend__item${off ? ' is-off' : ''}`}
                        onClick={() => onToggle && onToggle(it.key)} title={off ? `Show ${it.name}` : `Hide ${it.name}`} aria-pressed={!off}>
                        <span className={`chart-legend__key chart-legend__key--${it.mark || 'bar'}${it.dashed ? ' is-dashed' : ''}`} style={{ '--k': it.color }} />
                        <span>{it.name}</span>
                    </button>
                );
            })}
        </div>
    );
}

function Gradients({ items, id, stacked }) {
    return (
        <defs>
            {items.map((it, i) => (
                <linearGradient key={i} id={`${id}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={it.color} stopOpacity={it.mark === 'area' ? (stacked ? 0.55 : 0.34) : 1} />
                    <stop offset="100%" stopColor={it.color} stopOpacity={it.mark === 'area' ? (stacked ? 0.22 : 0.02) : 0.78} />
                </linearGradient>
            ))}
            {items.map((it, i) => (
                <linearGradient key={`h${i}`} id={`${id}-h${i}`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={it.color} stopOpacity={0.78} />
                    <stop offset="100%" stopColor={it.color} stopOpacity={1} />
                </linearGradient>
            ))}
        </defs>
    );
}

const axisTick = { fill: 'var(--ink-3)', fontSize: 11 };
const gridProps = { vertical: false, stroke: 'var(--rule-2)', strokeOpacity: 0.7 };

function refLines(spec, data, keys, fmt, horizontal) {
    const out = [];
    (spec.referenceLines || []).forEach((r, i) => {
        let y = r.y;
        if (r.average) {
            const vals = data.flatMap(row => keys.map(k => Number(row[k]))).filter(Number.isFinite);
            if (!vals.length) return;
            y = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        const label = { value: `${r.label || ''}${r.label && y != null ? ' · ' : ''}${y != null ? fmt.axis(y) : ''}`, position: horizontal ? 'top' : 'insideTopRight', fill: 'var(--ink-2)', fontSize: 11 };
        if (y != null) out.push(horizontal
            ? <ReferenceLine key={`r${i}`} x={y} stroke="var(--ink-3)" strokeDasharray="4 4" label={label} ifOverflow="extendDomain" />
            : <ReferenceLine key={`r${i}`} y={y} yAxisId="left" stroke="var(--ink-3)" strokeDasharray="4 4" label={label} ifOverflow="extendDomain" />);
        else if (r.x != null) out.push(<ReferenceLine key={`r${i}`} x={r.x} yAxisId="left" stroke="var(--ink-3)" strokeDasharray="4 4" label={{ value: r.label || String(r.x), position: 'insideTopLeft', fill: 'var(--ink-2)', fontSize: 11 }} />);
    });
    return out;
}

// End-of-line value label for a single line (label the endpoint, not every point).
function EndLabel({ fmt, last }) {
    return (props) => {
        const { x, y, index, value } = props;
        if (index !== last || value == null) return null;
        return <text x={x + 6} y={y} dy={4} fill="var(--ink-2)" fontSize={11} fontWeight={600}>{fmt.axis(value)}</text>;
    };
}

// ── cartesian: line / area / bar / combo (+ histogram) ─────────────────────
function CartesianChart({ spec, palette, fmt, hidden, gid }) {
    const xKey = xKeyOf(spec);
    const { data } = spec;
    const series = resolveSeries(spec, xKey);
    const base = spec.type;
    const combo = spec.combo === true || base === 'combo' || series.some(s => s.type && s.type !== base);
    const markOf = (s) => s.type || (base === 'combo' ? 'line' : base);
    const horizontal = !!spec.horizontal;
    const stackId = spec.stacked ? 'stack' : undefined;
    const curveOf = (s) => CURVE[s.curve || spec.curve || 'smooth'];
    const hasRight = !horizontal && series.some(s => s.yAxis === 'right');
    const bars = series.filter(s => markOf(s) === 'bar');
    const visible = series.filter(s => !hidden.has(s.dataKey + s.name));
    const many = data.length > 24;
    const singleBar = bars.length === 1 && !spec.stacked;
    const showBarValues = spec.showValues || (singleBar && data.length <= 12 && series.filter(s => markOf(s) !== 'bar').length === 0);
    const lineCount = series.filter(s => markOf(s) === 'line').length;
    const percent = spec.stacked === 'percent';
    const lastIdx = data.length - 1;
    const isHist = spec.type === 'bar' && data[0] && 'from' in data[0] && 'to' in data[0];

    const colorOf = (s) => s.color || palette[series.indexOf(s) % palette.length];
    const items = series.map(s => ({ color: colorOf(s), mark: markOf(s) }));
    // Bars draw first so lines and areas sit on top of them; a stack keeps
    // its rounded end on the LAST bar only.
    const ordered = [...visible].sort((a, b) => (markOf(a) === 'bar' ? 0 : 1) - (markOf(b) === 'bar' ? 0 : 1));
    const lastBar = [...ordered].reverse().find(s => markOf(s) === 'bar');

    const valueAxis = { tick: axisTick, axisLine: false, tickLine: false, tickFormatter: percent ? (v) => `${Math.round(v * 100)}%` : fmt.axis, width: 56 };
    const catAxis = { dataKey: xKey, tick: axisTick, axisLine: { stroke: 'var(--rule)' }, tickLine: false, minTickGap: 12, interval: 'preserveStartEnd' };

    const marks = ordered.map(s => {
        const i = series.indexOf(s);
        const color = colorOf(s);
        const axisId = !horizontal && s.yAxis === 'right' && hasRight ? 'right' : 'left';
        const mark = markOf(s);
        const common = { key: s.dataKey + s.name, dataKey: s.dataKey, name: s.name, yAxisId: horizontal ? undefined : axisId, isAnimationActive: true, animationDuration: 650 };
        if (mark === 'bar') {
            const r = !stackId || s === lastBar ? 4 : 0;
            return (
                <Bar {...common} stackId={stackId} fill={`url(#${gid}-${horizontal ? 'h' : 'g'}${i})`} maxBarSize={isHist ? 80 : 28}
                    radius={horizontal ? [0, r, r, 0] : [r, r, 0, 0]} stroke={stackId ? 'var(--surface)' : undefined} strokeWidth={stackId ? 1 : 0}>
                    {showBarValues && !stackId && (
                        <LabelList dataKey={s.dataKey} position={horizontal ? 'right' : 'top'} offset={6} formatter={fmt.axis} style={{ fill: 'var(--ink-2)', fontSize: 10.5, fontWeight: 600 }} />
                    )}
                </Bar>
            );
        }
        if (mark === 'area') {
            return <Area {...common} stackId={stackId} type={curveOf(s)} stroke={color} strokeWidth={2} fill={`url(#${gid}-g${i})`} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />;
        }
        // A line drawn over bars traces their tops: a smooth curve with a ringed
        // dot at the centre of every bar.
        const overBars = bars.length > 0;
        const dots = !many && (overBars || data.length <= 30);
        return (
            <Line {...common} type={curveOf(s)} stroke={color} strokeWidth={overBars ? 2.5 : 2} strokeDasharray={s.dashed ? '6 5' : undefined}
                strokeLinecap="round" strokeLinejoin="round"
                dot={dots && !s.dashed ? { r: overBars ? 4 : 3.5, fill: color, stroke: 'var(--surface)', strokeWidth: 2 } : false}
                activeDot={{ r: 5.5, fill: color, stroke: 'var(--surface)', strokeWidth: 2 }}
                style={{ filter: s.dashed ? undefined : `drop-shadow(0 3px 6px ${color}55)` }}>
                {lineCount === 1 && !overBars && !s.dashed && (
                    <LabelList dataKey={s.dataKey} content={EndLabel({ fmt, last: lastIdx })} />
                )}
            </Line>
        );
    });

    const right = (lineCount === 1 && !bars.length) ? 44 : (hasRight ? 4 : 16);
    const margin = { top: showBarValues && !horizontal ? 22 : 12, right: horizontal && showBarValues ? 44 : right, left: 4, bottom: spec.xLabel ? 22 : 4 };
    const Wrapper = combo || isHist || horizontal ? ComposedChart : (base === 'bar' ? BarChart : base === 'area' ? AreaChart : LineChart);
    return (
        <Wrapper data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={margin} stackOffset={percent ? 'expand' : undefined}
            barCategoryGap={isHist ? 2 : (bars.length > 1 && !stackId ? '22%' : '28%')} barGap={3}>
            {Gradients({ items, id: gid, stacked: !!stackId })}
            <CartesianGrid {...gridProps} vertical={horizontal} horizontal={!horizontal} />
            {horizontal ? (
                <>
                    <XAxis type="number" {...valueAxis} axisLine={false} height={24} />
                    <YAxis type="category" {...catAxis} width={Math.min(150, 12 + Math.max(...data.map(d => String(d[xKey] ?? '').length)) * 6.4)} interval={0} />
                </>
            ) : (
                <>
                    <XAxis {...catAxis} label={spec.xLabel ? { value: spec.xLabel, position: 'insideBottom', offset: -14, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                    <YAxis yAxisId="left" {...valueAxis} label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft', offset: 10, fill: 'var(--ink-3)', fontSize: 11, style: { textAnchor: 'middle' } } : undefined} />
                    {hasRight && <YAxis yAxisId="right" orientation="right" {...valueAxis} label={spec.y2Label ? { value: spec.y2Label, angle: 90, position: 'insideRight', fill: 'var(--ink-3)', fontSize: 11 } : undefined} />}
                </>
            )}
            <Tooltip content={<ChartTooltip fmt={fmt} colorMap={Object.fromEntries(series.map(s => [s.name, colorOf(s)]))} />} cursor={bars.length ? { fill: 'var(--ink)', fillOpacity: 0.05 } : { stroke: 'var(--ink-3)', strokeWidth: 1 }} />
            {refLines(spec, data, visible.map(s => s.dataKey), fmt, horizontal)}
            {marks}
        </Wrapper>
    );
}

// ── waterfall ─────────────────────────────────────────────────────────────
function WaterfallChart({ spec, light, fmt, gid }) {
    const up = light ? UP.light : UP.dark, down = light ? DOWN.light : DOWN.dark, total = light ? PALETTE.light[0] : PALETTE.dark[0];
    const colorOf = (d) => (d._kind === 'total' ? total : d._kind === 'up' ? up : down);
    return (
        <ComposedChart data={spec.data} margin={{ top: 22, right: 12, left: 4, bottom: spec.xLabel ? 22 : 4 }} barCategoryGap="22%">
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="name" tick={axisTick} axisLine={{ stroke: 'var(--rule)' }} tickLine={false} interval={0} minTickGap={4} />
            <YAxis yAxisId="left" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmt.axis} width={56} />
            <Tooltip content={<ChartTooltip fmt={fmt} kind="waterfall" />} cursor={{ fill: 'var(--ink)', fillOpacity: 0.05 }} />
            <ReferenceLine y={0} yAxisId="left" stroke="var(--rule)" />
            <Bar yAxisId="left" dataKey="_range" name="Change" maxBarSize={40} radius={4} isAnimationActive animationDuration={650}>
                {spec.data.map((d, i) => <Cell key={i} fill={colorOf(d)} />)}
                <LabelList dataKey="value" position="top" offset={6} formatter={(v) => fmt.axis(v)} style={{ fill: 'var(--ink-2)', fontSize: 10.5, fontWeight: 600 }} />
            </Bar>
        </ComposedChart>
    );
}

// Round a [lo, hi] range out to clean tick steps (1/2/2.5/5 × 10^n).
function niceDomain(lo, hi, ticks = 5) {
    const span = hi - lo || Math.abs(hi) || 1;
    const raw = span / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) || 10 * mag;
    return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

// ── candlestick (+ volume below) ──────────────────────────────────────────
function CandleShape(props) {
    const { x, y, width, height, payload, up, down } = props;
    if (!payload || !Number.isFinite(y) || !Number.isFinite(height)) return null;
    const { open, close, high, low } = payload;
    const span = high - low || 1;
    const yOf = (v) => y + ((high - v) / span) * height;
    const isUp = close >= open;
    const color = isUp ? up : down;
    const bodyTop = yOf(Math.max(open, close)), bodyBot = yOf(Math.min(open, close));
    const w = Math.max(2, Math.min(14, width * 0.7));
    const cx = x + width / 2;
    return (
        <g>
            <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1.25} />
            <rect x={cx - w / 2} y={bodyTop} width={w} height={Math.max(1.5, bodyBot - bodyTop)} rx={1.5} fill={color} />
        </g>
    );
}
function CandleChart({ spec, light, fmt }) {
    const up = light ? UP.light : UP.dark, down = light ? DOWN.light : DOWN.dark;
    const xKey = spec.xKey;
    const lows = spec.data.map(d => d.low), highs = spec.data.map(d => d.high);
    const domain = niceDomain(Math.min(...lows), Math.max(...highs));
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ flex: spec.hasVolume ? '1 1 76%' : '1 1 100%', minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={spec.data} syncId={`c-${xKey}`} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="18%">
                        <CartesianGrid {...gridProps} />
                        <XAxis dataKey={xKey} tick={spec.hasVolume ? false : axisTick} axisLine={{ stroke: 'var(--rule)' }} tickLine={false} minTickGap={16} height={spec.hasVolume ? 4 : 24} />
                        <YAxis yAxisId="left" domain={domain} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmt.axis} width={56} />
                        <Tooltip content={<ChartTooltip fmt={fmt} kind="candle" />} cursor={{ fill: 'var(--ink)', fillOpacity: 0.05 }} />
                        <Bar yAxisId="left" dataKey="_hl" name="Price" shape={(p) => <CandleShape {...p} up={up} down={down} />} isAnimationActive={false}>
                            {spec.data.map((d, i) => <Cell key={i} fill={d.close >= d.open ? up : down} />)}
                        </Bar>
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
            {spec.hasVolume && (
                <div style={{ flex: '0 0 24%', minHeight: 54 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={spec.data} syncId={`c-${xKey}`} margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barCategoryGap="18%">
                            <XAxis dataKey={xKey} tick={axisTick} axisLine={{ stroke: 'var(--rule)' }} tickLine={false} minTickGap={16} />
                            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => Number(v).toLocaleString(undefined, { notation: 'compact' })} tickCount={2} />
                            <Tooltip content={() => null} cursor={{ fill: 'var(--ink)', fillOpacity: 0.05 }} />
                            <Bar dataKey="volume" name="Volume" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                                {spec.data.map((d, i) => <Cell key={i} fill={d.close >= d.open ? up : down} fillOpacity={0.45} />)}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}

// ── scatter / bubble ──────────────────────────────────────────────────────
function ScatterPlot({ spec, palette, fmt, hidden }) {
    // Older saved specs carried raw rows; v2 carries normalized points.
    const pts = (spec.data || []).map(d => ({ ...d, x: Number(d.x ?? d[spec.xKey]), y: Number(d.y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    const groups = spec.groups && spec.groups.length ? spec.groups : [null];
    return (
        <ScatterChart margin={{ top: 12, right: 16, left: 4, bottom: spec.xLabel ? 22 : 4 }}>
            <CartesianGrid {...gridProps} vertical horizontal />
            <XAxis type="number" dataKey="x" name={spec.xLabel || 'x'} tick={axisTick} axisLine={{ stroke: 'var(--rule)' }} tickLine={false} tickFormatter={fmt.axis} domain={['auto', 'auto']}
                label={spec.xLabel ? { value: spec.xLabel, position: 'insideBottom', offset: -14, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
            <YAxis type="number" dataKey="y" name={spec.yLabel || 'y'} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmt.axis} width={56} domain={['auto', 'auto']}
                label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft', offset: 10, fill: 'var(--ink-3)', fontSize: 11, style: { textAnchor: 'middle' } } : undefined} />
            {spec.bubble && <ZAxis type="number" dataKey="z" range={[50, 900]} />}
            <Tooltip content={<ChartTooltip fmt={fmt} kind="scatter" xLabel={spec.xLabel} />} cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }} />
            {groups.map((g, i) => (hidden.has(String(g)) ? null : (
                <Scatter key={String(g)} name={g || 'Points'} data={g == null ? pts : pts.filter(p => p.group === g)}
                    fill={palette[i % palette.length]} fillOpacity={spec.bubble ? 0.62 : 0.88} stroke="var(--surface)" strokeWidth={spec.bubble ? 1.5 : 1.5}
                    isAnimationActive animationDuration={600} />
            )))}
            {spec.trend && <Scatter name="Trend" data={spec.trend} line={{ stroke: 'var(--ink-2)', strokeWidth: 1.5, strokeDasharray: '6 5' }} shape={() => null} legendType="none" isAnimationActive={false} />}
        </ScatterChart>
    );
}

// ── parts: pie / donut / radialBar / funnel / treemap ─────────────────────
function partsData(spec) {
    const raw = (spec.data || []).map((d, i) => ({
        name: d.name ?? d.label ?? d.x ?? `Item ${i + 1}`,
        value: typeof d.value === 'number' ? d.value : Number(d.y ?? d.value ?? 0),
        other: d.other,
    })).filter(d => Number.isFinite(d.value));
    const total = raw.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
    return raw.map(d => ({ ...d, _share: Math.max(0, d.value) / total }));
}

function PartsList({ data, colors, fmt, hidden, onToggle }) {
    return (
        <div className="chart-parts">
            {data.map((d, i) => (
                <button type="button" key={d.name} className={`chart-parts__row${hidden.has(d.name) ? ' is-off' : ''}`} onClick={() => onToggle(d.name)}>
                    <span className="chart-parts__swatch" style={{ background: colors[i] }} />
                    <span className="chart-parts__name">{d.name}</span>
                    <span className="chart-parts__val">{fmt.full(d.value)}</span>
                    <span className="chart-parts__pct">{(d._share * 100).toFixed(d._share < 0.1 ? 1 : 0)}%</span>
                </button>
            ))}
        </div>
    );
}

function PieLike({ spec, palette, fmt, hidden, onToggle, light }) {
    const all = partsData(spec);
    const colors = all.map((d, i) => (d.other ? (light ? '#a8a8a3' : '#6a6a66') : palette[i % palette.length]));
    const shown = all.map((d, i) => ({ ...d, fill: colors[i] })).filter(d => !hidden.has(d.name));
    const donut = spec.type === 'donut';
    const total = shown.reduce((a, d) => a + d.value, 0);
    return (
        <div className="chart-split">
            <div className="chart-split__plot">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Tooltip content={<ChartTooltip fmt={fmt} kind="parts" />} />
                        <Pie data={shown} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={donut ? '60%' : 0} outerRadius="92%"
                            paddingAngle={shown.length > 1 ? 1.5 : 0} cornerRadius={donut ? 5 : 3} stroke="var(--surface)" strokeWidth={2}
                            isAnimationActive animationDuration={700} startAngle={90} endAngle={-270}>
                            {shown.map((d) => <Cell key={d.name} fill={d.fill} />)}
                        </Pie>
                        {donut && (
                            <>
                                <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" fill="var(--ink)" fontSize={20} fontWeight={650}>{fmt.axis(total)}</text>
                                <text x="50%" y="58%" textAnchor="middle" dominantBaseline="middle" fill="var(--ink-3)" fontSize={11}>{spec.centerLabel || 'Total'}</text>
                            </>
                        )}
                    </PieChart>
                </ResponsiveContainer>
            </div>
            <PartsList data={all} colors={colors} fmt={fmt} hidden={hidden} onToggle={onToggle} />
        </div>
    );
}

function RadialBars({ spec, palette, fmt, hidden, onToggle }) {
    const all = partsData(spec);
    const colors = all.map((_, i) => palette[i % palette.length]);
    const max = Math.max(...all.map(d => d.value), 0) || 1;
    const shown = all.map((d, i) => ({ ...d, fill: colors[i] })).filter(d => !hidden.has(d.name)).reverse();
    return (
        <div className="chart-split">
            <div className="chart-split__plot">
                <ResponsiveContainer width="100%" height="100%">
                    <RadialBarChart data={shown} innerRadius="22%" outerRadius="100%" startAngle={90} endAngle={-270} barCategoryGap="18%">
                        <PolarAngleAxis type="number" domain={[0, spec.max || max]} tick={false} />
                        <RadialBar dataKey="value" cornerRadius={8} background={{ fill: 'var(--ink)', fillOpacity: 0.06 }} isAnimationActive animationDuration={700} />
                        <Tooltip content={<ChartTooltip fmt={fmt} kind="parts" />} cursor={false} />
                    </RadialBarChart>
                </ResponsiveContainer>
            </div>
            <PartsList data={all} colors={colors} fmt={fmt} hidden={hidden} onToggle={onToggle} />
        </div>
    );
}

function FunnelPlot({ spec, light, fmt }) {
    // Centred horizontal bars: an invisible pad on each side keeps every
    // stage centred; the label column shows value and conversion from the
    // first stage. Ordinal blue ramp, darkest = largest.
    const all = partsData(spec);
    const ramp = light ? SEQ.slice(4, 12).reverse() : SEQ_DARK.slice(5).reverse();
    const first = all[0]?.value || 1;
    const max = Math.max(...all.map(d => d.value)) || 1;
    const data = all.map((d, i) => ({
        ...d, _pad: (max - d.value) / 2, _fill: ramp[Math.min(ramp.length - 1, Math.round(i * (ramp.length - 1) / Math.max(1, all.length - 1)))],
        _label: `${fmt.axis(d.value)}${i ? `  ·  ${((d.value / first) * 100).toFixed(d.value / first < 0.1 ? 1 : 0)}%` : ''}`,
    }));
    const nameW = Math.min(150, 14 + Math.max(...data.map(d => String(d.name).length)) * 6.6);
    return (
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 96, left: 4, bottom: 4 }} barCategoryGap="14%">
            <XAxis type="number" hide domain={[0, max]} />
            <YAxis type="category" dataKey="name" tick={{ fill: 'var(--ink-2)', fontSize: 12 }} axisLine={false} tickLine={false} width={nameW} />
            <Tooltip content={<ChartTooltip fmt={fmt} kind="parts" />} cursor={{ fill: 'var(--ink)', fillOpacity: 0.04 }} />
            <Bar dataKey="_pad" stackId="f" fill="transparent" isAnimationActive={false} legendType="none" />
            <Bar dataKey="value" name="Value" stackId="f" radius={5} isAnimationActive animationDuration={650}>
                {data.map((d, i) => <Cell key={i} fill={d._fill} />)}
                <LabelList dataKey="_label" content={(p) => {
                    const d = data[p.index];
                    if (!d || !Number.isFinite(p.x) || !Number.isFinite(p.width)) return null;
                    return <text x={p.x + p.width + 10} y={p.y + p.height / 2} dy={4} fill="var(--ink-2)" fontSize={11.5} fontWeight={600}>{d._label}</text>;
                }} />
            </Bar>
        </BarChart>
    );
}

function TreeCell(props) {
    const { x, y, width, height, name, value, index, colors, fmt, depth } = props;
    if (depth !== 1 || width <= 0 || height <= 0) return null;
    const fill = colors[index % colors.length];
    const fits = width > 54 && height > 30;
    return (
        <g>
            <rect x={x + 1} y={y + 1} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} rx={6} fill={fill} fillOpacity={0.92} />
            {fits && <text x={x + 9} y={y + 19} fill="#ffffff" fontSize={12} fontWeight={600}>{String(name).length * 7 > width - 14 ? `${String(name).slice(0, Math.max(3, Math.floor((width - 18) / 7)))}…` : name}</text>}
            {fits && height > 46 && <text x={x + 9} y={y + 36} fill="#ffffff" fillOpacity={0.85} fontSize={11}>{fmt.axis(value)}</text>}
        </g>
    );
}
function TreemapPlot({ spec, palette, fmt }) {
    const data = partsData(spec).filter(d => d.value > 0).sort((a, b) => b.value - a.value);
    return (
        <Treemap data={data} dataKey="value" nameKey="name" aspectRatio={4 / 3} isAnimationActive={false}
            content={<TreeCell colors={palette} fmt={fmt} />}>
            <Tooltip content={<ChartTooltip fmt={fmt} kind="parts" />} />
        </Treemap>
    );
}

// ── radar ─────────────────────────────────────────────────────────────────
function RadarPlot({ spec, palette, fmt, hidden }) {
    const xKey = xKeyOf(spec);
    const series = resolveSeries(spec, xKey);
    return (
        <RadarChart data={spec.data} outerRadius="76%" margin={{ top: 8, right: 24, left: 24, bottom: 8 }}>
            <PolarGrid stroke="var(--rule-2)" />
            <PolarAngleAxis dataKey={xKey} tick={{ fill: 'var(--ink-2)', fontSize: 11 }} />
            <PolarRadiusAxis tick={{ fill: 'var(--ink-3)', fontSize: 9.5 }} axisLine={false} tickFormatter={fmt.axis} angle={90 - 180 / Math.max(3, spec.data.length)} tickCount={4} />
            <Tooltip content={<ChartTooltip fmt={fmt} />} />
            {series.filter(s => !hidden.has(s.dataKey + s.name)).map((s) => {
                const color = s.color || palette[series.indexOf(s) % palette.length];
                return <Radar key={s.dataKey + s.name} name={s.name} dataKey={s.dataKey} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.16}
                    dot={{ r: 3, fill: color, stroke: 'var(--surface)', strokeWidth: 1.5 }} isAnimationActive animationDuration={650} />;
            })}
        </RadarChart>
    );
}

// ── heatmap (SVG grid) ────────────────────────────────────────────────────
function Heatmap({ spec, light, fmt }) {
    const [hover, setHover] = useState(null);
    const ramp = light ? SEQ : SEQ_DARK;
    const { xs = [], ys = [], cells = [], min = 0, max = 1 } = spec;
    const lookup = useMemo(() => { const m = new Map(); for (const c of cells) m.set(`${c.x}\u0000${c.y}`, c.v); return m; }, [cells]);
    const labelW = Math.min(120, 10 + Math.max(0, ...ys.map(y => String(y).length)) * 6.5);
    const cw = 34, ch = 26, gap = 2, top = 22;
    const W = labelW + xs.length * (cw + gap), H = top + ys.length * (ch + gap) + 30;
    const colorOf = (v) => (v == null ? 'transparent' : ramp[Math.round(((v - min) / ((max - min) || 1)) * (ramp.length - 1))]);
    const step = Math.max(1, Math.ceil(xs.length / 14));
    return (
        <div className="chart-heat">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: H * 1.4, display: 'block' }} role="img">
                {xs.map((x, i) => (i % step === 0 ? <text key={x} x={labelW + i * (cw + gap) + cw / 2} y={14} textAnchor="middle" fill="var(--ink-3)" fontSize={10}>{String(x).slice(0, 8)}</text> : null))}
                {ys.map((y, j) => (
                    <g key={y}>
                        <text x={labelW - 8} y={top + j * (ch + gap) + ch / 2 + 4} textAnchor="end" fill="var(--ink-3)" fontSize={10.5}>{String(y).slice(0, 16)}</text>
                        {xs.map((x, i) => {
                            const v = lookup.get(`${x}\u0000${y}`);
                            const on = hover && hover.x === x && hover.y === y;
                            return <rect key={x} x={labelW + i * (cw + gap)} y={top + j * (ch + gap)} width={cw} height={ch} rx={4}
                                fill={v == null ? 'var(--ink)' : colorOf(v)} fillOpacity={v == null ? 0.04 : 1}
                                stroke={on ? 'var(--ink)' : 'none'} strokeWidth={on ? 1.5 : 0}
                                onMouseEnter={() => setHover({ x, y, v })} onMouseLeave={() => setHover(null)} />;
                        })}
                    </g>
                ))}
                <defs>
                    <linearGradient id="heat-scale" x1="0" x2="1" y1="0" y2="0">
                        {ramp.map((c, i) => <stop key={i} offset={`${(i / (ramp.length - 1)) * 100}%`} stopColor={c} />)}
                    </linearGradient>
                </defs>
                <rect x={labelW} y={H - 18} width={Math.min(180, W - labelW)} height={8} rx={4} fill="url(#heat-scale)" />
                <text x={labelW - 6} y={H - 10} textAnchor="end" fill="var(--ink-3)" fontSize={10}>{fmt.axis(min)}</text>
                <text x={labelW + Math.min(180, W - labelW) + 6} y={H - 10} fill="var(--ink-3)" fontSize={10}>{fmt.axis(max)}</text>
            </svg>
            <div className="chart-heat__hover">{hover ? <><b>{hover.y}</b> · {hover.x}: <b>{fmt.full(hover.v)}</b></> : <span>Hover a cell for its value</span>}</div>
        </div>
    );
}

// ── table view + downloads ────────────────────────────────────────────────
function tableOf(spec) {
    const t = spec.type;
    if (t === 'heatmap') {
        const m = new Map((spec.cells || []).map(c => [`${c.x}\u0000${c.y}`, c.v]));
        return { cols: ['', ...(spec.xs || [])], rows: (spec.ys || []).map(y => [y, ...(spec.xs || []).map(x => m.get(`${x}\u0000${y}`))]) };
    }
    if (['pie', 'donut', 'radialBar', 'funnel', 'treemap'].includes(t)) {
        const d = partsData(spec);
        return { cols: ['Name', 'Value', 'Share'], rows: d.map(r => [r.name, r.value, `${(r._share * 100).toFixed(1)}%`]) };
    }
    if (t === 'scatter') {
        const has = (k) => (spec.data || []).some(p => p[k] != null);
        const cols = [has('label') && 'label', has('group') && 'group', 'x', 'y', has('z') && 'z'].filter(Boolean);
        return { cols, rows: (spec.data || []).map(p => cols.map(c => p[c])) };
    }
    if (t === 'waterfall') return { cols: ['Step', 'Change', 'Running total'], rows: spec.data.map(d => [d.name, d.value, d._end]) };
    if (t === 'candlestick') {
        const cols = [spec.xKey, 'open', 'high', 'low', 'close', ...(spec.hasVolume ? ['volume'] : [])];
        return { cols, rows: spec.data.map(d => cols.map(c => d[c])) };
    }
    const xKey = xKeyOf(spec);
    const series = resolveSeries(spec, xKey);
    return { cols: [spec.xLabel || xKey, ...series.map(s => s.name)], rows: spec.data.map(d => [d[xKey], ...series.map(s => d[s.dataKey])]) };
}

function DataTable({ spec, fmt }) {
    const { cols, rows } = tableOf(spec);
    return (
        <div className="chart-table">
            <table>
                <thead><tr>{cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{rows.slice(0, 500).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'is-num' : ''}>{typeof v === 'number' ? fmt.full(v) : (v ?? '—')}</td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}

function slug(s) { return (String(s || 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chart').slice(0, 60); }

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvOf(spec) {
    const { cols, rows } = tableOf(spec);
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols, ...rows].map(r => r.map(esc).join(',')).join('\n');
}

// Inline computed paint so the exported SVG does not depend on CSS variables.
async function exportPng(root, title, light) {
    const svgs = [...root.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 60 && !s.closest('.chart-actions'));
    if (!svgs.length) return;
    const box = root.getBoundingClientRect();
    const scale = 2;
    const canvas = document.createElement('canvas');
    const headH = title ? 34 : 8;
    canvas.width = Math.ceil(box.width * scale);
    canvas.height = Math.ceil((box.height + headH) * scale);
    const ctx = canvas.getContext('2d');
    const cs = getComputedStyle(root);
    ctx.fillStyle = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : (light ? '#ffffff' : '#161618');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (title) {
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-primary') || (light ? '#111' : '#eee');
        ctx.font = `600 ${15 * scale}px system-ui, -apple-system, Segoe UI, sans-serif`;
        ctx.fillText(title, 14 * scale, 22 * scale);
    }
    for (const svg of svgs) {
        const r = svg.getBoundingClientRect();
        const clone = svg.cloneNode(true);
        const src = svg.querySelectorAll('*'), dst = clone.querySelectorAll('*');
        src.forEach((el, i) => {
            const st = getComputedStyle(el);
            const d = dst[i];
            if (!d) return;
            for (const p of ['fill', 'stroke', 'stop-color', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-weight', 'font-family', 'filter']) {
                const v = st.getPropertyValue(p);
                if (v) d.style.setProperty(p, v);
            }
        });
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', r.width); clone.setAttribute('height', r.height);
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
        await new Promise((res) => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, (r.left - box.left) * scale, (r.top - box.top + headH) * scale, r.width * scale, r.height * scale); URL.revokeObjectURL(url); res(); };
            img.onerror = () => { URL.revokeObjectURL(url); res(); };
            img.src = url;
        });
    }
    canvas.toBlob((b) => b && downloadBlob(b, `${slug(title)}.png`), 'image/png');
}

const Icon = {
    table: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></svg>,
    chart: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
    image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>,
};

// ── the block ─────────────────────────────────────────────────────────────
let chartSeq = 0;
export default function ChartBlock({ spec, summary }) {
    const light = useLightSurface();
    const palette = light ? PALETTE.light : PALETTE.dark;
    const [hidden, setHidden] = useState(() => new Set());
    const [view, setView] = useState('chart');
    const gid = useRef(`ch${++chartSeq}`).current;
    const cardRef = useRef(null);
    const toggle = useCallback((k) => setHidden(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);

    const valid = spec && ((Array.isArray(spec.data) && spec.data.length) || (spec.type === 'heatmap' && Array.isArray(spec.cells) && spec.cells.length));
    const fmt = useMemo(() => makeFormat(spec || {}), [spec]);
    const type = spec ? (spec.combo ? 'combo' : spec.type) : null;

    const legendItems = useMemo(() => {
        if (!valid) return [];
        if (['line', 'bar', 'area', 'combo', 'radar'].includes(type)) {
            const xKey = xKeyOf(spec);
            const series = resolveSeries(spec, xKey);
            return series.map((s, i) => ({ key: s.dataKey + s.name, name: s.name, color: s.color || palette[i % palette.length], mark: type === 'radar' ? 'area' : (s.type || (type === 'combo' ? 'line' : type)), dashed: s.dashed }));
        }
        if (type === 'scatter' && spec.groups && spec.groups.length > 1) return spec.groups.map((g, i) => ({ key: String(g), name: g, color: palette[i % palette.length], mark: 'dot' }));
        return [];
    }, [valid, spec, type, palette]);

    if (!valid) {
        return <div className="chart-card chart-card--empty">No chart data to display.</div>;
    }

    const n = Array.isArray(spec.data) ? spec.data.length : 0;
    let height = 300;
    if (spec.horizontal) height = Math.max(180, Math.min(640, 34 + n * 32));
    else if (type === 'candlestick') height = spec.hasVolume ? 360 : 300;
    else if (['pie', 'donut', 'radialBar'].includes(type)) height = 260;
    else if (type === 'funnel') height = Math.max(200, Math.min(420, n * 54));
    else if (type === 'treemap') height = 300;
    else if (type === 'radar') height = 320;

    let body = null;
    const props = { spec, palette, fmt, hidden, onToggle: toggle, light, gid };
    if (type === 'heatmap') body = <Heatmap {...props} />;
    else if (type === 'candlestick') body = <CandleChart {...props} />;
    else if (['pie', 'donut'].includes(type)) body = <PieLike {...props} />;
    else if (type === 'radialBar') body = <RadialBars {...props} />;
    else {
        // Called as functions, not mounted as components: ResponsiveContainer
        // hands width/height to its DIRECT child, which must be the Recharts
        // chart itself (a wrapper component in between renders nothing).
        let inner = null;
        if (['line', 'bar', 'area', 'combo', 'histogram'].includes(type)) inner = CartesianChart({ ...props, spec: type === 'histogram' ? { ...spec, type: 'bar' } : spec });
        else if (type === 'waterfall') inner = WaterfallChart(props);
        else if (type === 'scatter') inner = ScatterPlot(props);
        else if (type === 'funnel') inner = FunnelPlot(props);
        else if (type === 'treemap') inner = TreemapPlot(props);
        else if (type === 'radar') inner = RadarPlot(props);
        body = inner ? <ResponsiveContainer width="100%" height="100%">{inner}</ResponsiveContainer> : <div className="chart-card--empty">Unsupported chart type: {String(spec.type)}</div>;
    }

    const title = spec.title || '';
    const sub = summary || spec.subtitle || '';
    const fixedHeight = type !== 'heatmap';
    return (
        <figure className="chart-card" ref={cardRef} aria-label={title || 'Chart'}>
            <div className="chart-card__head">
                <div className="chart-card__titles">
                    {title && <figcaption className="chart-card__title">{title}</figcaption>}
                    {sub && <div className="chart-card__sub">{sub}</div>}
                </div>
                <div className="chart-actions">
                    <button type="button" className="chart-actions__btn" onClick={() => setView(v => (v === 'chart' ? 'table' : 'chart'))} title={view === 'chart' ? 'Show the data as a table' : 'Show the chart'}>
                        {view === 'chart' ? Icon.table : Icon.chart}<span>{view === 'chart' ? 'Table' : 'Chart'}</span>
                    </button>
                    <button type="button" className="chart-actions__btn" title="Download (PNG; Shift-click for CSV)"
                        onClick={(e) => {
                            if (e.shiftKey || view === 'table') downloadBlob(new Blob([csvOf(spec)], { type: 'text/csv' }), `${slug(title)}.csv`);
                            else if (cardRef.current) exportPng(cardRef.current.querySelector('.chart-card__plot') || cardRef.current, title, light).catch(() => {});
                        }}>
                        {Icon.image}<span>{view === 'table' ? 'CSV' : 'PNG'}</span>
                    </button>
                </div>
            </div>
            {view === 'chart' && <Legend items={legendItems} hidden={hidden} onToggle={toggle} />}
            {view === 'chart' ? (
                <div className="chart-card__plot" style={fixedHeight ? { height } : undefined}>{body}</div>
            ) : (
                <DataTable spec={spec} fmt={fmt} />
            )}
            {spec.type === 'histogram' && spec.sampleSize && view === 'chart' && <div className="chart-card__foot">{spec.sampleSize.toLocaleString()} values · {n} bins</div>}
        </figure>
    );
}
