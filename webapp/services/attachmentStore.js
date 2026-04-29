// Persistent attachment store. Keeps PDF bytes, structured spreadsheet
// rows, and similar large/binary upload artifacts on disk so they don't
// bloat conversation messages on disk or the SSE stream when a model
// turn echoes the message list back.
//
// Layout:
//   /models/.modelserver/attachments/<userIdSafe>/<attachmentId>/
//       file        — raw bytes (no extension; Content-Type lives in meta)
//       meta.json   — { filename, mimeType, type, byteSize, sheets?, ... }
//
// Ownership is enforced by path: a logged-in user only ever sees their
// own <userIdSafe> bucket. There is no cross-user lookup; an attempt to
// fetch another user's id falls through to "not found".
//
// All fs operations use crypto-random ids that the caller cannot
// influence; the only validation we apply on the read path is a strict
// /^[a-f0-9]{32}$/ check to keep paths well-formed.

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = '/models/.modelserver/attachments';

function userIdSafe(userId) {
    return String(userId == null ? 'anon' : userId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
}

function isValidId(id) {
    return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function userDir(userId) {
    return path.join(ROOT, userIdSafe(userId));
}

function attachmentDir(userId, id) {
    return path.join(userDir(userId), id);
}

async function ensureRoot() {
    await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
}

// Write {file, meta.json} for a new attachment. Returns the generated
// attachmentId. `bytes` may be null/undefined for purely-structured
// metadata (e.g. xlsx where we save sheets[] but not the raw xlsx bytes).
async function save(userId, { filename, mimeType, type, bytes, meta = {} } = {}) {
    await ensureRoot();
    const id = crypto.randomBytes(16).toString('hex');
    const dir = attachmentDir(userId, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const fullMeta = {
        id,
        filename: filename || 'attachment',
        mimeType: mimeType || 'application/octet-stream',
        type: type || 'file',
        byteSize: bytes ? bytes.length : 0,
        createdAt: Date.now(),
        ...meta,
    };
    // Write meta first so a bytes-write crash leaves us with metadata
    // pointing at a missing file (callers treat that as 404). The reverse
    // ordering would leave bytes the orphan-sweep can't easily attribute.
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(fullMeta), { mode: 0o600 });
    if (bytes && bytes.length > 0) {
        await fs.writeFile(path.join(dir, 'file'), bytes, { mode: 0o600 });
    }
    return id;
}

async function loadMeta(userId, id) {
    if (!isValidId(id)) return null;
    try {
        const txt = await fs.readFile(path.join(attachmentDir(userId, id), 'meta.json'), 'utf8');
        return JSON.parse(txt);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[attachmentStore] loadMeta failed:', e.message);
        return null;
    }
}

// Returns { bytes, meta } or null if missing.
async function loadBytes(userId, id) {
    if (!isValidId(id)) return null;
    const meta = await loadMeta(userId, id);
    if (!meta) return null;
    try {
        const bytes = await fs.readFile(path.join(attachmentDir(userId, id), 'file'));
        return { bytes, meta };
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[attachmentStore] loadBytes failed:', e.message);
        return null;
    }
}

async function deleteOne(userId, id) {
    if (!isValidId(id)) return { deleted: false };
    const dir = attachmentDir(userId, id);
    try {
        // Capture size before unlinking so callers can log how much they wiped.
        let byteSize = 0;
        try {
            const meta = await loadMeta(userId, id);
            byteSize = meta?.byteSize || 0;
        } catch (_) { /* ignore */ }
        await fs.rm(dir, { recursive: true, force: true });
        return { deleted: true, byteSize };
    } catch (e) {
        return { deleted: false, error: e.message };
    }
}

// Delete every attachment referenced by any message in `messages` (the
// shape PUT /api/conversations/:id sees). Returns { count, byteSize }.
async function deleteForConversation(userId, messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { count: 0, byteSize: 0 };
    }
    let count = 0;
    let byteSize = 0;
    for (const msg of messages) {
        const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
        for (const att of atts) {
            if (att && typeof att.attachmentId === 'string') {
                const r = await deleteOne(userId, att.attachmentId);
                if (r.deleted) {
                    count++;
                    byteSize += r.byteSize || 0;
                }
            }
        }
    }
    return { count, byteSize };
}

// Walk every user dir and drop any attachment that is older than
// `maxAgeMs` AND whose id doesn't appear in `referencedIds`. Used at
// boot + on a periodic timer to keep storage bounded against incomplete
// uploads or persistence races.
async function sweepOrphans(referencedIdsByUser, { maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    let entries;
    try {
        entries = await fs.readdir(ROOT, { withFileTypes: true });
    } catch (e) {
        if (e.code === 'ENOENT') return { swept: 0, byteSize: 0 };
        throw e;
    }
    const now = Date.now();
    let swept = 0;
    let byteSize = 0;
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const userBucket = ent.name;
        const referenced = referencedIdsByUser.get(userBucket) || new Set();
        let aids;
        try {
            aids = await fs.readdir(path.join(ROOT, userBucket), { withFileTypes: true });
        } catch (_) { continue; }
        for (const aEnt of aids) {
            if (!aEnt.isDirectory()) continue;
            const aid = aEnt.name;
            if (!isValidId(aid)) continue;
            if (referenced.has(aid)) continue;
            const dir = path.join(ROOT, userBucket, aid);
            let mtime = 0;
            let size = 0;
            try {
                const st = await fs.stat(dir);
                mtime = st.mtimeMs;
                const meta = await loadMeta(userBucket, aid);
                size = meta?.byteSize || 0;
            } catch (_) { /* missing meta — still eligible */ }
            if (mtime && now - mtime < maxAgeMs) continue;
            try {
                await fs.rm(dir, { recursive: true, force: true });
                swept++;
                byteSize += size;
            } catch (_) { /* ignore */ }
        }
    }
    return { swept, byteSize };
}

module.exports = {
    save,
    loadMeta,
    loadBytes,
    deleteOne,
    deleteForConversation,
    sweepOrphans,
    userIdSafe,
    isValidId,
    ROOT,
};
