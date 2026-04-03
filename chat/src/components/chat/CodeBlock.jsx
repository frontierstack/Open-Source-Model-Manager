import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';

/**
 * CodeBlock - Syntax-highlighted code block with copy functionality (Tailwind)
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
        <div className="code-block my-4">
            {/* Header with language and copy button */}
            <div className="code-header">
                <span className="text-xs text-dark-400 uppercase font-medium tracking-wider">
                    {normalizedLanguage}
                </span>
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

            {/* Code content */}
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
        </div>
    );
});
