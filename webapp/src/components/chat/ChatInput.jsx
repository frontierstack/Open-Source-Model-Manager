import React, { useState, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import SendIcon from '@mui/icons-material/Send';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import StopIcon from '@mui/icons-material/Stop';
import CloseIcon from '@mui/icons-material/Close';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import ImageIcon from '@mui/icons-material/Image';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import LanguageIcon from '@mui/icons-material/Language';

/**
 * ChatInput - Message input with file attachments and web search toggle
 */
export default function ChatInput({
    onSend,
    onStop,
    isStreaming,
    disabled,
    attachments = [],
    onAddAttachment,
    onRemoveAttachment,
    webSearchEnabled = false,
    onWebSearchToggle,
}) {
    const [message, setMessage] = useState('');
    const [isDragOver, setIsDragOver] = useState(false);
    const fileInputRef = useRef(null);
    const textFieldRef = useRef(null);

    // Accept all file types (no restrictions)
    const supportedTypes = {
        all: ['*']
    };

    const handleSend = () => {
        if (message.trim() || attachments.length > 0) {
            onSend(message.trim(), attachments);
            setMessage('');
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isStreaming && !disabled) {
                handleSend();
            }
        }
    };

    const handleFileSelect = useCallback(async (files) => {
        if (!files || files.length === 0) return;

        for (const file of Array.from(files)) {
            // Accept all file types
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64 = e.target.result.split(',')[1];

                try {
                    const response = await fetch('/api/chat/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            filename: file.name,
                            content: base64,
                            mimeType: file.type,
                        }),
                    });

                    if (response.ok) {
                        const data = await response.json();
                        onAddAttachment({
                            id: crypto.randomUUID(),
                            filename: file.name,
                            type: data.type,
                            content: data.content,
                            dataUrl: data.dataUrl,
                            charCount: data.charCount,
                            pageCount: data.pageCount,
                        });
                    }
                } catch (error) {
                    console.error('File upload error:', error);
                }
            };
            reader.readAsDataURL(file);
        }
    }, [onAddAttachment]);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileSelect(e.dataTransfer.files);
        }
    }, [handleFileSelect]);

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
    };

    const handleFileInputChange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleFileSelect(e.target.files);
        }
        e.target.value = '';
    };

    const getFileIcon = (type) => {
        switch (type) {
            case 'image':
                return <ImageIcon sx={{ fontSize: 14 }} />;
            case 'pdf':
                return <PictureAsPdfIcon sx={{ fontSize: 14 }} />;
            default:
                return <InsertDriveFileIcon sx={{ fontSize: 14 }} />;
        }
    };

    return (
        <Box
            sx={{
                p: { xs: 1, sm: 1.5 },
                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                backgroundColor: 'background.paper',
            }}
        >
            {/* Attachments preview */}
            {attachments.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                    {attachments.map((att, index) => (
                        <Chip
                            key={att.id || index}
                            icon={getFileIcon(att.type)}
                            label={`${att.filename}${att.charCount ? ` (${(att.charCount / 1000).toFixed(1)}k)` : ''}`}
                            size="small"
                            onDelete={() => onRemoveAttachment(index)}
                            deleteIcon={<CloseIcon sx={{ fontSize: 14 }} />}
                            sx={{
                                height: 22,
                                fontSize: '0.75rem',
                                backgroundColor: 'rgba(167, 139, 250, 0.1)',
                                border: '1px solid rgba(167, 139, 250, 0.3)',
                                '& .MuiChip-label': {
                                    maxWidth: 120,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                },
                            }}
                        />
                    ))}
                </Box>
            )}

            {/* Input area */}
            <Box
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                sx={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 0.5,
                    p: 0.75,
                    borderRadius: '10px',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: isDragOver
                        ? '2px dashed rgba(167, 139, 250, 0.5)'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                    transition: 'all 0.2s',
                    position: 'relative',
                }}
            >
                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="*/*"
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                />

                {/* Attach button */}
                <Tooltip title="Attach files">
                    <IconButton
                        size="small"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={disabled || isStreaming}
                        sx={{ color: 'text.secondary', p: 0.75 }}
                    >
                        <AttachFileIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                </Tooltip>

                {/* Web search toggle */}
                {onWebSearchToggle && (
                    <Tooltip title={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}>
                        <IconButton
                            size="small"
                            onClick={onWebSearchToggle}
                            disabled={disabled || isStreaming}
                            sx={{
                                p: 0.75,
                                color: webSearchEnabled ? 'secondary.main' : 'text.secondary',
                                backgroundColor: webSearchEnabled ? 'rgba(34, 211, 238, 0.1)' : 'transparent',
                                '&:hover': {
                                    backgroundColor: webSearchEnabled ? 'rgba(34, 211, 238, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                                },
                            }}
                        >
                            <LanguageIcon sx={{ fontSize: 20 }} />
                        </IconButton>
                    </Tooltip>
                )}

                {/* Text input */}
                <TextField
                    ref={textFieldRef}
                    fullWidth
                    multiline
                    maxRows={6}
                    placeholder={isDragOver ? 'Drop files here...' : 'Type a message...'}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    variant="standard"
                    InputProps={{
                        disableUnderline: true,
                        sx: {
                            fontSize: '0.9375rem',
                            lineHeight: 1.5,
                            minHeight: 32,
                            '& textarea': {
                                '&::placeholder': {
                                    color: 'text.secondary',
                                    opacity: 0.6,
                                },
                            },
                        },
                    }}
                    sx={{
                        '& .MuiInputBase-root': {
                            padding: '4px 6px',
                        },
                    }}
                />

                {/* Send/Stop button */}
                {isStreaming ? (
                    <Tooltip title="Stop generating">
                        <IconButton
                            size="small"
                            onClick={onStop}
                            sx={{
                                p: 0.75,
                                color: 'error.main',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                '&:hover': {
                                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                                },
                            }}
                        >
                            <StopIcon sx={{ fontSize: 20 }} />
                        </IconButton>
                    </Tooltip>
                ) : (
                    <Tooltip title="Send message">
                        <span>
                            <IconButton
                                size="small"
                                onClick={handleSend}
                                disabled={disabled || (!message.trim() && attachments.length === 0)}
                                sx={{
                                    p: 0.75,
                                    backgroundColor: 'primary.main',
                                    color: 'white',
                                    '&:hover': {
                                        backgroundColor: 'primary.dark',
                                    },
                                    '&.Mui-disabled': {
                                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                        color: 'rgba(255, 255, 255, 0.3)',
                                    },
                                }}
                            >
                                <SendIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                        </span>
                    </Tooltip>
                )}

                {/* Drag overlay */}
                {isDragOver && (
                    <Box
                        sx={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(0, 0, 0, 0.7)',
                            borderRadius: '10px',
                            pointerEvents: 'none',
                        }}
                    >
                        <Typography variant="body2" color="primary.light">
                            Drop files to attach
                        </Typography>
                    </Box>
                )}
            </Box>

            {/* Hint text with web search indicator */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 0.5, px: 0.5 }}>
                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                    {webSearchEnabled && (
                        <Chip
                            icon={<LanguageIcon sx={{ fontSize: '12px !important' }} />}
                            label="Web Search"
                            size="small"
                            sx={{
                                height: 18,
                                fontSize: '0.65rem',
                                backgroundColor: 'rgba(34, 211, 238, 0.1)',
                                color: 'secondary.main',
                                '& .MuiChip-icon': {
                                    color: 'secondary.main',
                                },
                            }}
                        />
                    )}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                    Shift+Enter for new line
                </Typography>
            </Box>
        </Box>
    );
}
