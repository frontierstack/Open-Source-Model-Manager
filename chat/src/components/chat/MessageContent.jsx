import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

/**
 * MessageContent - Renders markdown content with Tailwind styling
 *
 * During streaming: two-layer render —
 *   1. Memoized ReactMarkdown re-renders only when debounced content changes
 *      (~10fps markdown formatting for tables/bold/code)
 *   2. Plain text "tail" updates every frame (60fps character flow)
 * After streaming: single full ReactMarkdown render.
 */

// Markdown re-parses at most every INTERVAL ms. Low enough for responsive
// formatting, high enough to not cause jank.
const MARKDOWN_INTERVAL = 100;

function useDebounced(value, delay) {
    const [debounced, setDebounced] = useState(value);
    const timerRef = useRef(null);

    useEffect(() => {
        if (!timerRef.current) {
            setDebounced(value);
        }
        timerRef.current = setTimeout(() => {
            setDebounced(value);
            timerRef.current = null;
        }, delay);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [value, delay]);

    return debounced;
}

// Shared markdown component maps — defined once outside the component
// to keep stable references (prevents ReactMarkdown from re-mounting internals).
const markdownComponents = {
    code({ node, inline, className, children, ...props }) {
        const match = /language-(\w+)/.exec(className || '');
        const code = String(children).replace(/\n$/, '');

        if (!inline && (match || code.includes('\n'))) {
            return (
                <CodeBlock
                    code={code}
                    language={match ? match[1] : 'text'}
                    isStreaming={false}
                />
            );
        }

        return (
            <code
                className="px-1.5 py-0.5 mx-0.5 bg-white/10 rounded text-accent-400 font-mono text-[0.85em]"
                {...props}
            >
                {children}
            </code>
        );
    },

    p({ children }) {
        return <p className="mb-4 leading-relaxed last:mb-0">{children}</p>;
    },
    h1({ children }) {
        return <h1 className="text-xl font-semibold mt-6 mb-3 text-dark-100">{children}</h1>;
    },
    h2({ children }) {
        return <h2 className="text-lg font-semibold mt-5 mb-2 text-dark-100">{children}</h2>;
    },
    h3({ children }) {
        return <h3 className="text-base font-semibold mt-4 mb-2 text-dark-100">{children}</h3>;
    },
    a({ href, children }) {
        return (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:underline break-all">
                {children}
            </a>
        );
    },
    ul({ children }) {
        return <ul className="pl-5 mb-4 list-disc marker:text-dark-500">{children}</ul>;
    },
    ol({ children }) {
        return <ol className="pl-5 mb-4 list-decimal marker:text-dark-500">{children}</ol>;
    },
    li({ children }) {
        return <li className="mb-1.5 text-dark-200">{children}</li>;
    },
    blockquote({ children }) {
        return (
            <blockquote className="border-l-3 border-primary-500/50 pl-4 py-1 my-4 text-dark-400 italic">
                {children}
            </blockquote>
        );
    },
    table({ children }) {
        return (
            <div className="overflow-x-auto my-4 rounded-lg border border-white/10">
                <table className="w-full border-collapse min-w-max">{children}</table>
            </div>
        );
    },
    thead({ children }) {
        return <thead className="bg-dark-800/70">{children}</thead>;
    },
    tbody({ children }) {
        return <tbody className="divide-y divide-white/5">{children}</tbody>;
    },
    tr({ children }) {
        return <tr className="hover:bg-white/[0.02] transition-colors">{children}</tr>;
    },
    th({ children }) {
        return (
            <th className="px-4 py-3 text-left text-dark-200 font-semibold text-sm border-b border-white/10 whitespace-nowrap">
                {children}
            </th>
        );
    },
    td({ children }) {
        return (
            <td className="px-4 py-3 text-dark-300 text-sm border-b border-white/5">
                {children}
            </td>
        );
    },
    hr() {
        return <hr className="border-white/10 my-6" />;
    },
    strong({ children }) {
        return <strong className="font-semibold text-dark-100">{children}</strong>;
    },
    em({ children }) {
        return <em className="italic">{children}</em>;
    },
};

const streamingMarkdownComponents = {
    ...markdownComponents,
    code({ node, inline, className, children, ...props }) {
        const match = /language-(\w+)/.exec(className || '');
        const code = String(children).replace(/\n$/, '');

        if (!inline && (match || code.includes('\n'))) {
            return (
                <CodeBlock
                    code={code}
                    language={match ? match[1] : 'text'}
                    isStreaming={true}
                />
            );
        }

        return (
            <code
                className="px-1.5 py-0.5 mx-0.5 bg-white/10 rounded text-accent-400 font-mono text-[0.85em]"
                {...props}
            >
                {children}
            </code>
        );
    },
};

const remarkPlugins = [remarkGfm];

export default React.memo(function MessageContent({ content, isStreaming }) {
    if (!content) return null;

    const debouncedContent = useDebounced(content, MARKDOWN_INTERVAL);

    // Memoize the ReactMarkdown output — only re-parses when debouncedContent
    // actually changes (~every 100ms). On all other frames the cached JSX tree
    // is reused, so the only per-frame work is the cheap tail text node update.
    const markdownRendered = useMemo(() => {
        const processed = (isStreaming ? debouncedContent : content).replace(/<br\s*\/?>/gi, '  \n');
        return (
            <ReactMarkdown
                remarkPlugins={remarkPlugins}
                components={isStreaming ? streamingMarkdownComponents : markdownComponents}
            >
                {processed}
            </ReactMarkdown>
        );
    }, [isStreaming ? debouncedContent : content, isStreaming]);

    if (isStreaming) {
        // Tail: characters that arrived since the last debounced snapshot.
        // This text updates every frame (60fps) — just a text node, sub-ms.
        const tail = content.length > debouncedContent.length
            ? content.slice(debouncedContent.length)
            : '';
        return (
            <div className="markdown-content">
                {markdownRendered}
                {tail && (
                    <span className="whitespace-pre-wrap leading-relaxed break-words">
                        {tail}
                    </span>
                )}
            </div>
        );
    }

    return (
        <div className="markdown-content">
            {markdownRendered}
        </div>
    );
});
