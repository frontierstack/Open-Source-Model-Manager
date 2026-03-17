/**
 * Scrapling Service - Node.js wrapper for Python Scrapling library
 * Provides captcha-evading web scraping with fallback to Playwright
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

// Path to the Python script
const SCRAPLING_SCRIPT = path.join(__dirname, 'scrapling_fetch.py');

/**
 * Check if Scrapling is available
 * @returns {Promise<boolean>}
 */
async function isScraplingAvailable() {
    try {
        await execAsync('python3 -c "import scrapling"', { timeout: 5000 });
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
            '--action', 'fetch',
            '--url', JSON.stringify(url),
            '--timeout', timeout.toString()
        ];

        if (!headless) args.push('--headless', 'false');
        if (extractLinks) args.push('--extract-links');

        const { stdout, stderr } = await execAsync(
            `python3 "${SCRAPLING_SCRIPT}" ${args.join(' ')}`,
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
            '--action', 'search',
            '--query', JSON.stringify(query),
            '--max-results', maxResults.toString()
        ];

        const { stdout, stderr } = await execAsync(
            `python3 "${SCRAPLING_SCRIPT}" ${args.join(' ')}`,
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

    if (result.success && result.content) {
        result.source = 'scrapling';
        return result;
    }

    // If Scrapling failed and Playwright is available, try that
    if (playwrightService) {
        console.log('[Scrapling] Falling back to Playwright for:', url);
        try {
            const pwResult = await playwrightService.fetchUrlContent(url, {
                timeout: options.timeout || 15000,
                waitForJS: true,
                includeLinks: options.extractLinks || false
            });
            return {
                success: true,
                url,
                content: pwResult.content || '',
                title: pwResult.title || '',
                links: pwResult.links || [],
                source: 'playwright',
                scraplingError: result.error
            };
        } catch (pwErr) {
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
