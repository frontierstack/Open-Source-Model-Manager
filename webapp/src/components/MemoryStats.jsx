import React from 'react';
import {
    Loader2 as SpinnerIcon,
    Minus as FlatIcon,
    Award as BestIcon,
    PenLine as RefineIcon,
    CheckCircle2 as BetterIcon,
    AlertTriangle as WorseIcon,
    Activity as ActivityIcon,
    Wrench as FixIcon,
    ShieldCheck as SteadyIcon,
    RotateCcw as RevertIcon,
    MessageSquareWarning as CorrectedIcon,
    HelpCircle as ChanceIcon,
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
    rough: { label: 'Tasks with repeated failures', fmt: (v) => pct(v, 0) },
    corrected: { label: 'Answers you corrected', fmt: (v) => pct(v, 0) },
    stepSeconds: { label: 'Model time per step', fmt: (v) => fmtShortSecs(v) },
    modelSeconds: { label: 'Model time per task', fmt: fmtSecs },
    toolWait: { label: 'Tool wait per call', fmt: (v) => fmtShortSecs(v) },
};
function fmtShortSecs(v) { return v == null ? '—' : v < 10 ? `${(Math.round(v * 10) / 10).toFixed(1)}s` : fmtSecs(v); }

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

// Plain words for each lower-is-better measure: [when it went down, when it went up].
const CHANGE_WORDS = {
    seconds: ['faster', 'slower', 'as long'],
    calls: ['fewer calls', 'more calls', 'as many calls'],
    failedShare: ['fewer failed calls', 'more failed calls'],
    rough: ['fewer repeated failures', 'more repeated failures'],
    corrected: ['fewer corrections', 'more corrections'],
    stepSeconds: ['faster per step', 'slower per step', 'as long per step'],
    modelSeconds: ['less model time', 'more model time', 'as much model time'],
    toolWait: ['tools answer faster', 'tools answer slower', 'as long a tool wait'],
};

/** {text, good, flat} for a change: "25% slower", "2.0× as many calls", "9 pts more failed calls". */
function describeChange(value, kind = 'relative', metric = null, invert = false, threshold) {
    if (value == null) return null;
    const t = threshold ?? (kind === 'points' ? 0.03 : 0.08);
    const flat = Math.abs(value) < t;
    const up = value > 0;
    const good = flat ? null : (invert ? up : !up);
    const w = CHANGE_WORDS[metric] || (invert ? ['lower', 'higher'] : ['better', 'worse']);
    const word = up ? w[1] : w[0];
    let text;
    if (flat) text = 'no real change';
    else if (kind === 'points') text = `${Math.abs(Math.round(value * 100))} pts ${word}`;
    else if (up && value >= 1 && w[2]) text = `${(1 + value).toFixed(1)}× ${w[2]}`;
    else text = `${Math.abs(Math.round(value * 100))}% ${word}`;
    return { text, good, flat };
}

// Change chip, in words. Green = better, red = worse — but only when the
// evidence says it is probably real; a change that could be chance is grey
// with a "?" so a noisy +47% never looks like a verdict.
function Change({ value, kind = 'relative', metric = null, evidence = null, invert = false, small = false, threshold, showChance = false }) {
    const d = describeChange(value, kind, metric, invert, threshold);
    if (!d) return <span style={{ color: MUTED }}>—</span>;
    const chance = evidence === 'weak' && !d.flat;
    const color = d.flat || chance ? MUTED : d.good ? GOOD : BAD;
    const Icon = d.flat ? FlatIcon : chance ? ChanceIcon : d.good ? BetterIcon : WorseIcon;
    const dir = d.flat ? 'flat' : value < 0 ? 'down' : 'up';
    const title = `${d.text}${d.flat ? '' : d.good ? ' (better)' : ' (worse)'}${evidence ? ` · ${(EVIDENCE[evidence] || EVIDENCE.weak).label}` : ''}`;
    return (
        <span key={d.text} title={title} className={`ms-chg ms-chg--${dir} inline-flex items-center gap-1 font-medium tabular-nums ${small ? 'text-xs' : ''}`} style={{ color }}>
            <span className="ms-chg-icon inline-flex"><Icon size={small ? 12 : 14} strokeWidth={2} /></span>
            <span style={chance ? { textDecoration: 'underline dotted', textUnderlineOffset: 3 } : undefined}>{d.text}</span>
            {chance && showChance && <span className="font-normal" style={{ color: MUTED }}>· could be chance</span>}
        </span>
    );
}

// One sentence a person can read: what the recent tasks look like against the
// earlier ones, and whether it is likely real.
function verdictSentence(h) {
    if (!h) return 'no tasks yet';
    if (h.from == null) return `${h.n} task${h.n === 1 ? '' : 's'} so far — needs 10 to compare earlier with recent`;
    const d = describeChange(h.change, h.changeKind, h.metric);
    const span = `first ${h.window} vs latest ${h.window} tasks`;
    if (d.flat) return `About the same — ${span}.`;
    const head = d.good ? 'Better' : 'Worse';
    if (h.evidence === 'weak') return `${head}, but could be chance — ${span}.`;
    return `${head} — ${span}, ${h.evidence === 'strong' ? 'strong evidence it is real' : 'some evidence it is real'}.`;
}

// The tile's line: rolling median of the SAME tasks the comparison used, with
// the earlier and recent windows shaded and their medians dashed — the line
// can no longer seem to go one way while the label says the other.
function HeadSpark({ h, fmt, width = 220, height = 44 }) {
    const pts = (h && h.series) || [];
    if (pts.length < 3) return null;
    // Scale to the bulk of the line: one 10-minute task must not flatten the rest.
    const sorted = pts.map((p) => p.y).sort((a, b) => a - b);
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
    const max = Math.max(p90 * 1.25, h.from || 0, h.to || 0) || 1, min = 0;
    const span = max - min || 1;
    const X = (x) => x * width;
    const Y = (y) => height - 3 - ((Math.min(y, max) - min) / span) * (height - 8);
    const line = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const d = h.from != null ? describeChange(h.change, h.changeKind, h.metric) : null;
    const real = d && !d.flat && h.evidence !== 'weak';
    const recentColor = !d || d.flat || !real ? 'var(--text-secondary)' : d.good ? GOOD : BAD;
    const wf = h.window && h.n > 1 ? Math.min(0.5, (h.window - 1) / (h.n - 1)) : 0;
    const k = `${pts.length}:${pts[pts.length - 1].y}`;
    return (
        <div>
            <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" height={height} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
                {wf > 0 && <rect x={0} y={0} width={X(wf)} height={height} fill="var(--bg-hover)" opacity="0.55" />}
                {wf > 0 && <rect x={X(1 - wf)} y={0} width={X(wf)} height={height} fill={recentColor} opacity="0.10" />}
                <polyline key={k} points={line} pathLength="1" className="ms-draw" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {wf > 0 && <line x1={0} x2={X(wf)} y1={Y(h.from)} y2={Y(h.from)} stroke="var(--text-secondary)" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
                {wf > 0 && <line x1={X(1 - wf)} x2={width} y1={Y(h.to)} y2={Y(h.to)} stroke={recentColor} strokeWidth="2.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
            </svg>
            {wf > 0 && (
                <div className="mt-1 flex justify-between text-[0.65rem] tabular-nums" style={{ color: MUTED }}>
                    <span>first {h.window}: {fmt(h.from)}</span>
                    <span>{h.n} tasks</span>
                    <span style={{ color: recentColor === 'var(--text-secondary)' ? undefined : recentColor }}>latest {h.window}: {fmt(h.to)}</span>
                </div>
            )}
        </div>
    );
}

// A formatted number that counts to its new value and flashes when it changes.
function Num({ value, fmt }) {
    const v = useTween(value, 800);
    const bump = useBump(value);
    return <span key={bump} className={bump ? 'ms-num-flash' : undefined}>{value == null ? '—' : fmt(v)}</span>;
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

// A headline number: counts to its new value, flashes when it changes and
// floats the difference up beside it.
function Tile({ label, value, sub, extra, num = null, format = null, chart = null, lowerIsBetter = true }) {
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
            {chart && <div className="mt-2.5">{chart}</div>}
        </div>
    );
}

function Card({ title, hint, children, right, className = '' }) {
    return (
        <div className={`min-w-0 rounded-lg border p-3.5 ${className}`} style={{ borderColor: RULE, backgroundColor: 'var(--bg-secondary)' }}>
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
    { key: 'medianToolSeconds', label: 'Tool wait', fmt: fmtSecs, kind: 'line', hint: 'Median seconds per task spent waiting on tools (parallel calls counted once). Recorded from Nov 11, 2026.' },
    { key: 'medianStepSeconds', label: 'Model time per step', fmt: fmtShortSecs, kind: 'line', hint: 'Median model seconds per tool call: response time minus tool wait, divided by the calls. A bigger job does not move it; a slower or wordier model does.' },
    { key: 'avgCalls', label: 'Tool calls', fmt: n1, kind: 'line', hint: 'Average tool calls per task. Fewer calls for the same kind of work means a shorter path.' },
    { key: 'failedCallRate', label: 'Failed calls', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of tool calls that failed.' },
    { key: 'roughRate', label: 'Repeated failures', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of tasks where the loop guard stepped in or many calls failed.' },
    { key: 'correctionRate', label: 'Corrections', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, hint: 'Share of answers your next message corrected ("that\'s wrong", "I said…"). Tracked from Nov 7, 2026 on.' },
    { key: 'recallRate', label: 'Memory recalled', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, higherIsBetter: true, hint: 'Share of tasks that started with the theme\'s memory. Higher is better here.' },
    { key: 'followRate', label: 'Playbook followed', fmt: (v) => pct(v, 0), kind: 'line', pctAxis: true, higherIsBetter: true, hint: 'Of the tasks given the memory, how many used the proven approach. Higher is better here.' },
    { key: 'tasks', label: 'Tasks', fmt: (v) => String(v), kind: 'bar', hint: 'How much work was recorded in each period.' },
];

function bucketLabel(key, unit) {
    if (!key) return '';
    if (unit === 'hour') { const d = new Date(key); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric' }); }
    return shortDate(key);
}
function bucketTitle(key, unit) {
    if (unit === 'hour') { const d = new Date(key); return isNaN(d) ? '' : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`; }
    if (unit === 'day') return shortDate(key);
    return `Week of ${shortDate(key)}`;
}

function WeeklyChart({ data, metric, height = 180, unit = 'week' }) {
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
            <svg width={w} height={h} role="img" aria-label={`${metric.label} by ${unit}`} style={{ display: 'block' }}>
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
                    // A bucket with under 5 tasks is a hollow dot: it can swing the line on its own.
                    <circle key={`${field}${dd.week}`} cx={x(i)} cy={y(dd[field])} r={hover === i ? 5 : 4} fill={(dd.tasks || 0) < 5 ? 'var(--bg-secondary)' : ACCENT} stroke={(dd.tasks || 0) < 5 ? ACCENT : 'var(--bg-secondary)'} strokeWidth="2"
                        className="ms-pop" style={{ animationDelay: `${300 + Math.min(i, 30) * 25}ms` }} />
                )))}
                {hover != null && metric.kind === 'line' && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />}
                {data.map((dd, i) => (i % labelEvery === 0 ? (
                    <text key={`l${dd.week}`} x={x(i)} y={h - 6} textAnchor="middle" fontSize="10" fill={MUTED}>{bucketLabel(dd.week, unit)}</text>
                ) : null))}
                {data.map((dd, i) => (
                    <rect key={`h${dd.week}`} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} />
                ))}
            </svg>
            {metric.kind === 'line' && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {metric.band && <LegendItem swatch={lineSwatch(ACCENT)} label="median" />}
                    {metric.band && <LegendItem swatch={lineSwatch(MUTED, true)} label="slowest quarter (p75)" />}
                    {data.some((dd) => dd[field] != null && (dd.tasks || 0) < 5) && (
                        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ border: `2px solid ${ACCENT}` }} />under 5 tasks — one task can move it</span>
                    )}
                    <span style={{ color: MUTED }}>{metric.higherIsBetter ? 'Up is better.' : 'Down is better.'}</span>
                </div>
            )}
            {d && (
                <Tooltip x={x(hover)} width={w}>
                    <div className="font-semibold">{bucketTitle(d.week, unit)}</div>
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
                    {t.rough && <div style={{ color: 'var(--text-secondary)' }}>repeated failures (loop guard / many failed calls)</div>}
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
                                <Change value={r.change} kind={r.changeKind} metric={r.metric} evidence={r.evidence} small />
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
                                Same theme against itself ({r.matchedThemes} theme{r.matchedThemes === 1 ? '' : 's'}): <Change value={r.matchedChange} kind={r.changeKind} metric={r.metric} small />
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

// Small neutral line (rolling median). No verdict of its own: the trend
// column beside it is the verdict, computed from the same tasks.
function Spark({ values, width = 84, height = 22, label = 'values' }) {
    if (!values || values.length < 2) return <span style={{ color: MUTED }}>—</span>;
    const max = Math.max(1, ...values);
    const step = width / (values.length - 1);
    const yOf = (v) => height - 2 - (v / max) * (height - 4);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
    const k = `${values.length}:${values[values.length - 1]}`;
    return (
        <svg width={width} height={height} aria-label={`${label}, rolling median`} style={{ display: 'block', overflow: 'visible' }}>
            <polyline key={k} points={pts} pathLength="1" className="ms-draw" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx={(values.length - 1) * step} cy={yOf(values[values.length - 1])} r="2.5" fill="var(--text-secondary)" />
        </svg>
    );
}

// --------------------------------------------------------------- findings



// ------------------------------------------------------- change board

// One row per theme: every measure LATELY (newest tasks against the ones just
// before them — a new change shows here first) and SINCE THE START (earliest
// third against latest third), what drove it (time split into tool wait and
// model time, the tools whose use changed), how many of the theme's tasks got
// its memory, and what self-correction is doing about it.
const BOARD_METRICS = ['seconds', 'stepSeconds', 'toolWait', 'calls', 'failedShare', 'rough', 'corrected'];
const TIME_METRICS = new Set(['seconds', 'stepSeconds', 'toolWait', 'modelSeconds']);

function driverText(f) {
    const d = f && f.drivers;
    if (!d) return null;
    const bits = [];
    if (d.time && TIME_METRICS.has(f.metric)) {
        const dt = d.time.toolTo - d.time.toolFrom, dm = d.time.modelTo - d.time.modelFrom;
        bits.push(`waiting on tools ${fmtSecs(d.time.toolFrom)} → ${fmtSecs(d.time.toolTo)}, model ${fmtSecs(d.time.modelFrom)} → ${fmtSecs(d.time.modelTo)}`
            + (Math.abs(dt) > Math.abs(dm) * 1.5 ? ' — mostly the tools' : Math.abs(dm) > Math.abs(dt) * 1.5 ? ' — mostly the model' : ''));
    }
    if (d.tools && d.tools.list.length) {
        const unit = d.tools.per === 'seconds' ? ' s' : d.tools.per === 'failed' ? ' failed' : '';
        bits.push(d.tools.list.slice(0, 3).map((x) => `${x.tool} ${x.delta > 0 ? '+' : ''}${x.delta}${unit}`).join(', ') + ' per task');
    }
    return bits.length ? bits.join(' · ') : null;
}

function BoardCell({ f }) {
    if (!f) return <span className="text-xs" style={{ color: MUTED }}>—</span>;
    const fmt = (METRIC_FMT[f.metric] || { fmt: n1 }).fmt;
    const e = EVIDENCE[f.evidence] || EVIDENCE.weak;
    return (
        <div className="min-w-0">
            <Change value={f.change} kind={f.changeKind} metric={f.metric} evidence={f.evidence} small />
            <div className="text-[0.7rem] tabular-nums" style={{ color: MUTED }}
                title={`${e.label}${f.p != null ? ` · p = ${f.p < 0.001 ? '<0.001' : f.p.toFixed(3)}` : ''} · ${f.nFrom} vs ${f.nTo} tasks`}>
                {f.matched ? `${(f.themes || []).length} themes, like for like` : `${fmt(f.from)} → ${fmt(f.to)}`}
                <span className="ml-1.5 inline-flex gap-0.5 align-middle" aria-label={e.label}>
                    {[0, 1, 2].map((i) => <span key={i} className="inline-block h-1 w-1 rounded-full" style={{ backgroundColor: i < e.dots ? 'var(--text-secondary)' : 'var(--bg-hover)' }} />)}
                </span>
            </div>
        </div>
    );
}

const notable = (f) => f && f.direction !== 'flat';
function themeStatus({ th, rows, cov, SC }) {
    const act = (SC.actions || []).find((a) => a.th === th && a.status === 'active');
    if (act) return { tone: 'accent', text: `Being corrected · ${act.progress || 0} of ${SC.evalTasks || 8} tasks measured`, detail: `${act.kind === 'revert' ? `restored playbook v${act.toVersion}` : 'rewrote the playbook'} for ${String(act.metricLabel || '').toLowerCase()}; an unmistakable effect is decided after ${SC.earlyTasks || 5}` };
    const watch = (SC.watch || []).filter((w) => w.scope === th);
    if (watch.some((w) => w.actionable)) return { tone: 'bad', text: 'Correction starts at the next check', detail: watch.filter((w) => w.actionable).map((w) => w.metricLabel).join(', ') };
    const worse = rows.filter((r) => [r.lately, r.overall].some((f) => f && f.direction === 'worse' && f.evidence !== 'weak'));
    if (worse.length && cov && cov.tasks && cov.withMemory < 8) {
        return { tone: 'bad', text: `Getting worse — can't be corrected yet`, detail: `only ${cov.withMemory} of ${cov.tasks} tasks were handed this theme's memory; a correction needs 8 to measure` };
    }
    if (worse.length) return { tone: 'bad', text: 'Getting worse', detail: watch.length ? watch[0].reason : 'watching until the evidence is real' };
    const better = rows.filter((r) => [r.lately, r.overall].some((f) => f && f.direction === 'better' && f.evidence !== 'weak'));
    if (better.length) return { tone: 'good', text: 'Improving', detail: null };
    return { tone: 'muted', text: 'Steady', detail: rows.some((r) => notable(r.lately) || notable(r.overall)) ? 'changes so far could be chance' : null };
}
const TONE = { accent: ACCENT, bad: BAD, good: GOOD, muted: MUTED };

function ChangeBoard({ F, coverage, SC, labelOf, showWeak }) {
    const byTheme = new Map();
    const put = (f, slot) => {
        if (!f || !BOARD_METRICS.includes(f.metric)) return;
        if (!byTheme.has(f.scope)) byTheme.set(f.scope, { label: f.scopeLabel, m: new Map() });
        const t = byTheme.get(f.scope);
        if (!t.m.has(f.metric)) t.m.set(f.metric, { metric: f.metric });
        t.m.get(f.metric)[slot] = f;
    };
    for (const f of [...(F.improving || []), ...(F.worsening || [])]) put(f, 'overall');
    for (const f of F.lately || []) put(f, 'lately');
    // Steady overall findings are not in the improving/worsening lists; the
    // row still shows the measure when "lately" has something.
    const themesOut = [...byTheme.entries()].map(([th, t]) => {
        const all = BOARD_METRICS.map((k) => t.m.get(k)).filter(Boolean);
        const shown = all.filter((r) => [r.lately, r.overall].some((f) => notable(f) && (showWeak || f.evidence !== 'weak')));
        const status = th === 'chat' ? null : themeStatus({ th, rows: all, cov: coverage && coverage[th], SC });
        const score = all.reduce((n, r) => n + [r.lately, r.overall].reduce((k, f) => k + (f && f.direction === 'worse' ? (f.evidence === 'strong' ? 4 : f.evidence === 'moderate' ? 2 : 0) : 0), 0), 0);
        return { th, label: labelOf.get(th) || t.label || th, all, shown, status, score, hidden: all.length - shown.length };
    }).filter((t) => t.all.length)
        .sort((a, b) => (a.th === 'chat') - (b.th === 'chat') || b.score - a.score || a.label.localeCompare(b.label));
    if (!themesOut.length) return <Empty>Not enough tasks yet — a theme needs {F.recentMin ? F.recentMin * 2 : 10}+ tasks before its newest ones can be compared.</Empty>;
    return (
        <div className="divide-y" style={{ borderColor: RULE }}>
            {themesOut.map((t) => {
                const cov = coverage && coverage[t.th];
                return (
                    <section key={t.th} className="py-3 first:pt-0" style={{ borderColor: RULE }}>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                            <div className="text-sm">
                                <b className="font-medium">{t.th === 'chat' ? 'All web chat' : t.label}</b>
                                {cov && <span className="ml-2 text-xs tabular-nums" style={{ color: cov.tasks && cov.withMemory / cov.tasks < 0.5 ? BAD : MUTED }}
                                    title="Tasks handed this theme's memory (at the start, or mid-turn once the first tools showed the kind of work). Self-correction can only see and judge these.">
                                    {cov.tasks} tasks · memory reached {cov.withMemory}
                                </span>}
                            </div>
                            {t.status && (
                                <div className="text-xs" style={{ color: TONE[t.status.tone] }}>
                                    <span className="font-medium">{t.status.text}</span>
                                    {t.status.detail && <span style={{ color: MUTED }}> — {t.status.detail}</span>}
                                </div>
                            )}
                        </div>
                        {t.shown.length ? (
                            <div className="mt-2">
                                <div className="ms-board-row ms-board-head text-[0.66rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
                                    <span>Measure</span>
                                    <span title="Newest tasks against the ones just before them">Lately</span>
                                    <span title="Earliest third of tasks against the latest third">Since the start</span>
                                    <span>What drove it</span>
                                </div>
                                {t.shown.map((r) => {
                                    const why = driverText(r.lately) || driverText(r.overall) || (TIME_METRICS.has(r.metric) ? 'tool timing not recorded for these tasks' : '');
                                    return (
                                        <div key={r.metric} className="ms-feed-in ms-board-row border-t py-1.5" style={{ borderColor: RULE }}>
                                            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{(METRIC_FMT[r.metric] || {}).label || r.metric}</span>
                                            <span><span className="ms-board-label">Lately</span><BoardCell f={r.lately} /></span>
                                            <span><span className="ms-board-label">Since the start</span><BoardCell f={r.overall} /></span>
                                            <span className="text-[0.72rem]" style={{ color: MUTED }}>{why}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="mt-1 text-xs" style={{ color: MUTED }}>
                                No change{showWeak ? '' : ' with evidence'} on {t.all.length} measure{t.all.length === 1 ? '' : 's'}.
                            </div>
                        )}
                        {t.shown.length > 0 && t.hidden > 0 && (
                            <div className="mt-1 text-[0.7rem]" style={{ color: MUTED }}>{t.hidden} other measure{t.hidden === 1 ? '' : 's'} steady{showWeak ? '' : ' or could be chance'}.</div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

// How each tool is used: calls, failures, time per call and its share of all
// time spent waiting on tools, with time per call earlier vs lately.
function ToolUsageCard({ U }) {
    const [all, setAll] = React.useState(false);
    const tools = (U && U.tools) || [];
    const list = all ? tools : tools.slice(0, 10);
    return (
        <Card title="How tools are used"
            hint="Per tool, over tasks with per-call records (from Nov 11, 2026, plus older tasks whose conversation still exists). Time per call is the median of each task's average; the share is of all time spent waiting on tools. Trend compares time per call in the earliest and latest tasks.">
            {!tools.length ? <Empty>Per-call timing is recorded from Nov 11, 2026 on — this fills in as tasks run.</Empty> : (
                <>
                    <div className="mb-2 text-xs" style={{ color: MUTED }}>{U.tasks} task{U.tasks === 1 ? '' : 's'} with per-tool records · {U.timedTasks || 0} with tool timing</div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm" style={{ minWidth: 560 }}>
                            <thead>
                                <tr className="text-[0.66rem] uppercase tracking-wide" style={{ color: MUTED }}>
                                    <th className="pb-1 font-semibold">Tool</th>
                                    <th className="pb-1 text-right font-semibold">Calls</th>
                                    <th className="pb-1 text-right font-semibold">Tasks</th>
                                    <th className="pb-1 text-right font-semibold">Failed</th>
                                    <th className="pb-1 text-right font-semibold">Per call</th>
                                    <th className="w-[22%] pb-1 pl-3 font-semibold">Share of tool time</th>
                                    <th className="pb-1 font-semibold">Time per call</th>
                                </tr>
                            </thead>
                            <tbody>
                                {list.map((t) => (
                                    <tr key={t.tool} className="border-t" style={{ borderColor: RULE }}>
                                        <td className="py-1.5 pr-2 font-mono text-xs">{t.tool}</td>
                                        <td className="py-1.5 text-right tabular-nums">{t.calls}</td>
                                        <td className="py-1.5 text-right tabular-nums">{t.tasks}</td>
                                        <td className="py-1.5 text-right tabular-nums" style={{ color: t.failedShare >= 0.2 ? BAD : undefined }}>{pct(t.failedShare, 0)}</td>
                                        <td className="py-1.5 text-right tabular-nums">{fmtShortSecs(t.perCall)}</td>
                                        <td className="py-1.5 pl-3">
                                            {t.timeShare != null ? (
                                                <div className="flex items-center gap-2">
                                                    <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: 'var(--bg-hover)' }}>
                                                        <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, t.timeShare * 100)}%`, backgroundColor: ACCENT }} />
                                                    </div>
                                                    <span className="w-9 text-right text-xs tabular-nums" style={{ color: MUTED }}>{pct(t.timeShare, 0)}</span>
                                                </div>
                                            ) : <span style={{ color: MUTED }}>—</span>}
                                        </td>
                                        <td className="py-1.5 pl-2">
                                            {t.trend ? <Change value={t.trend.change} kind="relative" metric="toolWait" evidence={t.trend.evidence} small /> : <span className="text-xs" style={{ color: MUTED }}>needs 8 timed tasks</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {tools.length > 10 && (
                        <button type="button" className="mt-2 text-xs underline" style={{ color: MUTED }} onClick={() => setAll((v) => !v)}>
                            {all ? 'show fewer' : `show all ${tools.length} tools`}
                        </button>
                    )}
                </>
            )}
        </Card>
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
            if (t.rough) tags.push(['repeated failures', BAD]);
            return { icon: ActivityIcon, color: ACCENT, title: `${L(ev.theme)} task`, detail: t.title || '', meta: bits.join(' · '), tags };
        }
        case 'refine': return { icon: RefineIcon, color: ACCENT, title: `${L(ev.theme)} playbook rewritten`, meta: `now v${ev.v}` };
        case 'best': return { icon: BestIcon, color: GOOD, title: `${L(ev.theme)}: new proven approach`, meta: ev.calls != null ? `${ev.from != null ? `${ev.from} → ` : ''}${ev.calls} calls` : '' };
        case 'correction': return { icon: CorrectedIcon, color: BAD, title: 'You corrected an answer', meta: 'counted against that task' };
        case 'self_check': {
            const c = ev.check || {};
            const acted = (c.considered || []).filter((x) => x.decision === 'act');
            if (!acted.length && !(c.judged || []).length) return null;   // quiet checks stay in the card's log
            return { icon: FixIcon, color: '#f59e0b', title: 'Self-check', detail: [...(c.judged || []).map((j) => `verdict on ${j.label}: ${STATUS_TEXT[j.status] || j.status}`), ...acted.map((x) => `${x.label}: ${x.reason}`)].join(' · ') };
        }
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
            right={<LiveBadge live={live} />} className="flex flex-col">
            {items.length ? (
                // Side by side the row height comes from Self-correction: the list is taken out
                // of flow so it fills that height (and scrolls to the card's edge) without adding to it.
                <div className="relative min-h-0 flex-1 xl:min-h-[340px]">
                <ul className="ms-feed -mx-1 max-h-[340px] overflow-y-auto xl:absolute xl:inset-0 xl:max-h-none">
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
                </div>
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

// The playbook text before and after a correction.
function PlaybookDiff({ a }) {
    const [open, setOpen] = React.useState(false);
    if (!a.fromText && !a.toText) return null;
    return (
        <div className="mt-2">
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium hover:underline" style={{ color: ACCENT }} aria-expanded={open}>
                {open ? 'Hide' : 'Show'} what changed in the playbook{a.fromVersion != null ? ` (v${a.fromVersion} → v${a.toVersion})` : ''}
            </button>
            {open && (
                <div className="ms-feed-in mt-1.5 grid grid-cols-1 gap-2 md:grid-cols-2">
                    {[['Before', a.fromText, BAD], [a.kind === 'revert' ? 'Restored' : 'Rewritten', a.toText, GOOD]].map(([l, t, c]) => (
                        <div key={l} className="rounded-md border p-2 text-xs leading-relaxed" style={{ borderColor: `color-mix(in oklab, ${c} 35%, var(--border-primary))` }}>
                            <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide" style={{ color: c }}>{l}</div>
                            <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{t || '(empty)'}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const DECISION = {
    act: { label: 'acted', color: '#f59e0b' },
    wait: { label: 'waiting', color: ACCENT },
    skip: { label: 'not acted on', color: MUTED },
};

// What each check looked at and decided, newest first.
function ChecksLog({ checks, now }) {
    const [all, setAll] = React.useState(false);
    if (!checks || !checks.length) return <div className="py-2 text-xs" style={{ color: MUTED }}>No checks have run yet — the first runs a couple of minutes after the server starts, then after every task and every 30 minutes.</div>;
    const list = all ? checks : checks.slice(0, 1);
    return (
        <div>
            <ul className="space-y-2">
                {list.map((c, i) => (
                    <li key={c.t} className={`rounded-md border p-2.5 ${i === 0 ? 'ms-feed-in' : ''}`} style={{ borderColor: RULE }}>
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                                Check {ago(c.t, now)}
                            </span>
                            <span className="tabular-nums" style={{ color: MUTED }}>
                                {(c.considered || []).length} measure{(c.considered || []).length === 1 ? '' : 's'} trending worse reviewed
                                {c.judged && c.judged.length ? ` · ${c.judged.length} verdict${c.judged.length === 1 ? '' : 's'}` : ''}
                                {c.ms != null ? ` · ${c.ms < 1000 ? `${c.ms} ms` : `${(c.ms / 1000).toFixed(1)} s`}` : ''}
                            </span>
                        </div>
                        <ul className="mt-1.5 space-y-1 text-xs">
                            {(c.judged || []).map((j, k) => (
                                <li key={`j${k}`} className="flex gap-2">
                                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[j.status] || MUTED }} />
                                    <span><b className="font-medium">Verdict · {j.label}</b> {j.metricLabel.toLowerCase()}: {STATUS_TEXT[j.status] || j.status}{j.early ? ' early (clearly worse after 2 tasks)' : ''}{j.results && j.results.length > 1 ? ` — ${j.results.map((r) => `${r.metricLabel.toLowerCase()} ${fmtFor(r.metric, r.baseline)} → ${fmtFor(r.metric, r.value)}`).join(', ')}` : j.to != null ? ` (${fmtFor(j.metric, j.from)} → ${fmtFor(j.metric, j.to)})` : ''}</span>
                                </li>
                            ))}
                            {(c.measuring || []).map((m, k) => (
                                <li key={`m${k}`} className="flex gap-2">
                                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
                                    <span><b className="font-medium">Measuring · {m.label}</b> {m.metricLabel.toLowerCase()}: {m.progress}/{m.progress + (m.remaining || 0)} tasks so far</span>
                                </li>
                            ))}
                            {(c.considered || []).map((x, k) => {
                                const d = DECISION[x.decision] || DECISION.skip;
                                return (
                                    <li key={`c${k}`} className="flex gap-2">
                                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                                        <span style={{ color: 'var(--text-secondary)' }}>
                                            <b className="font-medium" style={{ color: 'var(--text-primary)' }}>{x.label} · {x.metricLabel.toLowerCase()}</b>{' '}
                                            <span className="tabular-nums">{fmtFor(x.metric, x.from)} → {fmtFor(x.metric, x.to)}</span>{' '}
                                            — <span style={{ color: d.color }}>{d.label}</span>: {x.reason}
                                        </span>
                                    </li>
                                );
                            })}
                            {!(c.judged || []).length && !(c.measuring || []).length && !(c.considered || []).length && (
                                <li style={{ color: GOOD }}>Nothing trending worse — no action needed.</li>
                            )}
                        </ul>
                    </li>
                ))}
            </ul>
            {checks.length > 1 && (
                <button type="button" onClick={() => setAll((v) => !v)} className="mt-1.5 text-xs hover:underline" style={{ color: ACCENT }}>
                    {all ? 'Show only the latest check' : `Show ${checks.length - 1} earlier check${checks.length === 2 ? '' : 's'}`}
                </button>
            )}
        </div>
    );
}

// One active correction: applied → measuring (n of N tasks) → verdict, with
// the measure so far against where it started. Updates on every task.
function CorrectionTracker({ a, evalTasks, now }) {
    const fmt = (v) => (METRIC_FMT[a.metric] || { fmt: n1 }).fmt(v);
    const n = a.progress || 0;
    const bump = useBump(n);
    const pctDone = Math.round((n / evalTasks) * 100);
    const metricsList = (a.metrics && a.metrics.length) ? a.metrics : [{ metric: a.metric, metricLabel: a.metricLabel, baseline: a.baseline }];
    const readingsByMetric = new Map((a.interims || (a.interim ? [{ ...a.interim, metric: a.metric }] : [])).map((r) => [r.metric, r]));
    const anyReading = readingsByMetric.size > 0;
    const fmtM = (m) => (v) => (METRIC_FMT[m] || { fmt: n1 }).fmt(v);
    const steps = [
        ['Applied', true],
        [`Measuring ${n}/${evalTasks}`, n > 0],
        ['Verdict', false],
    ];
    return (
        <li className="ms-feed-in rounded-md border p-2.5" style={{ borderColor: 'color-mix(in oklab, #f59e0b 35%, var(--border-primary))', backgroundColor: 'color-mix(in oklab, #f59e0b 5%, transparent)' }}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-sm"><b className="font-medium">{a.label}</b><span style={{ color: 'var(--text-secondary)' }}> · {a.metricLabel}</span></span>
                <span className="text-[0.7rem] tabular-nums" style={{ color: MUTED }}>started {ago(a.t, now)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs" style={{ color: '#f59e0b' }}>
                <span className="ms-status-dot is-on" style={{ backgroundColor: '#f59e0b' }} />
                {a.kind === 'revert' ? `Restored playbook v${a.toVersion != null ? a.toVersion : ''}${a.basis ? '' : ''}` : `Playbook rewritten (v${a.toVersion})`} — {a.why}
            </div>
            <ol className="ms-steps mt-2.5 flex items-center gap-1.5 text-[0.68rem] font-semibold">
                {steps.map(([label, done], i) => (
                    <React.Fragment key={i}>
                        {i > 0 && <span className={`ms-step-line ${done ? 'is-done' : ''}`} />}
                        <li className={`ms-step ${done ? 'is-done' : ''} ${i === 1 && n < evalTasks ? 'is-current' : ''}`}>
                            <span className="ms-step-dot" />{label}
                        </li>
                    </React.Fragment>
                ))}
            </ol>
            <div className="mt-2.5 flex items-center gap-2">
                <span className="ms-progress h-2 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-hover)' }}>
                    <span className="ms-progress-fill block h-full rounded-full" style={{ width: `${Math.max(3, pctDone)}%`, backgroundColor: '#f59e0b' }} />
                </span>
                <span key={bump} className={`shrink-0 text-xs font-semibold tabular-nums ${bump ? 'ms-num-flash' : ''}`}>{pctDone}%</span>
            </div>
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {metricsList.map((x) => {
                    const r = readingsByMetric.get(x.metric);
                    const f = fmtM(x.metric);
                    const col = r ? (r.direction === 'better' ? GOOD : r.direction === 'worse' ? BAD : MUTED) : MUTED;
                    return (
                        <li key={x.metric} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{x.metricLabel}</span>
                            {r ? (
                                <>
                                    <span>so far <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}><Num value={r.value} fmt={f} /></b></span>
                                    <span style={{ color: MUTED }}>vs {f(x.baseline)} before</span>
                                    <Change value={r.change} kind={r.changeKind} metric={r.metric} evidence={r.evidence} small />
                                    <span className="font-medium" style={{ color: col }}>{r.direction === 'better' ? 'trending better' : r.direction === 'worse' ? 'trending worse' : 'no clear change yet'}</span>
                                </>
                            ) : <span style={{ color: MUTED }}>was {f(x.baseline)} before the fix — no reading yet</span>}
                        </li>
                    );
                })}
            </ul>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {anyReading ? <span>Readings over {n} task{n === 1 ? '' : 's'} that used the fix.</span> : <span>No {a.label} task has used the fix yet — nothing to measure.</span>}
                <span className="tabular-nums" style={{ color: MUTED }}>
                    {a.remaining ? `${a.remaining} more task${a.remaining === 1 ? '' : 's'} to a verdict` : 'verdict due at the next check'}{a.lastTaskAt ? ` · last ${ago(a.lastTaskAt, now)}` : ''}
                </span>
            </div>
            <div className="mt-2 rounded-md px-2.5 py-2 text-xs leading-relaxed" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>
                {(() => {
                    const pace = a.themeTasks14d != null ? a.themeTasks14d / 14 : null;
                    const paceTxt = pace == null ? '' : pace >= 1 ? `about ${Math.round(pace)} a day` : pace > 0 ? `about ${Math.max(1, Math.round(pace * 7))} a week` : 'none in the last two weeks';
                    return (
                        <>
                            <b style={{ color: 'var(--text-primary)' }}>What it's waiting for:</b> the fix is judged only on new {a.label} tasks that were given this playbook, so it advances when the next such task runs
                            {a.lastThemeTaskAt ? ` (the last one was ${ago(a.lastThemeTaskAt, now)}` : ''}{paceTxt ? `${a.lastThemeTaskAt ? '; ' : ' ('}${paceTxt} lately` : ''}{(a.lastThemeTaskAt || paceTxt) ? ')' : ''}.
                            {a.etaDays != null && a.remaining ? ` At that pace the verdict lands in about ${a.etaDays < 1 ? 'a day' : `${Math.round(a.etaDays)} day${Math.round(a.etaDays) === 1 ? '' : 's'}`}.` : ''}
                            {' '}After {evalTasks} such tasks it compares {metricsList.length > 1 ? `each of the ${metricsList.length} measures` : a.metricLabel.toLowerCase()} with before the fix, and only a difference too large to be chance counts: clearly better → kept, clearly worse on any measure → the old playbook comes back, anything else → no clear effect.
                        </>
                    );
                })()}
            </div>
            <PlaybookDiff a={a} />
        </li>
    );
}

function SelfCorrection({ data, now }) {
    const SC = data.selfCorrect || { actions: [], evalTasks: 6 };
    const actions = SC.actions || [];
    const active = actions.filter((a) => a.status === 'active');
    // Watching = the server's all-time list (the view's range filter does not apply).
    const watching = (SC.watch || []).filter((w) => !active.some((a) => a.th === w.scope));
    // Verdicts reached on fewer tasks than today's rule needs (the early 2–3-task
    // rule) were mostly chance — shown in the history, not counted here.
    const solid = (a) => !(a.after && a.after.n < (SC.evalTasks || 8));
    const helped = actions.filter((a) => a.status === 'helped' && solid(a)).length;
    const rolled = actions.filter((a) => (a.status === 'rolled_back' || a.status === 'worse') && solid(a)).length;
    const fmt = (m, v) => (METRIC_FMT[m] || { fmt: n1 }).fmt(v);
    const statusFor = (w) => {
        const last = actions.find((a) => a.th === w.scope);
        if (last && now - Date.parse(last.t) < (SC.cooldownHours || 6) * 3600e3) return { text: `Last attempt ${STATUS_TEXT[last.status] || last.status} · next try after the cooldown`, color: MUTED };
        if (!w.actionable) return { text: `Watching · ${w.reason}`, color: MUTED };
        return { text: 'Will act at the next check', color: ACCENT, on: true };
    };
    return (
        <Card title="Self-correction"
            hint={`When a theme's numbers trend the wrong way with real evidence, the system acts on its own: it restores a playbook that measured better, or rewrites the playbook against the slow tasks. It looks only at tasks that were given the theme's memory, since a playbook cannot change the others. After ${SC.evalTasks || 8} such tasks it judges the result and rolls back a fix that made things worse. Checks run after every task, on your full history — the time range above does not change what gets corrected.`}
            right={SC.lastCheckAt ? <span className="text-[0.7rem] tabular-nums" style={{ color: MUTED }}>checked {ago(SC.lastCheckAt, now)}</span> : null}
            className="flex flex-col xl:max-h-[720px]">
            {/* Capped side by side: this card sets the row height, so unbounded it left Live activity mostly empty. */}
            <div className="min-h-0 flex-1 xl:overflow-y-auto xl:pr-1">
            <div className="mb-3 grid grid-cols-3 gap-2">
                {[['Correcting', active.length, '#f59e0b'], ['Helped', helped, GOOD], ['Rolled back / worse', rolled, BAD]].map(([l, v, c]) => (
                    <div key={l} className="rounded-md border px-2.5 py-2" style={{ borderColor: RULE }}>
                        <div className="text-[0.65rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>{l}</div>
                        <div className="text-lg font-semibold tabular-nums" style={{ color: v ? c : 'var(--text-primary)' }}><Counter value={v} /></div>
                    </div>
                ))}
            </div>
            {active.length > 0 && (
                <>
                    <div className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>In progress</div>
                    <ul className="mb-3 space-y-2">
                        {active.map((a) => <CorrectionTracker key={a.id} a={a} evalTasks={SC.evalTasks || 6} now={now} />)}
                    </ul>
                </>
            )}
            <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>Watching</div>
            {watching.length ? (
                <ul className="mb-3">
                    {watching.map((w) => {
                        const st = statusFor(w);
                        return (
                            <li key={`${w.scope}${w.metric}`} className="ms-feed-in border-t py-2 first:border-t-0" style={{ borderColor: RULE }}>
                                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                                    <span className="text-sm"><b className="font-medium">{w.scopeLabel}</b><span style={{ color: 'var(--text-secondary)' }}> · {(METRIC_FMT[w.metric] || {}).label || w.metricLabel}</span></span>
                                    <span className="inline-flex items-center gap-2 text-xs"><span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}><Num value={w.from} fmt={(v) => fmt(w.metric, v)} /> → <Num value={w.to} fmt={(v) => fmt(w.metric, v)} /></span><Change value={w.change} kind={w.changeKind} small /></span>
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: st.color }}>
                                    <span className={`ms-status-dot ${st.on ? 'is-on' : ''}`} style={{ backgroundColor: st.color }} />{st.text}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            ) : !active.length ? (
                <div className="mb-3 flex items-center gap-2 rounded-md px-2 py-2 text-xs" style={{ color: GOOD, backgroundColor: `color-mix(in oklab, ${GOOD} 8%, transparent)` }}>
                    <SteadyIcon size={14} /> Nothing is trending the wrong way with evidence — no correction needed.
                </div>
            ) : <div className="mb-3 py-1 text-xs" style={{ color: MUTED }}>Nothing else trending the wrong way.</div>}
            <div className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>Recent checks</div>
            <div className="mb-3"><ChecksLog checks={SC.checks} now={now} /></div>
            <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>History</div>
            {actions.length ? (
                <ul className="max-h-[220px] overflow-y-auto xl:max-h-none xl:overflow-visible">
                    {actions.slice(0, 12).map((a) => (
                        <li key={a.id} className="flex items-start gap-2.5 border-t py-2 first:border-t-0" style={{ borderColor: RULE }}>
                            {a.kind === 'revert' ? <RevertIcon size={14} style={{ color: MUTED, marginTop: 3, flexShrink: 0 }} /> : <FixIcon size={14} style={{ color: MUTED, marginTop: 3, flexShrink: 0 }} />}
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                                    <span className="text-sm"><b className="font-medium">{a.label}</b><span style={{ color: 'var(--text-secondary)' }}> · {a.metricLabel}</span></span>
                                    <span className="rounded-full px-1.5 py-px text-[0.7rem] font-medium" style={{ color: STATUS_COLOR[a.status], backgroundColor: `color-mix(in oklab, ${STATUS_COLOR[a.status]} 12%, transparent)` }}>{STATUS_TEXT[a.status] || a.status}</span>
                                </div>
                                <div className="truncate text-xs" style={{ color: 'var(--text-secondary)' }} title={a.why}>{a.why}</div>
                                {a.closedReason && <div className="text-[0.7rem]" style={{ color: MUTED }}>{a.closedReason}</div>}
                                {!a.closedReason && a.status !== 'active' && !solid(a) && <div className="text-[0.7rem]" style={{ color: MUTED }}>judged on only {a.after.n} task{a.after.n === 1 ? '' : 's'} under the early rule — likely chance, not counted above</div>}
                                <div className="text-[0.7rem] tabular-nums" style={{ color: MUTED }}>
                                    {ago(a.t, now)}{a.fromVersion != null ? ` · v${a.fromVersion} → v${a.toVersion}` : ''}
                                    {a.after ? ` · ${fmt(a.metric, a.baseline)} → ${fmt(a.metric, a.after.value)} over ${a.after.n} tasks` : a.status === 'active' ? ` · ${a.progress || 0}/${SC.evalTasks} tasks so far` : ''}
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : <div className="py-2 text-xs" style={{ color: MUTED }}>No corrections yet{SC.lastCheckAt ? ` · last checked ${ago(SC.lastCheckAt, now)}` : ''}.</div>}
            </div>
        </Card>
    );
}

function Counter({ value }) {
    const v = useTween(value, 700);
    return <>{v == null ? '—' : Math.round(v)}</>;
}

// --------------------------------------------------------------- the view

const MIN_COMPARE = 3;

const RANGES = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['1y', 'Year'], ['all', 'All time']];
const RANGE_TEXT = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days', '1y': 'the last year', all: 'all time' };

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
    const mountedAt = React.useRef(Date.now());
    const now = useNow(1000);
    const [range, setRangeState] = React.useState(() => { try { return localStorage.getItem('memoryStatsRange') || 'all'; } catch (_) { return 'all'; } });
    const [switching, setSwitching] = React.useState(false);
    const setRange = (r) => { setRangeState(r); setSwitching(true); try { localStorage.setItem('memoryStatsRange', r); } catch (_) { /* per-browser only */ } };
    const streamQs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    const qs = `?${new URLSearchParams({ ...(userId ? { userId } : {}), ...(range !== 'all' ? { range } : {}) }).toString()}`;

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
        } catch (e) { if (!silent) setError(e.message); } finally { if (!silent) setLoading(false); setSwitching(false); }
    }, [qs]);
    const loadedOnce = React.useRef(false);
    React.useEffect(() => { load(loadedOnce.current); loadedOnce.current = true; }, [load]);

    // Live feed: the server pushes a frame per task / memory update /
    // self-correction step; each one refreshes the stats (coalesced).
    React.useEffect(() => {
        let es = null, pending = 0, poll = 0, closed = false;
        const refresh = () => { clearTimeout(pending); pending = setTimeout(() => load(true), 700); };
        const open = () => {
            if (closed || typeof EventSource === 'undefined') { setLive('reconnecting'); return; }
            es = new EventSource(`/api/memories/stats/stream${streamQs}`, { withCredentials: true });
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
    }, [streamQs, load]);


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
    const H = data.headline || {};
    // Like for like (each theme against itself) only when it tells a different
    // story from the plain comparison above it, and says how sure it is.
    const lflNote = (f, h) => {
        if (!f || f.change == null || !h || h.change == null) return null;
        const a = describeChange(f.change, f.changeKind, f.metric), b = describeChange(h.change, h.changeKind, h.metric);
        if (a.flat === b.flat && a.good === b.good) return null;
        return <span className="block">same kind of work only: {a.text} ({(EVIDENCE[f.evidence] || EVIDENCE.weak).label}) — the mix of tasks changed</span>;
    };
    const RT = data.responseTime || {};
    const I = data.impact;
    const U = data.updateImpact;
    const visible = (list) => list.filter((f) => showWeak || f.evidence !== 'weak');
    const improving = visible(F.improving || []);
    const worsening = visible(F.worsening || []);
    const hiddenWeak = (F.improving || []).length + (F.worsening || []).length - improving.length - worsening.length
        + (F.lately || []).filter((f) => f.direction !== 'flat' && f.evidence === 'weak').length;
    const solidBetter = (F.improving || []).filter((f) => f.evidence !== 'weak').length;
    const solidWorse = (F.worsening || []).filter((f) => f.evidence !== 'weak').length;
    const wm = WEEKLY_METRICS.find((m) => m.key === weeklyMetric) || WEEKLY_METRICS[0];
    const impactReady = I && I.withTasks >= MIN_COMPARE && I.coldTasks >= MIN_COMPARE;
    const followReady = I && I.followedTasks >= MIN_COMPARE && I.notFollowedTasks >= MIN_COMPARE;
    const corrTracked = (data.tasks || []).filter((t) => typeof t.cor === 'boolean');
    const corrRate = corrTracked.length ? corrTracked.filter((t) => t.cor).length / corrTracked.length : null;

    const scopeSelect = (
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: RULE, backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }} aria-label="Theme">
            <option value="all">All themes</option>
            {themes.map((t) => <option key={t.theme} value={t.theme}>{t.label}</option>)}
        </select>
    );

    return (
        <div className={`ms-root min-h-0 flex-1 space-y-4 overflow-y-auto pb-6 pr-1 ${switching ? 'is-switching' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                    <LiveBadge live={live} />
                    <span className="text-xs tabular-nums" style={{ color: MUTED }}>
                        {updatedAt ? `updated ${ago(updatedAt, now)}` : ''}{live !== 'live' ? ' · refreshing every 30 s' : ''}
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-xs tabular-nums" style={{ color: MUTED }}>
                        {(L.tasks || 0).toLocaleString()} tasks{range !== 'all' && data.since ? ` since ${shortDate(data.since)}` : ''} · {themes.length} themes
                    </span>
                    <Segmented options={RANGES} value={range} onChange={setRange} />
                </div>
            </div>
            {/* Headline numbers */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label="Median response time · web chat" value={fmtSecs(H.seconds ? H.seconds.value : null)}
                    num={H.seconds ? H.seconds.value : null} format={fmtSecs}
                    extra={H.seconds && H.seconds.from != null ? <Change value={H.seconds.change} kind="relative" metric="seconds" evidence={H.seconds.evidence} small /> : null}
                    chart={<HeadSpark h={H.seconds} fmt={fmtSecs} />}
                    sub={<>{verdictSentence(H.seconds)}{lflNote(chatF.seconds, H.seconds)}</>} />
                <Tile label="Tool calls per task · web chat" value={n1(H.calls ? H.calls.value : null)}
                    num={H.calls ? H.calls.value : null} format={n1}
                    extra={H.calls && H.calls.from != null ? <Change value={H.calls.change} kind="relative" metric="calls" evidence={H.calls.evidence} small /> : null}
                    chart={<HeadSpark h={H.calls} fmt={n1} />}
                    sub={<>Median. {verdictSentence(H.calls)}{lflNote(chatF.calls, H.calls)}</>} />
                <Tile label="Failed tool calls · web chat" value={pct(H.failedShare ? H.failedShare.value : null, 1)}
                    num={H.failedShare ? H.failedShare.value : null} format={(v) => pct(v, 1)}
                    extra={H.failedShare && H.failedShare.from != null ? <Change value={H.failedShare.change} kind="points" metric="failedShare" evidence={H.failedShare.evidence} small /> : null}
                    chart={<HeadSpark h={H.failedShare} fmt={(v) => pct(v, 1)} />}
                    sub={<>{verdictSentence(H.failedShare)} {pct(data.logged && data.logged.roughRate, 1)} of all tasks had repeated failures.</>} />
                <Tile label="Answers you corrected" value={pct(corrRate, 0)} num={corrRate} format={(v) => pct(v, 0)}
                    sub={corrTracked.length ? `${corrTracked.filter((t) => t.cor).length} of ${corrTracked.length} tracked tasks` : 'tracked from today on: a "that\'s wrong / I said…" reply counts against the answer'} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label={range === 'all' ? 'Tasks learned from' : 'Tasks in range'} value={L.tasks || 0} num={L.tasks || 0} format={(v) => String(Math.round(v))} lowerIsBetter={false}
                    sub={`across ${themes.length} theme${themes.length === 1 ? '' : 's'}${data.since ? ` since ${shortDate(data.since)}` : ''}`} />
                <Tile label="Memory recalled" value={pct(L.recallRate)} num={L.recallRate} format={(v) => pct(v)} lowerIsBetter={false} sub={`${L.recalled || 0} tasks started from a theme memory`} />
                <Tile label="Playbook followed" value={pct(L.followRate)} num={L.followRate} format={(v) => pct(v)} lowerIsBetter={false} sub={`${L.followed || 0} of ${L.recalled || 0} recalled tasks used the proven approach`} />
                <Tile label={range === 'all' ? 'Memory updates' : 'Memory updates in range'} value={L.refinements || 0} num={L.refinements || 0} format={(v) => String(Math.round(v))} lowerIsBetter={false} sub={`${L.proven || 0} proven approaches · ${L.lessons || 0} lessons · ${L.avoid || 0} pitfalls`} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <ActivityFeed items={feedItems} labelOf={labelOf} now={now} live={live} />
                <SelfCorrection data={data} now={now} />
            </div>

            {/* What is changing */}
            <Card
                title="What's improving — and what isn't"
                hint={`Within ${RANGE_TEXT[range]}, per theme. "Lately" compares the newest tasks with the ones just before them, so a new change shows up within a few tasks; "Since the start" compares the earliest third with the latest third (${F.minTasks || 10}+ tasks). Time is split into waiting on tools and model time, so a slow site or a bigger job is not read as a worse playbook. Dots show how likely a change is real rather than chance.`}
                right={(
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: MUTED }}>
                        <input type="checkbox" checked={showWeak} onChange={(e) => setShowWeak(e.target.checked)} />
                        show changes that could be chance{hiddenWeak > 0 && !showWeak ? ` (${hiddenWeak})` : ''}
                    </label>
                )}
            >
                <div className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {(() => {
                        const lw = (F.lately || []).filter((f) => f.direction === 'worse' && f.evidence !== 'weak').length;
                        const lb = (F.lately || []).filter((f) => f.direction === 'better' && f.evidence !== 'weak').length;
                        const active = ((data.selfCorrect && data.selfCorrect.actions) || []).filter((a) => a.status === 'active').length;
                        if (!solidBetter && !solidWorse && !lw && !lb) return <>No change with real evidence yet — {F.total || 0} measure{F.total === 1 ? '' : 's'} checked, {F.steady || 0} steady.</>;
                        return <>Lately: {lb} improving, {lw} getting worse. Since the start: {solidBetter} improving, {solidWorse} getting worse{active ? ` · ${active} correction${active === 1 ? '' : 's'} being measured` : ''}.</>;
                    })()}
                </div>
                <ChangeBoard F={F} coverage={data.coverage} SC={data.selfCorrect || {}} labelOf={labelOf} showWeak={showWeak} />
            </Card>

            <ToolUsageCard U={data.toolUsage} />

            {/* Trends by week */}
            <Card title={`${wm.label}, by ${data.bucket || 'week'}`} hint={wm.hint} right={scopeSelect}>
                <div className="mb-3">
                    <Segmented options={WEEKLY_METRICS.map((m) => [m.key, m.label])} value={weeklyMetric} onChange={setWeeklyMetric} />
                </div>
                <WeeklyChart data={scoped.weekly} metric={wm} unit={data.bucket || 'week'} />
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
                hint={U ? `For every new proven approach or playbook rewrite: the theme's last ${U.window} tasks before it against its first ${U.window} after (updates with no task between them share a row). Neighbouring windows overlap — read the totals, not one row. With 5 tasks a side a single row is rarely more than chance, so most rows stay grey.` : ''}>
                {U && U.updates ? (
                    <>
                        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: RULE }}>
                                <div className="text-xs" style={{ color: MUTED }}>Response time after an update</div>
                                <div className="mt-0.5"><b>{U.fasterAfter}</b> faster · <b>{U.slowerAfter}</b> slower of {U.updates} <span className="ml-2 text-xs" style={{ color: MUTED }}>typical update:</span> <Change value={U.medianSecondsChange} metric="seconds" small /></div>
                            </div>
                            <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: RULE }}>
                                <div className="text-xs" style={{ color: MUTED }}>Tool calls after an update</div>
                                <div className="mt-0.5"><b>{U.leanerAfter}</b> leaner · <b>{U.heavierAfter}</b> heavier of {U.updates} <span className="ml-2 text-xs" style={{ color: MUTED }}>typical update:</span> <Change value={U.medianCallsChange} metric="calls" small /></div>
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
                                            <td className="py-1.5 pr-3">{e.seconds ? <Change value={e.seconds.change} metric="seconds" evidence={e.seconds.evidence} small /> : null}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{e.callsChange ? `${n1(e.callsChange.from)} → ${n1(e.callsChange.to)}` : '—'}</td>
                                            <td className="py-1.5">{e.callsChange ? <Change value={e.callsChange.change} metric="calls" evidence={e.callsChange.evidence} small /> : null}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                ) : <Empty>Needs 3+ tasks before and after an update.</Empty>}
            </Card>

            {/* Per theme */}
            <Card title="By theme" hint="Trends compare a theme's earliest and latest third of tasks in the range (median). Green or red only when the difference is probably real; grey with a ? could be chance. The line is the rolling median of the same tasks. Follow rate = recalled tasks that used the proven approach.">
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
                                <th className="py-1.5 pr-3 font-semibold">Time over the range</th>
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
                                        {t.secondsTrend ? <Change value={t.secondsTrend.change} metric="seconds" evidence={t.secondsTrend.evidence} small /> : <span className="text-xs" style={{ color: MUTED }}>too few</span>}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{n1(t.lifetimeAvgCalls)}</td>
                                    <td className="py-2 pr-3" title={t.callsTrend ? `median ${n1(t.callsTrend.from)} → ${n1(t.callsTrend.to)} calls (${t.callsTrend.nFrom} vs ${t.callsTrend.nTo} tasks, ${EVIDENCE[t.callsTrend.evidence].label})` : ''}>
                                        {t.callsTrend ? <Change value={t.callsTrend.change} metric="calls" evidence={t.callsTrend.evidence} small /> : <span className="text-xs" style={{ color: MUTED }}>too few</span>}
                                    </td>
                                    <td className="py-2 pr-3"><Spark values={(t.seriesSeconds || []).map((p) => p.y)} label="response time" /></td>
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
