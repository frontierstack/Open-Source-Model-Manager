import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

/**
 * MessageContent - Renders markdown content with Tailwind styling
 *
 * Streaming phase renders the accumulating text as a single plain-text
 * <div> (whitespace-pre-wrap) — grows monotonically, no block/inline
 * layout shifts per token. Final markdown (syntax-highlighted code,
 * tables, headings, etc.) is rendered once, after stream-end, via the
 * atomic swap in commitStreamingMessage — so there's no visible flash
 * when the stream finishes either.
 */

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

const remarkPlugins = [remarkGfm];

export default React.memo(function MessageContent({ content, isStreaming }) {
    if (!content) return null;

    if (isStreaming) {
        // During streaming we render plain text in a single <pre>-style
        // block. The previous two-layer setup (throttled markdown + tail
        // span sibling) was smooth in principle but visibly jittered every
        // 120 ms when a throttle tick moved tokens from the tail <span>
        // into the parsed markdown <p>: the paragraph grew, the span
        // shrank to empty, and the line-break between them collapsed —
        // a small vertical jump every tick. A single plain-text block
        // grows monotonically from one line into many without any layout
        // shift until the atomic stream→final swap happens at stream-end
        // (handled in commitStreamingMessage).
        return (
            <div className="markdown-content">
                <div className="whitespace-pre-wrap leading-relaxed break-words">
                    {content}
                </div>
            </div>
        );
    }

    // Finalised message: full markdown with syntax-highlighted code blocks
    // and all the trimmings. Only runs once per completed response.
    const processed = content.replace(/<br\s*\/?>/gi, '  \n');
    return (
        <div className="markdown-content">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {processed}
            </ReactMarkdown>
        </div>
    );
});
