'use strict';
// Is the model on this agent task struggling? Read from the conversation the
// client sends (Pi/omp resend the whole history every request), so it needs no
// state and works for any agent. Used to hand a task the FAST model started to
// the STRONGER one on the fly — not by topic (no "app listings go to the 27B"
// rule), but because the fast model's own tool calls keep failing.
//
// Measured case (2026-11-05): the 4B, asked to list Microsoft Store apps, ran
// ~15 PowerShell variants through bash; every one failed (bash ate $_, pipes
// ran outside the quotes) and each retry changed the quoting, so no repeat
// guard fired and the 27B never saw the task.

const FAIL_STREAK = Math.max(1, Number(process.env.PI_ESCALATE_FAIL_STREAK) || 2);
const FAIL_TOTAL = Math.max(FAIL_STREAK, Number(process.env.PI_ESCALATE_FAIL_TOTAL) || 3);

function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && p.type === 'text' ? String(p.text || '') : '')).join('\n');
    return '';
}

// A tool result that reports a failure. Conservative on purpose: an empty
// result, "no matches" or a grep that found nothing is an answer, not a failure.
const FAIL_RES = [
    /Command exited with code [1-9]\d*/i,          // omp bash
    /^\s*error:/im,                                // omp tool errors ("error: command not found: X")
    /\bFullyQualifiedErrorId\b|\+ CategoryInfo\s*:/, // PowerShell error record
    /is not recognized as an internal or external command|is not recognized as the name of a cmdlet/i,
    /\bcommand not found\b/i,
    /^Traceback \(most recent call last\)/m,
    /\[modelserver loop guard\] Not run|\[modelserver: repeated tool call\]/,
    /^\s*\[powershell — (?:exit (?:-?[1-9]\d*|null)|timed out)/m,
];
function isFailedResult(content) {
    const t = contentText(content);
    if (!t) return false;
    return FAIL_RES.some(re => re.test(t));
}

/**
 * Tool results after the latest real user message.
 * @returns {{calls:number, failed:number, streak:number, struggling:boolean, lastErrors:string[]}}
 */
function assessStruggle(messages, opts = {}) {
    const streakAt = opts.streak || FAIL_STREAK;
    const totalAt = opts.total || FAIL_TOTAL;
    const out = { calls: 0, failed: 0, streak: 0, struggling: false, lastErrors: [] };
    if (!Array.isArray(messages)) return out;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user' && !/^\s*\[ASSISTANT RESULTS/.test(contentText(m.content))) { start = i + 1; break; }
    }
    for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.role !== 'tool') continue;
        out.calls++;
        if (isFailedResult(m.content)) {
            out.failed++; out.streak++;
            const line = contentText(m.content).split('\n').map(s => s.trim()).find(s => s && !/^\+|^At line/.test(s)) || '';
            out.lastErrors.push(line.slice(0, 120));
            if (out.lastErrors.length > 3) out.lastErrors.shift();
        } else {
            out.streak = 0;
        }
    }
    out.struggling = out.streak >= streakAt || out.failed >= totalAt;
    return out;
}

function handoverNote(s, fromModel) {
    return `\n\n[modelserver: you are taking over this task from ${fromModel}, after ${s.failed} of its tool call${s.failed === 1 ? '' : 's'} above failed. ` +
        'Read why those calls failed before trying again, change the approach rather than the spelling, and finish the task.]';
}

module.exports = { assessStruggle, isFailedResult, handoverNote, FAIL_STREAK, FAIL_TOTAL };
