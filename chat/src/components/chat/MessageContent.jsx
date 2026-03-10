import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';

/**
 * MessageContent - Renders markdown content with Tailwind styling
 */
export default function MessageContent({ content }) {
    if (!content) return null;

    return (
        <div className="markdown-content">
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
                            <code
                                className="px-1.5 py-0.5 mx-0.5 bg-white/10 rounded text-accent-400 font-mono text-[0.85em]"
                                {...props}
                            >
                                {children}
                            </code>
                        );
                    },

                    // Paragraphs
                    p({ children }) {
                        return (
                            <p className="mb-4 leading-relaxed last:mb-0">
                                {children}
                            </p>
                        );
                    },

                    // Headings
                    h1({ children }) {
                        return (
                            <h1 className="text-xl font-semibold mt-6 mb-3 text-dark-100">
                                {children}
                            </h1>
                        );
                    },
                    h2({ children }) {
                        return (
                            <h2 className="text-lg font-semibold mt-5 mb-2 text-dark-100">
                                {children}
                            </h2>
                        );
                    },
                    h3({ children }) {
                        return (
                            <h3 className="text-base font-semibold mt-4 mb-2 text-dark-100">
                                {children}
                            </h3>
                        );
                    },

                    // Links
                    a({ href, children }) {
                        return (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary-400 hover:underline"
                            >
                                {children}
                            </a>
                        );
                    },

                    // Lists
                    ul({ children }) {
                        return (
                            <ul className="pl-5 mb-4 list-disc marker:text-dark-500">
                                {children}
                            </ul>
                        );
                    },
                    ol({ children }) {
                        return (
                            <ol className="pl-5 mb-4 list-decimal marker:text-dark-500">
                                {children}
                            </ol>
                        );
                    },
                    li({ children }) {
                        return (
                            <li className="mb-1.5 text-dark-200">
                                {children}
                            </li>
                        );
                    },

                    // Blockquotes
                    blockquote({ children }) {
                        return (
                            <blockquote className="border-l-3 border-primary-500/50 pl-4 py-1 my-4 text-dark-400 italic">
                                {children}
                            </blockquote>
                        );
                    },

                    // Tables - with proper structure and borders
                    table({ children }) {
                        return (
                            <div className="overflow-x-auto my-4 rounded-lg border border-white/10">
                                <table className="w-full border-collapse min-w-max">
                                    {children}
                                </table>
                            </div>
                        );
                    },
                    thead({ children }) {
                        return (
                            <thead className="bg-dark-800/70">
                                {children}
                            </thead>
                        );
                    },
                    tbody({ children }) {
                        return (
                            <tbody className="divide-y divide-white/5">
                                {children}
                            </tbody>
                        );
                    },
                    tr({ children }) {
                        return (
                            <tr className="hover:bg-white/[0.02] transition-colors">
                                {children}
                            </tr>
                        );
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

                    // Horizontal rule
                    hr() {
                        return <hr className="border-white/10 my-6" />;
                    },

                    // Strong/Bold
                    strong({ children }) {
                        return <strong className="font-semibold text-dark-100">{children}</strong>;
                    },

                    // Emphasis/Italic
                    em({ children }) {
                        return <em className="italic">{children}</em>;
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
