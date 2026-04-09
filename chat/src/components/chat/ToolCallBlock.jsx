import React from 'react';
import { Globe, Link as LinkIcon, Wrench, AlertCircle } from 'lucide-react';

/**
 * ToolCallBlock - Compact status pill showing that the assistant used a tool.
 *
 * This used to be a collapsible card that re-displayed the query on
 * expand, but the query is already the user message directly above the
 * assistant response — rehashing it was redundant. Flattened to a
 * single-line pill showing just label + count + duration, plus an
 * inline error line when the call failed.
 *
 * @param {Object} props
 * @param {Object} props.tool - Tool invocation metadata
 * @param {'web_search'|'url_fetch'|'skill'} props.tool.type - Tool type
 * @param {string} props.tool.label - Display label (e.g. "Web Search")
 * @param {number} [props.tool.durationMs] - Execution time in milliseconds
 * @param {number} [props.tool.resultCount] - Number of items returned
 * @param {'success'|'failed'|'partial'} props.tool.status - Execution status
 * @param {string} [props.tool.error] - Error message when status !== 'success'
 */
export default function ToolCallBlock({ tool }) {
    if (!tool) return null;

    const {
        type = 'skill',
        label = 'Tool',
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

    const statusGlowClass =
        status === 'success'
            ? 'shadow-[0_0_6px_rgba(52,211,153,0.6)]'
            : status === 'partial'
            ? 'shadow-[0_0_6px_rgba(251,191,36,0.6)]'
            : 'shadow-[0_0_6px_rgba(248,113,113,0.6)]';

    // Describe what the tool did. For web_search / url_fetch the count +
    // duration are enough: "Web Search · 5 sources · 1.2s"
    const captionParts = [];
    if (typeof resultCount === 'number') {
        const noun = type === 'web_search' ? 'source' : type === 'url_fetch' ? 'page' : 'result';
        captionParts.push(`${resultCount} ${noun}${resultCount === 1 ? '' : 's'}`);
    }
    if (typeof durationMs === 'number' && durationMs >= 0) {
        const seconds = durationMs / 1000;
        captionParts.push(
            seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`
        );
    }
    const caption = captionParts.join(' · ');

    return (
        <div className="inline-flex items-center gap-1.5 mr-1.5 mb-1 px-2 py-1 rounded-full bg-white/[0.03] border border-white/[0.06] text-[11px] align-middle">
            <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass} ${statusGlowClass}`}
            />
            <IconComponent className="w-3 h-3 text-dark-300 flex-shrink-0" />
            <span className="text-dark-100 font-medium tracking-tight">{label}</span>
            {caption && (
                <>
                    <span className="text-dark-600" aria-hidden="true">·</span>
                    <span className="text-dark-400 font-mono tabular-nums">{caption}</span>
                </>
            )}
            {status !== 'success' && error && (
                <>
                    <span className="text-dark-600" aria-hidden="true">·</span>
                    <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                    <span className="text-red-300 truncate max-w-[240px]">{error}</span>
                </>
            )}
        </div>
    );
}
