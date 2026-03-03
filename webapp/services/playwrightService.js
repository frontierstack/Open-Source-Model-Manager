/**
 * PlaywrightService - Advanced web scraping with bot detection avoidance
 *
 * Features:
 * - Browser pooling for fast reuse
 * - Stealth mode with fingerprint randomization
 * - Smart content extraction (handles JS-rendered pages)
 * - Configurable timeouts and retry logic
 * - Graceful degradation on failures
 */

const { chromium } = require('playwright');

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
    return {
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
}

/**
 * Apply stealth patches to page
 */
async function applyStealthPatches(page) {
    await page.addInitScript(() => {
        // Override webdriver detection
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
        });

        // Override automation detection
        delete navigator.__proto__.webdriver;

        // Chrome runtime
        window.chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
        };

        // Permissions API
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );

        // Plugin array
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ]
        });

        // Languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en']
        });

        // Hardware concurrency (randomize slightly)
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 4 + Math.floor(Math.random() * 5)
        });

        // WebGL vendor/renderer
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.apply(this, arguments);
        };

        // Notification permission
        if (typeof Notification !== 'undefined') {
            Object.defineProperty(Notification, 'permission', {
                get: () => 'default'
            });
        }

        // Connection type
        if (navigator.connection) {
            Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
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
                '--no-default-browser-check'
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

        for (let i = browserPool.length - 1; i >= 0; i--) {
            const entry = browserPool[i];
            if (!entry.inUse && (now - entry.lastUsed > BROWSER_IDLE_TIMEOUT || !entry.browser.isConnected())) {
                toRemove.push(i);
                try {
                    await entry.browser.close();
                } catch (e) {}
            }
        }

        for (const idx of toRemove) {
            browserPool.splice(idx, 1);
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

        // Get main content area
        const mainContent = document.querySelector('article') ||
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

        // Extract paragraphs
        const paragraphs = [];
        mainContent.querySelectorAll('p, li').forEach(p => {
            const text = p.textContent?.trim()
                .replace(/\s+/g, ' ')
                .replace(/\n+/g, ' ');
            if (text && text.length > 30) {
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

        if (includeLinks && links.length > 0) {
            output += '\nLinks:\n';
            links.slice(0, 10).forEach(l => {
                output += `- ${l.text}: ${l.href}\n`;
            });
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
 * @returns {Object} { success, content, title, url, screenshot?, error? }
 */
async function fetchUrlContent(url, options = {}) {
    const {
        timeout = 15000,
        waitForJS = true,
        includeLinks = false,
        maxLength = 8000,
        screenshot = false
    } = options;

    let poolEntry = null;
    let context = null;
    let page = null;

    try {
        poolEntry = await getBrowser();

        // Create stealth context
        context = await poolEntry.browser.newContext(getStealthContextOptions());

        // Block unnecessary resources for speed
        await context.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                if (!screenshot && resourceType !== 'stylesheet') {
                    return route.abort();
                }
            }
            return route.continue();
        });

        page = await context.newPage();

        // Apply stealth patches
        await applyStealthPatches(page);

        // Random pre-navigation delay
        await page.waitForTimeout(randomDelay(30, 100));

        // Navigate with stealth
        const response = await page.goto(url, {
            timeout,
            waitUntil: waitForJS ? 'networkidle' : 'domcontentloaded'
        });

        if (!response || response.status() >= 400) {
            throw new Error(`HTTP ${response?.status() || 'no response'}`);
        }

        // Wait for content to stabilize
        if (waitForJS) {
            await page.waitForTimeout(randomDelay(200, 500));

            // Wait for any lazy-loaded content
            try {
                await page.waitForLoadState('networkidle', { timeout: 3000 });
            } catch (e) {
                // Ignore timeout, continue with what we have
            }
        }

        // Extract content
        const content = await extractContent(page, { includeLinks, maxLength });
        const title = await page.title();

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

        await page.goto(url, { timeout, waitUntil: 'networkidle' });

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
                    await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
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
