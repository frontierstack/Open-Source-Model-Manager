// Egress proxy — per-tool HTTPS allowlist enforcement.
//
// Tools declare their network policy:
//   'none'      — container launched with --network=none (no DNS, no routes)
//   'allowlist' — container gets HTTP_PROXY/HTTPS_PROXY pointing here with
//                 a unique per-invocation token. The proxy checks the token
//                 against an in-memory grants table, forwards to the
//                 declared hostnames, and rejects everything else.
//   'open'      — container gets normal bridge networking. Rare; only for
//                 trusted tools the operator explicitly marks open.
//
// The proxy speaks two protocols:
//   - HTTPS via the CONNECT method (hostname is exposed in plain text in
//     the CONNECT line; we decide allow/deny there, then blindly pipe
//     bytes if allowed — we do NOT MITM TLS)
//   - HTTP forward-proxy (first line is "GET http://host/path HTTP/1.1";
//     we parse the absolute URL, decide, then forward)
//
// A grant is keyed by an opaque random token that we hand to the tool
// container via Proxy-Authorization: Bearer <token>. Grants have a TTL so
// stale containers (crashed, orphaned) can't reuse credentials.

const http = require('http');
const net = require('net');
const url = require('url');
const crypto = require('crypto');
const dns = require('dns');
const dnsPromises = dns.promises;

// ---------------------------------------------------------------------------
// Private-network blocking — defense against the sandbox calling internal
// services (Docker bridge IPs, host-only nets, loopback, link-local, etc).
// Applied to every request regardless of allowlist tightness; the model
// should never reach the host's intranet via this proxy.
// ---------------------------------------------------------------------------

function isPrivateOrLocalIp(addr) {
    if (!addr) return true;
    if (net.isIP(addr) === 4) {
        const p = addr.split('.').map(Number);
        if (p.some(n => Number.isNaN(n))) return true;
        if (p[0] === 0)  return true;                              // 0.0.0.0/8
        if (p[0] === 10) return true;                              // 10/8
        if (p[0] === 127) return true;                             // 127/8 loopback
        if (p[0] === 169 && p[1] === 254) return true;             // 169.254/16 link-local
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
        if (p[0] === 192 && p[1] === 168) return true;             // 192.168/16
        if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // 192.0.0/24 IETF
        if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true; // 192.0.2/24 TEST-NET-1
        if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // 198.18/15 benchmark
        if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true; // TEST-NET-2
        if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;  // TEST-NET-3
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
        if (p[0] >= 224) return true;                              // 224+ multicast / reserved
        return false;
    }
    if (net.isIP(addr) === 6) {
        const lower = addr.toLowerCase();
        if (lower === '::1' || lower === '::') return true;
        if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true;
        if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;          // fc00::/7 ULA
        if (lower.startsWith('ff')) return true;                     // ff00::/8 multicast
        if (lower.startsWith('::ffff:')) {
            const v4 = lower.slice(7);
            if (net.isIP(v4) === 4) return isPrivateOrLocalIp(v4);
        }
        if (lower.startsWith('64:ff9b::')) return false;             // NAT64 — public-mapped
        return false;
    }
    return true; // unknown format = treat as private
}

function isInternalLookingHost(host) {
    host = String(host || '').toLowerCase().trim();
    if (!host) return true;
    // Single-label hostnames map to Docker-internal services ("webapp",
    // "chat", or arbitrary user containers); no public DNS root for them.
    if (!host.includes('.')) return true;
    // Reserved/internal TLDs that should never leak out.
    if (/\.(local|internal|localhost|home|lan|corp|intranet|alt|home\.arpa)$/i.test(host)) return true;
    return false;
}

/** Resolve `host` and return true only if every resolved address is
 *  publicly routable. Literal IPs are checked directly. Failures (DNS
 *  error, no records) deny by default. */
async function resolvesPublicly(host) {
    host = String(host || '').toLowerCase().trim();
    if (!host) return false;
    if (net.isIP(host)) return !isPrivateOrLocalIp(host);
    if (isInternalLookingHost(host)) return false;
    try {
        const addrs = await dnsPromises.lookup(host, { all: true, verbatim: true });
        if (!addrs || addrs.length === 0) return false;
        for (const a of addrs) {
            if (isPrivateOrLocalIp(a.address)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

const PROXY_PORT = parseInt(process.env.EGRESS_PROXY_PORT || '3180', 10);

// grants: token -> { allow:Set<string>, expiresAt:number, toolName, userId }
const grants = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — longer than any tool

// Stats for debugging / future dashboards.
const stats = {
    granted: 0,
    revoked: 0,
    allowed: 0,
    rejectedNoToken: 0,
    rejectedBadToken: 0,
    rejectedExpired: 0,
    rejectedNotOnAllowlist: 0,
    rejectedPrivateHost: 0,
};

// ---------------------------------------------------------------------------
// Grant API — called by the tool runner when spawning a container
// ---------------------------------------------------------------------------

function issueGrant({ allowlist, toolName, userId, ttlMs = DEFAULT_TTL_MS }) {
    const token = crypto.randomBytes(24).toString('base64url');
    const allow = new Set((allowlist || []).map(d => String(d).toLowerCase().trim()).filter(Boolean));
    grants.set(token, {
        allow,
        expiresAt: Date.now() + ttlMs,
        toolName: toolName || 'unknown',
        userId: userId || null,
    });
    stats.granted++;
    return token;
}

function revokeGrant(token) {
    if (grants.delete(token)) stats.revoked++;
}

/** Return true if `host` (case-insensitive) matches any pattern on allowlist.
 *  Patterns may be exact ("example.com"), subdomain wildcards
 *  ("*.example.com" which matches foo.example.com, a.b.example.com), or
 *  the bare wildcard "*" (any public host — private/internal IPs still
 *  blocked by the resolvesPublicly check applied separately). */
function hostMatches(host, allow) {
    host = String(host).toLowerCase();
    if (allow.has('*')) return true;
    if (allow.has(host)) return true;
    for (const pat of allow) {
        if (pat.startsWith('*.')) {
            const suffix = pat.slice(1); // ".example.com"
            if (host.endsWith(suffix)) return true;
        }
    }
    return false;
}

function extractToken(req) {
    const hdr = req.headers['proxy-authorization'];
    if (!hdr || typeof hdr !== 'string') return null;
    // Preferred form — skills that control their own HTTP client (Python
    // `requests`, Node `https`) attach Bearer explicitly.
    const bearer = hdr.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1].trim();
    // Fallback: Basic auth from the proxy URL (git, curl, wget, and any
    // HTTP client that reads HTTPS_PROXY will encode as Basic). Accept
    // the token as either username or password — callers use
    //   HTTPS_PROXY=http://TOKEN@host:port          (user form)
    //   HTTPS_PROXY=http://:TOKEN@host:port         (password form)
    const basic = hdr.match(/^Basic\s+(.+)$/i);
    if (basic) {
        try {
            const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
            const idx = decoded.indexOf(':');
            if (idx < 0) return decoded.trim() || null;
            const user = decoded.slice(0, idx);
            const pass = decoded.slice(idx + 1);
            return (pass || user || '').trim() || null;
        } catch {
            return null;
        }
    }
    return null;
}

function checkGrant(token) {
    if (!token) return { ok: false, reason: 'no_token' };
    const g = grants.get(token);
    if (!g) return { ok: false, reason: 'bad_token' };
    if (g.expiresAt < Date.now()) {
        grants.delete(token);
        return { ok: false, reason: 'expired' };
    }
    return { ok: true, grant: g };
}

function deny(res, status, reason, detail) {
    try {
        res.writeHead(status, { 'Content-Type': 'text/plain', 'Connection': 'close' });
        res.end(`egress proxy: ${reason}${detail ? ' (' + detail + ')' : ''}\n`);
    } catch (_) { /* client gone */ }
}

// ---------------------------------------------------------------------------
// HTTP forward-proxy handler (plain HTTP)
// ---------------------------------------------------------------------------

async function onHttpRequest(req, res) {
    // Only absolute-form URLs are valid forward-proxy requests.
    let target;
    try { target = new url.URL(req.url); } catch { /* relative */ }
    if (!target || !target.host) {
        return deny(res, 400, 'bad_request', 'expected absolute URL');
    }

    const token = extractToken(req);
    const check = checkGrant(token);
    if (!check.ok) {
        stats[`rejected${check.reason === 'no_token' ? 'NoToken'
               : check.reason === 'bad_token' ? 'BadToken'
               : 'Expired'}`]++;
        return deny(res, 407, 'denied', check.reason);
    }
    const hostname = target.hostname;
    if (!hostMatches(hostname, check.grant.allow)) {
        stats.rejectedNotOnAllowlist++;
        return deny(res, 403, 'denied', `${hostname} not on allowlist`);
    }
    // Block private/internal targets (Docker-bridge IPs, RFC1918, link-local,
    // single-label hostnames, .local/.internal). Applies even on narrow
    // allowlists — defense in depth against DNS-rebinding or operator typos.
    if (!(await resolvesPublicly(hostname))) {
        stats.rejectedPrivateHost++;
        return deny(res, 403, 'denied', `${hostname} resolves to a private/internal address`);
    }

    // Strip Proxy-Authorization before forwarding.
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];

    const options = {
        host: hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.pathname + target.search,
        headers,
    };

    stats.allowed++;
    const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('error', err => {
        deny(res, 502, 'upstream_error', err.message);
    });
    req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// HTTPS CONNECT handler (tunnel)
// ---------------------------------------------------------------------------

async function onConnect(req, clientSocket, head) {
    const token = extractToken(req);
    const check = checkGrant(token);
    if (!check.ok) {
        stats[`rejected${check.reason === 'no_token' ? 'NoToken'
               : check.reason === 'bad_token' ? 'BadToken'
               : 'Expired'}`]++;
        // Include Proxy-Authenticate so clients (git, curl, wget) retry
        // with Basic creds pulled from the proxy URL. Without this they
        // give up immediately and never send Proxy-Authorization.
        clientSocket.write(
            'HTTP/1.1 407 Proxy Authentication Required\r\n' +
            'Proxy-Authenticate: Basic realm="sandbox-egress"\r\n' +
            'Connection: close\r\n\r\n',
        );
        clientSocket.destroy();
        return;
    }
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const hostname = (rawHost || '').toLowerCase();
    const port = parseInt(rawPort || '443', 10);
    if (!hostname) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.destroy();
        return;
    }
    if (!hostMatches(hostname, check.grant.allow)) {
        stats.rejectedNotOnAllowlist++;
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
    }
    // Resolve + private-network check. Done after the allowlist check so
    // a narrow allowlist still gets the protection (defense in depth) and
    // before we open a socket to the target — never even establish a TCP
    // connection to a private IP.
    if (!(await resolvesPublicly(hostname))) {
        stats.rejectedPrivateHost++;
        clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n' +
            `egress proxy: ${hostname} resolves to a private/internal address\n`);
        clientSocket.destroy();
        return;
    }
    stats.allowed++;
    const upstream = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    });
    upstream.on('error', err => {
        try { clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`); } catch (_) {}
        clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server = null;

function start() {
    if (server) return server;
    server = http.createServer(onHttpRequest);
    server.on('connect', onConnect);
    server.listen(PROXY_PORT, '0.0.0.0', () => {
        console.log(`[egressProxy] listening on 0.0.0.0:${PROXY_PORT}`);
    });

    // Periodically sweep expired grants so the map doesn't leak on long
    // uptimes where some tool runs never clean up (crashes, timeouts).
    setInterval(() => {
        const now = Date.now();
        for (const [tok, g] of grants) {
            if (g.expiresAt < now) grants.delete(tok);
        }
    }, 60_000).unref();

    return server;
}

function getStats() {
    return {
        ...stats,
        activeGrants: grants.size,
        listening: !!server,
        port: PROXY_PORT,
    };
}

module.exports = {
    start,
    issueGrant,
    revokeGrant,
    getStats,
    hostMatches,            // exported for tests
    isPrivateOrLocalIp,     // exported for tests + reuse
    isInternalLookingHost,  // exported for tests
    resolvesPublicly,       // exported for tests
    PROXY_PORT,
};
