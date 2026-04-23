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
 *  Patterns may be exact ("example.com") or subdomain wildcards
 *  ("*.example.com" which matches foo.example.com, a.b.example.com). */
function hostMatches(host, allow) {
    host = String(host).toLowerCase();
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
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
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

function onHttpRequest(req, res) {
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

function onConnect(req, clientSocket, head) {
    const token = extractToken(req);
    const check = checkGrant(token);
    if (!check.ok) {
        stats[`rejected${check.reason === 'no_token' ? 'NoToken'
               : check.reason === 'bad_token' ? 'BadToken'
               : 'Expired'}`]++;
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
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
    hostMatches,  // exported for tests
    PROXY_PORT,
};
