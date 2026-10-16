/**
 * PlaywrightService - Advanced web scraping with bot detection avoidance
 *
 * Features:
 * - Browser pooling for fast reuse
 * - Stealth mode with fingerprint randomization (playwright-extra + stealth plugin)
 * - Headed mode with Xvfb for maximum anti-detection
 * - Smart content extraction (handles JS-rendered pages)
 * - Configurable timeouts and retry logic
 * - Graceful degradation on failures
 * - SSL inspection bypass for corporate proxy environments
 */

const { isNonContentUrl, isPlumbingPayload, unusableContentReason, looksOpaque } = require('./contentQuality');
const adBlock = require('./adBlock');
const paginationSvc = require('./pagination');

// Bot-protection / captcha vendors whose requests must pass UNTOUCHED — never
// aborted (a blocked challenge script is a wall) and never replayed through
// route.fetch() (which can break the handshake). Everything else that
// contentQuality's non-content filter names is analytics/ads → abortable.
const PROTECTION_HOST_RE = /(awswaf|aws-waf|datadome|perimeterx|px-cloud|px-cdn|hcaptcha|recaptcha|challenges\.cloudflare|turnstile|captcha-delivery|kasada|queue-it|arkoselabs|imperva|incapsula|cdn-cgi)/i;

/**
 * ONE request policy for every page this service opens: ads/trackers are
 * blocked (adBlock.isAdUrl — the domain list + URL shapes), bot-protection
 * passes untouched, optional resource types are aborted for speed, and XHR/
 * fetch JSON can be captured for the SPA enrichment. Blocking ads is also
 * what keeps the renderer responsive: the ad-refresh loops that peg a page's
 * main thread at 100% (the class the hard deadline exists for) never load.
 * Returns a stats object the caller can report (`adsBlocked`).
 */
async function installRequestPolicy(context, { blockTypes = [], captureJson = null, stats = null } = {}) {
    const st = stats || { adsBlocked: 0, typesBlocked: 0 };
    const blockSet = new Set(blockTypes);
    await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (PROTECTION_HOST_RE.test(url)) return route.continue();
        if (adBlock.isAdUrl(url)) { st.adsBlocked++; return route.abort('blockedbyclient').catch(() => {}); }
        const resourceType = req.resourceType();
        if (blockSet.has(resourceType)) { st.typesBlocked++; return route.abort().catch(() => {}); }
        if (captureJson && (resourceType === 'xhr' || resourceType === 'fetch')) {
            // Analytics/telemetry endpoints that survived the ad list are still
            // session plumbing — pass through, never capture.
            if (isNonContentUrl(url)) return route.continue();
            try {
                const response = await route.fetch();
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const body = await response.text();
                    if (body.length > 100 && body.length < 500000) {
                        try {
                            const json = JSON.parse(body);
                            // {token, next_interval, session…} — plumbing, not data.
                            if (!isPlumbingPayload(json)) captureJson.push({ url, data: json, size: body.length });
                        } catch (e) { /* Not valid JSON */ }
                    }
                }
                return route.fulfill({ response });
            } catch (e) {
                return route.continue().catch(() => {});
            }
        }
        return route.continue().catch(() => {});
    });
    return st;
}

// ============================================================================
// SSL INSPECTION BYPASS CONFIGURATION
// ============================================================================
// Check environment variable (set by docker-compose from build.sh detection)
const sslBypassEnabled = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

if (sslBypassEnabled) {
    console.log('[Playwright] SSL bypass enabled for corporate proxy environment');
}

// Use playwright-extra with stealth plugin for enhanced bot detection bypass
const { chromium: playwrightChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin with all evasions enabled
playwrightChromium.use(StealthPlugin());

// Export stealth-enabled chromium
const chromium = playwrightChromium;

// Headed-browser support was removed when getBrowser() was pinned to headless
// (see the comment there): `USE_HEADED_MODE` was assigned at require time and
// then never read by anything, so the Xvfb it started was pure overhead — a
// synchronous `which Xvfb` on the server's boot path plus a detached X server
// holding ~72 MB RSS for the process lifetime, verified running in the
// container with zero consumers. Stealth/anti-detection lives in
// scrapling_fetch (patchright + curl_cffi), not in a virtual display.

/**
 * Flatten a JSON object/array into human-readable text.
 * Used to extract meaningful data from intercepted SPA API responses.
 */
function flattenJsonToText(data, maxLength = 6000, prefix = '', depth = 0) {
    if (depth > 5 || !data) return '';
    let output = '';

    if (Array.isArray(data)) {
        for (let i = 0; i < Math.min(data.length, 20) && output.length < maxLength; i++) {
            const item = data[i];
            if (typeof item === 'object' && item !== null) {
                const attrs = item.attributes || item;
                if (typeof attrs === 'object') {
                    output += flattenJsonToText(attrs, maxLength - output.length, `  [${i}] `, depth + 1);
                }
            } else if (item !== null && item !== undefined) {
                output += `${prefix}${item}\n`;
            }
        }
        if (data.length > 20) output += `${prefix}... and ${data.length - 20} more items\n`;
    } else if (typeof data === 'object') {
        // For large objects with many similar entries (like scan results),
        // only show the interesting ones (non-default/non-undetected values)
        const entries = Object.entries(data);
        const isLargeHomogeneous = entries.length > 20 && entries.every(([, v]) => typeof v === 'object' && v !== null);

        if (isLargeHomogeneous) {
            // Filter to only show entries with interesting values (not undetected/clean/unrated)
            // Check known category/result/status fields specifically
            const boringValues = new Set(['undetected', 'clean', 'unrated', 'type-unsupported', 'harmless', 'confirmed-timeout']);
            const categoryKeys = new Set(['category', 'result', 'status', 'verdict']);
            const interestingEntries = entries.filter(([, v]) => {
                // Check category-like fields for non-boring values
                for (const [k, val] of Object.entries(v)) {
                    if (categoryKeys.has(k) && typeof val === 'string' && val.length > 0 && !boringValues.has(val)) {
                        return true;
                    }
                }
                return false;
            });

            if (interestingEntries.length > 0) {
                output += `${prefix}(${interestingEntries.length} of ${entries.length} entries with notable results):\n`;
                for (const [key, value] of interestingEntries.slice(0, 30)) {
                    if (output.length >= maxLength) break;
                    output += `${prefix}  ${key}: ${JSON.stringify(value)}\n`;
                }
            } else {
                output += `${prefix}(${entries.length} entries, all clean/undetected)\n`;
            }
        } else {
            for (const [key, value] of entries) {
                if (output.length >= maxLength) break;
                // Skip noisy/internal keys
                if (['links', 'meta', 'context_attributes', 'type', 'id'].includes(key) && depth > 0) continue;
                if (key.startsWith('_') || key === 'self') continue;

                if (value === null || value === undefined) continue;
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    const strVal = String(value);
                    // A long opaque value (a session token, a signed blob, an
                    // embedded base64 asset) is never something a reader wants,
                    // and 500 chars of it crowds out the content that is.
                    if (strVal.length >= 64 && looksOpaque(strVal, 32)) continue;
                    if (strVal.length > 0 && strVal.length < 2000) {
                        output += `${prefix}${key}: ${strVal.length > 500 ? strVal.slice(0, 500) + '...' : strVal}\n`;
                    }
                } else if (Array.isArray(value)) {
                    if (value.length > 0) {
                        output += `${prefix}${key} (${value.length} items):\n`;
                        output += flattenJsonToText(value, maxLength - output.length, prefix + '  ', depth + 1);
                    }
                } else if (typeof value === 'object') {
                    output += `${prefix}${key}:\n`;
                    output += flattenJsonToText(value, maxLength - output.length, prefix + '  ', depth + 1);
                }
            }
        }
    }
    return output.slice(0, maxLength);
}

// Browser pool management
let browserPool = [];
// Default 3 (unchanged). Operators on a larger host can raise it via
// PLAYWRIGHT_MAX_POOL to reduce serialization under the find_image/find_video/
// sniff fan-outs (which can request 4-12 pages). Default is deliberately NOT
// bumped — headless-chromium peak RSS isn't predictable from a launch-time
// check, so a silent raise risks OOM next to the model containers.
const MAX_POOL_SIZE = Math.max(1, parseInt(process.env.PLAYWRIGHT_MAX_POOL, 10) || 3);
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Hard deadline on every page function. Playwright bounds navigation and
// actions, but `page.evaluate` / `page.title` / `page.screenshot` wait on the
// page's MAIN THREAD with no timeout at all — a page whose renderer never
// yields (an ad-refresh / anti-adblock loop pegging the CPU at 100%: the
// macrotrends.net gas-price page, 2026-09-08) stalled a chat turn for 9+
// minutes with nothing in the log until the browser was killed by hand. A
// lease is armed at the top of each page function; when it expires it closes
// the browser context, which rejects every pending page op with "Target
// closed", and the function's catch maps that to a clear deadline message via
// lease.errorOf(). getBrowser(lease) also stops waiting for a pool slot once
// the lease is spent, so hung pages can never starve later callers forever.
const PLAYWRIGHT_HARD_DEADLINE_MS = Math.max(15000, parseInt(process.env.PLAYWRIGHT_HARD_DEADLINE_MS, 10) || 75000);
function hardDeadlineFor(timeout, extraMs = 0) {
    return Math.max(PLAYWRIGHT_HARD_DEADLINE_MS, (parseInt(timeout, 10) || 0) * 3) + Math.max(0, parseInt(extraMs, 10) || 0);
}
function armDeadline(label, url, ms) {
    const lease = { label, url, ms, context: null, expired: false, reason: null, timer: null, startedAt: Date.now() };
    lease.timer = setTimeout(() => {
        lease.timer = null;
        lease.expired = true;
        lease.reason = `${label}: hard deadline of ${ms}ms exceeded for ${url} — the page never yielded (renderer busy or a request that never completes); browser context closed`;
        console.log(`[Playwright] ${lease.reason}`);
        if (lease.context) { try { lease.context.close().catch(() => {}); } catch (_) { /* already gone */ } }
    }, ms);
    lease.clear = () => { if (lease.timer) { clearTimeout(lease.timer); lease.timer = null; } };
    lease.errorOf = (error) => lease.expired ? lease.reason : ((error && error.message) || String(error));
    return lease;
}

let poolCleanupInterval = null;

// Stealth configuration - rotated per request
// A coherent Windows-Chromium fingerprint. EVERY other signal we spoof — the
// Sec-Ch-Ua client-hints, navigator.platform='Win32', vendor='Google Inc.',
// window.chrome, the WebGL ANGLE/Direct3D renderer, and navigator.userAgentData —
// is Windows-Chrome, so the UA pool must be too. A Firefox/Safari/Mac/Linux UA
// paired with Chromium client-hints + Win32 platform (the previous mixed pool) is
// an instant bot tell. A few recent majors keep rotation entropy; the client-hints
// are DERIVED from the chosen UA (see getStealthContextOptions) so they never drift.
// The stealth plugin rewrites navigator.userAgent to the REAL bundled Chromium
// version, so a hardcoded UA major would disagree with the JS UA (and userAgentData)
// — a header-vs-JS version mismatch that Cloudflare/DataDome cross-check. So the
// major is detected from the launched browser at runtime (see getBrowser) and only
// falls back to STEALTH_CHROME_MAJOR before the first launch.
const STEALTH_CHROME_MAJOR = parseInt(process.env.STEALTH_CHROME_MAJOR, 10) || 131;
let detectedChromeMajor = null;
function stealthChromeMajor() { return detectedChromeMajor || String(STEALTH_CHROME_MAJOR); }
function windowsChromeUA(major) {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 }
];

// Pin to en-US so navigator.language, navigator.languages, and the hardcoded
// Accept-Language header all agree (a rotating locale against a fixed en-US
// Accept-Language is a mismatch). Timezones are US-only for the same reason —
// Europe/London contradicted the en-US / US-Windows persona.
const LOCALES = ['en-US'];
const TIMEZONES = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver'];

/**
 * Get a random element from an array
 */
function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Random delay to simulate human behavior
 */
function randomDelay(min = 50, max = 200) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate stealth browser context options
 */
function getStealthContextOptions() {
    const viewport = randomChoice(VIEWPORTS);
    // Build the UA from the REAL browser major (detected at launch) so the HTTP-header
    // UA, navigator.userAgent (stealth-plugin-corrected to the real version), the
    // Sec-Ch-Ua client-hint, and userAgentData all report the SAME Windows-Chrome
    // version — no header-vs-JS mismatch.
    const chromeMajor = stealthChromeMajor();
    const userAgent = windowsChromeUA(chromeMajor);
    const options = {
        userAgent: userAgent,
        viewport: viewport,
        screen: viewport,
        locale: randomChoice(LOCALES),
        timezoneId: randomChoice(TIMEZONES),
        deviceScaleFactor: Math.random() > 0.5 ? 1 : 2,
        hasTouch: false,
        isMobile: false,
        javaScriptEnabled: true,
        permissions: ['geolocation'],
        colorScheme: Math.random() > 0.5 ? 'light' : 'dark',
        extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Ch-Ua': `"Chromium";v="${chromeMajor}", "Not(A:Brand";v="24", "Google Chrome";v="${chromeMajor}"`,
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        }
    };

    // Always tolerate bad certificates. This is a READ-ONLY scraper that never
    // sends credentials, and the pages worth inspecting (OSINT / phishing /
    // freshly-registered sites) routinely have a self-signed, expired or
    // mismatched cert — a hard ERR_CERT_AUTHORITY_INVALID on every browser
    // mode (read/interact/screenshot) sent a model into 4 failed retries and
    // no screenshot. The corporate-proxy case (sslBypassEnabled) is subsumed.
    options.ignoreHTTPSErrors = true;

    return options;
}

/**
 * Apply stealth patches to page - Enhanced for VirusTotal/FOFA bypass
 */
async function applyStealthPatches(page) {
    await page.addInitScript(() => {
        // Override webdriver detection - comprehensive
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        delete navigator.__proto__.chromeHeadless;
        delete navigator.__proto__.phantom;

        // Hide process/global objects (Node.js detection)
        if (typeof globalThis !== 'undefined') {
            delete globalThis.process;
            delete globalThis.global;
        }

        // Chrome runtime - more complete mock
        window.chrome = {
            runtime: {
                connect: () => {},
                sendMessage: () => {},
                onMessage: { addListener: () => {} }
            },
            loadTimes: function() { return { commitLoadTime: Date.now() / 1000 }; },
            csi: function() { return { startE: Date.now(), onloadT: Date.now() }; },
            app: { isInstalled: false, InstallState: { DISABLED: 'disabled' } }
        };

        // Permissions API - comprehensive
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );

        // Plugin array with length property
        const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ];
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const pluginArray = Object.assign(plugins, { length: plugins.length });
                pluginArray.item = (i) => plugins[i];
                pluginArray.namedItem = (name) => plugins.find(p => p.name === name);
                pluginArray.refresh = () => {};
                return pluginArray;
            }
        });

        // Languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

        // Platform - consistent with Windows
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

        // userAgentData — align with the Windows-Chrome persona. Headless Chromium on
        // a Linux host otherwise reports platform:'Linux' + the real engine major here,
        // contradicting navigator.platform / Sec-Ch-Ua-Platform / the UA string. Derive
        // everything from the (already-spoofed) UA so all client-hint surfaces agree.
        try {
            if (navigator.userAgentData) {
                const _major = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '131';
                const _brands = [
                    { brand: 'Chromium', version: _major },
                    { brand: 'Google Chrome', version: _major },
                    { brand: 'Not(A:Brand', version: '24' },
                ];
                const _fullVersion = `${_major}.0.0.0`;
                const _uaData = {
                    brands: _brands,
                    mobile: false,
                    platform: 'Windows',
                    getHighEntropyValues: (hints) => Promise.resolve({
                        architecture: 'x86',
                        bitness: '64',
                        brands: _brands,
                        fullVersionList: _brands.map(b => ({ brand: b.brand, version: b.brand === 'Not(A:Brand' ? '24.0.0.0' : _fullVersion })),
                        mobile: false,
                        model: '',
                        platform: 'Windows',
                        platformVersion: '15.0.0',
                        uaFullVersion: _fullVersion,
                        wow64: false,
                    }),
                    toJSON: function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
                };
                Object.defineProperty(navigator, 'userAgentData', { get: () => _uaData, configurable: true });
            }
        } catch (e) { /* userAgentData unsupported — nothing to align */ }

        // Hardware concurrency (randomize slightly)
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 4 + Math.floor(Math.random() * 5)
        });

        // Device memory
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // WebGL vendor/renderer - randomize slightly
        // Windows Chrome renders through ANGLE/Direct3D11 — the unmasked renderer is
        // an "ANGLE (...Direct3D11...)" string, NOT the macOS-style "Intel Iris OpenGL
        // Engine" (which contradicted the Windows persona and was itself a tell).
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Google Inc. (Intel)';
            if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter.apply(this, arguments);
        };

        // WebGL2 support
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParam2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Google Inc. (Intel)';
                if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParam2.apply(this, arguments);
            };
        }

        // Notification permission
        if (typeof Notification !== 'undefined') {
            Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        }

        // Connection type - realistic values
        if (navigator.connection) {
            Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
            Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
            Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
            Object.defineProperty(navigator.connection, 'saveData', { get: () => false });
        }

        // Canvas fingerprinting protection - add slight noise
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(...args) {
            const imageData = origGetImageData.apply(this, args);
            // Add minimal noise to prevent fingerprinting
            for (let i = 0; i < imageData.data.length; i += 100) {
                imageData.data[i] = imageData.data[i] ^ (Math.random() > 0.5 ? 1 : 0);
            }
            return imageData;
        };

        // Touch / pointer — a desktop browser (hasTouch:false) reports 0 touch
        // points; a non-zero value with isMobile:false is inconsistent.
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

        // PDF viewer present (real desktop Chrome). Its absence is a headless tell.
        try { Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true }); } catch (e) {}

        // mimeTypes consistent with the spoofed plugins (length 0 alongside
        // non-empty plugins is itself suspicious).
        try {
            const mimeTypes = [
                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            ];
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const arr = Object.assign(mimeTypes.slice(), { length: mimeTypes.length });
                    arr.item = (i) => mimeTypes[i];
                    arr.namedItem = (name) => mimeTypes.find(m => m.type === name);
                    return arr;
                },
            });
        } catch (e) {}

        // Headless Chromium leaves window.outer*/screenX/screenY at 0 — one of
        // the strongest, easiest tells. Mirror inner size + typical chrome.
        try {
            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
            Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
            Object.defineProperty(window, 'screenX', { get: () => 0 });
            Object.defineProperty(window, 'screenY', { get: () => 0 });
        } catch (e) {}

        // Screen properties
        Object.defineProperty(screen, 'availWidth', { get: () => screen.width });
        Object.defineProperty(screen, 'availHeight', { get: () => screen.height - 40 });

        // Disable WebRTC IP leak
        let _rtcPatched = null;
        if (typeof RTCPeerConnection !== 'undefined') {
            const origRTC = RTCPeerConnection;
            _rtcPatched = function(...args) {
                const pc = new origRTC(...args);
                pc.createDataChannel = () => ({});
                return pc;
            };
            window.RTCPeerConnection = _rtcPatched;
        }

        // Native-code masking — make fn.toString() return
        // "function NAME() { [native code] }" for EVERY function we replaced
        // (not just permissions.query). A detector that calls
        // WebGLRenderingContext.prototype.getParameter.toString() or
        // Function.prototype.toString.toString() would otherwise see our JS
        // source and flag the browser as instrumented.
        const _origToString = Function.prototype.toString;
        const _masked = new WeakMap();
        const _mask = (fn, name) => {
            if (typeof fn === 'function') {
                try { _masked.set(fn, 'function ' + name + '() { [native code] }'); } catch (e) {}
            }
        };
        _mask(navigator.permissions.query, 'query');
        try { _mask(WebGLRenderingContext.prototype.getParameter, 'getParameter'); } catch (e) {}
        try { _mask(WebGL2RenderingContext.prototype.getParameter, 'getParameter'); } catch (e) {}
        try { _mask(CanvasRenderingContext2D.prototype.getImageData, 'getImageData'); } catch (e) {}
        if (_rtcPatched) _mask(_rtcPatched, 'RTCPeerConnection');
        const _newToString = function () {
            if (_masked.has(this)) return _masked.get(this);
            return _origToString.apply(this, arguments);
        };
        _mask(_newToString, 'toString');
        Object.defineProperty(Function.prototype, 'toString', { value: _newToString, configurable: true, writable: true });
    });
}

/**
 * Get or create a browser from the pool
 */
async function getBrowser(lease = null) {
    // Try to get an available browser from pool. `browser` is null while an entry
    // is still launching (see the slot reservation below), so guard the isConnected
    // call — a reserved slot is never handed out.
    const availableBrowser = browserPool.find(b => !b.inUse && b.browser && b.browser.isConnected());
    if (availableBrowser) {
        availableBrowser.inUse = true;
        availableBrowser.lastUsed = Date.now();
        return availableBrowser;
    }

    // Create new browser if pool not full
    if (browserPool.length < MAX_POOL_SIZE) {
        // Reserve the slot SYNCHRONOUSLY, before the await. The length check and
        // the push used to straddle `await chromium.launch()`, so concurrent
        // callers all measured the same stale length and all launched — the pool
        // could exceed MAX_POOL_SIZE by however many arrived in that window, at
        // ~150-250 MB of RSS per surplus Chromium. The parallel find_image /
        // crawl paths issue exactly that burst.
        const poolEntry = {
            browser: null,
            inUse: true,
            lastUsed: Date.now(),
            createdAt: Date.now(),
        };
        browserPool.push(poolEntry);
        try {
        // Always launch headless. The previous boot-time Xvfb spawn could die
        // silently — stdio: 'ignore' swallows any crash — leaving the headed flag
        // cached as true while no X server was actually serving. The result was:
        // every chromium launch died with "Missing X server or $DISPLAY" and the
        // chat's playwright_fetch path was completely broken. Stealth/anti-
        // detection lives in scrapling_fetch (patchright + curl_cffi);
        // playwright_fetch is the simple JS-render path and headless is fine.
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-web-security',
                '--disable-features=CrossSiteDocumentBlockingIfIsolating',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--start-maximized',
                '--disable-infobars',
                '--disable-extensions',
                '--disable-plugins-discovery',
                '--disable-default-apps',
                '--no-first-run',
                '--no-default-browser-check',
                // Additional anti-detection flags
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-component-extensions-with-background-pages',
                '--disable-component-update',
                '--disable-domain-reliability',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--enable-features=NetworkService,NetworkServiceInProcess',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--password-store=basic',
                '--use-mock-keychain',
            ]
        });

        // Detect the REAL Chromium major so the spoofed UA/client-hints match the
        // version the stealth plugin puts in navigator.userAgent (avoids a header-vs-JS
        // version mismatch). browser.version() → e.g. "145.0.7632.6".
        if (!detectedChromeMajor) {
            try { const m = String(browser.version() || '').match(/(\d+)\./); if (m) detectedChromeMajor = m[1]; } catch (e) { /* keep fallback */ }
        }

        poolEntry.browser = browser;
        startPoolCleanup();

        return poolEntry;
        } catch (launchErr) {
            // Launch failed — give the reserved slot back so the pool doesn't
            // permanently shrink after a transient failure.
            const i = browserPool.indexOf(poolEntry);
            if (i >= 0) browserPool.splice(i, 1);
            throw launchErr;
        }
    }

    // Wait for an available browser — but not past the caller's deadline: with
    // every pool slot held by a hung page this used to poll forever.
    if (lease && lease.expired) throw new Error(lease.reason || 'browser pool wait exceeded the hard deadline');
    await new Promise(resolve => setTimeout(resolve, 100));
    return getBrowser(lease);
}

/**
 * Release a browser back to the pool
 */
function releaseBrowser(poolEntry) {
    poolEntry.inUse = false;
    poolEntry.lastUsed = Date.now();
}

/**
 * Start pool cleanup interval
 */
function startPoolCleanup() {
    if (poolCleanupInterval) return;

    poolCleanupInterval = setInterval(async () => {
        const now = Date.now();
        const toRemove = [];

        // Identify browsers to remove
        for (let i = browserPool.length - 1; i >= 0; i--) {
            const entry = browserPool[i];
            if (!entry.inUse && (now - entry.lastUsed > BROWSER_IDLE_TIMEOUT || !entry.browser.isConnected())) {
                toRemove.push({ index: i, entry });
            }
        }

        // Close browsers in parallel for faster cleanup
        if (toRemove.length > 0) {
            await Promise.allSettled(
                toRemove.map(async ({ entry }) => {
                    try {
                        await entry.browser.close();
                    } catch (e) {}
                })
            );

            // Remove from pool (in reverse order to maintain indices)
            for (const { index } of toRemove.sort((a, b) => b.index - a.index)) {
                browserPool.splice(index, 1);
            }
        }

        if (browserPool.length === 0) {
            clearInterval(poolCleanupInterval);
            poolCleanupInterval = null;
        }
    }, 60000); // Check every minute
}

/**
 * Extract readable content from a page
 */
async function extractContent(page, options = {}) {
    const { includeLinks = false, maxLength = 8000, linkFilter = null, find = null } = options;

    const adArgs = { tokenSrc: adBlock.AD_TOKEN_RE.source, idPrefixSrc: adBlock.AD_ID_PREFIX_RE.source, attrSelectors: adBlock.AD_ATTR_SELECTORS };
    try {
        return await extractContentInner(page, { includeLinks, maxLength, adArgs, linkFilter, find });
    } finally {
        // Put back what the extractor detached (not iframes — re-inserting one
        // reloads it; they were never restored before either).
        await page.evaluate(() => {
            const list = window.__msDetached || [];
            for (let i = list.length - 1; i >= 0; i--) {
                const [marker, el] = list[i];
                if (!marker.isConnected) continue;
                if (el.tagName === 'IFRAME') marker.remove(); else marker.replaceWith(el);
            }
            window.__msDetached = [];
        }).catch(() => {});
    }
}

async function extractContentInner(page, { includeLinks, maxLength, adArgs, linkFilter, find }) {
    return await page.evaluate(({ includeLinks, maxLength, adArgs, linkFilter, find }) => {
        // Ad slots first — only elements that DECLARE themselves ads (id/class
        // TOKENS, data-ad-* attributes), and never one holding a large share of
        // the page text (a content column named "sponsored" is content). Whole
        // tokens only: a substring test on "ad" would strip "header"/"read".
        {
            const TOKEN = new RegExp(adArgs.tokenSrc, 'i');
            const IDPFX = new RegExp(adArgs.idPrefixSrc, 'i');
            const bodyLen = ((document.body && document.body.innerText) || '').length || 1;
            const declares = (el) => {
                const id = el.id || '';
                if (id && (TOKEN.test(id) || IDPFX.test(id))) return true;
                const cls = typeof el.className === 'string' ? el.className : '';
                if (!cls) return false;
                for (const t of cls.split(/\s+/)) if (t && TOKEN.test(t)) return true;
                return false;
            };
            const victims = new Set();
            try { document.querySelectorAll(adArgs.attrSelectors.join(',')).forEach(el => victims.add(el)); } catch (_) {}
            document.querySelectorAll('div, section, aside, ins, span, li, figure, iframe').forEach(el => { if (declares(el)) victims.add(el); });
            for (const el of victims) {
                if (!el.isConnected) continue;
                if (((el.innerText || '').length) / bodyLen > 0.4) continue;
                el.remove();
            }
        }
        // Snapshot provider <iframe> video embeds (YouTube/Vimeo/etc.) BEFORE the
        // cleanup below strips all iframes — otherwise the video harvest further
        // down can never see them.
        const EMBED_HOST = /(youtube\.com\/embed|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|vimeo\.com\/video|dailymotion\.com\/embed|geo\.dailymotion\.com|player\.twitch\.tv|facebook\.com\/plugins\/video|streamable\.com\/[eo]\/|wistia|brightcove|jwplayer|kaltura)/i;
        const embedIframeSrcs = [];
        document.querySelectorAll('iframe[src]').forEach(f => {
            const s = f.getAttribute('src') || '';
            if (EMBED_HOST.test(s)) { try { embedIframeSrcs.push(new URL(s, location.href).href); } catch (_) {} }
        });

        // Remove unwanted elements
        const removeSelectors = [
            'script', 'style', 'noscript', 'iframe', 'svg',
            'nav', 'footer', 'header', 'aside',
            '.ad', '.ads', '.advertisement', '.sidebar',
            '.cookie-banner', '.popup', '.modal',
            '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
            '.social-share', '.comments', '.related-posts'
        ];

        // Detach REVERSIBLY: the caller restores these after reading, so the
        // page stays usable — a crawl or an interact run that reads a page and
        // then clicks "Next" used to find the pager (a <nav>) deleted.
        window.__msDetached = [];
        removeSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (!el.isConnected) return;
                const marker = document.createComment('ms-detached');
                el.replaceWith(marker);
                window.__msDetached.push([marker, el]);
            });
        });

        // Get title
        const title = document.title || document.querySelector('h1')?.textContent?.trim() || '';

        // Get meta description
        const metaDesc = document.querySelector('meta[name="description"]')?.content ||
                         document.querySelector('meta[property="og:description"]')?.content || '';

        // Get main content area - check specific article body selectors first
        // (Blogger, WordPress, news sites), then the semantic landmarks.
        //
        // The pick is SIZE-CHECKED, not first-match. These selectors assume the
        // element wraps the whole article, which holds on a news/blog POST but not
        // on a listing: an activity feed, a model/product grid, a search-results or
        // blog INDEX page wraps EACH CARD in its own <article>, so first-match
        // grabbed one ~40-character row and every extraction step below then
        // queried inside that single row — discarding the entire page. (Live case:
        // a HuggingFace activity feed with 20 <article> cards extracted 57 chars,
        // which made the caller fall back to publishing captured bot-telemetry as
        // the page.) A candidate that holds well under half the body text is a
        // fragment, not the content, so it loses to the landmark elements.
        const CONTENT_SELECTORS = [
            '.post-body', '.articlebody', '.post-body-container', '[itemprop="articleBody"]',
            '.story-body', '.storycontent', '.entry-content', '.be__contents',
            '.be__contents-wrapper', '.blog-contents', '.section--article',
            'article', 'main', '[role="main"]', '.content', '.article', '.post',
        ];
        const bodyTextLen = (document.body?.innerText || '').length;
        let mainContent = document.body;
        for (const sel of CONTENT_SELECTORS) {
            const els = document.querySelectorAll(sel);
            if (!els.length) continue;
            // Repeated <article> = one per card. The page is their container, not
            // any single one of them.
            if (sel === 'article' && els.length > 1) continue;
            const len = (els[0].innerText || '').length;
            if (len >= 200 && (!bodyTextLen || len >= bodyTextLen * 0.4)) {
                mainContent = els[0];
                break;
            }
        }

        // Extract headings
        const headings = [];
        mainContent.querySelectorAll('h1, h2, h3').forEach(h => {
            const text = h.textContent?.trim();
            if (text && text.length > 2 && text.length < 200) {
                headings.push(text);
            }
        });

        // Extract paragraphs from multiple element types (not just p/li)
        const paragraphs = [];
        const seenText = new Set();
        mainContent.querySelectorAll('p, li, td, th, dd, dt, blockquote, pre, figcaption, [class*="description"], [class*="content"], [class*="detail"], [class*="result"], [class*="detection"], [class*="info"], [class*="summary"], [class*="value"], [class*="label"]').forEach(el => {
            const text = el.textContent?.trim()
                .replace(/\s+/g, ' ')
                .replace(/\n+/g, ' ');
            if (text && text.length > 20 && !seenText.has(text)) {
                seenText.add(text);
                paragraphs.push(text);
            }
        });

        // Links (want:"links" / find). The old harvest read only the detected
        // main region, kept relative hrefs, and the renderer then emitted the
        // FIRST TEN — appended after the text, i.e. usually cut off entirely by
        // the char budget. Live (2026-09-09): a 430-link policy directory came
        // back with zero links, the model guessed the policy's URL from its
        // number, and spent 24 calls on the guess. Now: the whole document,
        // absolute hrefs, de-duplicated, content links before nav/footer
        // links, an optional filter (`linkFilter`/`find`: case-insensitive,
        // alternatives separated by |, matched on link text AND URL), and a
        // reserved share of the budget rendered at the very end.
        const splitTerms = (v) => String(v || '').split('|').map(t => t.trim().toLowerCase()).filter(t => t.length >= 2);
        const findTerms = splitTerms(find);
        const linkTerms = splitTerms(linkFilter || find);
        const links = [];
        let linksTotal = 0, linksMatched = 0;
        if (includeLinks) {
            const NAVISH = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], .breadcrumb, .breadcrumbs, [class*="cookie"], [id*="cookie"]';
            const seenHref = new Set();
            document.querySelectorAll('a[href]').forEach(a => {
                let href = '';
                try { href = a.href; } catch (_) { href = ''; }
                if (!href || !/^https?:/i.test(href)) return;
                href = href.replace(/#.*$/, '');
                if (!href || seenHref.has(href)) return;
                let text = (a.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) text = (a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
                if (!text) { const im = a.querySelector('img[alt]'); if (im) text = (im.getAttribute('alt') || '').replace(/\s+/g, ' ').trim(); }
                if (!text) return;
                seenHref.add(href);
                linksTotal++;
                if (linkTerms.length) {
                    let hay;
                    try { hay = (text + ' ' + decodeURIComponent(href)).toLowerCase(); } catch (_) { hay = (text + ' ' + href).toLowerCase(); }
                    if (!linkTerms.some(t => hay.includes(t))) return;
                    linksMatched++;
                }
                let navish = false;
                try { navish = !!a.closest(NAVISH); } catch (_) { navish = false; }
                links.push({ text: text.substring(0, 100), href, navish });
            });
            // Stable: document order within each group, content links first.
            if (!linkTerms.length) links.sort((a, b) => (a.navish === b.navish ? 0 : (a.navish ? 1 : -1)));
        }
        // With links (or a find) requested, the prose gets a smaller share of
        // the budget so the part the caller asked for is never the part cut.
        const textBudget = (includeLinks && (links.length || linkTerms.length))
            ? Math.floor(maxLength * (linkTerms.length ? 0.55 : 0.45))
            : maxLength;

        // Extract table data (important for sites like VirusTotal)
        const tables = [];
        mainContent.querySelectorAll('table').forEach(table => {
            const rows = [];
            table.querySelectorAll('tr').forEach(tr => {
                const cells = [];
                tr.querySelectorAll('td, th').forEach(cell => {
                    const text = cell.textContent?.trim().replace(/\s+/g, ' ');
                    if (text) cells.push(text);
                });
                if (cells.length > 0) rows.push(cells.join(' | '));
            });
            if (rows.length > 0) tables.push(rows.join('\n'));
        });

        // Repeated cards / list items → ONE LINE EACH.
        //
        // A feed, activity list, release list, job board or product grid keeps
        // every entry in its own <article>/<li>, but innerText runs them together
        // into one unbroken paragraph. That costs any line-oriented consumer its
        // precision: a change monitor watching such a page can only say "the whole
        // page differs" when a single new entry appears, and whatever reads the
        // diff then has to re-derive which entry is new. One line per entry makes
        // a new entry exactly one added line.
        const cardItems = [];
        {
            let group = null;
            const arts = document.querySelectorAll('article');
            if (arts.length > 1) group = arts;
            else {
                const lis = document.querySelectorAll('main li, [role="list"] > [role="listitem"], main ul > li');
                if (lis.length > 2) group = lis;
            }
            const seenCard = new Set();
            for (const el of (group || [])) {
                const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                // The card's own link IS its identity — on many feeds the visible
                // text is just metadata ("Text-to-Video • Updated 2 hours ago") and
                // the name lives only in the permalink, so without it every card
                // reads identically and a new entry is indistinguishable.
                const a = el.querySelector('a[href]');
                let href = '';
                if (a) {
                    href = a.getAttribute('href') || '';
                    try { href = new URL(href, location.href).pathname; } catch (_) {}
                }
                const line = href ? `${href}${t ? ' — ' + t : ''}` : t;
                if (line.length < 12 || line.length > 400 || seenCard.has(line)) continue;
                seenCard.add(line);
                cardItems.push(line);
                if (cardItems.length >= 60) break;
            }
        }

        // Extract image captions + per-image links. Image-heavy pages
        // (Instagram, Pinterest, photo galleries) carry their per-image TEXT in
        // the <img alt> accessibility caption and the post/permalink on the
        // wrapping <a> — an image-only feed has almost no <p> content, so
        // without this the extractor returns a near-empty page. Scan the whole
        // document (tiles often sit outside the detected main region) and drop
        // decorative/sprite alts.
        const imageItems = [];
        const seenAlt = new Set();
        const ALT_DECOR = /^(image|photo|picture|logo|icon|avatar|thumbnail)$|sprite|placeholder|spinner|loading|profile picture|may be an image of nothing/i;
        document.querySelectorAll('img[alt]').forEach(img => {
            const alt = (img.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
            if (!alt || alt.length < 10 || ALT_DECOR.test(alt) || seenAlt.has(alt)) return;
            // Skip sub-icon images (avatars, inline glyphs, tracking pixels) —
            // they carry alts like "Go to X's profile" that aren't page content.
            const rect = img.getBoundingClientRect();
            const w = img.naturalWidth || rect.width;
            const h = img.naturalHeight || rect.height;
            if ((w && w < 64) || (h && h < 64)) return;
            seenAlt.add(alt);
            const a = img.closest('a[href]');
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            imageItems.push({ alt, link: a ? a.href : '', src });
        });

        // Extract video sources + provider embeds from the rendered DOM. A
        // page's playable video is a <video>/<source> file, a provider <iframe>
        // player (YouTube/Vimeo/Dailymotion/etc.), or an og:video — JS injects
        // these after load, so a static fetch misses them entirely. Surfacing
        // the real url here lets the model hand it straight to find_video
        // instead of eyeballing raw HTML.
        const videoItems = [];
        const seenVid = new Set();
        const addVid = (u, kind) => {
            if (!u) return;
            let abs; try { abs = new URL(u, location.href).href; } catch (_) { return; }
            if (!/^https?:/i.test(abs) || seenVid.has(abs)) return;
            seenVid.add(abs); videoItems.push({ url: abs, kind });
        };
        document.querySelectorAll('video[src]').forEach(v => addVid(v.getAttribute('src') || v.currentSrc, 'file'));
        document.querySelectorAll('video source[src]').forEach(s => addVid(s.getAttribute('src'), 'file'));
        embedIframeSrcs.forEach(s => addVid(s, 'embed'));   // provider iframes snapshotted pre-cleanup
        const ogv = document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]');
        if (ogv) addVid(ogv.getAttribute('content'), 'og:video');

        // Build output
        let output = '';

        if (title) {
            output += `Title: ${title}\n\n`;
        }

        if (metaDesc) {
            output += `Summary: ${metaDesc}\n\n`;
        }
        // Everything above is page metadata, present on every page whether or not
        // the extraction actually worked. The rescue below must judge itself
        // against the REAL content it produced, not against this preamble.
        const preambleLen = output.length;

        if (headings.length > 0) {
            output += 'Key Points:\n';
            headings.slice(0, 8).forEach(h => {
                output += `- ${h}\n`;
            });
            output += '\n';
        }

        const itemsSection = cardItems.length > 1
            ? 'Items:\n' + cardItems.map(t => `- ${t}`).join('\n') + '\n\n'
            : '';
        if (itemsSection) output += itemsSection;

        // `find`: the ctrl-F view. The lines of the page's text that mention
        // the term (with one line of context each) go FIRST, so a long
        // index/directory page answers "where is item X" in one read.
        const findSection = (() => {
            if (!findTerms.length) return '';
            const src = (document.body && document.body.innerText) || '';
            const lines = src.split('\n').map(l => l.replace(/\s+/g, ' ').trim());
            const hit = (l) => { const x = l.toLowerCase(); return findTerms.some(t => x.includes(t)); };
            const keep = new Set();
            let matches = 0;
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i] || !hit(lines[i])) continue;
                matches++;
                for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) if (lines[j]) keep.add(j);
                if (matches >= 40) break;
            }
            if (!matches) {
                return `Matches for "${find}" in the page text: none — no line of this page's text mentions it` +
                    (lines.some(Boolean) ? '' : ' (the page text is empty)') +
                    '. Check the Links section, or try a different spelling / a shorter term.\n\n';
            }
            const budget = Math.floor(maxLength * 0.4);
            let sec = `Matches for "${find}" in the page text (${matches}${matches >= 40 ? '+' : ''}):\n`;
            let last = -2;
            for (const j of [...keep].sort((a, b) => a - b)) {
                if (sec.length > budget) { sec += '  …\n'; break; }
                if (j !== last + 1) sec += '  ---\n';
                sec += `  ${hit(lines[j]) ? '>' : ' '} ${lines[j].slice(0, 300)}\n`;
                last = j;
            }
            return sec + '\n';
        })();
        if (findSection) output += findSection;

        // Videos first — there are only ever a handful and they're high-value
        // (the model passes them to find_video), so emit them before the bulky
        // paragraph content can exhaust the char budget.
        if (videoItems.length > 0) {
            output += 'Videos:\n';
            videoItems.forEach(v => {
                if (output.length < textBudget - 300) output += `- [${v.kind}] ${v.url}\n`;
            });
            output += '\n';
        }

        if (paragraphs.length > 0) {
            output += 'Content:\n';
            paragraphs.forEach(p => {
                if (output.length < textBudget - 500) {
                    output += `${p}\n\n`;
                }
            });
        }

        if (tables.length > 0) {
            output += '\nData:\n';
            tables.forEach(t => {
                if (output.length < textBudget - 500) {
                    output += `${t}\n\n`;
                }
            });
        }

        if (imageItems.length > 0) {
            output += '\nImages:\n';
            imageItems.forEach(im => {
                if (output.length < textBudget - 500) {
                    output += `- ${im.alt}\n`;
                    if (im.link) output += `  post: ${im.link}\n`;
                    if (im.src) output += `  image: ${im.src}\n`;
                }
            });
            output += '\n';
        }

        // If structured extraction returned too little content, fall back to innerText.
        // This handles SPAs, shadow DOM, and sites with non-standard HTML structure.
        //
        // "Too little" is measured on the extracted BODY (output minus the
        // title/description preamble) and relative to the page: a card/list page
        // can yield a few hundred characters of nav crumbs while the rendered body
        // holds thousands, and the old absolute `output.length < 300` test — with
        // the preamble counted in — meant the rescue never fired on exactly the
        // pages that needed it.
        const bodyPortionLen = output.length - preambleLen;
        const pageTextLen = (document.body?.innerText || '').length;
        if (bodyPortionLen < 300 || (pageTextLen > 800 && bodyPortionLen < pageTextLen * 0.25)) {
            // Recursive function to get text including shadow DOM
            function getAllText(element) {
                let text = '';
                if (element.shadowRoot) {
                    text += getAllText(element.shadowRoot);
                }
                for (const child of (element.childNodes || [])) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const trimmed = child.textContent.trim();
                        if (trimmed) text += trimmed + ' ';
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const tag = child.tagName?.toLowerCase();
                        if (!['script', 'style', 'noscript', 'svg'].includes(tag)) {
                            text += getAllText(child);
                        }
                    }
                }
                return text;
            }

            // Rescue from whichever of the detected region / the document body
            // actually holds the text. Re-reading only `mainContent` re-reads the
            // very element the selector chain got wrong, so the rescue could
            // never recover from a bad pick.
            const src = ((document.body?.innerText || '').length > (mainContent.innerText || '').length)
                ? document.body : mainContent;
            const shadowText = getAllText(src);
            const innerText = src.innerText || '';
            // Prefer innerText: it preserves the page's LINE structure, which is
            // what makes a diff (and any per-item reading of a feed/listing) work.
            // getAllText walks into shadow roots but joins every text node with a
            // space, so it is almost always the longer of the two and used to win
            // on length alone — flattening every page to a single line. Only take
            // it when it found materially more text, i.e. real shadow-DOM content
            // innerText could not see.
            const fallbackText = shadowText.length > innerText.length * 1.2 + 50 ? shadowText : innerText;

            if (fallbackText.length > bodyPortionLen) {
                output = '';
                if (title) output += `Title: ${title}\n\n`;
                if (metaDesc) output += `Summary: ${metaDesc}\n\n`;
                // Keep the per-entry lines: they are the structured half of the
                // answer, and the flat rescue text cannot reproduce them.
                if (itemsSection) output += itemsSection;
                if (findSection) output += findSection;
                // Collapse horizontal whitespace only. The old blanket /\s+/ → ' '
                // put the entire page on ONE line (and made the following
                // paragraph-break restore dead code), which costs every
                // line-oriented consumer its precision: a change monitor could
                // only report "this whole page differs" instead of the one row
                // that actually appeared.
                output += 'Content:\n' + fallbackText
                    .replace(/[^\S\n]+/g, ' ')
                    .replace(/\n{3,}/g, '\n\n')
                    .replace(/[ \t]*\n[ \t]*/g, '\n')
                    .trim();
            }
        }

        // Links go LAST but inside a reserved share of the budget: the prose
        // above is cut to make room, never the other way round.
        if (includeLinks && (links.length || linkTerms.length)) {
            const filtered = linkTerms.length > 0;
            const cap = Math.floor(maxLength * (filtered ? 0.8 : 0.6));
            let sec = filtered
                ? `\nLinks matching "${linkFilter || find}" (${linksMatched} of ${linksTotal} links on the page):\n`
                : `\nLinks (${linksTotal} on the page):\n`;
            let shown = 0;
            for (const l of links) {
                const line = `- ${l.text}: ${l.href}\n`;
                if (sec.length + line.length > cap) break;
                sec += line;
                shown++;
            }
            if (shown < links.length) sec += `… +${links.length - shown} more links not shown — narrow them with find:"<term>" (matches link text or URL, alternatives separated by |).\n`;
            if (filtered && !linksMatched) sec += '(none — the term does not occur in any link text or URL on this page; the page may load this list dynamically, or the item may be named differently)\n';
            const keepText = Math.max(preambleLen, maxLength - sec.length - 2);
            output = output.substring(0, keepText).replace(/\s+$/, '') + '\n' + sec;
        }
        return output.substring(0, maxLength);
    }, { includeLinks, maxLength, adArgs, linkFilter, find });
}

// A Cloudflare/Turnstile "managed challenge" returns a 403/503 (or a 200 "Just a
// moment" interstitial) that its own JS AUTO-CLEARS for a sufficiently real browser
// after a few seconds, then reloads to the real content. Our stealth context now
// presents a coherent Windows-Chrome fingerprint, so waiting for that auto-solve
// (instead of throwing on the challenge status immediately) recovers a large class
// of pages the browser was giving up on. Interactive challenges that need a real
// click never clear here and fall through to a hard failure (cascade / host-block).
const CF_CHALLENGE_RE = /just a moment|checking your browser|verify(?:ing)? you are (?:human|a human)|attention required|cf-browser-verification|cf-challenge|challenge-platform|__cf_chl|enable javascript and cookies|ddos protection by cloudflare|please (?:wait|stand by) while|needs to review the security of your connection|www\.cloudflare\.com\/(?:5xx|learning)/i;
const CF_CHALLENGE_WAIT_MS = parseInt(process.env.CF_CHALLENGE_WAIT_MS, 10) || 12000;

async function pageLooksLikeChallenge(page) {
    try {
        const sig = await page.evaluate(() => (document.title + '\n' + (document.body ? document.body.innerText : '')).slice(0, 4000));
        return CF_CHALLENGE_RE.test(sig);
    } catch (_) { return false; }   // eval race during a challenge redirect — treat as "still working"
}

// Poll until the interstitial is gone AND real content is present, or the deadline
// passes. Returns true if the challenge cleared. Exits early the moment content
// appears so a fast auto-solve isn't penalised.
async function waitForChallengeToClear(page, maxMs = CF_CHALLENGE_WAIT_MS) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        try {
            const [title, body] = await page.evaluate(() => [document.title, (document.body ? document.body.innerText : '')]);
            const stillChallenge = CF_CHALLENGE_RE.test(title + '\n' + body.slice(0, 4000));
            if (!stillChallenge && body.trim().length > 300) return true;
        } catch (_) { /* execution context destroyed = Cloudflare is reloading the page; keep waiting */ }
    }
    return false;
}


// ---------------------------------------------------------------------------
// Overlay dismissal — cookie-consent walls and simple age gates.
// A consent-management overlay (OneTrust/Didomi/Sourcepoint/Quantcast/…) or an
// age gate answers INSTEAD of the page for a fresh browser context: extracted
// text is "We value your privacy … Accept all" and the article behind it never
// reaches the model, which then re-reads the same URL the same way. The known
// CMP selectors are tried first (precise; several live in a cross-origin
// iframe, so every frame is scanned), then visible buttons whose whole label is
// an accept/agree phrase AND that sit inside an overlay-ish container (fixed /
// sticky / dialog / consent-named ancestor) — a "Continue" button in ordinary
// page flow is never clicked. Age gates get a 1990-01-01 birth date and the
// enter/confirm button. Best-effort, bounded (~2 s worst case), never throws.
// ---------------------------------------------------------------------------
const { CONSENT_SELECTORS, CONSENT_BUTTON_RE, AGE_RE: AGE_GATE_RE } = require('./pageObstacles');
const AGE_ENTER_RE = /^\s*(?:view page|enter(?: site)?|continue|confirm|submit|proceed|i am (?:over )?(?:18|19|21)(?:\+| or older)?|yes,? i(?:'m| am)(?: over)? (?:18|19|21)|yes|ok|verify|go)\s*$/i;

async function dismissOverlays(page, { maxRounds = 2 } = {}) {
    const dismissed = [];
    const visibleWithin = async (loc) => {
        try { if (!(await loc.count())) return false; return await loc.isVisible(); } catch (_) { return false; }
    };
    for (let round = 0; round < maxRounds; round++) {
        let clicked = null;
        let frames = [];
        try { frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]; } catch (_) { break; }
        for (const frame of frames) {
            // 1. Known consent-management-platform buttons.
            for (const sel of CONSENT_SELECTORS) {
                try {
                    const loc = frame.locator(sel).first();
                    if (await visibleWithin(loc)) {
                        await loc.click({ timeout: 1500 });
                        clicked = { kind: 'consent', via: sel };
                        break;
                    }
                } catch (_) { /* detached / covered — next candidate */ }
            }
            if (clicked) break;
            // 2. Visible accept/agree button inside an overlay-ish container.
            try {
                const handle = await frame.evaluateHandle((btnReSrc) => {
                    const re = new RegExp(btnReSrc, 'i');
                    const cands = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'));
                    const isVisible = (el) => {
                        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
                        return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
                    };
                    const OVERLAYISH = /cookie|consent|gdpr|privacy|cmp|banner|modal|overlay|popup|dialog|notice|age-?gate|agegate|interstitial|paywall|onboard|welcome/i;
                    const inOverlay = (el) => {
                        let n = el;
                        for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement) {
                            const cs = getComputedStyle(n);
                            if (cs.position === 'fixed' || cs.position === 'sticky') return true;
                            if (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') return true;
                            if (OVERLAYISH.test(`${n.id} ${typeof n.className === 'string' ? n.className : ''}`)) return true;
                        }
                        // The whole frame IS the overlay (CMP iframes): body-level buttons count.
                        return window !== window.top;
                    };
                    for (const el of cands) {
                        const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                        if (t && t.length <= 40 && re.test(t) && isVisible(el) && inOverlay(el)) return el;
                    }
                    return null;
                }, CONSENT_BUTTON_RE.source);
                const el = handle.asElement();
                if (el) {
                    const label = (await el.innerText().catch(() => '')).trim().slice(0, 40);
                    await el.click({ timeout: 1500 });
                    clicked = { kind: 'consent', via: `text:${label || '?'}` };
                }
                await handle.dispose().catch(() => {});
            } catch (_) { /* frame navigated away — fine */ }
            if (clicked) break;
        }
        // 3. Age gate: only when the visible page text says so.
        if (!clicked) {
            try {
                const isAgeGate = await page.evaluate((src) => new RegExp(src, 'i').test((document.body?.innerText || '').slice(0, 2000)), AGE_GATE_RE.source);
                if (isAgeGate) {
                    const done = await page.evaluate(({ enterSrc }) => {
                        const fire = (el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
                        let touched = 0;
                        document.querySelectorAll('select').forEach((sel) => {
                            const key = `${sel.id} ${sel.name}`.toLowerCase();
                            const opts = Array.from(sel.options);
                            let pick = null;
                            if (/year|yy|birth|age|dob/.test(key)) pick = opts.find(o => /^(19|20)\d\d$/.test(o.value) && parseInt(o.value, 10) <= 1995 && parseInt(o.value, 10) >= 1970) || opts.find(o => /^1990$/.test(o.textContent.trim()));
                            else if (/month|mm/.test(key)) pick = opts.find(o => /^(1|01|jan)/i.test(o.value) || /^jan/i.test(o.textContent.trim()));
                            else if (/day|dd/.test(key)) pick = opts.find(o => /^(1|01)$/.test(o.value));
                            if (pick) { sel.value = pick.value; fire(sel); touched++; }
                        });
                        document.querySelectorAll('input').forEach((inp) => {
                            const key = `${inp.id} ${inp.name} ${inp.placeholder || ''}`.toLowerCase();
                            if (inp.type === 'date') { inp.value = '1990-01-01'; fire(inp); touched++; }
                            else if (/year|yyyy/.test(key)) { inp.value = '1990'; fire(inp); touched++; }
                            else if (/month|mm/.test(key)) { inp.value = '01'; fire(inp); touched++; }
                            else if (/\bday\b|dd/.test(key)) { inp.value = '01'; fire(inp); touched++; }
                            else if (inp.type === 'checkbox' && /age|18|21|confirm|adult/.test(key)) { inp.checked = true; fire(inp); touched++; }
                        });
                        const re = new RegExp(enterSrc, 'i');
                        const btn = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'))
                            .find(el => { const t = (el.innerText || el.value || '').trim(); const r = el.getBoundingClientRect(); return t && t.length <= 30 && re.test(t) && r.width > 4 && r.height > 4; });
                        if (btn) { btn.click(); return { touched, clicked: (btn.innerText || btn.value || '').trim().slice(0, 30) }; }
                        return { touched, clicked: null };
                    }, { enterSrc: AGE_ENTER_RE.source });
                    if (done && done.clicked) {
                        clicked = { kind: 'age_gate', via: `text:${done.clicked}` };
                        try { await page.waitForLoadState('load', { timeout: 6000 }); } catch (_) {}
                    }
                }
            } catch (_) { /* best-effort */ }
        }
        if (!clicked) break;
        dismissed.push(clicked);
        try { await page.waitForTimeout(700); } catch (_) { break; }
    }
    if (dismissed.length) console.log(`[Playwright] Dismissed ${dismissed.map(d => `${d.kind} (${d.via})`).join(', ')}`);
    return dismissed;
}

/**
 * Fetch URL content with Playwright
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} options.timeout - Timeout in ms (default: 15000)
 * @param {boolean} options.waitForJS - Wait for JS to render (default: true)
 * @param {boolean} options.includeLinks - Include extracted links (default: false)
 * @param {number} options.maxLength - Max content length (default: 8000)
 * @param {boolean} options.screenshot - Take screenshot (default: false)
 * @param {boolean} options.rawHtml - Return raw HTML instead of processed content (default: false)
 * @param {string} options.waitForSelector - Wait for specific selector before extracting (default: null)
 * @returns {Object} { success, content, title, url, screenshot?, error? }
 */
async function fetchUrlContent(url, options = {}) {
    const {
        timeout = 15000,
        waitForJS = true,
        includeLinks = false,
        maxLength = 8000,
        screenshot = false,
        rawHtml = false,
        waitForSelector = null,
        linkFilter = null,
        find = null,
        // structured: also return the rendered HTML and the JSON API responses
        // the page loaded — what a deterministic record counter (services/
        // tally.js) reads instead of the extracted text.
        structured = false
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('fetchUrlContent', url, hardDeadlineFor(timeout));
    const dismissed = [];   // overlays clicked away (consent / age gate) — reported to the caller

    try {
        poolEntry = await getBrowser(lease);

        // Create stealth context
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        lease.context = context;

        // Capture JSON API responses from XHR/fetch calls (SPAs load data this
        // way); block ads/trackers and, unless we need a screenshot, the heavy
        // resource types. Bot-protection endpoints pass through untouched —
        // see installRequestPolicy.
        const capturedJsonResponses = [];
        const reqStats = await installRequestPolicy(context, {
            blockTypes: screenshot ? [] : ['image', 'media', 'font'],
            captureJson: capturedJsonResponses,
        });

        page = await context.newPage();

        // Apply stealth patches
        await applyStealthPatches(page);

        // Random pre-navigation delay
        await page.waitForTimeout(randomDelay(30, 100));

        // Navigate with stealth - use 'load' instead of 'networkidle' for better reliability
        const response = await page.goto(url, {
            timeout,
            waitUntil: waitForJS ? 'load' : 'domcontentloaded'
        });

        if (!response) {
            throw new Error('HTTP no response');
        }
        // Distinguish a bot-CHALLENGE interstitial (wait for it to auto-clear) from a
        // hard error status (real failure — throw so the cascade escalates / the
        // host-block memo strikes). Only an actual Cloudflare/Turnstile interstitial
        // gets the wait; a plain 403/429 error PAGE (no challenge markers) must NOT be
        // mistaken for a "cleared challenge" just because it has some text.
        const navStatus = response.status();
        // cf-mitigated:challenge is Cloudflare's explicit "this is a challenge" flag —
        // it catches a Turnstile challenge whose visible text doesn't match our markers
        // (and is NOT set on a hard block, so it won't false-enter on g2/zillow-style walls).
        let cfMitigated = '';
        try { cfMitigated = String(response.headers()['cf-mitigated'] || '').toLowerCase(); } catch (_) { /* headers race */ }
        const looksChallenge = cfMitigated === 'challenge' || (waitForJS && await pageLooksLikeChallenge(page));
        if (looksChallenge) {
            const cleared = await waitForChallengeToClear(page, CF_CHALLENGE_WAIT_MS);
            if (!cleared) {
                throw new Error(`HTTP ${navStatus >= 400 ? navStatus : 403}`);
            }
            // Cleared — fall through to the normal JS-render wait + extraction, which
            // now runs against the real content Cloudflare redirected us to.
        } else if (navStatus >= 400) {
            throw new Error(`HTTP ${navStatus}`);
        }

        // Wait for JS to render content
        if (waitForJS) {
            // Wait for networkidle first (best signal that JS frameworks have loaded data)
            // Kept at 8s and BEFORE the settle poll so the XHR-capture window
            // (page.on('response') → capturedJsonResponses) is unchanged — the
            // "Structured data:" enrichment is not cut short.
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
            } catch (e) {
                // Ignore timeout, continue with what we have
            }

            // Bounded content-settle poll — replaces a flat 3-5s hydration wait.
            // Exit as soon as the document is complete AND body text has stabilized
            // (>=500 chars, unchanged across two 250ms samples), capped at ~3s. The
            // readyState gate keeps an XHR-hydrating SPA from being cut early; a
            // ~700-900ms floor preserves the anti-bot "human dwell" signal and gives
            // the DOM a beat to paint. A genuinely thin page never satisfies the
            // >=500 condition, polls to the cap, and the <500 slow-SPA path below
            // still runs — slow-render recovery is unchanged. Net: a fast-rendering
            // page returns in ~1-1.5s instead of a fixed 3-5s.
            await page.waitForTimeout(randomDelay(700, 900));   // hard floor
            {
                let lastLen = -1, stable = 0;
                for (let i = 0; i < 10; i++) {
                    let ready = 'complete', len = 0;
                    try {
                        [ready, len] = await page.evaluate(() => [
                            document.readyState, (document.body?.innerText || '').trim().length
                        ]);
                    } catch (_) { break; }   // navigation/eval race — stop polling, proceed
                    if (ready === 'complete' && len >= 500 && len === lastLen) { stable++; if (stable >= 1) break; }
                    else stable = 0;
                    lastLen = len;
                    await page.waitForTimeout(250);
                }
            }

            // Cookie-consent walls / age gates answer INSTEAD of the page — dismiss
            // them now, before the thin-content wait and the lazy scroll, so the
            // extraction below sees the real content.
            if (options.dismissOverlays !== false) {
                const d = await dismissOverlays(page).catch(() => []);
                if (d.length) { dismissed.push(...d); try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch (_) {} }
            }

            // Check if page has meaningful content, if not wait longer for late-loading SPAs
            const bodyTextLength = await page.evaluate(() => (document.body?.innerText || '').trim().length);
            if (bodyTextLength < 500) {
                // Page likely still rendering - wait extra time for SPA hydration
                await page.waitForTimeout(randomDelay(5000, 8000));

                // If still thin, try scrolling to trigger lazy loading
                let stillThin = false;
                try { stillThin = await page.evaluate(() => (document.body?.innerText || '').trim().length < 500); } catch (_) {}
                if (stillThin) {
                    // body can be null mid-redirect (Google News interstitials) — never let
                    // a scroll nudge fail the whole fetch.
                    try { await page.evaluate(() => window.scrollTo(0, (document.body?.scrollHeight || 0) / 2)); } catch (_) {}
                    await page.waitForTimeout(randomDelay(2000, 3000));
                }
            }
        }

        // Trigger lazy-loaded content on ANY page (not just thin ones): many
        // sites fetch images / infinite-scroll posts / late XHR only as the
        // viewport reaches them, so a static render misses most of the content.
        // Bounded so it adds ~1-2s at most, then returns to top.
        if (waitForJS) {
            try {
                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let total = 0;
                        const step = () => {
                            window.scrollBy(0, window.innerHeight);
                            total += window.innerHeight;
                            if (total < document.body.scrollHeight && total < 18000) setTimeout(step, 150);
                            else { window.scrollTo(0, 0); resolve(); }
                        };
                        step();
                    });
                });
                await page.waitForTimeout(800);
            } catch (_) { /* scrolling is best-effort */ }
        }

        // Wait for specific selector if requested
        if (waitForSelector) {
            try {
                await page.waitForSelector(waitForSelector, { timeout: 5000 });
            } catch (e) {
                // Continue even if selector not found
            }
        }

        // Extract content - raw HTML or processed
        let content;
        if (rawHtml) {
            // Get raw HTML content including shadow DOM
            content = await page.evaluate((maxLen) => {
                // Recursive function to get all text including shadow DOM
                function getAllText(element) {
                    let text = '';

                    // Get text from this element's shadow root
                    if (element.shadowRoot) {
                        text += getAllText(element.shadowRoot);
                    }

                    // Get text from children
                    for (const child of (element.childNodes || [])) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            const trimmed = child.textContent.trim();
                            if (trimmed) text += trimmed + ' ';
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            text += getAllText(child);
                        }
                    }

                    return text;
                }

                // Get all text including shadow DOM content
                const allText = getAllText(document.body);

                // Also get regular innerText and innerHTML as fallback
                const bodyText = document.body.innerText || '';
                const bodyHtml = document.body.innerHTML || '';

                // Combine all for best results
                const combined = allText + '\n\n---INNERTEXT---\n\n' + bodyText + '\n\n---HTML---\n\n' + bodyHtml;
                return combined.substring(0, maxLen);
            }, maxLength);
        } else {
            content = await extractContent(page, { includeLinks, maxLength, linkFilter, find });
        }

        const title = await page.title();

        // Supplement with captured JSON API data when available.
        // SPAs load real data via XHR/fetch - the DOM often has just UI chrome.
        // Always merge API data if we captured meaningful JSON responses.
        if (capturedJsonResponses.length > 0) {
            // Sort by size descending - largest responses likely have the main data
            capturedJsonResponses.sort((a, b) => b.size - a.size);
            let apiContent = '';
            for (const resp of capturedJsonResponses) {
                if (apiContent.length >= maxLength) break;
                const flatText = flattenJsonToText(resp.data, maxLength - apiContent.length);
                // A flattened response that is all opaque ids/tokens is noise no
                // matter which endpoint it came from — the URL denylist catches the
                // known bot-protection hosts, this catches the rest.
                if (flatText.length > 80 && !unusableContentReason(flatText)) {
                    apiContent += flatText + '\n\n';
                }
            }
            if (apiContent.length > 200) {
                console.log(`[Playwright] Captured ${capturedJsonResponses.length} API responses (${apiContent.length} chars text), enriching content`
                    + ` [${capturedJsonResponses.slice(0, 4).map(r => { try { return new URL(r.url).host; } catch (_) { return '?'; } }).join(', ')}]`);
                // SUPPLEMENT, don't supplant. The rendered DOM holds the
                // human-readable text + media (paragraphs, tables, image
                // captions/links) the JSON omits; the captured XHR/fetch JSON
                // holds structured data the DOM hasn't rendered. A model needs
                // BOTH — replacing wholesale (the old behavior) discarded
                // whichever half the page kept in the DOM, which on image/media
                // SPAs is the part the user actually asked for. Only fall back to
                // JSON-only when the DOM yielded nothing but chrome.
                const dom = (content || '').trim();
                const domBeyondTitle = dom.replace(/^Title:.*$/m, '').trim();
                if (domBeyondTitle.length > 60) {
                    const room = maxLength - dom.length - 80;
                    content = room > 200
                        ? `${dom}\n\nStructured data (captured from the page's API calls):\n${apiContent.slice(0, room)}`
                        : dom;
                } else {
                    const titleLine = title ? `Title: ${title}\n\n` : '';
                    content = titleLine + apiContent.slice(0, maxLength - titleLine.length);
                }
            }
        }

        // Take screenshot if requested
        let screenshotData = null;
        if (screenshot) {
            screenshotData = await page.screenshot({
                type: 'jpeg',
                quality: 70,
                fullPage: false
            });
        }

        let navStatusOut = 0;
        try { navStatusOut = response.status(); } catch (_) {}
        let published = null;
        try {
            published = await page.evaluate(() => {
                const sel = ['meta[property="article:published_time"]', 'meta[name="article:published_time"]', 'meta[property="og:updated_time"]', 'meta[name="datePublished"]', 'meta[itemprop="datePublished"]', 'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="publish-date"]', 'meta[name="date"]', 'meta[name="dc.date"]', 'meta[name="parsely-pub-date"]', 'time[datetime]'];
                for (const q of sel) { const el = document.querySelector(q); const v = el && (el.getAttribute('content') || el.getAttribute('datetime')); if (v) return v; }
                for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) { const m = /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(sc.textContent || ''); if (m) return m[1]; }
                return null;
            });
            if (published) { const d = new Date(published); published = /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : (isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)); }
        } catch (_) { published = null; }
        const pagination = await domPagination(page);
        let structuredOut = null;
        if (structured) {
            let html = '';
            try { html = await page.content(); } catch (_) { html = ''; }
            structuredOut = {
                html: html.length > 8_000_000 ? html.slice(0, 8_000_000) : html,
                apiJson: capturedJsonResponses.map(r => ({ url: r.url, data: r.data })),
            };
        }
        return {
            success: true,
            content,
            title,
            url,
            ...(structuredOut || {}),
            finalUrl: page.url(),
            httpStatus: navStatusOut,
            ...(pagination ? { pagination } : {}),
            ...(published ? { published } : {}),
            ...(dismissed.length ? { dismissed } : {}),
            ...(reqStats.adsBlocked ? { adsBlocked: reqStats.adsBlocked } : {}),
            screenshot: screenshotData?.toString('base64')
        };

    } catch (error) {
        return {
            success: false,
            error: lease.errorOf(error),
            url
        };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

/**
 * Fetch multiple URLs in parallel
 *
 * @param {string[]} urls - URLs to fetch
 * @param {Object} options - Fetch options (same as fetchUrlContent)
 * @param {number} concurrency - Max concurrent fetches (default: 3)
 * @returns {Object[]} Array of fetch results
 */
async function fetchMultipleUrls(urls, options = {}, concurrency = 3) {
    const results = [];
    const queue = [...urls];

    async function worker() {
        while (queue.length > 0) {
            const url = queue.shift();
            if (url) {
                const result = await fetchUrlContent(url, options);
                results.push(result);
            }
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    // Sort results to match input order
    const urlOrder = new Map(urls.map((url, idx) => [url, idx]));
    results.sort((a, b) => (urlOrder.get(a.url) || 0) - (urlOrder.get(b.url) || 0));

    return results;
}

// ---- Page interaction ------------------------------------------------------
// Models describe steps in many shapes ({action:"click"}, {type:"fill"},
// {op:"press", key:"Enter"}, {type:"click", text:"Search"}); normalize them
// instead of silently ignoring the ones the switch did not know.
const ACTION_ALIASES = {
    text: 'set', value: 'set', setvalue: 'set', fillin: 'set', enter: 'set',
    fill: 'type', input: 'type', typetext: 'type', entertext: 'type', settext: 'type', write: 'type',
    key: 'press', presskey: 'press', keypress: 'press', keyboard: 'press',
    selectoption: 'select', choose: 'select', dropdown: 'select',
    tap: 'click', clickon: 'click', clickbutton: 'click', clicklink: 'click', doubleclick: 'dblclick',
    mouseover: 'hover',
    waitfor: 'wait', sleep: 'wait', pause: 'wait', waitforselector: 'wait', delay: 'wait', waitfortext: 'wait',
    scrolldown: 'scroll', scrolltobottom: 'scroll', scrollto: 'scroll', scrollintoview: 'scroll',
    next: 'nextpage', nextpage: 'nextpage', paginate: 'nextpage', gotonextpage: 'nextpage', clicknext: 'nextpage',
    loadmore: 'loadmore', showmore: 'loadmore', clickloadmore: 'loadmore',
    capture: 'snapshot', extract: 'snapshot', snapshot: 'snapshot', read: 'snapshot',
    waitfornavigation: 'waitfornavigation', waitfornav: 'waitfornavigation',
    submitform: 'submit', check: 'check', uncheck: 'uncheck', back: 'back', goback: 'back',
};
const ACTION_TYPES = ['set', 'click', 'dblclick', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'waitfornavigation', 'submit', 'nextpage', 'loadmore', 'snapshot', 'back'];

function normalizeAction(raw) {
    const src = typeof raw === 'string' ? { type: raw } : { ...(raw || {}) };
    const rawType = String(src.type || src.action || src.op || src.kind || src.command || '').toLowerCase().replace(/[\s_-]+/g, '');
    let type = ACTION_ALIASES[rawType] || rawType;
    // No verb at all ({selector:"#author", value:"Albert Einstein"} is common):
    // infer it from the fields. A value means "set this field" (resolved
    // against the real element — a <select> gets an option chosen, a text box
    // gets filled), a key means press, a bare target means click.
    if (!type) {
        if ([src.waitMs, src.ms, src.wait, src.delay, src.duration, src.sleep, src.pause].some(v => v != null && Number.isFinite(Number(v))) && !src.selector && src.value == null) type = 'wait';
        else if (src.value != null || (src.text != null && (src.selector || src.placeholder || src.label))) type = 'set';
        else if (src.key || src.keys) type = 'press';
        else if (src.selector || src.target || src.text || src.label) type = 'click';
    }
    const a = { ...src, type, rawType };
    a.selector = src.selector || src.target || src.css || src.element || src.locator || null;
    if (type === 'type' || type === 'set') a.text = src.text ?? src.value ?? src.input ?? src.content ?? src.query ?? '';
    if (type === 'select' || type === 'set') a.value = src.value ?? src.option ?? src.label ?? src.text;
    if (type === 'press') a.key = src.key ?? src.keys ?? src.value ?? (src.selector ? null : src.text) ?? 'Enter';
    if (type === 'scroll' && rawType === 'scrolltobottom') a.to = 'bottom';
    // Click / hover / wait by VISIBLE TEXT when no selector was given — models
    // know the label they see ("Search", "Next", "Accept") far better than the
    // page's CSS.
    a.byText = !a.selector && type !== 'type' && type !== 'set' && type !== 'press'
        ? (src.text || src.label || src.name || src.buttonText || src.linkText || null)
        : null;
    if ((type === 'type' || type === 'set') && !a.selector) { a.placeholder = src.placeholder || null; a.label = src.label || src.field || src.name || null; }
    a.times = Math.max(1, Math.min(10, parseInt(src.times ?? src.count ?? src.repeat ?? src.pages ?? 1, 10) || 1));
    return a;
}

// ---- Target resolution -----------------------------------------------------
// Frames to search for a step's target: the page itself first, then its child
// frames (a form inside an <iframe> — embedded editors, "try it" sandboxes,
// third-party checkout/login widgets — is invisible to page-level locators).
function interactFrames(page) {
    const main = page.mainFrame();
    // about:blank frames are kept: editors and "try it" sandboxes write
    // their document into an iframe that has no src.
    const kids = page.frames().filter(f => f !== main && !f.isDetached());
    return [main, ...kids].slice(0, 8);
}

const escRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cssQ = (t) => String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// "First name:" / "Email *" — a label's trailing punctuation is decoration.
const bareLabel = (t) => String(t).trim().replace(/[\s:*]+$/, '').trim();

// A "selector" that is really a field id, a name, or the visible label: models
// send {selector:"username"}, {selector:"Login"}, {selector:"Search"}.
function selectorVariants(sel, { loose = true } = {}) {
    const s = String(sel).trim();
    const out = [s];
    if (/^[A-Za-z][\w-]*$/.test(s)) {
        out.push(`#${s}`);
        if (loose) out.push(`[name="${cssQ(s)}"]`, `[id="${cssQ(s)}" i]`);
    }
    return out;
}
function selectorLooksLikeText(sel) {
    const s = String(sel).trim();
    if (!s || s.length > 80) return false;
    if (/^[#.\[]|[>~+=\[\]()#:]|^\/\/|^(xpath|css|text)=/.test(s)) return false;
    return true;   // plain words: "Login", "Search", "username", "First name"
}

async function firstUsable(loc, { allowHidden = false } = {}) {
    try {
        const n = Math.min(await loc.count(), 8);
        let hidden = null;
        for (let i = 0; i < n; i++) {
            const one = loc.nth(i);
            if (await one.isVisible().catch(() => false)) {
                if (!(await isDisabledControl(one))) return one;
                if (!hidden) hidden = one;   // disabled but present: last resort
            } else if (allowHidden && !hidden) hidden = one;
        }
        return hidden && allowHidden ? hidden : null;
    } catch (_) { return null; }
}

// Strategies in priority order for one frame. Exact matches before partial
// ones (getByRole's default name match is a SUBSTRING: "Login" also matches
// "Login with Google"), buttons before links (a header "Login" link sits
// above the form's "Login" button on most sites and clicking it only reloads
// the page), and the form the model just filled before the rest of the page.
// Returns [strong, weak]: every frame is searched for a strong (exact) match
// before any frame is searched for a weak (partial) one — otherwise "Submit"
// in a page's own prose beats the real Submit button inside its iframe.
function textStrategies(scope, a, t, formScope) {
    const fill = a.type === 'type' || a.type === 'set' || a.type === 'select';
    const b = bareLabel(t) || t;
    const exactRe = new RegExp(`^\\s*${escRe(t)}\\s*$`, 'i');
    const out = [];
    if (fill) {
        for (const x of b === t ? [t] : [t, b]) {
            out.push(scope.getByLabel(x, { exact: true }), scope.getByPlaceholder(x, { exact: true }));
            for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton']) out.push(scope.getByRole(role, { name: x, exact: true }));
        }
        if (/^[A-Za-z][\w-]*$/.test(b)) out.push(scope.locator(`[name="${cssQ(b)}" i], [id="${cssQ(b)}" i]`));
        out.push(scope.locator(`input[aria-label="${cssQ(b)}" i], textarea[aria-label="${cssQ(b)}" i], select[aria-label="${cssQ(b)}" i], input[title="${cssQ(b)}" i]`));
        const weak = [scope.getByLabel(b), scope.getByPlaceholder(b)];
        for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton']) weak.push(scope.getByRole(role, { name: b }));
        return [out, weak];
    }
    if (a.type === 'check' || a.type === 'uncheck') {
        out.push(scope.getByRole('checkbox', { name: t, exact: true }), scope.getByRole('radio', { name: t, exact: true }),
            scope.getByRole('switch', { name: t, exact: true }), scope.getByLabel(t, { exact: true }));
        return [out, [scope.getByRole('checkbox', { name: b }), scope.getByRole('radio', { name: b }), scope.getByRole('switch', { name: b }), scope.getByLabel(b)]];
    }
    const BUTTONISH = 'button, [role="button"], input[type="submit"], input[type="button"], input[type="image"], input[type="reset"]';
    if (formScope) out.push(formScope.getByRole('button', { name: t, exact: true }), formScope.locator(BUTTONISH).filter({ hasText: exactRe }));
    out.push(
        scope.getByRole('button', { name: t, exact: true }),
        scope.locator(BUTTONISH).filter({ hasText: exactRe }),
        scope.locator(`input[type="submit"][value="${cssQ(t)}" i], input[type="button"][value="${cssQ(t)}" i]`),
        scope.getByRole('link', { name: t, exact: true }),
        scope.locator('a, [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"], summary, label, li').filter({ hasText: exactRe }),
        scope.getByRole('tab', { name: t, exact: true }),
        scope.getByRole('menuitem', { name: t, exact: true }),
        scope.getByRole('option', { name: t, exact: true }),
        scope.locator(`[aria-label="${cssQ(t)}" i], [title="${cssQ(t)}" i]`),
        scope.getByText(t, { exact: true }),
    );
    return [out, [
        scope.getByRole('button', { name: t }),
        scope.getByRole('link', { name: t }),
        scope.locator(`[aria-label*="${cssQ(t)}" i], [title*="${cssQ(t)}" i]`),
        scope.getByText(t),
    ]];
}

// A control described by the text next to it, with no <label> or ARIA name
// ("checkbox 1", a "Sort by" caption beside a <select>, "Your city" in a span
// before an input): mark the nearest control of the wanted kind to that text
// and return a locator for it. Text after a field (a hint) is penalised
// against text before/above it (a caption).
const BOX_CONTROLS = 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]';
const FIELD_CONTROLS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select, [role=combobox], [role=textbox], [contenteditable="true"]';
async function checkboxNearText(frame, t) { return controlNearText(frame, t, BOX_CONTROLS); }
async function controlNearText(frame, t, controlSel) {
    try {
        const tok = `ms${Math.random().toString(36).slice(2, 9)}`;
        const hit = await frame.evaluate(([t, tok, controlSel]) => {
            const want = t.trim().replace(/[\s:*]+$/, '').toLowerCase();
            const boxes = [...document.querySelectorAll(controlSel)];
            if (!boxes.length) return false;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let best = null;
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const txt = (n.textContent || '').trim().replace(/[\s:*]+$/, '').toLowerCase();
                if (!txt || (txt !== want && !(txt.includes(want) && txt.length <= want.length + 20))) continue;
                if (n.parentElement && n.parentElement.closest('script, style, option, button, a')) continue;
                const host = n.parentElement;
                const range = document.createRange(); range.selectNodeContents(n);
                const r = range.getBoundingClientRect();
                for (const bx of boxes) {
                    const br = bx.getBoundingClientRect();
                    if (!br.width && !br.height) continue;
                    const d = Math.hypot((br.left + br.right) / 2 - (r.left + r.right) / 2, (br.top + br.bottom) / 2 - (r.top + r.bottom) / 2);
                    const sameBlock = host && (host.contains(bx) || bx.parentElement === host || bx.parentElement === host.parentElement
                        || (host.parentElement && bx.parentElement && bx.parentElement.parentElement === host.parentElement));
                    // A caption sits before (left of / above) its control.
                    const after = br.right < r.left - 4 && Math.abs(br.top - r.top) < 20 || br.bottom < r.top - 4;
                    const score = d - (sameBlock ? 400 : 0) + (after ? 150 : 0);
                    if (!best || score < best.score) best = { score, bx };
                }
            }
            if (!best || best.score > 300) return false;
            best.bx.setAttribute('data-ms-pick', tok);
            return true;
        }, [t, tok, controlSel]);
        return hit ? frame.locator(`[data-ms-pick="${tok}"]`) : null;
    } catch (_) { return null; }
}

// Resolve an action's target to a locator: a CSS selector (also read as an
// id/name/label when it is a bare word), or the visible text / placeholder /
// label the model named — in the page and then in its frames.
async function resolveTarget(page, a, timeout, hint = {}) {
    const deadline = Date.now() + timeout;
    if (a.selector) {
        const textLike = selectorLooksLikeText(a.selector);
        // For a click, a bare word is far more often the button's LABEL than an
        // id: {selector:"Login"} must not land on <form id="login">. Fields
        // keep the id/name readings ({selector:"username"} is #username).
        const clicky = !['type', 'set', 'select', 'check', 'uncheck'].includes(a.type);
        const sels = selectorVariants(a.selector, { loose: !(clicky && textLike) });
        // A word that is not a CSS match is most likely a label: do not burn
        // the whole timeout on the CSS reading before trying the text one.
        const selDeadline = Date.now() + (textLike ? Math.min(timeout, 900) : timeout);
        let attached = null, attachedAt = 0;
        for (;;) {
            for (const fr of interactFrames(page)) {
                for (const s of sels) {
                    let loc;
                    try { loc = fr.locator(s); await loc.count(); } catch (_) { continue; }   // invalid CSS: try the next reading
                    const vis = await firstUsable(loc);
                    if (vis) {
                        if (s !== sels[0] || fr !== page.mainFrame()) hint.resolvedAs = `${s}${fr !== page.mainFrame() ? ' (inside a frame)' : ''}`;
                        hint.frame = fr;
                        return vis;
                    }
                    if (!attached && await loc.count().catch(() => 0)) { attached = loc.first(); attachedAt = Date.now(); }
                }
            }
            // Present but hidden (a native <select> behind a custom widget, a
            // visually-hidden checkbox): still usable for selectOption/check.
            if (attached && Date.now() - attachedAt > 1500) return attached;
            if (Date.now() >= selDeadline) break;
            await page.waitForTimeout(250);
        }
        if (attached) return attached;
        if (!textLike) return null;
        const t = String(a.selector).trim();
        const loc = await resolveTarget(page, { ...a, selector: null, byText: t, label: t, placeholder: null }, Math.max(1500, deadline - Date.now()), hint);
        if (loc) { if (!hint.resolvedAs) hint.resolvedAs = `the element labelled "${t}"`; return loc; }
        if (clicky) {
            for (const fr of interactFrames(page)) {
                for (const s of [`[name="${cssQ(t)}"]`, `[id="${cssQ(t)}" i]`]) {
                    const vis = await firstUsable(fr.locator(s));
                    if (vis) { hint.resolvedAs = s; hint.frame = fr; return vis; }
                }
            }
        }
        return null;
    }
    const text = a.byText || a.label || a.placeholder;
    if (!text) return null;
    const t = String(text).trim();
    const textDeadline = Date.now() + Math.min(timeout, 6000);
    const allowHidden = a.type === 'check' || a.type === 'uncheck' || a.type === 'select';
    do {
        let frames = interactFrames(page);
        // The frame holding the form the model just filled goes first.
        if (hint.formFrame && frames.includes(hint.formFrame)) frames = [hint.formFrame, ...frames.filter(f => f !== hint.formFrame)];
        const tiers = frames.map(fr => {
            const formScope = hint.form && fr === hint.formFrame ? hint.form : null;
            const [strong, weak] = textStrategies(fr, a, t, formScope);
            return a.placeholder && !a.byText && !a.label
                ? [[fr.getByPlaceholder(t, { exact: true }), fr.getByPlaceholder(t), ...strong], weak]
                : [strong, weak];
        });
        for (const tier of [0, 1]) {
            for (let k = 0; k < frames.length; k++) {
                for (const c of tiers[k][tier]) {
                    const loc = await firstUsable(c, { allowHidden });
                    if (loc) { if (frames[k] !== page.mainFrame()) hint.resolvedAs = 'an element inside a frame'; hint.frame = frames[k]; return loc; }
                }
            }
        }
        for (const fr of frames) {
            const boxy = a.type === 'check' || a.type === 'uncheck' || (a.type === 'set' && /^(true|false|on|off|yes|no|checked|unchecked)$/i.test(String(a.value ?? '')));
            if (boxy) {
                const box = await checkboxNearText(fr, t);
                if (box) { hint.resolvedAs = `the checkbox next to "${t}"`; hint.frame = fr; return box; }
            } else if (a.type === 'type' || a.type === 'set' || a.type === 'select') {
                const field = await controlNearText(fr, t, a.type === 'select' ? 'select, [role=combobox], [role=listbox]' : FIELD_CONTROLS);
                if (field) { hint.resolvedAs = `the field next to "${t}"`; hint.frame = fr; return field; }
            }
        }
        await page.waitForTimeout(300);
    } while (Date.now() < textDeadline);
    return null;
}

// Visible form fields, buttons and links with a selector that will work —
// returned when a step fails so the model retries against the page's REAL
// controls instead of inventing another selector. Fields carry their label,
// boxes their checked state, selects their options; frames are included.
async function listControls(page, limit = 30) {
    const out = [];
    for (const fr of interactFrames(page)) {
        if (out.length >= limit) break;
        try {
            const rows = await fr.evaluate((limit) => {
                const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
                const q = (s) => String(s).replace(/"/g, '\\"');
                const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
                const selectorOf = (el) => {
                    const tag = el.tagName.toLowerCase();
                    if (el.id && !/\d{5,}|^[a-f0-9-]{16,}$/i.test(el.id)) return `#${esc(el.id)}`;
                    const name = el.getAttribute('name'); if (name) return `${tag}[name="${q(name)}"]`;
                    const al = el.getAttribute('aria-label'); if (al) return `${tag}[aria-label="${q(al)}"]`;
                    const ph = el.getAttribute('placeholder'); if (ph) return `${tag}[placeholder="${q(ph)}"]`;
                    const type = el.getAttribute('type'); if (tag === 'input' && type) return `input[type="${q(type)}"]`;
                    return null;
                };
                const labelOf = (el) => {
                    const l = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
                    if (l) return l;
                    const by = el.getAttribute('aria-labelledby');
                    if (by) return by.split(/\s+/).map(id => (document.getElementById(id) || {}).innerText || '').join(' ');
                    return '';
                };
                const rows = [];
                for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role=button], [role=combobox], [role=checkbox], [role=tab], summary, a[href]')) {
                    if (rows.length > 400) break;
                    if (!visible(el)) continue;
                    const tag = el.tagName.toLowerCase();
                    const type = (el.getAttribute('type') || '').toLowerCase();
                    const role = el.getAttribute('role');
                    const kind = tag === 'a' ? 'link'
                        : (type === 'checkbox' || type === 'radio' || role === 'checkbox') ? 'checkbox'
                        : (tag === 'input' && /^(submit|button|image|reset)$/.test(type)) ? 'button'
                        : (tag === 'input' || tag === 'textarea') ? 'field'
                        : (tag === 'select' || role === 'combobox') ? 'select' : 'button';
                    const text = ((tag === 'input' ? (kind === 'button' ? el.value : '') : (el.innerText || '')) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                    if (kind === 'link' && !text) continue;
                    const row = { kind };
                    if (text) row.text = text;
                    const lab = labelOf(el).replace(/\s+/g, ' ').trim().slice(0, 60);
                    if (lab && lab !== text) row.label = lab;
                    const sel = selectorOf(el); if (sel) row.selector = sel;
                    const ph = el.getAttribute('placeholder'); if (ph) row.placeholder = ph.slice(0, 60);
                    if (kind === 'field' && el.value) row.value = String(el.value).slice(0, 60);
                    if (kind === 'checkbox') row.checked = !!(el.checked || el.getAttribute('aria-checked') === 'true');
                    if (tag === 'select') { row.options = [...el.options].slice(0, 12).map(o => o.text.trim()).filter(Boolean); row.value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text.trim() : ''; }
                    rows.push(row);
                }
                const order = { field: 0, select: 1, checkbox: 2, button: 3, link: 4 };
                return rows.sort((x, y) => order[x.kind] - order[y.kind]).slice(0, limit);
            }, limit - out.length);
            const inFrame = fr !== page.mainFrame();
            for (const r of rows) out.push(inFrame ? { ...r, inFrame: true } : r);
        } catch (_) { /* frame gone */ }
    }
    return out.slice(0, limit);
}

// Something covering the target (a newsletter / tour / chat popup that opened
// after the page loaded — the load-time overlay pass never saw it): find the
// layer on top of the target's centre and click its close control. Returns
// null when nothing covers it, else {cleared, desc, via}.
async function clearBlocker(loc) {
    return await loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return null;
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top || el.contains(top) || top.contains(el)) return null;
        // Climb to the outermost positioned / dialog layer around what covers it.
        let layer = top;
        for (let n = top; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            const st = getComputedStyle(n);
            if (st.position === 'fixed' || st.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') layer = n;
        }
        if (layer.contains(el)) return null;
        const desc = (layer.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const CLOSE_TEXT = /^(×|✕|✖|x|close|dismiss|no,? thanks|no thank you|not now|maybe later|later|skip|got it|ok|okay|accept|accept all|i agree|agree|allow all|reject all|decline|continue to site)$/i;
        const cands = [...layer.querySelectorAll('button, [role=button], a, [aria-label], [title], [class*=close i]')];
        const pick = cands.find(b => {
            const lab = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
            const txt = (b.innerText || '').trim();
            const cls = typeof b.className === 'string' ? b.className : '';
            return /\b(close|dismiss)\b/i.test(lab) || CLOSE_TEXT.test(txt) || /(^|[\s_-])(close|dismiss)([\s_-]|$)/i.test(cls);
        });
        if (!pick) return { cleared: false, desc };
        pick.click();
        return { cleared: true, desc, via: (pick.getAttribute('aria-label') || pick.innerText || 'close').trim().slice(0, 40) };
    }).catch(() => null);
}

// Before acting on a target: if a layer covers it, close it (once), or try
// Escape; report what was in the way either way.
async function unblockTarget(page, loc, entry) {
    const b = await clearBlocker(loc);
    if (!b) return;
    if (b.cleared) {
        entry.closedOverlay = `${b.via} (covering: "${b.desc.slice(0, 80)}")`;
        await page.waitForTimeout(400);
        return;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    const again = await clearBlocker(loc);
    if (!again) { entry.closedOverlay = `Escape (covering: "${b.desc.slice(0, 80)}")`; return; }
    if (!again.cleared) entry.blockedBy = again.desc.slice(0, 140);
}

// ---- What the steps did --------------------------------------------------
// Visible text lines of the page and its frames. The readable-content
// extractor keeps articles, lists and tables; the result of an interaction is
// usually a short line it drops ("You entered: A", "Hello World!", a status
// banner, a new "Delete" button, a total that updated), so the lines that
// appeared are reported separately.
async function visibleLines(page) {
    const lines = [];
    await waitForFramesLoaded(page, 3000);
    for (const fr of interactFrames(page)) {
        try {
            let t;
            try { t = await fr.evaluate(() => (document.body ? document.body.innerText : '') || ''); }
            catch (_) { await fr.waitForLoadState('load', { timeout: 3000 }).catch(() => {}); t = await fr.evaluate(() => (document.body ? document.body.innerText : '') || ''); }
            for (const l of t.split('\n')) { const x = l.replace(/\s+/g, ' ').trim(); if (x) lines.push(x); }
        } catch (_) { /* frame gone */ }
        if (lines.length > 6000) break;
    }
    return lines;
}

function lineDiff(beforeLines, afterLines) {
    const count = new Map();
    for (const l of beforeLines) count.set(l, (count.get(l) || 0) + 1);
    const added = [];
    for (const l of afterLines) {
        const n = count.get(l) || 0;
        if (n > 0) count.set(l, n - 1); else added.push(l);
    }
    let removed = 0;
    for (const n of count.values()) removed += n;
    return { added, removed };
}

// The page signature for interaction: the top document AND its frames (a
// form submitted inside an iframe changes only the frame).
async function interactSignature(page) {
    const parts = [await pageSignature(page)];
    for (const fr of interactFrames(page).slice(1, 5)) {
        try {
            parts.push(await fr.evaluate(() => {
                const t = (document.body && document.body.innerText) || '';
                let h = 0;
                for (let i = 0; i < t.length; i += 5) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
                return `${location.href}|${t.length}|${h}`;
            }));
        } catch (_) {
            // Mid-navigation the frame has no document to read: a unique token
            // keeps the settle loop waiting instead of reading it as stable.
            parts.push(`nav${Date.now()}`);
        }
    }
    return parts.join('#');
}

// Every frame's own load: page.waitForLoadState only covers the top document,
// and a form submitted inside an iframe navigates just that frame.
async function waitForFramesLoaded(page, ms = 5000) {
    await Promise.all(interactFrames(page).map(f => f.waitForLoadState('load', { timeout: ms }).catch(() => {})));
}

// Loading indicators on screen. An action that starts one ("Loading…",
// a spinner, aria-busy, a progress bar) is not done when the page first
// changes — the result arrives when the indicator goes away.
async function busyCount(page) {
    let n = 0;
    for (const fr of interactFrames(page).slice(0, 4)) {
        try {
            n += await fr.evaluate(() => {
                const vis = (el) => { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0'; };
                let c = 0;
                const sel = '[aria-busy="true"], [role="progressbar"], [id*="loading" i], [id*="spinner" i], [class*="spinner" i], [class*="loader" i], [class~="loading" i], [class*="is-loading" i], [class*="skeleton" i]';
                for (const el of document.querySelectorAll(sel)) { if (c > 20) break; if (el.tagName !== 'IMG' && el.tagName !== 'BODY' && el.tagName !== 'HTML' && vis(el)) c++; }
                const t = (document.body && document.body.innerText) || '';
                c += (t.match(/^\s*(loading|searching|please wait|fetching|processing)\b[^\n]{0,30}$/gim) || []).length;
                return c;
            });
        } catch (_) { /* navigating */ }
    }
    return n;
}

// After an action: wait for the page to change (navigation / re-render),
// then for any loading indicator the action started to clear, then settle.
async function waitForResult(page, before, busyBefore, maxMs) {
    let changed = await waitForChange(page, before, maxMs, interactSignature);
    if (changed) await waitForFramesLoaded(page);
    let busy = await busyCount(page);
    if (busy > busyBefore) {
        const until = Date.now() + Math.max(4000, Math.min(20000, maxMs * 2));
        while (Date.now() < until) {
            await page.waitForTimeout(300);
            busy = await busyCount(page);
            if (busy <= busyBefore) break;
        }
        // The result renders as the indicator goes away; let it settle.
        const after = await interactSignature(page);
        if (await waitForChange(page, after, 1200, interactSignature)) changed = true;
        else if (after !== before) changed = true;
    }
    return changed;
}

// A native <select>'s options are not clickable elements, but "click the
// dropdown, click the option" is how a person describes it — so a click aimed
// at an <option> (by selector, or by text matching an option) chooses it.
async function optionTarget(page, a) {
    try {
        if (a.selector) {
            const loc = page.locator(a.selector).first();
            if (await loc.count() && await loc.evaluate(el => el.tagName === 'OPTION')) return loc;
            return null;
        }
        if (a.byText) {
            const t = String(a.byText).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const loc = page.locator('select option').filter({ hasText: new RegExp(`^\\s*${t}\\s*$`, 'i') }).first();
            if (await loc.count()) return loc;
        }
    } catch (_) { /* not an option */ }
    return null;
}

async function chooseOption(optLoc, timeout) {
    const value = await optLoc.evaluate(el => el.value);
    await optLoc.locator('xpath=ancestor::select[1]').selectOption(value, { timeout });
}

// ---- Interact sessions ----------------------------------------------------
// Models drive a page one step per call ("pick the author" … "now pick the
// tag" … "now click Search"), assuming the page carries over. It used to be
// thrown away after every call, so each follow-up started from an empty form
// and the model burned 15-25 calls. A session keeps the page (context) open for
// the rest of the turn; the browser SLOT goes back to the pool between calls
// (contexts are isolated, other fetches share the browser meanwhile).
const INTERACT_SESSION_IDLE_MS = Math.max(15000, parseInt(process.env.INTERACT_SESSION_IDLE_MS, 10) || 120000);
const INTERACT_SESSION_MAX = Math.max(1, parseInt(process.env.INTERACT_SESSION_MAX, 10) || 4);
const interactSessions = new Map();   // key -> { context, page, poolEntry, startUrl, timer }

function closeInteractSession(key) {
    const s = interactSessions.get(key);
    if (!s) return;
    interactSessions.delete(key);
    clearTimeout(s.timer);
    s.context.close().catch(() => {});
}

function keepInteractSession(key, sess) {
    clearTimeout(sess.timer);
    sess.timer = setTimeout(() => closeInteractSession(key), INTERACT_SESSION_IDLE_MS);
    if (sess.timer.unref) sess.timer.unref();
    interactSessions.set(key, sess);
    while (interactSessions.size > INTERACT_SESSION_MAX) closeInteractSession(interactSessions.keys().next().value);
}

function sessionAlive(sess) {
    try { return !!(sess && sess.page && !sess.page.isClosed() && sess.poolEntry && sess.poolEntry.browser && sess.poolEntry.browser.isConnected()); }
    catch (_) { return false; }
}

function sameDocUrl(a, b) {
    const n = (u) => String(u || '').split('#')[0].replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
    return !!a && !!b && n(a) === n(b);
}

/**
 * Drive a page through ordered steps, then read it.
 *
 * Steps: click / dblclick / hover (selector or visible `text`), type (selector,
 * placeholder or label; `submit:true` presses Enter), press (key), select,
 * check / uncheck, scroll ({to:"bottom"} loads lazy content; {selector}; or one
 * viewport), wait ({selector} | {text} | {ms}), waitForNavigation, submit,
 * nextPage ({times:N} — captures each page), loadMore ({times:N}), snapshot
 * (capture the page as it is now), back.
 *
 * Every step waits for the page to actually CHANGE (navigation or re-render)
 * instead of a fixed pause. A failing step stops the run but still returns the
 * page as it is, the steps that ran, and the page's real controls.
 */
async function interactAndFetch(url, actions = [], options = {}) {
    const { timeout = 30000 } = options;
    const maxLength = options.maxLength || 8000;
    const steps = (Array.isArray(actions) ? actions : []).slice(0, 30).map(normalizeAction);
    const extraMs = steps.reduce((sum, s) => sum + (s.type === 'nextpage' || s.type === 'loadmore' ? s.times * 15000 : 8000), 0);

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('interactAndFetch', url, hardDeadlineFor(timeout, extraMs));
    const log = [];
    const snapshots = [];
    let firstLines = null;
    let lastTyped = null;
    let lastTypedFrame = null;
    let baselineLines = null;

    const snapshot = async (label) => {
        const raw = await extractContent(page, { ...options, maxLength: Math.max(4000, maxLength) });
        const title = await page.title().catch(() => '');
        let content = raw;
        if (!firstLines) firstLines = raw.split('\n');
        else content = paginationSvc.stripRepeatedChrome(raw, firstLines);
        const prev = snapshots[snapshots.length - 1];
        if (prev && prev.content === content) return false;
        snapshots.push({ url: page.url(), title, content, label });
        return true;
    };

    const sessionKey = options.session ? String(options.session) : null;
    let continued = false;
    let keep = false;
    let startUrl = url;

    try {
        let sess = sessionKey ? interactSessions.get(sessionKey) : null;
        if (sess && !sessionAlive(sess)) { closeInteractSession(sessionKey); sess = null; }
        if (sess && !options._fresh && (!url || sameDocUrl(url, sess.page.url()) || sameDocUrl(url, sess.startUrl))) {
            clearTimeout(sess.timer);
            interactSessions.delete(sessionKey);
            ({ context, page } = sess);
            startUrl = sess.startUrl;
            sess.poolEntry.lastUsed = Date.now();
            continued = true;
            lease.context = context;
        } else {
            if (sess) closeInteractSession(sessionKey);
            if (!url) throw new Error('no url given and no page is open from an earlier interact call this turn');
            poolEntry = await getBrowser(lease);
            context = await poolEntry.browser.newContext(getStealthContextOptions());
            lease.context = context;
            await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
            page = await context.newPage();
            await applyStealthPatches(page);

            await page.goto(url, { timeout, waitUntil: 'load' });

            // Give a Cloudflare/Turnstile interstitial a chance to auto-clear before we
            // start clicking/typing against what would otherwise be the challenge page.
            if (await pageLooksLikeChallenge(page)) {
                await waitForChallengeToClear(page, CF_CHALLENGE_WAIT_MS);
            }
            if (options.dismissOverlays !== false) await dismissOverlays(page).catch(() => []);
        }
        const sessionPoolEntry = continued ? sess.poolEntry : poolEntry;
        baselineLines = await visibleLines(page);
        const baselineUrl = page.url();

        let failure = null;
        for (let idx = 0; idx < steps.length; idx++) {
            const a = steps[idx];
            const entry = { step: idx + 1, type: a.type };
            if (a.selector) entry.target = String(a.selector).slice(0, 80);
            else if (a.byText) entry.target = `text "${String(a.byText).slice(0, 60)}"`;
            log.push(entry);
            if (!ACTION_TYPES.includes(a.type)) {
                entry.ok = false;
                entry.error = `unknown step type "${a.rawType || ''}" — skipped (supported: ${ACTION_TYPES.join(', ')})`;
                continue;
            }
            // Per-action timeout; the model can widen it for slow sites.
            const actTimeout = Math.max(500, Math.min(60000, parseInt(a.timeout || 8000, 10) || 8000));
            await page.waitForTimeout(randomDelay(80, 200));
            try {
                const before = await interactSignature(page);
                const busyBefore = await busyCount(page);
                const hint = {};
                if (lastTyped) {
                    const form = lastTyped.locator('xpath=ancestor::form[1]');
                    if (await form.count().catch(() => 0)) { hint.form = form; hint.formFrame = lastTypedFrame; }
                }
                const settle = (ms) => waitForResult(page, before, busyBefore, ms);
                const needTarget = async () => {
                    const loc = await resolveTarget(page, a, actTimeout, hint);
                    if (hint.resolvedAs) entry.resolvedAs = hint.resolvedAs;
                    if (!loc) throw new Error(a.selector
                        ? `selector '${a.selector}' matched nothing visible within ${actTimeout}ms`
                        : (a.byText || a.placeholder || a.label)
                            ? `nothing visible labelled "${a.byText || a.placeholder || a.label}"`
                            : `${a.type} needs a selector or the visible text of the element`);
                    return loc;
                };
                switch (a.type) {
                    case 'click':
                    case 'dblclick': {
                        const opt = await optionTarget(page, a);
                        if (opt) {
                            await chooseOption(opt, actTimeout);
                            entry.as = 'select option';
                            entry.changed = await settle(4000);
                            break;
                        }
                        const loc = await needTarget();
                        // Clicking a native <select> only opens its menu — nothing to wait for.
                        if (await loc.evaluate(el => el.tagName === 'SELECT').catch(() => false)) {
                            await loc.focus().catch(() => {});
                            entry.as = 'focus dropdown';
                            break;
                        }
                        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                        await unblockTarget(page, loc, entry);
                        if (a.type === 'dblclick') await loc.dblclick({ timeout: actTimeout });
                        else await loc.click({ timeout: actTimeout });
                        entry.changed = await settle(Math.min(actTimeout, 5000));
                        break;
                    }
                    case 'hover': {
                        const loc = await needTarget();
                        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                        await unblockTarget(page, loc, entry);
                        await loc.hover({ timeout: actTimeout });
                        entry.changed = await settle(1500);
                        break;
                    }
                    case 'set':
                    case 'type':
                    case 'select': {
                        const loc = await needTarget();
                        const tag = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
                        if (tag === 'select' || a.type === 'select') {
                            const v = String(a.value ?? a.text ?? '');
                            if (tag === 'select') {
                                try { await loc.selectOption(v, { timeout: actTimeout }); }
                                catch (_) { await loc.selectOption({ label: v }, { timeout: actTimeout }); }
                                entry.changed = await settle(4000);
                                lastTyped = null;
                                break;
                            }
                            // A custom dropdown (div/button): open it, then pick the option by text.
                            await loc.click({ timeout: actTimeout });
                            const opt = await resolveTarget(page, { type: 'click', byText: v }, actTimeout);
                            if (!opt) throw new Error(`option "${v}" not found in the dropdown`);
                            await opt.click({ timeout: actTimeout });
                            entry.changed = await settle(4000);
                            break;
                        }
                        if (tag === 'input' || tag === 'textarea' || a.type !== 'set') {
                            const inputType = (await loc.getAttribute('type').catch(() => '') || '').toLowerCase();
                            if (inputType === 'checkbox' || inputType === 'radio') {
                                const want = !/^(false|0|off|no|unchecked)$/i.test(String(a.value ?? a.text ?? 'true'));
                                if (want) await loc.check({ timeout: actTimeout }); else await loc.uncheck({ timeout: actTimeout });
                                entry.changed = await settle(3000);
                                break;
                            }
                        }
                        const text = String(a.text ?? '');
                        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                        await unblockTarget(page, loc, entry);
                        await loc.click({ timeout: Math.min(actTimeout, 3000) }).catch(() => {});
                        await loc.fill('', { timeout: actTimeout }).catch(() => {});
                        if (text.length <= 80) await loc.pressSequentially(text, { delay: randomDelay(20, 50), timeout: actTimeout });
                        else await loc.fill(text, { timeout: actTimeout });
                        lastTyped = loc;
                        lastTypedFrame = hint.frame || page.mainFrame();
                        if (a.submit || a.enter || a.pressEnter) {
                            await loc.press('Enter', { timeout: actTimeout });
                            entry.changed = await settle(8000);
                        }
                        break;
                    }
                    case 'press': {
                        const key = String(a.key || 'Enter');
                        if (a.selector || a.byText) await (await needTarget()).press(key, { timeout: actTimeout });
                        else await page.keyboard.press(key);
                        entry.changed = await settle(/^enter$/i.test(key) ? 8000 : 1500);
                        break;
                    }
                    case 'submit': {
                        const loc = a.selector || a.byText ? await needTarget() : lastTyped;
                        if (!loc) throw new Error('submit needs a selector, or a preceding type step');
                        await loc.press('Enter', { timeout: actTimeout });
                        entry.changed = await settle(8000);
                        break;
                    }
                    case 'check':
                    case 'uncheck': {
                        let loc = await needTarget();
                        const checkable = await loc.evaluate(el => el.matches('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]') || (el.tagName === 'LABEL' && !!el.control)).catch(() => false);
                        if (!checkable) {
                            const inner = loc.locator('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]').first();
                            if (await inner.count().catch(() => 0)) loc = inner;
                            else {
                                const near = (a.byText || a.label) ? await checkboxNearText(hint.frame || page.mainFrame(), String(a.byText || a.label)) : null;
                                if (!near) throw new Error(`the element ${entry.target || ''} is not a checkbox or radio button, and none sits next to it`);
                                loc = near;
                                entry.resolvedAs = `the checkbox next to "${a.byText || a.label}"`;
                            }
                        }
                        if (a.type === 'check') await loc.check({ timeout: actTimeout, force: !(await loc.isVisible().catch(() => false)) }); else await loc.uncheck({ timeout: actTimeout, force: !(await loc.isVisible().catch(() => false)) });
                        entry.changed = await settle(3000);
                        break;
                    }
                    case 'scroll': {
                        if (a.selector || a.byText) {
                            await (await needTarget()).scrollIntoViewIfNeeded({ timeout: actTimeout });
                        } else if (a.to === 'bottom' || a.to === 'end' || a.times > 1) {
                            let grew = false;
                            for (let k = 0; k < a.times; k++) { if (await scrollForMore(page, 4000)) grew = true; else break; }
                            entry.changed = grew;
                        } else if (a.to === 'top') {
                            await page.evaluate(() => window.scrollTo(0, 0));
                        } else {
                            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                            entry.changed = await settle(1500);
                        }
                        break;
                    }
                    case 'wait': {
                        if (a.selector || a.byText) {
                            // In the page or any of its frames.
                            const until = Date.now() + actTimeout;
                            let seen = false;
                            while (!seen && Date.now() < until) {
                                for (const fr of interactFrames(page)) {
                                    const l = a.selector ? fr.locator(a.selector) : fr.getByText(String(a.byText));
                                    if (await l.first().isVisible().catch(() => false)) { seen = true; break; }
                                }
                                if (!seen) await page.waitForTimeout(250);
                            }
                            if (!seen) throw new Error(`waited ${actTimeout}ms but ${a.selector ? `'${a.selector}'` : `the text "${a.byText}"`} never appeared`);
                        } else await page.waitForTimeout(Math.min(15000, parseInt(a.ms ?? a.waitMs ?? a.wait ?? a.delay ?? a.duration ?? a.sleep ?? a.pause ?? a.timeout ?? 1000, 10) || 1000));
                        break;
                    }
                    case 'waitfornavigation': {
                        // A preceding click has very often ALREADY navigated before
                        // this step starts listening; a change-wait covers both.
                        entry.changed = await settle(actTimeout);
                        if (!entry.changed) await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
                        break;
                    }
                    case 'back': {
                        await page.goBack({ timeout: actTimeout, waitUntil: 'load' });
                        break;
                    }
                    case 'snapshot': {
                        entry.captured = await snapshot(a.label || null);
                        break;
                    }
                    case 'nextpage': {
                        if (!snapshots.length) await snapshot('page 1');
                        const visited = new Set(snapshots.map(s => stripHashUrl(s.url)));
                        let moved = 0;
                        for (let k = 0; k < a.times; k++) {
                            const adv = await advanceToNext(page, { nextSelector: a.selector || undefined, timeout, visited });
                            if (!adv.ok) { entry.stoppedBecause = adv.reason; break; }
                            visited.add(stripHashUrl(page.url()));
                            moved++;
                            if (!(await snapshot(`page ${snapshots.length + 1}`))) { entry.stoppedBecause = 'the next page repeated the previous one'; break; }
                        }
                        entry.pagesAdvanced = moved;
                        if (!moved && !entry.stoppedBecause) entry.stoppedBecause = 'no next page';
                        break;
                    }
                    case 'loadmore': {
                        let clicks = 0;
                        for (let k = 0; k < a.times; k++) {
                            const loc = await findLoadMore(page, a.selector || null);
                            if (!loc) { entry.stoppedBecause = 'no load-more control'; break; }
                            const b = await pageSignature(page);
                            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                            await loc.click({ timeout: actTimeout });
                            if (!(await waitForChange(page, b, 8000))) { entry.stoppedBecause = 'load-more added nothing'; break; }
                            clicks++;
                        }
                        entry.clicks = clicks;
                        break;
                    }
                }
                entry.ok = true;
            } catch (actionErr) {
                const raw = String(actionErr?.message || actionErr).split('\n')[0];
                entry.ok = false;
                const full = String(actionErr?.message || actionErr);
                const intercept = full.match(/<([a-z0-9-]+)([^>]{0,120})>[^\n]{0,160}?intercepts pointer events/i);
                entry.error = entry.blockedBy
                    ? `the element is covered by "${entry.blockedBy}" — close or answer that first (click its button), then retry`
                    : intercept
                        ? `the element is covered by another element (<${intercept[1]}${intercept[2].slice(0, 80)}>) — close the overlay first, then retry`
                        : /timeout .* exceeded/i.test(raw)
                            ? `timed out after ${actTimeout}ms — the element is missing, hidden or covered`
                            : raw.slice(0, 240);
                failure = { index: idx, error: entry.error };
                break;
            }
        }

        // Continuing on the open page, but its FIRST step already fails: the
        // model is most likely re-sending its whole flow from the top. Run it
        // again on a fresh load of the start page.
        if (continued && failure && failure.index === 0) {
            await context.close().catch(() => {});
            context = null; page = null;
            lease.clear();
            keep = true;   // nothing left to clean up here; the rerun owns the session
            return await interactAndFetch(startUrl, actions, { ...options, _fresh: true });
        }

        // Unrecognized steps were skipped (not fatal — a trailing pause with no
        // type must not throw away a run that worked); report them.
        const skippedSteps = log.filter(e => e.ok === false && /^unknown step type/.test(e.error || '')).map(e => e.step);
        // Fields were filled but nothing submitted after the last fill. The
        // browser session ENDS with this call, so a follow-up call to "click
        // Search" opens a fresh page with an empty form — the model split one
        // form flow across calls and lost the input every time.
        const FILL = new Set(['set', 'type', 'select', 'check', 'uncheck']);
        const isFill = (e) => e.ok && (FILL.has(e.type) || e.as === 'select option');
        const lastFill = log.reduce((k, e, i) => (isFill(e) ? i : k), -1);
        const submittedAfter = lastFill >= 0 && log.slice(lastFill + 1).some(e => e.ok && !e.as && ['click', 'dblclick', 'press', 'submit', 'nextpage'].includes(e.type));
        const unsubmitted = lastFill >= 0 && !submittedAfter && !(steps[lastFill] && (steps[lastFill].submit || steps[lastFill].enter || steps[lastFill].pressEnter)) && !log[lastFill].changed;
        await page.waitForTimeout(randomDelay(150, 300));
        // Read the page's lines BEFORE extracting readable content: the
        // extractor takes iframes out of the live document, which would hide
        // the result of a form submitted inside one.
        const afterLines = baselineLines ? await visibleLines(page) : null;
        const title = await page.title().catch(() => '');
        const pagination = await domPagination(page);

        let content;
        if (snapshots.length) {
            // Anything done after the last capture (a click, a scroll) is part
            // of the answer too.
            const lastWasCapture = ['snapshot', 'nextpage'].includes(steps[steps.length - 1]?.type);
            if (!lastWasCapture || failure) await snapshot('final');
            const per = Math.max(1500, Math.floor(Math.max(maxLength, 6000 * Math.min(snapshots.length, 5)) / snapshots.length));
            content = snapshots
                .map((sn, i) => `=== ${sn.label || `Capture ${i + 1}`}: ${sn.title || '(no title)'} — ${sn.url} ===\n${sn.content.slice(0, per)}`)
                .join('\n\n');
        } else {
            content = await extractContent(page, options);
        }

        // What the steps changed: lines that are on the page now and were not
        // before the first step. A wholesale new page (navigation to a
        // different document) is already the content itself.
        let pageChanges = null;
        if (baselineLines) {
            const d = lineDiff(baselineLines, afterLines);
            // Navigated to another document: the content already IS that page,
            // so only a short one (a result/confirmation page) is listed.
            const navigated = !sameDocUrl(baselineUrl, page.url());
            if (d.added.length > (navigated ? 25 : 150)) pageChanges = { newPage: true, addedLines: d.added.length, removedLines: d.removed };
            else if (d.added.length) {
                const shown = [];
                let budget = 3500;
                for (const l of d.added) { const x = l.slice(0, 240); if (budget - x.length < 0) break; shown.push(x); budget -= x.length + 1; }
                pageChanges = { added: shown, addedLines: d.added.length, removedLines: d.removed };
                if (!snapshots.length) {
                    content = `New on the page after your steps (${d.added.length} line${d.added.length === 1 ? '' : 's'} that were not there before):\n`
                        + shown.map(l => `+ ${l}`).join('\n') + (shown.length < d.added.length ? `\n+ … ${d.added.length - shown.length} more` : '')
                        + `\n\n${content}`;
                }
            } else pageChanges = { added: [], addedLines: 0, removedLines: d.removed };
        }
        const noEffect = log.filter(e => e.ok && e.changed === false && ['click', 'dblclick', 'press', 'submit'].includes(e.type) && !e.as).map(e => e.step);

        if (sessionKey) {
            keep = true;
            keepInteractSession(sessionKey, { context, page, poolEntry: sessionPoolEntry, startUrl, timer: null });
        }
        const base = {
            content,
            title,
            url,
            finalUrl: page.url(),
            steps: log,
            ...(skippedSteps.length ? { skippedSteps } : {}),
            ...(pageChanges ? { pageChanges } : {}),
            // A click that changed nothing usually hit the wrong element: hand
            // back the real controls so the retry can target one of them.
            ...(noEffect.length ? { stepsWithoutEffect: noEffect, ...(failure ? {} : { controls: await listControls(page) }) } : {}),
            ...(unsubmitted ? { formNotSubmitted: true } : {}),
            ...(continued ? { continuedFrom: startUrl } : {}),
            ...(sessionKey ? { pageKeptOpen: true } : {}),
            ...(snapshots.length > 1 ? { pagesCaptured: snapshots.length } : {}),
            ...(pagination ? { pagination } : {}),
        };
        if (failure) {
            return {
                success: false,
                error: `step ${failure.index + 1} (${steps[failure.index].type}) failed: ${failure.error}`,
                failedStep: failure.index + 1,
                controls: await listControls(page),
                ...base,
            };
        }
        return { success: true, ...base };

    } catch (error) {
        return {
            success: false,
            error: lease.errorOf(error),
            url,
            ...(log.length ? { steps: log } : {}),
        };
    } finally {
        lease.clear();
        if (!keep) {
            if (sessionKey) interactSessions.delete(sessionKey);
            if (page) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
        }
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

/**
 * Download a file URL through the real browser.
 *
 * Bot-protection layers (Akamai/Cloudflare) fingerprint the TLS/HTTP stack and
 * 403 axios AND curl even with full browser headers — the real Chromium is the
 * only client they let through. But headless Chromium can't render a PDF:
 * page.goto throws "Download is starting" instead. This captures that download
 * event and returns the raw bytes so the caller can parse them (pdf-parse etc.).
 *
 * @returns {Object} { success, buffer, filename, contentType, via } or { success:false, error }
 */
async function downloadFile(url, options = {}) {
    const { timeout = 30000, maxBytes = 50 * 1024 * 1024 } = options;
    const fs = require('fs');

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('downloadFile', url, hardDeadlineFor(timeout, 45000));

    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext({
            ...getStealthContextOptions(),
            acceptDownloads: true,
        });
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        await applyStealthPatches(page);

        // Listen BEFORE goto — the download event fires while goto is throwing.
        const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null);

        let response = null;
        let navTriggeredDownload = false;
        try {
            response = await page.goto(url, { timeout, waitUntil: 'load' });
        } catch (e) {
            const msg = e?.message || String(e);
            if (!/Download is starting|net::ERR_ABORTED/i.test(msg)) throw e;
            navTriggeredDownload = true;
        }

        if (navTriggeredDownload) {
            const download = await downloadPromise;
            if (!download) throw new Error('Navigation triggered a download but none was captured');
            const failure = await download.failure();
            if (failure) throw new Error(`Download failed: ${failure}`);
            const filePath = await download.path();
            const size = fs.statSync(filePath).size;
            if (size > maxBytes) {
                await download.delete().catch(() => {});
                throw new Error(`Download too large (${size} bytes > ${maxBytes} limit)`);
            }
            const buffer = fs.readFileSync(filePath);
            await download.delete().catch(() => {});
            return {
                success: true,
                buffer,
                filename: download.suggestedFilename() || url.split('?')[0].split('/').pop() || 'download',
                contentType: null,
                via: 'download-event',
                url,
            };
        }

        // Navigation completed normally — a non-HTML response (inline PDF, raw
        // text/JSON served with a permissive content-disposition) can be taken
        // straight from the response body.
        if (response && response.ok()) {
            const ct = (response.headers()['content-type'] || '').toLowerCase();
            if (ct && !ct.includes('text/html')) {
                const buffer = await response.body();
                if (buffer.length > maxBytes) throw new Error(`Response too large (${buffer.length} bytes > ${maxBytes} limit)`);
                return {
                    success: true,
                    buffer,
                    filename: url.split('?')[0].split('/').pop() || 'download',
                    contentType: ct,
                    via: 'response-body',
                    url,
                };
            }
            throw new Error(`URL served an HTML page (content-type: ${ct || 'unknown'}), not a file`);
        }
        throw new Error(`HTTP ${response?.status() || 'no response'}`);
    } catch (error) {
        return { success: false, error: lease.errorOf(error), url };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

/**
 * Cleanup all browsers in pool
 */
async function cleanup() {
    if (poolCleanupInterval) {
        clearInterval(poolCleanupInterval);
        poolCleanupInterval = null;
    }

    for (const entry of browserPool) {
        try {
            if (entry.browser) await entry.browser.close();   // null while a slot is still launching
        } catch (e) {}
    }

    browserPool = [];
}

/**
 * Get pool status
 */
function getPoolStatus() {
    return {
        size: browserPool.length,
        maxSize: MAX_POOL_SIZE,
        inUse: browserPool.filter(b => b.inUse).length,
        available: browserPool.filter(b => !b.inUse && b.browser.isConnected()).length
    };
}

// Common selectors the crawler tries when the caller doesn't pass an
// explicit nextSelector / loadMoreSelector. Ordered specific → generic.
const NEXT_SELECTORS = [
    'a[rel="next"]',
    'nav a[rel="next"]',
    '[aria-label="Next page"]',
    '[aria-label*="next page" i]',
    '[aria-label*="Next" i]:not([aria-label*="previous" i]):not([aria-label*="slide" i]):not([aria-label*="image" i]):not([aria-label*="photo" i]):not([aria-label*="video" i]):not([aria-label*="article" i]):not([aria-label*="story" i]):not([aria-label*="month" i])',
    '.pagination-next a',
    '.pagination-next',
    '.pagination .next a',
    '.pagination li.next a',
    '.page-next',
    'a.next',
    'a.pagination__next',
    'button[aria-label*="Next" i]',
];
const LOAD_MORE_SELECTORS = [
    'button[class*="load-more" i]',
    'button[class*="loadmore" i]',
    'button[class*="show-more" i]',
    '[aria-label*="Load more" i]',
    '[aria-label*="Show more" i]',
    'a[class*="load-more" i]',
    'a[class*="loadmore" i]',
];

// "Next page" as visible text, for controls with no rel/aria/class signal.
// Anchored so "Next article" / "Next slide" never match.
const NEXT_CONTROL_TEXT = /^\s*(?:next(?:\s+page|\s+results?)?|older(?:\s+(?:posts|entries|articles|results))?|more\s+results)?\s*[›»→>❯]?\s*$/i;
const LOAD_MORE_TEXT = /^\s*(?:load|show|see|view)\s+more(?:\s+\w+){0,2}\s*$|^\s*more\s+results\s*$/i;

async function findFirstVisible(page, selectors) {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.count() === 0) continue;
            if (!(await loc.isVisible().catch(() => false))) continue;
            if (await isDisabledControl(loc)) continue;
            return loc;
        } catch (_) { /* try next */ }
    }
    return null;
}

async function isDisabledControl(loc) {
    try {
        return await loc.evaluate((el) => el.hasAttribute('disabled')
            || el.getAttribute('aria-disabled') === 'true'
            || /\bdisabled\b/i.test(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '')));
    } catch (_) { return false; }
}

// First visible, enabled control whose WHOLE visible text matches `re`.
async function findByText(page, re, roles = 'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]') {
    try {
        const matches = page.locator(roles).filter({ hasText: re });
        const n = Math.min(await matches.count(), 8);
        for (let i = 0; i < n; i++) {
            const loc = matches.nth(i);
            const text = ((await loc.innerText().catch(() => '')) || '').trim();
            if (!text || !re.test(text)) continue;   // filter() is a substring test; require the whole label
            if (!(await loc.isVisible().catch(() => false))) continue;
            if (await isDisabledControl(loc)) continue;
            return loc;
        }
    } catch (_) { /* no match */ }
    return null;
}

// Normalized anchor list from the rendered DOM (same shape as
// pagination.anchorsFromHtml), with a pager-context marker the regex path
// cannot see.
async function domAnchors(page) {
    try {
        return await page.evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll('link[rel][href], a[href]')) {
                if (out.length >= 2000) break;
                let href = el.getAttribute('href') || '';
                if (!href || href[0] === '#' || /^(javascript|mailto|tel):/i.test(href)) continue;
                try { href = new URL(href, document.baseURI).href; } catch (_) { continue; }
                const isA = el.tagName === 'A';
                const cls = typeof el.className === 'string' ? el.className : '';
                const ctx = isA && el.closest('nav, [role="navigation"], [class*="pagin" i], [class*="pager" i], .page-numbers, .nav-links') ? ' pagerctx' : '';
                out.push({
                    href,
                    rel: (el.getAttribute('rel') || '').toLowerCase(),
                    text: isA ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
                    label: (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 80),
                    cls: `${cls} ${el.id || ''}${ctx}`.slice(0, 200),
                    disabled: el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(cls),
                });
            }
            return out;
        });
    } catch (_) { return []; }
}

async function domPagination(page) {
    try { return paginationSvc.detectPagination(await domAnchors(page), page.url()); } catch (_) { return null; }
}

// Cheap fingerprint of what is on screen — tells whether an action DID
// something (navigated, re-rendered results, appended items).
async function pageSignature(page) {
    try {
        return await page.evaluate(() => {
            const t = (document.body && document.body.innerText) || '';
            let h = 0;
            for (let i = 0; i < t.length; i += 5) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
            return `${location.href}|${t.length}|${h}`;
        });
    } catch (_) { return ''; }   // mid-navigation: the context is being replaced
}

// Wait until the URL or the page text changes (navigation, an XHR re-render,
// appended items), then until it stops changing. The old code slept a fixed
// 300 ms after a click — a search-results page that re-rendered 800 ms later
// was extracted BEFORE the new results, and the crawler compared page 2 with
// page 1, found them identical and stopped ("pagination exhausted").
async function waitForChange(page, before, maxMs = 6000, sigOf = pageSignature) {
    const start = Date.now();
    let changed = false;
    while (Date.now() - start < maxMs) {
        await page.waitForTimeout(200);
        const now = await sigOf(page);
        if (now && now !== before) { changed = true; break; }
    }
    if (!changed) return false;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    let last = await sigOf(page);
    const settleStart = Date.now();
    while (Date.now() - settleStart < 3000) {
        await page.waitForTimeout(350);
        const cur = await sigOf(page);
        if (cur === last) break;
        last = cur;
    }
    return true;
}

// Scroll down in viewport steps (so lazy observers along the way fire) and
// wait for the document to grow.
async function scrollForMore(page, maxWaitMs = 5000) {
    const heightOf = () => page.evaluate(() => document.body ? document.body.scrollHeight : 0).catch(() => 0);
    const before = await heightOf();
    await page.evaluate(async () => {
        let y = window.scrollY;
        for (let k = 0; k < 40 && y < document.body.scrollHeight; k++) {
            y += Math.round(window.innerHeight * 0.9);
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
        }
    }).catch(() => {});
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        await page.waitForTimeout(300);
        if ((await heightOf()) > before) { await page.waitForTimeout(600); return true; }
    }
    return false;
}

function stripHashUrl(u) { return String(u || '').split('#')[0]; }

// Advance a stateful browser session to the next page of a listing.
//   1. explicit nextSelector → click it
//   2. a real next-page href on the page → navigate to it (robust: no
//      click/navigation race, no overlay stealing the click)
//   3. a next control without a usable href (JS pager) → click + wait for change
async function advanceToNext(page, { nextSelector, timeout = 20000, visited } = {}) {
    const before = await pageSignature(page);
    const click = async (loc, how) => {
        try { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await loc.click({ timeout: Math.min(timeout, 8000) }); }
        catch (e) { return { ok: false, reason: `could not click the next control (${String(e.message || e).split('\n')[0].slice(0, 120)})` }; }
        const changed = await waitForChange(page, before, 8000);
        return changed ? { ok: true, how } : { ok: false, reason: 'clicking the next control did not change the page' };
    };
    if (nextSelector) {
        const loc = page.locator(nextSelector).first();
        if (!(await loc.count().catch(() => 0))) return { ok: false, reason: `nextSelector ${nextSelector} matched nothing` };
        if (await isDisabledControl(loc)) return { ok: false, reason: 'the next control is disabled (last page)' };
        return click(loc, 'selector');
    }
    const p = await domPagination(page);
    if (p && p.next) {
        if (visited && visited.has(stripHashUrl(p.next))) return { ok: false, reason: 'pagination loops back to a page already read' };
        try {
            await page.goto(p.next, { timeout, waitUntil: 'load' });
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
            return { ok: true, how: `link (${p.via || 'detected'})` };
        } catch (e) { return { ok: false, reason: `next page ${p.next} failed to load (${String(e.message || e).split('\n')[0].slice(0, 100)})` }; }
    }
    const loc = (await findFirstVisible(page, NEXT_SELECTORS)) || (await findByText(page, NEXT_CONTROL_TEXT));
    if (!loc) return { ok: false, reason: p && p.current && p.last && p.current >= p.last ? 'this is the last page' : 'no next-page control found' };
    const href = await loc.getAttribute('href').catch(() => null);
    if (href && !/^\s*(#|javascript:)/i.test(href)) {
        try {
            const abs = new URL(href, page.url()).href;
            if (paginationSvc.sameSite(abs, page.url()) && !(visited && visited.has(stripHashUrl(abs)))) {
                await page.goto(abs, { timeout, waitUntil: 'load' });
                await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
                return { ok: true, how: 'link' };
            }
        } catch (_) { /* fall through to a click */ }
    }
    return click(loc, 'click');
}

async function findLoadMore(page, loadMoreSelector) {
    if (loadMoreSelector) {
        const loc = page.locator(loadMoreSelector).first();
        return (await loc.count().catch(() => 0)) ? loc : null;
    }
    return (await findFirstVisible(page, LOAD_MORE_SELECTORS)) || (await findByText(page, LOAD_MORE_TEXT));
}

async function detectPaginationMode(page, opts = {}) {
    if (opts.nextSelector) return 'link-follow';
    if (opts.loadMoreSelector) return 'load-more';
    const p = await domPagination(page);
    if (p && p.next) return 'link-follow';
    if (await findFirstVisible(page, NEXT_SELECTORS)) return 'link-follow';
    if (await findLoadMore(page, null)) return 'load-more';
    if (await findByText(page, NEXT_CONTROL_TEXT)) return 'link-follow';
    return 'infinite-scroll';
}

async function crawlPages(url, options = {}) {
    const {
        mode = 'auto',
        maxPages = 5,
        nextSelector,
        loadMoreSelector,
        timeout = 20000,
        maxLength = 30000,
        waitForSelector,
        includeLinks = false,
    } = options;

    const cappedMaxPages = Math.min(20, Math.max(1, parseInt(maxPages, 10) || 5));
    const perPageCap = Math.max(500, Math.floor(maxLength / cappedMaxPages));

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('crawlPages', url, hardDeadlineFor(timeout, cappedMaxPages * 25000));

    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        await applyStealthPatches(page);

        await page.goto(url, { timeout, waitUntil: 'load' });
        if (await pageLooksLikeChallenge(page)) await waitForChallengeToClear(page, CF_CHALLENGE_WAIT_MS);
        await dismissOverlays(page).catch(() => []);
        if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout }).catch(() => {});
        }

        const resolvedMode = mode === 'auto'
            ? await detectPaginationMode(page, { nextSelector, loadMoreSelector })
            : mode;
        // load-more / infinite-scroll pages ACCUMULATE: each extraction holds
        // every earlier item again, and the old per-page cap then cut exactly
        // the new items off the end. Diff them against what was already seen.
        const accumulating = resolvedMode === 'load-more' || resolvedMode === 'infinite-scroll';

        const pages = [];
        let total = 0;
        let firstLines = null;
        const seen = new Set();
        const visited = new Set();
        let stoppedBecause = null;

        for (let i = 0; i < cappedMaxPages; i++) {
            await page.waitForTimeout(randomDelay(120, 300));
            const raw = await extractContent(page, {
                includeLinks,
                maxLength: accumulating ? Math.min(200000, Math.max(maxLength * 2, 60000)) : perPageCap * 2,
            });
            const title = await page.title().catch(() => '');
            const currentUrl = page.url();
            visited.add(stripHashUrl(currentUrl));

            let content;
            if (i === 0) {
                content = raw;
                firstLines = raw.split('\n');
                paginationSvc.rememberLines(raw, seen);
            } else if (accumulating) {
                content = paginationSvc.newLinesOnly(raw, seen);
            } else {
                content = paginationSvc.stripRepeatedChrome(raw, firstLines);
            }
            if (i > 0 && paginationSvc.meaningfulLength(content) < 40) { stoppedBecause = 'no new content on the next page'; break; }

            pages.push({ index: i, url: currentUrl, title, content: content.slice(0, perPageCap) });
            total += Math.min(content.length, perPageCap);
            if (total >= maxLength) { stoppedBecause = 'length budget reached'; break; }
            if (i === cappedMaxPages - 1) { stoppedBecause = 'maxPages reached'; break; }

            if (resolvedMode === 'link-follow') {
                const adv = await advanceToNext(page, { nextSelector, timeout, visited });
                if (!adv.ok) { stoppedBecause = adv.reason; break; }
            } else if (resolvedMode === 'load-more') {
                const moreLoc = await findLoadMore(page, loadMoreSelector);
                if (!moreLoc) { stoppedBecause = 'no load-more control left'; break; }
                const before = await pageSignature(page);
                try {
                    await moreLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    await moreLoc.click({ timeout: Math.min(timeout, 8000) });
                } catch (e) { stoppedBecause = 'could not click the load-more control'; break; }
                if (!(await waitForChange(page, before, 8000))) { stoppedBecause = 'load-more did not add anything'; break; }
            } else {
                if (!(await scrollForMore(page))) { stoppedBecause = 'scrolling loaded nothing more'; break; }
            }
        }

        const pagination = await domPagination(page);
        return {
            success: true,
            url,
            finalUrl: page.url(),
            mode: resolvedMode,
            pagesVisited: pages.length,
            pages,
            ...(stoppedBecause ? { stoppedBecause } : {}),
            ...(pagination ? { pagination } : {}),
        };
    } catch (error) {
        return { success: false, error: lease.errorOf(error), url };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

/**
 * Sniff streaming-media network traffic from a page.
 *
 * Loads `url` in a real (stealth) browser and PASSIVELY records every network
 * request/response whose URL or content-type identifies it as streaming media:
 *   • HLS manifests  — *.m3u8  / application/vnd.apple.mpegurl
 *   • DASH manifests — *.mpd   / application/dash+xml
 *   • direct files   — *.mp4/.webm/.mov/.m4v/.ogv/.flv (and any video/* response)
 * Many players only request the real stream once the user presses play, so when
 * `interact` is true it also un-mutes+plays any <video>, clicks common play
 * controls, and keeps listening for a few seconds — this is what surfaces the
 * stream URL that a JS player fetches but never writes into the page HTML.
 *
 * Read-only: it never downloads response bodies (header sniff only) and never
 * blocks or rewrites requests, so the player initialises exactly as it would
 * for a real visitor. HLS/DASH *segments* (.ts/.m4s/init/seg-N) are counted but
 * dropped from `media` — the manifest is the thing that plays.
 *
 * @param {string} url
 * @param {Object} options
 * @param {boolean} options.interact   click/auto-play to trigger lazy streams (default true)
 * @param {number}  options.timeout    navigation timeout ms (default 20000)
 * @param {number}  options.settleMs   quiet wait after load before interacting (default 3500)
 * @param {number}  options.captureMs  listen window after interaction (default 6000)
 * @param {number}  options.maxResults cap on returned media URLs (default 25)
 * @returns {Object} { success, url, finalUrl, title, media:[{url,kind,contentType,phase}],
 *                     pageVideos:[...], counts:{hls,dash,file,segment}, error? }
 */
async function sniffMediaStreams(url, options = {}) {
    const {
        interact = true,
        timeout = 20000,
        settleMs = 3500,
        captureMs = 6000,
        maxResults = 25,
        // When true (find_video's single-pick fallback), the settle + capture
        // waits bail as soon as a manifest is observed, instead of burning the
        // full fixed windows. The native sniff_media_streams inventory tool keeps
        // earlyExit=false so it still returns the COMPLETE stream inventory.
        earlyExit = false,
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('sniffMediaStreams', url, hardDeadlineFor(timeout, settleMs + captureMs));

    const media = new Map();            // url(no #) -> { url, kind, contentType, phase }
    const counts = { hls: 0, dash: 0, file: 0, segment: 0 };
    let currentPhase = 'load';

    // Decorative/asset files that look like media but aren't content.
    const ASSET = /favicon|sprite|\/icons?\/|\/logos?\/|placeholder|loading|spinner|site\.webm|\/ads?\/|advert/i;

    // Classify a (url, contentType) pair → 'hls' | 'dash' | 'file' | 'segment' | null.
    const classify = (u, ct) => {
        const s = String(u || '');
        if (!/^https?:\/\//i.test(s)) return null;        // skip blob:/data:/about:
        const path = s.split('#')[0].split('?')[0].toLowerCase();
        const c = String(ct || '').toLowerCase();
        // Manifests (highest value) — match first so a ?query'd .m3u8 still wins.
        if (/\.m3u8$/.test(path) || c.includes('mpegurl')) return 'hls';
        if (/\.mpd$/.test(path) || c.includes('dash+xml')) return 'dash';
        // HLS/DASH media segments → noise (counted, not returned).
        if (/\.(ts|m4s)$/.test(path) || c === 'video/mp2t' ||
            /\binit\.(mp4|m4s|cmf[vat])$/.test(path) ||
            /(?:^|[\/_-])(?:seg(?:ment)?|chunk|frag)[-_]?\d+/.test(path)) return 'segment';
        // Direct, progressive files.
        if (/\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi|flv|m2ts|3gp)$/.test(path)) {
            return ASSET.test(s) ? null : 'file';
        }
        // Content-type says video but the URL didn't (CDN with an opaque path).
        if (/^video\//.test(c) && !ASSET.test(s)) return 'file';
        return null;
    };

    const record = (u, ct) => {
        const kind = classify(u, ct);
        if (!kind) return;
        counts[kind] = (counts[kind] || 0) + 1;
        if (kind === 'segment') return;                   // tracked, never surfaced
        const key = String(u).split('#')[0];
        if (media.has(key)) return;
        media.set(key, { url: key, kind, contentType: ct || '', phase: currentPhase });
    };

    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        await applyStealthPatches(page);

        // Passive listeners — observe only; never block, never read bodies.
        page.on('request', (req) => { try { record(req.url(), ''); } catch (_) {} });
        page.on('response', (resp) => { try { record(resp.url(), resp.headers()['content-type'] || ''); } catch (_) {} });

        // Wait helper: fixed window normally; under earlyExit, poll in 250ms steps
        // and bail the instant an HLS/DASH manifest is observed (segments are
        // unreliable — they may never appear within the window — so gate on
        // manifests only), capped at the same window.
        const waitWindow = async (capMs) => {
            if (!earlyExit) { await page.waitForTimeout(capMs); return; }
            const steps = Math.max(1, Math.ceil(capMs / 250));
            for (let i = 0; i < steps; i++) {
                if (counts.hls > 0 || counts.dash > 0) break;
                await page.waitForTimeout(250);
            }
        };

        // Don't hard-fail on a >=400 HTML status — some player pages 403 the
        // document yet still expose the stream over XHR.
        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        // networkidle never fires on a live-streaming page, so the old 8s cap was
        // pure wasted wait (the catch already swallows the timeout); 3s is enough
        // for non-streaming setup. Applies to both paths.
        try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch (_) {}
        await waitWindow(settleMs);

        // Supplement with DOM-declared sources (cheap; catches <video>/og:video)
        // plus provider <iframe> players the JS injected — a YouTube/Vimeo/etc.
        // embed is cross-origin so the network listener never sees its stream,
        // and a static scrape never saw the iframe; without this such a page
        // recovers nothing.
        let pageVideos = [], pageEmbeds = [];
        try {
            const domMedia = await page.evaluate(() => {
                const vids = [], embeds = [];
                const EMBED_HOST = /(youtube\.com\/embed|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|vimeo\.com\/video|dailymotion\.com\/embed|geo\.dailymotion\.com|player\.twitch\.tv|facebook\.com\/plugins\/video|streamable\.com\/[eo]\/|wistia|brightcove|jwplayer|kaltura)/i;
                document.querySelectorAll('video[src]').forEach((v) => v.getAttribute('src') && vids.push(v.getAttribute('src')));
                document.querySelectorAll('video source[src]').forEach((s) => s.getAttribute('src') && vids.push(s.getAttribute('src')));
                const og = document.querySelector('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]');
                if (og && og.getAttribute('content')) vids.push(og.getAttribute('content'));
                document.querySelectorAll('iframe[src]').forEach((f) => { const s = f.getAttribute('src') || ''; if (EMBED_HOST.test(s)) embeds.push(s); });
                return { vids, embeds };
            });
            pageVideos = domMedia.vids || [];
            pageEmbeds = (domMedia.embeds || []).map((u) => { try { return new URL(u, page.url()).href; } catch (_) { return null; } }).filter(Boolean);
        } catch (_) { pageVideos = []; pageEmbeds = []; }
        for (const u of pageVideos) {
            let abs = null;
            try { abs = new URL(u, page.url()).href; } catch (_) { abs = null; }
            if (abs) record(abs, '');
        }

        // Interaction phase: provoke lazy-loaded streams.
        if (interact) {
            currentPhase = 'interact';
            try {
                await page.evaluate(() => {
                    document.querySelectorAll('video').forEach((v) => {
                        try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
                    });
                });
            } catch (_) {}
            const SELECTORS = [
                'button[aria-label*="play" i]', '[aria-label*="play" i][role="button"]',
                '.ytp-large-play-button', '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid',
                '[class*="play-button"]', '[class*="playButton"]', '[class*="play-btn"]',
                'button.play', '.video-play', 'button[title*="play" i]',
            ];
            for (const sel of SELECTORS) {
                try {
                    const el = page.locator(sel).first();
                    if (await el.isVisible().catch(() => false)) {
                        await el.click({ timeout: 1500 }).catch(() => {});
                        break;
                    }
                } catch (_) {}
            }
            // Fallback: click the center of the first sizeable <video> element.
            try {
                const box = await page.locator('video').first().boundingBox().catch(() => null);
                if (box && box.width > 80) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
            } catch (_) {}
            await waitWindow(captureMs);
        }

        // Order: manifests first (hls, then dash), then files; preserve
        // discovery order within a rank (V8 sort is stable).
        const rank = { hls: 0, dash: 1, file: 2 };
        const out = Array.from(media.values())
            .sort((a, b) => (rank[a.kind] - rank[b.kind]))
            .slice(0, maxResults);

        return {
            success: true,
            url,
            finalUrl: page.url(),
            title: await page.title().catch(() => ''),
            media: out,
            embeds: pageEmbeds,
            pageVideos,
            counts,
        };
    } catch (error) {
        return {
            success: false,
            error: lease.errorOf(error),
            url,
            media: Array.from(media.values()).slice(0, maxResults),
            counts,
        };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

// Load a (often JS-rendered) page in a real browser and read the images the
// way a human would after "right click → save image as": the actually-rendered
// <img> elements (with their true natural dimensions), <picture>/<source>
// srcsets, large CSS background images, and og:image/twitter:image. Static HTML
// scraping misses all of these on SPA/lazy-loaded gallery pages (wallpaper
// sites, Unsplash, Pexels, etc.), which is why the model otherwise loops trying
// to parse image URLs out of dead markup. Returns absolute URLs, largest first.
async function extractPageImages(url, options = {}) {
    const {
        timeout = 22000,
        settleMs = 2500,
        minDimension = 256,   // ignore icons/sprites/thumbnails below this
        maxResults = 16,
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('extractPageImages', url, hardDeadlineFor(timeout, settleMs));

    // URL fragments that mark a decorative/non-content image.
    const ASSET = /sprite|favicon|\/icons?\/|[-_]icon[-_.]|\/logos?\/|[-_]logo[-_.]|avatar|placeholder|spinner|loading|1x1|blank\.|pixel\.|spacer|data:image/i;

    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        await applyStealthPatches(page);

        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
        await page.waitForTimeout(settleMs);

        // Scroll through the page to trigger lazy-loaded images, then settle.
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let total = 0;
                    const step = () => {
                        window.scrollBy(0, window.innerHeight);
                        total += window.innerHeight;
                        if (total < document.body.scrollHeight && total < 25000) setTimeout(step, 140);
                        else { window.scrollTo(0, 0); resolve(); }
                    };
                    step();
                });
            });
            await page.waitForTimeout(700);
        } catch (_) {}

        let raw = [];
        try {
            raw = await page.evaluate(() => {
                const out = [];
                const seen = new Set();
                const abs = (u) => { try { return new URL(u, location.href).href; } catch (_) { return null; } };
                const push = (rawUrl, w, h, src) => {
                    const u = abs(rawUrl);
                    if (!u || !/^https?:/i.test(u) || seen.has(u)) return;
                    seen.add(u);
                    out.push({ url: u, width: w || 0, height: h || 0, source: src });
                };
                // Pick the highest-resolution candidate out of a srcset string.
                const fromSrcset = (ss) => {
                    if (!ss) return null;
                    let best = null, bestW = -1;
                    ss.split(',').forEach((part) => {
                        const seg = part.trim().split(/\s+/);
                        const u = seg[0];
                        const w = seg[1] && seg[1].endsWith('w') ? parseInt(seg[1], 10) : 0;
                        if (u && w > bestW) { bestW = w; best = u; }
                    });
                    return best;
                };
                document.querySelectorAll('img').forEach((img) => {
                    const ss = fromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
                    // A dynamically-loaded post image (lazy / below the fold) may
                    // still be undecoded when we read it — naturalWidth/Height are
                    // 0 — even after scrolling. Fall back to the element's RENDERED
                    // box size so a genuinely-displayed image still passes the size
                    // gate; without this an extensionless CDN url (no .jpg to
                    // whitelist on) with naturalWidth 0 is dropped on the floor.
                    const r = img.getBoundingClientRect();
                    const w = img.naturalWidth || Math.round(r.width);
                    const h = img.naturalHeight || Math.round(r.height);
                    // Some lazy loaders keep the real url in data-src/data-original
                    // until the image enters the viewport.
                    const src = ss || img.currentSrc || img.src
                        || img.getAttribute('data-src') || img.getAttribute('data-original')
                        || img.getAttribute('data-lazy-src');
                    push(src, w, h, 'img');
                });
                document.querySelectorAll('picture source[srcset]').forEach((s) => {
                    push(fromSrcset(s.getAttribute('srcset')), 0, 0, 'source');
                });
                // Large CSS background images (hero/banner/tiles).
                document.querySelectorAll('*').forEach((el) => {
                    const bg = getComputedStyle(el).backgroundImage;
                    if (bg && bg.indexOf('url(') === 0) {
                        const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
                        if (m) {
                            const r = el.getBoundingClientRect();
                            if (r.width >= 200 && r.height >= 200) push(m[1], Math.round(r.width), Math.round(r.height), 'bg');
                        }
                    }
                });
                ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]'].forEach((sel) => {
                    const el = document.querySelector(sel);
                    if (el) push(el.getAttribute('content') || el.getAttribute('href'), 0, 0, 'meta');
                });
                return out;
            });
        } catch (_) { raw = []; }

        const finalUrl = page.url();
        const title = await page.title().catch(() => '');

        // Keep substantial images (by natural size) plus og:image/srcset entries
        // whose dimensions the DOM didn't expose; drop decorative assets.
        // og:image/twitter:image is the page's DECLARED main image but carries
        // no dimensions, so a plain area sort ranked it LAST — behind ad-sized
        // page furniture (observed: a news article's "main image" came back as
        // a 300×250 cross-promo tile). Give meta entries a synthetic area that
        // beats ad formats (≤728×90/300×600) but loses to a genuinely larger
        // rendered hero image.
        const rankArea = (im) => ((im.source === 'meta' && !(im.width * im.height))
            ? 480000
            : (im.width * im.height));
        const images = raw
            .filter((im) => !ASSET.test(im.url))
            .filter((im) => {
                if (im.source === 'meta') return true;
                // width/height is naturalWidth OR (for an undecoded lazy img) the
                // rendered box size, so a displayed post image passes even when its
                // url is extensionless and it had not decoded yet.
                if (im.width >= minDimension && im.height >= minDimension) return true;
                // dimension still unknown (virtualized/off-layout img, or a
                // srcset/source with no element) — keep if it has a real image extension
                if ((im.width === 0 || im.height === 0) && /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)(?:[?#]|$)/i.test(im.url)) return true;
                return false;
            })
            .sort((a, b) => rankArea(b) - rankArea(a))
            .slice(0, maxResults);

        return { success: true, url, finalUrl, title, images };
    } catch (error) {
        return { success: false, error: lease.errorOf(error), url, images: [] };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

// Screenshot the dominant CONTENT-image element(s) on a page — the capture
// layer of LAST resort, for pictures whose bytes are unreachable by every
// other means: canvas/blob:-rendered galleries and protected viewers (no
// fetchable URL exists at all), or a direct image URL whose origin refuses
// every non-browser client even for the response body.
//
// Deliberately conservative — a screenshot of the wrong thing is worse than
// no image, so this NEVER "just grabs the viewport":
//  • challenge/error pages (Cloudflare "Just a moment", captcha, access
//    denied) are detected and ABORTED after one resolve-wait — no screenshot;
//  • mode 'image' (url IS an image document): screenshots the <img> only
//    when document.contentType is image/* AND the picture actually decoded
//    (naturalWidth ≥ 64) — an HTML page in disguise aborts;
//  • mode 'page': only elements that look like content pictures qualify —
//    rendered box ≥ minWidth×minHeight, sane aspect ratio, not matching the
//    decorative/ad denylist (sprite/icon/logo/avatar/banner/promo), not
//    inside nav/header/footer/aside or ad-marked containers, iframes never
//    (that's where ads live); overlapping candidates collapse to the
//    largest; ranked by rendered area, top maxShots only.
//
// @returns { success, shots: [{ buffer(PNG), width, height, kind, srcHint }],
//            title, finalUrl } or { success:false, error, aborted? }
async function screenshotPageImages(url, options = {}) {
    const {
        mode = 'page',
        timeout = 22000,
        settleMs = 2000,
        maxShots = 4,
        minWidth = 200,
        minHeight = 150,
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('screenshotPageImages', url, hardDeadlineFor(timeout, settleMs + maxShots * 4000));

    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        await applyStealthPatches(page);

        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
        await page.waitForTimeout(settleMs);

        // Challenge/error wall? Give an auto-resolving challenge (Cloudflare
        // JS check) one grace wait, then abort rather than screenshot a wall.
        const CHALLENGE = /just a moment|checking your browser|verify you are human|are you a robot|attention required|access denied|request blocked|captcha|error 40[34]|too many requests/i;
        const looksBlocked = async () => {
            try {
                return await page.evaluate((reSrc) => {
                    const re = new RegExp(reSrc, 'i');
                    const head = (document.title || '') + ' ' + (document.body ? (document.body.innerText || '').slice(0, 600) : '');
                    return re.test(head);
                }, CHALLENGE.source);
            } catch (_) { return false; }
        };
        if (await looksBlocked()) {
            await page.waitForTimeout(4500);
            if (await looksBlocked()) {
                return { success: false, aborted: 'challenge', error: 'Page is a bot-challenge/error wall — refusing to screenshot it', url };
            }
        }

        const title = await page.title().catch(() => '');
        const finalUrl = page.url();

        if (mode === 'image') {
            // Chromium renders a direct image URL as an "image document":
            // contentType image/* with a single <img>. Anything else means the
            // origin served HTML — not the picture — so abort.
            const ok = await page.evaluate(() => {
                const ct = document.contentType || '';
                const img = document.images && document.images[0];
                if (!/^image\//i.test(ct) || !img) return false;
                if ((img.naturalWidth || 0) < 64 || (img.naturalHeight || 0) < 64) return false;
                img.setAttribute('data-msshot', '0');
                return true;
            });
            if (!ok) return { success: false, aborted: 'not-an-image-document', error: 'URL did not render as an image in the browser', url };
            const buffer = await page.locator('[data-msshot="0"]').screenshot({ timeout: 8000 });
            const dims = await page.evaluate(() => {
                const img = document.images[0];
                return { width: img.naturalWidth, height: img.naturalHeight };
            }).catch(() => ({ width: 0, height: 0 }));
            return { success: true, title, finalUrl, url, shots: [{ buffer, ...dims, kind: 'image-document', srcHint: url }] };
        }

        // modes 'page'/'fullpage' — scroll to force lazy content in (same walk
        // as extractPageImages) so below-the-fold images are painted.
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let total = 0;
                    const step = () => {
                        window.scrollBy(0, window.innerHeight);
                        total += window.innerHeight;
                        if (total < document.body.scrollHeight && total < 25000) setTimeout(step, 140);
                        else { window.scrollTo(0, 0); resolve(); }
                    };
                    step();
                });
            });
            await page.waitForTimeout(700);
        } catch (_) {}

        if (mode === 'fullpage') {
            // Explicit user-requested page screenshot — the one case where
            // capturing the page itself IS the relevant item. Height-capped
            // so a mile-long feed doesn't become a useless 1:20 strip.
            const maxFullHeight = options.maxFullHeight || 2600;
            const vp = page.viewportSize() || { width: 1280, height: 720 };
            const pageH = await page.evaluate(() => Math.max(
                document.body ? document.body.scrollHeight : 0,
                document.documentElement ? document.documentElement.scrollHeight : 0,
            )).catch(() => vp.height);
            const capH = Math.min(Math.max(pageH || vp.height, vp.height), maxFullHeight);
            const buffer = capH < pageH
                ? await page.screenshot({ clip: { x: 0, y: 0, width: vp.width, height: capH }, timeout: 15000 })
                : await page.screenshot({ fullPage: true, timeout: 15000 });
            return { success: true, title, finalUrl, url, shots: [{ buffer, width: vp.width, height: capH, kind: 'fullpage', srcHint: url }] };
        }

        const candidates = await page.evaluate((opts) => {
            const { minWidth, minHeight, maxShots } = opts;
            const DENY = /sprite|favicon|(^|[-_/])icons?([-_./]|$)|(^|[-_/])logos?([-_./]|$)|avatar|placeholder|spinner|loading|1x1|blank\.|pixel\.|spacer|(^|[-_ ])(ads?|advert\w*|banner|promo|sponsor)([-_ ]|$)/i;
            const CHROME_ANCESTOR = /(^|[-_ ])(nav|menu|header|footer|sidebar|toolbar|breadcrumb|ads?|advert\w*|promo|sponsor|cookie|consent)([-_ ]|$)/i;
            const inChrome = (el) => {
                for (let n = el, depth = 0; n && depth < 6; n = n.parentElement, depth++) {
                    const tag = (n.tagName || '').toLowerCase();
                    if (['nav', 'header', 'footer', 'aside'].includes(tag)) return true;
                    const marker = `${n.id || ''} ${typeof n.className === 'string' ? n.className : ''}`;
                    if (CHROME_ANCESTOR.test(marker)) return true;
                }
                return false;
            };
            const found = [];
            const consider = (el, kind, srcHint) => {
                const r = el.getBoundingClientRect();
                const w = Math.round(r.width), h = Math.round(r.height);
                if (w < minWidth || h < minHeight) return;
                const aspect = w / h;
                if (aspect < 0.25 || aspect > 4.5) return; // skinny strips = banners/rules
                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.05) return;
                if (DENY.test(srcHint || '') || DENY.test(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('alt') || ''}`)) return;
                if (inChrome(el)) return;
                found.push({ el, kind, srcHint: (srcHint || '').slice(0, 300), area: w * h, w, h, top: r.top + window.scrollY, left: r.left + window.scrollX });
            };
            document.querySelectorAll('img').forEach((img) => consider(img, 'img', img.currentSrc || img.src || ''));
            document.querySelectorAll('canvas').forEach((c) => consider(c, 'canvas', 'canvas'));
            document.querySelectorAll('div,section,figure,a,span').forEach((el) => {
                const bg = getComputedStyle(el).backgroundImage;
                if (bg && bg.indexOf('url(') === 0 && el.childElementCount <= 3) {
                    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
                    if (m) consider(el, 'bg', m[1]);
                }
            });
            // Collapse overlapping candidates (img inside a bg-styled figure
            // etc.): if two boxes overlap heavily, keep the larger.
            found.sort((a, b) => b.area - a.area);
            const kept = [];
            for (const c of found) {
                const dup = kept.some((k) => {
                    const ox = Math.max(0, Math.min(k.left + k.w, c.left + c.w) - Math.max(k.left, c.left));
                    const oy = Math.max(0, Math.min(k.top + k.h, c.top + c.h) - Math.max(k.top, c.top));
                    return (ox * oy) / c.area > 0.7;
                });
                if (!dup) kept.push(c);
                if (kept.length >= maxShots) break;
            }
            kept.forEach((c, i) => c.el.setAttribute('data-msshot', String(i)));
            return kept.map((c, i) => ({ idx: i, kind: c.kind, srcHint: c.srcHint, width: c.w, height: c.h }));
        }, { minWidth, minHeight, maxShots });

        const shots = [];
        for (const c of candidates) {
            try {
                const buffer = await page.locator(`[data-msshot="${c.idx}"]`).screenshot({ timeout: 8000 });
                if (buffer && buffer.length) shots.push({ buffer, width: c.width, height: c.height, kind: c.kind, srcHint: c.srcHint });
            } catch (_) { /* element vanished/detached — skip it */ }
        }
        return { success: true, title, finalUrl, url, shots };
    } catch (error) {
        return { success: false, error: lease.errorOf(error), url };
    } finally {
        lease.clear();
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}


/**
 * Render a LOCAL HTML document (a file the model wrote into the workspace, or
 * inline markup) in a real headless Chromium and report what a developer
 * would read off DevTools: console errors/warnings, uncaught exceptions,
 * failed network requests (CDN scripts that never loaded), a DOM summary,
 * per-canvas blank detection, and a screenshot. This is the ONLY browser the
 * platform can offer for testing generated pages — the sandbox has no
 * Chromium and cannot install one (64 MB /tmp, gVisor), so a model that tries
 * spends a whole turn on ENOSPC (live-observed, 21 tool calls, no answer).
 *
 * Not stealth: it is our own document. file:// so relative assets next to
 * the file (chart.png, style.css written by an earlier tool) resolve; remote
 * CDN scripts load through the webapp's normal network.
 *
 * @param {object} opts
 * @param {string} [opts.filePath]   absolute path of the .html on this host
 * @param {string} [opts.html]       inline markup (written to a temp file)
 * @param {number} [opts.waitMs]     settle time after load (default 3000)
 * @param {Array}  [opts.actions]    [{type:'click'|'type'|'wait'|'press'|'hover', selector, text, key, ms}]
 * @param {object} [opts.viewport]   {width,height} default 1280×800
 * @param {number} [opts.timeout]    navigation timeout (default 20000)
 */
async function renderLocalPage(opts = {}) {
    const {
        filePath = null,
        html = null,
        waitMs = 3000,
        actions = [],
        viewport = { width: 1280, height: 800 },
        timeout = 20000,
        screenshot = true,
    } = opts;
    if (!filePath && typeof html !== 'string') throw new Error('renderLocalPage: filePath or html required');
    const fs = require('fs');
    const path = require('path');

    let tmpFile = null;
    let target = filePath;
    if (!target) {
        const os = require('os');
        const crypto = require('crypto');
        tmpFile = path.join(os.tmpdir(), `preview-${crypto.randomBytes(6).toString('hex')}.html`);
        await fs.promises.writeFile(tmpFile, html, 'utf8');
        target = tmpFile;
    }
    const fileUrl = 'file://' + path.resolve(target);

    let poolEntry = null;
    let context = null;
    let page = null;
    const lease = armDeadline('renderLocalPage', fileUrl, hardDeadlineFor(timeout, waitMs + (Array.isArray(actions) ? actions.length : 0) * 8000));
    const consoleMsgs = [];
    const pageErrors = [];
    const failedRequests = [];
    const requests = { total: 0, ok: 0 };
    const started = Date.now();
    try {
        poolEntry = await getBrowser(lease);
        context = await poolEntry.browser.newContext({
            viewport: { width: Math.max(320, Math.min(2560, viewport.width | 0 || 1280)), height: Math.max(240, Math.min(2000, viewport.height | 0 || 800)) },
            ignoreHTTPSErrors: true,
            deviceScaleFactor: 1,
        });
        lease.context = context;
        await installRequestPolicy(context);   // ads/trackers blocked, everything else untouched
        page = await context.newPage();
        page.on('console', (m) => {
            if (consoleMsgs.length >= 200) return;
            let loc = '';
            try { const l = m.location(); if (l && l.url) loc = `${l.url.replace(/^file:\/\/.*\//, '')}:${l.lineNumber || 0}`; } catch (_) {}
            consoleMsgs.push({ type: m.type(), text: String(m.text() || '').slice(0, 600), ...(loc ? { at: loc } : {}) });
        });
        page.on('pageerror', (e) => {
            if (pageErrors.length >= 50) return;
            const msg = (e && (e.message || String(e))) || 'error';
            const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '';
            pageErrors.push({ message: String(msg).slice(0, 600), ...(stack ? { stack: stack.slice(0, 800) } : {}) });
        });
        page.on('request', () => { requests.total++; });
        page.on('requestfinished', () => { requests.ok++; });
        page.on('requestfailed', (r) => {
            if (failedRequests.length >= 50) return;
            const f = r.failure();
            failedRequests.push({ url: String(r.url()).slice(0, 300), error: (f && f.errorText) || 'failed', resourceType: r.resourceType() });
        });
        page.on('response', (r) => {
            try {
                if (r.status() >= 400 && failedRequests.length < 50) {
                    failedRequests.push({ url: String(r.url()).slice(0, 300), error: `HTTP ${r.status()}`, resourceType: r.request().resourceType() });
                }
            } catch (_) {}
        });

        await page.goto(fileUrl, { timeout, waitUntil: 'load' });
        try { await page.waitForLoadState('networkidle', { timeout: Math.min(8000, timeout) }); } catch (_) {}
        await page.waitForTimeout(Math.max(0, Math.min(15000, waitMs | 0)));

        const actionLog = [];
        for (const a of (Array.isArray(actions) ? actions.slice(0, 12) : [])) {
            const t = String(a && a.type || '').toLowerCase();
            try {
                if (t === 'click' && a.selector) { await page.click(String(a.selector), { timeout: 4000 }); actionLog.push({ ok: true, action: `click ${a.selector}` }); }
                else if (t === 'hover' && a.selector) { await page.hover(String(a.selector), { timeout: 4000 }); actionLog.push({ ok: true, action: `hover ${a.selector}` }); }
                else if (t === 'type' && a.selector) { await page.fill(String(a.selector), String(a.text || ''), { timeout: 4000 }); actionLog.push({ ok: true, action: `type into ${a.selector}` }); }
                else if (t === 'press') { await page.keyboard.press(String(a.key || 'Enter')); actionLog.push({ ok: true, action: `press ${a.key || 'Enter'}` }); }
                else if (t === 'wait') { await page.waitForTimeout(Math.max(0, Math.min(10000, (a.ms | 0) || 1000))); actionLog.push({ ok: true, action: `wait ${(a.ms | 0) || 1000}ms` }); }
                else if (t === 'mouse' && a.x != null) { await page.mouse.move(+a.x, +a.y || 0); await page.mouse.down(); await page.mouse.move((+a.x) + ((a.dx | 0) || 40), (+a.y || 0) + ((a.dy | 0) || 40), { steps: 8 }); await page.mouse.up(); actionLog.push({ ok: true, action: `drag from ${a.x},${a.y}` }); }
                else actionLog.push({ ok: false, action: JSON.stringify(a).slice(0, 120), error: 'unknown action (click|hover|type|press|wait|mouse)' });
            } catch (e) {
                actionLog.push({ ok: false, action: `${t} ${a.selector || ''}`.trim(), error: String(e && e.message || e).split('\n')[0].slice(0, 200) });
            }
        }
        if (actionLog.length) await page.waitForTimeout(800);

        // DOM + canvas inspection. Canvas "blank" = every sampled pixel equals
        // the first one (uniform) — a black canvas and an all-white canvas are
        // both blank; a rendered scene is not. WebGL canvases are sampled via
        // toDataURL into a 2d copy (works when preserveDrawingBuffer is on;
        // otherwise reported as unsampled, never as blank).
        const dom = await page.evaluate(() => {
            const out = {};
            out.title = document.title || '';
            const body = document.body;
            const text = body ? (body.innerText || '') : '';
            out.bodyTextChars = text.length;
            out.bodyTextPreview = text.replace(/\s+/g, ' ').trim().slice(0, 400);
            out.elementCount = document.getElementsByTagName('*').length;
            const root = document.getElementById('root') || document.getElementById('app') || document.querySelector('main') || body;
            out.mountPoint = root ? `${root.tagName.toLowerCase()}${root.id ? '#' + root.id : ''}` : null;
            out.mountPointChildren = root ? root.children.length : 0;
            out.visibleElements = body ? Array.from(body.querySelectorAll('*')).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length : 0;
            out.scripts = Array.from(document.scripts).map(s => ({ src: s.src ? s.src.slice(0, 160) : null, type: s.type || 'text/javascript', inlineChars: s.src ? 0 : (s.textContent || '').length }));
            const canvases = [];
            for (const c of Array.from(document.querySelectorAll('canvas')).slice(0, 8)) {
                const rect = c.getBoundingClientRect();
                const entry = { width: c.width, height: c.height, cssWidth: Math.round(rect.width), cssHeight: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 };
                try {
                    let ctx = c.getContext('2d');
                    let src = c;
                    if (!ctx) {
                        // WebGL / bitmaprenderer: copy through an image
                        entry.kind = 'webgl-or-other';
                        const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
                        const cctx = copy.getContext('2d');
                        try { cctx.drawImage(c, 0, 0); ctx = cctx; src = copy; } catch (_) { ctx = null; }
                    } else entry.kind = '2d';
                    if (ctx && c.width > 0 && c.height > 0) {
                        const step = Math.max(1, Math.floor(Math.sqrt((c.width * c.height) / 4096)));
                        const d = ctx.getImageData(0, 0, src.width, src.height).data;
                        const r0 = d[0], g0 = d[1], b0 = d[2], a0 = d[3];
                        let sampled = 0, differ = 0, transparent = 0, nonBlack = 0;
                        for (let y = 0; y < src.height; y += step) for (let x = 0; x < src.width; x += step) {
                            const o = (y * src.width + x) * 4; sampled++;
                            if (d[o + 3] === 0) transparent++;
                            if (d[o] || d[o + 1] || d[o + 2]) nonBlack++;
                            if (Math.abs(d[o] - r0) > 8 || Math.abs(d[o + 1] - g0) > 8 || Math.abs(d[o + 2] - b0) > 8 || Math.abs(d[o + 3] - a0) > 8) differ++;
                        }
                        entry.sampledPixels = sampled;
                        entry.nonUniformRatio = sampled ? +(differ / sampled).toFixed(3) : 0;
                        entry.nonBlackRatio = sampled ? +(nonBlack / sampled).toFixed(3) : 0;
                        entry.transparentRatio = sampled ? +(transparent / sampled).toFixed(3) : 0;
                        entry.blank = sampled > 0 && differ / sampled < 0.002;
                        entry.firstPixel = [r0, g0, b0, a0];
                    } else if (!ctx) entry.unsampled = true;
                } catch (e) { entry.unsampled = true; entry.error = String(e && e.message || e).slice(0, 120); }
                canvases.push(entry);
            }
            out.canvases = canvases;
            out.svgCount = document.querySelectorAll('svg').length;
            out.imgCount = document.images.length;
            out.brokenImages = Array.from(document.images).filter(i => i.complete && i.naturalWidth === 0 && i.src).length;
            return out;
        }).catch((e) => ({ error: String(e && e.message || e).slice(0, 200) }));

        let shot = null;
        if (screenshot) {
            try { shot = await page.screenshot({ type: 'png', fullPage: false }); } catch (_) { shot = null; }
        }
        // Every step above catches its own failure, so a spent deadline (the page's
        // main thread never yielded) would otherwise come back looking like an
        // ordinary render with an empty DOM — name it.
        if (lease.expired) throw new Error(lease.reason);
        return {
            success: true,
            url: fileUrl,
            title: dom.title || '',
            elapsedMs: Date.now() - started,
            console: consoleMsgs,
            pageErrors,
            failedRequests,
            requests,
            dom,
            actions: actionLog,
            screenshot: shot,
        };
    } catch (error) {
        // The deadline closed the context under us — surface WHY, not "Target closed".
        if (lease.expired) throw new Error(lease.reason);
        throw error;
    } finally {
        lease.clear();
        try { if (page) await page.close(); } catch (_) {}
        try { if (context) await context.close(); } catch (_) {}
        if (poolEntry) releaseBrowser(poolEntry);
        if (tmpFile) { try { await fs.promises.unlink(tmpFile); } catch (_) {} }
    }
}

module.exports = {
    dismissOverlays,
    fetchUrlContent,
    fetchMultipleUrls,
    interactAndFetch,
    downloadFile,
    crawlPages,
    sniffMediaStreams,
    extractPageImages,
    screenshotPageImages,
    renderLocalPage,
    cleanup,
    getPoolStatus,
    // test hooks
    _armDeadline: armDeadline,
    _domAnchors: domAnchors,
    _hardDeadlineFor: hardDeadlineFor,
    _HARD_DEADLINE_MS: PLAYWRIGHT_HARD_DEADLINE_MS,
};
