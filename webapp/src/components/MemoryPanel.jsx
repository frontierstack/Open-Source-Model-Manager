import React from 'react';
import {
    Brain as BrainIcon,
    Trash2 as DeleteIcon,
    Save as SaveIcon,
    RefreshCw as RefreshIcon,
    Loader2 as SpinnerIcon,
    Pause as PauseIcon,
    Play as PlayIcon,
    Plus as PlusIcon,
    History as HistoryIcon,
    FlaskConical as TestIcon,
} from 'lucide-react';

// Memory tab — CORE MEMORY: one living memory per THEME of work (research,
// coding, data analysis, documents, media, security analysis, automations).
// Every task the model completes flows into its theme's memory and refines
// it: statistics, the proven approach, lessons and pitfalls, and a playbook the
// model rewrites from the evidence over time. The tab shows each theme, lets
// the user add their own guidance per theme, pause or reset a theme, and
// preview what an ask would recall. No facts / preferences / limitations.

async function jsonFetch(url, opts) {
    const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body || {};
}

function relativeTime(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString();
}

function fmtSeconds(sec) {
    if (!Number.isFinite(sec)) return '';
    if (sec < 90) return `${Math.round(sec)} s`;
    return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function Chip({ children, tone = 'muted', title }) {
    const tones = {
        muted: { backgroundColor: 'var(--bg-hover)', color: 'var(--text-tertiary)' },
        accent: { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' },
        warn: { backgroundColor: '#f59e0b1a', color: '#f59e0b' },
        success: { backgroundColor: '#10b9811a', color: '#10b981' },
        danger: { backgroundColor: '#ef44441a', color: '#ef4444' },
        outline: { backgroundColor: 'transparent', color: 'var(--text-tertiary)', boxShadow: 'inset 0 0 0 1px var(--border-primary)' },
    };
    return (
        <span title={title} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.68rem] font-medium leading-none" style={tones[tone] || tones.muted}>
            {children}
        </span>
    );
}

const SOURCE_LABEL = { auto: 'observed', refined: 'refined', model: 'model', user: 'you' };
const SOURCE_TONE = { auto: 'muted', refined: 'outline', model: 'success', user: 'accent' };

function Section({ title, hint, children, right }) {
    return (
        <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <div className="text-[0.72rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{title}</div>
                {right}
            </div>
            {hint && <div className="mb-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{hint}</div>}
            {children}
        </div>
    );
}

function Stat({ label, value, sub }) {
    return (
        <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-primary)' }}>
            <div className="text-[0.66rem] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
            <div className="text-[0.95rem] font-semibold tabular-nums">{value}</div>
            {sub && <div className="text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>{sub}</div>}
        </div>
    );
}

function renderSteps(steps) {
    return (steps || []).map((s) => {
        const t = s.times > 1 ? `${s.tool}×${s.times}` : s.tool;
        return s.hint ? `${t}(${s.hint})` : t;
    }).join(' → ');
}

export default function MemoryPanel() {
    const [memories, setMemories] = React.useState([]);
    const [themes, setThemes] = React.useState([]);
    const [isAdmin, setIsAdmin] = React.useState(false);
    const [accountId, setAccountId] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(null);

    const [selectedKey, setSelectedKey] = React.useState(null); // `${userId}|${theme}`
    const [notes, setNotes] = React.useState('');
    const [savingNotes, setSavingNotes] = React.useState(false);
    const [newLesson, setNewLesson] = React.useState('');
    const [addingLesson, setAddingLesson] = React.useState(false);
    const [showHistory, setShowHistory] = React.useState(false);

    const [testText, setTestText] = React.useState('');
    const [testResult, setTestResult] = React.useState(null);
    const [testing, setTesting] = React.useState(false);

    const loadMemories = React.useCallback(async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        setError(null);
        try {
            const data = await jsonFetch('/api/memories');
            setMemories(data.memories || []);
            setThemes(data.themes || []);
            setIsAdmin(!!data.isAdmin);
            setAccountId(data.accountId || null);
        } catch (e) {
            if (!silent) setError(e.message);
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    React.useEffect(() => { loadMemories(); }, [loadMemories]);

    // Core memories change OUT OF BAND (at the end of chat turns, on background
    // refinement), so refresh silently on focus and on a gentle poll.
    React.useEffect(() => {
        const refresh = () => { if (document.visibilityState === 'visible') loadMemories({ silent: true }); };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        const id = setInterval(refresh, 15000);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
            clearInterval(id);
        };
    }, [loadMemories]);

    // Rows = every theme for the caller's own account (a theme with no memory
    // yet shows as "not started"), plus other accounts' memories for admins.
    const rows = React.useMemo(() => {
        const own = themes.map((t) => {
            const rec = memories.find((m) => m.theme === t.key && (!accountId || m.userId === accountId)) || null;
            return { key: `${accountId || 'me'}|${t.key}`, theme: t, rec, userId: accountId, ownerName: null };
        });
        const others = isAdmin
            ? memories.filter((m) => accountId && m.userId !== accountId).map((m) => ({
                key: `${m.userId}|${m.theme}`, theme: themes.find((t) => t.key === m.theme) || { key: m.theme, label: m.label, description: '' }, rec: m, userId: m.userId, ownerName: m.ownerName,
            }))
            : [];
        const rank = (r) => (r.rec ? (Date.parse(r.rec.stats?.lastRunAt || r.rec.updatedAt || '') || 0) : -1);
        own.sort((a, b) => rank(b) - rank(a));
        return [...own, ...others];
    }, [memories, themes, accountId, isAdmin]);

    const selected = rows.find((r) => r.key === selectedKey) || null;

    React.useEffect(() => {
        setNotes(selected?.rec?.notes || '');
        setNewLesson('');
        setShowHistory(false);
    }, [selectedKey, selected?.rec?.notes]); // eslint-disable-line react-hooks/exhaustive-deps

    const saveNotes = async () => {
        if (!selected) return;
        setSavingNotes(true);
        try {
            if (selected.rec) {
                await jsonFetch(`/api/memories/${selected.rec.id}`, { method: 'PATCH', body: JSON.stringify({ notes }) });
            } else {
                await jsonFetch('/api/memories', { method: 'POST', body: JSON.stringify({ theme: selected.theme.key, notes }) });
            }
            await loadMemories({ silent: true });
        } catch (e) { setError(e.message); } finally { setSavingNotes(false); }
    };

    const addLesson = async () => {
        if (!selected || !newLesson.trim()) return;
        setAddingLesson(true);
        try {
            if (!selected.rec) {
                const { memory } = await jsonFetch('/api/memories', { method: 'POST', body: JSON.stringify({ theme: selected.theme.key, notes: '' }) });
                await jsonFetch(`/api/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ lesson: newLesson.trim() }) });
            } else {
                await jsonFetch(`/api/memories/${selected.rec.id}`, { method: 'PATCH', body: JSON.stringify({ lesson: newLesson.trim() }) });
            }
            setNewLesson('');
            await loadMemories({ silent: true });
        } catch (e) { setError(e.message); } finally { setAddingLesson(false); }
    };

    const togglePaused = async () => {
        if (!selected?.rec) return;
        try {
            await jsonFetch(`/api/memories/${selected.rec.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: selected.rec.enabled === false }) });
            await loadMemories({ silent: true });
        } catch (e) { setError(e.message); }
    };

    const resetTheme = async () => {
        if (!selected?.rec) return;
        if (!window.confirm(`Reset the ${selected.theme.label} core memory? Its tasks, playbook, lessons and your guidance are removed. This cannot be undone.`)) return;
        try {
            await jsonFetch(`/api/memories/${selected.rec.id}`, { method: 'DELETE' });
            await loadMemories({ silent: true });
        } catch (e) { setError(e.message); }
    };

    const clearAll = async () => {
        if (!window.confirm('Clear ALL of your core memories? This cannot be undone.')) return;
        try {
            await jsonFetch('/api/memories', { method: 'DELETE' });
            setSelectedKey(null);
            await loadMemories();
        } catch (e) { setError(e.message); }
    };

    const runTest = async () => {
        if (!testText.trim()) return;
        setTesting(true); setTestResult(null);
        try {
            const r = await jsonFetch('/api/memories/recall', { method: 'POST', body: JSON.stringify({ text: testText.trim() }) });
            setTestResult(r);
        } catch (e) { setTestResult({ error: e.message }); } finally { setTesting(false); }
    };

    const ownCount = rows.filter((r) => !r.ownerName && r.rec).length;
    const rec = selected?.rec || null;
    const stats = rec?.stats || null;
    const notesDirty = (notes || '') !== (rec?.notes || '');

    return (
        <div className="flex flex-col" style={{ color: 'var(--text-primary)', height: 'calc(100vh - 140px)', minHeight: '460px' }}>
            {/* Header */}
            <div className="flex flex-col items-stretch gap-3 px-1 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                    <BrainIcon size={20} strokeWidth={1.75} style={{ color: 'var(--accent-primary)' }} />
                    <div>
                        <div className="text-base font-semibold tracking-tight">Core memory</div>
                        <div className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)', maxWidth: '68ch' }}>
                            One living memory per kind of work. Every task the model finishes flows into its theme
                            — research, coding, data analysis, documents… — and refines that memory: its playbook, the approach that
                            worked best, lessons and pitfalls. The next task of the same kind starts from it.
                            {isAdmin && ' Admin: other accounts’ core memories are listed below yours.'}
                        </div>
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                        type="button" onClick={() => loadMemories()} title="Refresh"
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition"
                        style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                    >
                        <RefreshIcon size={15} className={loading ? 'animate-spin' : ''} /> Refresh
                    </button>
                    {ownCount > 0 && (
                        <button
                            type="button" onClick={clearAll} title="Clear all of your core memories"
                            className="rounded-lg px-3 py-2 text-sm font-medium transition"
                            style={{ color: '#ef4444', border: '1px solid #ef444455' }}
                        >
                            Clear all
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="mb-3 rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#ef444455', backgroundColor: '#ef44441a', color: '#ef4444' }}>
                    {error}
                </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
                {/* Theme list */}
                <div className="flex min-h-0 flex-col rounded-lg border" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                        {loading ? (
                            <div className="flex items-center gap-2 p-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                                <SpinnerIcon size={16} className="animate-spin" /> Loading…
                            </div>
                        ) : rows.map((r) => {
                            const active = r.key === selectedKey;
                            const s = r.rec?.stats;
                            const paused = r.rec && r.rec.enabled === false;
                            return (
                                <button
                                    key={r.key}
                                    type="button"
                                    onClick={() => setSelectedKey(r.key)}
                                    className="mb-0.5 flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition"
                                    style={active ? { backgroundColor: 'var(--accent-muted)', boxShadow: 'inset 0 0 0 1px var(--border-focus)' } : {}}
                                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = ''; }}
                                >
                                    <span className="inline-block shrink-0 rounded-full" style={{ width: 8, height: 8, marginTop: 6, backgroundColor: !r.rec ? 'var(--border-primary)' : (paused ? '#f59e0b' : 'var(--accent-primary)') }} />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline gap-2">
                                            <div className="min-w-0 flex-1 truncate text-[0.84rem] font-medium" style={{ color: active ? 'var(--accent-primary)' : (r.rec ? 'var(--text-primary)' : 'var(--text-tertiary)') }}>
                                                {r.theme.label}
                                            </div>
                                            <span className="shrink-0 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>
                                                {s?.lastRunAt ? relativeTime(s.lastRunAt) : (r.rec ? relativeTime(r.rec.updatedAt) : '')}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 line-clamp-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                            {r.rec?.playbook || r.theme.description}
                                        </div>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                            {r.rec ? (
                                                <>
                                                    <Chip tone="accent">{`${s?.runs || 0} task${(s?.runs || 0) === 1 ? '' : 's'}`}</Chip>
                                                    {s?.bestCalls != null && <Chip>{`best ${s.bestCalls} call${s.bestCalls === 1 ? '' : 's'}`}</Chip>}
                                                    {r.rec.playbookVersion > 0 && <Chip tone="outline">{`playbook v${r.rec.playbookVersion}`}</Chip>}
                                                    {r.rec.notes && <Chip tone="outline">your guidance</Chip>}
                                                    {paused && <Chip tone="warn">paused</Chip>}
                                                </>
                                            ) : <Chip tone="outline">not started</Chip>}
                                            {r.ownerName ? <span className="text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>· {r.ownerName}</span> : null}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Recall test */}
                    <div className="border-t p-2.5" style={{ borderColor: 'var(--border-primary)' }}>
                        <div className="mb-1.5 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                            <TestIcon size={12} /> Which memory would an ask recall?
                        </div>
                        <div className="flex gap-1.5">
                            <input
                                value={testText}
                                onChange={(e) => setTestText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') runTest(); }}
                                placeholder="e.g. find the latest news on …"
                                className="min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                            <button type="button" onClick={runTest} disabled={testing || !testText.trim()} className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50" style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}>
                                {testing ? '…' : 'Test'}
                            </button>
                        </div>
                        {testResult && (
                            <div className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                {testResult.error ? <span style={{ color: '#ef4444' }}>{testResult.error}</span>
                                    : !testResult.theme ? 'No theme — nothing would be recalled for this ask.'
                                    : (
                                        <>
                                            <span>Theme: <b>{testResult.label}</b>. </span>
                                            {testResult.recalled
                                                ? <span>The {testResult.recalled.label} core memory would be recalled ({testResult.recalled.runs} task{testResult.recalled.runs === 1 ? '' : 's'}, ~{testResult.recalled.tokens} tokens).</span>
                                                : <span>That theme has no memory yet, so nothing would be injected.</span>}
                                        </>
                                    )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Detail */}
                <div className="min-h-0 overflow-y-auto rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    {!selected ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            <div>Select a theme to see its core memory.</div>
                            <div className="text-xs" style={{ maxWidth: '48ch', textAlign: 'center' }}>
                                A theme starts once the model completes a task of that kind. You can add guidance to a theme before that.
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-[1rem] font-semibold tracking-tight">{selected.theme.label}</div>
                                    <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                        {selected.theme.description}
                                        {selected.ownerName ? ` · ${selected.ownerName}` : ''}
                                    </div>
                                </div>
                                {rec && (
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <button type="button" onClick={togglePaused} title={rec.enabled === false ? 'Resume: recall this memory again' : 'Pause: keep it, but stop recalling it'} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-medium transition" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}>
                                            {rec.enabled === false ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
                                            {rec.enabled === false ? 'Resume' : 'Pause'}
                                        </button>
                                        <button type="button" onClick={resetTheme} title="Reset this core memory" className="rounded-lg p-2 transition" style={{ color: '#ef4444', border: '1px solid #ef444455' }}>
                                            <DeleteIcon size={16} />
                                        </button>
                                    </div>
                                )}
                            </div>

                            {stats && (
                                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    <Stat label="Tasks" value={stats.runs} sub={stats.runs ? `${stats.converged} converged${stats.failedRuns ? `, ${stats.failedRuns} not` : ''}` : 'none yet'} />
                                    <Stat label="Best run" value={stats.bestCalls != null ? `${stats.bestCalls} call${stats.bestCalls === 1 ? '' : 's'}` : '—'} sub={rec.bestApproach?.seconds != null ? fmtSeconds(rec.bestApproach.seconds) : ''} />
                                    <Stat label="Average" value={stats.runs ? `${(stats.totalCalls / stats.runs).toFixed(1)} calls` : '—'} sub={stats.runs && stats.totalSeconds ? `${fmtSeconds(stats.totalSeconds / stats.runs)} per task` : ''} />
                                    <Stat label="Recalled" value={stats.recalled} sub={stats.recalled ? `followed ${stats.followed}×` : 'not yet'} />
                                </div>
                            )}

                            <Section
                                title="Playbook"
                                hint={rec?.playbook
                                    ? `Version ${rec.playbookVersion}, rewritten by the model ${relativeTime(rec.playbookUpdatedAt)} from ${stats?.runs || 0} task${(stats?.runs || 0) === 1 ? '' : 's'}. It changes as more tasks land.`
                                    : (rec ? 'The model writes this after its first task of this kind; until then the proven approach and lessons below are what it recalls.' : 'Nothing yet — the playbook appears after the first task of this kind.')}
                                right={rec?.playbookHistory?.length ? (
                                    <button type="button" onClick={() => setShowHistory((v) => !v)} className="inline-flex items-center gap-1 text-[0.7rem]" style={{ color: 'var(--accent-primary)' }}>
                                        <HistoryIcon size={12} /> {showHistory ? 'Hide' : 'Show'} {rec.playbookHistory.length} earlier version{rec.playbookHistory.length === 1 ? '' : 's'}
                                    </button>
                                ) : null}
                            >
                                {rec?.playbook && (
                                    <div className="whitespace-pre-wrap rounded-md border px-3 py-2.5 text-sm leading-relaxed" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-primary)' }}>
                                        {rec.playbook}
                                    </div>
                                )}
                                {showHistory && rec?.playbookHistory?.slice().reverse().map((h) => (
                                    <div key={`${h.version}-${h.at}`} className="mt-2 rounded-md border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                                        <div className="mb-1 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>v{h.version} · after {h.runs} task{h.runs === 1 ? '' : 's'} · {relativeTime(h.at)}</div>
                                        {h.playbook}
                                    </div>
                                ))}
                            </Section>

                            {rec?.bestApproach?.steps?.length ? (
                                <Section title="Proven approach" hint={`The leanest run that converged: ${rec.bestApproach.calls} call${rec.bestApproach.calls === 1 ? '' : 's'}${rec.bestApproach.seconds != null ? `, ${fmtSeconds(rec.bestApproach.seconds)}` : ''} — “${rec.bestApproach.task}”`}>
                                    <div className="rounded-md border px-3 py-2 font-mono text-[0.74rem] leading-relaxed" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                                        {renderSteps(rec.bestApproach.steps)}
                                    </div>
                                </Section>
                            ) : null}

                            <Section title="Lessons" hint="What to do next time. Observed lessons come from failed→fixed steps; the model and you can add your own.">
                                {rec?.lessons?.length ? (
                                    <ul className="space-y-1">
                                        {rec.lessons.slice().reverse().map((l, i) => (
                                            <li key={`${l.at}-${i}`} className="flex items-start gap-2 text-sm leading-relaxed">
                                                <Chip tone={SOURCE_TONE[l.source] || 'muted'}>{SOURCE_LABEL[l.source] || 'observed'}</Chip>
                                                <span className="min-w-0 flex-1">{l.text}{l.hits > 1 ? <span className="ml-1 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>×{l.hits}</span> : null}</span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No lessons yet.</div>}
                                <div className="mt-2 flex gap-1.5">
                                    <input
                                        value={newLesson}
                                        onChange={(e) => setNewLesson(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') addLesson(); }}
                                        placeholder="Add a lesson, e.g. “Check the primary source before summarising a news item.”"
                                        className="min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
                                        style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                                    />
                                    <button type="button" onClick={addLesson} disabled={addingLesson || !newLesson.trim()} className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}>
                                        <PlusIcon size={14} /> Add
                                    </button>
                                </div>
                            </Section>

                            {rec?.avoid?.length ? (
                                <Section title="Avoid" hint="Already tried, did not work.">
                                    <ul className="space-y-1">
                                        {rec.avoid.slice().reverse().map((a, i) => (
                                            <li key={`${a.at}-${i}`} className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>• {a.text}{a.count > 1 ? <span className="ml-1 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>×{a.count}</span> : null}</li>
                                        ))}
                                    </ul>
                                </Section>
                            ) : null}

                            <Section title="Your guidance" hint="Standing guidance for how this kind of work should be done for you. Recalled with this theme on every task of this kind.">
                                <textarea
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    rows={3}
                                    placeholder={`e.g. “Prefer primary sources and cite them; give me a short summary first, details after.”`}
                                    className="w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed outline-none"
                                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                                />
                                <div className="mt-2 flex items-center">
                                    <button
                                        type="button" disabled={savingNotes || !notesDirty} onClick={saveNotes}
                                        className="ml-auto inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                                    >
                                        {savingNotes ? <SpinnerIcon size={15} className="animate-spin" /> : <SaveIcon size={15} />}
                                        {savingNotes ? 'Saving…' : 'Save guidance'}
                                    </button>
                                </div>
                            </Section>

                            {rec?.episodes?.length ? (
                                <Section title="Recent tasks" hint="The most recent tasks that fed this memory.">
                                    <ul className="space-y-1.5">
                                        {rec.episodes.slice().reverse().map((e, i) => (
                                            <li key={`${e.at}-${i}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-primary)' }}>
                                                <div className="flex items-baseline gap-2">
                                                    <div className="min-w-0 flex-1 truncate text-sm" title={e.task}>{e.task}</div>
                                                    <span className="shrink-0 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(e.at)}</span>
                                                </div>
                                                <div className="mt-1 flex flex-wrap items-center gap-1">
                                                    <Chip>{`${e.calls} call${e.calls === 1 ? '' : 's'}`}</Chip>
                                                    {e.seconds != null && <Chip>{fmtSeconds(e.seconds)}</Chip>}
                                                    {e.failed ? <Chip tone="warn">{`${e.failed} failed`}</Chip> : null}
                                                    {e.converged === false && <Chip tone="danger">did not converge</Chip>}
                                                    {e.provisional && <Chip tone="outline">in progress</Chip>}
                                                </div>
                                                {e.approach && <div className="mt-1 font-mono text-[0.7rem] leading-relaxed" style={{ color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>{e.approach}</div>}
                                            </li>
                                        ))}
                                    </ul>
                                </Section>
                            ) : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
