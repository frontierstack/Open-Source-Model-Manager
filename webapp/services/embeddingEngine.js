/**
 * Embedding engine — owns the resident Python embedding/retrieval subprocess
 * (embedding_engine.py): spawn it once at boot, keep it warm, restart it if it
 * dies, talk to it over a loopback HTTP port. One model2vec model in RAM,
 * shared by every consumer:
 *   - memoryIndex.js  — account-memory semantic index
 *   - toolIndex.js    — tool-router semantic catalog index
 * The engine only ever returns top-k rows, so callers stay context-cheap.
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ENGINE_SCRIPT = path.join(__dirname, 'embedding_engine.py');

// --------------------------------------------------------------------------
// Engine subprocess lifecycle
// --------------------------------------------------------------------------

let engineProc = null;
let engineBaseHost = '127.0.0.1';
let enginePort = null;
let startPromise = null;

function log(...a) { console.log('[embed]', ...a); }

function spawnEngine() {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('python3', [ENGINE_SCRIPT], {
            env: { ...process.env, EMBED_ENGINE_PORT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        engineProc = proc;

        const onLine = (line) => {
            const m = /EMBED_ENGINE_LISTENING\s+(\d+)/.exec(line);
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
                if (line.trim()) { onLine(line); if (!line.includes('EMBED_ENGINE_LISTENING')) log(line.trim()); }
            }
        });
        proc.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) log('engine:', s.split('\n').slice(-1)[0]);
        });
        proc.on('exit', (code, sig) => {
            log(`engine exited (code=${code} sig=${sig})`);
            if (engineProc === proc) { engineProc = null; enginePort = null; }
            if (!settled) { settled = true; reject(new Error(`embedding engine exited before listening (code=${code})`)); }
        });
        proc.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });

        // Model load can take a few seconds; give it generous headroom.
        setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('embedding engine startup timed out')); }
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


module.exports = { ensureEngine, health, call, engineCall: call };
