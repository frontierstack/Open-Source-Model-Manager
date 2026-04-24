import React, { useState, useRef } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Clock, Zap, PlayCircle, AlertCircle, Sparkles, User, RefreshCw, Eye, Code as CodeIcon } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';
import StatusIndicator from './StatusIndicator';
import ToolCallBlock from './ToolCallBlock';
import SearchSources from './SearchSources';
import ProcessingLogFeed from './ProcessingLogFeed';
import { useChatStore } from '../../stores/useChatStore';

export default React.memo(function ChatMessage({
    id,
    role,
    content,
    reasoning,
    timestamp,
    attachments,
    isStreaming,
    streamingContent,
    streamingReasoning,
    responseTime,
    tokenCount,
    processingStatus,
    processingMessage,
    needsContinuation,
    isPartial,
    onContinue,
    isLoading,
    toolCalls,
    searchResults,
    processingLog,
    modelName,
    onOpenArtifacts,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);
    // Tool-call group collapse. When a turn fires many tool calls the
    // chip strip gets visually crowded; we group them above a threshold
    // and let the user collapse to a one-line summary. Default to
    // expanded while streaming so in-flight chips stay visible, then
    // auto-collapse once streaming ends for that message.
    const TOOL_GROUP_THRESHOLD = 3;
    const [toolsExpanded, setToolsExpanded] = useState(true);
    const prevStreamingRef = useRef(isStreaming);
    React.useEffect(() => {
        if (prevStreamingRef.current && !isStreaming) {
            if (Array.isArray(toolCalls) && toolCalls.length >= TOOL_GROUP_THRESHOLD) {
                setToolsExpanded(false);
            }
        }
        prevStreamingRef.current = isStreaming;
    }, [isStreaming, toolCalls?.length]);
    const reasoningRef = useRef(null);

    // Collapse state lives in the Zustand store so it survives remounts during streaming.
    const collapseKey = id || (isStreaming ? '__streaming__' : null);
    const bodyCollapsed = useChatStore(state => collapseKey ? !!state.collapsedMessageIds[collapseKey] : false);
    const toggleMessageCollapsed = useChatStore(state => state.toggleMessageCollapsed);
    const setMessageCollapsed = useChatStore(state => state.setMessageCollapsed);

    const isUser = role === 'user';
    const displayContent = isStreaming ? streamingContent : content;
    const displayReasoning = isStreaming ? streamingReasoning : reasoning;

    const handleToggleReasoning = (e) => {
        e.stopPropagation();
        setReasoningExpanded(!reasoningExpanded);
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(displayContent || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    // Shared inline styles that use the design palette bridge.
    const aiBadge = {
        width: 18, height: 18, borderRadius: '50%',
        background: 'var(--ink)', color: 'var(--bg)',
        display: 'grid', placeItems: 'center',
        flexShrink: 0,
    };
    const userBadge = {
        ...aiBadge,
        background: 'var(--accent)', color: 'var(--accent-ink)',
    };
    const metaRow = {
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11.5, color: 'var(--ink-3)',
        marginBottom: 6,
    };
    const metaName = { color: 'var(--ink-2)', fontWeight: 500 };
    const metaTime = { color: 'var(--ink-4)' };
    const aiBubble = {
        background: 'var(--bubble-ai-bg)',
        color: 'var(--ink)',
        border: 'var(--bubble-border)',
        borderRadius: 'var(--bubble-radius)',
        padding: 'var(--bubble-pad-y) var(--bubble-pad-x)',
        boxShadow: 'var(--bubble-shadow)',
        fontSize: 14.5,
        lineHeight: 1.62,
        alignSelf: 'stretch',
        maxWidth: '100%',
    };
    // User bubble stays as a proper bubble even in flat-bubble mode
    // so right-aligned user text reads as a message, not a highlight.
    const userBubble = {
        background: 'var(--bubble-user-bg)',
        color: 'var(--bubble-user-ink)',
        borderRadius: 14,
        padding: '10px 16px',
        fontSize: 14.5,
        lineHeight: 1.6,
        maxWidth: '78%',
        alignSelf: 'flex-end',
    };
    const collapseBtn = {
        marginLeft: 'auto',
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 7px', borderRadius: 4,
        color: 'var(--ink-3)', fontSize: 10.5,
        transition: 'opacity .12s, background .1s',
        background: 'transparent', border: 0, cursor: 'pointer',
        opacity: hovered || bodyCollapsed ? 1 : 0.35,
    };
    const actionsRow = {
        display: 'flex', alignItems: 'center', gap: 2,
        marginTop: 4,
        transition: 'opacity .12s',
        opacity: hovered ? 1 : 0,
    };
    const actionBtn = {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 8px', borderRadius: 5,
        color: 'var(--ink-3)', fontSize: 11,
        background: 'transparent', border: 0, cursor: 'pointer',
        transition: 'background .1s, color .1s',
    };
    const actionBtnActive = {
        ...actionBtn,
        color: 'var(--ok)',
        background: 'color-mix(in oklab, var(--ok) 15%, transparent)',
    };
    const tokenCountStyle = {
        fontSize: 10.5, color: 'var(--ink-4)',
        fontFamily: 'var(--font-mono)',
    };

    return (
        <div
            style={{
                gap: 6,
                width: '100%',
                marginBottom: 'var(--msg-gap)',
            }}
            className={`flex flex-col min-w-0 ${isUser ? 'items-end' : 'items-start'} ${isStreaming ? '' : 'animate-fade-in'}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {/* File attachments above user messages */}
            {isUser && attachments && attachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 2, maxWidth: '85%' }}>
                    {attachments.map((att, i) => (
                        <div
                            key={i}
                            style={{
                                padding: '2px 8px', borderRadius: 6,
                                background: 'var(--accent-soft)',
                                border: '1px solid var(--accent)',
                            }}
                        >
                            <span style={{ fontSize: 11, color: 'var(--accent)' }}>
                                {att.filename || att.name}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* Meta row: badge + name + time + collapse toggle */}
            <div style={{
                ...metaRow,
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                flexDirection: isUser ? 'row-reverse' : 'row',
            }}>
                {isUser ? (
                    <div style={userBadge}>
                        <User style={{ width: 10, height: 10 }} strokeWidth={2} />
                    </div>
                ) : (
                    <div style={aiBadge}>
                        <Sparkles style={{ width: 10, height: 10 }} strokeWidth={2} />
                    </div>
                )}
                <span style={metaName}>{isUser ? 'You' : (modelName || 'Assistant')}</span>
                {timeStr && <span style={metaTime}>{timeStr}</span>}
                {!isUser && displayContent && !isStreaming && collapseKey && (
                    <button
                        onClick={() => toggleMessageCollapsed(collapseKey)}
                        style={collapseBtn}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        title={bodyCollapsed ? 'Expand response' : 'Collapse response'}
                    >
                        <span style={{ display: 'inline-flex', transform: bodyCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }}>
                            <ChevronDown style={{ width: 11, height: 11 }} strokeWidth={2} />
                        </span>
                        <span>{bodyCollapsed ? 'Expand' : 'Collapse'}</span>
                    </button>
                )}
            </div>

            {/* Skip bubble entirely for user message with no content (paste-as-file case) */}
            {isUser && !displayContent ? null : (
                <div style={isUser ? userBubble : aiBubble} className={isUser ? 'message-user' : 'message-assistant'}>
                    {/* Reasoning / thinking dropdown */}
                    {displayReasoning && (
                        <div ref={reasoningRef} style={{ marginBottom: 8 }}>
                            <button
                                onClick={handleToggleReasoning}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                    color: 'var(--ink-4)',
                                    fontSize: 11.5, fontWeight: 500,
                                    background: 'transparent', border: 0, cursor: 'pointer',
                                    padding: 0,
                                }}
                            >
                                <span>Thinking</span>
                                <span style={{ color: 'var(--ink-4)', fontSize: 10.5 }}>({displayReasoning.length})</span>
                                {reasoningExpanded
                                    ? <ChevronUp style={{ width: 12, height: 12 }} strokeWidth={2} />
                                    : <ChevronDown style={{ width: 12, height: 12 }} strokeWidth={2} />
                                }
                            </button>
                            {reasoningExpanded && (
                                <div style={{
                                    marginTop: 6,
                                    padding: '10px 12px',
                                    borderRadius: 6,
                                    background: 'var(--bg-2)',
                                    border: '1px solid var(--rule-2)',
                                    maxHeight: 260,
                                    overflowY: 'auto',
                                }}>
                                    <p style={{
                                        fontSize: 13, color: 'var(--ink-3)',
                                        fontStyle: 'italic',
                                        whiteSpace: 'pre-wrap',
                                        lineHeight: 1.55,
                                        margin: 0,
                                    }}>
                                        {displayReasoning}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Body content */}
                    {isStreaming && !displayContent ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
                            {Array.isArray(processingLog) && processingLog.length > 0 ? (
                                <ProcessingLogFeed log={processingLog} />
                            ) : processingStatus ? (
                                <StatusIndicator status={processingStatus} message={processingMessage} />
                            ) : (
                                <ThinkingIndicator />
                            )}
                        </div>
                    ) : bodyCollapsed ? (
                        (() => {
                            const cleaned = (displayContent || '')
                                .replace(/```[\s\S]*?```/g, '[code]')
                                .replace(/`([^`]+)`/g, '$1')
                                .replace(/\*\*([^*]+)\*\*/g, '$1')
                                .replace(/\*([^*]+)\*/g, '$1')
                                .replace(/^#{1,6}\s+/gm, '')
                                .replace(/^[-*+]\s+/gm, '')
                                .replace(/^\d+\.\s+/gm, '');
                            const firstLine = (cleaned.split('\n').find(l => l.trim().length > 0) || '').trim();
                            const MAX = 90;
                            const preview = firstLine.length > MAX
                                ? firstLine.slice(0, MAX).replace(/\s+\S*$/, '') + '…'
                                : firstLine;
                            const chars = (displayContent || '').length;
                            return (
                                <button
                                    onClick={() => collapseKey && setMessageCollapsed(collapseKey, false)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                                        padding: '9px 12px',
                                        border: '1px dashed var(--rule-2)', borderRadius: 8,
                                        background: 'transparent', textAlign: 'left', cursor: 'pointer',
                                        transition: 'background .1s',
                                    }}
                                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                    <span style={{ flex: 1, textAlign: 'left', color: 'var(--ink-3)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {preview || 'Collapsed response'}
                                    </span>
                                    <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>
                                        {chars.toLocaleString()} chars · click to expand
                                    </span>
                                </button>
                            );
                        })()
                    ) : (
                        <MessageContent content={displayContent} isStreaming={isStreaming} />
                    )}

                    {/* Inline artifact chip — shown when the assistant response
                        contains one or more fenced code blocks. Click opens the
                        right-rail Artifacts panel. */}
                    {!isUser && !isStreaming && !bodyCollapsed && displayContent && onOpenArtifacts && (() => {
                        const matches = (displayContent || '').match(/```[\w-]*\s*(?:\[[^\]]+\])?\n[\s\S]*?```/g);
                        const count = matches ? matches.length : 0;
                        if (count === 0) return null;
                        const firstMatch = matches[0];
                        const langMatch = firstMatch.match(/^```(\w+)/);
                        const lang = langMatch ? langMatch[1] : 'code';
                        return (
                            <button
                                onClick={onOpenArtifacts}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                                    padding: '10px 12px',
                                    marginTop: 10,
                                    background: 'var(--bg-2)',
                                    border: '1px solid var(--rule)',
                                    borderRadius: 8,
                                    textAlign: 'left', cursor: 'pointer',
                                    color: 'var(--ink)',
                                    transition: 'border-color .12s, background .12s',
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.borderColor = 'var(--accent)';
                                    e.currentTarget.style.background = 'var(--accent-soft)';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.borderColor = 'var(--rule)';
                                    e.currentTarget.style.background = 'var(--bg-2)';
                                }}
                            >
                                <div style={{
                                    width: 28, height: 28, borderRadius: 6,
                                    background: 'var(--accent-soft)', color: 'var(--accent)',
                                    display: 'grid', placeItems: 'center', flexShrink: 0,
                                }}>
                                    <CodeIcon style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                                </div>
                                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                                        {count} code artifact{count === 1 ? '' : 's'}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                                        {lang}{count > 1 ? ` + ${count - 1} more` : ''} · Open in panel
                                    </div>
                                </div>
                                <Eye style={{ width: 13, height: 13, color: 'var(--ink-3)' }} strokeWidth={1.75} />
                            </button>
                        );
                    })()}

                    {/* Search source chips */}
                    {!isUser && !isStreaming && !bodyCollapsed && Array.isArray(searchResults) && searchResults.length > 0 && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                            <SearchSources sources={searchResults} />
                        </div>
                    )}

                    {/* Tool calls — also rendered during streaming so live
                        chips show up for native tool invocations in flight.
                        When the count hits TOOL_GROUP_THRESHOLD we wrap in
                        a collapsible container and let the user fold to a
                        one-line summary; otherwise the chips render inline
                        as before. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.length > 0 && (() => {
                        const grouped = toolCalls.length >= TOOL_GROUP_THRESHOLD;
                        if (!grouped) {
                            return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                                    {toolCalls.map((tc, idx) => (
                                        <ToolCallBlock key={idx} tool={tc} />
                                    ))}
                                </div>
                            );
                        }
                        // Group header summary: count unique tool names so the user
                        // sees "web_search, fetch_url (x5)" rather than a raw count.
                        const counts = {};
                        for (const tc of toolCalls) {
                            const nm = tc?.name || tc?.label || tc?.type || 'tool';
                            counts[nm] = (counts[nm] || 0) + 1;
                        }
                        const summary = Object.entries(counts)
                            .map(([n, c]) => c > 1 ? `${n} ×${c}` : n)
                            .join(', ');
                        return (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                                <button
                                    type="button"
                                    onClick={() => setToolsExpanded(v => !v)}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '4px 10px',
                                        borderRadius: 6,
                                        background: 'color-mix(in oklab, var(--accent, #6366f1) 10%, transparent)',
                                        border: '1px solid color-mix(in oklab, var(--accent, #6366f1) 25%, transparent)',
                                        color: 'var(--text-secondary)',
                                        fontSize: 11,
                                        cursor: 'pointer',
                                    }}
                                    aria-expanded={toolsExpanded}
                                    aria-label={toolsExpanded ? 'Collapse tool calls' : 'Expand tool calls'}
                                >
                                    {toolsExpanded
                                        ? <ChevronUp style={{ width: 12, height: 12 }} />
                                        : <ChevronDown style={{ width: 12, height: 12 }} />}
                                    <span style={{ fontWeight: 500 }}>
                                        {toolCalls.length} tool {toolCalls.length === 1 ? 'call' : 'calls'}
                                    </span>
                                    <span style={{ opacity: 0.75 }}>·</span>
                                    <span style={{ opacity: 0.85 }}>{summary}</span>
                                </button>
                                {toolsExpanded && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                                        {toolCalls.map((tc, idx) => (
                                            <ToolCallBlock key={idx} tool={tc} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Partial / interrupted indicator */}
                    {!isUser && !isStreaming && (needsContinuation || isPartial) && (
                        <div style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            marginTop: 8,
                            padding: '4px 10px',
                            borderRadius: 6,
                            background: 'color-mix(in oklab, var(--warning, #f59e0b) 12%, transparent)',
                            border: '1px solid color-mix(in oklab, var(--warning, #f59e0b) 30%, transparent)',
                        }}>
                            <AlertCircle style={{ width: 12, height: 12, color: 'var(--warning, #f59e0b)', flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>
                                Response cut off
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Hover-revealed action row (assistant messages) */}
            {!isUser && displayContent && !isStreaming && (
                <div style={{ ...actionsRow, alignSelf: 'stretch' }}>
                    <button
                        onClick={handleCopy}
                        style={copied ? actionBtnActive : actionBtn}
                        onMouseEnter={(e) => { if (!copied) e.currentTarget.style.background = 'var(--bg-2)'; }}
                        onMouseLeave={(e) => { if (!copied) e.currentTarget.style.background = 'transparent'; }}
                        title={copied ? 'Copied!' : 'Copy response'}
                    >
                        {copied ? <Check style={{ width: 13, height: 13 }} strokeWidth={2} /> : <Copy style={{ width: 13, height: 13 }} strokeWidth={1.75} />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>

                    {(needsContinuation || isPartial) && onContinue && (
                        <button
                            onClick={() => onContinue(id, content)}
                            disabled={isLoading}
                            style={{
                                ...actionBtn,
                                color: isLoading ? 'var(--ink-4)' : 'var(--accent)',
                                background: isLoading ? 'transparent' : 'var(--accent-soft)',
                                cursor: isLoading ? 'not-allowed' : 'pointer',
                            }}
                            title="Continue generating"
                        >
                            <PlayCircle style={{ width: 13, height: 13 }} strokeWidth={1.75} className={isLoading ? 'animate-pulse' : ''} />
                            <span>{isLoading ? 'Continuing…' : 'Continue'}</span>
                        </button>
                    )}

                    <div style={{ flex: 1 }} />

                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {responseTime && (
                            <span style={{ ...tokenCountStyle, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <Clock style={{ width: 10, height: 10 }} strokeWidth={1.75} />
                                {responseTime < 1000 ? `${responseTime}ms` : `${(responseTime / 1000).toFixed(1)}s`}
                            </span>
                        )}
                        {tokenCount && (
                            <span style={{ ...tokenCountStyle, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <Zap style={{ width: 10, height: 10 }} strokeWidth={1.75} />
                                {tokenCount.toLocaleString?.() || tokenCount}
                            </span>
                        )}
                    </span>
                </div>
            )}
        </div>
    );
});
