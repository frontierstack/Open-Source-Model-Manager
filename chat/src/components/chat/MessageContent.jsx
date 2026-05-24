import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import CodeBlock from './CodeBlock';
import CodePreviewBlock from './CodePreviewBlock';

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

// Shared markdown component maps — built once outside the component to keep
// stable references (prevents ReactMarkdown from re-mounting internals each
// render). The `code` renderer is the only streaming-sensitive piece: while
// the stream is live we pass isStreaming through so CodePreviewBlock keeps its
// Run buttons / iframes inert until a fenced block has fully arrived;
// everything else is identical between the two maps.
const makeCodeComponent = (isStreaming) => function CodeRenderer({ node, inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');

    if (!inline && (match || code.includes('\n'))) {
        // CodePreviewBlock gates on the codePreviewEnabled setting
        // internally — when off, it falls through to a plain
        // CodeBlock with zero Run-related rendering.
        return (
            <CodePreviewBlock
                code={code}
                language={match ? match[1] : 'text'}
                isStreaming={isStreaming}
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
};

const sharedMarkdownComponents = {
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
            <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline break-all" style={{ color: 'var(--accent)' }}>
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
            <blockquote className="border-l-3 pl-4 py-1 my-4 text-dark-400 italic" style={{ borderColor: 'color-mix(in oklab, var(--accent) 50%, transparent)' }}>
                {children}
            </blockquote>
        );
    },
    table({ children }) {
        // No outer wrapper border — cell separators are enough and doubled
        // borders read badly in layouts like Slack that already frame the
        // message. Keep horizontal scroll for wide tables.
        return (
            <div className="overflow-x-auto my-4">
                <table className="w-full border-collapse min-w-max">{children}</table>
            </div>
        );
    },
    thead({ children }) {
        return <thead style={{ background: 'var(--bg-2)' }}>{children}</thead>;
    },
    tbody({ children }) {
        return <tbody>{children}</tbody>;
    },
    tr({ children }) {
        return <tr>{children}</tr>;
    },
    th({ children }) {
        return (
            <th
                className="px-4 py-3 text-left font-semibold text-sm whitespace-nowrap"
                style={{ color: 'var(--ink)', borderBottom: '1px solid var(--rule)' }}
            >
                {children}
            </th>
        );
    },
    td({ children }) {
        return (
            <td
                className="px-4 py-3 text-sm"
                style={{ color: 'var(--ink-2)', borderBottom: '1px solid var(--rule-2)' }}
            >
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

// Two frozen maps: live stream (code previews inert) vs finalized message.
const streamingMarkdownComponents = { ...sharedMarkdownComponents, code: makeCodeComponent(true) };
const markdownComponents = { ...sharedMarkdownComponents, code: makeCodeComponent(false) };

// remark-math parses both inline ($...$) and block ($$...$$) math; rehype-katex
// renders it via KaTeX. Models emit chemistry like $\text{C}_{16}\text{H}_8...$
// and physics/units like $466.36 \text{ g/mol}$ — without these plugins the raw
// `$...$` syntax leaks through and reads as gibberish.
const remarkPlugins = [remarkGfm, remarkMath];
// strict:false → ignore unknown LaTeX commands instead of dropping a hard
// "ParseError" in red across the page; output:'html' keeps the DOM small
// (no MathML twin tree we don't display).
const rehypePlugins = [[rehypeKatex, { strict: false, output: 'html', throwOnError: false }]];

// Currency vs math. remark-math treats single `$...$` as inline math, so a reply
// like "it's $289.99 (Amazon) ... or $275.49 used" gets the two `$` paired and
// everything between them rendered as (mangled) KaTeX — spaces stripped, `*`→`∗`,
// `-`→`−`. Prices are far more common than inline LaTeX in chat, so escape a `$`
// that begins a currency amount (digit-led number ending at a NON-math boundary)
// to a literal `\$`, while leaving real math untouched: `$\alpha$` and number-led
// math like `$466.36 \text{ g/mol}$` (number followed by a LaTeX command) are NOT
// escaped because the lookahead sees the `\`/`^`/`_`/`{`. Code spans/blocks are
// skipped (there `$` is already literal and a backslash would show through).
function escapeCurrency(md) {
    if (!md || md.indexOf('$') === -1) return md;
    // Split keeps code regions (odd indices) verbatim; only even segments get escaped.
    // The two `(?!\d)(?!\.\d)` lookaheads stop the optional-decimal group from
    // backtracking to a shorter number (e.g. matching "$466" out of "$466.36
    // \text{…}$" and escaping it); the last lookahead leaves real math alone.
    return md.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((seg, i) => (
        i % 2 === 1
            ? seg
            : seg.replace(/\$(\d[\d,]*(?:\.\d+)?)(?!\d)(?!\.\d)(?!\s*[\\^_{}])/g, '\\$$$1')
    )).join('');
}

export default React.memo(function MessageContent({ content, isStreaming }) {
    if (!content) return null;

    // Render markdown for BOTH the in-progress stream and the finalized
    // message, so formatting and ```html / code previews appear progressively
    // as tokens arrive. Previously the stream rendered as raw plain text and
    // only swapped to markdown at stream-end, which (a) made HTML/markdown
    // "only show up once the response was done" and (b) produced a visible
    // layout reflow at the swap. The smooth-reveal pump in ChatContainer feeds
    // this a steadily-growing prefix, so structure forms at a readable cadence
    // rather than per-token; the streaming map keeps code-block previews inert
    // until a fenced block is complete (makeCodeComponent(true)).
    // Repair GFM tables emitted on a single line (models sometimes skip
    // the newlines between rows, leaving remark-gfm to render raw pipes).
    const repairedTables = content.includes('|')
        ? content.split('\n').map((line) => (
            /\|\s*:?-{3,}:?\s*\|/.test(line)
                ? line.replace(/\s*\|\s*\|\s*/g, ' |\n| ')
                : line
        )).join('\n')
        : content;
    const processed = escapeCurrency(repairedTables.replace(/<br\s*\/?>/gi, '  \n'));
    return (
        <div className="markdown-content">
            <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                components={isStreaming ? streamingMarkdownComponents : markdownComponents}
            >
                {processed}
            </ReactMarkdown>
        </div>
    );
});
