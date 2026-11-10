'use strict';
// Core memory STATS: the evidence that a theme's memory is helping.
//
// coreMemory keeps only the last 8 episodes per theme and lifetime counters,
// which cannot show a trend. Every recorded task therefore also appends one
// compact row to the shard's `statsLog`, and the moments the memory changes
// (a new proven approach, a playbook rewrite) go into `statsEvents`. The log is
// seeded once from the episode archive so history before this existed shows
// too (those rows carry `bf:1`: whether memory was recalled is unknown).
//
// Row:   { t, th, c (calls), f (failed calls), s (seconds|null), ok (converged),
//          rough, prov (provisional Pi snapshot), k (taskKey|null),
//          r (any memory recalled: true|false|null), rt (this theme's memory
//          recalled), fo (playbook followed: true|false|null), bf }
// Event: { t, th, kind: 'best'|'refine', calls?, from?, v? }

const LOG_MAX = 3000;
const EVENTS_MAX = 600;

function num(x) { return Number.isFinite(x) ? x : null; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(x, d = 1) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d; }

function ensure(shard) {
    if (!Array.isArray(shard.statsLog)) shard.statsLog = [];
    if (!Array.isArray(shard.statsEvents)) shard.statsEvents = [];
    return shard;
}

/** Append (or, for the same in-flight Pi task, replace) a task row. */
function logRun(shard, row) {
    ensure(shard);
    const r = {
        t: row.t, th: row.th, c: num(row.c) ?? 0, f: num(row.f) ?? 0, s: num(row.s),
        ok: row.ok !== false, rough: !!row.rough, prov: !!row.prov, k: row.k || null,
        r: row.r == null ? null : !!row.r, rt: row.rt == null ? null : !!row.rt,
        fo: row.fo == null ? null : !!row.fo,
        tools: Array.isArray(row.tools) ? row.tools.slice(0, 8) : undefined,
    };
    // Added 2026-11-07: playbook version at the time, the answering model,
    // answer size, where the task came from, and the conversation (so a
    // correction in the NEXT message can be pinned on this task).
    if (Number.isFinite(row.pv)) r.pv = row.pv;
    if (row.m) r.m = String(row.m).slice(0, 80);
    if (Number.isFinite(row.ac)) r.ac = row.ac;
    if (row.src) r.src = row.src;
    if (row.cv) { r.cv = String(row.cv).slice(0, 64); r.cor = false; }
    if (r.k) {
        const i = shard.statsLog.findIndex(x => x.k === r.k);
        if (i >= 0) { shard.statsLog[i] = { ...shard.statsLog[i], ...r, t: shard.statsLog[i].t }; return; }
    }
    shard.statsLog.push(r);
    while (shard.statsLog.length > LOG_MAX) shard.statsLog.shift();
}

/**
 * The user's next message corrected the answer ("that's wrong", "I said…").
 * Pins it on the newest task of that conversation from the last 6 hours.
 */
const CORRECTION_WINDOW_MS = 6 * 3600 * 1000;
function markCorrection(shard, convId, now = Date.now()) {
    ensure(shard);
    const cv = String(convId || '').slice(0, 64);
    if (!cv) return false;
    for (let i = shard.statsLog.length - 1; i >= 0; i--) {
        const r = shard.statsLog[i];
        if (r.cv !== cv) continue;
        if (now - Date.parse(r.t) > CORRECTION_WINDOW_MS) return false;
        if (r.cor) return false;
        r.cor = true;
        return true;
    }
    return false;
}

function logEvent(shard, ev) {
    ensure(shard);
    shard.statsEvents.push(ev);
    while (shard.statsEvents.length > EVENTS_MAX) shard.statsEvents.shift();
}

/** One-time seed from the archive + the episodes core memory still holds. */
function seedFromHistory(shard, archived) {
    ensure(shard);
    if (shard.statsSeeded) return false;
    const seen = new Set(shard.statsLog.map(x => `${x.th}|${String(x.t).slice(0, 19)}`));
    const rows = [];
    const add = (th, e) => {
        if (!e || !e.at) return;
        const key = `${th}|${String(e.at).slice(0, 19)}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ t: e.at, th, c: num(e.calls) ?? 0, f: num(e.failed) ?? 0, s: num(e.seconds),
            ok: e.converged !== false, rough: !!e.rough, prov: !!e.provisional, k: e.taskKey || null,
            r: null, rt: null, fo: null, bf: 1 });
    };
    for (const e of archived || []) add(e.theme || 'general', e);
    for (const rec of shard.memories || []) for (const e of rec.episodes || []) add(rec.theme, e);
    for (const rec of shard.memories || []) {
        for (const h of rec.playbookHistory || []) {
            if (h && h.at) shard.statsEvents.push({ t: h.at, th: rec.theme, kind: 'refine', v: h.version, bf: 1 });
        }
        if (rec.playbookUpdatedAt && rec.playbookVersion) shard.statsEvents.push({ t: rec.playbookUpdatedAt, th: rec.theme, kind: 'refine', v: rec.playbookVersion, bf: 1 });
        if (rec.bestApproach && rec.bestApproach.at) shard.statsEvents.push({ t: rec.bestApproach.at, th: rec.theme, kind: 'best', calls: rec.bestApproach.calls, bf: 1 });
    }
    shard.statsLog = rows.concat(shard.statsLog).sort((a, b) => String(a.t).localeCompare(String(b.t))).slice(-LOG_MAX);
    shard.statsEvents.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    shard.statsSeeded = true;
    return true;
}

// Monday-start ISO week key (UTC).
function weekStart(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const day = (d.getUTCDay() + 6) % 7;
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    return m.toISOString().slice(0, 10);
}

function summarizeRows(rows) {
    const calls = rows.map(r => r.c);
    const secs = rows.map(r => r.s).filter(x => x != null);
    const allCalls = rows.reduce((n, r) => n + r.c + r.f, 0);
    const failed = rows.reduce((n, r) => n + r.f, 0);
    return {
        tasks: rows.length,
        avgCalls: round(avg(calls)),
        medianCalls: median(calls),
        medianSeconds: median(secs),
        failedCallRate: allCalls ? round(failed / allCalls, 3) : null,
        roughRate: rows.length ? round(rows.filter(r => r.rough).length / rows.length, 3) : null,
        convergedRate: rows.length ? round(rows.filter(r => r.ok).length / rows.length, 3) : null,
    };
}

// Early vs recent: the first and last third of a theme's tasks. Needs
// TREND_MIN tasks: with 4 against 4 one long task decides the sign (Coding read
// +94% from six quick game rewrites vs a few repo audits).
const TREND_MIN = parseInt(process.env.CORE_MEMORY_TREND_MIN, 10) || 15;
function earlyVsRecent(rows) {
    if (rows.length < TREND_MIN) return null;
    const n = Math.max(5, Math.floor(rows.length / 3));
    const early = summarizeRows(rows.slice(0, n));
    const recent = summarizeRows(rows.slice(-n));
    const change = (early.avgCalls && recent.avgCalls != null) ? round((recent.avgCalls - early.avgCalls) / early.avgCalls, 3) : null;
    return { window: n, early, recent, callsChange: change };
}

function withVsWithout(rows) {
    const known = rows.filter(r => r.r != null);
    const w = known.filter(r => r.rt);
    const wo = known.filter(r => !r.rt);
    if (!w.length && !wo.length) return null;
    const a = summarizeRows(w), b = summarizeRows(wo);
    return {
        with: a, without: b,
        callsSaved: (a.avgCalls != null && b.avgCalls != null) ? round(b.avgCalls - a.avgCalls) : null,
    };
}

/**
 * Everything the Stats view shows. `memories` = the shard's theme records
 * (lifetime counters live there), `themes` = allThemes() for labels/order.
 */
// `since` (ISO) limits everything to tasks/events from then on; the headline
// counters are then computed from the log instead of the lifetime totals.
function computeStats(shard, themes, { since = null, bucket = 'week' } = {}) {
    ensure(shard);
    const label = new Map((themes || []).map(t => [t.key, t.label]));
    // A Pi task is snapshotted while it runs; only its final row counts.
    const rows = shard.statsLog.filter(r => r && r.t && (!since || r.t >= since)).sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const allEvents = (shard.statsEvents || []).filter(e => e && (!since || (e.t && e.t >= since)));
    const recs = shard.memories || [];

    // Lifetime counters (they predate the log and cover tasks it never saw).
    const life = recs.reduce((acc, m) => {
        const s = m.stats || {};
        acc.tasks += s.runs || 0; acc.calls += s.totalCalls || 0;
        acc.recalled += s.recalled || 0; acc.followed += s.followed || 0;
        acc.converged += s.converged || 0;
        acc.refinements += m.playbookVersion || 0;
        acc.lessons += (m.lessons || []).length;
        acc.avoid += (m.avoid || []).length;
        acc.proven += m.bestApproach ? 1 : 0;
        return acc;
    }, { tasks: 0, calls: 0, recalled: 0, followed: 0, converged: 0, refinements: 0, lessons: 0, avoid: 0, proven: 0 });
    if (since) {
        life.tasks = rows.length;
        life.calls = rows.reduce((n, r) => n + (r.c || 0), 0);
        life.recalled = rows.filter(r => r.rt).length;
        life.followed = rows.filter(r => r.rt && r.fo === true).length;
        life.converged = rows.filter(r => r.ok !== false).length;
        life.refinements = allEvents.filter(e => e.kind === 'refine' || e.kind === 'correct').length;
        life.proven = allEvents.filter(e => e.kind === 'best').length;
    }

    const weekly = weeklySeries(rows, bucket);

    const byTheme = [];
    const themeKeys = [...new Set([...(themes || []).map(t => t.key), ...rows.map(r => r.th)])];
    for (const key of themeKeys) {
        const rs = rows.filter(r => r.th === key);
        const rec = recs.find(m => m.theme === key);
        if (!rs.length && !rec) continue;
        let s = (rec && rec.stats) || {};
        // In a range, the per-theme counters come from that window's tasks.
        if (since) {
            const conv = rs.filter(r => r.ok !== false && !r.rough);
            const rec2 = rs.filter(r => r.rt);
            s = { runs: rs.length, totalCalls: rs.reduce((n, r) => n + (r.c || 0), 0),
                bestCalls: conv.length ? Math.min(...conv.map(r => r.c)) : null,
                recalled: rec2.length, followed: rec2.filter(r => r.fo === true).length, lastRunAt: rs.length ? rs[rs.length - 1].t : null };
        }
        byTheme.push({
            theme: key,
            label: label.get(key) || (rec && rec.label) || key,
            enabled: rec ? rec.enabled !== false : true,
            lifetimeTasks: s.runs || 0,
            lifetimeAvgCalls: s.runs ? round(s.totalCalls / s.runs) : null,
            bestCalls: s.bestCalls ?? null,
            recalled: s.recalled || 0,
            followed: s.followed || 0,
            followRate: s.recalled ? round(s.followed / s.recalled, 3) : null,
            playbookVersion: rec ? rec.playbookVersion || 0 : 0,
            lessons: rec ? (rec.lessons || []).length : 0,
            avoid: rec ? (rec.avoid || []).length : 0,
            lastRunAt: s.lastRunAt || null,
            logged: summarizeRows(rs),
            trend: earlyVsRecent(rs),
            memoryEffect: withVsWithout(rs),
            spark: rs.slice(-30).map(r => r.c),
            sparkSeconds: rs.slice(-30).map(r => r.s).filter(x => x != null),
            seriesSeconds: rollingSeries(rs.map(r => r.s).filter(x => x != null), 30),
            callsTrend: (() => {
                if (rs.length < FIND_MIN) return null;
                const w = Math.min(60, Math.max(5, Math.floor(rs.length / 3)));
                return compareGroups(rs.slice(0, w), rs.slice(-w), METRICS[1]);
            })(),
            weekly: weeklySeries(rs, bucket),
            secondsTrend: (() => {
                const v = rs.filter(r => r.s != null);
                if (v.length < FIND_MIN) return null;
                const w = Math.min(60, Math.max(5, Math.floor(v.length / 3)));
                return compareGroups(v.slice(0, w), v.slice(-w), METRICS[0]);
            })(),
        });
    }
    byTheme.sort((a, b) => b.lifetimeTasks - a.lifetimeTasks);

    const events = allEvents.slice().sort((a, b) => String(b.t).localeCompare(String(a.t)))
        .slice(0, 40).map(e => ({ ...e, label: label.get(e.th) || e.th }));

    const overall = summarizeRows(rows);
    // Theme-adjusted trend: each theme's early→recent change weighted by its
    // task count, so a week of heavy research does not read as "everything
    // got slower".
    const withTrend = byTheme.filter(t => t.trend && t.trend.callsChange != null);
    const wsum = withTrend.reduce((n, t) => n + t.logged.tasks, 0);
    const adjustedChange = wsum ? round(withTrend.reduce((n, t) => n + t.trend.callsChange * t.logged.tasks, 0) / wsum, 3) : null;
    const improvedThemes = withTrend.filter(t => t.trend.callsChange < -0.05).length;
    const worseThemes = withTrend.filter(t => t.trend.callsChange > 0.05).length;
    return {
        generatedAt: new Date().toISOString(),
        since: rows.length ? rows[0].t : null,
        lifetime: {
            ...life,
            avgCalls: life.tasks ? round(life.calls / life.tasks) : null,
            recallRate: life.tasks ? round(life.recalled / life.tasks, 3) : null,
            followRate: life.recalled ? round(life.followed / life.recalled, 3) : null,
            convergedRate: life.tasks ? round(life.converged / life.tasks, 3) : null,
        },
        logged: overall,
        trend: earlyVsRecent(rows),
        adjustedChange, improvedThemes, worseThemes, trendThemes: withTrend.length,
        memoryEffect: withVsWithout(rows),
        trackedSince: (rows.find(r => !r.bf) || {}).t || null,
        weekly,
        themes: byTheme,
        events,
        range: since ? { since } : null,
        bucket,
        ...analyze(rows, byTheme, allEvents, label),
    };
}

// ---------------------------------------------------------------------------
// Advanced analysis (2026-11-07): what is improving, how long answers take,
// and whether the memory changes how tasks go.
//
// Every comparison carries its sample sizes and a p-value: with a few dozen
// tasks per theme most differences are noise, and the panel says so instead of
// colouring them green.

function quantile(a, q) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf).
function normCdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Two-sided Mann–Whitney U (normal approximation, tie-corrected). */
function mannWhitneyP(a, b) {
    const n1 = a.length, n2 = b.length;
    if (n1 < 2 || n2 < 2) return null;
    const all = a.map(v => [v, 0]).concat(b.map(v => [v, 1])).sort((x, y) => x[0] - y[0]);
    const ranks = new Array(all.length);
    let tieSum = 0;
    for (let i = 0; i < all.length;) {
        let j = i;
        while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[k] = r;
        const tcount = j - i + 1;
        tieSum += tcount ** 3 - tcount;
        i = j + 1;
    }
    let r1 = 0;
    all.forEach((x, i) => { if (x[1] === 0) r1 += ranks[i]; });
    const u = r1 - n1 * (n1 + 1) / 2;
    const n = n1 + n2;
    const sd = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tieSum / (n * (n - 1))));
    if (!sd) return 1;
    const z = (Math.abs(u - n1 * n2 / 2) - 0.5) / sd;
    return Math.max(0, Math.min(1, 2 * (1 - normCdf(z))));
}

/** Two-sided two-proportion z-test. */
function twoPropP(x1, n1, x2, n2) {
    if (n1 < 2 || n2 < 2) return null;
    const p = (x1 + x2) / (n1 + n2);
    const sd = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (!sd) return 1;
    const z = Math.abs(x1 / n1 - x2 / n2) / sd;
    return Math.max(0, Math.min(1, 2 * (1 - normCdf(z))));
}

function evidence(p, nA, nB) {
    if (p == null || Math.min(nA, nB) < 5) return 'weak';
    if (p < 0.05) return 'strong';
    if (p < 0.2) return 'moderate';
    return 'weak';
}

const isHostRow = (r) => r.src === 'agent' || r.th === 'host';

// Outcome measures. `kind: 'value'` compares medians (Mann–Whitney), `'rate'`
// compares shares (z-test). All are lower-is-better.
const METRICS = [
    { key: 'seconds', label: 'Response time', kind: 'value', get: r => r.s, unit: 'seconds' },
    { key: 'calls', label: 'Tool calls per task', kind: 'value', get: r => r.c, unit: 'calls' },
    { key: 'failedShare', label: 'Failed tool calls', kind: 'value', get: r => (r.c + r.f) ? r.f / (r.c + r.f) : 0, unit: 'share' },
    { key: 'rough', label: 'Tasks with repeated failures', kind: 'rate', get: r => (r.rough ? 1 : 0) },
    { key: 'corrected', label: 'Answers corrected by you', kind: 'rate', get: r => (typeof r.cor === 'boolean' ? (r.cor ? 1 : 0) : null) },
];

function metricVals(rows, m) { return rows.map(m.get).filter(v => v != null && Number.isFinite(v)); }
function metricCentre(vals, m) { return vals.length ? (m.kind === 'rate' ? avg(vals) : median(vals)) : null; }

/** Compare two groups of rows on one metric. */
function compareGroups(a, b, m) {
    const va = metricVals(a, m), vb = metricVals(b, m);
    const ca = metricCentre(va, m), cb = metricCentre(vb, m);
    if (ca == null || cb == null) return null;
    const p = m.kind === 'rate'
        ? twoPropP(va.reduce((x, y) => x + y, 0), va.length, vb.reduce((x, y) => x + y, 0), vb.length)
        : mannWhitneyP(va, vb);
    // Relative change of b against a (b is "after"/"with memory").
    let change = null;
    if (m.kind === 'rate' || m.key === 'failedShare') change = round(cb - ca, 3);           // percentage points
    else if (ca > 0) change = round((cb - ca) / ca, 3);
    return { from: round(ca, 3), to: round(cb, 3), nFrom: va.length, nTo: vb.length, change,
        changeKind: (m.kind === 'rate' || m.key === 'failedShare') ? 'points' : 'relative',
        p: p == null ? null : round(p, 4), evidence: evidence(p, va.length, vb.length) };
}

const MEANINGFUL = { relative: 0.08, points: 0.03 };
function direction(c) {
    if (!c || c.change == null) return 'flat';
    const t = MEANINGFUL[c.changeKind];
    return c.change <= -t ? 'better' : c.change >= t ? 'worse' : 'flat';
}

// Earlier vs recent for one scope: the oldest and newest third (window capped,
// so a long history still compares "then" with "lately").
const FIND_MIN = parseInt(process.env.CORE_MEMORY_FIND_MIN, 10) || 10;
function findingsFor(rows, scope, label) {
    const out = [];
    for (const m of METRICS) {
        const rs = rows.filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
        if (rs.length < FIND_MIN) continue;
        const w = Math.min(60, Math.max(5, Math.floor(rs.length / 3)));
        const early = rs.slice(0, w), recent = rs.slice(-w);
        const c = compareGroups(early, recent, m);
        if (!c) continue;
        out.push({ scope, scopeLabel: label, metric: m.key, metricLabel: m.label, ...c,
            since: early[0].t, until: recent[recent.length - 1].t, recentSince: recent[0].t,
            direction: direction(c) });
    }
    return out;
}

// Inverse standard normal (Acklam's rational approximation).
function normInv(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549671010349497e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const lo = 0.02425, hi = 1 - lo;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Web chat as a whole, LIKE FOR LIKE: each theme's earliest third against its
// latest third, combined weighted by size (Stouffer's method for the p-value).
// Pooling all chat tasks read a week of reverse-engineering work (3-9 minute
// tasks that barely existed before) as "chat got 50% slower" while research,
// the most common kind, had got faster. The pooled change is kept as `pooled`.
const STRAT_MIN = 6;
const STRAT_SHRINK = 5;
function stratifiedFindings(rows, scope, label) {
    const out = [];
    const themes = [...new Set(rows.map(r => r.th))];
    for (const m of METRICS) {
        let wsum = 0, acc = 0, zsum = 0, w2 = 0, nFrom = 0, nTo = 0;
        const parts = [];
        for (const th of themes) {
            const rs = rows.filter(r => r.th === th).filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
            if (rs.length < STRAT_MIN) continue;
            const w = Math.min(60, Math.max(3, Math.floor(rs.length / 3)));
            const c = compareGroups(rs.slice(0, w), rs.slice(-w), m);
            if (!c || c.change == null) continue;
            const wt = Math.min(c.nFrom, c.nTo);
            // Ratios average on a log scale: +100% and −50% cancel, and one
            // theme going 1 → 6 calls cannot outweigh every other theme.
            // Shrunk toward "no change" by n/(n+STRAT_SHRINK): a theme with 3
            // tasks a side going 45 s → 140 s is mostly noise and must not set
            // the headline on its own (it read as "+47%" over a flat median).
            const raw = c.changeKind === 'relative' ? Math.log(Math.max(0.05, 1 + c.change)) : c.change;
            const contrib = raw * (wt / (wt + STRAT_SHRINK));
            acc += contrib * wt; wsum += wt;
            if (c.p != null) {
                const z = normInv(1 - Math.max(1e-9, c.p) / 2) * Math.sign(c.change || 0);
                zsum += z * wt; w2 += wt * wt;
            }
            nFrom += c.nFrom; nTo += c.nTo;
            parts.push({ theme: th, change: c.change, nFrom: c.nFrom, nTo: c.nTo });
        }
        if (!wsum || parts.length === 0) continue;
        const z = w2 ? zsum / Math.sqrt(w2) : 0;
        const p = w2 ? round(2 * (1 - normCdf(Math.abs(z))), 4) : null;
        const changeKind = (m.kind === 'rate' || m.key === 'failedShare') ? 'points' : 'relative';
        const change = round(changeKind === 'relative' ? Math.exp(acc / wsum) - 1 : acc / wsum, 3);
        // Pooled (mix included), for context.
        const all = rows.filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
        const pw = Math.min(60, Math.max(5, Math.floor(all.length / 3)));
        const pooled = all.length >= FIND_MIN ? compareGroups(all.slice(0, pw), all.slice(-pw), m) : null;
        const f = { scope, scopeLabel: label, metric: m.key, metricLabel: m.label, change, changeKind,
            nFrom, nTo, p, evidence: evidence(p, nFrom, nTo), matched: true, themes: parts,
            from: pooled ? pooled.from : null, to: pooled ? pooled.to : null,
            pooled: pooled ? { from: pooled.from, to: pooled.to, change: pooled.change } : null,
            since: all.length ? all[0].t : null, recentSince: all.length ? all[Math.max(0, all.length - pw)].t : null };
        f.direction = direction(f);
        out.push(f);
    }
    return out;
}

// Weekly series with every measure, for the trend charts.
// Buckets for the trend chart: hours for a day, days for up to a month, weeks beyond.
function bucketStart(iso, unit) {
    if (unit === 'week') return weekStart(iso);
    const d = new Date(iso);
    if (isNaN(d)) return null;
    if (unit === 'day') return d.toISOString().slice(0, 10);
    return d.toISOString().slice(0, 13) + ':00:00.000Z';
}
function weeklySeries(rows, unit = 'week') {
    const weeks = new Map();
    for (const r of rows) {
        const w = bucketStart(r.t, unit);
        if (!w) continue;
        if (!weeks.has(w)) weeks.set(w, []);
        weeks.get(w).push(r);
    }
    return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rs]) => {
        const secs = rs.map(r => r.s).filter(x => x != null);
        const known = rs.filter(r => r.r != null);
        const rec = known.filter(r => r.rt);
        const fol = rec.filter(r => r.fo != null);
        const corr = rs.filter(r => typeof r.cor === 'boolean');
        const allCalls = rs.reduce((n, r) => n + r.c + r.f, 0);
        return {
            week, tasks: rs.length,
            avgCalls: round(avg(rs.map(r => r.c))),
            medianCalls: median(rs.map(r => r.c)),
            medianSeconds: secs.length ? Math.round(median(secs)) : null,
            p75Seconds: secs.length ? Math.round(quantile(secs, 0.75)) : null,
            failedCallRate: allCalls ? round(rs.reduce((n, r) => n + r.f, 0) / allCalls, 3) : null,
            roughRate: round(rs.filter(r => r.rough).length / rs.length, 3),
            recallRate: known.length ? round(rec.length / known.length, 3) : null,
            followRate: fol.length ? round(fol.filter(r => r.fo).length / fol.length, 3) : null,
            correctionRate: corr.length ? round(corr.filter(r => r.cor).length / corr.length, 3) : null,
        };
    });
}

// With the theme's memory recalled vs a cold start. Raw groups mix themes
// (memory is recalled more on themes that already have one), so each theme is
// also compared with itself and the per-theme differences are weighted.
function memoryImpact(rows) {
    const known = rows.filter(r => r.r != null);
    const withM = known.filter(r => r.rt), cold = known.filter(r => !r.rt);
    const metrics = [];
    for (const m of METRICS) {
        const c = compareGroups(cold, withM, m);
        if (!c) continue;
        // Theme-matched.
        let wsum = 0, acc = 0, themesUsed = 0;
        const themes = [...new Set(known.map(r => r.th))];
        for (const th of themes) {
            const a = cold.filter(r => r.th === th), b = withM.filter(r => r.th === th);
            const tc = compareGroups(a, b, m);
            if (!tc || tc.change == null || Math.min(tc.nFrom, tc.nTo) < 2) continue;
            const wgt = Math.min(tc.nFrom, tc.nTo);
            acc += tc.change * wgt; wsum += wgt; themesUsed++;
        }
        metrics.push({ metric: m.key, metricLabel: m.label, ...c, direction: direction(c),
            matchedChange: wsum ? round(acc / wsum, 3) : null, matchedThemes: themesUsed });
    }
    const recalled = withM.filter(r => r.fo != null);
    const followed = recalled.filter(r => r.fo), notFollowed = recalled.filter(r => !r.fo);
    const follow = [];
    for (const m of METRICS) {
        const c = compareGroups(notFollowed, followed, m);
        if (c) follow.push({ metric: m.key, metricLabel: m.label, ...c, direction: direction(c) });
    }
    return { withTasks: withM.length, coldTasks: cold.length, metrics,
        followedTasks: followed.length, notFollowedTasks: notFollowed.length, follow };
}

// Learning curve: how the Nth task of a theme compares with that theme's
// typical task. Values are relative to the theme's own median, so research
// (long) and coding (short) can be pooled.
const CURVE_BUCKETS = [[1, 5], [6, 15], [16, 30], [31, 60], [61, Infinity]];
function learningCurve(rows) {
    const byTheme = new Map();
    for (const r of rows) { if (!byTheme.has(r.th)) byTheme.set(r.th, []); byTheme.get(r.th).push(r); }
    const out = CURVE_BUCKETS.map(([lo, hi]) => ({ label: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, lo, hi, seconds: [], calls: [], themes: new Set() }));
    for (const [th, rs] of byTheme) {
        if (rs.length < 8) continue;
        const ms = median(rs.map(r => r.s).filter(x => x != null && x > 0));
        const mc = median(rs.map(r => r.c).filter(x => x > 0));
        rs.forEach((r, i) => {
            const b = out.find(x => i + 1 >= x.lo && i + 1 <= x.hi);
            if (!b) return;
            if (ms && r.s != null) b.seconds.push(r.s / ms);
            if (mc) b.calls.push(r.c / mc);
            b.themes.add(th);
        });
    }
    return out.map(b => ({
        label: b.label, tasks: Math.max(b.seconds.length, b.calls.length), themes: b.themes.size,
        relSeconds: b.seconds.length >= 3 ? round(median(b.seconds), 3) : null,
        relCalls: b.calls.length >= 3 ? round(median(b.calls), 3) : null,
    }));
}

// Before/after each memory update (new proven approach or playbook rewrite):
// the theme's last K tasks before it against its first K after.
const UPDATE_K = 5;
function updateImpact(rows, events, label) {
    const list = [];
    for (const e of events) {
        if (!e || !e.t || (e.kind !== 'best' && e.kind !== 'refine')) continue;
        const rs = rows.filter(r => r.th === e.th);
        const before = rs.filter(r => r.t < e.t).slice(-UPDATE_K);
        const after = rs.filter(r => r.t > e.t).slice(0, UPDATE_K);
        if (before.length < 3 || after.length < 3) continue;
        // Rewrites often land between the same two tasks (v21..v24 with no
        // task in between): one row per distinct before/after split.
        const split = `${e.th}|${before[before.length - 1].t}|${after[0].t}`;
        const prev = list.find(x => x.split === split);
        if (prev) {
            if (e.kind === 'best') { prev.kind = 'best'; prev.calls = e.calls ?? prev.calls; prev.from = e.from ?? prev.from; }
            if (e.v != null) { prev.vFrom = Math.min(prev.vFrom ?? e.v, e.v); prev.v = Math.max(prev.v ?? e.v, e.v); }
            prev.merged = (prev.merged || 1) + 1;
            if (e.t > prev.t) prev.t = e.t;
            continue;
        }
        const sec = compareGroups(before, after, METRICS[0]);
        const cal = compareGroups(before, after, METRICS[1]);
        list.push({ split, t: e.t, th: e.th, label: label.get(e.th) || e.th, kind: e.kind, v: e.v ?? null, vFrom: e.v ?? null, calls: e.calls ?? null, from: e.from ?? null,
            before: before.length, after: after.length,
            seconds: sec ? { from: sec.from, to: sec.to, change: sec.change, evidence: sec.evidence } : null,
            callsChange: cal ? { from: cal.from, to: cal.to, change: cal.change, evidence: cal.evidence } : null });
    }
    const sec = list.filter(x => x.seconds && x.seconds.change != null);
    const cal = list.filter(x => x.callsChange && x.callsChange.change != null);
    return {
        window: UPDATE_K,
        updates: list.length,
        fasterAfter: sec.filter(x => x.seconds.change < -MEANINGFUL.relative).length,
        slowerAfter: sec.filter(x => x.seconds.change > MEANINGFUL.relative).length,
        medianSecondsChange: sec.length ? round(median(sec.map(x => x.seconds.change)), 3) : null,
        leanerAfter: cal.filter(x => x.callsChange.change < -MEANINGFUL.relative).length,
        heavierAfter: cal.filter(x => x.callsChange.change > MEANINGFUL.relative).length,
        medianCallsChange: cal.length ? round(median(cal.map(x => x.callsChange.change)), 3) : null,
        recent: list.slice().sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, 20).map(({ split, ...x }) => x),
    };
}

function responseTime(rows) {
    const secs = rows.map(r => r.s).filter(x => x != null);
    const chat = rows.filter(r => !isHostRow(r)).map(r => r.s).filter(x => x != null);
    const agent = rows.filter(isHostRow).map(r => r.s).filter(x => x != null);
    const stat = (a) => (a.length ? { tasks: a.length, median: Math.round(median(a)), p25: Math.round(quantile(a, 0.25)), p75: Math.round(quantile(a, 0.75)), p90: Math.round(quantile(a, 0.9)) } : null);
    // Distribution for the histogram (minutes buckets).
    const edges = [0, 15, 30, 60, 120, 240, 480, 900, Infinity];
    const hist = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], tasks: secs.filter(s => s >= lo && s < edges[i + 1]).length }));
    return { all: stat(secs), chat: stat(chat), agent: stat(agent), histogram: hist };
}


// Rolling median of a value over rows in time order, thinned to ≤ maxPts
// points. Each point keeps its position (0..1) so a chart can mark the
// earlier and recent windows the comparison used.
function rollingSeries(vals, maxPts = 60) {
    const n = vals.length;
    if (n < 3) return [];
    const k = Math.max(1, Math.min(7, Math.floor(n / 8)));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: n > 1 ? i / (n - 1) : 0, y: median(vals.slice(Math.max(0, i - k), i + 1)) });
    if (pts.length <= maxPts) return pts.map(p => ({ x: round(p.x, 4), y: round(p.y, 3) }));
    const out = [];
    for (let j = 0; j < maxPts; j++) out.push(pts[Math.round(j * (n - 1) / (maxPts - 1))]);
    return out.map(p => ({ x: round(p.x, 4), y: round(p.y, 3) }));
}

// The headline tiles: ONE comparison per measure (all web-chat tasks in the
// range, earliest window vs latest window), and the line drawn from the same
// tasks — so the chip, the sentence and the picture can never disagree.
function headlineFor(rows, m) {
    const rs = rows.filter(r => { const v = m.get(r); return v != null && Number.isFinite(v); });
    if (!rs.length) return null;
    const vals = rs.map(m.get);
    const out = { metric: m.key, n: rs.length, value: round(metricCentre(vals, m), 3), series: rollingSeries(vals) };
    if (m.key === 'failedShare') {
        const calls = rs.reduce((a, r) => a + (r.c || 0) + (r.f || 0), 0);
        out.value = calls ? round(rs.reduce((a, r) => a + (r.f || 0), 0) / calls, 4) : 0;
    }
    if (rs.length >= FIND_MIN) {
        const w = Math.min(60, Math.max(5, Math.floor(rs.length / 3)));
        const c = compareGroups(rs.slice(0, w), rs.slice(-w), m);
        if (c && m.key === 'failedShare') {
            // Shown as "N% of calls failed": compare that same rate per window
            // (most tasks have no failures, so the median share is always 0).
            const rate = (a) => { const t = a.reduce((x, r) => x + (r.c || 0) + (r.f || 0), 0); return t ? a.reduce((x, r) => x + (r.f || 0), 0) / t : 0; };
            c.from = round(rate(rs.slice(0, w)), 4); c.to = round(rate(rs.slice(-w)), 4); c.change = round(c.to - c.from, 3);
        }
        if (c) Object.assign(out, c, { direction: direction(c), window: w,
            since: rs[0].t, recentSince: rs[rs.length - w].t });
    }
    return out;
}

/** Everything beyond the basic counters; merged into computeStats' result. */
function analyze(rows, byTheme, events, label) {
    // Overall findings use chat and agent rows separately (they differ by an
    // order of magnitude, a shift in mix would read as a trend).
    const findings = [];
    const chatRows = rows.filter(r => !isHostRow(r));
    const chatFindings = stratifiedFindings(chatRows, 'chat', 'Web chat (like for like)');
    findings.push(...chatFindings);
    for (const t of byTheme) {
        const rs = rows.filter(r => r.th === t.theme);
        findings.push(...findingsFor(rs, t.theme, t.label));
    }
    const rank = { strong: 0, moderate: 1, weak: 2 };
    const sortF = (a, b) => (rank[a.evidence] - rank[b.evidence]) || (Math.abs(b.change || 0) - Math.abs(a.change || 0));
    const improving = findings.filter(f => f.direction === 'better').sort(sortF);
    const worsening = findings.filter(f => f.direction === 'worse').sort(sortF);
    const steady = findings.filter(f => f.direction === 'flat').length;

    const tasks = rows.slice(-400).map(r => ({
        t: r.t, th: r.th, c: r.c, f: r.f, s: r.s, rough: r.rough || undefined,
        rt: r.rt, fo: r.fo, cor: r.cor, src: isHostRow(r) ? 'agent' : 'chat', pv: r.pv,
    }));
    return {
        findings: { improving, worsening, steady, total: findings.length, minTasks: FIND_MIN, chat: Object.fromEntries(chatFindings.map(f => [f.metric, f])) },
        headline: Object.fromEntries(METRICS.slice(0, 3).map(m => [m.key, headlineFor(chatRows, m)])),
        responseTime: responseTime(rows),
        impact: memoryImpact(rows),
        learningCurve: learningCurve(rows),
        updateImpact: updateImpact(rows, events, label),
        tasks,
        correctionsTrackedSince: (rows.find(r => typeof r.cor === 'boolean') || {}).t || null,
        metrics: METRICS.map(m => ({ key: m.key, label: m.label, kind: m.kind })),
    };
}

module.exports = { METRICS, compareGroups, direction, TREND_MIN, logRun, markCorrection, analyze, mannWhitneyP, twoPropP, logEvent, seedFromHistory, computeStats, weekStart, earlyVsRecent, withVsWithout, LOG_MAX };
