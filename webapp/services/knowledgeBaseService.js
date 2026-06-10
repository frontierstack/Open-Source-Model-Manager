/**
 * Knowledge Base service — Node-side orchestration for the RAG feature.
 *
 * Responsibilities:
 *   - own the embedding/retrieval engine subprocess (kb_engine.py): spawn it
 *     once at boot, keep it warm, restart it if it dies, talk to it over a
 *     loopback HTTP port.
 *   - own knowledge-base metadata (knowledge-bases.json): create / list /
 *     get / update / delete records, each tagged with its owner userId.
 *   - extract plain text from uploaded documents (pdf / docx / xlsx / text)
 *     and split it into overlapping chunks before handing them to the engine.
 *
 * The engine holds the model resident and only ever returns the top-k chunks,
 * so querying stays fast and context-cheap regardless of how big a KB grows.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DATA_DIR = '/models/.modelserver';
const KB_META_FILE = path.join(DATA_DIR, 'knowledge-bases.json');
const KB_ROOT = path.join(DATA_DIR, 'knowledge-bases');
const ENGINE_SCRIPT = path.join(__dirname, 'kb_engine.py');

// --------------------------------------------------------------------------
// Engine subprocess lifecycle
// --------------------------------------------------------------------------

let engineProc = null;
let engineBaseHost = '127.0.0.1';
let enginePort = null;
let startPromise = null;

function log(...a) { console.log('[kb]', ...a); }

function spawnEngine() {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('python3', [ENGINE_SCRIPT], {
            env: { ...process.env, KB_ENGINE_PORT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        engineProc = proc;

        const onLine = (line) => {
            const m = /KB_ENGINE_LISTENING\s+(\d+)/.exec(line);
            if (m && !settled) {
                settled = true;
                enginePort = parseInt(m[1], 10);
                log(`engine listening on ${engineBaseHost}:${enginePort}`);
                resolve();
            }
        };

        let buf = '';
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (line.trim()) { onLine(line); if (!line.includes('KB_ENGINE_LISTENING')) log(line.trim()); }
            }
        });
        proc.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) log('engine:', s.split('\n').slice(-1)[0]);
        });
        proc.on('exit', (code, sig) => {
            log(`engine exited (code=${code} sig=${sig})`);
            if (engineProc === proc) { engineProc = null; enginePort = null; }
            if (!settled) { settled = true; reject(new Error(`kb_engine exited before listening (code=${code})`)); }
        });
        proc.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });

        // Model load can take a few seconds; give it generous headroom.
        setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('kb_engine startup timed out')); }
        }, 90000);
    });
}

/** Ensure the engine is up; safe to call concurrently. */
async function ensureEngine() {
    if (engineProc && enginePort) return;
    if (!startPromise) {
        startPromise = spawnEngine().catch((e) => { startPromise = null; throw e; });
    }
    await startPromise;
}

function engineRequest(pathName, bodyObj, { method = 'POST' } = {}) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
        const req = http.request({
            host: engineBaseHost,
            port: enginePort,
            path: pathName,
            method,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
                : {},
            timeout: 120000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data || '{}');
                    if (res.statusCode >= 400 || json.ok === false) {
                        return reject(new Error(json.error || `engine ${res.statusCode}`));
                    }
                    resolve(json);
                } catch (e) { reject(new Error('engine bad response: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('engine request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

async function call(pathName, body, opts) {
    await ensureEngine();
    try {
        return await engineRequest(pathName, body, opts);
    } catch (e) {
        // One transparent retry after a respawn — covers a crashed engine.
        log(`request ${pathName} failed (${e.message}); respawning engine`);
        engineProc = null; enginePort = null; startPromise = null;
        await ensureEngine();
        return engineRequest(pathName, body, opts);
    }
}

async function health() {
    await ensureEngine();
    return engineRequest('/health', null, { method: 'GET' });
}

// --------------------------------------------------------------------------
// Metadata store (knowledge-bases.json)
// --------------------------------------------------------------------------

let writeChain = Promise.resolve();

async function readMeta() {
    try {
        return JSON.parse(await fsp.readFile(KB_META_FILE, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

/** Serialize read-modify-write so concurrent requests don't clobber the file. */
function mutateMeta(fn) {
    const next = writeChain.then(async () => {
        const list = await readMeta();
        const result = await fn(list);
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(KB_META_FILE, JSON.stringify(list, null, 2));
        return result;
    });
    // Keep the chain alive even if this link rejects.
    writeChain = next.catch(() => {});
    return next;
}

function userIdSafe(userId) {
    return String(userId == null ? 'global' : userId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function kbDirFor(kb) {
    return path.join(KB_ROOT, userIdSafe(kb.userId), kb.id);
}

async function listKBs(userId, { all = false } = {}) {
    const list = await readMeta();
    if (all) return list;
    return list.filter((kb) => kb.userId === userId);
}

async function getKB(id) {
    const list = await readMeta();
    return list.find((kb) => kb.id === id) || null;
}

async function createKB({ name, description = '', userId }) {
    const kb = {
        id: crypto.randomUUID(),
        name: String(name || 'Untitled').slice(0, 200),
        description: String(description || '').slice(0, 2000),
        userId: userId || null,
        documentCount: 0,
        chunkCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    await mutateMeta((list) => { list.push(kb); });
    await fsp.mkdir(kbDirFor(kb), { recursive: true });
    return kb;
}

async function updateKB(id, patch) {
    return mutateMeta((list) => {
        const kb = list.find((k) => k.id === id);
        if (!kb) return null;
        Object.assign(kb, patch, { updatedAt: new Date().toISOString() });
        return kb;
    });
}

/** Atomically append/replace a document record + refresh counts. */
async function addDocumentMeta(kbId, doc, { chunkCount, embeddingModel } = {}) {
    return mutateMeta((list) => {
        const kb = list.find((k) => k.id === kbId);
        if (!kb) return null;
        kb.documents = [...(kb.documents || []).filter((d) => d.docId !== doc.docId), doc];
        kb.documentCount = kb.documents.length;
        if (chunkCount != null) kb.chunkCount = chunkCount;
        if (embeddingModel) kb.embeddingModel = embeddingModel;
        kb.updatedAt = new Date().toISOString();
        return kb;
    });
}

/** Atomically remove a document record + refresh counts. */
async function removeDocumentMeta(kbId, docId, { chunkCount } = {}) {
    return mutateMeta((list) => {
        const kb = list.find((k) => k.id === kbId);
        if (!kb) return null;
        kb.documents = (kb.documents || []).filter((d) => d.docId !== docId);
        kb.documentCount = kb.documents.length;
        if (chunkCount != null) kb.chunkCount = chunkCount;
        kb.updatedAt = new Date().toISOString();
        return kb;
    });
}

async function deleteKB(id) {
    let removed = null;
    await mutateMeta((list) => {
        const i = list.findIndex((k) => k.id === id);
        if (i >= 0) { removed = list[i]; list.splice(i, 1); }
    });
    if (removed) {
        await fsp.rm(kbDirFor(removed), { recursive: true, force: true }).catch(() => {});
    }
    return removed;
}

// --------------------------------------------------------------------------
// Document text extraction + chunking
// --------------------------------------------------------------------------

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/[ \t]+/g, ' ');
}

// Image formats we OCR rather than decode as text. Tesseract (via leptonica)
// reads png/jpg/tiff/bmp/gif natively; webp and anything else we transcode to
// PNG with Jimp first.
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp'];
const TESSERACT_NATIVE = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.gif']);

/** OCR an image buffer to text via Tesseract. Returns '' if nothing legible. */
async function extractImageText(buffer, ext) {
    const tmpBase = path.join(os.tmpdir(), `kb_ocr_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);
    let ocrPath = `${tmpBase}${ext || '.png'}`;
    const cleanup = [];
    try {
        // Transcode formats Tesseract can't read (e.g. webp) to PNG.
        if (!TESSERACT_NATIVE.has(ext)) {
            try {
                const { Jimp } = require('jimp');
                const img = await Jimp.read(buffer);
                const png = await img.getBuffer('image/png');
                ocrPath = `${tmpBase}.png`;
                await fsp.writeFile(ocrPath, png);
            } catch (convErr) {
                log('image transcode failed, trying raw:', convErr.message);
                ocrPath = `${tmpBase}${ext || '.png'}`;
                await fsp.writeFile(ocrPath, buffer);
            }
        } else {
            await fsp.writeFile(ocrPath, buffer);
        }
        cleanup.push(ocrPath);
        const { stdout } = await execFileAsync('tesseract', [ocrPath, 'stdout', '--psm', '3'], {
            timeout: 30000,
            maxBuffer: 8 * 1024 * 1024,
        });
        return (stdout || '').trim();
    } catch (e) {
        log('OCR failed:', e.message);
        return '';
    } finally {
        for (const p of cleanup) { try { await fsp.unlink(p); } catch (_) {} }
    }
}

/** Extract plain text from a document buffer. Returns '' if unsupported. */
async function extractText(buffer, filename = '', mimeType = '') {
    const ext = (path.extname(filename) || '').toLowerCase();
    const mime = (mimeType || '').toLowerCase();
    try {
        if (ext === '.pdf' || mime.includes('pdf')) {
            const pdfParse = require('pdf-parse');
            const out = await pdfParse(buffer);
            return out.text || '';
        }
        if (ext === '.docx' || mime.includes('word') || mime.includes('officedocument.wordprocessing')) {
            const mammoth = require('mammoth');
            const out = await mammoth.extractRawText({ buffer });
            return out.value || '';
        }
        if (['.xlsx', '.xls', '.xlsm'].includes(ext) || mime.includes('sheet') || mime.includes('excel')) {
            const XLSX = require('xlsx');
            const wb = XLSX.read(buffer, { type: 'buffer' });
            return wb.SheetNames
                .map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]))
                .join('\n\n');
        }
        if (IMAGE_EXTS.includes(ext) || mime.startsWith('image/')) {
            const ocr = await extractImageText(buffer, ext || '.png');
            // Always register the image even when OCR finds nothing legible, so
            // it's still counted and retrievable by filename. The header line
            // gives semantic search something to match on.
            const base = path.basename(filename) || 'image';
            return ocr
                ? `[Image: ${base}]\n${ocr}`
                : `[Image: ${base}] (no machine-readable text detected in this picture)`;
        }
        if (ext === '.html' || ext === '.htm' || mime.includes('html')) {
            return stripHtml(buffer.toString('utf8'));
        }
        // Everything else: treat as UTF-8 text (txt, md, csv, json, source code, logs…).
        return buffer.toString('utf8');
    } catch (e) {
        log('extractText failed:', e.message);
        return '';
    }
}

/** Split text into overlapping chunks, preferring paragraph/line boundaries. */
function chunkText(text, { chunkChars = 1200, overlap = 200 } = {}) {
    const clean = String(text || '')
        .replace(/[\u0000\u00a0]/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!clean) return [];
    if (clean.length <= chunkChars) return [clean];

    // Build blocks on blank-line boundaries, then greedily pack into chunks.
    const blocks = clean.split(/\n\s*\n/);
    const chunks = [];
    let cur = '';
    const pushCur = () => { if (cur.trim()) chunks.push(cur.trim()); };

    for (let block of blocks) {
        block = block.trim();
        if (!block) continue;
        // A single block bigger than the window: hard-split it with overlap.
        if (block.length > chunkChars) {
            pushCur(); cur = '';
            for (let i = 0; i < block.length; i += (chunkChars - overlap)) {
                chunks.push(block.slice(i, i + chunkChars).trim());
            }
            continue;
        }
        if ((cur + '\n\n' + block).length > chunkChars) {
            pushCur();
            // Carry an overlap tail from the previous chunk for context continuity.
            const tail = cur.length > overlap ? cur.slice(cur.length - overlap) : cur;
            cur = (tail ? tail + '\n\n' : '') + block;
        } else {
            cur = cur ? cur + '\n\n' + block : block;
        }
    }
    pushCur();
    return chunks.filter((c) => c.length > 0);
}

// --------------------------------------------------------------------------
// Engine-backed document operations
// --------------------------------------------------------------------------

/** Extract → chunk → embed/store one document. Returns {docId, chunkCount}. */
async function ingestDocument(kb, { docId, filename, buffer, mimeType, text }) {
    const raw = text != null ? String(text) : await extractText(buffer, filename, mimeType);
    const chunks = chunkText(raw);
    if (!chunks.length) return { docId, chunkCount: 0, chars: raw.length };
    const res = await call('/ingest', { kbDir: kbDirFor(kb), docId, filename, chunks });
    return { docId, chunkCount: res.chunkCount || chunks.length, chars: raw.length };
}

async function search(kb, query, k = 6) {
    const res = await call('/search', { kbDir: kbDirFor(kb), query, k });
    return res.results || [];
}

async function deleteDocument(kb, docId) {
    return call('/delete_doc', { kbDir: kbDirFor(kb), docId });
}

/** Reassemble a document's full text from its stored chunks (ordered). */
async function getDocumentText(kb, { docId, filename, maxChars } = {}) {
    return call('/get_doc', { kbDir: kbDirFor(kb), docId, filename, maxChars });
}

async function stats(kb) {
    return call('/stats', { kbDir: kbDirFor(kb) });
}

module.exports = {
    ensureEngine,
    health,
    // Raw engine RPC — shared by memoryIndex.js so account-memory embeddings
    // ride the SAME resident engine process (one model in RAM, two stores).
    engineCall: call,
    listKBs,
    getKB,
    createKB,
    updateKB,
    deleteKB,
    addDocumentMeta,
    removeDocumentMeta,
    kbDirFor,
    extractText,
    chunkText,
    ingestDocument,
    search,
    deleteDocument,
    getDocumentText,
    stats,
};
