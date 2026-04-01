/**
 * Scrapling Service - Node.js wrapper for Python Scrapling library
 * Provides captcha-evading web scraping with fallback to Playwright
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

// Path to the Python script
const SCRAPLING_SCRIPT = path.join(__dirname, 'scrapling_fetch.py');

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
async function search(query, maxResults = 5) {
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
    search,
    fetchWithFallback
};
