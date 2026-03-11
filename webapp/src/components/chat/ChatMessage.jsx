import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import PsychologyIcon from '@mui/icons-material/Psychology';
import DownloadIcon from '@mui/icons-material/Download';
import DescriptionIcon from '@mui/icons-material/Description';
import CodeIcon from '@mui/icons-material/Code';
import TableChartIcon from '@mui/icons-material/TableChart';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';

/**
 * ChatMessage - Individual chat message bubble with export support
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
    onExportContent,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
    const [exportMenuAnchor, setExportMenuAnchor] = useState(null);

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

    // Detect exportable content types
    const detectExportableContent = () => {
        if (!displayContent) return [];
        const exports = [];

        // Check for code blocks
        const codeBlockMatch = displayContent.match(/```(\w+)?\n([\s\S]*?)```/);
        if (codeBlockMatch) {
            const lang = codeBlockMatch[1] || 'txt';
            exports.push({
                type: 'code',
                label: `Code (${lang})`,
                extension: lang === 'javascript' ? 'js' : lang === 'typescript' ? 'ts' : lang === 'python' ? 'py' : lang,
                content: codeBlockMatch[2].trim(),
            });
        }

        // Check for CSV-like content
        const csvMatch = displayContent.match(/```csv\n([\s\S]*?)```/) ||
            (displayContent.includes(',') && displayContent.split('\n').length > 2 &&
                displayContent.split('\n').every(line => line.split(',').length > 1));
        if (csvMatch || (displayContent.includes(',') && displayContent.split('\n').filter(l => l.trim()).length > 2)) {
            const csvContent = csvMatch ? csvMatch[1] : displayContent;
            if (csvContent.split('\n').filter(l => l.trim()).length > 1) {
                exports.push({
                    type: 'csv',
                    label: 'CSV Data',
                    extension: 'csv',
                    content: csvContent.trim(),
                });
            }
        }

        // Check for JSON content
        const jsonMatch = displayContent.match(/```json\n([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                JSON.parse(jsonMatch[1]);
                exports.push({
                    type: 'json',
                    label: 'JSON Data',
                    extension: 'json',
                    content: jsonMatch[1].trim(),
                });
            } catch (e) {
                // Not valid JSON
            }
        }

        // Always offer text export
        exports.push({
            type: 'text',
            label: 'Plain Text',
            extension: 'txt',
            content: displayContent,
        });

        // Offer markdown export
        exports.push({
            type: 'markdown',
            label: 'Markdown',
            extension: 'md',
            content: displayContent,
        });

        return exports;
    };

    const handleExport = (exportOption) => {
        setExportMenuAnchor(null);
        if (onExportContent) {
            onExportContent(exportOption.content, exportOption.extension, `export.${exportOption.extension}`);
        }
    };

    const exportOptions = detectExportableContent();

    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                mb: 1.5,
                maxWidth: '100%',
                px: isUser ? 0 : 4,
            }}
        >
            {/* File attachments for user messages */}
            {isUser && attachments && attachments.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 0.5, maxWidth: '85%', justifyContent: 'flex-end' }}>
                    {attachments.map((att, i) => (
                        <Box
                            key={i}
                            sx={{
                                px: 1,
                                py: 0.5,
                                borderRadius: '6px',
                                backgroundColor: 'rgba(99, 102, 241, 0.2)',
                                border: '1px solid rgba(99, 102, 241, 0.3)',
                            }}
                        >
                            <Typography variant="caption" sx={{ color: 'primary.light', fontSize: '0.7rem' }}>
                                {att.filename || att.name}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}

            {/* Message bubble */}
            <Box
                sx={{
                    maxWidth: { xs: '95%', sm: '90%', md: '80%' },
                    minWidth: '60px',
                    position: 'relative',
                    borderRadius: isUser
                        ? '14px 14px 4px 14px'
                        : '14px 14px 14px 4px',
                    px: 2,
                    py: 1.5,
                    background: isUser
                        ? 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)'
                        : 'rgba(255, 255, 255, 0.05)',
                    border: isUser
                        ? 'none'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                    color: 'text.primary',
                    '&:hover .message-actions': {
                        opacity: 1,
                    },
                }}
            >
                {/* Thinking/Reasoning section */}
                {displayReasoning && (
                    <Box sx={{ mb: 0.75 }}>
                        <Box
                            onClick={() => setReasoningExpanded(!reasoningExpanded)}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.75,
                                cursor: 'pointer',
                                color: 'text.secondary',
                                '&:hover': {
                                    color: 'text.primary',
                                },
                            }}
                        >
                            <PsychologyIcon sx={{ fontSize: 16 }} />
                            <Typography variant="caption" sx={{ fontWeight: 500, fontSize: '0.7rem' }}>
                                Thinking
                            </Typography>
                            {reasoningExpanded ? (
                                <ExpandLessIcon sx={{ fontSize: 14 }} />
                            ) : (
                                <ExpandMoreIcon sx={{ fontSize: 14 }} />
                            )}
                        </Box>
                        <Collapse in={reasoningExpanded}>
                            <Box
                                sx={{
                                    mt: 0.75,
                                    p: 1,
                                    borderRadius: '6px',
                                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                }}
                            >
                                <Typography
                                    variant="body2"
                                    sx={{
                                        color: 'text.secondary',
                                        fontStyle: 'italic',
                                        whiteSpace: 'pre-wrap',
                                        fontSize: '0.8rem',
                                    }}
                                >
                                    {displayReasoning}
                                </Typography>
                            </Box>
                        </Collapse>
                    </Box>
                )}

                {/* Content */}
                {isStreaming && !displayContent ? (
                    <ThinkingIndicator />
                ) : (
                    <MessageContent content={displayContent} />
                )}

                {/* Actions (copy and export buttons) */}
                {!isUser && displayContent && (
                    <Box
                        className="message-actions"
                        sx={{
                            position: 'absolute',
                            bottom: 6,
                            right: 6,
                            opacity: 0,
                            transition: 'opacity 0.2s',
                            display: 'flex',
                            gap: 0.25,
                        }}
                    >
                        <Tooltip title={copied ? 'Copied!' : 'Copy'}>
                            <IconButton
                                size="small"
                                onClick={handleCopy}
                                sx={{
                                    p: 0.5,
                                    color: copied ? 'success.main' : 'text.secondary',
                                    '&:hover': {
                                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                    },
                                }}
                            >
                                {copied ? (
                                    <CheckIcon sx={{ fontSize: 14 }} />
                                ) : (
                                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                                )}
                            </IconButton>
                        </Tooltip>
                        {onExportContent && (
                            <Tooltip title="Export">
                                <IconButton
                                    size="small"
                                    onClick={(e) => setExportMenuAnchor(e.currentTarget)}
                                    sx={{
                                        p: 0.5,
                                        color: 'text.secondary',
                                        '&:hover': {
                                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                        },
                                    }}
                                >
                                    <DownloadIcon sx={{ fontSize: 14 }} />
                                </IconButton>
                            </Tooltip>
                        )}
                    </Box>
                )}
            </Box>

            {/* Export Menu */}
            <Menu
                anchorEl={exportMenuAnchor}
                open={Boolean(exportMenuAnchor)}
                onClose={() => setExportMenuAnchor(null)}
                PaperProps={{
                    sx: {
                        backgroundColor: 'background.paper',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                    },
                }}
            >
                {exportOptions.map((option, index) => (
                    <MenuItem
                        key={index}
                        onClick={() => handleExport(option)}
                        sx={{ py: 0.75 }}
                    >
                        <ListItemIcon sx={{ minWidth: 32 }}>
                            {option.type === 'code' ? <CodeIcon sx={{ fontSize: 16 }} /> :
                                option.type === 'csv' ? <TableChartIcon sx={{ fontSize: 16 }} /> :
                                    <DescriptionIcon sx={{ fontSize: 16 }} />}
                        </ListItemIcon>
                        <ListItemText
                            primary={option.label}
                            primaryTypographyProps={{ fontSize: '0.8rem' }}
                        />
                    </MenuItem>
                ))}
            </Menu>

            {/* Timestamp */}
            {timestamp && (
                <Typography
                    variant="caption"
                    sx={{
                        mt: 0.25,
                        color: 'text.secondary',
                        opacity: 0.5,
                        fontSize: '0.65rem',
                    }}
                >
                    {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Typography>
            )}
        </Box>
    );
}
