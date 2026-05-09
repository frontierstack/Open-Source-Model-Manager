import React from 'react';
import { Terminal as TerminalIcon, X as ClearIcon, Search as SearchIcon } from 'lucide-react';
import SystemResourceMonitor from './SystemResourceMonitor';

// Phase 2: Tailwind rewrite of the Logs tab. State + refs + handlers
// are passed in as props so the data flow stays identical to the
// previous MUI implementation. Surface chrome reads CSS variables so
// the panel tracks theme + accent picks.
//
// The dark log-rendering area (bg #0a0a0f, level coloring, syntax
// highlights) is intentionally NOT themed — log readability against
// a fixed dark surface is more important than matching every theme.
//
// Props:
//   logs           array of log entries (string | { level, message, timestamp })
//   setLogs        setter; only used by the Clear button
//   logFilter      'all' | 'error' | 'warning' | 'success' | 'info'
//   setLogFilter
//   logSearch      string
//   setLogSearch
//   logsContainerRef, logsEndRef   refs for auto-scroll
//   handleLogsScroll               onScroll handler
//   isMobile       bool — used to swap Clear icon-button vs full button
//   systemStats, systemStatsHistory — passed through to SystemResourceMonitor

const LEVEL_CONFIG = {
    error:   { color: '#ef4444', bg: 'rgba(239,68,68,0.06)',   icon: '✗', border: 'rgba(239,68,68,0.15)' },
    warning: { color: '#f59e0b', bg: 'rgba(245,158,11,0.04)',  icon: '▲', border: 'rgba(245,158,11,0.10)' },
    success: { color: '#22c55e', bg: 'rgba(34,197,94,0.04)',   icon: '✓', border: 'rgba(34,197,94,0.10)' },
    info:    { color: '#6b7280', bg: 'transparent',            icon: '│', border: 'transparent'         },
};

const FILTER_PILLS = [
    { key: 'all',     label: 'All',      color: null      },
    { key: 'error',   label: 'Errors',   color: '#ef4444' },
    { key: 'warning', label: 'Warnings', color: '#f59e0b' },
    { key: 'success', label: 'Success',  color: '#22c55e' },
    { key: 'info',    label: 'Info',     color: '#a1a1aa' },
];

function FilterPill({ active, label, count, color, onClick }) {
    // Active uses the accent color from the active theme/accent override.
    // Inactive: muted text on transparent bg with hover. Each pill's
    // color is semantic (red for errors etc.); only the All pill uses
    // the theme accent.
    const tint = color || 'var(--accent-primary)';
    const isAll = !color;
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.7rem] font-medium transition"
            style={
                active
                    ? {
                          color: tint,
                          backgroundColor: isAll ? 'var(--accent-muted)' : `${color}1F`,
                          borderColor: isAll ? 'var(--border-focus)' : `${color}66`,
                      }
                    : {
                          color: 'var(--text-tertiary)',
                          backgroundColor: 'transparent',
                          borderColor: 'var(--border-primary)',
                      }
            }
        >
            <span>{label}</span>
            <span
                className="rounded px-1 text-[0.6rem] font-semibold tabular-nums"
                style={{
                    backgroundColor: active ? 'rgba(0,0,0,0.25)' : 'var(--bg-tertiary)',
                    color: active ? tint : 'var(--text-muted)',
                }}
            >
                {count}
            </span>
        </button>
    );
}

// Inline syntax highlights for log lines. Returns an array of <span>s.
// Identical regex set to the previous MUI implementation; only the
// surrounding shell changed.
function formatMessageInline(msg) {
    const parts = [];
    let remaining = msg;
    let key = 0;
    while (remaining.length > 0) {
        let match = remaining.match(/^\[([^\]]+)\]/);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.08)', padding: '0 4px', borderRadius: 3, fontSize: '0.72rem' }}>[{match[1]}]</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(Step \d+\/\d+:)/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#a5b4fc', backgroundColor: 'rgba(99,102,241,0.15)', padding: '1px 6px', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(\d+(?:\.\d+)?%)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#fbbf24', fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(\d+(?:\.\d+)?\s*(?:GB|MB|KB|K|B|TB))\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#c084fc' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:\/[\w.\-]+){2,}(?:\/[\w.\-]*)?)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#93c5fd', fontSize: '0.73rem' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:port\s+)\d{2,5}|:\d{2,5})\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#34d399' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(Creating|Stopping|Deleting|Starting|Syncing|Removing|Restarting|Switching|Checking|Loading|Verifying|Downloading)\b/);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#e2e8f0', fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(ERROR|Error|WARNING|Warning|WARN)(:?\s*)/i);
        if (match) {
            const isErr = match[1].toLowerCase().startsWith('err');
            parts.push(<span key={key++} style={{ color: isErr ? '#f87171' : '#fbbf24', fontWeight: 700, fontSize: '0.72rem', backgroundColor: isErr ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)', padding: '0 4px', borderRadius: 2 }}>{match[1]}</span>);
            if (match[2]) parts.push(<span key={key++}>{match[2]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:llamacpp|vllm)-[\w\-]+)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#22d3ee', fontSize: '0.73rem' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(API key)\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: '#c084fc', fontWeight: 500 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(={3,}[^=]*={3,})/);
        if (match) {
            parts.push(<span key={key++} style={{ color: 'rgba(255,255,255,0.35)', letterSpacing: '1px' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^[^\[%\/\\(=ES CWADLRV]*./);
        if (match) {
            parts.push(<span key={key++}>{match[0]}</span>);
            remaining = remaining.slice(match[0].length);
        } else {
            parts.push(<span key={key++}>{remaining[0]}</span>);
            remaining = remaining.slice(1);
        }
    }
    return parts;
}

function LogRow({ entry }) {
    let message = typeof entry === 'string' ? entry : entry.message;
    const level = typeof entry === 'string' ? 'info' : (entry.level || 'info');

    // Strip Docker container timestamps from message and capture them
    // for the timestamp column. Same regex set as the legacy code.
    let extractedTime = null;
    const dockerTsMatch = message.match(/^(.{0,2}?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s*/);
    if (dockerTsMatch) {
        extractedTime = new Date(dockerTsMatch[2]);
        message = (dockerTsMatch[1] && /\w/.test(dockerTsMatch[1]) ? '' : '') + message.slice(dockerTsMatch[0].length);
    }
    message = message.replace(/^(\[[^\]]+\])\s*.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/g, '$1 ');
    message = message.replace(/.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s*/g, ' ');

    const timestamp = entry.timestamp ? new Date(entry.timestamp) : extractedTime;
    const timeStr = timestamp && !isNaN(timestamp.getTime())
        ? timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '';

    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;
    const isStepMsg = /^Step \d+\/\d+:/i.test(message);
    const isSeparator = /^={3,}/.test(message);
    const baseTextColor = level === 'error' ? '#f87171'
        : level === 'success' ? '#4ade80'
        : level === 'warning' ? '#fbbf24'
        : 'rgba(255,255,255,0.65)';

    const rowStyle = {
        backgroundColor: isStepMsg ? 'rgba(99,102,241,0.04)'
            : isSeparator ? 'rgba(255,255,255,0.02)'
            : cfg.bg,
        borderLeft: `2px solid ${isStepMsg ? 'rgba(99,102,241,0.3)' : cfg.border}`,
        borderTop: isStepMsg ? '1px solid rgba(255,255,255,0.04)' : 'none',
        paddingTop: isStepMsg ? '0.6rem' : isSeparator ? '0.55rem' : '0.32rem',
        paddingBottom: isStepMsg ? '0.6rem' : isSeparator ? '0.55rem' : '0.32rem',
        marginTop: isStepMsg ? '0.35rem' : 0,
        transition: 'background-color 0.15s',
    };

    return (
        <div className="flex items-start gap-0 px-3 hover:bg-white/[0.03]" style={rowStyle}>
            <span
                className="flex-shrink-0 mr-2 mt-[2px] select-none whitespace-pre"
                style={{
                    fontFamily: '"Fira Code", monospace',
                    fontSize: '0.68rem',
                    color: 'rgba(255,255,255,0.18)',
                }}
            >
                {timeStr ? `${timeStr} ` : '         '}
                <span style={{ color: cfg.color, fontSize: '0.72rem' }}>{cfg.icon}</span>
            </span>
            <div
                className="flex-1 break-words"
                style={{
                    fontFamily: '"Fira Code", monospace',
                    fontSize: '0.78rem',
                    color: baseTextColor,
                    lineHeight: 1.55,
                }}
            >
                {formatMessageInline(message)}
            </div>
        </div>
    );
}

export default function LogsPanel({
    logs = [],
    setLogs = () => {},
    logFilter = 'all',
    setLogFilter = () => {},
    logSearch = '',
    setLogSearch = () => {},
    logsContainerRef,
    logsEndRef,
    handleLogsScroll = () => {},
    isMobile = false,
    systemStats,
    systemStatsHistory,
}) {
    const logCounts = { all: logs.length, error: 0, warning: 0, success: 0, info: 0 };
    for (const l of logs) {
        const lv = (typeof l === 'string' ? 'info' : l.level) || 'info';
        if (logCounts[lv] !== undefined) logCounts[lv]++;
    }
    const filteredLogs = logs.filter((log) => {
        const message = typeof log === 'string' ? log : log.message;
        const level = typeof log === 'string' ? 'info' : log.level;
        if (logFilter !== 'all' && level !== logFilter) return false;
        if (logSearch && !message.toLowerCase().includes(logSearch.toLowerCase())) return false;
        return true;
    });

    return (
        <div
            className="flex flex-col gap-4"
            style={{
                height: 'calc(100vh - 200px)',
                minHeight: 500,
            }}
        >
            <div
                className="flex flex-1 flex-col overflow-hidden rounded-xl border"
                style={{
                    backgroundColor: 'var(--surface-primary, var(--bg-secondary))',
                    borderColor: 'var(--border-primary)',
                    minHeight: 0,
                }}
            >
                <div className="flex h-full flex-col p-4">
                    {/* Header */}
                    <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <TerminalIcon size={20} strokeWidth={1.75} style={{ color: 'var(--accent-primary)' }} />
                            <div>
                                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                    Process Logs
                                </div>
                                <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                    Real-time system, model, and operation logs
                                </div>
                            </div>
                        </div>
                        {isMobile ? (
                            <button
                                type="button"
                                onClick={() => setLogs([])}
                                aria-label="Clear logs"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md border transition"
                                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                            >
                                <ClearIcon size={16} strokeWidth={2} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setLogs([])}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition"
                                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                            >
                                <ClearIcon size={14} strokeWidth={2} />
                                <span>Clear</span>
                            </button>
                        )}
                    </div>

                    {/* Filter bar */}
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                        {FILTER_PILLS.map((f) => (
                            <FilterPill
                                key={f.key}
                                active={logFilter === f.key}
                                label={f.label}
                                count={logCounts[f.key]}
                                color={f.color}
                                onClick={() => setLogFilter(f.key)}
                            />
                        ))}

                        <div
                            className="ml-auto flex h-7 items-center gap-1.5 rounded-md border px-2"
                            style={{
                                backgroundColor: 'var(--bg-tertiary)',
                                borderColor: 'var(--border-primary)',
                                minWidth: 200,
                            }}
                        >
                            <SearchIcon size={14} strokeWidth={2} style={{ color: 'var(--text-tertiary)' }} />
                            <input
                                type="text"
                                placeholder="Search logs..."
                                value={logSearch}
                                onChange={(e) => setLogSearch(e.target.value)}
                                className="flex-1 bg-transparent text-xs outline-none"
                                style={{
                                    color: 'var(--text-primary)',
                                    fontFamily: '"Fira Code", monospace',
                                }}
                            />
                            {logSearch && (
                                <button
                                    type="button"
                                    onClick={() => setLogSearch('')}
                                    className="flex h-4 w-4 items-center justify-center rounded transition hover:bg-white/10"
                                    style={{ color: 'var(--text-tertiary)' }}
                                    aria-label="Clear search"
                                >
                                    <ClearIcon size={12} strokeWidth={2} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Showing count */}
                    {(logFilter !== 'all' || logSearch) && (
                        <div className="mb-1 text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                            Showing {filteredLogs.length} of {logs.length} entries
                        </div>
                    )}

                    {/* Log display — kept on a fixed dark surface for readability
                        regardless of theme (pure-#0a0a0f background, white-tone
                        text, level coloring) */}
                    <div
                        ref={logsContainerRef}
                        onScroll={handleLogsScroll}
                        className="flex-1 overflow-auto rounded-lg border"
                        style={{
                            backgroundColor: '#0a0a0f',
                            borderColor: 'rgba(255,255,255,0.08)',
                            paddingTop: '0.25rem',
                            paddingBottom: '0.25rem',
                        }}
                    >
                        {filteredLogs.length === 0 ? (
                            <div className="flex h-full min-h-[120px] items-center justify-center">
                                <span
                                    className="text-xs"
                                    style={{
                                        fontFamily: '"Fira Code", monospace',
                                        color: 'rgba(255,255,255,0.25)',
                                    }}
                                >
                                    {logs.length === 0 ? '● Waiting for activity...' : 'No matching log entries'}
                                </span>
                            </div>
                        ) : (
                            filteredLogs.map((entry, index) => (
                                <LogRow key={index} entry={entry} />
                            ))
                        )}
                        <div ref={logsEndRef} />
                    </div>
                </div>
            </div>

            <SystemResourceMonitor current={systemStats} history={systemStatsHistory} />
        </div>
    );
}
