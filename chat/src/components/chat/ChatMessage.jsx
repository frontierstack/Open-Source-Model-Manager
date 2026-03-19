import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Clock, Zap, PlayCircle, AlertCircle } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';
import StatusIndicator from './StatusIndicator';

/**
 * ChatMessage - Individual chat message bubble (Tailwind)
 */
export default function ChatMessage({
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
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
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
        <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4 max-w-full animate-fade-in`}>
            {/* File attachments for user messages */}
            {isUser && attachments && attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2 max-w-[85%] justify-end">
                    {attachments.map((att, i) => (
                        <div
                            key={i}
                            className="px-2.5 py-1 rounded-lg bg-primary-500/20 border border-primary-500/30"
                        >
                            <span className="text-xs text-primary-300">
                                {att.filename || att.name}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* Message bubble */}
            <div
                className={`group relative min-w-[80px] ${
                    isUser
                        ? 'message-user max-w-[75%] px-4 py-3'
                        : 'message-assistant max-w-[90%] px-5 py-4'
                }`}
            >
                {/* Thinking/Reasoning section */}
                {displayReasoning && (
                    <div className="mb-3" ref={reasoningRef}>
                        <button
                            onClick={handleToggleReasoning}
                            className="flex items-center gap-1.5 text-dark-400 hover:text-dark-200 transition-colors"
                        >
                            <span className="text-xs font-medium">Thinking</span>
                            <span className="text-xs text-dark-500">({displayReasoning.length} chars)</span>
                            {reasoningExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                            )}
                        </button>
                        {reasoningExpanded && (
                            <div className="mt-2 p-3 rounded-lg bg-white/5 border border-white/10 max-h-64 overflow-y-auto">
                                <p className="text-sm text-dark-400 italic whitespace-pre-wrap">
                                    {displayReasoning}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* Content */}
                {isStreaming && !displayContent ? (
                    <div className="flex items-center gap-2">
                        {processingStatus ? (
                            <StatusIndicator status={processingStatus} message={processingMessage} />
                        ) : (
                            <ThinkingIndicator />
                        )}
                    </div>
                ) : (
                    <MessageContent content={displayContent} />
                )}

                {/* Partial/interrupted response indicator */}
                {!isUser && !isStreaming && (needsContinuation || isPartial) && (
                    <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                        <span className="text-xs text-amber-300">
                            Response was cut off due to length limit
                        </span>
                    </div>
                )}

                {/* Actions (copy button + continue button) - always visible for assistant messages */}
                {!isUser && displayContent && !isStreaming && (
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
                        <div className="flex items-center gap-2">
                            {/* Continue button for partial responses */}
                            {(needsContinuation || isPartial) && onContinue && (
                                <button
                                    onClick={() => onContinue(id, content)}
                                    disabled={isLoading}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                        isLoading
                                            ? 'text-dark-500 bg-dark-800 cursor-not-allowed'
                                            : 'text-primary-300 bg-primary-500/20 hover:bg-primary-500/30 border border-primary-500/30'
                                    }`}
                                    title="Continue generating from where it left off"
                                >
                                    <PlayCircle className={`w-4 h-4 ${isLoading ? 'animate-pulse' : ''}`} />
                                    <span>{isLoading ? 'Continuing...' : 'Continue'}</span>
                                </button>
                            )}
                        </div>
                        <button
                            onClick={handleCopy}
                            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                                copied
                                    ? 'text-green-400 bg-green-500/10'
                                    : 'text-dark-400 hover:text-dark-200 hover:bg-white/5'
                            }`}
                            title={copied ? 'Copied!' : 'Copy response'}
                        >
                            {copied ? (
                                <>
                                    <Check className="w-3.5 h-3.5" />
                                    <span>Copied</span>
                                </>
                            ) : (
                                <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span>Copy</span>
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

            {/* Timestamp and stats */}
            <div className="flex items-center gap-3 mt-1">
                {timestamp && (
                    <span className="text-xs text-dark-500">
                        {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}
                {/* Response time */}
                {!isUser && responseTime && (
                    <span className="flex items-center gap-1 text-xs text-dark-500">
                        <Clock className="w-3 h-3" />
                        {responseTime < 1000 ? `${responseTime}ms` : `${(responseTime / 1000).toFixed(1)}s`}
                    </span>
                )}
                {/* Token count */}
                {!isUser && tokenCount && (
                    <span className="flex items-center gap-1 text-xs text-dark-500">
                        <Zap className="w-3 h-3" />
                        {tokenCount} tokens
                    </span>
                )}
            </div>
        </div>
    );
}
