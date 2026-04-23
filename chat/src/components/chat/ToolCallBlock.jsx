import React, { useState } from 'react';
import { Globe, Link as LinkIcon, Wrench, AlertCircle, ChevronDown, Check } from 'lucide-react';

/**
 * ToolCallBlock — expandable block showing an assistant tool invocation.
 *
 * Visual matches the research-UI design: a row with a success dot,
 * tool icon, code-styled tool name, and summary caption on the left;
 * chevron on the right. Click to expand for error details (if any).
 *
 * @param {Object} tool
 * @param {'web_search'|'url_fetch'|'skill'} tool.type
 * @param {string} tool.label
 * @param {number} [tool.durationMs]
 * @param {number} [tool.resultCount]
 * @param {'success'|'failed'|'partial'} tool.status
 * @param {string} [tool.error]
 */
export default function ToolCallBlock({ tool }) {
    const [open, setOpen] = useState(false);
    if (!tool) return null;

    const {
        type = 'skill',
        label = 'Tool',
        durationMs,
        resultCount,
        status = 'success',
        error,
    } = tool;

    const IconComponent =
        type === 'web_search' ? Globe : type === 'url_fetch' ? LinkIcon : Wrench;

    const toolName =
        type === 'web_search' ? 'web.search'
            : type === 'url_fetch' ? 'web.fetch'
            : label.toLowerCase().replace(/\s+/g, '.');

    const captionParts = [];
    if (typeof resultCount === 'number') {
        const noun = type === 'web_search' ? 'result' : type === 'url_fetch' ? 'page' : 'result';
        captionParts.push(`${resultCount} ${noun}${resultCount === 1 ? '' : 's'}`);
    }
    if (typeof durationMs === 'number' && durationMs >= 0) {
        const seconds = durationMs / 1000;
        captionParts.push(seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`);
    }
    const caption = captionParts.join(' · ');
    const hasDetail = status !== 'success' && error;

    const statusColor =
        status === 'success' ? 'var(--ok)'
            : status === 'partial' ? 'var(--warning, #f59e0b)'
            : 'var(--danger)';

    const wrap = {
        display: 'inline-flex', width: '100%',
        border: '1px solid var(--rule)', borderRadius: 8,
        background: 'var(--bg-2)',
        margin: '8px 0 0',
        fontSize: 12.5,
        overflow: 'hidden',
    };
    const header = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', width: '100%', textAlign: 'left',
        color: 'var(--ink-2)',
        background: 'transparent', border: 0,
        cursor: hasDetail ? 'pointer' : 'default',
        transition: 'background .08s',
    };
    const statusDot = {
        width: 16, height: 16, borderRadius: '50%',
        background: statusColor, color: '#fff',
        display: 'grid', placeItems: 'center',
        flexShrink: 0,
    };
    const toolNameStyle = {
        fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink)',
    };
    const summaryStyle = { color: 'var(--ink-3)', fontSize: 12 };
    const body = {
        borderTop: '1px solid var(--rule)',
        padding: '8px 12px 10px',
        display: 'flex', flexDirection: 'column', gap: 4,
        background: 'var(--bg)',
    };

    return (
        <div style={wrap}>
            <button
                style={header}
                onClick={() => hasDetail && setOpen(o => !o)}
                onMouseEnter={(e) => { if (hasDetail) e.currentTarget.style.background = 'var(--bg-3, var(--bg))'; }}
                onMouseLeave={(e) => { if (hasDetail) e.currentTarget.style.background = 'transparent'; }}
            >
                <span style={statusDot}>
                    {status === 'success'
                        ? <Check style={{ width: 10, height: 10 }} strokeWidth={3} />
                        : <AlertCircle style={{ width: 11, height: 11 }} strokeWidth={2} />}
                </span>
                <IconComponent style={{ width: 13, height: 13, color: 'var(--ink-3)', flexShrink: 0 }} strokeWidth={1.75} />
                <code style={toolNameStyle}>{toolName}</code>
                {caption && <span style={summaryStyle}>{caption}</span>}
                {hasDetail && (
                    <span style={{
                        marginLeft: 'auto',
                        color: 'var(--ink-4)',
                        display: 'inline-flex',
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform .15s',
                    }}>
                        <ChevronDown style={{ width: 13, height: 13 }} strokeWidth={2} />
                    </span>
                )}
            </button>
            {open && hasDetail && (
                <div style={body}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--danger)' }}>
                        <AlertCircle style={{ width: 13, height: 13, marginTop: 2, flexShrink: 0 }} strokeWidth={1.75} />
                        <span style={{ fontSize: 12, lineHeight: 1.5 }}>{error}</span>
                    </div>
                </div>
            )}
        </div>
    );
}
