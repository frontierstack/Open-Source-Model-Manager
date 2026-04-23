import React, { useState, useMemo } from 'react';
import { X, Eye, Code, RefreshCw, Download, Share2, FileText } from 'lucide-react';
import CodeBlock from './CodeBlock';

/**
 * ArtifactsPanel — right-rail panel with Preview / Source / Diff tabs.
 *
 * Artifacts are detected client-side from assistant messages:
 *   - Every fenced code block (```lang\n...\n```) becomes an artifact
 *   - Each artifact has: id, title, language, source
 *
 * Detection is read-only; nothing is persisted. Future enhancements may
 * promote long markdown sections or attached files to artifacts too.
 */
export function extractArtifacts(messages = []) {
    const artifacts = [];
    messages.forEach((msg, msgIdx) => {
        if (msg.role !== 'assistant') return;
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
    });
    return artifacts;
}

export default function ArtifactsPanel({ open, artifacts = [], activeId, onSelect, onClose }) {
    const [tab, setTab] = useState('preview');

    const active = useMemo(() => {
        if (!artifacts.length) return null;
        return artifacts.find(a => a.id === activeId) || artifacts[artifacts.length - 1];
    }, [artifacts, activeId]);

    if (!open) return null;

    const panel = {
        width: 420, height: '100%',
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
        <aside style={panel}>
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
                {active && (
                    <button
                        style={iconBtn}
                        onClick={() => {
                            const blob = new Blob([active.source], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${active.title.replace(/[^a-z0-9.-]+/gi, '_')}.${active.language || 'txt'}`;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 0);
                        }}
                        title="Download"
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                        <Download style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                    </button>
                )}
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
                    {active ? `${active.language || 'text'} · ${active.source.split('\n').length} lines` : ''}
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
                    <div style={{ padding: '16px 18px 40px' }}>
                        <CodeBlock
                            code={active.source}
                            language={active.language}
                            isStreaming={false}
                        />
                    </div>
                ) : (
                    <pre style={{
                        margin: 0,
                        padding: '20px 22px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5, lineHeight: 1.6,
                        color: 'var(--ink-2)',
                        whiteSpace: 'pre',
                        overflowX: 'auto',
                    }}>
                        {active.source}
                    </pre>
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
                                await navigator.clipboard.writeText(active.source);
                            } catch (e) { /* ignore */ }
                        }}
                    >
                        <Share2 style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                        <span>Copy</span>
                    </button>
                )}
            </div>
        </aside>
    );
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
