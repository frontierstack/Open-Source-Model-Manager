'use strict';
// Model ROLES for a two-model setup: a PRIMARY model does the work (the chat
// turn + delegated worker agents — usually the weaker/faster one) and a
// SECONDARY "checker" model reviews what the primary produced. Pure helpers:
// resolving the roles from a request body / user prefs, building the review
// prompts, parsing the checker's verdict, and rendering it for the user.
// server.js owns the wiring (delegate tool + the chat-stream final check).

const ROLE_KEYS = ['rolePrimaryModel', 'roleCheckerModel', 'roleCheckWorkers', 'roleCheckFinal', 'roleConsult'];
const CHECK_MODES = ['off', 'note', 'edit'];

const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
const bool = (v, dflt) => (typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : dflt));
// checkFinal: 'off' | 'note' (append the verdict) | 'edit' (the checker
// rewrites the answer when it finds problems). Legacy booleans map true→note.
const checkMode = (v, dflt) => {
    if (typeof v === 'boolean') return v ? 'note' : 'off';
    if (typeof v === 'string' && CHECK_MODES.includes(v.trim().toLowerCase())) return v.trim().toLowerCase();
    if (v === 'true') return 'note';
    if (v === 'false') return 'off';
    return dflt;
};

/** Server-wide default roles (system-settings.json) — sanitized. */
function sanitizeSystemRoles(input) {
    const o = input && typeof input === 'object' ? input : {};
    return {
        primary: clean(o.primary),
        checker: clean(o.checker),
        checkWorkers: bool(o.checkWorkers, true),
        checkFinal: checkMode(o.checkFinal, 'off'),
        consult: bool(o.consult, true),
    };
}

/**
 * Resolve the roles for one turn. `body.modelRoles` (sent by the chat UI on
 * every request) wins, then the account's saved chat prefs. A role naming a
 * model that is not running is dropped (never route to a dead instance).
 * @param {{ body?: object, prefs?: object, running?: string[] }} o
 * @returns {{ primary: string|null, checker: string|null, checkWorkers: boolean, checkFinal: boolean, source: string }}
 */
function resolveModelRoles({ body, prefs, system, running, targetModel } = {}) {
    const runningSet = Array.isArray(running) ? new Set(running) : null;
    const fromBody = body && body.modelRoles && typeof body.modelRoles === 'object' ? body.modelRoles : null;
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    const sys = system && typeof system === 'object' ? system : {};
    const has = (v) => v !== undefined && v !== null && v !== '';
    // Per field: request body → the account's chat prefs → the server-wide
    // default set on the Models page. An empty string means "not set here".
    const pick = (bodyKey, prefKey, sysKey) => {
        if (fromBody && has(fromBody[bodyKey])) return fromBody[bodyKey];
        if (has(p[prefKey])) return p[prefKey];
        return sys[sysKey];
    };
    let primary = clean(pick('primary', 'rolePrimaryModel', 'primary'));
    let checker = clean(pick('checker', 'roleCheckerModel', 'checker'));
    const checkWorkers = bool(pick('checkWorkers', 'roleCheckWorkers', 'checkWorkers'), true);
    const checkFinal = checkMode(pick('checkFinal', 'roleCheckFinal', 'checkFinal'), 'off');
    const consult = bool(pick('consult', 'roleConsult', 'consult'), true);
    if (runningSet) {
        if (primary && !runningSet.has(primary)) primary = '';
        if (checker && !runningSet.has(checker)) checker = '';
    }
    // The primary/checker split exists for TWO DIFFERENT models. One model
    // (even with several parallel slots) checking itself is not a second
    // opinion — it doubles the latency for nothing — so when the checker is
    // the same model as the one doing the work, the checker role is ignored.
    const effectivePrimary = primary || clean(targetModel) || '';
    let sameModel = false;
    if (checker && effectivePrimary && checker === effectivePrimary) { checker = ''; sameModel = true; }
    const source = (fromBody && (has(fromBody.primary) || has(fromBody.checker))) ? 'request'
        : (has(p.rolePrimaryModel) || has(p.roleCheckerModel)) ? 'prefs'
        : (has(sys.primary) || has(sys.checker)) ? 'system' : 'none';
    return {
        primary: primary || null,
        checker: checker || null,
        checkWorkers,
        checkFinal,
        consult,
        source,
        sameModel,
    };
}

const REVIEW_FORMAT =
    'Respond with ONLY a JSON object, no prose, no markdown fence:\n' +
    '{"verdict":"pass"|"issues","summary":"one sentence","issues":[{"claim":"the exact statement or value that is wrong or unsupported","problem":"what is wrong and how you know","fix":"the corrected statement, or what must be re-checked"}],"confidence":0.0-1.0}\n' +
    'Rules: only flag REAL problems — factual errors, numbers/dates/names/URLs that contradict the evidence or each other, claims presented as verified without evidence, the task not actually answered, or missing parts of the task. Do not flag style, length or formatting. If you find nothing wrong, verdict is "pass" with an empty issues list.';

const EDIT_FORMAT =
    'Respond with ONLY a JSON object, no prose, no markdown fence:\n' +
    '{"verdict":"pass"|"issues","summary":"one sentence","issues":[{"claim":"…","problem":"…","fix":"…"}],"revised":"the FULL corrected text (same format and language as the original, same markdown, every correct part kept verbatim, only the flagged parts fixed, no commentary about the review) — empty string when verdict is pass","confidence":0.0-1.0}\n' +
    'Rules: only flag and fix REAL problems — factual errors, numbers/dates/names/URLs that contradict the evidence or each other, unsupported claims presented as verified, the task not actually answered, or missing parts. Do not rewrite for style. If nothing is wrong, verdict is "pass", issues is [] and revised is "".';

/** Messages for reviewing one delegated worker's report against its task. */
function buildWorkerReviewMessages({ task, report, label, mode }) {
    return [
        { role: 'system', content: 'You are a strict, fair reviewer checking the work of a faster model. You see the task it was given and the report it wrote. Verify the report against the task: is every part of the task addressed, are the facts internally consistent, is anything asserted that the report does not support with a source, value or path? Be concrete.\n' + (mode === 'edit' ? EDIT_FORMAT : REVIEW_FORMAT) },
        { role: 'user', content: `WORKER: ${label || 'worker'}\n\nTASK GIVEN TO THE WORKER:\n${String(task || '').slice(0, 12000)}\n\nWORKER'S REPORT:\n${String(report || '').slice(0, 20000)}` },
    ];
}

/** Messages for reviewing the final answer of a chat turn. */
function buildFinalReviewMessages({ userAsk, answer, toolSummary, mode }) {
    return [
        { role: 'system', content: 'You are a strict, fair reviewer checking the final answer a faster model gave a user. You see the user\'s request, a summary of the tools the model ran, and the answer. Check that the answer addresses the request, that its facts, numbers, dates, names, paths and URLs are consistent with the tool evidence summary and with each other, and that nothing is asserted as verified without support. Be concrete and brief.\n' + (mode === 'edit' ? EDIT_FORMAT : REVIEW_FORMAT) },
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
    const revisedRaw = typeof obj.revised === 'string' ? obj.revised : (typeof obj.revised_answer === 'string' ? obj.revised_answer : (typeof obj.revised_report === 'string' ? obj.revised_report : ''));
    const revised = verdict === 'issues' && revisedRaw.trim().length >= 20 ? revisedRaw.trim() : '';
    return { verdict, summary: clean2(obj.summary), issues, confidence, revised, raw: raw.slice(0, 2000) };
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
    if (review.edited) {
        const items = review.issues.map(i => `- ${i.claim ? `**${i.claim}** — ` : ''}${i.fix || i.problem || ''}`);
        return `\n\n---\n*✎ Edited by ${who}${review.summary ? ` — ${review.summary}` : ''}. Changes:*\n${items.join('\n')}`;
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

/** Messages for the primary model asking the stronger model for help. */
function buildConsultMessages({ question, context, attempt, primaryModel }) {
    return [
        { role: 'system', content: `You are the stronger expert model on this server. A smaller, faster model${primaryModel ? ` (${primaryModel})` : ''} is doing the user's task and is consulting you on a specific point it is stuck on or unsure about. Answer the question directly and completely: give the reasoning, the correct result, corrected code or the exact next steps. Be precise; do not pad. If the question is under-specified, state the assumption you make and answer anyway. You have no tools — say so if a step needs one and tell the smaller model exactly what to run or look up.` },
        { role: 'user', content: `QUESTION:\n${String(question || '').slice(0, 8000)}${context ? `\n\nCONTEXT (task, evidence, files so far):\n${String(context).slice(0, 16000)}` : ''}${attempt ? `\n\nWHAT I TRIED / MY CURRENT ANSWER:\n${String(attempt).slice(0, 8000)}` : ''}` },
    ];
}

module.exports = {
    ROLE_KEYS,
    CHECK_MODES,
    sanitizeSystemRoles,
    buildConsultMessages,
    resolveModelRoles,
    buildWorkerReviewMessages,
    buildFinalReviewMessages,
    parseReview,
    buildFixRoundTask,
    shouldCheckFinal,
    formatReviewAddendum,
    summarizeToolChips,
};
