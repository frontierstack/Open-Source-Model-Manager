import React from 'react';
import {
    Brain as BrainIcon,
    Plus as PlusIcon,
    Trash2 as DeleteIcon,
    Save as SaveIcon,
    RefreshCw as RefreshIcon,
    Loader2 as SpinnerIcon,
    Pin as PinIcon,
    EyeOff as MuteIcon,
} from 'lucide-react';

// Memory tab — account-scoped persona/fact memory that follows the user across
// every conversation. Self-contained data fetching (global fetch is CSRF-tagged
// + cookie-authed via csrfFetch.js). Admins receive every user's memories and
// see an owner badge.


// source → {label, dot}. auto = heuristic extraction, manual = user-authored,
// model = recorded by the assistant via record_learning. A small colored dot
// (not an icon) keeps each row clean and uncluttered.
const SOURCE_META = {
    auto: { label: 'auto', dot: 'var(--text-tertiary)' },
    manual: { label: 'you', dot: 'var(--accent-primary)' },
    model: { label: 'learned', dot: '#10b981' },
};

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

// Impact → chip tone, so importance is visible at every level (not just
// "important"): low is quiet, medium is accented, important stands out.
const IMPACT_TONE = { important: 'warn', medium: 'accent', low: 'muted' };

// One consistent chip — single font size + weight everywhere so the meta rows
// read cleanly instead of mixing sizes.
function Chip({ children, tone = 'muted', title }) {
    const tones = {
        muted: { backgroundColor: 'var(--bg-hover)', color: 'var(--text-tertiary)' },
        accent: { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' },
        warn: { backgroundColor: '#f59e0b1a', color: '#f59e0b' },
        success: { backgroundColor: '#10b9811a', color: '#10b981' },
        outline: { backgroundColor: 'transparent', color: 'var(--text-tertiary)', boxShadow: 'inset 0 0 0 1px var(--border-primary)' },
    };
    return (
        <span
            title={title}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.68rem] font-medium leading-none"
            style={tones[tone] || tones.muted}
        >
            {children}
        </span>
    );
}

function SourceDot({ source }) {
    const sm = SOURCE_META[source] || SOURCE_META.auto;
    return <span className="inline-block shrink-0 rounded-full" style={{ width: 7, height: 7, marginTop: 6, backgroundColor: sm.dot }} title={sm.label} />;
}

export default function MemoryPanel() {
    const [memories, setMemories] = React.useState([]);
    const [isAdmin, setIsAdmin] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(null);

    const [selectedId, setSelectedId] = React.useState(null);
    const [editText, setEditText] = React.useState('');
    const [savingEdit, setSavingEdit] = React.useState(false);

    const [showCreate, setShowCreate] = React.useState(false);
    const [newText, setNewText] = React.useState('');
    const [newPinned, setNewPinned] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    const resetCreate = () => {
        setNewText(''); setNewPinned(false);
    };

    const [filter, setFilter] = React.useState('');

    // `silent` refetches in the background without flashing the loading spinner
    // or clearing the list — used by the auto-refresh so the view doesn't flicker
    // every poll.
    const loadMemories = React.useCallback(async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        setError(null);
        try {
            const data = await jsonFetch('/api/memories');
            setMemories(data.memories || []);
            setIsAdmin(!!data.isAdmin);
        } catch (e) {
            if (!silent) setError(e.message);
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    React.useEffect(() => { loadMemories(); }, [loadMemories]);

    // Auto-refresh: memories are created OUT OF BAND (during a chat turn, by the
    // model's record_learning, by background extraction), so a mount-only load
    // makes the tab look empty/stale — the user creates a memory in chat and it
    // never appears here. Silently refetch when the tab/window regains focus and
    // on a gentle poll while visible. Selection + in-progress edits are keyed on
    // selectedId, which a refetch never changes, so editing is undisturbed.
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

    const selected = memories.find((m) => m.id === selectedId) || null;

    // Sync the edit form whenever the selection changes.
    React.useEffect(() => {
        if (selected) setEditText(selected.text || '');
    }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

    const createMemory = async () => {
        if (!newText.trim()) return;
        setBusy(true);
        try {
            const { memory } = await jsonFetch('/api/memories', {
                method: 'POST',
                body: JSON.stringify({ text: newText.trim() }),
            });
            // Apply the pin flag to the freshly created memory.
            if (newPinned) {
                try { await jsonFetch(`/api/memories/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) }); } catch (_) { /* non-fatal */ }
            }
            setShowCreate(false); resetCreate();
            await loadMemories();
            setSelectedId(memory.id);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };

    const saveEdit = async () => {
        if (!selected || !editText.trim()) return;
        setSavingEdit(true);
        try {
            await jsonFetch(`/api/memories/${selected.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ text: editText.trim() }),
            });
            await loadMemories();
        } catch (e) { setError(e.message); } finally { setSavingEdit(false); }
    };

    const deleteMemory = async (id) => {
        if (!window.confirm('Delete this memory? This cannot be undone.')) return;
        try {
            await jsonFetch(`/api/memories/${id}`, { method: 'DELETE' });
            if (selectedId === id) setSelectedId(null);
            await loadMemories();
        } catch (e) { setError(e.message); }
    };

    // Pin = never pruned out of the store; Mute = kept but never injected
    // into a chat turn. Toggles PATCH the flag directly (no edit-form state).
    const toggleFlag = async (mem, flag) => {
        try {
            await jsonFetch(`/api/memories/${mem.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ [flag]: !mem[flag] }),
            });
            await loadMemories({ silent: true });
        } catch (e) { setError(e.message); }
    };

    const clearAll = async () => {
        if (!window.confirm('Delete ALL of your memories? This cannot be undone.')) return;
        try {
            await jsonFetch('/api/memories', { method: 'DELETE' });
            setSelectedId(null);
            await loadMemories();
        } catch (e) { setError(e.message); }
    };

    const visible = filter.trim()
        ? memories.filter((m) => (m.text || '').toLowerCase().includes(filter.trim().toLowerCase()))
        : memories;

    const dirty = selected && editText.trim() !== (selected.text || '');

    return (
        <div className="flex flex-col" style={{ color: 'var(--text-primary)', height: 'calc(100vh - 140px)', minHeight: '460px' }}>
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-1 pb-4">
                <div className="flex items-center gap-2.5">
                    <BrainIcon size={20} strokeWidth={1.75} style={{ color: 'var(--accent-primary)' }} />
                    <div>
                        <div className="text-base font-semibold tracking-tight">Memory</div>
                        <div className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)', maxWidth: '62ch' }}>
                            What the model remembers about you across every chat — preferences, facts, and lessons it
                            learns so it avoids past mistakes and works faster. The most relevant are pulled into each reply.
                            {isAdmin && ' Admin: showing every user\'s memories.'}
                        </div>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button" onClick={() => loadMemories()} title="Refresh memories"
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition"
                        style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                    >
                        <RefreshIcon size={15} className={loading ? 'animate-spin' : ''} /> Refresh
                    </button>
                    {memories.length > 0 && (
                        <button
                            type="button" onClick={clearAll} title="Delete all memories"
                            className="rounded-lg px-3 py-2 text-sm font-medium transition"
                            style={{ color: '#ef4444', border: '1px solid #ef444455' }}
                        >
                            Clear all
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => { if (showCreate) { setShowCreate(false); resetCreate(); } else { setShowCreate(true); } }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition"
                        style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                    >
                        <PlusIcon size={16} /> New memory
                    </button>
                </div>
            </div>

            {showCreate && (
                <div className="mb-4 rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="mb-2 text-sm font-semibold tracking-tight">New memory</div>
                    <textarea
                        autoFocus
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        placeholder="Something the model should always remember (e.g. 'Prefers concise answers with code first, no preamble', or a lesson: 'When parsing GGUF, check the header magic first — saves a failed load')."
                        rows={3}
                        className="w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed outline-none"
                        style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                    />

                    {/* Field row: pin */}
                    <div className="mt-3 flex flex-wrap items-end gap-4">
                        <button
                            type="button"
                            onClick={() => setNewPinned((v) => !v)}
                            title="Pin — never auto-pruned from the store"
                            className="inline-flex h-[34px] items-center gap-1.5 rounded-md px-3 text-sm font-medium transition"
                            style={newPinned
                                ? { color: 'var(--accent-primary)', border: '1px solid var(--border-focus)', backgroundColor: 'var(--accent-muted)' }
                                : { color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                        >
                            <PinIcon size={14} /> {newPinned ? 'Pinned' : 'Pin'}
                        </button>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                        <button
                            type="button" disabled={busy || !newText.trim()} onClick={createMemory}
                            className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                            style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                        >
                            {busy ? 'Saving…' : 'Add memory'}
                        </button>
                        <button
                            type="button" onClick={() => { setShowCreate(false); resetCreate(); }}
                            className="rounded-md px-4 py-2 text-sm font-medium"
                            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className="mb-3 rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#ef444455', backgroundColor: '#ef44441a', color: '#ef4444' }}>
                    {error}
                </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
                {/* Memory list */}
                <div className="flex min-h-0 flex-col rounded-lg border" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="border-b p-2" style={{ borderColor: 'var(--border-primary)' }}>
                        <input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder={`Filter ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}…`}
                            className="w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                        />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                        {loading ? (
                            <div className="flex items-center gap-2 p-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                                <SpinnerIcon size={16} className="animate-spin" /> Loading…
                            </div>
                        ) : visible.length === 0 ? (
                            <div className="p-4 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                                {memories.length === 0
                                    ? 'No memories yet. They build up as you chat — or add one by hand.'
                                    : 'No memories match that filter.'}
                            </div>
                        ) : (
                            visible.map((m) => {
                                const active = m.id === selectedId;
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => setSelectedId(m.id)}
                                        className="mb-0.5 flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition"
                                        style={active
                                            ? { backgroundColor: 'var(--accent-muted)', boxShadow: 'inset 0 0 0 1px var(--border-focus)' }
                                            : {}}
                                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = ''; }}
                                    >
                                        <SourceDot source={m.source} />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-baseline gap-2">
                                                <div className="min-w-0 flex-1 truncate text-[0.82rem] font-medium" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                                    {m.title || m.text}
                                                </div>
                                                <span className="shrink-0 text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>
                                                    {relativeTime(m.updatedAt || m.createdAt)}
                                                </span>
                                            </div>
                                            <div className="mt-0.5 line-clamp-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                                {m.text}
                                            </div>
                                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                                {m.type === 'procedure'
                                                    ? <Chip tone="accent">{`${m.activity || 'experience'} ·×${m.count || 1}${m.outcome && Number.isFinite(m.outcome.calls) ? ` · best ${m.outcome.calls} call${m.outcome.calls === 1 ? '' : 's'}` : ''}`}</Chip>
                                                    : (m.type && <Chip>{m.type}</Chip>)}
                                                {m.impact && <Chip tone={IMPACT_TONE[m.impact] || 'muted'}>{m.impact}</Chip>}
                                                {m.pinned && <Chip tone="accent"><PinIcon size={10} /> pinned</Chip>}
                                                {m.muted && <Chip>muted</Chip>}
                                                {isAdmin && m.ownerName ? <span className="text-[0.66rem]" style={{ color: 'var(--text-tertiary)' }}>· {m.ownerName}</span> : null}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Detail / edit */}
                <div className="min-h-0 overflow-y-auto rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    {!selected ? (
                        <div className="flex h-full flex-col items-center justify-center gap-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            <div>Select a memory to view or edit it.</div>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="truncate text-[0.95rem] font-semibold tracking-tight" title={selected.title || ''}>{selected.title || 'Edit memory'}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.68rem]" style={{ color: 'var(--text-tertiary)' }}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <span className="inline-block rounded-full" style={{ width: 7, height: 7, backgroundColor: (SOURCE_META[selected.source] || SOURCE_META.auto).dot }} />
                                            {(SOURCE_META[selected.source] || SOURCE_META.auto).label}
                                        </span>
                                        <span>· added {relativeTime(selected.createdAt)}</span>
                                        {selected.updatedAt !== selected.createdAt && <span>· edited {relativeTime(selected.updatedAt)}</span>}
                                        {isAdmin && selected.ownerName ? <span>· {selected.ownerName}</span> : null}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => toggleFlag(selected, 'pinned')}
                                        title={selected.pinned ? 'Unpin (allow pruning again)' : 'Pin — never auto-pruned'}
                                        className="rounded-lg p-2 transition"
                                        style={selected.pinned
                                            ? { color: 'var(--accent-primary)', border: '1px solid var(--border-focus)', backgroundColor: 'var(--accent-muted)' }
                                            : { color: 'var(--text-tertiary)', border: '1px solid var(--border-primary)' }}
                                    >
                                        <PinIcon size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => toggleFlag(selected, 'muted')}
                                        title={selected.muted ? 'Unmute (inject into chats again)' : 'Mute — keep stored but never inject into chats'}
                                        className="rounded-lg p-2 transition"
                                        style={selected.muted
                                            ? { color: '#f59e0b', border: '1px solid #f59e0b55', backgroundColor: '#f59e0b1a' }
                                            : { color: 'var(--text-tertiary)', border: '1px solid var(--border-primary)' }}
                                    >
                                        <MuteIcon size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => deleteMemory(selected.id)}
                                        title="Delete memory"
                                        className="rounded-lg p-2 transition"
                                        style={{ color: '#ef4444', border: '1px solid #ef444455' }}
                                    >
                                        <DeleteIcon size={16} />
                                    </button>
                                </div>
                            </div>

                            <textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={4}
                                className="mt-3 w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed outline-none"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                    type="button" disabled={savingEdit || !dirty || !editText.trim()} onClick={saveEdit}
                                    className="ml-auto inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                                    style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                                >
                                    {savingEdit ? <SpinnerIcon size={15} className="animate-spin" /> : <SaveIcon size={15} />}
                                    {savingEdit ? 'Saving…' : 'Save'}
                                </button>
                            </div>

                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
