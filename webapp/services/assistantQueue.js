'use strict';
// Background-job queue for the two-model hand-off (the lead hands legwork to
// the assistant model). Pure: no I/O, no timers — the caller supplies `run`.
//
// Why a queue and not a cap: the old dispatch refused work past the parallel
// limit ("All 3 assistant jobs are already running") and the server's own
// auto-dispatch started only HANDOFF_AUTO_JOBS=2 of the jobs the first pass
// proposed — so the pair only ever traded two jobs per turn, whatever the task
// needed. Now every job is accepted up to a per-turn budget; those past the
// parallel limit wait as `queued` and start the moment a slot frees, so
// delegation is continuous: the lead can hand over more whenever its work
// reveals more, and nothing is silently dropped.
//
// Job statuses: queued → running → done | failed; queued/running → cancelled.

const PENDING = new Set(['queued', 'running']);

function isPending(job) { return !!job && PENDING.has(job.status); }
function isSettled(job) { return !!job && !PENDING.has(job.status); }

function createAssistantQueue({ maxParallel = 3, maxJobs = 12, run, onChange, jobs: existing } = {}) {
    if (typeof run !== 'function') throw new Error('createAssistantQueue: run(job) is required');
    // The caller may hand in the Map its other consumers already read (the
    // chat turn's `_assistantJobs`); otherwise the queue owns a fresh one.
    const jobs = existing instanceof Map ? existing : new Map();
    const parallel = Math.max(1, maxParallel | 0);
    const budget = Math.max(1, maxJobs | 0);
    const notify = () => { try { if (typeof onChange === 'function') onChange(jobs); } catch (_) { /* observer */ } };

    function runningCount() { let n = 0; for (const j of jobs.values()) if (j.status === 'running') n++; return n; }
    function queuedList() { return [...jobs.values()].filter(j => j.status === 'queued'); }
    function pending() { return [...jobs.values()].filter(isPending); }
    function freeSlots() { return Math.max(0, parallel - runningCount()); }

    // Start queued jobs while there is room. Called after every add and every
    // settle, so the queue drains itself with no external ticking.
    function pump() {
        let started = 0;
        for (const j of queuedList()) {
            if (runningCount() >= parallel) break;
            j.status = 'running';
            j.startedAt = Date.now();
            started++;
            let p;
            try { p = Promise.resolve(run(j)); } catch (e) { p = Promise.reject(e); }
            p.then((r) => {
                if (j.status === 'cancelled') return null;   // aborted mid-flight
                j.status = (r && r.status === 'ok') ? 'done' : 'failed';
                j.result = r;
                j.seconds = r && typeof r.seconds === 'number' ? r.seconds : Math.round((Date.now() - j.startedAt) / 100) / 10;
                j.finishedAt = Date.now();
                return r;
            }, (e) => {
                if (j.status !== 'cancelled') {
                    j.status = 'failed';
                    j.error = e && e.message ? e.message : String(e);
                    j.finishedAt = Date.now();
                }
                return null;
            }).then((r) => {
                j._resolve(r);
                notify();
                pump();
            });
        }
        if (started) notify();
        return started;
    }

    // Accept jobs. Returns { accepted: [{id,name,status}], rejected: [{name, reason}] }.
    function add(items, extra = {}) {
        const accepted = [];
        const rejected = [];
        for (const t of (Array.isArray(items) ? items : [])) {
            const task = String((t && t.task) || '').trim();
            if (!task) continue;
            if (jobs.size >= budget) { rejected.push({ name: t.name, reason: 'budget' }); continue; }
            const id = `a${jobs.size + 1}`;
            const name = String((t && t.name) || `job ${jobs.size + 1}`).slice(0, 60);
            let resolve;
            const promise = new Promise(res => { resolve = res; });
            const job = { id, name, task, status: 'queued', queuedAt: Date.now(), promise, _resolve: resolve, ...extra };
            jobs.set(id, job);
            accepted.push(job);
        }
        pump();
        return { accepted: accepted.map(j => ({ id: j.id, name: j.name, status: j.status })), rejected };
    }

    // Abort everything still pending. Queued jobs never start; running ones get
    // `abort()` if the runner attached one.
    function cancelPending(reason) {
        const hit = pending();
        for (const j of hit) {
            j.status = 'cancelled';
            j.error = reason || 'cancelled';
            j.finishedAt = Date.now();
            try { if (typeof j.abort === 'function') j.abort(); } catch (_) { /* best effort */ }
            j._resolve(null);
        }
        if (hit.length) notify();
        return hit.map(j => j.id);
    }

    return { jobs, add, pump, pending, freeSlots, runningCount, cancelPending, maxParallel: parallel, maxJobs: budget };
}

module.exports = { createAssistantQueue, isPending, isSettled };
