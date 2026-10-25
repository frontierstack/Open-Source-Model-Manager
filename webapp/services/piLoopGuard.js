'use strict';
// Server-side backstop for an agent that re-issues the SAME tool call forever
// (identical name + arguments, identical result). The Pi extension has its own
// guard (note → block); this one works for any /v1 tool loop, including Pi
// installs that predate it, by reading the conversation the client sends:
//   - from PI_LOOP_NOTE_AT identical results, a note is appended to the latest
//     tool result (the newest message, so the cached prefix is untouched);
//   - from PI_LOOP_FORCE_AT, the request goes out with tool_choice "none" and
//     an instruction to answer — the loop ends with a reply, not a dead stop.
// Measured case: `wait <pid>` in a fresh bash shell fails at once (the PID is
// not a child of that shell), "still running" came back 409 times in 500 s.

const LOOP_MARK = '[modelserver loop guard]';
const SERVER_MARK = '[modelserver: repeated tool call]';
const NOTE_AT = Math.max(2, Number(process.env.PI_LOOP_NOTE_AT) || 4);
const FORCE_AT = Math.max(NOTE_AT + 1, Number(process.env.PI_LOOP_FORCE_AT) || 10);

function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && p.type === 'text' ? String(p.text || '') : '')).join('\n');
    return '';
}

function outcomeSig(content) {
    let t = contentText(content);
    for (const mark of [LOOP_MARK, SERVER_MARK]) { const i = t.indexOf(mark); if (i >= 0) t = t.slice(0, i); }
    t = t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    return t.length > 4000 ? t.slice(0, 2000) + t.slice(-2000) : t;
}

function callKey(fn) {
    let args = fn && fn.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep raw text */ } }
    return `${fn && fn.name}\u0000${typeof args === 'string' ? args.replace(/\s+/g, ' ').trim() : stableStringify(args ?? {})}`;
}

/** Why a bash command can never see shell state from an earlier call, or ''. */
function freshShellHint(command) {
    const c = String(command || '');
    const bare = c.replace(/&&|\|&|\d?>&\d?|&>>?|<&\d?/g, ' ');
    const startsChild = /&/.test(bare) || /\bnohup\b|\bsetsid\b/.test(c);
    if (/\b(?:wait|fg|bg|disown|jobs)\b|\bkill\s+%/.test(c) && !startsChild) {
        return 'Each bash call runs in a NEW shell: `wait`/`jobs`/`fg` only see processes started in the same call, so this can never report a process from an earlier call finishing. Check a PID with `kill -0 <pid> 2>/dev/null && echo running || echo finished`, or start and wait in ONE call.';
    }
    return '';
}

/**
 * Look at the tool calls after the latest user message. Returns null when the
 * latest message is not a tool result or nothing repeats; otherwise
 * { name, count, preview, hint }.
 */
function detectRepeat(messages, minCount = NOTE_AT) {
    if (!Array.isArray(messages) || !messages.length) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'tool') return null;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user' && !/^\s*\[ASSISTANT RESULTS/.test(contentText(m.content))) { start = i + 1; break; }
    }
    const calls = new Map(); // tool_call_id -> {key, name, args}
    const seq = [];
    for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) if (tc && tc.id) calls.set(tc.id, { key: callKey(tc.function), name: tc.function && tc.function.name, args: tc.function && tc.function.arguments });
        } else if (m.role === 'tool') {
            const c = calls.get(m.tool_call_id);
            if (c) seq.push({ ...c, sig: outcomeSig(m.content) });
        }
    }
    if (!seq.length) return null;
    const cur = seq[seq.length - 1];
    if (calls.get(last.tool_call_id)?.key !== cur.key) return null;
    const count = seq.filter(s => s.key === cur.key && s.sig === cur.sig).length;
    if (count < minCount) return null;
    let command = '';
    try { const a = typeof cur.args === 'string' ? JSON.parse(cur.args) : cur.args; command = a && a.command; } catch { /* ignore */ }
    const preview = cur.sig.length > 160 ? `${cur.sig.slice(0, 160)}…` : (cur.sig || '(no output)');
    return { name: cur.name, count, preview, hint: cur.name === 'bash' ? freshShellHint(command) : '' };
}

function appendToContent(msg, text) {
    if (typeof msg.content === 'string' || msg.content == null) msg.content = `${msg.content || ''}${text}`;
    else if (Array.isArray(msg.content)) msg.content = [...msg.content, { type: 'text', text }];
}

/**
 * Mutates body when the latest tool result repeats. Returns
 * { action: 'note'|'force', count, name } or null.
 */
function applyLoopGuard(body, opts = {}) {
    const rep = detectRepeat(body && body.messages, opts.clientGuard ? 2 : NOTE_AT);
    if (!rep) return null;
    const last = body.messages[body.messages.length - 1];
    const lastText = contentText(last.content);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    // A client with its own guard (the Pi extension times each call, so it
    // can tell a real `sleep 15; check` poll from a spin) owns the notes; the
    // server only ends the loop once that guard has blocked the call twice.
    if (opts.clientGuard) {
        if (!(hasTools && lastText.includes(`${LOOP_MARK} Not run:`) && rep.count >= 2)) return null;
    }
    const force = hasTools && (opts.clientGuard || rep.count >= FORCE_AT);
    const already = lastText.includes(LOOP_MARK);
    if (force) {
        body.tool_choice = 'none';
        appendToContent(last, `\n\n${SERVER_MARK} This exact ${rep.name} call has returned the same result ${rep.count} times ("${rep.preview}"). Tools are disabled for this reply. ${rep.hint ? rep.hint + ' ' : ''}Answer the user now: say what you found, what is still unknown or still running, and what they could run to finish it. Do not call any tool.`);
        return { action: 'force', count: rep.count, name: rep.name };
    }
    if (already) return null; // the extension already said it
    appendToContent(last, `\n\n${SERVER_MARK} This exact ${rep.name} call has returned the same result ${rep.count} times. Running it again will not change it. ${rep.hint ? rep.hint + ' ' : ''}If you are waiting for something, wait INSIDE one call (e.g. "sleep 10;" before the check) or tell the user it is still running; otherwise do something that can reveal new information, or answer with what you have. Never kill, stop or delete anything just to end a wait. After ${FORCE_AT} identical results tools are switched off for a reply.`);
    return { action: 'note', count: rep.count, name: rep.name };
}

module.exports = { applyLoopGuard, detectRepeat, freshShellHint, outcomeSig, callKey, NOTE_AT, FORCE_AT, LOOP_MARK, SERVER_MARK };
