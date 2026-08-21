// ── /v1 context guard ───────────────────────────────────────────────────────
// Protects OpenAI-compatible passthrough traffic (Pi and raw SDK clients)
// from the three context-window failure modes the backends handle badly:
//
//   1. llama.cpp with --context-shift ENABLED accepts a request whose
//      prompt fits but whose generation runs past the window, then silently
//      drops the OLDEST KV entries mid-generation — i.e. the system prompt
//      (for Pi: the sandbox-state block) evaporates without any signal to
//      the client. With no max_tokens at all (Pi never sends one on agent
//      turns) a looping reasoning model can also generate indefinitely,
//      pinning the single slot. Fix: always bound max_tokens by the real
//      headroom (window - estimated input).
//
//   2. sglang 400s when input + max_new_tokens exceeds the window even
//      though the completion would have fit naturally. The clamp avoids
//      the error entirely.
//
//   3. When the INPUT alone cannot fit, the request must fail with an error
//      the client's auto-compaction recognizes. Pi (pi.dev) matches
//      "exceeds the available context size" (llama.cpp's wording) and
//      compacts + retries automatically — so the synthetic rejection reuses
//      that exact phrasing. Rejection is deliberately conservative: it only
//      fires when even an optimistic token estimate exceeds the window
//      (chars / V1_CPT_FLOOR), otherwise the backend stays the authority.
//
// Special case: Pi's compaction SUMMARIZER call is itself a /v1 completion
// carrying the serialized conversation as one giant user message. After a
// hard overflow (the reason compaction was triggered), that call can ALSO
// overflow — compaction fails and the session wedges permanently ("recovery
// failed" on every retry). For bearer (Pi) callers with a summarizer-shaped
// request (≤2 messages, no tools, plain string content) we middle-truncate
// the oversized message instead of rejecting, so the summary gets computed
// from the head + tail of the conversation and compaction completes.
//
// Everything is estimate-based (no tokenizer round-trip) so the guard adds
// microseconds, not milliseconds. Estimates use two ratios:
//   - V1_CPT_CENTRAL (3.6 chars/token): central estimate used for clamping.
//   - V1_CPT_FLOOR   (4.8 chars/token): optimistic lower bound — a request
//     is only rejected/rescued when even this says the input can't fit.
// Env-tunable, no rebuild: V1_CTX_GUARD=false disables the whole guard;
// V1_CTX_MARGIN_TOKENS / V1_MIN_COMPLETION_TOKENS adjust the buffers.

const V1_CTX_GUARD_ENABLED = process.env.V1_CTX_GUARD !== 'false';
const V1_CTX_MARGIN_TOKENS = parseInt(process.env.V1_CTX_MARGIN_TOKENS, 10) || 512;
const V1_MIN_COMPLETION_TOKENS = parseInt(process.env.V1_MIN_COMPLETION_TOKENS, 10) || 1024;
const V1_CPT_CENTRAL = 3.6;
const V1_CPT_FLOOR = 4.8;
// Rough char cost of an image content part (~1000 tokens at the central ratio).
const V1_IMAGE_PART_CHARS = 3600;

// Effective per-request context window. llama.cpp splits --ctx-size evenly
// across --parallel slots (n_ctx_slot = n_ctx / n_parallel), so with
// parallelSlots > 1 the window a single request actually gets is a fraction
// of the configured contextSize. sglang's context length is already
// per-request. Returns 0 when the instance config carries no usable size.
function effectiveContextSize(instance) {
    const cfg = instance?.config || {};
    const ctx = cfg.contextSize || cfg.maxModelLen || 0;
    if (!ctx) return 0;
    if (instance?.backend !== 'sglang') {
        const slots = parseInt(cfg.parallelSlots, 10) || 1;
        if (slots > 1) return Math.floor(ctx / slots);
    }
    return ctx;
}

// Single-pass character count over an OpenAI chat-completions body:
// messages (string + vision-array content, tool_calls) plus the tools
// catalog. Avoids JSON.stringify on the message contents themselves (no
// escape inflation, no megabyte copies).
function countRequestChars(body) {
    let chars = 0;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const m of messages) {
        if (!m) continue;
        chars += 16; // role + framing overhead
        const c = m.content;
        if (typeof c === 'string') {
            chars += c.length;
        } else if (Array.isArray(c)) {
            for (const part of c) {
                if (!part) continue;
                if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
                else if (part.type === 'image_url') chars += V1_IMAGE_PART_CHARS;
            }
        }
        if (Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                chars += 48;
                const fn = tc?.function;
                if (fn?.name) chars += String(fn.name).length;
                if (typeof fn?.arguments === 'string') chars += fn.arguments.length;
                else if (fn?.arguments != null) { try { chars += JSON.stringify(fn.arguments).length; } catch (_) { /* skip */ } }
            }
        }
    }
    if (Array.isArray(body?.tools) && body.tools.length) {
        try { chars += JSON.stringify(body.tools).length; } catch (_) { /* skip */ }
    }
    return chars;
}

// The synthetic rejection body. The message deliberately reuses llama.cpp's
// wording ("exceeds the available context size") because that is what Pi's
// isContextOverflow() matches to trigger automatic compact-and-retry; the
// generic "context length exceeded" phrase covers other clients' fallback
// patterns.
function buildOverflowErrorBody(estTokens, effCtx) {
    return {
        error: {
            code: 400,
            message: `request (~${estTokens} tokens estimated) exceeds the available context size (${effCtx} tokens): context length exceeded — compact or shorten the conversation and retry`,
            type: 'exceed_context_size_error',
            n_prompt_tokens_est: estTokens,
            n_ctx: effCtx,
        },
    };
}

// Middle-truncate a string to ~targetChars, keeping 30% head + 70% tail
// (recent state matters more than old detail, matching smartTruncate's
// split elsewhere in the codebase).
function middleTruncate(text, targetChars) {
    const marker = '\n\n[... middle omitted: content exceeded the model\'s context window ...]\n\n';
    if (targetChars >= text.length) return text;
    const budget = Math.max(200, targetChars - marker.length);
    const head = Math.floor(budget * 0.3);
    const tail = budget - head;
    return text.slice(0, head) + marker + text.slice(text.length - tail);
}

// Does this request look like Pi's internal compaction/branch summarizer
// (or any comparable single-shot utility call)? Those are safe to rescue by
// truncation: one system + one user message, plain strings, no tools, no
// multi-turn state to corrupt — and a hard 400 would wedge the caller.
function isSingleShotRescuable(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length || messages.length > 2) return false;
    if (Array.isArray(body?.tools) && body.tools.length) return false;
    for (const m of messages) {
        if (!m || typeof m.content !== 'string') return false;
        if (m.role !== 'system' && m.role !== 'user') return false;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
    }
    return true;
}

/**
 * Inspect (and possibly mutate) a POST /v1/chat/completions body so the
 * request fits the instance's effective context window.
 *
 * Returns an action record:
 *   { action: 'ok',      estTokens, effCtx, nearFull }         — untouched
 *   { action: 'capped',  estTokens, effCtx, maxTokens }        — injected max_tokens (client sent none)
 *   { action: 'clamped', estTokens, effCtx, maxTokens, from }  — reduced client's max_tokens
 *   { action: 'rescued', estTokens, effCtx, removedChars }     — middle-truncated a single-shot request
 *   { action: 'reject',  estTokens, effCtx, payload }          — caller should 400 with payload
 *   null                                                        — guard disabled / not applicable
 */
function applyContextGuard(body, instance, { bearerOnly = false } = {}) {
    if (!V1_CTX_GUARD_ENABLED) return null;
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return null;
    const effCtx = effectiveContextSize(instance);
    if (!effCtx) return null;

    const chars = countRequestChars(body);
    const estCentral = Math.ceil(chars / V1_CPT_CENTRAL) + V1_CTX_MARGIN_TOKENS;
    const estFloor = Math.ceil(chars / V1_CPT_FLOOR);
    // Minimum useful completion scales with the window: a fixed 1024 floor is
    // right for 100k-class models but rejects perfectly runnable requests on a
    // small-window model (measured: a 1298-token summarize call against a 2048
    // window with 750 free tokens). Floor = window/8, capped at the configured
    // value, never below 64.
    const minCompletion = Math.max(64, Math.min(V1_MIN_COMPLETION_TOKENS, Math.floor(effCtx / 8)));
    const requestedMax = Number.isFinite(body.max_tokens) ? body.max_tokens
        : (Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : null);

    // Input alone cannot fit, even optimistically.
    if (estFloor >= effCtx) {
        if (bearerOnly && isSingleShotRescuable(body)) {
            // Rescue: truncate the LARGEST message down so input + completion fit.
            const completion = Math.min(requestedMax || minCompletion, Math.floor(effCtx * 0.25));
            const targetInputTokens = Math.max(512, effCtx - V1_CTX_MARGIN_TOKENS - completion);
            let biggest = -1, biggestLen = -1;
            body.messages.forEach((m, i) => {
                const len = typeof m.content === 'string' ? m.content.length : 0;
                if (len > biggestLen) { biggestLen = len; biggest = i; }
            });
            if (biggest >= 0 && biggestLen > 4000) {
                // Proportional inversion of the estimate (never targetTokens × ratio —
                // that over-counts and can exceed the string length; see the
                // trimToolHistoryToFit lesson).
                const otherChars = chars - biggestLen;
                const targetChars = Math.max(2000, Math.floor(targetInputTokens * V1_CPT_CENTRAL) - otherChars);
                const original = body.messages[biggest].content;
                const truncated = middleTruncate(original, targetChars);
                if (truncated.length < original.length) {
                    body.messages[biggest] = { ...body.messages[biggest], content: truncated };
                    return {
                        action: 'rescued', estTokens: estCentral, effCtx,
                        removedChars: original.length - truncated.length,
                    };
                }
            }
            // fall through to reject if nothing could be truncated
        }
        return { action: 'reject', estTokens: estCentral, effCtx, payload: buildOverflowErrorBody(estCentral, effCtx) };
    }

    const headroom = effCtx - estCentral;
    const nearFull = estCentral > effCtx * 0.88;

    // Not even a minimal completion fits: an agent at this point needs to
    // compact, and letting the request through would either 400 at sglang
    // or silently shift at llama.cpp. Reject with the recognizable error.
    if (headroom < minCompletion) {
        return { action: 'reject', estTokens: estCentral, effCtx, payload: buildOverflowErrorBody(estCentral, effCtx) };
    }

    if (requestedMax == null) {
        // No output bound at all → bound it by the physical headroom. This is
        // what prevents llama.cpp's silent mid-generation context shift (and
        // an unbounded runaway generation on a looping model).
        body.max_tokens = headroom;
        return { action: 'capped', estTokens: estCentral, effCtx, maxTokens: headroom, nearFull };
    }
    if (requestedMax > headroom) {
        body.max_tokens = headroom;
        if (Number.isFinite(body.max_completion_tokens)) body.max_completion_tokens = headroom;
        return { action: 'clamped', estTokens: estCentral, effCtx, maxTokens: headroom, from: requestedMax, nearFull };
    }
    return { action: 'ok', estTokens: estCentral, effCtx, nearFull };
}

// ── Upstream error normalization ────────────────────────────────────────────
// Recognized-by-clients overflow phrasings (mirrors the core of Pi's
// OVERFLOW_PATTERNS). Both of our backends already emit recognizable text;
// this is insurance for future backends / new wordings.
const OVERFLOW_RECOGNIZED = [
    /exceeds the available context size/i,           // llama.cpp
    /is longer than the model'?s context length/i,   // sglang input overflow
    /maximum context length/i,                       // sglang total overflow / OpenAI-compatible
    /exceeds the context window/i,                   // OpenAI
    /prompt is too long/i,                           // Anthropic-style
    /context[_ ]length[_ ]exceeded/i,                // generic fallback clients match
    /too many tokens/i,
];
const OVERFLOW_SHAPE = /(context|token|prompt|input)/i;
const OVERFLOW_VERB = /(exceed|too (?:long|large|many)|longer than|over the limit|doesn'?t fit|does not fit)/i;

// If a 400/413 upstream error clearly describes a context overflow but in
// wording no client's auto-compaction would recognize, append the canonical
// generic phrase so recovery still triggers. Mutates and returns `data`.
function normalizeOverflowErrorBody(status, data) {
    if (status !== 400 && status !== 413) return data;
    try {
        let holder = null, key = null;
        if (data && typeof data === 'object') {
            if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') { holder = data.error; key = 'message'; }
            else if (typeof data.message === 'string') { holder = data; key = 'message'; }
            else if (typeof data.error === 'string') { holder = data; key = 'error'; }
        }
        if (!holder) return data;
        const msg = holder[key];
        const overflowish = OVERFLOW_SHAPE.test(msg) && OVERFLOW_VERB.test(msg);
        const recognized = OVERFLOW_RECOGNIZED.some((p) => p.test(msg));
        if (overflowish && !recognized) {
            holder[key] = `${msg} (context length exceeded)`;
        }
    } catch (_) { /* normalization must never break error forwarding */ }
    return data;
}

module.exports = {
    V1_CTX_GUARD_ENABLED,
    V1_CTX_MARGIN_TOKENS,
    V1_MIN_COMPLETION_TOKENS,
    effectiveContextSize,
    countRequestChars,
    buildOverflowErrorBody,
    middleTruncate,
    isSingleShotRescuable,
    applyContextGuard,
    normalizeOverflowErrorBody,
};
