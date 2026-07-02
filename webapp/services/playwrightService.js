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

const { spawn, execSync } = require('child_process');

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

// Xvfb virtual display management
let xvfbProcess = null;
const DISPLAY_NUM = 99;
const XVFB_DISPLAY = `:${DISPLAY_NUM}`;

/**
 * Start Xvfb virtual display for headed browser mode
 */
function startXvfb() {
    if (xvfbProcess) return true;

    try {
        // Check if Xvfb is available
        execSync('which Xvfb', { stdio: 'ignore' });

        // Start Xvfb
        xvfbProcess = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1920x1080x24'], {
            detached: true,
            stdio: 'ignore'
        });

        xvfbProcess.unref();

        // Set DISPLAY environment variable
        process.env.DISPLAY = XVFB_DISPLAY;

        console.log(`Xvfb started on display ${XVFB_DISPLAY} for headed browser mode`);
        return true;
    } catch (err) {
        console.log('Xvfb not available, using headless mode');
        return false;
    }
}

/**
 * Stop Xvfb virtual display
 */
function stopXvfb() {
    if (xvfbProcess) {
        try {
            process.kill(-xvfbProcess.pid);
        } catch (e) {
            // Process already dead
        }
        xvfbProcess = null;
    }
}

// Check for Xvfb on startup
const USE_HEADED_MODE = startXvfb();

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
let poolCleanupInterval = null;

// Stealth configuration - rotated per request
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0'
];

const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 }
];

const LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU'];
const TIMEZONES = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Europe/London', 'America/Denver'];

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
    const options = {
        userAgent: randomChoice(USER_AGENTS),
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
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        }
    };

    // Enable SSL bypass for corporate proxy environments
    if (sslBypassEnabled) {
        options.ignoreHTTPSErrors = true;
    }

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

        // Hardware concurrency (randomize slightly)
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 4 + Math.floor(Math.random() * 5)
        });

        // Device memory
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // WebGL vendor/renderer - randomize slightly
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.apply(this, arguments);
        };

        // WebGL2 support
        if (typeof WebGL2RenderingContext !== 'undefined') {
            const getParam2 = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Intel Inc.';
                if (parameter === 37446) return 'Intel Iris OpenGL Engine';
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
async function getBrowser() {
    // Try to get an available browser from pool
    const availableBrowser = browserPool.find(b => !b.inUse && b.browser.isConnected());
    if (availableBrowser) {
        availableBrowser.inUse = true;
        availableBrowser.lastUsed = Date.now();
        return availableBrowser;
    }

    // Create new browser if pool not full
    if (browserPool.length < MAX_POOL_SIZE) {
        // Always launch headless. The previous boot-time Xvfb spawn (startXvfb)
        // could die silently — stdio: 'ignore' swallows any crash — leaving
        // USE_HEADED_MODE cached as true while no X server is actually serving.
        // The result was: every chromium launch died with "Missing X server or
        // $DISPLAY" and the chat's playwright_fetch path was completely broken.
        // Stealth/anti-detection lives in scrapling_fetch (patchright + curl_cffi);
        // playwright_fetch is the simple JS-render path and headless is fine.
        const useHeaded = false;

        const browser = await chromium.launch({
            headless: !useHeaded,
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
                // Extra anti-detection for headed mode
                ...(useHeaded ? ['--disable-notifications', '--disable-popup-blocking'] : [])
            ]
        });

        const poolEntry = {
            browser,
            inUse: true,
            lastUsed: Date.now(),
            createdAt: Date.now()
        };

        browserPool.push(poolEntry);
        startPoolCleanup();

        return poolEntry;
    }

    // Wait for an available browser
    await new Promise(resolve => setTimeout(resolve, 100));
    return getBrowser();
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
    const { includeLinks = false, maxLength = 8000 } = options;

    return await page.evaluate(({ includeLinks, maxLength }) => {
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

        removeSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
        });

        // Get title
        const title = document.title || document.querySelector('h1')?.textContent?.trim() || '';

        // Get meta description
        const metaDesc = document.querySelector('meta[name="description"]')?.content ||
                         document.querySelector('meta[property="og:description"]')?.content || '';

        // Get main content area - check specific article body selectors first (Blogger, WordPress, news sites)
        const mainContent = document.querySelector('.post-body') ||
                           document.querySelector('.articlebody') ||
                           document.querySelector('.post-body-container') ||
                           document.querySelector('[itemprop="articleBody"]') ||
                           document.querySelector('.story-body') ||
                           document.querySelector('.storycontent') ||
                           document.querySelector('.entry-content') ||
                           document.querySelector('.be__contents') ||
                           document.querySelector('.be__contents-wrapper') ||
                           document.querySelector('.blog-contents') ||
                           document.querySelector('.section--article') ||
                           document.querySelector('article') ||
                           document.querySelector('main') ||
                           document.querySelector('[role="main"]') ||
                           document.querySelector('.content') ||
                           document.querySelector('.article') ||
                           document.querySelector('.post') ||
                           document.body;

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

        // Extract links if requested
        const links = [];
        if (includeLinks) {
            mainContent.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href');
                const text = a.textContent?.trim();
                if (href && text && !href.startsWith('#') && !href.startsWith('javascript:')) {
                    links.push({ text: text.substring(0, 100), href });
                }
            });
        }

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

        if (headings.length > 0) {
            output += 'Key Points:\n';
            headings.slice(0, 8).forEach(h => {
                output += `- ${h}\n`;
            });
            output += '\n';
        }

        // Videos first — there are only ever a handful and they're high-value
        // (the model passes them to find_video), so emit them before the bulky
        // paragraph content can exhaust the char budget.
        if (videoItems.length > 0) {
            output += 'Videos:\n';
            videoItems.forEach(v => {
                if (output.length < maxLength - 300) output += `- [${v.kind}] ${v.url}\n`;
            });
            output += '\n';
        }

        if (paragraphs.length > 0) {
            output += 'Content:\n';
            paragraphs.forEach(p => {
                if (output.length < maxLength - 500) {
                    output += `${p}\n\n`;
                }
            });
        }

        if (tables.length > 0) {
            output += '\nData:\n';
            tables.forEach(t => {
                if (output.length < maxLength - 500) {
                    output += `${t}\n\n`;
                }
            });
        }

        if (imageItems.length > 0) {
            output += '\nImages:\n';
            imageItems.forEach(im => {
                if (output.length < maxLength - 500) {
                    output += `- ${im.alt}\n`;
                    if (im.link) output += `  post: ${im.link}\n`;
                    if (im.src) output += `  image: ${im.src}\n`;
                }
            });
            output += '\n';
        }

        if (includeLinks && links.length > 0) {
            output += '\nLinks:\n';
            links.slice(0, 10).forEach(l => {
                output += `- ${l.text}: ${l.href}\n`;
            });
        }

        // If structured extraction returned too little content, fall back to innerText
        // This handles SPAs, shadow DOM, and sites with non-standard HTML structure
        if (output.length < 300) {
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

            const shadowText = getAllText(mainContent);
            const innerText = mainContent.innerText || '';
            const fallbackText = shadowText.length > innerText.length ? shadowText : innerText;

            if (fallbackText.length > output.length) {
                output = '';
                if (title) output += `Title: ${title}\n\n`;
                if (metaDesc) output += `Summary: ${metaDesc}\n\n`;
                output += 'Content:\n' + fallbackText.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
            }
        }

        return output.substring(0, maxLength);
    }, { includeLinks, maxLength });
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
        waitForSelector = null
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;

    try {
        poolEntry = await getBrowser();

        // Create stealth context
        context = await poolEntry.browser.newContext(getStealthContextOptions());

        // Capture JSON API responses from XHR/fetch calls (SPAs load data this way)
        const capturedJsonResponses = [];
        await context.route('**/*', async (route) => {
            const resourceType = route.request().resourceType();
            // Block heavy resources for speed
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                if (!screenshot && resourceType !== 'stylesheet') {
                    return route.abort();
                }
            }
            // Intercept XHR/fetch responses that return JSON (SPA data loading)
            if (resourceType === 'xhr' || resourceType === 'fetch') {
                try {
                    const response = await route.fetch();
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('application/json')) {
                        const body = await response.text();
                        if (body.length > 100 && body.length < 500000) {
                            try {
                                const json = JSON.parse(body);
                                capturedJsonResponses.push({
                                    url: route.request().url(),
                                    data: json,
                                    size: body.length
                                });
                            } catch (e) { /* Not valid JSON */ }
                        }
                    }
                    return route.fulfill({ response });
                } catch (e) {
                    return route.continue();
                }
            }
            return route.continue();
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

        if (!response || response.status() >= 400) {
            throw new Error(`HTTP ${response?.status() || 'no response'}`);
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

            // Check if page has meaningful content, if not wait longer for late-loading SPAs
            const bodyTextLength = await page.evaluate(() => (document.body?.innerText || '').trim().length);
            if (bodyTextLength < 500) {
                // Page likely still rendering - wait extra time for SPA hydration
                await page.waitForTimeout(randomDelay(5000, 8000));

                // If still thin, try scrolling to trigger lazy loading
                const stillThin = await page.evaluate(() => (document.body?.innerText || '').trim().length < 500);
                if (stillThin) {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
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
            content = await extractContent(page, { includeLinks, maxLength });
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
                if (flatText.length > 80) {
                    apiContent += flatText + '\n\n';
                }
            }
            if (apiContent.length > 200) {
                console.log(`[Playwright] Captured ${capturedJsonResponses.length} API responses (${apiContent.length} chars text), enriching content`);
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

        return {
            success: true,
            content,
            title,
            url,
            finalUrl: page.url(),
            screenshot: screenshotData?.toString('base64')
        };

    } catch (error) {
        return {
            success: false,
            error: error.message,
            url
        };
    } finally {
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

/**
 * Search and extract content from URLs
 * Used for enhanced web search with content fetching
 */
async function searchAndFetch(searchResults, options = {}) {
    const { contentLimit = 5 } = options;

    const urlsToFetch = searchResults
        .slice(0, contentLimit)
        .map(r => r.url)
        .filter(Boolean);

    const fetchResults = await fetchMultipleUrls(urlsToFetch, {
        timeout: 12000,
        waitForJS: true,
        maxLength: 6000
    });

    // Merge fetch results back into search results
    const fetchMap = new Map(fetchResults.map(r => [r.url, r]));

    return searchResults.map(result => {
        const fetched = fetchMap.get(result.url);
        if (fetched && fetched.success) {
            return {
                ...result,
                content: fetched.content,
                contentFetched: true,
                finalUrl: fetched.finalUrl
            };
        }
        return {
            ...result,
            contentFetched: false,
            fetchError: fetched?.error
        };
    });
}

/**
 * Advanced page interaction for complex sites
 */
async function interactAndFetch(url, actions = [], options = {}) {
    const { timeout = 30000 } = options;

    let poolEntry = null;
    let context = null;
    let page = null;

    try {
        poolEntry = await getBrowser();
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        page = await context.newPage();
        await applyStealthPatches(page);

        await page.goto(url, { timeout, waitUntil: 'load' });

        // Execute actions
        for (const action of actions) {
            await page.waitForTimeout(randomDelay(100, 300));

            // Per-action timeout with sensible defaults; the model can pass
            // action.timeout to widen it for slow / lazy-loaded sites.
            const actTimeout = Math.max(500, parseInt(action.timeout || 8000, 10));
            try {
                switch (action.type) {
                    case 'click':
                        await page.click(action.selector, { timeout: actTimeout });
                        break;
                    case 'type':
                        await page.type(action.selector, action.text, { delay: randomDelay(30, 80), timeout: actTimeout });
                        break;
                    case 'wait':
                        // Support both selector-based wait and simple timeout
                        if (action.selector) {
                            await page.waitForSelector(action.selector, { timeout: actTimeout });
                        } else {
                            await page.waitForTimeout(action.timeout || 1000);
                        }
                        break;
                    case 'scroll':
                        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                        break;
                    case 'waitForNavigation':
                        // Best-effort: a preceding click very often FINISHES
                        // navigating before this line starts listening (the
                        // classic page.click → waitForNavigation race), so a
                        // timeout here normally means "already navigated", not a
                        // failure. Don't hard-fail — fall back to a short
                        // load-state settle and continue so pagination works.
                        try {
                            await page.waitForNavigation({ timeout: actTimeout, waitUntil: 'load' });
                        } catch (navErr) {
                            try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch (e) {}
                        }
                        break;
                }
            } catch (actionErr) {
                // Rewrap selector-timeout errors with an actionable hint so
                // the model doesn't keep retrying the same bad selector.
                // Playwright's raw message is terse ("page.click: Timeout
                // 5000ms exceeded. Call log: - waiting for locator('X')")
                // and reads as "network was slow" rather than "selector
                // did not match". Make the failure mode explicit.
                const raw = actionErr?.message || String(actionErr);
                const isTimeout = /timeout .* exceeded/i.test(raw);
                const sel = action.selector ? ` '${action.selector}'` : '';
                const msg = isTimeout
                    ? `${action.type} action timed out — selector${sel} not found / not visible within ${actTimeout}ms. Inspect the page with scrapling_fetch or playwright_fetch to find the real selector before retrying, or consider whether the data is already available without interaction. Raw: ${raw}`
                    : raw;
                throw new Error(msg);
            }
        }

        await page.waitForTimeout(randomDelay(300, 600));

        const content = await extractContent(page, options);
        const title = await page.title();

        return {
            success: true,
            content,
            title,
            url,
            finalUrl: page.url()
        };

    } catch (error) {
        return {
            success: false,
            error: error.message,
            url
        };
    } finally {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
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

    try {
        poolEntry = await getBrowser();
        context = await poolEntry.browser.newContext({
            ...getStealthContextOptions(),
            acceptDownloads: true,
        });
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
        return { success: false, error: error.message, url };
    } finally {
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
            await entry.browser.close();
        } catch (e) {}
    }

    browserPool = [];

    // Stop Xvfb if running
    stopXvfb();
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
    '[aria-label*="Next" i]:not([aria-label*="previous" i])',
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

async function findFirstVisible(page, selectors) {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.count() === 0) continue;
            if (!(await loc.isVisible().catch(() => false))) continue;
            return loc;
        } catch (_) { /* try next */ }
    }
    return null;
}

async function detectPaginationMode(page, opts = {}) {
    if (opts.nextSelector) return 'link-follow';
    if (opts.loadMoreSelector) return 'load-more';
    const nextLoc = await findFirstVisible(page, NEXT_SELECTORS);
    if (nextLoc) return 'link-follow';
    const moreLoc = await findFirstVisible(page, LOAD_MORE_SELECTORS);
    if (moreLoc) return 'load-more';
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

    try {
        poolEntry = await getBrowser();
        context = await poolEntry.browser.newContext(getStealthContextOptions());
        page = await context.newPage();
        await applyStealthPatches(page);

        await page.goto(url, { timeout, waitUntil: 'load' });
        if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout }).catch(() => {});
        }

        const resolvedMode = mode === 'auto'
            ? await detectPaginationMode(page, { nextSelector, loadMoreSelector })
            : mode;

        const pages = [];
        let total = 0;
        let prevContentHash = '';

        const hash = (s) => {
            let h = 0;
            for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
            return h;
        };

        for (let i = 0; i < cappedMaxPages; i++) {
            await page.waitForTimeout(randomDelay(150, 400));
            const content = await extractContent(page, { includeLinks, maxLength: perPageCap });
            const title = await page.title().catch(() => '');
            const currentUrl = page.url();

            const thisHash = `${hash(content)}|${content.length}`;
            if (i > 0 && thisHash === prevContentHash) break; // pagination exhausted
            prevContentHash = thisHash;

            pages.push({
                index: i,
                url: currentUrl,
                title,
                content: content.slice(0, perPageCap),
            });
            total += content.length;
            if (total >= maxLength) break;
            if (i === cappedMaxPages - 1) break;

            // Advance to the next "page".
            if (resolvedMode === 'link-follow') {
                const nextLoc = nextSelector
                    ? page.locator(nextSelector).first()
                    : await findFirstVisible(page, NEXT_SELECTORS);
                if (!nextLoc) break;
                const isDisabled = await nextLoc.getAttribute('aria-disabled').catch(() => null);
                const classList = await nextLoc.getAttribute('class').catch(() => '') || '';
                if (isDisabled === 'true' || /\bdisabled\b/i.test(classList)) break;
                try {
                    await Promise.all([
                        page.waitForLoadState('load', { timeout }).catch(() => {}),
                        nextLoc.click({ timeout: Math.min(timeout, 8000) }),
                    ]);
                } catch (e) {
                    break;
                }
            } else if (resolvedMode === 'load-more') {
                const moreLoc = loadMoreSelector
                    ? page.locator(loadMoreSelector).first()
                    : await findFirstVisible(page, LOAD_MORE_SELECTORS);
                if (!moreLoc) break;
                try {
                    await moreLoc.click({ timeout: Math.min(timeout, 8000) });
                    await page.waitForTimeout(1500);
                } catch (e) {
                    break;
                }
            } else {
                // infinite-scroll
                const prevH = await page.evaluate(() => document.body.scrollHeight);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1500);
                const newH = await page.evaluate(() => document.body.scrollHeight);
                if (newH === prevH) break;
            }
        }

        return {
            success: true,
            url,
            finalUrl: page.url(),
            mode: resolvedMode,
            pagesVisited: pages.length,
            pages,
        };
    } catch (error) {
        return { success: false, error: error.message, url };
    } finally {
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
        poolEntry = await getBrowser();
        context = await poolEntry.browser.newContext(getStealthContextOptions());
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
            error: error.message,
            url,
            media: Array.from(media.values()).slice(0, maxResults),
            counts,
        };
    } finally {
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

    // URL fragments that mark a decorative/non-content image.
    const ASSET = /sprite|favicon|\/icons?\/|[-_]icon[-_.]|\/logos?\/|[-_]logo[-_.]|avatar|placeholder|spinner|loading|1x1|blank\.|pixel\.|spacer|data:image/i;

    try {
        poolEntry = await getBrowser();
        context = await poolEntry.browser.newContext(getStealthContextOptions());
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
            .sort((a, b) => (b.width * b.height) - (a.width * a.height))
            .slice(0, maxResults);

        return { success: true, url, finalUrl, title, images };
    } catch (error) {
        return { success: false, error: error.message, url, images: [] };
    } finally {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (poolEntry) releaseBrowser(poolEntry);
    }
}

module.exports = {
    fetchUrlContent,
    fetchMultipleUrls,
    searchAndFetch,
    interactAndFetch,
    downloadFile,
    crawlPages,
    sniffMediaStreams,
    extractPageImages,
    cleanup,
    getPoolStatus
};
