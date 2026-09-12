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
    // A running delegate chip opens itself: the worker agents' tool calls
    // are the whole point of watching it, like a chart auto-expanding.
    const isDelegateChip = tool?.type === 'native_tool_call' && tool?.label === 'delegate';
    useEffect(() => {
        if (isDelegateChip && running) setOpen(true);
    }, [isDelegateChip, running]);

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
        agents,
        agentResults,
    } = tool;
    // Per-agent view for a delegate chip: live progress frames while running,
    // else the compact results lifted off the tool result, else (a chip saved
    // server-side in the background) the raw delegate result if it is there.
    const agentRows = isDelegateChip ? mergeAgentRows(agents, agentResults, tool.result) : null;
    const hasAgents = Array.isArray(agentRows) && agentRows.length > 0;

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
    if (tool.purpose) captionParts.push(String(tool.purpose));
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
    const hasDetail = isFailed || (preview && !isRunning) || hasSources || hasArgs || !!chartSpec || !!imageSpec || !!videoSpec || hasArtifacts || hasAgents;

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
                    {hasAgents && <AgentsPanel rows={agentRows} running={isRunning} />}
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
                // delegate's `tasks`: one line per worker brief, not one JSON blob.
                if (k === 'tasks' && Array.isArray(v) && v.length && v.every(t => t && typeof t === 'object')) {
                    return (
                        <React.Fragment key={k}>
                            <span className="tool-chip-argk">{k}</span>
                            <span className="tool-chip-argv">
                                {v.map((t, i) => {
                                    const brief = String(t.task || t.instructions || t.prompt || t.description || '');
                                    return (
                                        <span key={i} style={{ display: 'block' }}>
                                            <strong>{String(t.name || t.label || `worker ${i + 1}`)}</strong>
                                            {brief ? ` — ${brief.length > 90 ? brief.slice(0, 90) + '…' : brief}` : ''}
                                        </span>
                                    );
                                })}
                            </span>
                        </React.Fragment>
                    );
                }
                let display;
                if (v == null) display = String(v);
                else if (typeof v === 'string') display = v;
                else if (typeof v === 'object') {
                    try { display = JSON.stringify(v); } catch { display = String(v); }
                    if (display.length > 160) display = display.slice(0, 160) + '…';
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

// Merge the live progress rows (delegate_progress frames) with the final
// per-agent results into one row per agent. Live rows win for the tool list
// while the call is running; results supply the outcome/review at the end.
function mergeAgentRows(agents, agentResults, rawResult) {
    const live = Array.isArray(agents) ? agents : [];
    let finals = Array.isArray(agentResults) ? agentResults : [];
    if (!finals.length && rawResult && typeof rawResult === 'object' && Array.isArray(rawResult.results)) {
        finals = rawResult.results.map(x => ({
            name: x && x.name, status: x && x.status, calls: x && x.toolCalls, seconds: x && x.seconds, model: x && x.model,
            tools: Array.isArray(x && x.tools) ? x.tools : [],
            answerChars: x && typeof x.answer === 'string' ? x.answer.length : undefined,
            review: x && x.review ? { verdict: x.review.verdict, edited: !!x.review.edited, issues: Array.isArray(x.review.issues) ? x.review.issues.length : 0 } : undefined,
        }));
    }
    const byName = new Map();
    const order = [];
    const add = (name) => { const key = String(name || ''); if (!byName.has(key)) { byName.set(key, { name: key }); order.push(key); } return byName.get(key); };
    for (const a of live) {
        if (!a || typeof a !== 'object') continue;
        const row = add(a.name);
        row.phase = a.phase; row.calls = a.calls; row.current = a.current; row.chars = a.chars; row.preview = a.preview;
        if (a.model) row.model = a.model;
        row.tools = Array.isArray(a.tools) ? a.tools : row.tools;
    }
    for (const f of finals) {
        if (!f || typeof f !== 'object') continue;
        const row = add(f.name);
        row.status = f.status; row.seconds = f.seconds; row.review = f.review;
        if (f.model) row.model = f.model;
        if (typeof f.calls === 'number') row.calls = f.calls;
        if (typeof f.answerChars === 'number') row.chars = f.answerChars;
        // Final tool list is strings ("web — purpose"); keep the structured
        // live list when we have it, else parse the strings.
        if (!Array.isArray(row.tools) || !row.tools.length) {
            row.tools = (f.tools || []).map(s => {
                const str = String(s);
                const failed = /\(failed\)/.test(str);
                const cleaned = str.replace(/\s*\(failed\)/, '');
                const idx = cleaned.indexOf(' — ');
                return idx >= 0
                    ? { name: cleaned.slice(0, idx), purpose: cleaned.slice(idx + 3), status: failed ? 'failed' : 'ok' }
                    : { name: cleaned, purpose: '', status: failed ? 'failed' : 'ok' };
            });
        }
        if (!row.phase) row.phase = f.status === 'ok' ? 'done' : (f.status || 'done');
    }
    return order.map(k => byName.get(k));
}

const PHASE_LABEL = { starting: 'starting', running: 'running', checking: 'checking', done: 'done', failed: 'failed', timeout: 'timed out', cancelled: 'cancelled', empty: 'no answer', ok: 'done' };
function phaseColor(phase) {
    if (phase === 'done' || phase === 'ok') return 'var(--ok)';
    if (phase === 'failed' || phase === 'timeout' || phase === 'cancelled' || phase === 'empty') return 'var(--danger)';
    return 'var(--accent)';
}
function fmtSecs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const s = ms / 1000;
    return s >= 1 ? `${s.toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// One block per worker agent: header (name · phase · calls · time), the
// agent's tool calls in order with status dots, a muted draft preview, and
// the checker verdict when there is one.
function AgentsPanel({ rows, running }) {
    return (
        <div className="tool-chip-agents" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
            {rows.map((row, i) => {
                const phase = row.phase || (running ? 'running' : 'done');
                const live = phase === 'starting' || phase === 'running' || phase === 'checking';
                const color = phaseColor(phase);
                const tools = Array.isArray(row.tools) ? row.tools : [];
                const rev = row.review;
                const revText = rev
                    ? (rev.edited ? '✎ edited by checker' : rev.verdict === 'issues' ? `⚠ ${rev.issues} issue${rev.issues === 1 ? '' : 's'}` : rev.verdict === 'pass' ? '✓ checked' : null)
                    : null;
                return (
                    <div key={`${row.name}-${i}`} style={{ borderLeft: `2px solid ${color}`, paddingLeft: 8, minWidth: 0 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: 1.3 }}>
                            <strong style={{ color: 'var(--ink-2, inherit)' }}>{row.name || 'worker'}</strong>
                            <span style={{ ...badgeStyle(color, 12, 30), borderRadius: 999, padding: '0 6px', fontSize: 10.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {live && <Loader2 className="animate-spin" style={{ width: 9, height: 9 }} strokeWidth={2.5} />}
                                {PHASE_LABEL[phase] || phase}
                            </span>
                            {row.model && (
                                <span title={`This worker runs on ${row.model}`} style={{ color: 'var(--ink-4)', fontSize: 10.5, fontFamily: 'var(--font-mono, monospace)', border: '1px solid var(--rule, rgba(128,128,128,.3))', borderRadius: 4, padding: '0 4px' }}>{row.model}</span>
                            )}
                            {typeof row.calls === 'number' && (
                                <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>{row.calls} call{row.calls === 1 ? '' : 's'}</span>
                            )}
                            {typeof row.seconds === 'number' && !live && (
                                <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>done in {row.seconds}s</span>
                            )}
                            {typeof row.chars === 'number' && row.chars > 0 && (
                                <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>{row.chars} chars</span>
                            )}
                            {revText && (
                                <span style={{ fontSize: 11, color: rev.edited ? 'var(--accent)' : rev.verdict === 'issues' ? 'var(--danger)' : 'var(--ok)' }}>{revText}</span>
                            )}
                        </div>
                        {tools.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                                {tools.map((t, j) => {
                                    const st = t.status === 'running' ? 'running' : t.status === 'failed' ? 'failed' : 'ok';
                                    const dot = st === 'running' ? 'var(--accent)' : st === 'failed' ? 'var(--danger)' : 'var(--ok)';
                                    return (
                                        <div key={j} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, fontSize: 11.5, lineHeight: 1.35, minWidth: 0 }}>
                                            <span className={st === 'running' ? 'animate-pulse' : ''} style={{ width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0, alignSelf: 'center' }} />
                                            <code style={{ fontSize: 11, color: 'var(--ink-3, inherit)' }}>{String(t.name || 'tool').replace(/_/g, ' ')}</code>
                                            {t.purpose && <span style={{ color: 'var(--ink-3, inherit)', minWidth: 0, overflowWrap: 'anywhere' }}>{t.purpose}</span>}
                                            {typeof t.ms === 'number' && <span style={{ color: 'var(--ink-4)', fontSize: 10.5 }}>{fmtSecs(t.ms)}</span>}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {live && !tools.length && row.current && (
                            <div style={{ fontSize: 11.5, color: 'var(--ink-4)', marginTop: 3 }}>{row.current}</div>
                        )}
                        {row.preview && (
                            <div style={{ fontSize: 11.5, color: 'var(--ink-4)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontStyle: 'italic' }}>
                                …{row.preview}
                            </div>
                        )}
                    </div>
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
