// Imagegen service activator — manages the optional GPU image-generation
// container alongside the LLM model containers. Parallel to (not exclusive
// with) the llamacpp / vLLM model loaders: a user can have llamacpp +
// imagegen running, or vllm + imagegen, or any combination.
//
// Lifecycle:
//   1. start()  — build modelserver-imagegen:latest if missing, remove
//                 any stale container of the same name, create + start a
//                 new one with GPU access on modelserver_default, stream
//                 logs to the Logs tab via broadcast(), wait for /health.
//   2. stop()   — stop + remove the container.
//   3. getStatus() — current state for the UI (status string, error, etc).
//
// Container naming: `modelserver-imagegen` (no compose suffix). The
// docker-compose `imagegen` service in the same compose file uses the
// `imagegen` profile and would name the container `modelserver-imagegen-1`
// — kept as an escape hatch but not the primary path.
//
// Skill side-effect: when the service comes up, the `generate_image` skill
// is auto-flipped to enabled=true (so the chat catalog includes it the
// next turn). On stop(), it stays enabled — a friendly error from the
// skill is more discoverable than the tool silently disappearing.

const path = require('path');
const fs = require('fs').promises;
const tar = require('tar-fs');
const Docker = require('dockerode');
const http = require('http');

const docker = new Docker();

const IMAGE_NAME = 'modelserver-imagegen:latest';
const CONTAINER_NAME = 'modelserver-imagegen';
const BUILD_CONTEXT = '/usr/src/app/imagegen';
const VOLUME_NAME = (process.env.COMPOSE_PROJECT_NAME || 'modelserver') + '_imagegen_cache';
const NETWORK_NAME = (process.env.COMPOSE_PROJECT_NAME || 'modelserver') + '_default';
const HEALTH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const state = {
    // 'stopped' | 'building' | 'starting' | 'running' | 'error'
    status: 'stopped',
    containerId: null,
    containerName: CONTAINER_NAME,
    startedAt: null,
    error: null,
    // Whether the image is present locally — exposed so the UI can show
    // "first start will download/build (~10-15 min)" warnings appropriately.
    imageBuilt: null,
};

// Wired in from server.js so logs reach the Logs tab without a circular
// import. Both `broadcast` and `enableSkill` are optional — missing impls
// just no-op.
const hooks = {
    broadcast: null,
    enableSkill: null,
};
function init(opts) {
    if (opts && typeof opts.broadcast === 'function') hooks.broadcast = opts.broadcast;
    if (opts && typeof opts.enableSkill === 'function') hooks.enableSkill = opts.enableSkill;
}

function emitLog(message, level = 'info') {
    if (typeof hooks.broadcast !== 'function') return;
    try {
        hooks.broadcast({ type: 'log', message: `[imagegen] ${message}`, level });
    } catch (_) { /* broadcast is best-effort */ }
}

function getStatus() {
    return { ...state };
}

// ---------------------------------------------------------------------------
// Image / container helpers
// ---------------------------------------------------------------------------

async function imageExists() {
    try {
        await docker.getImage(IMAGE_NAME).inspect();
        state.imageBuilt = true;
        return true;
    } catch (_) {
        state.imageBuilt = false;
        return false;
    }
}

async function existingContainer() {
    try {
        const c = docker.getContainer(CONTAINER_NAME);
        const info = await c.inspect();
        return { container: c, info };
    } catch (_) {
        return null;
    }
}

async function ensureVolume() {
    try {
        await docker.getVolume(VOLUME_NAME).inspect();
    } catch (_) {
        try {
            await docker.createVolume({ Name: VOLUME_NAME });
        } catch (e) {
            // Race: another caller created it between our inspect+create.
            if (!/already exists/i.test(e.message)) throw e;
        }
    }
}

async function ensureNetworkAttached(container) {
    // The imagegen container must join modelserver_default so the egress
    // proxy resolves the `imagegen` hostname for sandboxed skill calls.
    // dockerode's createContainer accepts NetworkMode, but with the named
    // alias we need NetworkingConfig.EndpointsConfig — set on create below.
    return;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildImage() {
    state.status = 'building';
    state.error = null;
    emitLog('Building modelserver-imagegen:latest (first start; this can take 10-15 min on a typical GPU box)…');

    // Confirm build context is mounted. If the docker-compose volume
    // wasn't applied (older deploy), surface a clear error rather than
    // a confusing tar error.
    try {
        await fs.access(path.join(BUILD_CONTEXT, 'Dockerfile'));
    } catch (_) {
        const msg = `Build context missing at ${BUILD_CONTEXT}. ` +
            `Make sure docker-compose.yml mounts ./imagegen into the webapp ` +
            `container, then restart the webapp service.`;
        emitLog(msg, 'error');
        throw new Error(msg);
    }

    const ctx = tar.pack(BUILD_CONTEXT);
    const stream = await new Promise((resolve, reject) => {
        docker.buildImage(ctx, { t: IMAGE_NAME, dockerfile: 'Dockerfile' }, (err, s) => {
            if (err) return reject(err);
            resolve(s);
        });
    });

    await new Promise((resolve, reject) => {
        docker.modem.followProgress(
            stream,
            (err, output) => {
                if (err) return reject(err);
                // Final event(s) sometimes carry the build error inside
                // `errorDetail` rather than failing the stream — surface it.
                const failure = output.find(e => e && e.error);
                if (failure) return reject(new Error(failure.error));
                resolve(output);
            },
            (event) => {
                if (event && event.stream) {
                    const line = event.stream.replace(/\r?\n$/, '');
                    if (line.trim()) emitLog(line);
                } else if (event && event.error) {
                    emitLog(event.error, 'error');
                } else if (event && event.status) {
                    // Layer pull progress — keep noise down (one line per id).
                    emitLog(`${event.status}${event.id ? ' ' + event.id : ''}`);
                }
            },
        );
    });

    state.imageBuilt = true;
    emitLog('Image build complete.', 'success');
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

async function streamLogs(container) {
    // Mirror the streamContainerLogs helper in server.js (which is keyed
    // on modelInstances). We don't reuse it directly because the imagegen
    // container isn't in the modelInstances Map — but the broadcast event
    // shape and `[imagegen] ...` prefix match so the Logs tab renders it
    // identically to model logs.
    try {
        const logStream = await container.logs({
            follow: true, stdout: true, stderr: true, timestamps: true,
        });
        logStream.on('data', (chunk) => {
            try {
                const lines = chunk.toString('utf8').split('\n').filter(l => l.trim());
                for (const raw of lines) {
                    let line = raw.replace(/[\x00-\x08]/g, '').trim();
                    line = line.replace(/^.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/, '');
                    if (!line) continue;
                    const isError = /error|failed|fatal|exception|cannot|unable|oom|killed/i.test(line);
                    const isSuccess = /ready|started|listening|loaded|complete|running/i.test(line) && !isError;
                    emitLog(line, isError ? 'error' : isSuccess ? 'success' : 'info');
                }
            } catch (_) { /* line-by-line; skip junk */ }
        });
        logStream.on('error', () => { /* container gone */ });
    } catch (e) {
        emitLog(`log stream attach failed: ${e.message}`, 'error');
    }
}

function waitHealthy(timeoutMs = HEALTH_TIMEOUT_MS) {
    // Hits the imagegen container's /health endpoint via its Docker
    // network alias. The webapp is on the same modelserver_default
    // network so DNS resolves directly. Polls every 1s.
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (Date.now() > deadline) {
                resolve(false);
                return;
            }
            const req = http.request({
                host: 'imagegen', port: 5000, path: '/health',
                method: 'GET', timeout: 2000,
            }, (res) => {
                if (res.statusCode === 200) {
                    res.resume();
                    resolve(true);
                } else {
                    res.resume();
                    setTimeout(tick, 1000);
                }
            });
            req.on('error', () => setTimeout(tick, 1000));
            req.on('timeout', () => { req.destroy(); setTimeout(tick, 1000); });
            req.end();
        };
        tick();
    });
}

async function enableGenerateImageSkill() {
    if (typeof hooks.enableSkill !== 'function') return;
    try {
        await hooks.enableSkill('generate_image');
    } catch (e) {
        emitLog(`skill auto-enable failed (non-fatal): ${e.message}`, 'warning');
    }
}

async function start() {
    if (state.status === 'building' || state.status === 'starting' || state.status === 'running') {
        return getStatus();
    }
    state.error = null;

    try {
        if (!(await imageExists())) {
            await buildImage();
        }

        const stale = await existingContainer();
        if (stale) {
            emitLog(`removing stale container ${stale.info.Id.slice(0, 12)}`);
            try { await stale.container.stop({ t: 5 }); } catch (_) {}
            try { await stale.container.remove({ force: true }); } catch (_) {}
        }

        await ensureVolume();

        state.status = 'starting';
        emitLog('Creating container on ' + NETWORK_NAME);

        const container = await docker.createContainer({
            Image: IMAGE_NAME,
            name: CONTAINER_NAME,
            Tty: false,
            ExposedPorts: { '5000/tcp': {} },
            Env: [
                `IMAGEGEN_MODEL=${process.env.IMAGEGEN_MODEL || 'stabilityai/sdxl-turbo'}`,
                `HUGGING_FACE_HUB_TOKEN=${process.env.HUGGING_FACE_HUB_TOKEN || ''}`,
                'NVIDIA_VISIBLE_DEVICES=all',
                'NVIDIA_DRIVER_CAPABILITIES=compute,utility',
                'PYTHONUNBUFFERED=1',
            ],
            HostConfig: {
                NetworkMode: NETWORK_NAME,
                Mounts: [{
                    Type: 'volume',
                    Source: VOLUME_NAME,
                    Target: '/root/.cache/huggingface',
                }],
                DeviceRequests: [{
                    Driver: 'nvidia',
                    Count: -1,
                    Capabilities: [['gpu']],
                }],
                RestartPolicy: { Name: 'unless-stopped' },
            },
            // Aliases so the egress proxy + skill can resolve `imagegen`
            // directly. Without this, the dockerode-created container is
            // only addressable by full container name on the network.
            NetworkingConfig: {
                EndpointsConfig: {
                    [NETWORK_NAME]: {
                        Aliases: ['imagegen'],
                    },
                },
            },
        });

        await container.start();
        state.containerId = container.id;
        state.startedAt = Date.now();
        streamLogs(container);

        emitLog('container started; waiting for /health…');
        const healthy = await waitHealthy();
        if (!healthy) {
            // Service didn't bind /health within the deadline. Don't tear
            // it down — model loading on first start can take longer than
            // 60s while it pulls SDXL-Turbo (~5GB). UI polls status; user
            // can retry the skill which has its own 180s timeout.
            emitLog('healthcheck not ready yet — model may still be downloading on first start (5GB). The container stays up; the generate_image skill will work as soon as /health is live.', 'warning');
        } else {
            emitLog('service ready', 'success');
        }
        state.status = 'running';

        await enableGenerateImageSkill();
    } catch (e) {
        state.status = 'error';
        state.error = e.message;
        emitLog(`start failed: ${e.message}`, 'error');
        throw e;
    }
    return getStatus();
}

async function stop() {
    if (state.status === 'stopped') return getStatus();
    try {
        const c = docker.getContainer(CONTAINER_NAME);
        try { await c.stop({ t: 10 }); } catch (_) { /* maybe already stopped */ }
        try { await c.remove({ force: true }); } catch (_) {}
        emitLog('service stopped', 'info');
    } catch (e) {
        emitLog(`stop encountered: ${e.message}`, 'warning');
    } finally {
        state.status = 'stopped';
        state.containerId = null;
        state.startedAt = null;
        state.error = null;
    }
    return getStatus();
}

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

/** Runs once on webapp startup. If the imagegen container is already
 *  running (carried over from a prior webapp restart, or activated via
 *  compose), reattach log streaming and mark state as running. */
async function reconcileOnBoot() {
    state.imageBuilt = await imageExists();
    const existing = await existingContainer();
    if (!existing) return;
    if (existing.info.State && existing.info.State.Running) {
        state.status = 'running';
        state.containerId = existing.info.Id;
        state.startedAt = existing.info.State.StartedAt
            ? new Date(existing.info.State.StartedAt).getTime() : Date.now();
        streamLogs(existing.container);
        emitLog('reattached to running container ' + existing.info.Id.slice(0, 12));
    }
}

module.exports = {
    init,
    getStatus,
    start,
    stop,
    reconcileOnBoot,
    // Exposed for testing / introspection.
    _internals: { IMAGE_NAME, CONTAINER_NAME, NETWORK_NAME, VOLUME_NAME },
};
