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
    };
    if (r.k) {
        const i = shard.statsLog.findIndex(x => x.k === r.k);
        if (i >= 0) { shard.statsLog[i] = { ...shard.statsLog[i], ...r, t: shard.statsLog[i].t }; return; }
    }
    shard.statsLog.push(r);
    while (shard.statsLog.length > LOG_MAX) shard.statsLog.shift();
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

// Early vs recent: the first and last third of a theme's tasks (min 3 each).
function earlyVsRecent(rows) {
    if (rows.length < 6) return null;
    const n = Math.max(3, Math.floor(rows.length / 3));
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
function computeStats(shard, themes) {
    ensure(shard);
    const label = new Map((themes || []).map(t => [t.key, t.label]));
    // A Pi task is snapshotted while it runs; only its final row counts.
    const rows = shard.statsLog.filter(r => r && r.t).sort((a, b) => String(a.t).localeCompare(String(b.t)));
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

    // Weekly series over the log.
    const weeks = new Map();
    for (const r of rows) {
        const w = weekStart(r.t);
        if (!w) continue;
        if (!weeks.has(w)) weeks.set(w, []);
        weeks.get(w).push(r);
    }
    const weekly = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rs]) => {
        const s = summarizeRows(rs);
        const known = rs.filter(r => r.r != null);
        return {
            week, tasks: s.tasks, avgCalls: s.avgCalls, failedCallRate: s.failedCallRate,
            recallRate: known.length ? round(known.filter(r => r.rt).length / known.length, 3) : null,
        };
    });

    const byTheme = [];
    const themeKeys = [...new Set([...(themes || []).map(t => t.key), ...rows.map(r => r.th)])];
    for (const key of themeKeys) {
        const rs = rows.filter(r => r.th === key);
        const rec = recs.find(m => m.theme === key);
        if (!rs.length && !rec) continue;
        const s = (rec && rec.stats) || {};
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
        });
    }
    byTheme.sort((a, b) => b.lifetimeTasks - a.lifetimeTasks);

    const events = (shard.statsEvents || []).slice().sort((a, b) => String(b.t).localeCompare(String(a.t)))
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
    };
}

module.exports = { logRun, logEvent, seedFromHistory, computeStats, weekStart, earlyVsRecent, withVsWithout, LOG_MAX };
