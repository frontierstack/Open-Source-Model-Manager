import React from 'react';
import {
    Terminal as TerminalIcon,
    X as ClearIcon,
    Search as SearchIcon,
    Eye as EyeIcon,
    EyeOff as EyeOffIcon,
    Copy as CopyIcon,
    Download as DownloadIcon,
    ArrowDown as ArrowDownIcon,
    Check as CheckIcon,
    Layers as LayersIcon,
} from 'lucide-react';
import SystemResourceMonitor from './SystemResourceMonitor';
import { usePreferencesStore } from '../stores/usePreferencesStore';

// Tailwind Logs tab. State + refs + handlers are passed in as props so the data
// flow stays identical to the previous implementation. Surface chrome reads CSS
// variables so the panel tracks theme + accent picks.
//
// The log-rendering area is bright-text-on-dark on every theme except
// `theme-light`, where it flips to a light surface with dark text so a
// light-mode dashboard doesn't get a single gaping black tile in it.
//
// ORGANIZATION: lines arrive interleaved from many producers (each model
// container, [Chat], [Sandbox], [Error] …). Rather than repeating the source
// badge on every row, consecutive lines from one source render as a GROUP —
// one badge, one colored rail, a per-source hue — so the feed reads as blocks
// of related activity instead of an undifferentiated wall. A source filter and
// the level pills narrow it further.
//
// Props:
//   logs             array of log entries (string | { seq, level, message, timestamp })
//   setLogs          setter (kept for callers without onClear)
//   onClear          clears the view AND parks the server-history cursor
//   wsConnected      live socket state — drives the Live/Offline chip
//   historyBuffered  how many lines the server is holding for backfill
//   logFilter        'all' | 'error' | 'warning' | 'success' | 'info'
//   logSearch        string
//   logsContainerRef, logsEndRef   refs for auto-scroll
//   handleLogsScroll               onScroll handler (parent tracks near-bottom)
//   isMobile         bool
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

// Rendering every line of a long-running session is what makes the tab janky
// during a model load; the tail is what anyone actually reads.
const RENDER_CAP = 2000;

function FilterPill({ active, label, count, color, onClick, title }) {
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
            title={title}
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

// Small square icon button used across the header actions.
function IconAction({ onClick, title, children, active }) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border transition hover:brightness-125"
            style={{
                borderColor: active ? 'var(--border-focus)' : 'var(--border-primary)',
                color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                backgroundColor: active ? 'var(--accent-muted)' : 'transparent',
            }}
        >
            {children}
        </button>
    );
}

// Inline syntax highlights for log lines. Returns an array of <span>s.
// `isLight` flips the high-luminance hues (light indigo, near-white,
// pale blue, alpha-white separator) to their darker counterparts so
// the spans stay readable on the slate surface used in light mode.
function formatMessageInline(msg, isLight = false) {
    // Accent-driven hues — brackets like [Chat], [Sandbox], step badges and
    // container names ride the active accent so the log feed visibly
    // belongs to the user's theme. Semantic level colors (error/warning/
    // success) stay fixed because they carry meaning the accent shouldn't
    // override.
    const C = isLight
        ? {
              bracket:    'var(--accent-primary)',
              step:       'var(--accent-primary)',
              percent:    '#b45309',  // amber-700
              size:       '#7e22ce',  // purple-700
              path:       '#1d4ed8',  // blue-700
              port:       '#047857',  // emerald-700
              keyword:    '#0f172a',  // slate-900
              errFg:      '#b91c1c',  // red-700
              warnFg:     '#b45309',  // amber-700
              container:  'var(--accent-primary)',
              apiKey:     '#7e22ce',
              separator:  'rgba(15,23,42,0.30)',
              bracketBg:  'var(--accent-muted)',
              stepBg:     'var(--accent-muted)',
              errBg:      'rgba(185,28,28,0.10)',
              warnBg:     'rgba(180,83,9,0.10)',
          }
        : {
              bracket:    'var(--accent-primary)',
              step:       'var(--accent-primary)',
              percent:    '#fbbf24',
              size:       '#c084fc',
              path:       '#93c5fd',
              port:       '#34d399',
              keyword:    '#e2e8f0',
              errFg:      '#f87171',
              warnFg:     '#fbbf24',
              container:  'var(--accent-primary)',
              apiKey:     '#c084fc',
              separator:  'rgba(255,255,255,0.35)',
              bracketBg:  'var(--accent-muted)',
              stepBg:     'var(--accent-muted)',
              errBg:      'rgba(239,68,68,0.12)',
              warnBg:     'rgba(245,158,11,0.12)',
          };

    const parts = [];
    let remaining = msg;
    let key = 0;
    while (remaining.length > 0) {
        let match = remaining.match(/^\[([^\]]+)\]/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.bracket, backgroundColor: C.bracketBg, padding: '0 4px', borderRadius: 3, fontSize: '0.72rem' }}>[{match[1]}]</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(Step \d+\/\d+:)/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.step, backgroundColor: C.stepBg, padding: '1px 6px', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(\d+(?:\.\d+)?%)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.percent, fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(\d+(?:\.\d+)?\s*(?:GB|MB|KB|K|B|TB))\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.size }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:\/[\w.\-]+){2,}(?:\/[\w.\-]*)?)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.path, fontSize: '0.73rem' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:port\s+)\d{2,5}|:\d{2,5})\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.port }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(Creating|Stopping|Deleting|Starting|Syncing|Removing|Restarting|Switching|Checking|Loading|Verifying|Downloading)\b/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.keyword, fontWeight: 600 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(ERROR|Error|WARNING|Warning|WARN)(:?\s*)/i);
        if (match) {
            const isErr = match[1].toLowerCase().startsWith('err');
            parts.push(<span key={key++} style={{ color: isErr ? C.errFg : C.warnFg, fontWeight: 700, fontSize: '0.72rem', backgroundColor: isErr ? C.errBg : C.warnBg, padding: '0 4px', borderRadius: 2 }}>{match[1]}</span>);
            if (match[2]) parts.push(<span key={key++}>{match[2]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^((?:llamacpp|sglang)-[\w\-]+)/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.container, fontSize: '0.73rem' }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(API key)\b/i);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.apiKey, fontWeight: 500 }}>{match[1]}</span>);
            remaining = remaining.slice(match[0].length);
            continue;
        }
        match = remaining.match(/^(={3,}[^=]*={3,})/);
        if (match) {
            parts.push(<span key={key++} style={{ color: C.separator, letterSpacing: '1px' }}>{match[1]}</span>);
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

// Model-container lines arrive as
//   "[<long model name>] 931.20.557.923 I srv slot_update: ..."
// — a llama.cpp relative timestamp + a level letter + a subsystem-tagged
// debug line. Those internal lines (srv/slot/print_timing/statistics/
// reasoning-budget) are pure engine noise that floods the feed and buries
// the curated [Chat]/[Sandbox] activity lines. This classifier splits off
// the model badge, strips the relative timestamp, and flags the low-value
// engine-internal lines so the panel can hide them behind a toggle.
const ENGINE_BODY_RE = /^[IWED]\s+(srv|slot|statistics?|reasoning-budget|graph|sampler|kv-?cache|kv|main|loader|ggml|llama|server|common|init|context|batch)\b/i;

function analyzeLogLine(rawMessage) {
    let msg = String(rawMessage);
    // Strip any Docker container timestamps the server didn't (defensive;
    // the model stream already removes them server-side).
    msg = msg
        .replace(/^(\[[^\]]+\])\s*.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/, '$1 ')
        .replace(/^.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/, '');

    let model = null;
    const fullBadge = msg.match(/^\[([^\]]+)\]\s*/);
    if (fullBadge) {
        model = fullBadge[1];
        msg = msg.slice(fullBadge[0].length);
    } else {
        // Docker multiplex chunk boundaries occasionally drop the opening
        // "[" and leave a "…name] <reltime> I srv …" fragment.
        const frag = msg.match(/^([^\[\]]{1,48})\]\s+(?=\d+\.\d+\.\d+\.\d+\s+[IWED]\s)/);
        if (frag) {
            model = '…' + frag[1].trim();
            msg = msg.slice(frag[0].length);
        }
    }

    // Drop the llama.cpp relative timestamp ("931.20.557.923").
    const body = msg.replace(/^\d+\.\d+\.\d+\.\d+\s+/, '');
    const isEngine = !!model && ENGINE_BODY_RE.test(body);
    return { model, body, isEngine };
}

const MODELISH_RE = /gguf|llamacpp|sglang/i;
function isModelContainer(model) {
    return !!model && (MODELISH_RE.test(model) || model.length > 22 || model.startsWith('…'));
}
function shortModelLabel(model) {
    return model.length <= 22 ? model : model.slice(0, 20) + '…';
}

// A stable hue per source so two models running side by side are visually
// separable at a glance without anyone configuring anything. Curated sources
// ([Chat], [Sandbox], [Error] …) keep the theme accent — they are the app
// talking about itself, and the accent is what the user picked for that.
const CURATED = new Set(['chat', 'sandbox', 'error', 'system', 'memory', 'automation', 'pi', 'webapp']);
function sourceHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
}
function sourceStyle(name, isLight) {
    if (!name || CURATED.has(name.toLowerCase())) {
        return { rail: 'var(--accent-primary)', fg: 'var(--accent-primary)', bg: 'var(--accent-muted)' };
    }
    const hue = sourceHue(name);
    return isLight
        ? { rail: `hsl(${hue} 55% 48%)`, fg: `hsl(${hue} 60% 32%)`, bg: `hsl(${hue} 70% 94%)` }
        : { rail: `hsl(${hue} 60% 58%)`, fg: `hsl(${hue} 70% 74%)`, bg: `hsl(${hue} 60% 60% / 0.14)` };
}

function timeOf(entry) {
    const t = entry && typeof entry === 'object' ? entry.timestamp : null;
    const d = t ? new Date(t) : null;
    return d && !isNaN(d.getTime()) ? d : null;
}
function timeStrOf(entry) {
    const d = timeOf(entry);
    return d ? d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function LogRow({ entry, level = 'info', meta, isLight, showBadge, onPickSource }) {
    const { model, body, isEngine } = meta || analyzeLogLine(typeof entry === 'string' ? entry : entry.message);
    const timeStr = timeStrOf(entry);

    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;
    const isStepMsg = /^Step \d+\/\d+:/i.test(body);
    const isSeparator = /^={3,}/.test(body);
    // Default text fades to off-white on dark surfaces and slate on the
    // light surface; the saturated error/success/warning hues read fine
    // on either.
    const baseTextColor = level === 'error' ? (isLight ? '#dc2626' : '#f87171')
        : level === 'success' ? (isLight ? '#15803d' : '#4ade80')
        : level === 'warning' ? (isLight ? '#b45309' : '#fbbf24')
        : isEngine ? (isLight ? 'rgba(15,23,42,0.5)' : 'rgba(255,255,255,0.42)')
        : (isLight ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.65)');

    const stepBg = isLight ? 'rgba(99,102,241,0.10)' : 'rgba(99,102,241,0.04)';
    const separatorBg = isLight ? 'rgba(15,23,42,0.04)' : 'rgba(255,255,255,0.02)';

    const rowStyle = {
        backgroundColor: isStepMsg ? stepBg : isSeparator ? separatorBg : cfg.bg,
        paddingTop: isStepMsg || isSeparator ? '0.5rem' : '0.26rem',
        paddingBottom: isStepMsg || isSeparator ? '0.5rem' : '0.26rem',
        transition: 'background-color 0.15s',
    };

    const hoverClass = isLight ? 'hover:bg-black/[0.035]' : 'hover:bg-white/[0.035]';
    const tsColor = isLight ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.20)';
    const srcStyle = model ? sourceStyle(model, isLight) : null;

    return (
        <div className={`group flex items-start gap-0 pl-2 pr-3 ${hoverClass}`} style={rowStyle}>
            <span
                className="flex-shrink-0 mr-2 mt-[2px] select-none whitespace-pre tabular-nums"
                style={{ fontFamily: '"Fira Code", monospace', fontSize: '0.68rem', color: tsColor }}
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
                {/* The badge prints once per run of same-source lines — the
                    group rail carries the identity for the rest. */}
                {model && showBadge && (
                    <button
                        type="button"
                        title={`Show only ${model}`}
                        onClick={() => onPickSource && onPickSource(model)}
                        style={{
                            color: srcStyle.fg,
                            backgroundColor: srcStyle.bg,
                            padding: '0 5px',
                            borderRadius: 3,
                            fontSize: '0.7rem',
                            marginRight: 6,
                            cursor: 'pointer',
                        }}
                    >
                        {isModelContainer(model) ? shortModelLabel(model) : model}
                    </button>
                )}
                {formatMessageInline(body, isLight)}
            </div>
        </div>
    );
}

export default function LogsPanel({
    logs = [],
    setLogs = () => {},
    onClear,
    wsConnected = false,
    historyBuffered = 0,
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
    // Subscribe to theme so the log surface re-renders when the picker changes.
    const theme = usePreferencesStore((s) => s.theme);
    const isLight = theme === 'light';
    const logSurfaceBg = isLight ? '#f8fafc' : '#0a0a0f';
    const logSurfaceBorder = isLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.08)';
    const emptyTextColor = isLight ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.25)';

    // Engine-internal llama.cpp lines are hidden by default so the curated
    // activity feed reads cleanly; toggle to bring the raw firehose back.
    const [showVerbose, setShowVerbose] = React.useState(false);
    const [sourceFilter, setSourceFilter] = React.useState('all');
    const [copied, setCopied] = React.useState(false);
    const [atBottom, setAtBottom] = React.useState(true);

    const clear = onClear || (() => setLogs([]));

    // Decorate once: classify + clean each line, used by counting, grouping and
    // rendering so we don't run the regexes several times per line.
    const decorated = React.useMemo(() => logs.map((entry, i) => {
        const message = typeof entry === 'string' ? entry : (entry.message || '');
        const level = typeof entry === 'string' ? 'info' : (entry.level || 'info');
        const meta = analyzeLogLine(message);
        return {
            entry,
            message,
            level,
            meta,
            source: meta.model || 'System',
            key: (entry && typeof entry === 'object' && entry.seq != null) ? `s${entry.seq}` : `i${i}`,
        };
    }), [logs]);

    const logCounts = { all: logs.length, error: 0, warning: 0, success: 0, info: 0 };
    const sourceCounts = new Map();
    for (const d of decorated) {
        if (logCounts[d.level] !== undefined) logCounts[d.level]++;
        sourceCounts.set(d.source, (sourceCounts.get(d.source) || 0) + 1);
    }
    const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]);
    const engineHiddenCount = decorated.filter((d) => d.meta.isEngine && d.level === 'info').length;
    // A search reveals everything (so engine lines stay findable); otherwise
    // the toggle governs visibility. Errors/warnings are never hidden.
    const hideEngine = !showVerbose && !logSearch;

    const filteredLogs = React.useMemo(() => decorated.filter((d) => {
        if (hideEngine && d.meta.isEngine && d.level === 'info') return false;
        if (logFilter !== 'all' && d.level !== logFilter) return false;
        if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
        if (logSearch && !d.message.toLowerCase().includes(logSearch.toLowerCase())) return false;
        return true;
    }), [decorated, hideEngine, logFilter, sourceFilter, logSearch]);

    // Only the tail is rendered; a long model load can leave tens of thousands
    // of lines in the buffer and mounting all of them is what makes the tab
    // stutter. The trimmed count is reported so nothing looks silently missing.
    const visible = filteredLogs.length > RENDER_CAP ? filteredLogs.slice(-RENDER_CAP) : filteredLogs;
    const trimmed = filteredLogs.length - visible.length;

    // Mark the first row of each run of same-source lines: it carries the badge
    // and opens a new group block. The rest of the run just gets the rail.
    const rows = visible.map((d, i) => ({
        ...d,
        startsGroup: i === 0 || visible[i - 1].source !== d.source,
    }));

    const onScroll = (e) => {
        handleLogsScroll(e);
        const el = e.currentTarget;
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    };

    const jumpToLatest = () => {
        const el = logsContainerRef && logsContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        setAtBottom(true);
    };

    const asText = () => visible
        .map((d) => `${timeStrOf(d.entry)} [${d.level.toUpperCase()}] ${d.message}`)
        .join('\n');

    const copyAll = async () => {
        try {
            await navigator.clipboard.writeText(asText());
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        } catch (_) { /* clipboard blocked (insecure context) — nothing to do */ }
    };

    const downloadAll = () => {
        try {
            const blob = new Blob([asText()], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `process-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (_) { /* download blocked — nothing to do */ }
    };

    const filtersActive = logFilter !== 'all' || sourceFilter !== 'all' || !!logSearch || (hideEngine && engineHiddenCount > 0);
    const firstTime = timeStrOf(decorated[0] && decorated[0].entry);
    const lastTime = timeStrOf(decorated[decorated.length - 1] && decorated[decorated.length - 1].entry);

    // The resource monitor takes its natural height, and on a multi-GPU host that
    // is tall enough to squeeze the log feed down to a few visible lines. Growing
    // past the viewport (the page scrolls) and giving the feed a floor keeps the
    // logs the subject of the Logs tab.
    return (
        <div className="flex flex-col gap-4" style={{ minHeight: 'calc(100vh - 200px)' }}>
            <div
                className="flex flex-1 flex-col overflow-hidden rounded-xl border"
                style={{
                    backgroundColor: 'var(--surface-primary, var(--bg-secondary))',
                    borderColor: 'var(--border-primary)',
                    minHeight: 460,
                }}
            >
                <div className="flex h-full flex-col p-4">
                    {/* Header — identity, live state, actions */}
                    <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <TerminalIcon size={20} strokeWidth={1.75} style={{ color: 'var(--accent-primary)' }} />
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                        Process Logs
                                    </span>
                                    {/* Collection is server-side now, so "Offline" means this
                                        browser is not receiving — not that logging stopped. */}
                                    <span
                                        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[1px] text-[0.62rem] font-medium uppercase tracking-wide"
                                        title={wsConnected
                                            ? 'Streaming live from the server'
                                            : 'This page is not connected. Logging continues on the server and the gap is filled when the connection returns.'}
                                        style={{
                                            color: wsConnected ? '#22c55e' : '#f59e0b',
                                            borderColor: wsConnected ? 'rgba(34,197,94,0.35)' : 'rgba(245,158,11,0.35)',
                                            backgroundColor: wsConnected ? 'rgba(34,197,94,0.10)' : 'rgba(245,158,11,0.10)',
                                        }}
                                    >
                                        <span
                                            className="h-1.5 w-1.5 rounded-full"
                                            style={{
                                                backgroundColor: wsConnected ? '#22c55e' : '#f59e0b',
                                                boxShadow: wsConnected ? '0 0 0 3px rgba(34,197,94,0.15)' : 'none',
                                            }}
                                        />
                                        {wsConnected ? 'Live' : 'Offline'}
                                    </span>
                                </div>
                                <div className="truncate text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                                    {logs.length > 0 ? (
                                        <>
                                            {logs.length.toLocaleString()} entries
                                            {firstTime && lastTime ? ` · ${firstTime} → ${lastTime}` : ''}
                                            {historyBuffered > 0 ? ` · ${historyBuffered.toLocaleString()} kept on the server` : ''}
                                        </>
                                    ) : (
                                        'System, model, and operation activity'
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            <IconAction onClick={copyAll} title="Copy visible logs" active={copied}>
                                {copied ? <CheckIcon size={15} strokeWidth={2} /> : <CopyIcon size={15} strokeWidth={2} />}
                            </IconAction>
                            {!isMobile && (
                                <IconAction onClick={downloadAll} title="Download visible logs">
                                    <DownloadIcon size={15} strokeWidth={2} />
                                </IconAction>
                            )}
                            <IconAction onClick={clear} title="Clear this view">
                                <ClearIcon size={16} strokeWidth={2} />
                            </IconAction>
                        </div>
                    </div>

                    {/* Toolbar — level, source, verbosity, search */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
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

                        {sources.length > 1 && (
                            <div
                                className="inline-flex h-7 items-center gap-1.5 rounded-full border pl-2.5 pr-1.5 text-[0.7rem]"
                                style={{
                                    borderColor: sourceFilter === 'all' ? 'var(--border-primary)' : 'var(--border-focus)',
                                    backgroundColor: sourceFilter === 'all' ? 'transparent' : 'var(--accent-muted)',
                                    color: sourceFilter === 'all' ? 'var(--text-tertiary)' : 'var(--accent-primary)',
                                }}
                            >
                                <LayersIcon size={13} strokeWidth={2} />
                                <select
                                    value={sourceFilter}
                                    onChange={(e) => setSourceFilter(e.target.value)}
                                    title="Filter by where the line came from"
                                    className="cursor-pointer bg-transparent pr-1 text-[0.7rem] outline-none"
                                    style={{ color: 'inherit', maxWidth: 190 }}
                                >
                                    <option value="all" style={{ color: '#111' }}>All sources ({sources.length})</option>
                                    {sources.map(([name, count]) => (
                                        <option key={name} value={name} style={{ color: '#111' }}>
                                            {isModelContainer(name) ? shortModelLabel(name) : name} ({count})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {(engineHiddenCount > 0 || showVerbose) && (
                            <button
                                type="button"
                                onClick={() => setShowVerbose((v) => !v)}
                                title="Raw engine internals from the model server (srv/slot/print_timing/statistics/reasoning-budget). Hidden by default to keep the activity feed readable."
                                className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.7rem] font-medium transition"
                                style={
                                    showVerbose
                                        ? { color: 'var(--accent-primary)', backgroundColor: 'var(--accent-muted)', borderColor: 'var(--border-focus)' }
                                        : { color: 'var(--text-tertiary)', backgroundColor: 'transparent', borderColor: 'var(--border-primary)' }
                                }
                            >
                                {showVerbose ? <EyeIcon size={13} strokeWidth={2} /> : <EyeOffIcon size={13} strokeWidth={2} />}
                                <span>Engine</span>
                                {!showVerbose && engineHiddenCount > 0 && (
                                    <span
                                        className="rounded px-1 text-[0.6rem] font-semibold tabular-nums"
                                        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                                    >
                                        {engineHiddenCount}
                                    </span>
                                )}
                            </button>
                        )}

                        <div
                            className="ml-auto flex h-7 items-center gap-1.5 rounded-md border px-2"
                            style={{
                                backgroundColor: 'var(--bg-tertiary)',
                                borderColor: logSearch ? 'var(--border-focus)' : 'var(--border-primary)',
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
                                style={{ color: 'var(--text-primary)', fontFamily: '"Fira Code", monospace' }}
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

                    {/* Result summary — only when something is actually narrowing the feed */}
                    {filtersActive && (
                        <div className="mb-1 flex items-center gap-2 text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                            <span>
                                Showing {filteredLogs.length.toLocaleString()} of {logs.length.toLocaleString()} entries
                                {hideEngine && engineHiddenCount > 0 && (
                                    <span style={{ color: 'var(--text-muted)' }}> · {engineHiddenCount} engine line{engineHiddenCount === 1 ? '' : 's'} hidden</span>
                                )}
                            </span>
                            {(logFilter !== 'all' || sourceFilter !== 'all' || logSearch) && (
                                <button
                                    type="button"
                                    onClick={() => { setLogFilter('all'); setSourceFilter('all'); setLogSearch(''); }}
                                    className="rounded px-1.5 py-[1px] text-[0.65rem] font-medium transition"
                                    style={{ color: 'var(--accent-primary)', backgroundColor: 'var(--accent-muted)' }}
                                >
                                    Reset filters
                                </button>
                            )}
                        </div>
                    )}

                    {/* Log display — terminal-black on every theme except light,
                        where it flips to a slate surface so the panel doesn't
                        look like a black tile pasted onto a white dashboard. */}
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        <div
                            ref={logsContainerRef}
                            onScroll={onScroll}
                            className="flex-1 overflow-auto rounded-lg border"
                            style={{
                                backgroundColor: logSurfaceBg,
                                borderColor: logSurfaceBorder,
                                paddingTop: '0.25rem',
                                paddingBottom: '0.25rem',
                            }}
                        >
                            {rows.length === 0 ? (
                                <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1">
                                    <span className="text-xs" style={{ fontFamily: '"Fira Code", monospace', color: emptyTextColor }}>
                                        {logs.length === 0 ? '● Waiting for activity...' : 'No matching log entries'}
                                    </span>
                                    {logs.length === 0 && (
                                        <span className="text-[0.68rem]" style={{ color: emptyTextColor }}>
                                            Activity is recorded on the server, so nothing is missed while this page is closed.
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <>
                                    {trimmed > 0 && (
                                        <div
                                            className="px-3 py-1.5 text-[0.68rem]"
                                            style={{ color: emptyTextColor, fontFamily: '"Fira Code", monospace' }}
                                        >
                                            ⋯ {trimmed.toLocaleString()} earlier matching line{trimmed === 1 ? '' : 's'} not rendered — search or filter to narrow
                                        </div>
                                    )}
                                    {rows.map((d) => {
                                        const s = sourceStyle(d.meta.model, isLight);
                                        return (
                                            <div
                                                key={d.key}
                                                style={{
                                                    borderLeft: `2px solid ${d.meta.model ? s.rail : 'transparent'}`,
                                                    // A hairline above each new source block turns an
                                                    // interleaved stream into readable chunks.
                                                    borderTop: d.startsGroup
                                                        ? `1px solid ${isLight ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.045)'}`
                                                        : 'none',
                                                    marginTop: d.startsGroup ? '0.2rem' : 0,
                                                }}
                                            >
                                                <LogRow
                                                    entry={d.entry}
                                                    level={d.level}
                                                    meta={d.meta}
                                                    isLight={isLight}
                                                    showBadge={d.startsGroup}
                                                    onPickSource={setSourceFilter}
                                                />
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                            <div ref={logsEndRef} />
                        </div>

                        {/* Reading back through history shouldn't be yanked away by
                            new lines; this is the way back to the tail. */}
                        {!atBottom && rows.length > 0 && (
                            <button
                                type="button"
                                onClick={jumpToLatest}
                                className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-[0.7rem] font-medium shadow-lg transition"
                                style={{
                                    color: 'var(--accent-primary)',
                                    backgroundColor: 'var(--bg-elevated, var(--bg-secondary))',
                                    borderColor: 'var(--border-focus)',
                                }}
                            >
                                <ArrowDownIcon size={13} strokeWidth={2.2} />
                                Jump to latest
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <SystemResourceMonitor current={systemStats} history={systemStatsHistory} />
        </div>
    );
}
