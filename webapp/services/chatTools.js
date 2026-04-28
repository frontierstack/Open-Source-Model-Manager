// Native tool calling for /api/chat/stream.
//
// The model emits OpenAI-style `tool_calls: [{ id, type, function: { name,
// arguments } }]` alongside / instead of `content`. The chat stream handler
// accumulates these across streaming deltas, dispatches each call to a
// server-side handler once the turn ends with `finish_reason: "tool_calls"`,
// and continues the conversation with `role: "tool"` messages.
//
// The first tool registered here is `load_skill` — it returns the markdown
// body of a named instructional skill. Future tools (web_search, fetch_url,
// plus the existing skill catalog when sandboxing lands) register via the
// same `toolRegistry` map.
//
// Scope note: this module is intentionally UI-agnostic. The chat-stream
// handler forwards tool-executing / tool-result events to the SSE client so
// the UI can surface activity, but the loop itself runs entirely server-side.

const markdownSkills = require('./markdownSkills');
const { jsonrepair } = require('jsonrepair');

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/**
 * Each registered tool has:
 *   name        — unique identifier
 *   build(ctx)  — returns OpenAI tool definition  { type: 'function', function: {...} }
 *                 ctx carries { userId } so descriptions can reference user state
 *   execute(args, ctx) — async, returns a string result or structured payload.
 *                        Throw to signal an error; the loop will send the
 *                        message back to the model as the tool result so it
 *                        can recover.
 */
const toolRegistry = new Map();

function registerTool(def) {
    if (!def?.name || typeof def.execute !== 'function') {
        throw new Error('registerTool: name and execute(fn) are required');
    }
    toolRegistry.set(def.name, def);
}

// ---------------------------------------------------------------------------
// load_skill — the one tool we ship with the initial native-tools cutover.
// ---------------------------------------------------------------------------

registerTool({
    name: 'load_skill',
    async build(ctx) {
        const allSkills = await markdownSkills.listSkills(ctx.userId);
        const skills = allSkills.filter(s => s.enabled !== false);
        // Compact catalog — IDs only, comma-separated. Removes ~5 KB of
        // descriptions+triggers from every prompt. Detail is on demand:
        // the model reads description / triggers when it actually loads
        // a skill body. Same name-resolution contract — the model still
        // picks the id from a known list.
        const ids = skills.length ? skills.map(s => s.id).join(', ') : '(none)';
        return {
            type: 'function',
            function: {
                name: 'load_skill',
                description:
                    'Load an instructional skill (markdown procedure) by id. ' +
                    'Call BEFORE a task that matches a skill name — the body has the exact steps. ' +
                    `Available ids: ${ids}`,
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Skill id (kebab-case) from the available list.',
                        },
                    },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
        };
    },
    async execute(args, ctx) {
        const id = String(args?.name || '').trim();
        if (!id) {
            return { error: 'load_skill requires a "name" argument.' };
        }
        const skill = await markdownSkills.getSkill(ctx.userId, id);
        if (!skill) {
            // Return a structured not-found rather than throwing, so the
            // model can try a different id on the next turn.
            const all = await markdownSkills.listSkills(ctx.userId);
            return {
                error: `No skill with id "${id}".`,
                available: all.filter(s => s.enabled !== false).map(s => s.id),
            };
        }
        if (skill.enabled === false) {
            return {
                error: `Skill "${id}" is disabled. The operator turned it off in Settings; pick another skill or proceed without one.`,
            };
        }
        return {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            body: skill.body,
        };
    },
});

// ---------------------------------------------------------------------------
// Catalog builder — called per-request to produce the outgoing `tools` array
// ---------------------------------------------------------------------------

// The static toolRegistry holds tools that live inside this module (the
// hand-coded load_skill, plus web_search / fetch_url registered from
// server.js at boot). `dynamicToolProvider` lets callers surface an
// additional set of tools computed per-request (e.g. the enabled skills
// for the current user). Keeps the registry small and stable while
// letting the catalog grow organically.
let dynamicToolProvider = null;
function setDynamicToolProvider(fn) { dynamicToolProvider = fn || null; }

// `fallbackDispatch` handles tool names not present in toolRegistry.
// Used to route calls that came from the dynamic provider back to the
// appropriate handler (the legacy skill executor, etc.).
let fallbackDispatch = null;
function setFallbackDispatch(fn) { fallbackDispatch = fn || null; }

async function buildToolCatalog(ctx) {
    const out = [];
    for (const def of toolRegistry.values()) {
        try {
            out.push(await def.build(ctx));
        } catch (e) {
            console.warn(`[chatTools] build failed for ${def.name}:`, e.message);
        }
    }
    if (dynamicToolProvider) {
        try {
            const extra = await dynamicToolProvider(ctx);
            if (Array.isArray(extra)) out.push(...extra);
        } catch (e) {
            console.warn('[chatTools] dynamic provider failed:', e.message);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Streaming delta accumulator
// ---------------------------------------------------------------------------
//
// OpenAI streams `tool_calls` as delta fragments — the `arguments` JSON
// arrives in pieces across chunks. Each delta entry has an `index` that
// identifies which call we're appending to.

/** Update the accumulator in place and return the slot that was touched. */
function accumulateToolCallDelta(acc, deltaToolCalls) {
    const touched = [];
    for (const tc of deltaToolCalls || []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!acc[idx]) {
            acc[idx] = {
                id: tc.id || '',
                type: tc.type || 'function',
                function: { name: '', arguments: '' },
            };
        }
        if (tc.id) acc[idx].id = tc.id;
        if (tc.type) acc[idx].type = tc.type;
        if (tc.function?.name) acc[idx].function.name += tc.function.name;
        if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
        touched.push(idx);
    }
    return touched;
}

function finalizeToolCalls(acc) {
    // Drop empty slots, assign synthetic ids if the backend didn't provide one.
    const out = [];
    let synth = 0;
    for (const tc of acc) {
        if (!tc || !tc.function?.name) continue;
        out.push({
            id: tc.id || `call_${Date.now()}_${synth++}`,
            type: tc.type || 'function',
            function: {
                name: tc.function.name,
                arguments: tc.function.arguments || '{}',
            },
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Dispatch one tool call
// ---------------------------------------------------------------------------

// String-aware truncation closer for tool-call arguments. Walks the input
// tracking JSON-string state so that brackets/braces/quotes inside string
// values are ignored. At end-of-buffer, closes any unterminated string and
// drains the bracket/brace stacks. Used as a second-stage repair after
// jsonrepair gives up — jsonrepair's parser chokes on strings that contain
// unbalanced JS-style brackets (e.g. `"const s = v => [...v]"`) because it
// mistakes the bracket pair for a JSON array.
function closeUnterminated(input) {
    let inString = false;
    let escape = false;
    const stack = []; // values: '}' or ']' (the closer we still owe)
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (escape) { escape = false; continue; }
        if (inString) {
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = false; continue; }
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') {
            if (stack.length && stack[stack.length - 1] === c) stack.pop();
        }
    }
    let out = input;
    if (inString) out += '"';
    while (stack.length) out += stack.pop();
    return out;
}

async function executeToolCall(call, ctx) {
    const toolName = call.function.name;
    // Parse args once up-front — same error path whether we dispatch to
    // a registered tool or the dynamic fallback.
    //
    // Strict JSON.parse first. Local LLMs frequently emit lightly-malformed
    // arguments (unescaped quotes inside string values when the model writes
    // code into a `content` field; unquoted object keys; trailing commas;
    // smart quotes; mid-string truncation when the response hits the output
    // token cap). Two repair passes salvage those without false positives
    // on actually-valid JSON:
    //   1. jsonrepair — handles unescaped quotes, unquoted keys, smart
    //      quotes, trailing commas, simple mid-stream truncation.
    //   2. closeUnterminated — string-aware bracket-closer that fixes the
    //      truncation cases jsonrepair chokes on (it misinterprets bracket
    //      pairs *inside* string values as JSON arrays and bails).
    // Only the original error is surfaced to the model when both passes
    // fail; repairs are logged for observability without polluting the
    // user-visible error message.
    let args = {};
    const rawArgs = call.function.arguments || '';
    if (rawArgs.trim()) {
        try {
            args = JSON.parse(rawArgs);
        } catch (firstErr) {
            let repairedVia = null;
            try {
                args = JSON.parse(jsonrepair(rawArgs));
                repairedVia = 'jsonrepair';
            } catch (_) {
                try {
                    args = JSON.parse(closeUnterminated(rawArgs));
                    repairedVia = 'closeUnterminated';
                } catch (_) { /* both passes failed */ }
            }
            if (repairedVia) {
                console.warn(`[chatTools] Repaired malformed JSON args for ${toolName} via ${repairedVia} (${firstErr.message})`);
            } else {
                // Heuristic: if the buffer ends with no closing `}` and the
                // brace stack is unbalanced, this was almost certainly a
                // mid-stream truncation when the model hit its output token
                // cap — make that explicit so the model gets a useful nudge
                // instead of a generic "Invalid JSON" the next turn.
                const looksTruncated = !rawArgs.trimEnd().endsWith('}') && rawArgs.length > 200;
                const hint = looksTruncated
                    ? ' Arguments appear to be truncated mid-stream — your previous response likely hit its output token limit. Retry with a smaller payload, or move large content to a follow-up call.'
                    : '';
                return {
                    tool_call_id: call.id,
                    role: 'tool',
                    name: toolName,
                    content: JSON.stringify({
                        error: `Invalid JSON in tool arguments: ${firstErr.message}.${hint}`,
                        // Cap echo so a 50KB malformed blob doesn't ship back
                        // through the whole chat history; the head usually
                        // shows the model what its own emission looked like.
                        received: rawArgs.length > 4000 ? rawArgs.slice(0, 4000) + '…[truncated]' : rawArgs,
                    }),
                };
            }
        }
    }

    const def = toolRegistry.get(toolName);
    const dispatch = def
        ? (a, c) => def.execute(a, c)
        : (fallbackDispatch
            ? (a, c) => fallbackDispatch(toolName, a, c)
            : null);

    if (!dispatch) {
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: toolName,
            content: JSON.stringify({
                error: `Unknown tool "${toolName}".`,
                available: [...toolRegistry.keys()],
            }),
        };
    }

    try {
        const result = await dispatch(args, ctx);
        const serialized = typeof result === 'string' ? result : JSON.stringify(result);
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: toolName,
            content: serialized,
        };
    } catch (e) {
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: toolName,
            content: JSON.stringify({ error: e.message || String(e) }),
        };
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Cap on model⇄tool rounds per user turn. Raised from 10 → 50 so the
// model has room to iterate through large repos / multi-file audits
// without hitting the cap after a few rounds and triggering synthesis.
// Runaway loops are now caught by the per-turn identical-call detector
// in server.js (2 repeats → nudge) and the reasoning-stream loop guard
// (8+ phrase matches → abort), so an explicit iteration cap mainly
// guards against pathological token-cost blowups where those guards
// don't apply.
const MAX_TOOL_ITERATIONS = 50;

module.exports = {
    registerTool,
    buildToolCatalog,
    accumulateToolCallDelta,
    finalizeToolCalls,
    executeToolCall,
    setDynamicToolProvider,
    setFallbackDispatch,
    toolRegistry,
    MAX_TOOL_ITERATIONS,
};
