import React, { useState } from 'react';
import { Copy, Check, Minimize2, Maximize2 } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';

/**
 * CodeBlock - Syntax-highlighted code block with copy functionality (Tailwind)
 */
export default React.memo(function CodeBlock({ code, language = 'text' }) {
    const [copied, setCopied] = useState(false);

    // Compute line count from the raw code
    const lineCount = (code || '').split('\n').length;

    // Default-collapse blocks longer than 20 lines
    const initialCollapsed = lineCount > 20;
    const [collapsed, setCollapsed] = useState(initialCollapsed);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleToggleCollapsed = () => {
        setCollapsed((prev) => !prev);
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
        <div className="code-block my-4">
            {/* Header with language, line count, collapse toggle and copy button */}
            <div className="code-header">
                <span className="text-xs text-dark-400 uppercase font-medium tracking-wider">
                    {normalizedLanguage}
                    <span className="ml-2 normal-case tracking-normal text-dark-500 font-normal">
                        · {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                    </span>
                </span>
                <div className="flex items-center gap-2">
                    {collapsed && (
                        <span className="text-xs text-dark-500 italic">
                            {lineCount} {lineCount === 1 ? 'line' : 'lines'} hidden
                        </span>
                    )}
                    <button
                        onClick={handleToggleCollapsed}
                        className="p-1.5 rounded-lg transition-colors text-dark-400 hover:text-dark-200 hover:bg-white/10"
                        title={collapsed ? 'Expand code' : 'Collapse code'}
                    >
                        {collapsed ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                    </button>
                    <button
                        onClick={handleCopy}
                        className={`p-1.5 rounded-lg transition-colors ${
                            copied
                                ? 'text-green-400'
                                : 'text-dark-400 hover:text-dark-200 hover:bg-white/10'
                        }`}
                        title={copied ? 'Copied!' : 'Copy code'}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Code content */}
            {!collapsed && (
                <Highlight theme={themes.nightOwl} code={code.trim()} language={normalizedLanguage}>
                    {({ className, style, tokens, getLineProps, getTokenProps }) => (
                        <pre
                            className="p-4 overflow-x-auto font-mono text-[0.8125rem] leading-relaxed"
                            style={{ ...style, backgroundColor: 'transparent' }}
                        >
                            {tokens.map((line, i) => (
                                <div key={i} {...getLineProps({ line })}>
                                    <span className="inline-block w-8 text-right pr-4 text-white/20 select-none">
                                        {i + 1}
                                    </span>
                                    {line.map((token, key) => (
                                        <span key={key} {...getTokenProps({ token })} />
                                    ))}
                                </div>
                            ))}
                        </pre>
                    )}
                </Highlight>
            )}
        </div>
    );
});
