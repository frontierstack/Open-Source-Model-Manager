/**
 * Scrapling Service - Node.js wrapper for Python Scrapling library
 * Provides captcha-evading web scraping with fallback to Playwright
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);
const { spawn } = require('child_process');
const http = require('http');

// Path to the Python script (cold-subprocess FALLBACK path)
const SCRAPLING_SCRIPT = path.join(__dirname, 'scrapling_fetch.py');

// ---------------------------------------------------------------------------
// Resident web engine (services/web_engine.py) — warm stealth browsers + a
// curl_cffi browser-impersonating HTTP layer + multi-backend search. Same
// lifecycle pattern as kb_engine: spawned lazily (and warmed at boot), finds
// its ephemeral port from the WEB_ENGINE_LISTENING line, one transparent
// respawn-and-retry on failure. Every caller below falls back to the old
// cold-subprocess path when the engine is unavailable, so nothing regresses.
// Set WEB_ENGINE_DISABLED=1 to force the legacy subprocess behaviour.
// ---------------------------------------------------------------------------
const ENGINE_SCRIPT = path.join(__dirname, 'web_engine.py');
const ENGINE_DISABLED = /^(1|true|yes)$/i.test(String(process.env.WEB_ENGINE_DISABLED || ''));
let engineProc = null;
let enginePort = null;
let startPromise = null;
let engineFailures = 0;          // consecutive spawn failures → back off
let engineBackoffUntil = 0;

function elog(...a) { console.log('[web-engine]', ...a); }

function spawnEngine() {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('python3', [ENGINE_SCRIPT], {
            env: { ...process.env, WEB_ENGINE_PORT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        engineProc = proc;
        let buf = '';
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                const m = /WEB_ENGINE_LISTENING\s+(\d+)/.exec(line);
                if (m && !settled) {
                    settled = true; enginePort = parseInt(m[1], 10); engineFailures = 0;
                    elog(`engine listening on 127.0.0.1:${enginePort}`);
                    resolve();
                } else if (line.trim()) elog(line.trim());
            }
        });
        proc.stderr.on('data', (d) => {
            // Scrapling's per-fetch INFO lines are noise; surface only our own + errors.
            const lines = d.toString().split('\n').map(x => x.trim()).filter(Boolean);
            for (const l of lines) if (/\[web_engine\]|ERROR|Traceback|Error/.test(l) && !/No Cloudflare challenge found/.test(l)) elog(l.slice(0, 300));
        });
        proc.on('exit', (code, sig) => {
            elog(`engine exited (code=${code} sig=${sig})`);
            if (engineProc === proc) { engineProc = null; enginePort = null; startPromise = null; }
            if (!settled) { settled = true; reject(new Error(`web_engine exited before listening (code=${code})`)); }
        });
        proc.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
        setTimeout(() => { if (!settled) { settled = true; reject(new Error('web_engine startup timed out')); } }, 60000);
    });
}

async function ensureEngine() {
    if (ENGINE_DISABLED) throw new Error('web engine disabled');
    if (engineProc && enginePort) return;
    if (Date.now() < engineBackoffUntil) throw new Error('web engine in backoff');
    if (!startPromise) {
        startPromise = spawnEngine().catch((e) => {
            startPromise = null;
            engineFailures++;
            engineBackoffUntil = Date.now() + Math.min(5 * 60 * 1000, 10000 * 2 ** Math.min(engineFailures, 5));
            throw e;
        });
    }
    await startPromise;
}

function engineRequest(pathName, bodyObj, { method = 'POST', timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
        const req = http.request({
            host: '127.0.0.1', port: enginePort, path: pathName, method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data || '{}');
                    if (res.statusCode >= 400 || json.ok === false) return reject(new Error(json.error || `engine ${res.statusCode}`));
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

// A request-level failure (engine crashed mid-call) gets ONE respawn + retry;
// an application-level failure (the site refused) is a normal result, not a throw.
async function engineCall(pathName, body, opts) {
    await ensureEngine();
    try {
        return await engineRequest(pathName, body, opts);
    } catch (e) {
        if (/timed out/.test(String(e.message))) throw e;   // a slow site is not a dead engine
        elog(`request ${pathName} failed (${e.message}); respawning engine`);
        try { if (engineProc) engineProc.kill('SIGKILL'); } catch (_) {}
        engineProc = null; enginePort = null; startPromise = null;
        await ensureEngine();
        return engineRequest(pathName, body, opts);
    }
}

function engineAvailable() { return !ENGINE_DISABLED && !!(engineProc && enginePort); }

/** Fire-and-forget boot warm-up so the first web call doesn't pay the spawn. */
function warmUp() {
    if (ENGINE_DISABLED) return;
    ensureEngine().then(() => engineRequest('/health', null, { method: 'GET', timeoutMs: 5000 }).catch(() => {}))
        .catch((e) => elog('warm-up failed:', e.message));
}

async function engineHealth() {
    await ensureEngine();
    return engineRequest('/health', null, { method: 'GET', timeoutMs: 5000 });
}

/**
 * curl_cffi browser-impersonating HTTP fetch — NO browser, ~0.3-0.6 s. Beats
 * TLS/JA3-fingerprint walls that 403 Node's axios (Cloudflare basic, Akamai,
 * most news/listing sites). Returns the engine's raw shape (httpStatus/headers/
 * bodyHead included) so the caller can classify a refusal.
 */
async function fetchImpersonated(url, options = {}) {
    const { timeout = 12000, extractLinks = false, profile = null, maxLength = 50000 } = options;
    try {
        const r = await engineCall('/fetch', {
            url, layer: 'impersonate', timeout, extractLinks, maxLength,
            ...(profile ? { impersonate: profile } : {}),
        }, { timeoutMs: timeout + 15000 });
        return r;
    } catch (e) {
        return { success: false, url, layer: 'impersonate', content: '', error: `engine: ${e.message}`, engineDown: true };
    }
}

/**
 * Check if Scrapling is available
 * @returns {Promise<boolean>}
 */
async function isScraplingAvailable() {
    try {
        await execFileAsync('python3', ['-c', 'import scrapling'], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Fetch a URL using Scrapling's anti-bot capabilities
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} - Result with content, title, links
 */
async function fetchUrl(url, options = {}) {
    const {
        headless = true,
        timeout = 30000,
        extractLinks = false
    } = options;

    // Warm stealth browser in the resident engine (1-3 s) instead of a cold
    // interpreter + browser launch per call (3.5-9 s). Falls through to the
    // subprocess below only when the engine itself is unavailable.
    if (!ENGINE_DISABLED && options.layer !== 'subprocess') {
        try {
            const r = await engineCall('/fetch', {
                url, layer: 'stealth', timeout, extractLinks,
                maxLength: options.maxLength || 50000, networkIdle: !!options.networkIdle,
            }, { timeoutMs: timeout + 60000 });
            return r;
        } catch (e) {
            elog(`stealth via engine failed (${e.message}); using cold subprocess for ${url}`);
        }
    }

    try {
        const args = [
            SCRAPLING_SCRIPT,
            '--action', 'fetch',
            '--url', url,
            '--timeout', timeout.toString()
        ];

        if (!headless) args.push('--headless', 'false');
        if (extractLinks) args.push('--extract-links');

        const { stdout, stderr } = await execFileAsync(
            'python3', args,
            {
                timeout: timeout + 10000, // Add buffer for process startup
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            }
        );

        if (stderr) {
            console.warn('[Scrapling] stderr:', stderr);
        }

        try {
            const result = JSON.parse(stdout.trim());
            return result;
        } catch (parseErr) {
            return {
                success: false,
                url,
                content: '',
                error: `Failed to parse Scrapling output: ${parseErr.message}`
            };
        }
    } catch (error) {
        console.error('[Scrapling] Fetch error:', error.message);
        return {
            success: false,
            url,
            content: '',
            error: error.message
        };
    }
}

/**
 * Perform a web search using Scrapling
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return
 * @returns {Promise<Object>} - Search results
 */
async function search(query, maxResults = 5, options = {}) {
    // Multi-backend impersonated search (ddg → bing → yahoo → brave) in the
    // resident engine, ~0.3-0.9 s. `options.engines` narrows the list (callers
    // skip backends they know are cooling down); `tried[]` reports per-engine
    // status so the caller can update its cooldown memos.
    if (!ENGINE_DISABLED && options.layer !== 'subprocess') {
        try {
            const r = await engineCall('/search', {
                query, limit: maxResults,
                ...(Array.isArray(options.engines) && options.engines.length ? { engines: options.engines } : {}),
                timeout: options.timeoutSec || 8,
            }, { timeoutMs: 45000 });
            return r;
        } catch (e) {
            elog(`search via engine failed (${e.message}); using cold subprocess`);
        }
    }
    try {
        const args = [
            SCRAPLING_SCRIPT,
            '--action', 'search',
            '--query', query,
            '--max-results', maxResults.toString()
        ];

        const { stdout, stderr } = await execFileAsync(
            'python3', args,
            {
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024
            }
        );

        if (stderr) {
            console.warn('[Scrapling] search stderr:', stderr);
        }

        try {
            const result = JSON.parse(stdout.trim());
            return result;
        } catch (parseErr) {
            return {
                success: false,
                query,
                results: [],
                error: `Failed to parse Scrapling output: ${parseErr.message}`
            };
        }
    } catch (error) {
        console.error('[Scrapling] Search error:', error.message);
        return {
            success: false,
            query,
            results: [],
            error: error.message
        };
    }
}

/**
 * Fetch URL with Scrapling, falling back to Playwright if needed
 * @param {string} url - URL to fetch
 * @param {Object} options - Options
 * @param {Object} playwrightService - Playwright service for fallback
 * @returns {Promise<Object>}
 */
async function fetchWithFallback(url, options = {}, playwrightService = null) {
    // Try Scrapling first
    const result = await fetchUrl(url, options);

    if (result.success && result.content && result.content.length >= 1500) {
        result.source = 'scrapling';
        return result;
    }

    // If Scrapling returned thin content or failed, try Playwright for better extraction
    if (playwrightService) {
        console.log('[Scrapling] Falling back to Playwright for:', url, result.content ? `(thin content: ${result.content.length} chars)` : '(no content)');
        try {
            const pwResult = await playwrightService.fetchUrlContent(url, {
                timeout: options.timeout || 15000,
                waitForJS: true,
                includeLinks: options.extractLinks || false
            });
            const pwContent = pwResult.content || '';
            const scrapContent = result.content || '';
            // Use whichever source got more content
            if (pwContent.length > scrapContent.length) {
                return {
                    success: true,
                    url,
                    content: pwContent,
                    title: pwResult.title || result.title || '',
                    links: pwResult.links || [],
                    source: 'playwright',
                    scraplingError: result.error
                };
            } else if (scrapContent.length > 0) {
                result.source = 'scrapling';
                return result;
            }
            return {
                success: pwContent.length > 0,
                url,
                content: pwContent,
                title: pwResult.title || '',
                links: pwResult.links || [],
                source: 'playwright',
                scraplingError: result.error
            };
        } catch (pwErr) {
            // If Scrapling had thin content, return it rather than nothing
            if (result.success && result.content) {
                result.source = 'scrapling';
                return result;
            }
            return {
                success: false,
                url,
                content: '',
                error: `Scrapling: ${result.error} | Playwright: ${pwErr.message}`,
                source: 'none'
            };
        }
    }

    return result;
}

module.exports = {
    isScraplingAvailable,
    fetchUrl,
    fetchImpersonated,
    search,
    fetchWithFallback,
    warmUp,
    engineHealth,
    engineAvailable,
};
