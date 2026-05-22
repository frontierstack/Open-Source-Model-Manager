import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './automation.css';
import {
    ArrowLeft, Plus, Play, Square, Save, Trash2, Archive, ArchiveRestore,
    Power, PowerOff, Copy, Check,
} from 'lucide-react';
import { useChatStore } from '../../stores/useChatStore';
import AutomationNode from './AutomationNode';

const nodeTypes = { automation: AutomationNode };

const uid = (p = 'n') => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const CATEGORY_ORDER = ['trigger', 'connector', 'gate', 'output'];
const CATEGORY_LABEL = { trigger: 'Triggers', connector: 'Connectors', gate: 'Logic Gates', output: 'Output' };
const COND_OPS = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'not_contains', 'startsWith', 'endsWith', 'matches', 'empty', 'not_empty'];

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
const fieldLabel = { fontSize: 11, color: 'var(--ink-3, var(--ink-2))', marginBottom: 3, display: 'block', fontWeight: 500 };
const fieldInput = {
    width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--rule-2)',
    background: 'var(--bg)', color: 'var(--ink)', fontSize: 12.5, marginBottom: 10, boxSizing: 'border-box',
};

function FlowEditor({ showSnackbar }) {
    const setView = useChatStore(s => s.setView);

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
    const runAbortRef = useRef(null);
    const addCountRef = useRef(0);

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
                ...(builtins || []).map(b => ({ key: b.key || b.type, kind: b.type, label: b.label, category: b.category, defaults: b.defaults || {}, custom: false })),
                ...(custom || []).filter(c => c.enabled !== false).map(c => ({ key: c.id, kind: c.baseType || 'tool', label: c.name, category: c.category, defaults: c.defaults || {}, custom: true })),
            ];
            setPalette(pal);
            await loadAutomations();
        })();
    }, [loadAutomations]);

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
            addCountRef.current = n.length;
        } catch (err) { notify(err.message, 'error'); }
    }, [labelFor, setNodes, setEdges]);

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

    // ---- graph edits ----
    const onConnect = useCallback((params) => {
        setEdges(eds => addEdge({ ...params, id: uid('e') }, eds));
        setDirty(true);
    }, [setEdges]);

    const addFromPalette = useCallback((item) => {
        const id = uid('node');
        const i = addCountRef.current++;
        const position = { x: 240 + (i % 5) * 36, y: 110 + (i % 8) * 70 };
        setNodes(ns => ns.concat({
            id, type: 'automation', position,
            data: { kind: item.kind, label: item.label, ...(item.defaults || {}) },
        }));
        setSelectedNodeId(id);
        setDirty(true);
    }, [setNodes]);

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
        if (!window.confirm('Delete this automation?')) return;
        try {
            await fetch(`/api/automations/${id}`, { method: 'DELETE', credentials: 'include' });
            if (selected && selected.id === id) { setSelected(null); setNodes([]); setEdges([]); }
            loadAutomations();
        } catch (err) { notify(err.message, 'error'); }
    }, [selected, loadAutomations, setNodes, setEdges]);

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
    }, [setNodes, setEdges]);

    const handleRunEvent = useCallback((evt) => {
        switch (evt.type) {
            case 'run_created': setRunId(evt.runId); break;
            case 'node_start':
                setNodes(ns => ns.map(n => n.id === evt.nodeId ? { ...n, data: { ...n.data, status: 'running' } } : n));
                break;
            case 'node_finish':
                setNodes(ns => ns.map(n => n.id === evt.nodeId ? { ...n, data: { ...n.data, status: evt.status } } : n));
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

    const onNodeClick = useCallback((_e, node) => setSelectedNodeId(node.id), []);
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
                <div style={{ width: 230, borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
                    <div style={{ padding: 10, borderBottom: '1px solid var(--rule)' }}>
                        <button onClick={newAutomation} style={{ ...railBtn, justifyContent: 'center', color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                            <Plus size={14} /> <span>New automation</span>
                        </button>
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
                    <div style={{ overflowY: 'auto', flex: 1, padding: '0 8px 10px', opacity: selected ? 1 : 0.5, pointerEvents: selected ? 'auto' : 'none' }}>
                        {CATEGORY_ORDER.map(cat => (groupedPalette[cat] && groupedPalette[cat].length > 0) && (
                            <div key={cat} style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 10, color: 'var(--ink-3)', margin: '6px 2px 4px', textTransform: 'uppercase', letterSpacing: 0.4 }}>{CATEGORY_LABEL[cat] || cat}</div>
                                {groupedPalette[cat].map(item => (
                                    <button key={item.key} onClick={() => addFromPalette(item)}
                                        style={{ ...railBtn, padding: '6px 8px', marginBottom: 3, fontSize: 12 }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-soft)'; e.currentTarget.style.color = 'var(--accent)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-2)'; }}
                                        title={item.custom ? 'Custom building block' : 'Built-in'}
                                    >
                                        <Plus size={12} /> <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
                                        {item.custom && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--accent)' }}>★</span>}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Canvas */}
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                    {!selected ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ink-3)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                            Select an automation on the left, or create a new one to start building a workflow.
                        </div>
                    ) : (
                        <ReactFlow
                            className="automation-flow"
                            nodes={nodes}
                            edges={edges}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onNodeClick={onNodeClick}
                            onPaneClick={onPaneClick}
                            nodeTypes={nodeTypes}
                            fitView
                            deleteKeyCode={['Backspace', 'Delete']}
                            proOptions={{ hideAttribution: true }}
                        >
                            <Background gap={18} size={1} />
                            <Controls />
                            <MiniMap pannable zoomable style={{ width: 130, height: 90 }} />
                        </ReactFlow>
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
                {selectedNode && (
                    <NodeConfig
                        key={selectedNode.id}
                        node={selectedNode}
                        onChange={(patch) => updateNodeData(selectedNode.id, patch)}
                        onDelete={deleteSelectedNode}
                        webhookUrl={webhookUrl}
                        onGenWebhook={genWebhook}
                        copied={copied}
                        onCopyWebhook={() => { navigator.clipboard?.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    />
                )}
            </div>
        </div>
    );
}

// ---- per-node config panel ----
function NodeConfig({ node, onChange, onDelete, webhookUrl, onGenWebhook, copied, onCopyWebhook }) {
    const kind = node.data.kind;
    const d = node.data;
    const cond = (d.condition && typeof d.condition === 'object') ? d.condition : { left: '', op: '==', right: '' };
    const setCond = (patch) => onChange({ condition: { ...cond, ...patch } });

    const Field = ({ label, children }) => (
        <div><label style={fieldLabel}>{label}</label>{children}</div>
    );

    return (
        <div style={{ width: 270, borderLeft: '1px solid var(--rule)', flexShrink: 0, overflowY: 'auto', padding: 12, background: 'var(--surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 12.5 }}>{kind}</span>
                <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger, #ef4444)', display: 'flex' }} title="Delete node"><Trash2 size={15} /></button>
            </div>

            <Field label="Label"><input style={fieldInput} value={d.label || ''} onChange={(e) => onChange({ label: e.target.value })} /></Field>

            {kind === 'model' && (<>
                <Field label="Prompt"><textarea style={{ ...fieldInput, minHeight: 80, fontFamily: 'inherit', resize: 'vertical' }} value={d.prompt || ''} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="Use {{input.x}} or {{nodes.id.text}}" /></Field>
                <Field label="System prompt"><textarea style={{ ...fieldInput, minHeight: 48, resize: 'vertical' }} value={d.systemPrompt || ''} onChange={(e) => onChange({ systemPrompt: e.target.value })} /></Field>
                <Field label="Model (blank = current)"><input style={fieldInput} value={d.model || ''} onChange={(e) => onChange({ model: e.target.value })} /></Field>
                <Field label="Temperature"><input type="number" step="0.1" style={fieldInput} value={d.temperature ?? ''} onChange={(e) => onChange({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
                <Field label="Max tokens"><input type="number" style={fieldInput} value={d.maxTokens ?? ''} onChange={(e) => onChange({ maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'tool' && (<>
                <Field label="Tool / skill name"><input style={fieldInput} value={d.tool || ''} onChange={(e) => onChange({ tool: e.target.value })} placeholder="e.g. query_sqlite" /></Field>
                <Field label="Arguments (JSON)"><JsonField value={d.args} onChange={(v) => onChange({ args: v })} /></Field>
            </>)}

            {kind === 'web_search' && (<>
                <Field label="Query"><input style={fieldInput} value={d.query || ''} onChange={(e) => onChange({ query: e.target.value })} /></Field>
                <Field label="Limit"><input type="number" style={fieldInput} value={d.limit ?? ''} onChange={(e) => onChange({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'fetch_url' && (<>
                <Field label="URL"><input style={fieldInput} value={d.url || ''} onChange={(e) => onChange({ url: e.target.value })} /></Field>
                <Field label="Max length"><input type="number" style={fieldInput} value={d.maxLength ?? ''} onChange={(e) => onChange({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'delay' && (
                <Field label="Delay (ms)"><input type="number" style={fieldInput} value={d.ms ?? ''} onChange={(e) => onChange({ ms: Number(e.target.value) })} /></Field>
            )}

            {kind === 'set' && (<>
                <Field label="Variable name"><input style={fieldInput} value={d.name || ''} onChange={(e) => onChange({ name: e.target.value })} /></Field>
                <Field label="Value"><input style={fieldInput} value={d.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} placeholder="Supports {{...}}" /></Field>
            </>)}

            {(kind === 'gate.if' || kind === 'gate.filter') && (<>
                <Field label="Left (supports {{...}})"><input style={fieldInput} value={cond.left || ''} onChange={(e) => setCond({ left: e.target.value })} /></Field>
                <Field label="Operator">
                    <select style={fieldInput} value={cond.op || '=='} onChange={(e) => setCond({ op: e.target.value })}>
                        {COND_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                </Field>
                <Field label="Right"><input style={fieldInput} value={cond.right || ''} onChange={(e) => setCond({ right: e.target.value })} /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>
                    {kind === 'gate.if' ? 'Wire the "true" / "false" handles to branches.' : 'Continues down "out" only when true.'}
                </p>
            </>)}

            {kind === 'gate.switch' && (<>
                <Field label="Value (supports {{...}})"><input style={fieldInput} value={d.value || ''} onChange={(e) => onChange({ value: e.target.value })} /></Field>
                <Field label="Cases (JSON)"><JsonField value={d.cases} onChange={(v) => onChange({ cases: v })} placeholder='[{"equals":"a","handle":"a"}]' /></Field>
                <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: -4 }}>Unmatched routes to the "default" handle.</p>
            </>)}

            {kind === 'trigger.schedule' && (<>
                <Field label="Cron (min hour dom mon dow)"><input style={fieldInput} value={d.cron || ''} onChange={(e) => onChange({ cron: e.target.value })} placeholder="0 9 * * 1-5" /></Field>
                <Field label="…or interval (ms, min 60000)"><input type="number" style={fieldInput} value={d.intervalMs ?? ''} onChange={(e) => onChange({ intervalMs: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
            </>)}

            {kind === 'trigger.event' && (
                <Field label="Event name"><input style={fieldInput} value={d.event || ''} onChange={(e) => onChange({ event: e.target.value })} placeholder="model.loaded" /></Field>
            )}

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
        </div>
    );
}

// JSON editor field with inline validity feedback.
function JsonField({ value, onChange, placeholder }) {
    const [text, setText] = useState(() => value == null ? '' : JSON.stringify(value, null, 2));
    const [err, setErr] = useState(false);
    return (
        <>
            <textarea
                style={{ ...fieldInput, minHeight: 70, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical', borderColor: err ? 'var(--danger, #ef4444)' : 'var(--rule-2)' }}
                value={text}
                placeholder={placeholder || '{}'}
                onChange={(e) => {
                    setText(e.target.value);
                    if (!e.target.value.trim()) { setErr(false); onChange(undefined); return; }
                    try { const parsed = JSON.parse(e.target.value); setErr(false); onChange(parsed); }
                    catch { setErr(true); }
                }}
            />
            {err && <div style={{ fontSize: 10, color: 'var(--danger, #ef4444)', marginTop: -6, marginBottom: 8 }}>Invalid JSON</div>}
        </>
    );
}

export default function AutomationView({ showSnackbar }) {
    return (
        <ReactFlowProvider>
            <FlowEditor showSnackbar={showSnackbar} />
        </ReactFlowProvider>
    );
}
