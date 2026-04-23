// Sandbox runner — executes untrusted Python code inside a short-lived
// gVisor-isolated container for each invocation.
//
// Lifecycle per run:
//   1. Create a scratch dir under /models/.modelserver/sandbox/<uuid>/
//      containing skill.py (RO), params.json (RO), artifacts/ (RW).
//   2. `docker run --rm --runtime=runsc --read-only --tmpfs /tmp
//       --network=<tier> -v <scratch>:/work:ro -v <artifacts>:/artifacts:rw
//       modelserver-sandbox-python python3 /work/skill.py`
//   3. Capture stdout/stderr (10MB cap), parse JSON.
//   4. Collect artifact file list for the UI; keep the scratch dir around
//      long enough for the chat handler to serve them (caller's job to
//      clean up via cleanupRun()).
//
// Network tiers:
//   'none'      → --network=none, no DNS, no routing
//   'allowlist' → --network=modelserver_default, HTTPS_PROXY pointing to
//                  webapp:3180 with a per-run token grant issued to the
//                  egress proxy for the tool's declared hostnames
//   'open'      → --network=bridge (rare; caller must explicitly request)
//
// Falls back to runc (default runtime) when runsc isn't available so the
// system still works in dev environments without gVisor. A log warning
// makes the degraded state visible.

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const Docker = require('dockerode');
const egressProxy = require('./egressProxy');

const docker = new Docker();

// Base dir (inside webapp container). The corresponding host path is needed
// for sibling --volume mounts.
const SANDBOX_DIR_IN_CONTAINER = '/models/.modelserver/sandbox';
// Resolved once at first use from the webapp's detected host models path.
let sandboxHostBase = null;

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'modelserver-sandbox-python:latest';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY = '512m';
const DEFAULT_CPUS = '1.0';
const DEFAULT_NETWORK_NAME = process.env.COMPOSE_PROJECT_NAME
    ? `${process.env.COMPOSE_PROJECT_NAME}_default`
    : 'modelserver_default';

function ensureBaseDir() {
    if (!fsSync.existsSync(SANDBOX_DIR_IN_CONTAINER)) {
        fsSync.mkdirSync(SANDBOX_DIR_IN_CONTAINER, { recursive: true, mode: 0o755 });
    }
}
ensureBaseDir();

/** Set once by server.js after it detects the host path. The in-container
 *  path is /models/... so the host path is <hostModelsPath>/.modelserver/sandbox. */
function setHostBase(hostModelsPath) {
    if (hostModelsPath) {
        sandboxHostBase = path.posix.join(hostModelsPath, '.modelserver/sandbox');
    }
}

/** True when runsc is available on the Docker daemon. Computed once. */
let _runscAvailable = null;
async function runscAvailable() {
    if (_runscAvailable != null) return _runscAvailable;
    try {
        const info = await docker.info();
        _runscAvailable = !!(info?.Runtimes && info.Runtimes.runsc);
    } catch (e) {
        console.warn('[sandboxRunner] runsc detection failed:', e.message);
        _runscAvailable = false;
    }
    if (!_runscAvailable) {
        console.warn('[sandboxRunner] gVisor (runsc) not registered — tool execution will use the default runtime. Install via ./setup-sandbox.sh for isolation.');
    }
    return _runscAvailable;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Run a Python skill in a sandboxed container.
 *
 * @param {object} opts
 * @param {string} opts.code          — Python source. Must define execute(params).
 * @param {object} opts.params        — Arguments passed as JSON to execute().
 * @param {'none'|'allowlist'|'open'} [opts.network]  — default 'none'
 * @param {string[]} [opts.allowlist] — hosts/patterns for network=allowlist
 * @param {number}   [opts.timeoutMs]
 * @param {string}   [opts.memory]    — Docker memory limit (e.g. "256m")
 * @param {string}   [opts.cpus]      — Docker cpu limit (e.g. "0.5")
 * @param {string}   [opts.toolName]  — for logging / egress grants
 * @param {string}   [opts.userId]
 * @returns {Promise<{ stdout, stderr, exitCode, result?, artifacts, runId, scratchDir }>}
 *          `result` is the parsed JSON from stdout if parse succeeded.
 *          Caller must invoke cleanupRun(runId) after consuming artifacts.
 */
async function runPythonSkill(opts) {
    if (!sandboxHostBase) {
        throw new Error('sandboxRunner: host base path not set — call setHostBase() first');
    }
    const {
        code, params = {},
        network = 'none',
        allowlist = [],
        timeoutMs = DEFAULT_TIMEOUT_MS,
        memory = DEFAULT_MEMORY,
        cpus = DEFAULT_CPUS,
        toolName = 'anonymous',
        userId = null,
    } = opts;

    if (typeof code !== 'string' || !code.trim()) {
        throw new Error('sandboxRunner: code is required');
    }

    const runId = crypto.randomBytes(12).toString('hex');
    const scratchIn = path.join(SANDBOX_DIR_IN_CONTAINER, runId);
    const scratchHost = path.posix.join(sandboxHostBase, runId);
    const artifactsIn = path.join(scratchIn, 'artifacts');
    const artifactsHost = path.posix.join(scratchHost, 'artifacts');

    // 1. Stage input on disk. umask may strip the mkdir mode bits, so
    // chmod explicitly after create — the artifacts dir MUST be writable
    // by the container's unprivileged user (uid 1000 in our image).
    await fs.mkdir(scratchIn, { recursive: true, mode: 0o755 });
    await fs.mkdir(artifactsIn, { recursive: true });
    await fs.chmod(artifactsIn, 0o777);
    await fs.writeFile(path.join(scratchIn, 'params.json'), JSON.stringify(params));

    // A small harness wraps the user's code so we control stdout framing.
    // `execute(params)` is the convention the existing skill catalog already
    // uses, so dropping in existing skill code works unchanged.
    const harness = `
import json, sys, os, traceback

try:
    with open('/work/params.json') as f:
        _params = json.load(f)
except Exception as e:
    print(json.dumps({"success": False, "error": f"failed to load params: {e}"}))
    sys.exit(1)

# --- user skill code starts ---
${code}
# --- user skill code ends ---

try:
    _result = execute(_params)  # convention
    if not isinstance(_result, dict):
        _result = {"success": False, "error": "skill must return a dict"}
    print(json.dumps(_result))
except Exception as _e:
    print(json.dumps({
        "success": False,
        "error": str(_e),
        "traceback": traceback.format_exc(limit=10),
    }))
    sys.exit(1)
`;
    await fs.writeFile(path.join(scratchIn, 'skill.py'), harness);

    // 2. Build container config
    const useRunsc = await runscAvailable();
    const env = [];
    let networkMode = 'none';
    let egressToken = null;

    if (network === 'none') {
        networkMode = 'none';
    } else if (network === 'allowlist') {
        if (!allowlist.length) {
            await cleanupRun(runId).catch(() => {});
            throw new Error('sandboxRunner: network=allowlist requires non-empty allowlist');
        }
        networkMode = DEFAULT_NETWORK_NAME;
        egressToken = egressProxy.issueGrant({
            allowlist, toolName, userId,
            ttlMs: timeoutMs + 5_000,
        });
        const host = process.env.EGRESS_HOST || 'webapp';
        const port = egressProxy.PROXY_PORT || 3180;
        // Skills that use `requests` or `urllib` read these env vars.
        // The Proxy-Authorization header must come from the skill code
        // itself; we expose the token so well-behaved skills can attach it.
        env.push(
            `HTTP_PROXY=http://${host}:${port}`,
            `HTTPS_PROXY=http://${host}:${port}`,
            `http_proxy=http://${host}:${port}`,
            `https_proxy=http://${host}:${port}`,
            `SANDBOX_EGRESS_TOKEN=${egressToken}`,
        );
    } else if (network === 'open') {
        networkMode = 'bridge';
    } else {
        await cleanupRun(runId).catch(() => {});
        throw new Error(`sandboxRunner: unknown network tier "${network}"`);
    }

    const memoryBytes = parseMemory(memory);
    const nanoCpus = Math.round(parseFloat(cpus) * 1e9);

    // 3. Create + start + wait with timeout
    const start = Date.now();
    let container, stdout = '', stderr = '', exitCode = -1, timedOut = false;
    try {
        container = await docker.createContainer({
            Image: SANDBOX_IMAGE,
            Cmd: ['python3', '/work/skill.py'],
            WorkingDir: '/work',
            Env: env,
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                AutoRemove: false, // we remove explicitly so we can inspect first
                ReadonlyRootfs: true,
                Runtime: useRunsc ? 'runsc' : undefined,
                Memory: memoryBytes,
                NanoCpus: nanoCpus,
                PidsLimit: 256,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
                NetworkMode: networkMode,
                Binds: [
                    `${scratchHost}:/work:ro`,
                    `${artifactsHost}:/artifacts:rw`,
                ],
                Tmpfs: { '/tmp': 'rw,size=64m,mode=1777' },
            },
        });

        // Attach stdout/stderr stream before starting
        const logStream = await container.attach({
            stream: true, stdout: true, stderr: true,
        });
        const outS = new PassThrough();
        const errS = new PassThrough();
        outS.on('data', c => stdout += c.toString('utf8'));
        errS.on('data', c => stderr += c.toString('utf8'));
        container.modem.demuxStream(logStream, outS, errS);

        await container.start();

        const waitResult = await Promise.race([
            container.wait(),
            new Promise(resolve => setTimeout(async () => {
                timedOut = true;
                try { await container.kill({ signal: 'SIGKILL' }); } catch (_) {}
                resolve({ StatusCode: 137 });
            }, timeoutMs)),
        ]);
        exitCode = waitResult.StatusCode;

        // Give the stream a moment to flush final bytes
        await new Promise(r => setTimeout(r, 80));
    } catch (err) {
        stderr = (stderr || '') + `\n[sandboxRunner error: ${err.message}]`;
        exitCode = -1;
    } finally {
        if (container) {
            try { await container.remove({ force: true }); } catch (_) {}
        }
        if (egressToken) egressProxy.revokeGrant(egressToken);
    }

    const durationMs = Date.now() - start;

    // Cap captured output sizes
    const MAX = 10 * 1024 * 1024;
    if (stdout.length > MAX) stdout = stdout.slice(0, MAX) + '\n[stdout truncated]';
    if (stderr.length > MAX) stderr = stderr.slice(0, MAX) + '\n[stderr truncated]';

    // 5. Parse stdout as JSON (skill convention)
    let result = null;
    let parseError = null;
    try {
        result = JSON.parse(stdout.trim() || 'null');
    } catch (e) {
        parseError = e.message;
    }

    // 6. Collect artifact file list
    let artifacts = [];
    try {
        const entries = await fs.readdir(artifactsIn, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isFile()) continue;
            const stat = await fs.stat(path.join(artifactsIn, e.name));
            artifacts.push({
                name: e.name,
                size: stat.size,
                containerPath: path.join(artifactsIn, e.name),
            });
        }
    } catch (_) { /* no artifacts */ }

    return {
        runId,
        scratchDir: scratchIn,
        artifactsDir: artifactsIn,
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs,
        result,
        parseError,
        artifacts,
        network,
        sandboxed: useRunsc,
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Convert "512m", "1g", "256" (bytes) to an integer byte count.
 *  dockerode's HostConfig.Memory takes bytes. */
function parseMemory(spec) {
    if (typeof spec === 'number') return spec;
    const m = String(spec).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
    if (!m) throw new Error(`sandboxRunner: invalid memory spec "${spec}"`);
    const n = parseFloat(m[1]);
    const unit = m[2] || '';
    const mul = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit];
    return Math.round(n * mul);
}

async function cleanupRun(runId) {
    if (!runId) return;
    const dir = path.join(SANDBOX_DIR_IN_CONTAINER, runId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
    runPythonSkill,
    cleanupRun,
    setHostBase,
    SANDBOX_IMAGE,
    DEFAULT_TIMEOUT_MS,
};
