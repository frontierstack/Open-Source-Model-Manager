import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
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
    processingLog,
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

    // Empty state handled by ChatContainer for centered layout
    if (messages.length === 0 && !isStreaming) {
        return null;
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
            {/* Centered container for messages. Width must match the
                 ChatInput inner wrapper (`max-w-4xl mx-auto`) so the
                 input sits on exactly the same horizontal column as the
                 responses. On narrow viewports where max-w-5xl would
                 overflow the parent, using the smaller max-w-4xl also
                 guarantees that `mx-auto` actually has margin to work
                 with, avoiding the drift the user reported. */}
            <div className="max-w-4xl mx-auto min-w-0 space-y-1">
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
                    toolCalls={message.toolCalls}
                    searchResults={message.searchResults}
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
                    processingLog={processingLog}
                />
            )}

            <div ref={messagesEndRef} />
            </div>
        </div>
    );
}
