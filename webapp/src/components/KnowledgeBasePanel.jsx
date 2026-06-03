import React from 'react';
import {
    Library as LibraryIcon,
    Plus as PlusIcon,
    Trash2 as DeleteIcon,
    Upload as UploadIcon,
    Search as SearchIcon,
    FileText as FileIcon,
    Loader2 as SpinnerIcon,
    Database as DatabaseIcon,
} from 'lucide-react';

// Knowledge Base tab — per-user document collections with semantic retrieval.
// Self-contained: it owns its own data fetching (global fetch is CSRF-tagged
// and cookie-authed by csrfFetch.js), so App.js only has to render it.
// Admins receive every user's KBs from the API and see an owner badge.

function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

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

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const s = String(reader.result || '');
            const comma = s.indexOf(',');
            resolve(comma >= 0 ? s.slice(comma + 1) : s);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export default function KnowledgeBasePanel() {
    const [kbs, setKbs] = React.useState([]);
    const [isAdmin, setIsAdmin] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(null);

    const [selectedId, setSelectedId] = React.useState(null);
    const [detail, setDetail] = React.useState(null); // {knowledgeBase, documents, stats}
    const [detailLoading, setDetailLoading] = React.useState(false);

    const [showCreate, setShowCreate] = React.useState(false);
    const [newName, setNewName] = React.useState('');
    const [newDesc, setNewDesc] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const [uploadBusy, setUploadBusy] = React.useState(false);
    const [uploadMsg, setUploadMsg] = React.useState(null);
    const fileInputRef = React.useRef(null);

    const [query, setQuery] = React.useState('');
    const [searching, setSearching] = React.useState(false);
    const [results, setResults] = React.useState(null);

    const loadKBs = React.useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const data = await jsonFetch('/api/knowledge-bases');
            setKbs(data.knowledgeBases || []);
            setIsAdmin(!!data.isAdmin);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadDetail = React.useCallback(async (id) => {
        if (!id) { setDetail(null); return; }
        setDetailLoading(true); setResults(null); setUploadMsg(null);
        try {
            setDetail(await jsonFetch(`/api/knowledge-bases/${id}`));
        } catch (e) {
            setDetail(null); setError(e.message);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    React.useEffect(() => { loadKBs(); }, [loadKBs]);
    React.useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

    const createKB = async () => {
        if (!newName.trim()) return;
        setBusy(true);
        try {
            const { knowledgeBase } = await jsonFetch('/api/knowledge-bases', {
                method: 'POST',
                body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() }),
            });
            setShowCreate(false); setNewName(''); setNewDesc('');
            await loadKBs();
            setSelectedId(knowledgeBase.id);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    };

    const deleteKB = async (id, name) => {
        if (!window.confirm(`Delete knowledge base "${name}"? This removes all of its documents and cannot be undone.`)) return;
        try {
            await jsonFetch(`/api/knowledge-bases/${id}`, { method: 'DELETE' });
            if (selectedId === id) setSelectedId(null);
            await loadKBs();
        } catch (e) { setError(e.message); }
    };

    const onPickFiles = async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length || !selectedId) return;
        setUploadBusy(true); setUploadMsg(null);
        let added = 0, failed = 0, chunks = 0;
        for (const file of files) {
            try {
                const content = await fileToBase64(file);
                const out = await jsonFetch(`/api/knowledge-bases/${selectedId}/documents`, {
                    method: 'POST',
                    body: JSON.stringify({ filename: file.name, content, mimeType: file.type || '' }),
                });
                added += 1; chunks += (out.document?.chunkCount || 0);
            } catch (err) {
                failed += 1; setUploadMsg(`"${file.name}": ${err.message}`);
            }
        }
        setUploadBusy(false);
        if (added) setUploadMsg(`Indexed ${added} file${added > 1 ? 's' : ''} (${chunks} chunks)${failed ? `, ${failed} failed` : ''}.`);
        await Promise.all([loadKBs(), loadDetail(selectedId)]);
    };

    const deleteDoc = async (docId) => {
        try {
            await jsonFetch(`/api/knowledge-bases/${selectedId}/documents/${docId}`, { method: 'DELETE' });
            await Promise.all([loadKBs(), loadDetail(selectedId)]);
        } catch (e) { setError(e.message); }
    };

    const runSearch = async () => {
        if (!query.trim() || !selectedId) return;
        setSearching(true); setResults(null);
        try {
            const data = await jsonFetch(`/api/knowledge-bases/${selectedId}/search`, {
                method: 'POST',
                body: JSON.stringify({ query: query.trim(), k: 6 }),
            });
            setResults(data.results || []);
        } catch (e) { setResults([]); setError(e.message); } finally { setSearching(false); }
    };

    const selected = detail?.knowledgeBase || kbs.find((k) => k.id === selectedId) || null;

    return (
        <div className="flex flex-col" style={{ color: 'var(--text-primary)', height: 'calc(100vh - 140px)', minHeight: '460px' }}>
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-1 pb-4">
                <div className="flex items-center gap-2.5">
                    <LibraryIcon size={22} strokeWidth={1.75} style={{ color: 'var(--accent-primary)' }} />
                    <div>
                        <div className="text-lg font-semibold">Knowledge Base</div>
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            Upload documents the model can reference. Retrieval is semantic — only the most
                            relevant passages are pulled in, so large collections never blow the context.
                            {isAdmin && ' Admin: showing every user\'s knowledge bases.'}
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => setShowCreate((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition"
                    style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                >
                    <PlusIcon size={16} /> New Knowledge Base
                </button>
            </div>

            {showCreate && (
                <div className="mb-4 rounded-lg border p-3" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                            autoFocus
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createKB()}
                            placeholder="Name (e.g. Product Docs)"
                            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                        />
                        <input
                            value={newDesc}
                            onChange={(e) => setNewDesc(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createKB()}
                            placeholder="Description (optional)"
                            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                        />
                        <button
                            type="button" disabled={busy || !newName.trim()} onClick={createKB}
                            className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                            style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                        >
                            {busy ? 'Creating…' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div className="mb-3 rounded-md border px-3 py-2 text-sm" style={{ borderColor: '#ef444455', backgroundColor: '#ef44441a', color: '#ef4444' }}>
                    {error}
                </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
                {/* KB list */}
                <div className="min-h-0 overflow-y-auto rounded-lg border p-2" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    {loading ? (
                        <div className="flex items-center gap-2 p-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            <SpinnerIcon size={16} className="animate-spin" /> Loading…
                        </div>
                    ) : kbs.length === 0 ? (
                        <div className="p-4 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            No knowledge bases yet. Create one to get started.
                        </div>
                    ) : (
                        kbs.map((kb) => {
                            const active = kb.id === selectedId;
                            return (
                                <button
                                    key={kb.id}
                                    type="button"
                                    onClick={() => setSelectedId(kb.id)}
                                    className="mb-1 flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition"
                                    style={active
                                        ? { backgroundColor: 'var(--accent-muted)', boxShadow: 'inset 0 0 0 1px var(--border-focus)' }
                                        : {}}
                                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = ''; }}
                                >
                                    <DatabaseIcon size={16} style={{ marginTop: 2, color: active ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                            {kb.name}
                                        </div>
                                        <div className="truncate text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                            {kb.documentCount || 0} docs · {kb.chunkCount || 0} chunks
                                            {isAdmin && kb.ownerName ? ` · ${kb.ownerName}` : ''}
                                        </div>
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                {/* Detail */}
                <div className="min-h-0 overflow-y-auto rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-secondary)' }}>
                    {!selected ? (
                        <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            Select a knowledge base to manage its documents.
                        </div>
                    ) : (
                        <>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-base font-semibold">{selected.name}</div>
                                    {selected.description && (
                                        <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{selected.description}</div>
                                    )}
                                    <div className="mt-1 text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                        {(detail?.stats?.documentCount ?? selected.documentCount ?? 0)} documents ·{' '}
                                        {(detail?.stats?.chunkCount ?? selected.chunkCount ?? 0)} chunks
                                        {detail?.stats?.model ? ` · ${detail.stats.model}` : ''}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button" disabled={uploadBusy}
                                        onClick={() => fileInputRef.current?.click()}
                                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                                    >
                                        {uploadBusy ? <SpinnerIcon size={16} className="animate-spin" /> : <UploadIcon size={16} />}
                                        {uploadBusy ? 'Indexing…' : 'Upload'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => deleteKB(selected.id, selected.name)}
                                        title="Delete knowledge base"
                                        className="rounded-lg p-2"
                                        style={{ color: '#ef4444', border: '1px solid #ef444455' }}
                                    >
                                        <DeleteIcon size={16} />
                                    </button>
                                    <input ref={fileInputRef} type="file" multiple className="hidden"
                                        accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.htm,.xlsx,.xls,.log,.tsv,.xml,.yml,.yaml,.py,.js,.ts" onChange={onPickFiles} />
                                </div>
                            </div>

                            {uploadMsg && (
                                <div className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{uploadMsg}</div>
                            )}

                            {/* Documents */}
                            <div className="mt-4">
                                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Documents</div>
                                {detailLoading ? (
                                    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                                        <SpinnerIcon size={14} className="animate-spin" /> Loading…
                                    </div>
                                ) : (detail?.documents || []).length === 0 ? (
                                    <div className="rounded-md border border-dashed p-4 text-center text-sm" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }}>
                                        No documents yet. Upload PDFs, Word/Excel files, text, markdown, code or CSV.
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-1">
                                        {detail.documents.map((d) => (
                                            <div key={d.docId} className="flex items-center gap-2 rounded-md px-3 py-2"
                                                style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                                                <FileIcon size={15} style={{ color: 'var(--text-tertiary)' }} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm">{d.filename}</div>
                                                    <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                                        {formatBytes(d.size)} · {d.chunkCount} chunks
                                                    </div>
                                                </div>
                                                <button type="button" onClick={() => deleteDoc(d.docId)} title="Remove document"
                                                    className="rounded p-1" style={{ color: 'var(--text-tertiary)' }}
                                                    onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                                                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}>
                                                    <DeleteIcon size={15} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Search test */}
                            <div className="mt-5">
                                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Test retrieval</div>
                                <div className="flex gap-2">
                                    <div className="relative flex-1">
                                        <SearchIcon size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
                                        <input
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                                            placeholder="Ask something this knowledge base should answer…"
                                            className="w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none"
                                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                                        />
                                    </div>
                                    <button type="button" disabled={searching || !query.trim()} onClick={runSearch}
                                        className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>
                                        {searching ? 'Searching…' : 'Search'}
                                    </button>
                                </div>
                                {results != null && (
                                    <div className="mt-2 flex flex-col gap-2">
                                        {results.length === 0 ? (
                                            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No matching passages.</div>
                                        ) : results.map((r, i) => (
                                            <div key={i} className="rounded-md p-3" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                                                <div className="mb-1 flex items-center justify-between text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                                    <span className="truncate">{r.filename || 'source'}</span>
                                                    <span>score {r.score}</span>
                                                </div>
                                                <div className="text-sm" style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                                                    {r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
