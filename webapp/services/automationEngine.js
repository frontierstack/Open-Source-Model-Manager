// In-process DAG executor for workflow automations.
//
// A workflow is { nodes: [...], edges: [...] }. Nodes carry a `type` and a
// `data` blob; edges connect node output handles to input handles. The engine
// walks the graph from its entry node(s), runs each node's handler, threads
// outputs into a shared scope, and prunes branches that an if/else gate
// doesn't take.
//
// It is intentionally dependency-light and decoupled from server.js: the
// host injects the capabilities it needs (`runModelCompletion`,
// `executeToolCall`) via `deps`, and receives live status via `onEvent`. That
// keeps the engine unit-testable without booting the whole server.
//
// Telegram trigger/connector nodes are deliberately NOT implemented yet
// (planned for a later phase) — a `telegram.*` node fails fast with a clear
// "not implemented" error rather than silently passing through.

// ---------------------------------------------------------------------------
// Built-in node-type catalog (drives the editor palette + validation).
// User-authored node-types (from node-types.json) are layered on top by the
// API; these are the primitives the executor understands natively.
// ---------------------------------------------------------------------------
const BUILTIN_NODE_TYPES = [
    // Triggers (entry points; emit the run input as their output)
    { type: 'trigger.manual',   category: 'trigger',   label: 'Manual / Run now', description: 'Starts the workflow when run manually.', outputs: ['out'] },
    { type: 'trigger.webhook',  category: 'trigger',   label: 'Inbound Webhook',  description: 'Starts when its webhook URL is called. (Wiring added in Phase 2.)', outputs: ['out'] },
    { type: 'trigger.schedule', category: 'trigger',   label: 'Schedule',         description: 'Starts on a cron/interval. (Scheduler added in Phase 2.)', outputs: ['out'] },
    { type: 'trigger.event',    category: 'trigger',   label: 'On Event',         description: 'Starts on a system event (model loaded, etc). (Phase 2.)', outputs: ['out'] },

    // Connectors (do work)
    { type: 'model',      category: 'connector', label: 'Model / LLM call', description: 'Runs a prompt through a loaded model.', inputs: ['in'], outputs: ['out'], fields: ['prompt', 'systemPrompt', 'model', 'temperature', 'maxTokens'] },
    { type: 'tool',       category: 'connector', label: 'Run Tool / Skill', description: 'Invokes any enabled skill or native tool by name.', inputs: ['in'], outputs: ['out'], fields: ['tool', 'args'] },
    { type: 'web_search', category: 'connector', label: 'Web Search',        description: 'Searches the web (DuckDuckGo → Brave fallback).', inputs: ['in'], outputs: ['out'], fields: ['query', 'limit'] },
    { type: 'fetch_url',  category: 'connector', label: 'Fetch URL',         description: 'Fetches and extracts the content of a URL.', inputs: ['in'], outputs: ['out'], fields: ['url', 'maxLength'] },
    { type: 'http_request', category: 'connector', label: 'HTTP Request',    description: 'Calls an HTTP endpoint (SSRF-guarded). (Phase 2 connector.)', inputs: ['in'], outputs: ['out'], fields: ['url', 'method', 'headers', 'body'] },
    { type: 'delay',      category: 'connector', label: 'Delay / Wait',      description: 'Pauses the workflow for N milliseconds.', inputs: ['in'], outputs: ['out'], fields: ['ms'] },
    { type: 'set',        category: 'connector', label: 'Set Variable',      description: 'Stores a value in the run scope for later nodes.', inputs: ['in'], outputs: ['out'], fields: ['name', 'value'] },

    // Logic gates
    { type: 'gate.if',     category: 'gate', label: 'If / Else',  description: 'Branches on a condition.', inputs: ['in'], outputs: ['true', 'false'], fields: ['condition'] },
    { type: 'gate.switch', category: 'gate', label: 'Switch',     description: 'N-way branch on a value. (Phase 2.)', inputs: ['in'], outputs: ['default'], fields: ['value', 'cases'] },

    // Terminal
    { type: 'output', category: 'output', label: 'Output / End', description: 'Marks a workflow result.', inputs: ['in'] },
];

const MAX_DELAY_MS = 5 * 60 * 1000; // a delay node can wait at most 5 minutes

// ---------------------------------------------------------------------------
// Scope + templating helpers
// ---------------------------------------------------------------------------

// Resolve a dotted path ("nodes.fetch.text", "results.0.title") against scope.
function resolvePath(scope, pathStr) {
    const parts = String(pathStr).trim().split('.').filter(Boolean);
    let cur = scope;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

// Interpolate {{ path }} references in a template.
//   - A string that is EXACTLY "{{ path }}" returns the raw resolved value
//     (preserving objects/numbers/booleans).
//   - Embedded references are stringified into the surrounding text.
//   - Objects/arrays are deep-mapped.
function interpolate(template, scope) {
    if (typeof template === 'string') {
        const exact = template.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
        if (exact) {
            const val = resolvePath(scope, exact[1]);
            return val === undefined ? '' : val;
        }
        return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
            const val = resolvePath(scope, path);
            if (val === undefined || val === null) return '';
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        });
    }
    if (Array.isArray(template)) return template.map(t => interpolate(t, scope));
    if (template && typeof template === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(template)) out[k] = interpolate(v, scope);
        return out;
    }
    return template;
}

function toComparable(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

function truthy(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'object') return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
    const s = String(v).trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== '0' && s !== 'null' && s !== 'undefined' && s !== 'no';
}

// Evaluate a gate condition WITHOUT eval(). Accepts:
//   - a string  → interpolated, then truthiness-tested
//   - an object { left, op, right } → interpolated operands compared by op
function evalCondition(condition, scope) {
    if (condition == null) return false;
    if (typeof condition === 'string') {
        return truthy(interpolate(condition, scope));
    }
    if (typeof condition === 'object') {
        const left = interpolate(condition.left, scope);
        const right = interpolate(condition.right, scope);
        const op = String(condition.op || '==').trim();
        const ls = toComparable(left), rs = toComparable(right);
        switch (op) {
            case '==': case 'eq':           return String(ls) === String(rs);
            case '!=': case 'ne':           return String(ls) !== String(rs);
            case '>':  case 'gt':           { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a > b; }
            case '<':  case 'lt':           { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a < b; }
            case '>=': case 'gte':          { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a >= b; }
            case '<=': case 'lte':          { const a = asNumber(ls), b = asNumber(rs); return a !== null && b !== null && a <= b; }
            case 'contains':                return String(ls).includes(String(rs));
            case 'not_contains':            return !String(ls).includes(String(rs));
            case 'startsWith':              return String(ls).startsWith(String(rs));
            case 'endsWith':                return String(ls).endsWith(String(rs));
            case 'matches':                 { try { return new RegExp(String(rs)).test(String(ls)); } catch { return false; } }
            case 'empty':                   return !truthy(left);
            case 'not_empty': case 'truthy':return truthy(left);
            default:                        return false;
        }
    }
    return truthy(condition);
}

// ---------------------------------------------------------------------------
// Node handlers
// ---------------------------------------------------------------------------

async function runNode(node, scope, deps, ctx) {
    const type = node.type || 'output';
    const data = interpolate(node.data || {}, scope);

    // Triggers simply surface the run input as their output.
    if (type.startsWith('trigger.')) {
        return scope.input ?? {};
    }

    if (type.startsWith('telegram.')) {
        throw new Error('Telegram nodes are not implemented yet (planned for a later phase).');
    }

    switch (type) {
        case 'model': {
            if (!deps.runModelCompletion) throw new Error('Model nodes are unavailable (no model runner wired).');
            const messages = [];
            if (data.systemPrompt) messages.push({ role: 'system', content: String(data.systemPrompt) });
            messages.push({ role: 'user', content: String(data.prompt ?? '') });
            const text = await deps.runModelCompletion({
                messages,
                model: data.model || undefined,
                temperature: data.temperature != null ? Number(data.temperature) : undefined,
                maxTokens: data.maxTokens != null ? Number(data.maxTokens) : undefined,
                userId: ctx.userId,
            });
            return { text };
        }

        case 'tool':
        case 'web_search':
        case 'fetch_url': {
            if (!deps.executeToolCall) throw new Error('Tool nodes are unavailable (no tool dispatcher wired).');
            let toolName, args;
            if (type === 'web_search') {
                toolName = 'web_search';
                args = { query: data.query ?? '', limit: data.limit != null ? Number(data.limit) : 5 };
            } else if (type === 'fetch_url') {
                toolName = 'fetch_url';
                args = { url: data.url ?? '', maxLength: data.maxLength != null ? Number(data.maxLength) : undefined };
            } else {
                toolName = data.tool;
                if (!toolName) throw new Error('Tool node is missing a `tool` name.');
                args = (data.args && typeof data.args === 'object') ? data.args : {};
            }
            const msg = await deps.executeToolCall(
                { id: `auto-${node.id}`, function: { name: toolName, arguments: JSON.stringify(args) } },
                { userId: ctx.userId, apiKeyData: ctx.apiKeyData, conversationId: null, workspaceBucket: ctx.workspaceBucket }
            );
            let parsed;
            try { parsed = JSON.parse(msg.content); } catch { parsed = { raw: msg.content }; }
            return parsed;
        }

        case 'delay': {
            const ms = Math.max(0, Math.min(MAX_DELAY_MS, Number(data.ms) || 0));
            if (ms > 0) await new Promise(r => setTimeout(r, ms));
            return scope.last ?? {};
        }

        case 'set': {
            const name = data.name;
            if (name) scope.vars[name] = data.value;
            return { [name || 'value']: data.value };
        }

        case 'gate.if': {
            const result = evalCondition(node.data ? node.data.condition : null, scope);
            return { result, _handle: result ? 'true' : 'false' };
        }

        case 'output':
        case 'note':
            return scope.last ?? data ?? {};

        default:
            // Unknown type → treat as a passthrough so user-authored node-types
            // that the executor doesn't specially handle don't hard-fail.
            return { ...data };
    }
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

// runWorkflow(workflow, { input, deps, onEvent, ctx, signal })
//   workflow : { nodes:[{id,type,data}], edges:[{id,source,target,sourceHandle?,targetHandle?}] }
//   input    : payload made available as {{input.*}} (trigger output)
//   deps     : { runModelCompletion, executeToolCall }
//   onEvent  : (evt) => void   — { type, ... } status events for SSE/WS
//   ctx      : { userId, apiKeyData, workspaceBucket }
//   signal   : optional AbortSignal to cancel mid-run
// returns { status:'completed'|'failed', result, error, timeline:[...] }
async function runWorkflow(workflow, opts = {}) {
    const { input = {}, deps = {}, onEvent = () => {}, ctx = {}, signal = null } = opts;
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const outgoing = new Map(nodes.map(n => [n.id, []]));
    const incoming = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
        if (outgoing.has(e.source)) outgoing.get(e.source).push(e);
        if (incoming.has(e.target)) incoming.get(e.target).push(e);
    }

    const nodeState = new Map(nodes.map(n => [n.id, 'pending'])); // pending|running|done|skipped
    const edgeState = new Map(edges.map(e => [e.id ?? `${e.source}->${e.target}:${e.sourceHandle || ''}`, 'pending'])); // pending|active|pruned
    const edgeKey = (e) => e.id ?? `${e.source}->${e.target}:${e.sourceHandle || ''}`;

    const scope = { input, vars: {}, nodes: {}, last: input };
    const timeline = [];

    const isResolved = (e) => edgeState.get(edgeKey(e)) !== 'pending';
    const isActive = (e) => edgeState.get(edgeKey(e)) === 'active';

    const aborted = () => signal && signal.aborted;

    onEvent({ type: 'run_start', nodeCount: nodes.length });

    let result = null;
    const stepCap = nodes.length * 3 + 20; // guard against cycles / no-progress loops
    let steps = 0;

    try {
        while (steps++ < stepCap) {
            if (aborted()) throw new Error('aborted');

            // 1. Skip any node whose every incoming edge is resolved-and-pruned.
            let changed = false;
            for (const n of nodes) {
                if (nodeState.get(n.id) !== 'pending') continue;
                const inc = incoming.get(n.id);
                if (inc.length === 0) continue; // entry node — never auto-skipped
                if (inc.every(isResolved) && !inc.some(isActive)) {
                    nodeState.set(n.id, 'skipped');
                    for (const e of outgoing.get(n.id)) edgeState.set(edgeKey(e), 'pruned');
                    changed = true;
                }
            }

            // 2. Find a runnable node: entry (no incoming) OR all incoming
            //    resolved with at least one active.
            const runnable = nodes.find(n => {
                if (nodeState.get(n.id) !== 'pending') return false;
                const inc = incoming.get(n.id);
                if (inc.length === 0) return true;
                return inc.every(isResolved) && inc.some(isActive);
            });

            if (!runnable) {
                if (changed) continue; // pruning may have unblocked something
                break;                 // nothing left to do
            }

            // 3. Run it.
            const node = runnable;
            nodeState.set(node.id, 'running');
            const startedAt = new Date().toISOString();
            const entry = { nodeId: node.id, type: node.type, label: (node.data && node.data.label) || node.type, status: 'running', startedAt, finishedAt: null };
            timeline.push(entry);
            onEvent({ type: 'node_start', nodeId: node.id, nodeType: node.type });

            let output;
            try {
                output = await runNode(node, scope, deps, ctx);
            } catch (err) {
                entry.status = 'failed';
                entry.finishedAt = new Date().toISOString();
                entry.error = err.message || String(err);
                onEvent({ type: 'node_finish', nodeId: node.id, status: 'failed', error: entry.error });
                throw new Error(`Node "${entry.label}" (${node.type}) failed: ${entry.error}`);
            }

            nodeState.set(node.id, 'done');
            scope.nodes[node.id] = output;
            scope.last = output;
            result = output;
            entry.status = 'completed';
            entry.finishedAt = new Date().toISOString();
            entry.output = summarizeOutput(output);
            onEvent({ type: 'node_finish', nodeId: node.id, status: 'completed', output: entry.output });

            // 4. Activate/prune outgoing edges.
            const chosenHandle = (node.type === 'gate.if') ? output._handle : null;
            for (const e of outgoing.get(node.id)) {
                let active = true;
                if (chosenHandle != null && e.sourceHandle != null) {
                    active = (e.sourceHandle === chosenHandle);
                }
                edgeState.set(edgeKey(e), active ? 'active' : 'pruned');
                if (active) onEvent({ type: 'edge_active', edgeId: e.id, source: e.source, target: e.target });
            }
        }

        onEvent({ type: 'run_finish', status: 'completed' });
        return { status: 'completed', result, error: null, timeline };
    } catch (err) {
        const message = err.message === 'aborted' ? 'Run cancelled' : (err.message || String(err));
        onEvent({ type: 'run_finish', status: 'failed', error: message });
        return { status: 'failed', result, error: message, timeline };
    }
}

// Keep persisted/streamed node outputs from ballooning — cap large blobs.
function summarizeOutput(output) {
    try {
        const s = JSON.stringify(output);
        if (s.length <= 4000) return output;
        return { _truncated: true, preview: s.slice(0, 4000) + '…' };
    } catch {
        return { _unserializable: true };
    }
}

module.exports = {
    runWorkflow,
    evalCondition,
    interpolate,
    BUILTIN_NODE_TYPES,
};
