import React, { useState, useRef } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Clock, Zap, PlayCircle, AlertCircle, Sparkles, User, RefreshCw, Eye, Code as CodeIcon } from 'lucide-react';
import MessageContent from './MessageContent';
import ThinkingIndicator from './ThinkingIndicator';
import ToolCallBlock from './ToolCallBlock';
import ToolMilestones from './ToolMilestones';
import SearchSources from './SearchSources';
import FilePreviewModal, { isAttachmentPreviewable } from './FilePreviewModal';
import ChartBlock from './ChartBlock';
import ImageBlock from './ImageBlock';
import VideoBlock from './VideoBlock';
import ArtifactList from './ArtifactList';
import { useChatStore } from '../../stores/useChatStore';

// Break a reasoning blob into discrete thought-steps so long chains of
// "Let me also check…" / "Now I'll…" don't render as one giant wall.
// Splits on paragraph breaks first; if the model emitted no paragraphs,
// splits on sentence boundaries that lead into a new cue phrase.
const STEP_CUE = /(?:Let me|Let's|Now|Next|Actually|Wait|Hmm|Okay|OK|First|Then|So|Alright|But|However|Looking|Checking|I(?:'| a)?ll|I need|I should|I'll|I'm going|Maybe|Perhaps|Finally)\b/;
function splitReasoningIntoSteps(text) {
    if (!text) return [];
    const trimmed = text.trim();
    if (!trimmed) return [];
    let parts = trimmed.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) {
        const cueSplit = trimmed.split(new RegExp(`(?<=[.!?])\\s+(?=${STEP_CUE.source})`));
        if (cueSplit.length >= 3) parts = cueSplit.map(s => s.trim()).filter(Boolean);
    }
    return parts;
}

// Map a tool name to a short present-tense verb phrase shown next to
// the 3-dot ThinkingIndicator while that tool is running. Falls back
// to humanizing the snake_case name (e.g. extract_archive → "Extract
// archive") so newly-added skills still get a reasonable label.
const TOOL_VERBS = {
    web: 'Browsing the web',
    web_search: 'Searching the web',
    fetch_url: 'Fetching page',
    crawl_pages: 'Crawling pages',
    playwright_fetch: 'Loading page',
    playwright_interact: 'Interacting with page',
    scrapling_fetch: 'Loading page',
    download_html: 'Downloading page',
    dns_lookup: 'Resolving DNS',
    virustotal_lookup: 'Checking VirusTotal',
    base64_decode: 'Decoding',
    load_skill: 'Loading skill',
    render_chart: 'Rendering chart',
    fetch_timeseries: 'Fetching data',
    read_file: 'Reading file',
    head_file: 'Reading file',
    tail_file: 'Reading file',
    write_file: 'Writing file',
    create_file: 'Writing file',
    append_to_file: 'Editing file',
    replace_lines: 'Editing file',
    edit_file: 'Editing file',
    move_file: 'Moving file',
    copy_file: 'Copying file',
    delete_file: 'Deleting file',
    list_directory: 'Listing files',
    grep_code: 'Searching code',
    outline_file: 'Outlining file',
    create_pdf: 'Creating PDF',
    create_docx: 'Creating document',
    create_xlsx: 'Creating spreadsheet',
    read_xlsx: 'Reading spreadsheet',
    query_sqlite: 'Querying database',
    workspace_db: 'Querying database',
    transform_image: 'Editing image',
    transcribe_audio: 'Transcribing audio',
    extract_archive: 'Expanding archive',
    send_file: 'Sending file',
    run_python: 'Running script',
    run_node: 'Running script',
    make_downloadable: 'Preparing download',
};
function describeRunningTool(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
    // Most recent partial/running tool drives the label.
    for (let i = toolCalls.length - 1; i >= 0; i--) {
        const t = toolCalls[i];
        if (t && (t.status === 'partial' || t.status === 'running')) {
            const name = t.label || t.name || '';
            const verb = TOOL_VERBS[name] || (name ? name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : null);
            // The model's own one-line purpose is the most informative label.
            if (t.purpose) return verb ? `${verb} — ${t.purpose}` : t.purpose;
            return verb;
        }
    }
    return null;
}

// Derive the most informative live label for the streaming bubble.
// Precedence: running tool > server-driven phase (chunking/synth) >
// reasoning-only > content streaming > fallback. This keeps the
// indicator visible AT ALL TIMES while the assistant is producing
// output, not just before the first content token.
function deriveStreamingLabel({ toolCalls, streamingStatus, hasContent, hasReasoning }) {
    const toolLabel = describeRunningTool(toolCalls);
    if (toolLabel) return toolLabel;
    if (streamingStatus && streamingStatus.text && !hasContent) return streamingStatus.text;
    if (!hasContent && hasReasoning) return 'Thinking';
    if (hasContent) return 'Generating';
    return 'Thinking';
}

export default React.memo(function ChatMessage({
    id,
    role,
    content,
    reasoning,
    timestamp,
    attachments,
    isStreaming,
    streamingContent,
    streamingReasoning,
    responseTime,
    tokenCount,
    needsContinuation,
    isPartial,
    onContinue,
    isLoading,
    toolCalls,
    searchResults,
    modelName,
    onOpenArtifacts,
    streamingStatus,
}) {
    const [copied, setCopied] = useState(false);
    const [reasoningExpanded, setReasoningExpanded] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [previewAttachment, setPreviewAttachment] = useState(null);
    // Tool-call group collapse. Always rendered as a collapsible
    // summary — chips fold to a one-line "N tool calls · names"
    // header by default. While streaming we keep them expanded so
    // in-flight chips stay visible; once streaming ends (or for
    // already-loaded messages) they collapse to the summary line.
    // For chart calls the chart itself surfaces in the main bubble
    // body anyway, so the chip strip is purely a transparency footer.
    const [toolsExpanded, setToolsExpanded] = useState(false);
    const prevStreamingRef = useRef(isStreaming);
    React.useEffect(() => {
        if (prevStreamingRef.current && !isStreaming) {
            setToolsExpanded(false);
        }
        prevStreamingRef.current = isStreaming;
    }, [isStreaming]);
    const reasoningRef = useRef(null);

    // Collapse state lives in the Zustand store so it survives remounts during streaming.
    const collapseKey = id || (isStreaming ? '__streaming__' : null);
    const bodyCollapsed = useChatStore(state => collapseKey ? !!state.collapsedMessageIds[collapseKey] : false);
    const toggleMessageCollapsed = useChatStore(state => state.toggleMessageCollapsed);
    const setMessageCollapsed = useChatStore(state => state.setMessageCollapsed);

    const isUser = role === 'user';
    const displayContent = isStreaming ? streamingContent : content;
    const displayReasoning = isStreaming ? streamingReasoning : reasoning;

    // Deduped image grids for the bubble. The server now dedups find_image
    // results across calls within one reply, but this stays as the display
    // safety net: (1) already-saved messages from before that fix, and (2) the
    // model repeating a grid image as its own markdown ![](url) in the prose —
    // the prose copy keeps the model's caption/layout, so the GRID tile is the
    // one suppressed. A spec whose images all dedup away is dropped entirely.
    const bubbleImageSpecs = React.useMemo(() => {
        if (isUser || !Array.isArray(toolCalls)) return [];
        const specs = toolCalls.filter(tc => tc?.imageSpec && Array.isArray(tc.imageSpec.images)).map(tc => tc.imageSpec);
        if (!specs.length) return [];
        const norm = (u) => (typeof u === 'string' && !/^data:/i.test(u)
            ? u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase()
            : '');
        const seen = new Set();
        // Images the model already embedded in the prose as markdown.
        const md = typeof displayContent === 'string' ? displayContent : '';
        const mdImg = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
        let m;
        while ((m = mdImg.exec(md))) { const k = norm(m[1]); if (k) seen.add(k); }
        const out = [];
        for (const spec of specs) {
            const images = spec.images.filter(im => {
                const keys = [norm(im?.thumbnail), norm(im?.url)].filter(Boolean);
                if (!keys.length) return true; // data-url-only capture — can't key it, keep it
                if (keys.some(k => seen.has(k))) return false;
                keys.forEach(k => seen.add(k));
                return true;
            });
            if (images.length) out.push(images.length === spec.images.length ? spec : { ...spec, images });
        }
        return out;
    }, [isUser, toolCalls, displayContent]);

    const handleToggleReasoning = (e) => {
        e.stopPropagation();
        setReasoningExpanded(!reasoningExpanded);
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(displayContent || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    // Shared inline styles that use the design palette bridge.
    const aiBubble = {
        background: 'var(--bubble-ai-bg)',
        color: 'var(--ink)',
        border: 'var(--bubble-border)',
        borderRadius: 'var(--bubble-radius)',
        padding: 'var(--bubble-pad-y) var(--bubble-pad-x)',
        boxShadow: 'var(--bubble-shadow)',
        alignSelf: 'stretch',
        maxWidth: '100%',
        // Same overflow guard as the user bubble — a long unbroken token in
        // prose can't wrap at a space and would push past the edge. Code
        // blocks are unaffected (their own overflow-x container + white-space:
        // pre override wrapping).
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
    };
    // User bubble stays as a proper bubble even in flat-bubble mode
    // so right-aligned user text reads as a message, not a highlight.
    const userBubble = {
        background: 'var(--bubble-user-bg)',
        color: 'var(--bubble-user-ink)',
        borderRadius: 16,
        borderBottomRightRadius: 6,
        padding: '10px 15px',
        maxWidth: '78%',
        alignSelf: 'flex-end',
        // Long unbroken pastes (URLs, hashes, base64, file paths) have no
        // space to wrap at, so without this they overflow the bubble's right
        // edge. `anywhere` both breaks the run AND lets the box shrink to fit;
        // `pre-wrap` on children preserves multi-line paste layout.
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
    };
    const collapseBtn = {
        transition: 'opacity .12s, background .12s, color .12s',
        opacity: hovered || bodyCollapsed ? 1 : 0.4,
    };
    const actionsRow = {
        transition: 'opacity .12s',
        opacity: hovered ? 1 : 0,
    };

    return (
        <div
            style={{
                gap: 6,
                width: '100%',
                marginBottom: 'var(--msg-gap)',
            }}
            className={`msg-root flex flex-col min-w-0 ${isUser ? 'items-end' : 'items-start'} ${isStreaming ? '' : 'animate-fade-in'}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {/* File attachments above user messages — clickable to open
                FilePreviewModal. Only enable the click when the persisted
                attachment carries previewable data (content / dataUrl /
                sheets); old conversations may have only a filename stub. */}
            {isUser && attachments && attachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 2, maxWidth: '85%', justifyContent: 'flex-end' }}>
                    {attachments.map((att, i) => {
                        const previewable = isAttachmentPreviewable(att);
                        if (!previewable) {
                            return (
                                <div key={i} className="msg-attach-chip" title={att.filename || att.name}>
                                    <span>{att.filename || att.name}</span>
                                </div>
                            );
                        }
                        return (
                            <button
                                key={i}
                                type="button"
                                onClick={() => setPreviewAttachment(att)}
                                className="msg-attach-chip"
                                title="Click to preview"
                            >
                                <span>{att.filename || att.name}</span>
                                <Eye strokeWidth={1.75} />
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Meta row: badge + name + time + collapse toggle */}
            <div className="msg-meta" style={{
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                flexDirection: isUser ? 'row-reverse' : 'row',
                width: isUser ? undefined : '100%',
            }}>
                {isUser ? (
                    <div className="msg-badge msg-badge-user">
                        <User strokeWidth={2.25} />
                    </div>
                ) : (
                    <div className="msg-badge msg-badge-ai">
                        <Sparkles strokeWidth={2} />
                    </div>
                )}
                <span className="msg-name">{isUser ? 'You' : (modelName || 'Assistant')}</span>
                {timeStr && <span className="msg-time">{timeStr}</span>}
                {!isUser && displayContent && !isStreaming && collapseKey && (
                    <button
                        onClick={() => toggleMessageCollapsed(collapseKey)}
                        className="message-collapse-btn msg-collapse-btn ui-chip-btn"
                        style={collapseBtn}
                        title={bodyCollapsed ? 'Expand response' : 'Collapse response'}
                    >
                        <span style={{ display: 'inline-flex', transform: bodyCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }}>
                            <ChevronDown strokeWidth={2} />
                        </span>
                        <span>{bodyCollapsed ? 'Expand' : 'Collapse'}</span>
                    </button>
                )}
            </div>

            {/* Skip bubble entirely for user message with no content (paste-as-file case) */}
            {isUser && !displayContent ? null : (
                <div style={isUser ? userBubble : aiBubble} className={isUser ? 'message-user' : 'message-assistant'}>
                    {/* Reasoning / thinking dropdown */}
                    {displayReasoning && (
                        <div ref={reasoningRef} style={{ marginBottom: 10, marginLeft: -6 }}>
                            <button
                                onClick={handleToggleReasoning}
                                className="msg-thinking-toggle"
                                aria-expanded={reasoningExpanded}
                            >
                                <Sparkles strokeWidth={1.75} style={{ opacity: 0.7 }} />
                                <span>{isStreaming && !displayContent ? 'Thinking' : 'Thought process'}</span>
                                <span className="msg-thinking-count">· {displayReasoning.length.toLocaleString()} chars</span>
                                {reasoningExpanded
                                    ? <ChevronUp strokeWidth={2} />
                                    : <ChevronDown strokeWidth={2} />
                                }
                            </button>
                            {reasoningExpanded && (() => {
                                const steps = splitReasoningIntoSteps(displayReasoning);
                                const structured = steps.length >= 3;
                                return (
                                    <div className="msg-thinking-panel" style={{ marginLeft: 6 }}>
                                        {structured ? (
                                            <ol>
                                                {steps.map((step, i) => (
                                                    <li key={i}>
                                                        <span className="msg-thinking-n">{i + 1}.</span>
                                                        <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{step}</span>
                                                    </li>
                                                ))}
                                            </ol>
                                        ) : (
                                            <p>{displayReasoning}</p>
                                        )}
                                    </div>
                                );
                            })()}

                        </div>
                    )}

                    {/* Live tool-call milestones — short breadcrumb per
                        in-flight / completed tool so the user gets running
                        narration of what the model is actually doing
                        (separate from the bottom dot-chip). Only during
                        streaming; the collapsed chip strip below takes
                        over once the message is committed. */}
                    {isStreaming && Array.isArray(toolCalls) && toolCalls.length > 0 && (
                        <ToolMilestones toolCalls={toolCalls} />
                    )}

                    {/* Body content */}
                    {isStreaming && !displayContent ? (
                        <ThinkingIndicator label={deriveStreamingLabel({
                            toolCalls,
                            streamingStatus,
                            hasContent: false,
                            hasReasoning: !!displayReasoning,
                        })} />
                    ) : bodyCollapsed ? (
                        (() => {
                            const cleaned = (displayContent || '')
                                .replace(/```[\s\S]*?```/g, '[code]')
                                .replace(/`([^`]+)`/g, '$1')
                                .replace(/\*\*([^*]+)\*\*/g, '$1')
                                .replace(/\*([^*]+)\*/g, '$1')
                                .replace(/^#{1,6}\s+/gm, '')
                                .replace(/^[-*+]\s+/gm, '')
                                .replace(/^\d+\.\s+/gm, '');
                            const firstLine = (cleaned.split('\n').find(l => l.trim().length > 0) || '').trim();
                            const MAX = 90;
                            const preview = firstLine.length > MAX
                                ? firstLine.slice(0, MAX).replace(/\s+\S*$/, '') + '…'
                                : firstLine;
                            const chars = (displayContent || '').length;
                            return (
                                <button
                                    onClick={() => collapseKey && setMessageCollapsed(collapseKey, false)}
                                    className="msg-collapsed-preview"
                                >
                                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {preview || 'Collapsed response'}
                                    </span>
                                    <span style={{ color: 'var(--ink-4)', '--fs': '11.5px', flexShrink: 0 }}>
                                        {chars.toLocaleString()} chars · click to expand
                                    </span>
                                </button>
                            );
                        })()
                    ) : (
                        <MessageContent content={displayContent} isStreaming={isStreaming} />
                    )}

                    {/* Live status footer — keeps the activity indicator
                        visible WHILE content streams. Pre-content the
                        ThinkingIndicator above is shown instead. Hidden
                        once streaming finishes. */}
                    {isStreaming && displayContent && !bodyCollapsed && (() => {
                        const label = deriveStreamingLabel({
                            toolCalls,
                            streamingStatus,
                            hasContent: true,
                            hasReasoning: !!displayReasoning,
                        });
                        return (
                            <div
                                className="streaming-status-chip"
                                aria-live="polite"
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginTop: 10,
                                    padding: '0 10px 0 8px',
                                    borderRadius: 999,
                                    background: 'color-mix(in oklab, var(--accent, #6366f1) 10%, transparent)',
                                    border: '1px solid color-mix(in oklab, var(--accent, #6366f1) 22%, transparent)',
                                    color: 'var(--ink-3)',
                                    '--fs': '12px',
                                    lineHeight: 1,
                                    maxWidth: '100%',
                                }}
                            >
                                <div className="flex items-center gap-1">
                                    <div className="thinking-dot" style={{ animationDelay: '0s' }} />
                                    <div className="thinking-dot" style={{ animationDelay: '0.2s' }} />
                                    <div className="thinking-dot" style={{ animationDelay: '0.4s' }} />
                                </div>
                                <span style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    maxWidth: 360,
                                }}>{label}</span>
                            </div>
                        );
                    })()}

                    {/* Inline charts — surface render_chart results in the
                        main response body so users don't have to expand the
                        tool chip to see the visual. Charts also still render
                        inside the chip dropdown for transparency, but this
                        is where they belong as a first-class part of the
                        assistant's reply. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.some(tc => tc?.chartSpec) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {toolCalls.filter(tc => tc?.chartSpec).map((tc, idx) => (
                                <ChartBlock
                                    key={`bubble-chart-${idx}`}
                                    spec={tc.chartSpec}
                                    summary={tc.chartSummary || ''}
                                />
                            ))}
                        </div>
                    )}

                    {/* Inline images — surface find_image results as a thumbnail
                        grid in the main response body, same first-class treatment
                        as charts. The picture is what the user asked for, so it
                        belongs in the reply, not buried in the tool chip. */}
                    {!isUser && !bodyCollapsed && bubbleImageSpecs.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {bubbleImageSpecs.map((spec, idx) => (
                                <ImageBlock key={`bubble-image-${idx}`} spec={spec} />
                            ))}
                        </div>
                    )}

                    {/* Inline videos — surface find_video results as click-to-play
                        players in the main response body, same first-class
                        treatment as images/charts. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.some(tc => tc?.videoSpec) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: displayContent ? 12 : 0 }}>
                            {toolCalls.filter(tc => tc?.videoSpec).map((tc, idx) => (
                                <VideoBlock key={`bubble-video-${idx}`} spec={tc.videoSpec} />
                            ))}
                        </div>
                    )}

                    {/* Inline downloadable artifacts — surface every file the
                        model produced (PDFs, docx, xlsx, anything written to
                        /artifacts/) as a download card in the bubble itself,
                        same pattern as charts. The chip dropdown still shows
                        them for transparency, but the user shouldn't have to
                        expand a tool chip to grab a file they just asked for. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && (() => {
                        const all = [];
                        for (const tc of toolCalls) {
                            if (Array.isArray(tc?.artifacts)) {
                                for (const a of tc.artifacts) {
                                    if (a && a.url && a.name) all.push(a);
                                }
                            }
                        }
                        if (all.length === 0) return null;
                        return (
                            <div style={{ marginTop: displayContent ? 12 : 0 }}>
                                <ArtifactList artifacts={all} />
                            </div>
                        );
                    })()}

                    {/* Inline artifact chip — shown when the assistant response
                        contains one or more fenced code blocks. Click opens the
                        right-rail Artifacts panel. */}
                    {!isUser && !isStreaming && !bodyCollapsed && displayContent && onOpenArtifacts && (() => {
                        const matches = (displayContent || '').match(/```[\w-]*\s*(?:\[[^\]]+\])?\n[\s\S]*?```/g);
                        const count = matches ? matches.length : 0;
                        if (count === 0) return null;
                        const firstMatch = matches[0];
                        const langMatch = firstMatch.match(/^```(\w+)/);
                        const lang = langMatch ? langMatch[1] : 'code';
                        return (
                            <button
                                onClick={onOpenArtifacts}
                                className="msg-artifact-card"
                            >
                                <div className="msg-artifact-icon">
                                    <CodeIcon strokeWidth={1.75} />
                                </div>
                                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                    <div className="msg-artifact-title">
                                        {count} code artifact{count === 1 ? '' : 's'}
                                    </div>
                                    <div className="msg-artifact-sub">
                                        {lang}{count > 1 ? ` + ${count - 1} more` : ''} · Open in panel
                                    </div>
                                </div>
                                <Eye style={{ width: 14, height: 14, color: 'var(--ink-3)', flexShrink: 0 }} strokeWidth={1.75} />
                            </button>
                        );
                    })()}

                    {/* Search source chips */}
                    {!isUser && !isStreaming && !bodyCollapsed && Array.isArray(searchResults) && searchResults.length > 0 && (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                            <SearchSources sources={searchResults} />
                        </div>
                    )}

                    {/* Tool calls — always wrapped in a collapsible summary
                        so the chip strip stays unobtrusive. Defaults to
                        folded post-stream; expanded during streaming so
                        users see live progress. Charts also surface in the
                        main body above (see ChartBlock pass) — this strip
                        is the transparency footer. */}
                    {!isUser && !bodyCollapsed && Array.isArray(toolCalls) && toolCalls.length > 0 && (() => {
                        // Group header summary: count unique tool names so the user
                        // sees "web_search, fetch_url (x5)" rather than a raw count.
                        const counts = {};
                        for (const tc of toolCalls) {
                            const nm = tc?.name || tc?.label || tc?.type || 'tool';
                            counts[nm] = (counts[nm] || 0) + 1;
                        }
                        const summary = Object.entries(counts)
                            .map(([n, c]) => c > 1 ? `${n} ×${c}` : n)
                            .join(', ');
                        return (
                            <div className="msg-tools-section">
                                <button
                                    type="button"
                                    onClick={() => setToolsExpanded(v => !v)}
                                    className="msg-tools-toggle"
                                    aria-expanded={toolsExpanded}
                                    aria-label={toolsExpanded ? 'Collapse tool calls' : 'Expand tool calls'}
                                >
                                    <ChevronDown strokeWidth={2} />
                                    <span className="msg-tools-count">
                                        {toolCalls.length} tool {toolCalls.length === 1 ? 'call' : 'calls'}
                                    </span>
                                    <span style={{ color: 'var(--ink-4)' }}>·</span>
                                    <span className="msg-tools-summary">{summary}</span>
                                </button>
                                {toolsExpanded && (
                                    <div className="msg-tools-list">
                                        {toolCalls.map((tc, idx) => (
                                            <ToolCallBlock key={idx} tool={tc} />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Partial / interrupted indicator */}
                    {!isUser && !isStreaming && (needsContinuation || isPartial) && (
                        <div className="msg-partial-banner">
                            <AlertCircle strokeWidth={2} />
                            <span>Response cut off</span>
                        </div>
                    )}
                </div>
            )}

            {/* Hover-revealed action row (assistant messages) */}
            {!isUser && displayContent && !isStreaming && (
                <div className="message-actions-row" style={{ ...actionsRow, alignSelf: 'stretch', marginLeft: -8 }}>
                    <button
                        onClick={handleCopy}
                        className={`ui-chip-btn ${copied ? 'is-active' : ''}`}
                        title={copied ? 'Copied!' : 'Copy response'}
                    >
                        {copied ? <Check strokeWidth={2.25} /> : <Copy strokeWidth={1.75} />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>

                    {(needsContinuation || isPartial) && onContinue && (
                        <button
                            onClick={() => onContinue(id, content)}
                            disabled={isLoading}
                            className={`ui-chip-btn ${isLoading ? '' : 'is-accent'}`}
                            title="Continue generating"
                        >
                            <PlayCircle strokeWidth={1.75} className={isLoading ? 'animate-pulse' : ''} />
                            <span>{isLoading ? 'Continuing…' : 'Continue'}</span>
                        </button>
                    )}

                    <span className="msg-stats">
                        {responseTime && (
                            <span title="Response time">
                                <Clock strokeWidth={1.75} />
                                {responseTime < 1000 ? `${responseTime}ms` : `${(responseTime / 1000).toFixed(1)}s`}
                            </span>
                        )}
                        {tokenCount && (
                            <span title="Tokens">
                                <Zap strokeWidth={1.75} />
                                {tokenCount.toLocaleString?.() || tokenCount}
                            </span>
                        )}
                    </span>
                </div>
            )}

            {previewAttachment && (
                <FilePreviewModal
                    attachment={previewAttachment}
                    onClose={() => setPreviewAttachment(null)}
                />
            )}
        </div>
    );
});
