import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';
import ChatMessage from './ChatMessage';
import StatusIndicator from './StatusIndicator';

/**
 * ChatMessages - Scrollable message list with auto-scroll (Tailwind)
 */
export default function ChatMessages({
    messages,
    isStreaming,
    streamingContent,
    streamingReasoning,
    processingStatus,
    processingMessage,
    onContinue,
    isLoading,
    chatStyle = 'default',
    messageBorderStrength = 10,
}) {
    const messagesEndRef = useRef(null);
    const containerRef = useRef(null);
    const [userHasScrolled, setUserHasScrolled] = useState(false);
    const prevMessagesLengthRef = useRef(messages.length);
    const prevStreamingRef = useRef(isStreaming);

    // Track if user manually scrolled up
    const handleScroll = () => {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
        setUserHasScrolled(!isNearBottom);
    };

    // Auto-scroll only when:
    // 1. New message is added (messages.length increases)
    // 2. Streaming just started
    // 3. User hasn't manually scrolled up
    useEffect(() => {
        const messagesLengthChanged = messages.length !== prevMessagesLengthRef.current;
        const streamingJustStarted = isStreaming && !prevStreamingRef.current;

        if ((messagesLengthChanged || streamingJustStarted) && !userHasScrolled) {
            if (messagesEndRef.current) {
                messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
            }
        }

        prevMessagesLengthRef.current = messages.length;
        prevStreamingRef.current = isStreaming;
    }, [messages.length, isStreaming, userHasScrolled]);

    // Reset scroll tracking when streaming ends
    useEffect(() => {
        if (!isStreaming) {
            setUserHasScrolled(false);
        }
    }, [isStreaming]);

    // Show empty state
    if (messages.length === 0 && !isStreaming) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-6">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary-500/15 to-accent-500/15 flex items-center justify-center mb-3">
                    <Sparkles className="w-5 h-5 text-primary-400/80" />
                </div>
                <h2 className="text-base font-medium text-dark-200 mb-1">Start a conversation</h2>
                <p className="text-dark-500 text-center text-sm max-w-xs">
                    Type a message below to begin
                </p>
            </div>
        );
    }

    // Get chat style class
    const chatStyleClass = chatStyle && chatStyle !== 'default' ? `chat-style-${chatStyle}` : '';

    return (
        <div
            ref={containerRef}
            onScroll={handleScroll}
            className={`flex-1 overflow-y-auto px-3 py-2 ${chatStyleClass}`}
            style={{ '--message-border-opacity': (messageBorderStrength || 10) / 100 }}
        >
            {/* Centered container for messages */}
            <div className="max-w-5xl mx-auto space-y-1">
            {messages.map((message, index) => (
                <ChatMessage
                    key={message.id || `msg-${index}-${message.timestamp || index}`}
                    id={message.id}
                    role={message.role}
                    content={message.content}
                    reasoning={message.reasoning}
                    timestamp={message.timestamp}
                    attachments={message.attachments}
                    isStreaming={false}
                    responseTime={message.responseTime}
                    tokenCount={message.tokenCount}
                    needsContinuation={message.needsContinuation}
                    isPartial={message.isPartial}
                    onContinue={onContinue}
                    isLoading={isLoading}
                />
            ))}

            {/* Streaming message with status indicator */}
            {isStreaming && (
                <ChatMessage
                    role="assistant"
                    content={streamingContent}
                    reasoning={streamingReasoning}
                    isStreaming={true}
                    streamingContent={streamingContent}
                    streamingReasoning={streamingReasoning}
                    processingStatus={processingStatus}
                    processingMessage={processingMessage}
                />
            )}

            <div ref={messagesEndRef} />
            </div>
        </div>
    );
}
