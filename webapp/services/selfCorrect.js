'use strict';
// Self-correction for core memory: when a theme's numbers trend the wrong way,
// do something about it, then check whether it worked.
//
//   detect   — a theme measure (response time, tool calls, failed calls,
//              repeated failures, corrections) getting worse with moderate or
//              strong evidence, over the tasks that RECEIVED the theme's memory
//              (memoryStats.correctionFindings, earliest vs latest third).
//   act      — REVERT when the data shows an earlier playbook did better on
//              that measure (by the playbook version each task ran with, else
//              by the tasks around each rewrite); otherwise a TARGETED
//              re-refinement that is told what regressed and shown the slow
//              and the fast recent tasks.
//   evaluate — ONE look, after EVAL_K (8) tasks that actually received the
//              corrected playbook: a measure counts as better or worse only
//              with strong evidence against the tasks before the fix, else it
//              is no effect. Closed as inconclusive if too few tasks ever use
//              it. One correction per theme covers all its worsening measures;
//              themes are corrected in parallel.
//
// Why these bars (placebo over the real task history, 2026-11-09: the verdict
// applied at positions where nothing was corrected): the old 3-task median rule
// called 89% of them better or worse, and "any of two measures worse" rolled
// back 61%. Moderate evidence at 8 tasks still misfired 31-53%, looking at
// 3..8 tasks repeatedly 45-63%; strong evidence at one look at 8 misfired 4-8%.
// One task's calls run from 1 to 34, so a handful of tasks cannot say more.
//
// Everything here is pure (plain shard objects in, decisions out); the server
// owns the model call and the scheduling. State lives in shard.selfCorrect.

const memoryStats = require('./memoryStats');
const { METRICS, compareGroups } = memoryStats;

const EVAL_K = parseInt(process.env.SELF_CORRECT_EVAL_TASKS, 10) || 8;     // tasks that used the fix, to a verdict
const MIN_READINGS = Math.ceil(EVAL_K * 0.75);
// Two looks instead of one (2026-11-11): a clear effect is decided after
// EARLY_K tasks at a much stricter bar, otherwise at EVAL_K as before.
// Placebo over the real history: false verdicts 5.1% with both looks vs 5.9%
// for the single look at p < 0.05; a real 2-3x change in calls is decided at
// the early look 5-12% of the time.
const EARLY_K = parseInt(process.env.SELF_CORRECT_EARLY_TASKS, 10) || 5;
const P_EARLY = 0.01;
const P_FINAL = 0.04;   // response time can be missing on a task
const BASE_K = 8;
// A correction that too few tasks ever use must not stay open: while it is
// active the theme gets no new correction and no ordinary refinement.
const EVAL_MAX_TASKS = parseInt(process.env.SELF_CORRECT_EVAL_MAX_TASKS, 10) || 20;   // theme tasks since the fix
const EVAL_MAX_MS = (parseFloat(process.env.SELF_CORRECT_EVAL_MAX_DAYS) || 21) * 86400000;
const COOLDOWN_MS = (parseFloat(process.env.SELF_CORRECT_COOLDOWN_H) || 1) * 3600 * 1000;
const MAX_ATTEMPTS = parseInt(process.env.SELF_CORRECT_MAX_ATTEMPTS, 10) || 4;   // per theme in ATTEMPT_WINDOW
const ATTEMPT_WINDOW_MS = 24 * 3600 * 1000;
const MIN_GROUP = 5;                // tasks per playbook version / per side of a rewrite to judge it
// When to act: strong or moderate evidence only. Weak findings are watched.
const ACT_MIN = { strong: 4, moderate: 5 };
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

// The comparison group for a correction: tasks that received the memory, as
// the tasks that judge it do (measuredRows). Mixing in tasks that never saw a
// playbook (44% slower on this account) made any fix look like it helped.
function memoryRows(rows) {
    const rt = rows.filter(r => r.rt === true);
    return rt.length >= MIN_GROUP ? rt : rows;
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
        if (d != null && d >= THRESH(m) && (!best || c < best.centre)) best = { version: v, text, centre: c, current: cmp.to, basis: 'by-version', n: rs.length, oldRows: rs, newRows: curRows.slice(-Math.max(MIN_GROUP, BASE_K)) };
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
        if (text && text !== rec.playbook) return { version: prevV, text, centre: cb, current: ca, basis: 'around-rewrite', n: before.length, rewrite: e.v, oldRows: before, newRows: after };
    }
    return null;
}

/** Slowest/heaviest and fastest/leanest recent tasks — the evidence a targeted refine reads. */
function contrastTasks(rec, m) {
    const eps = (rec.episodes || []).filter(e => e && !e.provisional);
    const val = (e) => (m.key === 'seconds' ? e.seconds : m.key === 'calls' ? e.calls
        : m.key === 'stepSeconds' ? (Number.isFinite(e.seconds) && Number.isFinite(e.toolSeconds) ? Math.max(0, e.seconds - e.toolSeconds) / Math.max(1, (e.calls || 0) + (e.failed || 0)) : null)
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

function correctionInput(rec, fs) {
    const list = (Array.isArray(fs) ? fs : [fs]).map(f => ({ f, m: metricByKey.get(f.metric) })).filter(x => x.m);
    const line = (e) => `- "${e.task}" → ${e.calls} call${e.calls === 1 ? '' : 's'}${e.failed ? ` (${e.failed} failed)` : ''}${e.seconds != null ? `, ${e.seconds} s` : ''}${Number.isFinite(e.toolSeconds) ? ` (${Math.round(e.toolSeconds)} s waiting on tools)` : ''}${e.rough ? ' [ROUGH]' : ''}: ${e.approach || 'no tools'}`;
    const parts = [
        `REGRESSION${list.length > 1 ? 'S' : ''} TO FIX for this theme (earliest vs latest tasks):\n` +
            list.map(({ f, m }) => `- ${m.label}: ${fmtVal(f.from, m)} → ${fmtVal(f.to, m)} (${f.nFrom} vs ${f.nTo} tasks)`).join('\n'),
        `Rewrite the playbook so the next tasks bring ${list.length > 1 ? 'these measures' : 'this measure'} back down. Find what the slow/heavy/failing tasks did that the fast/lean ones did not (extra searches, re-reading, retries of a failing call, scripts where a tool exists, missing early checks) and turn the difference into concrete instructions. Keep what the good tasks did.`,
    ];
    const seen = new Set();
    for (const { m } of list.slice(0, 2)) {
        const { bad, good } = contrastTasks(rec, m);
        const b = bad.filter(e => !seen.has(e.task)); b.forEach(e => seen.add(e.task));
        if (b.length) parts.push(`WORST RECENT TASKS on ${m.label.toLowerCase()}:\n` + b.map(line).join('\n'));
        if (good.length) parts.push(`BEST RECENT TASKS on ${m.label.toLowerCase()}:\n` + good.map(line).join('\n'));
    }
    return parts.join('\n\n');
}

/**
 * Decide what to do now. `findings` = computeStats(...).findings.worsening.
 * Returns [{ th, label, metric, metricLabel, kind: 'revert'|'refine', ... }]
 * — at most one per theme, none while a correction on that theme is still
 * being evaluated or inside its cooldown.
 */
function eligibility(f) {
    const need = ACT_MIN[f.evidence];
    if (!need) return { ok: false, decision: 'wait', reason: 'could still be chance — watching until the evidence is real' };
    const have = Math.min(f.nFrom || 0, f.nTo || 0);
    if (have < need) return { ok: false, decision: 'wait', reason: `only ${have} tasks a side so far; acts at ${need}+` };
    return { ok: true };
}

/**
 * Decide what to do now: ONE correction per theme, covering every measure of
 * that theme that is getting worse (they share one playbook, so separate
 * fixes would overwrite each other); themes are corrected independently, in
 * parallel. `findings` = computeStats(...).findings.worsening.
 */
function plan(shard, findings, { now = Date.now() } = {}) {
    const st = state(shard);
    const out = [];
    const considered = [];
    const note = (f, decision, reason) => considered.push({
        th: f.scope, label: f.scopeLabel, metric: f.metric, metricLabel: f.metricLabel,
        from: f.from, to: f.to, changeKind: f.changeKind, evidence: f.evidence, decision, reason,
    });
    const byTheme = new Map();
    for (const f of findings || []) {
        if (!f || f.direction !== 'worse' || !f.scope || f.scope === 'chat' || !metricByKey.has(f.metric)) continue;
        if (!byTheme.has(f.scope)) byTheme.set(f.scope, []);
        byTheme.get(f.scope).push(f);
    }
    const rank = { strong: 0, moderate: 1, weak: 2 };
    for (const [th, fs] of byTheme) {
        fs.sort((a, b) => (rank[a.evidence] - rank[b.evidence]) || (Math.abs(b.change || 0) - Math.abs(a.change || 0)));
        const rec = (shard.memories || []).find(r => r.theme === th);
        if (!rec) { fs.forEach(f => note(f, 'skip', 'no memory for this theme yet')); continue; }
        if (rec.enabled === false) { fs.forEach(f => note(f, 'skip', 'this theme’s memory is paused')); continue; }
        const mine = st.actions.filter(a => a.th === th);
        const act = mine.find(a => a.status === 'active');
        if (act) {
            const covered = new Set(actionMetrics(act).map(x => x.metric));
            fs.forEach(f => note(f, 'wait', covered.has(f.metric)
                ? `being corrected now — verdict after ${EVAL_K} ${rec.label} tasks`
                : `joins the next ${rec.label} correction once the current one is judged (≤${EVAL_K} tasks)`));
            continue;
        }
        const last = mine[mine.length - 1];
        if (last && now - Date.parse(last.t) < COOLDOWN_MS) {
            const m = Math.max(1, Math.ceil((COOLDOWN_MS - (now - Date.parse(last.t))) / 60000));
            fs.forEach(f => note(f, 'wait', `last attempt ${STATUS_WORD[last.status] || last.status}; next try in ~${m} min`)); continue;
        }
        const attempts = mine.filter(a => now - Date.parse(a.t) < ATTEMPT_WINDOW_MS).length;
        if (attempts >= MAX_ATTEMPTS) { fs.forEach(f => note(f, 'skip', `${attempts} attempts on this theme in 24 h — paused so the playbook is not churned`)); continue; }
        const eligible = [];
        for (const f of fs) { const e = eligibility(f); if (e.ok) eligible.push(f); else note(f, e.decision, e.reason); }
        if (!eligible.length) continue;
        const primary = eligible[0];
        const pm = metricByKey.get(primary.metric);
        const metrics = eligible.map(f => ({ metric: f.metric, metricLabel: metricByKey.get(f.metric).label,
            trigger: { from: f.from, to: f.to, change: f.change, changeKind: f.changeKind, evidence: f.evidence, p: f.p, nFrom: f.nFrom, nTo: f.nTo } }));
        const base = {
            th, label: rec.label, metric: primary.metric, metricLabel: metrics.map(x => x.metricLabel).join(' + '),
            metrics, trigger: metrics[0].trigger,
        };
        // Restoring an earlier playbook needs real evidence AND must not make
        // another of the theme's worsening measures worse.
        let better = betterPlaybook(shard, rec, pm);
        if (better && better.oldRows && better.newRows) {
            for (const f of eligible.slice(1)) {
                const m2 = metricByKey.get(f.metric);
                const c = compareGroups(better.newRows, better.oldRows, m2);   // old playbook as "after"
                const d = c ? worseBy(c.from, c.to, m2) : null;
                if (d != null && d >= THRESH(m2) && c.evidence !== 'weak') { better = null; break; }
            }
        }
        if (better) {
            const { oldRows, newRows, ...b } = better;
            out.push({ ...base, kind: 'revert', toVersion: b.version, text: b.text, basis: b.basis,
                why: `playbook v${b.version} ran this theme at ${fmtVal(b.centre, pm)} ${pm.label.toLowerCase()} vs ${fmtVal(b.current, pm)} now` });
            eligible.forEach(f => note(f, 'act', `restoring playbook v${b.version} (${metrics.length} measure${metrics.length === 1 ? '' : 's'} in one correction)`));
        } else {
            out.push({ ...base, kind: 'refine', input: correctionInput(rec, eligible),
                why: `rewriting the playbook against ${metrics.map(x => x.metricLabel.toLowerCase()).join(', ')} (${metrics.map(x => `${fmtVal(x.trigger.from, metricByKey.get(x.metric))} → ${fmtVal(x.trigger.to, metricByKey.get(x.metric))}`).join(', ')})` });
            eligible.forEach(f => note(f, 'act', `rewriting the playbook${metrics.length > 1 ? ` for ${metrics.length} measures at once` : ''}`));
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

function actionMetrics(a) {
    return Array.isArray(a.metrics) && a.metrics.length ? a.metrics : [{ metric: a.metric, metricLabel: a.metricLabel, baseline: a.baseline }];
}
const kindOf = (m) => ((m.kind === 'rate' || m.key === 'failedShare') ? 'points' : 'relative');

/** Record an applied action (inside a shard mutation). */
function recordAction(shard, d, { now = Date.now(), fromVersion, toVersion, prevPlaybook, newPlaybook = null }) {
    const st = state(shard);
    const rows = memoryRows(themeRows(shard, d.th)).slice(-BASE_K);
    const metrics = (d.metrics || [{ metric: d.metric, metricLabel: d.metricLabel, trigger: d.trigger }]).map(x => {
        const m = metricByKey.get(x.metric);
        return { metric: x.metric, metricLabel: x.metricLabel, trigger: x.trigger, baseline: m ? centre(rows, m) : null };
    });
    const a = {
        id: `sc_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        t: new Date(now).toISOString(), th: d.th, label: d.label, metric: d.metric, metricLabel: d.metricLabel,
        metrics, kind: d.kind, why: d.why, trigger: d.trigger, basis: d.basis || null,
        fromVersion, toVersion, prevPlaybook: prevPlaybook || null, newPlaybook: newPlaybook || null,
        baseline: metrics[0] ? metrics[0].baseline : null, baselineN: rows.length,
        status: 'active', after: null,
    };
    st.actions.push(a);
    while (st.actions.length > ACTIONS_MAX) st.actions.shift();
    return a;
}

// Only tasks that were handed this theme's memory, at the corrected playbook
// or later, can say anything about the correction. Measured 2026-11-09: 3 of
// the 12 tasks behind the first five verdicts qualified, and none of the 6
// behind the three rollbacks.
function measuredRows(shard, a) {
    return themeRows(shard, a.th).filter(r => r.t > a.t && r.rt
        && (!Number.isFinite(r.pv) || !Number.isFinite(a.toVersion) || r.pv >= a.toVersion));
}

// Per-measure readings for an action over the tasks that used it.
function readings(shard, a, k = EVAL_K, pMax = P_FINAL) {
    const after = measuredRows(shard, a);
    const before = memoryRows(themeRows(shard, a.th).filter(r => r.t < a.t)).slice(-BASE_K);
    return actionMetrics(a).map(x => {
        const m = metricByKey.get(x.metric);
        if (!m) return { ...x, n: 0, value: null, change: null };
        const vals = after.filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); }).slice(0, k);
        const value = vals.length ? centre(vals, m) : null;
        const change = worseBy(x.baseline, value, m);
        const cmp = vals.length ? compareGroups(before, vals, m) : null;
        const real = cmp && cmp.p != null && cmp.p < pMax && Math.min(cmp.nFrom, cmp.nTo) >= Math.min(k, MIN_GROUP);
        return { metric: x.metric, metricLabel: x.metricLabel, baseline: x.baseline, n: vals.length, value, change, changeKind: kindOf(m),
            p: cmp ? cmp.p : null, evidence: cmp ? cmp.evidence : null,
            direction: !real || change == null ? 'flat' : change <= -THRESH(m) ? 'better' : change >= THRESH(m) ? 'worse' : 'flat' };
    });
}

/**
 * Judge active actions, once, after EVAL_K tasks that used the fix. Worse on
 * any measure (strong evidence) → rollback; better on one or more and worse on
 * none → helped; otherwise no effect.
 */
function evaluate(shard, { now = Date.now() } = {}) {
    const st = state(shard);
    const judged = [];
    for (const a of st.actions) {
        if (a.status !== 'active') continue;
        // Opened under the old rules on evidence that could be chance (every
        // trigger weak): today's rules would not have acted, and while it stays
        // open the theme's playbook cannot learn. Close it, keep the playbook.
        const trig = actionMetrics(a).map(x => x.trigger && x.trigger.evidence).filter(Boolean);
        if (trig.length && trig.every(e => e === 'weak')) {
            a.results = readings(shard, a);
            a.after = a.results[0] && a.results[0].n ? { value: a.results[0].value, n: a.results[0].n, change: a.results[0].change, changeKind: a.results[0].changeKind } : null;
            a.judgedAt = new Date(now).toISOString();
            a.status = 'no_effect';
            a.inconclusive = true;
            a.closedReason = 'started on a change that could be chance — closed so the playbook can keep learning';
            judged.push(a);
            continue;
        }
        const rs = readings(shard, a);
        const n = Math.min(...rs.map(r => r.n));
        const measured = measuredRows(shard, a).length;
        a.progress = Math.min(measured, EVAL_K);
        // Response time can be missing on a task; do not wait forever for it.
        const ready = n >= EVAL_K || (measured >= EVAL_K + 2 && rs.every(r => r.n >= MIN_READINGS));
        if (!ready && measured >= EARLY_K) {
            const early = readings(shard, a, EARLY_K, P_EARLY);
            if (early.every(r => r.n >= EARLY_K) && early.some(r => r.direction !== 'flat')) {
                a.results = early;
                a.after = { value: early[0].value, n: early[0].n, change: early[0].change, changeKind: early[0].changeKind };
                a.judgedAt = new Date(now).toISOString();
                a.early = true;
                if (early.some(r => r.direction === 'worse')) { a.status = 'worse'; if (a.prevPlaybook) a.rollback = true; }
                else a.status = 'helped';
                judged.push(a);
                continue;
            }
        }
        if (!ready) {
            const themeTasks = themeRows(shard, a.th).filter(r => r.t > a.t).length;
            if (themeTasks < EVAL_MAX_TASKS && now - Date.parse(a.t) < EVAL_MAX_MS) continue;
            a.results = rs;
            a.after = rs[0].n ? { value: rs[0].value, n: rs[0].n, change: rs[0].change, changeKind: rs[0].changeKind } : null;
            a.judgedAt = new Date(now).toISOString();
            a.status = 'no_effect';
            a.inconclusive = true;
            judged.push(a);
            continue;
        }
        const prim = rs[0];
        a.results = rs;
        a.after = { value: prim.value, n: prim.n, change: prim.change, changeKind: prim.changeKind };
        a.judgedAt = new Date(now).toISOString();
        if (rs.some(r => r.direction === 'worse')) { a.status = 'worse'; if (a.prevPlaybook) a.rollback = true; }
        else if (rs.some(r => r.direction === 'better')) a.status = 'helped';
        else a.status = 'no_effect';
        judged.push(a);
    }
    return judged;
}

/** Would plan() act on this finding (ignoring cooldowns)? And if not, why. */
function assessFinding(f) {
    if (!f || f.direction !== 'worse' || !f.scope || f.scope === 'chat') return { actionable: false, reason: 'not a theme measure' };
    const e = eligibility(f);
    return e.ok ? { actionable: true, reason: '' } : { actionable: false, reason: e.reason };
}

// An active correction as it stands right now: tasks measured so far and the
// measure over them against the baseline (an interim reading, not a verdict).
function liveProgress(shard, a) {
    const rs = readings(shard, a);
    const all = themeRows(shard, a.th).filter(r => r.rt);
    const after = measuredRows(shard, a);
    const now = Date.now();
    const recent = all.filter(r => now - Date.parse(r.t) < 14 * 86400000).length;
    const perDay = recent / 14;
    const progress = Math.min(after.length, EVAL_K);
    const remaining = Math.max(0, EVAL_K - progress);
    const interims = rs.filter(r => r.value != null);
    return {
        lastThemeTaskAt: all.length ? all[all.length - 1].t : null,
        themeTasks14d: recent,
        etaDays: remaining && perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
        progress, remaining,
        lastTaskAt: progress ? after[progress - 1].t : null,
        interims,
        interim: interims[0] || null,
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
        watch: (worsening || []).filter(f => f && f.scope && f.scope !== 'chat')
            .map(f => ({ scope: f.scope, scopeLabel: f.scopeLabel, metric: f.metric, metricLabel: f.metricLabel,
                from: f.from, to: f.to, change: f.change, changeKind: f.changeKind, evidence: f.evidence, nFrom: f.nFrom, nTo: f.nTo,
                ...assessFinding(f) })),
        evalTasks: EVAL_K,
        earlyTasks: EARLY_K,
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

module.exports = { EARLY_K, actionMetrics, readings, logCheck, assessFinding, plan, evaluate, recordAction, publicState, betterPlaybook, correctionInput, state, EVAL_K, COOLDOWN_MS, fmtVal, fmtMetric };
