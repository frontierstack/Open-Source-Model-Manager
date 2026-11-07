import React from 'react';
import {
    Loader2 as SpinnerIcon,
    TrendingDown as DownIcon,
    TrendingUp as UpIcon,
    Minus as FlatIcon,
    Award as BestIcon,
    PenLine as RefineIcon,
    CheckCircle2 as BetterIcon,
    AlertTriangle as WorseIcon,
    Activity as ActivityIcon,
    Wrench as FixIcon,
    ShieldCheck as SteadyIcon,
    RotateCcw as RevertIcon,
    RefreshCw as CheckIcon,
    MessageSquareWarning as CorrectedIcon,
} from 'lucide-react';

// Memory tab → Stats. Is core memory making the work better? Shows what is
// improving or getting worse (each with its evidence), response times, every
// measure by week and per task, tasks with the memory against cold starts,
// how a theme's Nth task compares with its typical one, and what happened
// after each memory update. Data: GET /api/memories/stats.

const GOOD = '#10b981';
const BAD = '#ef4444';
const ACCENT = 'var(--accent-primary)';
const MUTED = 'var(--text-tertiary)';
const RULE = 'var(--border-primary)';

function pct(x, d = 0) { return x == null ? '—' : `${(x * 100).toFixed(d)}%`; }
function n1(x) { return x == null ? '—' : (Math.round(x * 10) / 10).toString(); }
function shortDate(iso) {
    if (!iso) return '';
    const bare = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    const d = new Date(bare ? `${iso}T00:00:00Z` : iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(bare ? { timeZone: 'UTC' } : {}) });
}
function fmtSecs(s) {
    if (s == null) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return r ? `${m}m ${r}s` : `${m}m`;
}
function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// How each measure is displayed. All outcome measures are lower-is-better.
const METRIC_FMT = {
    seconds: { label: 'Response time', fmt: fmtSecs, unit: '' },
    calls: { label: 'Tool calls per task', fmt: n1 },
    failedShare: { label: 'Failed tool calls', fmt: (v) => pct(v, 0) },
    rough: { label: 'Tasks that flailed', fmt: (v) => pct(v, 0) },
    corrected: { label: 'Answers you corrected', fmt: (v) => pct(v, 0) },
};

// --------------------------------------------------------------- primitives

function useWidth(min = 240) {
    const ref = React.useRef(null);
    const [width, setWidth] = React.useState(420);
    React.useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => setWidth(Math.max(min, Math.floor(e.contentRect.width))));
        ro.observe(el);
        return () => ro.disconnect();
    }, [min]);
    return [ref, width];
}

function niceTicks(max, count = 4) {
    if (!(max > 0)) return { top: 1, ticks: [0, 1] };
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { top, ticks };
}

// Change chip. `kind` relative → %, points → percentage points. Lower is
// better unless `invert`. Direction is carried by an icon and a sign.
function Change({ value, kind = 'relative', invert = false, small = false, threshold }) {
    if (value == null) return <span style={{ color: MUTED }}>—</span>;
    const t = threshold ?? (kind === 'points' ? 0.03 : 0.08);
    const good = invert ? value > t : value < -t;
    const bad = invert ? value < -t : value > t;
    const Icon = value < -t ? DownIcon : value > t ? UpIcon : FlatIcon;
    const color = good ? GOOD : bad ? BAD : MUTED;
    const txt = kind === 'points'
        ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)} pts`
        : `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
    return (
        <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${small ? 'text-xs' : ''}`} style={{ color }}>
            <Icon size={small ? 12 : 14} strokeWidth={2} />{txt}
        </span>
    );
}

const EVIDENCE = {
    strong: { label: 'strong evidence', dots: 3 },
    moderate: { label: 'some evidence', dots: 2 },
    weak: { label: 'could be chance', dots: 1 },
};
function Evidence({ level, p, nFrom, nTo }) {
    const e = EVIDENCE[level] || EVIDENCE.weak;
    const title = `${e.label}${p != null ? ` · p = ${p < 0.001 ? '<0.001' : p.toFixed(3)}` : ''}${nFrom != null ? ` · ${nFrom} vs ${nTo} tasks` : ''}`;
    return (
        <span className="inline-flex items-center gap-1 text-[0.7rem]" style={{ color: MUTED }} title={title}>
            <span className="inline-flex gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                    <span key={i} className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: i < e.dots ? 'var(--text-secondary)' : 'var(--bg-hover)' }} />
                ))}
            </span>
            {e.label}
        </span>
    );
}

// ------------------------------------------------------------ live motion

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tween a number to its new value (ease-out), starting from what was shown.
function useTween(target, duration = 900) {
    const [shown, setShown] = React.useState(target);
    const from = React.useRef(target);
    const raf = React.useRef(0);
    React.useEffect(() => {
        if (target == null || !Number.isFinite(target)) { setShown(target); from.current = target; return undefined; }
        const start = Number.isFinite(from.current) ? from.current : 0;
        if (start === target || reduceMotion()) { setShown(target); from.current = target; return undefined; }
        const t0 = performance.now();
        const step = (now) => {
            const k = Math.min(1, (now - t0) / duration);
            const e = 1 - (1 - k) ** 3;
            const v = start + (target - start) * e;
            setShown(v);
            from.current = v;
            if (k < 1) raf.current = requestAnimationFrame(step);
        };
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf.current);
    }, [target, duration]);
    return shown;
}

// Re-run a CSS animation whenever `value` changes after the first render.
function useBump(value) {
    const [n, setN] = React.useState(0);
    const first = React.useRef(true);
    const prev = React.useRef(value);
    React.useEffect(() => {
        if (first.current) { first.current = false; prev.current = value; return; }
        if (value !== prev.current) { prev.current = value; setN((x) => x + 1); }
    }, [value]);
    return n;
}

function useNow(ms = 1000) {
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
    return now;
}

function ago(iso, now) {
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return shortDate(new Date(t).toISOString());
}

// Small trend line under a tile: draws in, and the last point glows.
function TileSpark({ values, color = ACCENT, width = 120, height = 28 }) {
    const gid = React.useMemo(() => `ms-g${Math.random().toString(36).slice(2, 8)}`, []);
    const v = (values || []).filter((x) => x != null && Number.isFinite(x));
    if (v.length < 3) return null;
    const max = Math.max(...v), min = Math.min(...v);
    const span = max - min || 1;
    const step = width / (v.length - 1);
    const py = (x) => height - 3 - ((x - min) / span) * (height - 6);
    const pts = v.map((x, i) => `${(i * step).toFixed(1)},${py(x).toFixed(1)}`);
    const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
    const key = v.length + ':' + v[v.length - 1];
    return (
        <svg width={width} height={height} className="ms-spark" aria-hidden style={{ display: 'block', overflow: 'visible' }}>
            <defs>
                <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path key={`a${key}`} d={area} fill={`url(#${gid})`} className="ms-fade-in" />
            <polyline key={`l${key}`} points={pts.join(' ')} pathLength="1" className="ms-draw" fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={(v.length - 1) * step} cy={py(v[v.length - 1])} r="3" fill={color} className="ms-pulse-dot" />
        </svg>
    );
}

// A headline number: counts to its new value, flashes when it changes and
// floats the difference up beside it.
function Tile({ label, value, sub, extra, num = null, format = null, spark = null, sparkColor, lowerIsBetter = true }) {
    const tw = useTween(num);
    const bump = useBump(num);
    const prev = React.useRef(num);
    const [delta, setDelta] = React.useState(null);
    React.useEffect(() => {
        if (num != null && prev.current != null && num !== prev.current) {
            const d = num - prev.current;
            setDelta({ d, id: Date.now() });
        }
        prev.current = num;
    }, [num]);
    const shown = num != null && format ? format(tw) : value;
    const deltaGood = delta ? (lowerIsBetter ? delta.d < 0 : delta.d > 0) : false;
    return (
        <div key={bump} className={`ms-tile rounded-lg border px-3.5 py-3 ${bump ? 'ms-flash' : ''}`} style={{ borderColor: RULE, backgroundColor: 'var(--bg-secondary)' }}>
            <div className="text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>{label}</div>
            <div className="relative mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold tabular-nums tracking-tight">{shown}</span>
                {extra}
                {delta && format && (
                    <span key={delta.id} className="ms-delta text-xs font-semibold tabular-nums" style={{ color: deltaGood ? GOOD : BAD }}>
                        {delta.d > 0 ? '▲' : '▼'} {format(Math.abs(delta.d))}
                    </span>
                )}
            </div>
            {sub && <div className="mt-0.5 text-xs leading-snug" style={{ color: MUTED }}>{sub}</div>}
            {spark && <div className="mt-2"><TileSpark values={spark} color={sparkColor} /></div>}
        </div>
    );
}

function Card({ title, hint, children, right }) {
    return (
        <div className="min-w-0 rounded-lg border p-3.5" style={{ borderColor: RULE, backgroundColor: 'var(--bg-secondary)' }}>
            <div className="mb-0.5 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-semibold">{title}</div>
                {right}
            </div>
            {hint && <div className="mb-3 text-xs leading-relaxed" style={{ color: MUTED }}>{hint}</div>}
            {children}
        </div>
    );
}

function Segmented({ options, value, onChange }) {
    return (
        <div className="inline-flex flex-wrap overflow-hidden rounded-md border text-xs" style={{ borderColor: RULE }}>
            {options.map(([k, l]) => (
                <button key={k} type="button" onClick={() => onChange(k)} className="px-2.5 py-1"
                    style={value === k ? { backgroundColor: 'var(--accent-muted)', color: ACCENT } : { color: MUTED }}>{l}</button>
            ))}
        </div>
    );
}

function Empty({ children }) {
    return <div className="py-8 text-center text-xs leading-relaxed" style={{ color: MUTED }}>{children}</div>;
}

function Tooltip({ x, width, children }) {
    return (
        <div className="pointer-events-none absolute z-10 rounded-md border px-2.5 py-1.5 text-xs shadow-lg"
            style={{
                left: Math.min(Math.max(0, x - 85), width - 180), top: 0, width: 180,
                backgroundColor: 'var(--bg-elevated, var(--bg-secondary))', borderColor: RULE, color: 'var(--text-primary)',
            }}>
            {children}
        </div>
    );
}

function LegendItem({ swatch, label }) {
    return <span className="inline-flex items-center gap-1.5">{swatch}<span>{label}</span></span>;
}
const lineSwatch = (color, dashed) => (
    <svg width="18" height="8" aria-hidden><line x1="1" x2="17" y1="4" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '3 3' : undefined} strokeLinecap="round" /></svg>
);
const dotSwatch = (fill, stroke) => (
    <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill={fill} stroke={stroke || fill} strokeWidth="1.5" /></svg>
);

// ----------------------------------------------------------- weekly trends

const WEEKLY_METRICS = [
    { key: 'medianSeconds', label: 'Response time', fmt: fmtSecs, band: 'p75Seconds', kind: 'line', hint: 'Median time from your message to the finished answer; the dashed line is the slowest quarter (75th percentile).' },
    { key: 'avgCalls', label: 'Tool calls', fmt: n1, kind: 'line', hint: 'Average tool calls per task. Fewer calls for the same kind of work means a shorter path.' },
    { key: 'failedCallRate', label: 'Failed calls', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of tool calls that failed.' },
    { key: 'roughRate', label: 'Flailing', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of tasks where the loop guard stepped in or many calls failed.' },
    { key: 'correctionRate', label: 'Corrections', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of answers your next message corrected ("that\'s wrong", "I said…"). Tracked from Nov 7, 2026 on.' },
    { key: 'recallRate', label: 'Memory recalled', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of tasks that started with the theme\'s memory. Higher is better here.' },
    { key: 'followRate', label: 'Playbook followed', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Of the tasks given the memory, how many used the proven approach. Higher is better here.' },
    { key: 'tasks', label: 'Tasks', fmt: (v) => String(v), kind: 'bar', hint: 'How much work was recorded each week.' },
];

function WeeklyChart({ data, metric, height = 180 }) {
    const [hover, setHover] = React.useState(null);
    const [ref, w] = useWidth();
    const field = metric.key;
    const pts = data.filter((d) => d[field] != null);
    if (!pts.length) return <div ref={ref}><Empty>No data for this measure yet.</Empty></div>;
    const values = pts.map((d) => d[field]).concat(metric.band ? pts.map((d) => d[metric.band]).filter((v) => v != null) : []);
    const max = Math.max(...values);
    const { top, ticks } = metric.pctAxis ? niceTicks(Math.min(1, Math.max(0.05, max)), 4) : niceTicks(max, 4);
    const padL = 44, padR = 10, padT = 10, padB = 22, h = height;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const slot = plotW / data.length;
    const x = (i) => padL + slot * i + slot / 2;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const barW = Math.max(4, Math.min(28, slot * 0.6));
    const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));
    const path = (f) => {
        const p = data.map((d, i) => (d[f] == null ? null : `${x(i)},${y(d[f])}`)).filter(Boolean);
        return p.length > 1 ? p.join(' ') : null;
    };
    const tickFmt = metric.pctAxis ? (v) => `${Math.round(v * 100)}%` : field === 'medianSeconds' ? fmtSecs : (v) => String(v);
    const d = hover != null ? data[hover] : null;
    return (
        <div ref={ref} className="relative" style={{ width: '100%' }}>
            <svg width={w} height={h} role="img" aria-label={`${metric.label} by week`} style={{ display: 'block' }}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={RULE} strokeWidth={t === 0 ? 1 : 0.5} opacity={t === 0 ? 1 : 0.6} />
                        <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={MUTED}>{tickFmt(t)}</text>
                    </g>
                ))}
                {metric.kind === 'bar' && data.map((dd, i) => {
                    const v = dd[field];
                    if (v == null) return null;
                    const bh = Math.max(1, y(0) - y(v));
                    const r = Math.min(4, barW / 2, bh);
                    const x0 = x(i) - barW / 2, y0 = y(v);
                    return <path key={`${field}${dd.week}`} d={`M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z`}
                        className="ms-grow" style={{ animationDelay: `${Math.min(i, 30) * 25}ms` }}
                        fill={ACCENT} opacity={hover == null || hover === i ? 1 : 0.55} />;
                })}
                {metric.kind === 'line' && metric.band && path(metric.band) && (
                    <polyline key={`b${field}`} points={path(metric.band)} className="ms-fade-in" fill="none" stroke={MUTED} strokeWidth="1.5" strokeDasharray="4 4" />
                )}
                {metric.kind === 'line' && path(field) && (
                    <polyline key={`m${field}`} points={path(field)} pathLength="1" className="ms-draw ms-draw--slow" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                )}
                {metric.kind === 'line' && data.map((dd, i) => (dd[field] == null ? null : (
                    <circle key={`${field}${dd.week}`} cx={x(i)} cy={y(dd[field])} r={hover === i ? 5 : 4} fill={ACCENT} stroke="var(--bg-secondary)" strokeWidth="2"
                        className="ms-pop" style={{ animationDelay: `${300 + Math.min(i, 30) * 25}ms` }} />
                )))}
                {hover != null && metric.kind === 'line' && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />}
                {data.map((dd, i) => (i % labelEvery === 0 ? (
                    <text key={`l${dd.week}`} x={x(i)} y={h - 6} textAnchor="middle" fontSize="10" fill={MUTED}>{shortDate(dd.week)}</text>
                ) : null))}
                {data.map((dd, i) => (
                    <rect key={`h${dd.week}`} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} />
                ))}
            </svg>
            {metric.band && (
                <div className="mt-1 flex gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <LegendItem swatch={lineSwatch(ACCENT)} label="median" />
                    <LegendItem swatch={lineSwatch(MUTED, true)} label="slowest quarter (p75)" />
                </div>
            )}
            {d && (
                <Tooltip x={x(hover)} width={w}>
                    <div className="font-semibold">Week of {shortDate(d.week)}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{metric.label}: <b>{d[field] == null ? '—' : metric.fmt(d[field])}</b></div>
                    {metric.band && d[metric.band] != null && <div style={{ color: 'var(--text-secondary)' }}>p75: {metric.fmt(d[metric.band])}</div>}
                    <div style={{ color: 'var(--text-secondary)' }}>{d.tasks} task{d.tasks === 1 ? '' : 's'}</div>
                </Tooltip>
            )}
        </div>
    );
}

// --------------------------------------------------------- every task plot

const ROLL = 9;
function TaskTimeline({ tasks, field, height = 210, freshSince = 0 }) {
    const [hover, setHover] = React.useState(null);
    const [ref, w] = useWidth();
    const get = field === 'seconds' ? (t) => t.s : (t) => t.c;
    const pts = tasks.filter((t) => get(t) != null);
    if (pts.length < 3) return <div ref={ref}><Empty>Not enough tasks with this measure yet.</Empty></div>;
    // Rolling median of the last ROLL tasks.
    const rolling = pts.map((_, i) => median(pts.slice(Math.max(0, i - ROLL + 1), i + 1).map(get)));
    // Clip the axis at the 95th percentile so one 20-minute task does not
    // flatten everything else; clipped dots sit on the top edge with a caret.
    const sorted = pts.map(get).sort((a, b) => a - b);
    const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const { top, ticks } = niceTicks(Math.max(cap, ...rolling), 4);
    const padL = 44, padR = 10, padT = 10, padB = 22, h = height;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const x = (i) => padL + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
    const y = (v) => padT + plotH - (Math.min(v, top) / top) * plotH;
    const fmt = field === 'seconds' ? fmtSecs : (v) => String(Math.round(v * 10) / 10);
    const roll = rolling.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    // Date labels: up to ~6, at task positions.
    const nLabels = Math.max(2, Math.min(6, Math.floor(plotW / 80)));
    const labelIdx = [...new Set(Array.from({ length: nLabels }, (_, k) => Math.round((k / (nLabels - 1)) * (pts.length - 1))))];
    const t = hover != null ? pts[hover] : null;
    return (
        <div ref={ref} className="relative" style={{ width: '100%' }}>
            <svg width={w} height={h} role="img" aria-label={`${field} for each task`} style={{ display: 'block' }}
                onMouseLeave={() => setHover(null)}
                onMouseMove={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const px = e.clientX - r.left;
                    const i = Math.round(((px - padL) / plotW) * (pts.length - 1));
                    setHover(Math.max(0, Math.min(pts.length - 1, i)));
                }}>
                {ticks.map((tk) => (
                    <g key={tk}>
                        <line x1={padL} x2={w - padR} y1={y(tk)} y2={y(tk)} stroke={RULE} strokeWidth={tk === 0 ? 1 : 0.5} opacity={tk === 0 ? 1 : 0.6} />
                        <text x={padL - 6} y={y(tk) + 3} textAnchor="end" fontSize="10" fill={MUTED}>{fmt(tk)}</text>
                    </g>
                ))}
                {pts.map((p, i) => {
                    const v = get(p);
                    const withMem = !!p.rt;
                    const isNew = freshSince && Date.parse(p.t) > freshSince;
                    return (
                        <g key={`${p.t}|${p.th}`} className={isNew ? 'ms-pop' : undefined}>
                            {isNew && <circle cx={x(i)} cy={y(v)} r="4" fill="none" stroke={ACCENT} strokeWidth="2" className="ms-ripple" />}
                            <circle cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5}
                                fill={withMem ? ACCENT : 'var(--bg-secondary)'}
                                stroke={p.cor ? BAD : withMem ? 'var(--bg-secondary)' : MUTED}
                                strokeWidth={p.cor ? 2 : 1.5} opacity={hover == null || hover === i ? 0.95 : 0.6} />
                            {v > top && <path d={`M${x(i) - 3},${padT + 4} L${x(i)},${padT} L${x(i) + 3},${padT + 4}`} fill="none" stroke={MUTED} strokeWidth="1.2" />}
                        </g>
                    );
                })}
                <polyline key={`r${field}`} points={roll} pathLength="1" className="ms-draw ms-draw--slow" fill="none" stroke="var(--text-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
                {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />}
                {labelIdx.map((i) => (
                    <text key={i} x={x(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'} fontSize="10" fill={MUTED}>{shortDate(pts[i].t)}</text>
                ))}
            </svg>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <LegendItem swatch={dotSwatch('var(--accent-primary)')} label="task with the theme's memory" />
                <LegendItem swatch={dotSwatch('transparent', MUTED)} label="cold start" />
                <LegendItem swatch={dotSwatch('transparent', BAD)} label="you corrected the answer" />
                <LegendItem swatch={lineSwatch('var(--text-primary)')} label={`median of the last ${ROLL} tasks`} />
            </div>
            {t && (
                <Tooltip x={x(hover)} width={w}>
                    <div className="font-semibold">{shortDate(t.t)} · {t.label}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{fmtSecs(t.s)} · {t.c} call{t.c === 1 ? '' : 's'}{t.f ? `, ${t.f} failed` : ''}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>
                        {t.rt ? (t.fo === true ? 'memory recalled · playbook followed' : t.fo === false ? 'memory recalled · not followed' : 'memory recalled') : t.rt === false ? 'cold start' : 'memory use not recorded'}
                    </div>
                    {t.cor && <div style={{ color: BAD }}>you corrected this answer</div>}
                    {t.rough && <div style={{ color: 'var(--text-secondary)' }}>flailed (loop guard / many failures)</div>}
                    <div style={{ color: MUTED }}>rolling median {fmt(rolling[hover])}</div>
                </Tooltip>
            )}
        </div>
    );
}

// ------------------------------------------------------------- impact bars

function fmtFor(metric, v) { return (METRIC_FMT[metric] || { fmt: n1 }).fmt(v); }

function ImpactRows({ rows, fromLabel, toLabel }) {
    return (
        <div className="space-y-3.5">
            {rows.map((r) => {
                const max = Math.max(r.from || 0, r.to || 0) || 1;
                return (
                    <div key={r.metric}>
                        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
                            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{(METRIC_FMT[r.metric] || {}).label || r.metricLabel}</span>
                            <span className="inline-flex items-center gap-2">
                                <Change value={r.change} kind={r.changeKind} small />
                                <Evidence level={r.evidence} p={r.p} nFrom={r.nFrom} nTo={r.nTo} />
                            </span>
                        </div>
                        {[[toLabel, r.to, ACCENT, r.nTo], [fromLabel, r.from, MUTED, r.nFrom]].map(([name, v, color, n]) => (
                            <div key={name} className="mb-1 flex items-center gap-2 text-xs">
                                <span className="w-28 shrink-0 truncate" style={{ color: MUTED }} title={`${n} tasks`}>{name}</span>
                                <span className="h-2.5 flex-1 overflow-hidden rounded-sm" style={{ backgroundColor: 'var(--bg-hover)' }}>
                                    <span className="ms-bar block h-full rounded-sm" style={{ width: `${v == null ? 0 : Math.max(2, (v / max) * 100)}%`, backgroundColor: color }} />
                                </span>
                                <span className="w-16 shrink-0 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{fmtFor(r.metric, v)}</span>
                            </div>
                        ))}
                        {r.matchedChange != null && r.matchedThemes > 0 && (
                            <div className="text-[0.7rem]" style={{ color: MUTED }}>
                                Same theme against itself ({r.matchedThemes} theme{r.matchedThemes === 1 ? '' : 's'}): <Change value={r.matchedChange} kind={r.changeKind} small />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Learning curve: one measure, bars per bucket relative to the theme's
// typical task (1.0 reference line).
function CurveChart({ data, field, height = 170 }) {
    const [hover, setHover] = React.useState(null);
    const [ref, w] = useWidth(200);
    const pts = data.filter((d) => d[field] != null);
    if (pts.length < 2) return <div ref={ref}><Empty>Needs themes with 8+ tasks.</Empty></div>;
    const max = Math.max(1.2, ...pts.map((d) => d[field]));
    const { top, ticks } = niceTicks(max, 4);
    const padL = 36, padR = 8, padT = 10, padB = 34, h = height;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const slot = plotW / data.length;
    const x = (i) => padL + slot * i + slot / 2;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const barW = Math.max(6, Math.min(34, slot * 0.55));
    return (
        <div ref={ref} className="relative" style={{ width: '100%' }}>
            <svg width={w} height={h} role="img" aria-label={`${field} relative to the theme's typical task`} style={{ display: 'block' }}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={RULE} strokeWidth={t === 0 ? 1 : 0.5} opacity={t === 0 ? 1 : 0.6} />
                        <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={MUTED}>{`${t}×`}</text>
                    </g>
                ))}
                {data.map((d, i) => {
                    const v = d[field];
                    if (v == null) return null;
                    const bh = Math.max(1, y(0) - y(v));
                    const r = Math.min(4, barW / 2, bh);
                    const x0 = x(i) - barW / 2, y0 = y(v);
                    return <path key={`${field}${d.label}`} d={`M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z`}
                        className="ms-grow" style={{ animationDelay: `${i * 60}ms` }}
                        fill={ACCENT} opacity={hover == null || hover === i ? 1 : 0.55} />;
                })}
                <line x1={padL} x2={w - padR} y1={y(1)} y2={y(1)} stroke="var(--text-primary)" strokeWidth="1.2" strokeDasharray="4 3" opacity="0.7" />
                <text x={w - padR} y={y(1) - 4} textAnchor="end" fontSize="10" fill="var(--text-secondary)">typical task</text>
                {data.map((d, i) => (
                    <g key={`l${d.label}`}>
                        <text x={x(i)} y={h - 18} textAnchor="middle" fontSize="10" fill={MUTED}>{d.label}</text>
                        <text x={x(i)} y={h - 6} textAnchor="middle" fontSize="9" fill={MUTED}>{d.tasks ? `${d.tasks} tasks` : ''}</text>
                    </g>
                ))}
                {data.map((d, i) => (
                    <rect key={`h${d.label}`} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} />
                ))}
            </svg>
            {hover != null && data[hover] && data[hover][field] != null && (
                <Tooltip x={x(hover)} width={w}>
                    <div className="font-semibold">Tasks {data[hover].label} of a theme</div>
                    <div style={{ color: 'var(--text-secondary)' }}>
                        {data[hover][field] < 1
                            ? `${Math.round((1 - data[hover][field]) * 100)}% below the theme's typical task`
                            : `${Math.round((data[hover][field] - 1) * 100)}% above the theme's typical task`}
                    </div>
                    <div style={{ color: MUTED }}>{data[hover].tasks} tasks across {data[hover].themes} theme{data[hover].themes === 1 ? '' : 's'}</div>
                </Tooltip>
            )}
        </div>
    );
}

// Response-time histogram.
function HistChart({ bins, height = 170 }) {
    const [hover, setHover] = React.useState(null);
    const [ref, w] = useWidth(200);
    const total = bins.reduce((n, b) => n + b.tasks, 0);
    if (!total) return <div ref={ref}><Empty>No timed tasks yet.</Empty></div>;
    const max = Math.max(...bins.map((b) => b.tasks));
    const { top, ticks } = niceTicks(max, 4);
    const padL = 30, padR = 8, padT = 10, padB = 22, h = height;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const slot = plotW / bins.length;
    const x = (i) => padL + slot * i + slot / 2;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const barW = Math.max(6, slot - 2);
    const label = (b) => (b.hi == null ? `${fmtSecs(b.lo)}+` : `<${fmtSecs(b.hi)}`);
    return (
        <div ref={ref} className="relative" style={{ width: '100%' }}>
            <svg width={w} height={h} role="img" aria-label="Distribution of response times" style={{ display: 'block' }}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={RULE} strokeWidth={t === 0 ? 1 : 0.5} opacity={t === 0 ? 1 : 0.6} />
                        <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={MUTED}>{t}</text>
                    </g>
                ))}
                {bins.map((b, i) => {
                    if (!b.tasks) return null;
                    const bh = Math.max(1, y(0) - y(b.tasks));
                    const r = Math.min(4, barW / 2, bh);
                    const x0 = x(i) - barW / 2, y0 = y(b.tasks);
                    return <path key={i} d={`M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z`}
                        className="ms-grow" style={{ animationDelay: `${i * 50}ms` }}
                        fill={ACCENT} opacity={hover == null || hover === i ? 1 : 0.55} />;
                })}
                {bins.map((b, i) => (
                    <text key={`l${i}`} x={x(i)} y={h - 6} textAnchor="middle" fontSize="10" fill={MUTED}>{label(b)}</text>
                ))}
                {bins.map((b, i) => (
                    <rect key={`h${i}`} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} />
                ))}
            </svg>
            {hover != null && (
                <Tooltip x={x(hover)} width={w}>
                    <div className="font-semibold">{bins[hover].hi == null ? `${fmtSecs(bins[hover].lo)} or longer` : `${fmtSecs(bins[hover].lo)} – ${fmtSecs(bins[hover].hi)}`}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{bins[hover].tasks} tasks ({pct(bins[hover].tasks / total)})</div>
                </Tooltip>
            )}
        </div>
    );
}

function Spark({ values, width = 84, height = 22, label = 'values' }) {
    if (!values || values.length < 2) return <span style={{ color: MUTED }}>—</span>;
    const max = Math.max(1, ...values);
    const step = width / (values.length - 1);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(' ');
    return (
        <svg width={width} height={height} aria-label={`last ${values.length} tasks: ${label}`} style={{ display: 'block' }}>
            <polyline points={pts} fill="none" stroke={ACCENT} strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
    );
}

// --------------------------------------------------------------- findings

function FindingRow({ f }) {
    const fmt = (METRIC_FMT[f.metric] || { fmt: n1 }).fmt;
    const better = f.direction === 'better';
    const Icon = better ? BetterIcon : WorseIcon;
    return (
        <li className="flex items-start gap-2.5 border-t py-2 first:border-t-0" style={{ borderColor: RULE }}>
            <Icon size={15} style={{ color: better ? GOOD : BAD, flexShrink: 0, marginTop: 2 }} aria-label={better ? 'improving' : 'getting worse'} />
            <div className="min-w-0 flex-1">
                <div className="text-sm">
                    <b className="font-medium">{f.scopeLabel}</b>
                    <span style={{ color: 'var(--text-secondary)' }}> · {(METRIC_FMT[f.metric] || {}).label || f.metricLabel}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {f.matched
                        ? <span>each theme against itself ({(f.themes || []).length} themes)</span>
                        : <span className="tabular-nums">{fmt(f.from)} → <b style={{ color: 'var(--text-primary)' }}>{fmt(f.to)}</b></span>}
                    <Change value={f.change} kind={f.changeKind} small />
                    <Evidence level={f.evidence} p={f.p} nFrom={f.nFrom} nTo={f.nTo} />
                </div>
                <div className="mt-0.5 text-[0.7rem]" style={{ color: MUTED }}>
                    {f.matched
                        ? <>All chat tasks pooled: {fmt(f.from)} → {fmt(f.to)}{f.pooled && f.pooled.change != null ? ` (${f.pooled.change > 0 ? '+' : ''}${Math.round(f.pooled.change * 100)}${f.changeKind === 'points' ? ' pts' : '%'})` : ''}, which also counts the change in what kind of work you asked for</>
                        : <>earliest {f.nFrom} tasks (from {shortDate(f.since)}) vs latest {f.nTo} (since {shortDate(f.recentSince)})</>}
                </div>
            </div>
        </li>
    );
}

// ------------------------------------------------------------ live feed

// One row per thing that happened: a task recorded, a playbook rewrite, a new
// proven approach, a correction, a self-correction step.
function feedItem(ev, labelOf) {
    const L = (th) => ev.label || labelOf.get(th) || th || '';
    switch (ev.kind) {
        case 'task': {
            const t = ev.task || {};
            const bits = [`${t.c ?? 0} call${t.c === 1 ? '' : 's'}`];
            if (t.s != null) bits.push(fmtSecs(t.s));
            if (t.f) bits.push(`${t.f} failed`);
            const tags = [];
            if (ev.newBest) tags.push(['new best', GOOD]);
            if (t.rt) tags.push([t.fo === false ? 'memory not followed' : 'used memory', t.fo === false ? MUTED : ACCENT]);
            if (t.rough) tags.push(['flailed', BAD]);
            return { icon: ActivityIcon, color: ACCENT, title: `${L(ev.theme)} task`, detail: t.title || '', meta: bits.join(' · '), tags };
        }
        case 'refine': return { icon: RefineIcon, color: ACCENT, title: `${L(ev.theme)} playbook rewritten`, meta: `now v${ev.v}` };
        case 'best': return { icon: BestIcon, color: GOOD, title: `${L(ev.theme)}: new proven approach`, meta: ev.calls != null ? `${ev.from != null ? `${ev.from} → ` : ''}${ev.calls} calls` : '' };
        case 'correction': return { icon: CorrectedIcon, color: BAD, title: 'You corrected an answer', meta: 'counted against that task' };
        case 'self_correct': {
            const a = ev.action || {};
            if (ev.phase === 'judged') {
                const col = a.status === 'helped' ? GOOD : (a.status === 'worse' || a.status === 'rolled_back') ? BAD : MUTED;
                return { icon: a.status === 'rolled_back' ? RevertIcon : a.status === 'helped' ? SteadyIcon : FixIcon, color: col,
                    title: `Self-correction ${STATUS_TEXT[a.status] || a.status}`, detail: `${L(ev.theme)} · ${a.metricLabel || ''}` };
            }
            return { icon: a.kind === 'revert' ? RevertIcon : FixIcon, color: '#f59e0b', title: `Self-correcting ${L(ev.theme)}`, detail: a.why || '',
                meta: a.kind === 'revert' ? `restored playbook${a.toVersion ? ` → v${a.toVersion}` : ''}` : 'playbook rewritten against the slow tasks' };
        }
        default: return null;
    }
}

function ActivityFeed({ items, labelOf, now, live }) {
    return (
        <Card title="Live activity" hint="Each task, memory update and self-correction as it happens."
            right={<LiveBadge live={live} />}>
            {items.length ? (
                <ul className="ms-feed -mx-1 max-h-[340px] overflow-y-auto">
                    {items.map((ev) => {
                        const it = feedItem(ev, labelOf);
                        if (!it) return null;
                        const Icon = it.icon;
                        return (
                            <li key={ev._id} className={`ms-feed-row flex items-start gap-2.5 rounded-md px-1 py-2 ${ev._fresh ? 'ms-feed-in' : ''}`}>
                                <span className="ms-feed-icon mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                                    style={{ backgroundColor: `color-mix(in oklab, ${it.color} 14%, transparent)`, color: it.color }}>
                                    <Icon size={13} strokeWidth={2} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="truncate text-sm font-medium">{it.title}</span>
                                        <span className="shrink-0 text-[0.7rem] tabular-nums" style={{ color: MUTED }}>{ago(ev.at || ev.t, now)}</span>
                                    </div>
                                    {it.detail && <div className="truncate text-xs" style={{ color: 'var(--text-secondary)' }} title={it.detail}>{it.detail}</div>}
                                    {(it.meta || (it.tags && it.tags.length)) && (
                                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[0.7rem]" style={{ color: MUTED }}>
                                            {it.meta && <span className="tabular-nums">{it.meta}</span>}
                                            {(it.tags || []).map(([t, c]) => (
                                                <span key={t} className="rounded-full px-1.5 py-px font-medium" style={{ color: c, backgroundColor: `color-mix(in oklab, ${c} 12%, transparent)` }}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            ) : <Empty>Waiting for the next task…</Empty>}
        </Card>
    );
}

function LiveBadge({ live }) {
    const on = live === 'live';
    const label = on ? 'Live' : live === 'connecting' ? 'Connecting' : 'Reconnecting';
    const color = on ? GOOD : '#f59e0b';
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide"
            style={{ borderColor: `color-mix(in oklab, ${color} 40%, transparent)`, color }}>
            <span className={`ms-live-dot ${on ? 'is-on' : ''}`} style={{ backgroundColor: color }} />{label}
        </span>
    );
}

// ------------------------------------------------------- self-correction

const STATUS_TEXT = { active: 'in progress', helped: 'helped', no_effect: 'had no clear effect', worse: 'made it worse', rolled_back: 'rolled back' };
const STATUS_COLOR = { active: '#f59e0b', helped: GOOD, no_effect: MUTED, worse: BAD, rolled_back: BAD };

function SelfCorrection({ data, now, onCheck, checking }) {
    const SC = data.selfCorrect || { actions: [], evalTasks: 6 };
    const F = data.findings || {};
    const watching = (F.worsening || []).filter((f) => f.evidence !== 'weak' && f.scope && f.scope !== 'chat');
    const actions = SC.actions || [];
    const helped = actions.filter((a) => a.status === 'helped').length;
    const rolled = actions.filter((a) => a.status === 'rolled_back' || a.status === 'worse').length;
    const activeN = actions.filter((a) => a.status === 'active').length;
    const fmt = (m, v) => (METRIC_FMT[m] || { fmt: n1 }).fmt(v);
    const statusFor = (f) => {
        const mine = actions.filter((a) => a.th === f.scope);
        const act = mine.find((a) => a.status === 'active');
        if (act) return { text: act.kind === 'revert' ? 'Correcting · restored a better playbook' : 'Correcting · playbook rewritten', color: '#f59e0b', progress: (act.progress || 0) / (SC.evalTasks || 6), act };
        const last = mine[0];
        if (last && now - Date.parse(last.t) < (SC.cooldownHours || 6) * 3600e3) return { text: `Last attempt ${STATUS_TEXT[last.status] || last.status} · next try after cooldown`, color: MUTED };
        const w = (SC.watch || []).find((x) => x.scope === f.scope && x.metric === f.metric);
        if (w && !w.actionable) return { text: `Watching · ${w.reason}`, color: MUTED };
        return { text: 'Will act at the next check', color: ACCENT };
    };
    return (
        <Card title="Self-correction"
            hint={`When a theme's numbers trend the wrong way with real evidence, the system acts: it restores a playbook that measured better, or rewrites the playbook against the slow tasks. After ${SC.evalTasks || 6} more tasks it checks the result and rolls back a fix that made things worse.`}
            right={(
                <button type="button" onClick={onCheck} disabled={checking}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-60"
                    style={{ borderColor: RULE, color: 'var(--text-secondary)' }}>
                    <CheckIcon size={12} className={checking ? 'animate-spin' : ''} /> Check now
                </button>
            )}>
            <div className="mb-3 grid grid-cols-3 gap-2">
                {[['Correcting', activeN, '#f59e0b'], ['Helped', helped, GOOD], ['Rolled back / worse', rolled, BAD]].map(([l, v, c]) => (
                    <div key={l} className="rounded-md border px-2.5 py-2" style={{ borderColor: RULE }}>
                        <div className="text-[0.65rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>{l}</div>
                        <div className="text-lg font-semibold tabular-nums" style={{ color: v ? c : 'var(--text-primary)' }}><Counter value={v} /></div>
                    </div>
                ))}
            </div>
            <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>Watching</div>
            {watching.length ? (
                <ul className="mb-3">
                    {watching.map((f, i) => {
                        const st = statusFor(f);
                        return (
                            <li key={`${f.scope}${f.metric}`} className="ms-feed-in border-t py-2 first:border-t-0" style={{ borderColor: RULE, animationDelay: `${i * 60}ms` }}>
                                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                                    <span className="text-sm"><b className="font-medium">{f.scopeLabel}</b><span style={{ color: 'var(--text-secondary)' }}> · {(METRIC_FMT[f.metric] || {}).label || f.metricLabel}</span></span>
                                    <span className="inline-flex items-center gap-2 text-xs"><span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmt(f.metric, f.from)} → {fmt(f.metric, f.to)}</span><Change value={f.change} kind={f.changeKind} small /></span>
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: st.color }}>
                                    <span className={`ms-status-dot ${st.act ? 'is-on' : ''}`} style={{ backgroundColor: st.color }} />{st.text}
                                </div>
                                {st.act && (
                                    <div className="mt-1.5 flex items-center gap-2">
                                        <span className="ms-progress h-1.5 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-hover)' }}>
                                            <span className="ms-progress-fill block h-full rounded-full" style={{ width: `${Math.max(4, st.progress * 100)}%`, backgroundColor: st.color }} />
                                        </span>
                                        <span className="shrink-0 text-[0.7rem] tabular-nums" style={{ color: MUTED }}>{st.act.progress || 0}/{SC.evalTasks} tasks measured</span>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <div className="mb-3 flex items-center gap-2 rounded-md px-2 py-2 text-xs" style={{ color: GOOD, backgroundColor: `color-mix(in oklab, ${GOOD} 8%, transparent)` }}>
                    <SteadyIcon size={14} /> Nothing is trending the wrong way with evidence — no correction needed.
                </div>
            )}
            <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>History</div>
            {actions.length ? (
                <ul className="max-h-[220px] overflow-y-auto">
                    {actions.slice(0, 12).map((a) => (
                        <li key={a.id} className="flex items-start gap-2.5 border-t py-2 first:border-t-0" style={{ borderColor: RULE }}>
                            {a.kind === 'revert' ? <RevertIcon size={14} style={{ color: MUTED, marginTop: 3, flexShrink: 0 }} /> : <FixIcon size={14} style={{ color: MUTED, marginTop: 3, flexShrink: 0 }} />}
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                                    <span className="text-sm"><b className="font-medium">{a.label}</b><span style={{ color: 'var(--text-secondary)' }}> · {a.metricLabel}</span></span>
                                    <span className="rounded-full px-1.5 py-px text-[0.7rem] font-medium" style={{ color: STATUS_COLOR[a.status], backgroundColor: `color-mix(in oklab, ${STATUS_COLOR[a.status]} 12%, transparent)` }}>{STATUS_TEXT[a.status] || a.status}</span>
                                </div>
                                <div className="truncate text-xs" style={{ color: 'var(--text-secondary)' }} title={a.why}>{a.why}</div>
                                <div className="text-[0.7rem] tabular-nums" style={{ color: MUTED }}>
                                    {ago(a.t, now)}{a.fromVersion != null ? ` · v${a.fromVersion} → v${a.toVersion}` : ''}
                                    {a.after ? ` · ${fmt(a.metric, a.baseline)} → ${fmt(a.metric, a.after.value)} over ${a.after.n} tasks` : a.status === 'active' ? ` · ${a.progress || 0}/${SC.evalTasks} tasks so far` : ''}
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : <div className="py-2 text-xs" style={{ color: MUTED }}>No corrections yet{SC.lastCheckAt ? ` · last checked ${ago(SC.lastCheckAt, now)}` : ''}.</div>}
        </Card>
    );
}

function Counter({ value }) {
    const v = useTween(value, 700);
    return <>{v == null ? '—' : Math.round(v)}</>;
}

// --------------------------------------------------------------- the view

const MIN_COMPARE = 3;

// Running median of the last 7 tasks over the last 40 — a tile's trend line
// without one slow task spiking it.
function rollingSpark(tasks, get) {
    const v = (tasks || []).slice(-46).map(get).filter((x) => x != null && Number.isFinite(x));
    const out = [];
    for (let i = 6; i < v.length; i++) out.push(median(v.slice(i - 6, i + 1)));
    return out.slice(-40);
}

export default function MemoryStats({ userId = null }) {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [weeklyMetric, setWeeklyMetric] = React.useState('medianSeconds');
    const [scope, setScope] = React.useState('all');
    const [taskField, setTaskField] = React.useState('seconds');
    const [showWeak, setShowWeak] = React.useState(false);
    const [curveField, setCurveField] = React.useState('relSeconds');

    const [live, setLive] = React.useState('connecting');
    const [feed, setFeed] = React.useState([]);
    const [updatedAt, setUpdatedAt] = React.useState(null);
    const [checking, setChecking] = React.useState(false);
    const mountedAt = React.useRef(Date.now());
    const now = useNow(1000);
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';

    // `silent` refreshes keep the current view on screen (live updates).
    const load = React.useCallback(async (silent = false) => {
        if (!silent) { setLoading(true); setError(null); }
        try {
            const res = await fetch(`/api/memories/stats${qs}`, { credentials: 'same-origin' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
            setData(body);
            setUpdatedAt(Date.now());
            if (silent) setError(null);
        } catch (e) { if (!silent) setError(e.message); } finally { if (!silent) setLoading(false); }
    }, [qs]);
    React.useEffect(() => { load(); }, [load]);

    // Live feed: the server pushes a frame per task / memory update /
    // self-correction step; each one refreshes the stats (coalesced).
    React.useEffect(() => {
        let es = null, pending = 0, poll = 0, closed = false;
        const refresh = () => { clearTimeout(pending); pending = setTimeout(() => load(true), 700); };
        const open = () => {
            if (closed || typeof EventSource === 'undefined') { setLive('reconnecting'); return; }
            es = new EventSource(`/api/memories/stats/stream${qs}`, { withCredentials: true });
            es.onopen = () => setLive('live');
            es.onmessage = (m) => {
                let ev = null;
                try { ev = JSON.parse(m.data); } catch (_) { return; }
                if (!ev || ev.kind === 'connected') { setLive('live'); return; }
                // A Pi task re-records while it runs: one feed row per task.
                setFeed((f) => {
                    const id = `${ev.kind}|${ev.at}|${Math.random().toString(36).slice(2, 6)}`;
                    const row = { ...ev, _id: id, _fresh: true };
                    const rest = ev.kind === 'task' && ev.sameRun ? f.filter((x) => !(x.kind === 'task' && x.theme === ev.theme && x.task && ev.task && x.task.title === ev.task.title)) : f;
                    return [row, ...rest].slice(0, 40);
                });
                refresh();
            };
            es.onerror = () => setLive('reconnecting');   // EventSource retries by itself
        };
        open();
        // Fallback: refresh every 30 s if the stream is down, and on return to the tab.
        poll = setInterval(() => { if (!es || es.readyState !== 1) load(true); }, 30000);
        const onVis = () => { if (document.visibilityState === 'visible') load(true); };
        document.addEventListener('visibilitychange', onVis);
        return () => { closed = true; clearTimeout(pending); clearInterval(poll); document.removeEventListener('visibilitychange', onVis); if (es) es.close(); };
    }, [qs, load]);

    const checkNow = React.useCallback(async () => {
        setChecking(true);
        try {
            await fetch('/api/memories/self-correct', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(userId ? { userId } : {}),
            });
            await load(true);
        } finally { setChecking(false); }
    }, [userId, load]);

    const themes = React.useMemo(() => ((data && data.themes) || []).filter((t) => t.lifetimeTasks > 0), [data]);
    const labelOf = React.useMemo(() => new Map(themes.map((t) => [t.theme, t.label])), [themes]);
    // Feed = live frames, then recent history so it is never empty on open.
    const feedItems = React.useMemo(() => {
        if (!data) return feed;
        const hist = [];
        for (const t of (data.tasks || []).slice(-10)) hist.push({ kind: 'task', at: t.t, theme: t.th, task: { ...t, title: '' }, _id: `h-t-${t.t}-${t.th}` });
        for (const e of (data.events || []).slice(0, 10)) if (e.kind === 'refine' || e.kind === 'best') hist.push({ ...e, at: e.t, theme: e.th, _id: `h-e-${e.t}-${e.th}-${e.kind}` });
        for (const a of ((data.selfCorrect && data.selfCorrect.actions) || []).slice(0, 8)) {
            hist.push({ kind: 'self_correct', phase: 'applied', at: a.t, theme: a.th, label: a.label, action: a, _id: `h-a-${a.id}` });
            if (a.judgedAt) hist.push({ kind: 'self_correct', phase: 'judged', at: a.judgedAt, theme: a.th, label: a.label, action: a, _id: `h-j-${a.id}` });
        }
        const liveStart = feed.length ? Math.min(...feed.map((f) => Date.parse(f.at) || Infinity)) : Infinity;
        const older = hist.filter((h) => Date.parse(h.at) < liveStart).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return [...feed, ...older].slice(0, 30);
    }, [data, feed]);

    const scoped = React.useMemo(() => {
        if (!data) return { weekly: [], tasks: [] };
        const tasks = (data.tasks || []).map((t) => ({ ...t, label: labelOf.get(t.th) || t.th }));
        if (scope === 'all') return { weekly: data.weekly || [], tasks };
        const th = themes.find((t) => t.theme === scope);
        return { weekly: (th && th.weekly) || [], tasks: tasks.filter((t) => t.th === scope) };
    }, [data, scope, themes, labelOf]);

    if (loading && !data) {
        return <div className="flex items-center gap-2 p-4 text-sm" style={{ color: MUTED }}><SpinnerIcon size={16} className="animate-spin" /> Loading stats…</div>;
    }
    if (error) return <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#ef444455', color: BAD }}>{error}</div>;
    if (!data) return null;

    const L = data.lifetime || {};
    const F = data.findings || { improving: [], worsening: [], chat: {} };
    const chatF = F.chat || {};
    const RT = data.responseTime || {};
    const I = data.impact;
    const U = data.updateImpact;
    const visible = (list) => list.filter((f) => showWeak || f.evidence !== 'weak');
    const improving = visible(F.improving || []);
    const worsening = visible(F.worsening || []);
    const hiddenWeak = (F.improving || []).length + (F.worsening || []).length - improving.length - worsening.length;
    const solidBetter = (F.improving || []).filter((f) => f.evidence !== 'weak').length;
    const solidWorse = (F.worsening || []).filter((f) => f.evidence !== 'weak').length;
    const wm = WEEKLY_METRICS.find((m) => m.key === weeklyMetric) || WEEKLY_METRICS[0];
    const impactReady = I && I.withTasks >= MIN_COMPARE && I.coldTasks >= MIN_COMPARE;
    const followReady = I && I.followedTasks >= MIN_COMPARE && I.notFollowedTasks >= MIN_COMPARE;
    const corrTracked = (data.tasks || []).filter((t) => typeof t.cor === 'boolean');
    const corrRate = corrTracked.length ? corrTracked.filter((t) => t.cor).length / corrTracked.length : null;
    const trendSub = (f) => (f ? `trend: each theme's earliest vs latest tasks (${EVIDENCE[f.evidence].label})` : 'trend needs 6+ tasks in a theme');

    const scopeSelect = (
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: RULE, backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }} aria-label="Theme">
            <option value="all">All themes</option>
            {themes.map((t) => <option key={t.theme} value={t.theme}>{t.label}</option>)}
        </select>
    );

    return (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6 pr-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                    <LiveBadge live={live} />
                    <span className="text-xs tabular-nums" style={{ color: MUTED }}>
                        {updatedAt ? `updated ${ago(updatedAt, now)}` : ''}{live !== 'live' ? ' · refreshing every 30 s' : ''}
                    </span>
                </div>
                <span className="text-xs" style={{ color: MUTED }}>
                    {(L.tasks || 0).toLocaleString()} tasks · {themes.length} themes{data.selfCorrect && data.selfCorrect.lastCheckAt ? ` · self-check ${ago(data.selfCorrect.lastCheckAt, now)}` : ''}
                </span>
            </div>
            {/* Headline numbers */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label="Median response time" value={fmtSecs(RT.chat ? RT.chat.median : RT.all && RT.all.median)}
                    num={RT.chat ? RT.chat.median : RT.all ? RT.all.median : null} format={fmtSecs}
                    spark={rollingSpark(data.tasks, (t) => (t.src === 'agent' ? null : t.s))}
                    extra={chatF.seconds ? <Change value={chatF.seconds.change} kind="relative" small /> : null}
                    sub={RT.chat ? `half of chat answers take ${fmtSecs(RT.chat.p25)}–${fmtSecs(RT.chat.p75)} · ${trendSub(chatF.seconds)}` : 'no timed tasks yet'} />
                <Tile label="Tool calls per task" value={n1(data.logged && data.logged.avgCalls)}
                    num={data.logged ? data.logged.avgCalls : null} format={n1}
                    spark={rollingSpark(data.tasks, (t) => t.c)}
                    extra={chatF.calls ? <Change value={chatF.calls.change} kind="relative" small /> : null}
                    sub={`median ${n1(data.logged && data.logged.medianCalls)} · ${trendSub(chatF.calls)}`} />
                <Tile label="Failed calls" value={pct(data.logged && data.logged.failedCallRate, 1)}
                    num={data.logged ? data.logged.failedCallRate : null} format={(v) => pct(v, 1)}
                    spark={rollingSpark(data.tasks, (t) => ((t.c + (t.f || 0)) ? (t.f || 0) / (t.c + (t.f || 0)) : 0))} sparkColor={BAD}
                    extra={chatF.failedShare ? <Change value={chatF.failedShare.change} kind="points" small /> : null}
                    sub={`${pct(data.logged && data.logged.roughRate, 1)} of tasks flailed (loop guard or many failures)`} />
                <Tile label="Answers you corrected" value={pct(corrRate, 0)} num={corrRate} format={(v) => pct(v, 0)}
                    sub={corrTracked.length ? `${corrTracked.filter((t) => t.cor).length} of ${corrTracked.length} tracked tasks` : 'tracked from today on: a "that\'s wrong / I said…" reply counts against the answer'} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label="Tasks learned from" value={L.tasks || 0} num={L.tasks || 0} format={(v) => String(Math.round(v))} lowerIsBetter={false}
                    sub={`across ${themes.length} theme${themes.length === 1 ? '' : 's'}${data.since ? ` since ${shortDate(data.since)}` : ''}`} />
                <Tile label="Memory recalled" value={pct(L.recallRate)} num={L.recallRate} format={(v) => pct(v)} lowerIsBetter={false} sub={`${L.recalled || 0} tasks started from a theme memory`} />
                <Tile label="Playbook followed" value={pct(L.followRate)} num={L.followRate} format={(v) => pct(v)} lowerIsBetter={false} sub={`${L.followed || 0} of ${L.recalled || 0} recalled tasks used the proven approach`} />
                <Tile label="Memory updates" value={L.refinements || 0} num={L.refinements || 0} format={(v) => String(Math.round(v))} lowerIsBetter={false} sub={`${L.proven || 0} proven approaches · ${L.lessons || 0} lessons · ${L.avoid || 0} pitfalls`} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <ActivityFeed items={feedItems} labelOf={labelOf} now={now} live={live} />
                <SelfCorrection data={data} now={now} onCheck={checkNow} checking={checking} />
            </div>

            {/* What is changing */}
            <Card
                title="What's improving — and what isn't"
                hint={`Each measure compares a theme's earliest third of tasks with its latest third (needs ${F.minTasks || 10}+ tasks). The dots show how likely the change is real rather than chance.`}
                right={(
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: MUTED }}>
                        <input type="checkbox" checked={showWeak} onChange={(e) => setShowWeak(e.target.checked)} />
                        show changes that could be chance{hiddenWeak > 0 && !showWeak ? ` (${hiddenWeak})` : ''}
                    </label>
                )}
            >
                <div className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {solidBetter || solidWorse
                        ? <>{solidBetter} measure{solidBetter === 1 ? '' : 's'} improving and {solidWorse} getting worse with at least some evidence; {F.steady || 0} steady.</>
                        : <>No change with real evidence yet — {F.total || 0} measure{F.total === 1 ? '' : 's'} checked, {F.steady || 0} steady.</>}
                </div>
                <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
                    <div>
                        <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: GOOD }}>Improving</div>
                        {improving.length
                            ? <ul>{improving.map((f, i) => <FindingRow key={i} f={f} />)}</ul>
                            : <div className="py-2 text-xs" style={{ color: MUTED }}>Nothing yet{!showWeak && (F.improving || []).length ? ' with evidence (tick the box to see weaker signals)' : ''}.</div>}
                    </div>
                    <div>
                        <div className="mb-1 mt-3 text-[0.68rem] font-semibold uppercase tracking-wide lg:mt-0" style={{ color: BAD }}>Getting worse</div>
                        {worsening.length
                            ? <ul>{worsening.map((f, i) => <FindingRow key={i} f={f} />)}</ul>
                            : <div className="py-2 text-xs" style={{ color: MUTED }}>Nothing{!showWeak && (F.worsening || []).length ? ' with evidence' : ''}.</div>}
                    </div>
                </div>
            </Card>

            {/* Trends by week */}
            <Card title={`${wm.label}, by week`} hint={wm.hint} right={scopeSelect}>
                <div className="mb-3">
                    <Segmented options={WEEKLY_METRICS.map((m) => [m.key, m.label])} value={weeklyMetric} onChange={setWeeklyMetric} />
                </div>
                <WeeklyChart data={scoped.weekly} metric={wm} />
            </Card>

            {/* Every task */}
            <Card
                title="Every task"
                hint="One dot per task, oldest on the left. Filled dots started with the theme's memory. The line is the running median, so a falling line means tasks are getting faster or leaner."
                right={(
                    <div className="flex flex-wrap items-center gap-2">
                        <Segmented options={[['seconds', 'Response time'], ['calls', 'Tool calls']]} value={taskField} onChange={setTaskField} />
                        {scopeSelect}
                    </div>
                )}
            >
                <TaskTimeline tasks={scoped.tasks} field={taskField} freshSince={mountedAt.current} />
            </Card>

            {/* Is the memory helping */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Card title="Does recalled memory help?"
                    hint="Tasks that started with their theme's memory against tasks that started cold. Themes differ a lot, so each theme is also compared with itself.">
                    {impactReady ? (
                        <>
                            <div className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {(() => {
                                    const s = I.metrics.find((m) => m.metric === 'seconds');
                                    const c = I.metrics.find((m) => m.metric === 'calls');
                                    const parts = [];
                                    if (s && s.change != null) parts.push(`${s.change < 0 ? 'answer' : 'take'} ${Math.abs(Math.round(s.change * 100))}% ${s.change < 0 ? 'faster' : 'longer'}`);
                                    if (c && c.change != null) parts.push(`use ${Math.abs(Math.round(c.change * 100))}% ${c.change < 0 ? 'fewer' : 'more'} tool calls`);
                                    return parts.length ? <>With memory, tasks {parts.join(' and ')} ({I.withTasks} vs {I.coldTasks} tasks).</> : null;
                                })()}
                            </div>
                            <ImpactRows rows={I.metrics} fromLabel="Cold start" toLabel="With memory" />
                        </>
                    ) : (
                        <Empty>
                            Collecting. Whether memory was recalled is recorded from {data.trackedSince ? shortDate(data.trackedSince) : 'now'} on.
                            The comparison appears with {MIN_COMPARE}+ tasks on each side ({I ? `${I.withTasks} with, ${I.coldTasks} cold so far` : 'none yet'}).
                        </Empty>
                    )}
                </Card>
                <Card title="Following the playbook"
                    hint="Of the tasks given the memory: those that used the proven approach against those that went their own way.">
                    {followReady
                        ? <ImpactRows rows={I.follow} fromLabel="Not followed" toLabel="Followed" />
                        : <Empty>Needs {MIN_COMPARE}+ recalled tasks of each kind ({I ? `${I.followedTasks} followed, ${I.notFollowedTasks} not` : 'none yet'}).</Empty>}
                </Card>
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Card title="Learning curve"
                    hint="How a theme's 1st–5th, 6th–15th… task compares with that theme's typical task (1×). Bars falling below the line as the count grows mean the theme got better with experience."
                    right={<Segmented options={[['relSeconds', 'Time'], ['relCalls', 'Calls']]} value={curveField} onChange={setCurveField} />}>
                    <CurveChart data={data.learningCurve || []} field={curveField} />
                </Card>
                <Card title="How long answers take"
                    hint={RT.all ? `Median ${fmtSecs(RT.all.median)} · middle half ${fmtSecs(RT.all.p25)}–${fmtSecs(RT.all.p75)} · slowest tenth over ${fmtSecs(RT.all.p90)}${RT.agent ? ` · terminal agent median ${fmtSecs(RT.agent.median)}` : ''}` : 'No timed tasks yet.'}>
                    <HistChart bins={(RT.histogram || [])} />
                </Card>
            </div>

            {/* After each memory update */}
            <Card title="After each memory update"
                hint={U ? `For every new proven approach or playbook rewrite: the theme's last ${U.window} tasks before it against its first ${U.window} after (updates with no task between them share a row). Neighbouring windows overlap — read the totals, not one row.` : ''}>
                {U && U.updates ? (
                    <>
                        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: RULE }}>
                                <div className="text-xs" style={{ color: MUTED }}>Response time after an update</div>
                                <div className="mt-0.5"><b>{U.fasterAfter}</b> faster · <b>{U.slowerAfter}</b> slower of {U.updates} <span className="ml-1"><Change value={U.medianSecondsChange} small /></span> <span className="text-xs" style={{ color: MUTED }}>median change</span></div>
                            </div>
                            <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: RULE }}>
                                <div className="text-xs" style={{ color: MUTED }}>Tool calls after an update</div>
                                <div className="mt-0.5"><b>{U.leanerAfter}</b> leaner · <b>{U.heavierAfter}</b> heavier of {U.updates} <span className="ml-1"><Change value={U.medianCallsChange} small /></span> <span className="text-xs" style={{ color: MUTED }}>median change</span></div>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm" style={{ minWidth: 620 }}>
                                <thead>
                                    <tr className="text-left text-[0.68rem] uppercase tracking-wide" style={{ color: MUTED }}>
                                        <th className="py-1.5 pr-3 font-semibold">Update</th>
                                        <th className="py-1.5 pr-3 font-semibold">When</th>
                                        <th className="py-1.5 pr-3 text-right font-semibold">Time before → after</th>
                                        <th className="py-1.5 pr-3 font-semibold" />
                                        <th className="py-1.5 pr-3 text-right font-semibold">Calls before → after</th>
                                        <th className="py-1.5 font-semibold" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {U.recent.map((e, i) => (
                                        <tr key={i} className="border-t" style={{ borderColor: RULE }}>
                                            <td className="py-1.5 pr-3">
                                                <span className="inline-flex items-center gap-2">
                                                    {e.kind === 'best'
                                                        ? <BestIcon size={14} style={{ color: ACCENT, flexShrink: 0 }} aria-label="new proven approach" />
                                                        : <RefineIcon size={14} style={{ color: MUTED, flexShrink: 0 }} aria-label="playbook rewritten" />}
                                                    <span><b className="font-medium">{e.label}</b>
                                                        <span style={{ color: 'var(--text-secondary)' }}>{e.kind === 'best' ? ` · proven approach ${e.from != null ? `${e.from} → ` : ''}${e.calls} calls` : ''}{e.v != null ? ` · playbook ${e.vFrom != null && e.vFrom !== e.v ? `v${e.vFrom}–v${e.v}` : `v${e.v}`}` : ''}</span>
                                                    </span>
                                                </span>
                                            </td>
                                            <td className="py-1.5 pr-3 text-xs" style={{ color: MUTED }}>{shortDate(e.t)}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{e.seconds ? `${fmtSecs(e.seconds.from)} → ${fmtSecs(e.seconds.to)}` : '—'}</td>
                                            <td className="py-1.5 pr-3">{e.seconds ? <Change value={e.seconds.change} small /> : null}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{e.callsChange ? `${n1(e.callsChange.from)} → ${n1(e.callsChange.to)}` : '—'}</td>
                                            <td className="py-1.5">{e.callsChange ? <Change value={e.callsChange.change} small /> : null}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                ) : <Empty>Needs 3+ tasks before and after an update.</Empty>}
            </Card>

            {/* Per theme */}
            <Card title="By theme" hint="Trends compare a theme's earliest and latest third of tasks. Follow rate = recalled tasks that used the proven approach.">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm" style={{ minWidth: 900 }}>
                        <thead>
                            <tr className="text-left text-[0.68rem] uppercase tracking-wide" style={{ color: MUTED }}>
                                <th className="py-1.5 pr-3 font-semibold">Theme</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Tasks</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Median time</th>
                                <th className="py-1.5 pr-3 font-semibold">Time trend</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Avg calls</th>
                                <th className="py-1.5 pr-3 font-semibold">Calls trend</th>
                                <th className="py-1.5 pr-3 font-semibold">Last 30 (time)</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Recalled</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Followed</th>
                                <th className="py-1.5 text-right font-semibold">Playbook</th>
                            </tr>
                        </thead>
                        <tbody>
                            {themes.map((t) => (
                                <tr key={t.theme} className="border-t" style={{ borderColor: RULE }}>
                                    <td className="py-2 pr-3 font-medium">
                                        <button type="button" className="text-left hover:underline" onClick={() => setScope(t.theme)} title="Show this theme in the charts">{t.label}</button>
                                        {!t.enabled && <span className="ml-1.5 text-xs" style={{ color: '#f59e0b' }}>paused</span>}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{t.lifetimeTasks}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{fmtSecs(t.logged && t.logged.medianSeconds)}</td>
                                    <td className="py-2 pr-3" title={t.secondsTrend ? `${fmtSecs(t.secondsTrend.from)} → ${fmtSecs(t.secondsTrend.to)} (${t.secondsTrend.nFrom} vs ${t.secondsTrend.nTo} tasks, ${EVIDENCE[t.secondsTrend.evidence].label})` : ''}>
                                        {t.secondsTrend ? <Change value={t.secondsTrend.change} small /> : <span className="text-xs" style={{ color: MUTED }}>too few</span>}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{n1(t.lifetimeAvgCalls)}</td>
                                    <td className="py-2 pr-3" title={t.trend ? `${n1(t.trend.early.avgCalls)} → ${n1(t.trend.recent.avgCalls)} calls (${t.trend.window} tasks each)` : ''}>
                                        {t.trend ? <Change value={t.trend.callsChange} small /> : <span className="text-xs" style={{ color: MUTED }}>too few</span>}
                                    </td>
                                    <td className="py-2 pr-3"><Spark values={t.sparkSeconds} label="seconds" /></td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{t.recalled}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{pct(t.followRate)}</td>
                                    <td className="py-2 text-right tabular-nums">v{t.playbookVersion}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}
