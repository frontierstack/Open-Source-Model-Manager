import React, { useState, useMemo, useEffect } from 'react';
import { X, Eye, Code, RefreshCw, Download, Share2, FileText } from 'lucide-react';
import CodeBlock from './CodeBlock';

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

export default function ArtifactsPanel({ open, artifacts = [], activeId, onSelect, onClose }) {
    const [tab, setTab] = useState('preview');

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
            <aside style={panel} className="artifacts-panel">
            <div style={header}>
                <div style={{ flex: 1, minWidth: 0 }}>
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
                    // Native <a download> for file artifacts — no JS click
                    // chain so Chrome's "non-user-initiated download" guard
                    // never trips. ?download=1 forces Content-Disposition:
                    // attachment server-side regardless of file type.
                    <a
                        href={active.url + (active.url.includes('?') ? '&' : '?') + 'download=1'}
                        download={active.fileName || active.title}
                        title="Download"
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
                        ? (active.kind === 'file'
                            ? `${active.language || 'file'}${active.fileSize ? ' · ' + fmtBytes(active.fileSize) : ''}`
                            : `${active.language || 'text'} · ${(active.source || '').split('\n').length} lines`)
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
function FilePreviewBody({ active, fileSource }) {
    if (active.kind !== 'file') {
        return (
            <div style={{ padding: '16px 18px 40px' }}>
                <CodeBlock code={active.source} language={active.language} isStreaming={false} />
            </div>
        );
    }
    const lang = active.language;
    if (lang === 'html') {
        return (
            <iframe
                src={active.url}
                title={active.title || 'preview'}
                // `allow-downloads` lets the user Ctrl+S / right-click-save
                // from inside the sandboxed iframe — without it Chrome
                // silently blocks the save. `allow-popups-to-escape-sandbox`
                // lets links inside the page open externally with their own
                // (un-sandboxed) origin so Leaflet/Mapbox tile URLs work.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
            />
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
        // Browsers natively render these in an iframe.
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
    return (
        <div style={{ padding: '10px 10px 30px' }}>
            {artifacts.map(a => (
                <button
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                        padding: '10px 12px', marginBottom: 4,
                        background: a.id === activeId ? 'var(--accent-soft)' : 'transparent',
                        border: '1px solid var(--rule)',
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
                        <div style={{
                            fontSize: 12.5, fontWeight: 500, color: 'var(--ink)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                            {a.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                            {a.language} · {a.source.split('\n').length} lines
                        </div>
                    </div>
                </button>
            ))}
        </div>
    );
}
