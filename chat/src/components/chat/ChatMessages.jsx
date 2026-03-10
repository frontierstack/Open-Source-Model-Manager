import React, { useEffect, useRef } from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';
import ChatMessage from './ChatMessage';

/**
 * ChatMessages - Scrollable message list with auto-scroll (Tailwind)
 */
export default function ChatMessages({
    messages,
    isStreaming,
    streamingContent,
    streamingReasoning,
}) {
    const messagesEndRef = useRef(null);
    const containerRef = useRef(null);

    // Auto-scroll to bottom when messages change or during streaming
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, streamingContent, streamingReasoning]);

    // Show empty state
    if (messages.length === 0 && !isStreaming) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-8">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500/20 to-accent-500/20 flex items-center justify-center mb-4">
                    <Sparkles className="w-8 h-8 text-primary-400" />
                </div>
                <h2 className="text-xl font-semibold text-dark-100 mb-2">Start a conversation</h2>
                <p className="text-dark-400 text-center max-w-sm">
                    Type a message below to begin chatting with the AI. You can also attach files for context.
                </p>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        >
            {messages.map((message, index) => (
                <ChatMessage
                    key={message.id || index}
                    role={message.role}
                    content={message.content}
                    reasoning={message.reasoning}
                    timestamp={message.timestamp}
                    attachments={message.attachments}
                    isStreaming={false}
                />
            ))}

            {/* Streaming message */}
            {isStreaming && (
                <ChatMessage
                    role="assistant"
                    content={streamingContent}
                    reasoning={streamingReasoning}
                    isStreaming={true}
                    streamingContent={streamingContent}
                    streamingReasoning={streamingReasoning}
                />
            )}

            <div ref={messagesEndRef} />
        </div>
    );
}
