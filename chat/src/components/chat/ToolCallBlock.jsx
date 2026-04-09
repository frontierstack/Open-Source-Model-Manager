import React, { useState } from 'react';
import { Globe, Link as LinkIcon, Wrench, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * ToolCallBlock - Collapsible card showing that the assistant used a tool.
 *
 * @param {Object} props
 * @param {Object} props.tool - Tool invocation metadata
 * @param {'web_search'|'url_fetch'|'skill'} props.tool.type - Tool type
 * @param {string} props.tool.label - Display label (e.g. "Web Search")
 * @param {string} props.tool.query - The search query or url list
 * @param {number} [props.tool.durationMs] - Execution time in milliseconds
 * @param {number} [props.tool.resultCount] - Number of items returned
 * @param {'success'|'failed'|'partial'} props.tool.status - Execution status
 * @param {string} [props.tool.error] - Error message when status !== 'success'
 * @param {Array} [props.tool.results] - Raw results passed through for expanded view
 * @param {React.ReactNode} [props.children] - Optional expanded body content
 */
export default function ToolCallBlock({ tool, children }) {
    const [expanded, setExpanded] = useState(false);

    if (!tool) return null;

    const {
        type = 'skill',
        label = 'Tool',
        query = '',
        durationMs,
        resultCount,
        status = 'success',
        error,
    } = tool;

    const IconComponent =
        type === 'web_search' ? Globe : type === 'url_fetch' ? LinkIcon : Wrench;

    const statusDotClass =
        status === 'success'
            ? 'bg-emerald-400'
            : status === 'partial'
            ? 'bg-amber-400'
            : 'bg-red-400';

    const captionParts = [];
    if (typeof resultCount === 'number') {
        captionParts.push(`${resultCount} result${resultCount === 1 ? '' : 's'}`);
    }
    if (typeof durationMs === 'number' && durationMs >= 0) {
        const seconds = durationMs / 1000;
        captionParts.push(
            seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`
        );
    }
    const caption = captionParts.join(' · ');

    const toggle = () => setExpanded((v) => !v);

    return (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] my-2 text-[12px]">
            <button
                type="button"
                onClick={toggle}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.02] transition-colors rounded-md"
            >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass}`} />
                <IconComponent className="w-3.5 h-3.5 text-dark-300 flex-shrink-0" />
                <span className="text-dark-100 font-medium tracking-tight truncate">
                    {label}
                </span>
                {caption && (
                    <span className="text-dark-400 text-[11px] truncate">{caption}</span>
                )}
                <span className="ml-auto flex-shrink-0 text-dark-400">
                    {expanded ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                    )}
                </span>
            </button>

            {expanded && (
                <div className="px-3 py-2.5 border-t border-white/[0.06]">
                    {query && (
                        <div className="mb-2">
                            <div className="text-[10px] uppercase tracking-wider text-dark-400 mb-1">
                                Query
                            </div>
                            <div className="font-mono text-[11.5px] text-dark-200 bg-white/[0.03] border border-white/[0.05] rounded px-2 py-1.5 whitespace-pre-wrap break-words">
                                {query}
                            </div>
                        </div>
                    )}

                    {status !== 'success' && error && (
                        <div className="mb-2">
                            <div className="text-[10px] uppercase tracking-wider text-red-400/80 mb-1">
                                Error
                            </div>
                            <div className="text-[11.5px] text-red-300 bg-red-500/5 border border-red-500/20 rounded px-2 py-1.5 whitespace-pre-wrap break-words">
                                {error}
                            </div>
                        </div>
                    )}

                    {children && (
                        <div
                            className={
                                query || (status !== 'success' && error)
                                    ? 'pt-2.5 border-t border-white/[0.06]'
                                    : ''
                            }
                        >
                            {children}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
