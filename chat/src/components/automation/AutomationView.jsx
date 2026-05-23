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
    Power, PowerOff, Copy, Check, ChevronDown, ChevronRight, History as HistoryIcon, X as CloseIcon, Sparkles, Download, Braces,
} from 'lucide-react';
import { useChatStore } from '../../stores/useChatStore';
import { useConfirm } from '../ConfirmDialog';
import AutomationNode, { iconFor, NodeDropContext } from './AutomationNode';

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
    parse_json: 'tools', export_file: 'tools', http_request: 'tools', crawl: 'tools',
    sqlite: 'tools', render_chart: 'tools', create_pdf: 'tools', html_to_pdf: 'tools', create_file: 'tools',
    run_python: 'tools', db_store: 'tools', db_query: 'tools', tool: 'tools',
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
// Node keys hidden from the chat palette (display-only; engine still supports them).
const PALETTE_HIDDEN = new Set(['output']);
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
    const [showHistory, setShowHistory] = useState(false);
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
    const animTokenRef = useRef(0);
    const animTimersRef = useRef([]);
    useEffect(() => { try { localStorage.setItem('automationPanelWidth', String(panelWidth)); } catch (_) {} }, [panelWidth]);
    const [leftWidth, setLeftWidth] = useState(() => {
        const v = Number(localStorage.getItem('automationLeftWidth'));
        return v >= 190 && v <= 520 ? v : 230;
    });
    useEffect(() => { try { localStorage.setItem('automationLeftWidth', String(leftWidth)); } catch (_) {} }, [leftWidth]);
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

    useEffect(() => {
        (async () => {
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
            await Promise.all([loadAutomations(), loadChips()]);
        })();
    }, [loadAutomations, loadChips]);

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
            addCountRef.current = n.length;
            if (animate === 'build' && n.length && animFnsRef.current.animateConstruction) {
                animFnsRef.current.animateConstruction(n, e);
            } else {
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
            selectAutomation(wf.id);
        } catch (err) { notify(err.message, 'error'); }
    }, [loadAutomations, selectAutomation]);

    // Close the open automation and return to the list view (clears the canvas
    // and any open Build/Edit boxes). Gives a clear way back to the automations
    // list from inside the editor.
    const backToList = useCallback(() => {
        if (animFnsRef.current.cancelAnim) animFnsRef.current.cancelAnim();
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
        setEditOpen(false);
        setEditResult(null);
        setEditPrompt('');
    }, [setNodes, setEdges]);

    // Build with LLM — describe an automation in plain language, the model assembles it.
    const [buildOpen, setBuildOpen] = useState(false);
    const [buildPrompt, setBuildPrompt] = useState('');
    const [building, setBuilding] = useState(false);
    const [buildTest, setBuildTest] = useState(false);
    const [buildLog, setBuildLog] = useState(null);
    const buildAutomation = useCallback(async () => {
        const p = buildPrompt.trim();
        if (!p || building) return;
        setBuilding(true);
        setBuildLog(null);
        try {
            const res = await fetch('/api/automations/build', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, test: buildTest }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to build automation');
            await loadAutomations();
            selectAutomation(data.id, { animate: 'build' });
            setBuildPrompt('');
            const log = Array.isArray(data.buildLog) ? data.buildLog : null;
            setBuildLog(log);
            // Keep the box open to show the build log; otherwise close it.
            if (!log) setBuildOpen(false);
            notify('Built with LLM — review and tweak the steps before running', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBuilding(false); }
    }, [buildPrompt, building, buildTest, loadAutomations, selectAutomation]);

    // Edit with LLM — describe a change to the OPEN automation; preview the diff, then apply.
    const [editOpen, setEditOpen] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');
    const [editing, setEditing] = useState(false);
    const [editResult, setEditResult] = useState(null); // { proposed, diff, buildLog? }
    const [editTest, setEditTest] = useState(false);
    useEffect(() => { setEditOpen(false); setEditResult(null); setEditPrompt(''); }, [selected && selected.id]);
    const previewEdit = useCallback(async () => {
        const p = editPrompt.trim();
        if (!p || editing || !selected) return;
        setEditing(true);
        try {
            const res = await fetch(`/api/automations/${selected.id}/edit`, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: p, test: editTest }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to edit automation');
            setEditResult(data);
        } catch (err) { notify(err.message, 'error'); }
        finally { setEditing(false); }
    }, [editPrompt, editing, editTest, selected]);
    const applyEdit = useCallback(async () => {
        if (!editResult || !selected) return;
        setEditing(true);
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
            setEditResult(null); setEditPrompt(''); setEditOpen(false);
            notify('Changes applied', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setEditing(false); }
    }, [editResult, selected, nodes, edges, labelFor, loadAutomations, setNodes, setEdges, seedNodeOutputs]);

    // ---- graph edits ----
    const onConnect = useCallback((params) => {
        setEdges(eds => addEdge({ ...params, id: uid('e') }, eds));
        setDirty(true);
    }, [setEdges]);

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

    // A data chip dropped onto a node on the canvas: drop the ref into the node's
    // primary slot (append if it already has content) and auto-wire an edge from
    // the source node so the data actually reaches it.
    const handleDropChip = useCallback((nodeId, ref) => {
        setNodes(ns => ns.map(n => {
            if (n.id !== nodeId) return n;
            const kind = n.data.kind;
            const slot = kind === 'tool' ? (TOOL_PRIMARY_SLOT[n.data.tool] || null) : PRIMARY_SLOT[kind];
            if (!slot) return n;
            const cur = getAt(n.data, slot);
            const val = (cur == null || cur === '') ? ref : `${cur} ${ref}`;
            return { ...n, data: { ...n.data, ...patchFor(n.data, slot, val) } };
        }));
        const m = /\{\{\s*nodes\.([^.}\s]+)/.exec(ref);
        const src = m && m[1];
        if (src && src !== nodeId) {
            setEdges(es => es.some(e => e.source === src && e.target === nodeId) ? es : addEdge({ source: src, target: nodeId, id: uid('e') }, es));
        }
        setDirty(true);
    }, [setNodes, setEdges]);

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
    const animateConstruction = useCallback((rfNodes, rfEdges, { accentIds } = {}) => {
        cancelAnim();
        const token = animTokenRef.current;
        const STAGGER = 170;     // per-node reveal cadence (140–220ms feel)
        const EDGE_SETTLE = 520; // glow → settled

        if (prefersReducedMotion() || !rfNodes.length) {
            setNodes(rfNodes);
            setEdges(rfEdges);
            setAssembling(false);
            try { requestAnimationFrame(() => fitView({ duration: 200, padding: 0.2 })); } catch (_) {}
            return;
        }

        setAssembling(true);
        const waves = topoWaves(rfNodes, rfEdges);
        const revealOrder = waves.flat();
        const revealAt = new Map();
        revealOrder.forEach((id, i) => revealAt.set(id, i));
        const accent = accentIds instanceof Set ? accentIds : null;

        // Start with every node staged-but-invisible (is-hidden) and every edge
        // pending (path opacity 0); flipping anim→appear/pulse kicks the keyframe.
        const hidden = rfNodes.map(n => ({ ...n, data: { ...n.data, anim: 'hidden', status: undefined } }));
        setNodes(hidden);
        setEdges(rfEdges.map(e => ({ ...e, className: 'is-pending', animated: false })));

        revealOrder.forEach((id, idx) => {
            animLater(token, idx * STAGGER, () => {
                const animKind = accent && accent.has(id) ? 'pulse' : 'appear';
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
            try { fitView({ duration: 260, padding: 0.2 }); } catch (_) {}
        });
    }, [cancelAnim, animLater, setNodes, setEdges, fitView]);

    // Diff-aware replay for Edit→Apply: removed nodes fade out first, then the
    // new graph is revealed with changed nodes pulsing accent and added nodes
    // fading in (animateConstruction handles the reveal; we pass changed ids as
    // the accent set). `base` = the pre-apply RF nodes/edges (for the fade-out).
    const animateDiff = useCallback((baseNodes, baseEdges, nextNodes, nextEdges, diff) => {
        cancelAnim();
        if (prefersReducedMotion()) {
            setNodes(nextNodes); setEdges(nextEdges); setAssembling(false);
            try { requestAnimationFrame(() => fitView({ duration: 200, padding: 0.2 })); } catch (_) {}
            return;
        }
        const removedIds = new Set((diff && diff.removedNodes || []).map(n => n.id));
        const changedIds = new Set((diff && diff.changedNodes || []).map(n => n.id));
        const FADE = 460;
        if (removedIds.size) {
            setAssembling(true);
            const token = ++animTokenRef.current; // claim a token for the fade phase
            // Show the OLD graph, flag removed nodes with the remove keyframe.
            setNodes(baseNodes.map(n => removedIds.has(n.id) ? { ...n, data: { ...n.data, anim: 'remove' } } : { ...n, data: { ...n.data, anim: null } }));
            setEdges(baseEdges.map(e => (removedIds.has(e.source) || removedIds.has(e.target)) ? { ...e, className: 'is-removing-edge', animated: false } : e));
            animLater(token, FADE, () => animateConstruction(nextNodes, nextEdges, { accentIds: changedIds }));
        } else {
            animateConstruction(nextNodes, nextEdges, { accentIds: changedIds });
        }
    }, [cancelAnim, animLater, animateConstruction, setNodes, setEdges, fitView]);

    // Keep the ref current so selectAutomation (declared earlier) can reach the
    // replay helpers at call time.
    useEffect(() => { animFnsRef.current = { animateConstruction, animateDiff, cancelAnim }; }, [animateConstruction, animateDiff, cancelAnim]);
    // Cancel any in-flight replay on unmount.
    useEffect(() => () => cancelAnim(), [cancelAnim]);

    // ---- run (SSE) + animation ----
    const resetRunVisuals = useCallback(() => {
        cancelAnim(); // a run supersedes any in-flight construction replay
        setAssembling(false);
        setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, status: undefined, anim: null } })));
        setEdges(es => es.map(e => ({ ...e, className: undefined, animated: false })));
        setNodeOutputs({});
    }, [setNodes, setEdges, cancelAnim]);

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

    const onNodeClick = useCallback((_e, node) => { setSelectedNodeId(node.id); setShowHistory(false); }, []);
    const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

    const selectedNode = nodes.find(n => n.id === selectedNodeId) || null;

    // mark name edits dirty
    const onNameChange = (v) => { setName(v); setDirty(true); };

    const groupedPalette = useMemo(() => {
        const groups = {};
        for (const cat of CATEGORY_ORDER) groups[cat] = [];
        for (const p of palette) { (groups[p.category] || (groups[p.category] = [])).push(p); }
        return groups;
    }, [palette]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--rule)', flexShrink: 0 }}>
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
                            style={{ ...fieldInput, width: 240, marginBottom: 0 }}
                        />
                        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                            <button className={`auto-btn${selected.enabled !== false ? ' auto-btn--ok' : ''}`} onClick={() => toggleFlag('enabled')} title={selected.enabled !== false ? 'Enabled (triggers active)' : 'Disabled'}>
                                {selected.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
                                <span>{selected.enabled !== false ? 'Enabled' : 'Disabled'}</span>
                            </button>
                            <button className="auto-btn auto-btn--icon" onClick={() => toggleFlag('archived')} title={selected.archived ? 'Unarchive' : 'Archive'}>
                                {selected.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                            </button>
                            <button className={`auto-btn${showHistory ? ' is-active' : ''}`} onClick={() => (showHistory ? setShowHistory(false) : openHistory())} title="Run history">
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
                {/* Left rail: automations + palette */}
                <div className="auto-rail" style={{ width: leftWidth, position: 'relative', borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
                    <ResizeHandle side="right" onResizeStart={onLeftResizeStart} />
                    <div style={{ padding: '12px 12px 11px', borderBottom: '1px solid var(--rule)', maxHeight: '52vh', overflowY: 'auto', flexShrink: 0 }}>
                        <button className="auto-btn auto-btn--accent auto-btn--block" onClick={newAutomation}>
                            <Plus size={15} /> <span>New automation</span>
                        </button>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            <button className={`auto-btn auto-btn--grow${buildOpen ? ' is-active' : ''}`} onClick={() => setBuildOpen(o => { if (o) setBuildLog(null); return !o; })} title="Describe an automation and let the model assemble it">
                                <Sparkles size={14} /> <span>Build</span>
                            </button>
                            {selected && (
                                <button className={`auto-btn auto-btn--grow${editOpen ? ' is-active' : ''}`} onClick={() => { setEditOpen(o => !o); setEditResult(null); }} title="Describe a change to the open automation">
                                    <Sparkles size={14} /> <span>Edit</span>
                                </button>
                            )}
                        </div>
                        {buildOpen && (
                            <div style={{ marginTop: 6 }}>
                                <textarea
                                    value={buildPrompt}
                                    onChange={(e) => setBuildPrompt(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) buildAutomation(); }}
                                    placeholder="Describe the automation you want… e.g. every morning fetch a feed and Telegram me only the new items"
                                    rows={3}
                                    disabled={building}
                                    style={{ ...fieldInput, resize: 'vertical', minHeight: 64, lineHeight: 1.4 }}
                                />
                                <Toggle checked={buildTest} onChange={setBuildTest} disabled={building}>Test &amp; improve <span style={{ opacity: 0.7 }}>— run it &amp; let the model fix issues (slower)</span></Toggle>
                                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                                    <button className="auto-btn auto-btn--primary auto-btn--grow" onClick={buildAutomation} disabled={building || !buildPrompt.trim()}>
                                        {building ? 'Building…' : 'Build'}
                                    </button>
                                    <button className="auto-btn auto-btn--ghost" onClick={() => { setBuildOpen(false); setBuildPrompt(''); setBuildLog(null); }} disabled={building}>Cancel</button>
                                </div>
                                {building && <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 5 }}>{buildTest ? 'Building, testing & improving…' : 'The model is assembling your workflow…'}</div>}
                                {buildLog && (
                                    <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)', maxHeight: 180, overflowY: 'auto' }}>
                                        {buildLog.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>• {l}</div>)}
                                    </div>
                                )}
                            </div>
                        )}
                        {selected && editOpen && (
                            <div style={{ marginTop: 6 }}>
                                {!editResult ? (<>
                                    <textarea
                                        value={editPrompt}
                                        onChange={(e) => setEditPrompt(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) previewEdit(); }}
                                        placeholder={`Describe a change to “${name || 'this automation'}”… e.g. add a Slack alert on the false branch`}
                                        rows={3}
                                        disabled={editing}
                                        style={{ ...fieldInput, resize: 'vertical', minHeight: 60, lineHeight: 1.4 }}
                                    />
                                    <Toggle checked={editTest} onChange={setEditTest} disabled={editing}>Test &amp; improve <span style={{ opacity: 0.7 }}>— run it &amp; let the model fix issues (slower)</span></Toggle>
                                    <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                                        <button className="auto-btn auto-btn--primary auto-btn--grow" onClick={previewEdit} disabled={editing || !editPrompt.trim()}>
                                            {editing ? (editTest ? 'Testing…' : 'Thinking…') : 'Preview changes'}
                                        </button>
                                        <button className="auto-btn auto-btn--ghost" onClick={() => { setEditOpen(false); setEditPrompt(''); setEditResult(null); }} disabled={editing}>Cancel</button>
                                    </div>
                                    {editing && <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 5 }}>{editTest ? 'Revising, testing & improving…' : 'The model is revising your workflow…'}</div>}
                                </>) : (<>
                                    <div style={{ fontSize: 11, border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)', maxHeight: 260, overflowY: 'auto' }}>
                                        <div style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>Proposed changes</div>
                                        {editResult.diff.addedNodes.map(n => (
                                            <div key={'a' + n.id} style={{ marginBottom: 3 }}>
                                                <div style={{ color: '#22c55e' }}>+ added <b>{n.label}</b> <span style={{ color: 'var(--ink-3)' }}>({n.type})</span></div>
                                                {Array.isArray(n.config) && n.config.map((c, i) => (
                                                    <div key={i} style={{ color: 'var(--ink-3)', paddingLeft: 12, fontFamily: 'var(--mono, monospace)', fontSize: 10 }}>{c}</div>
                                                ))}
                                            </div>
                                        ))}
                                        {editResult.diff.changedNodes.map(n => (
                                            <div key={'c' + n.id} style={{ marginBottom: 3 }}>
                                                <div style={{ color: 'var(--accent)' }}>~ changed <b>{n.label}</b> <span style={{ color: 'var(--ink-3)' }}>({n.type})</span></div>
                                                {Array.isArray(n.changes) && n.changes.length ? n.changes.map((c, i) => (
                                                    <div key={i} style={{ paddingLeft: 12, fontSize: 10, lineHeight: 1.45 }}>
                                                        <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{c.field}</span>{': '}
                                                        <span style={{ color: '#ef4444', textDecoration: 'line-through', opacity: 0.8 }}>{c.before}</span>
                                                        <span style={{ color: 'var(--ink-3)' }}> → </span>
                                                        <span style={{ color: '#22c55e' }}>{c.after}</span>
                                                    </div>
                                                )) : (n.fields && n.fields.length ? <div style={{ color: 'var(--ink-3)', paddingLeft: 12, fontSize: 10 }}>{n.fields.join(', ')}</div> : null)}
                                            </div>
                                        ))}
                                        {editResult.diff.removedNodes.map(n => <div key={'r' + n.id} style={{ color: '#ef4444' }}>− removed <b>{n.label}</b> <span style={{ color: 'var(--ink-3)' }}>({n.type})</span></div>)}
                                        {(editResult.diff.addedEdges > 0 || editResult.diff.removedEdges > 0) && <div style={{ color: 'var(--ink-3)', marginTop: 3 }}>edges: +{editResult.diff.addedEdges} / −{editResult.diff.removedEdges}</div>}
                                        {(editResult.diff.addedNodes.length + editResult.diff.changedNodes.length + editResult.diff.removedNodes.length) === 0 && <div style={{ color: 'var(--ink-3)' }}>No node changes detected.</div>}
                                    </div>
                                    {Array.isArray(editResult.buildLog) && editResult.buildLog.length > 0 && (
                                        <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)', maxHeight: 180, overflowY: 'auto' }}>
                                            {editResult.buildLog.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>• {l}</div>)}
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                        <button className="auto-btn auto-btn--primary auto-btn--grow" onClick={applyEdit} disabled={editing}>{editing ? 'Applying…' : 'Apply'}</button>
                                        <button className="auto-btn auto-btn--ghost" onClick={() => setEditResult(null)} disabled={editing}>Discard</button>
                                    </div>
                                </>)}
                            </div>
                        )}
                    </div>
                    <div style={{ overflowY: 'auto', flex: '0 0 auto', maxHeight: '38%', padding: '4px 8px 8px' }}>
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
                    {/* Palette */}
                    <div className="auto-rail__section" style={{ borderTop: '1px solid var(--rule)', padding: '10px 8px 6px' }}>
                        <span>Node Palette</span>
                        {!selected && <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: 'var(--ink-4, var(--ink-3))' }}>select an automation</span>}
                    </div>
                    <div style={{ padding: '0 8px 6px' }}>
                        <input
                            type="text"
                            value={paletteQuery}
                            onChange={(e) => setPaletteQuery(e.target.value)}
                            placeholder="Search nodes…"
                            style={{ ...fieldInput, marginBottom: 0, padding: '6px 9px', fontSize: 12 }}
                        />
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1, padding: '0 8px 10px', opacity: selected ? 1 : 0.5, pointerEvents: selected ? 'auto' : 'none' }}>
                        {(() => {
                            const q = paletteQuery.trim().toLowerCase();
                            const searching = q.length > 0;
                            const matches = (item) => !searching || (`${item.label} ${item.description || ''}`).toLowerCase().includes(q);
                            const renderItemBtn = (item, displayLabel) => (
                                <button key={item.key}
                                    className="auto-chip"
                                    draggable
                                    onDragStart={(e) => onPaletteDragStart(e, item)}
                                    onClick={() => addFromPalette(item)}
                                    title={item.description || item.label}
                                >
                                    <span className="auto-chip__icon"><Plus size={12} /></span>
                                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayLabel}</span>
                                    {item.custom && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--accent)' }}>★</span>}
                                </button>
                            );
                            const renderedCats = CATEGORY_ORDER.map(cat => {
                                const allItems = groupedPalette[cat];
                                if (!allItems || allItems.length === 0) return null;
                                const items = allItems.filter(matches);
                                if (items.length === 0) return null; // hide categories with no matches
                                const collapsed = !searching && !!collapsedCats[cat];
                                return (
                                    <div key={cat} style={{ marginBottom: 4 }}>
                                        <button
                                            className="auto-cat"
                                            onClick={() => setCollapsedCats(c => ({ ...c, [cat]: !c[cat] }))}
                                        >
                                            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                            <span>{CATEGORY_LABEL[cat] || cat}</span>
                                            <span className="auto-rail__count">{items.length}</span>
                                        </button>
                                        {!collapsed && (cat === 'connector' ? (() => {
                                            // Connectors: group by external app into collapsible sub-sections.
                                            const flat = items.filter(it => !it.app);
                                            const byApp = {};
                                            for (const it of items) { if (it.app) (byApp[it.app] || (byApp[it.app] = [])).push(it); }
                                            const apps = Object.keys(byApp).sort((a, b) => a.localeCompare(b));
                                            return (<>
                                                {flat.map(item => renderItemBtn(item, item.label))}
                                                {apps.map(app => {
                                                    const appItems = byApp[app];
                                                    const appCollapsed = !searching && !!collapsedApps[app];
                                                    const prefix = `${app} · `;
                                                    return (
                                                        <div key={app} style={{ marginLeft: 8, paddingLeft: 4, borderLeft: '1px solid var(--rule-2, var(--rule))' }}>
                                                            <button
                                                                className="auto-cat"
                                                                style={{ fontSize: 9.5, padding: '5px 2px 4px', textTransform: 'none', letterSpacing: 0.2 }}
                                                                onClick={() => setCollapsedApps(c => ({ ...c, [app]: !c[app] }))}
                                                            >
                                                                {appCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                                                                <span>{app}</span>
                                                                <span className="auto-rail__count">{appItems.length}</span>
                                                            </button>
                                                            {!appCollapsed && appItems.map(item => renderItemBtn(item, item.label.startsWith(prefix) ? item.label.slice(prefix.length) : item.label))}
                                                        </div>
                                                    );
                                                })}
                                            </>);
                                        })() : items.map(item => renderItemBtn(item, item.label)))}
                                    </div>
                                );
                            }).filter(Boolean);
                            if (searching && renderedCats.length === 0) {
                                return <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '12px 6px', textAlign: 'center' }}>No nodes match “{paletteQuery.trim()}”.</div>;
                            }
                            return renderedCats;
                        })()}
                    </div>
                </div>

                {/* Canvas */}
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }} onDragOver={onDragOver} onDrop={onDrop}>
                    {!selected ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ink-3)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                            Select an automation on the left, or create a new one to start building a workflow.
                        </div>
                    ) : (
                        <NodeDropContext.Provider value={handleDropChip}>
                        <EdgeActionsContext.Provider value={edgeActions}>
                        <ReactFlow
                            className="automation-flow"
                            nodes={nodes}
                            edges={edges}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onNodeClick={onNodeClick}
                            onPaneClick={onPaneClick}
                            onEdgesDelete={() => setDirty(true)}
                            onNodesDelete={() => setDirty(true)}
                            nodeTypes={nodeTypes}
                            edgeTypes={edgeTypes}
                            fitView
                            deleteKeyCode={['Backspace', 'Delete']}
                            proOptions={{ hideAttribution: true }}
                        >
                            <Background gap={18} size={1} />
                            <Controls />
                            <MiniMap pannable zoomable style={{ width: 130, height: 90 }} />
                        </ReactFlow>
                        </EdgeActionsContext.Provider>
                        </NodeDropContext.Provider>
                    )}
                    {assembling && (
                        <div className="auto-assembling-badge" style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 7, background: 'var(--surface)', border: '1px solid var(--accent)', borderRadius: 999, padding: '5px 13px', fontSize: 12, fontWeight: 600, color: 'var(--accent)', boxShadow: '0 2px 10px rgba(0,0,0,0.18)', zIndex: 5 }}>
                            <span className="auto-node__spinner" style={{ width: 12, height: 12 }} />
                            <span>Assembling…</span>
                        </div>
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

                {/* Run history panel */}
                {showHistory && (
                    <RunHistoryPanel
                        runs={runs}
                        width={panelWidth}
                        onResizeStart={onPanelResizeStart}
                        onClearHistory={clearRuns}
                        onClose={() => { setShowHistory(false); setRunDetail(null); }}
                    />
                )}
            </div>
            {chipBuilderOpen && <ChipBuilder onClose={() => setChipBuilderOpen(false)} customChips={customChips} onSaved={loadChips} notify={notify} />}
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
function CountdownLine({ intervalMs }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { if (!intervalMs) return undefined; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [intervalMs]);
    if (!intervalMs) return null;
    const next = (Math.floor(now / intervalMs) + 1) * intervalMs;
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
        onChange({ intervalMs: Math.max(5000, Math.max(1, Number(amt) || 1) * unitMs), cron: '' });
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
        <CountdownLine intervalMs={ms} />
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
                        ? <textarea key={p.id} className="cf-text cf-text--multi" rows={1} value={p.v} placeholder={parts.length === 1 ? (chip.placeholder || '') : ''} ref={cfGrow} onFocus={() => registerActive && registerActive(apiRef.current)} onChange={(e) => { editText(p.id, e.target.value); cfGrow(e.target); }} />
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
    query_sqlite: [{ key: 'query', label: 'SQL', multiline: true }, { key: 'db', label: 'Database file' }],
    create_file: [{ key: 'path', label: 'Path' }, { key: 'content', label: 'Content', multiline: true }],
    run_python: [{ key: 'code', label: 'Python code', multiline: true }],
    run_node: [{ key: 'code', label: 'JavaScript code', multiline: true }],
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
            <div className="cf-sec__label">Parameters</div>
            {known.map(p => p.options
                ? <ChoiceChip key={p.key} chip={{ label: p.label }} value={args[p.key]} options={p.options.map(o => ({ value: o, label: o }))} onChange={(v) => setArg(p.key, v)} />
                : <ValueChip key={p.key} chip={{ label: p.label, type: p.multiline ? 'multiline' : 'value', acceptsData: true }} value={args[p.key]} onChange={(v) => setArg(p.key, v)} nodeList={nodeList} registerActive={registerActive} />)}
            {extra.map(k => <ValueChip key={k} chip={{ label: k, type: 'value', acceptsData: true }} value={args[k]} onChange={(v) => setArg(k, v)} nodeList={nodeList} registerActive={registerActive} onRemove={() => { setArg(k, undefined); setCustomKeys(cs => cs.filter(x => x !== k)); }} />)}
            {adding ? (
                <div className="cf-row__head">
                    <input className="cf-num" style={{ width: 140 }} autoFocus placeholder="parameter name" value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newKey.trim()) { setCustomKeys(cs => [...cs, newKey.trim()]); setNewKey(''); setAdding(false); } }} />
                    <button className="cf-add" onClick={() => { if (newKey.trim()) setCustomKeys(cs => [...cs, newKey.trim()]); setNewKey(''); setAdding(false); }}>Add</button>
                </div>
            ) : <div className="cf-tray"><button className="cf-add" onClick={() => setAdding(true)}><span className="cf-add__plus">+</span> parameter</button></div>}
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
function ScheduleChips({ d, onChange }) {
    const ms = Number(d.intervalMs) || 0;
    let unit = 'minutes', amount = 5;
    if (ms > 0) { const u = [...SCHEDULE_UNITS].reverse().find(([, m]) => ms % m === 0) || SCHEDULE_UNITS[0]; unit = u[0]; amount = Math.round(ms / u[1]); }
    const [cronMode, setCronMode] = useState(!!d.cron);
    const apply = (amt, un) => { const unitMs = (SCHEDULE_UNITS.find(([n]) => n === un) || SCHEDULE_UNITS[1])[1]; onChange({ intervalMs: Math.max(5000, Math.max(1, Number(amt) || 1) * unitMs), cron: '' }); };
    if (cronMode) {
        return (<div className="cf-sec">
            <ValueChip chip={{ label: 'Cron (min hour dom mon dow)', type: 'value', acceptsData: false, placeholder: '0 9 * * 1-5' }} value={d.cron || ''} onChange={(v) => onChange({ cron: v })} />
            <button className="cf-add" onClick={() => { setCronMode(false); onChange({ cron: '' }); }}>← simple interval</button>
        </div>);
    }
    return (<div className="cf-sec">
        <div className="cf-chip cf-chip--num"><span className="cf-chip__label">Run every</span><input type="number" min="1" className="cf-num" value={amount} onChange={(e) => apply(e.target.value, unit)} /></div>
        <ChoiceChip chip={{ label: 'Unit' }} value={unit} options={SCHEDULE_UNITS.map(([n]) => ({ value: n, label: n }))} onChange={(v) => apply(amount, v)} />
        <CountdownLine intervalMs={ms} />
        <button className="cf-add" onClick={() => setCronMode(true)}>Advanced: cron →</button>
    </div>);
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
        { field: 'prompt', label: 'Prompt', type: 'multiline', required: true, placeholder: 'Leave blank to receive the previous step’s output, or drop in data chips' },
        { field: 'systemPrompt', label: 'System prompt', type: 'multiline' },
        { field: 'model', label: 'Model', type: 'choice', optionsFrom: 'models' },
    ],
    tool: [
        { field: 'tool', label: 'Tool / skill name', type: 'value', acceptsData: false, required: true, placeholder: 'e.g. query_sqlite' },
        { field: '__args', label: 'Parameters', type: 'special', special: 'toolArgs', required: true },
        { field: 'sendMode', label: 'When sent to Telegram/Slack', type: 'choice', options: SEND_MODE_OPTS, default: 'pdf', when: { field: 'tool', op: 'in', value: ['create_pdf', 'html_to_pdf'] } },
    ],
    web_search: [
        { field: 'query', label: 'Query', type: 'value', required: true },
        { field: 'limit', label: 'Limit', type: 'number', placeholder: '5' },
    ],
    fetch_url: [
        { field: 'url', label: 'URL', type: 'value', required: true, placeholder: 'https://…' },
        { field: 'maxLength', label: 'Max length', type: 'number' },
    ],
    parse_json: [
        { field: 'path', label: 'Keep only this field', type: 'value', acceptsData: false, suggestFrom: 'parseFields', placeholder: 'e.g. results.*.url — blank keeps all' },
    ],
    db_store: [
        { field: 'table', label: 'Table', type: 'value', acceptsData: false, required: true, placeholder: 'records' },
        { field: 'value', label: 'Data to store', type: 'multiline', placeholder: 'Blank stores the previous step’s output' },
        { field: 'key', label: 'Unique key field (track changes)', type: 'value', acceptsData: false, suggestFrom: 'incomingFields', placeholder: 'e.g. link,post_title' },
        { field: 'keyStrip', label: 'Ignore words in key', type: 'value', acceptsData: false, when: { field: 'key', op: 'truthy' } },
        { field: 'keyNormalize', label: 'Normalize key (ignore case & punctuation)', type: 'toggle', when: { field: 'key', op: 'truthy' } },
        { field: 'db', label: 'Database file', type: 'value', acceptsData: false, placeholder: 'automation.db' },
    ],
    db_query: [
        { field: 'table', label: 'Table', type: 'value', acceptsData: false, required: true, placeholder: 'records' },
        { field: 'order', label: 'Order', type: 'choice', required: true, default: 'id DESC', options: [{ value: 'id DESC', label: 'Newest first' }, { value: 'id ASC', label: 'Oldest first' }, { value: 'ts DESC', label: 'By time, newest first' }, { value: 'ts ASC', label: 'By time, oldest first' }] },
        { field: 'limit', label: 'How many', type: 'number', placeholder: '100' },
        { field: 'sql', label: 'Advanced: raw SQL', type: 'multiline', acceptsData: false, placeholder: 'SELECT data FROM records WHERE …' },
        { field: 'db', label: 'Database file', type: 'value', acceptsData: false, placeholder: 'automation.db' },
    ],
    render_html: [{ field: 'html', label: 'HTML', type: 'multiline', required: true, placeholder: '<h1>Report</h1> — blank wraps the previous output' }],
    export_file: [
        { field: 'format', label: 'Format', type: 'choice', required: true, default: 'txt', options: ['txt', 'csv', 'json', 'md', 'html', 'pdf'].map(f => ({ value: f, label: f.toUpperCase() })) },
        { field: 'filename', label: 'Filename', type: 'value', acceptsData: false, required: true, placeholder: 'report' },
        { field: 'content', label: 'Content', type: 'multiline', placeholder: 'Blank uses the previous step’s output' },
    ],
    slack: [
        { field: 'text', label: 'Message / caption', type: 'multiline', required: true, placeholder: 'Blank sends the previous step’s output' },
        { field: 'attachFile', label: 'Upload upstream file', type: 'toggle', default: true },
        { field: 'botToken', label: 'Slack bot token (xoxb-…)', type: 'value', acceptsData: false, required: true, when: { field: 'attachFile', op: 'neq', value: false } },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, when: { field: 'attachFile', op: 'neq', value: false } },
        { field: 'webhookUrl', label: 'Webhook URL (text only)', type: 'value', acceptsData: false, placeholder: 'https://hooks.slack.com/…' },
    ],
    telegram: [
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, placeholder: '123456:ABC-DEF…' },
        { field: 'chatId', label: 'Chat ID', type: 'value', required: true, placeholder: 'e.g. 123456789 or @channel' },
        { field: 'text', label: 'Message / caption', type: 'multiline', required: true, placeholder: 'Blank sends the previous step’s output' },
        { field: 'attachFile', label: 'Send upstream file as a document', type: 'toggle', default: true },
    ],
    telegram_get: [
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, placeholder: '123456:ABC-DEF…' },
        { field: 'limit', label: 'Limit', type: 'number', placeholder: '10' },
    ],
    send_file: [
        { field: 'to', label: 'Send to', type: 'choice', required: true, default: 'telegram', options: [{ value: 'telegram', label: 'Telegram' }, { value: 'slack', label: 'Slack' }, { value: 'http', label: 'HTTP upload' }] },
        { field: 'botToken', label: 'Bot token', type: 'value', acceptsData: false, required: true, when: { field: 'to', op: 'in', value: ['telegram', 'slack'] } },
        { field: 'chatId', label: 'Chat ID', type: 'value', required: true, when: { field: 'to', op: 'eq', value: 'telegram' } },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, when: { field: 'to', op: 'eq', value: 'slack' } },
        { field: 'url', label: 'Upload URL', type: 'value', required: true, when: { field: 'to', op: 'eq', value: 'http' } },
        { field: 'caption', label: 'Caption / message', type: 'value' },
    ],
    delay: [{ field: 'ms', label: 'Delay (ms)', type: 'number', required: true }],
    set: [
        { field: 'name', label: 'Variable name', type: 'value', acceptsData: false, required: true },
        { field: 'value', label: 'Value', type: 'value', required: true, placeholder: 'text or drop a data chip' },
    ],
    map: [
        { field: 'items', label: 'Items to loop over', type: 'value', required: true, placeholder: 'drop a list chip, e.g. results' },
        { field: 'action', label: 'For each item', type: 'choice', required: true, default: 'tool', options: [{ value: 'tool', label: 'Run a tool / skill' }, { value: 'model', label: 'Run the model' }] },
        { field: 'tool', label: 'Tool / skill name', type: 'value', acceptsData: false, required: true, placeholder: 'e.g. fetch_url', when: { field: 'action', op: 'neq', value: 'model' } },
        { field: '__args', label: 'Parameters', type: 'special', special: 'toolArgs', when: { field: 'action', op: 'neq', value: 'model' } },
        { field: 'prompt', label: 'Prompt', type: 'multiline', required: true, placeholder: 'Summarize this: drop the item chip', when: { field: 'action', op: 'eq', value: 'model' } },
        { field: 'model', label: 'Model', type: 'choice', optionsFrom: 'models', when: { field: 'action', op: 'eq', value: 'model' } },
        { field: 'maxConcurrency', label: 'Max parallel', type: 'number', placeholder: '3' },
    ],
    'gate.if': [
        { field: 'condition.left', label: 'Value to check', type: 'value', required: true, placeholder: 'previous output' },
        { field: 'condition.op', label: 'Operator', type: 'choice', required: true, default: '==', options: COND_OP_OPTIONS },
        { field: 'condition.right', label: 'Compare to', type: 'value', required: true, when: { field: 'condition.op', op: 'notIn', value: ['empty', 'not_empty'] } },
    ],
    'gate.filter': [
        { field: 'condition.left', label: 'Value to check', type: 'value', required: true, placeholder: 'previous output' },
        { field: 'condition.op', label: 'Operator', type: 'choice', required: true, default: '==', options: COND_OP_OPTIONS },
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
        { field: 'chatId', label: 'Chat ID filter', type: 'value', acceptsData: false, placeholder: 'only this chat / @channel' },
        { field: 'keyword', label: 'Keyword filter', type: 'value', acceptsData: false },
        { field: 'match', label: 'Match', type: 'choice', default: 'contains', options: MATCH_OPTS, when: { field: 'keyword', op: 'truthy' } },
    ],
    'trigger.slack': [
        { field: 'botToken', label: 'Bot token (xoxb-…)', type: 'value', acceptsData: false, required: true, placeholder: 'xoxb-…' },
        { field: 'channel', label: 'Channel ID', type: 'value', acceptsData: false, required: true, placeholder: 'C0123456789' },
        { field: 'keyword', label: 'Keyword filter', type: 'value', acceptsData: false },
        { field: 'match', label: 'Match', type: 'choice', default: 'contains', options: MATCH_OPTS, when: { field: 'keyword', op: 'truthy' } },
    ],
    'trigger.webhook': [{ field: '__webhook', label: 'Webhook', type: 'special', special: 'webhook', required: true }],
};

function chipApplies(chip, kind) {
    const a = chip && chip.appliesTo;
    if (!a || a === '*' || (Array.isArray(a) && a.includes('*'))) return true;
    return Array.isArray(a) ? a.includes(kind) : a === kind;
}
function chipsForKind(kind, ctx) {
    const out = [{ field: 'label', label: 'Label', type: 'value', acceptsData: false, required: true }];
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
function ChipBoard({ node, ctx, onChange }) {
    const d = node.data || {}; const kind = d.kind;
    const tagGroups = React.useContext(DataTagsContext);
    const activeRef = useRef(null);
    const registerActive = useCallback((api) => { activeRef.current = api; }, []);
    const [added, setAdded] = useState(() => new Set());
    useEffect(() => { setAdded(new Set()); }, [node.id]);
    const specs = chipsForKind(kind, ctx);
    const defaults = {}; for (const s of specs) if (s.default !== undefined) defaults[s.field] = s.default;
    const set = (s, val) => onChange(patchFor(d, s.field, val));
    const visible = (s) => evalWhen(s.when, d, defaults);
    const hasVal = (s) => { const v = getAt(d, s.field); return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length); };
    const isApplied = (s) => visible(s) && (s.required || s.type === 'toggle' || s.type === 'special' || hasVal(s) || added.has(s.field));
    const appliedList = specs.filter(isApplied);
    const trayList = specs.filter(s => visible(s) && !isApplied(s));
    const addChip = (s) => { if (s.type === 'choice') { const o = resolveOptions(s, ctx); set(s, s.default !== undefined ? s.default : (o[0] && o[0].value)); } setAdded(p => { const n = new Set(p); n.add(s.field); return n; }); };
    const removeChip = (s) => { setAdded(p => { const n = new Set(p); n.delete(s.field); return n; }); set(s, undefined); };
    const renderChip = (s) => {
        const rm = (!s.required && s.type !== 'special' && s.type !== 'toggle') ? () => removeChip(s) : undefined;
        if (s.type === 'special') return <React.Fragment key={s.field}>{renderSpecial(s, d, onChange, ctx, registerActive)}</React.Fragment>;
        if (s.type === 'choice') return <ChoiceChip key={s.field} chip={s} value={getAt(d, s.field)} options={resolveOptions(s, ctx)} onChange={(v) => set(s, v)} onRemove={rm} />;
        if (s.type === 'toggle') return <ToggleChip key={s.field} chip={s} value={getAt(d, s.field) ?? s.default} onChange={(v) => set(s, v)} />;
        if (s.type === 'number') return <NumberChip key={s.field} chip={s} value={getAt(d, s.field)} onChange={(v) => set(s, v)} onRemove={rm} />;
        return <ValueChip key={s.field} chip={s} value={getAt(d, s.field)} onChange={(v) => set(s, v)} nodeList={ctx.nodeList} registerActive={registerActive} suggestions={resolveSuggestions(s, ctx)} onRemove={rm} />;
    };
    const dataGroups = [];
    if (kind === 'map') dataGroups.push({ id: '__item', label: 'Each item', predicted: false, tags: [{ ref: '{{item}}', label: 'item', sample: '' }, { ref: '{{item.url}}', label: 'item.url', sample: '' }, { ref: '{{index}}', label: 'index', sample: '' }] });
    for (const g of (tagGroups || [])) dataGroups.push(g);
    return (
        <div className="cf-board">
            <div className="cf-sec" style={{ gap: 8 }}>{appliedList.map(renderChip)}</div>
            <div className="cf-sec">
                <div className="cf-sec__label">Add</div>
                <div className="cf-tray">
                    {trayList.map(s => (
                        <button key={s.field} className={`cf-add${s._custom ? ' cf-add--custom' : ''}`} draggable onDragStart={(e) => { e.dataTransfer.setData(CHIP_ADD_DRAG, s.field); }} onClick={() => addChip(s)} title={s.hint || `Add ${s.label}`}><span className="cf-add__plus">+</span>{s.label}{s._custom ? ' ✦' : ''}</button>
                    ))}
                    {ctx.onOpenChipBuilder && <button className="cf-add cf-add--new" onClick={ctx.onOpenChipBuilder} title="Create a new chip"><span className="cf-add__plus">✦</span> New chip…</button>}
                </div>
            </div>
            {dataGroups.length > 0 && (
                <div className="cf-sec">
                    <div className="cf-sec__label">Data from earlier steps</div>
                    <div className="cf-hint">Drag a chip into a value, or click to drop it into the field you last edited.</div>
                    <div className="cf-data">
                        {dataGroups.map(g => (
                            <div className="cf-data__group" key={g.id}>
                                <div className="cf-data__head">{g.label}{g.predicted ? <small> · expected</small> : null}</div>
                                <div className="cf-data__chips">
                                    {g.tags.map(t => (
                                        <span key={t.ref} className="cf-datachip" draggable title={t.ref}
                                            onDragStart={(e) => { e.dataTransfer.setData(CHIP_REF_DRAG, t.ref); e.dataTransfer.effectAllowed = 'copy'; }}
                                            onClick={() => { if (activeRef.current) activeRef.current.insert(t.ref); }}>
                                            {t.label}{t.sample ? <span className="cf-datachip__s">{t.sample}</span> : null}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
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

function NodeConfig({ node, typeLabel, runningModels = [], lastRun, allOutputs = {}, nodeList = [], edgeList = [], width = 300, onResizeStart, onChange, onDelete, webhookUrl, onGenWebhook, copied, onCopyWebhook, customChips = [], onOpenChipBuilder }) {
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
    // Everything the chip board needs to render this node's chips + data palette.
    const chipCtx = { runningModels, nodeList, edgeList, parseFields, incomingFields, customChips, webhookUrl, onGenWebhook, copied, onCopyWebhook, onOpenChipBuilder };

    return (
        <DataTagsContext.Provider value={tagGroups}>
        <div style={{ position: 'relative', width, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            {onResizeStart && <ResizeHandle onResizeStart={onResizeStart} />}
            <div className="auto-panel__head">
                <span className="auto-panel__icon"><HeadIcon size={16} strokeWidth={2} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="auto-panel__title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label || typeLabel || kind}</div>
                    <div className="auto-panel__sub">{typeLabel || kind}</div>
                </div>
                <button className="auto-btn auto-btn--icon auto-btn--sm auto-btn--danger" onClick={onDelete} title="Delete node" style={{ flexShrink: 0 }}><Trash2 size={14} /></button>
            </div>

            <NodeResult lastRun={lastRun} nodeId={node.id} isTrigger={isTrigger} />

            <ChipBoard node={node} ctx={chipCtx} onChange={onChange} />


            {!isTrigger && (
                <div className="auto-panel__ref" title="Reference this node's output in a later node">
                    <span>Use later:</span>
                    <code>{`{{nodes.${node.id}}}`}</code>
                    <button className="auto-panel__refbtn" onClick={copyRef}>
                        {refCopied ? <Check size={12} /> : <Copy size={12} />} {refCopied ? 'Copied' : 'Copy'}
                    </button>
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

function RunHistoryPanel({ runs, width = 300, onResizeStart, onClearHistory, onClose }) {
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
        <div style={{ position: 'relative', width, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            {onResizeStart && <ResizeHandle onResizeStart={onResizeStart} />}
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
                                        {(rec.nodes || []).map((n, i) => (
                                            <div key={i} style={{ marginBottom: 6, fontSize: 11 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: runStatusColor(n.status) }} />
                                                    <span style={{ color: 'var(--ink-2)' }}>{n.nodeId || n.type}</span>
                                                    <span style={{ color: 'var(--ink-3)', fontSize: 10 }}>({n.type})</span>
                                                    <span style={{ marginLeft: 'auto', color: 'var(--ink-3)', fontSize: 10, textTransform: 'capitalize' }}>{n.status}</span>
                                                </div>
                                                {n.error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 10, marginLeft: 12 }}>{n.error}</div>}
                                                {n.output != null && (
                                                    <pre style={{ margin: '2px 0 0 12px', fontSize: 10, color: 'var(--ink-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 80, overflow: 'auto' }}>
                                                        {typeof n.output === 'string' ? n.output.slice(0, 300) : JSON.stringify(n.output).slice(0, 300)}
                                                    </pre>
                                                )}
                                            </div>
                                        ))}
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

export default function AutomationView({ showSnackbar, models }) {
    return (
        <ReactFlowProvider>
            <FlowEditor showSnackbar={showSnackbar} models={models} />
        </ReactFlowProvider>
    );
}
