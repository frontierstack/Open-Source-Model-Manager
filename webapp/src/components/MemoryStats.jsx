import React from 'react';
import {
    Loader2 as SpinnerIcon,
    TrendingDown as DownIcon,
    TrendingUp as UpIcon,
    Minus as FlatIcon,
    Award as BestIcon,
    PenLine as RefineIcon,
} from 'lucide-react';

// Memory tab → Stats. How well each theme's core memory is doing: how often it
// is recalled and followed, whether tasks take fewer tool calls over time, what
// a recalled memory saves against a cold start, and the moments the memory got
// better (new proven approach, playbook rewrite). Data: GET /api/memories/stats.

const GOOD = '#10b981';
const BAD = '#ef4444';

function pct(x, d = 0) { return x == null ? '—' : `${(x * 100).toFixed(d)}%`; }
function n1(x) { return x == null ? '—' : (Math.round(x * 10) / 10).toString(); }
function shortDate(iso) {
    if (!iso) return '';
    // A bare week key (YYYY-MM-DD) is a UTC date; read it as one, or west of
    // UTC every week label shows the day before.
    const bare = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    const d = new Date(bare ? `${iso}T00:00:00Z` : iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(bare ? { timeZone: 'UTC' } : {}) });
}
function fmtSecs(s) {
    if (s == null) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// Fewer calls is better, so a negative change is an improvement. The direction
// is carried by an icon and a sign, never by colour alone.
function Change({ value, invert = false, small = false }) {
    if (value == null) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    const good = invert ? value > 0.05 : value < -0.05;
    const bad = invert ? value < -0.05 : value > 0.05;
    const Icon = value < -0.05 ? DownIcon : value > 0.05 ? UpIcon : FlatIcon;
    const color = good ? GOOD : bad ? BAD : 'var(--text-tertiary)';
    return (
        <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${small ? 'text-xs' : ''}`} style={{ color }}>
            <Icon size={small ? 12 : 14} strokeWidth={2} />
            {value > 0 ? '+' : ''}{(value * 100).toFixed(0)}%
        </span>
    );
}

function Tile({ label, value, sub, extra }) {
    return (
        <div className="rounded-lg border px-3.5 py-3" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
            <div className="text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
            <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
                {extra}
            </div>
            {sub && <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-tertiary)' }}>{sub}</div>}
        </div>
    );
}

function Card({ title, hint, children, right }) {
    return (
        <div className="rounded-lg border p-3.5" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
            <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <div className="text-sm font-semibold">{title}</div>
                {right}
            </div>
            {hint && <div className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{hint}</div>}
            {children}
        </div>
    );
}

// Single-series weekly chart (bars or a line), one axis, hairline grid,
// hover tooltip per week.
function WeeklyChart({ data, field, kind = 'bar', format = n1, height = 150 }) {
    const [hover, setHover] = React.useState(null);
    const wrapRef = React.useRef(null);
    const [width, setWidth] = React.useState(420);
    React.useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const pts = data.filter((d) => d[field] != null);
    if (!pts.length) return <div className="py-8 text-center text-xs" style={{ color: 'var(--text-tertiary)' }}>Not enough data yet.</div>;

    const padL = 30, padR = 8, padT = 10, padB = 22;
    const w = width, h = height;
    const max = Math.max(...pts.map((d) => d[field]));
    const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
    const top = Math.max(step, Math.ceil(max / step) * step);
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const slot = plotW / data.length;
    const x = (i) => padL + slot * i + slot / 2;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const barW = Math.max(4, Math.min(28, slot * 0.6));
    const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));
    const linePts = data.map((d, i) => (d[field] == null ? null : [x(i), y(d[field])])).filter(Boolean);

    return (
        <div ref={wrapRef} className="relative" style={{ width: '100%' }}>
            <svg width={w} height={h} role="img" aria-label={`${field} by week`} style={{ display: 'block' }}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--border-primary)" strokeWidth={t === 0 ? 1 : 0.5} opacity={t === 0 ? 1 : 0.6} />
                        <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-tertiary)">{t}</text>
                    </g>
                ))}
                {kind === 'bar' && data.map((d, i) => {
                    const v = d[field];
                    if (v == null) return null;
                    const bh = Math.max(1, y(0) - y(v));
                    const r = Math.min(4, barW / 2, bh);
                    const x0 = x(i) - barW / 2, y0 = y(v);
                    const path = `M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + barW - r} Q${x0 + barW},${y0} ${x0 + barW},${y0 + r} V${y(0)} Z`;
                    return <path key={d.week} d={path} fill="var(--accent-primary)" opacity={hover == null || hover === i ? 1 : 0.55} />;
                })}
                {kind === 'line' && linePts.length > 1 && (
                    <polyline points={linePts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--accent-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                )}
                {kind === 'line' && data.map((d, i) => (d[field] == null ? null : (
                    <circle key={d.week} cx={x(i)} cy={y(d[field])} r={hover === i ? 5 : 4} fill="var(--accent-primary)" stroke="var(--bg-secondary)" strokeWidth="2" />
                )))}
                {hover != null && kind === 'line' && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke="var(--text-tertiary)" strokeWidth="1" strokeDasharray="3 3" />}
                {data.map((d, i) => (i % labelEvery === 0 ? (
                    <text key={`l${d.week}`} x={x(i)} y={h - 6} textAnchor="middle" fontSize="10" fill="var(--text-tertiary)">{shortDate(d.week)}</text>
                ) : null))}
                {data.map((d, i) => (
                    <rect key={`h${d.week}`} x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onTouchStart={() => setHover(i)} />
                ))}
            </svg>
            {hover != null && data[hover] && (
                <div className="pointer-events-none absolute z-10 rounded-md border px-2.5 py-1.5 text-xs shadow-lg"
                    style={{
                        left: Math.min(Math.max(0, x(hover) - 70), w - 150), top: 0, width: 150,
                        backgroundColor: 'var(--bg-elevated, var(--bg-secondary))', borderColor: 'var(--border-primary)', color: 'var(--text-primary)',
                    }}>
                    <div className="font-semibold">Week of {shortDate(data[hover].week)}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{data[hover].tasks} task{data[hover].tasks === 1 ? '' : 's'}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{n1(data[hover].avgCalls)} calls per task</div>
                    {data[hover].recallRate != null && <div style={{ color: 'var(--text-secondary)' }}>memory recalled on {pct(data[hover].recallRate)}</div>}
                </div>
            )}
        </div>
    );
}

function Spark({ values, width = 84, height = 22 }) {
    if (!values || values.length < 2) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    const max = Math.max(1, ...values);
    const step = width / (values.length - 1);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(' ');
    return (
        <svg width={width} height={height} aria-label={`last ${values.length} tasks: ${values.join(', ')} calls`} style={{ display: 'block' }}>
            <polyline points={pts} fill="none" stroke="var(--accent-primary)" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
    );
}

// With vs without recalled memory: two thin horizontal bars per measure.
function CompareBars({ effect }) {
    const rows = [
        { key: 'avgCalls', label: 'Calls per task', fmt: n1 },
        { key: 'medianSeconds', label: 'Median time', fmt: fmtSecs },
        { key: 'failedCallRate', label: 'Failed calls', fmt: (v) => pct(v, 1) },
    ];
    return (
        <div className="space-y-3">
            {rows.map((r) => {
                const a = effect.with[r.key], b = effect.without[r.key];
                const max = Math.max(a || 0, b || 0) || 1;
                return (
                    <div key={r.key}>
                        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{r.label}</div>
                        {[['With memory', a, 'var(--accent-primary)'], ['Without', b, 'var(--text-tertiary)']].map(([name, v, color]) => (
                            <div key={name} className="mb-1 flex items-center gap-2 text-xs">
                                <span className="w-24 shrink-0" style={{ color: 'var(--text-tertiary)' }}>{name}</span>
                                <span className="h-2.5 flex-1 overflow-hidden rounded-sm" style={{ backgroundColor: 'var(--bg-hover)' }}>
                                    <span className="block h-full rounded-sm" style={{ width: `${v == null ? 0 : Math.max(2, (v / max) * 100)}%`, backgroundColor: color }} />
                                </span>
                                <span className="w-14 shrink-0 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{r.fmt(v)}</span>
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

const MIN_COMPARE = 3;

export default function MemoryStats({ userId = null }) {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [chart, setChart] = React.useState('calls');

    const load = React.useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const res = await fetch(`/api/memories/stats${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`, { credentials: 'same-origin' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
            setData(body);
        } catch (e) { setError(e.message); } finally { setLoading(false); }
    }, [userId]);
    React.useEffect(() => { load(); }, [load]);

    if (loading && !data) {
        return <div className="flex items-center gap-2 p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}><SpinnerIcon size={16} className="animate-spin" /> Loading stats…</div>;
    }
    if (error) return <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#ef444455', color: '#ef4444' }}>{error}</div>;
    if (!data) return null;

    const L = data.lifetime || {};
    const eff = data.memoryEffect;
    const effReady = eff && eff.with.tasks >= MIN_COMPARE && eff.without.tasks >= MIN_COMPARE;
    const themes = (data.themes || []).filter((t) => t.lifetimeTasks > 0);

    return (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6 pr-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile
                    label="Tasks learned from"
                    value={L.tasks || 0}
                    sub={`across ${themes.length} theme${themes.length === 1 ? '' : 's'}${data.since ? ` since ${shortDate(data.since)}` : ''}`}
                />
                <Tile
                    label="Memory recalled"
                    value={pct(L.recallRate)}
                    sub={`${L.recalled || 0} tasks started from a theme memory`}
                />
                <Tile
                    label="Playbook followed"
                    value={pct(L.followRate)}
                    sub={`${L.followed || 0} of ${L.recalled || 0} recalled tasks used the proven approach`}
                />
                <Tile
                    label="Calls per task trend"
                    value={data.adjustedChange == null ? '—' : <Change value={data.adjustedChange} />}
                    sub={data.trendThemes
                        ? `earliest vs latest third of each theme's tasks · ${data.improvedThemes} theme${data.improvedThemes === 1 ? '' : 's'} leaner, ${data.worseThemes} heavier`
                        : 'needs 6+ tasks in a theme'}
                />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile label="Avg calls per task" value={n1(L.avgCalls)} sub={`median ${n1(data.logged?.medianCalls)} over the tracked tasks`} />
                <Tile label="Failed calls" value={pct(data.logged?.failedCallRate, 1)} sub={`${pct(data.logged?.roughRate, 1)} of tasks needed the loop guard or failed a lot`} />
                <Tile label="Playbook rewrites" value={L.refinements || 0} sub={`${L.proven || 0} proven approaches kept`} />
                <Tile label="Knowledge kept" value={`${L.lessons || 0} lessons`} sub={`${L.avoid || 0} known pitfalls to avoid`} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.4fr_1fr]">
                <Card
                    title={chart === 'calls' ? 'Tool calls per task, by week' : 'Tasks per week'}
                    hint={chart === 'calls' ? 'Fewer calls for the same kind of work means the memory is steering the model to a shorter path.' : 'How much work flowed into core memory.'}
                    right={(
                        <div className="inline-flex overflow-hidden rounded-md border text-xs" style={{ borderColor: 'var(--border-primary)' }}>
                            {[['calls', 'Calls'], ['tasks', 'Tasks']].map(([k, l]) => (
                                <button key={k} type="button" onClick={() => setChart(k)} className="px-2.5 py-1"
                                    style={chart === k ? { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' } : { color: 'var(--text-tertiary)' }}>{l}</button>
                            ))}
                        </div>
                    )}
                >
                    <WeeklyChart data={data.weekly || []} field={chart === 'calls' ? 'avgCalls' : 'tasks'} kind={chart === 'calls' ? 'line' : 'bar'} />
                </Card>

                <Card title="With memory vs without" hint="Tasks where the theme's memory was recalled, against tasks that started cold.">
                    {effReady ? (
                        <>
                            <CompareBars effect={eff} />
                            <div className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {eff.callsSaved > 0
                                    ? <>Recalled memory saves <b>{n1(eff.callsSaved)}</b> calls per task on average ({eff.with.tasks} vs {eff.without.tasks} tasks).</>
                                    : <>No saving yet: {eff.with.tasks} tasks with memory vs {eff.without.tasks} without.</>}
                            </div>
                        </>
                    ) : (
                        <div className="py-4 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                            Collecting. Whether memory was recalled is recorded from {data.trackedSince ? shortDate(data.trackedSince) : 'now'} on;
                            older tasks did not record it. The comparison appears once there are {MIN_COMPARE}+ tasks on each side
                            ({eff ? `${eff.with.tasks} with, ${eff.without.tasks} without so far` : 'none yet'}).
                        </div>
                    )}
                </Card>
            </div>

            <Card title="By theme" hint="Trend compares the earliest and latest third of a theme's tasks (needs 6+). Follow rate = recalled tasks that used the proven approach.">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm" style={{ minWidth: 760 }}>
                        <thead>
                            <tr className="text-left text-[0.68rem] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                <th className="py-1.5 pr-3 font-semibold">Theme</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Tasks</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Avg calls</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Best</th>
                                <th className="py-1.5 pr-3 font-semibold">Trend</th>
                                <th className="py-1.5 pr-3 font-semibold">Last 30 tasks</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Recalled</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Followed</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Playbook</th>
                                <th className="py-1.5 text-right font-semibold">Lessons</th>
                            </tr>
                        </thead>
                        <tbody>
                            {themes.map((t) => (
                                <tr key={t.theme} className="border-t" style={{ borderColor: 'var(--border-primary)' }}>
                                    <td className="py-2 pr-3 font-medium">{t.label}{!t.enabled && <span className="ml-1.5 text-xs" style={{ color: '#f59e0b' }}>paused</span>}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{t.lifetimeTasks}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{n1(t.lifetimeAvgCalls)}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{t.bestCalls ?? '—'}</td>
                                    <td className="py-2 pr-3" title={t.trend ? `${n1(t.trend.early.avgCalls)} → ${n1(t.trend.recent.avgCalls)} calls (${t.trend.window} tasks each)` : ''}>
                                        {t.trend ? (
                                            <span className="inline-flex items-center gap-2">
                                                <Change value={t.trend.callsChange} small />
                                                <span className="text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{n1(t.trend.early.avgCalls)} → {n1(t.trend.recent.avgCalls)}</span>
                                            </span>
                                        ) : <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>too few</span>}
                                    </td>
                                    <td className="py-2 pr-3"><Spark values={t.spark} /></td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{t.recalled}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{pct(t.followRate)}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">v{t.playbookVersion}</td>
                                    <td className="py-2 text-right tabular-nums">{t.lessons}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>

            <Card title="Improvements" hint="When a theme found a shorter proven approach or its playbook was rewritten from new evidence.">
                {(data.events || []).length ? (
                    <ul className="divide-y" style={{ borderColor: 'var(--border-primary)' }}>
                        {data.events.map((e, i) => (
                            <li key={i} className="flex items-center gap-2.5 py-1.5 text-sm" style={{ borderColor: 'var(--border-primary)' }}>
                                {e.kind === 'best'
                                    ? <BestIcon size={15} style={{ color: GOOD, flexShrink: 0 }} />
                                    : <RefineIcon size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />}
                                <span className="min-w-0 flex-1">
                                    <b className="font-medium">{e.label}</b>
                                    <span style={{ color: 'var(--text-secondary)' }}>
                                        {e.kind === 'best'
                                            ? (e.from != null ? ` — new proven approach: ${e.from} → ${e.calls} call${e.calls === 1 ? '' : 's'}` : ` — proven approach: ${e.calls} call${e.calls === 1 ? '' : 's'}`)
                                            : ` — playbook rewritten (v${e.v}${e.runs ? `, after ${e.runs} tasks` : ''})`}
                                    </span>
                                </span>
                                <span className="shrink-0 text-xs" style={{ color: 'var(--text-tertiary)' }}>{shortDate(e.t)}</span>
                            </li>
                        ))}
                    </ul>
                ) : <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No changes recorded yet.</div>}
            </Card>
        </div>
    );
}
