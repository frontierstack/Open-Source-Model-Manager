import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Brain } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';

/**
 * ChatMessage - Individual chat message bubble (Tailwind)
 */
export default function ChatMessage({
    role,
    content,
    reasoning,
    timestamp,
    attachments,
    isStreaming,
    streamingContent,
    streamingReasoning,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);

    const isUser = role === 'user';
    const displayContent = isStreaming ? streamingContent : content;
    const displayReasoning = isStreaming ? streamingReasoning : reasoning;

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
                className={`group relative max-w-[85%] min-w-[80px] px-4 py-3 ${
                    isUser
                        ? 'message-user'
                        : 'message-assistant'
                }`}
            >
                {/* Thinking/Reasoning section */}
                {displayReasoning && (
                    <div className="mb-3">
                        <button
                            onClick={() => setReasoningExpanded(!reasoningExpanded)}
                            className="flex items-center gap-1.5 text-dark-400 hover:text-dark-200 transition-colors"
                        >
                            <Brain className="w-4 h-4" />
                            <span className="text-xs font-medium">Thinking</span>
                            {reasoningExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                            )}
                        </button>
                        {reasoningExpanded && (
                            <div className="mt-2 p-3 rounded-lg bg-white/5 border border-white/10">
                                <p className="text-sm text-dark-400 italic whitespace-pre-wrap">
                                    {displayReasoning}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* Content */}
                {isStreaming && !displayContent ? (
                    <ThinkingIndicator />
                ) : (
                    <MessageContent content={displayContent} />
                )}

                {/* Actions (copy button) */}
                {!isUser && displayContent && (
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                            onClick={handleCopy}
                            className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${
                                copied ? 'text-green-400' : 'text-dark-400 hover:text-dark-200'
                            }`}
                            title={copied ? 'Copied!' : 'Copy'}
                        >
                            {copied ? (
                                <Check className="w-4 h-4" />
                            ) : (
                                <Copy className="w-4 h-4" />
                            )}
                        </button>
                    </div>
                )}
            </div>

            {/* Timestamp */}
            {timestamp && (
                <span className="mt-1 text-xs text-dark-500">
                    {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
            )}
        </div>
    );
}
