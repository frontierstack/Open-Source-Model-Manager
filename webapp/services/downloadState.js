'use strict';
// ---------------------------------------------------------------------------
// Download-state manifests for model directories.
//
// scripts/download_model.py writes /models/<ModelDir>/.download-state.json as
// it pulls a repo. This module is the READ side: it turns that manifest (which
// may be absent, stale, half-written or outright corrupt) into a truthful
// summary for /api/models and /api/downloads/partial.
//
// Two rules do the heavy lifting:
//  1. STALENESS — a manifest that still says "downloading" but has not been
//     touched for STALE_MS means the writer died. The downloader is a CHILD OF
//     THIS CONTAINER, so `docker compose up -d --build webapp` kills it mid-pull
//     and it never gets to write "interrupted". Anything stale (or whose pid is
//     gone) is reported as interrupted.
//  2. RE-STAT — the manifest's byte counters are only as fresh as its last
//     write, so every summary re-stats the files on disk. The percent shown to
//     the user is derived from real bytes, never from a stale counter.
//
// Everything here is defensive: a missing/corrupt manifest must never break
// /api/models. Every failure path returns null or a status of 'unknown'.
// ---------------------------------------------------------------------------

const fsp = require('fs').promises;
const path = require('path');

const STATE_FILE = '.download-state.json';
// A "downloading" manifest older than this means the writer is gone.
const STALE_MS = 60 * 1000;
// /api/models is polled; hold summaries briefly so a poll storm is cheap.
const CACHE_TTL_MS = 3000;

const cache = new Map(); // modelDir -> { at, value }

function cacheGet(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    return undefined;
}
function cacheSet(key, value) {
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
}
function invalidate(modelDir) {
    if (modelDir) cache.delete(modelDir); else cache.clear();
}

function statePath(modelDir) { return path.join(modelDir, STATE_FILE); }

/**
 * Read and validate a model dir's manifest.
 * @returns {Promise<object|null>} the manifest, or null when absent/corrupt.
 */
async function readState(modelDir) {
    try {
        const raw = await fsp.readFile(statePath(modelDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        // Normalize the fields we rely on; anything else rides along untouched.
        return {
            version: Number(parsed.version) || 1,
            repo: typeof parsed.repo === 'string' ? parsed.repo : null,
            requestedFile: typeof parsed.requestedFile === 'string' ? parsed.requestedFile : null,
            status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
            totalBytes: Number(parsed.totalBytes) || 0,
            downloadedBytes: Number(parsed.downloadedBytes) || 0,
            percent: Number(parsed.percent) || 0,
            startedAt: parsed.startedAt || null,
            updatedAt: parsed.updatedAt || null,
            pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null,
            error: parsed.error ?? null,
            files: Array.isArray(parsed.files) ? parsed.files.filter(f => f && typeof f.name === 'string') : []
        };
    } catch {
        return null; // absent, unreadable, or invalid JSON — treat as "no record"
    }
}

function isPidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function parseTs(v) {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}

/**
 * Apply the staleness rule to a manifest's declared status.
 * @returns {'complete'|'downloading'|'interrupted'|'failed'|'unknown'}
 */
function effectiveStatus(state, now = Date.now()) {
    if (!state) return 'unknown';
    const s = String(state.status || '').toLowerCase();
    if (s === 'complete' || s === 'completed') return 'complete';
    if (s === 'failed') return 'failed';
    if (s === 'interrupted') return 'interrupted';
    if (s === 'downloading') {
        const updated = parseTs(state.updatedAt);
        const stale = updated == null || (now - updated) > STALE_MS;
        // Two independent demotions: a DEAD pid demotes immediately even when the
        // timestamp is fresh (the writer died between heartbeats), and a stale
        // heartbeat demotes regardless of what the pid field claims (a pid can be
        // recycled, and a wedged writer is no better than a dead one).
        if (state.pid != null && !isPidAlive(state.pid)) return 'interrupted';
        if (stale) return 'interrupted';
        return 'downloading';
    }
    return 'unknown';
}

async function statSize(p) {
    try { const st = await fsp.stat(p); return st.isFile() ? st.size : 0; } catch { return 0; }
}

// Weight files present in a model dir (what a resume would have to re-fetch).
async function listModelFiles(modelDir) {
    try {
        const entries = await fsp.readdir(modelDir, { withFileTypes: true });
        return entries
            .filter(e => e.isFile() && !e.name.startsWith('.'))
            .map(e => e.name);
    } catch { return []; }
}

/**
 * Truthful summary of a model dir's download state, with sizes re-stat-ed.
 * @returns {Promise<{status,percent,downloadedBytes,totalBytes,repo,file,
 *                    updatedAt,resumable,reason,files:Array}|null>}
 *          null when the dir has no manifest at all.
 */
async function summarize(modelDir) {
    const cached = cacheGet(modelDir);
    if (cached !== undefined) return cached;

    const state = await readState(modelDir);
    if (!state) return cacheSet(modelDir, null);

    const status = effectiveStatus(state);

    // Re-stat: never trust the manifest's byte counters (they are as old as its
    // last write, and a killed writer never wrote the final one).
    const files = [];
    let downloadedBytes = 0;
    let totalBytes = 0;
    if (state.files.length) {
        for (const f of state.files) {
            const onDisk = await statSize(path.join(modelDir, f.name));
            const expected = Number(f.expectedBytes) || 0;
            downloadedBytes += onDisk;
            totalBytes += expected;
            files.push({
                name: f.name,
                expectedBytes: expected,
                downloadedBytes: onDisk,
                complete: expected > 0 ? onDisk >= expected : !!f.complete,
                etag: f.etag ?? null
            });
        }
    } else {
        // Manifest without a file list — fall back to whatever is in the dir.
        for (const name of await listModelFiles(modelDir)) {
            const onDisk = await statSize(path.join(modelDir, name));
            downloadedBytes += onDisk;
            files.push({ name, expectedBytes: 0, downloadedBytes: onDisk, complete: false, etag: null });
        }
    }
    if (!totalBytes) totalBytes = Number(state.totalBytes) || 0;
    if (!downloadedBytes) downloadedBytes = Number(state.downloadedBytes) || 0;

    const percent = totalBytes > 0
        ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 1000) / 10)
        : (Number(state.percent) || 0);

    // Resumable only when we can attribute the bytes to a repo + file: a resume
    // is a ranged re-request against the SAME remote object.
    const incomplete = status === 'interrupted' || status === 'failed';
    const resumable = incomplete && !!state.repo && !!state.requestedFile;

    let reason;
    if (status === 'complete') reason = 'download complete';
    else if (status === 'downloading') reason = 'download in progress';
    else if (status === 'failed') reason = state.error ? `download failed: ${state.error}` : 'download failed';
    else if (status === 'interrupted') {
        reason = state.status === 'downloading'
            ? 'download was interrupted (the downloader process is gone — a webapp restart/rebuild kills it)'
            : 'download was interrupted';
    } else reason = 'download state unknown';
    if (incomplete && !resumable) reason += ' — no repo/file recorded, re-download to repair';

    return cacheSet(modelDir, {
        status,
        percent,
        downloadedBytes,
        totalBytes,
        repo: state.repo,
        file: state.requestedFile,
        updatedAt: state.updatedAt,
        startedAt: state.startedAt,
        error: state.error ?? null,
        pid: state.pid,
        resumable,
        reason,
        files
    });
}

/**
 * Every model dir under `modelsDir` that carries a manifest, summarized.
 * @returns {Promise<Array<{modelName, modelDir, ...summary}>>}
 */
async function listPartials(modelsDir) {
    let entries = [];
    try {
        entries = await fsp.readdir(modelsDir, { withFileTypes: true });
    } catch { return []; }
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('models--'));
    const out = [];
    for (const d of dirs) {
        const modelDir = path.join(modelsDir, d.name);
        const s = await summarize(modelDir);
        if (s) out.push({ modelName: d.name, modelDir, ...s });
    }
    return out;
}

/**
 * Rewrite a manifest's status in place (used by the boot scan to demote a
 * dead "downloading" record to "interrupted" so disk state is honest).
 * Best-effort — never throws.
 */
async function markStatus(modelDir, status, extra = {}) {
    try {
        const raw = await fsp.readFile(statePath(modelDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return false;
        parsed.status = status;
        parsed.updatedAt = new Date().toISOString();
        Object.assign(parsed, extra);
        await fsp.writeFile(statePath(modelDir), JSON.stringify(parsed, null, 2));
        invalidate(modelDir);
        return true;
    } catch { return false; }
}

module.exports = {
    STATE_FILE,
    STALE_MS,
    readState,
    effectiveStatus,
    summarize,
    listPartials,
    markStatus,
    invalidate,
    _isPidAlive: isPidAlive
};
