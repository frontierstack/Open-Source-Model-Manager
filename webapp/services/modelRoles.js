'use strict';
// Model ROLES for a two-model setup: a PRIMARY model does the work (the chat
// turn + delegated worker agents — usually the weaker/faster one) and a
// SECONDARY "checker" model reviews what the primary produced. Pure helpers:
// resolving the roles from a request body / user prefs, building the review
// prompts, parsing the checker's verdict, and rendering it for the user.
// server.js owns the wiring (delegate tool + the chat-stream final check).

const ROLE_KEYS = ['rolePrimaryModel', 'roleCheckerModel', 'roleCheckWorkers', 'roleCheckFinal'];

const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
const bool = (v, dflt) => (typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : dflt));

/**
 * Resolve the roles for one turn. `body.modelRoles` (sent by the chat UI on
 * every request) wins, then the account's saved chat prefs. A role naming a
 * model that is not running is dropped (never route to a dead instance).
 * @param {{ body?: object, prefs?: object, running?: string[] }} o
 * @returns {{ primary: string|null, checker: string|null, checkWorkers: boolean, checkFinal: boolean, source: string }}
 */
function resolveModelRoles({ body, prefs, running } = {}) {
    const runningSet = Array.isArray(running) ? new Set(running) : null;
    const fromBody = body && body.modelRoles && typeof body.modelRoles === 'object' ? body.modelRoles : null;
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    const pick = (bodyKey, prefKey) => (fromBody && bodyKey in fromBody) ? fromBody[bodyKey] : p[prefKey];
    let primary = clean(pick('primary', 'rolePrimaryModel'));
    let checker = clean(pick('checker', 'roleCheckerModel'));
    const checkWorkers = bool(pick('checkWorkers', 'roleCheckWorkers'), true);
    const checkFinal = bool(pick('checkFinal', 'roleCheckFinal'), false);
    if (runningSet) {
        if (primary && !runningSet.has(primary)) primary = '';
        if (checker && !runningSet.has(checker)) checker = '';
    }
    return {
        primary: primary || null,
        checker: checker || null,
        checkWorkers,
        checkFinal,
        source: fromBody ? 'request' : (ROLE_KEYS.some(k => k in p) ? 'prefs' : 'none'),
    };
}

const REVIEW_FORMAT =
    'Respond with ONLY a JSON object, no prose, no markdown fence:\n' +
    '{"verdict":"pass"|"issues","summary":"one sentence","issues":[{"claim":"the exact statement or value that is wrong or unsupported","problem":"what is wrong and how you know","fix":"the corrected statement, or what must be re-checked"}],"confidence":0.0-1.0}\n' +
    'Rules: only flag REAL problems — factual errors, numbers/dates/names/URLs that contradict the evidence or each other, claims presented as verified without evidence, the task not actually answered, or missing parts of the task. Do not flag style, length or formatting. If you find nothing wrong, verdict is "pass" with an empty issues list.';

/** Messages for reviewing one delegated worker's report against its task. */
function buildWorkerReviewMessages({ task, report, label }) {
    return [
        { role: 'system', content: 'You are a strict, fair reviewer checking the work of a faster model. You see the task it was given and the report it wrote. Verify the report against the task: is every part of the task addressed, are the facts internally consistent, is anything asserted that the report does not support with a source, value or path? Be concrete.\n' + REVIEW_FORMAT },
        { role: 'user', content: `WORKER: ${label || 'worker'}\n\nTASK GIVEN TO THE WORKER:\n${String(task || '').slice(0, 12000)}\n\nWORKER'S REPORT:\n${String(report || '').slice(0, 20000)}` },
    ];
}

/** Messages for reviewing the final answer of a chat turn. */
function buildFinalReviewMessages({ userAsk, answer, toolSummary }) {
    return [
        { role: 'system', content: 'You are a strict, fair reviewer checking the final answer a faster model gave a user. You see the user\'s request, a summary of the tools the model ran, and the answer. Check that the answer addresses the request, that its facts, numbers, dates, names, paths and URLs are consistent with the tool evidence summary and with each other, and that nothing is asserted as verified without support. Be concrete and brief.\n' + REVIEW_FORMAT },
        { role: 'user', content: `USER'S REQUEST:\n${String(userAsk || '').slice(0, 8000)}\n\nTOOLS THE MODEL RAN (with their results):\n${String(toolSummary || '(none)').slice(0, 40000)}\n\nMODEL'S ANSWER:\n${String(answer || '').slice(0, 24000)}` },
    ];
}

/** Parse the checker's JSON (tolerant: fences, prose around it, jsonrepair when available). */
function parseReview(text) {
    const raw = String(text || '').trim();
    const empty = { verdict: 'unknown', summary: '', issues: [], confidence: null, raw: raw.slice(0, 2000) };
    if (!raw) return empty;
    let slice = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = slice.indexOf('{'), b = slice.lastIndexOf('}');
    if (a >= 0 && b > a) slice = slice.slice(a, b + 1);
    let obj = null;
    try { obj = JSON.parse(slice); } catch (_) {
        try { obj = JSON.parse(require('jsonrepair').jsonrepair(slice)); } catch (_) { obj = null; }
    }
    if (!obj || typeof obj !== 'object') {
        // Prose fallback — a plain "looks correct" still counts as a pass.
        if (/^(pass|looks? (correct|good|fine)|no (issues?|problems?)( found)?)\b/i.test(raw)) return { ...empty, verdict: 'pass', summary: raw.slice(0, 300) };
        return empty;
    }
    const issues = (Array.isArray(obj.issues) ? obj.issues : [])
        .map(i => (i && typeof i === 'object')
            ? { claim: clean2(i.claim), problem: clean2(i.problem), fix: clean2(i.fix) }
            : (typeof i === 'string' ? { claim: '', problem: clean2(i), fix: '' } : null))
        .filter(i => i && (i.claim || i.problem || i.fix))
        .slice(0, 10);
    let verdict = String(obj.verdict || '').toLowerCase();
    if (verdict !== 'pass' && verdict !== 'issues') verdict = issues.length ? 'issues' : (verdict ? 'pass' : 'unknown');
    if (verdict === 'issues' && !issues.length) verdict = 'pass';
    const confidence = Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(1, Number(obj.confidence))) : null;
    return { verdict, summary: clean2(obj.summary), issues, confidence, raw: raw.slice(0, 2000) };
}
function clean2(v) { return typeof v === 'string' ? v.trim().slice(0, 600) : (v == null ? '' : String(v).slice(0, 600)); }

/** Task text for the worker's one revision round after the checker flagged issues. */
function buildFixRoundTask({ task, report, review }) {
    const lines = (review && review.issues || []).map((i, n) =>
        `${n + 1}. ${i.claim ? `Claim: ${i.claim}\n   ` : ''}Problem: ${i.problem || '(unspecified)'}${i.fix ? `\n   Fix: ${i.fix}` : ''}`);
    return `${task}\n\n--- REVISION ROUND ---\nYour previous report was reviewed by a checker model, which found these problems:\n${lines.join('\n') || review && review.summary || '(see summary)'}\n${review && review.summary ? `Checker summary: ${review.summary}\n` : ''}\nRe-verify the flagged points with your tools (re-read the source, re-run the computation) and write the CORRECTED full report. Keep everything that was right. If a flagged point was actually correct, keep it and say what evidence supports it.\n\nYOUR PREVIOUS REPORT:\n${String(report || '').slice(0, 16000)}`;
}

/** Whether a final answer is worth a checker pass (skip trivial chat). */
function shouldCheckFinal({ answer, toolCalls, minChars = 300 } = {}) {
    const len = String(answer || '').trim().length;
    if (!len) return false;
    if ((toolCalls || 0) > 0) return true;
    return len >= minChars;
}

/** Markdown addendum appended to a checked final answer. */
function formatReviewAddendum(review, checkerModel) {
    const who = checkerModel ? `\`${checkerModel}\`` : 'the checker model';
    if (review && typeof review.summary === 'string') review = { ...review, summary: review.summary.replace(/[.\s]+$/, '') };
    if (!review || review.verdict === 'unknown') {
        return `\n\n---\n*Checker (${who}): review could not be completed${review && review.raw ? ` — ${review.raw.slice(0, 160).replace(/\s+/g, ' ')}` : ''}.*`;
    }
    if (review.verdict === 'pass') {
        return `\n\n---\n*✓ Checked by ${who}${review.summary ? ` — ${review.summary}` : ' — no issues found'}.*`;
    }
    const items = review.issues.map(i => {
        const head = i.claim ? `**${i.claim}** — ` : '';
        return `- ${head}${i.problem || ''}${i.fix ? ` *Fix:* ${i.fix}` : ''}`;
    });
    return `\n\n---\n**⚠ Checker (${who}) found ${review.issues.length} issue${review.issues.length === 1 ? '' : 's'}${review.summary ? ` — ${review.summary}` : ''}:**\n${items.join('\n')}`;
}

/** Compact one-line-per-call summary of a turn's tool chips for the final review. */
function summarizeToolChips(chips) {
    if (!Array.isArray(chips) || !chips.length) return '';
    return chips.slice(0, 40).map((c) => {
        const name = c.label || c.name || (c.function && c.function.name) || 'tool';
        const status = c.status === 'failed' || c.error ? 'FAILED' : 'ok';
        const purpose = c.purpose ? ` — ${String(c.purpose).slice(0, 120)}` : '';
        let preview = '';
        const src = c.preview || (c.result && typeof c.result === 'object' ? JSON.stringify(c.result) : c.result);
        if (src) preview = ` → ${String(src).replace(/\s+/g, ' ').slice(0, 240)}`;
        return `${name} [${status}]${purpose}${preview}`;
    }).join('\n');
}

module.exports = {
    ROLE_KEYS,
    resolveModelRoles,
    buildWorkerReviewMessages,
    buildFinalReviewMessages,
    parseReview,
    buildFixRoundTask,
    shouldCheckFinal,
    formatReviewAddendum,
    summarizeToolChips,
};
