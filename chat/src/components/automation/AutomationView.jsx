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
    Power, PowerOff, Copy, Check, ChevronDown, ChevronRight, History as HistoryIcon, X as CloseIcon, Sparkles, Download,
} from 'lucide-react';
import { useChatStore } from '../../stores/useChatStore';
import { useConfirm } from '../ConfirmDialog';
import AutomationNode from './AutomationNode';

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
    sqlite: 'tools', render_chart: 'tools', create_pdf: 'tools', create_file: 'tools',
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
            const { kind, status, ...rest } = n.data || {};
            return { id: n.id, type: kind, position: n.position, data: rest };
        }),
        edges: rfEdges.map(e => ({
            id: e.id, source: e.source, target: e.target,
            sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
        })),
    };
}

// inline style helpers (theme tokens)
const railBtn = {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
    padding: '7px 9px', border: '1px solid var(--rule-2)', borderRadius: 8,
    color: 'var(--ink-2)', fontSize: 12.5, fontWeight: 500, background: 'transparent',
    cursor: 'pointer',
};
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
const FieldInsertContext = React.createContext(null);

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
    const ctx = React.useContext(FieldInsertContext);
    return <input ref={elRef} value={value} onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (ctx) ctx.setActive({ el: elRef.current, onChangeRef }); }}
        style={{ ...fieldInput, ...style }} {...makeDropHandlers(elRef, onChangeRef)} {...rest} />;
}
function TemplTextarea({ value = '', onChange, style, registerAsDefault, ...rest }) {
    const elRef = useRef(null);
    const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
    const ctx = React.useContext(FieldInsertContext);
    // The Output box registers itself as the default insert target so clicking a
    // data tag drops it here even before the field is explicitly focused.
    useEffect(() => { if (registerAsDefault && ctx && elRef.current) ctx.setActive({ el: elRef.current, onChangeRef }); }, [registerAsDefault]); // eslint-disable-line react-hooks/exhaustive-deps
    return <textarea ref={elRef} value={value} onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (ctx) ctx.setActive({ el: elRef.current, onChangeRef }); }}
        style={{ ...fieldInput, ...style }} {...makeDropHandlers(elRef, onChangeRef)} {...rest} />;
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

function DataTag({ refStr, label, sample }) {
    const ctx = React.useContext(FieldInsertContext);
    const [flash, setFlash] = useState(false);
    const pick = () => {
        const inserted = ctx && ctx.insert(refStr);
        if (!inserted) navigator.clipboard?.writeText(refStr); // no field focused → copy
        setFlash(true); setTimeout(() => setFlash(false), 450);
    };
    return (
        <span
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(REF_MIME, refStr); e.dataTransfer.setData('text/plain', refStr); e.dataTransfer.effectAllowed = 'copy'; }}
            onMouseDown={(e) => e.preventDefault()}  // keep the focused field focused
            onClick={pick}
            title={`${refStr}${sample ? `  ·  e.g. ${sample}` : ''}`}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10.5, fontFamily: 'monospace',
                background: flash ? 'var(--accent)' : 'var(--bg)', color: flash ? 'var(--accent-ink, #fff)' : 'var(--ink-2)',
                border: `1px solid ${flash ? 'var(--accent)' : 'var(--rule-2)'}`, borderRadius: 5, padding: '2px 6px', margin: '0 4px 4px 0', maxWidth: '100%',
            }}
        >
            <span style={{ opacity: 0.55 }}>+</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        </span>
    );
}

// Representative output shape per node kind, so data tags are discoverable
// BEFORE a run. Captured run output replaces this once available.
function staticOutputShape(kind, data = {}) {
    switch (kind) {
        case 'db_store':    return { new: [{}], stored: 0, skipped: 0, total: 0, table: '', db: '' };
        case 'db_query':    return [{}];
        case 'fetch_url':   return { url: '', title: '', content: '', source: '', success: true };
        case 'web_search':  return { results: [{ title: '', url: '', snippet: '' }] };
        case 'merge':       return { items: [], count: 0 };
        case 'map':         return { count: 0, results: [{}] };
        case 'render_html': return { html: '', contentType: 'text/html' };
        case 'set':         return data && data.name ? { [data.name]: '' } : { value: '' };
        case 'tool':        return (data && data.tool === 'http_request') ? { success: true, status: 200, data: '', headers: {} } : null;
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

// Clickable {{nodes.id.path}} tags for every UPSTREAM node (the data available
// here). Shows expected fields before a run; real fields once captured.
function DataTagPalette({ outputs = {}, nodes = [], edges = [], currentNodeId }) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const sources = upstreamIdsOrdered(edges, currentNodeId)
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(n => {
            const captured = (outputs[n.id] && outputs[n.id].output != null) ? outputs[n.id].output : undefined;
            return {
                id: n.id,
                label: (n.data && n.data.label) || (n.data && n.data.kind) || n.id,
                predicted: captured === undefined,
                out: captured !== undefined ? captured : staticOutputShape(n.data && n.data.kind, n.data || {}),
            };
        });
    if (!sources.length) {
        return (
            <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                Connect a node into this one to pull its data here as clickable <code>{'{{nodes.…}}'}</code> tags.
            </div>
        );
    }
    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 5 }}>Click a field, then a tag to insert it. <em>Run once</em> to refine fields from real data.</div>
            {sources.map(s => (
                <div key={s.id} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 3 }}>{s.label}{s.predicted ? ' · expected' : ''}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                        <DataTag refStr={`{{nodes.${s.id}}}`} label="whole output" />
                        {s.out != null && typeof s.out === 'object' && flattenForTags(s.out).map(t => (
                            <DataTag key={t.path} refStr={`{{nodes.${s.id}.${t.path}}}`} label={t.path} sample={t.leaf ? t.sample : ''} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function FlowEditor({ showSnackbar, models }) {
    const setView = useChatStore(s => s.setView);
    const confirm = useConfirm();
    const { screenToFlowPosition } = useReactFlow();
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
    const [panelWidth, setPanelWidth] = useState(() => {
        const v = Number(localStorage.getItem('automationPanelWidth'));
        return v >= 280 && v <= 760 ? v : 320;
    });
    const runAbortRef = useRef(null);
    const addCountRef = useRef(0);

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
            await loadAutomations();
        })();
    }, [loadAutomations]);

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

    // ---- selection ----
    const selectAutomation = useCallback(async (id) => {
        try {
            const res = await fetch(`/api/automations/${id}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to load automation');
            const wf = await res.json();
            const { nodes: n, edges: e } = serverToRF(wf, labelFor);
            setSelected(wf);
            setName(wf.name || '');
            setNodes(n);
            setEdges(e);
            setSelectedNodeId(null);
            setDirty(false);
            setRunResult(null);
            setWebhookUrl('');
            setNodeOutputs({});
            addCountRef.current = n.length;
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
            selectAutomation(data.id);
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
        try {
            const res = await fetch(`/api/automations/${selected.id}`, {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editResult.proposed.name, nodes: editResult.proposed.nodes, edges: editResult.proposed.edges }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to apply changes'); }
            await loadAutomations();
            selectAutomation(selected.id);
            setEditResult(null); setEditPrompt(''); setEditOpen(false);
            notify('Changes applied', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setEditing(false); }
    }, [editResult, selected, loadAutomations, selectAutomation]);

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

    // ---- run (SSE) + animation ----
    const resetRunVisuals = useCallback(() => {
        setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, status: undefined } })));
        setEdges(es => es.map(e => ({ ...e, className: undefined, animated: false })));
        setNodeOutputs({});
    }, [setNodes, setEdges]);

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
        if (!window.confirm('Clear all run history for this automation?')) return;
        try {
            const res = await fetch(`/api/automations/${selected.id}/runs`, { method: 'DELETE', credentials: 'include' });
            if (!res.ok) throw new Error('Failed to clear run history');
            setRunDetail(null);
            await loadRuns();
        } catch (err) { notify(err.message, 'error'); }
    }, [selected, loadRuns]);

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
                <button onClick={() => setView('chat')} style={{ ...railBtn, width: 'auto', padding: '6px 10px' }} title="Back to chat">
                    <ArrowLeft size={15} /> <span>Chat</span>
                </button>
                <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13 }}>Automations</span>
                {selected && (
                    <>
                        <input
                            value={name} onChange={(e) => onNameChange(e.target.value)}
                            placeholder="Automation name"
                            style={{ ...fieldInput, width: 240, marginBottom: 0 }}
                        />
                        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                            <button onClick={() => toggleFlag('enabled')} style={{ ...railBtn, width: 'auto', padding: '6px 9px', color: selected.enabled !== false ? 'var(--ok, #22c55e)' : 'var(--ink-3)' }} title={selected.enabled !== false ? 'Enabled (triggers active)' : 'Disabled'}>
                                {selected.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
                                <span>{selected.enabled !== false ? 'Enabled' : 'Disabled'}</span>
                            </button>
                            <button onClick={() => toggleFlag('archived')} style={{ ...railBtn, width: 'auto', padding: '6px 9px' }} title={selected.archived ? 'Unarchive' : 'Archive'}>
                                {selected.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                            </button>
                            <button onClick={() => (showHistory ? setShowHistory(false) : openHistory())} style={{ ...railBtn, width: 'auto', padding: '6px 9px', color: showHistory ? 'var(--accent)' : 'var(--ink-2)', borderColor: showHistory ? 'var(--accent)' : 'var(--rule-2)' }} title="Run history">
                                <HistoryIcon size={14} /> <span>History</span>
                            </button>
                            <button onClick={save} disabled={!dirty} style={{ ...railBtn, width: 'auto', padding: '6px 11px', color: dirty ? 'var(--accent)' : 'var(--ink-3)', borderColor: dirty ? 'var(--accent)' : 'var(--rule-2)' }}>
                                <Save size={14} /> <span>Save{dirty ? '*' : ''}</span>
                            </button>
                            {running ? (
                                <button onClick={stop} style={{ ...railBtn, width: 'auto', padding: '6px 11px', color: 'var(--danger, #ef4444)', borderColor: 'var(--danger, #ef4444)' }}>
                                    <Square size={13} /> <span>Stop</span>
                                </button>
                            ) : (
                                <button onClick={run} style={{ ...railBtn, width: 'auto', padding: '6px 11px', color: 'var(--accent-ink, #fff)', background: 'var(--accent)', borderColor: 'var(--accent)' }}>
                                    <Play size={13} /> <span>Run</span>
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Left rail: automations + palette */}
                <div style={{ width: leftWidth, position: 'relative', borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
                    <ResizeHandle side="right" onResizeStart={onLeftResizeStart} />
                    <div style={{ padding: 10, borderBottom: '1px solid var(--rule)' }}>
                        <button onClick={newAutomation} style={{ ...railBtn, justifyContent: 'center', color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                            <Plus size={14} /> <span>New automation</span>
                        </button>
                        <button onClick={() => setBuildOpen(o => { if (o) setBuildLog(null); return !o; })} style={{ ...railBtn, justifyContent: 'center', marginTop: 6 }}>
                            <Sparkles size={14} /> <span>Build with LLM</span>
                        </button>
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
                                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-3)', margin: '6px 0', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={buildTest} onChange={e => setBuildTest(e.target.checked)} disabled={building} /> Test &amp; improve (run it and let the model fix issues — slower)
                                </label>
                                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                    <button onClick={buildAutomation} disabled={building || !buildPrompt.trim()} style={{ ...railBtn, justifyContent: 'center', flex: 1, color: 'var(--accent)', borderColor: 'var(--accent)', opacity: (building || !buildPrompt.trim()) ? 0.55 : 1, cursor: (building || !buildPrompt.trim()) ? 'default' : 'pointer' }}>
                                        {building ? 'Building…' : 'Build'}
                                    </button>
                                    <button onClick={() => { setBuildOpen(false); setBuildPrompt(''); setBuildLog(null); }} disabled={building} style={{ ...railBtn, justifyContent: 'center', flex: '0 0 auto', padding: '0 12px' }}>Cancel</button>
                                </div>
                                {building && <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 5 }}>{buildTest ? 'Building, testing & improving…' : 'The model is assembling your workflow…'}</div>}
                                {buildLog && (
                                    <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)' }}>
                                        {buildLog.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>• {l}</div>)}
                                    </div>
                                )}
                            </div>
                        )}
                        {selected && (
                            <button onClick={() => { setEditOpen(o => !o); setEditResult(null); }} style={{ ...railBtn, justifyContent: 'center', marginTop: 6 }}>
                                <Sparkles size={14} /> <span>Edit with LLM</span>
                            </button>
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
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-3)', margin: '6px 0', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={editTest} onChange={(e) => setEditTest(e.target.checked)} disabled={editing} /> Test &amp; improve (run it and let the model fix issues — slower)
                                    </label>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button onClick={previewEdit} disabled={editing || !editPrompt.trim()} style={{ ...railBtn, justifyContent: 'center', flex: 1, opacity: (editing || !editPrompt.trim()) ? 0.55 : 1, cursor: (editing || !editPrompt.trim()) ? 'default' : 'pointer' }}>
                                            {editing ? (editTest ? 'Testing…' : 'Thinking…') : 'Preview changes'}
                                        </button>
                                        <button onClick={() => { setEditOpen(false); setEditPrompt(''); setEditResult(null); }} disabled={editing} style={{ ...railBtn, justifyContent: 'center', flex: '0 0 auto', padding: '0 12px' }}>Cancel</button>
                                    </div>
                                    {editing && <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 5 }}>{editTest ? 'Revising, testing & improving…' : 'The model is revising your workflow…'}</div>}
                                </>) : (<>
                                    <div style={{ fontSize: 11, border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)' }}>
                                        <div style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>Proposed changes</div>
                                        {editResult.diff.addedNodes.map(n => <div key={'a' + n.id} style={{ color: '#22c55e' }}>+ {n.label}</div>)}
                                        {editResult.diff.changedNodes.map(n => <div key={'c' + n.id} style={{ color: 'var(--accent)' }}>~ {n.label}</div>)}
                                        {editResult.diff.removedNodes.map(n => <div key={'r' + n.id} style={{ color: '#ef4444' }}>− {n.label}</div>)}
                                        {(editResult.diff.addedEdges > 0 || editResult.diff.removedEdges > 0) && <div style={{ color: 'var(--ink-3)', marginTop: 3 }}>edges: +{editResult.diff.addedEdges} / −{editResult.diff.removedEdges}</div>}
                                        {(editResult.diff.addedNodes.length + editResult.diff.changedNodes.length + editResult.diff.removedNodes.length) === 0 && <div style={{ color: 'var(--ink-3)' }}>No node changes detected.</div>}
                                    </div>
                                    {Array.isArray(editResult.buildLog) && editResult.buildLog.length > 0 && (
                                        <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 8, padding: 8, background: 'var(--bg)' }}>
                                            {editResult.buildLog.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>• {l}</div>)}
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                        <button onClick={applyEdit} disabled={editing} style={{ ...railBtn, justifyContent: 'center', flex: 1, color: 'var(--accent)', borderColor: 'var(--accent)' }}>{editing ? 'Applying…' : 'Apply'}</button>
                                        <button onClick={() => setEditResult(null)} disabled={editing} style={{ ...railBtn, justifyContent: 'center', flex: '0 0 auto', padding: '0 12px' }}>Discard</button>
                                    </div>
                                </>)}
                            </div>
                        )}
                    </div>
                    <div style={{ overflowY: 'auto', flex: '0 0 auto', maxHeight: '38%', padding: '6px 8px' }}>
                        {automations.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: 8 }}>No automations yet.</div>}
                        {automations.map(a => (
                            <div key={a.id}
                                onClick={() => selectAutomation(a.id)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 7, padding: '7px 8px', borderRadius: 7, cursor: 'pointer', marginBottom: 2,
                                    background: selected && selected.id === a.id ? 'var(--accent-soft)' : 'transparent',
                                    color: selected && selected.id === a.id ? 'var(--accent)' : 'var(--ink-2)',
                                    opacity: a.archived ? 0.55 : 1,
                                }}
                            >
                                <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: a.enabled !== false ? 'var(--ok, #22c55e)' : 'var(--ink-4, #64748b)' }} />
                                <span style={{ flex: 1, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name || 'Untitled'}</span>
                                {a._ownerName && (
                                    <span style={{ flexShrink: 0, fontSize: 9.5, color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 4, padding: '1px 5px' }} title={`Owner: ${a._ownerName}`}>{a._ownerName}</span>
                                )}
                                <button onClick={(e) => { e.stopPropagation(); deleteAutomation(a.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', display: 'flex' }} title="Delete">
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                    {/* Palette */}
                    <div style={{ borderTop: '1px solid var(--rule)', padding: '8px 8px 4px', fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' }}>
                        NODE PALETTE {selected ? '' : '(select an automation)'}
                    </div>
                    <div style={{ padding: '0 8px 6px' }}>
                        <input
                            type="text"
                            value={paletteQuery}
                            onChange={(e) => setPaletteQuery(e.target.value)}
                            placeholder="Search nodes…"
                            style={{ ...fieldInput, padding: '5px 8px', fontSize: 12 }}
                        />
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1, padding: '0 8px 10px', opacity: selected ? 1 : 0.5, pointerEvents: selected ? 'auto' : 'none' }}>
                        {(() => {
                            const q = paletteQuery.trim().toLowerCase();
                            const searching = q.length > 0;
                            const matches = (item) => !searching || (`${item.label} ${item.description || ''}`).toLowerCase().includes(q);
                            const renderItemBtn = (item, displayLabel) => (
                                <button key={item.key}
                                    draggable
                                    onDragStart={(e) => onPaletteDragStart(e, item)}
                                    onClick={() => addFromPalette(item)}
                                    style={{ ...railBtn, padding: '6px 8px', marginBottom: 3, fontSize: 12, cursor: 'grab' }}
                                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-soft)'; e.currentTarget.style.color = 'var(--accent)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-2)'; }}
                                    title={item.description || item.label}
                                >
                                    <Plus size={12} /> <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayLabel}</span>
                                    {item.custom && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--accent)' }}>★</span>}
                                </button>
                            );
                            return CATEGORY_ORDER.map(cat => {
                                const allItems = groupedPalette[cat];
                                if (!allItems || allItems.length === 0) return null;
                                const items = allItems.filter(matches);
                                if (items.length === 0) return null; // hide categories with no matches
                                const collapsed = !searching && !!collapsedCats[cat];
                                return (
                                    <div key={cat} style={{ marginBottom: 6 }}>
                                        <button
                                            onClick={() => setCollapsedCats(c => ({ ...c, [cat]: !c[cat] }))}
                                            style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', padding: '6px 2px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}
                                        >
                                            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                            <span>{CATEGORY_LABEL[cat] || cat}</span>
                                            <span style={{ marginLeft: 'auto', color: 'var(--ink-4, var(--ink-3))' }}>{items.length}</span>
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
                                                        <div key={app} style={{ marginLeft: 6 }}>
                                                            <button
                                                                onClick={() => setCollapsedApps(c => ({ ...c, [app]: !c[app] }))}
                                                                style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', padding: '4px 2px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 9.5, fontWeight: 600 }}
                                                            >
                                                                {appCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                                                                <span>{app}</span>
                                                                <span style={{ marginLeft: 'auto', color: 'var(--ink-4, var(--ink-3))' }}>{appItems.length}</span>
                                                            </button>
                                                            {!appCollapsed && appItems.map(item => renderItemBtn(item, item.label.startsWith(prefix) ? item.label.slice(prefix.length) : item.label))}
                                                        </div>
                                                    );
                                                })}
                                            </>);
                                        })() : items.map(item => renderItemBtn(item, item.label)))}
                                    </div>
                                );
                            });
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

function NodeConfig({ node, runningModels = [], lastRun, allOutputs = {}, nodeList = [], edgeList = [], width = 300, onResizeStart, onChange, onDelete, webhookUrl, onGenWebhook, copied, onCopyWebhook }) {
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

    // Track the focused templatable field so clicking a data tag inserts into it.
    const activeFieldRef = useRef(null);
    const fieldInsert = useMemo(() => ({
        setActive: (f) => { activeFieldRef.current = f; },
        insert: (refStr) => {
            const f = activeFieldRef.current;
            if (!f || !f.el) return false;
            const el = f.el;
            const v = el.value || '';
            // Insert at the caret only when the field is actually focused; otherwise
            // append at the end (the field is the default target, e.g. the Output box).
            const focused = document.activeElement === el;
            const s = (focused && el.selectionStart != null) ? el.selectionStart : v.length;
            const e = (focused && el.selectionEnd != null) ? el.selectionEnd : v.length;
            f.onChangeRef.current(`${v.slice(0, s)}${refStr}${v.slice(e)}`);
            requestAnimationFrame(() => { try { el.focus(); const p = s + refStr.length; el.setSelectionRange(p, p); } catch (_) {} });
            return true;
        },
    }), []);

    return (
        <FieldInsertContext.Provider value={fieldInsert}>
        <div style={{ position: 'relative', width, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            {onResizeStart && <ResizeHandle onResizeStart={onResizeStart} />}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 14 }}>{kind}</span>
                <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger, #ef4444)', display: 'flex' }} title="Delete node"><Trash2 size={16} /></button>
            </div>

            <NodeResult lastRun={lastRun} nodeId={node.id} isTrigger={isTrigger} />

            {!isTrigger && <DataTagPalette outputs={allOutputs} nodes={nodeList} edges={edgeList} currentNodeId={node.id} />}

            <Field label="Label"><input style={fieldInput} value={d.label || ''} onChange={(e) => onChange({ label: e.target.value })} /></Field>

            {kind === 'model' && (<>
                <Field label="Prompt"><TemplTextarea style={{ minHeight: 80, fontFamily: 'inherit', resize: 'vertical' }} value={d.prompt || ''} onChange={(v) => onChange({ prompt: v })} placeholder="Leave blank to receive the previous node's output, or use {{last}} / {{nodes.id.field}}" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -6, marginBottom: 8 }}>The connected node's output is passed in automatically unless you reference data with {'{{…}}'}.</p>
                <Field label="System prompt"><TemplTextarea style={{ minHeight: 48, resize: 'vertical' }} value={d.systemPrompt || ''} onChange={(v) => onChange({ systemPrompt: v })} /></Field>
                <Field label="Model">
                    <select style={fieldInput} value={d.model || ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
                        <option value="">Current model{runningModels[0] ? ` (${runningModels[0].name})` : ''}</option>
                        {runningModels.map(m => (
                            <option key={m.name} value={m.name}>{m.name}{m.backend ? ` · ${m.backend}` : ''}</option>
                        ))}
                        {d.model && !runningModels.some(m => m.name === d.model) && (
                            <option value={d.model}>{d.model} (not currently loaded)</option>
                        )}
                    </select>
                    {runningModels.length === 0 && (
                        <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: -6, marginBottom: 8 }}>No models loaded right now — load one to run this node.</div>
                    )}
                </Field>
            </>)}

            {kind === 'tool' && (<>
                <Field label="Tool / skill name"><TemplInput value={d.tool || ''} onChange={(v) => onChange({ tool: v })} placeholder="e.g. query_sqlite" /></Field>
                <Field label="Arguments (JSON)"><JsonField value={d.args} onChange={(v) => onChange({ args: v })} placeholder={'{ "url": "{{nodes.id.results.0.url}}" }'} /></Field>
                <p style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: -4 }}>This tool reads its data from these Arguments — click a data tag to drop it into a value. (The incoming line isn't passed in automatically.)</p>
            </>)}

            {kind === 'web_search' && (<>
                <Field label="Query"><TemplInput value={d.query || ''} onChange={(v) => onChange({ query: v })} /></Field>
                <Field label="Limit"><input type="number" style={fieldInput} value={d.limit ?? ''} onChange={(e) => onChange({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'fetch_url' && (<>
                <Field label="URL"><TemplInput value={d.url || ''} onChange={(v) => onChange({ url: v })} /></Field>
                <Field label="Max length"><input type="number" style={fieldInput} value={d.maxLength ?? ''} onChange={(e) => onChange({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'parse_json' && (<>
                <Field label="Keep only this field (optional)">
                    {parseFields.length > 0 && (
                        <select style={{ ...fieldInput, marginBottom: 6 }} value={parseFields.includes(d.path) ? d.path : (d.path ? '__custom__' : '')} onChange={(e) => { if (e.target.value !== '__custom__') onChange({ path: e.target.value }); }}>
                            <option value="">— keep the whole result —</option>
                            {parseFields.map(f => <option key={f} value={f}>{f}</option>)}
                            <option value="__custom__">Custom… (type below)</option>
                        </select>
                    )}
                    <TemplInput value={d.path || ''} onChange={(v) => onChange({ path: v })} placeholder={parseFields.length ? 'or type a field path' : 'e.g. results.*.url — run once to list fields'} />
                </Field>
                <p style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: -2 }}>Picks one field out of the previous step's JSON. Blank = pass it all through.</p>
            </>)}

            {kind === 'db_store' && (<>
                <Field label="Table"><TemplInput value={d.table || ''} onChange={(v) => onChange({ table: v })} placeholder="records" /></Field>
                <Field label="Data to store"><TemplTextarea style={{ minHeight: 48, resize: 'vertical' }} value={d.value || ''} onChange={(v) => onChange({ value: v })} placeholder="Leave blank to store the previous node's output ({{last}})" /></Field>
                <Field label="Unique key field — track changes (optional)">
                    {incomingFields.length > 0 && (
                        <select style={{ ...fieldInput, marginBottom: 6 }} value={incomingFields.includes(d.key) ? d.key : (d.key ? '__custom__' : '')} onChange={(e) => { if (e.target.value !== '__custom__') onChange({ key: e.target.value }); }}>
                            <option value="">— no key (store everything) —</option>
                            {incomingFields.map(f => <option key={f} value={f}>{f}</option>)}
                            <option value="__custom__">Custom… (type below)</option>
                        </select>
                    )}
                    <TemplInput value={d.key || ''} onChange={(v) => onChange({ key: v })} placeholder={incomingFields.length ? 'or type field(s), e.g. link,post_title' : 'e.g. link,post_title — run once to list fields'} />
                </Field>
                {d.key ? (<>
                    <Field label="Ignore words in key (optional)"><TemplInput value={d.keyStrip || ''} onChange={(v) => onChange({ keyStrip: v })} placeholder="e.g. NEW (comma-separated)" /></Field>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-3)', margin: '0 0 10px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!d.keyNormalize} onChange={(e) => onChange({ keyNormalize: e.target.checked })} />
                        Normalize key (ignore case &amp; punctuation)
                    </label>
                </>) : null}
                <Field label="Database file"><TemplInput value={d.db || ''} onChange={(v) => onChange({ db: v })} placeholder="automation.db" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Appends to a SQLite table in this automation's workspace (auto-created); a list is stored as one row per item. Set a <b>key field</b> to deduplicate across runs — only new items are stored, and they're returned as <code>{'{{nodes.<id>.new}}'}</code> (the change feed); <code>{'{{nodes.<id>.stored}}'}</code> is how many were new.</p>
            </>)}

            {kind === 'db_query' && (<>
                <Field label="Table"><TemplInput value={d.table || ''} onChange={(v) => onChange({ table: v })} placeholder="records" /></Field>
                <Field label="How many"><input type="number" style={fieldInput} value={d.limit ?? ''} onChange={(e) => onChange({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="100" /></Field>
                <Field label="Order">
                    <select style={fieldInput} value={d.order || 'id DESC'} onChange={(e) => onChange({ order: e.target.value })}>
                        <option value="id DESC">Newest first</option>
                        <option value="id ASC">Oldest first</option>
                        <option value="ts DESC">By time, newest first</option>
                        <option value="ts ASC">By time, oldest first</option>
                    </select>
                </Field>
                <Field label="Advanced: raw SQL (optional)"><TemplTextarea style={{ minHeight: 44, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }} value={d.sql || ''} onChange={(v) => onChange({ sql: v })} placeholder="SELECT data FROM records WHERE …" /></Field>
                <Field label="Database file"><TemplInput value={d.db || ''} onChange={(v) => onChange({ db: v })} placeholder="automation.db" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Returns the stored records (most recent first) to feed a model, Telegram, or file. Raw SQL overrides the simple options.</p>
            </>)}

            {kind === 'render_html' && (
                <Field label="HTML"><TemplTextarea style={{ minHeight: 120, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }} value={d.html || ''} onChange={(v) => onChange({ html: v })} placeholder="<h1>Report</h1>{{last}} — leave blank to wrap the previous node's output" /></Field>
            )}

            {kind === 'export_file' && (<>
                <Field label="Format">
                    <select style={fieldInput} value={d.format || 'txt'} onChange={(e) => onChange({ format: e.target.value })}>
                        {['txt', 'csv', 'json', 'md', 'html', 'pdf'].map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                    </select>
                </Field>
                <Field label="Filename"><TemplInput value={d.filename || ''} onChange={(v) => onChange({ filename: v })} placeholder="report (extension added automatically)" /></Field>
                <Field label="Content"><TemplTextarea style={{ minHeight: 80, resize: 'vertical' }} value={d.content || ''} onChange={(v) => onChange({ content: v })} placeholder="Leave blank to use the previous node's output" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>The file is written to the run workspace and surfaced as a download.</p>
            </>)}

            {kind === 'slack' && (<>
                <Field label="Webhook URL"><TemplInput value={d.webhookUrl || ''} onChange={(v) => onChange({ webhookUrl: v })} placeholder="https://hooks.slack.com/services/…" /></Field>
                <Field label="Message"><TemplTextarea style={{ minHeight: 64, resize: 'vertical' }} value={d.text || ''} onChange={(v) => onChange({ text: v })} placeholder="Leave blank to send the previous node's output" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Create an Incoming Webhook in your Slack app settings and paste its URL here.</p>
            </>)}

            {kind === 'telegram' && (<>
                <Field label="Bot token"><TemplInput value={d.botToken || ''} onChange={(v) => onChange({ botToken: v })} placeholder="123456:ABC-DEF…" /></Field>
                <Field label="Chat ID"><TemplInput value={d.chatId || ''} onChange={(v) => onChange({ chatId: v })} placeholder="e.g. 123456789 or @channelname" /></Field>
                <Field label="Message"><TemplTextarea style={{ minHeight: 64, resize: 'vertical' }} value={d.text || ''} onChange={(v) => onChange({ text: v })} placeholder="Leave blank to send the previous node's output" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Create a bot with @BotFather for the token; get the chat id from @userinfobot or the bot's getUpdates.</p>
            </>)}

            {kind === 'telegram_get' && (<>
                <Field label="Bot token"><TemplInput value={d.botToken || ''} onChange={(v) => onChange({ botToken: v })} placeholder="123456:ABC-DEF…" /></Field>
                <Field label="Limit"><input type="number" style={fieldInput} value={d.limit ?? ''} onChange={(e) => onChange({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="10" /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Fetches recent messages: <code>{'{{nodes.id.messages}}'}</code>, <code>{'{{nodes.id.latest.text}}'}</code>, <code>{'{{nodes.id.text}}'}</code> (latest). Don't use on a bot that also has a Telegram trigger — getUpdates conflicts.</p>
            </>)}

            {kind === 'delay' && (
                <Field label="Delay (ms)"><input type="number" style={fieldInput} value={d.ms ?? ''} onChange={(e) => onChange({ ms: Number(e.target.value) })} /></Field>
            )}

            {kind === 'set' && (<>
                <Field label="Variable name"><input style={fieldInput} value={d.name || ''} onChange={(e) => onChange({ name: e.target.value })} /></Field>
                <Field label="Value"><TemplInput value={d.value ?? ''} onChange={(v) => onChange({ value: v })} placeholder="Supports {{...}}" /></Field>
            </>)}

            {kind === 'map' && (<>
                <Field label="Items to loop over"><TemplInput value={d.items || ''} onChange={(v) => onChange({ items: v })} placeholder="{{nodes.id.results.*.url}} or {{last}}" /></Field>
                <Field label="For each item">
                    <select style={fieldInput} value={d.action || 'tool'} onChange={(e) => onChange({ action: e.target.value })}>
                        <option value="tool">Run a tool / skill</option>
                        <option value="model">Run the model</option>
                    </select>
                </Field>
                {(d.action || 'tool') === 'tool' ? (<>
                    <Field label="Tool / skill name"><TemplInput value={d.tool || ''} onChange={(v) => onChange({ tool: v })} placeholder="e.g. fetch_url" /></Field>
                    <Field label="Arguments (JSON)"><JsonField value={d.args} onChange={(v) => onChange({ args: v })} placeholder={'{ "url": "{{item}}" }'} /></Field>
                </>) : (<>
                    <Field label="Prompt"><TemplTextarea style={{ minHeight: 64, resize: 'vertical' }} value={d.prompt || ''} onChange={(v) => onChange({ prompt: v })} placeholder="Summarize this: {{item}}" /></Field>
                    <Field label="Model">
                        <select style={fieldInput} value={d.model || ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
                            <option value="">Current model{runningModels[0] ? ` (${runningModels[0].name})` : ''}</option>
                            {runningModels.map(m => <option key={m.name} value={m.name}>{m.name}{m.backend ? ` · ${m.backend}` : ''}</option>)}
                        </select>
                    </Field>
                </>)}
                <Field label="Max parallel"><input type="number" style={fieldInput} value={d.maxConcurrency ?? ''} onChange={(e) => onChange({ maxConcurrency: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="3" /></Field>
                <p style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: -4 }}>Runs once per item (max 50). Use <code>{'{{item}}'}</code> for the current item (or <code>{'{{item.url}}'}</code> if items are objects) and <code>{'{{index}}'}</code>. Returns a list of results — reference it as <code>{'{{nodes.id.results}}'}</code>.</p>
            </>)}

            {(kind === 'gate.if' || kind === 'gate.filter') && (<>
                <Field label="Value to check"><TemplInput value={cond.left || ''} onChange={(v) => setCond({ left: v })} placeholder="{{last}} — or text/a value" /></Field>
                <Field label="Operator">
                    <select style={fieldInput} value={cond.op || '=='} onChange={(e) => setCond({ op: e.target.value })}>
                        {COND_OP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </Field>
                {(cond.op !== 'empty' && cond.op !== 'not_empty') && (
                    <Field label="Compare to"><TemplInput value={cond.right || ''} onChange={(v) => setCond({ right: v })} placeholder="value to compare against" /></Field>
                )}
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>
                    Leave <b>Value to check</b> blank to test the previous node's output. {kind === 'gate.if' ? 'Wire the "true" / "false" handles to branches.' : 'Continues down "out" only when true.'}
                </p>
            </>)}

            {kind === 'gate.switch' && (() => {
                const cases = Array.isArray(d.cases) ? d.cases : [];
                const setCase = (i, patch) => onChange({ cases: cases.map((c, idx) => idx === i ? { op: c.op || '==', value: (c.value ?? c.equals ?? ''), handle: c.handle || '', ...patch } : c) });
                const addCase = () => onChange({ cases: [...cases, { op: '==', value: '', handle: '' }] });
                const removeCase = (i) => onChange({ cases: cases.filter((_, idx) => idx !== i) });
                return (<>
                    <Field label="Value to check"><TemplInput value={d.value || ''} onChange={(v) => onChange({ value: v })} placeholder="{{last}} — value to route on" /></Field>
                    <label style={fieldLabel}>Cases</label>
                    {cases.map((c, i) => (
                        <div key={i} style={{ border: '1px solid var(--rule-2)', borderRadius: 8, padding: 8, marginBottom: 8, background: 'var(--bg)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <select style={{ ...fieldInput, marginBottom: 0, flex: 1 }} value={c.op || '=='} onChange={(e) => setCase(i, { op: e.target.value })}>
                                    {SWITCH_OP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                                <button onClick={() => removeCase(i)} title="Remove case" style={{ flexShrink: 0, width: 28, height: 28, padding: 0, border: '1px solid var(--rule-2)', borderRadius: 6, background: 'transparent', color: 'var(--ink-3)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
                            </div>
                            <TemplInput value={(c.value ?? c.equals ?? '')} onChange={(v) => setCase(i, { value: v })} placeholder="value to match" style={{ marginBottom: 6 }} />
                            <TemplInput value={c.handle || ''} onChange={(v) => setCase(i, { handle: v })} placeholder="route label (defaults to the value)" style={{ marginBottom: 0 }} />
                        </div>
                    ))}
                    <button onClick={addCase} style={{ ...railBtn, justifyContent: 'center', marginBottom: 8 }}>+ Add case</button>
                    <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Each case routes to its own handle on the node; anything unmatched takes the "default" handle.</p>
                </>);
            })()}

            {kind === 'trigger.schedule' && <ScheduleConfig d={d} onChange={onChange} />}

            {kind === 'trigger.event' && (
                <Field label="Event name"><input style={fieldInput} value={d.event || ''} onChange={(e) => onChange({ event: e.target.value })} placeholder="model.loaded" /></Field>
            )}

            {kind === 'trigger.telegram' && (<>
                <Field label="Bot token"><TemplInput value={d.botToken || ''} onChange={(v) => onChange({ botToken: v })} placeholder="123456:ABC-DEF…" /></Field>
                <Field label="Chat ID filter (optional)"><TemplInput value={d.chatId || ''} onChange={(v) => onChange({ chatId: v })} placeholder="only this chat id / @channel" /></Field>
                <Field label="Keyword (optional)"><TemplInput value={d.keyword || ''} onChange={(v) => onChange({ keyword: v })} placeholder="fire only when the text matches" /></Field>
                <Field label="Match">
                    <select style={fieldInput} value={d.match || 'contains'} onChange={(e) => onChange({ match: e.target.value })}>
                        {['contains', 'equals', 'startsWith', 'regex'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Polls every ~15s via getUpdates — save and keep the automation enabled. The message is the run input: use <code>{'{{input.text}}'}</code>, <code>{'{{input.chat.id}}'}</code>, <code>{'{{input.from.username}}'}</code>. Use one automation per bot token (multiple pollers on the same bot conflict).</p>
            </>)}

            {kind === 'trigger.slack' && (<>
                <Field label="Bot token (xoxb-…)"><TemplInput value={d.botToken || ''} onChange={(v) => onChange({ botToken: v })} placeholder="xoxb-…" /></Field>
                <Field label="Channel ID"><TemplInput value={d.channel || ''} onChange={(v) => onChange({ channel: v })} placeholder="e.g. C0123456789" /></Field>
                <Field label="Keyword filter (optional)"><TemplInput value={d.keyword || ''} onChange={(v) => onChange({ keyword: v })} placeholder="fire only when the text matches" /></Field>
                <Field label="Match">
                    <select style={fieldInput} value={d.match || 'contains'} onChange={(e) => onChange({ match: e.target.value })}>
                        {['contains', 'equals', 'startsWith', 'regex'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>The bot must be in the channel and have the <code>channels:history</code> scope. The message is the run input: use <code>{'{{input.text}}'}</code>, <code>{'{{input.user}}'}</code>, <code>{'{{input.channel}}'}</code>.</p>
            </>)}

            {kind === 'trigger.webhook' && (<>
                <button onClick={onGenWebhook} style={{ ...railBtn, justifyContent: 'center', marginBottom: 8 }}>Generate webhook URL</button>
                {webhookUrl && (
                    <div style={{ fontSize: 10.5, color: 'var(--ink-2)', wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--rule-2)', borderRadius: 6, padding: 8 }}>
                        {webhookUrl}
                        <button onClick={onCopyWebhook} style={{ ...railBtn, width: 'auto', padding: '4px 8px', marginTop: 6 }}>
                            {copied ? <Check size={12} /> : <Copy size={12} />} <span>{copied ? 'Copied' : 'Copy'}</span>
                        </button>
                    </div>
                )}
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 8 }}>POST to this URL to trigger the workflow; the request body becomes the run input. Save the automation and keep it enabled.</p>
            </>)}

            {!isTrigger && kind !== 'output' && kind !== 'merge' && !String(kind).startsWith('gate.') && (() => {
                const fwd = d.forward || '';
                const hasFwd = !!fwd.trim();
                let preview = null;
                if (hasFwd) {
                    const scope = { nodes: {}, last: lastRun && lastRun.output, input: {} };
                    for (const id of Object.keys(allOutputs)) scope.nodes[id] = allOutputs[id] && allOutputs[id].output;
                    try { preview = previewInterpolate(fwd, scope); } catch (_) { preview = null; }
                }
                const haveData = Object.keys(allOutputs).length > 0;
                return (
                    <div style={{ marginTop: 14, borderTop: '1px solid var(--rule-2)', paddingTop: 10 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Output → next node</div>
                        <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginBottom: 6 }}>
                            Type any text and insert data tags anywhere. Use <code>{'{{last}}'}</code> for this step's whole output, or <code>{'{{field}}'}</code> for one of its fields (e.g. <code>{'{{title}}'}</code>). Leave blank to send the whole output.
                        </div>
                        <TemplTextarea registerAsDefault style={{ minHeight: 56, fontFamily: 'inherit', fontSize: 13.5, resize: 'vertical' }} value={fwd} onChange={(v) => onChange({ forward: v })} placeholder={'e.g.  Top results:\n{{nodes.id.results.*.url}}'} />
                        {hasFwd ? (
                            <div style={{ marginTop: 5 }}>
                                <div style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 3 }}>
                                    Sends to next node{haveData ? '' : ' (run once to fill in tag values)'}:
                                </div>
                                <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--rule-2)', borderRadius: 6, padding: 8 }}>{preview === '' ? '(empty)' : preview}</pre>
                                <button onClick={() => onChange({ forward: '' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 10.5, padding: 0, marginTop: 4 }}>
                                    ↺ reset to send everything
                                </button>
                            </div>
                        ) : (
                            <div style={{ fontSize: 10.5, color: 'var(--ink-2)', marginTop: 5 }}>→ Sending the entire output</div>
                        )}
                    </div>
                );
            })()}
        </div>
        </FieldInsertContext.Provider>
    );
}

// JSON editor field with inline validity feedback.
function JsonField({ value, onChange, placeholder }) {
    const [text, setText] = useState(() => value == null ? '' : JSON.stringify(value, null, 2));
    const [err, setErr] = useState(false);
    const elRef = useRef(null);
    const ctx = React.useContext(FieldInsertContext);
    // Apply new text + reparse. Wrapped in a ref so click-to-insert data tags can
    // drop {{...}} into the JSON args (e.g. {"url": "{{nodes.id.results.0.url}}"}).
    const applyText = (t) => {
        setText(t);
        if (!t.trim()) { setErr(false); onChange(undefined); return; }
        try { const parsed = JSON.parse(t); setErr(false); onChange(parsed); }
        catch { setErr(true); }
    };
    const onChangeRef = useRef(applyText); onChangeRef.current = applyText;
    return (
        <>
            <textarea
                ref={elRef}
                style={{ ...fieldInput, minHeight: 70, fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical', borderColor: err ? 'var(--danger, #ef4444)' : 'var(--rule-2)' }}
                value={text}
                placeholder={placeholder || '{}'}
                onFocus={() => { if (ctx) ctx.setActive({ el: elRef.current, onChangeRef }); }}
                onChange={(e) => applyText(e.target.value)}
                {...makeDropHandlers(elRef, onChangeRef)}
            />
            {err && <div style={{ fontSize: 10, color: 'var(--danger, #ef4444)', marginTop: -6, marginBottom: 8 }}>Invalid JSON</div>}
        </>
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
                        {artifacts.map((a, i) => (
                            <a key={i} href={a.url} download={a.name} target="_blank" rel="noopener noreferrer"
                               style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--accent)', textDecoration: 'none', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 9px', margin: '0 6px 6px 0', background: 'var(--accent-soft)' }}>
                                <Download size={12} /> {a.name}{a.size ? <span style={{ color: 'var(--ink-3)', fontSize: 9.5 }}>{` · ${a.size < 1024 ? a.size + ' B' : Math.round(a.size / 1024) + ' KB'}`}</span> : null}
                            </a>
                        ))}
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
                <button onClick={onClearHistory} style={{ ...railBtn, justifyContent: 'center', marginBottom: 10, color: 'var(--danger, #ef4444)', borderColor: 'var(--rule-2)' }}>
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
