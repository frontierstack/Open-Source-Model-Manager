'use strict';
// Lifecycle of the inference engines beyond the two original ones (Strata and
// vLLM), plus the engine catalog, hardware profile and routing endpoints.
//
// Each instance is a Docker container in the same shape as llama.cpp/SGLang
// instances (a modelInstances entry, an alias on modelserver_default, bound to
// 127.0.0.1), so chat, /v1, health and speed tracking treat it the same way.

const crypto = require('crypto');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const axios = require('axios');
const router = require('./engineRouter');

const { strata: STRATA_VERSION, vllm: VLLM_VERSION } = require('./engineVersions.json');
const STRATA_SSE_IMAGE = 'modelserver-strata:latest';
const STRATA_PUBLISHED_IMAGE = `ghcr.io/niko1221/strata:${STRATA_VERSION}-cuda13`;
const VLLM_IMAGE = `vllm/vllm-openai:${VLLM_VERSION}`;
const HF_VOLUME = 'modelserver_hf_cache';
const STRATA_INTERNAL_DEFAULTS = { context: 262144, parallel: 1, kv: 'q4_0' };

const UPSTREAM = {
    llamacpp: 'ggml-org/llama.cpp', sglang: 'sgl-project/sglang', vllm: 'vllm-project/vllm', strata: 'Niko1221/Strata',
};
const BENCH_FILE = '/models/.modelserver/engine-benchmarks.json';
const GITHUB_CHECK_TTL_MS = 12 * 3600 * 1000;

function create(deps) {
    const {
        docker, modelInstances, broadcast, execPromise, allocatePort, instanceNetAlias, instanceNetworkingConfig,
        instanceHost, gpuDeviceRequests, gpuDevicesEnv, getNvidiaDeviceCgroupRules, getGpuCount, normalizeGpuDevices,
        removeStaleContainerByName, streamContainerLogs, monitorContainerHealth, startSystemMonitoring, stopSystemMonitoring,
        isValidModelName, isValidHfRepoId, getModelsVolumeBind,
    } = deps;

    // Strata refuses requests without a key, so each instance gets its own.
    // Kept out of the instance record so no route that serializes an instance
    // can hand it to a browser.
    const engineKeys = new Map();
    // URL parsing lowercases the hostname, and model names are mixed-case.
    const keyId = (host, port) => `${String(host).toLowerCase()}:${port}`;
    const keyFor = (host, port) => engineKeys.get(keyId(host, port));
    const setKey = (host, port, key) => { engineKeys.set(keyId(host, port), key); };

    axios.interceptors.request.use((config) => {
        if (engineKeys.size === 0 || !config.url) return config;
        try {
            const u = new URL(config.url);
            const key = keyFor(u.hostname, u.port);
            if (key) {
                config.headers = { ...(config.headers || {}), Authorization: `Bearer ${key}` };
                // Strata follows the OpenAI limit of four stop strings; our
                // default list is longer and its first four cover ChatML.
                if (config.data && Array.isArray(config.data.stop) && config.data.stop.length > 4) {
                    config.data = { ...config.data, stop: config.data.stop.slice(0, 4) };
                }
            }
        } catch (_) { /* relative URL: not an engine */ }
        return config;
    });

    // ---- Hardware ----------------------------------------------------------
    let hwCache = null;
    async function hardwareProfile() {
        if (hwCache && Date.now() - hwCache.at < 20000) return hwCache.value;
        let flags = new Set();
        try {
            const m = fsSync.readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:\s*(.*)$/m);
            if (m) flags = new Set(m[1].split(/\s+/));
        } catch (_) { /* unknown CPU: flags stay empty */ }
        const gpus = [];
        let driverMajor = null;
        try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=index,name,memory.total,memory.free,driver_version,pcie.link.width.current,compute_cap --format=csv,noheader,nounits');
            for (const line of stdout.trim().split('\n')) {
                const [index, name, total, free, driver, pcie, cap] = line.split(',').map(s => s.trim());
                if (!name) continue;
                driverMajor = parseInt(driver, 10) || driverMajor;
                gpus.push({
                    index: parseInt(index, 10), name, memoryTotalMiB: parseInt(total, 10), memoryFreeMiB: parseInt(free, 10),
                    pcieWidth: parseInt(pcie, 10) || null, computeCap: parseFloat(cap) || null,
                });
            }
        } catch (_) { /* no GPUs visible */ }
        let diskFreeGiB = null;
        try {
            const s = await fs.statfs('/models');
            diskFreeGiB = (s.bavail * s.bsize) / (1024 ** 3);
        } catch (_) { /* unknown */ }
        const value = {
            cpu: { avx2: flags.has('avx2'), avx: flags.has('avx'), sse42: flags.has('sse4_2'), cores: os.cpus().length, model: os.cpus()[0]?.model || '' },
            ramGiB: os.totalmem() / (1024 ** 3), driverMajor, diskFreeGiB, gpus,
        };
        hwCache = { at: Date.now(), value };
        return value;
    }

    // ---- Installed images and versions -------------------------------------
    async function imageInfo(ref) {
        try {
            const inspect = await docker.getImage(ref).inspect();
            return { present: true, id: inspect.Id, labels: inspect.Config?.Labels || {} };
        } catch (_) { return { present: false }; }
    }
    async function strataImage(hw) {
        const profile = hw || await hardwareProfile();
        if (!profile.cpu.avx2) return STRATA_SSE_IMAGE;
        return STRATA_PUBLISHED_IMAGE;
    }
    async function installedEngines() {
        const hw = await hardwareProfile();
        const refs = {
            llamacpp: 'modelserver-llamacpp:latest', sglang: 'modelserver-sglang:latest',
            vllm: VLLM_IMAGE, strata: await strataImage(hw),
        };
        const out = {};
        await Promise.all(Object.entries(refs).map(async ([id, ref]) => { out[id] = { ref, ...(await imageInfo(ref)) }; }));
        return out;
    }

    let upstreamCache = { at: 0, tags: {} };
    async function upstreamVersions() {
        if (Date.now() - upstreamCache.at < GITHUB_CHECK_TTL_MS) return upstreamCache.tags;
        const tags = {};
        await Promise.all(Object.entries(UPSTREAM).map(async ([id, repo]) => {
            try {
                const { data } = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, { timeout: 8000, headers: { 'User-Agent': 'modelserver' } });
                if (data && data.tag_name) tags[id] = data.tag_name;
            } catch (_) { /* offline or rate-limited: no update hint */ }
        }));
        upstreamCache = { at: Date.now(), tags: Object.keys(tags).length ? tags : upstreamCache.tags };
        return upstreamCache.tags;
    }
    function normalizeVersion(v) { return String(v || '').replace(/^v/, ''); }

    // ---- Measurements ------------------------------------------------------
    let benchmarks = null;
    function loadBenchmarks() {
        if (benchmarks) return benchmarks;
        try { benchmarks = JSON.parse(fsSync.readFileSync(BENCH_FILE, 'utf8')); } catch (_) { benchmarks = {}; }
        return benchmarks;
    }
    let benchWriteTimer = null;
    function noteSpeed(modelName, engine, tokensPerSecond) {
        if (!modelName || !engine || !(tokensPerSecond > 0)) return;
        const all = loadBenchmarks();
        const rec = all[modelName] || (all[modelName] = {});
        const prev = rec[engine];
        rec[engine] = {
            tokensPerSecond: prev ? prev.tokensPerSecond * 0.7 + tokensPerSecond * 0.3 : tokensPerSecond,
            samples: (prev ? prev.samples : 0) + 1, at: Date.now(),
        };
        if (benchWriteTimer) return;
        benchWriteTimer = setTimeout(() => {
            benchWriteTimer = null;
            const tmp = `${BENCH_FILE}.${process.pid}.tmp`;
            fs.writeFile(tmp, JSON.stringify(all)).then(() => fs.rename(tmp, BENCH_FILE)).catch(() => {});
        }, 15000);
        benchWriteTimer.unref?.();
    }

    async function planFor({ modelName, hfRepoId, format, weightBytes, files, size }) {
        const [hardware, images] = await Promise.all([hardwareProfile(), installedEngines()]);
        const name = modelName || hfRepoId;
        const model = router.describeModel({ name, hfRepoId, format, weightBytes, files });
        const installed = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.present]));
        const plan = router.rankEngines({ model, hardware, measured: loadBenchmarks()[name] || null, installed, size });
        return { model, hardware, plan };
    }

    // The card with the widest PCIe link runs the output head and draft layer,
    // which is what the decode loop waits on. Strata's own default (highest
    // index among equal cards) is the x2 slot on this host.
    function strataGpuRoles(gpus, devices) {
        const list = gpus.filter(g => !devices || devices.includes(g.index));
        if (list.length < 2) return null;
        const main = [...list].sort((a, b) => (b.pcieWidth || 0) - (a.pcieWidth || 0) || a.index - b.index)[0];
        // Inside the container the visible cards are renumbered from 0.
        const pos = (g) => (devices ? devices.indexOf(g.index) : g.index);
        return list.map(g => `${pos(g)}=${g === main ? 'main' : 'helper'}`).join(',');
    }

    async function registerInstance(modelName, container, { containerName, port, config, backend }) {
        modelInstances.set(modelName, {
            containerId: container.id, containerName, netHost: instanceNetAlias(containerName),
            port, internalPort: port, status: 'starting', modelName, config, backend,
        });
        startSystemMonitoring();
        broadcast({ type: 'status', modelName, status: 'starting', port });
        streamContainerLogs(container, modelName);
        monitorContainerHealth(container, modelName, port);
    }

    async function assertNameFree(name) {
        if (modelInstances.has(name)) {
            const existing = modelInstances.get(name);
            if (existing.status === 'running' || existing.status === 'starting' || existing.status === 'loading') {
                const e = new Error(`Instance for ${name} already running`); e.statusCode = 400; throw e;
            }
            modelInstances.delete(name);
            await removeStaleContainerByName(existing.containerName);
        }
    }

    async function createStrataInstance(opts = {}) {
        const name = opts.name || 'Qwen3.8-Flash-Next';
        if (!isValidModelName(name)) { const e = new Error('Invalid model name'); e.statusCode = 400; throw e; }
        await assertNameFree(name);
        const hw = await hardwareProfile();
        const image = await strataImage(hw);
        const info = await imageInfo(image);
        if (!info.present) {
            const e = new Error(hw.cpu.avx2
                ? `The Strata image is not installed. Install it from the Engines card (docker pull ${image}).`
                : 'This CPU has no AVX2, so Strata needs its SSE4.2 build. Run: docker build -t modelserver-strata:latest strata');
            e.statusCode = 409; throw e;
        }
        const detected = await getGpuCount();
        const gpuDevices = normalizeGpuDevices(opts.gpuDevices, detected);
        const sizeKey = String(opts.size || 'q2_0').toLowerCase();
        const size = router.FLASH_NEXT_SIZES[sizeKey];
        if (!size) { const e = new Error(`Unknown size: ${opts.size}`); e.statusCode = 400; throw e; }
        const context = Number(opts.context) || STRATA_INTERNAL_DEFAULTS.context;
        const parallel = Math.max(1, Math.min(Number(opts.parallel) || STRATA_INTERNAL_DEFAULTS.parallel, 8));
        const kv = opts.kv || STRATA_INTERNAL_DEFAULTS.kv;
        const family = size.family || 'qwen';
        const model = size.family === 'coder' ? 'IQ1_M' : size.label;
        const port = allocatePort();
        const containerName = `strata-${name}`;
        const apiKey = crypto.randomBytes(24).toString('hex');
        const roles = strataGpuRoles(hw.gpus, gpuDevices);
        const env = [
            `FAMILY=${family}`, `MODEL=${model}`, `CONTEXT=${context}`, `PARALLEL=${parallel}`, `KV=${kv}`, 'VISION=off',
            `API_KEY=${apiKey}`, `PORT=${port}`, 'STRATA_BIND=0.0.0.0', `STRATA_PORT=${port}`, 'TUNE=skip',
            ...gpuDevicesEnv(gpuDevices),
        ];
        if (roles) env.push(`GPU_ROLES=${roles}`);
        // Reuse GGUF files already in the models folder instead of downloading
        // them into the Strata volume.
        const localDir = `Qwen3.8-Flash-Next-${size.label.replace(/\s+/g, '-')}`;
        const localFiles = await fs.readdir(`/models/${localDir}`).catch(() => []);
        const haveLocal = localFiles.filter(f => f.endsWith('.gguf')).length >= 2;
        if (haveLocal) env.push(`MODEL_PATH=/models/${localDir}`);
        await removeStaleContainerByName(containerName);
        const container = await docker.createContainer({
            Image: image, name: containerName, Env: env,
            StopTimeout: 120,
            ExposedPorts: { [`${port}/tcp`]: {} },
            NetworkingConfig: instanceNetworkingConfig(containerName),
            HostConfig: {
                Runtime: 'nvidia',
                // Kept with the models so it follows them onto fast storage: Strata
                // reads its experts and lookup table from here on every token.
                Binds: [`${getModelsVolumeBind().split(':')[0]}/.strata-data:/data`, ...(haveLocal ? [getModelsVolumeBind()] : [])],
                PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${port}` }] },
                DeviceRequests: gpuDeviceRequests(gpuDevices),
                DeviceCgroupRules: getNvidiaDeviceCgroupRules(),
                NetworkMode: 'modelserver_default',
                ShmSize: 2 * 1024 * 1024 * 1024,
                Ulimits: [{ Name: 'memlock', Soft: -1, Hard: -1 }],
            },
        });
        await container.start();
        const config = { contextSize: context, parallelSlots: parallel, gpuDevices, strataSize: size.label, strataFamily: family, kv, compressMemory: false };
        setKey(instanceNetAlias(containerName), port, apiKey);
        await registerInstance(name, container, { containerName, port, config, backend: 'strata' });
        broadcast({ type: 'log', message: `[Strata] starting ${name} (${size.label}, ${context} context) on port ${port}. The first start downloads about ${size.downloadGiB} GB and prepares the model, which can take a long time.` });
        return { containerId: container.id, port, containerName, name };
    }

    function vllmToolParser(repoId) {
        const s = String(repoId).toLowerCase();
        if (/qwen3[._-]?[5-9]|qwen4/.test(s)) return 'qwen3_coder';
        if (/qwen/.test(s)) return 'hermes';
        if (/llama-?3/.test(s)) return 'llama3_json';
        if (/mistral|devstral/.test(s)) return 'mistral';
        if (/deepseek-?v3/.test(s)) return 'deepseek_v3';
        return null;
    }
    function vllmReasoningParser(repoId) {
        const s = String(repoId).toLowerCase();
        if (/qwen3|qwq/.test(s)) return 'qwen3';
        if (/deepseek-?r1/.test(s)) return 'deepseek_r1';
        return null;
    }

    async function createVllmInstance(opts = {}) {
        const { repoId } = opts;
        if (!isValidHfRepoId(repoId)) { const e = new Error('Invalid HuggingFace repo id (expected "owner/name")'); e.statusCode = 400; throw e; }
        await assertNameFree(repoId);
        const info = await imageInfo(VLLM_IMAGE);
        if (!info.present) { const e = new Error(`vLLM is not installed. Install it from the Engines card (docker pull ${VLLM_IMAGE}).`); e.statusCode = 409; throw e; }
        const detected = await getGpuCount();
        const gpuDevices = normalizeGpuDevices(opts.gpuDevices, detected);
        const visible = gpuDevices ? gpuDevices.length : detected;
        const maxModelLen = Number(opts.maxModelLen) || 16384;
        const memUtil = Math.min(0.97, Math.max(0.1, Number(opts.gpuMemoryUtilization) || 0.9));
        const tp = Math.max(1, Math.min(Number(opts.tensorParallelSize) || 1, visible));
        const toolParser = opts.toolCallParser ?? vllmToolParser(repoId);
        const reasoningParser = opts.reasoningParser ?? vllmReasoningParser(repoId);
        const port = allocatePort();
        const containerName = `vllm-hf-${repoId.replace(/\//g, '--')}`;
        const args = [
            '--model', repoId, '--host', '0.0.0.0', '--port', String(port), '--served-model-name', repoId,
            '--max-model-len', String(maxModelLen), '--gpu-memory-utilization', String(memUtil),
            '--tensor-parallel-size', String(tp), '--trust-remote-code',
        ];
        if (toolParser) args.push('--enable-auto-tool-choice', '--tool-call-parser', toolParser);
        if (reasoningParser) args.push('--reasoning-parser', reasoningParser);
        if (typeof opts.extraArgs === 'string' && opts.extraArgs.trim()) args.push(...opts.extraArgs.trim().split(/\s+/));
        await removeStaleContainerByName(containerName);
        const container = await docker.createContainer({
            Image: VLLM_IMAGE, name: containerName, Cmd: args,
            Env: [`VLLM_PORT=${port}`, `VLLM_MODEL=${repoId}`, `VLLM_MAX_LEN=${maxModelLen}`, `HF_TOKEN=${process.env.HUGGING_FACE_HUB_TOKEN || ''}`, ...gpuDevicesEnv(gpuDevices)],
            ExposedPorts: { [`${port}/tcp`]: {} },
            NetworkingConfig: instanceNetworkingConfig(containerName),
            HostConfig: {
                Runtime: 'nvidia',
                Binds: [`${HF_VOLUME}:/root/.cache/huggingface`],
                PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${port}` }] },
                DeviceRequests: gpuDeviceRequests(gpuDevices),
                DeviceCgroupRules: getNvidiaDeviceCgroupRules(),
                NetworkMode: 'modelserver_default',
                ShmSize: 8 * 1024 * 1024 * 1024,
            },
        });
        await container.start();
        const config = { contextSize: maxModelLen, maxModelLen, parallelSlots: 4, gpuDevices, hfRepoId: repoId, toolCallParser: toolParser, reasoningParser, compressMemory: false };
        await registerInstance(repoId, container, { containerName, port, config, backend: 'vllm' });
        broadcast({ type: 'log', message: `[vLLM] starting ${repoId} on port ${port}` });
        return { containerId: container.id, port, containerName, name: repoId };
    }

    // ---- Adoption after a webapp restart ------------------------------------
    function classifyContainer(name) {
        if (name.startsWith('strata-')) return { backend: 'strata', modelName: name.slice('strata-'.length) };
        if (name.startsWith('vllm-hf-')) return { backend: 'vllm', modelName: name.slice('vllm-hf-'.length).replace('--', '/') };
        return null;
    }
    function adoptConfig(backend, containerName, env) {
        const get = (k) => { const hit = env.find(e => e.startsWith(`${k}=`)); return hit ? hit.slice(k.length + 1) : null; };
        const devices = (get('MODELSERVER_GPU_DEVICES') || '').split(',').map(Number).filter(n => Number.isInteger(n));
        const gpuDevices = devices.length ? devices : null;
        if (backend === 'strata') {
            const port = parseInt(get('STRATA_PORT') || get('PORT') || '8080', 10);
            const key = get('API_KEY');
            if (key) setKey(instanceNetAlias(containerName), port, key);
            return { port, config: { contextSize: parseInt(get('CONTEXT'), 10) || 65536, parallelSlots: parseInt(get('PARALLEL'), 10) || 1, gpuDevices, strataSize: get('MODEL'), strataFamily: get('FAMILY'), kv: get('KV') } };
        }
        const port = parseInt(get('VLLM_PORT') || '8000', 10);
        const len = parseInt(get('VLLM_MAX_LEN'), 10) || 16384;
        return { port, config: { contextSize: len, maxModelLen: len, parallelSlots: 4, gpuDevices, hfRepoId: get('VLLM_MODEL') } };
    }

    function publicInstance(name, info) {
        const { containerId, containerName, netHost, port, internalPort, status, config, backend } = info;
        return { name, containerId, containerName, netHost, port, internalPort, status, config, backend };
    }

    // ---- Routes -------------------------------------------------------------
    function registerRoutes(app, { requireAuth, checkPermission, callerIsAdmin }) {
        const needs = (perm) => (req, res, next) => (
            checkPermission(req.apiKeyData, perm) ? next() : res.status(403).json({ error: `${perm} permission required` })
        );

        app.get('/api/engines', requireAuth, needs('models'), async (req, res) => {
            try {
                const [hardware, images, tags] = await Promise.all([hardwareProfile(), installedEngines(), upstreamVersions()]);
                const running = {};
                for (const [name, inst] of modelInstances.entries()) (running[inst.backend] = running[inst.backend] || []).push(name);
                const pinned = { llamacpp: images.llamacpp.labels?.['modelserver.engine.version'], sglang: images.sglang.labels?.['modelserver.engine.version'], vllm: VLLM_VERSION, strata: STRATA_VERSION };
                const engines = router.ENGINE_IDS.map((id) => {
                    const version = pinned[id] || null;
                    const latest = tags[id] || null;
                    return {
                        ...router.ENGINES[id], installed: images[id].present, image: images[id].ref, version, latest,
                        updateAvailable: !!(version && latest && !/rc|alpha|beta/i.test(latest) && normalizeVersion(version) !== normalizeVersion(latest)),
                        running: running[id] || [],
                    };
                });
                res.json({ engines, hardware, flashNextSizes: router.FLASH_NEXT_SIZES });
            } catch (error) { res.status(500).json({ error: error.message }); }
        });

        app.post('/api/engines/plan', requireAuth, needs('models'), async (req, res) => {
            try {
                const { modelName, hfRepoId, format, weightBytes, size } = req.body || {};
                if (!modelName && !hfRepoId) return res.status(400).json({ error: 'modelName or hfRepoId is required' });
                let files = [];
                if (modelName && isValidModelName(modelName)) {
                    files = await fs.readdir(`/models/${modelName}`, { recursive: true }).catch(() => []);
                }
                res.json(await planFor({ modelName, hfRepoId, format, weightBytes, files, size }));
            } catch (error) { res.status(500).json({ error: error.message }); }
        });

        app.get('/api/engines/instances', requireAuth, needs('instances'), (req, res) => {
            res.json([...modelInstances.entries()].filter(([, i]) => i.backend === 'strata' || i.backend === 'vllm').map(([n, i]) => publicInstance(n, i)));
        });

        app.delete('/api/engines/instances/:name', requireAuth, needs('instances'), async (req, res) => {
            const { name } = req.params;
            const inst = modelInstances.get(name);
            if (!inst) return res.status(404).json({ error: 'Instance not found' });
            if (inst.backend !== 'strata' && inst.backend !== 'vllm') return res.status(400).json({ error: 'Use the route for this engine' });
            try {
                const c = docker.getContainer(inst.containerId);
                await c.stop({ t: 120 }).catch(() => {});
                await c.remove({ force: true, v: false }).catch(() => {});
                modelInstances.delete(name);
                if (modelInstances.size === 0) stopSystemMonitoring();
                broadcast({ type: 'status', modelName: name, status: 'stopped' });
                res.json({ message: `Stopped ${name}` });
            } catch (error) { res.status(500).json({ error: error.message }); }
        });

        app.post('/api/engines/strata/load', requireAuth, needs('models'), async (req, res) => {
            try {
                const result = await createStrataInstance(req.body || {});
                res.json({ message: 'Instance created', backend: 'strata', ...result });
            } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
        });

        app.post('/api/engines/vllm/load', requireAuth, needs('models'), async (req, res) => {
            try {
                const result = await createVllmInstance(req.body || {});
                res.json({ message: 'Instance created', backend: 'vllm', ...result });
            } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
        });

        // Pulls a published engine image. Build-from-source engines (llama.cpp,
        // SGLang, the SSE4.2 Strata) stay in the build scripts.
        app.post('/api/engines/:id/install', requireAuth, async (req, res) => {
            if (!callerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
            const hw = await hardwareProfile();
            const ref = req.params.id === 'vllm' ? VLLM_IMAGE : (req.params.id === 'strata' && hw.cpu.avx2 ? STRATA_PUBLISHED_IMAGE : null);
            if (!ref) return res.status(400).json({ error: 'This engine is installed by the build scripts on this server.' });
            res.status(202).json({ message: `Pulling ${ref}` });
            docker.pull(ref, (err, stream) => {
                if (err) { broadcast({ type: 'log', level: 'error', message: `[Engines] pull failed: ${err.message}` }); return; }
                docker.modem.followProgress(stream, (e) => {
                    broadcast({ type: 'log', level: e ? 'error' : 'success', message: e ? `[Engines] pull failed: ${e.message}` : `[Engines] ${ref} installed` });
                });
            });
        });
    }

    return { hardwareProfile, planFor, noteSpeed, classifyContainer, adoptConfig, registerRoutes, createStrataInstance, createVllmInstance, publicInstance };
}

module.exports = { create };
