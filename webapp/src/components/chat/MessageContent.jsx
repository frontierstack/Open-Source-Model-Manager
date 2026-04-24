import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Link from '@mui/material/Link';
import CodeBlock from './CodeBlock';

// Repair GFM tables emitted on a single line. Models occasionally produce
// `| H1 | H2 | | :--- | :--- | | a | b |` with no row breaks, which
// remark-gfm then renders as literal text. If a line contains the GFM
// separator pattern (`| :--- |` / `| --- |`), split on row boundaries
// (`| |` with optional whitespace) to restore a parseable table.
function repairInlineTables(md) {
    if (!md || !md.includes('|')) return md;
    return md.split('\n').map((line) => {
        if (!/\|\s*:?-{3,}:?\s*\|/.test(line)) return line;
        return line.replace(/\s*\|\s*\|\s*/g, ' |\n| ');
    }).join('\n');
}

/**
 * MessageContent - Renders markdown content with proper styling
 */
export default React.memo(function MessageContent({ content }) {
    if (!content) return null;

    const processed = repairInlineTables(content);

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                // Code blocks
                code({ node, inline, className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const code = String(children).replace(/\n$/, '');

                    if (!inline && (match || code.includes('\n'))) {
                        return (
                            <CodeBlock
                                code={code}
                                language={match ? match[1] : 'text'}
                            />
                        );
                    }

                    // Inline code
                    return (
                        <Box
                            component="code"
                            sx={{
                                px: 0.75,
                                py: 0.25,
                                mx: 0.25,
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '4px',
                                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                                fontSize: '0.85em',
                            }}
                            {...props}
                        >
                            {children}
                        </Box>
                    );
                },

                // Paragraphs
                p({ children }) {
                    return (
                        <Typography
                            component="p"
                            sx={{
                                mb: 1.5,
                                lineHeight: 1.7,
                                '&:last-child': { mb: 0 },
                            }}
                        >
                            {children}
                        </Typography>
                    );
                },

                // Headings
                h1({ children }) {
                    return (
                        <Typography variant="h5" sx={{ mt: 2, mb: 1, fontWeight: 600 }}>
                            {children}
                        </Typography>
                    );
                },
                h2({ children }) {
                    return (
                        <Typography variant="h6" sx={{ mt: 2, mb: 1, fontWeight: 600 }}>
                            {children}
                        </Typography>
                    );
                },
                h3({ children }) {
                    return (
                        <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5, fontWeight: 600 }}>
                            {children}
                        </Typography>
                    );
                },

                // Links
                a({ href, children }) {
                    return (
                        <Link
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{
                                color: 'primary.light',
                                textDecoration: 'none',
                                '&:hover': {
                                    textDecoration: 'underline',
                                },
                            }}
                        >
                            {children}
                        </Link>
                    );
                },

                // Lists
                ul({ children }) {
                    return (
                        <Box
                            component="ul"
                            sx={{
                                pl: 2.5,
                                mb: 1.5,
                                '& li': {
                                    mb: 0.5,
                                },
                            }}
                        >
                            {children}
                        </Box>
                    );
                },
                ol({ children }) {
                    return (
                        <Box
                            component="ol"
                            sx={{
                                pl: 2.5,
                                mb: 1.5,
                                '& li': {
                                    mb: 0.5,
                                },
                            }}
                        >
                            {children}
                        </Box>
                    );
                },

                // Blockquotes
                blockquote({ children }) {
                    return (
                        <Box
                            component="blockquote"
                            sx={{
                                borderLeft: '3px solid',
                                borderColor: 'primary.main',
                                pl: 2,
                                py: 0.5,
                                my: 1.5,
                                color: 'text.secondary',
                                fontStyle: 'italic',
                            }}
                        >
                            {children}
                        </Box>
                    );
                },

                // Tables
                table({ children }) {
                    return (
                        <Box
                            sx={{
                                overflow: 'auto',
                                my: 2,
                            }}
                        >
                            <Box
                                component="table"
                                sx={{
                                    width: '100%',
                                    borderCollapse: 'collapse',
                                    '& th, & td': {
                                        border: '1px solid rgba(255, 255, 255, 0.1)',
                                        px: 2,
                                        py: 1,
                                        textAlign: 'left',
                                    },
                                    '& th': {
                                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                        fontWeight: 600,
                                    },
                                }}
                            >
                                {children}
                            </Box>
                        </Box>
                    );
                },

                // Horizontal rule
                hr() {
                    return (
                        <Box
                            component="hr"
                            sx={{
                                border: 'none',
                                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                                my: 2,
                            }}
                        />
                    );
                },

                // Strong/Bold
                strong({ children }) {
                    return (
                        <Box component="strong" sx={{ fontWeight: 600 }}>
                            {children}
                        </Box>
                    );
                },

                // Emphasis/Italic
                em({ children }) {
                    return (
                        <Box component="em" sx={{ fontStyle: 'italic' }}>
                            {children}
                        </Box>
                    );
                },
            }}
        >
            {processed}
        </ReactMarkdown>
    );
});
