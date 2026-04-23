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
        const skills = await markdownSkills.listSkills(ctx.userId);
        // Surface the catalog inside the tool description so the model can
        // choose `name` correctly without a parallel system-prompt section.
        const catalog = skills.length
            ? skills
                  .map(s => {
                      const trig = s.triggers ? ` — triggers: ${s.triggers}` : '';
                      return `  - ${s.id}: ${s.description || s.name}${trig}`;
                  })
                  .join('\n')
            : '  (no skills defined)';
        return {
            type: 'function',
            function: {
                name: 'load_skill',
                description:
                    'Load an instructional skill (markdown procedure) by its id. ' +
                    'Use this BEFORE attempting a task that matches any of the skills below — ' +
                    'the body contains the exact steps and tools to call.\n\n' +
                    'Available skills:\n' + catalog,
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Skill id as shown in the catalog (kebab-cased).',
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
                available: all.map(s => s.id),
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

async function buildToolCatalog(ctx) {
    const out = [];
    for (const def of toolRegistry.values()) {
        try {
            out.push(await def.build(ctx));
        } catch (e) {
            console.warn(`[chatTools] build failed for ${def.name}:`, e.message);
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

async function executeToolCall(call, ctx) {
    const def = toolRegistry.get(call.function.name);
    if (!def) {
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: JSON.stringify({
                error: `Unknown tool "${call.function.name}".`,
                available: [...toolRegistry.keys()],
            }),
        };
    }
    let args = {};
    try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (e) {
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: JSON.stringify({
                error: `Invalid JSON in tool arguments: ${e.message}`,
                received: call.function.arguments,
            }),
        };
    }
    try {
        const result = await def.execute(args, ctx);
        const serialized = typeof result === 'string' ? result : JSON.stringify(result);
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: serialized,
        };
    } catch (e) {
        return {
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: JSON.stringify({ error: e.message || String(e) }),
        };
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 5; // Cap on model⇄tool rounds per user turn.

module.exports = {
    registerTool,
    buildToolCatalog,
    accumulateToolCallDelta,
    finalizeToolCalls,
    executeToolCall,
    toolRegistry,
    MAX_TOOL_ITERATIONS,
};
