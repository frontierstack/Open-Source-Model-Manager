/**
 * Static validation + auto-repair for a MATERIALIZED workflow graph.
 *
 * The builder system prompt is ~8k tokens of rules; a small local model (the
 * Qwen3.6-35B-A3B that builds these) reliably skips some of them. Every skipped
 * rule produces the same class of outcome: a graph that LOOKS right in the editor
 * and "builds successfully", but is semantically dead — a template that points at
 * a node id that doesn't exist, a gate with no branch edge, a node that no edge
 * reaches, tool args at the wrong nesting level, a `{{nodes.x.data}}` on a node
 * whose output field is `.content`.
 *
 * None of that is caught anywhere today: materializeWorkflow only resolves node
 * types (silently DROPPING unknown ones) and the run-time health check can only
 * speak after a failed run — by which point the user has already been told the
 * build succeeded.
 *
 * So this module runs deterministically (no model call) right after
 * materializeWorkflow:
 *   - `repairWorkflow(wf)`  mutates the graph to fix the mechanical mistakes that
 *                           have exactly one correct interpretation.
 *   - `validateWorkflow(wf)` reports what remains, as {severity, nodeId, code, detail}.
 *
 * Findings feed three consumers: the build response (so the user sees them), the
 * repair-loop prompt (so the model fixes them against a concrete list instead of
 * guessing), and the test report.
 */

const { BUILTIN_NODE_TYPES } = require('./automationEngine');

const GATE_TYPES = new Set(['gate.if', 'gate.filter', 'gate.switch']);

// What each node type actually puts on its output object. Used to catch a
// template that reads a field the upstream node never produces — the single most
// common silent-empty bug (e.g. `{{nodes.<fetch_url>.data}}`: fetch_url returns
// `.content`, so that resolves to nothing and the model downstream gets an empty
// prompt). `null` = the output is a scalar/string (no fields to check) or a shape
// we can't predict, so we never flag it.
// Transcribed from the ACTUAL handlers (automationEngine.js) and skills
// (default-skills.json), not from prose. Getting one of these wrong flags a
// CORRECT template as broken and sends the repair loop chasing a working
// workflow, so anything uncertain is `null` (= no field check at all).
const OUTPUT_FIELDS = {
    fetch_url: ['url', 'title', 'content', 'success', 'source', 'error'],
    web_search: ['results', 'query', 'error', 'source', 'retryable'],
    parse_json: null,          // shape depends on `path`
    db_store: ['success', 'action', 'stored', 'skipped', 'total', 'new', 'table', 'db', 'error'],
    db_query: null,            // an array of rows
    track_changes: ['success', 'changed', 'firstSeen', 'diff', 'diffTruncated', 'added', 'removed',
        'addedCount', 'removedCount', 'revision', 'key', 'message', 'currentContent', 'currentHash',
        'currentLength', 'previousContent', 'previousHash', 'previousLength', 'cleared', 'reset', 'error'],
    map: ['results', 'count'],
    merge: ['items', 'count'],
    model: null,               // a plain string
    set: null,
    delay: null,
    render_html: null,
    export_file: null,
};

// Tool-backed nodes (type 'tool') keyed by data.tool.
const TOOL_OUTPUT_FIELDS = {
    parse_rss: ['success', 'feedTitle', 'count', 'items', 'error'],
    http_request: ['success', 'status', 'data', 'headers', 'contentType', 'bytes', 'binary', 'note', 'error'],
    fetch_timeseries: ['symbol', 'count', 'data', 'error'],
    chart_plot: ['success', 'file', 'workspacePath', 'data_url', 'png_base64', 'type', 'bytes', 'error'],
    create_pdf: null,          // reportlab skill: many keys (path/filename/size/pageSize/_artifacts/_pdfData…)
    html_to_pdf: null,
    create_file: ['success', 'message', 'filePath', 'size', '_artifacts', 'error'],
    run_python: null,          // sandbox runner shape varies
};

// A credential-ish field must be blank, not a placeholder. A placeholder makes the
// engine actually call the API with a bogus value and fail; blank is correctly
// recognized as "needs configuration".
const SECRET_FIELDS = new Set(['botToken', 'chatId', 'channel', 'webhookUrl', 'apiKey', 'api_key', 'token', 'secret', 'password']);
const PLACEHOLDER_RE = /^\s*(<[^>]*>|\{\{?\s*(your|my)[^}]*\}?\}|your[_\- ]?\w*|xxx+|todo|tbd|placeholder|123456:[A-Za-z\-_]+|abc-?def|insert[_\- ]?\w*|replace[_\- ]?\w*|example[_\- ]?\w*|\.\.\.+)\s*$/i;

const TPL_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function nodeKind(n) {
    if (!n) return '';
    return n.type === 'tool' ? `tool:${(n.data && n.data.tool) || '?'}` : (n.type || '');
}

function outputFieldsFor(n) {
    if (!n) return null;
    if (n.type === 'tool') {
        const t = (n.data && n.data.tool) || '';
        return Object.prototype.hasOwnProperty.call(TOOL_OUTPUT_FIELDS, t) ? TOOL_OUTPUT_FIELDS[t] : null;
    }
    return Object.prototype.hasOwnProperty.call(OUTPUT_FIELDS, n.type) ? OUTPUT_FIELDS[n.type] : null;
}

// Every {{...}} expression found anywhere in a node's data, with the JSON path we
// found it at (for a readable message).
function templatesIn(data) {
    const found = [];
    const walk = (v, path) => {
        if (typeof v === 'string') {
            let m;
            TPL_RE.lastIndex = 0;
            while ((m = TPL_RE.exec(v)) !== null) found.push({ expr: m[1].trim(), at: path, raw: m[0] });
        } else if (Array.isArray(v)) {
            v.forEach((x, i) => walk(x, `${path}[${i}]`));
        } else if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
        }
    };
    walk(data, '');
    return found;
}

// Ancestors of each node (transitive), so we can tell "references a node that
// cannot have run yet" from a legitimate upstream reference.
function ancestorMap(nodes, edges) {
    const preds = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
        if (preds.has(e.target)) preds.get(e.target).push(e.source);
    }
    const memo = new Map();
    const visit = (id, seen) => {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return new Set(); // cycle guard
        seen.add(id);
        const acc = new Set();
        for (const p of (preds.get(id) || [])) {
            acc.add(p);
            for (const a of visit(p, seen)) acc.add(a);
        }
        seen.delete(id);
        memo.set(id, acc);
        return acc;
    };
    const out = new Map();
    for (const n of nodes) out.set(n.id, visit(n.id, new Set()));
    return out;
}

// Wave depth = longest path from any trigger. The engine commits each wave's
// outputs into the run-global scope.nodes BEFORE launching the next wave, so a
// node can legitimately read ANY node that finished in an EARLIER wave — even one
// that is not its ancestor (a parallel sibling on a shorter chain). Only a
// reference to a node in the SAME or a LATER wave genuinely cannot have run.
function depthMap(nodes, edges) {
    const preds = new Map(nodes.map(n => [String(n.id), []]));
    for (const e of edges) if (preds.has(String(e.target))) preds.get(String(e.target)).push(String(e.source));
    const memo = new Map();
    const visit = (id, seen) => {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return 0;   // cycle guard
        seen.add(id);
        const ps = preds.get(id) || [];
        const d = ps.length ? 1 + Math.max(...ps.map(p => visit(p, seen))) : 0;
        seen.delete(id);
        memo.set(id, d);
        return d;
    };
    const out = new Map();
    for (const n of nodes) out.set(String(n.id), visit(String(n.id), new Set()));
    return out;
}

function reachableFromTriggers(nodes, edges) {
    const adj = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) if (adj.has(e.source)) adj.get(e.source).push(e.target);
    const seen = new Set();
    const stack = nodes.filter(n => typeof n.type === 'string' && n.type.startsWith('trigger.')).map(n => n.id);
    stack.forEach(id => seen.add(id));
    while (stack.length) {
        const cur = stack.pop();
        for (const nxt of (adj.get(cur) || [])) {
            if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
        }
    }
    return seen;
}

/**
 * Mechanical auto-repairs — only transformations with exactly ONE correct
 * interpretation. Anything ambiguous is left for validateWorkflow to report.
 * Mutates `wf` and returns a list of human-readable repair strings.
 */
function repairWorkflow(wf) {
    const fixes = [];
    const nodes = (wf && wf.nodes) || [];
    const edges = (wf && wf.edges) || [];
    const byKey = new Map();
    for (const b of BUILTIN_NODE_TYPES) byKey.set(b.key, b);

    for (const n of nodes) {
        const d = n.data || (n.data = {});

        // 1. create_file's argument is `filePath`, not `filename`. Every other file
        //    tool (create_pdf, html_to_pdf) takes a name-ish arg, so the model
        //    reaches for `filename` here too and the skill hard-fails with
        //    "filePath parameter is required". Unambiguous rename. Also default it
        //    under artifacts/ so the result is actually downloadable.
        if (n.type === 'tool' && d.tool === 'create_file' && d.args && typeof d.args === 'object') {
            const a = d.args;
            if (!a.filePath) {
                const alt = a.filename || a.outputName || a.name || a.path;
                if (typeof alt === 'string' && alt) {
                    a.filePath = /[\\/]/.test(alt) ? alt : `artifacts/${alt}`;
                    delete a.filename; delete a.outputName; delete a.name; delete a.path;
                    fixes.push(`${n.id}: create_file takes "filePath", not "filename" — set filePath:"${a.filePath}"`);
                }
            }
        }

        // 2. A map node with the TOOL NAME in `action` ("action":"fetch_url").
        //    action is only ever "tool" or "model".
        if (n.type === 'map' && typeof d.action === 'string' && d.action !== 'tool' && d.action !== 'model') {
            // Only promote a value that really names a tool — a builtin node key
            // (fetch_url, crawl…), a known tool, or a snake_case tool name. A loose
            // "any lowercase word" test would happily turn action:"each" into
            // tool:"each" and fail at dispatch instead of being reported here.
            const asTool = byKey.has(d.action)
                || Object.prototype.hasOwnProperty.call(TOOL_OUTPUT_FIELDS, d.action)
                || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(d.action);
            if (asTool) {
                if (!d.tool) d.tool = d.action;
                fixes.push(`${n.id}: map action "${d.action}" is a tool name — set action:"tool", tool:"${d.tool}"`);
                d.action = 'tool';
            }
        }
        // A map with a `tool` but no action at all.
        if (n.type === 'map' && !d.action && d.tool) {
            d.action = 'tool';
            fixes.push(`${n.id}: map had a tool but no action — set action:"tool"`);
        }
        if (n.type === 'map' && !d.action && (d.prompt || d.systemPrompt)) {
            d.action = 'model';
            fixes.push(`${n.id}: map had a prompt but no action — set action:"model"`);
        }

        // 3. Invented credential placeholders → blank. A placeholder is WORSE than
        //    blank: the engine treats it as real and the test run calls the API with
        //    it, producing a spurious failure. Blank = "needs configuration".
        for (const f of Object.keys(d)) {
            if (!SECRET_FIELDS.has(f)) continue;
            const v = d[f];
            if (typeof v === 'string' && v && PLACEHOLDER_RE.test(v)) {
                d[f] = '';
                fixes.push(`${n.id}: blanked placeholder ${f} ("${v}") — the user fills this in`);
            }
        }
    }

    // 4. A branch handle on an edge leaving a NON-gate node is a dead edge.
    //    (materializeWorkflow already does this for the build path; repeated here so
    //    repairWorkflow is safe to call on any workflow, e.g. an edited one.)
    const typeById = new Map(nodes.map(n => [String(n.id), n.type]));
    for (const e of edges) {
        if (e.sourceHandle && !GATE_TYPES.has(typeById.get(String(e.source))) && e.sourceHandle !== 'out') {
            fixes.push(`${e.source}→${e.target}: removed branch handle "${e.sourceHandle}" (only gates have branch handles; that edge would never fire)`);
            delete e.sourceHandle;
        }
    }

    // 5. A model node instructed to emit a quoted "nothing new" verdict ("If
    //    nothing significant changed, say 'No new activity'") wired STRAIGHT into
    //    telegram/slack delivers that verdict to the user on every quiet run —
    //    the exact opposite of "only notify me when there is something new"
    //    (live-reproduced on a page monitor). The fix is fully deterministic, so
    //    do it here rather than hoping a repair pass restructures the graph:
    //    insert model → gate.if({{nodes.<m>}} not_contains <sentinel>) --true-->
    //    delivery. Only fires when a quoted sentinel is extractable — a vague
    //    "respond that nothing changed" is left alone (no false-positive gates).
    const DELIVERY_TYPES = new Set(['telegram', 'slack']);
    const NOTHING_CUE_RE = /\bif\s+(?:nothing|none\b|no\s|there\s+(?:is|are)\s+no|it\s+did\s*n[o']?t)/i;
    const SENTINEL_RE = /(?:say|reply|respond|output|return|answer|write|send|state)[^'"“”‘’\n]{0,40}['"“‘]([^'"“”‘’{}\n]{2,60})['"”’]/i;
    const idSet = new Set(nodes.map(n => String(n.id)));
    const nextId = () => {
        let i = nodes.length + 1;
        while (idSet.has(`n${i}`)) i++;
        const id = `n${i}`;
        idSet.add(id);
        return id;
    };
    const sentinelGateByModel = new Map();
    for (const e of [...edges]) {
        const src = nodes.find(n => String(n.id) === String(e.source));
        const dst = nodes.find(n => String(n.id) === String(e.target));
        if (!src || !dst || src.type !== 'model' || !DELIVERY_TYPES.has(dst.type)) continue;
        const prompt = String((src.data && src.data.prompt) || '');
        if (!NOTHING_CUE_RE.test(prompt)) continue;
        const m = SENTINEL_RE.exec(prompt);
        if (!m) continue;
        const sentinel = m[1].trim();
        if (!sentinel) continue;
        let gid = sentinelGateByModel.get(String(src.id));
        if (!gid) {
            gid = nextId();
            sentinelGateByModel.set(String(src.id), gid);
            const mid = (a, b) => ({
                x: ((a && a.x) || 0) / 2 + ((b && b.x) || 0) / 2,
                y: ((a && a.y) || 0) / 2 + ((b && b.y) || 0) / 2 + 40,
            });
            nodes.push({
                id: gid,
                type: 'gate.if',
                position: mid(src.position, dst.position),
                data: {
                    label: 'Only if new',
                    condition: { left: `{{nodes.${src.id}}}`, op: 'not_contains', right: sentinel },
                },
            });
            edges.push({ id: `e_${gid}`, source: String(src.id), target: gid, sourceHandle: null, targetHandle: null });
        }
        e.source = gid;
        e.sourceHandle = 'true';
        fixes.push(`${src.id}→${e.target}: the model's "${sentinel}" nothing-new verdict was being delivered as an alert — inserted gate.if (not_contains "${sentinel}") so quiet runs send nothing`);
    }

    return fixes;
}

/**
 * Deterministic validation of a materialized graph. Returns
 * { ok, issues: [{severity:'high'|'medium', nodeId, code, detail}] }.
 * `high` = the workflow cannot do what was asked; `medium` = suspicious.
 */
function validateWorkflow(wf) {
    const issues = [];
    const nodes = (wf && wf.nodes) || [];
    const edges = (wf && wf.edges) || [];
    const push = (severity, nodeId, code, detail) => issues.push({ severity, nodeId, code, detail });

    if (!nodes.length) {
        push('high', null, 'empty', 'the workflow has no nodes');
        return { ok: false, issues };
    }

    const ids = new Set(nodes.map(n => String(n.id)));
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const ancestors = ancestorMap(nodes, edges);
    const depths = depthMap(nodes, edges);
    const reachable = reachableFromTriggers(nodes, edges);
    const outgoing = new Map(nodes.map(n => [String(n.id), []]));
    for (const e of edges) if (outgoing.has(String(e.source))) outgoing.get(String(e.source)).push(e);

    const triggers = nodes.filter(n => typeof n.type === 'string' && n.type.startsWith('trigger.'));
    if (triggers.length === 0) push('high', null, 'no_trigger', 'no trigger node — the workflow has no entry point');
    if (triggers.length > 1) {
        push('medium', triggers[1].id, 'multi_trigger',
            `${triggers.length} trigger nodes — only one entry point runs; the extra ones are dead (${triggers.slice(1).map(t => t.id).join(', ')})`);
    }

    for (const n of nodes) {
        const id = String(n.id);
        const d = n.data || {};
        const anc = ancestors.get(id) || new Set();

        // ── Templates: dangling / self / not-upstream / unknown output field ──
        for (const { expr, at } of templatesIn(d)) {
            const m = /^nodes\.([A-Za-z0-9_\-]+)(?:\.(.*))?$/.exec(expr);
            if (!m) continue;
            const refId = m[1];
            const field = (m[2] || '').split('.')[0].replace(/\[\d+\]$/, '');

            if (!ids.has(refId)) {
                push('high', id, 'dangling_ref',
                    `${at ? `"${at}" ` : ''}references {{nodes.${refId}…}} but there is no node "${refId}" — it resolves to nothing, so this step gets empty input`);
                continue;
            }
            if (refId === id) {
                push('high', id, 'self_ref',
                    `${at ? `"${at}" ` : ''}references its OWN output {{nodes.${refId}…}} — that value does not exist yet when this node runs`);
                continue;
            }
            // A non-ancestor reference still RESOLVES when the referenced node runs in
            // an earlier wave (the engine commits each wave into a run-global scope
            // before launching the next). Only a same-or-later-wave node genuinely
            // cannot have produced its output yet.
            if (!anc.has(refId) && (depths.get(refId) ?? 0) >= (depths.get(id) ?? 0)) {
                push('high', id, 'not_upstream',
                    `${at ? `"${at}" ` : ''}references {{nodes.${refId}…}} but "${refId}" is not upstream of "${id}" and does not run before it, so it has not produced anything — this resolves to nothing`);
                continue;
            }
            // Field-level check against the referenced node's real output shape.
            // Skipped when the producer reshapes its own output: a `forward` template
            // or `chips` rewrite what actually lands in scope.nodes, so the declared
            // shape no longer applies and any field could be valid.
            const refNode = byId.get(refId);
            const rd = (refNode && refNode.data) || {};
            const reshaped = (typeof rd.forward === 'string' ? rd.forward.trim() !== '' : rd.forward != null)
                || (Array.isArray(rd.chips) && rd.chips.length > 0);
            const fields = reshaped ? null : outputFieldsFor(refNode);
            if (field && fields && !fields.includes(field)) {
                push('high', id, 'bad_output_field',
                    `${at ? `"${at}" ` : ''}reads ".${field}" off ${nodeKind(refNode)} node "${refId}", which outputs { ${fields.join(', ')} } — ".${field}" is always empty. Use ${fields.slice(0, 3).map(f => `.${f}`).join(' / ')}.`);
            }
        }

        // ── Reachability ──
        if (!reachable.has(id) && triggers.length) {
            push('high', id, 'unreachable', `no path from the trigger reaches "${id}" — this step never runs`);
        }

        // ── Gates must actually branch ──
        if (GATE_TYPES.has(n.type)) {
            const outs = outgoing.get(id) || [];
            if (!outs.length) {
                push('high', id, 'gate_dead_end', `${n.type} has no outgoing edge — nothing happens on either branch`);
            } else if (n.type === 'gate.if') {
                // A HANDLE-LESS edge off a gate is now routed as the POSITIVE branch
                // by the engine (POSITIVE_HANDLE), so `gate.if → telegram` with no
                // sourceHandle IS the true branch and must not be flagged. Only a gate
                // whose every outgoing edge is explicitly a NON-true handle has no
                // positive branch.
                const hasTrue = outs.some(e => e.sourceHandle === 'true' || e.sourceHandle == null);
                if (!hasTrue) {
                    push('high', id, 'gate_no_true',
                        `gate.if "${id}" has no edge on the "true" handle (${outs.map(e => `${e.sourceHandle || '(none)'}→${e.target}`).join(', ')}) — the positive branch is missing, so the workflow does nothing when the condition holds`);
                }
            } else if (n.type === 'gate.switch') {
                const cases = Array.isArray(d.cases) ? d.cases : [];
                const handles = new Set(outs.map(e => e.sourceHandle).filter(Boolean));
                for (const c of cases) {
                    if (c && c.handle && !handles.has(c.handle)) {
                        push('medium', id, 'switch_case_unwired',
                            `switch case "${c.handle}" has no outgoing edge — that branch is a dead end`);
                    }
                }
            }
        }

        // ── Model node with nothing to say ──
        if (n.type === 'model') {
            const p = `${d.prompt || ''}${d.systemPrompt || ''}`.trim();
            if (!p) {
                push('high', id, 'empty_prompt',
                    `model node "${id}" has an empty prompt — it will be handed whatever the previous node emitted (often a gate's {result:false} object) and will "explain" that to the user`);
            }
        }

        // ── db_store dedupe sanity ──
        if (n.type === 'db_store') {
            const key = typeof d.key === 'string' ? d.key.trim() : '';
            // Keying a fetch_url/track-style single-page output: the "url never
            // changes" trap — stores 1 row on run 1 and reports ZERO new forever.
            const valExpr = typeof d.value === 'string' ? d.value : '';
            const vm = /nodes\.([A-Za-z0-9_\-]+)/.exec(valExpr);
            const src = vm ? byId.get(vm[1]) : null;
            if (key && src && src.type === 'fetch_url') {
                push('high', id, 'dedupe_on_page',
                    `db_store "${id}" dedupes on "${key}" but its value comes from fetch_url node "${vm[1]}", which returns ONE record for the whole page whose url never changes. It will report "new" on the first run and ZERO forever after — silently suppressing all content. Use parse_rss on the source's feed (one record per item, key="link"), or drop the key.`);
            }
        }

        // ── map node sanity ──
        if (n.type === 'map') {
            if (d.action && d.action !== 'tool' && d.action !== 'model') {
                push('high', id, 'map_bad_action',
                    `map "${id}" has action:"${d.action}" — a map's action is only ever "tool" or "model". Set action:"tool" plus tool:"<name>", or action:"model" plus a prompt. Every item will error as written.`);
            }
            if (d.action === 'tool' && !d.tool) {
                push('high', id, 'map_no_tool', `map "${id}" has action:"tool" but no "tool" name — every item will error`);
            }
            const items = typeof d.items === 'string' ? d.items.trim() : '';
            if (items && !/^\{\{[^}]+\}\}$/.test(items)) {
                push('medium', id, 'map_items_not_exact',
                    `map "${id}" items is "${items.slice(0, 60)}" — it must be an EXACT single template (e.g. "{{nodes.n3.new}}") so the raw ARRAY is passed. Surrounding text stringifies the list and the map runs once over one long string.`);
            }
            // A model node's output is a STRING — you cannot map over it.
            const im = /nodes\.([A-Za-z0-9_\-]+)\s*\}\}$/.exec(items);
            if (im) {
                const src = byId.get(im[1]);
                if (src && src.type === 'model') {
                    push('high', id, 'map_over_model',
                        `map "${id}" iterates {{nodes.${im[1]}}}, but "${im[1]}" is a model node and its output is a STRING, not a list — the map will run once over the whole string. Put a parse_json after the model, or use a "set" node holding a real array.`);
                }
            }
        }

        // ── Leftover placeholder credentials that repair didn't catch ──
        for (const f of Object.keys(d)) {
            if (SECRET_FIELDS.has(f) && typeof d[f] === 'string' && d[f] && PLACEHOLDER_RE.test(d[f])) {
                push('medium', id, 'placeholder_secret',
                    `"${f}" is the placeholder "${d[f]}" — the engine will call the API with it and fail. Leave it blank so it reads as "needs configuration".`);
            }
        }
    }

    // ── Webhook payload shape ─────────────────────────────────────────────────
    // The webhook route builds the run input as { body, query, receivedAt }, so the
    // POSTed JSON lives under .body. A workflow that reads {{input.<field>}}
    // directly gets nothing — silently, with no error. Observed on real builds
    // ({{input.company}} vs {{input.body.company_name}} across two runs of the
    // same prompt). Only fires for a webhook-triggered workflow: telegram/slack
    // triggers DO put their fields at the top level ({{input.text}}).
    if (triggers.some(t => t.type === 'trigger.webhook')) {
        const ENVELOPE = new Set(['body', 'query', 'receivedAt']);
        for (const n of nodes) {
            for (const { expr, at } of templatesIn(n.data || {})) {
                const im = /^input\.([A-Za-z0-9_\-]+)/.exec(expr);
                if (!im || ENVELOPE.has(im[1])) continue;
                push('high', n.id, 'webhook_input_shape',
                    `${at ? `"${at}" ` : ''}reads {{input.${im[1]}}}, but a webhook run input is { body, query, receivedAt } — the POSTed JSON is under .body. This resolves to nothing. Use {{input.body.${im[1]}}}.`);
            }
        }
    }

    // NOTE: the "node after a gate auto-attaches the gate's {result,_handle}
    // routing object" bug is fixed in the ENGINE (gate.if now carries the gated
    // payload as .value, and runNode unwraps routing objects before any
    // blank-default / auto-attach reads them). So a bare prompt after a gate is no
    // longer a defect and must NOT be flagged here — doing so would fail correct
    // workflows and send the repair loop chasing them.

    // ── web_search feeding a model/db_store with no fetch in between ──
    // web_search returns titles+links+snippets (often just a domain). Fed straight
    // to a model it produces a useless list of links; fed to db_store it stores junk.
    const adj = new Map(nodes.map(n => [String(n.id), []]));
    for (const e of edges) if (adj.has(String(e.source))) adj.get(String(e.source)).push(String(e.target));

    // Does a page-FETCHING map appear anywhere downstream of this node? If so the
    // search's page content does get retrieved and there is nothing thin about it —
    // e.g. `web_search → model (pick the urls) → map(fetch_url) → model` is a
    // perfectly good shape and must not be warned about.
    const FETCH_TOOLS = new Set(['fetch_url', 'crawl_pages', 'scrapling_fetch', 'playwright_fetch', 'http_request']);
    const fetchesDownstream = (startId) => {
        const seen = new Set([String(startId)]);
        const stack = [...(adj.get(String(startId)) || [])];
        while (stack.length) {
            const cur = stack.pop();
            if (seen.has(cur)) continue;
            seen.add(cur);
            const nn = byId.get(cur);
            if (nn && nn.type === 'map' && FETCH_TOOLS.has((nn.data && nn.data.tool) || '')) return true;
            if (nn && nn.type === 'tool' && FETCH_TOOLS.has((nn.data && nn.data.tool) || '')) return true;
            stack.push(...(adj.get(cur) || []));
        }
        return false;
    };

    for (const n of nodes) {
        if (n.type !== 'web_search') continue;
        const fetched = fetchesDownstream(n.id);
        for (const tgtId of (adj.get(String(n.id)) || [])) {
            const t = byId.get(tgtId);
            if (!t) continue;
            if (t.type === 'db_store') {
                // Not just "thin" — actively self-destructive. A web_search result is a
                // PAGE whose url is identical on every run, so a keyed db_store marks
                // them all new once and then reports ZERO forever: the automation is
                // permanently suppressed and never fires again. (Proved live.)
                push('medium', n.id, 'store_search_results',
                    `web_search "${n.id}" feeds db_store "${tgtId}" directly. A search result is a PAGE, and its url is the SAME on every run — so the store marks them new once and reports ZERO new forever, silently killing the automation after the first run. Extract real items first: web_search → map(fetch_url each result) → a model that emits the items as JSON → parse_json → db_store keyed on each ITEM's own url/id. If the source has an RSS feed or JSON API, use parse_rss / http_request instead.`);
                continue;
            }
            if (t.type !== 'model') continue;
            if (fetched) continue;   // the pages DO get fetched further down — not thin
            push('medium', n.id, 'thin_search',
                `web_search "${n.id}" feeds model "${tgtId}" directly. Search results are only titles/links/snippets — the page CONTENT is missing, so the model gets links instead of articles. Insert a map node that fetch_url's each result ({ items:"{{nodes.${n.id}.results}}", action:"tool", tool:"fetch_url", args:{ url:"{{item.url}}" } }) in between.`);
        }
    }

    // ── The workflow composes an answer but never delivers it ─────────────────
    // Observed live: the user asked for an alert on a service with no node; the
    // model coined a node type for it, materialize dropped it, and the graph was
    // left ending at a model node that writes an alert nobody sends. A model leaf
    // IS legitimate for a manual "just run it and show me" workflow, so this is a
    // warning, not a failure.
    const DELIVERS = new Set(['telegram', 'slack', 'send_file', 'export_file', 'db_store', 'render_html', 'output']);
    const deliversTool = new Set(['create_pdf', 'html_to_pdf', 'create_file', 'chart_plot']);
    const isDelivery = (n) => DELIVERS.has(n.type) || (n.type === 'tool' && deliversTool.has((n.data && n.data.tool) || ''));
    const hasOutgoing = new Set(edges.map(e => String(e.source)));
    const leaves = nodes.filter(n => !hasOutgoing.has(String(n.id)) && !String(n.type).startsWith('trigger.'));
    if (leaves.length && !nodes.some(isDelivery)) {
        const modelLeaf = leaves.find(n => n.type === 'model');
        if (modelLeaf) {
            push('medium', modelLeaf.id, 'no_delivery',
                `the workflow ends at model node "${modelLeaf.id}" and nothing delivers its text — there is no Telegram/Slack/file/database step anywhere. If the request asked for a notification, a file, or stored data, that step is missing.`);
        }
    }

    const ok = !issues.some(i => i.severity === 'high');
    return { ok, issues };
}

// One-line-per-issue rendering for a prompt / build log.
function summarizeValidation(issues) {
    if (!issues || !issues.length) return 'no structural issues';
    return issues.map(i => `[${i.severity}] ${i.nodeId ? i.nodeId + ': ' : ''}${i.detail}`).join('\n');
}

module.exports = { validateWorkflow, repairWorkflow, summarizeValidation, templatesIn, ancestorMap };
