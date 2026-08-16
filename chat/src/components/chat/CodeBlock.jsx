import React, { useState } from 'react';
import { Copy, Check, Minimize2, Maximize2 } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import { useChatStore } from '../../stores/useChatStore';

/**
 * CodeBlock - Syntax-highlighted code block with copy functionality (Tailwind)
 *
 * During streaming: always expanded, no syntax highlighting (plain pre) for
 * performance — avoids Prism re-highlighting the entire block on every token.
 * After streaming: normal collapse/expand with full syntax highlighting.
 */
export default React.memo(function CodeBlock({ code, language = 'text', isStreaming = false }) {
    const [copied, setCopied] = useState(false);
    // Pick a Prism theme that matches the chat theme. The default nightOwl
    // is unreadable on the light theme's near-white code-block background.
    const activeTheme = useChatStore((s) => s.theme);
    const isLight = activeTheme === 'light';
    const prismTheme = isLight ? themes.github : themes.nightOwl;

    // Compute line count from the raw code
    const lineCount = (code || '').split('\n').length;

    // While STREAMING: stay expanded so the user watches the code generate live
    // in the chat (the Artifacts panel also mirrors it live). Once streaming
    // ENDS: auto-collapse long blocks (> 20 lines) so a finished large file
    // doesn't take over the chat. The toggle is always available (below) to
    // expand/collapse either way.
    const initialCollapsed = !isStreaming && lineCount > 20;
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

    // Always show the collapse toggle — including during streaming — so the
    // user can expand a collapsed block to watch the code generate live, then
    // collapse it again. (The block streams within a stable markdown position,
    // so React preserves this component's expand/collapse state across token
    // re-parses.)
    const showCollapseToggle = true;

    return (
        <div className="code-block my-3.5">
            {/* Header with language, line count, collapse toggle and copy button */}
            <div className="code-header">
                <span className="code-header-lang">
                    {normalizedLanguage}
                    <span className="code-header-lines">
                        {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                    </span>
                </span>
                <div className="flex items-center gap-0.5">
                    {collapsed && showCollapseToggle && (
                        <span className="code-header-hidden">
                            {lineCount} {lineCount === 1 ? 'line' : 'lines'} hidden
                        </span>
                    )}
                    {showCollapseToggle && (
                        <button
                            onClick={handleToggleCollapsed}
                            className="code-hbtn"
                            title={collapsed ? 'Expand code' : 'Collapse code'}
                            aria-label={collapsed ? 'Expand code' : 'Collapse code'}
                        >
                            {collapsed ? <Maximize2 strokeWidth={1.75} /> : <Minimize2 strokeWidth={1.75} />}
                        </button>
                    )}
                    <button
                        onClick={handleCopy}
                        className={`code-hbtn${copied ? ' is-active' : ''}`}
                        title={copied ? 'Copied!' : 'Copy code'}
                        aria-label="Copy code"
                    >
                        {copied ? <Check strokeWidth={2.25} /> : <Copy strokeWidth={1.75} />}
                    </button>
                </div>
            </div>

            {/* Code content — during streaming use plain <pre> (fast), after
                streaming use Prism syntax highlighting (pretty). */}
            {!collapsed && (
                isStreaming ? (
                    <pre className="code-pre" style={{ color: 'var(--ink-2)' }}>
                        {code.trim()}
                    </pre>
                ) : (
                    <Highlight theme={prismTheme} code={code.trim()} language={normalizedLanguage}>
                        {({ className, style, tokens, getLineProps, getTokenProps }) => (
                            <pre
                                className="code-pre"
                                style={{ ...style, backgroundColor: 'transparent' }}
                            >
                                {tokens.map((line, i) => (
                                    <div key={i} {...getLineProps({ line })}>
                                        <span className="code-ln">
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
                )
            )}
        </div>
    );
});
