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

// Tools that accept a workspace FILE path as an alternative to a large inline
// payload. When a tool call's arguments truncate at the model's output-token
// cap, route the model to the hatch for THAT tool (param = the file arg name,
// ext = suggested extension, noun = what the body is) instead of a generic hint.
// Keep in sync with the skills' params + their /workspace sandbox mounts.
const TRUNCATION_FILE_HATCH = {
    create_pdf:       { param: 'contentFile', ext: 'md',   noun: 'markdown content' },
    create_docx:      { param: 'contentFile', ext: 'md',   noun: 'markdown content' },
    html_to_pdf:      { param: 'htmlPath',    ext: 'html', noun: 'HTML' },
    markdown_to_html: { param: 'mdPath',      ext: 'md',   noun: 'markdown' },
    run_python:       { param: 'codeFile',    ext: 'py',   noun: 'code' },
    run_node:         { param: 'codeFile',    ext: 'js',   noun: 'code' },
    create_xlsx:      { param: 'rowsFile',    ext: 'json', noun: 'rows (a JSON array of arrays, or {headers,rows})' },
};
// Tools whose large field IS the file body — recover by chunking the write
// itself, not by pointing at a second file.
const TRUNCATION_CHUNKABLE = new Set(['create_file', 'append_to_file', 'update_file', 'replace_lines']);

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
            // Route the model to the right recovery for THIS tool: a file-path
            // hatch when the tool has one, chunked writes for the file builders,
            // else the generic "smaller payload / move to a file" hint. See
            // TRUNCATION_FILE_HATCH / TRUNCATION_CHUNKABLE.
            const hatch = TRUNCATION_FILE_HATCH[toolName];
            let retryHint;
            if (hatch) {
                retryHint =
                  `Write the ${hatch.noun} to /workspace/<name>.${hatch.ext} via create_file + ` +
                  `append_to_file (one short call per chunk, no truncation risk), then re-call ` +
                  `${toolName} with ${hatch.param}='/workspace/<name>.${hatch.ext}' and NO inline ` +
                  `payload. The file path bypasses the arg-token cap. Do not retry the same call ` +
                  `with the same large inline content — it will truncate again.`;
            } else if (TRUNCATION_CHUNKABLE.has(toolName)) {
                retryHint =
                  `Split the write into smaller pieces: create the file with a short first chunk ` +
                  `via create_file, then append the rest via append_to_file/replace_lines (one ` +
                  `short call each). Do not retry with the same large content — it will truncate again.`;
            } else {
                retryHint =
                  `Retry with a smaller payload: split the work across multiple calls, or write ` +
                  `the long content to a /workspace file (create_file + chunked append_to_file) and ` +
                  `have a file-aware tool read it by path. Do not retry the same call with the same ` +
                  `large content — it will truncate again.`;
            }
            return {
                tool_call_id: call.id,
                role: 'tool',
                name: toolName,
                content: JSON.stringify({
                    error: 'arguments_truncated',
                    message:
                        `Your call to ${toolName} was truncated mid-stream — your previous ` +
                        `response hit the output token limit before finishing the JSON ` +
                        `arguments. The tool was NOT run. ` + retryHint,
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
        let serialized = typeof result === 'string' ? result : JSON.stringify(result);

        // Smart-dependency: scan the tool output for known install failures
        // (pip, npm, apt, ModuleNotFoundError) and attach an `_advice` field
        // telling the model not to retry the install and what to try
        // instead. Without this, models repeatedly retry the same failing
        // install command because stderr from a sandbox skill looks like
        // generic noise — the loop guard then aborts after 3 identical
        // calls and the model gives up with "I couldn't figure it out".
        const advice = detectInstallFailureAdvice(serialized);
        if (advice) {
            try {
                const obj = JSON.parse(serialized);
                if (obj && typeof obj === 'object') {
                    obj._advice = advice;
                    serialized = JSON.stringify(obj);
                }
            } catch { /* non-JSON tool output — leave alone */ }
        }

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

// Python module-name → pip-package-name mappings for the most common
// "import X" vs "pip install Y" mismatches. Lookups only — the advice
// tells the model the right pip name; we never run the install.
const PY_MODULE_TO_PIP = {
    cv2: 'opencv-python',
    PIL: 'Pillow',
    yaml: 'PyYAML',
    sklearn: 'scikit-learn',
    bs4: 'beautifulsoup4',
    magic: 'python-magic',
    psycopg2: 'psycopg2-binary',
    Crypto: 'pycryptodome',
    serial: 'pyserial',
    dateutil: 'python-dateutil',
    OpenSSL: 'pyOpenSSL',
    docx: 'python-docx',
    pptx: 'python-pptx',
    fitz: 'PyMuPDF',
    skimage: 'scikit-image',
    google: 'google-cloud',
    PyQt5: 'PyQt5',
    pkg_resources: 'setuptools',
};

// Scan tool output for install-failure signatures and return a short
// directive advice string for the model. Returns null when nothing
// matches (the vast majority of tool results).
//
// `content` is the serialized tool result — usually a JSON object whose
// stdout/stderr fields carry pip/npm/apt error text. We parse it first
// so the regexes run against the *unescaped* shell output (JSON-serialized
// stdout buries `\n` and `\"` in the string, which fights the regexes).
function detectInstallFailureAdvice(content) {
    if (typeof content !== 'string' || content.length === 0) return null;

    // Pull out scanning targets from the JSON if we can; fall back to the
    // raw serialized string for non-JSON tool outputs (some skills return
    // bare strings, especially older ones).
    let scanText = content;
    try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === 'object') {
            const parts = [];
            for (const key of ['stdout', 'stderr', 'output', 'message', 'error']) {
                const v = obj[key];
                if (typeof v === 'string' && v) parts.push(v);
            }
            if (parts.length > 0) scanText = parts.join('\n');
        }
    } catch { /* not JSON — scan raw content */ }

    // pip: "Could not find a version that satisfies the requirement <pkg>"
    let m = scanText.match(/Could not find a version that satisfies the requirement ([@A-Za-z0-9_.\-]+)/);
    if (m) {
        const pkg = m[1];
        return `Package "${pkg}" does not exist on PyPI under that name. Do NOT retry this install — pip already exhausted the index. Either (a) verify the correct PyPI name by searching pypi.org/search/?q=${encodeURIComponent(pkg)} via scrapling_fetch, (b) call the underlying service's HTTP API directly with stdlib (urllib/requests), or (c) abandon this approach and tell the user what you could not do. Do not call pip install with the same name again.`;
    }

    // npm: "404 Not Found - GET <url>/<pkg>" or "npm ERR! 404 '<pkg>' is not in the npm registry"
    m = scanText.match(/npm ERR! 404[^\n]*?["'`]([@A-Za-z0-9_.\-/]+)["'`]/);
    if (!m) m = scanText.match(/404 Not Found[^\n]*\/([@A-Za-z0-9_.\-/]+)/);
    if (m) {
        const pkg = m[1];
        return `npm package "${pkg}" was not found in the registry. Do NOT retry this install — the name is wrong or the package isn't published. Verify by fetching https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(pkg)} or try a different approach.`;
    }

    // apt / dnf: "Unable to locate package <pkg>" / "No package <pkg> available"
    m = scanText.match(/Unable to locate package ([A-Za-z0-9_.\-+]+)/);
    if (!m) m = scanText.match(/No package ([A-Za-z0-9_.\-+]+) available/);
    if (m) {
        const pkg = m[1];
        return `System package "${pkg}" is not in this sandbox image's apt sources. The sandbox is minimal and you generally cannot install new system packages. Do NOT retry. Use a pip-installable Python equivalent, call a remote API instead, or tell the user what you could not do.`;
    }

    // Python ModuleNotFoundError — the most common confusion is the import
    // name differing from the pip package name.
    m = scanText.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
    if (m) {
        const mod = m[1].split('.')[0];
        const pip = PY_MODULE_TO_PIP[mod];
        if (pip) {
            return `Python module "${mod}" is the import name; the pip package is "${pip}". Install with: subprocess.run(["pip","install","${pip}"], ...). Do not pip install "${mod}".`;
        }
        return `Python module "${mod}" is not installed. The pip package may have a different name (e.g. import cv2 ↔ pip install opencv-python). Try: pip install ${mod} first; if pip says "no matching distribution", search pypi.org via scrapling_fetch for the correct name.`;
    }

    // Generic command-not-found from shell-style skills. Two common
    // shapes: zsh "zsh: command not found: <cmd>" and bash "bash:
    // <cmd>: command not found". Match zsh first because its shape is
    // more specific (command not found is followed by `: <cmd>`); the
    // bash pattern would otherwise capture "zsh" as the binary name.
    m = scanText.match(/command not found\s*:\s*([a-zA-Z0-9_.\-]{2,})/);
    if (!m) m = scanText.match(/(?:^|[\s:])([a-zA-Z0-9_.\-]{2,})\s*:\s*command not found/m);
    if (m) {
        const cmd = m[1];
        return `Binary "${cmd}" is not on PATH in this sandbox. Do NOT retry the same command. Use a Python/Node equivalent via stdlib, install a Python wrapper via pip, or tell the user the operation isn't possible in this environment.`;
    }

    return null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Cap on model⇄tool rounds per user turn. Set to 50 — research workloads
// (multi-city news, multi-source comparisons with paywall fallbacks) can
// legitimately need 30+ distinct tool calls before synthesizing. The cap
// is not the runaway-loop defense: the per-turn identical-call detector
// (2 repeats with same result → nudge) and the reasoning-stream loop
// guard (8+ phrase matches → abort) catch loops cheaply. The iteration
// cap is the last-resort guard against pathological token-cost blowups
// where neither of those guards apply.
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
