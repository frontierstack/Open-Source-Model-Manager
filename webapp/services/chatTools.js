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
    // Build registered tools in parallel (each build(ctx) may hit the skills
    // store / DB). Order is preserved by Promise.all + the original
    // toolRegistry.values() iteration order. Per-tool errors are swallowed
    // and the slot dropped — same semantics as the prior sequential loop.
    const defs = Array.from(toolRegistry.values());
    const settled = await Promise.all(defs.map(async def => {
        try {
            return await def.build(ctx);
        } catch (e) {
            console.warn(`[chatTools] build failed for ${def.name}:`, e.message);
            return null;
        }
    }));
    for (const built of settled) {
        if (built) out.push(built);
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

/** Update the accumulator in place and return the slot that was touched.
 *
 * Slot routing for each delta, in priority order:
 *
 *   1. If the delta carries an `id` we've already seen, route to that slot
 *      (regardless of `index`). Some backends keep `index=0` for every call
 *      and only differentiate via `id`, which previously caused two distinct
 *      calls to merge into slot 0 and their `function.name` strings to get
 *      concatenated (e.g. "hex_convert" + "fetch_url" → "hex_convertfetch_url"
 *      → "Unknown skill" at dispatch time).
 *   2. Else, if the delta carries a *new* `id` not in any existing slot,
 *      allocate the next free slot (acc.length). This is the new-call
 *      boundary regardless of whether `index` is correct or omitted.
 *   3. Else, if `tc.index` is a number, use it. Standard OpenAI behavior.
 *   4. Else, this is a continuation fragment with no id and no index —
 *      append to the most recently touched slot.
 */
function accumulateToolCallDelta(acc, deltaToolCalls) {
    const touched = [];
    for (const tc of deltaToolCalls || []) {
        let idx;
        if (tc.id) {
            const existingByIdIdx = acc.findIndex(s => s && s.id && s.id === tc.id);
            if (existingByIdIdx >= 0) {
                idx = existingByIdIdx;
            } else {
                idx = acc.length;
            }
        } else if (typeof tc.index === 'number') {
            idx = tc.index;
        } else if (typeof acc._lastIdx === 'number') {
            idx = acc._lastIdx;
        } else {
            idx = 0;
        }
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
        // Non-enumerable bookkeeping so for...of iteration in finalizeToolCalls
        // and JSON.stringify of `acc` don't pick this up as a tool call.
        Object.defineProperty(acc, '_lastIdx', {
            value: idx, writable: true, enumerable: false, configurable: true,
        });
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

// Last-resort salvage: regex out individual top-level "key": value pairs
// when all three structured repair passes have failed. Used for the
// pathological case where the model emits a long string value containing
// unescaped JS source (quotes, brackets, comparison operators) — jsonrepair
// loses track of string state and closeUnterminated also can't recover
// because the corruption is mid-string, not at the tail.
//
// Recovers strings, numbers, booleans, and null. Skips array / nested object
// values (no recovery contract for them — the regex would over-match). The
// goal is to pull out at least the simple scalar args (path, line numbers,
// flags) so a tool call that's mostly correct still runs instead of failing
// the whole turn. False positives are bounded: we only run this AFTER all
// three structured passes have rejected the input.
function regexSalvageFields(input) {
    const out = {};
    let m;
    // "key": "value" — non-greedy with escape-aware match. Trailing
    // boundary allows EOL so a truncated final field can still be picked up.
    const stringPattern = /"([a-zA-Z_][\w-]{0,63})"\s*:\s*"((?:[^"\\]|\\.)*)"(?=\s*[,}\]]|\s*$)/g;
    while ((m = stringPattern.exec(input)) !== null) {
        const key = m[1];
        if (key in out) continue;
        try { out[key] = JSON.parse(`"${m[2]}"`); }
        catch { out[key] = m[2]; }
    }
    // "key": number
    const numPattern = /"([a-zA-Z_][\w-]{0,63})"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]]|\s*$)/g;
    while ((m = numPattern.exec(input)) !== null) {
        if (!(m[1] in out)) out[m[1]] = Number(m[2]);
    }
    // "key": true / false / null
    const litPattern = /"([a-zA-Z_][\w-]{0,63})"\s*:\s*(true|false|null)(?=\s*[,}\]]|\s*$)/g;
    while ((m = litPattern.exec(input)) !== null) {
        if (!(m[1] in out)) out[m[1]] = m[2] === 'null' ? null : m[2] === 'true';
    }
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
    let argsRepairedVia = null;
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
                } catch (_) {
                    // Last resort: regex out individual top-level fields.
                    // Better partial args than no call at all.
                    const salvaged = regexSalvageFields(rawArgs);
                    if (Object.keys(salvaged).length > 0) {
                        args = salvaged;
                        repairedVia = 'regexSalvage';
                    }
                }
            }
            if (repairedVia) {
                argsRepairedVia = repairedVia;
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

    // Truncation guard. Strict JSON.parse only succeeds on complete JSON,
    // so when we needed a repair pass AND the raw stream didn't close with
    // `}`, the model hit its output token cap mid-arguments. Any value the
    // repair produced is suspect — the offending field is almost always a
    // long string (file content, code blob, base64) that got chopped, so
    // running the tool with the salvaged args creates a "successful" zero-
    // size file or feeds the model a junk path that fails on the next
    // call. Refuse to dispatch and surface a clear retry hint instead;
    // without this, the model gets a misleading "success" or a downstream
    // tool error and has no idea its previous emission was clipped.
    //
    // Gating on argsRepairedVia avoids false positives on valid tool calls
    // that happened to emit a closing structure other than `}` (rare; not
    // observed in practice, but cheap belt-and-braces).
    if (argsRepairedVia) {
        const trimmed = rawArgs.trimEnd();
        if (trimmed.length > 30 && !trimmed.endsWith('}')) {
            console.warn(
                `[chatTools] ${toolName} args appear truncated (raw length ${rawArgs.length}, ` +
                `repair via ${argsRepairedVia}, no trailing brace) — refusing dispatch`
            );
            return {
                tool_call_id: call.id,
                role: 'tool',
                name: toolName,
                content: JSON.stringify({
                    error: 'arguments_truncated',
                    message:
                        `Your call to ${toolName} was truncated mid-stream — your previous ` +
                        `response hit the output token limit before finishing the JSON ` +
                        `arguments. The tool was NOT run. Retry with a smaller payload: ` +
                        `split large content across multiple calls (e.g. create the file ` +
                        `with a short stub via create_file, then append the rest in chunks ` +
                        `via replace_lines), or move the long content to a follow-up call. ` +
                        `Do not retry the same call with the same large content — it will ` +
                        `truncate again.`,
                    partial_args_preview: rawArgs.length > 500
                        ? rawArgs.slice(0, 500) + '…[truncated]'
                        : rawArgs,
                }),
            };
        }
    }

    // base64_decode salvage: model sometimes invokes the tool with no
    // string-typed args ({} or {"format":"utf-8"}). The skill's own alias
    // list and "longest string value" fallback can't help when there's
    // nothing to take. Scan the latest user message for base64 candidates
    // and inject them as `text` so the call still produces a useful result
    // instead of returning an unrecoverable parameter-required error that
    // the model treats as terminal.
    if (toolName === 'base64_decode') {
        const hasUsableString = Object.values(args).some(
            v => typeof v === 'string' && v.trim().length >= 16
        );
        if (!hasUsableString && typeof ctx?.latestUserText === 'string' && ctx.latestUserText) {
            try {
                const base64Detector = require('./base64Detector');
                const found = base64Detector.findBase64InText(ctx.latestUserText);
                if (found.length > 0) {
                    args.text = found.map(f => f.encoded).join('\n');
                    console.warn(
                        `[chatTools] base64_decode called with empty args; salvaged ${found.length} candidate(s) from latest user message`
                    );
                }
            } catch (e) {
                console.warn('[chatTools] base64_decode salvage failed:', e.message);
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

// Cap on model⇄tool rounds per user turn. Set to 20 — generous enough for
// multi-file audits while keeping small local LLMs from burning rounds in
// loops. Runaway loops are also caught by the per-turn identical-call
// detector in server.js (2 repeats → nudge) and the reasoning-stream loop
// guard (8+ phrase matches → abort), so an explicit iteration cap mainly
// guards against pathological token-cost blowups where those guards don't
// apply.
const MAX_TOOL_ITERATIONS = 20;

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
