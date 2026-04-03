import React, { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { Highlight, themes } from 'prism-react-renderer';

/**
 * CodeBlock - Syntax-highlighted code block with copy functionality
 */
export default React.memo(function CodeBlock({ code, language = 'text' }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    // Map common language aliases
    const languageMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'rb': 'ruby',
        'sh': 'bash',
        'shell': 'bash',
        'yml': 'yaml',
        'md': 'markdown',
    };

    const normalizedLanguage = languageMap[language?.toLowerCase()] || language?.toLowerCase() || 'text';

    return (
        <Box
            sx={{
                position: 'relative',
                my: 2,
                borderRadius: '8px',
                overflow: 'hidden',
                backgroundColor: '#1e1e2e',
                border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
        >
            {/* Header with language and copy button */}
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    px: 2,
                    py: 0.75,
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                }}
            >
                <Typography
                    variant="caption"
                    sx={{
                        color: 'text.secondary',
                        textTransform: 'uppercase',
                        fontWeight: 500,
                        letterSpacing: '0.05em',
                    }}
                >
                    {normalizedLanguage}
                </Typography>
                <Tooltip title={copied ? 'Copied!' : 'Copy code'}>
                    <IconButton
                        size="small"
                        onClick={handleCopy}
                        sx={{
                            color: copied ? 'success.main' : 'text.secondary',
                            '&:hover': {
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            },
                        }}
                    >
                        {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                    </IconButton>
                </Tooltip>
            </Box>

            {/* Code content */}
            <Highlight theme={themes.nightOwl} code={code.trim()} language={normalizedLanguage}>
                {({ className, style, tokens, getLineProps, getTokenProps }) => (
                    <Box
                        component="pre"
                        sx={{
                            ...style,
                            margin: 0,
                            padding: '16px',
                            overflow: 'auto',
                            fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
                            fontSize: '0.8125rem',
                            lineHeight: 1.6,
                            backgroundColor: 'transparent',
                        }}
                    >
                        {tokens.map((line, i) => (
                            <div key={i} {...getLineProps({ line })}>
                                <Box
                                    component="span"
                                    sx={{
                                        display: 'inline-block',
                                        width: '2em',
                                        textAlign: 'right',
                                        pr: 2,
                                        color: 'rgba(255, 255, 255, 0.3)',
                                        userSelect: 'none',
                                    }}
                                >
                                    {i + 1}
                                </Box>
                                {line.map((token, key) => (
                                    <span key={key} {...getTokenProps({ token })} />
                                ))}
                            </div>
                        ))}
                    </Box>
                )}
            </Highlight>
        </Box>
    );
});
