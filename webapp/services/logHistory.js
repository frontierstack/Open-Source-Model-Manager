'use strict';

// Server-side process-log history.
//
// WHY THIS EXISTS: the Logs tab used to be a pure CLIENT-side buffer — every
// line arrived over the WebSocket, lived in React state and was mirrored to
// localStorage. Nothing was retained server-side, so a line emitted while no
// browser was attached (page closed, laptop asleep, socket dropped mid-model-
// load, a different device) was gone forever. That is the reported "logs only
// show if the page is open and being viewed".
//
// Now every `{type:'log'}` frame is recorded here FIRST — at the one
// `broadcast()` choke point, so every call site is covered — and the client
// backfills the gap with `GET /api/logs?since=<seq>` on mount and on every
// reconnect. Collection no longer depends on anyone watching.
//
// Visibility matches the WS exactly: a frame with no `targetUserId` is global
// (every authenticated client) and one with a `targetUserId` belongs to that
// account only. No new information is exposed by the history endpoint.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = parseInt(process.env.LOG_HISTORY_MAX || '5000', 10);
// Persisted slice is smaller than the in-memory ring: a restart wants recent
// context, not the whole firehose, and the file is rewritten whole each flush.
const PERSIST_ENTRIES = parseInt(process.env.LOG_HISTORY_PERSIST || '1500', 10);
const PERSIST_DEBOUNCE_MS = parseInt(process.env.LOG_HISTORY_FLUSH_MS || '15000', 10);
// A single line is capped so one runaway container line cannot blow the ring's
// memory budget; the WS frame itself is untouched.
const MAX_LINE_CHARS = 4000;

let entries = [];          // ascending by seq
let seqCounter = 0;
let filePath = null;
let dirty = false;
let flushTimer = null;
let loaded = false;

function clampMessage(msg) {
    const s = typeof msg === 'string' ? msg : String(msg == null ? '' : msg);
    return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + ' …[truncated]' : s;
}

function normalizeLevel(level) {
    const l = String(level || 'info').toLowerCase();
    if (l === 'warn') return 'warning';
    return ['error', 'warning', 'success', 'info'].includes(l) ? l : 'info';
}

/**
 * Point the store at its on-disk backup and load whatever survived a restart.
 * Safe to call more than once; only the first call reads.
 */
function init(dataDir) {
    if (loaded) return;
    loaded = true;
    try {
        filePath = path.join(dataDir, 'process-logs.json');
        if (fs.existsSync(filePath)) {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.entries) ? raw.entries : []);
            entries = list
                .filter(e => e && typeof e.message === 'string')
                .slice(-MAX_ENTRIES)
                .map(e => ({
                    seq: Number(e.seq) || 0,
                    message: e.message,
                    level: normalizeLevel(e.level),
                    timestamp: Number(e.timestamp) || Date.now(),
                    targetUserId: e.targetUserId || null,
                }));
            // Continue the sequence past whatever was persisted so a client
            // holding a pre-restart seq is never handed a duplicate number.
            seqCounter = entries.reduce((m, e) => Math.max(m, e.seq), 0);
        }
    } catch (err) {
        // A corrupt/truncated backup must never stop the server booting.
        console.error('[log-history] could not load persisted logs:', err.message);
        entries = [];
    }
}

function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
    }, PERSIST_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
}

function flush() {
    if (!dirty || !filePath) return;
    dirty = false;
    try {
        // temp + rename: a crash mid-write must not leave a truncated JSON
        // array that the next boot reads as "no history".
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entries.slice(-PERSIST_ENTRIES)));
        fs.renameSync(tmp, filePath);
    } catch (err) {
        console.error('[log-history] could not persist logs:', err.message);
    }
}

/**
 * Record one log frame. Returns the assigned sequence number so the caller can
 * stamp it onto the outgoing WS frame (the client dedupes on it).
 */
function record({ message, level, targetUserId = null, timestamp = null }) {
    if (message == null) return null;
    const entry = {
        seq: ++seqCounter,
        message: clampMessage(message),
        level: normalizeLevel(level),
        timestamp: Number(timestamp) || Date.now(),
        targetUserId: targetUserId || null,
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    scheduleFlush();
    return entry.seq;
}

function visibleTo(entry, userId) {
    return !entry.targetUserId || (userId && String(entry.targetUserId) === String(userId));
}

/**
 * Entries newer than `since` that this account may see.
 *
 * `oldestSeq` lets the client tell "nothing new" from "your cursor fell off the
 * back of the ring while you were away" — in the latter case it replaces its
 * buffer instead of appending to a stale tail.
 */
function since(sinceSeq, { userId = null, limit = 1000 } = {}) {
    const from = Number(sinceSeq) || 0;
    const cap = Math.max(1, Math.min(Number(limit) || 1000, MAX_ENTRIES));
    const out = [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.seq <= from) break;
        if (!visibleTo(e, userId)) continue;
        out.push({ seq: e.seq, message: e.message, level: e.level, timestamp: e.timestamp });
        if (out.length >= cap) break;
    }
    out.reverse();
    return {
        entries: out,
        latestSeq: seqCounter,
        oldestSeq: entries.length ? entries[0].seq : seqCounter,
        total: entries.length,
    };
}

function stats() {
    return { size: entries.length, latestSeq: seqCounter, max: MAX_ENTRIES };
}

module.exports = { init, record, since, flush, stats, MAX_ENTRIES };
