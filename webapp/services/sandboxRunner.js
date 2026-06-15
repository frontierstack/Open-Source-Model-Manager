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
// Public DNS FALLBACKS, appended after the network's own resolvers in the
// sandbox resolv.conf (see the dns block in runPythonSkill). The network/host
// resolvers are preferred so corporate/LAN names resolve and networks that
// block public DNS still work; these are the safety net. Override with
// SANDBOX_DNS=1.1.1.1,9.9.9.9.
const SANDBOX_DNS = (process.env.SANDBOX_DNS || '8.8.8.8,1.1.1.1')
    .split(',').map(s => s.trim()).filter(Boolean);
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
    // Workspaces dir created lazily in ensureWorkspace — same parent though.
    const wsBase = '/models/.modelserver/workspaces';
    if (!fsSync.existsSync(wsBase)) {
        fsSync.mkdirSync(wsBase, { recursive: true, mode: 0o755 });
    }
}
ensureBaseDir();

/** Set once by server.js after it detects the host path. The in-container
 *  path is /models/... so the host path is <hostModelsPath>/.modelserver/sandbox. */
function setHostBase(hostModelsPath) {
    if (hostModelsPath) {
        sandboxHostBase = path.posix.join(hostModelsPath, '.modelserver/sandbox');
    }
    // Warm the host-resolver cache so the first networked sandbox run doesn't
    // pay the discovery probe latency. Best-effort.
    getHostResolvers().catch(() => {});
}

// Discover the host's real upstream DNS resolvers, once, and cache. On a
// user-defined Docker network the container's resolv.conf only lists Docker's
// embedded resolver 127.0.0.11, which gVisor can't reach — but the actual
// upstreams are exactly what Docker writes into a DEFAULT-bridge container's
// resolv.conf (loopback entries filtered out). Read them from a throwaway
// bridge container so the sandbox can PREFER the network's own DNS (corporate /
// LAN names, environments that block public DNS), keeping 8.8.8.8/1.1.1.1 only
// as a fallback. Returns [] on any failure (caller then uses the fallbacks).
let _hostResolversPromise = null;
async function discoverHostResolvers() {
    let c = null;
    try {
        c = await docker.createContainer({
            Image: SANDBOX_IMAGE,
            Cmd: ['cat', '/etc/resolv.conf'],
            HostConfig: { NetworkMode: 'bridge', AutoRemove: false },
            AttachStdout: true, AttachStderr: true,
        });
        let out = '';
        const stream = await c.attach({ stream: true, stdout: true, stderr: true });
        const pt = new PassThrough();
        pt.on('data', b => { out += b.toString('utf8'); });
        c.modem.demuxStream(stream, pt, pt);
        await c.start();
        await Promise.race([
            c.wait(),
            new Promise(r => setTimeout(r, 8000)),
        ]);
        const servers = [];
        for (const line of out.split('\n')) {
            const m = line.match(/^\s*nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
            // Skip loopback stubs (127.0.0.11 embedded resolver, 127.0.0.53
            // systemd-resolved) — unreachable from the gVisor sandbox.
            if (m && !m[1].startsWith('127.')) servers.push(m[1]);
        }
        return servers;
    } catch (e) {
        console.warn('[sandboxRunner] host DNS discovery failed:', e.message);
        return [];
    } finally {
        if (c) { try { await c.remove({ force: true }); } catch (_) {} }
    }
}
function getHostResolvers() {
    if (!_hostResolversPromise) _hostResolversPromise = discoverHostResolvers();
    return _hostResolversPromise;
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
        console.warn('[sandboxRunner] gVisor (runsc) not registered — tool execution will use the default runtime. Run ./build.sh to install it for isolation.');
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
 * @param {boolean}  [opts.workspace] — mount the user's per-user workspace
 *                                     directory read-write at /workspace, and
 *                                     normalize any path-shaped params (see
 *                                     PATH_ARG_NAMES) to paths under it.
 *                                     Enables file-op skills without giving
 *                                     them access to the host filesystem.
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
        workspace = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        memory = DEFAULT_MEMORY,
        cpus = DEFAULT_CPUS,
        toolName = 'anonymous',
        userId = null,
        // Per-chat scope so all skills firing in the same conversation
        // share a workspace bucket that can be wiped on conv delete.
        conversationId = null,
        // Explicit bucket override. When set (e.g. 'agent-<apiKeyId>' for Pi /
        // bearer-key callers) it wins over conversationId/global so a single
        // agent gets one persistent, manageable workspace across every turn.
        workspaceBucket = null,
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

    // If the tool requests workspace access, stage a per-user workspace dir
    // that will get mounted read-write at /workspace inside the sandbox, and
    // rewrite any path-shaped params to land under it. Workspace paths are
    // bind-mounted — they persist across runs (unlike /artifacts, which is
    // per-run).
    //
    // Path validation failures are returned as a structured result (same as
    // a skill's own runtime error), NOT thrown — so the caller sees
    // `{ success: false, error: "path escapes workspace: ..." }` instead of
    // a generic "Skill execution failed".
    // Optional per-skill escape hatch. File-op skills benefit from the
    // automatic path-rewriting (any `path` / `filePath` gets rerouted
    // under /workspace), but skills that use param names like `path`
    // for non-filesystem values — e.g. git_log's repo-relative path
    // filter — need to opt out. Default stays on to preserve the
    // existing hardening for every built-in that relied on it.
    const pathNormalize = opts.pathNormalize !== false;
    let workspaceInfo = null;
    let resolvedParams = params;
    if (workspace) {
        workspaceInfo = await ensureWorkspace(userId, conversationId, workspaceBucket);
        try {
            if (pathNormalize) {
                resolvedParams = normalizePathArgs(params, workspaceInfo.containerMount);
            }
        } catch (pathErr) {
            await cleanupRun(runId).catch(() => {});
            return {
                runId,
                scratchDir: scratchIn,
                artifactsDir: artifactsIn,
                stdout: '',
                stderr: '',
                exitCode: 0,
                timedOut: false,
                durationMs: 0,
                result: { success: false, error: pathErr.message || String(pathErr) },
                parseError: null,
                artifacts: [],
                network,
                sandboxed: await runscAvailable(),
            };
        }
    }
    await fs.writeFile(path.join(scratchIn, 'params.json'), JSON.stringify(resolvedParams));

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
        // Pre-resolve the proxy host. runsc's in-kernel DNS resolver
        // doesn't always see docker-network hostnames like "webapp"; by
        // resolving at grant time we give the sandbox a literal IP that
        // works whether it's using runc or runsc.
        let proxyHost = host;
        try {
            const { resolve4 } = require('dns').promises;
            const addrs = await resolve4(host);
            if (addrs && addrs.length) proxyHost = addrs[0];
        } catch { /* fall back to the hostname — may still work under runc */ }
        // Embed the token as Basic-auth credentials in the proxy URL so any
        // HTTP client that reads HTTPS_PROXY picks it up automatically
        // (git, curl, wget). Skills that use Python `requests` still see
        // SANDBOX_EGRESS_TOKEN for explicit Bearer use if they prefer.
        const proxyBase = `http://:${egressToken}@${proxyHost}:${port}`;
        env.push(
            `HTTP_PROXY=${proxyBase}`,
            `HTTPS_PROXY=${proxyBase}`,
            `http_proxy=${proxyBase}`,
            `https_proxy=${proxyBase}`,
            `SANDBOX_EGRESS_TOKEN=${egressToken}`,
            `SANDBOX_EGRESS_HOST=${proxyHost}`,
            `SANDBOX_EGRESS_PORT=${port}`,
        );
    } else if (network === 'open') {
        networkMode = 'bridge';
    } else {
        await cleanupRun(runId).catch(() => {});
        throw new Error(`sandboxRunner: unknown network tier "${network}"`);
    }

    if (workspaceInfo) {
        env.push(`USER_WORKSPACE=${workspaceInfo.containerMount}`);
        // Auto-persist pip installs across runs without the model needing to
        // know about /workspace at all. Plain `pip install yt-dlp` honors
        // PIP_TARGET as the default --target, so the install lands under
        // /workspace/.deps (per-conversation, persistent). PYTHONPATH then
        // makes the installed package importable in this and every future
        // call without `sys.path.insert` boilerplate. The model was
        // re-installing to /tmp on every turn because plain `pip install`
        // appeared to "just work" but evaporated under the read-only rootfs;
        // this makes it actually work.
        const depsDir = `${workspaceInfo.containerMount}/.deps`;
        env.push(
            `PIP_TARGET=${depsDir}`,
            // Pip otherwise complains "Target path exists but is not a
            // directory" if the user previously created /workspace/.deps
            // as a file by accident; --upgrade flag is the workaround pip
            // documents. Setting it here keeps `pip install <pkg>` idempotent.
            `PIP_DISABLE_PIP_VERSION_CHECK=1`,
            `PYTHONPATH=${depsDir}`,
        );
    }

    // DNS fix for gVisor (runsc). On a user-defined Docker network the
    // container's /etc/resolv.conf points at Docker's embedded resolver
    // 127.0.0.11, which gVisor's userspace netstack can't reach (it depends on
    // host iptables NAT that gVisor bypasses) — so EVERY hostname lookup fails
    // with "Temporary failure in name resolution" even though the path to a
    // real resolver works. `--dns` doesn't help: on user networks Docker keeps
    // 127.0.0.11 and only repoints its upstream. Bind a resolv.conf that lists
    // the network's OWN resolvers first (so corporate/LAN names resolve and
    // environments that block public DNS still work), with 8.8.8.8/1.1.1.1 as
    // fallbacks. Only for runsc + networked tiers ('none' has no network; under
    // runc 127.0.0.11 is reachable so we leave it alone). Well-behaved HTTP
    // clients still honor HTTP(S)_PROXY, so the allowlist/private-IP checks at
    // the egress proxy continue to apply to proxied traffic on the allowlist tier.
    const dnsBinds = [];
    if (useRunsc && networkMode !== 'none') {
        const hostResolvers = await getHostResolvers();
        // Network DNS first, public fallbacks after; dedupe. glibc reads at most
        // MAXNS (3) nameservers, so cap the list.
        const servers = [...new Set([...hostResolvers, ...SANDBOX_DNS])].slice(0, 3);
        if (servers.length) {
            // timeout:2 attempts:1 — if the primary (network) resolver is slow or
            // down, glibc moves to the next entry (the public fallback) quickly.
            const resolvConf = servers.map(s => `nameserver ${s}`).join('\n') + '\noptions timeout:2 attempts:1\n';
            try {
                await fs.writeFile(path.join(scratchIn, 'resolv.conf'), resolvConf);
                dnsBinds.push(`${path.posix.join(scratchHost, 'resolv.conf')}:/etc/resolv.conf:ro`);
            } catch (_) { /* fall back to the default resolv.conf — DNS may fail under gVisor */ }
        }
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
                    ...(workspaceInfo ? [`${workspaceInfo.hostMount}:/workspace:rw`] : []),
                    ...dnsBinds,
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

        // Bind the egress grant to this container's bridge IP so clients
        // that don't forward proxy URL userinfo on CONNECT (Python's
        // urllib stack — pip, requests, urllib.request) authenticate by
        // source IP. curl/git keep working through Proxy-Authorization;
        // either path applies the same allowlist + private-network checks.
        //
        // Under runsc (gVisor) the IP is NOT always populated in the first
        // inspect right after start() — gVisor attaches its netstack a beat
        // later, so a single read often returned "" and bindGrantToIp was
        // skipped, leaving the WHOLE run getting 407 from the egress proxy.
        // Poll briefly until the IP appears (or the container exits) instead of
        // giving up after one read. The window is small — the IP normally shows
        // within tens of ms, well before the Python workload finishes booting
        // under gVisor and issues its first request.
        if (egressToken) {
            const deadline = Date.now() + 1500;
            let bound = false;
            while (!bound && Date.now() < deadline) {
                try {
                    const info = await container.inspect();
                    const nets = info && info.NetworkSettings && info.NetworkSettings.Networks;
                    const netInfo = nets && nets[DEFAULT_NETWORK_NAME];
                    const ip = netInfo && netInfo.IPAddress;
                    if (ip) {
                        egressProxy.bindGrantToIp(egressToken, ip);
                        bound = true;
                        break;
                    }
                    // Container finished before an IP ever appeared (fast skill
                    // with no network use) — nothing to bind, stop polling.
                    const st = info && info.State;
                    if (st && st.Running === false && st.Status === 'exited') break;
                } catch (_) { /* mid-setup or already gone — retry until deadline */ }
                await new Promise(r => setTimeout(r, 25));
            }
            // curl/git still authenticate via the Basic-auth proxy URL even if
            // the IP never bound, so a miss here is degraded, not broken.
        }

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

    // 5. Parse stdout as JSON (skill convention).
    //
    // The harness writes a single-line `json.dumps(_result)` as the last
    // thing on stdout, but many third-party libraries (yt-dlp's progress
    // bar, tqdm, requests verbose mode, ML training spinners) print to
    // stdout too. A strict whole-stdout parse fails the moment any of
    // those leak through, even when the skill ran perfectly. Try the
    // whole buffer first; if that fails, walk back from the end looking
    // for a parseable JSON line.
    let result = null;
    let parseError = null;
    const trimmed = stdout.trim() || 'null';
    try {
        result = JSON.parse(trimmed);
    } catch (e) {
        parseError = e.message;
        // Treat \r as a line separator too. Progress bars (yt-dlp, tqdm,
        // wget) rewrite a single terminal line using bare \r, so they
        // arrive as one long "line" if you only split on \n.
        const lines = trimmed.split(/\r\n|\r|\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            // Cheap shape filter so we don't burn cycles JSON-parsing
            // every progress line. The harness output is always a top-
            // level JSON object — array results are wrapped in a dict.
            if (!line.startsWith('{') || !line.endsWith('}')) continue;
            try {
                result = JSON.parse(line);
                parseError = null;
                break;
            } catch { /* keep walking */ }
        }
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

    // 6b. Also promote files written to /workspace/artifacts/ during this
    // run. The chat model's natural instinct when asked to "download" a
    // file is to put it under /workspace/artifacts/ — but only the per-run
    // /artifacts/ mount is what surfaces as a download. Without this
    // promotion step, a file created by run_python and then copy_file'd
    // into /workspace/artifacts/ silently never appears.
    //
    // We use Math.max(mtime, ctime) against `start` so files left over
    // from prior turns don't re-surface every time. ctime is critical
    // because copy_file/shutil.copy2 (Python convention used by the
    // copy_file skill) preserves the SOURCE's mtime on the destination —
    // so a file copied into /workspace/artifacts/ during this run has an
    // mtime older than start and would be falsely skipped if we only
    // checked mtime. ctime ('change time') updates whenever the inode is
    // created or its metadata changes, so a freshly-copied file's ctime
    // is always within the run window. Skip dotfiles / `..` names since
    // the artifact endpoint would reject them anyway.
    if (workspaceInfo) {
        const wsArtifactsDir = path.join(workspaceInfo.localInContainer, 'artifacts');
        try {
            const wsEntries = await fs.readdir(wsArtifactsDir, { withFileTypes: true });
            const seen = new Set(artifacts.map(a => a.name));
            for (const e of wsEntries) {
                if (!e.isFile()) continue;
                if (e.name.startsWith('.') || e.name.includes('..')) continue;
                if (seen.has(e.name)) continue;
                const srcPath = path.join(wsArtifactsDir, e.name);
                let stat;
                try { stat = await fs.stat(srcPath); } catch { continue; }
                const newest = Math.max(stat.mtimeMs, stat.ctimeMs);
                if (!stat.isFile() || newest < start) continue;
                const destPath = path.join(artifactsIn, e.name);
                try {
                    await fs.copyFile(srcPath, destPath);
                } catch (copyErr) {
                    console.warn(
                        '[sandboxRunner] failed to promote workspace artifact:',
                        e.name, copyErr.message,
                    );
                    continue;
                }
                seen.add(e.name);
                artifacts.push({
                    name: e.name,
                    size: stat.size,
                    containerPath: destPath,
                });
            }
        } catch { /* no /workspace/artifacts/ — nothing to promote */ }
    }

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
// Workspace helpers
// ---------------------------------------------------------------------------

// Per-user workspace root inside the webapp container. The sibling host path
// is derived from hostModelsPath (set once at boot via setHostBase).
const WORKSPACE_DIR_IN_CONTAINER = '/models/.modelserver/workspaces';
const CONTAINER_MOUNT = '/workspace';

// Param names treated as paths — rewritten to land under /workspace and
// rejected if they attempt traversal out of it. Covers the naming used by
// the default skill catalog (filePath, dirPath, sourcePath, destPath, path,
// directory). Skill authors who want a path arg under a custom name can
// call normalizePathArgs themselves in skill.py.
const PATH_ARG_NAMES = [
    'filePath', 'dirPath', 'sourcePath', 'destPath',
    'path', 'directory', 'src', 'dest', 'target',
    'from', 'to', 'output', 'input',
    // download_file / screenshot use `savePath`; tar_extract / unzip_file
    // use `tarPath` / `zipPath` / `extractPath`. Without these, the model's
    // very natural `/tmp/foo.tgz` never gets rewritten to `/workspace/foo.tgz`
    // and the file disappears between calls.
    'savePath', 'tarPath', 'zipPath', 'extractPath',
    // convert_image (Pillow) reads `inputPath` and writes `outputPath`; without
    // rewriting these, a bare/`/tmp` path isn't routed under /workspace and the
    // in/out files don't line up with the mounted bucket.
    'inputPath', 'outputPath',
    // run_python/run_node's large-script escape hatch: a /workspace .py/.js path
    // passed instead of inline `code` (which truncates at the tool-call arg token
    // cap). Rewriting it lets the model pass `script.py` or `/workspace/script.py`
    // interchangeably and still have the runner find it inside the sandbox.
    'codeFile',
    // create_xlsx's large-dataset escape hatch: a /workspace JSON path of rows.
    'rowsFile',
];

/** Create (if needed) + chmod the per-(user, conversation) workspace.
 *  Returns both the in-container path and the host path for the bind mount.
 *
 *  Bucket layout:
 *    <base>/workspaces/<userId>/agent-<apiKeyId>/        (bearer-key / Pi caller)
 *    <base>/workspaces/<userId>/conv-<conversationId>/   (chat turn with a conv)
 *    <base>/workspaces/<userId>/global/                  (other non-chat callers)
 *
 *  Per-conv scoping lets us wipe everything a chat produced (git clones,
 *  files, downloads) when the conversation is deleted — clean cleanup semantics
 *  with no cross-conversation leakage. A `bucketOverride` (e.g. agent-<keyId>)
 *  pins one persistent, user-manageable workspace to a single bearer key/agent
 *  across all of its turns. Other non-chat callers still get `global/`. */
async function ensureWorkspace(userId, conversationId = null, bucketOverride = null) {
    if (!sandboxHostBase) {
        throw new Error('sandboxRunner: hostBase not set — workspace unavailable');
    }
    const owner = userId == null ? 'global' : String(userId).replace(/[^A-Za-z0-9_-]/g, '_');
    const bucket = bucketOverride
        ? String(bucketOverride).replace(/[^A-Za-z0-9_-]/g, '_')
        : conversationId
            ? 'conv-' + String(conversationId).replace(/[^A-Za-z0-9_-]/g, '_')
            : 'global';
    const userDirIn = path.join(WORKSPACE_DIR_IN_CONTAINER, owner, bucket);
    // Host workspace base lives next to the sandbox base.
    const workspaceHostBase = path.posix.join(
        path.posix.dirname(sandboxHostBase),
        'workspaces',
    );
    const userDirHost = path.posix.join(workspaceHostBase, owner, bucket);

    await fs.mkdir(userDirIn, { recursive: true });
    // umask may strip bits; be explicit.
    await fs.chmod(userDirIn, 0o777);
    return {
        containerMount: CONTAINER_MOUNT,   // what the skill sees
        hostMount: userDirHost,             // what Docker binds
        localInContainer: userDirIn,        // where webapp reads/writes
        bucket,                             // 'global' or 'conv-<id>'
        owner,
    };
}

/** Delete a conversation-scoped workspace bucket. Called from the
 *  conversation-delete handler to wipe every sandboxed artifact that
 *  chat produced. Returns { deleted, byteCount } for audit logging.
 *  Silently no-ops if the bucket never existed.
 */
async function deleteConversationWorkspace(userId, conversationId) {
    if (!conversationId) return { deleted: false };
    // Owner resolution must match ensureWorkspace exactly — null/undefined
    // userId buckets under 'global' there, so it must here. Otherwise the
    // deletion points at a non-existent dir (e.g. /workspaces/<apiKeyId>/)
    // while the real data sits under /workspaces/global/.
    const owner = userId == null ? 'global' : String(userId).replace(/[^A-Za-z0-9_-]/g, '_');
    const bucket = 'conv-' + String(conversationId).replace(/[^A-Za-z0-9_-]/g, '_');
    const dirIn = path.join(WORKSPACE_DIR_IN_CONTAINER, owner, bucket);
    let byteCount = 0;
    let fileCount = 0;
    try {
        for await (const entry of walkFiles(dirIn)) {
            try {
                const st = await fs.stat(entry);
                byteCount += st.size;
                fileCount += 1;
            } catch { /* ignore */ }
        }
        await fs.rm(dirIn, { recursive: true, force: true });
    } catch (e) {
        return { deleted: false, error: e.message };
    }
    return { deleted: true, path: dirIn, byteCount, fileCount };
}

async function* walkFiles(dir) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            yield* walkFiles(p);
        } else {
            yield p;
        }
    }
}

/** Map a userId to its on-disk owner dir name (null → 'global'). */
function workspaceOwnerDir(userId) {
    return userId == null ? 'global' : String(userId).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Classify a bucket dir name for the management UI. */
function classifyBucket(name) {
    return name.startsWith('agent-') ? 'agent'
        : name.startsWith('conv-') ? 'conversation'
        : name === 'global' ? 'global'
        : 'other';
}

/** Stat one owner's buckets. `owner` is the literal on-disk dir name. Returns
 *  [{ owner, bucket, type, sizeBytes, fileCount, mtimeMs }]; empty when none. */
async function listWorkspacesForOwner(owner) {
    const ownerDir = path.join(WORKSPACE_DIR_IN_CONTAINER, owner);
    let entries;
    try {
        entries = await fs.readdir(ownerDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const b of entries) {
        if (!b.isDirectory()) continue;
        const bucketDir = path.join(ownerDir, b.name);
        let sizeBytes = 0, fileCount = 0, mtimeMs = 0;
        for await (const f of walkFiles(bucketDir)) {
            try {
                const st = await fs.stat(f);
                sizeBytes += st.size;
                fileCount += 1;
                if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
            } catch { /* ignore */ }
        }
        if (!mtimeMs) {
            try { mtimeMs = (await fs.stat(bucketDir)).mtimeMs; } catch { /* ignore */ }
        }
        out.push({ owner, bucket: b.name, type: classifyBucket(b.name), sizeBytes, fileCount, mtimeMs });
    }
    return out;
}

/** One owner's workspace buckets (by userId) — self-scoped management view. */
async function listWorkspaces(userId) {
    return listWorkspacesForOwner(workspaceOwnerDir(userId));
}

/** Every owner's workspace buckets — admin-wide management view. Each entry
 *  carries its `owner` (the on-disk dir name) so the UI/route can resolve it
 *  back to a username and authorize deletes. */
async function listAllWorkspaces() {
    let owners;
    try {
        owners = await fs.readdir(WORKSPACE_DIR_IN_CONTAINER, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const o of owners) {
        if (!o.isDirectory()) continue;
        const list = await listWorkspacesForOwner(o.name);
        for (const w of list) out.push(w);
    }
    return out;
}

/** Delete a bucket given the literal owner dir name + bucket name. Both are
 *  re-sanitized defensively (the route validates + authorizes too). Returns
 *  { deleted, byteCount, fileCount } for audit logging. */
async function deleteWorkspaceBucketByOwner(owner, bucket) {
    const safeOwner = String(owner || '').replace(/[^A-Za-z0-9_-]/g, '_');
    const safeBucket = String(bucket || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (!safeOwner || !safeBucket) return { deleted: false, error: 'bad owner/bucket' };
    const dirIn = path.join(WORKSPACE_DIR_IN_CONTAINER, safeOwner, safeBucket);
    let byteCount = 0, fileCount = 0;
    try {
        for await (const f of walkFiles(dirIn)) {
            try {
                const st = await fs.stat(f);
                byteCount += st.size;
                fileCount += 1;
            } catch { /* ignore */ }
        }
        await fs.rm(dirIn, { recursive: true, force: true });
    } catch (e) {
        return { deleted: false, error: e.message };
    }
    return { deleted: true, path: dirIn, byteCount, fileCount };
}

/** Delete a bucket scoped to a userId (self-service). */
async function deleteWorkspaceBucket(userId, bucket) {
    return deleteWorkspaceBucketByOwner(workspaceOwnerDir(userId), bucket);
}

/** One-shot migration: any legacy per-user workspace whose contents sit
 *  directly under <userId>/ (pre-bucketing scheme) is shuffled into
 *  <userId>/global/ so the new code can find them. Idempotent — if the
 *  user dir already has bucket subdirs (conv-* or global), we skip. */
async function migrateLegacyWorkspaces() {
    if (!sandboxHostBase) return;
    let ownerDirs;
    try {
        ownerDirs = await fs.readdir(WORKSPACE_DIR_IN_CONTAINER, { withFileTypes: true });
    } catch {
        return;
    }
    let migrated = 0;
    for (const od of ownerDirs) {
        if (!od.isDirectory()) continue;
        const ownerPath = path.join(WORKSPACE_DIR_IN_CONTAINER, od.name);
        let contents;
        try {
            contents = await fs.readdir(ownerPath, { withFileTypes: true });
        } catch { continue; }
        // If every child is already a bucket dir (global / conv-*), nothing to do.
        const looseChildren = contents.filter(c => !(c.isDirectory() && (c.name === 'global' || c.name.startsWith('conv-'))));
        if (!looseChildren.length) continue;
        const globalDir = path.join(ownerPath, 'global');
        try {
            await fs.mkdir(globalDir, { recursive: true });
            await fs.chmod(globalDir, 0o777);
        } catch { continue; }
        for (const child of looseChildren) {
            const from = path.join(ownerPath, child.name);
            const to = path.join(globalDir, child.name);
            try {
                await fs.rename(from, to);
                migrated++;
            } catch { /* ignore — already moved / permissions */ }
        }
    }
    if (migrated) {
        console.log(`[workspace-migration] moved ${migrated} legacy item(s) into global/ bucket`);
    }
}

/** Resolve `input` against `/workspace` inside the sandbox. Any traversal
 *  that escapes the workspace root raises an Error. Absolute paths outside
 *  /workspace are rerouted to their basename under /workspace. */
function resolveInWorkspace(input, mount = CONTAINER_MOUNT) {
    if (typeof input !== 'string' || !input) return input;
    // Strip leading workspace prefix if the caller already normalized.
    let trimmed = input;
    if (trimmed.startsWith(mount + '/')) trimmed = trimmed.slice(mount.length + 1);
    else if (trimmed === mount) trimmed = '';
    // An absolute path that points outside /workspace — typically one the model
    // invented (a stale extract dir, a bare /tmp/pkg/index.js, a host path that
    // doesn't exist here). PRESERVE the directory structure under /workspace
    // (strip only the leading slash) instead of collapsing to the basename.
    // Collapsing throws away the very segments a skill's not-found recovery
    // needs to disambiguate a common filename — a package tree has dozens of
    // index.js / package.json, so a basename-only path is unrecoverable and the
    // model burns extra tool calls guessing. The real workspace-relative path is
    // a suffix of what we keep, so read_file's trailing-segment matcher can
    // still locate (and auto-read) the file. Traversal is still rejected below.
    if (trimmed.startsWith('/')) {
        trimmed = trimmed.replace(/^\/+/, '');
    }
    // Normalize and reject traversal.
    const joined = path.posix.normalize(path.posix.join(mount, trimmed));
    if (!joined.startsWith(mount + '/') && joined !== mount) {
        throw new Error(`path escapes workspace: ${input}`);
    }
    return joined;
}

/** Produce a shallow-copy of params where any key in PATH_ARG_NAMES is
 *  rewritten to its workspace-safe form. Non-string values pass through
 *  unchanged. Throws if any rewrite fails (propagated to the skill as
 *  a failure). */
function normalizePathArgs(params, mount = CONTAINER_MOUNT) {
    if (!params || typeof params !== 'object') return params;
    const out = { ...params };
    for (const k of PATH_ARG_NAMES) {
        if (typeof out[k] === 'string') {
            out[k] = resolveInWorkspace(out[k], mount);
        }
    }
    return out;
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
    deleteConversationWorkspace,
    listWorkspaces,
    listAllWorkspaces,
    deleteWorkspaceBucket,
    deleteWorkspaceBucketByOwner,
    migrateLegacyWorkspaces,
    ensureWorkspace,
    resolveInWorkspace,
    normalizePathArgs,
    PATH_ARG_NAMES,
    SANDBOX_IMAGE,
    DEFAULT_TIMEOUT_MS,
};
