'use strict';
// Self-correction for core memory: when a theme's numbers trend the wrong way,
// do something about it, then check whether it worked.
//
//   detect   — a theme measure (response time, tool calls, failed calls,
//              flailing, corrections) getting worse with at least moderate
//              evidence (memoryStats findings, earliest vs latest third).
//   act      — REVERT when the data shows an earlier playbook did better on
//              that measure (by the playbook version each task ran with, else
//              by the tasks around each rewrite); otherwise a TARGETED
//              re-refinement that is told what regressed and shown the slow
//              and the fast recent tasks.
//   evaluate — once EVAL_K tasks ran after the action, compare them with the
//              EVAL_K before it: helped / no effect / worse. A correction that
//              made things worse is rolled back to the playbook it replaced.
//
// Everything here is pure (plain shard objects in, decisions out); the server
// owns the model call and the scheduling. State lives in shard.selfCorrect.

const memoryStats = require('./memoryStats');
const { METRICS, compareGroups } = memoryStats;

const EVAL_K = parseInt(process.env.SELF_CORRECT_EVAL_TASKS, 10) || 6;
const BASE_K = 8;
const COOLDOWN_MS = (parseFloat(process.env.SELF_CORRECT_COOLDOWN_H) || 6) * 3600 * 1000;
const MAX_ATTEMPTS = parseInt(process.env.SELF_CORRECT_MAX_ATTEMPTS, 10) || 3;   // per theme+measure in ATTEMPT_WINDOW
const ATTEMPT_WINDOW_MS = 48 * 3600 * 1000;
const MIN_GROUP = 6;                // tasks per playbook version / per side of a rewrite to judge it
// Acting needs more than the panel shows: strong evidence on 5+ tasks a side,
// or moderate evidence on 8+. A revert must ALSO show the old playbook was
// better with evidence of its own — one flailed task in five is not a pattern.
const ACT_MIN = { strong: 5, moderate: 8 };
const ACTIONS_MAX = 120;
const metricByKey = new Map(METRICS.map(m => [m.key, m]));

function state(shard) {
    if (!shard.selfCorrect || typeof shard.selfCorrect !== 'object') shard.selfCorrect = { actions: [] };
    if (!Array.isArray(shard.selfCorrect.actions)) shard.selfCorrect.actions = [];
    return shard.selfCorrect;
}

function themeRows(shard, th) {
    return (shard.statsLog || []).filter(r => r && r.t && r.th === th && !r.prov)
        .sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

function centre(rows, m) {
    const v = rows.map(m.get).filter(x => x != null && Number.isFinite(x));
    if (!v.length) return null;
    if (m.kind === 'rate') return v.reduce((a, b) => a + b, 0) / v.length;
    const s = v.slice().sort((a, b) => a - b), k = s.length >> 1;
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

// Lower is better for every outcome measure. Points for shares, relative otherwise.
function worseBy(from, to, m) {
    if (from == null || to == null) return null;
    if (m.kind === 'rate' || m.key === 'failedShare') return to - from;
    return from > 0 ? (to - from) / from : null;
}
const THRESH = (m) => (m.kind === 'rate' || m.key === 'failedShare' ? 0.03 : 0.08);

function playbookText(rec, version) {
    if (!rec) return null;
    if (version === rec.playbookVersion) return rec.playbook || null;
    const h = (rec.playbookHistory || []).find(x => x.version === version);
    return h && h.playbook ? h.playbook : null;
}

/**
 * Which earlier playbook did better on this measure? By the version each task
 * ran with (rows carry `pv` from 2026-11-07), else by the tasks just before vs
 * after each rewrite. Returns { version, text, centre, current, basis } or null.
 */
function betterPlaybook(shard, rec, m) {
    const rows = themeRows(shard, rec.theme);
    const groups = new Map();
    for (const r of rows) if (Number.isFinite(r.pv)) { if (!groups.has(r.pv)) groups.set(r.pv, []); groups.get(r.pv).push(r); }
    const cur = rec.playbookVersion || 0;
    const curRows = groups.get(cur) || rows.slice(-BASE_K);
    const curC = centre(curRows.slice(-BASE_K), m);
    let best = null;
    for (const [v, rs] of groups) {
        if (v === cur || rs.length < MIN_GROUP) continue;
        const text = playbookText(rec, v);
        if (!text || text === rec.playbook) continue;
        if (curRows.length < MIN_GROUP) continue;
        const cmp = compareGroups(rs, curRows.slice(-Math.max(MIN_GROUP, BASE_K)), m);
        if (!cmp || cmp.evidence === 'weak') continue;
        const c = cmp.from, d = worseBy(cmp.from, cmp.to, m);   // how much worse the current one is
        if (d != null && d >= THRESH(m) && (!best || c < best.centre)) best = { version: v, text, centre: c, current: cmp.to, basis: 'by-version', n: rs.length };
    }
    if (best) return best;
    // Fallback: the rewrite after which this measure got worse.
    const events = (shard.statsEvents || []).filter(e => e && e.th === rec.theme && e.kind === 'refine' && Number.isFinite(e.v))
        .sort((a, b) => String(b.t).localeCompare(String(a.t)));
    for (const e of events.slice(0, 8)) {
        const before = rows.filter(r => r.t < e.t).slice(-BASE_K);
        const after = rows.filter(r => r.t > e.t).slice(0, BASE_K);
        if (before.length < MIN_GROUP || after.length < MIN_GROUP) continue;
        const cmp = compareGroups(before, after, m);
        if (!cmp || cmp.evidence === 'weak') continue;
        const cb = cmp.from, ca = cmp.to;
        const d = worseBy(cb, ca, m);
        if (d == null || d < THRESH(m)) continue;
        const prevV = (rec.playbookHistory || []).map(h => h.version).filter(v => v < e.v).sort((a, b) => b - a)[0];
        const text = prevV != null ? playbookText(rec, prevV) : null;
        if (text && text !== rec.playbook) return { version: prevV, text, centre: cb, current: ca, basis: 'around-rewrite', n: before.length, rewrite: e.v };
    }
    return null;
}

/** Slowest/heaviest and fastest/leanest recent tasks — the evidence a targeted refine reads. */
function contrastTasks(rec, m) {
    const eps = (rec.episodes || []).filter(e => e && !e.provisional);
    const val = (e) => (m.key === 'seconds' ? e.seconds : m.key === 'calls' ? e.calls
        : m.key === 'failedShare' ? ((e.calls + (e.failed || 0)) ? (e.failed || 0) / (e.calls + (e.failed || 0)) : 0)
        : m.key === 'rough' ? (e.rough ? 1 : 0) : e.calls);
    const scored = eps.filter(e => val(e) != null).map(e => ({ e, v: val(e) })).sort((a, b) => a.v - b.v);
    if (scored.length < 2) return { bad: [], good: [] };
    return { good: scored.slice(0, 2).map(x => x.e), bad: scored.slice(-2).reverse().map(x => x.e) };
}

function fmtVal(v, m) {
    if (v == null) return '?';
    if (m.kind === 'rate' || m.key === 'failedShare') return `${Math.round(v * 100)}%`;
    if (m.key === 'seconds') return `${Math.round(v)} s`;
    return String(Math.round(v * 10) / 10);
}

function fmtMetric(key, v) { const m = metricByKey.get(key); return m ? fmtVal(v, m) : String(v); }

function correctionInput(rec, f, m) {
    const { bad, good } = contrastTasks(rec, m);
    const line = (e) => `- "${e.task}" → ${e.calls} call${e.calls === 1 ? '' : 's'}${e.failed ? ` (${e.failed} failed)` : ''}${e.seconds != null ? `, ${e.seconds} s` : ''}${e.rough ? ' [ROUGH]' : ''}: ${e.approach || 'no tools'}`;
    const parts = [
        `REGRESSION TO FIX: "${m.label}" for this theme got worse — ${fmtVal(f.from, m)} → ${fmtVal(f.to, m)} between its earliest and latest tasks (${f.nFrom} vs ${f.nTo} tasks).`,
        'Rewrite the playbook so the next tasks bring this measure back down. Find what the slow/heavy tasks did that the fast/lean ones did not (extra searches, re-reading, retries of a failing call, scripts where a tool exists, missing early checks) and turn the difference into a concrete instruction. Keep what the fast tasks did.',
    ];
    if (bad.length) parts.push('WORST RECENT TASKS on this measure:\n' + bad.map(line).join('\n'));
    if (good.length) parts.push('BEST RECENT TASKS on this measure:\n' + good.map(line).join('\n'));
    return parts.join('\n\n');
}

/**
 * Decide what to do now. `findings` = computeStats(...).findings.worsening.
 * Returns [{ th, label, metric, metricLabel, kind: 'revert'|'refine', ... }]
 * — at most one per theme, none while a correction on that theme is still
 * being evaluated or inside its cooldown.
 */
function plan(shard, findings, { now = Date.now() } = {}) {
    const st = state(shard);
    const out = [];
    // Every worsening theme measure with an explanation of what the check
    // decided about it — the Stats view shows this as the check's log.
    const considered = [];
    const note = (f, decision, reason) => considered.push({
        th: f.scope, label: f.scopeLabel, metric: f.metric, metricLabel: f.metricLabel,
        from: f.from, to: f.to, changeKind: f.changeKind, evidence: f.evidence, decision, reason,
    });
    const seen = new Set();
    for (const f of findings || []) {
        if (!f || f.direction !== 'worse' || !f.scope || f.scope === 'chat') continue;
        const m = metricByKey.get(f.metric);
        if (!m) continue;
        const have = Math.min(f.nFrom || 0, f.nTo || 0);
        if (!ACT_MIN[f.evidence]) { note(f, 'skip', `could be chance (${have} vs ${have} tasks) — not acted on`); continue; }
        if (have < ACT_MIN[f.evidence]) { note(f, 'wait', `${f.evidence === 'strong' ? 'strong' : 'some'} evidence but only ${have} tasks a side; acts at ${ACT_MIN[f.evidence]}+`); continue; }
        const rec = (shard.memories || []).find(r => r.theme === f.scope);
        if (!rec) { note(f, 'skip', 'no memory for this theme yet'); continue; }
        if (rec.enabled === false) { note(f, 'skip', 'this theme’s memory is paused'); continue; }
        const mine = st.actions.filter(a => a.th === f.scope);
        const act = mine.find(a => a.status === 'active');
        if (act) { note(f, 'wait', `a correction for ${act.metricLabel.toLowerCase()} is being measured on this theme — one at a time`); continue; }
        if (seen.has(f.scope)) { note(f, 'wait', 'another measure of this theme is being corrected in this check'); continue; }
        const last = mine[mine.length - 1];
        if (last && now - Date.parse(last.t) < COOLDOWN_MS) {
            const h = Math.max(1, Math.ceil((COOLDOWN_MS - (now - Date.parse(last.t))) / 3600000));
            note(f, 'wait', `cooling down after the last attempt (${STATUS_WORD[last.status] || last.status}); next try in ~${h} h`); continue;
        }
        const attempts = mine.filter(a => a.metric === f.metric && now - Date.parse(a.t) < ATTEMPT_WINDOW_MS).length;
        if (attempts >= MAX_ATTEMPTS) { note(f, 'skip', `${attempts} attempts in 48 h without a fix — paused to avoid churning the playbook`); continue; }
        seen.add(f.scope);
        const base = {
            th: f.scope, label: rec.label, metric: f.metric, metricLabel: m.label,
            trigger: { from: f.from, to: f.to, change: f.change, changeKind: f.changeKind, evidence: f.evidence, p: f.p, nFrom: f.nFrom, nTo: f.nTo },
        };
        const better = betterPlaybook(shard, rec, m);
        if (better) {
            out.push({ ...base, kind: 'revert', toVersion: better.version, text: better.text, basis: better.basis,
                why: `playbook v${better.version} ran this theme at ${fmtVal(better.centre, m)} vs ${fmtVal(better.current, m)} now` });
            note(f, 'act', `restoring playbook v${better.version}, which measured ${fmtVal(better.centre, m)} vs ${fmtVal(better.current, m)} now`);
        } else {
            out.push({ ...base, kind: 'refine', input: correctionInput(rec, f, m),
                why: `${m.label.toLowerCase()} went ${fmtVal(f.from, m)} → ${fmtVal(f.to, m)}; rewriting the playbook against the slow tasks` });
            note(f, 'act', 'no earlier playbook measured better — rewriting the playbook against the slow tasks');
        }
    }
    out.considered = considered;
    return out;
}
const STATUS_WORD = { helped: 'it helped', no_effect: 'no clear effect', worse: 'it made things worse', rolled_back: 'rolled back' };

/** Keep a short log of checks (newest last). */
const CHECKS_MAX = 40;
function logCheck(shard, entry) {
    const st = state(shard);
    if (!Array.isArray(st.checks)) st.checks = [];
    st.checks.push(entry);
    while (st.checks.length > CHECKS_MAX) st.checks.shift();
}

/** Record an applied action (inside a shard mutation). */
function recordAction(shard, d, { now = Date.now(), fromVersion, toVersion, prevPlaybook, newPlaybook = null }) {
    const st = state(shard);
    const m = metricByKey.get(d.metric);
    const rows = themeRows(shard, d.th);
    const a = {
        id: `sc_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        t: new Date(now).toISOString(), th: d.th, label: d.label, metric: d.metric, metricLabel: d.metricLabel,
        kind: d.kind, why: d.why, trigger: d.trigger, basis: d.basis || null,
        fromVersion, toVersion, prevPlaybook: prevPlaybook || null, newPlaybook: newPlaybook || null,
        baseline: m ? centre(rows.slice(-BASE_K), m) : null, baselineN: Math.min(BASE_K, rows.length),
        status: 'active', after: null,
    };
    st.actions.push(a);
    while (st.actions.length > ACTIONS_MAX) st.actions.shift();
    return a;
}

/**
 * Judge active actions whose follow-up window has filled. Returns the judged
 * actions; those with `rollback` set should have their playbook restored.
 */
function evaluate(shard, { now = Date.now() } = {}) {
    const st = state(shard);
    const judged = [];
    for (const a of st.actions) {
        if (a.status !== 'active') continue;
        const m = metricByKey.get(a.metric);
        if (!m) { a.status = 'no_effect'; continue; }
        const after = themeRows(shard, a.th).filter(r => r.t > a.t);
        const vals = after.filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
        a.progress = Math.min(vals.length, EVAL_K);
        if (vals.length < EVAL_K) continue;
        const to = centre(vals.slice(0, EVAL_K), m);
        const d = worseBy(a.baseline, to, m);
        a.after = { value: to, n: EVAL_K, change: d, changeKind: (m.kind === 'rate' || m.key === 'failedShare') ? 'points' : 'relative' };
        a.judgedAt = new Date(now).toISOString();
        if (d == null) a.status = 'no_effect';
        else if (d <= -THRESH(m)) a.status = 'helped';
        else if (d >= THRESH(m)) { a.status = 'worse'; if (a.prevPlaybook) a.rollback = true; }
        else a.status = 'no_effect';
        judged.push(a);
    }
    return judged;
}

/** Would plan() act on this finding (ignoring cooldowns)? And if not, why. */
function assessFinding(f) {
    if (!f || f.direction !== 'worse' || !f.scope || f.scope === 'chat') return { actionable: false, reason: 'not a theme measure' };
    const need = ACT_MIN[f.evidence];
    if (!need) return { actionable: false, reason: 'could still be chance' };
    const have = Math.min(f.nFrom || 0, f.nTo || 0);
    if (have < need) return { actionable: false, reason: `needs ${need}+ tasks on each side at this evidence (has ${have})` };
    return { actionable: true, reason: '' };
}

// An active correction as it stands right now: tasks measured so far and the
// measure over them against the baseline (an interim reading, not a verdict).
function liveProgress(shard, a) {
    const m = metricByKey.get(a.metric);
    if (!m) return {};
    const vals = themeRows(shard, a.th).filter(r => r.t > a.t).filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
    const done = vals.slice(0, EVAL_K);
    const value = done.length ? centre(done, m) : null;
    const change = worseBy(a.baseline, value, m);
    const all = themeRows(shard, a.th);
    const lastTheme = all.length ? all[all.length - 1].t : null;
    const now = Date.now();
    const recent = all.filter(r => now - Date.parse(r.t) < 14 * 86400000).length;
    const perDay = recent / 14;
    const remaining = Math.max(0, EVAL_K - done.length);
    return {
        lastThemeTaskAt: lastTheme,
        themeTasks14d: recent,
        etaDays: remaining && perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
        progress: done.length,
        remaining: Math.max(0, EVAL_K - done.length),
        lastTaskAt: done.length ? done[done.length - 1].t : null,
        interim: value == null ? null : {
            value, change,
            changeKind: (m.kind === 'rate' || m.key === 'failedShare') ? 'points' : 'relative',
            direction: change == null ? 'flat' : change <= -THRESH(m) ? 'better' : change >= THRESH(m) ? 'worse' : 'flat',
        },
    };
}

function versionText(shard, th, v) {
    const rec = (shard.memories || []).find(r => r.theme === th);
    const t = rec && v != null ? playbookText(rec, v) : null;
    return t ? t.slice(0, 600) : null;
}

/** What the Stats view shows. `worsening` = the current worsening findings. */
function publicState(shard, worsening = []) {
    const st = state(shard);
    return {
        watch: (worsening || []).filter(f => f && f.scope && f.scope !== 'chat' && f.evidence !== 'weak')
            .map(f => ({ scope: f.scope, scopeLabel: f.scopeLabel, metric: f.metric, metricLabel: f.metricLabel,
                from: f.from, to: f.to, change: f.change, changeKind: f.changeKind, evidence: f.evidence, nFrom: f.nFrom, nTo: f.nTo,
                ...assessFinding(f) })),
        evalTasks: EVAL_K,
        cooldownHours: COOLDOWN_MS / 3600000,
        actions: st.actions.slice(-40).reverse().map(({ prevPlaybook, rollback, ...a }) => ({
            ...a, canRollBack: !!prevPlaybook,
            fromText: prevPlaybook ? prevPlaybook.slice(0, 600) : null,
            toText: a.newPlaybook ? String(a.newPlaybook).slice(0, 600) : versionText(shard, a.th, a.toVersion),
            ...(a.status === 'active' ? liveProgress(shard, a) : {}),
        })).map(({ newPlaybook, ...a }) => a),
        checks: (st.checks || []).slice(-15).reverse(),
        lastCheckAt: st.lastCheckAt || null,
    };
}

module.exports = { logCheck, assessFinding, plan, evaluate, recordAction, publicState, betterPlaybook, correctionInput, state, EVAL_K, COOLDOWN_MS, fmtVal, fmtMetric };
