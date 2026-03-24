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
const MAX_POOL_SIZE = 3;
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

        // Hide automation-related function modifications
        const originalToString = Function.prototype.toString;
        Function.prototype.toString = function() {
            if (this === navigator.permissions.query) {
                return 'function query() { [native code] }';
            }
            return originalToString.apply(this, arguments);
        };

        // Screen properties
        Object.defineProperty(screen, 'availWidth', { get: () => screen.width });
        Object.defineProperty(screen, 'availHeight', { get: () => screen.height - 40 });

        // Disable WebRTC IP leak
        if (typeof RTCPeerConnection !== 'undefined') {
            const origRTC = RTCPeerConnection;
            window.RTCPeerConnection = function(...args) {
                const pc = new origRTC(...args);
                pc.createDataChannel = () => ({});
                return pc;
            };
        }
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
        // Use headed mode with Xvfb when available (better anti-detection)
        const useHeaded = USE_HEADED_MODE;
        if (useHeaded) {
            console.log('Launching browser in headed mode with Xvfb');
        }

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
            try {
                await page.waitForLoadState('networkidle', { timeout: 8000 });
            } catch (e) {
                // Ignore timeout, continue with what we have
            }

            // Give JS time to hydrate and render (especially for shadow DOM components, SPAs)
            await page.waitForTimeout(randomDelay(3000, 5000));

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
                const titleLine = title ? `Title: ${title}\n\n` : '';
                content = titleLine + apiContent.slice(0, maxLength - titleLine.length);
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

            switch (action.type) {
                case 'click':
                    await page.click(action.selector, { timeout: 5000 });
                    break;
                case 'type':
                    await page.type(action.selector, action.text, { delay: randomDelay(30, 80) });
                    break;
                case 'wait':
                    // Support both selector-based wait and simple timeout
                    if (action.selector) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
                    } else {
                        await page.waitForTimeout(action.timeout || 1000);
                    }
                    break;
                case 'scroll':
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                    break;
                case 'waitForNavigation':
                    await page.waitForNavigation({ timeout: action.timeout || 10000 });
                    break;
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

module.exports = {
    fetchUrlContent,
    fetchMultipleUrls,
    searchAndFetch,
    interactAndFetch,
    cleanup,
    getPoolStatus
};
