import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import ChatMessage from './ChatMessage';
import { useChatStore } from '../../stores/useChatStore';

/**
 * StreamingMessage — reads streaming content directly from the Zustand store
 * via selectors so that only THIS component re-renders on each token, not the
 * entire ChatContainer → ChatMessages prop chain.
 */
function StreamingMessage() {
    const streamingContent = useChatStore(state => state.streamingContent);
    const streamingReasoning = useChatStore(state => state.streamingReasoning);
    const processingStatus = useChatStore(state => state.processingStatus);
    const processingMessage = useChatStore(state => state.processingMessage);
    const processingLog = useChatStore(state => state.processingLog);

    return (
        <ChatMessage
            key="streaming-message"
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
    );
}

/**
 * ChatMessages - Scrollable message list with auto-scroll (Tailwind)
 *
 * Wrapped in React.memo — only re-renders when messages, isStreaming, or
 * layout props change. Streaming content updates bypass this component
 * entirely (StreamingMessage reads from the store directly).
 */
const ChatMessages = React.memo(function ChatMessages({
    messages,
    isStreaming,
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

            {/* Streaming message — reads content from store directly */}
            {isStreaming && <StreamingMessage />}

            <div ref={messagesEndRef} />
            </div>
        </div>
    );
});

export default ChatMessages;
