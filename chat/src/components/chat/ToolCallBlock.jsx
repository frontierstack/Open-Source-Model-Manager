import React, { useState } from 'react';
import { Globe, Link as LinkIcon, Wrench, AlertCircle, ChevronDown, Check, Loader2, Shield } from 'lucide-react';
import SearchSources from './SearchSources';

/**
 * ToolCallBlock — compact chip showing an assistant tool invocation.
 *
 * Collapsed state is a content-sized chip (NOT full-width) that wraps
 * naturally inside the parent flex container. Click to expand for args,
 * preview, error details, and any structured sources.
 */
export default function ToolCallBlock({ tool }) {
    // Auto-expand failed calls on first render so the user immediately sees
    // why the call broke without an extra click. Still toggleable.
    const [open, setOpen] = useState(tool?.status === 'failed');
    if (!tool) return null;

    const {
        type = 'skill',
        label = 'Tool',
        query,
        args,
        durationMs,
        resultCount,
        status = 'success',
        error,
        preview,
        sources,
        results,
        sandboxed,
        sandboxNetwork,
        sandboxSource,
    } = tool;

    const isRunning = status === 'partial';
    const isFailed = status === 'failed';
    const IconComponent =
        type === 'web_search' ? Globe :
        type === 'url_fetch' ? LinkIcon :
        Wrench;

    const toolName =
        type === 'web_search' ? 'web.search'
            : type === 'url_fetch' ? 'web.fetch'
            : type === 'native_tool_call' ? label
            : label.toLowerCase().replace(/\s+/g, '.');

    const captionParts = [];
    const sourceList = Array.isArray(sources) ? sources : Array.isArray(results) ? results : null;
    const sourceCount = sourceList ? sourceList.length : null;
    if (typeof resultCount === 'number') {
        const noun = type === 'web_search' ? 'result' : type === 'url_fetch' ? 'page' : 'result';
        captionParts.push(`${resultCount} ${noun}${resultCount === 1 ? '' : 's'}`);
    } else if (sourceCount && (type === 'native_tool_call' || type === 'web_search' || type === 'url_fetch')) {
        captionParts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
    }
    if (isRunning) captionParts.push('running…');
    else if (typeof durationMs === 'number' && durationMs >= 0) {
        const seconds = durationMs / 1000;
        captionParts.push(seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`);
    }
    const caption = captionParts.join(' · ');
    const hasSources = Array.isArray(sourceList) && sourceList.length > 0;
    // Show args panel when we have parsed args or the legacy single-string `query`.
    const argEntries = args && typeof args === 'object' ? Object.entries(args) : null;
    const hasArgs = (argEntries && argEntries.length > 0) || (!argEntries && query);
    const hasDetail = isFailed || (preview && !isRunning) || hasSources || hasArgs;

    const statusColor =
        isRunning ? 'var(--accent)'
            : status === 'success' ? 'var(--ok)'
            : 'var(--danger)';

    // Tighter, content-sized chip. flex-direction column lets the header
    // stay compact while the expanded body stretches to the chip's natural
    // (content-driven) width.
    const wrap = {
        display: 'inline-flex',
        flexDirection: 'column',
        maxWidth: '100%',
        border: `1px solid ${isFailed ? 'color-mix(in oklab, var(--danger) 45%, var(--rule))' : 'var(--rule)'}`,
        borderRadius: 8,
        background: isFailed
            ? 'color-mix(in oklab, var(--danger) 6%, var(--bg-2))'
            : 'var(--bg-2)',
        margin: 0,
        fontSize: 12.5,
        overflow: 'hidden',
        verticalAlign: 'top',
    };
    const header = {
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '5px 10px',
        textAlign: 'left',
        color: 'var(--ink-2)',
        background: 'transparent', border: 0,
        cursor: hasDetail ? 'pointer' : 'default',
        transition: 'background .08s',
        minWidth: 0,
    };
    const statusDot = {
        width: 14, height: 14, borderRadius: '50%',
        background: statusColor, color: '#fff',
        display: 'grid', placeItems: 'center',
        flexShrink: 0,
    };
    const toolNameStyle = {
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        color: 'var(--ink)',
        whiteSpace: 'nowrap',
    };
    const summaryStyle = {
        color: 'var(--ink-3)',
        fontSize: 11.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 280,
    };
    const body = {
        borderTop: `1px solid ${isFailed ? 'color-mix(in oklab, var(--danger) 30%, var(--rule))' : 'var(--rule)'}`,
        padding: '6px 10px 8px',
        display: 'flex', flexDirection: 'column', gap: 6,
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
                    {isRunning
                        ? <Loader2 className="animate-spin" style={{ width: 10, height: 10 }} strokeWidth={2.5} />
                        : status === 'success'
                        ? <Check style={{ width: 9, height: 9 }} strokeWidth={3} />
                        : <AlertCircle style={{ width: 10, height: 10 }} strokeWidth={2.25} />}
                </span>
                <IconComponent style={{ width: 12, height: 12, color: 'var(--ink-3)', flexShrink: 0 }} strokeWidth={1.75} />
                <code style={toolNameStyle}>{toolName}</code>
                {sandboxSource === 'skill' && (
                    <span
                        title="Skill — user-defined Python or built-in skill (dispatched via the dynamic tool catalog)"
                        style={badgeStyle('var(--accent, #6366f1)', 14, 32)}
                    >
                        skill
                    </span>
                )}
                {sandboxSource === 'native' && (
                    <span
                        title="Native tool — built-in handler in the chat server (web_search, fetch_url, etc.)"
                        style={badgeStyle('var(--ink-3, #94a3b8)', 12, 28)}
                    >
                        tool
                    </span>
                )}
                {sandboxed === true && (
                    <span
                        title={
                            'Ran inside the gVisor sandbox' +
                            (sandboxNetwork ? ` · network=${sandboxNetwork}` : '')
                        }
                        style={badgeStyle('var(--ok, #22c55e)', 12, 30)}
                    >
                        <Shield style={{ width: 8, height: 8 }} strokeWidth={2.5} />
                        sandboxed
                    </span>
                )}
                {sandboxed === false && (
                    <span
                        title="Ran in-process in the webapp container (not sandboxed)"
                        style={badgeStyle('var(--warning, #f59e0b)', 10, 28)}
                    >
                        in-process
                    </span>
                )}
                {caption && <span style={summaryStyle}>{caption}</span>}
                {hasDetail && (
                    <span style={{
                        marginLeft: 6,
                        color: 'var(--ink-4)',
                        display: 'inline-flex',
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform .15s',
                        flexShrink: 0,
                    }}>
                        <ChevronDown style={{ width: 12, height: 12 }} strokeWidth={2} />
                    </span>
                )}
            </button>
            {open && hasDetail && (
                <div style={body}>
                    {hasArgs && (
                        argEntries && argEntries.length > 0 ? (
                            <ArgsTable entries={argEntries} />
                        ) : (
                            <div style={argLineStyle}>
                                <span style={argKeyStyle}>args</span>
                                <span style={argValStyle}>{query}</span>
                            </div>
                        )
                    )}
                    {isFailed && error && <ErrorBlock error={error} toolName={toolName} />}
                    {hasSources && <SearchSources sources={sourceList} />}
                    {preview && !isFailed && !hasSources && (
                        <pre style={{
                            margin: 0,
                            fontFamily: 'var(--font-mono)', fontSize: 11.5,
                            color: 'var(--ink-2)',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            maxHeight: 360, overflow: 'auto',
                        }}>{preview}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

// Pill style helper. `pct` = bg opacity, `borderPct` = border opacity (in %).
function badgeStyle(color, pct, borderPct) {
    return {
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '0 5px', height: 16, lineHeight: '16px',
        borderRadius: 9, fontSize: 9.5, fontWeight: 500,
        color, background: `color-mix(in oklab, ${color} ${pct}%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} ${borderPct}%, transparent)`,
        flexShrink: 0,
    };
}

// Compact key: value table for tool arguments. Long values get wrapped &
// monospaced; the key column auto-sizes to the longest key.
const argLineStyle = {
    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px',
    alignItems: 'baseline',
};
const argKeyStyle = {
    fontFamily: 'var(--font-mono)', fontSize: 10.5,
    color: 'var(--ink-4)', textTransform: 'lowercase',
};
const argValStyle = {
    fontFamily: 'var(--font-mono)', fontSize: 11,
    color: 'var(--ink-2)', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
};

function ArgsTable({ entries }) {
    return (
        <div style={argLineStyle}>
            {entries.map(([k, v]) => {
                let display;
                if (v == null) display = String(v);
                else if (typeof v === 'string') display = v;
                else if (typeof v === 'object') {
                    try { display = JSON.stringify(v); } catch { display = String(v); }
                } else display = String(v);
                if (display.length > 600) display = display.slice(0, 600) + '…';
                return (
                    <React.Fragment key={k}>
                        <span style={argKeyStyle}>{k}</span>
                        <span style={argValStyle}>{display}</span>
                    </React.Fragment>
                );
            })}
        </div>
    );
}

// Failed-call block. Visually distinct from preview text — red-tinted
// background, monospace, generous wrap. Most tool errors come back as a
// JSON-encoded `{"error": "..."}` string; pretty-print when we can.
function ErrorBlock({ error, toolName }) {
    let display = String(error || '').trim();
    let kind = 'error';
    try {
        const parsed = JSON.parse(display);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.error === 'string') {
                display = parsed.error;
                if (typeof parsed.message === 'string' && parsed.message !== parsed.error) {
                    display += `\n${parsed.message}`;
                }
                kind = parsed.error === 'loop_detected' ? 'loop' : 'error';
            } else if (typeof parsed.message === 'string') {
                display = parsed.message;
            }
        }
    } catch (_) { /* not JSON, keep raw */ }
    const isLoop = kind === 'loop';
    return (
        <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'color-mix(in oklab, var(--danger) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--danger) 22%, transparent)',
        }}>
            <AlertCircle style={{ width: 13, height: 13, marginTop: 1, color: 'var(--danger)', flexShrink: 0 }} strokeWidth={2} />
            <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>
                    {isLoop ? 'loop detected' : `${toolName} failed`}
                </div>
                <pre style={{
                    margin: 0,
                    fontFamily: 'var(--font-mono)', fontSize: 11.5,
                    color: 'var(--ink)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    maxHeight: 240, overflow: 'auto',
                }}>{display}</pre>
            </div>
        </div>
    );
}
