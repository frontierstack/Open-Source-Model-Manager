import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, Eye, Code, RefreshCw, Download, Share2, FileText, Maximize2, Minimize2, Play, Square, Loader2, AlertCircle } from 'lucide-react';
import CodeBlock from './CodeBlock';
import { injectSandboxPreview } from '../../utils/sandboxPreview';

/**
 * ArtifactsPanel — right-rail panel with Preview / Source / Diff tabs.
 *
 * Artifacts come from two places:
 *   - Fenced code blocks (```lang\n...\n```) in assistant prose
 *     → kind='code', source is the raw code
 *   - Tool-call artifacts (files written by create_file / run_python /
 *     make_downloadable etc., emitted via _artifacts on the tool result)
 *     → kind='file', `url` points at /api/tool-artifacts/<runId>/<name>
 *     so the Preview tab can iframe HTML, render images inline, and the
 *     Source tab can fetch the bytes for code-style files. This closes
 *     the gap where a model that wrote an .html via create_file produced
 *     no side-panel artifact at all.
 */
const FILE_LANG_BY_EXT = {
    html: 'html', htm: 'html', xhtml: 'html',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    jsx: 'javascript',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', md: 'markdown', txt: 'text', csv: 'csv', tsv: 'tsv',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
    xml: 'xml', svg: 'xml',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
    pdf: 'pdf', zip: 'archive', tar: 'archive', gz: 'archive',
    mp3: 'audio', wav: 'audio', mp4: 'video', webm: 'video',
};
function langFromName(name) {
    const ext = (name || '').toLowerCase().split('.').pop();
    return FILE_LANG_BY_EXT[ext] || 'text';
}

export function extractArtifacts(messages = []) {
    const artifacts = [];
    messages.forEach((msg, msgIdx) => {
        if (msg.role !== 'assistant') return;
        // Timestamp of the message this artifact came from — used in the list
        // to show when each was produced and to flag the most recent one.
        const createdAt = msg.timestamp || null;
        // Fenced code blocks in prose ----------------------------------
        const content = msg.content || '';
        const fenceRegex = /```(\w+)?\s*(?:\[([^\]]+)\])?\n([\s\S]*?)```/g;
        let match;
        let blockIdx = 0;
        while ((match = fenceRegex.exec(content)) !== null) {
            const lang = match[1] || 'text';
            const label = match[2] || '';
            const source = match[3].trimEnd();
            const firstLine = source.split('\n').find(l => l.trim().length > 0) || '';
            const title = label
                || (firstLine.length > 0 ? firstLine.slice(0, 60) : `${lang} snippet`);
            artifacts.push({
                id: `m${msgIdx}_b${blockIdx}`,
                title,
                language: lang,
                source,
                messageIdx: msgIdx,
                createdAt,
                kind: 'code',
            });
            blockIdx++;
        }

        // Tool-call artifacts (files written by skills) ----------------
        const tcalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
        tcalls.forEach((tc, tcIdx) => {
            const arts = Array.isArray(tc?.artifacts) ? tc.artifacts : [];
            arts.forEach((a, aIdx) => {
                if (!a || typeof a !== 'object' || !a.url || !a.name) return;
                const lang = langFromName(a.name);
                artifacts.push({
                    id: `m${msgIdx}_t${tcIdx}_a${aIdx}`,
                    title: a.name,
                    language: lang,
                    // Empty `source` until we fetch it on demand. CodeBlock
                    // and the line-count footer fall back gracefully on ''.
                    source: '',
                    url: a.url,
                    fileSize: typeof a.size === 'number' ? a.size : undefined,
                    fileName: a.name,
                    messageIdx: msgIdx,
                    createdAt,
                    kind: 'file',
                });
            });
        });
    });
    return artifacts;
}

function fmtBytes(b) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Compact "when" label for an artifact: "just now" / "5m ago" / "2h ago" for
// recent items, falling back to an absolute date+time for older ones. Returns
// '' when the source message had no usable timestamp.
function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const t = d.getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    if (diff < 0) return 'just now';
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ArtifactsPanel({ open, artifacts = [], activeId, onSelect, onClose }) {
    const [tab, setTab] = useState('preview');

    // --- Resize (docked) + detach (floating window) ----------------------
    // Self-contained, no ChatContainer changes: docked mode overrides the
    // flex-item width; detached mode pops the <aside> out of flow as a
    // position:fixed window the user can drag anywhere and resize from the
    // corner. All geometry persists to localStorage so it survives reloads.
    const [docW, setDocW] = useState(() => {
        const v = parseInt(localStorage.getItem('artifactsPanelWidth'), 10);
        return Number.isFinite(v) ? Math.max(320, Math.min(v, 1200)) : 420;
    });
    const [detached, setDetached] = useState(() => localStorage.getItem('artifactsPanelDetached') === '1');
    const [winPos, setWinPos] = useState(() => {
        try {
            const f = JSON.parse(localStorage.getItem('artifactsPanelFloat') || 'null');
            if (f && typeof f.x === 'number') return f;
        } catch (_) { /* ignore */ }
        return { x: Math.max(40, window.innerWidth - 620), y: 96, w: 560, h: 640 };
    });
    // While a drag is active we lay a transparent full-viewport overlay on
    // top so the preview <iframe> doesn't swallow the mousemove stream.
    const [dragging, setDragging] = useState(false);

    useEffect(() => { try { localStorage.setItem('artifactsPanelWidth', String(Math.round(docW))); } catch (_) {} }, [docW]);
    useEffect(() => { try { localStorage.setItem('artifactsPanelDetached', detached ? '1' : '0'); } catch (_) {} }, [detached]);
    useEffect(() => { try { localStorage.setItem('artifactsPanelFloat', JSON.stringify(winPos)); } catch (_) {} }, [winPos]);

    // Generic pointer-drag: binds window listeners for one drag, restores
    // selection/cursor on release. `onMove(dx, dy)` gets the delta from the
    // press point each frame.
    const startDrag = (e, onMove, cursor) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX, sy = e.clientY;
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = cursor || 'default';
        const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy);
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            setDragging(false);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };
    const onDockResize = (e) => {
        const startW = docW;
        // Handle sits on the LEFT edge → dragging left (dx<0) widens.
        startDrag(e, (dx) => {
            const w = Math.max(320, Math.min(startW - dx, Math.min(1200, window.innerWidth - 260)));
            setDocW(w);
        }, 'col-resize');
    };
    const onFloatMove = (e) => {
        const s = winPos;
        startDrag(e, (dx, dy) => {
            const x = Math.max(0, Math.min(s.x + dx, window.innerWidth - 120));
            const y = Math.max(0, Math.min(s.y + dy, window.innerHeight - 48));
            setWinPos(p => ({ ...p, x, y }));
        }, 'grabbing');
    };
    const onFloatResize = (e) => {
        const s = winPos;
        startDrag(e, (dx, dy) => {
            const w = Math.max(360, Math.min(s.w + dx, window.innerWidth - s.x));
            const h = Math.max(300, Math.min(s.h + dy, window.innerHeight - s.y));
            setWinPos(p => ({ ...p, w, h }));
        }, 'nwse-resize');
    };

    const active = useMemo(() => {
        if (!artifacts.length) return null;
        return artifacts.find(a => a.id === activeId) || artifacts[artifacts.length - 1];
    }, [artifacts, activeId]);

    // Source fetch for file artifacts. The active artifact carries only
    // a URL (the bytes live on the server); pull them on demand and
    // memoise per artifact id so switching tabs / artifacts is cheap and
    // refreshing the active artifact re-fetches.
    const [fileSources, setFileSources] = useState({}); // { [id]: { text|null, error|null, loading } }
    useEffect(() => {
        if (!active || active.kind !== 'file' || !active.url) return;
        // Don't refetch if already cached
        if (fileSources[active.id] && !fileSources[active.id].loading) return;
        // Skip binaries — Source tab shows a placeholder for image/pdf/archive.
        const lang = active.language;
        if (['image', 'pdf', 'archive', 'audio', 'video'].includes(lang)) return;
        let cancelled = false;
        setFileSources(prev => ({ ...prev, [active.id]: { text: null, error: null, loading: true } }));
        fetch(active.url, { credentials: 'include' })
            .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(text => {
                if (cancelled) return;
                setFileSources(prev => ({
                    ...prev,
                    [active.id]: { text: text.slice(0, 500_000), error: null, loading: false },
                }));
            })
            .catch(err => {
                if (cancelled) return;
                setFileSources(prev => ({
                    ...prev,
                    [active.id]: { text: null, error: err.message || 'Fetch failed', loading: false },
                }));
            });
        return () => { cancelled = true; };
    }, [active?.id, active?.url, active?.kind, active?.language]);

    if (!open) return null;

    const panel = {
        height: '100%',
        flexShrink: 0,
        borderLeft: '1px solid var(--rule)',
        background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column',
    };
    const panelStyle = detached
        ? {
            position: 'fixed', left: winPos.x, top: winPos.y,
            width: winPos.w, height: winPos.h,
            zIndex: 60, borderRadius: 12, overflow: 'hidden',
            border: '1px solid var(--rule)',
            boxShadow: '0 24px 60px -12px rgba(0,0,0,0.55)',
            background: 'var(--bg-2)',
            display: 'flex', flexDirection: 'column',
        }
        : { ...panel, position: 'relative', width: docW };
    const header = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 14px',
        borderBottom: '1px solid var(--rule)',
    };
    const iconBtn = {
        width: 26, height: 26, borderRadius: 6,
        display: 'grid', placeItems: 'center',
        color: 'var(--ink-3)',
        background: 'transparent', border: 0, cursor: 'pointer',
        transition: 'background .1s, color .1s',
    };
    const tabs = {
        display: 'flex', alignItems: 'center', gap: 2,
        padding: '0 10px',
        borderBottom: '1px solid var(--rule)',
        background: 'var(--bg)',
    };
    const tabBtn = (active) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '10px 12px',
        fontSize: 12.5, fontWeight: 500,
        color: active ? 'var(--ink)' : 'var(--ink-3)',
        borderBottom: active ? '1.5px solid var(--accent)' : '1.5px solid transparent',
        background: 'transparent', cursor: 'pointer', border: 0,
        transition: 'color .1s, border-color .1s',
    });
    const version = {
        fontSize: 10.5, color: 'var(--ink-4)',
        fontFamily: 'var(--font-mono)',
        paddingRight: 4, marginLeft: 'auto',
    };
    const body = { flex: 1, overflowY: 'auto', background: 'var(--bg)' };
    const footer = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px',
        borderTop: '1px solid var(--rule)',
        background: 'var(--bg-2)',
    };
    const primaryBtn = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 6,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        fontSize: 12, fontWeight: 500,
        border: 0, cursor: 'pointer',
    };

    return (
        <>
            {/* Mobile overlay backdrop — taps close the panel */}
            <div
                className="md:hidden fixed inset-0 z-40"
                style={{ background: 'color-mix(in oklab, var(--ink) 60%, transparent)', backdropFilter: 'blur(4px)' }}
                onClick={onClose}
            />
            {/* Drag overlay — keeps mousemove flowing over the preview iframe */}
            {dragging && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
            )}
            <aside style={panelStyle} className="artifacts-panel">
            {/* Docked: left-edge resize handle */}
            {!detached && (
                <div
                    onMouseDown={onDockResize}
                    title="Drag to resize"
                    style={{
                        position: 'absolute', left: -3, top: 0, bottom: 0, width: 8,
                        cursor: 'col-resize', zIndex: 10,
                    }}
                />
            )}
            <div style={header}>
                <div
                    style={{ flex: 1, minWidth: 0, cursor: detached ? 'move' : 'default' }}
                    onMouseDown={detached ? onFloatMove : undefined}
                >
                    <div style={{
                        fontSize: 10.5, color: 'var(--ink-3)',
                        letterSpacing: '.04em', textTransform: 'uppercase',
                    }}>
                        {active ? 'Artifact' : 'Artifacts'}
                    </div>
                    <div style={{
                        fontSize: 13.5, fontWeight: 600, color: 'var(--ink)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        marginTop: 1,
                    }}>
                        {active ? active.title : `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`}
                    </div>
                </div>
                {active && (active.kind === 'file' && active.url ? (
                    // fetch+blob path: the native <a download> works in most
                    // browsers, but Chrome surfaces "Network issue" on the
                    // background download request when the server URL is a
                    // self-signed-cert HTTPS endpoint. Fetching into a blob
                    // and triggering the save from a `blob:` URL routes
                    // around that — bytes are in-memory + same-origin. The
                    // <a href download> is kept on the element so right-
                    // click → Save As still works as a fallback path.
                    <a
                        href={active.url + (active.url.includes('?') ? '&' : '?') + 'download=1'}
                        download={active.fileName || active.title}
                        title="Download"
                        onClick={(e) => {
                            e.preventDefault();
                            const dlUrl = active.url + (active.url.includes('?') ? '&' : '?') + 'download=1';
                            const fname = active.fileName || active.title || 'download';
                            (async () => {
                                try {
                                    const r = await fetch(dlUrl, { credentials: 'same-origin' });
                                    if (!r.ok) throw new Error('HTTP ' + r.status);
                                    const blob = await r.blob();
                                    const blobUrl = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = blobUrl;
                                    a.download = fname;
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                                } catch (_err) {
                                    window.location.href = dlUrl;
                                }
                            })();
                        }}
                        style={{
                            ...iconBtn,
                            textDecoration: 'none',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                        <Download style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                    </a>
                ) : (
                    // Code-block artifact: build a Blob from the captured
                    // source. The blob URL is data-only and same-origin,
                    // so the click chain doesn't trip download blockers.
                    <button
                        style={iconBtn}
                        onClick={() => {
                            const blob = new Blob([active.source], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${active.title.replace(/[^a-z0-9.-]+/gi, '_')}.${active.language || 'txt'}`;
                            document.body.appendChild(a);
                            a.click();
                            setTimeout(() => {
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                            }, 0);
                        }}
                        title="Download"
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                        <Download style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                    </button>
                ))}
                <button
                    style={iconBtn}
                    onClick={() => setDetached(d => !d)}
                    title={detached ? 'Dock to side' : 'Detach — float anywhere'}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                    {detached
                        ? <Minimize2 style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                        : <Maximize2 style={{ width: 14, height: 14 }} strokeWidth={1.75} />}
                </button>
                <button
                    style={iconBtn}
                    onClick={onClose}
                    title="Close"
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                    <X style={{ width: 14, height: 14 }} strokeWidth={2} />
                </button>
            </div>

            <div style={tabs}>
                <button style={tabBtn(tab === 'preview')} onClick={() => setTab('preview')}>
                    <Eye style={{ width: 13, height: 13 }} strokeWidth={1.75} />
                    <span>Preview</span>
                </button>
                <button style={tabBtn(tab === 'source')} onClick={() => setTab('source')}>
                    <Code style={{ width: 13, height: 13 }} strokeWidth={1.75} />
                    <span>Source</span>
                </button>
                <button style={tabBtn(tab === 'list')} onClick={() => setTab('list')}>
                    <FileText style={{ width: 13, height: 13 }} strokeWidth={1.75} />
                    <span>All ({artifacts.length})</span>
                </button>
                <span style={version}>
                    {active
                        ? ((active.kind === 'file'
                            ? `${active.language || 'file'}${active.fileSize ? ' · ' + fmtBytes(active.fileSize) : ''}`
                            : `${active.language || 'text'} · ${(active.source || '').split('\n').length} lines`)
                            + (fmtWhen(active.createdAt) ? ` · ${fmtWhen(active.createdAt)}` : ''))
                        : ''}
                </span>
            </div>

            <div style={body}>
                {tab === 'list' ? (
                    <ArtifactList
                        artifacts={artifacts}
                        activeId={active?.id}
                        onSelect={(id) => { onSelect?.(id); setTab('preview'); }}
                    />
                ) : !active ? (
                    <EmptyState />
                ) : tab === 'preview' ? (
                    <FilePreviewBody active={active} fileSource={fileSources[active.id]} />
                ) : (
                    <FileSourceBody active={active} fileSource={fileSources[active.id]} />
                )}
            </div>

            <div style={footer}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: 'var(--ok)',
                    }} />
                    <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                        Synced with chat
                    </span>
                </div>
                {active && (
                    <button
                        style={primaryBtn}
                        onClick={async () => {
                            try {
                                let toCopy = active.source;
                                if (active.kind === 'file') {
                                    const cached = fileSources[active.id];
                                    toCopy = (cached && cached.text) || active.url || '';
                                }
                                await navigator.clipboard.writeText(toCopy);
                            } catch (e) { /* ignore */ }
                        }}
                    >
                        <Share2 style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                        <span>Copy</span>
                    </button>
                )}
            </div>
            {/* Detached: bottom-right resize grip */}
            {detached && (
                <div
                    onMouseDown={onFloatResize}
                    title="Drag to resize"
                    style={{
                        position: 'absolute', right: 0, bottom: 0,
                        width: 18, height: 18, cursor: 'nwse-resize', zIndex: 10,
                        background: 'linear-gradient(135deg, transparent 50%, var(--ink-4) 50%, var(--ink-4) 62%, transparent 62%, transparent 74%, var(--ink-4) 74%, var(--ink-4) 86%, transparent 86%)',
                        borderBottomRightRadius: 12,
                    }}
                />
            )}
            </aside>
        </>
    );
}

// Preview tab body. For code artifacts, renders the captured source via
// CodeBlock (existing behavior). For file artifacts: HTML iframes live so
// the user can interact with maps / dashboards / generated pages, images
// render inline, and binary file types fall back to an "Open in new tab"
// button. Text-based files (json, csv, md, py, js, ...) render their
// fetched source through CodeBlock.
// Run-in-panel for Python / Java artifacts. Posts to the same
// /api/sandbox/run-code endpoint the inline code-block Run button uses, then
// renders stdout / stderr and any image artifacts inline in the panel.
function RunnablePreview({ code, language }) {
    const serverLang = language === 'java' ? 'java' : 'python';
    const [state, setState] = useState('idle'); // idle | running | done | error
    const [output, setOutput] = useState(null);
    const abortRef = useRef(null);

    const run = async () => {
        setState('running');
        setOutput(null);
        abortRef.current = new AbortController();
        try {
            const res = await fetch('/api/sandbox/run-code', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ language: serverLang, code, timeoutMs: 60_000 }),
                signal: abortRef.current.signal,
            });
            const data = await res.json();
            setState(!res.ok || data.success === false ? 'error' : 'done');
            setOutput(data);
        } catch (e) {
            if (e.name === 'AbortError') { setState('idle'); setOutput(null); return; }
            setState('error');
            setOutput({ error: e.message });
        } finally {
            abortRef.current = null;
        }
    };
    const stop = () => { if (abortRef.current) abortRef.current.abort(); };

    const btn = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500,
        border: 0, cursor: 'pointer',
    };
    const pre = {
        margin: 0, padding: '10px 12px', fontFamily: 'var(--font-mono)',
        fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        overflowX: 'auto',
    };

    return (
        <div style={{ padding: '14px 16px 40px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
                    {serverLang} · sandbox
                </span>
                {state === 'running' ? (
                    <button style={{ ...btn, background: 'color-mix(in oklab, #ef4444 14%, transparent)', color: '#ef4444' }} onClick={stop}>
                        <Square style={{ width: 12, height: 12 }} strokeWidth={2.5} /> Stop
                    </button>
                ) : (
                    <button style={{ ...btn, background: 'var(--accent)', color: 'var(--accent-ink)' }} onClick={run}>
                        <Play style={{ width: 12, height: 12 }} strokeWidth={2.5} /> Run
                    </button>
                )}
            </div>

            <CodeBlock code={code} language={language} isStreaming={false} />

            {state === 'running' && (
                <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--ink-3)', fontSize: 12 }}>
                    <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> executing in sandbox…
                </div>
            )}

            {output && (state === 'done' || state === 'error') && (
                <div style={{ marginTop: 12, border: '1px solid var(--rule)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ padding: '6px 12px', background: 'var(--bg-2)', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {state === 'error' && <AlertCircle style={{ width: 12, height: 12, color: '#ef4444' }} />}
                        output
                        {typeof output.durationMs === 'number' && (
                            <span style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}>{Math.round(output.durationMs)}ms</span>
                        )}
                    </div>
                    {output.stdout && <pre style={{ ...pre, color: 'var(--ink-2)' }}>{output.stdout}</pre>}
                    {output.stderr && <pre style={{ ...pre, color: '#f87171', borderTop: '1px solid var(--rule)' }}>{output.stderr}</pre>}
                    {output.error && !output.stdout && !output.stderr && (
                        <pre style={{ ...pre, color: '#f87171' }}>{output.error}</pre>
                    )}
                    {output.timedOut && (
                        <div style={{ padding: '6px 12px', fontSize: 11, color: '#fbbf24', borderTop: '1px solid var(--rule)' }}>execution timed out</div>
                    )}
                    {Array.isArray(output.artifacts) && output.artifacts.length > 0 && (
                        <div style={{ borderTop: '1px solid var(--rule)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {output.artifacts.map(a => {
                                const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name);
                                return (
                                    <div key={a.runId + '/' + a.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        {isImage && (
                                            <img src={a.url} alt={a.name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 6, border: '1px solid var(--rule)', background: '#fff' }} />
                                        )}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
                                            <span>{a.name}</span>
                                            <span style={{ color: 'var(--ink-4)' }}>{fmtBytes(a.size)}</span>
                                            <a href={a.url} target="_blank" rel="noreferrer" download={a.name}
                                               style={{ marginLeft: 'auto', color: 'var(--accent)', textDecoration: 'underline' }}>download</a>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function FilePreviewBody({ active, fileSource }) {
    // Runnable languages (Python / Java) get a Run button right in the
    // Preview tab — executed server-side in the gVisor sandbox, with stdout
    // and any image artifacts (matplotlib PNGs, etc.) rendered inline here.
    const RUNNABLE = ['python', 'py', 'python3', 'java'];
    if (RUNNABLE.includes(active.language)) {
        if (active.kind === 'file') {
            if (fileSource?.loading) {
                return <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 12 }}>Loading…</div>;
            }
            if (fileSource?.error) {
                return <div style={{ padding: 24, color: 'var(--err, #d33)', fontSize: 12 }}>Could not load file: {fileSource.error}</div>;
            }
        }
        const code = active.kind === 'file' ? (fileSource?.text || '') : (active.source || '');
        return <RunnablePreview code={code} language={active.language} />;
    }
    const lang = active.language;
    // HTML preview — render in a sandboxed iframe. This runs for BOTH a fenced
    // ```html code block (kind='code', the markup lives inline in `source`) and
    // a written file (kind='file', bytes fetched into fileSource). Previously a
    // code artifact took an early `kind !== 'file'` return straight to CodeBlock
    // below, so a generated page (e.g. the "Tower Game") showed as SOURCE in the
    // Preview tab instead of actually rendering — only file artifacts reached
    // this branch. The early code-artifact return now sits AFTER this, so HTML
    // renders regardless of kind and other languages still fall through to it.
    if (lang === 'html' || lang === 'htm') {
        // Sandboxed at an OPAQUE origin: deliberately NO allow-same-origin. The
        // artifact is served from the app's own origin, so allow-scripts +
        // allow-same-origin together would let model-generated code reach the
        // parent app, its cookies and storage (the browser even warns it "can
        // escape its sandboxing"). With an opaque origin the page's scripts run
        // (button handlers, canvas, timers) but cannot touch the app — the real
        // security boundary that makes the relaxed artifact CSP safe.
        // `allow-downloads` lets Ctrl+S / right-click-save work (Chrome blocks
        // it otherwise); `allow-popups-to-escape-sandbox` opens links externally
        // with their own origin (Leaflet/Mapbox tiles).
        const htmlSandbox = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
        // Prefer rendering the markup via srcDoc so we can inject an in-memory
        // localStorage/sessionStorage shim (the opaque origin makes the real
        // ones throw a SecurityError, crashing snippets that save state — e.g. a
        // game's high score) plus a <base href> so the page's relative URLs
        // still resolve against where it was served. Code artifacts have the
        // text inline; file artifacts fetch it (capped at 500KB) — when a file
        // is truncated or hasn't loaded yet we fall back to src=url so the full
        // artifact still renders.
        let usableText;
        if (active.kind === 'file') {
            const htmlText = fileSource && !fileSource.loading && !fileSource.error ? fileSource.text : null;
            usableText = (htmlText != null && htmlText.length < 500_000) ? htmlText : null;
        } else {
            const src = active.source || '';
            usableText = src.length < 500_000 ? src : null;
        }
        if (usableText != null) {
            return (
                <iframe
                    title={active.title || 'preview'}
                    sandbox={htmlSandbox}
                    srcDoc={injectSandboxPreview(usableText, { baseHref: active.url })}
                    style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
                />
            );
        }
        // File artifact too large to inline (or still loading) — point the
        // iframe straight at the served bytes.
        if (active.kind === 'file') {
            return (
                <iframe
                    src={active.url}
                    title={active.title || 'preview'}
                    sandbox={htmlSandbox}
                    style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
                />
            );
        }
        // Oversized inline code artifact — fall through to the source view below.
    }
    if (active.kind !== 'file') {
        return (
            <div style={{ padding: '16px 18px 40px' }}>
                <CodeBlock code={active.source} language={active.language} isStreaming={false} />
            </div>
        );
    }
    if (lang === 'image') {
        return (
            <div style={{
                width: '100%', height: '100%', overflow: 'auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 16, background: 'var(--bg-2)',
            }}>
                <img
                    src={active.url}
                    alt={active.title}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
            </div>
        );
    }
    if (['pdf', 'audio', 'video'].includes(lang)) {
        // Browsers natively render these in an iframe. Do NOT add a
        // sandbox attribute here — Chrome's built-in PDF viewer is an
        // internal extension that does not initialize in a sandboxed
        // iframe even with allow-same-origin / allow-scripts, and the
        // frame falls back to chrome-error://chromewebdata/. Downloads
        // from this preview are expected to go through the Download
        // button in the panel header (native <a href download>), not
        // the PDF viewer's own toolbar — that path is reliable while
        // the in-PDF-viewer download button is subject to Chrome's
        // sandboxed-iframe download policy.
        return (
            <iframe
                src={active.url}
                title={active.title || 'preview'}
                style={{ width: '100%', height: '100%', border: 0, background: 'var(--bg-2)' }}
            />
        );
    }
    if (lang === 'archive') {
        return (
            <div style={{
                padding: '32px 24px', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 14, color: 'var(--ink-3)',
            }}>
                <FileText style={{ width: 40, height: 40, color: 'var(--ink-4)' }} strokeWidth={1.25} />
                <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                    Archive — no inline preview.
                </div>
                <a href={active.url} target="_blank" rel="noopener noreferrer"
                   style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'underline' }}>
                    Open / download {active.fileName || active.title}
                </a>
            </div>
        );
    }
    // Text-ish file (json, md, py, js, csv, ...). Fetch and render via CodeBlock.
    if (fileSource?.loading) {
        return <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 12 }}>Loading…</div>;
    }
    if (fileSource?.error) {
        return <div style={{ padding: 24, color: 'var(--err, #d33)', fontSize: 12 }}>Could not load file: {fileSource.error}</div>;
    }
    const text = fileSource?.text || '';
    return (
        <div style={{ padding: '16px 18px 40px' }}>
            <CodeBlock code={text} language={active.language} isStreaming={false} />
        </div>
    );
}

// Source tab body. Code artifacts: pre-formatted source. File artifacts:
// fetched bytes for text-ish files, "binary — open in new tab" for the
// rest so the panel never tries to render a 4 MB PNG as text.
function FileSourceBody({ active, fileSource }) {
    const preStyle = {
        margin: 0,
        padding: '20px 22px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5, lineHeight: 1.6,
        color: 'var(--ink-2)',
        whiteSpace: 'pre',
        overflowX: 'auto',
    };
    if (active.kind !== 'file') {
        return <pre style={preStyle}>{active.source}</pre>;
    }
    const lang = active.language;
    if (['image', 'pdf', 'archive', 'audio', 'video'].includes(lang)) {
        return (
            <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 12.5 }}>
                Binary file — no source view. Use Preview or open in a new tab.
            </div>
        );
    }
    if (fileSource?.loading) {
        return <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 12 }}>Loading source…</div>;
    }
    if (fileSource?.error) {
        return <div style={{ padding: 24, color: 'var(--err, #d33)', fontSize: 12 }}>Could not load source: {fileSource.error}</div>;
    }
    return <pre style={preStyle}>{fileSource?.text || ''}</pre>;
}

function EmptyState() {
    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', padding: '40px 24px',
            color: 'var(--ink-3)', textAlign: 'center',
        }}>
            <div style={{
                width: 56, height: 56, borderRadius: 12,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                display: 'grid', placeItems: 'center',
                marginBottom: 14,
            }}>
                <Code style={{ width: 24, height: 24 }} strokeWidth={1.5} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-2)', marginBottom: 6 }}>
                No artifacts yet
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', maxWidth: 280, lineHeight: 1.55 }}>
                Code blocks in assistant responses will appear here.
                Click one in chat to open it in Preview.
            </div>
        </div>
    );
}

function ArtifactList({ artifacts, activeId, onSelect }) {
    if (!artifacts.length) return <EmptyState />;
    // Artifacts are extracted in chronological order (messages in order, blocks
    // within a message in order), so the LAST one is the most recent.
    const mostRecentId = artifacts[artifacts.length - 1].id;
    return (
        <div style={{ padding: '10px 10px 30px' }}>
            {artifacts.map(a => {
                const isLatest = a.id === mostRecentId;
                const when = fmtWhen(a.createdAt);
                const meta = a.kind === 'file'
                    ? `${a.language}${a.fileSize ? ' · ' + fmtBytes(a.fileSize) : ''}`
                    : `${a.language} · ${(a.source || '').split('\n').length} lines`;
                return (
                    <button
                        key={a.id}
                        onClick={() => onSelect(a.id)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                            padding: '10px 12px', marginBottom: 4,
                            background: a.id === activeId ? 'var(--accent-soft)' : 'transparent',
                            border: isLatest && a.id !== activeId
                                ? '1px solid var(--accent)'
                                : '1px solid var(--rule)',
                            borderRadius: 8,
                            textAlign: 'left', cursor: 'pointer',
                            color: 'var(--ink)',
                            transition: 'background .1s, border-color .1s',
                        }}
                        onMouseEnter={(e) => {
                            if (a.id !== activeId) e.currentTarget.style.background = 'var(--surface)';
                        }}
                        onMouseLeave={(e) => {
                            if (a.id !== activeId) e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        <div style={{
                            width: 28, height: 28, borderRadius: 6,
                            background: a.id === activeId ? 'var(--accent)' : 'var(--bg-2)',
                            color: a.id === activeId ? 'var(--accent-ink)' : 'var(--ink-3)',
                            display: 'grid', placeItems: 'center',
                            flexShrink: 0,
                        }}>
                            <Code style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{
                                    fontSize: 12.5, fontWeight: 500, color: 'var(--ink)',
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    minWidth: 0,
                                }}>
                                    {a.title}
                                </span>
                                {isLatest && (
                                    <span style={{
                                        flexShrink: 0,
                                        fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                                        textTransform: 'uppercase',
                                        padding: '1px 6px', borderRadius: 999,
                                        background: 'var(--accent)', color: 'var(--accent-ink)',
                                    }}>
                                        Latest
                                    </span>
                                )}
                            </div>
                            <div style={{
                                fontSize: 11, color: 'var(--ink-3)', marginTop: 2,
                                display: 'flex', alignItems: 'center', gap: 6,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                                <span>{meta}</span>
                                {when && <span style={{ color: 'var(--ink-4)' }}>· {when}</span>}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}
