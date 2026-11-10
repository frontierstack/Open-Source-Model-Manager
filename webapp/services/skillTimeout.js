'use strict';
// How long one skill run may take. Every skill has a default limit; the caller
// (usually the model) can ask for more with `timeoutSeconds`. Raises only: a
// short request never cuts a skill's own default.

const DEFAULT_MS = 30_000;
const MAX_MS = (parseInt(process.env.SKILL_TIMEOUT_MAX_SECONDS, 10) || 1800) * 1000;
// A background job is abandoned at its own deadline, so its runs may not outlast it.
const DELEGATED_MAX_MS = (parseInt(process.env.SKILL_TIMEOUT_DELEGATED_MAX_SECONDS, 10) || 240) * 1000;
const GRACE_MS = 10_000;        // the skill's own limit fires first and can report cleanly

// Skills that also enforce a limit of their own, in seconds. Left at its
// default it would stop the work long before the raised sandbox limit.
const INNER_SECONDS_PARAM = {
    run_python: 'timeout', run_node: 'timeout', run_npm: 'timeout', run_bash: 'timeout',
    run_powershell: 'timeout', run_cmd: 'timeout', gdb_batch: 'timeout', git_clone_shallow: 'timeout_s',
};

const seconds = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** Returns { params (without timeoutSeconds), timeoutMs, baseMs, maxMs, requested }. */
function resolve(skill, params, { delegated = false } = {}) {
    const out = { ...(params || {}) };
    const explicit = seconds(out.timeoutSeconds);
    delete out.timeoutSeconds;
    const baseMs = Number(skill && skill.timeoutMs) > 0 ? Number(skill.timeoutMs) : DEFAULT_MS;
    const maxMs = Math.max(baseMs, delegated ? Math.min(MAX_MS, DELEGATED_MAX_MS) : MAX_MS);
    const innerKey = skill && Object.prototype.hasOwnProperty.call(INNER_SECONDS_PARAM, skill.name) ? INNER_SECONDS_PARAM[skill.name] : null;
    const inner = innerKey ? seconds(out[innerKey]) : null;
    const requested = Math.max(explicit || 0, inner || 0) || null;
    if (!requested) return { params: out, timeoutMs: baseMs, baseMs, maxMs, requested: null };
    const grace = innerKey ? GRACE_MS : 0;
    const timeoutMs = Math.max(baseMs, Math.min(requested * 1000 + grace, maxMs));
    if (innerKey) out[innerKey] = Math.max(1, Math.min(requested, Math.floor((timeoutMs - grace) / 1000)));
    return { params: out, timeoutMs, baseMs, maxMs, requested };
}

/** The result of a run the limit killed; tells the model how to give it more time. */
function timedOutResult(limit) {
    const used = Math.round(limit.timeoutMs / 1000), max = Math.round(limit.maxMs / 1000);
    const atMax = limit.timeoutMs >= limit.maxMs;
    return {
        success: false, timedOut: true, timeoutSeconds: used, maxTimeoutSeconds: max,
        error: `Timed out after ${used} s and was stopped.`,
        hint: atMax
            ? `${used} s is the most this run can have. Split the work into smaller steps or use a different route.`
            : `This is the time limit, not a failure of the tool. If the job can finish given longer, call it again with timeoutSeconds set higher (up to ${max}).`,
    };
}

module.exports = { resolve, timedOutResult, MAX_MS, DELEGATED_MAX_MS, GRACE_MS };
