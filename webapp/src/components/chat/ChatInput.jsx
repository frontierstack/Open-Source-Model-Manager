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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

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
    onUploadError,
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

        const fileArray = Array.from(files);

        // Helper: read file as base64 (promisified FileReader)
        const readAsBase64 = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result.split(',')[1]);
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
        });

        // Helper: upload a single file with one retry on 401/5xx
        const uploadFile = async (base64, file) => {
            const doFetch = () => fetch('/api/chat/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    filename: file.name,
                    content: base64,
                    mimeType: file.type,
                }),
            });

            let response = await doFetch();

            // Retry once on 401 (session race) or 5xx (transient server error)
            if (response.status === 401 || response.status >= 500) {
                await new Promise(r => setTimeout(r, 500));
                response = await doFetch();
            }

            return response;
        };

        // Process files sequentially to avoid session race conditions
        let failedFiles = [];
        for (const file of fileArray) {
            try {
                const base64 = await readAsBase64(file);
                const response = await uploadFile(base64, file);

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
                        estimatedTokens: data.estimatedTokens,
                        requiresChunking: data.requiresChunking,
                        totalChunks: data.totalChunks,
                        ocrPerformed: data.ocrPerformed,
                    });
                } else {
                    const errBody = await response.json().catch(() => ({}));
                    const reason = errBody.error || `HTTP ${response.status}`;
                    console.error(`Upload failed for ${file.name}: ${reason}`);
                    failedFiles.push(file.name);
                }
            } catch (error) {
                console.error(`File upload error for ${file.name}:`, error);
                failedFiles.push(file.name);
            }
        }

        // Report failures to the user
        if (failedFiles.length > 0 && onUploadError) {
            const msg = failedFiles.length === 1
                ? `Failed to upload: ${failedFiles[0]}`
                : `Failed to upload ${failedFiles.length} files: ${failedFiles.join(', ')}`;
            onUploadError(msg);
        }
    }, [onAddAttachment, onUploadError]);

    // Convert large pasted text or clipboard images into file attachments
    const PASTE_AS_FILE_THRESHOLD = 500; // characters
    const handlePaste = useCallback(async (e) => {
        // Handle image/file paste from clipboard (e.g. screenshots, copied images)
        if (e.clipboardData?.files?.length > 0) {
            const files = Array.from(e.clipboardData.files);
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length > 0) {
                e.preventDefault();
                handleFileSelect(imageFiles);
                return;
            }
        }

        // Large text paste → convert to file attachment
        const pastedText = e.clipboardData?.getData('text/plain');
        if (!pastedText || pastedText.length < PASTE_AS_FILE_THRESHOLD) return;

        e.preventDefault();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `pasted-text-${timestamp}.txt`;
        const base64 = btoa(unescape(encodeURIComponent(pastedText)));

        try {
            const response = await fetch('/api/chat/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    filename,
                    content: base64,
                    mimeType: 'text/plain',
                }),
            });

            if (response.ok) {
                const data = await response.json();
                onAddAttachment({
                    id: crypto.randomUUID(),
                    filename,
                    size: pastedText.length,
                    type: data.type,
                    content: data.content,
                    charCount: data.charCount,
                    estimatedTokens: data.estimatedTokens,
                    requiresChunking: data.requiresChunking,
                    totalChunks: data.totalChunks,
                });
            }
        } catch (error) {
            console.error('Paste-as-file upload error:', error);
        }
    }, [onAddAttachment, handleFileSelect]);

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
                    {attachments.map((att, index) => {
                        // Build label with size info
                        let label = att.filename;
                        if (att.charCount) {
                            const sizeStr = att.charCount >= 1000
                                ? `${(att.charCount / 1000).toFixed(1)}k`
                                : `${att.charCount}`;
                            label += ` (${sizeStr})`;
                        }
                        if (att.requiresChunking) {
                            label += ` [${att.totalChunks} chunks]`;
                        }
                        if (att.ocrPerformed) {
                            label += ' [OCR]';
                        }

                        const isLarge = att.requiresChunking || (att.estimatedTokens && att.estimatedTokens > 8000);

                        return (
                            <Tooltip
                                key={att.id || index}
                                title={isLarge
                                    ? `Large file (~${att.estimatedTokens?.toLocaleString() || '?'} tokens). Will be chunked to fit context window.`
                                    : att.ocrPerformed
                                        ? 'Text extracted via OCR from scanned document'
                                        : ''
                                }
                            >
                                <Chip
                                    icon={isLarge ? <WarningAmberIcon sx={{ fontSize: 14, color: 'warning.main' }} /> : getFileIcon(att.type)}
                                    label={label}
                                    size="small"
                                    onDelete={() => onRemoveAttachment(index)}
                                    deleteIcon={<CloseIcon sx={{ fontSize: 14 }} />}
                                    sx={{
                                        height: 22,
                                        fontSize: '0.75rem',
                                        backgroundColor: isLarge
                                            ? 'rgba(245, 158, 11, 0.1)'
                                            : 'rgba(99, 102, 241, 0.1)',
                                        border: isLarge
                                            ? '1px solid rgba(245, 158, 11, 0.3)'
                                            : '1px solid rgba(99, 102, 241, 0.3)',
                                        '& .MuiChip-label': {
                                            maxWidth: 180,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                        },
                                    }}
                                />
                            </Tooltip>
                        );
                    })}
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
                        ? '2px dashed rgba(99, 102, 241, 0.5)'
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
                                backgroundColor: webSearchEnabled ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                                '&:hover': {
                                    backgroundColor: webSearchEnabled ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.08)',
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
                    onPaste={handlePaste}
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
                                backgroundColor: 'rgba(99, 102, 241, 0.1)',
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
