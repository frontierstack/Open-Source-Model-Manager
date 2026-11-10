'use strict';
// Browser agent: runs one browser-use (https://github.com/browser-use/browser-use)
// task in a throwaway container and streams its steps back.
//
// browser-use 1.0 has the model write Python against a real Chromium, and that
// Python can read any file the process can. So it never runs in the webapp
// container (Docker socket, encryption keys, user data): each task gets its own
// container from the webapp image with no volumes, all capabilities dropped and
// a read-only root. Its web traffic goes through the egress proxy (private
// addresses blocked unless the admin allows them, cloud metadata always), and
// it reaches the model only through a relay here, one random token per run, so
// an engine's API key (Strata) never enters the container.
//
// Events from services/browser_agent_runner.py (JSON lines on stdout):
//   start · step {n, action, code, output, error, url, title, shot} · done

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { PassThrough } = require('stream');
const axios = require('axios');
const Docker = require('dockerode');
const egressProxy = require('./egressProxy');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const VENV_PYTHON = process.env.BROWSER_AGENT_PYTHON || '/opt/browser-use/bin/python';
const RUNNER = path.join(__dirname, 'browser_agent_runner.py');
const NETWORK = process.env.COMPOSE_PROJECT_NAME ? `${process.env.COMPOSE_PROJECT_NAME}_default` : 'modelserver_default';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.BROWSER_AGENT_MAX_CONCURRENT || '2', 10));
const MEMORY_BYTES = Math.max(1, parseFloat(process.env.BROWSER_AGENT_MEMORY_GB || '3')) * 1024 ** 3;
const SHOT_RETENTION_MS = 14 * 24 * 3600 * 1000;

let shotRoot = null;     // /models/.modelserver/browser-agent
let selfInfo = null;     // { image, ip }
let relay = null;        // { server, port }
const relayTokens = new Map(); // token -> { base, model, expiresAt }
let running = 0;

function init({ dataDir }) {
    shotRoot = path.join(dataDir, 'browser-agent');
    fs.mkdirSync(shotRoot, { recursive: true });
    const sweep = () => sweepOldRuns().catch(() => {});
    setTimeout(sweep, 60_000).unref();
    setInterval(sweep, 12 * 3600 * 1000).unref();
    // Containers a webapp restart left behind would otherwise run on.
    setTimeout(() => removeStrayContainers().catch(() => {}), 5_000).unref();
}

/** True when the browser-use environment is installed in this image. */
function available() {
    try { return fs.existsSync(VENV_PYTHON) && fs.existsSync(RUNNER); } catch (_) { return false; }
}

async function getSelf() {
    if (selfInfo) return selfInfo;
    const c = await docker.getContainer(os.hostname()).inspect();
    const net = c.NetworkSettings && c.NetworkSettings.Networks && c.NetworkSettings.Networks[NETWORK];
    if (!net || !net.IPAddress) throw new Error(`the webapp container is not on the ${NETWORK} network`);
    selfInfo = { image: process.env.BROWSER_AGENT_IMAGE || c.Image, ip: net.IPAddress };
    return selfInfo;
}

// ---- model relay -----------------------------------------------------------
// /r/<token>/v1/<path> → http://<instance>/v1/<path>. axios carries the
// engine key (engineManager's interceptor) and Strata's four-stop cap.
function ensureRelay() {
    if (relay) return relay;
    const server = http.createServer((req, res) => {
        const m = /^\/r\/([A-Za-z0-9_-]{20,})\/v1(\/[^?]*)?(\?.*)?$/.exec(req.url || '');
        const entry = m && relayTokens.get(m[1]);
        if (!entry || entry.expiresAt < Date.now()) { res.writeHead(404); res.end(); return; }
        const chunks = [];
        let size = 0;
        req.on('data', c => { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
        req.on('end', async () => {
            let data;
            const raw = Buffer.concat(chunks);
            if (raw.length) {
                try { data = JSON.parse(raw.toString('utf8')); } catch (_) { data = raw; }
                if (data && typeof data === 'object' && !Buffer.isBuffer(data) && entry.model) data.model = entry.model;
            }
            try {
                const up = await axios({
                    method: req.method,
                    url: `${entry.base}/v1${m[2] || ''}${m[3] || ''}`,
                    data,
                    headers: { 'Content-Type': 'application/json', Accept: req.headers.accept || '*/*' },
                    responseType: 'stream',
                    timeout: 0,
                    validateStatus: () => true,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });
                entry.requests = (entry.requests || 0) + 1;
                if (up.status >= 400) {
                    // Read the error body for the log, then answer with it.
                    const parts = [];
                    for await (const c of up.data) parts.push(c);
                    const text = Buffer.concat(parts).toString('utf8');
                    console.warn(`[browser_agent] model relay: HTTP ${up.status} from ${entry.base}: ${text.slice(0, 300)}`);
                    res.writeHead(up.status, { 'Content-Type': up.headers['content-type'] || 'application/json' });
                    res.end(text);
                    return;
                }
                const headers = {};
                for (const h of ['content-type', 'cache-control']) if (up.headers[h]) headers[h] = up.headers[h];
                res.writeHead(up.status, headers);
                up.data.pipe(res);
                res.on('close', () => { try { up.data.destroy(); } catch (_) {} });
            } catch (e) {
                if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `model relay: ${e.message}` } }));
            }
        });
    });
    server.listen(0, '0.0.0.0');
    relay = { server, get port() { return server.address() && server.address().port; } };
    return relay;
}

// ---- screenshots -----------------------------------------------------------
function safeOwner(userId) {
    return String(userId || 'anon').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'anon';
}

function shotDir(userId, runId) {
    return path.join(shotRoot, safeOwner(userId), runId);
}

/** Absolute path of one saved screenshot, owner-scoped; null when invalid. */
function shotPath(userId, runId, file) {
    if (!shotRoot || !/^[a-f0-9]{16}$/.test(String(runId)) || !/^step-\d{1,4}\.jpg$/.test(String(file))) return null;
    return path.join(shotDir(userId, runId), file);
}

async function sweepOldRuns() {
    if (!shotRoot) return;
    const now = Date.now();
    for (const owner of await fsp.readdir(shotRoot).catch(() => [])) {
        const dir = path.join(shotRoot, owner);
        for (const run of await fsp.readdir(dir).catch(() => [])) {
            const st = await fsp.stat(path.join(dir, run)).catch(() => null);
            if (st && now - st.mtimeMs > SHOT_RETENTION_MS) await fsp.rm(path.join(dir, run), { recursive: true, force: true }).catch(() => {});
        }
    }
}

async function removeStrayContainers() {
    const list = await docker.listContainers({ all: true, filters: { label: ['modelserver.role=browser-agent'] } });
    for (const c of list) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
}

// ---- run -------------------------------------------------------------------
/**
 * Run one task. target = { host, port, model } of the model instance.
 * onEvent(ev) gets each runner event; step events carry `shot` = the saved
 * file name (the base64 image is written to disk, not passed on).
 * Resolves { ok, runId, done, steps, error, stderrTail }.
 */
async function run({ task, target, userId, maxSteps = 20, timeoutS = 300, allowInternal = false, signal, onEvent, extraSystem }) {
    if (!available()) return { ok: false, error: 'browser-use is not installed in this image (rebuild the webapp image)' };
    if (running >= MAX_CONCURRENT) return { ok: false, error: `${running} browser agents are already running; wait for one to finish` };
    running++;
    const runId = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('base64url');
    const ttlMs = (timeoutS + 180) * 1000;
    let container = null, grant = null, killTimer = null, onAbort = null;
    const steps = [];
    let done = null, stderr = '', buf = '';
    try {
        const self = await getSelf();
        const r = ensureRelay();
        if (!r.port) await new Promise(res => r.server.once('listening', res));
        relayTokens.set(token, { base: `http://${target.host}:${target.port}`, model: target.model, expiresAt: Date.now() + ttlMs });
        grant = egressProxy.issueGrant({ allowlist: ['*'], toolName: 'browser_agent', userId, ttlMs });
        const proxyUrl = `http://${self.ip}:${egressProxy.PROXY_PORT || 3180}`;
        const dir = shotDir(userId, runId);
        await fsp.mkdir(dir, { recursive: true });

        const job = {
            task, maxSteps, timeoutS, allowInternal,
            model: target.model,
            baseUrl: `http://${self.ip}:${r.port}/r/${token}/v1`,
            apiKey: 'relay',
            extraSystem,
            shotMaxDim: 1024,
        };
        container = await docker.createContainer({
            name: `bagent-${runId}`,
            Image: self.image,
            // The runner travels with this process (BU_RUNNER) so the image needs
            // only the venv, and the container always runs this server's copy.
            Entrypoint: [VENV_PYTHON],
            Cmd: ['-c', 'import base64,os;exec(compile(base64.b64decode(os.environ["BU_RUNNER"]),"browser_agent_runner.py","exec"))'],
            WorkingDir: '/tmp',
            User: '0:0',
            Labels: { 'modelserver.role': 'browser-agent', 'modelserver.run': runId },
            Env: [
                `BU_JOB=${Buffer.from(JSON.stringify(job)).toString('base64')}`,
                `BU_RUNNER=${(await fsp.readFile(RUNNER)).toString('base64')}`,
                'HOME=/tmp/home', 'XDG_RUNTIME_DIR=/tmp/run', 'XDG_CONFIG_HOME=/tmp/home/.config', 'XDG_CACHE_HOME=/tmp/home/.cache',
                'ANONYMIZED_TELEMETRY=false', 'BH_TELEMETRY=0', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONUNBUFFERED=1',
                `HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, `http_proxy=${proxyUrl}`, `https_proxy=${proxyUrl}`,
                `NO_PROXY=${self.ip},localhost,127.0.0.1`, `no_proxy=${self.ip},localhost,127.0.0.1`,
            ],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                AutoRemove: false,
                NetworkMode: NETWORK,
                ReadonlyRootfs: true,
                Tmpfs: { '/tmp': 'rw,size=1536m,mode=1777', '/dev/shm': 'rw,size=512m' },
                Memory: MEMORY_BYTES,
                NanoCpus: 2e9,
                PidsLimit: 512,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
            },
        });
        const stream = await container.attach({ stream: true, stdout: true, stderr: true });
        const out = new PassThrough(), err = new PassThrough();
        container.modem.demuxStream(stream, out, err);
        err.on('data', c => { stderr = (stderr + c.toString('utf8')).slice(-20000); });
        const pending = [];
        const handle = async (line) => {
            let ev;
            try { ev = JSON.parse(line); } catch (_) { return; }
            if (ev.type === 'step') {
                let shot = null;
                if (ev.shot) {
                    shot = `step-${ev.n}.jpg`;
                    await fsp.writeFile(path.join(dir, shot), Buffer.from(ev.shot, 'base64')).catch(() => { shot = null; });
                }
                ev = { ...ev, shot };
                steps.push(ev);
            } else if (ev.type === 'done') {
                done = ev;
            }
            try { onEvent && onEvent(ev, { runId }); } catch (_) {}
        };
        out.on('data', c => {
            buf += c.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line) pending.push(handle(line));
            }
        });
        const ended = new Promise(res => { stream.once('end', res); stream.once('close', res); stream.once('error', res); });

        await container.start();
        // The proxy authorizes this container by its bridge IP (Chromium cannot
        // send proxy credentials from a URL).
        for (let t = Date.now(); Date.now() - t < 3000;) {
            const info = await container.inspect().catch(() => null);
            const ip = info && info.NetworkSettings && info.NetworkSettings.Networks && info.NetworkSettings.Networks[NETWORK] && info.NetworkSettings.Networks[NETWORK].IPAddress;
            if (ip) { egressProxy.bindGrantToIp(grant, ip); break; }
            if (info && info.State && info.State.Running === false) break;
            await new Promise(res => setTimeout(res, 50));
        }
        const kill = () => { container.kill().catch(() => {}); };
        killTimer = setTimeout(kill, (timeoutS + 120) * 1000);
        if (signal) {
            if (signal.aborted) kill();
            onAbort = kill;
            signal.addEventListener('abort', onAbort, { once: true });
        }
        await container.wait().catch(() => {});
        await Promise.race([ended, new Promise(res => setTimeout(res, 2000))]);
        if (buf.trim()) pending.push(handle(buf.trim()));
        await Promise.all(pending);
        const aborted = !!(signal && signal.aborted);
        const warnings = stderr.split('\n').filter(l => /^(WARNING|ERROR)\b/.test(l)).slice(-6);
        if (warnings.length) console.warn(`[browser_agent] ${runId}: ${warnings.join(' | ').slice(0, 900)}`);
        return {
            ok: !!done && !aborted,
            runId, done, steps,
            aborted,
            error: aborted ? 'stopped by the user' : done ? null : `the browser agent exited without a result${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`,
            stderrTail: stderr.slice(-4000),
        };
    } catch (e) {
        return { ok: false, runId, steps, done, error: e.message, stderrTail: stderr.slice(-4000) };
    } finally {
        running--;
        if (killTimer) clearTimeout(killTimer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        relayTokens.delete(token);
        if (grant) egressProxy.revokeGrant(grant);
        if (container) container.remove({ force: true }).catch(() => {});
    }
}

module.exports = { init, available, run, shotPath, safeOwner };
