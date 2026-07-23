import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge, useReactFlow,
    BaseEdge, EdgeLabelRenderer, getBezierPath,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './automation.css';
import {
    ArrowLeft, Plus, Play, Square, Save, Trash2, Archive, ArchiveRestore,
    Power, PowerOff, Copy, Check, ChevronDown, ChevronRight, History as HistoryIcon, X as CloseIcon, Download, Braces, Menu as MenuIcon,
    Sparkles, Wand2, FlaskConical, RotateCcw,
    LayoutGrid, Workflow, ListChecks, Boxes, Clock, Blocks,
} from 'lucide-react';
import { useChatStore } from '../../stores/useChatStore';
import { useConfirm } from '../ConfirmDialog';
import AutomationNode, { iconFor, handlesFor, NodeDropContext, NodeToggleContext } from './AutomationNode';

const nodeTypes = { automation: AutomationNode };

// Edges carry a hover-revealed "×" that removes the connection without touching
// the nodes. The delete action comes from context so it uses the parent's
// useEdgesState setter (controlled mode) and marks the graph dirty.
const EdgeActionsContext = React.createContext(null);

function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }) {
    const actions = React.useContext(EdgeActionsContext);
    const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    return (
        <>
            <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
            <EdgeLabelRenderer>
                <button
                    className="auto-edge-delete nodrag nopan"
                    style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
                    title="Delete connection"
                    onClick={(e) => { e.stopPropagation(); if (actions) actions.deleteEdge(id); }}
                >
                    ×
                </button>
            </EdgeLabelRenderer>
        </>
    );
}
const edgeTypes = { default: DeletableEdge };

const uid = (p = 'n') => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const CATEGORY_ORDER = ['trigger', 'tools', 'connector', 'gate', 'output'];
const CATEGORY_LABEL = { trigger: 'Triggers', tools: 'Tools', connector: 'Connectors', gate: 'Logic Gates', output: 'Output' };
// Chat-side palette grouping overrides (display only; engine + webapp categories unchanged).
// Loop moves under Triggers; data/work nodes form the new Tools group; Connectors keeps only
// external messaging integrations (Slack/Telegram); flow utilities (Delay/Set) join Logic Gates.
const PALETTE_CATEGORY_OVERRIDE = {
    map: 'trigger',
    model: 'tools', web_search: 'tools', fetch_url: 'tools', render_html: 'tools',
    playwright_fetch: 'tools', scrapling_fetch: 'tools',
    parse_json: 'tools', parse_rss: 'tools', export_file: 'tools', http_request: 'tools', crawl: 'tools',
    sqlite: 'tools', render_chart: 'tools', chart_plot: 'tools', fetch_timeseries: 'tools', create_pdf: 'tools', html_to_pdf: 'tools', create_file: 'tools',
    run_python: 'tools', db_store: 'tools', db_query: 'tools', track_changes: 'tools', tool: 'tools',
    delay: 'gate', set: 'gate',
    'trigger.telegram': 'connector', 'trigger.slack': 'connector',
};
const PALETTE_LABEL_OVERRIDE = {
    map: 'Loop',
    'trigger.telegram': 'Telegram · On new message',
    telegram: 'Telegram · Send message',
    telegram_get: 'Telegram · Get recent messages',
    'trigger.slack': 'Slack · On new message',
    slack: 'Slack · Send message',
};
// Within Connectors, group nodes by external app (sub-selectors).
const PALETTE_APP = {
    'trigger.telegram': 'Telegram', telegram: 'Telegram', telegram_get: 'Telegram',
    'trigger.slack': 'Slack', slack: 'Slack',
};
// Node keys hidden from the chat palette (display-only; engine still supports them
// so EXISTING saved workflows that use them keep running). The Fetch URL node now
// auto-cascades static→stealth→real-browser, so the separate Playwright Fetch and
// Scrapling Fetch nodes are redundant for new workflows and are hidden to reduce
// palette clutter (consolidated, like the chat `web` tool).
const PALETTE_HIDDEN = new Set(['output', 'playwright_fetch', 'scrapling_fetch']);
const COND_OP_OPTIONS = [
    { value: '==', label: 'equals' },
    { value: '!=', label: 'does not equal' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'matches', label: 'matches regex' },
    { value: '>', label: 'greater than (>)' },
    { value: '<', label: 'less than (<)' },
    { value: '>=', label: 'at least (≥)' },
    { value: '<=', label: 'at most (≤)' },
    { value: 'empty', label: 'is empty' },
    { value: 'not_empty', label: 'is not empty' },
];
// Case operators for the Switch gate (no empty/not_empty — a case needs a value).
const SWITCH_OP_OPTIONS = COND_OP_OPTIONS.filter(o => o.value !== 'empty' && o.value !== 'not_empty');

// The "main input" each node kind fills when a data chip is dropped onto it on
// the canvas (see handleDropChip). Dotted paths target nested data (args/condition).
const PRIMARY_SLOT = {
    model: 'prompt', telegram: 'text', slack: 'text', fetch_url: 'url', web_search: 'query',
    db_store: 'value', render_html: 'html', export_file: 'content', set: 'value', map: 'items',
    parse_json: 'source', 'gate.if': 'condition.left', 'gate.filter': 'condition.left', 'gate.switch': 'value',
};
const TOOL_PRIMARY_SLOT = {
    create_pdf: 'args.content', html_to_pdf: 'args.content', http_request: 'args.url',
    query_sqlite: 'args.query', create_file: 'args.content', run_python: 'args.code', run_node: 'args.code', render_chart: 'args.chartSpec',
    parse_rss: 'args.url',
};

// ---- server <-> React Flow conversion ----
function serverToRF(wf, labelFor) {
    const nodes = (wf.nodes || []).map((n, i) => ({
        id: n.id,
        type: 'automation',
        position: n.position || { x: 140 + (i % 4) * 70, y: 90 + i * 80 },
        data: { kind: n.type, label: labelFor(n.type), ...(n.data || {}) },
    }));
    const edges = (wf.edges || []).map(e => ({
        id: e.id || uid('e'),
        source: e.source, target: e.target,
        sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
    }));
    return { nodes, edges };
}
function rfToServer(rfNodes, rfEdges) {
    return {
        nodes: rfNodes.map(n => {
            const { kind, status, anim, ...rest } = n.data || {};
            return { id: n.id, type: kind, position: n.position, data: rest };
        }),
        edges: rfEdges.map(e => ({
            id: e.id, source: e.source, target: e.target,
            sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
        })),
    };
}

// inline style helpers (theme tokens)
// Action buttons across the editor use the `.auto-btn` CSS class family
// (automation.css) for one consistent size/shape — see auto-btn / --accent /
// --primary / --ghost / --danger / --ok / --icon / --sm / --block / --grow.
const fieldLabel = { fontSize: 12.5, color: 'var(--ink-3, var(--ink-2))', marginBottom: 4, display: 'block', fontWeight: 500 };
const fieldInput = {
    width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--rule-2)',
    background: 'var(--bg)', color: 'var(--ink)', fontSize: 14, marginBottom: 11, boxSizing: 'border-box',
};

// Module-scope so its identity is stable across NodeConfig re-renders — defining
// it inside NodeConfig remounted every input on each keystroke (focus loss bug).
function Field({ label, children }) {
    return <div><label style={fieldLabel}>{label}</label>{children}</div>;
}

// Drag-to-resize bar on the left edge of the right-hand panels.
function ResizeHandle({ onResizeStart, side = 'left' }) {
    return (
        <div
            onMouseDown={onResizeStart}
            title="Drag to resize"
            style={{ position: 'absolute', ...(side === 'right' ? { right: 0 } : { left: -3 }), top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 6 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-soft)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        />
    );
}

// Click-to-insert for "{{...}}" data tags. Templatable inputs register
// themselves as the "active field" on focus (via context); clicking a tag then
// inserts its reference at the caret of that field. Far easier than dragging —
// dragging is kept as a secondary path. The active field is tracked by ref so
// repeated inserts read the live DOM value/caret.
const REF_MIME = 'application/automation-ref';
// Available upstream data tags for the open node, consumed by each field's
// inline "{ }" picker. [{ id, label, predicted, tags:[{ref,label,sample}] }]
const DataTagsContext = React.createContext([]);

// Modern on/off switch — replaces raw <input type=checkbox> across the editor.
function Toggle({ checked, onChange, disabled, children }) {
    return (
        <label className={`auto-switch${disabled ? ' is-disabled' : ''}`} style={{ margin: '2px 0 10px' }}>
            <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span className="auto-switch__track"><span className="auto-switch__thumb" /></span>
            {children && <span>{children}</span>}
        </label>
    );
}

// Build the upstream data-tag groups for a node (transitive predecessors,
// closest-first). Shows expected fields before a run; real fields once captured.
function buildTagGroups(outputs = {}, nodes = [], edges = [], currentNodeId) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    return upstreamIdsOrdered(edges, currentNodeId)
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(n => {
            const captured = (outputs[n.id] && outputs[n.id].output != null) ? outputs[n.id].output : undefined;
            const out = captured !== undefined ? captured : staticOutputShape(n.data && n.data.kind, n.data || {});
            const tags = [{ ref: `{{nodes.${n.id}}}`, label: 'whole output', sample: '' }];
            if (out != null && typeof out === 'object') {
                for (const t of flattenForTags(out)) tags.push({ ref: `{{nodes.${n.id}.${t.path}}}`, label: t.path, sample: t.leaf ? t.sample : '' });
            }
            return { id: n.id, label: (n.data && n.data.label) || (n.data && n.data.kind) || n.id, predicted: captured === undefined, tags };
        });
}

// The "{ }" button docked in a field's top-right + its data-tag popover. The
// popover is fixed-positioned (computed from the button rect) so it's never
// clipped by the panel's scroll container. Clicking a tag inserts at the caret.
function FieldTagButton({ insertRef }) {
    const groups = React.useContext(DataTagsContext);
    const btnRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState(null);
    useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
    }, [open]);
    if (!groups || !groups.length) return null;
    const toggle = () => {
        if (open) { setOpen(false); return; }
        const r = btnRef.current && btnRef.current.getBoundingClientRect();
        if (r) {
            const MENU_H = 320;
            const top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - MENU_H - 8));
            setPos({ top, left: Math.max(8, r.right - 248) });
        }
        setOpen(true);
    };
    return (
        <>
            <button ref={btnRef} type="button" className={`auto-tagbtn${open ? ' is-open' : ''}`}
                title="Insert data from a previous step" onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
                <Braces size={12} />
            </button>
            {open && pos && (
                <>
                    <div className="auto-tagmenu-backdrop" onMouseDown={() => setOpen(false)} />
                    <div className="auto-tagmenu" style={{ top: pos.top, left: pos.left }}>
                        {groups.map(g => (
                            <div key={g.id} className="auto-tagmenu__group">
                                <div className="auto-tagmenu__head">{g.label}{g.predicted ? ' · expected' : ''}</div>
                                {g.tags.map(t => (
                                    <button key={t.ref} type="button" className="auto-tagmenu__item" title={t.ref}
                                        onMouseDown={(e) => e.preventDefault()} onClick={() => { insertRef(t.ref); setOpen(false); }}>
                                        <span className="auto-tagmenu__label">{t.label}</span>
                                        {t.sample ? <span className="auto-tagmenu__sample">{t.sample}</span> : null}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </>
            )}
        </>
    );
}

// Insert a {{...}} ref at the field's caret (or append when unfocused).
function insertAtCaret(el, onChangeRef, refStr) {
    if (!el) return;
    const v = el.value || '';
    const focused = document.activeElement === el;
    const s = (focused && el.selectionStart != null) ? el.selectionStart : v.length;
    const e = (focused && el.selectionEnd != null) ? el.selectionEnd : v.length;
    onChangeRef.current(`${v.slice(0, s)}${refStr}${v.slice(e)}`);
    requestAnimationFrame(() => { try { el.focus(); const p = s + refStr.length; el.setSelectionRange(p, p); } catch (_) {} });
}

function makeDropHandlers(elRef, onChangeRef) {
    return {
        onDragOver: (ev) => { if (Array.from(ev.dataTransfer.types || []).includes(REF_MIME)) ev.preventDefault(); },
        onDrop: (ev) => {
            const ref = ev.dataTransfer.getData(REF_MIME);
            if (!ref) return;
            ev.preventDefault();
            const el = elRef.current;
            const v = (el && el.value) || '';
            const s = (el && el.selectionStart != null) ? el.selectionStart : v.length;
            const e = (el && el.selectionEnd != null) ? el.selectionEnd : v.length;
            onChangeRef.current(`${v.slice(0, s)}${ref}${v.slice(e)}`);
        },
    };
}
function TemplInput({ value = '', onChange, style, ...rest }) {
    const elRef = useRef(null);
    const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
    const groups = React.useContext(DataTagsContext);
    const hasTags = groups && groups.length > 0;
    return (
        <div className="auto-field">
            <input ref={elRef} value={value} onChange={(e) => onChange(e.target.value)}
                style={{ ...fieldInput, ...(hasTags ? { paddingRight: 34 } : null), ...style }} {...makeDropHandlers(elRef, onChangeRef)} {...rest} />
            <FieldTagButton insertRef={(r) => insertAtCaret(elRef.current, onChangeRef, r)} />
        </div>
    );
}
function TemplTextarea({ value = '', onChange, style, registerAsDefault, ...rest }) {
    const elRef = useRef(null);
    const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
    const groups = React.useContext(DataTagsContext);
    const hasTags = groups && groups.length > 0;
    return (
        <div className="auto-field">
            <textarea ref={elRef} value={value} onChange={(e) => onChange(e.target.value)}
                style={{ ...fieldInput, ...(hasTags ? { paddingRight: 34 } : null), ...style }} {...makeDropHandlers(elRef, onChangeRef)} {...rest} />
            <FieldTagButton insertRef={(r) => insertAtCaret(elRef.current, onChangeRef, r)} />
        </div>
    );
}

// Flatten a node's output into dotted paths. Arrays use a `*` wildcard so a tag
// pulls the field from EVERY element ({{...results.*.url}} = all urls), not just
// the first; the engine's resolver maps `*` over the array.
function flattenForTags(obj, prefix = '', out = [], depth = 0) {
    if (out.length >= 50 || depth > 4) return out;
    if (Array.isArray(obj)) {
        if (obj.length) flattenForTags(obj[0], `${prefix}.*`, out, depth + 1);
        return out;
    }
    if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
            if (k === '_handle') continue;
            const p = prefix ? `${prefix}.${k}` : k;
            const v = obj[k];
            const isObj = v && typeof v === 'object';
            out.push({ path: p, leaf: !isObj, sample: isObj ? (Array.isArray(v) ? `[${v.length}]` : '{…}') : String(v).slice(0, 30) });
            if (isObj) flattenForTags(v, p, out, depth + 1);
            if (out.length >= 50) break;
        }
    }
    return out;
}

// Representative output shape per node kind, so data tags are discoverable
// BEFORE a run. Captured run output replaces this once available.
function staticOutputShape(kind, data = {}) {
    const FILE = { _artifacts: [{ name: 'file.pdf', url: '', size: 0 }] };
    switch (kind) {
        case 'db_store':    return { new: [{}], stored: 0, skipped: 0, total: 0, table: '', db: '' };
        case 'db_query':    return [{}];
        case 'fetch_url':   return { url: '', title: '', content: '', source: '', success: true };
        case 'web_search':  return { results: [{ title: '', url: '', snippet: '' }] };
        case 'merge':       return { items: [], count: 0 };
        case 'map':         return { count: 0, results: [{}] };
        case 'render_html': return { html: '', contentType: 'text/html' };
        case 'export_file': return FILE;
        case 'telegram':
        case 'slack':       return { sent: true, mode: 'document', file: '' };
        case 'send_file':   return { success: true, destination: '', file: '' };
        case 'telegram_get':return { count: 0, messages: [{}], latest: {}, text: '' };
        case 'set':         return data && data.name ? { [data.name]: '' } : { value: '' };
        case 'tool': {
            const t = data && data.tool;
            if (t === 'http_request') return { success: true, status: 200, data: '', headers: {} };
            if (t === 'create_pdf' || t === 'html_to_pdf' || t === 'create_file' || t === 'render_chart') return FILE;
            return null;
        }
        default:            return null; // model = string, gate/trigger = whole-output only
    }
}

// All upstream node ids (transitive predecessors), ordered closest-first — that's
// every node whose output is actually available to reference here.
function upstreamIdsOrdered(edges, currentId) {
    const preds = new Map();
    for (const e of edges) { if (!preds.has(e.target)) preds.set(e.target, []); preds.get(e.target).push(e.source); }
    const order = [], seen = new Set();
    let frontier = [...(preds.get(currentId) || [])];
    while (frontier.length) {
        const next = [];
        for (const n of frontier) {
            if (seen.has(n)) continue;
            seen.add(n); order.push(n);
            for (const p of (preds.get(n) || [])) if (!seen.has(p)) next.push(p);
        }
        frontier = next;
    }
    return order;
}


// Kahn-level topological order over RF nodes/edges: trigger/source nodes first,
// then BFS by depth, ties broken left→right (x, then y). Returns node ids grouped
// into waves so the construction replay reveals dependency-deep nodes after their
// sources. Cycles (shouldn't happen in a valid DAG) are appended at the end so no
// node is ever dropped from the reveal.
function topoWaves(rfNodes, rfEdges) {
    const ids = rfNodes.map(n => n.id);
    const idSet = new Set(ids);
    const indeg = new Map(ids.map(id => [id, 0]));
    const adj = new Map(ids.map(id => [id, []]));
    for (const e of rfEdges) {
        if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
        adj.get(e.source).push(e.target);
        indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    }
    const posOf = id => { const n = rfNodes.find(x => x.id === id); const p = (n && n.position) || {}; return [p.x || 0, p.y || 0]; };
    const sortLR = arr => arr.slice().sort((a, b) => { const [ax, ay] = posOf(a); const [bx, by] = posOf(b); return ax - bx || ay - by; });
    const waves = [];
    let frontier = sortLR(ids.filter(id => (indeg.get(id) || 0) === 0));
    const placed = new Set();
    while (frontier.length) {
        waves.push(frontier);
        frontier.forEach(id => placed.add(id));
        const next = [];
        for (const id of frontier) {
            for (const t of (adj.get(id) || [])) {
                indeg.set(t, indeg.get(t) - 1);
                if (indeg.get(t) === 0 && !placed.has(t)) next.push(t);
            }
        }
        frontier = sortLR(next);
    }
    // Append any leftover (cycle) nodes so the reveal stays complete.
    const leftover = sortLR(ids.filter(id => !placed.has(id)));
    if (leftover.length) waves.push(leftover);
    return waves;
}

const prefersReducedMotion = () => {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
};

// Caption for a node during the time-lapse replay, by its role in the assembly.
function captionForRole(role, label) {
    const L = label || 'step';
    if (role === 'update') return `Updating “${L}”`;
    if (role === 'remove') return `Removing “${L}”`;
    if (role === 'keep') return `“${L}”`;
    return `Adding “${L}”`;
}

function FlowEditor({ showSnackbar, models }) {
    const setView = useChatStore(s => s.setView);
    const confirm = useConfirm();
    const { screenToFlowPosition, fitView } = useReactFlow();
    const runningModels = useMemo(() => (models || []).filter(m => m.status === 'running'), [models]);

    const [automations, setAutomations] = useState([]);
    const [palette, setPalette] = useState([]); // {key, kind, label, category, defaults, custom}
    const [selected, setSelected] = useState(null); // full workflow record
    const [name, setName] = useState('');
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [running, setRunning] = useState(false);
    const [runId, setRunId] = useState(null);
    const [runResult, setRunResult] = useState(null);
    const [webhookUrl, setWebhookUrl] = useState('');
    const [copied, setCopied] = useState(false);
    // palette category collapse state — all categories start collapsed by default
    const [collapsedCats, setCollapsedCats] = useState(() => Object.fromEntries(CATEGORY_ORDER.map(c => [c, true])));
    // Connector app sub-groups default EXPANDED.
    const [collapsedApps, setCollapsedApps] = useState({});
    // Live palette search box.
    const [paletteQuery, setPaletteQuery] = useState('');
    const [chipsLibOpen, setChipsLibOpen] = useState(false);
    const [chipLibQuery, setChipLibQuery] = useState('');
    const [showHistory, setShowHistory] = useState(false);
    // Top-level console screen (design's icon side-rail): dashboard | builder | runs | library.
    const [screen, setScreen] = useState('builder');
    // On-canvas "+" add-node popup: { x, y (screen), flowPos } | null.
    const [addMenu, setAddMenu] = useState(null);
    const [runs, setRuns] = useState([]);
    const [runDetail, setRunDetail] = useState(null);
    const [nodeOutputs, setNodeOutputs] = useState({}); // nodeId -> { status, output, error }
    const [customChips, setCustomChips] = useState([]); // user/LLM-authored settings chips
    const [chipBuilderOpen, setChipBuilderOpen] = useState(false);
    const loadChips = useCallback(async () => {
        try { const r = await fetch('/api/chips', { credentials: 'include' }); const d = r.ok ? await r.json() : []; setCustomChips(Array.isArray(d) ? d : []); }
        catch (_) { setCustomChips([]); }
    }, []);
    const [panelWidth, setPanelWidth] = useState(() => {
        const v = Number(localStorage.getItem('automationPanelWidth'));
        return v >= 280 && v <= 760 ? v : 320;
    });
    const runAbortRef = useRef(null);
    const addCountRef = useRef(0);
    // Construction/diff replay: a token + timer registry so a replay is fully
    // cancellable (navigate away / start another build) with no leaked timers.
    const [assembling, setAssembling] = useState(false);
    // Time-lapse HUD: a caption for the step being replayed + a {i,total} counter,
    // and a replay handle so the user can re-watch the last build/edit assembly.
    const [animCaption, setAnimCaption] = useState('');
    const [animStep, setAnimStep] = useState(null); // { i, total }
    const [canReplay, setCanReplay] = useState(false);
    const replayRef = useRef(null);                  // () => void, replays the last assembly
    const animTokenRef = useRef(0);
    const animTimersRef = useRef([]);
    useEffect(() => { try { localStorage.setItem('automationPanelWidth', String(panelWidth)); } catch (_) {} }, [panelWidth]);
    const [leftWidth, setLeftWidth] = useState(() => {
        const v = Number(localStorage.getItem('automationLeftWidth'));
        return v >= 190 && v <= 520 ? v : 230;
    });
    useEffect(() => { try { localStorage.setItem('automationLeftWidth', String(leftWidth)); } catch (_) {} }, [leftWidth]);
    // Mobile (<=768px): the fixed 3-column layout (left rail + canvas + right
    // panel) can't fit, so it collapses to match the chat sidebar pattern — the
    // left rail becomes a slide-out drawer (hamburger-toggled) and the config /
    // history panel becomes a full-screen overlay. 768px is the app's `md`
    // breakpoint (Tailwind `md:`, ChatSidebar's drawer cutover).
    const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    // Start the drawer open on mobile so the automations list is visible on
    // first load (nothing is selected yet); it closes once one is picked.
    const [leftDrawerOpen, setLeftDrawerOpen] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    useEffect(() => {
        if (!window.matchMedia) return undefined;
        const mq = window.matchMedia('(max-width: 768px)');
        const onChange = () => setIsMobile(mq.matches);
        if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
        return () => { if (mq.removeEventListener) mq.removeEventListener('change', onChange); else mq.removeListener(onChange); };
    }, []);
    // Drag the right edge of the left rail (automations + palette) to widen it.
    const onLeftResizeStart = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = leftWidth;
        const onMove = (ev) => setLeftWidth(Math.min(520, Math.max(190, startW + (ev.clientX - startX))));
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
        };
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftWidth]);
    // Drag the left edge of the config / history panel to widen it (pull leftward).
    const onPanelResizeStart = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = panelWidth;
        const onMove = (ev) => setPanelWidth(Math.min(760, Math.max(280, startW + (startX - ev.clientX))));
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
        };
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [panelWidth]);

    const notify = (m, s = 'success') => { if (showSnackbar) showSnackbar(m, s); };

    const labelFor = useCallback((kind) => {
        const t = palette.find(p => p.kind === kind && !p.custom);
        return (t && t.label) || kind;
    }, [palette]);

    // ---- initial load: automations list + palette ----
    const loadAutomations = useCallback(async () => {
        try {
            const res = await fetch('/api/automations', { credentials: 'include' });
            const data = res.ok ? await res.json() : [];
            setAutomations(Array.isArray(data) ? data : []);
            return data;
        } catch (_) { return []; }
    }, []);

    // Build the node palette from built-in primitives + the user's custom
    // node-types. Reusable so the Library's node-builder can refresh it on save.
    const loadPalette = useCallback(async () => {
        const [bRes, cRes] = await Promise.all([
            fetch('/api/node-types/builtin', { credentials: 'include' }),
            fetch('/api/node-types', { credentials: 'include' }),
        ]);
        const builtins = bRes.ok ? await bRes.json() : [];
        const custom = cRes.ok ? await cRes.json() : [];
        const pal = [
            ...(builtins || []).map(b => {
                const key = b.key || b.type;
                return { key, kind: b.type, label: PALETTE_LABEL_OVERRIDE[key] || b.label, category: PALETTE_CATEGORY_OVERRIDE[key] || b.category, defaults: b.defaults || {}, custom: false, description: b.description || '', app: PALETTE_APP[key] || null };
            }),
            ...(custom || []).filter(c => c.enabled !== false).map(c => ({ key: c.id, kind: c.baseType || 'tool', label: c.name, category: c.category, defaults: c.defaults || {}, custom: true, description: c.description || '', app: null })),
        ].filter(p => !PALETTE_HIDDEN.has(p.key) && !PALETTE_HIDDEN.has(p.kind));
        setPalette(pal);
    }, []);

    useEffect(() => {
        (async () => {
            await loadPalette();
            await Promise.all([loadAutomations(), loadChips()]);
        })();
    }, [loadPalette, loadAutomations, loadChips]);

    // Seed per-node results from the most recent run so clicking a node shows
    // its last output even after a page reload (best-effort; silent on failure).
    const seedNodeOutputs = useCallback(async (automationId) => {
        try {
            const listRes = await fetch(`/api/automations/${automationId}/runs?limit=1`, { credentials: 'include' });
            const list = listRes.ok ? await listRes.json() : [];
            if (!Array.isArray(list) || !list.length) return;
            const detRes = await fetch(`/api/automations/runs/${list[0].id}`, { credentials: 'include' });
            if (!detRes.ok) return;
            const det = await detRes.json();
            const map = {};
            for (const n of (det.nodes || [])) {
                if (n.nodeId) map[n.nodeId] = { status: n.status, output: n.output, error: n.error };
            }
            setNodeOutputs(map);
        } catch (_) { /* best-effort */ }
    }, []);

    // animateConstruction/animateDiff are declared further down (they depend on
    // fitView etc.). selectAutomation is declared first but only needs them at
    // call time, so we reach them through a ref kept current each render — avoids
    // a temporal-dead-zone reference and stale closures.
    const animFnsRef = useRef({});

    // ---- selection ----
    // `animate`: 'build' replays the graph construction instead of slamming it in.
    const selectAutomation = useCallback(async (id, { animate } = {}) => {
        if (animFnsRef.current.cancelAnim) animFnsRef.current.cancelAnim(); // stop any in-flight replay
        try {
            const res = await fetch(`/api/automations/${id}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to load automation');
            const wf = await res.json();
            const { nodes: n, edges: e } = serverToRF(wf, labelFor);
            setSelected(wf);
            setName(wf.name || '');
            setSelectedNodeId(null);
            setDirty(false);
            setRunResult(null);
            setWebhookUrl('');
            setNodeOutputs({});
            setLeftDrawerOpen(false); // mobile: reveal the canvas after picking from the drawer
            addCountRef.current = n.length;
            if (animate === 'build' && n.length && animFnsRef.current.animateConstruction) {
                // role map: every node is freshly added in a from-scratch build.
                const roleById = new Map(n.map(x => [x.id, 'add']));
                animFnsRef.current.animateConstruction(n, e, { roleById });
            } else {
                if (animFnsRef.current.clearReplay) animFnsRef.current.clearReplay();
                setNodes(n);
                setEdges(e);
            }
            seedNodeOutputs(id);
        } catch (err) { notify(err.message, 'error'); }
    }, [labelFor, setNodes, setEdges, seedNodeOutputs]);

    const newAutomation = useCallback(async () => {
        try {
            const res = await fetch('/api/automations', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Untitled automation', nodes: [], edges: [] }),
            });
            if (!res.ok) throw new Error('Failed to create automation');
            const wf = await res.json();
            await loadAutomations();
            await selectAutomation(wf.id);
            return wf.id;
        } catch (err) { notify(err.message, 'error'); }
        return null;
    }, [loadAutomations, selectAutomation]);

    // Close the open automation and return to the list view (clears the canvas
    // and any open Build/Edit boxes). Gives a clear way back to the automations
    // list from inside the editor.
    const backToList = useCallback(() => {
        if (animFnsRef.current.cancelAnim) animFnsRef.current.cancelAnim();
        if (animFnsRef.current.clearReplay) animFnsRef.current.clearReplay();
        setSelected(null);
        setName('');
        setNodes([]);
        setEdges([]);
        setSelectedNodeId(null);
        setDirty(false);
        setRunResult(null);
        setWebhookUrl('');
        setNodeOutputs({});
        setShowHistory(false);
        setAssistantOpen(false);
        setEditResult(null);
        setBuildResult(null);
        setAssistantPrompt('');
    }, [setNodes, setEdges]);

    // ---- AI Assistant (Build + Edit in one roomy modal) ----
    // One modal serves both flows: Build a new automation from a description, or
    // Edit the open one. A wide composer + a readable result view (NL summary,
    // color-coded change log, test report) replaces the old cramped rail boxes.
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [assistantMode, setAssistantMode] = useState('build'); // 'build' | 'edit'
    const [assistantPrompt, setAssistantPrompt] = useState('');
    const [assistantTest, setAssistantTest] = useState(false);
    const [assistantBusy, setAssistantBusy] = useState(false);
    const [buildResult, setBuildResult] = useState(null);   // { id, summary, buildLog, testReport, nodeCount }
    const [editResult, setEditResult] = useState(null);     // { proposed, diff, summary, changelog, buildLog?, testReport? }

    const openAssistant = useCallback((mode) => {
        if (mode === 'edit' && !selected) return;
        setAssistantMode(mode);
        setAssistantPrompt('');
        setBuildResult(null);
        setEditResult(null);
        setAssistantOpen(true);
    }, [selected]);
    const closeAssistant = useCallback(() => {
        if (assistantBusy) return;
        setAssistantOpen(false);
        setAssistantPrompt('');
        setBuildResult(null);
        setEditResult(null);
    }, [assistantBusy]);
    // Reset the assistant's pending result when the open automation changes.
    useEffect(() => { setEditResult(null); setBuildResult(null); }, [selected && selected.id]);

    const buildAutomation = useCallback(async () => {
        const p = assistantPrompt.trim();
        if (!p || assistantBusy) return;
        setAssistantBusy(true);
        setBuildResult(null);
        try {
            const res = await fetch('/api/automations/build', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, test: assistantTest }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to build automation');
            await loadAutomations();
            await selectAutomation(data.id); // load the graph; the time-lapse plays on "Watch it build"
            setBuildResult({
                id: data.id,
                summary: data.summary || '',
                buildLog: Array.isArray(data.buildLog) ? data.buildLog : [],
                testReport: data.testReport || null,
                nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
            });
            notify('Built with LLM — review the summary, then watch it assemble', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setAssistantBusy(false); }
    }, [assistantPrompt, assistantBusy, assistantTest, loadAutomations, selectAutomation]);

    // Close the modal and play the construction time-lapse on the board.
    const watchBuild = useCallback(() => {
        setAssistantOpen(false);
        setBuildResult(null);
        setAssistantPrompt('');
        const fn = animFnsRef.current.animateConstruction;
        if (fn && nodes.length) {
            const roleById = new Map(nodes.map(n => [n.id, 'add']));
            fn(nodes, edges, { roleById });
        }
    }, [nodes, edges]);

    const previewEdit = useCallback(async () => {
        const p = assistantPrompt.trim();
        if (!p || assistantBusy || !selected) return;
        setAssistantBusy(true);
        try {
            const res = await fetch(`/api/automations/${selected.id}/edit`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, test: assistantTest }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to edit automation');
            setEditResult(data);
        } catch (err) { notify(err.message, 'error'); }
        finally { setAssistantBusy(false); }
    }, [assistantPrompt, assistantBusy, assistantTest, selected]);

    const applyEdit = useCallback(async () => {
        if (!editResult || !selected) return;
        setAssistantBusy(true);
        // Snapshot the current (pre-apply) board so the diff replay can fade out
        // removed nodes before revealing the new graph.
        const baseNodes = nodes;
        const baseEdges = edges;
        try {
            const res = await fetch(`/api/automations/${selected.id}`, {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editResult.proposed.name, nodes: editResult.proposed.nodes, edges: editResult.proposed.edges }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to apply changes'); }
            const saved = await res.json().catch(() => null);
            const wf = saved || { ...selected, ...editResult.proposed };
            const { nodes: nextNodes, edges: nextEdges } = serverToRF(wf, labelFor);
            // Update selection metadata (mirrors selectAutomation) without an
            // instant graph set, then replay the diff onto the board.
            setSelected(wf);
            setName(wf.name || '');
            setSelectedNodeId(null);
            setDirty(false);
            setRunResult(null);
            setWebhookUrl('');
            setNodeOutputs({});
            addCountRef.current = nextNodes.length;
            const diff = editResult.diff;
            const animateDiffFn = animFnsRef.current.animateDiff;
            if (animateDiffFn) animateDiffFn(baseNodes, baseEdges, nextNodes, nextEdges, diff);
            else { setNodes(nextNodes); setEdges(nextEdges); }
            await loadAutomations();
            seedNodeOutputs(selected.id);
            setEditResult(null); setAssistantPrompt(''); setAssistantOpen(false);
            notify('Changes applied', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setAssistantBusy(false); }
    }, [editResult, selected, nodes, edges, labelFor, loadAutomations, setNodes, setEdges, seedNodeOutputs]);

    // ---- graph edits ----
    const onConnect = useCallback((params) => {
        setEdges(eds => addEdge({ ...params, id: uid('e') }, eds));
        // Auto-fill a gate's "value to check" with the source node's output when
        // a node is wired into it. The engine already defaults a blank left to
        // the previous node's output, but leaving the field empty in the editor
        // makes it unclear what the gate tests — so populate {{nodes.<source>}}
        // (with a sensible "is not empty" default op) so it's explicit and
        // editable. Only fills when the value/condition is still blank, so a
        // user- or LLM-set condition is never clobbered.
        setNodes(nds => nds.map(n => {
            if (n.id !== params.target) return n;
            const t = n.type;
            if (t !== 'gate.if' && t !== 'gate.filter' && t !== 'gate.switch') return n;
            const ref = `{{nodes.${params.source}}}`;
            const d = { ...(n.data || {}) };
            if (t === 'gate.switch') {
                if (d.value != null && String(d.value).trim() !== '') return n;
                d.value = ref;
            } else {
                const cond = { ...(d.condition || {}) };
                if (cond.left != null && String(cond.left).trim() !== '') return n;
                cond.left = ref;
                if (!cond.op) cond.op = 'not_empty';
                if (cond.right == null) cond.right = '';
                d.condition = cond;
            }
            return { ...n, data: d };
        }));
        setDirty(true);
    }, [setEdges, setNodes]);

    // Dropping the connection line on a node's BODY (not exactly on the 11px
    // handle) used to silently discard the edge — the "dragging the line to
    // another node doesn't connect" complaint. When React Flow ends a drag
    // without making a connection, hit-test the drop point against node bounds
    // and wire to that node's default handle (respecting the drag direction).
    const onConnectEnd = useCallback((event, connectionState) => {
        if (!connectionState || connectionState.isValid) return; // a real handle-to-handle connection already happened
        const fromNode = connectionState.fromNode;
        const fromHandle = connectionState.fromHandle;
        if (!fromNode) return;
        const pt = (event && 'changedTouches' in event) ? event.changedTouches[0] : event;
        if (!pt || pt.clientX == null) return;
        let pos;
        try { pos = screenToFlowPosition({ x: pt.clientX, y: pt.clientY }); } catch (_) { return; }
        const hit = nodes.find(n => {
            if (n.id === fromNode.id) return false;
            const w = (n.measured && n.measured.width) || n.width || 0;
            const h = (n.measured && n.measured.height) || n.height || 0;
            if (!w || !h || !n.position) return false;
            return pos.x >= n.position.x && pos.x <= n.position.x + w
                && pos.y >= n.position.y && pos.y <= n.position.y + h;
        });
        if (!hit) return;
        const hitHandles = handlesFor(hit.data?.kind, hit.data || {});
        if (fromHandle && fromHandle.type === 'target') {
            // Dragged backwards out of an input — the hit node becomes the source.
            if (!hitHandles.sources.length) return;
            onConnect({ source: hit.id, sourceHandle: hitHandles.sources[0], target: fromNode.id, targetHandle: (fromHandle && fromHandle.id) || null });
        } else {
            if (!hitHandles.targets.length) return; // triggers accept no input
            onConnect({ source: fromNode.id, sourceHandle: (fromHandle && fromHandle.id) || null, target: hit.id, targetHandle: hitHandles.targets[0] });
        }
    }, [nodes, screenToFlowPosition, onConnect]);

    // Delete a single connection line (leaves the nodes intact) and mark dirty.
    const deleteEdge = useCallback((id) => {
        setEdges(es => es.filter(e => e.id !== id));
        setDirty(true);
    }, [setEdges]);
    const edgeActions = useMemo(() => ({ deleteEdge }), [deleteEdge]);

    const addFromPalette = useCallback((item, dropPos) => {
        const id = uid('node');
        const i = addCountRef.current++;
        const position = dropPos || { x: 240 + (i % 5) * 36, y: 110 + (i % 8) * 70 };
        setNodes(ns => ns.concat({
            id, type: 'automation', position,
            data: { kind: item.kind, label: item.label, ...(item.defaults || {}) },
        }));
        setSelectedNodeId(id);
        setDirty(true);
        setLeftDrawerOpen(false); // mobile: close the drawer so the new node + its config are visible
    }, [setNodes]);

    // Drag-and-drop from the palette onto the canvas.
    const onPaletteDragStart = useCallback((e, item) => {
        e.dataTransfer.setData('application/automation-node', JSON.stringify({ kind: item.kind, label: item.label, defaults: item.defaults || {} }));
        e.dataTransfer.effectAllowed = 'move';
    }, []);
    const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
    const onDrop = useCallback((e) => {
        e.preventDefault();
        if (!selected) return;
        const raw = e.dataTransfer.getData('application/automation-node');
        if (!raw) return;
        let item; try { item = JSON.parse(raw); } catch { return; }
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        addFromPalette(item, position);
    }, [selected, screenToFlowPosition, addFromPalette]);

    const updateNodeData = useCallback((id, patch) => {
        setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
        setDirty(true);
    }, [setNodes]);

    // Per-node power toggle — flips data.disabled. Disabled nodes are skipped by
    // the engine (and their trigger doesn't fire), so this turns a single step
    // off without deleting it.
    const toggleNodeDisabled = useCallback((nodeId) => {
        setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, disabled: !n.data.disabled } } : n));
        setDirty(true);
    }, [setNodes]);

    // A library chip dropped onto a node on the canvas attaches to it (it
    // post-processes that node's output). Stored on data.chips; no duplicates.
    const handleDropChip = useCallback((nodeId, chipId) => {
        setNodes(ns => ns.map(n => {
            if (n.id !== nodeId) return n;
            const chips = Array.isArray(n.data.chips) ? n.data.chips : [];
            if (chips.includes(chipId)) return n;
            return { ...n, data: { ...n.data, chips: [...chips, chipId] } };
        }));
        setDirty(true);
    }, [setNodes]);

    const deleteSelectedNode = useCallback(() => {
        if (!selectedNodeId) return;
        setNodes(ns => ns.filter(n => n.id !== selectedNodeId));
        setEdges(es => es.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
        setSelectedNodeId(null);
        setDirty(true);
    }, [selectedNodeId, setNodes, setEdges]);

    // ---- persistence ----
    const save = useCallback(async () => {
        if (!selected) return null;
        const { nodes: sn, edges: se } = rfToServer(nodes, edges);
        try {
            const res = await fetch(`/api/automations/${selected.id}`, {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, nodes: sn, edges: se }),
            });
            if (!res.ok) throw new Error('Save failed');
            const wf = await res.json();
            setSelected(wf);
            setDirty(false);
            loadAutomations();
            return wf;
        } catch (err) { notify(err.message, 'error'); return null; }
    }, [selected, nodes, edges, name, loadAutomations]);

    const toggleFlag = useCallback(async (field) => {
        if (!selected) return;
        try {
            const res = await fetch(`/api/automations/${selected.id}/${field === 'enabled' ? 'enable' : 'archive'}`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error('Update failed');
            const wf = await res.json();
            setSelected(wf);
            loadAutomations();
        } catch (err) { notify(err.message, 'error'); }
    }, [selected, loadAutomations]);

    const deleteAutomation = useCallback(async (id) => {
        const confirmed = await confirm({
            title: 'Delete automation',
            message: 'Delete this automation? This cannot be undone.',
            confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger',
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`/api/automations/${id}`, { method: 'DELETE', credentials: 'include' });
            if (!res.ok) throw new Error('Delete failed');
            if (selected && selected.id === id) { setSelected(null); setNodes([]); setEdges([]); }
            notify('Automation deleted');
            loadAutomations();
        } catch (err) { notify(err.message, 'error'); }
    }, [selected, loadAutomations, setNodes, setEdges, confirm]);

    const genWebhook = useCallback(async () => {
        if (!selected) return;
        try {
            const res = await fetch(`/api/automations/${selected.id}/webhook-token`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error('Failed to generate token');
            const d = await res.json();
            setWebhookUrl(`${window.location.origin}${d.url}`);
        } catch (err) { notify(err.message, 'error'); }
    }, [selected]);

    // ---- construction / diff replay animation ----
    // The Build/Edit model calls are non-streaming (the backend returns the
    // whole materialized graph). To give the user the "watch it get wired up"
    // feel they asked for, we replay the result client-side: reveal nodes in
    // dependency (topological) order with a staggered fade/scale-in, drawing
    // each node's incoming edges with the existing dashed-glow "is-active"
    // animation as it appears. Fully cancellable via animTokenRef so navigating
    // away or starting another build never leaves a half-animated board; honors
    // prefers-reduced-motion by setting the graph instantly.
    const cancelAnim = useCallback(() => {
        animTokenRef.current++;
        animTimersRef.current.forEach(t => clearTimeout(t));
        animTimersRef.current = [];
    }, []);
    // Schedule a callback tied to the current animation token; auto-no-ops if a
    // newer replay (or cancel) has superseded it.
    const animLater = useCallback((token, ms, fn) => {
        const t = setTimeout(() => {
            animTimersRef.current = animTimersRef.current.filter(x => x !== t);
            if (animTokenRef.current === token) fn();
        }, ms);
        animTimersRef.current.push(t);
        return t;
    }, []);

    // Reveal `rfNodes`/`rfEdges` one wave at a time. `accent(id)` (optional) tags
    // a node for the pulse (changed) class instead of the appear class — used by
    // the diff replay. Resolves when the reveal completes (or is cancelled).
    const animateConstruction = useCallback((rfNodes, rfEdges, { accentIds, roleById } = {}) => {
        cancelAnim();
        const token = animTokenRef.current;
        const STAGGER = 200;     // per-node reveal cadence — reads as a time-lapse
        const EDGE_SETTLE = 520; // glow → settled
        // Register a replay of THIS exact assembly so the user can re-watch it.
        replayRef.current = () => animateConstruction(rfNodes, rfEdges, { accentIds, roleById });
        setCanReplay(true);

        if (prefersReducedMotion() || !rfNodes.length) {
            setNodes(rfNodes);
            setEdges(rfEdges);
            setAssembling(false);
            setAnimCaption(''); setAnimStep(null);
            try { requestAnimationFrame(() => fitView({ duration: 200, padding: 0.2 })); } catch (_) {}
            return;
        }

        setAssembling(true);
        const waves = topoWaves(rfNodes, rfEdges);
        const revealOrder = waves.flat();
        const revealAt = new Map();
        revealOrder.forEach((id, i) => revealAt.set(id, i));
        const accent = accentIds instanceof Set ? accentIds : null;
        const roles = roleById instanceof Map ? roleById : null;
        const labelOf = new Map(rfNodes.map(n => [n.id, (n.data && n.data.label) || n.type]));
        setAnimStep({ i: 0, total: revealOrder.length });
        setAnimCaption('');

        // Start with every node staged-but-invisible (is-hidden) and every edge
        // pending (path opacity 0); flipping anim→appear/pulse kicks the keyframe.
        const hidden = rfNodes.map(n => ({ ...n, data: { ...n.data, anim: 'hidden', status: undefined } }));
        setNodes(hidden);
        setEdges(rfEdges.map(e => ({ ...e, className: 'is-pending', animated: false })));

        revealOrder.forEach((id, idx) => {
            animLater(token, idx * STAGGER, () => {
                const isAccent = accent && accent.has(id);
                const animKind = isAccent ? 'pulse' : 'appear';
                const role = roles ? roles.get(id) : (isAccent ? 'update' : 'add');
                // Narrate this step on the time-lapse HUD.
                setAnimCaption(captionForRole(role, labelOf.get(id)));
                setAnimStep({ i: idx + 1, total: revealOrder.length });
                setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, anim: animKind } } : n));
                // Draw the incoming edges whose source has already appeared.
                setEdges(es => es.map(e => {
                    if (e.target !== id) return e;
                    const srcAt = revealAt.get(e.source);
                    if (srcAt == null || srcAt > idx) return e; // source not revealed yet
                    return { ...e, className: 'is-drawing is-active', animated: true };
                }));
                // Settle this node's incoming edges to the "done" look a beat later.
                animLater(token, EDGE_SETTLE, () => {
                    setEdges(es => es.map(e => (e.target === id && (e.className || '').includes('is-active'))
                        ? { ...e, className: 'is-done', animated: false } : e));
                });
            });
        });

        // Final cleanup: clear transient classes/flags, draw any edges that were
        // still pending (e.g. into cycle nodes), settle, fit the view.
        const total = revealOrder.length * STAGGER + EDGE_SETTLE + 120;
        animLater(token, total, () => {
            setEdges(es => es.map(e => (e.className === 'is-pending' || (e.className || '').includes('is-active'))
                ? { ...e, className: undefined, animated: false } : e));
            setNodes(ns => ns.map(n => n.data && n.data.anim ? { ...n, data: { ...n.data, anim: null } } : n));
            setAssembling(false);
            setAnimCaption(''); setAnimStep(null);
            try { fitView({ duration: 260, padding: 0.2 }); } catch (_) {}
        });
    }, [cancelAnim, animLater, setNodes, setEdges, fitView]);

    // Diff-aware replay for Edit→Apply: removed nodes fade out first, then the
    // new graph is revealed with changed nodes pulsing accent and added nodes
    // fading in (animateConstruction handles the reveal; we pass changed ids as
    // the accent set). `base` = the pre-apply RF nodes/edges (for the fade-out).
    const animateDiff = useCallback((baseNodes, baseEdges, nextNodes, nextEdges, diff) => {
        cancelAnim();
        // Register a replay of this exact diff assembly.
        replayRef.current = () => animateDiff(baseNodes, baseEdges, nextNodes, nextEdges, diff);
        setCanReplay(true);
        const addedIds = new Set((diff && diff.addedNodes || []).map(n => n.id));
        const changedIds = new Set((diff && diff.changedNodes || []).map(n => n.id));
        // Role per surviving node so each reveal narrates correctly (add/update/keep).
        const roleById = new Map();
        for (const n of nextNodes) roleById.set(n.id, addedIds.has(n.id) ? 'add' : (changedIds.has(n.id) ? 'update' : 'keep'));
        if (prefersReducedMotion()) {
            setNodes(nextNodes); setEdges(nextEdges); setAssembling(false);
            setAnimCaption(''); setAnimStep(null);
            try { requestAnimationFrame(() => fitView({ duration: 200, padding: 0.2 })); } catch (_) {}
            return;
        }
        const removedIds = new Set((diff && diff.removedNodes || []).map(n => n.id));
        const FADE = 520;
        if (removedIds.size) {
            setAssembling(true);
            const token = ++animTokenRef.current; // claim a token for the fade phase
            const removedLabels = (diff.removedNodes || []).map(n => n.label).filter(Boolean);
            setAnimCaption(removedLabels.length === 1 ? `Removing “${removedLabels[0]}”` : `Removing ${removedIds.size} step${removedIds.size > 1 ? 's' : ''}`);
            setAnimStep(null);
            // Show the OLD graph, flag removed nodes with the remove keyframe.
            setNodes(baseNodes.map(n => removedIds.has(n.id) ? { ...n, data: { ...n.data, anim: 'remove' } } : { ...n, data: { ...n.data, anim: null } }));
            setEdges(baseEdges.map(e => (removedIds.has(e.source) || removedIds.has(e.target)) ? { ...e, className: 'is-removing-edge', animated: false } : e));
            animLater(token, FADE, () => animateConstruction(nextNodes, nextEdges, { accentIds: changedIds, roleById }));
        } else {
            animateConstruction(nextNodes, nextEdges, { accentIds: changedIds, roleById });
        }
    }, [cancelAnim, animLater, animateConstruction, setNodes, setEdges, fitView]);

    // Forget the last replay + clear the time-lapse HUD (used when a run, a new
    // selection, or returning to the list supersedes the assembly view).
    const clearReplay = useCallback(() => {
        setCanReplay(false); replayRef.current = null; setAnimCaption(''); setAnimStep(null);
    }, []);
    const replayAssembly = useCallback(() => { if (replayRef.current) replayRef.current(); }, []);

    // Keep the ref current so selectAutomation (declared earlier) can reach the
    // replay helpers at call time.
    useEffect(() => { animFnsRef.current = { animateConstruction, animateDiff, cancelAnim, clearReplay }; }, [animateConstruction, animateDiff, cancelAnim, clearReplay]);
    // Cancel any in-flight replay on unmount.
    useEffect(() => () => cancelAnim(), [cancelAnim]);

    // ---- run (SSE) + animation ----
    const resetRunVisuals = useCallback(() => {
        cancelAnim(); // a run supersedes any in-flight construction replay
        clearReplay();
        setAssembling(false);
        setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, status: undefined, anim: null } })));
        setEdges(es => es.map(e => ({ ...e, className: undefined, animated: false })));
        setNodeOutputs({});
    }, [setNodes, setEdges, cancelAnim, clearReplay]);

    // Mirror a generated file produced by each node onto its card as a minimal
    // chip (the only after-run detail kept on the canvas — full text output lives
    // in the side panel). Covers live runs AND the seeded last run. Functional
    // update + equality check keeps it from looping on its own writes.
    useEffect(() => {
        setNodes(ns => {
            let changed = false;
            const next = ns.map(n => {
                const o = nodeOutputs[n.id];
                let artifactName = '', delivered = false;
                if (o && o.status !== 'running' && o.output != null && !o.error) {
                    artifactName = artifactNameOf(o.output);
                    delivered = !!(o.output && typeof o.output === 'object' && o.output._delivered);
                }
                if (n.data.artifactName === artifactName && n.data.delivered === delivered) return n;
                changed = true;
                return { ...n, data: { ...n.data, artifactName, delivered } };
            });
            return changed ? next : ns;
        });
    }, [nodeOutputs, setNodes]);

    const handleRunEvent = useCallback((evt) => {
        switch (evt.type) {
            case 'run_created': setRunId(evt.runId); break;
            case 'node_start':
                setNodes(ns => ns.map(n => n.id === evt.nodeId ? { ...n, data: { ...n.data, status: 'running' } } : n));
                setNodeOutputs(o => ({ ...o, [evt.nodeId]: { status: 'running' } }));
                break;
            case 'node_finish':
                setNodes(ns => ns.map(n => n.id === evt.nodeId ? { ...n, data: { ...n.data, status: evt.status } } : n));
                setNodeOutputs(o => ({ ...o, [evt.nodeId]: { status: evt.status, output: evt.output, error: evt.error } }));
                break;
            case 'edge_active':
                setEdges(es => es.map(e => (e.id === evt.edgeId || (e.source === evt.source && e.target === evt.target))
                    ? { ...e, className: 'is-active', animated: true } : e));
                break;
            case 'run_finish':
                setEdges(es => es.map(e => e.className === 'is-active' ? { ...e, className: 'is-done', animated: false } : e));
                break;
            default: break;
        }
    }, [setNodes, setEdges]);

    // Live run events over SSE — animates server-triggered runs (schedule,
    // telegram, webhook, event) for whichever automation is open. Manual runs
    // drive their own animation via the run() fetch stream, so we skip live
    // events while a manual run is in progress. Stable refs let the single
    // EventSource read the current selection / running state / handlers.
    const selectedIdRef = useRef(null);
    const runningRef = useRef(false);
    const handleRunEventRef = useRef(handleRunEvent);
    const resetRunVisualsRef = useRef(resetRunVisuals);
    useEffect(() => { selectedIdRef.current = selected ? selected.id : null; }, [selected]);
    useEffect(() => { runningRef.current = running; }, [running]);
    useEffect(() => { handleRunEventRef.current = handleRunEvent; }, [handleRunEvent]);
    useEffect(() => { resetRunVisualsRef.current = resetRunVisuals; }, [resetRunVisuals]);
    useEffect(() => {
        let es;
        try { es = new EventSource('/api/automations/events', { withCredentials: true }); } catch (_) { return undefined; }
        es.onmessage = (e) => {
            let evt; try { evt = JSON.parse(e.data); } catch { return; }
            if (!evt || runningRef.current) return;                       // manual run owns the animation
            if (!evt.workflowId || evt.workflowId !== selectedIdRef.current) return;
            if (evt.type === 'run_start' || evt.type === 'run_created') resetRunVisualsRef.current();
            if (evt.type === 'done') { handleRunEventRef.current({ type: 'run_finish', status: evt.status }); return; }
            handleRunEventRef.current(evt);
        };
        es.onerror = () => {}; // EventSource auto-reconnects
        return () => { try { es.close(); } catch (_) {} };
    }, []);

    const run = useCallback(async () => {
        if (!selected) return;
        const wf = await save(); // persist current graph first
        if (!wf) return;
        resetRunVisuals();
        setRunResult(null);
        setRunning(true);
        setRunId(null);
        const ctrl = new AbortController();
        runAbortRef.current = ctrl;
        try {
            const res = await fetch(`/api/automations/${selected.id}/run`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: {} }), signal: ctrl.signal,
            });
            if (!res.ok || !res.body) throw new Error('Run failed to start');
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const blocks = buf.split('\n\n');
                buf = blocks.pop();
                for (const block of blocks) {
                    const line = block.split('\n').find(l => l.startsWith('data: '));
                    if (!line) continue;
                    let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
                    if (evt.type === 'done') {
                        setRunResult({ status: evt.status, result: evt.result, error: evt.error });
                        if (evt.status === 'failed') notify(evt.error || 'Automation failed', 'error');
                        else notify('Automation completed');
                    } else {
                        handleRunEvent(evt);
                    }
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError') notify(err.message, 'error');
        } finally {
            setRunning(false);
            runAbortRef.current = null;
        }
    }, [selected, save, resetRunVisuals, handleRunEvent]);

    const stop = useCallback(async () => {
        try { if (runId) await fetch(`/api/automations/runs/${runId}/stop`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); } catch (_) {}
        if (runAbortRef.current) runAbortRef.current.abort();
        setRunning(false);
    }, [runId]);

    const loadRuns = useCallback(async () => {
        if (!selected) return;
        try {
            const res = await fetch(`/api/automations/${selected.id}/runs?limit=50`, { credentials: 'include' });
            setRuns(res.ok ? await res.json() : []);
        } catch (_) { setRuns([]); }
    }, [selected]);

    const clearRuns = useCallback(async () => {
        if (!selected) return;
        const confirmed = await confirm({
            title: 'Clear run history',
            message: 'Clear all run history for this automation? This cannot be undone.',
            confirmText: 'Clear', cancelText: 'Cancel', variant: 'danger',
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`/api/automations/${selected.id}/runs`, { method: 'DELETE', credentials: 'include' });
            if (!res.ok) throw new Error('Failed to clear run history');
            setRunDetail(null);
            await loadRuns();
            notify('Run history cleared');
        } catch (err) { notify(err.message, 'error'); }
    }, [selected, loadRuns, confirm]);

    const openHistory = useCallback(() => {
        setSelectedNodeId(null);
        setRunDetail(null);
        setShowHistory(true);
        loadRuns();
    }, [loadRuns]);

    // Refresh the history list when a run finishes while the panel is open.
    useEffect(() => { if (showHistory && !running) loadRuns(); }, [running, showHistory]); // eslint-disable-line react-hooks/exhaustive-deps

    const onNodeClick = useCallback((_e, node) => { setSelectedNodeId(node.id); setAddMenu(null); }, []);
    // Single click empty canvas → just deselect (and dismiss any open add menu).
    const onPaneClick = useCallback(() => { setSelectedNodeId(null); setAddMenu(null); }, []);
    // DOUBLE-click empty canvas → open the "+" add-node popup at the cursor; the
    // picked node drops at that flow position. Only fires on the bare pane so a
    // double-click on a node is unaffected.
    const onCanvasDoubleClick = useCallback((e) => {
        if (!selected) return;
        const t = e.target;
        if (!(t && t.classList && t.classList.contains('react-flow__pane'))) return;
        let flowPos = null;
        try { flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY }); } catch (_) {}
        setAddMenu({ x: e.clientX, y: e.clientY, flowPos });
    }, [selected, screenToFlowPosition]);

    const selectedNode = nodes.find(n => n.id === selectedNodeId) || null;

    // mark name edits dirty
    const onNameChange = (v) => { setName(v); setDirty(true); };

    const groupedPalette = useMemo(() => {
        const groups = {};
        for (const cat of CATEGORY_ORDER) groups[cat] = [];
        for (const p of palette) { (groups[p.category] || (groups[p.category] = [])).push(p); }
        return groups;
    }, [palette]);

    // ---- Assistant result renderers (plain functions — no focusable inputs, so
    // calling them inline in JSX is safe and avoids remount concerns) ----
    const renderTestReport = (tr) => {
        if (!tr) return null;
        const tone = tr.ok ? 'ok' : (tr.configNeeded ? 'warn' : 'err');
        return (
            <div className={`ai-test ai-test--${tone}`}>
                <div className="ai-test__head">
                    {tr.ok ? <Check size={14} /> : <FlaskConical size={14} />}
                    <span>{tr.ok ? 'Test passed — data flows end to end' : (tr.configNeeded ? 'Runs — only needs configuration you supply' : 'Test found issues')}</span>
                    {tr.passes ? <span className="ai-test__passes">{tr.passes} pass{tr.passes > 1 ? 'es' : ''}</span> : null}
                </div>
                {tr.verdict ? <div className="ai-test__verdict">{tr.verdict}</div> : null}
                {Array.isArray(tr.nodes) && tr.nodes.length > 0 && (
                    <div className="ai-test__nodes">
                        {tr.nodes.map(n => (
                            <div key={n.id} className={`ai-test__node ${(n.status === 'failed' || n.flagged) ? 'is-bad' : (n.status === 'completed' ? 'is-ok' : '')}`}>
                                <span className="ai-test__dot" />
                                <span className="ai-test__nlabel">{n.label}</span>
                                <span className="ai-test__npreview">{n.error || n.preview || n.status || ''}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };
    const renderChangeDetail = (diff) => {
        if (!diff) return null;
        const empty = ((diff.addedNodes || []).length + (diff.changedNodes || []).length + (diff.removedNodes || []).length) === 0;
        return (
            <div className="ai-diff">
                {(diff.addedNodes || []).map(n => (
                    <div key={'a' + n.id} className="ai-diff__row ai-diff__row--add">
                        <span className="ai-diff__sign">+</span>
                        <div className="ai-diff__main">
                            <div className="ai-diff__title">Added <b>{n.label}</b> <span className="ai-diff__type">{n.type}</span></div>
                            {Array.isArray(n.config) && n.config.map((c, i) => <div key={i} className="ai-diff__cfg">{c}</div>)}
                        </div>
                    </div>
                ))}
                {(diff.changedNodes || []).map(n => (
                    <div key={'c' + n.id} className="ai-diff__row ai-diff__row--change">
                        <span className="ai-diff__sign">~</span>
                        <div className="ai-diff__main">
                            <div className="ai-diff__title">Updated <b>{n.label}</b> <span className="ai-diff__type">{n.type}</span></div>
                            {Array.isArray(n.changes) && n.changes.length ? n.changes.map((c, i) => (
                                <div key={i} className="ai-diff__chg">
                                    <span className="ai-diff__field">{c.field}</span>
                                    <span className="ai-diff__before">{c.before}</span>
                                    <span className="ai-diff__arrow">→</span>
                                    <span className="ai-diff__after">{c.after}</span>
                                </div>
                            )) : (n.fields && n.fields.length ? <div className="ai-diff__cfg">{n.fields.join(', ')}</div> : null)}
                        </div>
                    </div>
                ))}
                {(diff.removedNodes || []).map(n => (
                    <div key={'r' + n.id} className="ai-diff__row ai-diff__row--remove">
                        <span className="ai-diff__sign">−</span>
                        <div className="ai-diff__main"><div className="ai-diff__title">Removed <b>{n.label}</b> <span className="ai-diff__type">{n.type}</span></div></div>
                    </div>
                ))}
                {(diff.addedEdges > 0 || diff.removedEdges > 0) && <div className="ai-diff__edges">Connections: +{diff.addedEdges} / −{diff.removedEdges}</div>}
                {empty && <div className="ai-diff__none">No node changes — only field tweaks.</div>}
            </div>
        );
    };

    return (
        <div className="auto-shell" style={{ display: 'flex', flexDirection: 'row', height: '100%', background: 'var(--bg)' }}>
            {/* Console icon side-rail (design nav): Dashboard / Builder / Runs / Library */}
            <AutoIconRail screen={screen} setScreen={setScreen} runningCount={running ? 1 : 0} />
            <div className="auto-main" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
            {screen === 'dashboard' && (
                <DashboardScreen automations={automations} onOpen={(a) => { selectAutomation(a.id); setScreen('builder'); }} onNew={() => { newAutomation(); setScreen('builder'); }} onRuns={() => setScreen('runs')} />
            )}
            {screen === 'runs' && (
                <RunsScreen automations={automations} selectedId={selected?.id} confirm={confirm} notify={notify} onOpenBuilder={(a) => { if (a) selectAutomation(a.id); setScreen('builder'); }} />
            )}
            {screen === 'library' && (
                <LibraryScreen groupedPalette={groupedPalette} categoryOrder={CATEGORY_ORDER} categoryLabel={CATEGORY_LABEL} automations={automations} notify={notify} confirm={confirm} onPaletteChanged={loadPalette} onAddToFlow={async (item, flowId) => { if (flowId) { await selectAutomation(flowId); } else { await newAutomation(); } addFromPalette(item); setScreen('builder'); }} />
            )}
            {screen === 'builder' && (<>
            {/* Header */}
            <div className="auto-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--rule)', flexShrink: 0 }}>
                {isMobile && (
                    <button className="auto-btn auto-btn--icon" onClick={() => setLeftDrawerOpen(o => !o)} title="Automations & nodes">
                        <MenuIcon size={16} />
                    </button>
                )}
                <button className="auto-btn" onClick={() => setView('chat')} title="Back to chat">
                    <ArrowLeft size={15} /> <span>Chat</span>
                </button>
                {selected ? (
                    <button className="auto-btn" onClick={backToList} title="Back to automations list">
                        <ArrowLeft size={14} /> <span>Automations</span>
                    </button>
                ) : (
                    <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13 }}>Automations</span>
                )}
                {selected && (
                    <>
                        <input
                            value={name} onChange={(e) => onNameChange(e.target.value)}
                            placeholder="Automation name"
                            style={{ ...fieldInput, width: isMobile ? undefined : 240, flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : undefined, marginBottom: 0 }}
                        />
                        <div className="auto-toolbar__actions" style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                            <button className={`auto-btn${selected.enabled !== false ? ' auto-btn--ok' : ''}`} onClick={() => toggleFlag('enabled')} title={selected.enabled !== false ? 'Enabled (triggers active)' : 'Disabled'}>
                                {selected.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
                                <span>{selected.enabled !== false ? 'Enabled' : 'Disabled'}</span>
                            </button>
                            <button className="auto-btn auto-btn--icon" onClick={() => toggleFlag('archived')} title={selected.archived ? 'Unarchive' : 'Archive'}>
                                {selected.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                            </button>
                            <button className="auto-btn" onClick={() => setScreen('runs')} title="Run history">
                                <HistoryIcon size={14} /> <span>History</span>
                            </button>
                            <button className={`auto-btn${dirty ? ' is-active' : ''}`} onClick={save} disabled={!dirty}>
                                <Save size={14} /> <span>Save{dirty ? '*' : ''}</span>
                            </button>
                            {running ? (
                                <button className="auto-btn auto-btn--danger" onClick={stop}>
                                    <Square size={13} /> <span>Stop</span>
                                </button>
                            ) : (
                                <button className="auto-btn auto-btn--accent" onClick={run}>
                                    <Play size={13} /> <span>Run</span>
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Backdrop behind the mobile drawer */}
                {isMobile && leftDrawerOpen && (
                    <div onClick={() => setLeftDrawerOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 55 }} />
                )}
                {/* Left rail: automations + palette (slide-out drawer on mobile) */}
                <div className="auto-rail" style={isMobile
                    ? { position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 60, width: 'min(86vw, 320px)', background: 'var(--bg)', borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', overflow: 'hidden', transform: leftDrawerOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.28s ease', boxShadow: leftDrawerOpen ? '0 0 24px rgba(0,0,0,0.4)' : 'none' }
                    : { width: leftWidth, position: 'relative', borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
                    {!isMobile && <ResizeHandle side="right" onResizeStart={onLeftResizeStart} />}
                    <div style={{ padding: '12px 12px 11px', flexShrink: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                            <button className="auto-btn auto-btn--accent auto-newbtn" onClick={newAutomation}>
                                <Plus size={14} strokeWidth={2.2} /> <span>New automation</span>
                            </button>
                        </div>
                        <div className="auto-rail__aihint">Create with AI</div>
                        <div className="auto-rail__aibtns">
                            <button className="auto-btn auto-btn--grow" onClick={() => openAssistant('build')} title="Describe an automation and let the model build it for you">
                                <Sparkles size={13} /> <span>Build</span>
                            </button>
                            <button className="auto-btn auto-btn--grow" onClick={() => openAssistant('edit')} disabled={!selected} title={selected ? 'Describe a change to the open automation' : 'Open an automation first to edit it with AI'}>
                                <Wand2 size={13} /> <span>Edit</span>
                            </button>
                        </div>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '4px 8px 8px', borderTop: '1px solid var(--rule)' }}>
                        <div className="auto-rail__section">
                            <span>Automations</span>
                            {automations.length > 0 && <span className="auto-rail__count">{automations.length}</span>}
                        </div>
                        {automations.length === 0 && (
                            <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '10px 8px', lineHeight: 1.5, textAlign: 'center' }}>
                                No automations yet.<br />Create one or build with the model.
                            </div>
                        )}
                        {automations.map(a => {
                            const isSel = selected && selected.id === a.id;
                            return (
                            <div key={a.id}
                                className={`auto-rail__item ${isSel ? 'is-selected' : ''}`}
                                onClick={() => selectAutomation(a.id)}
                                style={{ opacity: a.archived ? 0.55 : 1 }}
                                title={a.name || 'Untitled'}
                            >
                                <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: a.enabled !== false ? 'var(--ok, #22c55e)' : 'var(--ink-4, #64748b)' }} title={a.enabled !== false ? 'Enabled' : 'Disabled'} />
                                <span style={{ flex: 1, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name || 'Untitled'}</span>
                                {a._ownerName && (
                                    <span style={{ flexShrink: 0, fontSize: 9.5, color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 999, padding: '1px 6px' }} title={`Owner: ${a._ownerName}`}>{a._ownerName}</span>
                                )}
                                <button className="auto-rail__del" onClick={(e) => { e.stopPropagation(); deleteAutomation(a.id); }} title="Delete">
                                    <Trash2 size={13} />
                                </button>
                            </div>
                            );
                        })}
                    </div>
                    {/* Node palette + Transforms moved out of the Builder: nodes come from the Library tab / double-clicking the canvas; transforms are attached from a node's inspector. */}
                </div>

                {/* Canvas */}
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }} onDragOver={onDragOver} onDrop={onDrop} onDoubleClick={onCanvasDoubleClick}>
                    {!selected ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ink-3)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                            {isMobile
                                ? 'Tap the menu (top-left) to pick an automation or create a new one.'
                                : 'Select an automation on the left, or create a new one to start building a workflow.'}
                        </div>
                    ) : (
                        <NodeDropContext.Provider value={handleDropChip}>
                        <NodeToggleContext.Provider value={toggleNodeDisabled}>
                        <EdgeActionsContext.Provider value={edgeActions}>
                        <ReactFlow
                            className="automation-flow"
                            nodes={nodes}
                            edges={edges}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onConnectEnd={onConnectEnd}
                            connectionRadius={38}
                            onNodeClick={onNodeClick}
                            onPaneClick={onPaneClick}
                            onEdgesDelete={() => setDirty(true)}
                            onNodesDelete={() => setDirty(true)}
                            nodeTypes={nodeTypes}
                            edgeTypes={edgeTypes}
                            fitView
                            deleteKeyCode={['Backspace', 'Delete']}
                            zoomOnDoubleClick={false}
                            proOptions={{ hideAttribution: true }}
                        >
                            <Background gap={18} size={1} />
                            <Controls />
                            <MiniMap pannable zoomable style={{ width: 130, height: 90 }} />
                        </ReactFlow>
                        </EdgeActionsContext.Provider>
                        </NodeToggleContext.Provider>
                        </NodeDropContext.Provider>
                    )}
                    {assembling && (
                        <div className="auto-timelapse">
                            <div className="auto-timelapse__row">
                                <span className="auto-node__spinner" style={{ width: 13, height: 13 }} />
                                <span className="auto-timelapse__cap">{animCaption || 'Assembling…'}</span>
                                {animStep && animStep.total ? <span className="auto-timelapse__count">{animStep.i}/{animStep.total}</span> : null}
                            </div>
                            {animStep && animStep.total ? (
                                <div className="auto-timelapse__bar"><div className="auto-timelapse__fill" style={{ width: `${Math.round((animStep.i / animStep.total) * 100)}%` }} /></div>
                            ) : null}
                        </div>
                    )}
                    {addMenu && (
                        <NodePicker
                            x={addMenu.x} y={addMenu.y}
                            items={palette}
                            onPick={(item) => { addFromPalette(item, addMenu.flowPos || undefined); setAddMenu(null); }}
                            onClose={() => setAddMenu(null)}
                        />
                    )}
                    {!assembling && canReplay && selected && (
                        <button className="auto-btn auto-btn--sm auto-replay" onClick={replayAssembly} title="Replay how the assistant assembled this workflow">
                            <RotateCcw size={13} /> <span>Replay assembly</span>
                        </button>
                    )}
                    {runResult && (
                        <div style={{ position: 'absolute', bottom: 12, left: 12, right: 150, maxHeight: 140, overflow: 'auto', background: 'var(--surface)', border: `1px solid ${runResult.status === 'failed' ? 'var(--danger, #ef4444)' : 'var(--ok, #22c55e)'}`, borderRadius: 8, padding: '8px 10px', fontSize: 11.5, color: 'var(--ink-2)' }}>
                            <strong style={{ color: runResult.status === 'failed' ? 'var(--danger, #ef4444)' : 'var(--ok, #22c55e)' }}>
                                {runResult.status === 'failed' ? 'Failed' : 'Completed'}
                            </strong>
                            {runResult.error ? ` — ${runResult.error}` : ''}
                            {runResult.result != null && (
                                <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 11 }}>
                                    {typeof runResult.result === 'string' ? runResult.result : JSON.stringify(runResult.result, null, 2).slice(0, 1200)}
                                </pre>
                            )}
                        </div>
                    )}
                </div>

                {/* Config panel */}
                {selectedNode && !showHistory && (
                    <NodeConfig
                        key={selectedNode.id}
                        node={selectedNode}
                        typeLabel={labelFor(selectedNode.data.kind)}
                        runningModels={runningModels}
                        lastRun={nodeOutputs[selectedNode.id]}
                        allOutputs={nodeOutputs}
                        nodeList={nodes}
                        edgeList={edges}
                        width={panelWidth}
                        mobile={isMobile}
                        onClose={() => setSelectedNodeId(null)}
                        onResizeStart={onPanelResizeStart}
                        onChange={(patch) => updateNodeData(selectedNode.id, patch)}
                        onDelete={deleteSelectedNode}
                        webhookUrl={webhookUrl}
                        onGenWebhook={genWebhook}
                        copied={copied}
                        onCopyWebhook={() => { navigator.clipboard?.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                        customChips={customChips}
                        onOpenChipBuilder={() => setChipBuilderOpen(true)}
                    />
                )}
                {/* Run history now lives in the full Runs screen (icon rail). */}
            </div>
            </>)}
            {chipBuilderOpen && <ChipBuilder onClose={() => setChipBuilderOpen(false)} customChips={customChips} onSaved={loadChips} notify={notify} />}

            {/* ---- AI Assistant modal: roomy composer + readable suggestions ---- */}
            {assistantOpen && (() => {
                const mode = assistantMode;
                const result = mode === 'build' ? buildResult : editResult;
                const tr = result && result.testReport;
                const stepChain = (nodes || []).map(n => (n.data && n.data.label) || n.type);
                const submit = () => (mode === 'build' ? buildAutomation() : previewEdit());
                return (
                    <div className="ai-modal-backdrop" onClick={closeAssistant}>
                        <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
                            <div className="ai-modal__head">
                                <div className="ai-modal__tabs">
                                    <button className={`ai-tab ${mode === 'build' ? 'is-active' : ''}`} disabled={assistantBusy}
                                        onClick={() => { if (!assistantBusy) { setAssistantMode('build'); setBuildResult(null); setEditResult(null); } }}>
                                        <Sparkles size={13} /> <span>Build new</span>
                                    </button>
                                    <button className={`ai-tab ${mode === 'edit' ? 'is-active' : ''}`} disabled={assistantBusy || !selected}
                                        title={selected ? '' : 'Open an automation first'}
                                        onClick={() => { if (!assistantBusy && selected) { setAssistantMode('edit'); setBuildResult(null); setEditResult(null); } }}>
                                        <Wand2 size={13} /> <span>{selected ? `Edit “${name || 'current'}”` : 'Edit'}</span>
                                    </button>
                                </div>
                                <button className="ai-modal__close" onClick={closeAssistant} disabled={assistantBusy} title="Close"><CloseIcon size={17} /></button>
                            </div>

                            <div className="ai-modal__body">
                                {!result ? (
                                    <>
                                        <label className="ai-modal__label">{mode === 'build' ? 'Describe the automation you want' : `Describe the change to “${name || 'this automation'}”`}</label>
                                        <textarea
                                            className="ai-modal__composer"
                                            value={assistantPrompt}
                                            onChange={(e) => setAssistantPrompt(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && assistantPrompt.trim() && !assistantBusy) submit(); }}
                                            placeholder={mode === 'build'
                                                ? 'e.g. Every weekday at 8am, fetch three cybersecurity RSS feeds, keep only the articles I have not seen before, write a short digest, and DM it to me on Telegram.'
                                                : 'e.g. Also post the summary to Slack, and only alert me when something actually changed since the last run.'}
                                            disabled={assistantBusy}
                                            autoFocus
                                        />
                                        <div className="ai-modal__opts">
                                            <Toggle checked={assistantTest} onChange={setAssistantTest} disabled={assistantBusy}>
                                                Test &amp; improve <span style={{ opacity: 0.7 }}>— run it &amp; let the model fix issues before showing you (slower)</span>
                                            </Toggle>
                                        </div>
                                        {assistantBusy && (
                                            <div className="ai-modal__busy">
                                                <span className="auto-node__spinner" style={{ width: 15, height: 15 }} />
                                                <span>{assistantTest
                                                    ? (mode === 'build' ? 'Building, testing & improving…' : 'Revising, testing & improving…')
                                                    : (mode === 'build' ? 'The model is assembling your workflow…' : 'The model is revising your workflow…')}</span>
                                            </div>
                                        )}
                                        <div className="ai-modal__actions">
                                            <button className="auto-btn auto-btn--accent" onClick={submit} disabled={assistantBusy || !assistantPrompt.trim()}>
                                                {mode === 'build' ? <><Sparkles size={14} /> <span>{assistantBusy ? 'Building…' : 'Build'}</span></> : <><Wand2 size={14} /> <span>{assistantBusy ? 'Thinking…' : 'Preview changes'}</span></>}
                                            </button>
                                            <button className="auto-btn auto-btn--ghost" onClick={closeAssistant} disabled={assistantBusy}>Cancel</button>
                                            <span className="ai-modal__hint">⌘ / Ctrl + Enter</span>
                                        </div>
                                    </>
                                ) : mode === 'build' ? (
                                    <>
                                        <div className="ai-summary"><Sparkles size={16} /><div>{result.summary || `A ${result.nodeCount}-step automation is ready.`}</div></div>
                                        <div className="ai-sec__label">Steps</div>
                                        <div className="ai-chain">
                                            {stepChain.map((l, i) => <React.Fragment key={i}>{i > 0 && <span className="ai-chain__arrow">→</span>}<span className="ai-chain__step">{l}</span></React.Fragment>)}
                                        </div>
                                        {renderTestReport(tr)}
                                        <div className="ai-modal__actions">
                                            <button className="auto-btn auto-btn--accent" onClick={watchBuild}><Play size={13} /> <span>Watch it build</span></button>
                                            <button className="auto-btn auto-btn--ghost" onClick={() => { setBuildResult(null); setAssistantPrompt(''); }}>Build another</button>
                                            <button className="auto-btn auto-btn--ghost" onClick={closeAssistant}>Done</button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="ai-summary"><Wand2 size={16} /><div>{result.summary || 'Proposed changes are ready to review.'}</div></div>
                                        {Array.isArray(result.changelog) && result.changelog.length > 0 && (
                                            <>
                                                <div className="ai-sec__label">Change log</div>
                                                <ul className="ai-changelog">{result.changelog.map((l, i) => <li key={i}>{l}</li>)}</ul>
                                            </>
                                        )}
                                        <div className="ai-sec__label">Details</div>
                                        {renderChangeDetail(result.diff)}
                                        {renderTestReport(tr)}
                                        <div className="ai-modal__actions">
                                            <button className="auto-btn auto-btn--accent" onClick={applyEdit} disabled={assistantBusy}>{assistantBusy ? 'Applying…' : <><Check size={14} /> <span>Apply changes</span></>}</button>
                                            <button className="auto-btn auto-btn--ghost" onClick={() => setEditResult(null)} disabled={assistantBusy}>Try a different change</button>
                                            <button className="auto-btn auto-btn--ghost" onClick={closeAssistant} disabled={assistantBusy}>Discard</button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })()}
            </div>
        </div>
    );
}

// Client-side mirror of the engine's templating (incl. the `*` wildcard) so the
// Output box can show a live preview of exactly what will be forwarded.
function previewResolveParts(cur, parts) {
    for (let i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        const p = parts[i];
        if (p === '*' || p === '[]') {
            const items = Array.isArray(cur) ? cur : (typeof cur === 'object' ? Object.values(cur) : [cur]);
            const rest = parts.slice(i + 1);
            if (rest.length === 0) return items;
            const mapped = items.map(it => previewResolveParts(it, rest)).filter(v => v !== undefined);
            return mapped.some(Array.isArray) ? [].concat(...mapped) : mapped;
        }
        cur = cur[p];
    }
    return cur;
}
// Mirror the engine: a bare field ref ({{title}}) resolves against `last`.
function previewResolvePath(scope, pathStr) {
    const parts = String(pathStr).trim().split('.').filter(Boolean);
    if (!parts.length) return undefined;
    const head = parts[0];
    if (!['input', 'vars', 'nodes', 'last'].includes(head) && scope && scope.last != null && typeof scope.last === 'object') {
        const viaLast = previewResolveParts(scope.last, parts);
        if (viaLast !== undefined) return viaLast;
    }
    return previewResolveParts(scope, parts);
}
function previewInterpolate(tmpl, scope) {
    if (typeof tmpl !== 'string') return '';
    const fmt = (v) => {
        if (v === undefined || v === null) return '';
        if (Array.isArray(v)) return v.every(x => x === null || typeof x !== 'object') ? v.join('\n') : JSON.stringify(v, null, 2);
        return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    };
    const exact = tmpl.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact) return fmt(previewResolvePath(scope, exact[1]));
    return tmpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => fmt(previewResolvePath(scope, p)));
}

// ---- schedule builder (unit picker + live countdown) ----
const SCHEDULE_UNITS = [['seconds', 1000], ['minutes', 60000], ['hours', 3600000], ['days', 86400000]];
function fmtCountdown(ms) {
    let s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}
// Next fire time for an interval schedule. Anchor-relative ("every N units
// from when it was set") when an anchorMs is present, so the countdown shows
// the FULL chosen interval — e.g. "every 1 day" counts down ~24h instead of
// the time-until-UTC-midnight that pure epoch-alignment produced (a 1-day
// schedule near 23:00 looked like "~1hr left", reading as if the unit never
// applied). Falls back to legacy epoch-alignment for schedules saved before
// anchorMs existed. MUST stay identical to the server's automationSchedulerTick
// formula so the editor countdown agrees with actual fire time.
function scheduleNextFire(now, interval, anchor) {
    if (Number.isFinite(anchor)) return anchor + (Math.floor((now - anchor) / interval) + 1) * interval;
    return (Math.floor(now / interval) + 1) * interval;
}
function CountdownLine({ intervalMs, anchorMs }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { if (!intervalMs) return undefined; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [intervalMs]);
    if (!intervalMs) return null;
    const next = scheduleNextFire(now, intervalMs, Number(anchorMs));
    return (
        <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
            Next run in {fmtCountdown(next - now)} <span style={{ color: 'var(--ink-3)' }}>· {new Date(next).toLocaleTimeString()}</span>
        </div>
    );
}
function ScheduleConfig({ d, onChange }) {
    const ms = Number(d.intervalMs) || 0;
    let unit = 'minutes', amount = 5;
    if (ms > 0) {
        const u = [...SCHEDULE_UNITS].reverse().find(([, m]) => ms % m === 0) || SCHEDULE_UNITS[0];
        unit = u[0]; amount = Math.round(ms / u[1]);
    }
    const [useCron, setUseCron] = useState(!!d.cron);
    const apply = (amt, un) => {
        const unitMs = (SCHEDULE_UNITS.find(([n]) => n === un) || SCHEDULE_UNITS[1])[1];
        // Re-anchor on every edit so "every N <unit>" counts down the full
        // interval from now (and fires N units later), not from a UTC boundary.
        onChange({ intervalMs: Math.max(5000, Math.max(1, Number(amt) || 1) * unitMs), anchorMs: Date.now(), cron: '' });
    };
    if (useCron) {
        return (<>
            <Field label="Cron (min hour dom mon dow)"><input style={fieldInput} value={d.cron || ''} onChange={(e) => onChange({ cron: e.target.value })} placeholder="0 9 * * 1-5" /></Field>
            <button onClick={() => { setUseCron(false); onChange({ cron: '' }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 10.5, padding: 0 }}>← Use a simple interval instead</button>
        </>);
    }
    return (<>
        <label style={fieldLabel}>Run every</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input type="number" min="1" style={{ ...fieldInput, marginBottom: 0, width: 78 }} value={amount} onChange={(e) => apply(e.target.value, unit)} />
            <select style={{ ...fieldInput, marginBottom: 0 }} value={unit} onChange={(e) => apply(amount, e.target.value)}>
                {SCHEDULE_UNITS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select>
        </div>
        <CountdownLine intervalMs={ms} anchorMs={Number(d.anchorMs)} />
        <button onClick={() => setUseCron(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 10.5, padding: 0 }}>Advanced: use a cron expression →</button>
    </>);
}

// ---- per-node config panel ----
// Collect the record field names from a captured node output (array-of-objects
// or a single object) — used to populate field dropdowns (e.g. the dedup key).
function recordFieldsFromOutput(output) {
    const fields = [];
    const addKeys = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) if (k !== '_handle' && !fields.includes(k)) fields.push(k); };
    if (Array.isArray(output)) { for (const item of output.slice(0, 5)) addKeys(item); }
    else if (output && typeof output === 'object' && Array.isArray(output.rows)) { for (const item of output.rows.slice(0, 5)) addKeys(item); }
    else if (output && typeof output === 'object' && Array.isArray(output.new)) { for (const item of output.new.slice(0, 5)) addKeys(item); }
    else addKeys(output);
    return fields;
}

// Dotted field paths within a value (for the parse_json "keep field" dropdown).
// Arrays contribute a `*` segment: { results:[{url}] } → ['results','results.*.url'].
function fieldPathOptions(value, prefix = '', out = [], depth = 0) {
    if (out.length >= 40 || depth > 3) return out;
    if (Array.isArray(value)) {
        if (value.length) fieldPathOptions(value[0], prefix ? prefix + '.*' : '*', out, depth + 1);
        return out;
    }
    if (value && typeof value === 'object') {
        for (const k of Object.keys(value)) {
            if (k === '_handle') continue;
            const p = prefix ? `${prefix}.${k}` : k;
            out.push(p);
            const v = value[k];
            if (v && typeof v === 'object') fieldPathOptions(v, p, out, depth + 1);
            if (out.length >= 40) break;
        }
    }
    return out;
}

// ============================================================
// Chip-based node settings. Everything in the panel is a chip:
//  - value / multiline chips hold text and accept dropped DATA chips ({{…}})
//  - choice chips replace dropdowns; toggle/number chips replace those inputs
//  - "special" chips render bespoke editors (tool args, switch cases, schedule…)
// Chips are described by definitions and compile to the SAME node.data the
// engine already consumes, so nothing server-side changes. A node "wears" the
// chips that apply to it; optional ones live in the Add tray.
// ============================================================
const CHIP_REF_DRAG = REF_MIME;            // data chip drag payload = a {{…}} ref
const CHIP_ADD_DRAG = 'application/automation-chip'; // tray chip drag payload = field

// Dotted-path read/patch helpers (so a chip can target args.url, condition.left…).
function getAt(obj, path) { if (!path) return undefined; const ks = String(path).split('.'); let c = obj; for (const k of ks) { if (c == null) return undefined; c = c[k]; } return c; }
function setAt(obj, path, val) {
    const ks = String(path).split('.'); const root = (obj && typeof obj === 'object') ? { ...obj } : {};
    let c = root;
    for (let i = 0; i < ks.length - 1; i++) { const k = ks[i]; c[k] = (c[k] && typeof c[k] === 'object') ? { ...c[k] } : {}; c = c[k]; }
    const last = ks[ks.length - 1];
    if (val === undefined) delete c[last]; else c[last] = val;
    return root;
}
function patchFor(d, path, val) {
    const ks = String(path).split('.');
    if (ks.length === 1) return { [ks[0]]: val };
    const top = ks[0];
    return { [top]: setAt((d && d[top] && typeof d[top] === 'object') ? d[top] : {}, ks.slice(1).join('.'), val) };
}
function effVal(d, field, defaults) { const v = getAt(d, field); return v === undefined ? (defaults && defaults[field]) : v; }
function evalWhen(when, d, defaults) {
    if (!when) return true;
    const v = effVal(d, when.field, defaults);
    switch (when.op) {
        case 'truthy': return !!v && v !== '';
        case 'falsy': return !v || v === '';
        case 'eq': return v === when.value;
        case 'neq': return v !== when.value;
        case 'in': return Array.isArray(when.value) && when.value.includes(v);
        case 'notIn': return Array.isArray(when.value) && !when.value.includes(v);
        default: return true;
    }
}

// Friendly label for a {{…}} data reference inside a value chip.
function chipRefLabel(ref, nodeList) {
    const m = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(String(ref)); const inner = m ? m[1] : String(ref);
    if (inner === 'last') return 'previous ▸ all';
    if (inner === 'item') return 'each item';
    if (inner === 'index') return 'item #';
    let g = /^nodes\.([^.]+)(?:\.(.+))?$/.exec(inner);
    if (g) { const n = (nodeList || []).find(x => x.id === g[1]); const lbl = (n && n.data && (n.data.label || n.data.kind)) || g[1]; return `${lbl} ▸ ${g[2] || 'all'}`; }
    g = /^input(?:\.(.+))?$/.exec(inner); if (g) return `trigger ▸ ${g[1] || 'input'}`;
    g = /^vars\.(.+)$/.exec(inner); if (g) return `var ▸ ${g[1]}`;
    return inner;
}

// --- value-chip tokenizer: a value string ⇄ [text | ref] parts -------------
let __cfseq = 0; const __cid = () => `p${++__cfseq}`;
function cfTokenize(value) {
    const s = value == null ? '' : String(value);
    const parts = []; const re = /\{\{\s*[^}]+?\s*\}\}/g; let last = 0, m;
    while ((m = re.exec(s))) {
        if (m.index > last) parts.push({ id: __cid(), t: 'x', v: s.slice(last, m.index) });
        parts.push({ id: __cid(), t: 'r', v: m[0] });
        last = m.index + m[0].length;
    }
    if (last < s.length || !parts.length) parts.push({ id: __cid(), t: 'x', v: s.slice(last) });
    return parts;
}
function cfCompile(parts) { return parts.map(p => p.v).join(''); }
function cfMerge(parts) {
    const out = [];
    for (const p of parts) { const prev = out[out.length - 1]; if (p.t === 'x' && prev && prev.t === 'x') prev.v += p.v; else out.push({ ...p }); }
    if (!out.length || out[out.length - 1].t === 'r') out.push({ id: __cid(), t: 'x', v: '' });
    if (out[0].t === 'r') out.unshift({ id: __cid(), t: 'x', v: '' });
    return out;
}
function cfGrow(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; }

// A value chip: editable text interleaved with data sub-chips. Accepts dropped
// data refs; registers itself as the "active field" so a clicked data chip lands
// here. Internal part state keeps stable keys → no focus loss while typing.
function ValueChip({ chip, value, onChange, onRemove, nodeList, registerActive, suggestions }) {
    const multi = chip.type === 'multiline';
    const acceptsData = chip.acceptsData !== false;
    const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
    const [parts, setParts] = useState(() => cfTokenize(value));
    const lastRef = useRef(value == null ? '' : String(value));
    useEffect(() => { const sv = value == null ? '' : String(value); if (sv !== lastRef.current) { setParts(cfTokenize(sv)); lastRef.current = sv; } }, [value]);
    const [drop, setDrop] = useState(false);
    const apiRef = useRef({ insert: () => {} });
    if (!acceptsData) {
        return (
            <div className={`cf-chip cf-chip--value${multi ? ' cf-chip--multi' : ''}`}>
                <span className="cf-chip__label">{chip.label}</span>
                {multi
                    ? <textarea className="cf-text cf-text--multi" value={value || ''} placeholder={chip.placeholder || ''} onChange={(e) => onChange(e.target.value)} />
                    : <input className="cf-text" style={{ flex: 1 }} value={value || ''} placeholder={chip.placeholder || ''} onChange={(e) => onChange(e.target.value)} />}
                {onRemove && <button className="cf-chip__rm" title="Remove" onClick={onRemove}>×</button>}
            </div>
        );
    }
    // Code fields (run_python / run_node "Script", mono) render as ONE
    // contiguous textarea. Tokenizing them like a value field split the script
    // into multiple boxes around every embedded {{nodes.x}} — but in code that
    // is intentional literal interpolation the author edits inline, not a data
    // pill. A dropped/clicked data ref appends its {{...}} text instead.
    if (chip.mono) {
        const raw = value == null ? '' : String(value);
        const append = (ref) => onChange((value == null ? '' : String(value)) + '{{' + ref + '}}');
        return (
            <div className="cf-chip cf-chip--value cf-chip--multi">
                <span className="cf-chip__label">{chip.label}</span>
                <textarea
                    className="cf-text cf-text--multi cf-text--mono"
                    value={raw}
                    placeholder={chip.placeholder || ''}
                    ref={cfGrow}
                    onFocus={() => registerActive && registerActive({ insert: append })}
                    onChange={(e) => { onChange(e.target.value); cfGrow(e.target); }}
                    onDrop={(e) => { const ref = e.dataTransfer.getData(CHIP_REF_DRAG); if (ref) { e.preventDefault(); append(ref); } }}
                    onDragOver={(e) => { if (Array.from(e.dataTransfer.types || []).includes(CHIP_REF_DRAG)) e.preventDefault(); }}
                />
                {onRemove && <button className="cf-chip__rm" title="Remove" onClick={onRemove}>×</button>}
            </div>
        );
    }
    const push = (next) => { const merged = cfMerge(next); setParts(merged); const c = cfCompile(merged); lastRef.current = c; onChangeRef.current(c); };
    const editText = (id, v) => { const next = parts.map(p => p.id === id ? { ...p, v } : p); setParts(next); const c = cfCompile(next); lastRef.current = c; onChangeRef.current(c); };
    const rmRef = (id) => push(parts.filter(p => p.id !== id));
    const insert = (ref) => push([...parts, { id: __cid(), t: 'r', v: ref }, { id: __cid(), t: 'x', v: '' }]);
    apiRef.current.insert = insert;
    const onDrop = (e) => { setDrop(false); const ref = e.dataTransfer.getData(CHIP_REF_DRAG); if (ref) { e.preventDefault(); insert(ref); } };
    const onDragOver = (e) => { if (Array.from(e.dataTransfer.types || []).includes(CHIP_REF_DRAG)) { e.preventDefault(); setDrop(true); } };
    return (
        <div className={`cf-chip cf-chip--value${multi ? ' cf-chip--multi' : ''}`}>
            <span className="cf-chip__label">{chip.label}</span>
            <div className={`cf-val${drop ? ' is-drop' : ''}`} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDrop(false)}>
                {parts.map(p => p.t === 'r'
                    ? <span key={p.id} className="cf-sub" title={p.v}><span className="cf-sub__t">{chipRefLabel(p.v, nodeList)}</span><button className="cf-sub__x" onMouseDown={(e) => e.preventDefault()} onClick={() => rmRef(p.id)}>×</button></span>
                    : (multi
                        ? <textarea key={p.id} className={`cf-text cf-text--multi${chip.mono ? ' cf-text--mono' : ''}`} rows={1} value={p.v} placeholder={parts.length === 1 ? (chip.placeholder || '') : ''} ref={cfGrow} onFocus={() => registerActive && registerActive(apiRef.current)} onChange={(e) => { editText(p.id, e.target.value); cfGrow(e.target); }} />
                        : <input key={p.id} className="cf-text" size={Math.max((p.v || '').length || 1, parts.length === 1 ? Math.min(42, (chip.placeholder || '').length) : 1)} value={p.v} placeholder={parts.length === 1 ? (chip.placeholder || '') : ''} onFocus={() => registerActive && registerActive(apiRef.current)} onChange={(e) => editText(p.id, e.target.value)} />)
                )}
            </div>
            {Array.isArray(suggestions) && suggestions.length > 0 && (
                <div className="cf-tray" style={{ width: '100%', marginTop: 4 }}>
                    {suggestions.slice(0, 12).map(s => <button key={s} className="cf-add" onClick={() => onChange(s)} title={`Use ${s}`}><span className="cf-add__plus">+</span>{s}</button>)}
                </div>
            )}
            {onRemove && <button className="cf-chip__rm" title="Remove" onClick={onRemove}>×</button>}
        </div>
    );
}

// Choice chip — replaces a dropdown. Selected option shown; click for a popover.
function ChoiceChip({ chip, value, options, onChange, onRemove }) {
    const [open, setOpen] = useState(false); const [pos, setPos] = useState(null); const btnRef = useRef(null);
    useEffect(() => { if (!open) return undefined; const c = () => setOpen(false); window.addEventListener('scroll', c, true); window.addEventListener('resize', c); return () => { window.removeEventListener('scroll', c, true); window.removeEventListener('resize', c); }; }, [open]);
    const opts = options || [];
    const cur = opts.find(o => o.value === (value ?? chip.default)) || opts[0] || { value: '', label: '—' };
    const toggle = () => { if (open) { setOpen(false); return; } const r = btnRef.current && btnRef.current.getBoundingClientRect(); if (r) { const H = Math.min(300, opts.length * 34 + 12); setPos({ top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - H - 8)), left: Math.max(8, Math.min(r.left, window.innerWidth - 210)) }); } setOpen(true); };
    return (
        <div className="cf-chip cf-chip--choice">
            {chip.label ? <span className="cf-chip__label">{chip.label}</span> : null}
            <button ref={btnRef} type="button" className="cf-choiceval" onClick={toggle}>{cur.label} ▾</button>
            {onRemove && <button className="cf-chip__rm" title="Remove" onClick={onRemove}>×</button>}
            {open && pos && (<>
                <div className="auto-tagmenu-backdrop" onMouseDown={() => setOpen(false)} />
                <div className="cf-pop" style={{ top: pos.top, left: pos.left }}>
                    {opts.map(o => <button key={String(o.value)} type="button" className={`cf-pop__item${o.value === cur.value ? ' is-sel' : ''}`} onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>)}
                </div>
            </>)}
        </div>
    );
}
function ToggleChip({ chip, value, onChange }) {
    const on = !!value;
    return (<div className={`cf-chip cf-chip--toggle${on ? ' is-on' : ''}`} role="button" onClick={() => onChange(!on)}><span className="cf-chip__label">{chip.label}</span><span className="cf-chip__state">{on ? 'On' : 'Off'}</span></div>);
}
function NumberChip({ chip, value, onChange, onRemove }) {
    return (<div className="cf-chip cf-chip--num"><span className="cf-chip__label">{chip.label}</span><input type="number" className="cf-num" value={value ?? ''} placeholder={chip.placeholder || ''} min={chip.min} max={chip.max} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />{onRemove && <button className="cf-chip__rm" title="Remove" onClick={onRemove}>×</button>}</div>);
}

// Per-tool parameter chips (replaces the raw JSON args box).
const TOOL_PARAMS = {
    create_pdf: [{ key: 'content', label: 'Content', multiline: true }, { key: 'filename', label: 'Filename' }],
    html_to_pdf: [{ key: 'content', label: 'HTML', multiline: true }, { key: 'outputName', label: 'Filename' }],
    http_request: [{ key: 'url', label: 'URL' }, { key: 'method', label: 'Method', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, { key: 'body', label: 'Body', multiline: true }],
    playwright_fetch: [{ key: 'url', label: 'URL' }, { key: 'timeout', label: 'Timeout (ms)' }, { key: 'maxLength', label: 'Max chars' }],
    scrapling_fetch: [{ key: 'url', label: 'URL' }, { key: 'timeout', label: 'Timeout (ms)' }, { key: 'maxLength', label: 'Max chars' }],
    download_html: [{ key: 'url', label: 'URL' }, { key: 'filename', label: 'Save as (filename)' }],
    parse_rss: [{ key: 'url', label: 'Feed URL' }, { key: 'limit', label: 'Max items' }],
    query_sqlite: [{ key: 'query', label: 'SQL', multiline: true }, { key: 'db', label: 'Database file' }],
    create_file: [{ key: 'path', label: 'Path' }, { key: 'content', label: 'Content', multiline: true }],
    run_python: [{ key: 'code', label: 'Script', multiline: true, mono: true }],
    run_node: [{ key: 'code', label: 'JavaScript code', multiline: true, mono: true }],
    render_chart: [{ key: 'chartSpec', label: 'Chart spec', multiline: true }],
};
function ToolArgsChips({ d, onChange, nodeList, registerActive }) {
    const args = (d.args && typeof d.args === 'object') ? d.args : {};
    const known = TOOL_PARAMS[d.tool] || [];
    const knownKeys = new Set(known.map(p => p.key));
    const [customKeys, setCustomKeys] = useState([]);
    const [adding, setAdding] = useState(false);
    const [newKey, setNewKey] = useState('');
    useEffect(() => { setCustomKeys([]); setAdding(false); setNewKey(''); }, [d.tool]);
    const setArg = (k, v) => { const next = { ...args }; if (v === undefined || v === '') delete next[k]; else next[k] = v; onChange({ args: Object.keys(next).length ? next : undefined }); };
    const extra = Array.from(new Set([...Object.keys(args).filter(k => !knownKeys.has(k)), ...customKeys]));
    return (
        <div className="cf-sec">
            <div className="cf-sec__label">Details</div>
            {known.map(p => p.options
                ? <ChoiceChip key={p.key} chip={{ label: p.label }} value={args[p.key]} options={p.options.map(o => ({ value: o, label: o }))} onChange={(v) => setArg(p.key, v)} />
                : <ValueChip key={p.key} chip={{ label: p.label, type: p.multiline ? 'multiline' : 'value', acceptsData: true, mono: p.mono }} value={args[p.key]} onChange={(v) => setArg(p.key, v)} nodeList={nodeList} registerActive={registerActive} />)}
            {extra.map(k => <ValueChip key={k} chip={{ label: k, type: 'value', acceptsData: true }} value={args[k]} onChange={(v) => setArg(k, v)} nodeList={nodeList} registerActive={registerActive} onRemove={() => { setArg(k, undefined); setCustomKeys(cs => cs.filter(x => x !== k)); }} />)}
            {adding ? (
                <div className="cf-row__head">
                    <input className="cf-num" style={{ width: 140 }} autoFocus placeholder="parameter name" value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newKey.trim()) { setCustomKeys(cs => [...cs, newKey.trim()]); setNewKey(''); setAdding(false); } }} />
                    <button className="cf-add" onClick={() => { if (newKey.trim()) setCustomKeys(cs => [...cs, newKey.trim()]); setNewKey(''); setAdding(false); }}>Add</button>
                </div>
            ) : <div className="cf-tray"><button className="cf-add" onClick={() => setAdding(true)}><span className="cf-add__plus">+</span> Add a custom field</button></div>}
            <div className="cf-hint">Optional — only if this tool needs a setting that isn’t shown above.</div>
        </div>
    );
}
function SwitchCases({ d, onChange, nodeList, registerActive }) {
    const cases = Array.isArray(d.cases) ? d.cases : [];
    const setCase = (i, patch) => onChange({ cases: cases.map((c, idx) => idx === i ? { op: c.op || '==', value: (c.value ?? c.equals ?? ''), handle: c.handle || '', ...patch } : c) });
    return (
        <div className="cf-sec">
            <div className="cf-sec__label">Cases</div>
            <div className="cf-rows">
                {cases.map((c, i) => (
                    <div className="cf-row" key={i}>
                        <div className="cf-row__head">
                            <ChoiceChip chip={{ label: 'When' }} value={c.op || '=='} options={SWITCH_OP_OPTIONS} onChange={(v) => setCase(i, { op: v })} />
                            <button className="cf-chip__rm" title="Remove case" style={{ marginLeft: 'auto' }} onClick={() => onChange({ cases: cases.filter((_, idx) => idx !== i) })}>×</button>
                        </div>
                        <ValueChip chip={{ label: 'Value', type: 'value', acceptsData: true }} value={(c.value ?? c.equals ?? '')} onChange={(v) => setCase(i, { value: v })} nodeList={nodeList} registerActive={registerActive} />
                        <ValueChip chip={{ label: 'Route label', type: 'value', acceptsData: false }} value={c.handle || ''} onChange={(v) => setCase(i, { handle: v })} />
                    </div>
                ))}
            </div>
            <div className="cf-tray"><button className="cf-add" onClick={() => onChange({ cases: [...cases, { op: '==', value: '', handle: '' }] })}><span className="cf-add__plus">+</span> case</button></div>
        </div>
    );
}
// Advanced schedule modes compile to a single 5-field cron expression the
// engine's cronMatches() understands. Layout: "M H DOM MON DOW".
//   daily   → "M H * <months|*> *"
//   weekly  → "M H * <months|*> <dows>"
//   monthly → "M H <doms> <months|*> *"
// scheduleTime is "HH:MM"; scheduleDow is 0-6 (Sun=0); scheduleDom is 1-31;
// scheduleMonths is 1-12. Empty months list = every month.
const DOW_LABELS = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]];
const MONTH_LABELS = [['Jan', 1], ['Feb', 2], ['Mar', 3], ['Apr', 4], ['May', 5], ['Jun', 6], ['Jul', 7], ['Aug', 8], ['Sep', 9], ['Oct', 10], ['Nov', 11], ['Dec', 12]];
function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return [9, 0];
    return [Math.min(23, Math.max(0, parseInt(m[1], 10))), Math.min(59, Math.max(0, parseInt(m[2], 10)))];
}
function compileScheduleCron(sd) {
    const [hh, mm] = parseHHMM(sd.scheduleTime);
    const mon = (sd.scheduleMonths && sd.scheduleMonths.length) ? sd.scheduleMonths.slice().sort((a, b) => a - b).join(',') : '*';
    if (sd.scheduleMode === 'daily') return `${mm} ${hh} * ${mon} *`;
    if (sd.scheduleMode === 'weekly') {
        const dow = (sd.scheduleDow && sd.scheduleDow.length) ? sd.scheduleDow.slice().sort((a, b) => a - b).join(',') : '*';
        return `${mm} ${hh} * ${mon} ${dow}`;
    }
    if (sd.scheduleMode === 'monthly') {
        const dom = (sd.scheduleDom && sd.scheduleDom.length) ? sd.scheduleDom.slice().sort((a, b) => a - b).join(',') : '1';
        return `${mm} ${hh} ${dom} ${mon} *`;
    }
    return '';
}
// ---- Calendar schedule: per-day times + one-off specific dates -------------
// Compiles weekly per-day times → array of 5-field crons (grouped by time).
// `weeklyTimes` shape: { '0': '09:00', '3': '14:30' } (dow 0=Sun … 6=Sat).
// Specific dates fire ONCE via `runAt[]` (ISO local strings parsed server-side).
const DOW_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function compileWeeklyTimesCrons(weeklyTimes) {
    const byTime = new Map();
    for (const [k, tm] of Object.entries(weeklyTimes || {})) {
        const dow = Number(k);
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
        if (!/^\d{1,2}:\d{2}$/.test(String(tm || ''))) continue;
        const list = byTime.get(tm) || []; list.push(dow); byTime.set(tm, list);
    }
    const out = [];
    for (const [tm, dows] of byTime) {
        const [hh, mm] = parseHHMM(tm);
        out.push(`${mm} ${hh} * * ${dows.slice().sort((a, b) => a - b).join(',')}`);
    }
    return out;
}
function fmtCronHuman(c) {
    const m = /^(\d{1,2})\s+(\d{1,2})\s+\S+\s+\S+\s+(\S+)$/.exec(c || '');
    if (!m) return c;
    const mm = m[1].padStart(2, '0'), hh = m[2].padStart(2, '0');
    const dow = m[3];
    const days = dow === '*' ? 'every day' : dow.split(',').map(x => DOW_FULL[Number(x)] || x).join(', ');
    return `${days} at ${hh}:${mm}`;
}
function fmtRunAt(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${MONTH_FULL[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function localIsoFromYMDHM(y, m, day, hh, mm) {
    // Build a UTC ISO (…Z) representing the user's chosen LOCAL wallclock so
    // the server's Date.parse fires at the correct instant regardless of its
    // own timezone (the webapp container is UTC; users may be elsewhere).
    return new Date(y, m, day, hh, mm, 0, 0).toISOString();
}
function monthMatrix(year, month /* 0-11 */) {
    // 6×7 grid starting on Sunday. Cells outside the month are null.
    const first = new Date(year, month, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    while (cells.length < 42) cells.push(null);
    return cells;
}
function CalendarPickerModal({ initialWeekly, initialRunAt, onSave, onClose }) {
    const [weekly, setWeekly] = useState(() => ({ ...(initialWeekly || {}) }));
    const [runAt, setRunAt] = useState(() => Array.isArray(initialRunAt) ? [...initialRunAt] : []);
    const [defaultTime, setDefaultTime] = useState('09:00');
    const today = new Date();
    const [viewYear, setViewYear] = useState(today.getFullYear());
    const [viewMonth, setViewMonth] = useState(today.getMonth());
    const toggleDow = (dow) => setWeekly(w => { const next = { ...w }; if (next[dow] !== undefined) delete next[dow]; else next[dow] = defaultTime; return next; });
    const setDowTime = (dow, tm) => setWeekly(w => ({ ...w, [dow]: tm }));
    const applyDefaultToAll = () => setWeekly(w => { const next = {}; for (const k of Object.keys(w)) next[k] = defaultTime; return next; });
    // Compare in LOCAL time (runAt[] holds UTC ISO — direct prefix match would
    // break across midnight in non-UTC timezones).
    const ymdLocal = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const cellYmd = (day) => `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const runAtForDay = (day) => { const ymd = cellYmd(day); return runAt.find(iso => ymdLocal(iso) === ymd); };
    const toggleDate = (day) => {
        const existing = runAtForDay(day);
        if (existing) setRunAt(r => r.filter(x => x !== existing));
        else {
            const [hh, mm] = parseHHMM(defaultTime);
            setRunAt(r => [...r, localIsoFromYMDHM(viewYear, viewMonth, day, hh, mm)].sort());
        }
    };
    const setRunAtTime = (oldIso, newIso) => setRunAt(r => r.map(x => x === oldIso ? newIso : x).sort());
    const removeRunAt = (iso) => setRunAt(r => r.filter(x => x !== iso));
    const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
    const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };
    const cells = monthMatrix(viewYear, viewMonth);
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const weeklyEntries = Object.keys(weekly).map(k => Number(k)).sort((a, b) => a - b);
    return (
        <div className="cf-modal-backdrop" onMouseDown={onClose}>
            <div className="cf-modal" style={{ width: 820 }} onMouseDown={(e) => e.stopPropagation()}>
                <div className="cf-modal__head">
                    <b>Calendar &amp; time picker</b>
                    <button className="cf-chip__rm" onClick={onClose}>×</button>
                </div>
                <div className="cf-modal__body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                    {/* Recurring weekly */}
                    <div style={{ padding: 14, borderRight: '1px solid var(--rule)', overflowY: 'auto' }}>
                        <div className="cf-sec__label">Recurring weekly</div>
                        <div className="cf-hint" style={{ marginBottom: 8 }}>Pick the days this should run. Each day can have its own time.</div>
                        <div className="cf-chip" style={{ marginBottom: 8 }}>
                            <span className="cf-chip__label">Default time</span>
                            <input type="time" className="cf-num" style={{ width: 110 }} value={defaultTime} onChange={(e) => setDefaultTime(e.target.value)} />
                            <button className="cf-add" style={{ marginLeft: 'auto' }} onClick={applyDefaultToAll} disabled={!weeklyEntries.length}>Apply to all</button>
                        </div>
                        <div className="cf-tray" style={{ marginBottom: 10 }}>
                            {DOW_LABELS.map(([label, dow]) => (
                                <button key={dow} type="button" className={`cf-add${weekly[dow] !== undefined ? ' is-on' : ''}`} onClick={() => toggleDow(dow)}>{label}</button>
                            ))}
                        </div>
                        {weeklyEntries.length === 0 && <div className="cf-hint">No days picked yet.</div>}
                        {weeklyEntries.map(dow => (
                            <div key={dow} className="cf-chip" style={{ marginBottom: 6 }}>
                                <span className="cf-chip__label" style={{ width: 60 }}>{DOW_FULL[dow]}</span>
                                <input type="time" className="cf-num" style={{ width: 110 }} value={weekly[dow]} onChange={(e) => setDowTime(dow, e.target.value)} />
                                <button className="cf-chip__rm" onClick={() => toggleDow(dow)} title="Remove">×</button>
                            </div>
                        ))}
                    </div>
                    {/* Specific dates */}
                    <div style={{ padding: 14, overflowY: 'auto' }}>
                        <div className="cf-sec__label">Specific dates (one-off)</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8 }}>
                            <button className="cf-add" onClick={prevMonth}>‹</button>
                            <div style={{ flex: 1, textAlign: 'center', fontWeight: 600, color: 'var(--ink)' }}>{MONTH_FULL[viewMonth]} {viewYear}</div>
                            <button className="cf-add" onClick={nextMonth}>›</button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, marginBottom: 10 }}>
                            {DOW_LABELS.map(([lbl, dow]) => (
                                <div key={dow} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase' }}>{lbl}</div>
                            ))}
                            {cells.map((day, i) => {
                                if (!day) return <div key={i} />;
                                const ymd = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                const isSelected = !!runAtForDay(day);
                                const isToday = ymd === todayYmd;
                                const isPast = ymd < todayYmd;
                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => toggleDate(day)}
                                        disabled={isPast && !isSelected}
                                        title={isPast ? 'Past date' : ''}
                                        style={{
                                            aspectRatio: '1', border: '1px solid ' + (isSelected ? 'var(--accent)' : 'var(--rule-2, var(--rule))'),
                                            background: isSelected ? 'var(--accent)' : (isToday ? 'var(--accent-soft, var(--bg))' : 'var(--bg)'),
                                            color: isSelected ? '#fff' : (isPast ? 'var(--ink-3)' : 'var(--ink)'),
                                            borderRadius: 7, fontSize: 12, fontWeight: isToday ? 700 : 500,
                                            cursor: isPast && !isSelected ? 'not-allowed' : 'pointer', opacity: isPast && !isSelected ? 0.45 : 1,
                                            padding: 0
                                        }}
                                    >{day}</button>
                                );
                            })}
                        </div>
                        {runAt.length === 0 && <div className="cf-hint">No specific dates picked yet. Click a date above.</div>}
                        {runAt.map(iso => {
                            const d = new Date(iso);
                            if (Number.isNaN(d.getTime())) return null;
                            const tm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                            return (
                                <div key={iso} className="cf-chip" style={{ marginBottom: 6 }}>
                                    <span className="cf-chip__label" style={{ width: 96 }}>{MONTH_FULL[d.getMonth()].slice(0, 3)} {d.getDate()}, {d.getFullYear()}</span>
                                    <input type="time" className="cf-num" style={{ width: 110 }} value={tm} onChange={(e) => {
                                        const [hh, mm] = parseHHMM(e.target.value);
                                        setRunAtTime(iso, localIsoFromYMDHM(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm));
                                    }} />
                                    <button className="cf-chip__rm" onClick={() => removeRunAt(iso)} title="Remove">×</button>
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 12, borderTop: '1px solid var(--rule)' }}>
                    <button className="auto-btn auto-btn--ghost" onClick={onClose}>Cancel</button>
                    <button className="auto-btn auto-btn--primary" onClick={() => onSave({ weekly, runAt })}>Done</button>
                </div>
            </div>
        </div>
    );
}

function DayPillRow({ items, selected, onToggle }) {
    const sel = new Set(selected || []);
    return (
        <div className="cf-tray">
            {items.map(([label, value]) => (
                <button key={value} type="button" className={`cf-add${sel.has(value) ? ' is-on' : ''}`} onClick={() => { const next = new Set(sel); if (next.has(value)) next.delete(value); else next.add(value); onToggle([...next]); }}>{label}</button>
            ))}
        </div>
    );
}
function ScheduleChips({ d, onChange }) {
    const ms = Number(d.intervalMs) || 0;
    let unit = 'minutes', amount = 5;
    if (ms > 0) { const u = [...SCHEDULE_UNITS].reverse().find(([, m]) => ms % m === 0) || SCHEDULE_UNITS[0]; unit = u[0]; amount = Math.round(ms / u[1]); }
    const hasCalendar = (Array.isArray(d.crons) && d.crons.length) || (Array.isArray(d.runAt) && d.runAt.length) || (d.weeklyTimes && Object.keys(d.weeklyTimes).length);
    const initialMode = d.scheduleMode || (hasCalendar ? 'calendar' : (d.cron ? 'cron' : 'interval'));
    const [mode, setMode] = useState(initialMode);
    const [calOpen, setCalOpen] = useState(false);
    const apply = (amt, un) => { const unitMs = (SCHEDULE_UNITS.find(([n]) => n === un) || SCHEDULE_UNITS[1])[1]; onChange({ scheduleMode: 'interval', intervalMs: Math.max(5000, Math.max(1, Number(amt) || 1) * unitMs), anchorMs: Date.now(), cron: '' }); };
    // Patch one of the schedule fields, then recompile the cron expression so
    // the server-side scheduler picks it up (cronMatches reads d.cron only).
    const patchSchedule = (patch) => {
        const merged = { ...d, scheduleMode: mode, ...patch };
        const cron = compileScheduleCron(merged);
        onChange({ ...patch, scheduleMode: mode, cron, intervalMs: 0 });
    };
    const switchMode = (newMode) => {
        setMode(newMode);
        if (newMode === 'interval') {
            onChange({ scheduleMode: 'interval', cron: '', crons: [], runAt: [], weeklyTimes: {}, intervalMs: ms || 300000, anchorMs: Date.now() });
        } else if (newMode === 'cron') {
            onChange({ scheduleMode: 'cron', crons: [], runAt: [], weeklyTimes: {}, intervalMs: 0 });
        } else if (newMode === 'calendar') {
            onChange({ scheduleMode: 'calendar', cron: '', intervalMs: 0, weeklyTimes: d.weeklyTimes || {}, crons: d.crons || [], runAt: d.runAt || [] });
        } else {
            const seed = {
                scheduleMode: newMode,
                scheduleTime: d.scheduleTime || '09:00',
                scheduleDow: d.scheduleDow || (newMode === 'weekly' ? [1, 2, 3, 4, 5] : []),
                scheduleDom: d.scheduleDom || (newMode === 'monthly' ? [1] : []),
                scheduleMonths: d.scheduleMonths || []
            };
            const cron = compileScheduleCron(seed);
            onChange({ ...seed, cron, intervalMs: 0 });
        }
    };
    const MODE_OPTS = [
        { value: 'interval', label: 'Every N…' },
        { value: 'calendar', label: 'Calendar' },
        { value: 'daily', label: 'Daily' },
        { value: 'weekly', label: 'Weekly' },
        { value: 'monthly', label: 'Monthly' },
        { value: 'cron', label: 'Cron' }
    ];
    const time = d.scheduleTime || '09:00';
    const months = d.scheduleMonths || [];
    return (
        <div className="cf-sec">
            <ChoiceChip chip={{ label: 'Mode' }} value={mode} options={MODE_OPTS} onChange={switchMode} />
            {mode === 'interval' && (<>
                <div className="cf-chip cf-chip--num"><span className="cf-chip__label">Run every</span><input type="number" min="1" className="cf-num" value={amount} onChange={(e) => apply(e.target.value, unit)} /></div>
                <ChoiceChip chip={{ label: 'Unit' }} value={unit} options={SCHEDULE_UNITS.map(([n]) => ({ value: n, label: n }))} onChange={(v) => apply(amount, v)} />
                <CountdownLine intervalMs={ms} anchorMs={Number(d.anchorMs)} />
            </>)}
            {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (<>
                <div className="cf-chip"><span className="cf-chip__label">At time</span><input type="time" className="cf-num" style={{ width: 110 }} value={time} onChange={(e) => patchSchedule({ scheduleTime: e.target.value })} /></div>
                {mode === 'weekly' && (
                    <div className="cf-chip cf-chip--multi"><span className="cf-chip__label">On days</span>
                        <DayPillRow items={DOW_LABELS} selected={d.scheduleDow || []} onToggle={(v) => patchSchedule({ scheduleDow: v })} />
                    </div>
                )}
                {mode === 'monthly' && (
                    <div className="cf-chip cf-chip--multi"><span className="cf-chip__label">Day of month</span>
                        <DayPillRow items={Array.from({ length: 31 }, (_, i) => [String(i + 1), i + 1])} selected={d.scheduleDom || []} onToggle={(v) => patchSchedule({ scheduleDom: v })} />
                    </div>
                )}
                <div className="cf-chip cf-chip--multi"><span className="cf-chip__label">{months.length ? 'In months' : 'Months (empty = every month)'}</span>
                    <DayPillRow items={MONTH_LABELS} selected={months} onToggle={(v) => patchSchedule({ scheduleMonths: v })} />
                </div>
                {d.cron && <div className="cf-hint" style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-3)', fontSize: 11 }}>Cron: <code>{d.cron}</code></div>}
            </>)}
            {mode === 'cron' && (
                <ValueChip chip={{ label: 'Cron (min hour dom mon dow)', type: 'value', acceptsData: false, placeholder: '0 9 * * 1-5' }} value={d.cron || ''} onChange={(v) => onChange({ cron: v, scheduleMode: 'cron', intervalMs: 0 })} />
            )}
            {mode === 'calendar' && (<>
                <button className="cf-add" style={{ width: '100%', justifyContent: 'center', padding: '8px 12px', fontSize: 12.5 }} onClick={() => setCalOpen(true)}>
                    <span className="cf-add__plus">📅</span> Open calendar &amp; time picker
                </button>
                {(d.crons || []).length === 0 && (d.runAt || []).length === 0 && (
                    <div className="cf-hint">Pick recurring days (each with its own time) and/or specific one-off dates.</div>
                )}
                {(d.crons || []).length > 0 && (
                    <div className="cf-chip cf-chip--multi">
                        <span className="cf-chip__label">Recurring</span>
                        {(d.crons || []).map((c, i) => (
                            <div key={i} style={{ fontSize: 11.5, color: 'var(--ink-2)', padding: '2px 0' }}>• {fmtCronHuman(c)}</div>
                        ))}
                    </div>
                )}
                {(d.runAt || []).length > 0 && (
                    <div className="cf-chip cf-chip--multi">
                        <span className="cf-chip__label">Specific dates</span>
                        {(d.runAt || []).map((iso, i) => (
                            <div key={i} style={{ fontSize: 11.5, color: 'var(--ink-2)', padding: '2px 0' }}>• {fmtRunAt(iso)}</div>
                        ))}
                    </div>
                )}
                {calOpen && (
                    <CalendarPickerModal
                        initialWeekly={d.weeklyTimes || {}}
                        initialRunAt={d.runAt || []}
                        onClose={() => setCalOpen(false)}
                        onSave={({ weekly, runAt }) => {
                            const crons = compileWeeklyTimesCrons(weekly);
                            onChange({ scheduleMode: 'calendar', weeklyTimes: weekly, crons, runAt, cron: '', intervalMs: 0 });
                            setCalOpen(false);
                        }}
                    />
                )}
            </>)}
        </div>
    );
}
function WebhookChip({ ctx }) {
    return (<div className="cf-sec">
        <button className="cf-add" onClick={ctx.onGenWebhook}><span className="cf-add__plus">+</span> Generate webhook URL</button>
        {ctx.webhookUrl && <div className="cf-hint" style={{ wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--rule-2)', borderRadius: 6, padding: 8 }}>{ctx.webhookUrl} <button className="cf-add" style={{ marginTop: 6 }} onClick={ctx.onCopyWebhook}>{ctx.copied ? 'Copied' : 'Copy'}</button></div>}
        <div className="cf-hint">POST to this URL to trigger the workflow; the request body becomes the run input.</div>
    </div>);
}

// Built-in chip definitions per node kind. `field` is a (dotted) node.data path.
// type: value | multiline | choice | toggle | number | special.
// required → pre-shown; otherwise the chip sits in the Add tray. `when` hides a
// chip until a condition holds. acceptsData:false = no data chips (a literal).
const SEND_MODE_OPTS = [{ value: 'pdf', label: 'The PDF only' }, { value: 'both', label: 'The data + the PDF' }, { value: 'data', label: 'The data only (no file)' }];
const MATCH_OPTS = ['contains', 'equals', 'startsWith', 'regex'].map(m => ({ value: m, label: m }));
const CHIP_DEFS_BY_KIND = {
    model: [
        { field: 'prompt', label: 'Prompt', type: 'multiline', required: true, placeholder: 'Leave blank to receive the previous step’s output, or drop in data chips', help: 'What to ask the model. Leave blank to just hand it the previous step’s output.' },
        { field: 'systemPrompt', label: 'System prompt', type: 'multiline', advanced: true, help: 'Optional persona / standing instructions for the model.' },
        { field: 'model', label: 'Model', type: 'choice', optionsFrom: 'models', advanced: true },
    ],
    tool: [
        { field: 'tool', label: 'Tool / skill name', type: 'value', acceptsData: false, required: true, placeholder: 'e.g. query_sqlite' },
        { field: '__args', label: 'Parameters', type: 'special', special: 'toolArgs', required: true },
        { field: 'sendMode', label: 'What to pass to the next step', type: 'choice', options: SEND_MODE_OPTS, default: 'pdf', advanced: true, when: { field: 'tool', op: 'in', value: ['create_pdf', 'html_to_pdf'] } },
    ],
    web_search: [
        { field: 'query', label: 'What to search for', type: 'value', required: true },
        { field: 'limit', label: 'Number of results', type: 'number', placeholder: '5', advanced: true, help: 'How many results to use (default 5).' },
    ],
    fetch_url: [
        { field: 'url', label: 'URL', type: 'value', required: true, placeholder: 'https://…' },
        { field: 'maxLength', label: 'Max characters', type: 'number', advanced: true, help: 'Limit how much of the page to read.' },
    ],
    parse_json: [
        { field: 'path', label: 'Pick a field', type: 'value', acceptsData: false, suggestFrom: 'parseFields', placeholder: 'e.g. results.*.url — blank keeps all', help: 'Pull out just one field. Leave blank to keep the whole result.' },
    ],
    db_store: [
        { field: 'table', label: 'Collection name', type: 'value', acceptsData: false, required: true, placeholder: 'records', help: 'A name for this saved list (you choose it).' },
        { field: 'value', label: 'Data to store', type: 'multiline', placeholder: 'Blank stores the previous step’s output' },
        { field: 'key', label: 'Skip duplicates by', type: 'value', acceptsData: false, suggestFrom: 'incomingFields', placeholder: 'e.g. link', help: 'The field that’s unique per item (e.g. link or id) so the same item is never sent twice. You can list a couple, comma-separated (e.g. link,title).' },
        { field: 'keyStrip', label: 'Ignore words when comparing', type: 'value', acceptsData: false, advanced: true, help: 'Words/prefixes to ignore when matching duplicates (e.g. “UPDATE:”).', when: { field: 'key', op: 'truthy' } },
        { field: 'keyNormalize', label: 'Ignore case & punctuation', type: 'toggle', advanced: true, when: { field: 'key', op: 'truthy' } },
        { field: 'db', label: 'Storage file', type: 'value', acceptsData: false, placeholder: 'automation.db', advanced: true, help: 'Which storage file to use (default automation.db). Leave as-is unless you want a separate store.' },
    ],
    db_query: [
        { field: 'table', label: 'Collection name', type: 'value', acceptsData: false, required: true, placeholder: 'records', help: 'The same collection name you stored into.' },
        { field: 'order', label: 'Order', type: 'choice', required: true, default: 'id DESC', options: [{ value: 'id DESC', label: 'Newest first' }, { value: 'id ASC', label: 'Oldest first' }, { value: 'ts DESC', label: 'By time, newest first' }, { value: 'ts ASC', label: 'By time, oldest first' }] },
        { field: 'limit', label: 'How many', type: 'number', placeholder: '100' },
        { field: 'sql', label: 'Raw SQL query', type: 'multiline', acceptsData: false, placeholder: 'SELECT data FROM records WHERE …', advanced: true, help: 'Advanced — a custom SELECT instead of the options above.' },
        { field: 'db', label: 'Storage file', type: 'value', acceptsData: false, placeholder: 'automation.db', advanced: true, help: 'Which storage file to read (default automation.db).' },
    ],
    render_html: [{ field: 'html', label: 'HTML', type: 'multiline', required: true, placeholder: '<h1>Report</h1> — blank wraps the previous output' }],
    export_file: [
        { field: 'format', label: 'Format', type: 'choice', required: true, default: 'txt', options: ['txt', 'csv', 'json', 'md', 'html', 'pdf'].map(f => ({ value: f, label: f.toUpperCase() })) },
        { field: 'filename', label: 'Filename', type: 'value', acceptsData: false, required: true, placeholder: 'report' },
        { field: 'content', label: 'Content', type: 'multiline', placeholder: 'Blank uses the previous step’s output', help: 'Leave blank to save the previous step’s output.' },
    ],
    slack: [
        { field: 'text', label: 'Message', type: 'multiline', required: true, placeholder: 'Blank sends the previous step’s output' },
        { field: 'botToken', label: 'Slack bot token (xoxb-…)', type: 'value', acceptsData: false, required: true, when: { field: 'attachFile', op: 'neq', value: false } },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, when: { field: 'attachFile', op: 'neq', value: false } },
        { field: 'webhookUrl', label: 'Webhook URL (text only)', type: 'value', acceptsData: false, placeholder: 'https://hooks.slack.com/…' },
        { field: 'attachFile', label: 'Upload a file from a previous step', type: 'toggle', default: true, advanced: true },
    ],
    telegram: [
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, placeholder: '123456:ABC-DEF…' },
        { field: 'chatId', label: 'Chat ID', type: 'value', required: true, placeholder: 'e.g. 123456789 or @channel' },
        { field: 'text', label: 'Message', type: 'multiline', required: true, placeholder: 'Blank sends the previous step’s output' },
        { field: 'attachFile', label: 'Send a file from a previous step', type: 'toggle', default: true, advanced: true },
    ],
    telegram_get: [
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, placeholder: '123456:ABC-DEF…' },
        { field: 'limit', label: 'How many messages', type: 'number', placeholder: '10', advanced: true },
    ],
    send_file: [
        { field: 'to', label: 'Send to', type: 'choice', required: true, default: 'telegram', options: [{ value: 'telegram', label: 'Telegram' }, { value: 'slack', label: 'Slack' }, { value: 'http', label: 'HTTP upload' }] },
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, when: { field: 'to', op: 'in', value: ['telegram', 'slack'] } },
        { field: 'chatId', label: 'Chat ID', type: 'value', required: true, when: { field: 'to', op: 'eq', value: 'telegram' } },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, when: { field: 'to', op: 'eq', value: 'slack' } },
        { field: 'url', label: 'Upload URL', type: 'value', required: true, when: { field: 'to', op: 'eq', value: 'http' } },
        { field: 'caption', label: 'Caption / message', type: 'value', advanced: true },
    ],
    delay: [{ field: 'ms', label: 'Delay (ms)', type: 'number', required: true }],
    set: [
        { field: 'name', label: 'Variable name', type: 'value', acceptsData: false, required: true },
        { field: 'value', label: 'Value', type: 'value', required: true, placeholder: 'text or drop a data chip' },
    ],
    map: [
        { field: 'items', label: 'Items to loop over', type: 'value', required: true, placeholder: 'drop a list chip, e.g. results', help: 'The list to repeat this for. Drop in a list from an earlier step.' },
        { field: 'action', label: 'For each item', type: 'choice', required: true, default: 'tool', options: [{ value: 'tool', label: 'Run a tool / skill' }, { value: 'model', label: 'Run the model' }] },
        { field: 'tool', label: 'Tool / skill name', type: 'value', acceptsData: false, required: true, placeholder: 'e.g. fetch_url', when: { field: 'action', op: 'neq', value: 'model' } },
        { field: '__args', label: 'Parameters', type: 'special', special: 'toolArgs', when: { field: 'action', op: 'neq', value: 'model' } },
        { field: 'prompt', label: 'Prompt', type: 'multiline', required: true, placeholder: 'Summarize this: drop the item chip', when: { field: 'action', op: 'eq', value: 'model' } },
        { field: 'model', label: 'Model', type: 'choice', optionsFrom: 'models', advanced: true, when: { field: 'action', op: 'eq', value: 'model' } },
        { field: 'maxConcurrency', label: 'How many at once', type: 'number', placeholder: '3', advanced: true, help: 'How many items to process in parallel (default 3).' },
    ],
    'gate.if': [
        { field: 'condition.left', label: 'Value to check', type: 'value', required: true, placeholder: 'previous output' },
        { field: 'condition.op', label: 'Is', type: 'choice', required: true, default: '==', options: COND_OP_OPTIONS },
        { field: 'condition.right', label: 'Compare to', type: 'value', required: true, when: { field: 'condition.op', op: 'notIn', value: ['empty', 'not_empty'] } },
    ],
    'gate.filter': [
        { field: 'condition.left', label: 'Value to check', type: 'value', required: true, placeholder: 'previous output' },
        { field: 'condition.op', label: 'Is', type: 'choice', required: true, default: '==', options: COND_OP_OPTIONS },
        { field: 'condition.right', label: 'Compare to', type: 'value', required: true, when: { field: 'condition.op', op: 'notIn', value: ['empty', 'not_empty'] } },
    ],
    'gate.switch': [
        { field: 'value', label: 'Value to check', type: 'value', required: true, placeholder: 'previous output' },
        { field: 'cases', label: 'Cases', type: 'special', special: 'switchCases', required: true },
    ],
    'trigger.schedule': [{ field: '__schedule', label: 'Schedule', type: 'special', special: 'schedule', required: true }],
    'trigger.event': [{ field: 'event', label: 'Event name', type: 'value', acceptsData: false, required: true, placeholder: 'model.loaded' }],
    'trigger.telegram': [
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, placeholder: '123456:ABC-DEF…' },
        { field: 'chatId', label: 'Only this chat', type: 'value', acceptsData: false, placeholder: 'only this chat / @channel', advanced: true, help: 'Optional — limit to one chat / channel.' },
        { field: 'keyword', label: 'Only messages containing', type: 'value', acceptsData: false, advanced: true, help: 'Optional — only run when the message matches.' },
        { field: 'match', label: 'Match', type: 'choice', default: 'contains', options: MATCH_OPTS, advanced: true, when: { field: 'keyword', op: 'truthy' } },
    ],
    'trigger.slack': [
        { field: 'botToken', label: 'Bot token (xoxb-…)', type: 'value', acceptsData: false, required: true, placeholder: 'xoxb-…' },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, placeholder: 'C0123456789' },
        { field: 'keyword', label: 'Only messages containing', type: 'value', acceptsData: false, advanced: true, help: 'Optional — only run when the message matches.' },
        { field: 'match', label: 'Match', type: 'choice', default: 'contains', options: MATCH_OPTS, advanced: true, when: { field: 'keyword', op: 'truthy' } },
    ],
    'trigger.webhook': [{ field: '__webhook', label: 'Webhook', type: 'special', special: 'webhook', required: true }],
};

function chipApplies(chip, kind) {
    const a = chip && chip.appliesTo;
    if (!a || a === '*' || (Array.isArray(a) && a.includes('*'))) return true;
    return Array.isArray(a) ? a.includes(kind) : a === kind;
}
function chipsForKind(kind, ctx) {
    const out = [{ field: 'label', label: 'Step name', type: 'value', acceptsData: false, advanced: true }];
    for (const c of (CHIP_DEFS_BY_KIND[kind] || [])) out.push({ ...c });
    const noFwd = (typeof kind === 'string' && (kind.startsWith('trigger.') || kind.startsWith('gate.'))) || kind === 'output' || kind === 'merge';
    if (!noFwd) out.push({ field: 'forward', label: 'Output → next step', type: 'multiline', hint: 'Shape what flows on. Blank = send the whole output.' });
    for (const c of ((ctx && ctx.customChips) || [])) if (chipApplies(c, kind)) out.push({ ...c, _custom: true });
    return out;
}
function resolveOptions(s, ctx) {
    if (s.optionsFrom === 'models') { const ms = (ctx && ctx.runningModels) || []; return [{ value: '', label: ms[0] ? `Current model (${ms[0].name})` : 'Current model' }, ...ms.map(m => ({ value: m.name, label: m.name + (m.backend ? ` · ${m.backend}` : '') }))]; }
    return (s.options || []).map(o => (typeof o === 'string' ? { value: o, label: o } : o));
}
function resolveSuggestions(s, ctx) {
    if (s.suggestFrom === 'parseFields') return (ctx && ctx.parseFields) || [];
    if (s.suggestFrom === 'incomingFields') return (ctx && ctx.incomingFields) || [];
    return null;
}
function renderSpecial(s, d, onChange, ctx, registerActive) {
    if (s.special === 'toolArgs') return <ToolArgsChips d={d} onChange={onChange} nodeList={ctx.nodeList} registerActive={registerActive} />;
    if (s.special === 'switchCases') return <SwitchCases d={d} onChange={onChange} nodeList={ctx.nodeList} registerActive={registerActive} />;
    if (s.special === 'schedule') return <ScheduleChips d={d} onChange={onChange} />;
    if (s.special === 'webhook') return <WebhookChip ctx={ctx} />;
    return null;
}

// The chip board: applied chips + an Add tray + the data-chip palette.
// ============================================================
// CHIPS LIBRARY — separate from node palette. A chip is a small behavior you
// drag from the left "Chips" panel onto a node to post-process its output
// (parse / transform / filter). Definitions only (id/label/category/desc); the
// engine wiring that runs them is a follow-up.
// ============================================================
const CHIP_LIB_DRAG = 'application/automation-chiplib';
const CHIP_LIBRARY = [
    // Text
    { id: 'trim', label: 'Trim', category: 'Text', desc: 'Strip leading/trailing whitespace' },
    { id: 'uppercase', label: 'UPPERCASE', category: 'Text', desc: 'Convert text to upper case' },
    { id: 'lowercase', label: 'lowercase', category: 'Text', desc: 'Convert text to lower case' },
    { id: 'titlecase', label: 'Title Case', category: 'Text', desc: 'Capitalize each word' },
    { id: 'capitalize', label: 'Capitalize', category: 'Text', desc: 'Capitalize the first letter' },
    { id: 'collapse_ws', label: 'Collapse spaces', category: 'Text', desc: 'Collapse runs of whitespace to one space' },
    { id: 'remove_blank_lines', label: 'Remove blank lines', category: 'Text', desc: 'Drop empty lines' },
    { id: 'strip_html', label: 'Strip HTML', category: 'Text', desc: 'Remove HTML tags' },
    { id: 'slugify', label: 'Slugify', category: 'Text', desc: 'Make a url-safe slug' },
    { id: 'reverse_text', label: 'Reverse text', category: 'Text', desc: 'Reverse the characters' },
    { id: 'truncate_280', label: 'Truncate 280', category: 'Text', desc: 'Cut to 280 characters' },
    { id: 'word_count', label: 'Word count', category: 'Text', desc: 'Count words' },
    { id: 'char_count', label: 'Character count', category: 'Text', desc: 'Count characters' },
    { id: 'dedent', label: 'Dedent', category: 'Text', desc: 'Remove common leading indentation' },
    { id: 'normalize_quotes', label: 'Normalize quotes', category: 'Text', desc: 'Curly → straight quotes' },
    // Parse / extract
    { id: 'parse_json', label: 'Parse JSON', category: 'Parse', desc: 'Parse a JSON string into data' },
    { id: 'to_json', label: 'To JSON string', category: 'Parse', desc: 'Serialize data to JSON' },
    { id: 'extract_urls', label: 'Extract URLs', category: 'Parse', desc: 'Pull all links out of the text' },
    { id: 'extract_emails', label: 'Extract emails', category: 'Parse', desc: 'Pull all email addresses' },
    { id: 'extract_numbers', label: 'Extract numbers', category: 'Parse', desc: 'Pull all numbers' },
    { id: 'extract_hashtags', label: 'Extract #tags', category: 'Parse', desc: 'Pull all hashtags' },
    { id: 'first_url', label: 'First link', category: 'Parse', desc: 'Keep only the first URL' },
    { id: 'domain_of', label: 'Domain only', category: 'Parse', desc: 'Reduce a URL to its domain' },
    { id: 'md_to_text', label: 'Markdown → text', category: 'Parse', desc: 'Strip markdown formatting' },
    { id: 'html_to_text', label: 'HTML → text', category: 'Parse', desc: 'Render HTML to plain text' },
    { id: 'csv_to_rows', label: 'CSV → rows', category: 'Parse', desc: 'Parse CSV into rows' },
    { id: 'lines_to_list', label: 'Lines → list', category: 'Parse', desc: 'Split text into a list by line' },
    { id: 'split_commas', label: 'Split on commas', category: 'Parse', desc: 'Split text into a list by comma' },
    { id: 'extract_dates', label: 'Extract dates', category: 'Parse', desc: 'Pull date-like strings' },
    // List
    { id: 'first', label: 'First item', category: 'List', desc: 'Keep only the first item' },
    { id: 'last', label: 'Last item', category: 'List', desc: 'Keep only the last item' },
    { id: 'first_5', label: 'First 5', category: 'List', desc: 'Keep the first 5 items' },
    { id: 'first_10', label: 'First 10', category: 'List', desc: 'Keep the first 10 items' },
    { id: 'skip_1', label: 'Skip first', category: 'List', desc: 'Drop the first item' },
    { id: 'reverse_list', label: 'Reverse list', category: 'List', desc: 'Reverse the order' },
    { id: 'sort_az', label: 'Sort A→Z', category: 'List', desc: 'Sort ascending' },
    { id: 'sort_za', label: 'Sort Z→A', category: 'List', desc: 'Sort descending' },
    { id: 'sort_numeric', label: 'Sort numeric', category: 'List', desc: 'Sort as numbers' },
    { id: 'dedupe', label: 'Remove duplicates', category: 'List', desc: 'Keep unique items' },
    { id: 'remove_empties', label: 'Remove empties', category: 'List', desc: 'Drop empty/blank items' },
    { id: 'count_items', label: 'Count items', category: 'List', desc: 'Return the number of items' },
    { id: 'join_commas', label: 'Join with commas', category: 'List', desc: 'Join a list with ", "' },
    { id: 'join_newlines', label: 'Join with new lines', category: 'List', desc: 'Join a list with line breaks' },
    { id: 'join_bullets', label: 'Join as bullets', category: 'List', desc: 'Join a list as "- " bullets' },
    { id: 'flatten', label: 'Flatten', category: 'List', desc: 'Flatten nested lists one level' },
    { id: 'shuffle', label: 'Shuffle', category: 'List', desc: 'Randomize the order' },
    // Filter
    { id: 'filter_nonempty', label: 'Only non-empty', category: 'Filter', desc: 'Keep items that have content' },
    { id: 'filter_has_url', label: 'Only with a URL', category: 'Filter', desc: 'Keep items containing a link' },
    { id: 'filter_unique', label: 'Only new vs last run', category: 'Filter', desc: 'Keep items not seen last run' },
    { id: 'drop_nulls', label: 'Drop null fields', category: 'Filter', desc: 'Remove null/empty object fields' },
    // Number / format
    { id: 'round', label: 'Round', category: 'Format', desc: 'Round numbers to whole' },
    { id: 'round_2', label: 'Round (2 dp)', category: 'Format', desc: 'Round to 2 decimals' },
    { id: 'floor', label: 'Floor', category: 'Format', desc: 'Round down' },
    { id: 'ceil', label: 'Ceiling', category: 'Format', desc: 'Round up' },
    { id: 'abs', label: 'Absolute value', category: 'Format', desc: 'Make numbers positive' },
    { id: 'to_currency', label: 'To currency', category: 'Format', desc: 'Format a number as $1,234.56' },
    { id: 'to_percent', label: 'To percent', category: 'Format', desc: 'Format a number as a percent' },
    { id: 'add_prefix', label: 'Add prefix', category: 'Format', desc: 'Prepend a label' },
    { id: 'add_suffix', label: 'Add suffix', category: 'Format', desc: 'Append a label' },
    { id: 'wrap_code', label: 'Wrap in code block', category: 'Format', desc: 'Fence text as code' },
    { id: 'wrap_quotes', label: 'Wrap in quotes', category: 'Format', desc: 'Surround with quotes' },
    { id: 'to_uppercase_first', label: 'Sentence case', category: 'Format', desc: 'Lowercase then capitalize first letter' },
    { id: 'now_timestamp', label: 'Add timestamp', category: 'Format', desc: 'Append the current date/time' },
    { id: 'pretty_json', label: 'Pretty JSON', category: 'Format', desc: 'Indent JSON for readability' },
];
const CHIP_LIB_BY_ID = Object.fromEntries(CHIP_LIBRARY.map(c => [c.id, c]));
const CHIP_LIB_CATEGORIES = Array.from(new Set(CHIP_LIBRARY.map(c => c.category)));

// Bare-minimum node settings: just the node's own essential fields as plain
// controls. No data palette, no {{…}} tags, no args box, no add tray — extra
// behavior is added by dragging CHIPS (above) onto the node from the left panel.
// Attach an output transform to the selected node from its inspector (replaces
// the old drag-from-the-left-rail flow). Click to open a searchable list.
function TransformAdder({ attached = [], onAdd }) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const ql = q.trim().toLowerCase();
    const avail = CHIP_LIBRARY.filter(c => !attached.includes(c.id) && (!ql || (`${c.label} ${c.desc} ${c.category}`).toLowerCase().includes(ql)));
    return (
        <div className="cf-tadd">
            <button type="button" className={`cf-add${open ? ' is-on' : ''}`} onClick={() => { setOpen(o => !o); setQ(''); }}>
                <span className="cf-add__plus">+</span> Add a clean-up step
            </button>
            {open && (
                <div className="cf-tadd__panel">
                    <input className="cf-binput" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transforms…" autoFocus style={{ marginBottom: 6 }} />
                    <div className="cf-tadd__list">
                        {avail.length === 0 && <div className="cf-hint" style={{ padding: '4px 2px' }}>No transforms{attached.length ? ' left to add' : ''}.</div>}
                        {avail.map(c => (
                            <button key={c.id} type="button" className="cf-tadd__item" title={c.desc} onClick={() => { onAdd(c.id); setOpen(false); setQ(''); }}>
                                <span className="cf-tadd__lbl">{c.label}</span>
                                <span className="cf-tadd__cat">{c.category}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ChipBoard({ node, ctx, onChange }) {
    const d = node.data || {}; const kind = d.kind;
    // NOTE: do NOT filter out `special: 'toolArgs'` here — that hid the
    // Parameters section (a tool/Script Block node's args, e.g. the Python
    // code) from the config panel entirely, so the LLM-generated script was
    // invisible and uneditable. renderField → renderSpecial renders it like
    // any other special (schedule/switch/webhook).
    const specs = chipsForKind(kind, ctx).filter(s => s.field !== 'forward' && !s._custom);
    const defaults = {}; for (const s of specs) if (s.default !== undefined) defaults[s.field] = s.default;
    const set = (s, val) => onChange(patchFor(d, s.field, val));
    const shown = specs.filter(s => evalWhen(s.when, d, defaults));
    // Lead with the load-bearing field(s); tuck rarely-needed ones (and the
    // optional output clean-up) behind one "Advanced" disclosure so a beginner
    // sees a short, obvious form. `advanced` + `help` are display-only flags on
    // the chip defs — they compile to the SAME node.data, engine untouched.
    const shownMain = shown.filter(s => !s.advanced);
    const shownAdv = shown.filter(s => s.advanced);
    const attached = Array.isArray(d.chips) ? d.chips : [];
    // Gates skip node.data.chips at runtime (their output carries a _handle), so a
    // transform there never runs — don't offer to add one; only let the user
    // remove a stray one left from before.
    const isGate = typeof kind === 'string' && kind.startsWith('gate.');
    const canAddTransforms = !isGate;
    const showTransformsBlock = canAddTransforms || attached.length > 0;
    const mainEmpty = shownMain.length === 0; // e.g. merge / output / manual trigger

    const [advOpen, setAdvOpen] = useState(false);
    // Reset/auto-open per selected node (ChipBoard is reused across selections):
    // open Advanced when something there is already configured so it's never hidden.
    useEffect(() => {
        const anyAdvSet = shownAdv.some(s => { const v = getAt(d, s.field); return v !== undefined && v !== ''; });
        setAdvOpen(attached.length > 0 || anyAdvSet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const renderField = (s) => {
        let el;
        if (s.type === 'special') el = renderSpecial(s, d, onChange, ctx, null);
        else if (s.type === 'choice') el = <ChoiceChip chip={s} value={getAt(d, s.field)} options={resolveOptions(s, ctx)} onChange={(v) => set(s, v)} />;
        else if (s.type === 'toggle') el = <ToggleChip chip={s} value={getAt(d, s.field) ?? s.default} onChange={(v) => set(s, v)} />;
        else if (s.type === 'number') el = <NumberChip chip={s} value={getAt(d, s.field)} onChange={(v) => set(s, v)} />;
        else el = <ValueChip chip={{ ...s, acceptsData: false }} value={getAt(d, s.field)} onChange={(v) => set(s, v)} />;
        // Tiny plain-English hint under the chip (never on special editors).
        return (s.help && s.type !== 'special')
            ? <div className="cf-field" key={s.field}>{el}<div className="cf-help">{s.help}</div></div>
            : <React.Fragment key={s.field}>{el}</React.Fragment>;
    };

    const transformsBlock = showTransformsBlock ? (
        <div className="cf-sec">
            <div className="cf-sec__label">Clean up the output (optional)</div>
            {attached.length > 0 && (
                <div className="cf-tray">{attached.map((cid, i) => { const c = CHIP_LIB_BY_ID[cid]; return (
                    <span key={i} className="cf-chip-pill" title={c ? c.desc : cid}>{c ? c.label : cid}<button className="cf-sub__x" onClick={() => onChange({ chips: attached.filter((_, j) => j !== i) })}>×</button></span>
                ); })}</div>
            )}
            {canAddTransforms && <TransformAdder attached={attached} onAdd={(id) => { if (!attached.includes(id)) onChange({ chips: [...attached, id] }); }} />}
            {canAddTransforms && attached.length === 0 && <div className="cf-hint">Optional — only if you want to tidy this step’s result first (e.g. remove extra spaces, keep the first item, or pull out the links).</div>}
        </div>
    ) : null;

    const hasAdvanced = !mainEmpty && (shownAdv.length > 0 || showTransformsBlock);

    return (
        <div className="cf-board">
            {/* If a node has no main field (merge/output/manual), show its Advanced
                fields inline rather than an empty box + lone disclosure. */}
            <div className="cf-sec" style={{ gap: 8 }}>{(mainEmpty ? shownAdv : shownMain).map(renderField)}</div>
            {mainEmpty && transformsBlock}
            {hasAdvanced && (
                <div className="cf-sec">
                    <button type="button" className="cf-advhead" onClick={() => setAdvOpen(o => !o)}>
                        <span aria-hidden>{advOpen ? '▾' : '▸'}</span> Advanced
                    </button>
                    {advOpen && (<>
                        {shownAdv.length > 0 && <div className="cf-sec" style={{ gap: 8 }}>{shownAdv.map(renderField)}</div>}
                        {transformsBlock}
                    </>)}
                </div>
            )}
        </div>
    );
}

// Node kinds a custom chip can target (label for the builder's picker).
const NODE_KIND_OPTIONS = [
    ['*', 'Any node'], ['model', 'Model'], ['tool', 'Tool / skill'], ['web_search', 'Web search'], ['fetch_url', 'Fetch URL'],
    ['parse_json', 'Parse JSON'], ['db_store', 'DB: Store'], ['db_query', 'DB: Query'], ['render_html', 'Render HTML'], ['export_file', 'Export file'],
    ['slack', 'Slack'], ['telegram', 'Telegram'], ['telegram_get', 'Telegram: Get'], ['send_file', 'Send file'], ['delay', 'Delay'], ['set', 'Set variable'], ['map', 'Loop / Map'],
    ['gate.if', 'If / Else'], ['gate.filter', 'Filter'], ['gate.switch', 'Switch'], ['merge', 'Merge'], ['output', 'Output'],
    ['trigger.manual', 'Trigger: Manual'], ['trigger.schedule', 'Trigger: Schedule'], ['trigger.webhook', 'Trigger: Webhook'], ['trigger.event', 'Trigger: Event'], ['trigger.telegram', 'Trigger: Telegram'], ['trigger.slack', 'Trigger: Slack'],
];
// Real fields a node kind already exposes — shown as guided suggestions so the
// builder writes a correct mapping instead of the user guessing field names.
function knownFieldsForKind(kind) {
    if (!kind || kind === '*') return [];
    const fields = (CHIP_DEFS_BY_KIND[kind] || []).filter(d => d.type !== 'special').map(d => d.field);
    if (kind === 'tool') for (const t of Object.keys(TOOL_PARAMS)) for (const p of TOOL_PARAMS[t]) fields.push('args.' + p.key);
    return Array.from(new Set(fields));
}

// The chip builder modal: manage custom chips, hand-build one (guided, no raw
// JSON), or describe one for the model to draft.
function ChipBuilder({ onClose, customChips, onSaved, notify }) {
    const EMPTY = { label: '', appliesTo: ['*'], field: '', type: 'value', options: [], acceptsData: true, placeholder: '', default: '' };
    const [form, setForm] = useState(EMPTY);
    const [editingId, setEditingId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [building, setBuilding] = useState(false);
    const upd = (patch) => setForm(f => ({ ...f, ...patch }));
    const reset = () => { setForm(EMPTY); setEditingId(null); };
    const buildLLM = async () => {
        const p = prompt.trim(); if (!p || building) return; setBuilding(true);
        try {
            const r = await fetch('/api/chips/build', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: p }) });
            const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to build');
            setForm({ label: d.label || '', appliesTo: Array.isArray(d.appliesTo) ? d.appliesTo : ['*'], field: d.field || '', type: d.type || 'value', options: Array.isArray(d.options) ? d.options : [], acceptsData: d.acceptsData !== false, placeholder: d.placeholder || '', default: d.default ?? '', when: d.when });
            setPrompt(''); notify('Chip drafted — review and save', 'success');
        } catch (e) { notify(e.message, 'error'); } finally { setBuilding(false); }
    };
    const save = async () => {
        if (!form.label.trim() || !form.field.trim()) { notify('Give the chip a label and a field', 'error'); return; }
        setSaving(true);
        const body = { label: form.label.trim(), appliesTo: (form.appliesTo && form.appliesTo.length) ? form.appliesTo : ['*'], field: form.field.trim(), type: form.type, acceptsData: form.acceptsData, placeholder: form.placeholder || undefined, default: form.default === '' ? undefined : form.default, options: form.type === 'choice' ? form.options : undefined, when: form.when };
        try {
            const url = editingId ? `/api/chips/${editingId}` : '/api/chips';
            const r = await fetch(url, { method: editingId ? 'PUT' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to save');
            await onSaved(); reset(); notify('Chip saved', 'success');
        } catch (e) { notify(e.message, 'error'); } finally { setSaving(false); }
    };
    const edit = (c) => { setEditingId(c.id); setForm({ label: c.label || '', appliesTo: c.appliesTo || ['*'], field: c.field || '', type: c.type || 'value', options: c.options || [], acceptsData: c.acceptsData !== false, placeholder: c.placeholder || '', default: c.default ?? '', when: c.when }); };
    const remove = async (id) => { try { const r = await fetch(`/api/chips/${id}`, { method: 'DELETE', credentials: 'include' }); if (!r.ok) throw new Error('Failed to delete'); await onSaved(); if (editingId === id) reset(); notify('Chip deleted', 'success'); } catch (e) { notify(e.message, 'error'); } };
    const toggleKind = (k) => setForm(f => { if (k === '*') return { ...f, appliesTo: ['*'] }; let a = (f.appliesTo || []).filter(x => x !== '*'); a = a.includes(k) ? a.filter(x => x !== k) : [...a, k]; return { ...f, appliesTo: a.length ? a : ['*'] }; });
    const oneKind = (form.appliesTo || []).length === 1 ? form.appliesTo[0] : null;
    const fieldSugg = oneKind ? knownFieldsForKind(oneKind) : [];
    return (
        <div className="cf-modal-backdrop" onMouseDown={onClose}>
            <div className="cf-modal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="cf-modal__head"><b>Chip builder</b><button className="cf-chip__rm" onClick={onClose}>×</button></div>
                <div className="cf-modal__body">
                    <div className="cf-modal__list">
                        <div className="cf-sec__label">Your chips</div>
                        {(customChips || []).length === 0 && <div className="cf-hint">None yet. Build one on the right →</div>}
                        {(customChips || []).map(c => (
                            <div key={c.id} className="cf-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ink)' }}>{c.label} <span style={{ color: 'var(--accent)' }}>✦</span></div>
                                    <div className="cf-hint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{(c.appliesTo || []).join(', ')} · {c.field} · {c.type}</div>
                                </div>
                                <button className="cf-add" onClick={() => edit(c)}>Edit</button>
                                <button className="cf-chip__rm" onClick={() => remove(c.id)}>×</button>
                            </div>
                        ))}
                    </div>
                    <div className="cf-modal__form">
                        <div className="cf-sec__label">Describe a chip — the model drafts it</div>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <input className="cf-binput" placeholder="e.g. a Bcc field for the email node" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') buildLLM(); }} />
                            <button className="auto-btn auto-btn--accent" style={{ flexShrink: 0 }} onClick={buildLLM} disabled={building || !prompt.trim()}>{building ? '…' : 'Draft'}</button>
                        </div>
                        <label className="cf-blabel">Label</label>
                        <input className="cf-binput" value={form.label} onChange={(e) => upd({ label: e.target.value })} placeholder="Chat ID" />
                        <label className="cf-blabel">Works on</label>
                        <div className="cf-tray">{NODE_KIND_OPTIONS.map(([k, lbl]) => <button key={k} className={`cf-add${(form.appliesTo || []).includes(k) ? ' is-on' : ''}`} onClick={() => toggleKind(k)}>{lbl}</button>)}</div>
                        <label className="cf-blabel">Controls field</label>
                        <input className="cf-binput" value={form.field} onChange={(e) => upd({ field: e.target.value })} placeholder="e.g. chatId or args.url" />
                        {fieldSugg.length > 0 && <div className="cf-tray" style={{ marginTop: 5 }}>{fieldSugg.map(f => <button key={f} className="cf-add" onClick={() => upd({ field: f })}>{f}</button>)}</div>}
                        <label className="cf-blabel">Type</label>
                        <div className="cf-tray">{['value', 'multiline', 'choice', 'toggle', 'number'].map(t => <button key={t} className={`cf-add${form.type === t ? ' is-on' : ''}`} onClick={() => upd({ type: t })}>{t}</button>)}</div>
                        {(form.type === 'value' || form.type === 'multiline') && (
                            <label className="cf-blabel" style={{ display: 'flex', gap: 8, alignItems: 'center', textTransform: 'none', fontWeight: 500, fontSize: 12 }}>
                                <input type="checkbox" checked={form.acceptsData} onChange={(e) => upd({ acceptsData: e.target.checked })} /> Can hold data chips from earlier steps
                            </label>
                        )}
                        {form.type === 'choice' && (
                            <div>
                                <label className="cf-blabel">Options</label>
                                {(form.options || []).map((o, i) => (
                                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                                        <input className="cf-binput" placeholder="value" value={o.value} onChange={(e) => upd({ options: form.options.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} />
                                        <input className="cf-binput" placeholder="label" value={o.label} onChange={(e) => upd({ options: form.options.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
                                        <button className="cf-chip__rm" onClick={() => upd({ options: form.options.filter((_, j) => j !== i) })}>×</button>
                                    </div>
                                ))}
                                <button className="cf-add" onClick={() => upd({ options: [...(form.options || []), { value: '', label: '' }] })}>+ option</button>
                            </div>
                        )}
                        {form.type !== 'toggle' && form.type !== 'choice' && (<><label className="cf-blabel">Placeholder</label><input className="cf-binput" value={form.placeholder} onChange={(e) => upd({ placeholder: e.target.value })} /></>)}
                        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                            <button className="auto-btn auto-btn--primary auto-btn--grow" onClick={save} disabled={saving}>{saving ? 'Saving…' : (editingId ? 'Save changes' : 'Create chip')}</button>
                            {editingId && <button className="auto-btn auto-btn--ghost" onClick={reset}>New</button>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function NodeConfig({ node, typeLabel, runningModels = [], lastRun, allOutputs = {}, nodeList = [], edgeList = [], width = 300, mobile = false, onClose, onResizeStart, onChange, onDelete, webhookUrl, onGenWebhook, copied, onCopyWebhook, customChips = [], onOpenChipBuilder }) {
    const kind = node.data.kind;
    const d = node.data;
    // Fields available from the node feeding into this one (for the dedup-key
    // dropdown) — derived from the upstream node's captured output after a run.
    const incomingNodeId = (edgeList.find(e => e.target === node.id) || {}).source;
    const incomingOutput = incomingNodeId && allOutputs[incomingNodeId] ? allOutputs[incomingNodeId].output : undefined;
    const incomingFields = incomingOutput !== undefined ? recordFieldsFromOutput(incomingOutput) : [];
    // For parse_json: the JSON it will parse (the upstream output, unwrapping a
    // JSON-string `data` field e.g. from http_request) → pickable field paths.
    let parseSrc = incomingOutput;
    if (parseSrc && typeof parseSrc === 'object' && typeof parseSrc.data === 'string') { try { parseSrc = JSON.parse(parseSrc.data); } catch (_) {} }
    else if (typeof parseSrc === 'string') { try { parseSrc = JSON.parse(parseSrc); } catch (_) {} }
    const parseFields = parseSrc && typeof parseSrc === 'object' ? fieldPathOptions(parseSrc) : [];
    const cond = (d.condition && typeof d.condition === 'object') ? d.condition : { left: '', op: '==', right: '' };
    const setCond = (patch) => onChange({ condition: { ...cond, ...patch } });
    const isTrigger = typeof kind === 'string' && kind.startsWith('trigger.');

    // Upstream data tags available to this node's fields (provided to every
    // templatable field's inline "{ }" picker — no more always-open wall).
    const tagGroups = useMemo(() => buildTagGroups(allOutputs, nodeList, edgeList, node.id), [allOutputs, nodeList, edgeList, node.id]);
    const HeadIcon = iconFor(kind, d);
    const [refCopied, setRefCopied] = useState(false);
    const copyRef = () => { try { navigator.clipboard?.writeText(`{{nodes.${node.id}}}`); setRefCopied(true); setTimeout(() => setRefCopied(false), 1200); } catch (_) {} };
    const [tab, setTab] = useState('parameters'); // parameters | settings | docs
    const nodeRef = `{{nodes.${node.id}}}`;
    // Everything the chip board needs to render this node's chips + data palette.
    const chipCtx = { runningModels, nodeList, edgeList, parseFields, incomingFields, customChips, webhookUrl, onGenWebhook, copied, onCopyWebhook, onOpenChipBuilder };

    return (
        <DataTagsContext.Provider value={tagGroups}>
        <div style={mobile
            ? { position: 'fixed', inset: 0, zIndex: 60, width: '100%', overflowY: 'auto', padding: 12, background: 'var(--surface)' }
            : { position: 'relative', width, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            {!mobile && onResizeStart && <ResizeHandle onResizeStart={onResizeStart} />}
            <div className="auto-panel__head">
                {mobile && (
                    <button className="auto-btn auto-btn--icon auto-btn--sm" onClick={onClose} title="Close" style={{ flexShrink: 0 }}><CloseIcon size={15} /></button>
                )}
                <span className="auto-panel__icon" style={{ background: `color-mix(in oklab, var(--cat-${consoleCat(kind)}) 16%, transparent)`, color: `var(--cat-${consoleCat(kind)})` }}><HeadIcon size={16} strokeWidth={2} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="auto-panel__title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label || typeLabel || kind}</div>
                    <div className="auto-panel__sub">{typeLabel || kind}</div>
                </div>
                <button className="auto-btn auto-btn--icon auto-btn--sm auto-btn--danger" onClick={onDelete} title="Delete node" style={{ flexShrink: 0 }}><Trash2 size={14} /></button>
            </div>

            <div className="auto-insptabs">
                <button className={`auto-insptab${tab === 'parameters' ? ' is-on' : ''}`} onClick={() => setTab('parameters')}>Parameters</button>
                <button className={`auto-insptab${tab === 'settings' ? ' is-on' : ''}`} onClick={() => setTab('settings')}>Settings</button>
                <button className={`auto-insptab${tab === 'docs' ? ' is-on' : ''}`} onClick={() => setTab('docs')}>Docs</button>
            </div>

            {tab === 'parameters' && <ChipBoard node={node} ctx={chipCtx} onChange={onChange} />}

            {tab === 'settings' && (
                <div className="cf-board">
                    <div className="cf-sec">
                        <div className="cf-sec__label">State</div>
                        <label className={`auto-switch${false ? ' is-disabled' : ''}`} style={{ padding: '2px 0' }}>
                            <input type="checkbox" checked={!d.disabled} onChange={() => onChange({ disabled: !d.disabled })} />
                            <span className="auto-switch__track"><span className="auto-switch__thumb" /></span>
                            <span>{d.disabled ? 'Node disabled — skipped on run' : 'Node enabled'}</span>
                        </label>
                    </div>
                    <div className="cf-sec">
                        <div className="cf-sec__label">Danger zone</div>
                        <button className="auto-btn auto-btn--danger auto-btn--block auto-btn--sm" onClick={onDelete}>
                            <Trash2 size={13} /> <span>Delete this node</span>
                        </button>
                    </div>
                </div>
            )}

            {tab === 'docs' && (
                <div className="cf-board">
                    <div className="cf-sec">
                        <div className="cf-sec__label">About</div>
                        <div className="cf-hint">{typeLabel || kind}{isTrigger ? ' — starts the workflow.' : ''}</div>
                    </div>
                    <div className="cf-sec">
                        <div className="cf-sec__label">Reference this step</div>
                        <div className="auto-panel__ref">
                            <code>{nodeRef}</code>
                            <button className="auto-panel__refbtn" onClick={copyRef}>{refCopied ? <Check size={12} /> : <Copy size={12} />}{refCopied ? 'Copied' : 'Copy'}</button>
                        </div>
                        <div className="cf-hint" style={{ marginTop: 6 }}>Drop this into a later node’s field (or use its “{'{ }'}” picker) to pass this step’s output downstream.</div>
                    </div>
                </div>
            )}
        </div>
        </DataTagsContext.Provider>
    );
}

// JSON editor field with inline validity feedback + the inline data-tag picker
// (drops {{...}} into a value, e.g. {"url": "{{nodes.id.results.0.url}}"}).
function JsonField({ value, onChange, placeholder }) {
    const [text, setText] = useState(() => value == null ? '' : JSON.stringify(value, null, 2));
    const [err, setErr] = useState(false);
    const elRef = useRef(null);
    const groups = React.useContext(DataTagsContext);
    const hasTags = groups && groups.length > 0;
    const applyText = (t) => {
        setText(t);
        if (!t.trim()) { setErr(false); onChange(undefined); return; }
        try { const parsed = JSON.parse(t); setErr(false); onChange(parsed); }
        catch { setErr(true); }
    };
    const onChangeRef = useRef(applyText); onChangeRef.current = applyText;
    return (
        <div className="auto-field">
            <textarea
                ref={elRef}
                style={{ ...fieldInput, minHeight: 70, fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical', ...(hasTags ? { paddingRight: 34 } : null), borderColor: err ? 'var(--danger, #ef4444)' : 'var(--rule-2)' }}
                value={text}
                placeholder={placeholder || '{}'}
                onChange={(e) => applyText(e.target.value)}
                {...makeDropHandlers(elRef, onChangeRef)}
            />
            <FieldTagButton insertRef={(r) => insertAtCaret(elRef.current, onChangeRef, r)} />
            {err && <div style={{ fontSize: 10, color: 'var(--danger, #ef4444)', marginTop: -6, marginBottom: 8 }}>Invalid JSON</div>}
        </div>
    );
}

// Render a node's captured output as readable text (handles strings, objects,
// and the engine's {_truncated, preview} summary blobs).
function formatNodeOutput(out) {
    if (out == null) return '';
    if (typeof out === 'string') return out;
    if (typeof out === 'object' && out._truncated && typeof out.preview === 'string') return out.preview;
    if (Array.isArray(out) && out.every(x => x === null || typeof x !== 'object')) return out.filter(x => x != null).join('\n');
    try { return JSON.stringify(out, null, 2); } catch { return String(out); }
}

// First generated-file name in a node's output (for the card's file chip).
function artifactNameOf(out) {
    if (out && typeof out === 'object' && Array.isArray(out._artifacts) && out._artifacts[0] && out._artifacts[0].name) return out._artifacts[0].name;
    return '';
}

// Append `?download=1` so the server sends `Content-Disposition: attachment`.
// The HTML `download` attr alone is advisory — Chrome/Edge silently drop it
// under self-signed HTTPS, COOP isolation, and corporate policies.
function withDownloadFlag(url) {
    if (typeof url !== 'string' || !url) return url;
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

// Fetch the artifact as a blob, then hand the bytes to the browser via a
// `blob:` URL + synthetic <a> click. A plain `<a href download>` to the
// server URL gets blocked by Chrome with "Network issue" under a self-signed
// cert + HSTS (it refuses to honor the cert exception for background download
// requests) — the exact failure the user hit. A blob URL is in-memory and
// same-origin, so it sidesteps those heuristics entirely. Mirrors the chat
// app's ArtifactList.jsx fix.
async function saveArtifactViaBlob(url, filename) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

// "Last result" card shown at the top of the node config panel — live during a
// run, and seeded from the most recent run on load. Lets you inspect exactly
// what a connector/gate/trigger returned, plus the reference to pipe it forward.
function NodeResult({ lastRun, nodeId, isTrigger }) {
    const status = lastRun && lastRun.status;
    const hasOutput = lastRun && lastRun.output != null;
    // Any node whose output carries an `html` string (Render HTML) gets a live,
    // sandboxed preview (sandbox="" → no script execution; images/CSS still render).
    const htmlPreview = (lastRun && lastRun.output && typeof lastRun.output === 'object' && typeof lastRun.output.html === 'string')
        ? lastRun.output.html : null;
    // Generated files (create_pdf / create_file / export_file / render_chart / etc.)
    // come back as `_artifacts` with a ready download URL.
    const artifacts = (lastRun && lastRun.output && typeof lastRun.output === 'object' && Array.isArray(lastRun.output._artifacts))
        ? lastRun.output._artifacts.filter(a => a && a.url) : [];
    return (
        <div style={{ marginBottom: 12, border: '1px solid var(--rule-2)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--bg)', borderBottom: '1px solid var(--rule-2)' }}>
                {status && <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: runStatusColor(status) }} />}
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>Last result</span>
                {status && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-3)', textTransform: 'capitalize' }}>{status}</span>}
            </div>
            <div style={{ padding: 8 }}>
                {!lastRun && <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>No run yet — hit Run to capture this node's output.</div>}
                {status === 'running' && <div style={{ fontSize: 10.5, color: 'var(--accent)' }}>Running…</div>}
                {lastRun && lastRun.error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 11, marginBottom: hasOutput ? 6 : 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{lastRun.error}</div>}
                {artifacts.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 4 }}>Generated file{artifacts.length > 1 ? 's' : ''}</div>
                        {artifacts.map((a, i) => {
                            const dlUrl = withDownloadFlag(a.url);
                            return (
                            <a key={i} href={dlUrl} download={a.name} target="_blank" rel="noopener noreferrer"
                               onClick={(e) => {
                                   // fetch+blob first; the native <a download> on
                                   // the href is the fallback (also keeps
                                   // right-click → Save As working).
                                   e.preventDefault();
                                   saveArtifactViaBlob(dlUrl, a.name).catch(() => { window.location.href = dlUrl; });
                               }}
                               style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--accent)', textDecoration: 'none', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 9px', margin: '0 6px 6px 0', background: 'var(--accent-soft)' }}>
                                <Download size={12} /> {a.name}{a.size ? <span style={{ color: 'var(--ink-3)', fontSize: 9.5 }}>{` · ${a.size < 1024 ? a.size + ' B' : Math.round(a.size / 1024) + ' KB'}`}</span> : null}
                            </a>
                            );
                        })}
                    </div>
                )}
                {htmlPreview != null && (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 4 }}>Preview</div>
                        <iframe
                            title="HTML preview"
                            sandbox=""
                            srcDoc={htmlPreview}
                            style={{ width: '100%', height: 240, border: '1px solid var(--rule-2)', borderRadius: 6, background: '#fff' }}
                        />
                    </div>
                )}
                {hasOutput && (
                    <pre style={{ margin: 0, fontSize: 10.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: htmlPreview != null ? 100 : 220, overflow: 'auto', fontFamily: 'monospace' }}>{formatNodeOutput(lastRun.output)}</pre>
                )}
                {lastRun && status !== 'running' && !hasOutput && !lastRun.error && (
                    <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Completed with no output.</div>
                )}
            </div>
        </div>
    );
}

// ---- run history panel ----
function fmtRunTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
}
function runStatusColor(s) {
    return s === 'completed' ? 'var(--ok, #22c55e)'
        : s === 'failed' ? 'var(--danger, #ef4444)'
        : s === 'running' ? 'var(--accent)'
        : 'var(--ink-4, #64748b)';
}

// ---- Run history: friendly per-node summary ---------------------------------
// Turns a raw node output into a short, human-readable one-liner. Falls back to
// "view raw" for anything that doesn't smart-summarize cleanly.
// Best-effort summary of a JSON string that is TRUNCATED (cut mid-value, so it
// won't JSON.parse). Pulls friendly fields out by regex — never returns braces.
function summarizeTruncatedJson(s) {
    const grab = (re) => { const m = s.match(re); return m ? m[1] : null; };
    const file = grab(/"(?:outputPath|filePath|filename)"\s*:\s*"([^"]{1,200})"/);
    if (file) return `Created ${String(file).split(/[\\/]/).pop()}`;
    const count = grab(/"count"\s*:\s*(\d+)/);
    const title = grab(/"(?:feedTitle|title|name)"\s*:\s*"([^"]{1,90})"/);
    if (count) return `${count} item${count === '1' ? '' : 's'}${title ? ' · ' + title : ''}`;
    if (title) return title;
    const titles = (s.match(/"title"\s*:/g) || []).length;
    if (titles) return `${titles} item${titles === 1 ? '' : 's'}`;
    const links = (s.match(/"(?:url|link)"\s*:/g) || []).length;
    if (links) return `${links} result${links === 1 ? '' : 's'}`;
    return 'Structured data';
}

function summarizeNodeOutput(output) {
    if (output == null) return null;
    if (typeof output === 'string') {
        const s = output.trim();
        if (!s) return '(empty string)';
        // Node outputs are often serialized: a JSON string or an HTML document.
        // Parse JSON and summarize its STRUCTURE; never surface raw JSON/HTML.
        const head = s.slice(0, 600).toLowerCase();
        if (head.startsWith('<!doctype') || head.startsWith('<html') || (s[0] === '<' && head.includes('<body'))) {
            const title = (s.match(/<title[^>]*>([^<]{1,80})<\/title>/i) || [])[1];
            return title ? `HTML page — ${title.trim()}` : `HTML document (${s.length.toLocaleString()} chars)`;
        }
        if (s[0] === '{' || s[0] === '[') {
            // Parse if possible; on TRUNCATED/invalid JSON, extract friendly fields
            // by regex. Never fall through to printing raw JSON braces.
            try { return summarizeNodeOutput(JSON.parse(s)); } catch (_) { return summarizeTruncatedJson(s); }
        }
        const oneLine = s.replace(/\s+/g, ' ');
        return oneLine.length > 160 ? oneLine.slice(0, 160) + '…' : oneLine;
    }
    if (typeof output === 'number' || typeof output === 'boolean') return String(output);
    if (Array.isArray(output)) {
        if (output.length === 0) return '(empty list)';
        const first = output[0];
        if (typeof first === 'string' || typeof first === 'number') {
            const preview = output.slice(0, 3).join(', ');
            return `${output.length} item${output.length === 1 ? '' : 's'}: ${preview}${output.length > 3 ? ', …' : ''}`;
        }
        return `${output.length} item${output.length === 1 ? '' : 's'}`;
    }
    if (typeof output === 'object') {
        // Engine "truncated preview" wrapper: { _truncated, preview }. Unwrap and
        // summarize the INNER value so we never surface a raw JSON preview string.
        if (output._truncated !== undefined || output.preview !== undefined) {
            const inner = output.preview;
            if (inner && typeof inner === 'object') return summarizeNodeOutput(inner);
            if (typeof inner === 'string' && inner.trim()) {
                const t = inner.trim();
                if (t[0] === '{' || t[0] === '[') return summarizeTruncatedJson(t);
                return t.replace(/\s+/g, ' ').slice(0, 160) + (output._truncated ? '…' : '');
            }
            return 'Large result (truncated)';
        }
        // Created-file shape (create_pdf / export_file / html-to-pdf)
        if (output.outputPath || output.filePath || (Array.isArray(output._artifacts) && output._artifacts.length)) {
            const fp = output.outputPath || output.filePath || (output._artifacts && output._artifacts[0] && output._artifacts[0].name) || '';
            const base = String(fp).split('/').pop() || 'file';
            return `Created ${base}`;
        }
        // Feed / list-with-title shape (parse_rss, search, etc.)
        if (typeof output.count === 'number') {
            const title = output.title || output.feedTitle || output.name;
            return `${output.count} item${output.count === 1 ? '' : 's'}${title ? ' · ' + title : ''}`;
        }
        // Merge / collection shape: { items: [...] } or { results: [...] }
        if (Array.isArray(output.items)) return `${output.items.length} item${output.items.length === 1 ? '' : 's'}`;
        if (Array.isArray(output.results)) return `${output.results.length} result${output.results.length === 1 ? '' : 's'}`;
        // Common "this is a fetch/scrape" shape
        if (output.url && (output.title || output.content)) {
            return `${output.title || output.url}${output.content ? ' — ' + String(output.content).slice(0, 120).replace(/\s+/g, ' ') + '…' : ''}`;
        }
        // db_store change-feed
        if ('new' in output && Array.isArray(output.new)) {
            return `${output.new.length} new · ${output.stored != null ? output.stored + ' stored' : ''}${output.total != null ? ' · ' + output.total + ' total' : ''}`;
        }
        // Tool result with a status flag
        if (output.success === true && output.message) return String(output.message).slice(0, 180);
        if (output.error) return `Error: ${String(output.error).slice(0, 180)}`;
        // sent/delivered confirmations
        if (output.sent === true) return 'Sent ✓';
        if (output._delivered) return `Delivered to ${output._delivered}`;
        // Generic: first 3 readable scalar keys. Skip internal (_*) keys and the
        // bookkeeping `preview`/`success` flags so nothing JSON-ish leaks through.
        const keys = Object.keys(output).filter(k => !k.startsWith('_') && k !== 'preview' && k !== 'success' && k !== 'ok');
        const labelize = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
        const parts = [];
        for (const k of keys.slice(0, 3)) {
            const v = output[k];
            if (v == null) continue;
            if (typeof v === 'string') {
                const t = v.trim();
                if (t.startsWith('{') || t.startsWith('[')) continue; // don't surface embedded JSON
                parts.push(`${labelize(k)}: ${t.length > 50 ? t.slice(0, 50) + '…' : t}`);
            }
            else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${labelize(k)}: ${v}`);
            else if (Array.isArray(v)) parts.push(`${v.length} ${labelize(k)}`);
        }
        return parts.length ? parts.join(' · ') : 'Done';
    }
    return null;
}
function nodeFriendlyType(type) {
    if (!type) return '';
    if (type.startsWith('trigger.')) return type.slice(8) + ' trigger';
    return type.replace(/_/g, ' ');
}
function NodeStatusDot({ status }) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: runStatusColor(status), display: 'inline-block' }} />;
}
function RunHistoryPanel({ runs, nodes: wfNodes = [], width = 300, mobile = false, onResizeStart, onClearHistory, onClose }) {
    const [openRunId, setOpenRunId] = useState(null);
    const [detail, setDetail] = useState(null);

    const toggleRun = useCallback(async (runId) => {
        if (openRunId === runId) { setOpenRunId(null); setDetail(null); return; }
        setOpenRunId(runId);
        setDetail(null);
        try {
            const res = await fetch(`/api/automations/runs/${runId}`, { credentials: 'include' });
            setDetail(res.ok ? await res.json() : null);
        } catch (_) { setDetail(null); }
    }, [openRunId]);

    return (
        <div style={mobile
            ? { position: 'fixed', inset: 0, zIndex: 60, width: '100%', overflowY: 'auto', padding: 12, background: 'var(--surface)' }
            : { position: 'relative', width, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            {!mobile && onResizeStart && <ResizeHandle onResizeStart={onResizeStart} />}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 14 }}>Run history</span>
                <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', display: 'flex' }} title="Close"><CloseIcon size={15} /></button>
            </div>
            {runs.length > 0 && onClearHistory && (
                <button className="auto-btn auto-btn--block auto-btn--danger auto-btn--sm" onClick={onClearHistory} style={{ marginBottom: 10 }}>
                    Clear history
                </button>
            )}
            {runs.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>No runs yet — hit Run to create one.</div>}
            {runs.map(r => {
                const isOpen = openRunId === r.id;
                const rec = isOpen ? detail : null;
                return (
                    <div key={r.id} style={{ marginBottom: 3 }}>
                        <div onClick={() => toggleRun(r.id)}
                            style={{ padding: '7px 8px', borderRadius: 7, cursor: 'pointer', border: '1px solid var(--rule-2)', background: isOpen ? 'var(--accent-soft)' : 'transparent' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: runStatusColor(r.status) }} />
                                <span style={{ fontSize: 12, color: 'var(--ink-2)', textTransform: 'capitalize' }}>{r.status}</span>
                                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-3)' }}>{r.trigger}</span>
                            </div>
                            <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2 }}>
                                {fmtRunTime(r.startedAt)}{r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ''}
                            </div>
                        </div>
                        {isOpen && (
                            <div style={{ margin: '4px 0 6px 0', borderLeft: '2px solid var(--rule)', paddingLeft: 8 }}>
                                {!rec && <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Loading…</div>}
                                {rec && (
                                    <>
                                        <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginBottom: 6 }}>
                                            <span style={{ color: runStatusColor(rec.status), textTransform: 'capitalize' }}>{rec.status}</span>
                                            {rec.durationMs != null ? ` · ${(rec.durationMs / 1000).toFixed(1)}s` : ''}
                                        </div>
                                        {rec.error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 10.5, marginBottom: 6 }}>{rec.error}</div>}
                                        {(rec.nodes || []).map((n, i) => {
                                            // Friendly label: prefer the workflow node's data.label,
                                            // fall back to the engine type, then nodeId. Surface any
                                            // generated files as download chips. Output renders as a
                                            // smart one-line summary with a "view raw" disclosure.
                                            const wfNode = wfNodes.find(x => x.id === n.nodeId);
                                            const label = (wfNode && wfNode.data && (wfNode.data.label || wfNode.data.tool)) || nodeFriendlyType(n.type) || n.nodeId;
                                            const arts = (n.output && typeof n.output === 'object' && Array.isArray(n.output._artifacts))
                                                ? n.output._artifacts.filter(a => a && a.url && a.name) : [];
                                            const summary = n.status === 'skipped' ? 'Skipped' : summarizeNodeOutput(n.output);
                                            const isLast = i === rec.nodes.length - 1;
                                            return (
                                                <div key={i}>
                                                    <div style={{ border: '1px solid var(--rule-2)', borderRadius: 8, background: 'var(--bg)', padding: '7px 9px' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                            <NodeStatusDot status={n.status} />
                                                            <span style={{ color: 'var(--ink)', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                                                            <span style={{ color: 'var(--ink-3)', fontSize: 9.5, marginLeft: 'auto', textTransform: 'uppercase', letterSpacing: '.3px' }}>{n.status}</span>
                                                        </div>
                                                        {n.error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 11, marginTop: 4 }}>{n.error}</div>}
                                                        {summary && !n.error && (
                                                            <div style={{ color: 'var(--ink-2)', fontSize: 11, marginTop: 4, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{summary}</div>
                                                        )}
                                                        {arts.length > 0 && (
                                                            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                                                {arts.map((a, j) => {
                                                                    const dlUrl = withDownloadFlag(a.url);
                                                                    return (
                                                                        <a key={j} href={dlUrl} download={a.name} target="_blank" rel="noopener noreferrer"
                                                                           onClick={(e) => { e.preventDefault(); saveArtifactViaBlob(dlUrl, a.name).catch(() => { window.location.href = dlUrl; }); }}
                                                                           style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--accent)', textDecoration: 'none', border: '1px solid var(--accent)', borderRadius: 5, padding: '2px 7px', background: 'var(--accent-soft)' }}>
                                                                            <Download size={10} /> {a.name}
                                                                        </a>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                        {n.output != null && (
                                                            <details style={{ marginTop: 5 }}>
                                                                <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--ink-3)', userSelect: 'none' }}>view raw</summary>
                                                                <pre style={{ margin: '4px 0 0 0', fontSize: 10, color: 'var(--ink-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--rule-2)', borderRadius: 4, padding: 5 }}>
                                                                    {typeof n.output === 'string' ? n.output : JSON.stringify(n.output, null, 2)}
                                                                </pre>
                                                            </details>
                                                        )}
                                                    </div>
                                                    {!isLast && (
                                                        <div style={{ textAlign: 'center', color: 'var(--ink-3)', fontSize: 12, lineHeight: '14px', padding: '2px 0' }}>↓</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ============================================================ *
 * Console screens (design's icon side-rail + Dashboard / Runs /
 * Library). The Builder screen is the existing 3-pane editor.
 * ============================================================ */

// Node kind → category color suffix (mirrors AutomationNode.colorCat).
function consoleCat(kind) {
    if (!kind) return 'cyan';
    if (kind.startsWith('trigger.')) return 'amber';
    if (kind === 'model') return 'mint';
    if (kind.startsWith('gate.') || kind === 'merge' || kind === 'map') return 'violet';
    if (kind === 'output' || kind === 'slack' || kind === 'telegram' || kind === 'telegram_get') return 'coral';
    return 'cyan';
}
function nodeKindOf(n) { return (n && (n.kind || (n.data && n.data.kind) || n.type)) || ''; }

const CONSOLE_RAIL = [
    { id: 'dashboard', label: 'Dashboard', Icon: LayoutGrid },
    { id: 'builder', label: 'Builder', Icon: Workflow },
    { id: 'runs', label: 'Runs', Icon: ListChecks },
    { id: 'library', label: 'Library', Icon: Boxes },
];

function AutoIconRail({ screen, setScreen }) {
    return (
        <nav className="auto-iconrail">
            <div className="auto-iconrail__brand" title="Automations">A</div>
            {CONSOLE_RAIL.map(r => (
                <button key={r.id} type="button"
                    className={`auto-iconrail__btn${screen === r.id ? ' is-active' : ''}`}
                    title={r.label} aria-label={r.label}
                    onClick={() => setScreen(r.id)}>
                    <r.Icon size={18} strokeWidth={1.8} />
                </button>
            ))}
            <div className="auto-iconrail__sp" />
        </nav>
    );
}

// Small chain of category chips summarizing a flow's nodes (design flow card).
function FlowChain({ nodes }) {
    const list = Array.isArray(nodes) ? nodes : [];
    const shown = list.slice(0, 4);
    return (
        <div className="auto-chain">
            {shown.map((n, i) => (
                <React.Fragment key={i}>
                    {i > 0 && <span className="auto-chain__dash" />}
                    <span className={`auto-chain__chip cc-${consoleCat(nodeKindOf(n))}`} />
                </React.Fragment>
            ))}
            {list.length > shown.length && <span className="auto-chain__more">+{list.length - shown.length}</span>}
        </div>
    );
}

function DashboardScreen({ automations = [], onOpen, onNew, onRuns }) {
    const total = automations.length;
    const active = automations.filter(a => a.enabled && !a.archived).length;
    const paused = automations.filter(a => !a.enabled && !a.archived).length;
    const archived = automations.filter(a => a.archived).length;
    const live = automations.filter(a => !a.archived);
    return (
        <div className="auto-screen">
            <div className="auto-phead">
                <div>
                    <div className="auto-ptitle">Automations</div>
                    <div className="auto-psub">{total} workflow{total === 1 ? '' : 's'} in your workspace</div>
                </div>
                <button className="auto-btn auto-btn--accent" onClick={onNew}><Plus size={15} /> <span>New automation</span></button>
            </div>
            <div className="auto-stats">
                <div className="auto-stat"><div className="auto-stat__lab">Active flows</div><div className="auto-stat__num">{active}</div></div>
                <div className="auto-stat"><div className="auto-stat__lab">Paused</div><div className="auto-stat__num">{paused}</div></div>
                <div className="auto-stat"><div className="auto-stat__lab">Archived</div><div className="auto-stat__num">{archived}</div></div>
                <div className="auto-stat auto-stat--link" onClick={onRuns} role="button"><div className="auto-stat__lab">Run history</div><div className="auto-stat__num">View →</div></div>
            </div>
            <div className="auto-sechd"><div className="auto-sectt">Your flows</div></div>
            {live.length === 0 ? (
                <div className="auto-empty">No automations yet. Create one to get started.</div>
            ) : (
                <div className="auto-cardgrid">
                    {live.map(a => {
                        const nodeCount = Array.isArray(a.nodes) ? a.nodes.length : (a.nodeCount || 0);
                        const status = a.archived ? 'archived' : a.enabled ? 'active' : 'paused';
                        const pillCls = status === 'active' ? 'ok' : 'warn';
                        return (
                            <div key={a.id} className="auto-acard" onClick={() => onOpen(a)}>
                                <div className="auto-acard__top">
                                    <div>
                                        <div className="auto-acard__nm">{a.name || 'Untitled'}</div>
                                        <div className="auto-acard__des">{nodeCount} node{nodeCount === 1 ? '' : 's'}</div>
                                    </div>
                                    <span className={`auto-pill ${pillCls}`}>{status}</span>
                                </div>
                                <FlowChain nodes={a.nodes} />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const RUN_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'success', label: 'Success' },
    { id: 'running', label: 'Running' },
    { id: 'failed', label: 'Failed' },
];
function runMatchesFilter(status, f) {
    if (f === 'all') return true;
    const s = String(status || '').toLowerCase();
    if (f === 'success') return s === 'success' || s === 'completed' || s === 'ok';
    if (f === 'running') return s === 'running' || s === 'active';
    if (f === 'failed') return s === 'failed' || s === 'error';
    return true;
}

function RunsScreen({ automations = [], onOpenBuilder, confirm, notify }) {
    const [runs, setRuns] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const [active, setActive] = useState(null);
    const [detail, setDetail] = useState(null);
    const [clearing, setClearing] = useState(false);

    const loadAll = useCallback(async () => {
        setLoading(true);
        const all = [];
        await Promise.all((automations || []).map(async a => {
            try {
                const r = await fetch(`/api/automations/${a.id}/runs?limit=25`, { credentials: 'include' });
                if (!r.ok) return;
                const list = await r.json();
                (Array.isArray(list) ? list : []).forEach(run => all.push({ ...run, _flow: a.name, _flowId: a.id }));
            } catch (_) { /* skip */ }
        }));
        all.sort((x, y) => new Date(y.startedAt || 0).getTime() - new Date(x.startedAt || 0).getTime());
        setRuns(all.slice(0, 80));
        setLoading(false);
    }, [automations]);

    useEffect(() => { loadAll(); }, [loadAll]);

    const openRun = useCallback(async (run) => {
        setActive(run);
        setDetail(null);
        try {
            const r = await fetch(`/api/automations/runs/${run.id}`, { credentials: 'include' });
            setDetail(r.ok ? await r.json() : null);
        } catch (_) { setDetail(null); }
    }, []);

    // Clear history for every automation that has runs, then reload.
    const clearAll = useCallback(async () => {
        const flowIds = Array.from(new Set(runs.map(r => r._flowId)));
        if (!flowIds.length) return;
        const ok = confirm
            ? await confirm({ title: 'Clear run history', message: `Clear all run history across ${flowIds.length} automation${flowIds.length === 1 ? '' : 's'}? This cannot be undone.`, confirmLabel: 'Clear', danger: true })
            : window.confirm('Clear all run history? This cannot be undone.');
        if (!ok) return;
        setClearing(true);
        await Promise.all(flowIds.map(id => fetch(`/api/automations/${id}/runs`, { method: 'DELETE', credentials: 'include' }).catch(() => {})));
        setActive(null); setDetail(null);
        await loadAll();
        setClearing(false);
        if (notify) notify('Run history cleared');
    }, [runs, confirm, notify, loadAll]);

    const filtered = runs.filter(r => runMatchesFilter(r.status, filter));
    const wfNodes = (active && automations.find(a => a.id === active._flowId)?.nodes) || [];

    return (
        <div className="auto-screen">
            <div className="auto-phead">
                <div>
                    <div className="auto-ptitle">Run history</div>
                    <div className="auto-psub">Executions across all automations</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="auto-btn auto-btn--ghost" onClick={loadAll}><RotateCcw size={14} /> <span>Refresh</span></button>
                    <button className="auto-btn auto-btn--danger" onClick={clearAll} disabled={clearing || runs.length === 0}>
                        <Trash2 size={14} /> <span>{clearing ? 'Clearing…' : 'Clear history'}</span>
                    </button>
                </div>
            </div>
            <div className="auto-filters">
                {RUN_FILTERS.map(f => (
                    <span key={f.id} className={`auto-fchip${filter === f.id ? ' is-on' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</span>
                ))}
            </div>
            <div className="auto-runlist">
                <div className="auto-tbl">
                    <div className="auto-trow auto-trow--head"><div>Status</div><div>Flow / trigger</div><div>Started</div><div>Run ID</div><div>Duration</div></div>
                    {loading && <div className="auto-tempty">Loading runs…</div>}
                    {!loading && filtered.length === 0 && <div className="auto-tempty">No runs match this filter.</div>}
                    {filtered.map(r => (
                        <div key={r.id} className={`auto-trow${active && active.id === r.id ? ' is-act' : ''}`} onClick={() => openRun(r)}>
                            <div className="auto-tst"><span className="auto-tdot" style={{ background: runStatusColor(r.status) }} /><span style={{ textTransform: 'capitalize' }}>{r.status}</span></div>
                            <div className="auto-tflow"><span className="auto-tflow__nm">{r._flow || 'Flow'}</span><span className="auto-tflow__tg">{r.trigger}</span></div>
                            <div className="auto-tmut">{fmtRunTime(r.startedAt)}</div>
                            <div className="auto-tid">{String(r.id).slice(0, 10)}</div>
                            <div className="auto-tmut">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</div>
                        </div>
                    ))}
                </div>
            </div>
            {active && (
                <div className="cf-modal-backdrop" onMouseDown={() => { setActive(null); setDetail(null); }}>
                    <div className="auto-runmodal" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="auto-runmodal__head">
                            <div className="auto-detid">{String(active.id).slice(0, 12)}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {onOpenBuilder && <button className="auto-linkbtn" onClick={() => onOpenBuilder(automations.find(a => a.id === active._flowId))}>Open in builder →</button>}
                                <span className="auto-pill" style={{ color: runStatusColor(active.status), borderColor: 'transparent', background: 'transparent', textTransform: 'capitalize' }}>{active.status}</span>
                                <button className="ai-modal__close" onClick={() => { setActive(null); setDetail(null); }} title="Close"><CloseIcon size={16} /></button>
                            </div>
                        </div>
                        <div className="auto-runmodal__body">
                            <div className="auto-detmeta">
                                <div><div className="auto-detk">Flow</div><div className="auto-detv">{active._flow}</div></div>
                                <div><div className="auto-detk">Trigger</div><div className="auto-detv">{active.trigger}</div></div>
                                <div><div className="auto-detk">Duration</div><div className="auto-detv">{active.durationMs != null ? `${(active.durationMs / 1000).toFixed(1)}s` : '—'}</div></div>
                                <div><div className="auto-detk">Started</div><div className="auto-detv">{fmtRunTime(active.startedAt)}</div></div>
                            </div>
                            {detail && detail.error && <div className="auto-deterr">{detail.error}</div>}
                            {!detail && <div className="auto-tempty">Loading steps…</div>}
                            {detail && (
                                <div className="auto-steps">
                                    {(detail.nodes || []).map((n, i) => {
                                        const wf = (wfNodes || []).find(x => x.id === n.nodeId);
                                        const label = (wf && wf.data && (wf.data.label || wf.data.tool)) || nodeFriendlyType(n.type) || n.nodeId;
                                        const summary = n.status === 'skipped' ? 'Skipped' : summarizeNodeOutput(n.output);
                                        const arts = (n.output && typeof n.output === 'object' && Array.isArray(n.output._artifacts))
                                            ? n.output._artifacts.filter(a => a && a.url && a.name) : [];
                                        const last = i === detail.nodes.length - 1;
                                        return (
                                            <div key={i} className="auto-step">
                                                {!last && <div className="auto-step__ln" />}
                                                <span className="auto-step__sd"><NodeStatusDot status={n.status} /></span>
                                                <div className="auto-step__bd">
                                                    <div className="auto-step__nm">{label}<span className={`auto-step__tag s-${String(n.status || '').toLowerCase()}`}>{n.status}</span></div>
                                                    {n.error
                                                        ? <div className="auto-step__err">{n.error}</div>
                                                        : summary && <div className="auto-step__sum">{summary}</div>}
                                                    {arts.length > 0 && (
                                                        <div className="auto-step__arts">
                                                            {arts.map((a, j) => {
                                                                const dlUrl = withDownloadFlag(a.url);
                                                                return (
                                                                    <a key={j} href={dlUrl} download={a.name} target="_blank" rel="noopener noreferrer"
                                                                        onClick={(e) => { e.preventDefault(); saveArtifactViaBlob(dlUrl, a.name).catch(() => { window.location.href = dlUrl; }); }}
                                                                        className="auto-step__art"><Download size={11} /> {a.name}</a>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function customAsPaletteItem(nt) {
    return { key: nt.id, kind: nt.baseType || 'tool', label: nt.name, category: nt.category, defaults: nt.defaults || {}, custom: true, description: nt.description || '' };
}

function LibraryScreen({ groupedPalette = {}, categoryOrder = [], categoryLabel = {}, automations = [], notify, confirm, onPaletteChanged, onAddToFlow }) {
    const [q, setQ] = useState('');
    const [pending, setPending] = useState(null); // node item awaiting an automation choice
    const [customTypes, setCustomTypes] = useState([]);
    const [builder, setBuilder] = useState(null); // { base? } when open
    const query = q.trim().toLowerCase();
    const match = (it) => !query || (`${it.label} ${it.description || ''}`).toLowerCase().includes(query);
    const live = automations.filter(a => !a.archived);

    const loadCustom = useCallback(async () => {
        try { const r = await fetch('/api/node-types', { credentials: 'include' }); const d = r.ok ? await r.json() : []; setCustomTypes(Array.isArray(d) ? d : []); }
        catch (_) { setCustomTypes([]); }
    }, []);
    useEffect(() => { loadCustom(); }, [loadCustom]);

    const onSaved = async () => { setBuilder(null); await loadCustom(); if (onPaletteChanged) await onPaletteChanged(); notify && notify('Custom block saved'); };
    const removeType = async (nt) => {
        const ok = confirm ? await confirm({ title: 'Delete block', message: `Delete the custom block “${nt.name}”? Flows already using it keep working.`, confirmLabel: 'Delete', danger: true }) : window.confirm('Delete this block?');
        if (!ok) return;
        try {
            const r = await fetch(`/api/node-types/${nt.id}`, { method: 'DELETE', credentials: 'include' });
            if (!r.ok) throw new Error('Failed');
            await loadCustom(); if (onPaletteChanged) await onPaletteChanged(); notify && notify('Block deleted');
        } catch (_) { notify && notify('Failed to delete block', 'error'); }
    };

    const choose = (item) => {
        if (live.length === 0) { onAddToFlow(item, null); return; }
        if (live.length === 1) { onAddToFlow(item, live[0].id); return; }
        setPending(item);
    };
    const myCustom = customTypes.filter(c => match({ label: c.name, description: c.description }));

    return (
        <div className="auto-screen">
            <div className="auto-phead">
                <div>
                    <div className="auto-ptitle">Node library</div>
                    <div className="auto-psub">Building blocks for your automations</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="auto-libsearch"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes…" /></div>
                    <button className="auto-btn auto-btn--accent" onClick={() => setBuilder({})}><Blocks size={14} /> <span>Manage Node</span></button>
                </div>
            </div>
            <div className="auto-libpage">
                {myCustom.length > 0 && (
                    <>
                        <div className="auto-libsection"><span className="auto-libsection__t">Custom blocks</span><span className="auto-libsection__c">{myCustom.length}</span><span className="auto-libsection__hr" /></div>
                        {myCustom.map(nt => (
                            <div key={nt.id} className="auto-ncard auto-ncard--custom">
                                <span className={`auto-ncard__cat cc-${consoleCat(nt.baseType)}`} />
                                <div className="auto-ncard__nm">{nt.name}{nt._ownerName ? <span className="auto-ncard__owner">{nt._ownerName}</span> : null}</div>
                                {nt.description && <div className="auto-ncard__des">{nt.description}</div>}
                                <div className="auto-ncard__actions">
                                    <button onClick={() => choose(customAsPaletteItem(nt))}><Plus size={12} /> Add</button>
                                    <button onClick={() => setBuilder({ base: nt })}><Wand2 size={12} /> Edit</button>
                                    <button className="is-danger" onClick={() => removeType(nt)}><Trash2 size={12} /></button>
                                </div>
                            </div>
                        ))}
                    </>
                )}
                {categoryOrder.map(cat => {
                    const items = (groupedPalette[cat] || []).filter(match);
                    if (!items.length) return null;
                    return (
                        <React.Fragment key={cat}>
                            <div className="auto-libsection"><span className="auto-libsection__t">{categoryLabel[cat] || cat}</span><span className="auto-libsection__c">{items.length}</span><span className="auto-libsection__hr" /></div>
                            {items.map(item => (
                                <div key={item.key} className="auto-ncard" onClick={() => choose(item)}>
                                    <span className={`auto-ncard__cat cc-${consoleCat(item.kind)}`} />
                                    <div className="auto-ncard__nm">{item.label}</div>
                                    {item.description && <div className="auto-ncard__des">{item.description}</div>}
                                    <div className="auto-ncard__add"><Plus size={13} /> Add to flow</div>
                                </div>
                            ))}
                        </React.Fragment>
                    );
                })}
            </div>
            {pending && (
                <div className="cf-modal-backdrop" onMouseDown={() => setPending(null)}>
                    <div className="auto-pickflow" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="auto-pickflow__head">Add “{pending.label}” to…</div>
                        <div className="auto-pickflow__list">
                            {live.map(a => (
                                <button key={a.id} className="auto-pickflow__item" onClick={() => { onAddToFlow(pending, a.id); setPending(null); }}>
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: a.enabled !== false ? 'var(--cat-mint)' : 'var(--ink-4)' }} />
                                    <span className="auto-pickflow__nm">{a.name || 'Untitled'}</span>
                                    <span className="auto-pickflow__meta">{Array.isArray(a.nodes) ? a.nodes.length : 0} nodes</span>
                                </button>
                            ))}
                        </div>
                        <button className="auto-pickflow__new" onClick={() => { onAddToFlow(pending, null); setPending(null); }}>
                            <Plus size={14} /> New automation
                        </button>
                    </div>
                </div>
            )}
            {builder && <NodeBuilderModal base={builder.base} onClose={() => setBuilder(null)} onSaved={onSaved} notify={notify} />}
        </div>
    );
}

// LLM-assisted node-type authoring: describe a block (or a change to an existing
// one) → the loaded model drafts a node-type → preview → save. POST /build drafts;
// POST/PUT /api/node-types persists.
function NodeBuilderModal({ base, onClose, onSaved, notify }) {
    const isEdit = !!base;
    const [prompt, setPrompt] = useState('');
    const [building, setBuilding] = useState(false);
    const [preview, setPreview] = useState(isEdit ? base : null);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    const build = async () => {
        if (!prompt.trim()) return;
        setBuilding(true); setErr('');
        try {
            const r = await fetch('/api/node-types/build', {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt.trim(), base: isEdit ? base : undefined }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'The model could not build that — try rephrasing.');
            setPreview(p => ({ ...(isEdit ? base : {}), ...d.nodeType }));
        } catch (e) { setErr(e.message); }
        finally { setBuilding(false); }
    };

    const save = async () => {
        if (!preview || !preview.name) { setErr('Nothing to save yet — build a block first.'); return; }
        setSaving(true); setErr('');
        const body = { name: preview.name, category: preview.category, description: preview.description, baseType: preview.baseType, defaults: preview.defaults || {}, fields: preview.fields || [], condition: preview.condition ?? null };
        try {
            const r = await fetch(isEdit ? `/api/node-types/${base.id}` : '/api/node-types', {
                method: isEdit ? 'PUT' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to save');
            onSaved();
        } catch (e) { setErr(e.message); setSaving(false); }
    };

    const defaultsEntries = preview && preview.defaults ? Object.entries(preview.defaults) : [];
    return (
        <div className="cf-modal-backdrop" onMouseDown={onClose}>
            <div className="auto-nbmodal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="auto-nbmodal__head">
                    <span className="auto-nbmodal__title">{isEdit ? `Edit “${base.name}”` : 'Build a node'}</span>
                    <button className="ai-modal__close" onClick={onClose} title="Close"><CloseIcon size={16} /></button>
                </div>
                <div className="auto-nbmodal__body">
                    <label className="ai-modal__label">{isEdit ? 'Describe the change' : 'Describe the block you want'}</label>
                    <textarea className="ai-modal__composer" style={{ minHeight: 96 }} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                        placeholder={isEdit ? 'e.g. also pre-fill the channel to #alerts and keep only the message field editable' : 'e.g. a connector that posts a message to my Slack #alerts channel'} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="auto-btn auto-btn--accent" onClick={build} disabled={building || !prompt.trim()}>
                            <Sparkles size={13} /> <span>{building ? 'Building…' : (preview && !isEdit ? 'Rebuild' : 'Build with AI')}</span>
                        </button>
                    </div>
                    {err && <div className="auto-deterr" style={{ marginTop: 10 }}>{err}</div>}
                    {preview && preview.name && (
                        <div className="auto-nbprev">
                            <div className="auto-nbprev__top">
                                <input className="auto-nbprev__name" value={preview.name} onChange={(e) => setPreview(p => ({ ...p, name: e.target.value }))} />
                                <span className={`auto-pill cc-${consoleCat(preview.baseType)}`} style={{ background: 'transparent', color: `var(--cat-${consoleCat(preview.baseType)})` }}>{preview.category}</span>
                            </div>
                            <div className="auto-nbprev__base">specializes <code>{preview.baseType}</code></div>
                            <textarea className="auto-nbprev__desc" value={preview.description || ''} onChange={(e) => setPreview(p => ({ ...p, description: e.target.value }))} placeholder="Description" />
                            {defaultsEntries.length > 0 && (
                                <div className="auto-nbprev__sec"><div className="auto-nbprev__lbl">Pre-filled</div>
                                    {defaultsEntries.map(([k, v]) => <div key={k} className="auto-nbprev__kv"><code>{k}</code><span>{String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 90)}</span></div>)}
                                </div>
                            )}
                            {(preview.fields || []).length > 0 && (
                                <div className="auto-nbprev__sec"><div className="auto-nbprev__lbl">Editable fields</div><div className="auto-nbprev__fields">{preview.fields.join(' · ')}</div></div>
                            )}
                        </div>
                    )}
                </div>
                <div className="auto-nbmodal__foot">
                    <button className="auto-btn" onClick={onClose}>Cancel</button>
                    <button className="auto-btn auto-btn--accent" onClick={save} disabled={!preview || !preview.name || saving}>{saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Save block')}</button>
                </div>
            </div>
        </div>
    );
}

// Searchable "+" popup shown when the canvas is clicked — pick a node to drop
// at that position. Fixed-positioned at the click point, clamped to viewport.
function NodePicker({ x, y, items = [], onPick, onClose }) {
    const [q, setQ] = useState('');
    const inputRef = useRef(null);
    useEffect(() => {
        const t = setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 0);
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
    }, [onClose]);
    const query = q.trim().toLowerCase();
    const filtered = items.filter(it => !query || (`${it.label} ${it.description || ''}`).toLowerCase().includes(query));
    const left = Math.max(8, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 268));
    const top = Math.max(8, Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 372));
    return (
        <>
            <div className="auto-addmenu-backdrop" onMouseDown={onClose} />
            <div className="auto-addmenu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
                <div className="auto-addmenu__search">
                    <Plus size={13} />
                    <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a node…" />
                </div>
                <div className="auto-addmenu__list">
                    {filtered.length === 0 && <div className="auto-addmenu__empty">No nodes match.</div>}
                    {filtered.slice(0, 50).map(it => (
                        <button key={it.key} className="auto-addmenu__item" onClick={() => onPick(it)} title={it.description || it.label}>
                            <span className={`auto-addmenu__dot cc-${consoleCat(it.kind)}`} />
                            <span className="auto-addmenu__lbl">{it.label}</span>
                        </button>
                    ))}
                </div>
            </div>
        </>
    );
}

export default function AutomationView({ showSnackbar, models }) {
    return (
        <ReactFlowProvider>
            <FlowEditor showSnackbar={showSnackbar} models={models} />
        </ReactFlowProvider>
    );
}
