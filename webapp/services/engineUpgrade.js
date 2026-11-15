'use strict';
// llama.cpp engine upgrades from the console.
//
// scripts/engine-upgrade.sh does the work (build :next, test it against the
// current build, promote, keep a rollback tag). From here it runs in a helper
// container started from the webapp's own image, with the project directory,
// the models directory and the Docker socket mounted at their host paths, so
// it survives a webapp restart and behaves exactly like `sudo ./scripts/
// engine-upgrade.sh upgrade` on the host (update.sh runs it that way).
//
// Both paths write models/.modelserver/engine-upgrade/{status.json,upgrade.log}.
// This module reads them for the My Models page, relays the log to the Logs
// tab, and after a promotion moves each running llama.cpp instance onto the
// new image once nothing is using it (same container settings, new image; if
// the instance does not come up on the new build it is started again on the
// old one).

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = '/models/.modelserver/engine-upgrade';
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const LOG_FILE = path.join(STATE_DIR, 'upgrade.log');
const HELPER_NAME = 'modelserver-engine-upgrade';
const IMAGE = 'modelserver-llamacpp:latest';
const WATCH_MS = 20000;
const IDLE_TICKS_BEFORE_RELOAD = 2;      // ~40 s with nothing in flight
const RELOAD_READY_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_RUN_MS = 4 * 3600 * 1000;     // a build can sit on one step for 90 min
const VERSION_RE = /^(v?\d+(\.\d+){1,3}|b\d{3,6})$/;

function create({ docker, modelInstances, broadcast, streamContainerLogs, monitorContainerHealth, isBusy, hostModelsPath }) {
    const log = (message, level = 'info') => broadcast({ type: 'log', level, message: `[Engine upgrade] ${message}` });

    function readStatus() {
        try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (_) { return null; }
    }
    function logTail(lines = 40) {
        try {
            const text = fs.readFileSync(LOG_FILE, 'utf8');
            // Docker build output is long and noisy; keep our own lines and the
            // last few build lines.
            return text.split('\n').filter(Boolean).slice(-lines);
        } catch (_) { return []; }
    }

    async function helperRunning() {
        try {
            const info = await docker.getContainer(HELPER_NAME).inspect();
            return !!info.State.Running;
        } catch (_) { return false; }
    }

    async function selfInfo() {
        const me = await docker.getContainer(os.hostname()).inspect();
        const project = me.Config.Labels?.['com.docker.compose.project.working_dir'];
        if (!project) throw new Error('Cannot find the project directory (the webapp was not started by docker compose).');
        const models = await hostModelsPath();
        return { image: me.Image, project, models };
    }

    async function startHelper(args) {
        if (await helperRunning()) {
            const e = new Error('An engine upgrade is already running.'); e.status = 409; throw e;
        }
        try { await docker.getContainer(HELPER_NAME).remove({ force: true }); } catch (_) { /* none */ }
        const { image, project, models } = await selfInfo();
        const binds = [`${project}:${project}`, '/var/run/docker.sock:/var/run/docker.sock'];
        if (models && !models.startsWith(`${project}/`)) binds.push(`${models}:${models}`);
        const env = [`MODELSERVER_PROJECT_DIR=${project}`, `UPGRADE_MODELS_DIR=${models}`, 'HOME=/root'];
        for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'GIT_SSL_NO_VERIFY']) if (process.env[k]) env.push(`${k}=${process.env[k]}`);
        const c = await docker.createContainer({
            name: HELPER_NAME,
            Image: image,
            Entrypoint: ['bash', `${project}/scripts/engine-upgrade.sh`],
            Cmd: args,
            WorkingDir: project,
            Env: env,
            Labels: { 'modelserver.role': 'engine-upgrade' },
            HostConfig: { Binds: binds, AutoRemove: true },
        });
        await c.start();
    }

    // ---- moving running instances onto the new image ---------------------
    const idleTicks = new Map();
    const settled = new Set();     // `${promotedAt}|${name}`: done or given up
    let reloading = null;

    async function recreate(oldInfo, imageRef, name) {
        const aliases = [];
        for (const net of Object.values(oldInfo.NetworkSettings?.Networks || {})) {
            for (const a of net.Aliases || []) if (!/^[0-9a-f]{12,}$/.test(a) && !aliases.includes(a)) aliases.push(a);
        }
        const networks = Object.keys(oldInfo.NetworkSettings?.Networks || {});
        const cfg = oldInfo.Config;
        const c = await docker.createContainer({
            name: oldInfo.Name.replace(/^\//, ''),
            Image: imageRef,
            Env: cfg.Env, Cmd: cfg.Cmd, Entrypoint: cfg.Entrypoint, Labels: cfg.Labels,
            ExposedPorts: cfg.ExposedPorts, WorkingDir: cfg.WorkingDir, Healthcheck: cfg.Healthcheck,
            HostConfig: oldInfo.HostConfig,
            NetworkingConfig: networks.length ? { EndpointsConfig: { [networks[0]]: { Aliases: aliases } } } : undefined,
        });
        await c.start();
        return c;
    }

    async function removeContainer(id) {
        const c = docker.getContainer(id);
        try { await c.kill(); } catch (_) { /* not running */ }
        try { await c.remove({ force: true, v: false }); } catch (_) { /* gone */ }
    }

    function waitForRunning(name, containerId) {
        const deadline = Date.now() + RELOAD_READY_TIMEOUT_MS;
        return new Promise((resolve) => {
            const tick = async () => {
                const inst = modelInstances.get(name);
                if (!inst || inst.containerId !== containerId) return resolve(false);
                if (inst.status === 'running') return resolve(true);
                try {
                    const info = await docker.getContainer(containerId).inspect();
                    if (!info.State.Running) return resolve(false);
                } catch (_) { return resolve(false); }
                if (Date.now() > deadline) return resolve(false);
                setTimeout(tick, 5000);
            };
            setTimeout(tick, 5000);
        });
    }

    async function reloadInstance(name, status) {
        const entry = modelInstances.get(name);
        if (!entry) return;
        const saved = { ...entry };
        const oldInfo = await docker.getContainer(entry.containerId).inspect();
        log(`Moving ${name} to llama.cpp ${status.target || 'the new build'} (it was idle)`);
        await removeContainer(entry.containerId);
        let container;
        try {
            container = await recreate(oldInfo, IMAGE, name);
        } catch (e) {
            log(`${name}: could not start on the new build (${e.message}); starting it on the previous one`, 'warning');
            container = await recreate(oldInfo, oldInfo.Image, name);
            modelInstances.set(name, { ...saved, containerId: container.id, status: 'starting' });
            streamContainerLogs(container, name);
            monitorContainerHealth(container, name, saved.port);
            return;
        }
        modelInstances.set(name, { ...saved, containerId: container.id, status: 'starting' });
        broadcast({ type: 'status', modelName: name, status: 'starting', port: saved.port });
        streamContainerLogs(container, name);
        monitorContainerHealth(container, name, saved.port);
        const ok = await waitForRunning(name, container.id);
        if (ok) { log(`${name} is running on llama.cpp ${status.target || 'the new build'}`, 'success'); return; }

        log(`${name} did not come up on llama.cpp ${status.target || 'the new build'}; starting it on the previous build`, 'warning');
        await removeContainer(container.id);
        const back = await recreate(oldInfo, oldInfo.Image, name);
        modelInstances.set(name, { ...saved, containerId: back.id, status: 'starting' });
        streamContainerLogs(back, name);
        monitorContainerHealth(back, name, saved.port);
    }

    async function pendingReloads(status) {
        const out = [];
        if (!status || status.state !== 'succeeded' || !status.reloadInstances || !status.promotedAt || !status.imageId) return out;
        for (const [name, inst] of modelInstances.entries()) {
            if (inst.backend !== 'llamacpp' || inst.status !== 'running') continue;
            if (settled.has(`${status.promotedAt}|${name}`)) continue;
            try {
                const info = await docker.getContainer(inst.containerId).inspect();
                if (info.Image === status.imageId) continue;
                if (Date.parse(info.Created) > status.promotedAt * 1000) continue;   // started after the swap on purpose
                out.push(name);
            } catch (_) { /* container vanished: the health monitor handles it */ }
        }
        return out;
    }

    // ---- watcher ---------------------------------------------------------
    let logOffset = null;
    function relayLog() {
        let st;
        try { st = fs.statSync(LOG_FILE); } catch (_) { return; }
        if (logOffset === null || st.size < logOffset) { logOffset = logOffset === null ? st.size : 0; if (logOffset === st.size) return; }
        if (st.size === logOffset) return;
        const fd = fs.openSync(LOG_FILE, 'r');
        try {
            const len = Math.min(st.size - logOffset, 64 * 1024);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, logOffset);
            logOffset += len;
            // Only the script's own timestamped lines, not the docker build.
            for (const line of buf.toString('utf8').split('\n')) {
                if (/^\d\d:\d\d:\d\d /.test(line)) log(line.slice(9), /FAILED/.test(line) ? 'error' : 'info');
            }
        } finally { fs.closeSync(fd); }
    }

    async function tick() {
        relayLog();
        if (reloading) return;
        const status = readStatus();
        const names = await pendingReloads(status);
        for (const n of [...idleTicks.keys()]) if (!names.includes(n)) idleTicks.delete(n);
        for (const name of names) {
            const idle = !isBusy(name);
            const t = idle ? (idleTicks.get(name) || 0) + 1 : 0;
            idleTicks.set(name, t);
            if (t < IDLE_TICKS_BEFORE_RELOAD) continue;
            idleTicks.delete(name);
            settled.add(`${status.promotedAt}|${name}`);
            reloading = reloadInstance(name, status)
                .catch(e => log(`${name}: reload failed: ${e.message}`, 'error'))
                .finally(() => { reloading = null; });
            return;   // one at a time
        }
    }
    const timer = setInterval(() => { tick().catch(() => {}); }, WATCH_MS);
    timer.unref?.();

    // ---- routes ----------------------------------------------------------
    function registerRoutes(app, { requireAuth, callerIsAdmin }) {
        app.get('/api/engines/llamacpp/upgrade', requireAuth, async (req, res) => {
            const status = readStatus();
            const running = await helperRunning();
            let rollbackAvailable = false;
            if (status?.rollbackTag) {
                try { await docker.getImage(status.rollbackTag).inspect(); rollbackAvailable = true; } catch (_) { /* pruned */ }
            }
            const stale = status?.state === 'running' && !running && Date.now() - (status.updatedAt || 0) * 1000 > STALE_RUN_MS;
            res.json({
                status: status ? { ...status, state: stale ? 'interrupted' : status.state } : null,
                helperRunning: running,
                rollbackAvailable,
                pendingReloads: await pendingReloads(status),
                log: callerIsAdmin(req) ? logTail(30) : [],
            });
        });

        app.post('/api/engines/llamacpp/upgrade', requireAuth, async (req, res) => {
            if (!callerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
            const { version, force } = req.body || {};
            if (version && !VERSION_RE.test(String(version))) return res.status(400).json({ error: 'Invalid version' });
            const st = readStatus();
            if (st?.state === 'running' && Date.now() - (st.updatedAt || 0) * 1000 < STALE_RUN_MS && await helperRunning()) {
                return res.status(409).json({ error: 'An engine upgrade is already running.' });
            }
            const args = ['upgrade'];
            if (version) args.push('--version', String(version));
            if (force === true) args.push('--force');
            try {
                await startHelper(args);
                log(`Started${version ? ` (target ${version})` : ''}. It builds, tests the new build against the current one and installs it only if it passes.`);
                res.status(202).json({ message: 'Upgrade started. The current build keeps serving until the new one passes its tests.' });
            } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
        });

        app.post('/api/engines/llamacpp/rollback', requireAuth, async (req, res) => {
            if (!callerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
            try {
                await startHelper(['rollback']);
                log('Rolling back to the previous build');
                res.status(202).json({ message: 'Rolling back. Running models move to the previous build when idle.' });
            } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
        });
    }

    return { registerRoutes, readStatus, tick };
}

module.exports = { create };
