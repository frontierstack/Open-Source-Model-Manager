import React, { useState, useEffect } from 'react';
import { Globe, Link as LinkIcon, Wrench, BookOpen, AlertCircle, ChevronDown, Check, Loader2, Shield, BarChart3, Image as ImageIcon, Film, Download, FileText } from 'lucide-react';
import SearchSources from './SearchSources';
import ChartBlock from './ChartBlock';
import ImageBlock from './ImageBlock';
import VideoBlock from './VideoBlock';
import ArtifactList from './ArtifactList';

/**
 * ToolCallBlock — compact chip showing an assistant tool invocation.
 *
 * Collapsed state is a content-sized chip (NOT full-width) that wraps
 * naturally inside the parent flex container. Click to expand for args,
 * preview, error details, and any structured sources.
 */
export default function ToolCallBlock({ tool }) {
    const [open, setOpen] = useState(false);

    // Live elapsed clock for an in-flight call. A bare spinner gives no signal
    // about whether a slow tool (make_downloadable on a large artifact, a fetch
    // walking the retrieval cascade) is progressing or wedged — a ticking
    // counter does, and it hands straight off to the final durationMs on
    // completion. Read off `tool` directly: these hooks must sit above the
    // `if (!tool)` bail-out, before the destructure below.
    const running = tool?.status === 'partial';
    const startedAt = tool?.startedAt;
    const [elapsedMs, setElapsedMs] = useState(0);
    useEffect(() => {
        if (!running) return undefined;
        // Fall back to mount time for a chip restored without a startedAt.
        const base = typeof startedAt === 'number' ? startedAt : Date.now();
        const tick = () => setElapsedMs(Date.now() - base);
        tick();
        const id = setInterval(tick, 200);
        return () => clearInterval(id);
    }, [running, startedAt]);

    if (!tool) return null;

    const {
        type = 'skill',
        label = 'Tool',
        query,
        args,
        durationMs,
        resultCount,
        status = 'success',
        error,
        preview,
        sources,
        results,
        chartSpec,
        chartSummary,
        imageSpec,
        videoSpec,
        artifacts,
        sandboxed,
        sandboxNetwork,
        sandboxSource,
    } = tool;

    const isRunning = status === 'partial';
    const isFailed = status === 'failed';
    // load_skill is the only chip that's actually loading a SKILL — an
    // instructional procedure body, not an executable operation. Mark it
    // with a different icon so users can tell at a glance when the model
    // is reading guidance vs. running a tool.
    const isSkillLoad = type === 'native_tool_call' && label === 'load_skill';
    // render_chart returns a structured chartSpec the UI renders inline
    // as a real Recharts SVG. ChatContainer.jsx lifts the spec out of
    // tool.result onto the chip so we don't have to keep the full
    // tool_result payload on the persisted message.
    const isChart = !!chartSpec || (type === 'native_tool_call' && label === 'render_chart');
    // find_image returns an imageSpec the UI renders inline as a thumbnail grid,
    // same lift-onto-the-chip pattern as render_chart's chartSpec.
    const isImage = !!imageSpec || (type === 'native_tool_call' && label === 'find_image');
    // find_video returns a videoSpec the UI renders inline as click-to-play
    // players, same lift-onto-the-chip pattern as imageSpec.
    const isVideo = !!videoSpec || (type === 'native_tool_call' && label === 'find_video');
    const IconComponent =
        (type === 'native_tool_call' && label === 'web') ? Globe :
        type === 'web_search' ? Globe :
        type === 'url_fetch' ? LinkIcon :
        isSkillLoad ? BookOpen :
        isChart ? BarChart3 :
        isImage ? ImageIcon :
        isVideo ? Film :
        Wrench;

    const toolName =
        type === 'web_search' ? 'web.search'
            : type === 'url_fetch' ? 'web.fetch'
            : type === 'native_tool_call' ? label
            : label.toLowerCase().replace(/\s+/g, '.');

    const captionParts = [];
    const sourceList = Array.isArray(sources) ? sources : Array.isArray(results) ? results : null;
    const sourceCount = sourceList ? sourceList.length : null;
    // For load_skill, surface which skill the model loaded so the user can
    // see the instructional procedure that was applied without expanding.
    const loadedSkillName = isSkillLoad
        ? (args && typeof args === 'object' ? args.name : null)
        : null;
    if (loadedSkillName) {
        captionParts.push(String(loadedSkillName));
    } else if (typeof resultCount === 'number') {
        const noun = type === 'web_search' ? 'result' : type === 'url_fetch' ? 'page' : 'result';
        captionParts.push(`${resultCount} ${noun}${resultCount === 1 ? '' : 's'}`);
    } else if (sourceCount && (type === 'native_tool_call' || type === 'web_search' || type === 'url_fetch')) {
        captionParts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
    }
    if (isRunning) {
        const runningSeconds = elapsedMs / 1000;
        captionParts.push(runningSeconds >= 1 ? `running… ${runningSeconds.toFixed(1)}s` : 'running…');
    } else if (typeof durationMs === 'number' && durationMs >= 0) {
        const seconds = durationMs / 1000;
        captionParts.push(seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`);
    }
    const caption = captionParts.join(' · ');
    const hasSources = Array.isArray(sourceList) && sourceList.length > 0;
    const hasArtifacts = Array.isArray(artifacts) && artifacts.length > 0;
    // Show args panel when we have parsed args or the legacy single-string `query`.
    const argEntries = args && typeof args === 'object' ? Object.entries(args) : null;
    const hasArgs = (argEntries && argEntries.length > 0) || (!argEntries && query);
    const hasDetail = isFailed || (preview && !isRunning) || hasSources || hasArgs || !!chartSpec || !!imageSpec || !!videoSpec || hasArtifacts;

    const statusColor =
        isRunning ? 'var(--accent)'
            : status === 'success' ? 'var(--ok)'
            : 'var(--danger)';

    const chipClass = `tool-chip${isFailed ? ' is-failed' : ''}${isRunning ? ' is-running' : ''}`;

    return (
        <div className={chipClass}>
            <button
                type="button"
                className={`tool-chip-header${hasDetail ? ' has-detail' : ''}`}
                onClick={() => hasDetail && setOpen(o => !o)}
                aria-expanded={hasDetail ? open : undefined}
                tabIndex={hasDetail ? 0 : -1}
            >
                <span className="tool-chip-status" style={{ background: statusColor }}>
                    {isRunning
                        ? <Loader2 className="animate-spin" strokeWidth={2.5} />
                        : status === 'success'
                        ? <Check strokeWidth={3} />
                        : <AlertCircle strokeWidth={2.25} />}
                </span>
                <IconComponent className="tool-chip-icon" strokeWidth={1.75} />
                <code className="tool-chip-name">{toolName}</code>
                {sandboxed === true && (
                    <span
                        title={
                            'Ran inside the gVisor sandbox' +
                            (sandboxNetwork ? ` · network=${sandboxNetwork}` : '')
                        }
                        className="tool-chip-badge"
                        style={badgeStyle('var(--ok, #22c55e)', 12, 30)}
                    >
                        <Shield strokeWidth={2.5} />
                        sandboxed
                    </span>
                )}
                {sandboxed === false && (
                    <span
                        title="Ran in-process in the webapp container (not sandboxed)"
                        className="tool-chip-badge"
                        style={badgeStyle('var(--warning, #f59e0b)', 10, 28)}
                    >
                        in-process
                    </span>
                )}
                {caption && <span className="tool-chip-caption">{caption}</span>}
                {hasDetail && (
                    <span className={`tool-chip-chevron${open ? ' is-open' : ''}`}>
                        <ChevronDown strokeWidth={2} />
                    </span>
                )}
            </button>
            {open && hasDetail && (
                <div className="tool-chip-body">
                    {chartSpec && (
                        <ChartBlock spec={chartSpec} summary={chartSummary || ''} />
                    )}
                    {imageSpec && (
                        <ImageBlock spec={imageSpec} />
                    )}
                    {videoSpec && (
                        <VideoBlock spec={videoSpec} />
                    )}
                    {hasArtifacts && (
                        <ArtifactList artifacts={artifacts} />
                    )}
                    {hasArgs && (
                        argEntries && argEntries.length > 0 ? (
                            <ArgsTable entries={argEntries} />
                        ) : (
                            <div className="tool-chip-args">
                                <span className="tool-chip-argk">args</span>
                                <span className="tool-chip-argv">{query}</span>
                            </div>
                        )
                    )}
                    {isFailed && error && <ErrorBlock error={error} toolName={toolName} />}
                    {hasSources && <SearchSources sources={sourceList} />}
                    {preview && !isFailed && !hasSources && !chartSpec && !imageSpec && !videoSpec && (
                        <pre className="tool-chip-pre">{preview}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

// Pill style helper. `pct` = bg opacity, `borderPct` = border opacity (in %).
function badgeStyle(color, pct, borderPct) {
    return {
        color,
        background: `color-mix(in oklab, ${color} ${pct}%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} ${borderPct}%, transparent)`,
    };
}

// Compact key: value table for tool arguments. Long values get wrapped &
// monospaced; the key column auto-sizes to the longest key.
function ArgsTable({ entries }) {
    return (
        <div className="tool-chip-args">
            {entries.map(([k, v]) => {
                let display;
                if (v == null) display = String(v);
                else if (typeof v === 'string') display = v;
                else if (typeof v === 'object') {
                    try { display = JSON.stringify(v); } catch { display = String(v); }
                } else display = String(v);
                if (display.length > 600) display = display.slice(0, 600) + '…';
                return (
                    <React.Fragment key={k}>
                        <span className="tool-chip-argk">{k}</span>
                        <span className="tool-chip-argv">{display}</span>
                    </React.Fragment>
                );
            })}
        </div>
    );
}

// Failed-call block. Visually distinct from preview text — red-tinted
// background, monospace, generous wrap. Most tool errors come back as a
// JSON-encoded `{"error": "..."}` string; pretty-print when we can.
function ErrorBlock({ error, toolName }) {
    let display = String(error || '').trim();
    let kind = 'error';
    try {
        const parsed = JSON.parse(display);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.error === 'string') {
                display = parsed.error;
                if (typeof parsed.message === 'string' && parsed.message !== parsed.error) {
                    display += `\n${parsed.message}`;
                }
                kind = parsed.error === 'loop_detected' ? 'loop' : 'error';
            } else if (typeof parsed.message === 'string') {
                display = parsed.message;
            }
        }
    } catch (_) { /* not JSON, keep raw */ }
    const isLoop = kind === 'loop';
    return (
        <div className="tool-chip-error">
            <AlertCircle strokeWidth={2} />
            <div style={{ minWidth: 0, flex: 1 }}>
                <div className="tool-chip-error-title">
                    {isLoop ? 'loop detected' : `${toolName} failed`}
                </div>
                <pre>{display}</pre>
            </div>
        </div>
    );
}
