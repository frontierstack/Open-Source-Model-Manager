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

// ── Spreading worker agents across loaded models ─────────────────────────────
// `delegate` used to run EVERY worker on one model (the primary), so two
// workers shared that model's slots and the second loaded model sat idle —
// measured 58 s for a 2-worker turn against 33 s for the same task done by one
// agent. Assignment now fans out across every loaded model that has capacity.
//
// Rules, in order:
//   1. A model needs an effective context window big enough for a worker turn
//      (prelude + tool catalog + the task). Below `minContext` it is skipped.
//   2. Models with an IDLE slot come before models where every slot is busy;
//      within each group, more free slots first, then more context, then name
//      (stable, so the same fleet always assigns the same way).
//   3. One worker per model first (true parallelism), then a second round over
//      models that still have a free slot, then the preferred model absorbs the
//      remainder (they queue at that backend, exactly as before).
//
// `capacity` is chatCapacity(): { models: [{ name, slots, busy, free }] }.
// `contextOf` maps a model name to its per-slot context (null = unknown, which
// is treated as acceptable). `preferred` is the primary/composer model, which
// keeps its place at the head of the list so a single-model host is unchanged.
// Cost model for placing workers. llama.cpp's continuous batching means two
// concurrent decodes on one model do NOT cost 2× — measured on this host, a
// second stream slows each by ~45% (one 9B worker turn 38 s, two together
// ~55 s). So the k-th worker on a model costs (1 + 0.45·(k−1)) work units.
const CONTENTION = 0.45;
function slotCost(k) { return 1 + CONTENTION * Math.max(0, k - 1); }

function assignWorkerModels({ count, capacity, preferred, contextOf, speedOf, minContext = 8192, exclude } = {}) {
    const n = Math.max(0, Math.trunc(count) || 0);
    if (n === 0) return [];
    const fallback = preferred || null;
    const all = (capacity && Array.isArray(capacity.models)) ? capacity.models : [];
    const skip = new Set(Array.isArray(exclude) ? exclude : (exclude ? [exclude] : []));
    const numOrNull = (fn, name) => {
        if (typeof fn !== 'function') return null;
        const v = Number(fn(name));
        return Number.isFinite(v) && v > 0 ? v : null;
    };
    const usable = all
        .filter(m => m && m.name && !skip.has(m.name))
        .filter(m => { const c = numOrNull(contextOf, m.name); return c === null || c >= minContext; })
        .map(m => ({
            name: m.name,
            free: Math.max(0, Math.trunc(Number(m.free)) || 0),
            slots: Math.max(1, Math.trunc(Number(m.slots)) || 1),
            ctx: numOrNull(contextOf, m.name) || 0,
            speed: numOrNull(speedOf, m.name),
        }));
    if (usable.length === 0) return Array.from({ length: n }, () => fallback);

    // Without measured speeds every model looks equally good, so fall back to a
    // stable preference order (the turn's own model first, then most free slots
    // / biggest context / name).
    const anySpeed = usable.some(m => m.speed);
    const median = (() => {
        const v = usable.map(m => m.speed).filter(Boolean).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : 1;
    })();
    for (const m of usable) if (!m.speed) m.speed = median;

    usable.sort((a, b) => {
        if (a.name === preferred && b.name !== preferred) return -1;
        if (b.name === preferred && a.name !== preferred) return 1;
        if (anySpeed && a.speed !== b.speed) return b.speed - a.speed;
        const aIdle = a.free > 0 ? 1 : 0, bIdle = b.free > 0 ? 1 : 0;
        if (aIdle !== bIdle) return bIdle - aIdle;
        if (a.free !== b.free) return b.free - a.free;
        if (a.ctx !== b.ctx) return b.ctx - a.ctx;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    // Greedy makespan: give each task to whichever model would finish it
    // soonest given what it already holds. A model 2.8× slower only earns a
    // worker once piling another one on the fast model would cost more — which
    // is why a fast 9B + a slow 27B keeps BOTH workers on the 9B (measured: the
    // naive one-each split made the turn 85 s against 58 s stacked).
    const held = new Map(usable.map(m => [m.name, 0]));
    const out = [];
    for (let i = 0; i < n; i++) {
        let best = null, bestCost = Infinity;
        for (const m of usable) {
            const k = held.get(m.name) + 1;
            // Past its free slots the work queues at the backend: the new
            // worker waits for a slot, so its finish time stacks.
            const queued = Math.max(0, k - Math.max(1, m.free));
            const cost = (slotCost(Math.min(k, Math.max(1, m.free))) + queued) / m.speed;
            if (cost < bestCost - 1e-9) { best = m; bestCost = cost; }
        }
        if (!best) break;
        held.set(best.name, held.get(best.name) + 1);
        out.push(best.name);
    }
    const spill = usable.some(m => m.name === fallback) ? fallback : usable[0].name;
    while (out.length < n) out.push(spill);
    return out;
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
    assignWorkerModels,
};
