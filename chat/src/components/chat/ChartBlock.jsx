import React, { useMemo } from 'react';
import {
    LineChart, Line,
    BarChart, Bar,
    AreaChart, Area,
    PieChart, Pie, Cell,
    ScatterChart, Scatter,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend,
    ResponsiveContainer,
} from 'recharts';

// Default palette — distinct hues that read OK on both light and dark
// themes. Picked to match the existing accent palette in chat/'s CSS vars.
const DEFAULT_COLORS = [
    '#6366f1', // indigo
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#06b6d4', // cyan
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#84cc16', // lime
];

// Inline chart renderer for the render_chart native tool result. Receives
// the chartSpec object the server validated and echoed back in
// tool_result.result.chartSpec.
//
// The wrapping ToolCallBlock chip already shows the tool name + status —
// here we just render the chart itself and an optional summary line.
export default function ChartBlock({ spec, summary }) {
    if (!spec || !Array.isArray(spec.data) || spec.data.length === 0) {
        return null;
    }
    const { type, title, xLabel, yLabel, data, series } = spec;

    // Resolve the list of series we'll draw. For single-series charts the
    // model usually emits {x, y} rows with no `series[]` — we synthesise
    // a single "value" series that points at `y`. Multi-series charts
    // either declare series explicitly OR we infer them from non-x keys.
    const resolvedSeries = useMemo(() => {
        if (Array.isArray(series) && series.length > 0) {
            return series.map((s, i) => ({
                name: s.name,
                color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
            }));
        }
        if (type === 'pie') return [];
        if (type === 'scatter') {
            return [{ name: 'value', color: DEFAULT_COLORS[0] }];
        }
        // Try to infer series from data keys, excluding the x-axis key.
        const sample = data[0] || {};
        const keys = Object.keys(sample).filter(k => k !== 'x' && k !== 'label' && k !== 'date');
        if (keys.length === 1 && keys[0] === 'y') {
            return [{ name: 'y', color: DEFAULT_COLORS[0] }];
        }
        if (keys.length === 0) {
            return [{ name: 'y', color: DEFAULT_COLORS[0] }];
        }
        return keys.map((k, i) => ({
            name: k,
            color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        }));
    }, [type, series, data]);

    // The x-axis key. Common shapes: { x, y }, { date, close }, { label, value }.
    const xKey = useMemo(() => {
        const sample = data[0] || {};
        if ('x' in sample) return 'x';
        if ('date' in sample) return 'date';
        if ('label' in sample) return 'label';
        const keys = Object.keys(sample);
        return keys[0] || 'x';
    }, [data]);

    const chartHeight = 320;

    const tooltipStyle = {
        background: 'var(--surface)',
        border: '1px solid var(--rule-2)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--ink)',
    };
    const axisProps = {
        tick: { fill: 'var(--ink-3)', fontSize: 11 },
        stroke: 'var(--rule)',
    };

    let chart = null;
    if (type === 'line') {
        chart = (
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: xLabel ? 24 : 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-2)" />
                <XAxis dataKey={xKey} {...axisProps} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -8, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <YAxis {...axisProps} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <Tooltip contentStyle={tooltipStyle} />
                {resolvedSeries.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {resolvedSeries.map(s => (
                    <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={2} dot={data.length <= 30} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
            </LineChart>
        );
    } else if (type === 'bar') {
        chart = (
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: xLabel ? 24 : 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-2)" />
                <XAxis dataKey={xKey} {...axisProps} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -8, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <YAxis {...axisProps} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-2)' }} />
                {resolvedSeries.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {resolvedSeries.map(s => (
                    <Bar key={s.name} dataKey={s.name} fill={s.color} isAnimationActive={false} />
                ))}
            </BarChart>
        );
    } else if (type === 'area') {
        chart = (
            <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: xLabel ? 24 : 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-2)" />
                <XAxis dataKey={xKey} {...axisProps} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -8, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <YAxis {...axisProps} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <Tooltip contentStyle={tooltipStyle} />
                {resolvedSeries.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {resolvedSeries.map(s => (
                    <Area key={s.name} type="monotone" dataKey={s.name} stroke={s.color} fill={s.color} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
                ))}
            </AreaChart>
        );
    } else if (type === 'scatter') {
        // Scatter expects {x,y} numeric pairs. Map data into that shape if
        // it's not already there.
        const scatterData = data.map(d => ({
            x: typeof d.x === 'number' ? d.x : (typeof d[xKey] === 'number' ? d[xKey] : Number(d[xKey])),
            y: typeof d.y === 'number' ? d.y : Number(d.y),
            label: d.label,
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
        chart = (
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: xLabel ? 24 : 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-2)" />
                <XAxis type="number" dataKey="x" {...axisProps} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -8, fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <YAxis type="number" dataKey="y" {...axisProps} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--ink-3)', fontSize: 11 } : undefined} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter data={scatterData} fill={DEFAULT_COLORS[0]} isAnimationActive={false} />
            </ScatterChart>
        );
    } else if (type === 'pie') {
        // Pie expects [{label/name, value}, ...]
        const pieData = data.map((d, i) => ({
            name: d.label || d.name || d.x || `Slice ${i + 1}`,
            value: typeof d.value === 'number' ? d.value : Number(d.y ?? d.value ?? 0),
        })).filter(d => Number.isFinite(d.value) && d.value > 0);
        chart = (
            <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%" cy="50%"
                    outerRadius={120}
                    label={(entry) => entry.name}
                    isAnimationActive={false}
                >
                    {pieData.map((_, i) => (
                        <Cell key={i} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
                    ))}
                </Pie>
            </PieChart>
        );
    }

    if (!chart) {
        return (
            <div style={{ padding: 12, color: 'var(--ink-3)', fontSize: 12 }}>
                Unsupported chart type: {String(type)}
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            background: 'var(--surface)',
            border: '1px solid var(--rule-2)',
            borderRadius: 8,
            padding: '12px 14px',
            width: '100%',
            minWidth: 320,
        }}>
            {title && (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {title}
                </div>
            )}
            {summary && (
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    {summary}
                </div>
            )}
            <div style={{ width: '100%', height: chartHeight }}>
                <ResponsiveContainer width="100%" height="100%">
                    {chart}
                </ResponsiveContainer>
            </div>
        </div>
    );
}
