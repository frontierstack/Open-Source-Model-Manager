'use strict';
// Engine upgrades from the console: llama.cpp, SGLang, Strata and vLLM.
//
// scripts/engine-upgrade.sh does the work (get the new version, test it
// against the current one, promote, keep a rollback point). From here it runs
// in a helper container started from the webapp's own image, with the project
// directory, the models directory and the Docker socket mounted at their host
// paths, so it survives a webapp restart and behaves exactly like
// `sudo ./scripts/engine-upgrade.sh --engine <id> upgrade` on the host.
//
// Both paths write models/.modelserver/engine-upgrade/status[-<id>].json and
// upgrade[-<id>].log. This module reads them for the Engines card (with a
// progress figure worked out from the stage and the log), relays the log to
// the Logs tab, and:
//   - llama.cpp / SGLang: after a promotion moves each running instance onto
//     the new image once nothing is using it (same container settings; back to
//     the old image if it does not come up);
//   - Strata: its test needs every GPU, so an upgrade started here unloads the
//     loaded Strata model first and loads it again afterwards with the same
//     settings (on the new version if it was installed, else the old one).

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = '/models/.modelserver/engine-upgrade';
const ENGINES = ['llamacpp', 'sglang', 'strata', 'vllm'];
const LABEL = { llamacpp: 'llama.cpp', sglang: 'SGLang', strata: 'Strata', vllm: 'vLLM' };
const BACKEND_IMAGE = { llamacpp: 'modelserver-llamacpp:latest', sglang: 'modelserver-sglang:latest' };
// How long each stage takes, roughly, as a share of the whole upgrade.
const STAGE_WEIGHTS = {
    llamacpp: [0.88, 0.05, 0.05, 0.02],
    sglang: [0.85, 0.12, 0.03],
    strata: [0.15, 0.42, 0.40, 0.03],
    vllm: [0.85, 0.12, 0.03],
};
const HELPER_NAME = 'modelserver-engine-upgrade';
const RESTORE_FILE = path.join(STATE_DIR, 'strata-restore.json');
const STRATA_TEST_ENV = path.join(STATE_DIR, 'strata-test.env');
const WATCH_MS = 20000;
const IDLE_TICKS_BEFORE_RELOAD = 2;      // ~40 s with nothing in flight
const RELOAD_READY_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_RUN_MS = 4 * 3600 * 1000;     // a build can sit on one step for 90 min
const VERSION_RE = /^(v?\d+(\.\d+){1,3}(rc\d+)?|b\d{3,6})$/;

const statusFile = (id) => path.join(STATE_DIR, id === 'llamacpp' ? 'status.json' : `status-${id}.json`);
const logFile = (id) => path.join(STATE_DIR, id === 'llamacpp' ? 'upgrade.log' : `upgrade-${id}.log`);

/**
 * Progress through the current stage, from the log: CMake's "[ 55%]" while
 * llama.cpp compiles, BuildKit's "[ 3/12]" steps while an image builds, and
 * finished layers / all layers while an image downloads. null = no figure.
 */
function stageProgress(stageName, lines) {
    const text = lines.join('\n');
    if (/^Build/.test(stageName)) {
        const pct = [...text.matchAll(/\[\s*(\d{1,3})%\]/g)].pop();
        if (pct) return Math.min(1, Number(pct[1]) / 100);
        const step = [...text.matchAll(/#\d+ \[(?:[\w-]+ )?\s*(\d+)\/(\d+)\]/g)].pop();
        if (step) return Math.min(1, (Number(step[1]) - 1) / Number(step[2]));
        return null;
    }
    if (/^Download/.test(stageName)) {
        const seen = new Set(), done = new Set();
        for (const m of text.matchAll(/^([0-9a-f]{12}): (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/gm)) {
            seen.add(m[1]);
            if (m[2] === 'Pull complete' || m[2] === 'Already exists') done.add(m[1]);
        }
        if (/Status: (Downloaded newer image|Image is up to date)/.test(text)) return 1;
        return seen.size ? done.size / seen.size : null;
    }
    return null;
}
function overallProgress(engine, status, lines) {
    const stages = Array.isArray(status?.stages) ? status.stages : [];
    const i = Number.isInteger(status?.stageIndex) ? status.stageIndex : -1;
    if (!stages.length || i < 0) return null;
    if (status.state === 'succeeded') return { value: 1, stage: null, stageProgress: 1 };
    const w = STAGE_WEIGHTS[engine] && STAGE_WEIGHTS[engine].length === stages.length ? STAGE_WEIGHTS[engine] : stages.map(() => 1 / stages.length);
    const before = w.slice(0, Math.min(i, w.length)).reduce((a, b) => a + b, 0);
    const inner = i < stages.length ? stageProgress(stages[i], lines) : 1;
    return { value: Math.min(1, before + (inner == null ? 0 : inner) * (w[i] || 0)), stage: stages[i] || null, stageProgress: inner };
}

function create({ docker, modelInstances, broadcast, streamContainerLogs, monitorContainerHealth, isBusy, hostModelsPath, engineManager }) {
    const log = (message, level = 'info') => broadcast({ type: 'log', level, message: `[Engine upgrade] ${message}` });

    function readStatus(id) {
        try { return JSON.parse(fs.readFileSync(statusFile(id), 'utf8')); } catch (_) { return null; }
    }
    function readLog(id) {
        try { return fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
    }
    // The script's own timestamped lines plus the last few build/pull lines.
    function logTail(id, lines = 40) {
        const all = readLog(id);
        const ours = all.filter(l => /^\d\d:\d\d:\d\d /.test(l));
        const tail = all.slice(-8).filter(l => !/^\d\d:\d\d:\d\d /.test(l));
        return [...ours.slice(-lines), ...tail];
    }

    async function helperInfo() {
        try {
            const info = await docker.getContainer(HELPER_NAME).inspect();
            if (!info.State.Running) return null;
            const args = info.Config.Cmd || [];
            const i = args.indexOf('--engine');
            return { engine: i >= 0 ? args[i + 1] : 'llamacpp' };
        } catch (_) { return null; }
    }

    async function selfInfo() {
        const me = await docker.getContainer(os.hostname()).inspect();
        const project = me.Config.Labels?.['com.docker.compose.project.working_dir'];
        if (!project) throw new Error('Cannot find the project directory (the webapp was not started by docker compose).');
        const models = await hostModelsPath();
        return { image: me.Image, project, models };
    }

    async function startHelper(args) {
        if (await helperInfo()) {
            const e = new Error('An engine upgrade is already running.'); e.status = 409; throw e;
        }
        try { await docker.getContainer(HELPER_NAME).remove({ force: true }); } catch (_) { /* none */ }
        const { image, project, models } = await selfInfo();
        const binds = [`${project}:${project}`, '/var/run/docker.sock:/var/run/docker.sock'];
        if (models && !models.startsWith(`${project}/`)) binds.push(`${models}:${models}`);
        const env = [`MODELSERVER_PROJECT_DIR=${project}`, `UPGRADE_MODELS_DIR=${models}`, 'HOME=/root'];
        for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'GIT_SSL_NO_VERIFY', 'TZ']) if (process.env[k]) env.push(`${k}=${process.env[k]}`);
        const c = await docker.createContainer({
            name: HELPER_NAME,
            Image: image,
            Entrypoint: ['bash', `${project}/scripts/engine-upgrade.sh`],
            Cmd: args,
            WorkingDir: project,
            Env: env,
            Labels: { 'modelserver.role': 'engine-upgrade' },
            // The test containers reach the host's GPUs through the Docker socket;
            // the helper itself needs no GPU.
            HostConfig: { Binds: binds, AutoRemove: true },
        });
        await c.start();
    }

    // ---- Strata: unload before the test, load again afterwards -------------
    function strataInstances() {
        return [...modelInstances.entries()].filter(([, i]) => i.backend === 'strata');
    }
    async function unloadStrataForUpgrade() {
        const list = strataInstances();
        if (!list.length) return [];
        const restore = [];
        let envWritten = false;
        for (const [name, inst] of list) {
            const c = inst.config || {};
            if (!envWritten) {
                try {
                    const info = await docker.getContainer(inst.containerId).inspect();
                    const keep = (info.Config.Env || []).filter(e => /^(FAMILY|MODEL|MODEL_PATH|CONTEXT|PARALLEL|KV|VISION|TUNE|STRATA_SET|GPU_ROLES|GPU|GPUS)=/.test(e));
                    fs.mkdirSync(STATE_DIR, { recursive: true });
                    fs.writeFileSync(STRATA_TEST_ENV, keep.join('\n') + '\n');
                    envWritten = true;
                } catch (_) { /* the script falls back to defaults */ }
            }
            restore.push({
                name, size: String(c.strataSize || 'q2_0').toLowerCase().replace(/\s+/g, '_'),
                context: c.contextSize, parallel: c.parallelSlots, kv: c.kv, gpuDevices: c.gpuDevices ?? null,
                contextShift: c.contextShift !== false, compressMemory: c.compressMemory === true,
                engineSettings: Object.fromEntries((c.engineSettings || []).map(x => String(x).split('=')).filter(p => p.length === 2)),
            });
        }
        fs.writeFileSync(RESTORE_FILE, JSON.stringify({ at: Date.now(), instances: restore }, null, 2));
        for (const [name] of list) {
            log(`Unloading ${name} for the Strata upgrade test (it is loaded again when the upgrade ends)`);
            await engineManager.stopInstance(name);
        }
        return restore.map(r => r.name);
    }
    let restoring = false;
    async function restoreStrata() {
        if (restoring || !fs.existsSync(RESTORE_FILE)) return;
        const st = readStatus('strata');
        if (st?.state === 'running' || await helperInfo()) return;
        restoring = true;
        try {
            const data = JSON.parse(fs.readFileSync(RESTORE_FILE, 'utf8'));
            fs.unlinkSync(RESTORE_FILE);
            for (const opts of data.instances || []) {
                if (modelInstances.has(opts.name)) continue;
                try {
                    await engineManager.createStrataInstance(opts);
                    log(`Loading ${opts.name} again on Strata ${engineManager.engineVersion('strata')}`, 'success');
                } catch (e) { log(`Could not load ${opts.name} again: ${e.message}. Load it from My Models.`, 'error'); }
            }
        } catch (e) { log(`Strata reload after the upgrade failed: ${e.message}`, 'error'); }
        finally { restoring = false; }
    }

    // ---- llama.cpp / SGLang: move running instances onto the new image ----
    const idleTicks = new Map();
    const settled = new Set();     // `${engine}|${promotedAt}|${name}`: done or given up
    let reloading = null;

    async function recreate(oldInfo, imageRef) {
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

    async function reloadInstance(engine, name, status) {
        const entry = modelInstances.get(name);
        if (!entry) return;
        const saved = { ...entry };
        const oldInfo = await docker.getContainer(entry.containerId).inspect();
        const what = `${LABEL[engine]} ${status.target || 'the new build'}`;
        log(`Moving ${name} to ${what} (it was idle)`);
        await removeContainer(entry.containerId);
        let container;
        try {
            container = await recreate(oldInfo, BACKEND_IMAGE[engine]);
        } catch (e) {
            log(`${name}: could not start on the new build (${e.message}); starting it on the previous one`, 'warning');
            container = await recreate(oldInfo, oldInfo.Image);
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
        if (ok) { log(`${name} is running on ${what}`, 'success'); return; }

        log(`${name} did not come up on ${what}; starting it on the previous build`, 'warning');
        await removeContainer(container.id);
        const back = await recreate(oldInfo, oldInfo.Image);
        modelInstances.set(name, { ...saved, containerId: back.id, status: 'starting' });
        streamContainerLogs(back, name);
        monitorContainerHealth(back, name, saved.port);
    }

    async function pendingReloads(engine, status) {
        const out = [];
        if (!BACKEND_IMAGE[engine]) return out;
        if (!status || status.state !== 'succeeded' || !status.reloadInstances || !status.promotedAt || !status.imageId) return out;
        for (const [name, inst] of modelInstances.entries()) {
            if (inst.backend !== engine || inst.status !== 'running') continue;
            if (settled.has(`${engine}|${status.promotedAt}|${name}`)) continue;
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
    const logOffsets = {};
    function relayLog(id) {
        const file = logFile(id);
        let st;
        try { st = fs.statSync(file); } catch (_) { return; }
        let off = logOffsets[id];
        if (off === undefined) { logOffsets[id] = st.size; return; }
        if (st.size < off) off = 0;
        if (st.size === off) return;
        const fd = fs.openSync(file, 'r');
        try {
            const len = Math.min(st.size - off, 64 * 1024);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, off);
            logOffsets[id] = off + len;
            // Only the script's own timestamped lines, not the build / pull output.
            for (const line of buf.toString('utf8').split('\n')) {
                if (/^\d\d:\d\d:\d\d /.test(line)) log(`${LABEL[id]}: ${line.slice(9)}`, /FAILED/.test(line) ? 'error' : 'info');
            }
        } finally { fs.closeSync(fd); }
    }

    async function tick() {
        for (const id of ENGINES) relayLog(id);
        await restoreStrata();
        if (reloading) return;
        for (const engine of ['llamacpp', 'sglang']) {
            const status = readStatus(engine);
            const names = await pendingReloads(engine, status);
            for (const k of [...idleTicks.keys()]) if (k.startsWith(`${engine}|`) && !names.includes(k.slice(engine.length + 1))) idleTicks.delete(k);
            for (const name of names) {
                const key = `${engine}|${name}`;
                const t = !isBusy(name) ? (idleTicks.get(key) || 0) + 1 : 0;
                idleTicks.set(key, t);
                if (t < IDLE_TICKS_BEFORE_RELOAD) continue;
                idleTicks.delete(key);
                settled.add(`${engine}|${status.promotedAt}|${name}`);
                reloading = reloadInstance(engine, name, status)
                    .catch(e => log(`${name}: reload failed: ${e.message}`, 'error'))
                    .finally(() => { reloading = null; });
                return;   // one at a time
            }
        }
    }
    const timer = setInterval(() => { tick().catch(() => {}); }, WATCH_MS);
    timer.unref?.();

    // ---- state for the console ------------------------------------------
    async function rollbackAvailable(engine, status) {
        if (!status || status.state !== 'succeeded' || status.rolledBack) return false;
        if (engine === 'strata' || engine === 'vllm') return !!status.rollbackVersion;
        if (!status.rollbackTag) return false;
        try { await docker.getImage(status.rollbackTag).inspect(); return true; } catch (_) { return false; }
    }
    async function engineState(engine, { admin, helper }) {
        const status = readStatus(engine);
        const running = !!helper && helper.engine === engine;
        const stale = status?.state === 'running' && !running && Date.now() - (status.updatedAt || 0) * 1000 > (helper ? 0 : STALE_RUN_MS);
        const state = status ? (stale && !helper ? 'interrupted' : status.state) : null;
        const lines = readLog(engine);
        return {
            status: status ? { ...status, state } : null,
            running: running || state === 'running',
            progress: status && (state === 'running' || state === 'succeeded') ? overallProgress(engine, status, lines.slice(-400)) : null,
            rollbackAvailable: await rollbackAvailable(engine, status),
            pendingReloads: await pendingReloads(engine, status),
            restorePending: engine === 'strata' && fs.existsSync(RESTORE_FILE),
            log: admin ? logTail(engine, 30) : [],
        };
    }

    // ---- routes ----------------------------------------------------------
    function registerRoutes(app, { requireAuth, callerIsAdmin }) {
        app.get('/api/engines/upgrades', requireAuth, async (req, res) => {
            const helper = await helperInfo();
            const admin = callerIsAdmin(req);
            const out = {};
            for (const id of ENGINES) out[id] = await engineState(id, { admin, helper });
            res.json({ engines: out, busy: helper ? helper.engine : null });
        });

        // Kept for older pages and scripts.
        app.get('/api/engines/llamacpp/upgrade', requireAuth, async (req, res) => {
            const helper = await helperInfo();
            const s = await engineState('llamacpp', { admin: callerIsAdmin(req), helper });
            res.json({ ...s, helperRunning: !!helper });
        });

        app.post('/api/engines/:id/upgrade', requireAuth, async (req, res) => {
            const id = req.params.id;
            if (!ENGINES.includes(id)) return res.status(404).json({ error: 'Unknown engine' });
            if (!callerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
            const { version, force, unload } = req.body || {};
            if (version && !VERSION_RE.test(String(version))) return res.status(400).json({ error: 'Invalid version' });
            if (await helperInfo()) return res.status(409).json({ error: 'An engine upgrade is already running. One at a time: they share the GPUs.' });
            let unloaded = [];
            if (id === 'strata') {
                const loaded = strataInstances().map(([n]) => n);
                if (loaded.length && unload !== true) {
                    return res.status(409).json({ needsUnload: true, instances: loaded, error: `The Strata test runs the real model on every GPU, so ${loaded.join(', ')} must be unloaded first. It is loaded again when the upgrade ends.` });
                }
                try { unloaded = await unloadStrataForUpgrade(); } catch (e) { return res.status(500).json({ error: `Could not unload Strata: ${e.message}` }); }
            }
            const args = ['--engine', id, 'upgrade'];
            if (version) args.push('--version', String(version));
            if (force === true) args.push('--force');
            try {
                await startHelper(args);
                log(`${LABEL[id]}: started${version ? ` (target ${version})` : ''}. The new version is installed only if it passes its test.`);
                res.status(202).json({ message: `${LABEL[id]} upgrade started.${unloaded.length ? ` ${unloaded.join(', ')} was unloaded and is loaded again afterwards.` : ''} The current version stays in place until the new one passes.` });
            } catch (e) {
                if (unloaded.length) restoreStrata().catch(() => {});
                res.status(e.status || 500).json({ error: e.message });
            }
        });

        app.post('/api/engines/:id/rollback', requireAuth, async (req, res) => {
            const id = req.params.id;
            if (!ENGINES.includes(id)) return res.status(404).json({ error: 'Unknown engine' });
            if (!callerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
            if (await helperInfo()) return res.status(409).json({ error: 'An engine upgrade is running; try again when it finishes.' });
            try {
                // A loaded Strata model keeps its container (and so its version)
                // until it is loaded again: reload it on the rolled-back version.
                if (id === 'strata' && strataInstances().length) await unloadStrataForUpgrade();
                await startHelper(['--engine', id, 'rollback']);
                log(`${LABEL[id]}: rolling back to the previous version`);
                res.status(202).json({ message: `Rolling back ${LABEL[id]}.${BACKEND_IMAGE[id] ? ' Running models move to the previous build when idle.' : ''}` });
            } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
        });
    }

    return { registerRoutes, readStatus, tick };
}

module.exports = { create, stageProgress, overallProgress };
