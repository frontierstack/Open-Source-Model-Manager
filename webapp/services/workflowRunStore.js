// Per-user persistent store for automation (workflow) run history.
//
// Layout (mirrors the conversations + attachment stores):
//   /models/.modelserver/workflow-runs/<userIdSafe>/
//       index.json        — array of run summaries, newest first
//       <runId>.json      — the full run record (node timeline + outputs)
//
// Ownership is enforced by path: a caller only ever sees their own
// <userIdSafe> bucket. Run records are plain JSON (no base64 wrapping —
// unlike conversations, these aren't user content that needs obfuscating).
//
// runId is a crypto-random 32-hex id the caller cannot influence; the read
// path validates /^[a-f0-9]{32}$/ to keep paths well-formed. To bound disk
// growth, each user's index is capped at MAX_RUNS_PER_USER — older run files
// are deleted as new ones land.

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = '/models/.modelserver/workflow-runs';
const MAX_RUNS_PER_USER = 200;

function userIdSafe(userId) {
    return String(userId == null ? 'anon' : userId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
}

function isValidId(id) {
    return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function userDir(userId) {
    return path.join(ROOT, userIdSafe(userId));
}

function indexPath(userId) {
    return path.join(userDir(userId), 'index.json');
}

function runPath(userId, runId) {
    return path.join(userDir(userId), `${runId}.json`);
}

// Persistent artifacts for a run (copied here at run-finish so they outlive the
// 1-hour sandbox sweep). Deleted when the run record is removed.
function runArtifactDir(userId, runId) {
    return path.join(userDir(userId), 'artifacts', runId);
}

async function dropRunFiles(userId, runId) {
    try { await fs.unlink(runPath(userId, runId)); } catch (_) { /* already gone */ }
    try { await fs.rm(runArtifactDir(userId, runId), { recursive: true, force: true }); } catch (_) { /* none */ }
}

function newRunId() {
    return crypto.randomBytes(16).toString('hex');
}

async function ensureUserDir(userId) {
    await fs.mkdir(userDir(userId), { recursive: true });
}

async function readIndex(userId) {
    try {
        const raw = await fs.readFile(indexPath(userId), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('[workflowRunStore] readIndex failed:', err.message);
        return [];
    }
}

async function writeIndex(userId, index) {
    await ensureUserDir(userId);
    await fs.writeFile(indexPath(userId), JSON.stringify(index, null, 2));
}

// Create a new run record (status 'running') and prepend its summary to the
// user's index. Returns the runId.
async function createRun(userId, { workflowId, workflowName, trigger }) {
    await ensureUserDir(userId);
    const runId = newRunId();
    const startedAt = new Date().toISOString();
    const record = {
        id: runId,
        workflowId: workflowId || null,
        workflowName: workflowName || '',
        trigger: trigger || 'manual',
        status: 'running',
        startedAt,
        finishedAt: null,
        durationMs: null,
        error: null,
        nodes: [],     // [{ nodeId, type, status, startedAt, finishedAt, output?, error? }]
        result: null,
    };
    await fs.writeFile(runPath(userId, runId), JSON.stringify(record, null, 2));

    const index = await readIndex(userId);
    index.unshift(summaryOf(record));

    // Cap retained runs — delete the overflow files so disk doesn't grow without bound.
    const overflow = index.splice(MAX_RUNS_PER_USER);
    for (const old of overflow) {
        await dropRunFiles(userId, old.id);
    }
    await writeIndex(userId, index);
    return runId;
}

function summaryOf(record) {
    return {
        id: record.id,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        trigger: record.trigger,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        error: record.error,
    };
}

async function getRun(userId, runId) {
    if (!isValidId(runId)) return null;
    try {
        const raw = await fs.readFile(runPath(userId, runId), 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.error('[workflowRunStore] getRun failed:', err.message);
        return null;
    }
}

// Persist a (possibly partial) update to a run record and refresh its index
// summary. `patch` is shallow-merged; `nodes` is replaced wholesale by the
// caller (the engine owns the node timeline).
async function updateRun(userId, runId, patch) {
    if (!isValidId(runId)) return null;
    const record = await getRun(userId, runId);
    if (!record) return null;
    const next = { ...record, ...patch };
    if (next.status !== 'running' && next.finishedAt && next.startedAt && next.durationMs == null) {
        next.durationMs = new Date(next.finishedAt).getTime() - new Date(next.startedAt).getTime();
    }
    await fs.writeFile(runPath(userId, runId), JSON.stringify(next, null, 2));

    const index = await readIndex(userId);
    const i = index.findIndex(r => r.id === runId);
    if (i !== -1) {
        index[i] = summaryOf(next);
        await writeIndex(userId, index);
    }
    return next;
}

// List run summaries for a user, optionally filtered to one workflow.
async function listRuns(userId, { workflowId = null, limit = 50 } = {}) {
    let index = await readIndex(userId);
    if (workflowId) index = index.filter(r => r.workflowId === workflowId);
    return index.slice(0, limit);
}

// Drop every run belonging to a workflow (called when a workflow is deleted).
async function deleteRunsForWorkflow(userId, workflowId) {
    const index = await readIndex(userId);
    const keep = [];
    for (const r of index) {
        if (r.workflowId === workflowId) {
            await dropRunFiles(userId, r.id);
        } else {
            keep.push(r);
        }
    }
    if (keep.length !== index.length) await writeIndex(userId, keep);
}

module.exports = {
    createRun,
    getRun,
    updateRun,
    listRuns,
    deleteRunsForWorkflow,
    userIdSafe,
    isValidId,
};
