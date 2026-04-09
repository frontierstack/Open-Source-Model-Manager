import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Clock, Zap, PlayCircle, AlertCircle, Minimize2, Maximize2 } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';
import StatusIndicator from './StatusIndicator';
import ToolCallBlock from './ToolCallBlock';
import SearchSources from './SearchSources';
import ProcessingLogFeed from './ProcessingLogFeed';

/**
 * ChatMessage - Individual chat message bubble (Tailwind)
 */
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
    // New: tool calls captured client-side (web search, url fetch, etc.)
    // and the full web search results array for SearchSources rendering.
    toolCalls,
    searchResults,
    // Rolling-credits-style processing log, rendered while isStreaming is
    // true in place of the single mute spinner.
    processingLog,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
    // Local per-message state for collapsing the main message body. Default
    // expanded; toggle persists for the session lifetime of this component.
    const [bodyCollapsed, setBodyCollapsed] = useState(false);
    const reasoningRef = useRef(null);

    const isUser = role === 'user';
    const displayContent = isStreaming ? streamingContent : content;
    const displayReasoning = isStreaming ? streamingReasoning : reasoning;

    // Prevent auto-scroll when expanding thinking - scroll to reasoning section instead
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

    return (
        <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-full ${isStreaming ? '' : 'animate-fade-in'}`}>
            {/* File attachments for user messages */}
            {isUser && attachments && attachments.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1 max-w-[85%] justify-end">
                    {attachments.map((att, i) => (
                        <div
                            key={i}
                            className="px-2 py-0.5 rounded-md bg-primary-500/15 border border-primary-500/20"
                        >
                            <span className="text-[11px] text-primary-300">
                                {att.filename || att.name}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* Message bubble */}
            <div
                className={`group relative min-w-[60px] ${
                    isUser
                        ? 'message-user px-3.5 py-2.5'
                        : 'message-assistant px-4 py-3'
                }`}
            >
                {/* Thinking/Reasoning section */}
                {displayReasoning && (
                    <div className="mb-2" ref={reasoningRef}>
                        <button
                            onClick={handleToggleReasoning}
                            className="flex items-center gap-1 text-dark-500 hover:text-dark-300 transition-colors"
                        >
                            <span className="text-[11px] font-medium">Thinking</span>
                            <span className="text-[10px] text-dark-600">({displayReasoning.length})</span>
                            {reasoningExpanded ? (
                                <ChevronUp className="w-3 h-3" />
                            ) : (
                                <ChevronDown className="w-3 h-3" />
                            )}
                        </button>
                        {reasoningExpanded && (
                            <div className="mt-1.5 p-2.5 rounded-md bg-white/[0.03] border border-white/[0.06] max-h-64 overflow-y-auto">
                                <p className="text-sm text-dark-400 italic whitespace-pre-wrap leading-relaxed">
                                    {displayReasoning}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* Collapse/expand toggle for the assistant message body.
                    Only shown on final (non-streaming) assistant messages
                    that actually have content. User messages always stay
                    expanded. */}
                {!isUser && !isStreaming && displayContent && (
                    <div className="flex items-center justify-end mb-1 -mt-0.5">
                        <button
                            onClick={() => setBodyCollapsed(v => !v)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] text-dark-500 hover:text-dark-200 hover:bg-white/[0.05] transition-colors"
                            title={bodyCollapsed ? 'Expand response' : 'Collapse response'}
                        >
                            {bodyCollapsed ? (
                                <>
                                    <Maximize2 className="w-3 h-3" />
                                    <span>Expand</span>
                                </>
                            ) : (
                                <>
                                    <Minimize2 className="w-3 h-3" />
                                    <span>Collapse</span>
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* Content */}
                {isStreaming && !displayContent ? (
                    // While streaming and no tokens have arrived yet, show
                    // the rolling-credits processing log in place of a mute
                    // spinner. Falls back to the legacy status indicator if
                    // no log entries exist yet (very brief window at turn
                    // start).
                    <div className="flex flex-col gap-1 min-w-[220px]">
                        {Array.isArray(processingLog) && processingLog.length > 0 ? (
                            <ProcessingLogFeed log={processingLog} />
                        ) : processingStatus ? (
                            <StatusIndicator status={processingStatus} message={processingMessage} />
                        ) : (
                            <ThinkingIndicator />
                        )}
                    </div>
                ) : bodyCollapsed ? (
                    // Collapsed: show a compact preview instead of the full
                    // markdown body so the message doesn't become an empty
                    // rectangle. Derives a one-line title from the first
                    // non-empty, non-markdown line of the response, and a
                    // character count. Clicking anywhere re-expands.
                    (() => {
                        // Strip fenced code blocks, headers, bullet markers,
                        // bold/italic, and inline code so the preview reads
                        // like plain prose rather than markdown source.
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
                                onClick={() => setBodyCollapsed(false)}
                                className="w-full text-left group transition-colors"
                            >
                                <div className="flex items-start gap-2 text-[12.5px]">
                                    <Maximize2 className="w-3 h-3 mt-0.5 flex-shrink-0 text-dark-500 group-hover:text-primary-400 transition-colors" />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-dark-200 group-hover:text-white truncate transition-colors">
                                            {preview || 'Collapsed response'}
                                        </div>
                                        <div className="text-[10.5px] text-dark-500 mt-0.5 group-hover:text-dark-400 transition-colors">
                                            {chars.toLocaleString()} character{chars === 1 ? '' : 's'} · click to expand
                                        </div>
                                    </div>
                                </div>
                            </button>
                        );
                    })()
                ) : (
                    <MessageContent content={displayContent} />
                )}

                {/* Web search source chips + tool-call blocks. Rendered
                    BELOW the response body so the hover preview on a source
                    chip has room above it to render without being clipped
                    by the viewport edge. Order: source chips first (they're
                    the primary provenance), then any additional tool calls
                    (url fetch, skills, etc) as compact status pills below. */}
                {!isUser && !isStreaming && !bodyCollapsed && Array.isArray(searchResults) && searchResults.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/[0.04]">
                        <SearchSources sources={searchResults} />
                    </div>
                )}

                {!isUser && !isStreaming && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.length > 0 && (
                    <div className="flex flex-wrap items-center mt-2 pt-2 border-t border-white/[0.04]">
                        {toolCalls.map((tc, idx) => (
                            <ToolCallBlock key={idx} tool={tc} />
                        ))}
                    </div>
                )}

                {/* Partial/interrupted response indicator */}
                {!isUser && !isStreaming && (needsContinuation || isPartial) && (
                    <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded-md bg-amber-500/8 border border-amber-500/15">
                        <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0" />
                        <span className="text-[11px] text-amber-300/80">
                            Response cut off
                        </span>
                    </div>
                )}

                {/* Actions (copy button + continue button) - always visible for assistant messages */}
                {!isUser && displayContent && !isStreaming && (
                    <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-white/[0.04]">
                        <div className="flex items-center gap-1.5">
                            {/* Continue button for partial responses */}
                            {(needsContinuation || isPartial) && onContinue && (
                                <button
                                    onClick={() => onContinue(id, content)}
                                    disabled={isLoading}
                                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                                        isLoading
                                            ? 'text-dark-500 bg-dark-800 cursor-not-allowed'
                                            : 'text-primary-300 bg-primary-500/15 hover:bg-primary-500/25 border border-primary-500/20'
                                    }`}
                                    title="Continue generating"
                                >
                                    <PlayCircle className={`w-3 h-3 ${isLoading ? 'animate-pulse' : ''}`} />
                                    <span>{isLoading ? 'Continuing...' : 'Continue'}</span>
                                </button>
                            )}
                        </div>
                        <button
                            onClick={handleCopy}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] transition-colors ${
                                copied
                                    ? 'text-green-400 bg-green-500/10'
                                    : 'text-dark-500 hover:text-dark-300 hover:bg-white/[0.04]'
                            }`}
                            title={copied ? 'Copied!' : 'Copy response'}
                        >
                            {copied ? (
                                <>
                                    <Check className="w-3 h-3" />
                                    <span>Copied</span>
                                </>
                            ) : (
                                <>
                                    <Copy className="w-3 h-3" />
                                    <span>Copy</span>
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

            {/* Timestamp and stats */}
            <div className="flex items-center gap-2 mt-0.5 px-1">
                {timestamp && (
                    <span className="text-[10px] text-dark-600">
                        {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}
                {!isUser && responseTime && (
                    <span className="flex items-center gap-0.5 text-[10px] text-dark-600">
                        <Clock className="w-2.5 h-2.5" />
                        {responseTime < 1000 ? `${responseTime}ms` : `${(responseTime / 1000).toFixed(1)}s`}
                    </span>
                )}
                {!isUser && tokenCount && (
                    <span className="flex items-center gap-0.5 text-[10px] text-dark-600">
                        <Zap className="w-2.5 h-2.5" />
                        {tokenCount}
                    </span>
                )}
            </div>
        </div>
    );
});
