'use strict';

// Per-request "reasoning effort" for the chat backends.
//
// There is no single lever that every model honors, so this module maps a
// user-facing effort ('off'|'low'|'medium'|'high') onto three layers, from
// strongest to weakest, and the caller sends ALL of them that apply:
//
//   native — gpt-oss (Harmony template): top-level `reasoning_effort` +
//            the same value mirrored into `chat_template_kwargs` (llama.cpp
//            master and sglang both accept the top-level field).
//   toggle — thinking-toggle families (Qwen3.x/QwQ, GLM-4.x/5, DeepSeek
//            V3.1+/R1-0528, Nemotron, Granite, MiniMax-M2, Kimi-K2-Thinking,
//            SmolLM3, EXAONE-4, Hunyuan, Seed-OSS, Ling/Ring, ERNIE-4.5,
//            "-thinking"/"-reasoning"/"-mtp" names): `chat_template_kwargs.
//            enable_thinking` (+ Granite's `thinking`, harmless elsewhere).
//            'off' → false; low/medium/high → true, plus a best-effort
//            token budget on llama.cpp only (`reasoning_budget_tokens` /
//            `thinking_budget_tokens` are parsed by llama.cpp master; unknown
//            keys are ignored there — sglang may 400 on unknown top-level
//            fields, so it never gets them). Seed-OSS reads the template kwarg
//            `thinking_budget`.
//   hint   — every model, every backend: a one-line system hint appended to
//            the runtime prelude. The universal fallback for models with no
//            template lever (Llama/Mistral/Gemma/Phi…), and reinforcement for
//            the others.
//
// `support` reports the strongest layer available for the model so the
// instance lists can advertise it. Nothing here talks to a backend; the chat
// stream merges `requestFields` / `templateKwargs` into its request body and
// retries once without them if the backend rejects the request.

const EFFORTS = new Set(['off', 'low', 'medium', 'high']);

// llama.cpp reasoning budgets (tokens). `high` is unbounded (omitted).
const BUDGET_TOKENS = { low: 1536, medium: 6144 };

const HINTS = {
    off: 'Reasoning effort: OFF — do not think out loud; answer directly.',
    low: 'Reasoning effort: LOW — keep any internal deliberation to a few short sentences and answer directly.',
    medium: 'Reasoning effort: MEDIUM — think through the problem at a moderate level of detail, then answer.',
    high: 'Reasoning effort: HIGH — think carefully and thoroughly, verify your reasoning before answering.',
};

const NATIVE_RE = /gpt[-_ ]?oss/i;
const TOGGLE_RE = new RegExp([
    'qwen\\s?3', 'qwen-?3', 'qwq',
    'glm[-_ ]?(?:4|5)', 'glm4', 'glm5',
    'deepseek[-_ ]?v3\\.[1-9]', 'deepseek[-_ ]?v3\\.\\d', 'deepseek[-_ ]?r1', 'deepseek[-_ ]?v3(?:$|[-_ ])',
    'nemotron', 'granite', 'minimax[-_ ]?m2', 'kimi[-_ ]?k2', 'smollm3', 'exaone[-_ ]?4',
    'hunyuan', 'seed[-_ ]?oss', '(?:^|[-_/ ])(?:ling|ring)[-_ ]', 'ernie[-_ ]?4\\.5',
    'gemma[^/]*think', '[-_ ]thinking', '[-_ ]reasoning', '[-_ ]mtp',
].join('|'), 'i');
const SEED_OSS_RE = /seed[-_ ]?oss/i;
const GRANITE_RE = /granite/i;
const DEFAULT_NO_THINK_RE = /qwen\s?[23]|qwen-?3|deepseek[-_ ]?r1|deepseek[-_ ]?v?3\.?\d*/i;

function normalizeEffort(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (!s || s === 'default' || s === 'auto') return null;
    if (s === 'none' || s === 'disabled' || s === 'no') return 'off';
    if (s === 'min' || s === 'minimal') return 'low';
    if (s === 'max' || s === 'maximum') return 'high';
    return EFFORTS.has(s) ? s : null;
}

function detectEffortSupport(modelName) {
    const n = String(modelName || '');
    if (NATIVE_RE.test(n)) return 'native';
    if (TOGGLE_RE.test(n)) return 'toggle';
    return 'hint';
}

/**
 * @param {object} o
 * @param {string} o.effort            'off'|'low'|'medium'|'high' (or raw; normalized here)
 * @param {string} o.modelName
 * @param {string} o.backend           'llamacpp'|'sglang'|other
 * @param {boolean} [o.loadedThinkingOff]  instance loaded with reasoning off (LLAMA_REASONING=off)
 * @param {function} [o.supportsNoThinkPrefix]  server.js modelSupportsNoThinkPrefix (default: local copy)
 */
function buildEffortDirectives({ effort, modelName, backend, loadedThinkingOff = false, supportsNoThinkPrefix } = {}) {
    const e = normalizeEffort(effort);
    const support = detectEffortSupport(modelName);
    const out = { effort: e, support, requestFields: {}, templateKwargs: {}, systemHint: null, noThinkPrefix: false, warnings: [] };
    if (!e) return out;

    const isSglang = backend === 'sglang';
    const isLlama = backend === 'llamacpp' || !isSglang;
    out.systemHint = HINTS[e];

    if (support === 'native') {
        const level = e === 'off' ? 'low' : e;
        out.requestFields.reasoning_effort = level;
        out.templateKwargs.reasoning_effort = level;
    } else if (support === 'toggle') {
        const on = e !== 'off';
        out.templateKwargs.enable_thinking = on;
        if (GRANITE_RE.test(String(modelName || ''))) out.templateKwargs.thinking = on;
        if (on && isLlama && BUDGET_TOKENS[e]) {
            out.requestFields.reasoning_budget_tokens = BUDGET_TOKENS[e];
            out.requestFields.thinking_budget_tokens = BUDGET_TOKENS[e];
        }
        if (on && SEED_OSS_RE.test(String(modelName || '')) && BUDGET_TOKENS[e]) {
            out.templateKwargs.thinking_budget = BUDGET_TOKENS[e];
        }
        if (on && loadedThinkingOff) {
            out.warnings.push(`model "${modelName}" was loaded with reasoning OFF (LLAMA_REASONING=off); re-enabling per request via enable_thinking (llama.cpp honors it; other backends may not)`);
        }
    }

    if (e === 'off') {
        const fn = typeof supportsNoThinkPrefix === 'function' ? supportsNoThinkPrefix : (m) => DEFAULT_NO_THINK_RE.test(String(m || ''));
        out.noThinkPrefix = !!fn(modelName);
    }
    return out;
}

// Names of every key the directives can put on a request body, so a caller
// can strip them on a backend rejection retry.
const EFFORT_REQUEST_KEYS = ['reasoning_effort', 'reasoning_budget_tokens', 'thinking_budget_tokens'];
const EFFORT_TEMPLATE_KEYS = ['reasoning_effort', 'enable_thinking', 'thinking', 'thinking_budget'];

function describeDirectives(d) {
    const keys = [
        ...Object.keys(d.requestFields || {}).map((k) => `${k}=${JSON.stringify(d.requestFields[k])}`),
        ...Object.keys(d.templateKwargs || {}).map((k) => `chat_template_kwargs.${k}=${JSON.stringify(d.templateKwargs[k])}`),
    ];
    if (d.noThinkPrefix) keys.push('/no_think');
    if (d.systemHint) keys.push('hint');
    return keys.join(', ') || '(none)';
}

module.exports = {
    normalizeEffort,
    detectEffortSupport,
    buildEffortDirectives,
    describeDirectives,
    EFFORT_REQUEST_KEYS,
    EFFORT_TEMPLATE_KEYS,
    HINTS,
    BUDGET_TOKENS,
};
