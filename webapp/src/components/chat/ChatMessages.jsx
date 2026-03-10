import React, { useEffect, useRef } from 'react';
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

    // Auto-scroll to bottom when messages change or during streaming
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, streamingContent, streamingReasoning]);

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
            sx={{
                flexGrow: 1,
                overflow: 'auto',
                px: 3,
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
