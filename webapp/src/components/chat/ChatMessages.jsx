import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ChatMessage from './ChatMessage';

/**
 * ChatMessages - Scrollable message list with auto-scroll
 */
export default function ChatMessages({
    messages,
    isStreaming,
    streamingContent,
    streamingReasoning,
    onExportContent,
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
            <Box
                sx={{
                    flexGrow: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'text.secondary',
                    p: 4,
                }}
            >
                <Typography variant="h5" sx={{ mb: 1, color: 'text.primary' }}>
                    Start a conversation
                </Typography>
                <Typography variant="body2">
                    Type a message below to begin chatting with the AI
                </Typography>
            </Box>
        );
    }

    return (
        <Box
            ref={containerRef}
            onScroll={handleScroll}
            sx={{
                flexGrow: 1,
                overflow: 'auto',
                px: 4,
                py: 2,
                display: 'flex',
                flexDirection: 'column',
                '&::-webkit-scrollbar': {
                    width: '8px',
                },
                '&::-webkit-scrollbar-track': {
                    backgroundColor: 'transparent',
                },
                '&::-webkit-scrollbar-thumb': {
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    borderRadius: '4px',
                    '&:hover': {
                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                    },
                },
            }}
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
                    onExportContent={onExportContent}
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
                    onExportContent={onExportContent}
                />
            )}

            <div ref={messagesEndRef} />
        </Box>
    );
}
