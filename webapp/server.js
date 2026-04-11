const express = require('express');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');
const Docker = require('dockerode');
const crypto = require('crypto');
const os = require('os');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const initializePassport = require('./auth/passport-config');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { encryptApiKeys, decryptApiKeys, isEncrypted } = require('./utils/encryption');

// ============================================================================
// SSL INSPECTION BYPASS CONFIGURATION
// ============================================================================
// Auto-configured by build.sh when corporate SSL inspection is detected.
// This allows web search and URL fetching to work behind corporate proxies.
// Set NODE_TLS_REJECT_UNAUTHORIZED=0 in environment to enable bypass.

let sslBypassEnabled = false;
let httpsAgent = null;

// Check environment variable (set by docker-compose from build.sh detection)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    sslBypassEnabled = true;
    httpsAgent = new https.Agent({
        rejectUnauthorized: false
    });
    console.log('[SSL] Corporate proxy bypass enabled - SSL verification disabled for outbound requests');

    // Configure axios defaults for SSL bypass
    axios.defaults.httpsAgent = httpsAgent;
    console.log('[SSL] Axios configured with SSL bypass agent');
}

// Export SSL config for services to use
const sslConfig = {
    bypassEnabled: sslBypassEnabled,
    httpsAgent: httpsAgent
};

// Playwright service for advanced web scraping
let playwrightService = null;
let playwrightEnabled = false;

try {
    playwrightService = require('./services/playwrightService');
    playwrightEnabled = true;
    console.log('Playwright service loaded - advanced web scraping enabled');
} catch (error) {
    console.log('Playwright service not available - using axios fallback:', error.message);
}

// AIMem memory compression service
let memoryCompressorService = null;
let aimemEnabled = false;

try {
    memoryCompressorService = require('./services/memoryCompressorService');
    memoryCompressorService.isAvailable().then(available => {
        aimemEnabled = available;
        if (available) {
            console.log('AIMem memory compression loaded - conversation compression enabled');
        } else {
            console.log('AIMem Python dependencies not available - compression disabled');
        }
    }).catch(error => {
        console.log('AIMem availability check failed:', error.message);
        aimemEnabled = false;
    });
} catch (error) {
    console.log('AIMem service not available:', error.message);
}

// Scrapling service for captcha-evading web scraping
let scraplingService = null;
let scraplingEnabled = false;

try {
    scraplingService = require('./services/scraplingService');
    scraplingService.isScraplingAvailable().then(available => {
        scraplingEnabled = available;
        if (available) {
            console.log('Scrapling service loaded - captcha evasion enabled');
        } else {
            console.log('Scrapling Python module not available - using fallback');
        }
    }).catch(error => {
        console.log('Scrapling availability check failed:', error.message);
        scraplingEnabled = false;
    });
} catch (error) {
    console.log('Scrapling service not available:', error.message);
}

const app = express();

// Security: HTTP headers via helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],  // Required for MUI and Google Fonts
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "wss:", "ws:"],  // WebSocket connections
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false,  // Required for some external resources
    crossOriginResourcePolicy: { policy: "same-origin" },
}));

// Security: Rate limiting for authentication endpoints
const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false, // Count all requests
});

// Security: General API rate limiting
const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests, please slow down' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiters to specific routes (applied later when routes are defined)

// SSL configuration - use HTTPS if certificates exist
const CERTS_DIR = '/certs';
const SSL_KEY_PATH = path.join(CERTS_DIR, 'server.key');
const SSL_CERT_PATH = path.join(CERTS_DIR, 'server.crt');

let server;
let httpRedirectServer;
let useHttps = false;

if (fsSync.existsSync(SSL_KEY_PATH) && fsSync.existsSync(SSL_CERT_PATH)) {
    try {
        const sslOptions = {
            key: fsSync.readFileSync(SSL_KEY_PATH),
            cert: fsSync.readFileSync(SSL_CERT_PATH)
        };
        server = https.createServer(sslOptions, app);
        useHttps = true;
        console.log('HTTPS enabled with SSL certificates');

        // Create HTTP server on port 3080 for internal container-to-container communication
        // This allows internal services to connect without SSL verification issues
        console.log('HTTP server enabled on port 3080 for internal API access');
        httpRedirectServer = http.createServer(app);
    } catch (error) {
        console.error('Failed to load SSL certificates, falling back to HTTP:', error.message);
        server = http.createServer(app);
    }
} else {
    console.log('SSL certificates not found, using HTTP');
    server = http.createServer(app);
}

const wss = new WebSocket.Server({ server });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Timing-safe string comparison to prevent timing attacks on API keys
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// SSRF protection: validate URLs against private IP ranges
function isPrivateUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        const hostname = parsed.hostname.toLowerCase();
        // Block private/reserved hostnames
        if (['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(hostname)) return true;
        // Block private IP ranges
        const parts = hostname.split('.').map(Number);
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            if (parts[0] === 10) return true; // 10.0.0.0/8
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
            if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
            if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 (link-local/AWS metadata)
            if (parts[0] === 0) return true; // 0.0.0.0/8
        }
        // Block file:// and other dangerous protocols
        if (!['http:', 'https:'].includes(parsed.protocol)) return true;
        return false;
    } catch {
        return true; // Invalid URL = block
    }
}

// In-memory store for model instances (supports both vLLM and llama.cpp backends)
// Map structure: modelName -> { containerId, port, status, config, backend }
const modelInstances = new Map();

// Content continuation queue for processing large files in chunks
// Map structure: conversationId -> { content: string, processedChunks: number, totalChunks: number, chunkSize: number }
const contentContinuationQueue = new Map();

// Active streaming jobs - allows background processing when client disconnects
// Map structure: conversationId -> { userId, content, startTime, model, clientConnected, abortController }
const activeStreamingJobs = new Map();

// ============================================================================
// MAP-REDUCE CHUNKING CONFIGURATION
// ============================================================================
// When content exceeds context window, it's split into overlapping chunks,
// processed in parallel (map phase), and responses are synthesized (reduce phase)

const CHUNKING_CONFIG = {
    // Enable automatic map-reduce chunking for large content
    enabled: true,
    // Minimum tokens to trigger chunking (below this, use simple truncation)
    minTokensForChunking: 2000,
    // Overlap between chunks (tokens) - preserves context at boundaries
    overlapTokens: 300,  // Reduced for faster processing
    // Maximum concurrent chunk requests (increased for speed)
    maxParallelChunks: 8,
    // Tokens reserved for synthesis prompt
    synthesisPromptReserve: 500,
    // Characters per token estimate
    charsPerToken: 4,
    // Safety margin for token estimation
    safetyMargin: 1.05,
    // Per-chunk timeout in milliseconds (5 minutes)
    chunkTimeout: 300000,
    // Maximum retry attempts per chunk
    maxRetries: 3,
    // Enable content condensation before chunking
    enableCondensation: true,
    // Target compression ratio for condensation (0.3 = keep 30% of content)
    condensationRatio: 0.4,
    // Minimum sentences to keep even with condensation
    minSentencesToKeep: 50
};

/**
 * Extract keywords from a query for relevance matching
 * @param {string} query - The user's query
 * @returns {string[]} Array of keywords
 */
function extractQueryKeywords(query) {
    // Common stop words to filter out
    const stopWords = new Set([
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
        'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
        'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
        'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
        'because', 'until', 'while', 'although', 'though', 'after', 'before',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am',
        'it', 'its', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'you',
        'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they',
        'them', 'their', 'please', 'help', 'want', 'know', 'tell', 'give',
        'find', 'show', 'explain', 'describe', 'summarize', 'analyze', 'about'
    ]);

    // Extract words, filter stop words, keep meaningful terms
    const words = query.toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));

    // Also extract multi-word phrases (bigrams) for better matching
    const queryLower = query.toLowerCase();
    const phrases = [];
    const phrasePatterns = [
        /security\s+\w+/gi, /data\s+\w+/gi, /user\s+\w+/gi,
        /error\s+\w+/gi, /api\s+\w+/gi, /\w+\s+management/gi,
        /\w+\s+system/gi, /\w+\s+service/gi, /\w+\s+control/gi
    ];
    for (const pattern of phrasePatterns) {
        const matches = queryLower.match(pattern);
        if (matches) phrases.push(...matches);
    }

    return [...new Set([...words, ...phrases])];
}

/**
 * Score a sentence's relevance to query keywords
 * @param {string} sentence - The sentence to score
 * @param {string[]} keywords - Query keywords
 * @returns {number} Relevance score
 */
function scoreSentenceRelevance(sentence, keywords) {
    const sentenceLower = sentence.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
        if (sentenceLower.includes(keyword)) {
            // Exact match gets higher score
            score += keyword.length > 5 ? 3 : 2;
            // Bonus for keyword at start of sentence
            if (sentenceLower.startsWith(keyword) || sentenceLower.includes(`. ${keyword}`)) {
                score += 1;
            }
        }
    }

    // Bonus for sentences with numbers/data (likely important)
    if (/\d+/.test(sentence)) score += 0.5;

    // Bonus for sentences with key indicators
    if (/must|shall|required|important|critical|essential|key|primary/i.test(sentence)) {
        score += 1;
    }

    // Bonus for sentences containing URLs (high-value reference content)
    if (/https?:\/\//.test(sentence)) score += 3;

    return score;
}

/**
 * Condense content using query-focused extractive summarization
 * @param {string} content - The content to condense
 * @param {string} query - The user's query for relevance matching
 * @param {number} targetRatio - Target ratio of content to keep (0.0-1.0)
 * @returns {{condensed: string, originalLength: number, condensedLength: number, reductionPercent: number}}
 */
function condenseContent(content, query, targetRatio = CHUNKING_CONFIG.condensationRatio) {
    const originalLength = content.length;

    // Split into sentences (handle various sentence endings)
    const sentenceRegex = /[^.!?\n]+[.!?\n]+/g;
    const sentences = content.match(sentenceRegex) || [content];

    if (sentences.length <= CHUNKING_CONFIG.minSentencesToKeep) {
        // Not enough sentences to condense meaningfully
        return {
            condensed: content,
            originalLength,
            condensedLength: content.length,
            reductionPercent: 0,
            method: 'none'
        };
    }

    // Extract keywords from query
    const keywords = extractQueryKeywords(query);

    // Score each sentence for relevance
    const scoredSentences = sentences.map((sentence, index) => ({
        sentence: sentence.trim(),
        index,
        score: scoreSentenceRelevance(sentence, keywords),
        length: sentence.length
    }));

    // Sort by score (highest first)
    scoredSentences.sort((a, b) => b.score - a.score);

    // Always keep sentences containing URLs — these are high-value reference
    // content that users frequently ask about and should never be condensed out
    const urlSentences = scoredSentences.filter(s => /https?:\/\//.test(s.sentence));
    const nonUrlSentences = scoredSentences.filter(s => !/https?:\/\//.test(s.sentence));

    // Calculate target length
    const targetLength = Math.floor(originalLength * targetRatio);

    // Start with all URL sentences, then fill remaining budget from scored non-URL sentences
    const selectedSentences = [...urlSentences];
    let currentLength = urlSentences.reduce((sum, s) => sum + s.length, 0);

    for (const scored of nonUrlSentences) {
        if (currentLength + scored.length <= targetLength ||
            selectedSentences.length < CHUNKING_CONFIG.minSentencesToKeep) {
            selectedSentences.push(scored);
            currentLength += scored.length;
        }

        // Stop if we've collected enough
        if (currentLength >= targetLength &&
            selectedSentences.length >= CHUNKING_CONFIG.minSentencesToKeep) {
            break;
        }
    }

    // Re-sort by original index to maintain document order
    selectedSentences.sort((a, b) => a.index - b.index);

    // Build condensed content with section markers
    const condensed = selectedSentences.map(s => s.sentence).join(' ');
    const condensedLength = condensed.length;
    const reductionPercent = Math.round((1 - condensedLength / originalLength) * 100);

    console.log(`[Condensation] Reduced content from ${originalLength} to ${condensedLength} chars (${reductionPercent}% reduction, ${selectedSentences.length}/${sentences.length} sentences kept)`);

    return {
        condensed,
        originalLength,
        condensedLength,
        reductionPercent,
        sentencesKept: selectedSentences.length,
        totalSentences: sentences.length,
        method: 'query-focused-extractive'
    };
}

/**
 * Estimate token count from content (string or vision array)
 * @param {string|Array} content - The content to estimate tokens for
 * @returns {number} Estimated token count
 */
function estimateTokenCount(content) {
    const { charsPerToken, safetyMargin } = CHUNKING_CONFIG;

    if (typeof content === 'string') {
        return Math.ceil((content.length / charsPerToken) * safetyMargin);
    }
    if (Array.isArray(content)) {
        // Vision format: array of { type: 'text', text: '...' } and { type: 'image_url', ... }
        let tokens = 0;
        for (const part of content) {
            if (part.type === 'text' && part.text) {
                tokens += Math.ceil((part.text.length / charsPerToken) * safetyMargin);
            } else if (part.type === 'image_url') {
                // Images use ~1000 tokens (conservative estimate)
                tokens += 1000;
            }
        }
        return tokens;
    }
    return 0;
}

/**
 * Split content into overlapping chunks for map-reduce processing
 * @param {string} content - The content to split
 * @param {number} chunkSizeTokens - Target tokens per chunk
 * @param {number} overlapTokens - Overlap between chunks
 * @returns {Array<{content: string, index: number, isFirst: boolean, isLast: boolean}>}
 */
function splitIntoChunks(content, chunkSizeTokens, overlapTokens = CHUNKING_CONFIG.overlapTokens) {
    const { charsPerToken, safetyMargin } = CHUNKING_CONFIG;

    // Convert token counts to character counts
    const chunkSizeChars = Math.floor((chunkSizeTokens * charsPerToken) / safetyMargin);
    const overlapChars = Math.floor((overlapTokens * charsPerToken) / safetyMargin);
    const stepSize = chunkSizeChars - overlapChars;

    if (stepSize <= 0) {
        // If overlap is too large, just return the whole content
        return [{ content, index: 0, isFirst: true, isLast: true }];
    }

    const chunks = [];
    let position = 0;
    let index = 0;

    while (position < content.length) {
        const endPosition = Math.min(position + chunkSizeChars, content.length);
        let chunkContent = content.substring(position, endPosition);

        // Try to break at word/sentence boundary if not at the end
        if (endPosition < content.length) {
            // Look for sentence end (. ! ?) within last 10% of chunk
            const lookbackStart = Math.floor(chunkContent.length * 0.9);
            const lookbackRegion = chunkContent.substring(lookbackStart);
            const sentenceEnd = lookbackRegion.search(/[.!?]\s/);

            if (sentenceEnd !== -1) {
                // Found a sentence boundary - adjust chunk to end there
                const newEnd = lookbackStart + sentenceEnd + 2; // Include the punctuation and space
                chunkContent = chunkContent.substring(0, newEnd);
            } else {
                // Try to break at word boundary
                const lastSpace = chunkContent.lastIndexOf(' ');
                if (lastSpace > chunkContent.length * 0.8) {
                    chunkContent = chunkContent.substring(0, lastSpace + 1);
                }
            }
        }

        chunks.push({
            content: chunkContent,
            index,
            isFirst: index === 0,
            isLast: position + chunkContent.length >= content.length
        });

        // Move position by the actual chunk size minus overlap
        position += Math.max(chunkContent.length - overlapChars, stepSize);
        index++;

        // Safety check to prevent infinite loop
        if (index > 100) {
            console.warn('[Chunking] Maximum chunk count reached, stopping');
            chunks[chunks.length - 1].isLast = true;
            break;
        }
    }

    // Mark the last chunk
    if (chunks.length > 0) {
        chunks[chunks.length - 1].isLast = true;
    }

    return chunks;
}

/**
 * Generate the prompt for processing a single chunk
 * @param {string} chunkContent - The chunk content
 * @param {number} chunkIndex - Zero-based chunk index
 * @param {number} totalChunks - Total number of chunks
 * @param {string} originalQuery - The user's original query/question
 * @param {boolean} isFirst - Whether this is the first chunk
 * @param {boolean} isLast - Whether this is the last chunk
 * @returns {string} The formatted chunk prompt
 */
function buildChunkPrompt(chunkContent, chunkIndex, totalChunks, originalQuery, isFirst, isLast) {
    const position = isFirst ? 'BEGINNING' : (isLast ? 'END' : 'MIDDLE');

    return `[CHUNK ${chunkIndex + 1}/${totalChunks} - ${position} OF DOCUMENT]

The following is part ${chunkIndex + 1} of ${totalChunks} of a large document that was split due to context limitations.
${!isFirst ? 'Note: This chunk overlaps slightly with the previous chunk to maintain context.' : ''}
${!isLast ? 'Note: This chunk overlaps slightly with the next chunk.' : ''}

---CHUNK CONTENT START---
${chunkContent}
---CHUNK CONTENT END---

USER'S QUERY: ${originalQuery}

Please analyze this chunk and provide relevant findings. Focus on information pertinent to the user's query.
${isLast ? 'This is the final chunk.' : 'Your response will be combined with analyses of other chunks.'}`;
}

/**
 * Generate the synthesis prompt for combining chunk responses
 * @param {Array<{chunkIndex: number, response: string}>} chunkResponses - Array of chunk responses
 * @param {string} originalQuery - The user's original query
 * @returns {string} The synthesis prompt
 */
function buildSynthesisPrompt(chunkResponses, originalQuery) {
    const responseParts = chunkResponses
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map(cr => `[ANALYSIS OF CHUNK ${cr.chunkIndex + 1}/${chunkResponses.length}]\n${cr.response}`)
        .join('\n\n---\n\n');

    return `You are synthesizing multiple partial analyses of a large document that was processed in chunks.

ORIGINAL USER QUERY: ${originalQuery}

The document was split into ${chunkResponses.length} chunks and each was analyzed separately. Below are the individual analyses:

${responseParts}

---

Please synthesize these partial analyses into a single, coherent, and comprehensive response that:
1. Combines all relevant findings from each chunk
2. Eliminates redundancy (chunks had some overlap)
3. Presents information in a logical order
4. Directly addresses the user's original query
5. Notes if any information might be missing due to chunking

Provide your synthesized response:`;
}

/**
 * Process large content using map-reduce chunking strategy
 * @param {Object} options - Processing options
 * @param {string} options.targetHost - Model host
 * @param {number} options.targetPort - Model port
 * @param {string} options.largeContent - The large content to process
 * @param {string} options.originalQuery - The user's original query
 * @param {Array} options.systemMessages - System messages to include
 * @param {number} options.contextSize - Available context window size
 * @param {number} options.temperature - Temperature setting
 * @param {number} options.topP - Top P setting
 * @param {number} options.maxTokens - Max tokens for responses
 * @param {function} options.onProgress - Callback for progress updates
 * @returns {Promise<{success: boolean, response: string, chunkCount: number, error?: string}>}
 */
async function processWithMapReduce(options) {
    const {
        targetHost,
        targetPort,
        largeContent,
        originalQuery,
        systemMessages = [],
        contextSize,
        temperature = 0.7,
        topP = 1.0,
        maxTokens,
        onProgress
    } = options;

    const { overlapTokens, maxParallelChunks, synthesisPromptReserve } = CHUNKING_CONFIG;

    // Calculate available tokens for each chunk
    const systemTokens = systemMessages.reduce((sum, msg) => sum + estimateTokenCount(msg.content), 0);
    const queryTokens = estimateTokenCount(originalQuery);
    // Cap response reserve at 80% of context to always leave room for chunk content
    const maxResponseReserve = Math.floor(contextSize * 0.8);
    const responseReserve = Math.min(maxTokens || Math.floor(contextSize * 0.2), maxResponseReserve);

    // Available for chunk content = context - system - query wrapper - response reserve - buffer
    const availableForChunkContent = contextSize - systemTokens - queryTokens - responseReserve - 500;

    if (availableForChunkContent < 1000) {
        return {
            success: false,
            error: 'Context window too small for map-reduce chunking',
            chunkCount: 0
        };
    }

    // Split content into overlapping chunks
    const chunks = splitIntoChunks(largeContent, availableForChunkContent, overlapTokens);
    const totalChunks = chunks.length;

    console.log(`[Map-Reduce] Splitting content into ${totalChunks} chunks (${availableForChunkContent} tokens each, ${overlapTokens} token overlap)`);

    const totalTokens = estimateTokenCount(largeContent);
    if (onProgress) {
        onProgress({ phase: 'chunking', totalChunks, totalTokens, chunkTokens: availableForChunkContent, currentChunk: 0 });
    }

    // MAP PHASE: Process chunks in parallel (with concurrency limit)
    const chunkResponses = [];
    const chunkErrors = [];
    let completedChunks = 0;
    let failedChunks = 0;
    const mapStartTime = Date.now();

    // Process in batches to limit concurrency
    for (let batchStart = 0; batchStart < chunks.length; batchStart += maxParallelChunks) {
        const batchEnd = Math.min(batchStart + maxParallelChunks, chunks.length);
        const batch = chunks.slice(batchStart, batchEnd);

        console.log(`[Map-Reduce] Processing batch ${Math.floor(batchStart / maxParallelChunks) + 1}: chunks ${batchStart + 1}-${batchEnd}`);

        if (onProgress) {
            onProgress({
                phase: 'map',
                totalChunks,
                totalTokens,
                completedChunks,
                failedChunks,
                currentChunk: batchStart,
                elapsedMs: Date.now() - mapStartTime,
            });
        }

        const batchPromises = batch.map(async (chunk) => {
            const chunkPrompt = buildChunkPrompt(
                chunk.content,
                chunk.index,
                totalChunks,
                originalQuery,
                chunk.isFirst,
                chunk.isLast
            );

            const messages = [
                ...systemMessages,
                { role: 'user', content: chunkPrompt }
            ];

            // Retry logic with exponential backoff
            const maxRetries = 3;
            const baseTimeout = 300000; // 5 minute timeout per chunk

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const response = await axios({
                        method: 'post',
                        url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
                        data: {
                            messages,
                            temperature,
                            top_p: topP,
                            max_tokens: responseReserve,
                            stream: false
                        },
                        timeout: baseTimeout
                    });

                    const responseContent = response.data?.choices?.[0]?.message?.content || '';
                    completedChunks++;
                    console.log(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} completed (${responseContent.length} chars)${attempt > 1 ? ` after ${attempt} attempts` : ''}`);

                    // Send per-chunk completion progress
                    if (onProgress) {
                        onProgress({
                            phase: 'map',
                            totalChunks,
                            totalTokens,
                            completedChunks,
                            failedChunks,
                            currentChunk: chunk.index,
                            elapsedMs: Date.now() - mapStartTime,
                            chunkChars: responseContent.length,
                        });
                    }

                    return {
                        chunkIndex: chunk.index,
                        response: responseContent,
                        success: true,
                        attempts: attempt
                    };
                } catch (error) {
                    const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
                    const isRetryable = isTimeout || error.code === 'ECONNRESET' || error.response?.status >= 500;

                    if (attempt < maxRetries && isRetryable) {
                        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
                        console.log(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} attempt ${attempt} failed (${error.message}), retrying in ${delay/1000}s...`);

                        // Send retry progress
                        if (onProgress) {
                            onProgress({
                                phase: 'map',
                                totalChunks,
                                totalTokens,
                                completedChunks,
                                failedChunks,
                                currentChunk: chunk.index,
                                elapsedMs: Date.now() - mapStartTime,
                                retrying: { chunk: chunk.index + 1, attempt, maxRetries },
                            });
                        }

                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    failedChunks++;
                    console.error(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} failed after ${attempt} attempts:`, error.message);

                    if (onProgress) {
                        onProgress({
                            phase: 'map',
                            totalChunks,
                            totalTokens,
                            completedChunks,
                            failedChunks,
                            currentChunk: chunk.index,
                            elapsedMs: Date.now() - mapStartTime,
                        });
                    }

                    return {
                        chunkIndex: chunk.index,
                        response: `[Error processing chunk ${chunk.index + 1}: ${error.message}]`,
                        success: false,
                        error: error.message,
                        attempts: attempt
                    };
                }
            }

            // Should not reach here, but return error just in case
            return {
                chunkIndex: chunk.index,
                response: `[Error processing chunk ${chunk.index + 1}: Max retries exceeded]`,
                success: false,
                error: 'Max retries exceeded',
                attempts: maxRetries
            };
        });

        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
            if (result.success) {
                chunkResponses.push(result);
            } else {
                chunkErrors.push(result);
            }
        }
    }

    // Check if we have enough successful responses
    if (chunkResponses.length === 0) {
        return {
            success: false,
            error: 'All chunk processing failed',
            chunkCount: totalChunks,
            errors: chunkErrors
        };
    }

    // Add error responses with error messages so they're included in synthesis
    for (const err of chunkErrors) {
        chunkResponses.push(err);
    }

    console.log(`[Map-Reduce] Map phase complete: ${chunkResponses.length - chunkErrors.length}/${totalChunks} chunks successful`);

    // REDUCE PHASE: Synthesize chunk responses
    const mapElapsedMs = Date.now() - mapStartTime;
    if (onProgress) {
        onProgress({
            phase: 'reduce',
            totalChunks,
            totalTokens,
            completedChunks,
            failedChunks,
            elapsedMs: mapElapsedMs,
        });
    }

    // Check if synthesis would fit in context
    const synthesisPrompt = buildSynthesisPrompt(chunkResponses, originalQuery);
    const synthesisTokens = estimateTokenCount(synthesisPrompt);

    if (synthesisTokens > contextSize - responseReserve - synthesisPromptReserve) {
        // Synthesis prompt is too large - need to do hierarchical reduction
        console.log(`[Map-Reduce] Synthesis prompt too large (${synthesisTokens} tokens), using direct concatenation`);

        // Fall back to concatenating chunk responses with clear separation
        const directResponse = chunkResponses
            .sort((a, b) => a.chunkIndex - b.chunkIndex)
            .map(cr => cr.response)
            .join('\n\n---\n\n');

        return {
            success: true,
            response: `[Note: Content was processed in ${totalChunks} chunks. Synthesis was skipped due to response size.]\n\n${directResponse}`,
            chunkCount: totalChunks,
            synthesized: false
        };
    }

    // Perform synthesis
    const synthesisMessages = [
        ...systemMessages,
        { role: 'user', content: synthesisPrompt }
    ];

    try {
        console.log(`[Map-Reduce] Starting synthesis (${synthesisTokens} tokens input)`);

        const synthesisResponse = await axios({
            method: 'post',
            url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
            data: {
                messages: synthesisMessages,
                temperature: Math.max(0.3, temperature - 0.2), // Slightly lower temp for synthesis
                top_p: topP,
                max_tokens: responseReserve,
                stream: false
            },
            timeout: 180000 // 3 minute timeout for synthesis
        });

        const finalResponse = synthesisResponse.data?.choices?.[0]?.message?.content || '';
        console.log(`[Map-Reduce] Synthesis complete (${finalResponse.length} chars)`);

        if (onProgress) {
            onProgress({
                phase: 'complete',
                totalChunks,
                totalTokens,
                completedChunks,
                failedChunks,
                elapsedMs: Date.now() - mapStartTime,
            });
        }

        return {
            success: true,
            response: finalResponse,
            chunkCount: totalChunks,
            synthesized: true,
            failedChunks: chunkErrors.length
        };

    } catch (error) {
        console.error(`[Map-Reduce] Synthesis failed:`, error.message);

        // Fall back to concatenated responses
        const directResponse = chunkResponses
            .sort((a, b) => a.chunkIndex - b.chunkIndex)
            .map(cr => cr.response)
            .join('\n\n---\n\n');

        return {
            success: true,
            response: `[Note: Synthesis failed (${error.message}). Showing concatenated chunk responses:]\n\n${directResponse}`,
            chunkCount: totalChunks,
            synthesized: false,
            synthesisError: error.message
        };
    }
}

// Global active backend state - determines which backend is used for loading models
// Can be 'llamacpp' or 'vllm'
let activeBackend = 'llamacpp'; // Default to llama.cpp for older GPU support

// Backend configuration defaults
const BACKEND_DEFAULTS = {
    vllm: {
        maxModelLen: 4096,
        cpuOffloadGb: 0,
        gpuMemoryUtilization: 0.9,
        tensorParallelSize: 1,
        maxNumSeqs: 256,
        kvCacheDtype: 'auto',
        trustRemoteCode: true,
        enforceEager: false,
        disableThinking: false
    },
    llamacpp: {
        nGpuLayers: -1,
        contextSize: 4096,
        flashAttention: false,
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        threads: 0,  // 0 = auto-detect
        parallelSlots: 1,
        batchSize: 2048,
        ubatchSize: 512,
        repeatPenalty: 1.1,
        repeatLastN: 64,
        presencePenalty: 0.0,
        frequencyPenalty: 0.0,
        disableThinking: false
    }
};

// In-memory store for active model downloads
// Map structure: downloadId -> { downloadId, ggufRepo, ggufFile, status, progress, startTime, childProcess }
const activeDownloads = new Map();

// ============================================================================
// HOST MODELS PATH DETECTION
// ============================================================================
// Stores the actual host path to the models directory
// This is detected at startup by inspecting the webapp container's mounts
// Required for creating dynamic model containers with correct volume bindings
let hostModelsPath = null;

/**
 * Detects the host path to the models directory by inspecting the webapp container.
 * This is necessary because the webapp runs inside a container with ./models:/models mount,
 * and we need to know the actual host path to create dynamic model containers.
 *
 * Works across all installation types:
 * - Linux + Docker (bare metal)
 * - Windows + WSL + Docker Desktop
 * - macOS + Docker Desktop
 *
 * @returns {Promise<string>} The host path to the models directory
 */
async function detectHostModelsPath() {
    try {
        // Method 1: Try to find webapp container by name patterns
        const containers = await docker.listContainers({ all: true });

        // Look for containers that match our webapp patterns
        const webappPatterns = [
            'modelserver-webapp',
            'modelserver_webapp',
            'opensourcemodelmanager-webapp',
            'opensourcemodelmanager_webapp'
        ];

        let webappContainer = null;
        for (const containerInfo of containers) {
            const names = containerInfo.Names || [];
            const image = containerInfo.Image || '';

            // Check container names
            for (const name of names) {
                const cleanName = name.replace(/^\//, ''); // Remove leading slash
                if (webappPatterns.some(pattern => cleanName.includes(pattern))) {
                    webappContainer = docker.getContainer(containerInfo.Id);
                    break;
                }
            }

            // Check image name
            if (!webappContainer && image.includes('modelserver-webapp')) {
                webappContainer = docker.getContainer(containerInfo.Id);
            }

            if (webappContainer) break;
        }

        if (webappContainer) {
            const containerData = await webappContainer.inspect();
            const mounts = containerData.Mounts || [];

            // Find the /models mount
            for (const mount of mounts) {
                if (mount.Destination === '/models') {
                    const sourcePath = mount.Source;
                    console.log(`Detected host models path from container mount: ${sourcePath}`);
                    return sourcePath;
                }
            }
        }

        // Method 2: Try to read from environment variable (can be set in docker-compose)
        if (process.env.HOST_MODELS_PATH) {
            console.log(`Using HOST_MODELS_PATH environment variable: ${process.env.HOST_MODELS_PATH}`);
            return process.env.HOST_MODELS_PATH;
        }

        // Method 3: Try common installation paths
        // Check if we're running in a Docker context and can detect the project root
        const hostname = os.hostname();

        // Try to find the compose project directory from Docker labels
        for (const containerInfo of containers) {
            const labels = containerInfo.Labels || {};
            if (labels['com.docker.compose.project.working_dir']) {
                const projectDir = labels['com.docker.compose.project.working_dir'];
                const modelsPath = path.posix.join(projectDir, 'models');
                console.log(`Detected host models path from compose project: ${modelsPath}`);
                return modelsPath;
            }
        }

        // Fallback: Use a reasonable default based on common Docker setups
        console.warn('Could not detect host models path automatically. Using /models as fallback.');
        console.warn('If models fail to load, set HOST_MODELS_PATH environment variable in docker-compose.yml');
        return '/models';

    } catch (error) {
        console.error('Error detecting host models path:', error.message);
        console.warn('Using /models as fallback. Set HOST_MODELS_PATH if needed.');
        return '/models';
    }
}

/**
 * Gets the volume bind string for model containers.
 * Uses the detected host models path.
 * @returns {string} Volume bind string like "/path/to/models:/models:ro"
 */
function getModelsVolumeBind() {
    if (!hostModelsPath) {
        console.error('Host models path not initialized! Using /models as emergency fallback.');
        return '/models:/models:ro';
    }
    return `${hostModelsPath}:/models:ro`;
}

// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent server crashes
// ============================================================================

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
    console.error('Promise:', promise);

    // Build detailed error message for logs
    const errorMsg = reason instanceof Error
        ? `${reason.message}${reason.code ? ` (${reason.code})` : ''}`
        : (typeof reason === 'string' ? reason : JSON.stringify(reason) || 'Unknown error');
    const stack = reason instanceof Error && reason.stack
        ? `\n${reason.stack.split('\n').slice(1, 3).join('\n').trim()}`
        : '';

    // Try to broadcast error to connected clients
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: `[Error] Unhandled rejection: ${errorMsg}${stack}`,
                level: 'error'
            });
        }
    } catch (broadcastError) {
        console.error('Failed to broadcast error:', broadcastError);
    }

    // Don't exit - keep server running
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    console.error('Stack:', error.stack);

    // Build detailed error message for logs
    const errorMsg = `${error.message || 'Unknown error'}${error.code ? ` (${error.code})` : ''}`;
    const stack = error.stack
        ? `\n${error.stack.split('\n').slice(1, 3).join('\n').trim()}`
        : '';

    // Try to broadcast error to connected clients
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: `[Error] Uncaught exception: ${errorMsg}${stack}`,
                level: 'error'
            });
        }
    } catch (broadcastError) {
        console.error('Failed to broadcast error:', broadcastError);
    }

    // Don't exit - keep server running (though in production you might want to restart)
    // For now, we'll keep it alive to maintain existing connections
});

// Sync model instances from Docker on startup (handles both vLLM and llama.cpp)
// Optimized: Parallelized container inspection for faster startup
async function syncModelInstances() {
    try {
        console.log('Syncing model instances from Docker...');
        const containers = await docker.listContainers({ all: true });

        // Filter model containers first
        const modelContainers = containers
            .map(containerInfo => {
                const name = containerInfo.Names[0].substring(1); // Remove leading /
                let backend = null;
                let modelName = null;

                if (name.startsWith('vllm-')) {
                    backend = 'vllm';
                    modelName = name.replace('vllm-', '');
                } else if (name.startsWith('llamacpp-')) {
                    backend = 'llamacpp';
                    modelName = name.replace('llamacpp-', '');
                }

                return backend ? { containerInfo, backend, modelName } : null;
            })
            .filter(Boolean);

        // Parallel inspection of all model containers
        const inspectResults = await Promise.all(
            modelContainers.map(async ({ containerInfo, backend, modelName }) => {
                try {
                    const container = docker.getContainer(containerInfo.Id);
                    const inspect = await container.inspect();
                    return { containerInfo, backend, modelName, inspect };
                } catch (error) {
                    console.error(`  - Error inspecting ${modelName}:`, error.message);
                    return null;
                }
            })
        );

        // Process results
        for (const result of inspectResults) {
            if (!result) continue;

            const { containerInfo, backend, modelName, inspect } = result;

            // Extract port from environment or use default
            let port = 8000;
            const getEnvValue = (key) => {
                if (!inspect.Config.Env) return null;
                const env = inspect.Config.Env.find(e => e.startsWith(`${key}=`));
                return env ? env.split('=')[1] : null;
            };

            if (backend === 'vllm') {
                port = parseInt(getEnvValue('VLLM_PORT') || '8000');
            } else if (backend === 'llamacpp') {
                port = parseInt(getEnvValue('LLAMA_PORT') || '8000');
            }

            // Extract config from environment variables based on backend
            let config = {};

            if (backend === 'vllm') {
                const maxModelLen = parseInt(getEnvValue('VLLM_MAX_MODEL_LEN') || '4096');
                config = {
                    maxModelLen,
                    contextSize: maxModelLen,  // Alias for chat stream compatibility
                    contextShift: getEnvValue('VLLM_CTX_SHIFT') !== 'false',
                    cpuOffloadGb: parseFloat(getEnvValue('VLLM_CPU_OFFLOAD_GB') || '0'),
                    gpuMemoryUtilization: parseFloat(getEnvValue('VLLM_GPU_MEMORY_UTILIZATION') || '0.9'),
                    tensorParallelSize: parseInt(getEnvValue('VLLM_TENSOR_PARALLEL_SIZE') || '1'),
                    maxNumSeqs: parseInt(getEnvValue('VLLM_MAX_NUM_SEQS') || '256'),
                    kvCacheDtype: getEnvValue('VLLM_KV_CACHE_DTYPE') || 'auto'
                };
            } else if (backend === 'llamacpp') {
                config = {
                    nGpuLayers: parseInt(getEnvValue('LLAMA_N_GPU_LAYERS') || '-1'),
                    contextSize: parseInt(getEnvValue('LLAMA_CTX_SIZE') || '4096'),
                    contextShift: getEnvValue('LLAMA_CTX_SHIFT') !== 'false',
                    flashAttention: getEnvValue('LLAMA_FLASH_ATTN') === 'true',
                    cacheTypeK: getEnvValue('LLAMA_CACHE_TYPE_K') || 'f16',
                    cacheTypeV: getEnvValue('LLAMA_CACHE_TYPE_V') || 'f16',
                    threads: parseInt(getEnvValue('LLAMA_THREADS') || '0'),
                    parallelSlots: parseInt(getEnvValue('LLAMA_PARALLEL') || '1'),
                    batchSize: parseInt(getEnvValue('LLAMA_BATCH_SIZE') || '2048'),
                    ubatchSize: parseInt(getEnvValue('LLAMA_UBATCH_SIZE') || '512'),
                    repeatPenalty: parseFloat(getEnvValue('LLAMA_REPEAT_PENALTY') || '1.1'),
                    repeatLastN: parseInt(getEnvValue('LLAMA_REPEAT_LAST_N') || '64')
                };
            }

            const status = inspect.State.Running ? 'running' : 'stopped';
            const containerName = containerInfo.Names[0].substring(1); // Remove leading /

            modelInstances.set(modelName, {
                containerId: containerInfo.Id,
                containerName,
                port,
                internalPort: port,
                status,
                modelName,
                config,
                backend
            });

            console.log(`  - Found ${modelName} (${backend}) on port ${port} (${status}) [container: ${containerName}]`);
        }

        console.log(`Synced ${modelInstances.size} model instance(s)`);
        // Start monitoring unconditionally — the UI resource panel needs
        // CPU/GPU/RAM samples even when no model is loaded. nvidia-smi at a
        // 3s cadence is effectively free.
        startSystemMonitoring();
    } catch (error) {
        console.error('Error syncing model instances:', error);
    }
}

// Persistent storage paths
const DATA_DIR = '/models/.modelserver';
const SYSTEM_PROMPTS_FILE = path.join(DATA_DIR, 'system-prompts.json');
const MODEL_CONFIGS_FILE = path.join(DATA_DIR, 'model-configs.json');
const API_KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');
const API_KEY_USAGE_STATS_FILE = path.join(DATA_DIR, 'api-key-usage-stats.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const AGENT_PERMISSIONS_FILE = path.join(DATA_DIR, 'agent-permissions.json');

// ============================================================================
// IN-MEMORY CACHE FOR PERFORMANCE
// ============================================================================

// Cache for agents, skills, tasks, and permissions with TTL
const dataCache = {
    agents: { data: null, timestamp: 0 },
    skills: { data: null, timestamp: 0 },
    tasks: { data: null, timestamp: 0 },
    agentPermissions: { data: null, timestamp: 0 },
    systemPrompts: { data: null, timestamp: 0 },
    modelConfigs: { data: null, timestamp: 0 }
};

// Cache TTL in milliseconds (30 seconds default)
const CACHE_TTL = 30000;

// Invalidate specific cache
function invalidateCache(cacheKey) {
    if (dataCache[cacheKey]) {
        dataCache[cacheKey].data = null;
        dataCache[cacheKey].timestamp = 0;
    }
}

// Check if cache is valid
function isCacheValid(cacheKey) {
    const cache = dataCache[cacheKey];
    return cache && cache.data !== null && (Date.now() - cache.timestamp) < CACHE_TTL;
}

// ============================================================================
// PERSISTENT STORAGE HELPERS
// ============================================================================

async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

async function loadSystemPrompts() {
    try {
        const data = await fs.readFile(SYSTEM_PROMPTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        console.error('Error loading system prompts:', err);
        return {};
    }
}

async function saveSystemPrompts(prompts) {
    await ensureDataDir();
    await fs.writeFile(SYSTEM_PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

async function loadModelConfigs() {
    try {
        const data = await fs.readFile(MODEL_CONFIGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        console.error('Error loading model configs:', err);
        return {};
    }
}

async function saveModelConfigs(configs) {
    await ensureDataDir();
    await fs.writeFile(MODEL_CONFIGS_FILE, JSON.stringify(configs, null, 2));
}

// ============================================================================
// AGENTS STORAGE HELPERS (with caching)
// ============================================================================

async function loadAgents() {
    // Check cache first
    if (isCacheValid('agents')) {
        return dataCache.agents.data;
    }
    try {
        const data = await fs.readFile(AGENTS_FILE, 'utf8');
        const agents = JSON.parse(data);
        // Update cache
        dataCache.agents.data = agents;
        dataCache.agents.timestamp = Date.now();
        return agents;
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading agents:', err);
        return [];
    }
}

async function saveAgents(agents) {
    await ensureDataDir();
    await fs.writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2));
    // Invalidate cache on write
    invalidateCache('agents');
}

async function loadSkills() {
    // Check cache first
    if (isCacheValid('skills')) {
        return dataCache.skills.data;
    }
    try {
        const data = await fs.readFile(SKILLS_FILE, 'utf8');
        const skills = JSON.parse(data);
        // Update cache
        dataCache.skills.data = skills;
        dataCache.skills.timestamp = Date.now();
        return skills;
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading skills:', err);
        return [];
    }
}

async function saveSkills(skills) {
    await ensureDataDir();
    await fs.writeFile(SKILLS_FILE, JSON.stringify(skills, null, 2));
    // Invalidate cache on write
    invalidateCache('skills');
}

async function loadTasks() {
    // Check cache first
    if (isCacheValid('tasks')) {
        return dataCache.tasks.data;
    }
    try {
        const data = await fs.readFile(TASKS_FILE, 'utf8');
        const tasks = JSON.parse(data);
        // Update cache
        dataCache.tasks.data = tasks;
        dataCache.tasks.timestamp = Date.now();
        return tasks;
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading tasks:', err);
        return [];
    }
}

async function saveTasks(tasks) {
    await ensureDataDir();
    await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
    // Invalidate cache on write
    invalidateCache('tasks');
}

async function loadAgentPermissions() {
    // Check cache first
    if (isCacheValid('agentPermissions')) {
        return dataCache.agentPermissions.data;
    }
    try {
        const data = await fs.readFile(AGENT_PERMISSIONS_FILE, 'utf8');
        const permissions = JSON.parse(data);
        // Update cache
        dataCache.agentPermissions.data = permissions;
        dataCache.agentPermissions.timestamp = Date.now();
        return permissions;
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Default permissions - all enabled
            const defaultPerms = {
                allowFileRead: true,
                allowFileWrite: true,
                allowFileDelete: true,
                allowToolExecution: true,
                allowModelAccess: true,
                allowCollaboration: true
            };
            // Cache default permissions too
            dataCache.agentPermissions.data = defaultPerms;
            dataCache.agentPermissions.timestamp = Date.now();
            return defaultPerms;
        }
        console.error('Error loading agent permissions:', err);
        return {};
    }
}

async function saveAgentPermissions(permissions) {
    await ensureDataDir();
    await fs.writeFile(AGENT_PERMISSIONS_FILE, JSON.stringify(permissions, null, 2));
    // Invalidate cache on write
    invalidateCache('agentPermissions');
}

// Port allocation for vLLM instances
const BASE_PORT = 8001;

function allocatePort() {
    // Find the lowest available port starting from BASE_PORT
    const usedPorts = new Set(
        Array.from(modelInstances.values()).map(instance => instance.port)
    );

    let port = BASE_PORT;
    while (usedPorts.has(port)) {
        port++;
    }
    return port;
}

// Session middleware configuration
// Persist session secret so sessions survive container restarts
const SESSION_SECRET_FILE = path.join(DATA_DIR, '.session-secret');
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    try {
        SESSION_SECRET = fsSync.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
    } catch {
        SESSION_SECRET = crypto.randomBytes(32).toString('hex');
        try {
            fsSync.writeFileSync(SESSION_SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
            console.log('[Security] Generated and persisted new session secret');
        } catch (e) {
            console.warn('[Security] Could not persist session secret:', e.message);
        }
    }
}
const SESSION_DIR = path.join('/models/.modelserver', 'sessions');

// Ensure sessions directory exists
if (!fsSync.existsSync(SESSION_DIR)) {
    fsSync.mkdirSync(SESSION_DIR, { recursive: true });
}

// Create FileStore with error handling to prevent crashes from corrupted sessions
const sessionStore = new FileStore({
    path: SESSION_DIR,
    ttl: 7 * 24 * 60 * 60, // 7 days in seconds
    retries: 0,
    secret: SESSION_SECRET,
    reapInterval: 3600  // Set to 1 hour but we'll immediately clear it
});

// CRITICAL: Stop the automatic cleanup interval to prevent crashes from corrupted sessions
// The reapIntervalObject contains the setInterval timer that causes crashes
console.log('Checking session store options:', JSON.stringify({
    hasOptions: !!sessionStore.options,
    hasReapInterval: !!(sessionStore.options && sessionStore.options.reapIntervalObject),
    reapInterval: sessionStore.options && sessionStore.options.reapInterval
}));

if (sessionStore.options && sessionStore.options.reapIntervalObject) {
    console.log('Clearing reapIntervalObject...');
    clearInterval(sessionStore.options.reapIntervalObject);
    sessionStore.options.reapIntervalObject = null;
    console.log('Session auto-cleanup interval cleared');
} else {
    console.log('WARNING: reapIntervalObject not found - cleanup may still run!');
    // Try to find and clear any intervals anyway
    if (sessionStore.options) {
        Object.keys(sessionStore.options).forEach(key => {
            console.log(`Session store option: ${key} = ${typeof sessionStore.options[key]}`);
        });
    }
}

// Override the reap method to safely handle errors if called manually
const originalReap = sessionStore.reap;
if (originalReap) {
    sessionStore.reap = function(callback) {
        console.log('Session cleanup called (will handle errors gracefully)');
        try {
            originalReap.call(this, function(err) {
                if (err) {
                    console.error('Session cleanup error (non-fatal):', err.message);
                    // Call callback without error to prevent crash
                    if (callback) callback();
                } else {
                    console.log('Session cleanup completed successfully');
                    if (callback) callback();
                }
            });
        } catch (error) {
            console.error('Session cleanup exception (non-fatal):', error.message);
            if (callback) callback();
        }
    };
}

// Override touch() to handle missing session files gracefully.
// When a session cookie references a file that was deleted (reap, manual cleanup),
// the default touch() throws ENOENT which bubbles up as a request error.
const originalTouch = sessionStore.touch;
if (originalTouch) {
    sessionStore.touch = function(sessionId, session, callback) {
        originalTouch.call(this, sessionId, session, function(err) {
            if (err && err.code === 'ENOENT') {
                // Session file gone — treat as expired, not a crash
                if (callback) callback();
                return;
            }
            if (callback) callback(err);
        });
    };
}

app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: useHttps, // Only send cookie over HTTPS if enabled
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
        sameSite: 'lax'
    },
    name: 'modelserver.sid' // Custom session cookie name
}));

// Initialize Passport
initializePassport(passport);
app.use(passport.initialize());
app.use(passport.session());

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    },
}));

// Helper function to parse session ID from cookie string
function parseSessionCookie(cookieHeader) {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        acc[key] = value;
        return acc;
    }, {});

    const sessionCookie = cookies['modelserver.sid'];
    if (!sessionCookie) return null;

    // Decode the signed cookie (format: s:sessionId.signature)
    const decoded = decodeURIComponent(sessionCookie);
    if (decoded.startsWith('s:')) {
        return decoded.substring(2).split('.')[0];
    }

    return decoded;
}

// Helper function to get userId from session ID
async function getUserIdFromSession(sessionId) {
    if (!sessionId) return null;

    try {
        const sessionFile = path.join(SESSION_DIR, `${sessionId}.json`);
        const sessionData = await fs.readFile(sessionFile, 'utf8');
        const session = JSON.parse(sessionData);

        // If user is authenticated via Passport, session.passport.user contains user ID
        if (session.passport && session.passport.user) {
            return session.passport.user;
        }
    } catch (error) {
        // Session file doesn't exist or can't be read
        return null;
    }

    return null;
}

// Enhanced WebSocket connection with user binding
wss.on('connection', async (ws, req) => {
    console.log('Client connected');

    let userId = null;
    try {
        // Try to bind WebSocket to user session
        const sessionId = parseSessionCookie(req.headers.cookie);
        userId = await getUserIdFromSession(sessionId);

        ws.userId = userId;
        ws.sessionId = sessionId;

        if (userId) {
            console.log(`WebSocket bound to user: ${userId}`);
        }
    } catch (error) {
        console.error('Error setting up WebSocket connection:', error.message);
    }

    if (!userId) {
        console.warn('[WebSocket] Connection without session - will not receive user-targeted messages');
    }

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        // Don't crash - just log the error
    });
});

// Enhanced broadcast function with optional user filtering
// If targetUserId is provided, only send to that user's connections
// If targetUserId is null, send to all connected clients
const broadcast = (data, targetUserId = null) => {
    // Wrap in try-catch to prevent crashes from broadcast failures
    try {
        const jsonData = JSON.stringify(data);

        wss.clients.forEach((client) => {
            try {
                if (client.readyState === WebSocket.OPEN) {
                    // If no target user specified, send to all
                    if (!targetUserId) {
                        client.send(jsonData);
                    }
                    // If target user specified, only send to their connections
                    else if (client.userId === targetUserId) {
                        client.send(jsonData);
                    }
                }
            } catch (sendError) {
                // Log error but don't crash - client might have disconnected
                console.error('Error sending to WebSocket client:', sendError.message);
            }
        });
    } catch (error) {
        // Log error but don't crash - data serialization might have failed
        console.error('Error in broadcast function:', error.message);
    }
};

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

const {
    createUser,
    getUserById,
    changePassword,
    getAllUsers,
    updateUser,
    deleteUser,
    adminResetPassword,
    createPendingUser,
    completeRegistration,
    disableUser,
    enableUser,
    hasAnyUsers,
    selfServicePasswordReset
} = require('./auth/users');

// Check if any users exist (for first admin setup)
app.get('/api/auth/has-users', authRateLimiter, async (req, res) => {
    try {
        const hasUsers = await hasAnyUsers();
        res.json({ hasUsers });
    } catch (error) {
        console.error('Check users error:', error);
        res.status(500).json({ error: 'Failed to check users' });
    }
});

// Register a new user (rate limited to prevent brute force)
// First user becomes admin and bypasses email requirement
// Subsequent users must have email pre-registered by admin
app.post('/api/auth/register', authRateLimiter, async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        // Validate password strength
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        // Check if this is the first user (becomes admin)
        const isFirstUser = !(await hasAnyUsers());

        const user = await createUser({ username, email, password }, isFirstUser);

        res.status(201).json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            },
            isFirstUser
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(400).json({ error: error.message || 'Registration failed' });
    }
});

// Self-service password reset (requires username, email, and current password)
app.post('/api/auth/reset-password', authRateLimiter, async (req, res) => {
    try {
        const { username, email, currentPassword, newPassword } = req.body;

        if (!username || !email || !currentPassword || !newPassword) {
            return res.status(400).json({
                error: 'Username, email, current password, and new password are required'
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }

        await selfServicePasswordReset(username, email, currentPassword, newPassword);

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Self-service password reset error:', error);
        res.status(400).json({ error: error.message || 'Password reset failed' });
    }
});

// Login user (rate limited to prevent brute force)
app.post('/api/auth/login', authRateLimiter, (req, res, next) => {
    passport.authenticate('local', async (err, user, info) => {
        if (err) {
            return res.status(500).json({ error: 'Authentication error' });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        req.logIn(user, async (err) => {
            if (err) {
                return res.status(500).json({ error: 'Login failed' });
            }

            // Update last login time
            try {
                await updateUser(user.id, { lastLoginAt: new Date().toISOString() });
            } catch (updateErr) {
                console.error('Failed to update lastLoginAt:', updateErr);
            }

            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                }
            });
        });
    })(req, res, next);
});

// Logout user
app.post('/api/auth/logout', (req, res) => {
    // Require authenticated session
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    req.logout((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }

        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ error: 'Session destruction failed' });
            }

            res.clearCookie('modelserver.sid');
            res.json({ success: true, message: 'Logged out successfully' });
        });
    });
});

// Get current user info
app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const response = {};

        // If session authentication, return user info
        if (req.isAuthenticated && req.isAuthenticated()) {
            const user = await getUserById(req.user.id);

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            response.user = {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            };
        }

        // If API key authentication, return API key info and usage stats
        if (req.apiKeyData) {
            const keyData = req.apiKeyData;
            const stats = apiKeyUsageStats.get(keyData.id) || {
                requestCount: 0,
                tokenCount: 0,
                lastUsed: null,
                requests: []
            };

            // Calculate token usage for today (calendar day, resets at midnight)
            const startOfDay = getStartOfDay();
            const dailyTokens = stats.requests
                .filter(r => r.timestamp >= startOfDay)
                .reduce((sum, r) => sum + (r.tokens || 0), 0);

            // Calculate usage percentages
            const tokenUsagePercentage = keyData.rateLimitTokens ?
                Math.min(100, (dailyTokens / keyData.rateLimitTokens * 100)) : 0;

            response.apiKey = {
                id: keyData.id,
                name: keyData.name,
                permissions: keyData.permissions,
                rateLimitRequests: keyData.rateLimitRequests,
                rateLimitTokens: keyData.rateLimitTokens,
                active: keyData.active,
                stats: {
                    requestCount: stats.requestCount,
                    tokenCount: stats.tokenCount,
                    dailyTokens,
                    tokenUsagePercentage: tokenUsagePercentage.toFixed(1),
                    lastUsed: stats.lastUsed
                }
            };
        }

        res.json(response);
    } catch (error) {
        console.error('Get auth info error:', error);
        res.status(500).json({ error: 'Failed to get authentication info' });
    }
});

// Change password (rate limited to prevent brute force)
app.put('/api/auth/password', authRateLimiter, requireAuth, async (req, res) => {
    // Require session authentication only - API keys cannot change passwords
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Session authentication required for password changes' });
    }

    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }

        await changePassword(req.user.id, currentPassword, newPassword);

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(400).json({ error: error.message || 'Failed to change password' });
    }
});

// ============================================================================
// USER MANAGEMENT ENDPOINTS (Admin Only)
// ============================================================================

// Get all users (admin only)
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const users = await getAllUsers();
        res.json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// Update user (admin only)
app.put('/api/users/:id', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;

        // Whitelist allowed fields to prevent mass assignment
        const { email, disabled, role } = req.body;
        const updates = {};
        if (email !== undefined) updates.email = email;
        if (disabled !== undefined) updates.disabled = disabled;
        if (role !== undefined && req.user.role === 'admin') updates.role = role;

        const updatedUser = await updateUser(id, updates);
        res.json(updatedUser);
    } catch (error) {
        console.error('Update user error:', error);
        res.status(400).json({ error: error.message || 'Failed to update user' });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;

        // Prevent deleting self
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await deleteUser(id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(400).json({ error: error.message || 'Failed to delete user' });
    }
});

// Reset user password (admin only)
app.post('/api/users/:username/reset-password', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { username } = req.params;
        const { newPassword } = req.body;

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }

        await adminResetPassword(username, newPassword);
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(400).json({ error: error.message || 'Failed to reset password' });
    }
});

// Create user (admin only)
app.post('/api/users', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const user = await createUser({ username, email, password, role: role || 'user' });
        res.status(201).json(user);
    } catch (error) {
        console.error('Create user error:', error);
        res.status(400).json({ error: error.message || 'Failed to create user' });
    }
});

// Invite user by email (admin only) - creates pending user
app.post('/api/users/invite', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const user = await createPendingUser(email);
        res.status(201).json({
            success: true,
            user,
            message: `Invitation created for ${email}. User can now register with this email.`
        });
    } catch (error) {
        console.error('Invite user error:', error);
        res.status(400).json({ error: error.message || 'Failed to invite user' });
    }
});

// Disable user (admin only)
app.put('/api/users/:id/disable', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;

        // Prevent disabling self
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot disable your own account' });
        }

        const user = await disableUser(id);
        res.json({
            success: true,
            user,
            message: 'User disabled successfully'
        });
    } catch (error) {
        console.error('Disable user error:', error);
        res.status(400).json({ error: error.message || 'Failed to disable user' });
    }
});

// Enable user (admin only)
app.put('/api/users/:id/enable', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;

        const user = await enableUser(id);
        res.json({
            success: true,
            user,
            message: 'User enabled successfully'
        });
    } catch (error) {
        console.error('Enable user error:', error);
        res.status(400).json({ error: error.message || 'Failed to enable user' });
    }
});

// ============================================================================
// MODEL DOWNLOAD ENDPOINTS (Multi-Download Support)
// ============================================================================

// Start a new model download
app.post('/api/models/pull', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }

    const { ggufRepo, ggufFile } = req.body;

    if (!ggufRepo || !ggufFile) {
        return res.status(400).json({ error: 'ggufRepo and ggufFile are required' });
    }

    // Generate unique download ID
    const downloadId = crypto.randomUUID();

    const scriptPath = '/usr/src/app/scripts/download_model.sh';
    const child = spawn('bash', [scriptPath, ggufRepo, ggufFile]);

    // Track download
    const downloadInfo = {
        downloadId,
        ggufRepo,
        ggufFile,
        status: 'downloading',
        progress: 0,
        overallPct: 0,
        overallDownloaded: 0,
        overallTotal: 0,
        speed: 0,
        eta: 0,
        fileIndex: 0,
        fileTotal: 0,
        fileName: null,
        filePct: 0,
        fileDownloaded: 0,
        fileSize: 0,
        startTime: Date.now(),
        childProcess: child,
        modelName: null // Will be extracted from repo name
    };

    // Extract model name from repo (e.g., "TheBloke/Llama-2-7B-GGUF" -> "Llama-2-7B-GGUF")
    const repoMatch = ggufRepo.match(/\/(.+)$/);
    if (repoMatch) {
        downloadInfo.modelName = repoMatch[1];
    }

    activeDownloads.set(downloadId, downloadInfo);

    // Broadcast download started event
    broadcast({
        type: 'download_started',
        downloadId,
        ggufRepo,
        ggufFile,
        modelName: downloadInfo.modelName
    });

    // Parse structured progress from stdout. The download script emits lines
    // of the form `__PROGRESS__{json}` alongside regular log output. We buffer
    // partial lines because `data` events are chunked arbitrarily.
    let stdoutBuffer = '';
    const PROGRESS_PREFIX = '__PROGRESS__';

    const handleProgressPayload = (payload) => {
        if (payload.kind === 'start') {
            downloadInfo.overallTotal = payload.totalBytes || 0;
            downloadInfo.fileTotal = payload.fileTotal || 0;
            broadcast({
                type: 'download_progress',
                downloadId,
                progress: 0,
                overallPct: 0,
                overallDownloaded: 0,
                overallTotal: downloadInfo.overallTotal,
                fileTotal: downloadInfo.fileTotal,
                speed: 0,
                eta: 0,
                status: 'downloading'
            });
        } else if (payload.kind === 'progress') {
            downloadInfo.progress = payload.overallPct ?? payload.filePct ?? 0;
            downloadInfo.overallPct = payload.overallPct ?? 0;
            downloadInfo.overallDownloaded = payload.overallDownloaded ?? 0;
            downloadInfo.overallTotal = payload.overallTotal ?? downloadInfo.overallTotal;
            downloadInfo.fileIndex = payload.fileIndex ?? 0;
            downloadInfo.fileTotal = payload.fileTotal ?? downloadInfo.fileTotal;
            downloadInfo.fileName = payload.fileName ?? downloadInfo.fileName;
            downloadInfo.filePct = payload.filePct ?? 0;
            downloadInfo.fileDownloaded = payload.fileDownloaded ?? 0;
            downloadInfo.fileSize = payload.fileSize ?? 0;
            downloadInfo.speed = payload.speed ?? 0;
            downloadInfo.eta = payload.eta ?? 0;
            broadcast({
                type: 'download_progress',
                downloadId,
                progress: downloadInfo.progress,
                overallPct: downloadInfo.overallPct,
                overallDownloaded: downloadInfo.overallDownloaded,
                overallTotal: downloadInfo.overallTotal,
                fileIndex: downloadInfo.fileIndex,
                fileTotal: downloadInfo.fileTotal,
                fileName: downloadInfo.fileName,
                filePct: downloadInfo.filePct,
                fileDownloaded: downloadInfo.fileDownloaded,
                fileSize: downloadInfo.fileSize,
                speed: downloadInfo.speed,
                eta: downloadInfo.eta
            });
        } else if (payload.kind === 'complete') {
            downloadInfo.progress = 100;
            downloadInfo.overallPct = 100;
            if (payload.totalBytes) {
                downloadInfo.overallDownloaded = payload.totalBytes;
                downloadInfo.overallTotal = payload.totalBytes;
            }
        }
    };

    child.stdout.on('data', (data) => {
        try {
            stdoutBuffer += data.toString();
            let newlineIdx;
            while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
                const line = stdoutBuffer.slice(0, newlineIdx);
                stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith(PROGRESS_PREFIX)) {
                    try {
                        const payload = JSON.parse(trimmed.slice(PROGRESS_PREFIX.length));
                        handleProgressPayload(payload);
                    } catch (parseErr) {
                        console.error(`[Download ${downloadId}] Bad progress payload:`, parseErr.message, trimmed);
                    }
                } else {
                    console.log(`[Download ${downloadId}] ${trimmed}`);
                    broadcast({ type: 'log', message: `[${downloadInfo.modelName}] ${trimmed}` });
                }
            }
        } catch (error) {
            console.error(`[Download ${downloadId}] Error processing stdout:`, error.message);
        }
    });

    child.stderr.on('data', (data) => {
        try {
            const output = data.toString();
            console.error(`[Download ${downloadId}] stderr: ${output}`);
            broadcast({ type: 'log', message: `[${downloadInfo.modelName}] ${output}` });
        } catch (error) {
            console.error(`[Download ${downloadId}] Error processing stderr:`, error.message);
        }
    });

    child.on('close', (code) => {
        console.log(`[Download ${downloadId}] process exited with code ${code}`);

        if (code === 0) {
            downloadInfo.status = 'completed';
            downloadInfo.progress = 100;
            broadcast({
                type: 'download_finished',
                downloadId,
                success: true,
                message: `Download completed: ${downloadInfo.modelName}`
            });
            broadcast({ type: 'status', message: `Download completed: ${downloadInfo.modelName}` });
            // Remove completed downloads immediately
            setTimeout(() => {
                activeDownloads.delete(downloadId);
                broadcast({ type: 'download_removed', downloadId });
            }, 3000); // 3 second delay to allow UI to show completion
        } else if (code === null || code === 143) {
            // Process was killed (SIGTERM)
            downloadInfo.status = 'cancelled';
            broadcast({
                type: 'download_cancelled',
                downloadId,
                message: `Download cancelled: ${downloadInfo.modelName}`
            });
            broadcast({ type: 'status', message: `Download cancelled: ${downloadInfo.modelName}` });
            // Remove cancelled downloads immediately
            setTimeout(() => {
                activeDownloads.delete(downloadId);
                broadcast({ type: 'download_removed', downloadId });
            }, 2000); // 2 second delay
        } else {
            downloadInfo.status = 'failed';
            broadcast({
                type: 'download_finished',
                downloadId,
                success: false,
                message: `Download failed: ${downloadInfo.modelName} (exit code ${code})`
            });
            broadcast({ type: 'status', message: `Download failed: ${downloadInfo.modelName} (exit code ${code})` });
            // Keep failed downloads visible for 30 seconds for user to see error
            setTimeout(() => {
                activeDownloads.delete(downloadId);
                broadcast({ type: 'download_removed', downloadId });
            }, 30000);
        }
    });

    // Handle child process errors (e.g., spawn failures)
    child.on('error', (error) => {
        console.error(`[Download ${downloadId}] process error:`, error.message);
        downloadInfo.status = 'failed';
        broadcast({
            type: 'download_finished',
            downloadId,
            success: false,
            message: `Download process error: ${downloadInfo.modelName} - ${error.message}`
        });
        broadcast({ type: 'status', message: `Download process error: ${downloadInfo.modelName}` });
        // Keep failed downloads visible for 30 seconds
        setTimeout(() => {
            activeDownloads.delete(downloadId);
            broadcast({ type: 'download_removed', downloadId });
        }, 30000);
    });

    res.status(202).json({
        message: 'Download started',
        downloadId,
        ggufRepo,
        ggufFile
    });
});

// Get all active downloads
app.get('/api/downloads', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }

    const downloads = Array.from(activeDownloads.values()).map(d => ({
        downloadId: d.downloadId,
        ggufRepo: d.ggufRepo,
        ggufFile: d.ggufFile,
        modelName: d.modelName,
        status: d.status,
        progress: d.progress,
        overallPct: d.overallPct,
        overallDownloaded: d.overallDownloaded,
        overallTotal: d.overallTotal,
        fileIndex: d.fileIndex,
        fileTotal: d.fileTotal,
        fileName: d.fileName,
        filePct: d.filePct,
        fileDownloaded: d.fileDownloaded,
        fileSize: d.fileSize,
        speed: d.speed,
        eta: d.eta,
        startTime: d.startTime
    }));
    res.json(downloads);
});

// Cancel a download
app.delete('/api/downloads/:downloadId', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { downloadId } = req.params;
    const download = activeDownloads.get(downloadId);

    if (!download) {
        return res.status(404).json({ error: 'Download not found' });
    }

    if (download.status !== 'downloading') {
        return res.status(400).json({ error: 'Download is not active' });
    }

    try {
        // Send SIGTERM to the process
        download.childProcess.kill('SIGTERM');
        download.status = 'cancelling';

        broadcast({
            type: 'log',
            message: `Cancelling download: ${download.modelName}`
        });

        res.json({
            message: 'Download cancellation initiated',
            downloadId
        });
    } catch (error) {
        console.error(`Error cancelling download ${downloadId}:`, error);
        res.status(500).json({ error: 'Failed to cancel download' });
    }
});

// ============================================================================
// MODEL LISTING ENDPOINT
// ============================================================================

app.get('/api/models', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const modelsDir = '/models';
    try {
        // Get running model instances (vLLM or llama.cpp)
        const instances = Array.from(modelInstances.entries()).map(([name, info]) => ({
            name,
            port: info.port,
            config: info.config,
            status: info.status,
            backend: info.backend || 'llamacpp'
        }));

        // Scan filesystem for available GGUF models
        const entries = await fs.readdir(modelsDir, { withFileTypes: true });
        const localModels = entries.filter(dirent =>
            dirent.isDirectory() &&
            !dirent.name.startsWith('.') &&
            !dirent.name.startsWith('models--')
        );

        // Merge data
        const models = await Promise.all(localModels.map(async dirent => {
            const modelName = dirent.name;
            const modelPath = path.join(modelsDir, modelName);
            const instance = instances.find(i => i.name === modelName);

            let files = [];
            try {
                files = await fs.readdir(modelPath, { recursive: true });
            } catch (err) {
                console.error(`Error reading ${modelPath}:`, err);
            }

            const hasGGUF = files.some(f => f.endsWith('.gguf'));

            // Get GGUF file details
            let fileSize = null;
            let quantization = null;
            let contextSize = null;
            const ggufFile = files.find(f => f.endsWith('.gguf') && !f.includes('-mmproj-'));

            if (ggufFile) {
                try {
                    const ggufPath = path.join(modelPath, ggufFile);
                    const stats = await fs.stat(ggufPath);
                    fileSize = stats.size;

                    // Extract quantization from filename (e.g., Q4_K_M, Q8_0, IQ4_XS)
                    const quantMatch = ggufFile.match(/[_.-](Q\d+_[A-Z0-9_]+|IQ\d+_[A-Z]+|F16|F32)[_.-]/i);
                    if (quantMatch) {
                        quantization = quantMatch[1].toUpperCase();
                    }
                } catch (err) {
                    console.error(`Error reading GGUF file stats:`, err);
                }
            }

            // Get context size from instance config, or use a default
            // Models have varying native context sizes, but we show a reasonable default
            if (instance?.config?.contextSize) {
                contextSize = instance.config.contextSize;
            } else {
                // Default context size for non-running models
                // Most modern models support at least 4096, many support 8192+
                contextSize = 4096;
            }

            // Check if it's a thinking/reasoning model
            const isThinkingModel = /think|reason|o1|o3|qwq|deepseek.*r1/i.test(modelName);

            // Determine status based on instance state
            let status = 'Downloaded (Not Loaded)';
            if (instance) {
                if (instance.status === 'starting') {
                    status = 'Starting...';
                } else if (instance.status === 'loading') {
                    status = 'Loading model...';
                } else if (instance.status === 'unhealthy') {
                    status = 'Slow to load (will auto-recover)';
                } else if (instance.status === 'running') {
                    // Show correct backend name based on what's actually running
                    const backendName = instance.backend === 'vllm' ? 'vLLM' : 'llama.cpp';
                    status = `Loaded in ${backendName}`;
                } else {
                    status = `Instance: ${instance.status}`;
                }
            }

            return {
                name: modelName,
                status,
                instanceStatus: instance?.status,
                format: hasGGUF ? 'GGUF' : 'Unknown',
                targetBackend: instance?.backend || 'llamacpp',
                loadedIn: instance ? instance.backend : null,
                port: instance?.port,
                config: instance?.config,
                // Enhanced model metadata
                fileSize,
                quantization,
                contextSize,
                isThinkingModel
            };
        }));

        res.json(models);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.json([]);
        }
        console.error('Error scanning models directory:', error);
        res.status(500).json({ error: 'Failed to scan models directory' });
    }
});

// ============================================================================
// MODEL LOADING ENDPOINT
// ============================================================================

app.post('/api/models/:modelName/load', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    // Backend defaults to llamacpp (works with older GPUs)
    const backend = req.body.backend || 'llamacpp';

    console.log(`Request to load model: ${modelName} with backend: ${backend}`);

    try {
        // Check if instance already exists
        if (modelInstances.has(modelName)) {
            return res.status(400).json({ error: `Instance for ${modelName} already running` });
        }

        const modelPath = path.join('/models', modelName);
        const files = await fs.readdir(modelPath, { recursive: true });

        // Filter for main model GGUF files, excluding auxiliary files
        // Be more specific to avoid filtering out main VLM (Vision Language Model) files
        let ggufFiles = files.filter(f => {
            if (!f.endsWith('.gguf')) return false;

            const lowerName = f.toLowerCase();
            // Exclude multimodal projection files (always auxiliary)
            if (lowerName.includes('mmproj')) return false;

            // Exclude only specifically named encoder/vision files (not VLM model names)
            // Examples: "vision-encoder.gguf", "audio-encoder.gguf", "text-encoder.gguf"
            if (lowerName.match(/(vision|audio|text)-?encoder/)) return false;

            // Exclude files that are explicitly encoder-only files
            // But don't exclude files like "qwen-vl" or "llava" which are main VLM models
            if (lowerName.endsWith('-encoder.gguf')) return false;

            return true;
        });

        if (ggufFiles.length === 0) {
            // Check if there are mmproj files to provide helpful error message
            const mmprojFiles = files.filter(f => f.endsWith('.gguf') && f.toLowerCase().includes('mmproj'));
            if (mmprojFiles.length > 0) {
                return res.status(400).json({
                    error: 'No main model file found. This directory contains only multimodal projection (mmproj) files which cannot be loaded as standalone models. Please download the main model file.'
                });
            }
            return res.status(400).json({ error: 'No GGUF file found' });
        }

        // For split models (e.g., model-00001-of-00003.gguf), always load the first split
        const splitFiles = ggufFiles.filter(f => /-\d{5}-of-\d{5}\.gguf$/.test(f));
        let ggufFile;
        if (splitFiles.length > 0) {
            // Sort split files and pick the first one (00001-of-xxxxx)
            splitFiles.sort();
            ggufFile = splitFiles[0];
            console.log(`Detected split model. Using first split: ${ggufFile}`);
        } else {
            // Use the first regular GGUF file found
            ggufFile = ggufFiles[0];
        }

        // Validate model configuration parameters
        if (req.body.maxModelLen !== undefined) {
            const maxLen = Number(req.body.maxModelLen);
            if (isNaN(maxLen) || maxLen < 256 || maxLen > 1048576) {
                return res.status(400).json({ error: 'maxModelLen must be between 256 and 1048576' });
            }
        }
        if (req.body.gpuMemoryUtilization !== undefined) {
            const gpuUtil = Number(req.body.gpuMemoryUtilization);
            if (isNaN(gpuUtil) || gpuUtil < 0.1 || gpuUtil > 1.0) {
                return res.status(400).json({ error: 'gpuMemoryUtilization must be between 0.1 and 1.0' });
            }
        }

        const fullPath = path.join(modelPath, ggufFile);

        let result;

        if (backend === 'vllm') {
            // Check for known incompatible VLM models
            const lowerModelName = modelName.toLowerCase();
            const knownIncompatibleVLMs = ['qwen3-vl', 'qwen2-vl', 'qwen-vl'];
            const isIncompatibleVLM = knownIncompatibleVLMs.some(pattern => lowerModelName.includes(pattern));

            if (isIncompatibleVLM) {
                broadcast({ type: 'log', message: `⚠️ WARNING: ${modelName} is a Vision Language Model that may have limited GGUF support in vLLM.` });
                broadcast({ type: 'log', message: `   vLLM's GGUF support is still maturing. If the model fails to load, try a HuggingFace format instead.` });
                console.warn(`Attempting to load potentially incompatible VLM model: ${modelName}`);
            }

            const config = {
                maxModelLen: req.body.maxModelLen || 4096,
                cpuOffloadGb: req.body.cpuOffloadGb ?? 0,
                gpuMemoryUtilization: req.body.gpuMemoryUtilization ?? 0.9,
                tensorParallelSize: req.body.tensorParallelSize || 1,
                maxNumSeqs: req.body.maxNumSeqs || 256,
                kvCacheDtype: req.body.kvCacheDtype || 'auto',
                trustRemoteCode: req.body.trustRemoteCode ?? true,
                enforceEager: req.body.enforceEager ?? false,
                contextShift: req.body.contextShift ?? true,
                contextSize: req.body.maxModelLen || 4096,  // Alias for API compatibility
                disableThinking: req.body.disableThinking ?? false,
                compressMemory: req.body.compressMemory ?? false,
                tokenizer: req.body.tokenizer || '',  // HuggingFace tokenizer repo for GGUF models
                chatTemplate: req.body.chatTemplate || ''  // Jinja2 chat template path (GGUF gets ChatML default)
            };

            broadcast({ type: 'log', message: `Creating vLLM instance for ${modelName}...` });
            result = await createVllmInstance(modelName, fullPath, config);
        } else if (backend === 'llamacpp') {
            const config = {
                nGpuLayers: req.body.nGpuLayers ?? -1,
                contextSize: req.body.contextSize || 4096,
                contextShift: req.body.contextShift ?? true,
                flashAttention: req.body.flashAttention ?? false,
                cacheTypeK: req.body.cacheTypeK || 'f16',
                cacheTypeV: req.body.cacheTypeV || 'f16',
                threads: req.body.threads || 0,
                parallelSlots: req.body.parallelSlots || 1,
                batchSize: req.body.batchSize || 2048,
                ubatchSize: req.body.ubatchSize || 512,
                repeatPenalty: req.body.repeatPenalty ?? 1.1,
                repeatLastN: req.body.repeatLastN || 64,
                presencePenalty: req.body.presencePenalty ?? 0.0,
                frequencyPenalty: req.body.frequencyPenalty ?? 0.0,
                disableThinking: req.body.disableThinking ?? false,
                compressMemory: req.body.compressMemory ?? false
            };

            broadcast({ type: 'log', message: `Creating llama.cpp instance for ${modelName}...` });
            result = await createLlamacppInstance(modelName, fullPath, config);
        } else {
            return res.status(400).json({ error: `Unknown backend: ${backend}. Supported: llamacpp, vllm` });
        }

        broadcast({ type: 'status', message: `Instance created on port ${result.port}` });
        res.json({ message: 'Instance created', backend, ...result });
    } catch (error) {
        console.error(`Error loading model ${modelName}:`, error.message);
        broadcast({ type: 'log', message: `Error: ${error.message}` });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// VLLM INSTANCE MANAGEMENT
// ============================================================================

async function createVllmInstance(modelName, modelPath, config) {
    const port = allocatePort();
    const containerName = `vllm-${modelName}`;
    // Internal port for Docker network communication (same as external for simplicity)
    const internalPort = port;

    try {
        // Check if base image exists
        const images = await docker.listImages({ filters: { reference: ['modelserver-vllm:latest'] } });
        if (images.length === 0) {
            throw new Error('modelserver-vllm:latest image not found. Please run ./build.sh to build the base image.');
        }

        // Build environment variables
        const envVars = [
            `VLLM_MODEL_PATH=${modelPath}`,
            `VLLM_PORT=${port}`,
            `VLLM_MAX_MODEL_LEN=${config.maxModelLen}`,
            `VLLM_CPU_OFFLOAD_GB=${config.cpuOffloadGb}`,
            `VLLM_GPU_MEMORY_UTILIZATION=${config.gpuMemoryUtilization}`,
            `VLLM_TENSOR_PARALLEL_SIZE=${config.tensorParallelSize}`,
            `VLLM_MAX_NUM_SEQS=${config.maxNumSeqs}`,
            `VLLM_KV_CACHE_DTYPE=${config.kvCacheDtype}`,
            `VLLM_TRUST_REMOTE_CODE=${config.trustRemoteCode}`,
            `VLLM_ENFORCE_EAGER=${config.enforceEager}`,
            `VLLM_CTX_SHIFT=${config.contextShift}`
        ];

        // Add tokenizer if specified (helps with GGUF models)
        if (config.tokenizer) {
            envVars.push(`VLLM_TOKENIZER=${config.tokenizer}`);
        }

        // Add chat template if specified (entrypoint auto-generates ChatML default for GGUF)
        if (config.chatTemplate) {
            envVars.push(`VLLM_CHAT_TEMPLATE=${config.chatTemplate}`);
        }

        const container = await docker.createContainer({
            Image: 'modelserver-vllm:latest',
            name: containerName,
            Env: envVars,
            HostConfig: {
                Runtime: 'nvidia',
                Binds: [getModelsVolumeBind()],
                PortBindings: {
                    // Bind to localhost only - containers communicate via Docker network, not exposed externally
                    [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${port}` }]
                },
                DeviceRequests: [{
                    Driver: 'nvidia',
                    Count: -1,
                    Capabilities: [['gpu']]
                }],
                // Connect to the same network as webapp for internal communication
                NetworkMode: 'modelserver_default',
                // vLLM needs more shared memory for model loading
                ShmSize: 8 * 1024 * 1024 * 1024 // 8GB shared memory
            }
        });

        await container.start();

        modelInstances.set(modelName, {
            containerId: container.id,
            containerName,
            port,
            internalPort,
            status: 'starting',
            config,
            backend: 'vllm'
        });
        startSystemMonitoring();

        // Broadcast structured status update for frontend
        broadcast({
            type: 'status',
            modelName,
            status: 'starting',
            port
        });

        console.log(`Created vLLM instance for ${modelName} on port ${port} (container: ${containerName})`);

        // Start streaming container logs
        streamContainerLogs(container, modelName);

        // Monitor container health and status
        monitorContainerHealth(container, modelName, port);

        return { containerId: container.id, port, containerName };
    } catch (error) {
        console.error(`Error creating container:`, error);
        throw error;
    }
}

// ============================================================================
// LLAMA.CPP INSTANCE MANAGEMENT
// ============================================================================

async function createLlamacppInstance(modelName, modelPath, config) {
    const port = allocatePort();
    const containerName = `llamacpp-${modelName}`;
    const internalPort = port;

    try {
        // Check if base image exists
        const images = await docker.listImages({ filters: { reference: ['modelserver-llamacpp:latest'] } });
        if (images.length === 0) {
            throw new Error('modelserver-llamacpp:latest image not found. Please run ./build.sh to build the base image.');
        }

        const envVars = [
            `LLAMA_MODEL_PATH=${modelPath}`,
            `LLAMA_PORT=${port}`,
            `LLAMA_N_GPU_LAYERS=${config.nGpuLayers}`,
            `LLAMA_CTX_SIZE=${config.contextSize}`,
            `LLAMA_CTX_SHIFT=${config.contextShift}`,
            `LLAMA_FLASH_ATTN=${config.flashAttention}`,
            `LLAMA_CACHE_TYPE_K=${config.cacheTypeK}`,
            `LLAMA_CACHE_TYPE_V=${config.cacheTypeV}`,
            `LLAMA_PARALLEL=${config.parallelSlots}`,
            `LLAMA_BATCH_SIZE=${config.batchSize}`,
            `LLAMA_UBATCH_SIZE=${config.ubatchSize}`,
            `LLAMA_REPEAT_PENALTY=${config.repeatPenalty}`,
            `LLAMA_REPEAT_LAST_N=${config.repeatLastN}`,
            `LLAMA_PRESENCE_PENALTY=${config.presencePenalty}`,
            `LLAMA_FREQUENCY_PENALTY=${config.frequencyPenalty}`
        ];

        // Only add threads if explicitly set (non-zero)
        if (config.threads && config.threads > 0) {
            envVars.push(`LLAMA_THREADS=${config.threads}`);
        }

        const container = await docker.createContainer({
            Image: 'modelserver-llamacpp:latest',
            name: containerName,
            Env: envVars,
            HostConfig: {
                Runtime: 'nvidia',
                Binds: [getModelsVolumeBind()],
                PortBindings: {
                    // Bind to localhost only - containers communicate via Docker network, not exposed externally
                    [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${port}` }]
                },
                DeviceRequests: [{
                    Driver: 'nvidia',
                    Count: -1,
                    Capabilities: [['gpu']]
                }],
                NetworkMode: 'modelserver_default',
                // llama.cpp needs less shared memory than vLLM
                ShmSize: 2 * 1024 * 1024 * 1024 // 2GB shared memory
            }
        });

        await container.start();

        modelInstances.set(modelName, {
            containerId: container.id,
            containerName,
            port,
            internalPort,
            status: 'starting',
            config,
            backend: 'llamacpp'
        });
        startSystemMonitoring();

        // Broadcast structured status update for frontend
        broadcast({
            type: 'status',
            modelName,
            status: 'starting',
            port
        });

        console.log(`Created llama.cpp instance for ${modelName} on port ${port} (container: ${containerName})`);

        // Start streaming container logs
        streamContainerLogs(container, modelName);

        // Monitor container health and status
        monitorContainerHealth(container, modelName, port);

        return { containerId: container.id, port, containerName };
    } catch (error) {
        console.error(`Error creating llama.cpp container:`, error);
        throw error;
    }
}

// Stream container logs to WebSocket clients
async function streamContainerLogs(container, modelName) {
    try {
        const logStream = await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            timestamps: true
        });

        logStream.on('data', (chunk) => {
            try {
                // Docker multiplexes stdout/stderr with 8-byte header
                // Strip the header and decode the message
                const lines = chunk.toString('utf8').split('\n').filter(line => line.trim());
                for (const line of lines) {
                    // Clean up the line (remove non-printable chars from Docker multiplex header)
                    let cleanLine = line.replace(/[\x00-\x08]/g, '').trim();
                    if (cleanLine) {
                        // Strip Docker timestamps (e.g., "2026-03-20T21:30:01.179299893Z ")
                        // These appear at the start, sometimes preceded by a stray char from the header
                        cleanLine = cleanLine.replace(/^.?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/, '');
                        if (!cleanLine) continue; // Skip empty lines after timestamp removal

                        // Detect error patterns
                        const isError = /error|failed|fatal|exception|cannot|unable|oom|out of memory|killed/i.test(cleanLine);
                        // Detect success patterns
                        const isSuccess = /ready|started|listening|loaded|complete|running/i.test(cleanLine) && !isError;
                        broadcast({
                            type: 'log',
                            message: `[${modelName}] ${cleanLine}`,
                            level: isError ? 'error' : isSuccess ? 'success' : 'info'
                        });
                    }
                }
            } catch (error) {
                console.error(`Error processing log stream data for ${modelName}:`, error.message);
            }
        });

        logStream.on('error', (err) => {
            console.error(`Log stream error for ${modelName}:`, err.message);
        });

        logStream.on('end', () => {
            console.log(`Log stream ended for ${modelName}`);
        });
    } catch (error) {
        console.error(`Failed to stream logs for ${modelName}:`, error.message);
    }
}

// Monitor container health and detect failures
// Uses progressive timeout: fast checks initially, then slower checks for large models
// vLLM takes longer to load than llama.cpp, so we use extended timeouts
async function monitorContainerHealth(container, modelName, port) {
    // Phase 1: Quick checks for fast-loading models (first 120 seconds, every 2 seconds)
    // Phase 2: Extended loading phase for large models (next 10 minutes, every 5 seconds)
    // Phase 3: Continuous monitoring to recover from unhealthy state (every 30 seconds)
    const PHASE1_DURATION = 120;   // 120 seconds of quick checks (vLLM takes longer)
    const PHASE1_INTERVAL = 2000;  // 2 seconds
    const PHASE2_DURATION = 600;   // 10 more minutes (600 seconds) for vLLM model loading
    const PHASE2_INTERVAL = 5000;  // 5 seconds
    const PHASE3_INTERVAL = 30000; // 30 seconds for ongoing monitoring

    let totalSeconds = 0;
    let modelLoadingDetected = false;
    let lastProgressUpdate = 0;

    const healthCheck = async () => {
        const instance = modelInstances.get(modelName);

        if (!instance) {
            // Instance was removed (user stopped it)
            return;
        }

        try {
            // Check if container is still running
            const containerInfo = await container.inspect();

            if (!containerInfo.State.Running) {
                // Container exited
                const exitCode = containerInfo.State.ExitCode;
                const error = containerInfo.State.Error || 'Container exited unexpectedly';

                broadcast({
                    type: 'log',
                    message: `[${modelName}] Container exited with code ${exitCode}: ${error}`,
                    level: 'error'
                });
                broadcast({
                    type: 'status',
                    message: `Instance ${modelName} failed to start (exit code ${exitCode})`,
                    level: 'error'
                });

                // Clean up the instance
                modelInstances.delete(modelName);
                if (modelInstances.size === 0) stopSystemMonitoring();
                try {
                    await container.remove();
                } catch (e) {
                    // Ignore removal errors
                }
                return;
            }

            // Container is running, check if vLLM server is responding
            // Use /v1/models endpoint for vLLM readiness check
            const targetHost = instance.containerName || `host.docker.internal`;
            const targetPort = instance.internalPort || port;
            try {
                const response = await axios.get(`http://${targetHost}:${targetPort}/v1/models`, { timeout: 5000 });
                if (response.status === 200) {
                    const wasUnhealthy = instance.status === 'unhealthy';
                    const wasLoading = instance.status === 'loading';

                    // Server is healthy!
                    instance.status = 'running';
                    modelInstances.set(modelName, instance);

                    // Broadcast structured status update for frontend
                    broadcast({
                        type: 'status',
                        modelName,
                        status: 'running',
                        port
                    });

                    // Only broadcast success message if transitioning from loading/unhealthy state
                    if (wasUnhealthy || wasLoading || instance.status === 'starting') {
                        if (wasUnhealthy) {
                            broadcast({
                                type: 'log',
                                message: `[${modelName}] Server recovered and is now healthy`,
                                level: 'success'
                            });
                        } else {
                            broadcast({
                                type: 'log',
                                message: `[${modelName}] Server is ready and healthy`,
                                level: 'success'
                            });
                        }
                    }

                    // Continue monitoring in phase 3 to detect future issues
                    setTimeout(healthCheck, PHASE3_INTERVAL);
                    return;
                }
            } catch (healthError) {
                // Server not ready yet, continue waiting
            }

            // Determine current phase and schedule next check
            totalSeconds++;

            // Don't continue health checks if instance was removed or is already running
            if (!instance || instance.status === 'running') {
                return;
            }

            if (totalSeconds <= PHASE1_DURATION) {
                // Phase 1: Quick checks
                setTimeout(healthCheck, PHASE1_INTERVAL);
            } else if (totalSeconds <= PHASE1_DURATION + PHASE2_DURATION) {
                // Phase 2: Extended loading
                // Update status to 'loading' to indicate model is still being loaded
                if (instance.status === 'starting') {
                    instance.status = 'loading';
                    modelInstances.set(modelName, instance);

                    // Broadcast structured status update for frontend
                    broadcast({
                        type: 'status',
                        modelName,
                        status: 'loading',
                        port
                    });

                    broadcast({
                        type: 'log',
                        message: `[${modelName}] Large model detected - extended loading in progress...`,
                        level: 'info'
                    });
                }

                // Show progress update every 30 seconds (only if still loading)
                if (instance.status === 'loading' && totalSeconds - lastProgressUpdate >= 30) {
                    lastProgressUpdate = totalSeconds;
                    const elapsed = Math.floor(totalSeconds);
                    const remaining = PHASE1_DURATION + PHASE2_DURATION - totalSeconds;
                    broadcast({
                        type: 'log',
                        message: `[${modelName}] Still loading... (${elapsed}s elapsed, ${Math.floor(remaining)}s remaining before timeout)`,
                        level: 'info'
                    });
                }

                setTimeout(healthCheck, PHASE2_INTERVAL);
            } else {
                // Phase 2 complete - mark as unhealthy but continue monitoring
                if (instance.status !== 'unhealthy') {
                    instance.status = 'unhealthy';
                    modelInstances.set(modelName, instance);

                    // Broadcast structured status update for frontend
                    broadcast({
                        type: 'status',
                        modelName,
                        status: 'unhealthy',
                        port,
                        error: 'Loading timeout - check logs'
                    });

                    broadcast({
                        type: 'log',
                        message: `[${modelName}] Initial loading timeout (${PHASE1_DURATION + PHASE2_DURATION}s) - marked as unhealthy but monitoring continues`,
                        level: 'warning'
                    });
                }

                // Phase 3: Continue monitoring indefinitely to allow recovery
                setTimeout(healthCheck, PHASE3_INTERVAL);
            }
        } catch (error) {
            console.error(`Health check error for ${modelName}:`, error.message);
            // Continue monitoring even on errors
            const interval = totalSeconds <= PHASE1_DURATION ? PHASE1_INTERVAL :
                            totalSeconds <= PHASE1_DURATION + PHASE2_DURATION ? PHASE2_INTERVAL :
                            PHASE3_INTERVAL;
            setTimeout(healthCheck, interval);
        }
    };

    // Start health checking after a brief delay
    setTimeout(healthCheck, 500);
}

// ====== Periodic System & Model Monitoring ======
let monitoringInterval = null;

// Delta-based CPU sampling. os.cpus() returns cumulative tick counts since
// boot, so a single snapshot is meaningless — we compute the delta between
// consecutive polls to derive a real CPU% over the monitoring interval.
let lastCpuTicks = null;
function sampleCpuPercent() {
    try {
        const cpus = os.cpus();
        const current = cpus.reduce((acc, cpu) => {
            acc.idle += cpu.times.idle;
            acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys +
                         cpu.times.idle + cpu.times.irq;
            return acc;
        }, { idle: 0, total: 0 });

        if (!lastCpuTicks) {
            lastCpuTicks = current;
            return null; // First sample — no delta yet
        }

        const idleDelta = current.idle - lastCpuTicks.idle;
        const totalDelta = current.total - lastCpuTicks.total;
        lastCpuTicks = current;

        if (totalDelta <= 0) return null;
        const busyDelta = totalDelta - idleDelta;
        return Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100));
    } catch {
        return null;
    }
}

let gpuErrorLogged = false; // Only log nvidia-smi errors once to avoid log spam

async function broadcastSystemMonitoring() {
    try {
        // ---- GPUs ----
        const gpus = [];
        let gpuError = null;
        try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits');
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const parts = line.split(',').map(s => s.trim());
                const [index, name, gpuUtil, memUtil, memUsed, memTotal, temp, power] = parts;
                const memUsedMb = parseInt(memUsed, 10);
                const memTotalMb = parseInt(memTotal, 10);
                gpus.push({
                    index: parseInt(index, 10),
                    name,
                    utilizationPct: parseInt(gpuUtil, 10) || 0,
                    vramUsedMb: Number.isFinite(memUsedMb) ? memUsedMb : 0,
                    vramTotalMb: Number.isFinite(memTotalMb) ? memTotalMb : 0,
                    vramUsedPct: memTotalMb > 0 ? Math.round((memUsedMb / memTotalMb) * 100) : 0,
                    temperatureC: parseInt(temp, 10) || 0,
                    powerW: parseFloat(power) || 0
                });
            }
            // Reset the flag if nvidia-smi starts working again
            if (gpus.length > 0) gpuErrorLogged = false;
        } catch (err) {
            // Determine the specific reason nvidia-smi failed
            const errMsg = err.message || String(err);
            if (errMsg.includes('not found') || errMsg.includes('ENOENT') || errMsg.includes('No such file')) {
                gpuError = 'nvidia-smi not found — NVIDIA drivers may not be installed in the container';
            } else if (errMsg.includes('NVML') || errMsg.includes('driver')) {
                gpuError = 'NVIDIA driver communication failed — GPU passthrough may not be configured';
            } else {
                gpuError = `nvidia-smi error: ${errMsg.substring(0, 120)}`;
            }

            // Log once to avoid flooding at 3s interval
            if (!gpuErrorLogged) {
                gpuErrorLogged = true;
                console.warn(`[Monitoring] GPU detection failed: ${gpuError}`);
                broadcast({
                    type: 'log',
                    message: `[Warning] GPU monitoring unavailable: ${gpuError}`,
                    level: 'warning'
                });
            }
        }

        // ---- Memory ----
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

        // ---- CPU ----
        const cpuPct = sampleCpuPercent();
        const cpus = os.cpus();

        // ---- Models ----
        const models = Array.from(modelInstances.entries()).map(([name, info]) => ({
            name,
            status: info.status,
            backend: info.backend || 'unknown',
            contextSize: info.config?.contextSize || info.config?.maxModelLen || null,
            port: info.port
        }));

        broadcast({
            type: 'system_stats',
            timestamp: Date.now(),
            cpu: {
                percent: cpuPct,
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown'
            },
            memory: {
                totalBytes: totalMem,
                usedBytes: usedMem,
                freeBytes: freeMem,
                percent: memPct
            },
            gpus,
            gpuError: gpuError || null,
            models
        });
    } catch (error) {
        console.error('System monitoring error:', error.message);
    }
}

// Poll every 3s so the UI sparklines animate smoothly. nvidia-smi takes
// ~20-50ms per call on a warm system; at this cadence it's negligible.
const MONITORING_INTERVAL_MS = 3000;

function startSystemMonitoring() {
    if (monitoringInterval) return; // Already running
    // Fire once immediately to prime the CPU tick delta and give clients
    // an initial snapshot, then settle into the regular interval.
    broadcastSystemMonitoring().catch(() => {});
    monitoringInterval = setInterval(broadcastSystemMonitoring, MONITORING_INTERVAL_MS);
    console.log(`[Monitoring] System monitoring started (${MONITORING_INTERVAL_MS}ms interval)`);
}

function stopSystemMonitoring() {
    // Intentional no-op. The UI resource panel keeps streaming CPU/GPU/RAM
    // samples for as long as the server is running, independent of whether
    // any model is loaded. Call sites that trigger this on "last model
    // removed" are left in place so that if we ever want tight lifecycle
    // coupling again we only have to change it here.
}

// List all running vLLM instances
app.get('/api/vllm/instances', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const instances = Array.from(modelInstances.entries())
        .filter(([name, info]) => info.backend === 'vllm')
        .map(([name, info]) => ({
            name,
            ...info
        }));
    res.json(instances);
});

// Stop and remove instance
app.delete('/api/vllm/instances/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const { modelName } = req.params;
    const instance = modelInstances.get(modelName);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    try {
        const container = docker.getContainer(instance.containerId);

        // Check container state first
        let containerInfo;
        try {
            containerInfo = await container.inspect();
        } catch (inspectErr) {
            // Container doesn't exist, just clean up our state
            console.log(`Container for ${modelName} not found, cleaning up state`);
            modelInstances.delete(modelName);
            if (modelInstances.size === 0) stopSystemMonitoring();
            broadcast({ type: 'status', message: `Instance ${modelName} cleaned up` });
            return res.json({ message: 'Instance cleaned up' });
        }

        // Stop the container if it's running
        if (containerInfo.State.Running) {
            broadcast({ type: 'log', message: `[${modelName}] Stopping container...` });
            try {
                // Use kill for faster, more forceful stop
                await container.kill();
            } catch (killErr) {
                // If kill fails, try graceful stop with short timeout
                try {
                    await container.stop({ t: 5 });
                } catch (stopErr) {
                    console.log(`Stop also failed for ${modelName}, container may already be stopped`);
                }
            }
        }

        // Wait briefly for the container to fully stop
        await new Promise(resolve => setTimeout(resolve, 500));

        // Remove the container with force flag
        try {
            await container.remove({ force: true, v: true });
            broadcast({ type: 'log', message: `[${modelName}] Container removed` });
        } catch (removeErr) {
            console.error(`Error removing container for ${modelName}:`, removeErr.message);
            // Continue anyway - the container might already be removed
        }

        // Clean up our state
        modelInstances.delete(modelName);
        if (modelInstances.size === 0) stopSystemMonitoring();

        // Broadcast structured status update for frontend
        broadcast({
            type: 'status',
            modelName,
            status: 'stopped'
        });

        res.json({ message: 'Instance stopped' });
    } catch (error) {
        console.error(`Error stopping instance:`, error);
        // Even on error, try to clean up our state to prevent stale entries
        modelInstances.delete(modelName);
        if (modelInstances.size === 0) stopSystemMonitoring();
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// LLAMA.CPP INSTANCES ENDPOINTS
// ============================================================================

// List all running llama.cpp instances
app.get('/api/llamacpp/instances', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const instances = Array.from(modelInstances.entries())
        .filter(([name, info]) => info.backend === 'llamacpp')
        .map(([name, info]) => ({
            name,
            ...info
        }));
    res.json(instances);
});

// Stop and remove llama.cpp instance
app.delete('/api/llamacpp/instances/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const { modelName } = req.params;
    const instance = modelInstances.get(modelName);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    // Ensure it's a llama.cpp instance
    if (instance.backend !== 'llamacpp') {
        return res.status(400).json({ error: 'Not a llama.cpp instance' });
    }

    try {
        const container = docker.getContainer(instance.containerId);

        // Check container state first
        let containerInfo;
        try {
            containerInfo = await container.inspect();
        } catch (inspectErr) {
            // Container doesn't exist, just clean up our state
            console.log(`Container for ${modelName} not found, cleaning up state`);
            modelInstances.delete(modelName);
            if (modelInstances.size === 0) stopSystemMonitoring();
            broadcast({ type: 'status', message: `Instance ${modelName} cleaned up` });
            return res.json({ message: 'Instance cleaned up' });
        }

        // Stop the container if it's running
        if (containerInfo.State.Running) {
            broadcast({ type: 'log', message: `[${modelName}] Stopping container...` });
            try {
                await container.kill();
            } catch (killErr) {
                try {
                    await container.stop({ t: 5 });
                } catch (stopErr) {
                    console.log(`Stop also failed for ${modelName}, container may already be stopped`);
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            await container.remove({ force: true, v: true });
            broadcast({ type: 'log', message: `[${modelName}] Container removed` });
        } catch (removeErr) {
            console.error(`Error removing container for ${modelName}:`, removeErr.message);
        }

        modelInstances.delete(modelName);
        if (modelInstances.size === 0) stopSystemMonitoring();

        // Broadcast structured status update for frontend
        broadcast({
            type: 'status',
            modelName,
            status: 'stopped'
        });

        res.json({ message: 'Instance stopped' });
    } catch (error) {
        console.error(`Error stopping instance:`, error);
        modelInstances.delete(modelName);
        if (modelInstances.size === 0) stopSystemMonitoring();
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// KV CACHE MANAGEMENT ENDPOINTS
// ============================================================================

// Get sequence status for an instance (vLLM equivalent of slots)
app.get('/api/vllm/instances/:modelName/slots', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const { modelName } = req.params;
    const instance = modelInstances.get(modelName);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    try {
        // vLLM doesn't have a /slots endpoint like llama.cpp
        // Return sequence capacity based on config
        const maxNumSeqs = instance.config?.maxNumSeqs || 256;
        res.json({
            max_sequences: maxNumSeqs,
            note: 'vLLM manages sequences dynamically. max_sequences is the configured limit.'
        });
    } catch (error) {
        console.error(`Error getting sequence info for ${modelName}:`, error.message);
        res.status(500).json({ error: `Failed to get sequence info: ${error.message}` });
    }
});

// Reset server state for an instance (vLLM doesn't have explicit slot clearing)
app.post('/api/vllm/instances/:modelName/slots/clear', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const { modelName } = req.params;
    const instance = modelInstances.get(modelName);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    try {
        // Use container name for Docker network communication
        const targetHost = instance.containerName || `host.docker.internal`;
        const targetPort = instance.internalPort || instance.port;

        // vLLM manages sequences internally, we just verify the server is responsive
        broadcast({
            type: 'log',
            message: `[${modelName}] Verifying vLLM server state...`,
            level: 'info'
        });

        // Verify server is responsive via /v1/models endpoint
        await axios.get(`http://${targetHost}:${targetPort}/v1/models`, { timeout: 5000 });

        broadcast({
            type: 'log',
            message: `[${modelName}] vLLM server is responsive`,
            level: 'success'
        });

        res.json({ message: 'Server state verified', note: 'vLLM manages sequences dynamically' });
    } catch (error) {
        console.error(`Error verifying server state for ${modelName}:`, error.message);
        res.status(500).json({ error: `Failed to verify server state: ${error.message}` });
    }
});

// ============================================================================
// HUGGINGFACE SEARCH ENDPOINTS
// ============================================================================

app.get('/api/huggingface/search', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }

    const { query, sortBy = 'downloads', minSize, maxSize } = req.query;

    // Helper to extract parameter size in billions from model name
    const extractParamSize = (name) => {
        // Match patterns like 7B, 7.5B, 70B, 0.5B, etc.
        const match = name.match(/(\d+\.?\d*)\s*[Bb]/);
        if (match) {
            return parseFloat(match[1]);
        }
        // Also check for M (millions) - convert to B
        const millionMatch = name.match(/(\d+\.?\d*)\s*[Mm]/);
        if (millionMatch) {
            return parseFloat(millionMatch[1]) / 1000;
        }
        return null;
    };

    // Helper to estimate context length from model name/tags
    const estimateContextLength = (name, tags) => {
        const nameLower = name.toLowerCase();
        const allText = nameLower + ' ' + (tags || []).join(' ').toLowerCase();

        // Check for explicit context length patterns in name
        // e.g., "128k", "32k-context", "64k-ctx"
        const ctxMatch = allText.match(/(\d+)k[-_]?(?:ctx|context|tokens?)?/);
        if (ctxMatch) {
            return parseInt(ctxMatch[1]) * 1024;
        }

        // Check for model family patterns with known context sizes
        if (/llama[-_]?3\.?[12]|llama3\.?[12]/i.test(nameLower)) return 131072; // Llama 3.1/3.2: 128k
        if (/llama[-_]?3|llama3/i.test(nameLower)) return 8192; // Llama 3: 8k
        if (/llama[-_]?2|llama2/i.test(nameLower)) return 4096; // Llama 2: 4k
        if (/mistral.*nemo/i.test(nameLower)) return 131072; // Mistral Nemo: 128k
        if (/mistral.*large/i.test(nameLower)) return 131072; // Mistral Large: 128k
        if (/mistral/i.test(nameLower)) return 32768; // Mistral 7B: 32k
        if (/mixtral/i.test(nameLower)) return 32768; // Mixtral: 32k
        if (/qwen2\.5|qwen-2\.5/i.test(nameLower)) return 131072; // Qwen 2.5: 128k
        if (/qwen2|qwen-2/i.test(nameLower)) return 32768; // Qwen 2: 32k
        if (/qwen/i.test(nameLower)) return 8192; // Qwen: 8k
        if (/gemma[-_]?2/i.test(nameLower)) return 8192; // Gemma 2: 8k
        if (/phi[-_]?3|phi3/i.test(nameLower)) return 131072; // Phi-3: 128k
        if (/deepseek.*v3/i.test(nameLower)) return 65536; // DeepSeek V3: 64k
        if (/deepseek/i.test(nameLower)) return 32768; // DeepSeek: 32k
        if (/command[-_]?r/i.test(nameLower)) return 131072; // Command R: 128k
        if (/yi[-_]?1\.5/i.test(nameLower)) return 32768; // Yi 1.5: 32k

        // Default: unknown context length
        return null;
    };

    try {
        // Determine HuggingFace API sort parameter
        let hfSort = 'downloads';
        let hfDirection = -1;  // -1 = descending, 1 = ascending
        if (sortBy === 'likes' || sortBy === 'likes_asc') {
            hfSort = 'likes';
            if (sortBy === 'likes_asc') hfDirection = 1;
        } else if (sortBy === 'downloads_asc') {
            hfSort = 'downloads';
            hfDirection = 1;
        } else if (sortBy === 'trending') {
            hfSort = 'trending';
        } else if (sortBy === 'newest') {
            hfSort = 'createdAt';
            hfDirection = -1;
        } else if (sortBy === 'oldest') {
            hfSort = 'createdAt';
            hfDirection = 1;
        }

        const response = await axios.get('https://huggingface.co/api/models', {
            params: {
                search: query || '',
                filter: 'gguf',
                sort: hfSort,
                direction: hfDirection,
                limit: 100  // Get more results for filtering
            }
        });

        let models = response.data.map(model => {
            const paramSize = extractParamSize(model.id);
            const contextLength = estimateContextLength(model.id, model.tags);
            return {
                id: model.id,
                downloads: model.downloads,
                likes: model.likes,
                tags: model.tags,
                paramSize: paramSize,  // Size in billions (null if unknown)
                contextLength: contextLength,  // Estimated context length (null if unknown)
                contextEstimated: contextLength !== null,  // Whether context was estimated
                createdAt: model.createdAt
            };
        });

        // Filter by parameter size if specified
        const minSizeNum = minSize ? parseFloat(minSize) : null;
        const maxSizeNum = maxSize ? parseFloat(maxSize) : null;

        if (minSizeNum !== null || maxSizeNum !== null) {
            models = models.filter(model => {
                if (model.paramSize === null) return false;  // Exclude if size unknown when filtering
                if (minSizeNum !== null && model.paramSize < minSizeNum) return false;
                if (maxSizeNum !== null && model.paramSize > maxSizeNum) return false;
                return true;
            });
        }

        // Sort by parameter size if requested
        if (sortBy === 'params' || sortBy === 'size') {
            // Largest first
            models.sort((a, b) => {
                if (a.paramSize === null && b.paramSize === null) return 0;
                if (a.paramSize === null) return 1;
                if (b.paramSize === null) return -1;
                return b.paramSize - a.paramSize;
            });
        } else if (sortBy === 'params_asc' || sortBy === 'size_asc') {
            // Smallest first
            models.sort((a, b) => {
                if (a.paramSize === null && b.paramSize === null) return 0;
                if (a.paramSize === null) return 1;
                if (b.paramSize === null) return -1;
                return a.paramSize - b.paramSize;
            });
        }

        res.json(models);
    } catch (error) {
        console.error('HuggingFace search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get GGUF files for specific repo
app.get('/api/huggingface/files/:owner/:repo', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }

    const { owner, repo } = req.params;
    const repoId = `${owner}/${repo}`;

    try {
        const response = await axios.get(`https://huggingface.co/api/models/${repoId}`);
        const ggufFiles = response.data.siblings.filter(f => f.rfilename.endsWith('.gguf'));
        res.json(ggufFiles);
    } catch (error) {
        console.error('HuggingFace files error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// SYSTEM PROMPTS ENDPOINTS
// ============================================================================

// Get all system prompts
app.get('/api/system-prompts', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    try {
        const prompts = await loadSystemPrompts();
        // Return user's prompts only, or all if no userId (backward compat)
        const userPrompts = req.userId ? (prompts[req.userId] || {}) : prompts;
        res.json(userPrompts);
    } catch (error) {
        console.error('Error getting system prompts:', error);
        res.status(500).json({ error: 'Failed to load system prompts' });
    }
});

// Get system prompt for a specific model
app.get('/api/system-prompts/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    try {
        const prompts = await loadSystemPrompts();
        const userPrompts = req.userId ? (prompts[req.userId] || {}) : prompts;
        res.json({
            modelName,
            systemPrompt: userPrompts[modelName] || '',
            exists: !!userPrompts[modelName]
        });
    } catch (error) {
        console.error('Error getting system prompt:', error);
        res.status(500).json({ error: 'Failed to load system prompt' });
    }
});

// Save system prompt for a model
app.put('/api/system-prompts/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    const { systemPrompt } = req.body;

    if (typeof systemPrompt !== 'string') {
        return res.status(400).json({ error: 'systemPrompt must be a string' });
    }

    try {
        const prompts = await loadSystemPrompts();

        if (req.userId) {
            // User-scoped: store in user's namespace
            if (!prompts[req.userId]) {
                prompts[req.userId] = {};
            }
            if (systemPrompt.trim() === '') {
                delete prompts[req.userId][modelName];
            } else {
                prompts[req.userId][modelName] = systemPrompt;
            }
        } else {
            // No userId: backward compatibility (old flat structure)
            if (systemPrompt.trim() === '') {
                delete prompts[modelName];
            } else {
                prompts[modelName] = systemPrompt;
            }
        }

        await saveSystemPrompts(prompts);
        broadcast({ type: 'log', message: `System prompt saved for ${modelName}` }, req.userId);
        res.json({ message: 'System prompt saved', modelName });
    } catch (error) {
        console.error('Error saving system prompt:', error);
        res.status(500).json({ error: 'Failed to save system prompt' });
    }
});

// Delete system prompt for a model
app.delete('/api/system-prompts/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    try {
        const prompts = await loadSystemPrompts();

        if (req.userId) {
            // User-scoped deletion
            if (prompts[req.userId]) {
                delete prompts[req.userId][modelName];
            }
        } else {
            // No userId: backward compatibility
            delete prompts[modelName];
        }

        await saveSystemPrompts(prompts);
        broadcast({ type: 'log', message: `System prompt deleted for ${modelName}` }, req.userId);
        res.json({ message: 'System prompt deleted', modelName });
    } catch (error) {
        console.error('Error deleting system prompt:', error);
        res.status(500).json({ error: 'Failed to delete system prompt' });
    }
});

// ============================================================================
// SYSTEM RESOURCES ENDPOINT
// ============================================================================

// Get system resource information
app.get('/api/system/resources', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    try {
        // Get memory info
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;

        // Get CPU info
        const cpus = os.cpus();
        const cpuCount = cpus.length;
        const cpuModel = cpus[0]?.model || 'Unknown';

        // Try to get GPU info using nvidia-smi (supports multiple GPUs)
        let gpuInfo = null;
        let gpus = [];
        try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits');
            const lines = stdout.trim().split('\n');
            let totalGpuMemory = 0;
            let totalGpuFree = 0;
            for (const line of lines) {
                const [index, name, totalMem, freeMem] = line.split(',').map(s => s.trim());
                const memTotal = parseInt(totalMem) * 1024 * 1024;
                const memFree = parseInt(freeMem) * 1024 * 1024;
                gpus.push({
                    index: parseInt(index),
                    name,
                    totalMemory: memTotal,
                    freeMemory: memFree,
                    usedMemory: memTotal - memFree
                });
                totalGpuMemory += memTotal;
                totalGpuFree += memFree;
            }
            if (gpus.length > 0) {
                gpuInfo = {
                    count: gpus.length,
                    name: gpus[0].name,
                    totalMemory: totalGpuMemory,
                    freeMemory: totalGpuFree,
                    usedMemory: totalGpuMemory - totalGpuFree,
                    gpus
                };
            }
        } catch (err) {
            console.warn('[System Resources] GPU detection failed:', err.message);
        }

        res.json({
            cpu: {
                model: cpuModel,
                cores: cpuCount
            },
            memory: {
                total: totalMemory,
                free: freeMemory,
                used: usedMemory,
                usagePercent: ((usedMemory / totalMemory) * 100).toFixed(2)
            },
            gpu: gpuInfo,
            // Recommended settings based on resources
            recommendations: {
                lowVRAM: gpuInfo && gpuInfo.totalMemory < 8 * 1024 * 1024 * 1024, // < 8GB
                highVRAM: gpuInfo && gpuInfo.totalMemory >= 24 * 1024 * 1024 * 1024, // >= 24GB
                lowRAM: totalMemory < 16 * 1024 * 1024 * 1024, // < 16GB
                highRAM: totalMemory >= 32 * 1024 * 1024 * 1024 // >= 32GB
            }
        });
    } catch (error) {
        console.error('Error getting system resources:', error);
        res.status(500).json({ error: 'Failed to get system resources' });
    }
});

// Calculate optimal vLLM settings for a model based on hardware
app.post('/api/system/optimal-settings', requireAuth, async (req, res) => {
    // Check permission - models or admin
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }

    try {
        const { modelFileSize, modelName, backend } = req.body;

        if (!modelFileSize) {
            return res.status(400).json({ error: 'modelFileSize is required' });
        }

        // Get hardware info
        const totalMemory = os.totalmem();
        const cpuCount = os.cpus().length;

        // Get GPU info
        let totalGpuMemory = 0;
        let gpuCount = 0;
        try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                totalGpuMemory += parseInt(line.trim()) * 1024 * 1024; // MB to bytes
                gpuCount++;
            }
        } catch (err) {
            // No GPU available
        }

        // Calculate optimal settings
        const modelSizeGB = modelFileSize / (1024 * 1024 * 1024);
        const gpuMemoryGB = totalGpuMemory / (1024 * 1024 * 1024);
        const ramGB = totalMemory / (1024 * 1024 * 1024);

        // Estimate VRAM usage: model size + ~20% overhead for KV cache at 4K context
        const estimatedBaseVRAM = modelSizeGB * 1.2;

        let notes = [];

        // ========================================================================
        // LLAMA.CPP OPTIMAL SETTINGS
        // ========================================================================
        if (backend === 'llamacpp') {
            let llamacppSettings = {
                nGpuLayers: -1,           // -1 = all layers on GPU
                contextSize: 4096,         // Context window
                flashAttention: false,     // Flash attention (newer GPUs)
                cacheTypeK: 'f16',         // KV cache key type
                cacheTypeV: 'f16',         // KV cache value type
                threads: Math.max(4, Math.floor(cpuCount * 0.75)),  // CPU threads
                parallelSlots: 1,          // Concurrent requests
                batchSize: 2048,           // Batch size for prompt processing
                ubatchSize: 512,           // Micro-batch size
                repeatPenalty: 1.1,        // Repetition penalty
                repeatLastN: 64,           // Last N tokens for repetition
                presencePenalty: 0.0,      // Presence penalty
                frequencyPenalty: 0.0      // Frequency penalty
            };

            if (gpuCount === 0 || gpuMemoryGB === 0) {
                // CPU-only mode
                llamacppSettings.nGpuLayers = 0;
                llamacppSettings.threads = Math.max(4, cpuCount - 2);
                llamacppSettings.contextSize = 2048;
                llamacppSettings.batchSize = 512;
                llamacppSettings.ubatchSize = 256;
                notes.push('No GPU detected - using CPU-only mode');
                notes.push(`Using ${llamacppSettings.threads} CPU threads`);
            } else if (estimatedBaseVRAM > gpuMemoryGB * 0.95) {
                // Model too large - partial GPU offload
                const layerFraction = (gpuMemoryGB * 0.85) / modelSizeGB;
                const estimatedLayers = Math.floor(layerFraction * 40); // Assume ~40 layers typical
                llamacppSettings.nGpuLayers = Math.max(1, estimatedLayers);
                llamacppSettings.contextSize = 2048;
                llamacppSettings.cacheTypeK = 'q8_0';
                llamacppSettings.cacheTypeV = 'q8_0';
                llamacppSettings.batchSize = 512;
                llamacppSettings.ubatchSize = 256;
                notes.push(`Model (${modelSizeGB.toFixed(1)}GB) exceeds GPU memory (${gpuMemoryGB.toFixed(1)}GB)`);
                notes.push(`Partial GPU offload: ~${llamacppSettings.nGpuLayers} layers on GPU`);
                notes.push('Using q8_0 KV cache for memory efficiency');
            } else if (estimatedBaseVRAM > gpuMemoryGB * 0.7) {
                // Tight fit - optimize memory
                llamacppSettings.nGpuLayers = -1;
                llamacppSettings.contextSize = 4096;
                llamacppSettings.cacheTypeK = 'q8_0';
                llamacppSettings.cacheTypeV = 'q8_0';
                llamacppSettings.flashAttention = true;
                llamacppSettings.batchSize = 1024;
                notes.push('Model fits in GPU with memory optimizations');
                notes.push('Using q8_0 KV cache and flash attention');
            } else if (estimatedBaseVRAM > gpuMemoryGB * 0.5) {
                // Moderate fit
                llamacppSettings.nGpuLayers = -1;
                llamacppSettings.contextSize = 8192;
                llamacppSettings.flashAttention = true;
                llamacppSettings.batchSize = 2048;
                notes.push('Model fits comfortably - using 8K context');
            } else {
                // Plenty of room
                llamacppSettings.nGpuLayers = -1;
                const availableForContext = (gpuMemoryGB - modelSizeGB) * 0.8;
                if (availableForContext > 8) {
                    llamacppSettings.contextSize = 32768;
                    llamacppSettings.parallelSlots = Math.min(4, gpuCount * 2);
                } else if (availableForContext > 4) {
                    llamacppSettings.contextSize = 16384;
                    llamacppSettings.parallelSlots = Math.min(2, gpuCount * 2);
                } else {
                    llamacppSettings.contextSize = 8192;
                }
                llamacppSettings.flashAttention = true;
                llamacppSettings.batchSize = 4096;
                llamacppSettings.ubatchSize = 1024;
                notes.push(`Plenty of GPU memory - using ${llamacppSettings.contextSize} context`);
            }

            // Multi-GPU support
            if (gpuCount > 1) {
                llamacppSettings.parallelSlots = Math.min(llamacppSettings.parallelSlots * gpuCount, 8);
                notes.push(`${gpuCount} GPUs detected - increased parallel slots to ${llamacppSettings.parallelSlots}`);
            }

            return res.json({
                settings: llamacppSettings,
                backend: 'llamacpp',
                hardware: {
                    gpuCount,
                    gpuMemoryGB: gpuMemoryGB.toFixed(1),
                    ramGB: ramGB.toFixed(1),
                    cpuCores: cpuCount
                },
                model: {
                    sizeGB: modelSizeGB.toFixed(2),
                    estimatedVRAM: estimatedBaseVRAM.toFixed(2)
                },
                notes
            });
        }

        // ========================================================================
        // VLLM OPTIMAL SETTINGS (default)
        // ========================================================================
        let settings = {
            // vLLM Core Settings
            maxModelLen: 4096,              // Context window size
            cpuOffloadGb: 0,                // GB to offload to CPU RAM
            gpuMemoryUtilization: 0.9,      // Fraction of VRAM to use
            tensorParallelSize: 1,          // Number of GPUs for tensor parallelism
            maxNumSeqs: 256,                // Max concurrent sequences
            kvCacheDtype: 'auto',           // KV cache data type (auto or fp8)
            trustRemoteCode: true,          // Trust remote code from model
            enforceEager: false             // Disable CUDA graphs (debug mode)
        };

        if (gpuCount === 0 || gpuMemoryGB === 0) {
            // vLLM requires GPU - cannot run in CPU-only mode
            notes.push('ERROR: No GPU detected - vLLM requires a GPU to run');
            notes.push('Please ensure NVIDIA drivers and CUDA are properly installed');
            return res.json({
                settings,
                backend: 'vllm',
                hardware: {
                    gpuCount,
                    gpuMemoryGB: '0',
                    ramGB: ramGB.toFixed(1),
                    cpuCores: cpuCount
                },
                model: {
                    sizeGB: modelSizeGB.toFixed(2),
                    estimatedVRAM: estimatedBaseVRAM.toFixed(2)
                },
                notes,
                error: 'GPU required for vLLM'
            });
        }

        if (estimatedBaseVRAM > gpuMemoryGB * 0.9) {
            // Model is too large for GPU - enable CPU offloading
            // Calculate how much to offload: model size - (VRAM * 0.85) + 2GB buffer
            const cpuOffload = Math.ceil(modelSizeGB - (gpuMemoryGB * 0.85) + 2);
            settings.cpuOffloadGb = Math.max(0, cpuOffload);
            settings.maxModelLen = 4096;  // Conservative context for large models
            settings.gpuMemoryUtilization = 0.95;  // Use more VRAM since we're offloading
            settings.maxNumSeqs = 64;  // Fewer sequences to manage memory
            notes.push(`Model (${modelSizeGB.toFixed(1)}GB) exceeds GPU memory (${gpuMemoryGB.toFixed(1)}GB)`);
            notes.push(`CPU offloading ${settings.cpuOffloadGb}GB to system RAM`);
            notes.push('Note: GGUF + CPU offload may have issues (see vLLM GitHub #8757)');
        } else if (estimatedBaseVRAM > gpuMemoryGB * 0.7) {
            // Tight fit - optimize for memory
            settings.maxModelLen = 4096;
            settings.gpuMemoryUtilization = 0.85;
            settings.maxNumSeqs = 128;
            settings.kvCacheDtype = 'fp8';  // Use fp8 KV cache to save memory
            notes.push('Model fits in GPU with memory optimizations');
            notes.push('Using fp8 KV cache for memory efficiency');
        } else if (estimatedBaseVRAM > gpuMemoryGB * 0.5) {
            // Moderate fit
            settings.maxModelLen = 8192;
            settings.gpuMemoryUtilization = 0.9;
            settings.maxNumSeqs = 256;
            notes.push('Model fits comfortably with 8K context');
        } else {
            // Plenty of room - maximize context and performance
            const availableForContext = (gpuMemoryGB - modelSizeGB) * 0.8;
            if (availableForContext > 8) {
                settings.maxModelLen = 32768;
                settings.maxNumSeqs = 512;
            } else if (availableForContext > 4) {
                settings.maxModelLen = 16384;
                settings.maxNumSeqs = 256;
            } else if (availableForContext > 2) {
                settings.maxModelLen = 8192;
                settings.maxNumSeqs = 256;
            }
            settings.gpuMemoryUtilization = 0.9;
            notes.push(`Plenty of GPU memory - using ${settings.maxModelLen} context`);
        }

        // Tensor parallelism for multiple GPUs
        if (gpuCount > 1) {
            settings.tensorParallelSize = gpuCount;
            settings.maxNumSeqs = Math.min(settings.maxNumSeqs * gpuCount, 1024);
            notes.push(`${gpuCount} GPUs detected - enabling tensor parallelism`);
            notes.push(`Increased max sequences to ${settings.maxNumSeqs} for multi-GPU`);
        }

        res.json({
            settings,
            backend: 'vllm',
            hardware: {
                gpuCount,
                gpuMemoryGB: gpuMemoryGB.toFixed(1),
                ramGB: ramGB.toFixed(1),
                cpuCores: cpuCount
            },
            model: {
                sizeGB: modelSizeGB.toFixed(2),
                estimatedVRAM: estimatedBaseVRAM.toFixed(2)
            },
            notes
        });
    } catch (error) {
        console.error('Error calculating optimal settings:', error);
        res.status(500).json({ error: 'Failed to calculate optimal settings' });
    }
});

// ============================================================================
// MODEL CONFIGURATIONS ENDPOINTS
// ============================================================================

// Get all saved model configurations
app.get('/api/model-configs', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    try {
        const configs = await loadModelConfigs();
        const userConfigs = req.userId ? (configs[req.userId] || {}) : configs;
        res.json(userConfigs);
    } catch (error) {
        console.error('Error getting model configs:', error);
        res.status(500).json({ error: 'Failed to load model configs' });
    }
});

// Get saved configuration for a specific model
app.get('/api/model-configs/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    try {
        const configs = await loadModelConfigs();
        const userConfigs = req.userId ? (configs[req.userId] || {}) : configs;
        res.json({
            modelName,
            config: userConfigs[modelName] || null,
            exists: !!userConfigs[modelName]
        });
    } catch (error) {
        console.error('Error getting model config:', error);
        res.status(500).json({ error: 'Failed to load model config' });
    }
});

// Save configuration for a model
app.put('/api/model-configs/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'config must be an object' });
    }

    try {
        const configs = await loadModelConfigs();

        if (req.userId) {
            // User-scoped
            if (!configs[req.userId]) {
                configs[req.userId] = {};
            }
            configs[req.userId][modelName] = config;
        } else {
            // Backward compatibility
            configs[modelName] = config;
        }

        await saveModelConfigs(configs);
        broadcast({ type: 'log', message: `Configuration saved for ${modelName}` }, req.userId);
        res.json({ message: 'Configuration saved', modelName });
    } catch (error) {
        console.error('Error saving model config:', error);
        res.status(500).json({ error: 'Failed to save model config' });
    }
});

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

// In-memory storage for API key usage stats
// Structure: { apiKeyId -> { requestCount, tokenCount, lastUsed, requests: [] } }
const apiKeyUsageStats = new Map();

// Periodic save of usage stats (every 30 seconds)
setInterval(async () => {
    await saveApiKeyUsageStats();
}, 30000);

// Save stats on process termination
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, saving usage stats...');
    await saveApiKeyUsageStats();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, saving usage stats...');
    await saveApiKeyUsageStats();
    process.exit(0);
});

// Helper functions for API keys
async function loadApiKeys() {
    try {
        const data = await fs.readFile(API_KEYS_FILE, 'utf8');
        const keys = JSON.parse(data);
        // Decrypt sensitive fields (handles both encrypted and unencrypted data for migration)
        return decryptApiKeys(keys);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading API keys:', err);
        return [];
    }
}

async function saveApiKeys(keys) {
    await ensureDataDir();
    // Encrypt sensitive fields before saving
    const encryptedKeys = encryptApiKeys(keys);
    await fs.writeFile(API_KEYS_FILE, JSON.stringify(encryptedKeys, null, 2));
}

/**
 * Migrate unencrypted API keys to encrypted format
 * Called during server initialization
 */
async function migrateApiKeysEncryption() {
    try {
        const data = await fs.readFile(API_KEYS_FILE, 'utf8');
        const keys = JSON.parse(data);

        if (!Array.isArray(keys) || keys.length === 0) {
            return; // No keys to migrate
        }

        // Check if any key needs encryption
        const needsMigration = keys.some(key => {
            return (key.key && !isEncrypted(key.key)) ||
                   (key.secret && !isEncrypted(key.secret));
        });

        if (needsMigration) {
            console.log('[Encryption] Migrating API keys to encrypted format...');
            // Save will automatically encrypt the keys
            await saveApiKeys(keys);
            console.log('[Encryption] API keys migration complete');
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            return; // No file to migrate
        }
        console.error('[Encryption] Error during API keys migration:', err.message);
    }
}

// Helper functions for API key usage stats
async function loadApiKeyUsageStats() {
    try {
        const data = await fs.readFile(API_KEY_USAGE_STATS_FILE, 'utf8');
        const statsArray = JSON.parse(data);
        // Convert array back to Map
        const statsMap = new Map();
        for (const [key, value] of statsArray) {
            statsMap.set(key, value);
        }
        return statsMap;
    } catch (err) {
        if (err.code === 'ENOENT') return new Map();
        console.error('Error loading API key usage stats:', err);
        return new Map();
    }
}

async function saveApiKeyUsageStats() {
    try {
        await ensureDataDir();
        // Convert Map to array for JSON serialization
        const statsArray = Array.from(apiKeyUsageStats.entries());
        await fs.writeFile(API_KEY_USAGE_STATS_FILE, JSON.stringify(statsArray, null, 2));
    } catch (err) {
        console.error('Error saving API key usage stats:', err);
    }
}

// Get the start of the current calendar day (midnight)
function getStartOfDay() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// Clean up old requests and reset daily counters
// This runs periodically to remove requests older than 24 hours
function cleanupOldApiKeyRequests() {
    const startOfDay = getStartOfDay();
    let cleaned = false;

    for (const [keyId, stats] of apiKeyUsageStats.entries()) {
        if (stats.requests && stats.requests.length > 0) {
            // Remove requests from previous days (keep only today's requests for rate limiting)
            const todayRequests = stats.requests.filter(r => r.timestamp >= startOfDay);

            // Also keep some recent requests for minute-based rate limiting (last hour)
            const oneHourAgo = Date.now() - 3600000;
            const recentRequests = stats.requests.filter(r => r.timestamp >= oneHourAgo && r.timestamp < startOfDay);

            // Combine: today's requests + last hour from yesterday (for rate limiting at midnight)
            const combinedRequests = [...recentRequests, ...todayRequests];

            if (combinedRequests.length < stats.requests.length) {
                stats.requests = combinedRequests;
                cleaned = true;
            }
        }
    }

    if (cleaned) {
        console.log('[API Keys] Cleaned up old request data (daily reset)');
        saveApiKeyUsageStats();
    }
}

// Run cleanup at startup and every hour
cleanupOldApiKeyRequests();
setInterval(cleanupOldApiKeyRequests, 3600000); // Every hour

function generateApiKey() {
    // Generate a secure random API key
    return crypto.randomBytes(32).toString('hex');
}

function generateApiSecret() {
    // Generate a secure random secret
    return crypto.randomBytes(48).toString('base64');
}

// Optional Authentication middleware - allows UI access without keys
// Only enforces auth when API keys are provided in headers
async function optionalAuth(req, res, next) {
    const apiKey = req.header('X-API-Key');
    const apiSecret = req.header('X-API-Secret');

    // If no API key headers, allow access (for UI)
    if (!apiKey && !apiSecret) {
        return next();
    }

    // If headers are provided, validate them
    try {
        const keys = await loadApiKeys();
        const keyData = keys.find(k => timingSafeCompare(k.key, apiKey) && timingSafeCompare(k.secret, apiSecret) && k.active);

        if (!keyData) {
            return res.status(401).json({ error: 'Invalid or inactive API key' });
        }

        // Check rate limits
        const now = Date.now();
        const stats = apiKeyUsageStats.get(keyData.id) || {
            requestCount: 0,
            tokenCount: 0,
            lastUsed: now,
            requests: []
        };

        // Check rate limit (requests per minute)
        if (keyData.rateLimitRequests) {
            const oneMinuteAgo = now - 60000;
            const recentRequests = stats.requests.filter(r => r.timestamp > oneMinuteAgo);
            if (recentRequests.length >= keyData.rateLimitRequests) {
                return res.status(429).json({ error: 'Rate limit exceeded' });
            }
        }

        // Check token limit (tokens per day - calendar day, resets at midnight)
        if (keyData.rateLimitTokens) {
            const startOfDay = getStartOfDay();
            const todayTokens = stats.requests
                .filter(r => r.timestamp >= startOfDay)
                .reduce((sum, r) => sum + (r.tokens || 0), 0);
            if (todayTokens >= keyData.rateLimitTokens) {
                return res.status(429).json({ error: 'Token limit exceeded' });
            }
        }

        // Update stats
        stats.requestCount++;
        stats.lastUsed = now;
        stats.requests.push({ timestamp: now, endpoint: req.path, tokens: 0 });
        // Keep only last 1000 requests
        if (stats.requests.length > 1000) {
            stats.requests = stats.requests.slice(-1000);
        }
        apiKeyUsageStats.set(keyData.id, stats);

        // Add response interceptor to track tokens
        const originalSend = res.send;
        res.send = function(data) {
            try {
                if (typeof data === 'string') {
                    const jsonData = JSON.parse(data);
                    if (jsonData.tokens || jsonData.usage) {
                        const tokens = jsonData.tokens?.total_tokens || jsonData.usage?.total_tokens || 0;
                        const lastReq = stats.requests[stats.requests.length - 1];
                        if (lastReq) {
                            lastReq.tokens = tokens;
                            stats.tokenCount += tokens;
                            apiKeyUsageStats.set(keyData.id, stats);
                        }
                    }
                }
            } catch (e) {
                // Ignore parsing errors
            }
            return originalSend.call(this, data);
        };

        // Attach key data to request
        req.apiKeyData = keyData;
        req.userId = keyData.userId || null; // Set userId from API key if available
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// Authentication middleware - supports session auth, API keys, and Bearer tokens
// Priority: 1) Session auth (Passport) 2) API key 3) Bearer token 4) No auth (backward compat)
// Sets req.userId for data filtering and req.apiKeyData for permission checks
async function requireAuth(req, res, next) {
    // Priority 1: Check for session authentication (Passport.js)
    if (req.isAuthenticated && req.isAuthenticated()) {
        // Check if user account has been disabled
        if (req.user.disabled === true) {
            // Destroy session and reject request
            req.logout((err) => {
                if (err) console.error('Error during logout:', err);
            });
            return res.status(403).json({ error: 'Account is disabled' });
        }

        req.userId = req.user.id;
        req.apiKeyData = null; // Session users have full access (like no API key)
        return next();
    }

    const apiKey = req.header('X-API-Key');
    const apiSecret = req.header('X-API-Secret');
    const authHeader = req.header('Authorization');

    // Priority 2: Check for Bearer token authentication
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const bearerToken = authHeader.substring(7);
        try {
            const keys = await loadApiKeys();
            const keyData = keys.find(k => timingSafeCompare(k.key, bearerToken) && k.active && k.bearerOnly === true);

            if (!keyData) {
                return res.status(401).json({ error: 'Invalid or inactive Bearer token' });
            }

            // Check rate limits
            const now = Date.now();
            const stats = apiKeyUsageStats.get(keyData.id) || {
                requestCount: 0,
                tokenCount: 0,
                lastUsed: now,
                requests: []
            };

            if (keyData.rateLimitRequests) {
                const oneMinuteAgo = now - 60000;
                const recentRequests = stats.requests.filter(r => r.timestamp > oneMinuteAgo);
                if (recentRequests.length >= keyData.rateLimitRequests) {
                    return res.status(429).json({ error: 'Rate limit exceeded' });
                }
            }

            // Check token limit (calendar day, resets at midnight)
            if (keyData.rateLimitTokens) {
                const startOfDay = getStartOfDay();
                const todayTokens = stats.requests
                    .filter(r => r.timestamp >= startOfDay)
                    .reduce((sum, r) => sum + (r.tokens || 0), 0);
                if (todayTokens >= keyData.rateLimitTokens) {
                    return res.status(429).json({ error: 'Token limit exceeded' });
                }
            }

            // Update stats
            stats.requestCount++;
            stats.lastUsed = now;
            stats.requests.push({ timestamp: now, endpoint: req.path, tokens: 0 });
            if (stats.requests.length > 1000) {
                stats.requests = stats.requests.slice(-1000);
            }
            apiKeyUsageStats.set(keyData.id, stats);

            req.apiKeyData = keyData;
            req.userId = keyData.userId || null; // Set userId from API key if available
            return next();
        } catch (error) {
            console.error('Bearer token authentication error:', error);
            return res.status(500).json({ error: 'Authentication failed' });
        }
    }

    // Priority 3: If API key headers are present, validate them
    if (apiKey || apiSecret) {
        if (!apiKey || !apiSecret) {
            return res.status(401).json({ error: 'Both X-API-Key and X-API-Secret headers are required' });
        }
        // Validate the provided credentials
        return optionalAuth(req, res, next);
    }

    // Priority 4: No authentication provided - reject request
    return res.status(401).json({ error: 'Authentication required' });
}

// Check if API key has permission for an action
// If no keyData (UI access), allow all permissions
function checkPermission(keyData, permission) {
    if (!keyData) {
        return true; // UI access - no restrictions
    }
    if (!keyData.permissions || !keyData.permissions.includes(permission)) {
        return false;
    }
    return true;
}

// Helper function to filter array data by userId
// If userId is null (authenticated via API key without userId), return global/system items
// Otherwise, return items belonging to the user + global items
function filterByUserId(items, userId) {
    if (!userId) {
        // API key auth without userId - return global/system items (no userId field)
        return items.filter(item => !item.userId);
    }
    // Include items without userId (global/system items) or items owned by user
    return items.filter(item => !item.userId || item.userId === userId);
}

// Helper function to check if user owns an item
// If userId is null (no auth), allow access (backward compatibility)
// Otherwise, check if item belongs to user
function checkOwnership(item, userId) {
    if (!userId) {
        return false; // Require authentication - no unauthenticated access
    }
    // Allow access to global items (no userId) or items owned by user
    return item && (!item.userId || item.userId === userId);
}

// ============================================================================
// API KEY CRUD ENDPOINTS
// ============================================================================

// Admin middleware - requires session auth (webapp UI) or admin API key
async function requireAdmin(req, res, next) {
    // Priority 1: Check for session authentication (Passport.js)
    if (req.isAuthenticated && req.isAuthenticated()) {
        req.userId = req.user.id;
        req.apiKeyData = null; // Session users have full access
        return next();
    }

    const apiKey = req.header('X-API-Key');
    const apiSecret = req.header('X-API-Secret');

    // Priority 2: If API key headers are present, validate them and check admin permission
    if (apiKey || apiSecret) {
        if (!apiKey || !apiSecret) {
            return res.status(401).json({ error: 'Both X-API-Key and X-API-Secret headers are required' });
        }

        // Check for admin permission
        try {
            const keys = await loadApiKeys();
            const keyData = keys.find(k => timingSafeCompare(k.key, apiKey) && timingSafeCompare(k.secret, apiSecret) && k.active);

            if (!keyData) {
                return res.status(401).json({ error: 'Invalid or inactive API key' });
            }

            if (!keyData.permissions || !keyData.permissions.includes('admin')) {
                return res.status(403).json({ error: 'Admin permission required' });
            }

            req.apiKeyData = keyData;
            return next();
        } catch (error) {
            console.error('Admin check error:', error);
            return res.status(500).json({ error: 'Authorization failed' });
        }
    }

    // Priority 3: No authentication provided - reject request
    return res.status(401).json({ error: 'Admin authentication required' });
}

// List all API keys (without secrets) - Admin only
app.get('/api/api-keys', requireAdmin, async (req, res) => {
    try {
        const keys = await loadApiKeys();
        const startOfDay = getStartOfDay();
        const keysWithStats = keys.map(k => {
            const stats = apiKeyUsageStats.get(k.id) || { requestCount: 0, tokenCount: 0, lastUsed: null, requests: [] };

            // Calculate token usage for today (calendar day, resets at midnight)
            const dailyTokens = stats.requests
                .filter(r => r.timestamp >= startOfDay)
                .reduce((sum, r) => sum + (r.tokens || 0), 0);

            // Calculate usage percentages
            const tokenUsagePercentage = k.rateLimitTokens ?
                Math.min(100, (dailyTokens / k.rateLimitTokens * 100)) : 0;

            return {
                ...k,
                // Keep secret for display in UI (with show/hide functionality)
                stats: {
                    requestCount: stats.requestCount,
                    tokenCount: stats.tokenCount,
                    dailyTokens,
                    tokenUsagePercentage: tokenUsagePercentage.toFixed(1),
                    lastUsed: stats.lastUsed,
                    isActive: stats.lastUsed && (Date.now() - stats.lastUsed < 60000) // Active in last minute
                }
            };
        });
        // Send full secrets - endpoint is admin-only (requireAdmin), frontend handles show/hide
        res.json(keysWithStats);
    } catch (error) {
        console.error('Error getting API keys:', error);
        res.status(500).json({ error: 'Failed to load API keys' });
    }
});

// Create a new API key - Admin only
app.post('/api/api-keys', requireAdmin, async (req, res) => {
    const { name, permissions, rateLimitRequests, rateLimitTokens, bearerOnly } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    try {
        const keys = await loadApiKeys();
        const newKey = {
            id: crypto.randomUUID(),
            name,
            key: generateApiKey(),
            secret: bearerOnly ? null : generateApiSecret(), // No secret for bearer-only keys
            bearerOnly: bearerOnly || false,
            permissions: permissions || ['query', 'models'],
            rateLimitRequests: (rateLimitRequests !== undefined && rateLimitRequests !== null && rateLimitRequests > 0) ? rateLimitRequests : 60,
            rateLimitTokens: (rateLimitTokens !== undefined && rateLimitTokens !== null && rateLimitTokens > 0) ? rateLimitTokens : 100000,
            userId: req.userId || null, // Associate key with creating user
            active: true,
            createdAt: new Date().toISOString()
        };
        keys.push(newKey);
        await saveApiKeys(keys);
        broadcast({ type: 'log', message: `API key created: ${name}${bearerOnly ? ' (Bearer Only)' : ''}` });
        res.json(newKey);
    } catch (error) {
        console.error('Error creating API key:', error);
        res.status(500).json({ error: 'Failed to create API key' });
    }
});

// Update an API key - Admin only
app.put('/api/api-keys/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, permissions, rateLimitRequests, rateLimitTokens, active } = req.body;

    try {
        const keys = await loadApiKeys();
        const keyIndex = keys.findIndex(k => k.id === id);
        if (keyIndex === -1) {
            return res.status(404).json({ error: 'API key not found' });
        }

        if (name !== undefined) keys[keyIndex].name = name;
        if (permissions !== undefined) keys[keyIndex].permissions = permissions;
        if (rateLimitRequests !== undefined) keys[keyIndex].rateLimitRequests = rateLimitRequests;
        if (rateLimitTokens !== undefined) keys[keyIndex].rateLimitTokens = rateLimitTokens;
        if (active !== undefined) keys[keyIndex].active = active;

        await saveApiKeys(keys);
        broadcast({ type: 'log', message: `API key updated: ${keys[keyIndex].name}` });
        res.json({ ...keys[keyIndex], secret: undefined });
    } catch (error) {
        console.error('Error updating API key:', error);
        res.status(500).json({ error: 'Failed to update API key' });
    }
});

// Revoke (deactivate) an API key - Admin only
app.post('/api/api-keys/:id/revoke', requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const keys = await loadApiKeys();
        const keyIndex = keys.findIndex(k => k.id === id);
        if (keyIndex === -1) {
            return res.status(404).json({ error: 'API key not found' });
        }

        keys[keyIndex].active = false;
        await saveApiKeys(keys);
        broadcast({ type: 'log', message: `API key revoked: ${keys[keyIndex].name}` });
        res.json({ message: 'API key revoked', ...keys[keyIndex], secret: undefined });
    } catch (error) {
        console.error('Error revoking API key:', error);
        res.status(500).json({ error: 'Failed to revoke API key' });
    }
});

// Delete an API key - Admin only
app.delete('/api/api-keys/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const keys = await loadApiKeys();
        const keyIndex = keys.findIndex(k => k.id === id);
        if (keyIndex === -1) {
            return res.status(404).json({ error: 'API key not found' });
        }

        const deletedKey = keys.splice(keyIndex, 1)[0];
        await saveApiKeys(keys);
        apiKeyUsageStats.delete(id);
        broadcast({ type: 'log', message: `API key deleted: ${deletedKey.name}` });
        res.json({ message: 'API key deleted' });
    } catch (error) {
        console.error('Error deleting API key:', error);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// Clear usage stats for an API key - Admin only
app.post('/api/api-keys/:id/clear-usage', requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const keys = await loadApiKeys();
        const key = keys.find(k => k.id === id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        // Reset usage stats for this key
        apiKeyUsageStats.set(id, {
            requestCount: 0,
            tokenCount: 0,
            lastUsed: null,
            requests: []
        });

        // Save stats immediately
        await saveApiKeyUsageStats();

        broadcast({ type: 'log', message: `Usage stats cleared for API key: ${key.name}` });
        res.json({ message: 'Usage stats cleared successfully', keyName: key.name });
    } catch (error) {
        console.error('Error clearing API key usage:', error);
        res.status(500).json({ error: 'Failed to clear usage stats' });
    }
});

// Get usage stats for an API key
app.get('/api/api-keys/:id/stats', requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const keys = await loadApiKeys();
        const key = keys.find(k => k.id === id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        const stats = apiKeyUsageStats.get(id) || {
            requestCount: 0,
            tokenCount: 0,
            lastUsed: null,
            requests: []
        };

        // Calculate stats
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        const oneHourAgo = now - 3600000;
        const startOfDay = getStartOfDay();

        const recentRequests = stats.requests.filter(r => r.timestamp > oneMinuteAgo).length;
        const hourlyRequests = stats.requests.filter(r => r.timestamp > oneHourAgo).length;
        const dailyRequests = stats.requests.filter(r => r.timestamp >= startOfDay).length;
        // Token usage uses calendar day (resets at midnight)
        const dailyTokens = stats.requests
            .filter(r => r.timestamp >= startOfDay)
            .reduce((sum, r) => sum + (r.tokens || 0), 0);

        res.json({
            id: key.id,
            name: key.name,
            totalRequests: stats.requestCount,
            totalTokens: stats.tokenCount,
            lastUsed: stats.lastUsed,
            recentRequests,
            hourlyRequests,
            dailyRequests,
            dailyTokens,
            rateLimits: {
                requestsPerMinute: key.rateLimitRequests,
                tokensPerDay: key.rateLimitTokens
            },
            usage: {
                requestsPercentage: key.rateLimitRequests ? (recentRequests / key.rateLimitRequests * 100).toFixed(1) : 0,
                tokensPercentage: key.rateLimitTokens ? (dailyTokens / key.rateLimitTokens * 100).toFixed(1) : 0
            }
        });
    } catch (error) {
        console.error('Error getting API key stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ============================================================================
// AGENTS API ENDPOINTS
// ============================================================================

// List all agents
app.get('/api/agents', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    try {
        const agents = await loadAgents();
        // Filter agents by userId (show only user's agents)
        const userAgents = filterByUserId(agents, req.userId);
        res.json(userAgents);
    } catch (error) {
        console.error('Error loading agents:', error);
        res.status(500).json({ error: 'Failed to load agents' });
    }
});

// Get a single agent
app.get('/api/agents/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    try {
        const agents = await loadAgents();
        const agent = agents.find(a => a.id === id);

        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Check ownership
        if (!checkOwnership(agent, req.userId)) {
            return res.status(403).json({ error: 'Access denied: agent belongs to another user' });
        }

        res.json(agent);
    } catch (error) {
        console.error('Error loading agent:', error);
        res.status(500).json({ error: 'Failed to load agent' });
    }
});

// Create a new agent
app.post('/api/agents', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { name, description, modelName, systemPrompt, skills, permissions } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Agent name is required' });
    }

    try {
        const agents = await loadAgents();

        // Check for duplicate name
        if (agents.find(a => a.name === name)) {
            return res.status(400).json({ error: 'Agent with this name already exists' });
        }

        const newAgent = {
            id: crypto.randomBytes(16).toString('hex'),
            name,
            description: description || '',
            modelName: modelName || null,
            systemPrompt: systemPrompt || '',
            skills: skills || [],
            permissions: permissions || {
                allowFileRead: true,
                allowFileWrite: true,
                allowFileDelete: true,
                allowToolExecution: true
            },
            apiKey: crypto.randomBytes(32).toString('hex'),
            userId: req.userId || null, // Assign agent to current user
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        agents.push(newAgent);
        await saveAgents(agents);

        res.status(201).json(newAgent);
    } catch (error) {
        console.error('Error creating agent:', error);
        res.status(500).json({ error: 'Failed to create agent' });
    }
});

// Update an agent
app.put('/api/agents/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    const { name, description, modelName, systemPrompt, skills, permissions } = req.body;

    try {
        const agents = await loadAgents();
        const agentIndex = agents.findIndex(a => a.id === id);

        if (agentIndex === -1) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Check ownership
        if (!checkOwnership(agents[agentIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: agent belongs to another user' });
        }

        // Check for duplicate name if name is being changed
        if (name && name !== agents[agentIndex].name) {
            if (agents.find(a => a.name === name)) {
                return res.status(400).json({ error: 'Agent with this name already exists' });
            }
        }

        // Update agent
        agents[agentIndex] = {
            ...agents[agentIndex],
            name: name || agents[agentIndex].name,
            description: description !== undefined ? description : agents[agentIndex].description,
            modelName: modelName !== undefined ? modelName : agents[agentIndex].modelName,
            systemPrompt: systemPrompt !== undefined ? systemPrompt : agents[agentIndex].systemPrompt,
            skills: skills !== undefined ? skills : agents[agentIndex].skills,
            permissions: permissions !== undefined ? permissions : agents[agentIndex].permissions,
            updatedAt: new Date().toISOString()
        };

        await saveAgents(agents);
        res.json(agents[agentIndex]);
    } catch (error) {
        console.error('Error updating agent:', error);
        res.status(500).json({ error: 'Failed to update agent' });
    }
});

// Delete an agent
app.delete('/api/agents/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;

    try {
        const agents = await loadAgents();
        const agentIndex = agents.findIndex(a => a.id === id);

        if (agentIndex === -1) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Check ownership
        if (!checkOwnership(agents[agentIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: agent belongs to another user' });
        }

        agents.splice(agentIndex, 1);
        await saveAgents(agents);

        // Also delete associated tasks
        const tasks = await loadTasks();
        const updatedTasks = tasks.filter(t => t.agentId !== id);
        await saveTasks(updatedTasks);

        res.json({ message: 'Agent deleted successfully' });
    } catch (error) {
        console.error('Error deleting agent:', error);
        res.status(500).json({ error: 'Failed to delete agent' });
    }
});

// Regenerate agent API key
app.post('/api/agents/:id/regenerate-key', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;

    try {
        const agents = await loadAgents();
        const agentIndex = agents.findIndex(a => a.id === id);

        if (agentIndex === -1) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        agents[agentIndex].apiKey = crypto.randomBytes(32).toString('hex');
        agents[agentIndex].updatedAt = new Date().toISOString();

        await saveAgents(agents);
        res.json({ apiKey: agents[agentIndex].apiKey });
    } catch (error) {
        console.error('Error regenerating agent API key:', error);
        res.status(500).json({ error: 'Failed to regenerate API key' });
    }
});

// ============================================================================
// SKILLS API ENDPOINTS
// ============================================================================

// List all skills
app.get('/api/skills', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    try {
        const skills = await loadSkills();
        const userSkills = filterByUserId(skills, req.userId);
        res.json(userSkills);
    } catch (error) {
        console.error('Error loading skills:', error);
        res.status(500).json({ error: 'Failed to load skills' });
    }
});

// Get a single skill
app.get('/api/skills/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    try {
        const skills = await loadSkills();
        const skill = skills.find(s => s.id === id);
        if (!skill) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        if (!checkOwnership(skill, req.userId)) {
            return res.status(403).json({ error: 'Access denied: skill belongs to another user' });
        }
        res.json(skill);
    } catch (error) {
        console.error('Error loading skill:', error);
        res.status(500).json({ error: 'Failed to load skill' });
    }
});

// Create a new skill
app.post('/api/skills', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { name, description, type, parameters, code } = req.body;

    if (!name || !type) {
        return res.status(400).json({ error: 'Skill name and type are required' });
    }

    try {
        const skills = await loadSkills();

        // Check for duplicate name
        if (skills.find(s => s.name === name)) {
            return res.status(400).json({ error: 'Skill with this name already exists' });
        }

        const newSkill = {
            id: crypto.randomBytes(16).toString('hex'),
            name,
            description: description || '',
            type, // 'tool', 'function', 'command'
            parameters: parameters || {},
            code: code || '',
            userId: req.userId || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        skills.push(newSkill);
        await saveSkills(skills);

        res.status(201).json(newSkill);
    } catch (error) {
        console.error('Error creating skill:', error);
        res.status(500).json({ error: 'Failed to create skill' });
    }
});

// Update a skill
app.put('/api/skills/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    const { name, description, type, parameters, code, enabled } = req.body;
    console.log('PUT /api/skills/:id - Request body:', JSON.stringify(req.body));
    console.log('PUT /api/skills/:id - enabled value:', enabled, 'type:', typeof enabled);

    try {
        const skills = await loadSkills();
        const skillIndex = skills.findIndex(s => s.id === id);

        if (skillIndex === -1) {
            return res.status(404).json({ error: 'Skill not found' });
        }

        if (!checkOwnership(skills[skillIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: skill belongs to another user' });
        }

        // Check for duplicate name if name is being changed
        if (name && name !== skills[skillIndex].name) {
            if (skills.find(s => s.name === name)) {
                return res.status(400).json({ error: 'Skill with this name already exists' });
            }
        }

        // Update skill
        skills[skillIndex] = {
            ...skills[skillIndex],
            name: name || skills[skillIndex].name,
            description: description !== undefined ? description : skills[skillIndex].description,
            type: type || skills[skillIndex].type,
            parameters: parameters !== undefined ? parameters : skills[skillIndex].parameters,
            code: code !== undefined ? code : skills[skillIndex].code,
            enabled: enabled !== undefined ? enabled : skills[skillIndex].enabled,
            updatedAt: new Date().toISOString()
        };

        await saveSkills(skills);
        res.json(skills[skillIndex]);
    } catch (error) {
        console.error('Error updating skill:', error);
        res.status(500).json({ error: 'Failed to update skill' });
    }
});

// Delete a skill
app.delete('/api/skills/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;

    try {
        const skills = await loadSkills();
        const skillIndex = skills.findIndex(s => s.id === id);

        if (skillIndex === -1) {
            return res.status(404).json({ error: 'Skill not found' });
        }

        if (!checkOwnership(skills[skillIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: skill belongs to another user' });
        }

        skills.splice(skillIndex, 1);
        await saveSkills(skills);

        res.json({ message: 'Skill deleted successfully' });
    } catch (error) {
        console.error('Error deleting skill:', error);
        res.status(500).json({ error: 'Failed to delete skill' });
    }
});

// ============================================================================
// AGENT-SKILL INTEGRATION ENDPOINTS
// ============================================================================

// List available (enabled) skills for agents
app.get('/api/agents/skills/available', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    try {
        const skills = await loadSkills();
        // Only return enabled skills, excluding the code for security
        const availableSkills = skills
            .filter(s => s.enabled)
            .map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                type: s.type,
                parameters: s.parameters,
                enabled: s.enabled
            }));

        res.json(availableSkills);
    } catch (error) {
        console.error('Error loading available skills:', error);
        res.status(500).json({ error: 'Failed to load available skills' });
    }
});

// Discover skills by type or search query
app.get('/api/agents/skills/discover', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { type, query } = req.query;

    try {
        const skills = await loadSkills();
        let filteredSkills = skills.filter(s => s.enabled);

        // Filter by type if provided
        if (type) {
            filteredSkills = filteredSkills.filter(s => s.type === type);
        }

        // Search by query if provided (searches name and description)
        if (query) {
            const searchTerm = query.toLowerCase();
            filteredSkills = filteredSkills.filter(s =>
                s.name.toLowerCase().includes(searchTerm) ||
                s.description.toLowerCase().includes(searchTerm)
            );
        }

        // Return without code
        const discoveredSkills = filteredSkills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            type: s.type,
            parameters: s.parameters
        }));

        res.json(discoveredSkills);
    } catch (error) {
        console.error('Error discovering skills:', error);
        res.status(500).json({ error: 'Failed to discover skills' });
    }
});

// Get skill recommendations for a task description
app.post('/api/agents/skills/recommend', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { taskDescription } = req.body;

    if (!taskDescription) {
        return res.status(400).json({ error: 'taskDescription is required' });
    }

    try {
        const skills = await loadSkills();
        const enabledSkills = skills.filter(s => s.enabled);

        // Simple keyword-based matching
        const keywords = taskDescription.toLowerCase().split(/\s+/);
        const recommendations = [];

        for (const skill of enabledSkills) {
            const skillText = (skill.name + ' ' + skill.description).toLowerCase();
            let score = 0;

            // Count matching keywords
            for (const keyword of keywords) {
                if (skillText.includes(keyword)) {
                    score++;
                }
            }

            if (score > 0) {
                recommendations.push({
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    type: skill.type,
                    parameters: skill.parameters,
                    relevanceScore: score
                });
            }
        }

        // Sort by relevance score (highest first)
        recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Return top 5 recommendations
        res.json(recommendations.slice(0, 5));
    } catch (error) {
        console.error('Error recommending skills:', error);
        res.status(500).json({ error: 'Failed to recommend skills' });
    }
});

// ============================================================================
// SKILL EXECUTION
// ============================================================================

// Execute a skill
app.post('/api/skills/:skillName/execute', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { skillName } = req.params;
    const { agentId, ...params } = req.body; // Extract agentId if provided

    try {
        const skills = await loadSkills();
        const skill = skills.find(s => s.name === skillName);

        if (!skill) {
            return res.status(404).json({ error: 'Skill not found' });
        }

        if (!skill.enabled) {
            return res.status(403).json({
                error: 'Skill is not available',
                message: `The skill '${skillName}' is currently disabled and cannot be executed. Please enable it in the Skills tab to use it.`,
                skillName: skillName,
                enabled: false
            });
        }

        // Log skill execution if agentId is provided
        if (agentId) {
            console.log(`[Agent ${agentId}] Executing skill: ${skillName}`);
        }

        let result;

        // Execute Python skill code
        if (skill.code && skill.code.trim() && !skill.code.startsWith('Uses ') && !skill.code.startsWith('Runs ')) {
            try {
                // Execute Python code
                result = await executePythonSkill(skill, params);
            } catch (error) {
                console.error(`Error executing skill ${skillName}:`, error);
                if (agentId) {
                    console.error(`[Agent ${agentId}] Skill execution failed: ${error.message}`);
                }
                return res.status(500).json({ error: 'Skill execution failed' });
            }
        } else {
            // Fallback to hardcoded implementations for legacy skills
            result = await executeLegacySkill(skillName, params);
        }

        // Add metadata to result if agent executed it
        if (agentId) {
            result.executedBy = agentId;
            result.executedAt = new Date().toISOString();
        }

        res.json(result);
    } catch (error) {
        console.error('Error executing skill:', error);
        res.status(500).json({ error: 'Failed to execute skill' });
    }
});

// Python skill executor
async function executePythonSkill(skill, params) {
    const tempFile = `/tmp/skill_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.py`;

    try {
        // Create Python script with JSON I/O
        // Write params to a separate JSON file to avoid shell escaping issues
        const paramsFile = `/tmp/skill_params_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.json`;
        const paramsJson = JSON.stringify(params);
        await fs.writeFile(paramsFile, paramsJson);

        const pythonScript = `#!/usr/bin/env python3
import json
import sys
import os

# Load parameters from JSON file
with open("${paramsFile}", "r") as f:
    params = json.load(f)

# Skill code
${skill.code}

# Execute skill
try:
    result = execute(params)
    # Ensure result is a dict
    if not isinstance(result, dict):
        result = {"success": False, "error": "Skill must return a dictionary"}
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
`;

        // Write Python script to temp file
        await fs.writeFile(tempFile, pythonScript, { mode: 0o755 });

        // Execute Python script
        const { stdout, stderr } = await execPromise(
            `python3 "${tempFile}"`,
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );

        // Clean up params file
        await fs.unlink(paramsFile).catch(() => {});

        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});

        // Parse result
        try {
            const result = JSON.parse(stdout.trim());
            return result;
        } catch (parseError) {
            console.error('Failed to parse Python output:', stdout, stderr);
            throw new Error(`Invalid JSON output from Python skill: ${parseError.message}`);
        }
    } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        throw error;
    }
}

// Legacy skill executor (for backward compatibility)
async function executeLegacySkill(skillName, params) {
    let result;

        switch (skillName) {
            // File Operations
            case 'create_file':
            case 'update_file':
                const content = params.content || '';
                const filePath = params.filePath;
                if (!filePath) {
                    throw new Error('filePath required' );
                }
                await fs.writeFile(filePath, content);
                result = { success: true, message: `File ${skillName === 'create_file' ? 'created' : 'updated'}: ${filePath}` };
                break;

            case 'read_file': {
                if (!params.filePath) {
                    throw new Error('filePath required');
                }
                const fileContent = await fs.readFile(params.filePath, 'utf8');
                const lines = fileContent.split('\n');
                const totalLines = lines.length;
                const chunkSize = params.chunkSize ? parseInt(params.chunkSize) : 500;
                const maxContentChars = params.maxContentChars ? parseInt(params.maxContentChars) : 100000;
                const totalChunks = Math.ceil(totalLines / chunkSize);
                const estimatedTokens = Math.ceil(fileContent.length / 4);

                // Handle specific line ranges
                if (params.startLine || params.endLine) {
                    const start = params.startLine ? parseInt(params.startLine) - 1 : 0;
                    const end = params.endLine ? parseInt(params.endLine) : totalLines;
                    const selectedLines = lines.slice(start, end);
                    result = {
                        success: true,
                        content: selectedLines.join('\n'),
                        lineRange: { start: start + 1, end: Math.min(end, totalLines) },
                        totalLines
                    };
                    break;
                }

                // Handle chunk-based reading
                if (params.chunkIndex !== undefined) {
                    const chunkIndex = parseInt(params.chunkIndex);
                    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
                        result = { success: false, error: `Invalid chunkIndex. Valid range: 0-${totalChunks - 1}` };
                        break;
                    }
                    const start = chunkIndex * chunkSize;
                    const end = Math.min(start + chunkSize, totalLines);
                    const chunkContent = lines.slice(start, end).join('\n');
                    result = {
                        success: true,
                        content: chunkContent,
                        currentChunk: chunkIndex,
                        totalChunks,
                        linesInChunk: end - start,
                        lineRange: { start: start + 1, end },
                        totalLines
                    };
                    break;
                }

                // Check if file is too large
                if (fileContent.length > maxContentChars || estimatedTokens > 20000) {
                    result = {
                        success: true,
                        warning: 'FILE_TOO_LARGE',
                        message: `File has ${totalLines} lines (~${estimatedTokens} tokens). Use chunkIndex parameter to read in parts.`,
                        totalLines,
                        totalChunks,
                        chunkSize,
                        estimatedTokens,
                        filePath: params.filePath,
                        suggestedApproach: `Read with chunkIndex=0 through chunkIndex=${totalChunks - 1} to process entire file`
                    };
                    break;
                }

                result = { success: true, content: fileContent, totalLines };
                break;
            }

            case 'delete_file':
                if (!params.filePath) {
                    throw new Error('filePath required' );
                }
                await fs.unlink(params.filePath);
                result = { success: true, message: `File deleted: ${params.filePath}` };
                break;

            case 'list_directory':
                if (!params.dirPath) {
                    throw new Error('dirPath required' );
                }
                const files = await fs.readdir(params.dirPath);
                result = { success: true, files };
                break;

            case 'move_file':
                if (!params.sourcePath || !params.destPath) {
                    throw new Error('sourcePath and destPath required' );
                }
                await fs.rename(params.sourcePath, params.destPath);
                result = { success: true, message: `File moved: ${params.sourcePath} -> ${params.destPath}` };
                break;

            case 'copy_file':
                if (!params.sourcePath || !params.destPath) {
                    throw new Error('sourcePath and destPath required' );
                }
                await fs.copyFile(params.sourcePath, params.destPath);
                result = { success: true, message: `File copied: ${params.sourcePath} -> ${params.destPath}` };
                break;

            // Data Processing
            case 'parse_json':
                if (!params.jsonString) {
                    throw new Error('jsonString required' );
                }
                try {
                    const parsed = JSON.parse(params.jsonString);
                    result = { success: true, data: parsed };
                } catch (e) {
                    throw new Error('Invalid JSON: ' + e.message );
                }
                break;

            case 'parse_csv':
                if (!params.csvString) {
                    throw new Error('csvString required' );
                }
                const delimiter = params.delimiter || ',';
                const lines = params.csvString.split('\n').filter(l => l.trim());
                const headers = lines[0].split(delimiter);
                const data = lines.slice(1).map(line => {
                    const values = line.split(delimiter);
                    const obj = {};
                    headers.forEach((h, i) => obj[h.trim()] = values[i]?.trim());
                    return obj;
                });
                result = { success: true, data };
                break;

            case 'format_markdown':
                if (!params.text) {
                    throw new Error('text required' );
                }
                // Basic markdown formatting
                let markdown = params.text;
                result = { success: true, markdown };
                break;

            case 'base64_encode':
                if (!params.data) {
                    throw new Error('data required' );
                }
                const encoded = Buffer.from(params.data).toString('base64');
                result = { success: true, encoded };
                break;

            case 'base64_decode':
                if (!params.encodedData) {
                    throw new Error('encodedData required' );
                }
                try {
                    const decoded = Buffer.from(params.encodedData, 'base64').toString('utf8');
                    result = { success: true, decoded };
                } catch (e) {
                    throw new Error('Invalid base64: ' + e.message );
                }
                break;

            // Web & Network
            case 'fetch_url':
                if (!params.url) {
                    throw new Error('url required' );
                }
                if (isPrivateUrl(params.url)) {
                    throw new Error('URLs targeting private/internal networks are not allowed');
                }
                try {
                    const axios = require('axios');
                    const response = await axios.get(params.url, { timeout: 10000 });
                    result = { success: true, data: response.data, status: response.status };
                } catch (e) {
                    throw new Error('Fetch failed: ' + e.message );
                }
                break;

            case 'http_request':
                if (!params.url || !params.method) {
                    throw new Error('url and method required' );
                }
                if (isPrivateUrl(params.url)) {
                    throw new Error('URLs targeting private/internal networks are not allowed');
                }
                try {
                    const axios = require('axios');
                    const config = {
                        method: params.method,
                        url: params.url,
                        timeout: 10000
                    };
                    if (params.headers) config.headers = params.headers;
                    if (params.body) config.data = params.body;
                    const response = await axios(config);
                    result = { success: true, data: response.data, status: response.status };
                } catch (e) {
                    throw new Error('Request failed: ' + e.message );
                }
                break;

            case 'dns_lookup':
                if (!params.domain) {
                    throw new Error('domain required' );
                }
                const dns = require('dns').promises;
                try {
                    const addresses = await dns.resolve4(params.domain);
                    result = { success: true, addresses };
                } catch (e) {
                    throw new Error('DNS lookup failed: ' + e.message );
                }
                break;

            case 'check_port':
                if (!params.host || !params.port) {
                    throw new Error('host and port required' );
                }
                const net = require('net');
                result = await new Promise((resolve) => {
                    const socket = new net.Socket();
                    const timeout = setTimeout(() => {
                        socket.destroy();
                        resolve({ success: true, open: false, message: 'Connection timeout' });
                    }, 3000);

                    socket.connect(params.port, params.host, () => {
                        clearTimeout(timeout);
                        socket.destroy();
                        resolve({ success: true, open: true, message: 'Port is open' });
                    });

                    socket.on('error', () => {
                        clearTimeout(timeout);
                        socket.destroy();
                        resolve({ success: true, open: false, message: 'Port is closed' });
                    });
                });
                break;

            // System Commands
            case 'netstat':
                const netstatCmd = process.platform === 'win32' ? 'netstat' : 'netstat';
                const netstatArgs = (params.flags || '-tuln').replace(/[;&|`$(){}]/g, '');
                try {
                    const { stdout } = await execPromise(`${netstatCmd} ${netstatArgs}`);
                    result = { success: true, output: stdout };
                } catch (e) {
                    throw new Error('Command failed: ' + e.message );
                }
                break;

            case 'process_list':
                const psCmd = process.platform === 'win32' ? 'tasklist' : 'ps aux';
                try {
                    const { stdout } = await execPromise(psCmd);
                    let output = stdout;
                    if (params.filter) {
                        output = stdout.split('\n').filter(line =>
                            line.toLowerCase().includes(params.filter.toLowerCase())
                        ).join('\n');
                    }
                    result = { success: true, output };
                } catch (e) {
                    throw new Error('Command failed: ' + e.message );
                }
                break;

            case 'system_info':
                const os = require('os');
                result = {
                    success: true,
                    platform: os.platform(),
                    arch: os.arch(),
                    cpus: os.cpus().length,
                    totalMemory: os.totalmem(),
                    freeMemory: os.freemem(),
                    uptime: os.uptime()
                };
                break;

            case 'run_bash':
            case 'run_powershell':
            case 'execute_command':
                if (!params.command) {
                    throw new Error('command required' );
                }
                try {
                    const shell = skillName === 'run_powershell' ? 'powershell' : '/bin/bash';
                    const { stdout, stderr } = await execPromise(params.command, {
                        shell,
                        timeout: params.timeout || 30000
                    });
                    result = { success: true, stdout, stderr };
                } catch (e) {
                    throw new Error('Command failed: ' + e.message );
                }
                break;

            // Code Analysis
            case 'find_patterns':
                if (!params.text || !params.pattern) {
                    throw new Error('text and pattern required' );
                }
                // Reject obviously dangerous regex patterns (catastrophic backtracking)
                if (params.pattern.length > 200) throw new Error('Pattern too long (max 200 chars)');
                if (/(\+\+|\*\*|\{\d+,\}\+|\(\?[^)]*\)\+\+)/.test(params.pattern)) {
                    throw new Error('Pattern contains potentially dangerous constructs');
                }
                try {
                    const regex = new RegExp(params.pattern, params.flags || 'g');
                    const matches = [...params.text.matchAll(regex)];
                    result = { success: true, matches: matches.map(m => ({ match: m[0], index: m.index })) };
                } catch (e) {
                    throw new Error('Invalid regex: ' + e.message );
                }
                break;

            case 'count_lines':
                if (!params.filePath) {
                    throw new Error('filePath required' );
                }
                const fileData = await fs.readFile(params.filePath, 'utf8');
                const fileLines = fileData.split('\n');
                const totalLines = fileLines.length;
                const blankLines = fileLines.filter(l => l.trim() === '').length;
                const codeLines = totalLines - blankLines;
                result = { success: true, totalLines, codeLines, blankLines };
                break;

            case 'git_status':
                const repoPath = params.repoPath || '.';
                // Validate repoPath to prevent path traversal
                const resolvedRepoPath = path.resolve(repoPath);
                if (!resolvedRepoPath.startsWith('/models') && resolvedRepoPath !== path.resolve('.')) {
                    throw new Error('repoPath must be within /models directory');
                }
                try {
                    const { stdout } = await execPromise('git status', { cwd: resolvedRepoPath });
                    result = { success: true, output: stdout };
                } catch (e) {
                    throw new Error('Git command failed: ' + e.message );
                }
                break;

            case 'git_diff':
                const gitRepoPath = params.repoPath || '.';
                // Validate repoPath to prevent path traversal
                const resolvedGitRepoPath = path.resolve(gitRepoPath);
                if (!resolvedGitRepoPath.startsWith('/models') && resolvedGitRepoPath !== path.resolve('.')) {
                    throw new Error('repoPath must be within /models directory');
                }
                const gitArgs = ['diff'];
                if (params.files && Array.isArray(params.files)) {
                    // Sanitize: only allow filenames without shell metacharacters
                    const safeFiles = params.files.filter(f => typeof f === 'string' && !/[;&|`$(){}]/.test(f));
                    gitArgs.push('--', ...safeFiles);
                }
                try {
                    const { stdout } = await execPromise(`git ${gitArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, { cwd: resolvedGitRepoPath });
                    result = { success: true, output: stdout };
                } catch (e) {
                    throw new Error('Git command failed: ' + e.message );
                }
                break;

            default:
                throw new Error(`Skill ${skillName} execution not implemented yet`);
        }

    return result;
}

// ============================================================================
// TASKS API ENDPOINTS
// ============================================================================

// List all tasks (optionally filter by agent)
app.get('/api/tasks', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { agentId } = req.query;

    try {
        let tasks = await loadTasks();

        // Filter by userId first
        tasks = filterByUserId(tasks, req.userId);

        // Then filter by agentId if provided
        if (agentId) {
            tasks = tasks.filter(t => t.agentId === agentId);
        }

        res.json(tasks);
    } catch (error) {
        console.error('Error loading tasks:', error);
        res.status(500).json({ error: 'Failed to load tasks' });
    }
});

// Get a single task
app.get('/api/tasks/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    try {
        const tasks = await loadTasks();
        const task = tasks.find(t => t.id === id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        if (!checkOwnership(task, req.userId)) {
            return res.status(403).json({ error: 'Access denied: task belongs to another user' });
        }
        res.json(task);
    } catch (error) {
        console.error('Error loading task:', error);
        res.status(500).json({ error: 'Failed to load task' });
    }
});

// Create a new task
app.post('/api/tasks', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { agentId, description, priority, collaborators } = req.body;

    if (!agentId || !description) {
        return res.status(400).json({ error: 'Agent ID and description are required' });
    }

    try {
        // Verify agent exists
        const agents = await loadAgents();
        if (!agents.find(a => a.id === agentId)) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const tasks = await loadTasks();
        const newTask = {
            id: crypto.randomBytes(16).toString('hex'),
            agentId,
            description,
            status: 'pending', // pending, in_progress, completed, failed
            priority: priority || 'medium', // low, medium, high
            result: null,
            error: null,
            collaborators: collaborators || [], // Array of agent IDs
            userId: req.userId || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: null
        };

        tasks.push(newTask);
        await saveTasks(tasks);

        res.status(201).json(newTask);
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// Update a task
app.put('/api/tasks/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;
    const { status, result, error, priority } = req.body;

    try {
        const tasks = await loadTasks();
        const taskIndex = tasks.findIndex(t => t.id === id);

        if (taskIndex === -1) {
            return res.status(404).json({ error: 'Task not found' });
        }

        if (!checkOwnership(tasks[taskIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: task belongs to another user' });
        }

        // Update task
        tasks[taskIndex] = {
            ...tasks[taskIndex],
            status: status || tasks[taskIndex].status,
            result: result !== undefined ? result : tasks[taskIndex].result,
            error: error !== undefined ? error : tasks[taskIndex].error,
            priority: priority || tasks[taskIndex].priority,
            updatedAt: new Date().toISOString(),
            completedAt: (status === 'completed' || status === 'failed') ? new Date().toISOString() : tasks[taskIndex].completedAt
        };

        await saveTasks(tasks);
        res.json(tasks[taskIndex]);
    } catch (error) {
        console.error('Error updating task:', error);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// Delete a task
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { id } = req.params;

    try {
        const tasks = await loadTasks();
        const taskIndex = tasks.findIndex(t => t.id === id);

        if (taskIndex === -1) {
            return res.status(404).json({ error: 'Task not found' });
        }

        if (!checkOwnership(tasks[taskIndex], req.userId)) {
            return res.status(403).json({ error: 'Access denied: task belongs to another user' });
        }

        tasks.splice(taskIndex, 1);
        await saveTasks(tasks);

        res.json({ message: 'Task deleted successfully' });
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// ============================================================================
// AGENT PERMISSIONS ENDPOINTS
// ============================================================================

// Get global agent permissions
app.get('/api/agent-permissions', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    try {
        const permissions = await loadAgentPermissions();
        res.json(permissions);
    } catch (error) {
        console.error('Error loading agent permissions:', error);
        res.status(500).json({ error: 'Failed to load permissions' });
    }
});

// Update global agent permissions
app.put('/api/agent-permissions', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { allowFileRead, allowFileWrite, allowFileDelete, allowToolExecution, allowModelAccess, allowCollaboration } = req.body;

    try {
        const permissions = {
            allowFileRead: allowFileRead !== undefined ? allowFileRead : true,
            allowFileWrite: allowFileWrite !== undefined ? allowFileWrite : true,
            allowFileDelete: allowFileDelete !== undefined ? allowFileDelete : true,
            allowToolExecution: allowToolExecution !== undefined ? allowToolExecution : true,
            allowModelAccess: allowModelAccess !== undefined ? allowModelAccess : true,
            allowCollaboration: allowCollaboration !== undefined ? allowCollaboration : true
        };

        await saveAgentPermissions(permissions);
        res.json(permissions);
    } catch (error) {
        console.error('Error updating agent permissions:', error);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
});

// ============================================================================
// AGENT FILE OPERATIONS API
// ============================================================================

// Security: Allowed base directories for agent file operations
// This prevents path traversal attacks (e.g., ../../etc/passwd)
const AGENT_ALLOWED_PATHS = [
    path.resolve('/models'),           // Model files
    path.resolve('/data'),             // Agent data
    path.resolve(process.cwd()),       // Current working directory
    path.resolve(process.env.HOME || '/root'), // User home directory
];

/**
 * Validates a file path against allowed directories to prevent path traversal attacks.
 * @param {string} filePath - The path to validate
 * @returns {{ valid: boolean, resolved: string|null, error: string|null }}
 */
function validateAgentFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return { valid: false, resolved: null, error: 'Invalid file path' };
    }

    // Resolve to absolute path
    const resolved = path.resolve(filePath);

    // Check for symlink attacks
    try {
        const realPath = fs.realpathSync(resolved);
        if (realPath !== resolved) {
            // Path contains symlinks - validate the real path too
            const allowedPrefixes = ['/models', '/tmp'];
            if (!allowedPrefixes.some(prefix => realPath.startsWith(prefix))) {
                return { valid: false, error: 'Symlink target is outside allowed directories' };
            }
        }
    } catch (e) {
        // File doesn't exist yet, which is OK for write operations
    }

    // Check if path starts with any allowed directory
    const isAllowed = AGENT_ALLOWED_PATHS.some(allowedPath => {
        return resolved.startsWith(allowedPath + path.sep) || resolved === allowedPath;
    });

    if (!isAllowed) {
        return {
            valid: false,
            resolved: null,
            error: 'Access denied: Path is outside allowed directories'
        };
    }

    // Additional check: prevent access to sensitive files
    const sensitivePatterns = [
        /\.env$/i,
        /credentials/i,
        /secrets?/i,
        /password/i,
        /\.pem$/i,
        /\.key$/i,
        /id_rsa/i,
        /\.ssh\//i,
    ];

    const isSensitive = sensitivePatterns.some(pattern => pattern.test(resolved));
    if (isSensitive) {
        return {
            valid: false,
            resolved: null,
            error: 'Access denied: Cannot access sensitive files'
        };
    }

    return { valid: true, resolved, error: null };
}

// Read a file (requires agent authentication)
app.post('/api/agent/file/read', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'File path is required' });
    }

    // Security: Validate path to prevent traversal attacks
    const validation = validateAgentFilePath(filePath);
    if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
    }

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileRead) {
            return res.status(403).json({ error: 'File read operations are disabled' });
        }

        // Read file using validated path
        const content = await fs.readFile(validation.resolved, 'utf8');
        res.json({ content, path: validation.resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: 'Failed to read file', details: error.message });
    }
});

// Write a file (requires agent authentication)
app.post('/api/agent/file/write', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { filePath, content } = req.body;
    if (!filePath || content === undefined) {
        return res.status(400).json({ error: 'File path and content are required' });
    }

    // Security: Validate path to prevent traversal attacks
    const validation = validateAgentFilePath(filePath);
    if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
    }

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileWrite) {
            return res.status(403).json({ error: 'File write operations are disabled' });
        }

        // Ensure directory exists using validated path
        const dir = path.dirname(validation.resolved);
        await fs.mkdir(dir, { recursive: true });

        // Write file using validated path
        await fs.writeFile(validation.resolved, content, 'utf8');
        res.json({ message: 'File written successfully', path: validation.resolved });
    } catch (error) {
        console.error('Error writing file:', error);
        res.status(500).json({ error: 'Failed to write file', details: error.message });
    }
});

// Delete a file (requires agent authentication)
app.post('/api/agent/file/delete', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { filePath } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'File path is required' });
    }

    // Security: Validate path to prevent traversal attacks
    const validation = validateAgentFilePath(filePath);
    if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
    }

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileDelete) {
            return res.status(403).json({ error: 'File delete operations are disabled' });
        }

        // Delete file using validated path
        await fs.unlink(validation.resolved);
        res.json({ message: 'File deleted successfully', path: validation.resolved });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: 'Failed to delete file', details: error.message });
    }
});

// List directory contents (requires agent authentication)
app.post('/api/agent/file/list', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { dirPath } = req.body;
    if (!dirPath) {
        return res.status(400).json({ error: 'Directory path is required' });
    }

    // Security: Validate path to prevent traversal attacks
    const validation = validateAgentFilePath(dirPath);
    if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
    }

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileRead) {
            return res.status(403).json({ error: 'File read operations are disabled' });
        }

        // List directory using validated path
        const entries = await fs.readdir(validation.resolved, { withFileTypes: true });
        const files = entries.map(entry => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile()
        }));

        res.json({ files, path: validation.resolved });
    } catch (error) {
        console.error('Error listing directory:', error);
        res.status(500).json({ error: 'Failed to list directory', details: error.message });
    }
});

// Move/rename a file (requires agent authentication)
app.post('/api/agent/file/move', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'agents')) {
        return res.status(403).json({ error: 'Agents permission required' });
    }

    const { sourcePath, destPath } = req.body;
    if (!sourcePath || !destPath) {
        return res.status(400).json({ error: 'Source and destination paths are required' });
    }

    // Security: Validate both paths to prevent traversal attacks
    const sourceValidation = validateAgentFilePath(sourcePath);
    if (!sourceValidation.valid) {
        return res.status(403).json({ error: `Source: ${sourceValidation.error}` });
    }
    const destValidation = validateAgentFilePath(destPath);
    if (!destValidation.valid) {
        return res.status(403).json({ error: `Destination: ${destValidation.error}` });
    }

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileWrite) {
            return res.status(403).json({ error: 'File write operations are disabled' });
        }

        // Ensure destination directory exists using validated path
        const destDir = path.dirname(destValidation.resolved);
        await fs.mkdir(destDir, { recursive: true });

        // Move file using validated paths
        await fs.rename(sourceValidation.resolved, destValidation.resolved);
        res.json({ message: 'File moved successfully', from: sourceValidation.resolved, to: destValidation.resolved });
    } catch (error) {
        console.error('Error moving file:', error);
        res.status(500).json({ error: 'Failed to move file', details: error.message });
    }
});

// ============================================================================
// WEB SEARCH & DOCUMENTATION
// ============================================================================

// Simple in-memory cache for search and docs results
const searchCache = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_CACHE_SIZE = 1000; // Maximum cache entries

// Helper function to clean cache entries older than CACHE_DURATION
function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of searchCache.entries()) {
        if (now - value.timestamp > CACHE_DURATION) {
            searchCache.delete(key);
        }
    }

    // If cache is too large, remove oldest entries
    if (searchCache.size > MAX_CACHE_SIZE) {
        const entries = Array.from(searchCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, Math.floor(MAX_CACHE_SIZE * 0.2));
        toRemove.forEach(([key]) => searchCache.delete(key));
    }
}

/**
 * Extract focused search query from a natural language message.
 * Long conversational prompts (e.g. "Give me a threat report for brambleufer.ru")
 * produce poor search results because the instructional text dilutes the query.
 * This extracts key entities (domains, IPs, hashes, CVEs) and intent keywords.
 */
function extractSearchQuery(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string') return rawQuery;

    const trimmed = rawQuery.trim();

    // Short queries (< 80 chars or < 10 words) are likely already focused
    const wordCount = trimmed.split(/\s+/).length;
    if (trimmed.length < 80 && wordCount < 10) return trimmed;

    // Extract key technical entities
    const entities = [];

    // Domain names (e.g. brambleufer.ru, example.com)
    const domainRegex = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:ru|com|net|org|io|info|biz|xyz|top|cc|tk|cn|de|uk|fr|jp|au|ca|nl|ch|se|no|fi|cz|pl|br|in|co|me|tv|us|eu|gov|edu|mil)\b/gi;
    const domains = trimmed.match(domainRegex);
    if (domains) entities.push(...domains.map(d => d.toLowerCase()));

    // IP addresses
    const ipRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
    const ips = trimmed.match(ipRegex);
    if (ips) entities.push(...ips);

    // SHA256/SHA1/MD5 hashes
    const hashRegex = /\b[a-fA-F0-9]{32,64}\b/g;
    const hashes = trimmed.match(hashRegex);
    if (hashes) entities.push(...hashes);

    // CVE identifiers
    const cveRegex = /CVE-\d{4}-\d{4,}/gi;
    const cves = trimmed.match(cveRegex);
    if (cves) entities.push(...cves);

    // URLs
    const urlRegex = /https?:\/\/[^\s,)}\]]+/gi;
    const urls = trimmed.match(urlRegex);
    if (urls) entities.push(...urls);

    // If no entities found, return original (might be a general question)
    if (entities.length === 0) return trimmed;

    // Extract intent keywords from the message
    const intentKeywords = [];
    const intentPatterns = [
        { pattern: /\b(threat|malware|malicious|phishing|spam|abuse|attack|exploit|vulnerability|ransomware|trojan|botnet|c2|c&c|command.and.control)\b/gi, keep: true },
        { pattern: /\b(report|intelligence|analysis|reputation|score|detection|scan|lookup|whois|dns)\b/gi, keep: true },
        { pattern: /\b(ioc|indicator|compromise|apt|campaign)\b/gi, keep: true },
    ];

    for (const { pattern } of intentPatterns) {
        const matches = trimmed.match(pattern);
        if (matches) {
            intentKeywords.push(...matches.map(m => m.toLowerCase()));
        }
    }

    // Deduplicate
    const uniqueKeywords = [...new Set(intentKeywords)].slice(0, 4);

    // Build focused query: entities + top intent keywords
    const queryParts = [...new Set(entities)];
    if (uniqueKeywords.length > 0) {
        queryParts.push(...uniqueKeywords);
    }

    const extracted = queryParts.join(' ');
    console.log(`[Search] Query extraction: "${trimmed.slice(0, 80)}..." => "${extracted}"`);
    return extracted;
}

/**
 * Smart truncation that preserves both beginning (context) and end (recent data) of content.
 * Many data pages (e.g. EIA gas prices, stock tables) have recent data at the end.
 * Simple .slice(0, maxLength) cuts off exactly the data users most need.
 */
function smartTruncate(content, maxLength) {
    if (!content || content.length <= maxLength) return content;

    // Reserve 30% for the beginning (title, context) and 70% for the end (recent data)
    const headSize = Math.floor(maxLength * 0.3);
    const tailSize = maxLength - headSize - 50; // 50 chars for separator

    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);

    return head + '\n\n[... earlier content omitted ...]\n\n' + tail;
}

// Web search endpoint using DuckDuckGo HTML parsing
// Now with optional content fetching for richer results
app.get('/api/search', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required for web search' });
    }

    const { q, limit = 5, timeRange, fetchContent = 'false', contentLimit = 3 } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    // Extract focused search terms from natural language queries
    const extractedQuery = extractSearchQuery(q);

    // Enhance query with current year/month for "recent" or "latest" queries
    let enhancedQuery = extractedQuery;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.toLocaleString('en-US', { month: 'long' });

    // If query contains "recent", "latest", "news", etc. and doesn't already have a year
    if (/(recent|latest|current|new|today|news)/i.test(q) && !/(202\d|201\d)/i.test(q)) {
        enhancedQuery = `${q} ${currentMonth} ${currentYear}`;
    }

    // Determine date filter parameter for DuckDuckGo
    // df=d (past day), df=w (past week), df=m (past month), df=y (past year)
    let dateFilter = '';
    if (timeRange) {
        dateFilter = `&df=${timeRange}`;
    } else if (/(recent|latest|current|today|news)/i.test(q)) {
        // Auto-apply "past month" filter for recent/news queries
        dateFilter = '&df=m';
    }

    // Check cache first (include fetchContent in cache key)
    const shouldFetchContent = fetchContent === 'true';
    const cacheKey = `search:${enhancedQuery}:${limit}:${dateFilter}:${shouldFetchContent}:${contentLimit}`;
    cleanExpiredCache();

    if (searchCache.has(cacheKey)) {
        const cached = searchCache.get(cacheKey);
        return res.json({ ...cached.data, cached: true });
    }

    try {
        const results = [];
        const seenUrls = new Set(); // Deduplication
        let searchSource = 'duckduckgo';

        // Try DuckDuckGo first, fall back to Jina if CAPTCHA detected
        try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(enhancedQuery)}${dateFilter}`;
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                timeout: 8000
            });

            const html = response.data;

            // Check for CAPTCHA/bot detection (anomaly-modal indicates CAPTCHA)
            if (html.includes('anomaly-modal') || html.includes('Please enable JavaScript')) {
                throw new Error('CAPTCHA_DETECTED');
            }

            // Parse DuckDuckGo HTML results
            const resultRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
            const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

            let match;
            while ((match = resultRegex.exec(html)) !== null && results.length < parseInt(limit)) {
                const resultHtml = match[1];
                const titleMatch = titleRegex.exec(resultHtml);
                const snippetMatch = snippetRegex.exec(resultHtml);

                if (titleMatch) {
                    const url = titleMatch[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0];
                    const decodedUrl = decodeURIComponent(url);
                    const title = titleMatch[2].replace(/<[^>]*>/g, '').trim();
                    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';

                    if (decodedUrl && decodedUrl.startsWith('http') && !seenUrls.has(decodedUrl)) {
                        seenUrls.add(decodedUrl);
                        results.push({
                            title: title || 'No title',
                            url: decodedUrl,
                            snippet: snippet || 'No description available',
                            content: null
                        });
                    }
                }
            }

            // If no results from DDG, fall back to Jina
            if (results.length === 0) {
                throw new Error('NO_RESULTS');
            }
        } catch (ddgError) {
            // Try Scrapling first (anti-bot capabilities for CAPTCHA evasion)
            console.log(`DuckDuckGo failed (${ddgError.message}), trying Scrapling...`);

            let scraplingSucceeded = false;
            if (scraplingService) {
            try {
                const scraplingResult = await scraplingService.search(enhancedQuery, parseInt(limit));
                if (scraplingResult.success && scraplingResult.results && scraplingResult.results.length > 0) {
                    searchSource = 'scrapling';
                    scraplingSucceeded = true;
                    for (const r of scraplingResult.results) {
                        if (r.url && !seenUrls.has(r.url)) {
                            seenUrls.add(r.url);
                            results.push({
                                title: r.title || 'No title',
                                url: r.url,
                                snippet: r.snippet || 'No description available',
                                content: null
                            });
                        }
                    }
                    console.log(`Scrapling returned ${results.length} results`);
                }
            } catch (scraplingError) {
                console.log(`Scrapling failed (${scraplingError.message})`);
            }
            } // End of scraplingService check

            // Fall back to Brave Search if Scrapling didn't work
            if (!scraplingSucceeded || results.length === 0) {
                console.log(`Falling back to Brave Search`);
                searchSource = 'brave';

            try {
                const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(enhancedQuery)}`;
                const braveResponse = await axios.get(braveUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    timeout: 10000
                });

                const braveHtml = braveResponse.data;

                // Updated Brave Search parsing - matches current HTML structure
                // Brave uses svelte classes like "svelte-14r20fy l1" for result links
                // Extract all external URLs with their context
                const linkPattern = /<a\s+href="(https?:\/\/(?!(?:search\.)?brave\.com|cdn\.search\.brave\.com|imgs\.search\.brave\.com|tiles\.search\.brave\.com)[^"]+)"[^>]*target="_self"[^>]*class="[^"]*svelte[^"]*"[^>]*>/gi;

                let match;
                const urlsFound = [];
                while ((match = linkPattern.exec(braveHtml)) !== null) {
                    const url = match[1];
                    if (url && !url.includes('brave.com') && !seenUrls.has(url)) {
                        urlsFound.push(url);
                    }
                }

                // Extract titles - look for title class spans near result links
                const titlePattern = /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/gi;
                const titles = [];
                while ((match = titlePattern.exec(braveHtml)) !== null) {
                    titles.push(match[1].trim());
                }

                // Extract descriptions
                const descPattern = /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
                const descriptions = [];
                while ((match = descPattern.exec(braveHtml)) !== null) {
                    descriptions.push(match[1].replace(/<[^>]*>/g, '').trim());
                }

                // Build results - deduplicate and limit
                for (let i = 0; i < urlsFound.length && results.length < parseInt(limit); i++) {
                    const url = urlsFound[i];
                    if (!seenUrls.has(url)) {
                        seenUrls.add(url);
                        // Try to extract domain for title fallback
                        let title = titles[i] || '';
                        if (!title) {
                            try {
                                title = new URL(url).hostname.replace('www.', '');
                            } catch (e) {
                                title = 'Web Result';
                            }
                        }
                        results.push({
                            title: title,
                            url: url,
                            snippet: descriptions[i] || 'Result from Brave Search',
                            content: null
                        });
                    }
                }

                // If still no results, try Playwright for JS-rendered content
                if (results.length === 0 && playwrightService) {
                    console.log('Brave HTML parsing failed, trying Playwright...');
                    searchSource = 'brave-playwright';
                    try {
                        const pwResult = await playwrightService.fetch(braveUrl, {
                            timeout: 20000,
                            waitForJS: true,
                            includeLinks: true,
                            maxLength: 50000
                        });

                        if (pwResult.success && pwResult.links) {
                            // Filter to external links only
                            const externalLinks = pwResult.links.filter(link =>
                                link.href &&
                                link.href.startsWith('http') &&
                                !link.href.includes('brave.com') &&
                                !seenUrls.has(link.href)
                            );

                            for (const link of externalLinks.slice(0, parseInt(limit))) {
                                if (!seenUrls.has(link.href)) {
                                    seenUrls.add(link.href);
                                    results.push({
                                        title: link.text || link.href,
                                        url: link.href,
                                        snippet: 'Result from Brave Search',
                                        content: null
                                    });
                                }
                            }
                        }
                    } catch (pwError) {
                        console.error('Playwright Brave search failed:', pwError.message);
                    }
                }
            } catch (braveError) {
                console.error('Brave search also failed:', braveError.message);
                // Continue with empty results if all methods fail
            }
            } // End of Scrapling fallback conditional
        }

        // Optionally fetch actual content from top URLs (in parallel)
        let contentFetchedCount = 0;
        if (shouldFetchContent && results.length > 0) {
            const urlsToFetch = results.slice(0, parseInt(contentLimit));

            const fetchPromises = urlsToFetch.map(async (result) => {
                const fetchResult = await fetchUrlContent(result.url, { waitForJS: true });
                if (fetchResult.success) {
                    result.content = fetchResult.content;
                    result.contentFetched = true;
                } else {
                    result.contentFetched = false;
                    result.fetchError = fetchResult.error;
                }
                return result;
            });

            await Promise.all(fetchPromises);
            contentFetchedCount = results.filter(r => r.contentFetched).length;
        }

        const resultData = {
            query: q,
            enhancedQuery: enhancedQuery !== q ? enhancedQuery : undefined,
            results,
            count: results.length,
            contentFetchedCount: shouldFetchContent ? contentFetchedCount : undefined,
            source: searchSource
        };

        // Cache the results
        searchCache.set(cacheKey, {
            data: resultData,
            timestamp: Date.now()
        });

        res.json(resultData);
    } catch (error) {
        console.error('Search error:', error);

        // Provide specific error messages based on error type
        let errorMsg = 'Search failed';
        let statusCode = 500;
        let retryable = false;

        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            errorMsg = 'Search request timed out';
            statusCode = 504;
            retryable = true;
        } else if (error.response?.status === 403) {
            errorMsg = 'Search service temporarily unavailable';
            statusCode = 503;
            retryable = true;
        } else if (error.response?.status === 429) {
            errorMsg = 'Too many search requests';
            statusCode = 429;
            retryable = true;
        } else if (!error.response) {
            errorMsg = 'Unable to reach search service';
            statusCode = 503;
            retryable = true;
        }

        res.status(statusCode).json({
            success: false,
            error: errorMsg,
            retryable
        });
    }
});

// Helper function to extract readable text content from HTML
function extractTextFromHtml(html, maxLength = 5000) {
    if (!html) return '';

    // Remove script and style elements
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
    text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ');
    text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ');
    text = text.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Extract meta description
    const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                          html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';

    // Extract article content (prioritize article, main, or content divs)
    const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/gi) ||
                         text.match(/<main[^>]*>([\s\S]*?)<\/main>/gi) ||
                         text.match(/<div[^>]*(?:class|id)=["'][^"']*(?:content|article|post|story|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);

    let mainContent = '';
    if (articleMatch && articleMatch.length > 0) {
        mainContent = articleMatch.join(' ');
    } else {
        // Fall back to body content
        const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        mainContent = bodyMatch ? bodyMatch[1] : text;
    }

    // Extract paragraphs
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(mainContent)) !== null) {
        const pText = pMatch[1].replace(/<[^>]*>/g, ' ').trim();
        if (pText.length > 50) { // Only include substantial paragraphs
            paragraphs.push(pText);
        }
    }

    // Also extract headings for context
    const headings = [];
    const hRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
    let hMatch;
    while ((hMatch = hRegex.exec(mainContent)) !== null) {
        const hText = hMatch[1].replace(/<[^>]*>/g, ' ').trim();
        if (hText.length > 3) {
            headings.push(hText);
        }
    }

    // Build final content
    let content = '';
    if (title) content += `Title: ${title}\n\n`;
    if (metaDesc) content += `Summary: ${metaDesc}\n\n`;
    if (headings.length > 0) content += `Key Points:\n- ${headings.slice(0, 5).join('\n- ')}\n\n`;
    if (paragraphs.length > 0) content += `Content:\n${paragraphs.join('\n\n')}`;

    // Clean up whitespace and entities
    content = content.replace(/&nbsp;/g, ' ')
                     .replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>')
                     .replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/&[a-z]+;/gi, ' ')
                     .replace(/\s+/g, ' ')
                     .replace(/\n\s*\n/g, '\n\n')
                     .trim();

    // Truncate if too long
    if (content.length > maxLength) {
        content = content.substring(0, maxLength) + '... [truncated]';
    }

    return content;
}

// Helper function to fetch content from a URL using axios (fallback)
async function fetchUrlContentAxios(url, timeout = 8000) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
            },
            timeout: timeout,
            maxRedirects: 3,
            validateStatus: (status) => status < 400,
        });

        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
            return { success: false, error: 'Not HTML content' };
        }

        const content = extractTextFromHtml(response.data);
        return { success: true, content, url };
    } catch (error) {
        return {
            success: false,
            error: error.code || error.message || 'Fetch failed',
            url
        };
    }
}

// Patterns that indicate a page requires JavaScript rendering (content is not useful)
const JS_REQUIRED_PATTERNS = [
    /please enable javascript/i,
    /javascript is required/i,
    /javascript must be enabled/i,
    /this page requires javascript/i,
    /you need to enable javascript/i,
    /browser does not support javascript/i,
    /noscript/i,
    /loading\.\.\./i,
];

// Check if content is too thin or indicates JS-only page
function isContentTooThin(content, url) {
    if (!content) return true;
    const trimmed = content.trim();
    // Short content likely means JS didn't render or extraction got ads/nav only
    if (trimmed.length < 500) return true;
    // Check for JS-required boilerplate patterns
    for (const pattern of JS_REQUIRED_PATTERNS) {
        if (pattern.test(trimmed) && trimmed.length < 1000) return true;
    }
    return false;
}


// File extensions and content-types that should be downloaded as binary/text files
// instead of scraped as HTML pages
const DIRECT_DOWNLOAD_EXTENSIONS = {
    // Documents
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    // Text/code
    txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    xml: 'application/xml', md: 'text/markdown', log: 'text/plain',
    yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
    ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
    // Code
    js: 'text/plain', ts: 'text/plain', py: 'text/plain',
    java: 'text/plain', go: 'text/plain', rs: 'text/plain',
    c: 'text/plain', cpp: 'text/plain', h: 'text/plain',
    cs: 'text/plain', rb: 'text/plain', php: 'text/plain',
    sh: 'text/plain', sql: 'text/plain', jsx: 'text/plain', tsx: 'text/plain',
    // Spreadsheets
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
};

const DIRECT_DOWNLOAD_CONTENT_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json', 'application/xml',
];

/**
 * Repair URLs broken across lines by PDF text extraction.
 * pdf-parse often splits URLs at line boundaries, producing truncated links
 * that models cannot recognize or follow.
 */
function repairPdfUrls(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Check if line ends with a URL that looks truncated
        const urlMatch = line.match(/(https?:\/\/\S+)$/);
        if (urlMatch) {
            let url = urlMatch[1];
            let joinedExtra = '';
            // Look ahead: join continuation lines that look like URL path fragments
            while (i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const trimmed = nextLine.trimStart();
                // Continuation: starts with path-like chars and isn't a new URL or sentence
                if (trimmed && /^[a-z0-9/\-_.#?&=%+~]/.test(trimmed) && !/^https?:\/\//.test(trimmed)) {
                    const fragment = trimmed.split(/\s/)[0].replace(/[.,;:)"'>\]]+$/, '');
                    if (fragment) {
                        url += fragment;
                        const remainder = trimmed.slice(fragment.length).trim();
                        joinedExtra = remainder;
                        i++;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            const prefix = line.slice(0, line.length - urlMatch[1].length);
            result.push(prefix + url + (joinedExtra ? ' ' + joinedExtra : ''));
        } else {
            result.push(line);
        }
        i++;
    }
    return result.join('\n');
}

/**
 * Download a URL as a file and extract text content.
 * Handles PDF, DOCX, TXT, CSV, JSON, code files, etc.
 * Returns null if the URL is not a downloadable file type.
 */
async function fetchUrlAsFile(url, options = {}) {
    const timeout = options.timeout || 30000;
    const maxLength = options.maxLength || 50000; // Files need much more than HTML pages

    // Check extension from URL (strip query params)
    const urlPath = url.split('?')[0].split('#')[0];
    let ext = urlPath.split('.').pop().toLowerCase();
    let isKnownFileExt = ext in DIRECT_DOWNLOAD_EXTENSIONS;

    // If URL extension doesn't match, check query parameters for file type hints
    // Handles URLs like ?pdf=download, ?format=pdf, ?type=csv, ?output=xlsx
    if (!isKnownFileExt) {
        try {
            const urlObj = new URL(url);
            for (const [key, value] of urlObj.searchParams) {
                const keyLower = key.toLowerCase();
                const valueLower = value.toLowerCase();
                // Param key IS a file type (e.g., ?pdf=download)
                if (keyLower in DIRECT_DOWNLOAD_EXTENSIONS) {
                    ext = keyLower;
                    isKnownFileExt = true;
                    console.log(`[fetchUrlAsFile] Detected file type '${ext}' from query param key: ${key}=${value}`);
                    break;
                }
                // Param value IS a file type (e.g., ?format=pdf, ?output=csv)
                if (valueLower in DIRECT_DOWNLOAD_EXTENSIONS) {
                    ext = valueLower;
                    isKnownFileExt = true;
                    console.log(`[fetchUrlAsFile] Detected file type '${ext}' from query param value: ${key}=${value}`);
                    break;
                }
            }
        } catch (e) {
            // Invalid URL, skip query param check
        }
    }

    // If still no match, try a HEAD request to check Content-Type / Content-Disposition
    if (!isKnownFileExt) {
        try {
            const headResponse = await axios.head(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
                timeout: 5000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400,
            });

            // Check Content-Disposition for filename (most reliable indicator)
            const disposition = headResponse.headers['content-disposition'] || '';
            const filenameMatch = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";\n]+)/i);
            if (filenameMatch) {
                const fileExt = filenameMatch[1].trim().split('.').pop().toLowerCase();
                if (fileExt in DIRECT_DOWNLOAD_EXTENSIONS) {
                    ext = fileExt;
                    isKnownFileExt = true;
                    console.log(`[fetchUrlAsFile] HEAD detected file type '${ext}' from Content-Disposition: ${disposition}`);
                }
            }

            // Fall back to Content-Type header
            if (!isKnownFileExt) {
                const contentType = (headResponse.headers['content-type'] || '').toLowerCase();
                if (DIRECT_DOWNLOAD_CONTENT_TYPES.some(ct => contentType.includes(ct)) && !contentType.includes('text/html')) {
                    if (contentType.includes('application/pdf')) ext = 'pdf';
                    else if (contentType.includes('wordprocessingml')) ext = 'docx';
                    else if (contentType.includes('msword')) ext = 'doc';
                    else if (contentType.includes('spreadsheetml')) ext = 'xlsx';
                    else if (contentType.includes('ms-excel')) ext = 'xls';
                    else if (contentType.includes('text/csv')) ext = 'csv';
                    else if (contentType.includes('application/json')) ext = 'json';
                    else if (contentType.includes('application/xml')) ext = 'xml';
                    else if (contentType.includes('text/markdown')) ext = 'md';
                    else if (contentType.includes('text/plain')) ext = 'txt';
                    isKnownFileExt = true;
                    console.log(`[fetchUrlAsFile] HEAD detected file type '${ext}' from Content-Type: ${contentType}`);
                }
            }
        } catch (e) {
            // HEAD failed (405, timeout, etc.) — fall through to HTML scraping
        }
    }

    if (!isKnownFileExt) return null;

    try {
        // Download the file as binary
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
            },
            timeout,
            maxRedirects: 5,
            responseType: 'arraybuffer',
            validateStatus: (status) => status < 400,
            maxContentLength: 50 * 1024 * 1024, // 50MB limit
        });

        const contentType = (response.headers['content-type'] || '').toLowerCase();
        const buffer = Buffer.from(response.data);

        // If response is HTML but we expected a file (from query params or HEAD),
        // the server returned an error/login page instead — fall through to HTML scraping
        if (contentType.includes('text/html')) {
            console.log(`[fetchUrlAsFile] Expected file type '${ext}' but server returned HTML — falling through to HTML scraping`);
            return null;
        }

        const filename = decodeURIComponent(urlPath.split('/').pop() || `download.${ext}`);
        let extractedText = '';
        let title = filename;

        console.log(`[fetchUrlAsFile] Downloaded ${filename} (${buffer.length} bytes, type: ${contentType})`);

        // PDF parsing
        if (ext === 'pdf' || contentType.includes('application/pdf')) {
            try {
                const pdfParse = require('pdf-parse');
                const data = await pdfParse(buffer);
                extractedText = repairPdfUrls(data.text || '');
                title = data.info?.Title || filename;
                if (data.numpages) {
                    title += ` (${data.numpages} pages)`;
                }
            } catch (e) {
                console.error(`[fetchUrlAsFile] PDF parse failed: ${e.message} — falling through to HTML scraping`);
                return null;
            }
        }
        // DOCX parsing
        else if (ext === 'docx' || contentType.includes('wordprocessingml')) {
            try {
                const mammoth = require('mammoth');
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value || '';
                title = filename;
            } catch (e) {
                console.error(`[fetchUrlAsFile] DOCX parse failed: ${e.message} — falling through to HTML scraping`);
                return null;
            }
        }
        // XLSX/XLS - extract as text
        else if (ext === 'xlsx' || ext === 'xls' || contentType.includes('spreadsheetml') || contentType.includes('ms-excel')) {
            try {
                // xlsx package may not be installed, fall back gracefully
                const XLSX = require('xlsx');
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheets = [];
                for (const sheetName of workbook.SheetNames) {
                    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                    if (csv.trim()) {
                        sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`);
                    }
                }
                extractedText = sheets.join('\n\n');
                title = filename;
            } catch (e) {
                console.warn(`[fetchUrlAsFile] XLSX parse not available: ${e.message} — falling through to HTML scraping`);
                return null;
            }
        }
        // Text-based files (txt, csv, json, xml, md, code files, etc.)
        else {
            extractedText = buffer.toString('utf-8');
            title = filename;
        }

        if (!extractedText || !extractedText.trim()) {
            return { success: false, error: 'No text content extracted from file', url };
        }

        return {
            success: true,
            url,
            content: smartTruncate(extractedText, maxLength),
            title,
            source: 'direct-download',
        };
    } catch (error) {
        console.error(`[fetchUrlAsFile] Download failed for ${url}: ${error.message}`);
        // Return null to fall through to HTML scraping pipeline
        return null;
    }
}

// Helper function to fetch content from a URL with timeout
// Uses direct file download → Scrapling → Playwright (with XHR interception) → axios fallback chain
async function fetchUrlContent(url, options = {}) {
    const timeout = options.timeout || 12000;
    const maxLength = options.maxLength || 12000;

    // Try direct file download first (PDF, DOCX, TXT, code files, etc.)
    // This avoids wasting time on Scrapling/Playwright for binary files
    const fileResult = await fetchUrlAsFile(url, { timeout, maxLength });
    if (fileResult) return fileResult;

    // Try Scrapling first if available (best CAPTCHA evasion)
    if (scraplingService) {
        try {
            const scraplingResult = await scraplingService.fetchUrl(url, {
                timeout,
                extractLinks: options.includeLinks || false
            });

            if (scraplingResult.success && scraplingResult.content && !isContentTooThin(scraplingResult.content, url)) {
                return {
                    success: true,
                    url,
                    content: smartTruncate(scraplingResult.content, maxLength),
                    title: scraplingResult.title || '',
                    links: scraplingResult.links || [],
                    source: 'scrapling'
                };
            }
            // Content too thin or JS-required — fall through to Playwright for JS rendering
            if (scraplingResult.success && isContentTooThin(scraplingResult.content, url)) {
                console.log(`[fetchUrlContent] Scrapling returned thin content for ${url} (${(scraplingResult.content || '').length} chars), trying Playwright for JS rendering`);
            }
        } catch (scraplingError) {
            console.log(`Scrapling fetch failed for ${url}: ${scraplingError.message}`);
        }
    }

    // Use Playwright if available (handles JS-rendered pages, avoids bot detection)
    if (playwrightEnabled && playwrightService) {
        try {
            const result = await playwrightService.fetchUrlContent(url, {
                timeout: Math.max(timeout, 20000), // Allow more time for JS-heavy pages
                waitForJS: options.waitForJS !== false,
                maxLength: options.maxLength || 6000,
                includeLinks: options.includeLinks || false
            });

            if (result.success) {
                return { ...result, source: 'playwright' };
            }

            // If Playwright fails, fall back to axios for simple HTML pages
            console.log(`Playwright fetch failed for ${url}, trying axios fallback`);
            return await fetchUrlContentAxios(url, timeout);
        } catch (error) {
            console.error(`Playwright error for ${url}:`, error.message);
            return await fetchUrlContentAxios(url, timeout);
        }
    }

    // Fallback to axios
    return await fetchUrlContentAxios(url, timeout);
}

// URL fetch endpoint for chat - fetches content from URLs in messages
app.post('/api/url/fetch', requireAuth, async (req, res) => {
    const { urls, maxLength = 50000, timeout = 30000 } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'URLs array required' });
    }

    // Limit to 3 URLs per request
    const urlsToFetch = urls.slice(0, 3);

    try {
        const results = await Promise.all(
            urlsToFetch.map(async (url) => {
                try {
                    const result = await fetchUrlContent(url, {
                        timeout,
                        maxLength,
                        waitForJS: true,
                    });

                    if (result.success) {
                        return {
                            url,
                            success: true,
                            content: result.content?.slice(0, maxLength) || '',
                            title: result.title || '',
                            source: result.source || 'unknown',
                        };
                    } else {
                        return {
                            url,
                            success: false,
                            error: result.error || 'Fetch failed',
                        };
                    }
                } catch (error) {
                    return {
                        url,
                        success: false,
                        error: error.message || 'Fetch failed',
                    };
                }
            })
        );

        res.json({ results });
    } catch (error) {
        console.error('URL fetch error:', error);
        res.status(500).json({
            error: error.message || 'Failed to fetch URLs',
        });
    }
});

// Playwright fetch endpoint - advanced web scraping with stealth mode
app.post('/api/playwright/fetch', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    const { url, urls, timeout = 15000, waitForJS = true, includeLinks = false, screenshot = false, maxLength = 8000, rawHtml = false, waitForSelector } = req.body;

    if (!url && !urls) {
        return res.status(400).json({ error: 'URL or URLs array required' });
    }

    // Check if Playwright is available
    if (!playwrightEnabled || !playwrightService) {
        // Fall back to axios-based fetching
        if (url) {
            const result = await fetchUrlContentAxios(url, timeout);
            return res.json({ ...result, engine: 'axios' });
        } else {
            const results = await Promise.all(
                urls.slice(0, 10).map(u => fetchUrlContentAxios(u, timeout))
            );
            return res.json({ results, engine: 'axios' });
        }
    }

    try {
        if (url) {
            // Single URL fetch
            const result = await playwrightService.fetchUrlContent(url, {
                timeout,
                waitForJS,
                includeLinks,
                screenshot,
                maxLength,
                rawHtml,
                waitForSelector
            });
            return res.json({ ...result, engine: 'playwright' });
        } else {
            // Multiple URL fetch
            const results = await playwrightService.fetchMultipleUrls(
                urls.slice(0, 10),
                { timeout, waitForJS, includeLinks, maxLength, rawHtml, waitForSelector },
                3 // concurrency
            );
            return res.json({ results, engine: 'playwright' });
        }
    } catch (error) {
        console.error('Playwright fetch error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            engine: 'playwright'
        });
    }
});

// Playwright interact endpoint - advanced page interaction
app.post('/api/playwright/interact', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    const { url, actions = [], timeout = 30000, maxLength = 8000 } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    if (!playwrightEnabled || !playwrightService) {
        return res.status(503).json({
            success: false,
            error: 'Playwright not available - interaction requires browser automation'
        });
    }

    try {
        const result = await playwrightService.interactAndFetch(url, actions, { timeout, maxLength });
        res.json({ ...result, engine: 'playwright' });
    } catch (error) {
        console.error('Playwright interact error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            engine: 'playwright'
        });
    }
});

// Playwright status endpoint
app.get('/api/playwright/status', requireAuth, (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'query permission required' });
    }

    if (playwrightEnabled && playwrightService) {
        const poolStatus = playwrightService.getPoolStatus();
        res.json({
            enabled: true,
            status: 'ready',
            browserPool: poolStatus,
            features: ['stealth', 'js-rendering', 'interaction', 'screenshots']
        });
    } else {
        res.json({
            enabled: false,
            status: 'unavailable',
            fallback: 'axios'
        });
    }
});

// Documentation endpoint - fetch from DevDocs.io
app.get('/api/docs', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'query permission required' });
    }

    const { library, query } = req.query;

    if (!library) {
        return res.status(400).json({ error: 'Library parameter is required' });
    }

    // Check cache first
    const cacheKey = `docs:${library}:${query || 'index'}`;
    cleanExpiredCache();

    if (searchCache.has(cacheKey)) {
        const cached = searchCache.get(cacheKey);
        return res.json({ ...cached.data, cached: true });
    }

    try {
        // Map common library names to DevDocs slugs
        const libraryMap = {
            'javascript': 'javascript',
            'js': 'javascript',
            'node': 'node',
            'nodejs': 'node',
            'python': 'python~3.12',
            'py': 'python~3.12',
            'react': 'react',
            'vue': 'vue~3',
            'angular': 'angular',
            'express': 'express',
            'django': 'django~5.0',
            'flask': 'flask~3.0',
            'typescript': 'typescript',
            'ts': 'typescript',
            'docker': 'docker',
            'git': 'git',
            'bash': 'bash',
            'css': 'css',
            'html': 'html',
            'mdn': 'mdn'
        };

        const slug = libraryMap[library.toLowerCase()] || library.toLowerCase();

        // If no specific query, fetch the index
        if (!query) {
            const indexUrl = `https://docs.devdocs.io/${slug}/index.json`;
            const response = await axios.get(indexUrl, { timeout: 10000 });

            const entries = response.data.entries || [];
            const topEntries = entries.slice(0, 10).map(entry => ({
                name: entry.name,
                path: entry.path,
                type: entry.type || 'reference'
            }));

            const resultData = {
                library: slug,
                type: 'index',
                entries: topEntries,
                count: topEntries.length,
                total: entries.length
            };

            // Cache the results
            searchCache.set(cacheKey, {
                data: resultData,
                timestamp: Date.now()
            });

            return res.json(resultData);
        }

        // Search for specific documentation
        const indexUrl = `https://docs.devdocs.io/${slug}/index.json`;
        const response = await axios.get(indexUrl, { timeout: 10000 });

        const entries = response.data.entries || [];
        const searchTerm = query.toLowerCase();
        const matches = entries
            .filter(entry => entry.name.toLowerCase().includes(searchTerm))
            .slice(0, 10)
            .map(entry => ({
                name: entry.name,
                path: entry.path,
                type: entry.type || 'reference',
                url: `https://devdocs.io/${slug}/${entry.path}`
            }));

        const resultData = {
            library: slug,
            query: query,
            type: 'search',
            results: matches,
            count: matches.length
        };

        // Cache the results
        searchCache.set(cacheKey, {
            data: resultData,
            timestamp: Date.now()
        });

        res.json(resultData);
    } catch (error) {
        console.error('Documentation fetch error:', error);
        res.status(500).json({
            error: 'Failed to fetch documentation',
            details: error.message
        });
    }
});

// ============================================================================
// CONVERSATION MANAGEMENT API
// ============================================================================

const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

// Ensure conversations directory exists for a user
async function ensureUserConversationsDir(userId) {
    const userDir = path.join(CONVERSATIONS_DIR, userId);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

// Load conversations index for a user
async function loadConversationsIndex(userId) {
    const userDir = await ensureUserConversationsDir(userId);
    const indexPath = path.join(userDir, 'index.json');
    try {
        const data = await fs.readFile(indexPath, 'utf8');
        if (!data || !data.trim()) return []; // Handle empty files
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        if (error instanceof SyntaxError) {
            console.error(`Corrupted conversations index for user ${userId}, resetting to empty`);
            return []; // Handle corrupted JSON
        }
        throw error;
    }
}

// Save conversations index for a user
async function saveConversationsIndex(userId, conversations) {
    const userDir = await ensureUserConversationsDir(userId);
    const indexPath = path.join(userDir, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(conversations, null, 2));
}

// Load messages for a conversation
async function loadConversationMessages(userId, conversationId) {
    // Validate conversationId format to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        throw new Error('Invalid conversation ID format');
    }
    const userDir = await ensureUserConversationsDir(userId);
    const messagesPath = path.join(userDir, `${conversationId}.json`);
    try {
        const data = await fs.readFile(messagesPath, 'utf8');
        if (!data || !data.trim()) return []; // Handle empty files
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        if (error instanceof SyntaxError) {
            console.error(`Corrupted conversation ${conversationId} for user ${userId}`);
            return []; // Handle corrupted JSON
        }
        throw error;
    }
}

// Save messages for a conversation
async function saveConversationMessages(userId, conversationId, messages) {
    // Validate conversationId format to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        throw new Error('Invalid conversation ID format');
    }
    const userDir = await ensureUserConversationsDir(userId);
    const messagesPath = path.join(userDir, `${conversationId}.json`);
    await fs.writeFile(messagesPath, JSON.stringify(messages, null, 2));

    // Update messageCount in conversations index
    try {
        const conversations = await loadConversationsIndex(userId);
        const conv = conversations.find(c => c.id === conversationId);
        if (conv) {
            conv.messageCount = messages.length;
            conv.updatedAt = new Date().toISOString();
            await saveConversationsIndex(userId, conversations);
        }
    } catch (e) {
        // Non-critical - don't fail message save if index update fails
    }
}

// List all conversations for a user
app.get('/api/conversations', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const conversations = await loadConversationsIndex(userId);

        // Backfill messageCount for conversations missing it
        let needsSave = false;
        for (const conv of conversations) {
            if (conv.messageCount === undefined) {
                try {
                    const msgs = await loadConversationMessages(userId, conv.id);
                    conv.messageCount = msgs.length;
                    needsSave = true;
                } catch {
                    conv.messageCount = 0;
                }
            }
        }
        if (needsSave) {
            await saveConversationsIndex(userId, conversations).catch(() => {});
        }

        res.json(conversations);
    } catch (error) {
        console.error('Error loading conversations:', error);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// Create a new conversation
app.post('/api/conversations', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { title } = req.body;

        const conversation = {
            id: crypto.randomUUID(),
            title: title || 'New Conversation',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const conversations = await loadConversationsIndex(userId);
        conversations.unshift(conversation);
        await saveConversationsIndex(userId, conversations);

        // Create empty messages file
        await saveConversationMessages(userId, conversation.id, []);

        res.json(conversation);
    } catch (error) {
        console.error('Error creating conversation:', error);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

// Get a specific conversation with messages
app.get('/api/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;

        const conversations = await loadConversationsIndex(userId);
        const conversation = conversations.find(c => c.id === id);

        if (!conversation) {
            // Return empty conversation instead of 404 - handles race conditions
            // where frontend creates conversation ID before backend saves it
            return res.json({
                id,
                title: 'New Conversation',
                createdAt: new Date().toISOString(),
                messages: []
            });
        }

        const messages = await loadConversationMessages(userId, id);
        res.json({ ...conversation, messages });
    } catch (error) {
        console.error('Error loading conversation:', error);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Update a conversation (title, favorite, etc.)
app.put('/api/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;
        const { title, favorite } = req.body;

        const conversations = await loadConversationsIndex(userId);
        const index = conversations.findIndex(c => c.id === id);

        // Auto-create conversation entry if not found (handles race conditions
        // where frontend sends update before index is fully saved)
        if (index === -1) {
            const newConversation = {
                id,
                title: title || 'New Conversation',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            if (favorite !== undefined) {
                newConversation.favorite = Boolean(favorite);
            }
            conversations.unshift(newConversation);
            await saveConversationsIndex(userId, conversations);
            return res.json(newConversation);
        }

        // Build update object
        const updates = {
            ...conversations[index],
            updatedAt: new Date().toISOString()
        };

        // Only update title if provided
        if (title !== undefined) {
            updates.title = title;
        }

        // Only update favorite if provided (allow toggling on/off)
        if (favorite !== undefined) {
            updates.favorite = Boolean(favorite);
        }

        conversations[index] = updates;

        await saveConversationsIndex(userId, conversations);
        res.json(conversations[index]);
    } catch (error) {
        console.error('Error updating conversation:', error);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

// Delete a conversation
app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;

        const conversations = await loadConversationsIndex(userId);
        const index = conversations.findIndex(c => c.id === id);

        if (index === -1) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        conversations.splice(index, 1);
        await saveConversationsIndex(userId, conversations);

        // Delete messages file
        const userDir = await ensureUserConversationsDir(userId);
        const messagesPath = path.join(userDir, `${id}.json`);
        try {
            await fs.unlink(messagesPath);
        } catch (e) {
            // Ignore if file doesn't exist
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting conversation:', error);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

// Save messages to a conversation
app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;
        const { messages } = req.body;

        if (!Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages must be an array' });
        }

        // Verify conversation exists
        const conversations = await loadConversationsIndex(userId);
        const conversation = conversations.find(c => c.id === id);

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        // saveConversationMessages also updates messageCount and updatedAt in the index
        await saveConversationMessages(userId, id, messages);

        res.json({ success: true, messageCount: messages.length });
    } catch (error) {
        console.error('Error saving messages:', error);
        res.status(500).json({ error: 'Failed to save messages' });
    }
});

// Check streaming status for a conversation
app.get('/api/conversations/:id/streaming', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const job = activeStreamingJobs.get(id);

        if (!job) {
            return res.json({ streaming: false });
        }

        res.json({
            streaming: true,
            content: job.content,
            reasoning: job.reasoning || '',
            startTime: job.startTime,
            model: job.model,
            clientConnected: job.clientConnected
        });
    } catch (error) {
        console.error('Error checking streaming status:', error);
        res.status(500).json({ error: 'Failed to check streaming status' });
    }
});

// Cancel an active streaming job for a conversation
app.delete('/api/conversations/:id/streaming', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const job = activeStreamingJobs.get(id);

        if (!job) {
            return res.json({ cancelled: false, reason: 'No active stream found' });
        }

        // Abort the underlying model request
        if (job.abortController) {
            job.abortController.abort();
        }

        // Save partial response if there is content
        if (job.content) {
            try {
                const conversationMsgs = await loadConversationMessages(job.userId, id);
                const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: job.content,
                    reasoning: job.reasoning || undefined,
                    timestamp: new Date().toISOString(),
                    responseTime: Date.now() - job.startTime,
                    stoppedByUser: true
                };
                conversationMsgs.push(assistantMessage);
                await saveConversationMessages(job.userId, id, conversationMsgs);
                console.log(`[Chat Stream] Cancelled stream for conversation ${id}, partial response saved (${job.content.length} chars)`);
            } catch (saveErr) {
                console.error(`[Chat Stream] Failed to save partial response on cancel:`, saveErr);
            }
        }

        // Clean up the job
        activeStreamingJobs.delete(id);

        res.json({ cancelled: true, hadContent: !!job.content });
    } catch (error) {
        console.error('Error cancelling stream:', error);
        res.status(500).json({ error: 'Failed to cancel stream' });
    }
});

// Smart content optimizer - removes unnecessary whitespace to save tokens
function optimizeContent(text, options = {}) {
    if (!text || typeof text !== 'string') return text;

    const {
        preserveCodeBlocks = true,
        maxConsecutiveNewlines = 2,
        trimLines = true,
        removeEmptyLines = false,
        compressWhitespace = true
    } = options;

    let result = text;

    // Preserve code blocks by replacing them with placeholders
    const codeBlocks = [];
    if (preserveCodeBlocks) {
        result = result.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
            codeBlocks.push(match);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });
    }

    // Normalize line endings
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Trim trailing whitespace from each line
    if (trimLines) {
        result = result.split('\n').map(line => line.trimEnd()).join('\n');
    }

    // Compress multiple spaces to single space (within lines)
    if (compressWhitespace) {
        result = result.split('\n').map(line => {
            // Don't compress leading whitespace (indentation)
            const leadingSpaces = line.match(/^(\s*)/)[1];
            const rest = line.slice(leadingSpaces.length);
            return leadingSpaces + rest.replace(/  +/g, ' ');
        }).join('\n');
    }

    // Remove empty lines or limit consecutive newlines
    if (removeEmptyLines) {
        result = result.split('\n').filter(line => line.trim() !== '').join('\n');
    } else if (maxConsecutiveNewlines > 0) {
        const pattern = new RegExp(`\n{${maxConsecutiveNewlines + 1},}`, 'g');
        result = result.replace(pattern, '\n'.repeat(maxConsecutiveNewlines));
    }

    // Restore code blocks
    if (preserveCodeBlocks) {
        codeBlocks.forEach((block, i) => {
            result = result.replace(`__CODE_BLOCK_${i}__`, block);
        });
    }

    return result.trim();
}

// Extract links from text/HTML content - extracts both HTML anchor tags and plain URLs
/**
 * Convert HTML email body to readable plain text, preserving table data and structure
 */
function htmlToPlainText(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        // Table handling - preserve cell data with separators
        .replace(/<\/th>/gi, ' | ')
        .replace(/<\/td>/gi, ' | ')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/table>/gi, '\n')
        // List handling
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        // Block elements
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<hr[^>]*>/gi, '\n---\n')
        // Strip remaining tags
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&dollar;/gi, '$')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .replace(/&[a-zA-Z]+;/g, ' ')
        // Clean up whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractLinksFromText(text) {
    if (!text || typeof text !== 'string') return [];

    const links = [];
    const seenUrls = new Set();

    // Pattern 1: HTML anchor tags with href
    const anchorPattern = /<a\s+[^>]*href=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(text)) !== null) {
        const url = match[1];
        const linkText = match[2].trim() || url;
        if (!seenUrls.has(url)) {
            seenUrls.add(url);
            links.push({ url, text: linkText });
        }
    }

    // Pattern 2: Plain URLs (not already inside anchor tags)
    // Remove HTML tags first to avoid duplicate extraction
    const textWithoutAnchors = text.replace(/<a\s+[^>]*href=["']?https?:\/\/[^"'\s>]+["']?[^>]*>[^<]*<\/a>/gi, '');
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
    while ((match = urlPattern.exec(textWithoutAnchors)) !== null) {
        let url = match[0];
        // Clean trailing punctuation that's likely not part of URL
        url = url.replace(/[.,;:!?)]+$/, '');
        if (!seenUrls.has(url)) {
            seenUrls.add(url);
            links.push({ url, text: url });
        }
    }

    return links;
}

/**
 * Helper function to extract text content from email attachments recursively
 * Handles nested emails (.eml, .msg), PDFs, and text documents
 * @param {Array} attachments - Array of attachment objects from mailparser or msgreader
 * @param {number} depth - Current recursion depth (max 3 levels to prevent infinite loops)
 * @returns {Promise<string>} - Extracted text from all attachments
 */
async function extractEmailAttachmentContent(attachments, depth = 0) {
    if (!attachments || !Array.isArray(attachments) || depth > 3) {
        return '';
    }

    const { simpleParser } = require('mailparser');
    const pdfParse = require('pdf-parse');
    const mammoth = require('mammoth');

    let extractedContent = '';

    for (const att of attachments) {
        try {
            const filename = att.filename || att.fileName || att.name || 'attachment';
            const ext = filename.toLowerCase().split('.').pop();
            const contentType = att.contentType || att.mimeType || '';
            const content = att.content || (att.dataBuffer ? Buffer.from(att.dataBuffer) : null);

            if (!content) continue;

            // Handle nested email attachments (.eml)
            if (ext === 'eml' || contentType === 'message/rfc822') {
                try {
                    const parsed = await simpleParser(content);
                    extractedContent += `\n\n=== Nested Email: ${parsed.subject || 'Untitled'} ===\n`;
                    if (parsed.from?.text) extractedContent += `From: ${parsed.from.text}\n`;
                    if (parsed.to?.text) extractedContent += `To: ${parsed.to.text}\n`;
                    if (parsed.date) extractedContent += `Date: ${parsed.date.toISOString()}\n`;
                    extractedContent += '\n';

                    // Get body text
                    const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '';
                    extractedContent += body.substring(0, 10000); // Limit nested body

                    // Recursively parse nested email's attachments
                    if (parsed.attachments?.length > 0) {
                        const nestedContent = await extractEmailAttachmentContent(parsed.attachments, depth + 1);
                        if (nestedContent) {
                            extractedContent += nestedContent;
                        }
                    }
                    extractedContent += '\n=== End Nested Email ===\n';
                } catch (emlErr) {
                    console.warn('Failed to parse nested EML:', emlErr.message);
                }
            }
            // Handle nested .msg files
            else if (ext === 'msg' || contentType === 'application/vnd.ms-outlook') {
                try {
                    const MsgReader = require('@kenjiuno/msgreader').default;
                    const msgReader = new MsgReader(content);
                    const fileData = msgReader.getFileData();

                    extractedContent += `\n\n=== Nested Email (MSG): ${fileData.subject || 'Untitled'} ===\n`;
                    if (fileData.senderEmail) extractedContent += `From: ${fileData.senderEmail}\n`;
                    extractedContent += '\n';

                    const body = fileData.body || '';
                    extractedContent += body.substring(0, 10000);

                    // Handle MSG attachments
                    if (fileData.attachments?.length > 0) {
                        for (const msgAtt of fileData.attachments) {
                            const attContent = msgReader.getAttachment(msgAtt);
                            if (attContent?.content) {
                                const nestedContent = await extractEmailAttachmentContent([{
                                    filename: msgAtt.fileName,
                                    content: Buffer.from(attContent.content),
                                    contentType: msgAtt.contentType
                                }], depth + 1);
                                if (nestedContent) {
                                    extractedContent += nestedContent;
                                }
                            }
                        }
                    }
                    extractedContent += '\n=== End Nested Email (MSG) ===\n';
                } catch (msgErr) {
                    console.warn('Failed to parse nested MSG:', msgErr.message);
                }
            }
            // Handle PDF attachments
            else if (ext === 'pdf' || contentType === 'application/pdf') {
                try {
                    const data = await pdfParse(content);
                    if (data.text?.trim()) {
                        extractedContent += `\n\n=== PDF Attachment: ${filename} ===\n`;
                        extractedContent += repairPdfUrls(data.text).substring(0, 20000); // Limit PDF content
                        extractedContent += '\n=== End PDF ===\n';
                    }
                } catch (pdfErr) {
                    console.warn('Failed to parse PDF attachment:', pdfErr.message);
                }
            }
            // Handle Word documents
            else if (ext === 'docx' || contentType.includes('wordprocessingml')) {
                try {
                    const result = await mammoth.extractRawText({ buffer: content });
                    if (result.value?.trim()) {
                        extractedContent += `\n\n=== Document Attachment: ${filename} ===\n`;
                        extractedContent += result.value.substring(0, 20000);
                        extractedContent += '\n=== End Document ===\n';
                    }
                } catch (docErr) {
                    console.warn('Failed to parse DOCX attachment:', docErr.message);
                }
            }
            // Handle text files
            else if (ext === 'txt' || ext === 'csv' || ext === 'json' || ext === 'xml' ||
                     ext === 'md' || ext === 'log' || contentType.startsWith('text/')) {
                try {
                    const textContent = content.toString('utf-8');
                    if (textContent?.trim()) {
                        extractedContent += `\n\n=== Text Attachment: ${filename} ===\n`;
                        extractedContent += textContent.substring(0, 20000);
                        extractedContent += '\n=== End Text ===\n';
                    }
                } catch (txtErr) {
                    console.warn('Failed to parse text attachment:', txtErr.message);
                }
            }
        } catch (attErr) {
            console.warn('Failed to process attachment:', attErr.message);
        }
    }

    return extractedContent;
}

// File upload endpoint for chat context
app.post('/api/chat/upload', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    try {
        // Handle base64-encoded file content
        const { filename, content, mimeType, optimize = true } = req.body;

        // Validate file size (max 50MB)
        const contentLength = content ? content.length : 0;
        if (contentLength > 50 * 1024 * 1024) {
            return res.status(413).json({ error: 'File too large. Maximum size is 50MB.' });
        }

        if (!content) {
            return res.status(400).json({ error: 'File content is required' });
        }

        // Helper to optionally optimize content
        const maybeOptimize = (text) => optimize ? optimizeContent(text) : text;

        // Helper to sanitize content for model tokenizers
        // Removes/replaces characters that can cause parsing errors
        const sanitizeForModel = (text) => {
            return text
                // Remove NULL bytes and other control characters (except newline, tab, carriage return)
                .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
                // Replace non-breaking spaces and other problematic whitespace
                .replace(/[\u00A0\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]/g, ' ')
                // Remove zero-width characters
                .replace(/[\uFEFF\u200C\u200D]/g, '')
                // Replace problematic Unicode characters that can cause tokenizer issues
                .replace(/[\uFFFD\uFFFF]/g, '')
                // Normalize common problematic sequences
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n');
        };

        // Helper to prepare content with chunking metadata (no truncation at upload time)
        // Truncation happens at chat time based on model's actual context window
        const prepareContent = (text, originalLength) => {
            const estimatedTokens = Math.ceil(text.length / 4);
            const chunkSize = 20000; // chars per chunk (~5000 tokens)
            const totalChunks = Math.ceil(text.length / chunkSize);

            return {
                content: text,
                originalLength,
                estimatedTokens,
                totalChunks,
                chunkSize,
                // Flag if this will likely need chunked processing
                requiresChunking: estimatedTokens > 8000
            };
        };

        // For text-based files, decode and return content
        const textTypes = [
            'text/', 'application/json', 'application/xml',
            'application/javascript', 'application/x-yaml'
        ];

        const isText = textTypes.some(t => mimeType?.startsWith(t) || mimeType?.includes(t));

        if (isText) {
            try {
                let decoded = Buffer.from(content, 'base64').toString('utf8');
                const originalLength = decoded.length;
                decoded = sanitizeForModel(maybeOptimize(decoded));
                const prepared = prepareContent(decoded, originalLength);

                return res.json({
                    type: 'text',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks
                });
            } catch (e) {
                return res.status(400).json({ error: 'Failed to decode text content' });
            }
        }

        // Get file extension for fallback detection
        const ext = filename?.toLowerCase()?.split('.').pop();

        // For PDFs, extract text with OCR fallback for scanned documents
        if (mimeType === 'application/pdf' || ext === 'pdf') {
            try {
                const pdfParse = require('pdf-parse');
                const { exec, execSync } = require('child_process');
                const { promisify } = require('util');
                const execAsync = promisify(exec);
                const path = require('path');
                const fs = require('fs');

                const buffer = Buffer.from(content, 'base64');
                const data = await pdfParse(buffer);
                const pageCount = data.numpages || 1;
                let extractedText = data.text || '';

                // Calculate text density (chars per page)
                const charsPerPage = extractedText.trim().length / pageCount;
                const needsOcr = charsPerPage < 100; // Less than 100 chars/page suggests scanned PDF

                let ocrText = '';
                let ocrPerformed = false;

                if (needsOcr && pageCount <= 50) { // Limit OCR to 50 pages for performance
                    try {
                        // Create temp directory for PDF processing
                        const tempDir = `/tmp/pdf_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                        fs.mkdirSync(tempDir, { recursive: true });

                        const pdfPath = path.join(tempDir, 'input.pdf');
                        fs.writeFileSync(pdfPath, buffer);

                        // Convert PDF pages to images using pdftoppm (from poppler-utils)
                        // Use PNG format for better OCR quality, 200 DPI for balance of speed/accuracy
                        await execAsync(`pdftoppm -png -r 200 "${pdfPath}" "${tempDir}/page"`, {
                            timeout: 120000 // 2 minute timeout
                        });

                        // Get list of generated images
                        const imageFiles = fs.readdirSync(tempDir)
                            .filter(f => f.startsWith('page') && f.endsWith('.png'))
                            .sort();

                        // Run OCR on each page
                        const ocrResults = [];
                        for (const imageFile of imageFiles) {
                            const imagePath = path.join(tempDir, imageFile);
                            try {
                                // Use tesseract for OCR
                                const { stdout } = await execAsync(`tesseract "${imagePath}" stdout -l eng --psm 1`, {
                                    timeout: 30000 // 30 seconds per page
                                });
                                if (stdout.trim()) {
                                    ocrResults.push(stdout.trim());
                                }
                            } catch (ocrErr) {
                                console.warn(`OCR failed for ${imageFile}:`, ocrErr.message);
                            }
                        }

                        // Cleanup temp directory
                        try {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        } catch (cleanupErr) {
                            console.warn('Failed to cleanup temp directory:', cleanupErr.message);
                        }

                        if (ocrResults.length > 0) {
                            ocrText = ocrResults.join('\n\n--- Page Break ---\n\n');
                            ocrPerformed = true;
                        }
                    } catch (ocrError) {
                        console.warn('PDF OCR failed, using text extraction only:', ocrError.message);
                    }
                }

                // Combine OCR text with regular extracted text
                let finalText = extractedText;
                if (ocrPerformed && ocrText.trim().length > extractedText.trim().length) {
                    // OCR found more text than regular extraction
                    finalText = ocrText;
                } else if (ocrPerformed && ocrText.trim()) {
                    // Append OCR text if it adds meaningful content
                    const ocrUnique = ocrText.trim().length - extractedText.trim().length;
                    if (ocrUnique > 500) {
                        finalText = extractedText + '\n\n--- OCR Extracted Content ---\n\n' + ocrText;
                    }
                }

                // Repair URLs broken across lines by pdf-parse
                finalText = repairPdfUrls(finalText);

                const originalLength = finalText.length;
                // PDFs often contain problematic characters - sanitize after optimization
                const optimized = sanitizeForModel(maybeOptimize(finalText));
                const prepared = prepareContent(optimized, originalLength);

                return res.json({
                    type: 'pdf',
                    filename,
                    content: prepared.content,
                    pageCount: pageCount,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks,
                    ocrPerformed: ocrPerformed
                });
            } catch (e) {
                console.error('PDF parsing error:', e);
                return res.status(400).json({ error: 'Failed to parse PDF: ' + e.message });
            }
        }

        // For .msg (Outlook binary format) files - requires msgreader
        if (ext === 'msg' || mimeType === 'application/vnd.ms-outlook') {
            try {
                const MsgReader = require('@kenjiuno/msgreader').default;
                const buffer = Buffer.from(content, 'base64');
                const msgReader = new MsgReader(buffer);
                const fileData = msgReader.getFileData();

                // Build email content string
                let emailContent = '';
                if (fileData.subject) emailContent += `Subject: ${fileData.subject}\n`;
                if (fileData.senderName || fileData.senderEmail) {
                    emailContent += `From: ${fileData.senderName || ''} <${fileData.senderEmail || ''}>\n`;
                }
                if (fileData.recipients?.length > 0) {
                    const toRecipients = fileData.recipients.filter(r => r.recipType === 'to' || !r.recipType);
                    const ccRecipients = fileData.recipients.filter(r => r.recipType === 'cc');
                    if (toRecipients.length > 0) {
                        emailContent += `To: ${toRecipients.map(r => r.name || r.email).join(', ')}\n`;
                    }
                    if (ccRecipients.length > 0) {
                        emailContent += `CC: ${ccRecipients.map(r => r.name || r.email).join(', ')}\n`;
                    }
                }
                if (fileData.messageDeliveryTime) emailContent += `Date: ${fileData.messageDeliveryTime}\n`;

                // Extract links from body content (both plain text and HTML)
                const bodyText = fileData.body || '';
                // msgreader uses 'bodyHtml' (string) or 'html' (Uint8Array)
                let bodyHtml = fileData.bodyHtml || '';
                if (!bodyHtml && fileData.html) {
                    // Convert Uint8Array to string
                    bodyHtml = Buffer.from(fileData.html).toString('utf-8');
                }
                const links = extractLinksFromText(bodyHtml || bodyText);

                // Add links section if any found
                if (links.length > 0) {
                    emailContent += `\nLinks found: ${links.length}\n`;
                    links.forEach((link, i) => {
                        emailContent += `  ${i + 1}. ${link.text !== link.url ? link.text + ': ' : ''}${link.url}\n`;
                    });
                }

                emailContent += '\n---\n\n';
                // Use HTML body when available (contains tables, dollar amounts, details)
                // Fall back to plain text body if no HTML
                const htmlText = bodyHtml ? htmlToPlainText(bodyHtml) : '';
                const plainText = bodyText.replace(/<[^>]+>/g, '').trim();
                // Use whichever has more content (HTML usually has full details)
                emailContent += (htmlText.length > plainText.length) ? htmlText : plainText;

                // Include attachments info and extract content from attachments
                if (fileData.attachments?.length > 0) {
                    emailContent += '\n\n---\nAttachments:\n';
                    fileData.attachments.forEach(att => {
                        emailContent += `- ${att.fileName || att.name || 'unnamed'} (${att.contentLength || 'unknown size'} bytes)\n`;
                    });

                    // Extract content from attachments (nested emails, PDFs, etc.)
                    try {
                        const attachmentsWithContent = [];
                        for (const att of fileData.attachments) {
                            const attContent = msgReader.getAttachment(att);
                            if (attContent?.content) {
                                attachmentsWithContent.push({
                                    filename: att.fileName,
                                    content: Buffer.from(attContent.content),
                                    contentType: att.contentType || ''
                                });
                            }
                        }
                        const attachmentText = await extractEmailAttachmentContent(attachmentsWithContent);
                        if (attachmentText) {
                            emailContent += '\n\n--- Attachment Contents ---' + attachmentText;
                        }
                    } catch (attErr) {
                        console.warn('Failed to extract MSG attachments:', attErr.message);
                    }
                }

                const originalLength = emailContent.length;
                const optimized = sanitizeForModel(maybeOptimize(emailContent));
                const prepared = prepareContent(optimized, originalLength);

                return res.json({
                    type: 'email',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    subject: fileData.subject,
                    from: fileData.senderEmail,
                    date: fileData.messageDeliveryTime,
                    links: links,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks,
                    hasAttachments: fileData.attachments?.length > 0
                });
            } catch (e) {
                console.error('MSG parsing error:', e);
                // Fall through to try as raw text
            }
        }

        // For .eml email files - uses mailparser
        if (ext === 'eml' || mimeType === 'message/rfc822') {
            try {
                const { simpleParser } = require('mailparser');
                const buffer = Buffer.from(content, 'base64');
                const parsed = await simpleParser(buffer);

                // Build email content string
                let emailContent = '';
                if (parsed.subject) emailContent += `Subject: ${parsed.subject}\n`;
                if (parsed.from?.text) emailContent += `From: ${parsed.from.text}\n`;
                if (parsed.to?.text) emailContent += `To: ${parsed.to.text}\n`;
                if (parsed.cc?.text) emailContent += `CC: ${parsed.cc.text}\n`;
                if (parsed.date) emailContent += `Date: ${parsed.date.toISOString()}\n`;

                // Extract links from body content (HTML first, then plain text)
                const bodyHtml = parsed.html || parsed.textAsHtml || '';
                const bodyText = parsed.text || '';
                const links = extractLinksFromText(bodyHtml || bodyText);

                // Add links section if any found
                if (links.length > 0) {
                    emailContent += `\nLinks found: ${links.length}\n`;
                    links.forEach((link, i) => {
                        emailContent += `  ${i + 1}. ${link.text !== link.url ? link.text + ': ' : ''}${link.url}\n`;
                    });
                }

                emailContent += '\n---\n\n';
                // Use HTML body when available (contains tables, dollar amounts, details)
                // Fall back to plain text body if no HTML
                const htmlText = bodyHtml ? htmlToPlainText(bodyHtml) : '';
                const plainText = (bodyText || '').trim();
                // Use whichever has more content (HTML usually has full details)
                emailContent += (htmlText.length > plainText.length) ? htmlText : plainText;

                // Include attachments info and extract content from attachments
                if (parsed.attachments?.length > 0) {
                    emailContent += '\n\n---\nAttachments:\n';
                    parsed.attachments.forEach(att => {
                        emailContent += `- ${att.filename || 'unnamed'} (${att.contentType}, ${att.size} bytes)\n`;
                    });

                    // Extract content from attachments (nested emails, PDFs, etc.)
                    try {
                        const attachmentText = await extractEmailAttachmentContent(parsed.attachments);
                        if (attachmentText) {
                            emailContent += '\n\n--- Attachment Contents ---' + attachmentText;
                        }
                    } catch (attErr) {
                        console.warn('Failed to extract EML attachments:', attErr.message);
                    }
                }

                const originalLength = emailContent.length;
                const optimized = sanitizeForModel(maybeOptimize(emailContent));
                const prepared = prepareContent(optimized, originalLength);

                return res.json({
                    type: 'email',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    subject: parsed.subject,
                    from: parsed.from?.text,
                    date: parsed.date?.toISOString(),
                    links: links,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks,
                    hasAttachments: parsed.attachments?.length > 0
                });
            } catch (e) {
                console.error('EML parsing error:', e);
                // Fall through to try as raw text
            }
        }

        // For Word documents (.docx)
        if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            try {
                const mammoth = require('mammoth');
                const buffer = Buffer.from(content, 'base64');
                const result = await mammoth.extractRawText({ buffer });
                const originalLength = result.value.length;
                const optimized = sanitizeForModel(maybeOptimize(result.value));
                const prepared = prepareContent(optimized, originalLength);

                return res.json({
                    type: 'document',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks
                });
            } catch (e) {
                console.error('DOCX parsing error:', e);
                // Fall through to try as raw text
            }
        }

        // For Excel files (.xlsx)
        if (ext === 'xlsx' || ext === 'xls' || mimeType?.includes('spreadsheet')) {
            try {
                const XLSX = require('xlsx');
                const buffer = Buffer.from(content, 'base64');
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                let textContent = '';

                workbook.SheetNames.forEach(sheetName => {
                    const sheet = workbook.Sheets[sheetName];
                    textContent += `--- ${sheetName} ---\n`;
                    textContent += XLSX.utils.sheet_to_csv(sheet) + '\n\n';
                });

                const originalLength = textContent.length;
                const optimized = sanitizeForModel(maybeOptimize(textContent));
                const prepared = prepareContent(optimized, originalLength);

                return res.json({
                    type: 'spreadsheet',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    sheets: workbook.SheetNames.length,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks
                });
            } catch (e) {
                console.error('Excel parsing error:', e);
                // Fall through to try as raw text
            }
        }

        // For images: convert to PNG if needed, run OCR, return both image and text
        if (mimeType?.startsWith('image/')) {
            let imageDataUrl = `data:${mimeType};base64,${content}`;
            let imageMimeType = mimeType;
            let ocrText = '';

            // Convert GIF/BMP/TIFF to PNG for model compatibility (most vision APIs only accept JPEG/PNG/WebP)
            const needsConversion = ['image/gif', 'image/bmp', 'image/tiff'].includes(mimeType);
            if (needsConversion) {
                try {
                    const { Jimp } = require('jimp');
                    const buffer = Buffer.from(content, 'base64');
                    const image = await Jimp.read(buffer);
                    const pngBuffer = await image.getBuffer('image/png');
                    const pngBase64 = pngBuffer.toString('base64');
                    imageDataUrl = `data:image/png;base64,${pngBase64}`;
                    imageMimeType = 'image/png';
                    console.log(`[Chat Upload] Converted ${mimeType} to PNG (${pngBase64.length} base64 chars)`);
                } catch (convErr) {
                    console.error(`[Chat Upload] Image conversion failed for ${mimeType}:`, convErr.message);
                    // Fall back to original format
                }
            }

            // Attempt OCR text extraction via Tesseract CLI
            try {
                const { execFile } = require('child_process');
                const { promisify } = require('util');
                const execFileAsync = promisify(execFile);
                const ocrTmpPath = `/tmp/ocr_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

                // Write image to temp file
                const imgBuffer = Buffer.from(content, 'base64');
                // Tesseract needs a file extension it recognizes
                const ocrExt = ext || mimeType.split('/')[1] || 'png';
                const ocrInputPath = `${ocrTmpPath}.${ocrExt}`;
                await fs.writeFile(ocrInputPath, imgBuffer);

                try {
                    const { stdout } = await execFileAsync('tesseract', [ocrInputPath, 'stdout', '--psm', '3'], {
                        timeout: 30000,
                        maxBuffer: 5 * 1024 * 1024
                    });
                    ocrText = (stdout || '').trim();
                    if (ocrText) {
                        console.log(`[Chat Upload] OCR extracted ${ocrText.length} chars from ${filename}`);
                    }
                } finally {
                    // Clean up temp file
                    try { await fs.unlink(ocrInputPath); } catch (e) { /* ignore */ }
                }
            } catch (ocrErr) {
                console.error(`[Chat Upload] OCR failed for ${filename}:`, ocrErr.message);
                // OCR failure is not critical — continue without text
            }

            const result = {
                type: 'image',
                filename,
                dataUrl: imageDataUrl,
                mimeType: imageMimeType
            };

            // If OCR extracted text, include it so the model can use it
            if (ocrText) {
                const ocrContent = `[OCR extracted text from ${filename}]\n${ocrText}`;
                result.ocrText = ocrText;
                result.content = ocrContent;
                result.charCount = ocrContent.length;
                result.estimatedTokens = Math.ceil(ocrContent.length / 4);
            }

            return res.json(result);
        }

        // Catch-all: Try to decode as text first, fallback to binary
        try {
            let decoded = sanitizeForModel(Buffer.from(content, 'base64').toString('utf8'));
            const originalLength = decoded.length;
            decoded = maybeOptimize(decoded);

            return res.json({
                type: 'text',
                filename,
                content: decoded,
                charCount: decoded.length,
                originalCharCount: originalLength,
                saved: originalLength - decoded.length
            });
        } catch (decodeError) {
            // If not text, return as binary data
            return res.json({
                type: 'file',
                filename,
                dataUrl: `data:${mimeType || 'application/octet-stream'};base64,${content}`,
                mimeType: mimeType || 'application/octet-stream',
                size: Buffer.from(content, 'base64').length
            });
        }
    } catch (error) {
        console.error('File upload error:', error);
        const detail = error.message || 'Unknown processing error';
        res.status(500).json({ error: `Failed to process file: ${detail}` });
    }
});

// ============================================================================
// SIMPLIFIED WRAPPER API
// ============================================================================

// Simplified chat endpoint - wraps OpenAI API
app.post('/api/chat', requireAuth, async (req, res) => {
    const { message, model, temperature, maxTokens, stream } = req.body;

    // If streaming requested, delegate to stream endpoint
    if (stream) {
        return app._router.handle({ ...req, url: '/api/chat/stream', method: 'POST' }, res);
    }

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    // Check permission
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    try {
        // Find first running instance or use specified model
        let targetModel = model;
        let targetInstance = null;

        if (!targetModel) {
            // Use first running instance
            targetInstance = Array.from(modelInstances.values())[0];
            if (!targetInstance) {
                return res.status(400).json({ error: 'No running models. Please load a model first.' });
            }
            targetModel = targetInstance.modelName || 'default';
        } else {
            // Find specific model
            targetInstance = modelInstances.get(targetModel);
            if (!targetInstance) {
                return res.status(400).json({ error: `Model ${targetModel} is not running. Please load it first.` });
            }
        }

        // Use container name for Docker network communication
        const targetHost = targetInstance.containerName || `host.docker.internal`;
        const targetPort = targetInstance.internalPort || targetInstance.port;

        // Get context size configuration
        const contextSize = targetInstance.config?.contextSize || targetInstance.config?.maxModelLen || 4096;
        const contextShift = targetInstance.config?.contextShift || false;
        const disableThinking = targetInstance.config?.disableThinking || false;

        // Apply thinking mode control - prepend /no_think for models that support it (e.g., Qwen3)
        let userContent = message;
        if (disableThinking) {
            userContent = `/no_think\n${message}`;
        }

        // Load system prompt for this model
        const systemPrompts = await loadSystemPrompts();
        const systemPrompt = systemPrompts[targetModel] || '';

        // Estimate token count (rough estimate: 1 token ≈ 4 characters)
        const estimateTokens = (text) => Math.ceil(text.length / 4);

        let systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
        let messageTokens = estimateTokens(userContent);
        let totalInputTokens = systemTokens + messageTokens;

        // Response reserve: input gets priority, response gets what's left (capped by max_tokens)
        const desiredResponseTokens = maxTokens || Math.floor(contextSize * 0.2);
        const minResponseReserve = Math.min(2048, Math.floor(contextSize * 0.2));
        const responseReserve = Math.max(
            minResponseReserve,
            Math.min(desiredResponseTokens, contextSize - totalInputTokens - 200)
        );
        const availableContextForInput = contextSize - responseReserve;

        // Check if input exceeds available context
        if (totalInputTokens > availableContextForInput) {
            // If context shift is enabled, we can truncate the message
            if (contextShift) {
                // Calculate how much we need to truncate
                const excessTokens = totalInputTokens - availableContextForInput;
                const targetMessageLength = userContent.length - (excessTokens * 4);

                if (targetMessageLength > 0) {
                    // Truncate message and add indicator
                    const truncatedMessage = userContent.substring(0, targetMessageLength) +
                        '\n\n[...input truncated due to context limit...]';
                    console.log(`Input truncated: ${userContent.length} -> ${truncatedMessage.length} chars`);

                    // Use truncated message
                    messageTokens = estimateTokens(truncatedMessage);
                    totalInputTokens = systemTokens + messageTokens;

                    // Make request to vLLM instance
                    const messages = [];

                    if (systemPrompt) {
                        messages.push({ role: 'system', content: systemPrompt });
                    }
                    messages.push({ role: 'user', content: truncatedMessage });

                    const requestBody = {
                        messages: messages,
                        temperature: temperature || 0.7,
                        // Always clamped to contextSize - inputTokens to prevent
                        // vLLM's "0 input tokens" VLLMValidationError.
                        max_tokens: responseReserve
                    };

                    const response = await axios.post(`http://${targetHost}:${targetPort}/v1/chat/completions`, requestBody);
                    const choice = response.data.choices[0];
                    const messageData = choice.message;
                    let reply = messageData.content || messageData.reasoning_content || '';

                    return res.json({
                        success: true,
                        response: reply,
                        model: targetModel,
                        tokens: response.data.usage,
                        reasoning: messageData.reasoning_content ? true : false,
                        truncated: true,
                        originalLength: userContent.length,
                        truncatedLength: truncatedMessage.length
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        error: `Input too large: Your message (${totalInputTokens} tokens) exceeds the model's context window (${contextSize} tokens). Please reduce input size or increase context size in model settings.`
                    });
                }
            } else {
                return res.status(400).json({
                    success: false,
                    error: `Not enough context window: Input requires ~${totalInputTokens} tokens but only ${availableContextForInput} available (context: ${contextSize}, reserved for response: ${responseReserve}). Enable context shifting or reduce input size.`
                });
            }
        }

        // Normal flow - input fits within context
        // Make request to vLLM instance
        const messages = [];

        // Add system prompt if one exists
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // Add user message (with /no_think prepended if disableThinking is enabled)
        messages.push({ role: 'user', content: userContent });

        const requestBody = {
            messages: messages,
            temperature: temperature || 0.7,
            // Always clamped to contextSize - inputTokens to prevent vLLM's
            // "0 input tokens" VLLMValidationError when the caller sends a
            // raw max_tokens value equal to contextSize.
            max_tokens: responseReserve
        };

        const response = await axios.post(`http://${targetHost}:${targetPort}/v1/chat/completions`, requestBody);

        // Extract response - handle reasoning models
        const choice = response.data.choices[0];
        const messageData = choice.message;
        let reply = messageData.content || '';

        // If content is empty but reasoning_content exists, use reasoning_content
        // This happens with reasoning models that only output thinking traces
        if (!reply && messageData.reasoning_content) {
            reply = messageData.reasoning_content;
        }

        // Handle different finish reasons with specific messages
        if (!reply) {
            if (choice.finish_reason === 'length') {
                return res.status(400).json({
                    success: false,
                    error: 'Not enough tokens: The response was truncated because the token limit was reached. Please increase maxTokens in your request.'
                });
            } else if (choice.finish_reason === 'content_filter') {
                return res.status(400).json({
                    success: false,
                    error: 'Content filtered: The response was blocked by content filtering.'
                });
            } else {
                return res.status(500).json({
                    success: false,
                    error: 'Empty response: The model returned no content. This may indicate an issue with the model or prompt.'
                });
            }
        }

        res.json({
            success: true,
            response: reply,
            model: targetModel,
            tokens: response.data.usage,
            reasoning: messageData.reasoning_content ? true : false,  // Indicate if reasoning was used
            contextSize: contextSize  // Include context window size for client tracking
        });
    } catch (error) {
        console.error('Chat error:', error.message);

        // Check for specific error types
        const errorMessage = error.response?.data?.error?.message || error.message || '';

        // Context window exceeded
        if (errorMessage.includes('context') || errorMessage.includes('too long') || errorMessage.includes('exceeds')) {
            return res.status(400).json({
                success: false,
                error: 'Not enough context window: Your prompt is too large for the model\'s context window. Please reduce the input size or increase the context size in model settings.'
            });
        }

        // Token rate limit
        if (errorMessage.includes('rate limit') || errorMessage.includes('too many tokens')) {
            return res.status(429).json({
                success: false,
                error: 'Token rate limit exceeded: You have exceeded your token rate limit. Please wait or increase your rate limit.'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to get response from model',
            details: error.message
        });
    }
});

// Check continuation queue for a conversation
app.get('/api/chat/continuation/:conversationId', requireAuth, (req, res) => {
    const { conversationId } = req.params;
    const continuation = contentContinuationQueue.get(conversationId);

    if (!continuation) {
        return res.json({ hasMore: false });
    }

    const remainingTokens = Math.ceil(continuation.content.length / 4);
    const remainingChunks = continuation.totalChunks - continuation.processedChunks;

    res.json({
        hasMore: true,
        remainingTokens,
        remainingChunks,
        processedChunks: continuation.processedChunks,
        totalChunks: continuation.totalChunks,
        contextSize: continuation.contextSize,
        modelName: continuation.modelName
    });
});

// Clear continuation queue for a conversation
app.delete('/api/chat/continuation/:conversationId', requireAuth, (req, res) => {
    const { conversationId } = req.params;
    contentContinuationQueue.delete(conversationId);
    res.json({ success: true });
});

// Streaming chat endpoint - Server-Sent Events (SSE)
app.post('/api/chat/stream', requireAuth, async (req, res) => {
    // Support both single message (legacy) and messages array (OpenAI compatible)
    const { message, messages: inputMessages, model, temperature, top_p, topP, maxTokens, max_tokens, conversationId, continueProcessing, chunkingStrategy } = req.body;
    const effectiveTopP = top_p !== undefined ? top_p : (topP !== undefined ? topP : 1.0);
    // Chunking strategy: 'auto' (default), 'map-reduce', 'truncate', 'none'
    const effectiveChunkingStrategy = chunkingStrategy || 'auto';

    // Check for continuation request
    if (continueProcessing && conversationId) {
        const continuation = contentContinuationQueue.get(conversationId);
        if (continuation) {
            // Process continuation by injecting remaining content
            console.log(`[Chat Stream] Processing continuation for conversation ${conversationId}`);
            // The remaining content will be added to the message below
        }
    }
    const effectiveMaxTokens = maxTokens || max_tokens;

    // Validate that either message or messages is provided
    if (!message && (!inputMessages || !Array.isArray(inputMessages) || inputMessages.length === 0)) {
        return res.status(400).json({ error: 'Message or messages array is required' });
    }

    // Check permission
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    try {
        // Find first running instance or use specified model
        let targetModel = model;
        let targetInstance = null;

        if (!targetModel) {
            // Use first running instance
            targetInstance = Array.from(modelInstances.values())[0];
            if (!targetInstance) {
                return res.status(400).json({ error: 'No running models. Please load a model first.' });
            }
            targetModel = targetInstance.modelName || 'default';
        } else {
            // Find specific model
            targetInstance = modelInstances.get(targetModel);
            if (!targetInstance) {
                return res.status(400).json({ error: `Model ${targetModel} is not running. Please load it first.` });
            }
        }

        // Use container name for Docker network communication
        const targetHost = targetInstance.containerName || `host.docker.internal`;
        const targetPort = targetInstance.internalPort || targetInstance.port;

        // Get context size configuration
        const contextSize = targetInstance.config?.contextSize || targetInstance.config?.maxModelLen || 4096;
        const contextShift = targetInstance.config?.contextShift || false;
        const disableThinking = targetInstance.config?.disableThinking || false;

        // Estimate token count - use conservative ratio for safety
        // Number-heavy content (prices, dates) tokenizes at ~2-3 chars/token, not 4
        // Being conservative here ensures chunking triggers before the model API rejects with 400
        const CHARS_PER_TOKEN = 3;
        const SAFETY_MARGIN = 1.1;  // 10% buffer for tokenizer variance

        const estimateTokens = (content) => {
            if (typeof content === 'string') {
                return Math.ceil((content.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
            }
            if (Array.isArray(content)) {
                // Vision format: array of { type: 'text', text: '...' } and { type: 'image_url', ... }
                let tokens = 0;
                for (const part of content) {
                    if (part.type === 'text' && part.text) {
                        tokens += Math.ceil((part.text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
                    } else if (part.type === 'image_url') {
                        // Images use ~85 tokens for low-res, ~1000+ for high-res
                        // Use conservative estimate of 1000 tokens per image
                        tokens += 1000;
                    }
                }
                return tokens;
            }
            return 0;
        };

        // Build messages array based on input format
        let chatMessages = [];

        if (inputMessages && Array.isArray(inputMessages) && inputMessages.length > 0) {
            // Use provided messages array (OpenAI compatible format)
            // Ensure system prompt is first and only appears once
            const systemMessages = inputMessages.filter(msg => msg.role === 'system');
            const nonSystemMessages = inputMessages.filter(msg => msg.role !== 'system');

            // Add system prompt first (only the first one if multiple exist)
            if (systemMessages.length > 0) {
                chatMessages.push({ ...systemMessages[0] });
            }

            // Add remaining messages in order
            chatMessages.push(...nonSystemMessages.map(msg => ({ ...msg })));

            // Apply thinking mode control to the last user message if disableThinking is enabled
            if (disableThinking) {
                for (let i = chatMessages.length - 1; i >= 0; i--) {
                    if (chatMessages[i].role === 'user') {
                        const content = chatMessages[i].content;
                        if (typeof content === 'string') {
                            chatMessages[i].content = `/no_think\n${content}`;
                        } else if (Array.isArray(content)) {
                            // Vision format: prepend to the first text part
                            const textPartIdx = content.findIndex(p => p.type === 'text');
                            if (textPartIdx !== -1) {
                                content[textPartIdx].text = `/no_think\n${content[textPartIdx].text}`;
                            }
                        }
                        break;
                    }
                }
            }
        } else {
            // Legacy single message format
            let userContent = message;
            if (disableThinking) {
                userContent = `/no_think\n${message}`;
            }

            // Load system prompt for this model (only for legacy format)
            const systemPrompts = await loadSystemPrompts();
            const systemPrompt = systemPrompts[targetModel] || '';

            if (systemPrompt) {
                chatMessages.push({ role: 'system', content: systemPrompt });
            }
            chatMessages.push({ role: 'user', content: userContent });
        }

        // Calculate total tokens from all messages
        let totalInputTokens = 0;
        for (const msg of chatMessages) {
            totalInputTokens += estimateTokens(msg.content);
        }

        // Response reserve: input gets priority, response gets what's left (capped by max_tokens)
        // This matches OpenAI-compatible semantics where max_tokens caps generation length
        // but does NOT pre-emptively starve input of context space
        const desiredResponseTokens = effectiveMaxTokens || Math.max(2048, Math.floor(contextSize * 0.2));
        const minResponseReserve = Math.min(2048, Math.floor(contextSize * 0.2)); // Absolute minimum for a useful response
        // Give input what it needs, response gets the rest (at least minResponseReserve)
        const responseReserve = Math.max(
            minResponseReserve,
            Math.min(desiredResponseTokens, contextSize - totalInputTokens - 200)
        );
        const availableContextForInput = Math.max(512, contextSize - responseReserve);

        // Smart content chunking - use map-reduce for large content
        let contentTruncated = false;
        let remainingContent = null;
        let truncationInfo = null;
        let useMapReduce = false;
        let mapReduceContent = null;
        let mapReduceQuery = null;
        let mapReduceCondensationInfo = null;

        console.log(`[Chat Stream] Context check: totalInputTokens=${totalInputTokens}, contextSize=${contextSize}, responseReserve=${responseReserve}, desiredResponse=${desiredResponseTokens}, availableForInput=${availableContextForInput}, needsChunking=${totalInputTokens > availableContextForInput}`);

        // AIMem compression: compress older conversation messages to save tokens
        // Controlled by compressMemory in model instance config (set at load time in model manager)
        // When enabled, triggers when conversation has 6+ non-system messages and input exceeds 60% of context
        const compressMemory = targetInstance.config?.compressMemory || false;
        const aimemThreshold = Math.floor(availableContextForInput * 0.6);
        const nonSystemCount = chatMessages.filter(m => m.role !== 'system').length;
        let aimemApplied = false;
        let aimemStats = null;

        if (aimemEnabled && memoryCompressorService && compressMemory && nonSystemCount >= 6 && totalInputTokens > aimemThreshold) {
            try {
                // Extract the current user query for relevance ranking
                let currentQuery = '';
                for (let i = chatMessages.length - 1; i >= 0; i--) {
                    if (chatMessages[i].role === 'user') {
                        const content = chatMessages[i].content;
                        currentQuery = typeof content === 'string' ? content :
                            (Array.isArray(content) ? (content.find(p => p.type === 'text')?.text || '') : '');
                        // Truncate long queries for relevance matching
                        if (currentQuery.length > 500) currentQuery = currentQuery.substring(0, 500);
                        break;
                    }
                }

                console.log(`[AIMem] Attempting compression: ${nonSystemCount} non-system messages, ${totalInputTokens} tokens (threshold: ${aimemThreshold})`);

                const compressResult = await memoryCompressorService.compressConversation(
                    chatMessages, currentQuery, availableContextForInput,
                    { keepRecentCount: 4, dedupThreshold: 0.45 }
                );

                if (compressResult.success && compressResult.compressed && compressResult.stats) {
                    chatMessages.length = 0;
                    chatMessages.push(...compressResult.messages);

                    // Recalculate token count after compression
                    totalInputTokens = 0;
                    for (const msg of chatMessages) {
                        totalInputTokens += estimateTokens(msg.content);
                    }

                    aimemApplied = true;
                    aimemStats = compressResult.stats;
                    console.log(`[AIMem] Compression applied: ${compressResult.stats.original_tokens} → ${compressResult.stats.compressed_tokens} tokens (${compressResult.stats.reduction_pct}% reduction). New total input: ${totalInputTokens}`);
                } else if (compressResult.error) {
                    console.log(`[AIMem] Compression skipped: ${compressResult.error}`);
                }
            } catch (aimemErr) {
                console.warn('[AIMem] Compression error (continuing without):', aimemErr.message);
            }
        }

        if (totalInputTokens > availableContextForInput) {
            // Find the last user message (which typically contains the large content)
            for (let i = chatMessages.length - 1; i >= 0; i--) {
                if (chatMessages[i].role === 'user') {
                    const msgContent = chatMessages[i].content;

                    // Handle both string and array content formats (vision models use array)
                    let textContent = '';
                    let isArrayFormat = false;
                    let textPartIdx = -1;

                    if (typeof msgContent === 'string') {
                        textContent = msgContent;
                    } else if (Array.isArray(msgContent)) {
                        // Vision format: find the text part
                        isArrayFormat = true;
                        textPartIdx = msgContent.findIndex(p => p.type === 'text');
                        if (textPartIdx !== -1) {
                            textContent = msgContent[textPartIdx].text || '';
                        }
                    }

                    if (!textContent) break;

                    // Use same estimation as estimateTokens for consistency
                    const contentTokens = Math.ceil((textContent.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);

                    // Calculate how much we need to trim
                    const otherTokens = totalInputTokens - contentTokens;
                    const availableForContent = availableContextForInput - otherTokens - 200;

                    if (availableForContent > 0 && contentTokens > availableForContent) {
                        // Determine if we should use map-reduce or simple truncation
                        const shouldUseMapReduce = CHUNKING_CONFIG.enabled &&
                            (effectiveChunkingStrategy === 'auto' || effectiveChunkingStrategy === 'map-reduce') &&
                            contentTokens >= CHUNKING_CONFIG.minTokensForChunking;

                        if (shouldUseMapReduce) {
                            // Extract query from content (usually the last part or a question)
                            // Try to find a question or instruction at the end
                            const lines = textContent.split('\n');
                            let queryPart = '';
                            let contentPart = textContent;

                            // Look for common query patterns at the end
                            for (let j = lines.length - 1; j >= Math.max(0, lines.length - 10); j--) {
                                const line = lines[j].trim();
                                if (line.endsWith('?') || line.match(/^(please|can you|what|how|why|summarize|analyze|explain|describe|list|find|search)/i)) {
                                    queryPart = lines.slice(j).join('\n');
                                    contentPart = lines.slice(0, j).join('\n');
                                    break;
                                }
                            }

                            // If no clear query found, use a generic one
                            if (!queryPart) {
                                queryPart = 'Please analyze and summarize this content.';
                            }

                            // Apply content condensation if enabled
                            let finalContent = contentPart;
                            let condensationInfo = null;

                            if (CHUNKING_CONFIG.enableCondensation) {
                                const condensationResult = condenseContent(
                                    contentPart,
                                    queryPart,
                                    CHUNKING_CONFIG.condensationRatio
                                );

                                if (condensationResult.reductionPercent > 10) {
                                    // Only use condensation if it provides meaningful reduction
                                    finalContent = condensationResult.condensed;
                                    condensationInfo = condensationResult;

                                    // Check if condensation avoided chunking entirely
                                    // IMPORTANT: Use the same estimateTokens function (3 chars/token, 1.1x margin)
                                    // as the overall context check to avoid divergence where estimateTokenCount
                                    // (4 chars/token) says "fits" but estimateTokens says "doesn't fit"
                                    const condensedTokens = estimateTokens(finalContent);
                                    if (condensedTokens <= availableForContent) {
                                        // Content now fits! No need for map-reduce
                                        console.log(`[Chat Stream] Condensation avoided chunking: ${contentTokens} -> ${condensedTokens} tokens`);

                                        // Update the message with condensed content
                                        const condensedNotice = `[Note: Content was condensed from ${condensationResult.originalLength.toLocaleString()} to ${condensationResult.condensedLength.toLocaleString()} chars (${condensationResult.reductionPercent}% reduction) using query-focused extraction.]\n\n${finalContent}`;

                                        if (isArrayFormat && textPartIdx !== -1) {
                                            chatMessages[i].content[textPartIdx].text = condensedNotice + '\n\n' + queryPart;
                                        } else {
                                            chatMessages[i].content = condensedNotice + '\n\n' + queryPart;
                                        }

                                        // Recalculate tokens - no longer need map-reduce
                                        totalInputTokens = 0;
                                        for (const msg of chatMessages) {
                                            totalInputTokens += estimateTokens(msg.content);
                                        }

                                        // Skip map-reduce since content now fits
                                        break;
                                    }

                                    console.log(`[Chat Stream] Content condensed: ${contentTokens} -> ${estimateTokens(finalContent)} tokens (${condensationResult.reductionPercent}% reduction)`);
                                }
                            }

                            useMapReduce = true;
                            mapReduceContent = finalContent;
                            mapReduceQuery = queryPart;
                            mapReduceCondensationInfo = condensationInfo;

                            console.log(`[Chat Stream] Using map-reduce chunking for ${estimateTokenCount(finalContent)} tokens (query: "${queryPart.substring(0, 50)}...")`);
                        } else {
                            // Fall back to simple truncation
                            const maxChars = Math.floor((availableForContent * CHARS_PER_TOKEN) / SAFETY_MARGIN);
                            const truncatedContent = textContent.substring(0, maxChars);
                            remainingContent = textContent.substring(maxChars);

                            const remainingTokens = estimateTokens(remainingContent);
                            const totalChunks = Math.ceil(contentTokens / availableForContent);

                            const truncatedWithNotice = truncatedContent +
                                `\n\n[CONTENT TRUNCATED - Processing chunk 1 of ${totalChunks}. ~${remainingTokens.toLocaleString()} tokens remaining. The model will be provided with a summary and the next chunk automatically.]`;

                            if (isArrayFormat && textPartIdx !== -1) {
                                chatMessages[i].content[textPartIdx].text = truncatedWithNotice;
                            } else {
                                chatMessages[i].content = truncatedWithNotice;
                            }

                            contentTruncated = true;
                            truncationInfo = {
                                totalTokens: contentTokens,
                                processedTokens: availableForContent,
                                remainingTokens,
                                totalChunks,
                                currentChunk: 1
                            };

                            totalInputTokens = 0;
                            for (const msg of chatMessages) {
                                totalInputTokens += estimateTokens(msg.content);
                            }

                            console.log(`[Chat Stream] Content truncated: Processing ${availableForContent} of ${contentTokens} tokens (chunk 1/${totalChunks})`);
                        }
                    }
                    break;
                }
            }

            // If still over limit after processing and not using map-reduce
            if (!useMapReduce && totalInputTokens > availableContextForInput) {
                // Safety fallback: if chunking should have triggered but didn't (e.g. condensation
                // thought it fit but recalculation disagrees), fall back to map-reduce for the
                // last user message rather than returning a hard 400 error
                const lastUserMsg = [...chatMessages].reverse().find(m => m.role === 'user');
                const lastUserContent = typeof lastUserMsg?.content === 'string'
                    ? lastUserMsg.content
                    : (Array.isArray(lastUserMsg?.content)
                        ? (lastUserMsg.content.find(p => p.type === 'text')?.text || '')
                        : '');
                const lastUserTokens = estimateTokens(lastUserContent);

                if (CHUNKING_CONFIG.enabled && lastUserTokens >= CHUNKING_CONFIG.minTokensForChunking &&
                    (effectiveChunkingStrategy === 'auto' || effectiveChunkingStrategy === 'map-reduce')) {
                    console.log(`[Chat Stream] Fallback to map-reduce: condensation did not reduce enough (totalInputTokens=${totalInputTokens}, available=${availableContextForInput})`);
                    useMapReduce = true;
                    mapReduceContent = lastUserContent;
                    mapReduceQuery = mapReduceQuery || 'Please analyze and summarize this content.';
                } else if (contextShift) {
                    // CONTEXT SHIFTING: Remove oldest messages (except system) until input fits
                    // Preserve: system messages, last user message, and as many recent messages as possible
                    console.log(`[Chat Stream] Context shift enabled - trimming ${totalInputTokens} tokens to fit ${availableContextForInput}`);

                    // Separate system messages from conversation messages
                    const systemMessages = chatMessages.filter(m => m.role === 'system');
                    const conversationMessages = chatMessages.filter(m => m.role !== 'system');

                    // Calculate tokens used by system messages (always kept)
                    let systemTokens = 0;
                    for (const msg of systemMessages) {
                        systemTokens += estimateTokens(msg.content);
                    }

                    // Available for conversation after system messages
                    const availableForConversation = availableContextForInput - systemTokens;

                    if (availableForConversation <= 0) {
                        return res.status(400).json({
                            success: false,
                            error: `System prompt alone exceeds context window. Please reduce system prompt size.`
                        });
                    }

                    // Keep messages from the end (most recent) until we run out of space
                    const keptMessages = [];
                    let conversationTokens = 0;

                    // Start from the most recent message and work backwards
                    for (let i = conversationMessages.length - 1; i >= 0; i--) {
                        const msg = conversationMessages[i];
                        const msgTokens = estimateTokens(msg.content);

                        if (conversationTokens + msgTokens <= availableForConversation) {
                            keptMessages.unshift(msg); // Add to front to maintain order
                            conversationTokens += msgTokens;
                        } else if (i === conversationMessages.length - 1) {
                            // Last user message is too large - truncate it
                            const excessTokens = (conversationTokens + msgTokens) - availableForConversation;
                            const targetLength = Math.max(100, msg.content.length - (excessTokens * 4));

                            if (typeof msg.content === 'string') {
                                const truncatedContent = msg.content.substring(0, targetLength) +
                                    '\n\n[...input truncated due to context limit...]';
                                keptMessages.unshift({ ...msg, content: truncatedContent });
                                conversationTokens += estimateTokens(truncatedContent);
                            } else {
                                // Array format (vision) - truncate text part
                                const newContent = msg.content.map(part => {
                                    if (part.type === 'text' && part.text) {
                                        return {
                                            type: 'text',
                                            text: part.text.substring(0, targetLength) + '\n\n[...truncated...]'
                                        };
                                    }
                                    return part;
                                });
                                keptMessages.unshift({ ...msg, content: newContent });
                                conversationTokens += estimateTokens(targetLength);
                            }
                        }
                        // else: skip this older message (context shift removes it)
                    }

                    // If we couldn't keep any messages, error out
                    if (keptMessages.length === 0) {
                        return res.status(400).json({
                            success: false,
                            error: `Input too large even with context shifting. Please reduce message size or clear conversation history.`
                        });
                    }

                    // Rebuild chatMessages with system messages first, then kept conversation
                    const removedCount = conversationMessages.length - keptMessages.length;
                    chatMessages.length = 0;
                    chatMessages.push(...systemMessages, ...keptMessages);

                    // Recalculate total tokens
                    totalInputTokens = systemTokens + conversationTokens;

                    console.log(`[Chat Stream] Context shift removed ${removedCount} old messages. New total: ${totalInputTokens} tokens`);
                } else {
                    return res.status(400).json({
                        success: false,
                        error: `Not enough context window: Input requires ~${totalInputTokens} tokens but only ${availableContextForInput} available (context: ${contextSize}, reserved for response: ${responseReserve}). Enable context shifting or reduce input size.`
                    });
                }
            }
        }

        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

        // Disable timeouts for SSE streaming - model responses can take minutes
        // Node.js default is 2 minutes which kills long-running streams
        req.setTimeout(0);
        res.setTimeout(0);
        if (req.socket) req.socket.setTimeout(0);

        // =====================================================================
        // MAP-REDUCE PROCESSING PATH
        // =====================================================================
        // If content exceeds context window and map-reduce is enabled,
        // process chunks in parallel and synthesize the response
        if (useMapReduce && mapReduceContent && mapReduceQuery) {
            console.log(`[Chat Stream] Starting map-reduce processing...`);

            // Send initial progress event with token and condensation details
            const mapReduceTokens = estimateTokens(mapReduceContent);
            const progressEvent = {
                type: 'chunking_progress',
                phase: 'starting',
                totalTokens: mapReduceTokens,
                contentLength: mapReduceContent.length,
                condensation: mapReduceCondensationInfo ? {
                    originalLength: mapReduceCondensationInfo.originalLength,
                    condensedLength: mapReduceCondensationInfo.condensedLength,
                    reductionPercent: mapReduceCondensationInfo.reductionPercent,
                } : null,
                message: 'Splitting content into chunks for parallel processing...'
            };
            res.write(`data: ${JSON.stringify(progressEvent)}\n\n`);

            // Extract system messages for the chunks
            const systemMsgs = chatMessages.filter(m => m.role === 'system');

            try {
                const mapReduceResult = await processWithMapReduce({
                    targetHost,
                    targetPort,
                    largeContent: mapReduceContent,
                    originalQuery: mapReduceQuery,
                    systemMessages: systemMsgs,
                    contextSize,
                    temperature: temperature || 0.7,
                    topP: effectiveTopP,
                    maxTokens: responseReserve,
                    onProgress: (progress) => {
                        // Stream progress events to client
                        const event = {
                            type: 'chunking_progress',
                            ...progress
                        };
                        try {
                            res.write(`data: ${JSON.stringify(event)}\n\n`);
                        } catch (e) {
                            // Client disconnected
                        }
                    }
                });

                if (mapReduceResult.success) {
                    // Stream the synthesized response token by token for consistent UX
                    const words = mapReduceResult.response.split(/(\s+)/);
                    let fullResponse = '';

                    for (const word of words) {
                        fullResponse += word;
                        const event = {
                            token: word,
                            choices: [{
                                delta: { content: word },
                                index: 0
                            }]
                        };
                        try {
                            res.write(`data: ${JSON.stringify(event)}\n\n`);
                        } catch (e) {
                            break; // Client disconnected
                        }
                        // Small delay to simulate streaming
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }

                    // Send final event
                    const finalEvent = {
                        done: true,
                        choices: [{
                            delta: {},
                            index: 0,
                            finish_reason: 'stop'
                        }],
                        model: targetModel,
                        contextSize,
                        mapReduce: {
                            enabled: true,
                            chunkCount: mapReduceResult.chunkCount,
                            synthesized: mapReduceResult.synthesized,
                            failedChunks: mapReduceResult.failedChunks || 0
                        }
                    };
                    res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
                    res.write(`data: [DONE]\n\n`);
                    res.end();

                    console.log(`[Chat Stream] Map-reduce complete: ${mapReduceResult.chunkCount} chunks, synthesized=${mapReduceResult.synthesized}`);
                    return;
                } else {
                    // Map-reduce failed, return error
                    const errorEvent = {
                        error: mapReduceResult.error || 'Map-reduce processing failed',
                        done: true
                    };
                    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                    res.end();
                    return;
                }
            } catch (mapReduceError) {
                console.error('[Chat Stream] Map-reduce error:', mapReduceError);
                const errorEvent = {
                    error: `Map-reduce processing failed: ${mapReduceError.message}`,
                    done: true
                };
                res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                res.end();
                return;
            }
        }

        // =====================================================================
        // SANITIZE IMAGE CONTENT FOR NON-VISION MODELS
        // =====================================================================
        // Strip image_url parts from messages — if OCR text was extracted, it's already
        // in the text part. Non-vision models reject image_url content with 500 errors.
        for (let i = 0; i < chatMessages.length; i++) {
            const msg = chatMessages[i];
            if (Array.isArray(msg.content)) {
                const textParts = msg.content.filter(p => p.type === 'text');
                const hasImages = msg.content.some(p => p.type === 'image_url');
                if (hasImages) {
                    // Collapse to plain text string (image data already converted to OCR text at upload)
                    const combinedText = textParts.map(p => p.text || '').join('\n').trim();
                    if (combinedText) {
                        chatMessages[i].content = combinedText;
                        console.log(`[Chat Stream] Stripped image_url parts from message ${i}, kept ${combinedText.length} chars of text`);
                    }
                }
            }
        }

        // =====================================================================
        // NORMAL STREAMING PATH (with automatic continuation)
        // =====================================================================
        const MAX_AUTO_CONTINUATIONS = 8; // Safety cap to prevent infinite loops
        const CONTINUATION_CONTEXT_CHARS = 3000; // ~750 tokens of tail context for better continuation pickup

        let fullResponse = '';
        let fullReasoning = '';
        let tokenCount = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let clientConnected = true;
        let continuationCount = 0;

        // Track this streaming job for background processing
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const streamingConversationId = conversationId || req.body.conversationId;
        const streamStartTime = Date.now();

        const streamAbortController = new AbortController();
        if (streamingConversationId) {
            activeStreamingJobs.set(streamingConversationId, {
                userId,
                content: '',
                reasoning: '',
                startTime: streamStartTime,
                model: targetModel,
                clientConnected: true,
                inputMessages: inputMessages,
                abortController: streamAbortController
            });
        }

        // Helper: stream one request to the model and return the finish_reason
        const streamOneRequest = (requestMessages, maxTokens) => {
            return new Promise(async (resolve, reject) => {
                let lastFinishReason = 'stop';

                try {
                    const requestBody = {
                        messages: requestMessages,
                        temperature: temperature || 0.7,
                        top_p: effectiveTopP,
                        stream: true,
                        max_tokens: maxTokens
                    };

                    const response = await axios({
                        method: 'post',
                        url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
                        data: requestBody,
                        responseType: 'stream',
                        signal: streamAbortController.signal
                    });

                    response.data.on('data', (chunk) => {
                        try {
                            const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');

                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const data = line.slice(6);

                                    if (data === '[DONE]') {
                                        // [DONE] received - resolve will happen in 'end' event
                                        return;
                                    }

                                    try {
                                        const parsed = JSON.parse(data);

                                        // Capture finish_reason from model
                                        if (parsed.choices && parsed.choices[0]?.finish_reason) {
                                            lastFinishReason = parsed.choices[0].finish_reason;
                                        }

                                        if (parsed.choices && parsed.choices[0]?.delta) {
                                            const delta = parsed.choices[0].delta;
                                            const content = delta.content || '';
                                            const reasoning = delta.reasoning_content || delta.reasoning || '';

                                            if (content || reasoning) {
                                                if (content) fullResponse += content;
                                                if (reasoning) fullReasoning += reasoning;
                                                tokenCount++;
                                                completionTokens++;

                                                if (streamingConversationId) {
                                                    const job = activeStreamingJobs.get(streamingConversationId);
                                                    if (job) {
                                                        job.content = fullResponse;
                                                        job.reasoning = fullReasoning;
                                                    }
                                                }

                                                if (clientConnected) {
                                                    const event = {
                                                        token: content || undefined,
                                                        choices: [{
                                                            delta: {
                                                                content: content || undefined,
                                                                reasoning: reasoning || undefined
                                                            },
                                                            index: 0
                                                        }]
                                                    };
                                                    try {
                                                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                                                    } catch (writeErr) {
                                                        clientConnected = false;
                                                    }
                                                }
                                            }
                                        }

                                        if (parsed.usage) {
                                            promptTokens = parsed.usage.prompt_tokens || 0;
                                            completionTokens = parsed.usage.completion_tokens || 0;
                                        }
                                        if (parsed.timings) {
                                            promptTokens = (parsed.timings.prompt_n || 0) + (parsed.timings.cache_n || 0);
                                            completionTokens = parsed.timings.predicted_n || 0;
                                        }
                                    } catch (e) {
                                        // Skip invalid JSON chunks
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('Error processing stream chunk:', error);
                        }
                    });

                    response.data.on('end', () => {
                        resolve(lastFinishReason);
                    });

                    response.data.on('error', (error) => {
                        reject(error);
                    });
                } catch (error) {
                    reject(error);
                }
            });
        };

        try {
            // Initial request with original messages.
            // responseReserve is already clamped to leave room for input
            // (see the desiredResponseTokens/responseReserve calculation above),
            // so we always use it — never the raw client-supplied value, which
            // could equal contextSize and make vLLM reject the request with
            // "0 input tokens" VLLMValidationError.
            const initialMaxTokens = responseReserve;
            let finishReason = await streamOneRequest(chatMessages, initialMaxTokens);

            // Auto-continuation loop: if model hit length limit, keep going
            while (finishReason === 'length' && continuationCount < MAX_AUTO_CONTINUATIONS && clientConnected) {
                continuationCount++;
                console.log(`[Chat Stream] Auto-continuing response (${continuationCount}/${MAX_AUTO_CONTINUATIONS}), accumulated ${fullResponse.length} chars so far`);

                // Notify client that we're auto-continuing
                if (clientConnected) {
                    try {
                        res.write(`data: ${JSON.stringify({
                            type: 'auto_continuation',
                            continuation: continuationCount,
                            maxContinuations: MAX_AUTO_CONTINUATIONS
                        })}\n\n`);
                    } catch (writeErr) {
                        clientConnected = false;
                        break;
                    }
                }

                // Build a slim continuation request:
                // - Keep system prompt
                // - Truncated original user message (NOT full content - it was already processed)
                // - Tail of the response so far as assistant context
                // - Continuation instruction
                const systemMsg = chatMessages.find(m => m.role === 'system');
                const lastUserMsg = [...chatMessages].reverse().find(m => m.role === 'user');

                // Take only the tail of the response for context (~500 tokens)
                const responseTail = fullResponse.length > CONTINUATION_CONTEXT_CHARS
                    ? fullResponse.slice(-CONTINUATION_CONTEXT_CHARS)
                    : fullResponse;

                // Truncate user message to avoid blowing the context on continuation
                // The model already processed the full content; it just needs a reminder of the task
                const maxUserMsgChars = Math.min(800, Math.floor(contextSize * 0.3));
                let userMsgContent = '';
                if (lastUserMsg) {
                    const content = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
                    userMsgContent = content.length > maxUserMsgChars
                        ? content.substring(0, maxUserMsgChars) + '\n[...original content truncated for continuation...]'
                        : content;
                }

                const continuationMessages = [];
                if (systemMsg) continuationMessages.push(systemMsg);
                if (userMsgContent) continuationMessages.push({ role: 'user', content: userMsgContent });
                continuationMessages.push({
                    role: 'assistant',
                    content: responseTail
                });
                continuationMessages.push({
                    role: 'user',
                    content: 'Continue from where you left off. Do not repeat what you already said, just continue directly.'
                });

                // Calculate available tokens for this continuation
                const continuationInputTokens = continuationMessages.reduce(
                    (sum, msg) => sum + estimateTokens(msg.content), 0
                );
                const continuationMaxTokens = Math.max(
                    512, // minimum useful response
                    contextSize - continuationInputTokens - 200 // leave buffer
                );

                try {
                    finishReason = await streamOneRequest(continuationMessages, continuationMaxTokens);
                } catch (contErr) {
                    // Continuation failed (e.g., 400 from model) - stop gracefully instead of crashing
                    console.error(`[Chat Stream] Auto-continuation ${continuationCount} failed:`, contErr.message);
                    finishReason = 'stop'; // Break the loop gracefully
                }
            }

            if (continuationCount > 0) {
                console.log(`[Chat Stream] Auto-continuation complete after ${continuationCount} continuation(s), total ${fullResponse.length} chars`);
            }
        } catch (streamError) {
            const isAborted = streamAbortController.signal.aborted || streamError.name === 'AbortError' || streamError.code === 'ERR_CANCELED';
            if (isAborted) {
                console.log(`[Chat Stream] Stream aborted by user for conversation ${streamingConversationId}`);
            } else {
                console.error('Stream error:', streamError);
                if (clientConnected && !res.writableEnded) {
                    const errorEvent = { error: streamError.message, done: true };
                    try {
                        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                    } catch (writeErr) { /* client disconnected */ }
                }
            }
        }

        // Save response to conversation if client disconnected (background completion)
        // Skip if aborted — the cancel endpoint handles saving partial content
        const wasAborted = streamAbortController.signal.aborted;
        if (!wasAborted && !clientConnected && streamingConversationId && fullResponse) {
            try {
                const conversationMsgs = await loadConversationMessages(userId, streamingConversationId);
                const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: fullResponse,
                    reasoning: fullReasoning || undefined,
                    timestamp: new Date().toISOString(),
                    responseTime: Date.now() - streamStartTime,
                    tokenCount: completionTokens,
                    backgroundCompleted: true
                };
                conversationMsgs.push(assistantMessage);
                await saveConversationMessages(userId, streamingConversationId, conversationMsgs);
                console.log(`[Chat Stream] Background response saved to conversation ${streamingConversationId}`);
            } catch (saveErr) {
                console.error(`[Chat Stream] Failed to save background response:`, saveErr);
            }
        }

        // Clean up the streaming job
        if (streamingConversationId) {
            activeStreamingJobs.delete(streamingConversationId);
        }

        // Send final event to client
        if (clientConnected && !res.writableEnded) {
            const actualFinishReason = (continuationCount >= MAX_AUTO_CONTINUATIONS) ? 'length' : 'stop';
            const finalEvent = {
                done: true,
                choices: [{
                    delta: {},
                    index: 0,
                    finish_reason: actualFinishReason
                }],
                tokens: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens
                },
                usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens
                },
                model: targetModel,
                contextSize: contextSize,
                ...(continuationCount > 0 && {
                    autoContinuation: {
                        continuations: continuationCount,
                        maxReached: continuationCount >= MAX_AUTO_CONTINUATIONS
                    }
                }),
                // Include content continuation info if input content was truncated
                ...(contentTruncated && {
                    continuation: {
                        hasMore: true,
                        ...truncationInfo,
                        message: `Content was split into ${truncationInfo.totalChunks} chunks. Processed chunk ${truncationInfo.currentChunk}. ~${truncationInfo.remainingTokens.toLocaleString()} tokens remaining.`
                    }
                }),
                // Include AIMem compression info if applied
                ...(aimemApplied && {
                    aimem: {
                        compressed: true,
                        tokensSaved: aimemStats?.tokens_saved || 0,
                        reductionPct: aimemStats?.reduction_pct || 0
                    }
                })
            };
            try {
                res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
            } catch (writeErr) { /* client disconnected */ }

            // If there's remaining content, store it for continuation
            if (remainingContent && req.body.conversationId) {
                contentContinuationQueue.set(req.body.conversationId, {
                    content: remainingContent,
                    processedChunks: truncationInfo?.currentChunk || 1,
                    totalChunks: truncationInfo?.totalChunks || 1,
                    contextSize,
                    modelName: targetModel,
                    timestamp: Date.now()
                });
                console.log(`[Chat Stream] Queued ${remainingContent.length} chars for continuation (conversation: ${req.body.conversationId})`);
            }

            try {
                res.write(`data: [DONE]\n\n`);
            } catch (writeErr) { /* client disconnected */ }

            // Update token usage stats
            if (req.apiKeyData) {
                const stats = apiKeyUsageStats.get(req.apiKeyData.id);
                if (stats && stats.requests.length > 0) {
                    const totalTokens = promptTokens + completionTokens;
                    const lastReq = stats.requests[stats.requests.length - 1];
                    lastReq.tokens = totalTokens;
                    stats.tokenCount += totalTokens;
                    apiKeyUsageStats.set(req.apiKeyData.id, stats);
                }
            }

            // Broadcast chat request completion to logs
            const chatResponseTimeMs = Date.now() - streamStartTime;
            const chatTotalTokens = promptTokens + completionTokens;
            broadcast({
                type: 'log',
                message: `[Chat] ${targetModel} | ${chatTotalTokens} tokens (${promptTokens} prompt + ${completionTokens} completion) | ${chatResponseTimeMs >= 1000 ? (chatResponseTimeMs / 1000).toFixed(1) + 's' : chatResponseTimeMs + 'ms'} | Conversation: ${streamingConversationId?.substring(0, 8) || 'N/A'}`,
                level: 'info'
            });

            try {
                res.end();
            } catch (endErr) { /* client disconnected */ }
        }

        // Handle client disconnect - DON'T destroy stream, let it continue in background
        req.on('close', () => {
            clientConnected = false;
            // Update the job to mark client as disconnected
            if (streamingConversationId) {
                const job = activeStreamingJobs.get(streamingConversationId);
                if (job) {
                    job.clientConnected = false;
                    console.log(`[Chat Stream] Client disconnected for conversation ${streamingConversationId}, continuing in background...`);
                }
            }
        });

    } catch (error) {
        // Build detailed error message for debugging and user feedback
        let errorMessage = 'Failed to get response from model';
        let errorDetails = '';

        // Handle stream response data (axios returns streams when responseType is 'stream')
        if (error.response?.data && typeof error.response.data.on === 'function') {
            // It's a stream - read it to get the error message
            try {
                const chunks = [];
                for await (const chunk of error.response.data) {
                    chunks.push(chunk);
                }
                const errorBody = Buffer.concat(chunks).toString('utf8');
                console.error('Chat stream error:', error.message, '| Status:', error.response?.status, '| Response:', errorBody);

                // Try to parse as JSON
                try {
                    const parsed = JSON.parse(errorBody);
                    errorDetails = parsed.error?.message || parsed.error || errorBody;
                } catch (e) {
                    errorDetails = errorBody;
                }
            } catch (streamErr) {
                console.error('Chat stream error:', error.message, '| Status:', error.response?.status, '| Could not read stream');
                errorDetails = error.message;
            }
        }
        // Extract error details from various sources (non-stream responses)
        else if (error.response?.data?.error?.message) {
            errorDetails = error.response.data.error.message;
            console.error('Chat stream error:', error.message, '| Status:', error.response?.status, '| Response:', errorDetails);
        } else if (error.response?.data?.error) {
            errorDetails = typeof error.response.data.error === 'string'
                ? error.response.data.error
                : JSON.stringify(error.response.data.error);
            console.error('Chat stream error:', error.message, '| Status:', error.response?.status, '| Response:', errorDetails);
        } else if (error.response?.data) {
            try {
                errorDetails = typeof error.response.data === 'string'
                    ? error.response.data
                    : JSON.stringify(error.response.data);
                console.error('Chat stream error:', error.message, '| Status:', error.response?.status, '| Response:', errorDetails);
            } catch (e) {
                errorDetails = 'Error response could not be parsed';
            }
        } else if (error.message) {
            errorDetails = error.message;
            console.error('Chat stream error:', error.message, '| Status:', error.response?.status);
        } else {
            console.error('Chat stream error: Unknown error', '| Status:', error.response?.status);
        }

        // Categorize error types for better messages
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errorMessage = 'Model service is not responding. It may be starting up or has crashed.';
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
            errorMessage = 'Model service timed out. The request may be too large.';
        } else if (errorDetails.toLowerCase().includes('context') || errorDetails.toLowerCase().includes('token')) {
            errorMessage = 'Context window exceeded. Try reducing message length or clearing history.';
        } else if (errorDetails.toLowerCase().includes('memory') || errorDetails.toLowerCase().includes('oom') || errorDetails.toLowerCase().includes('cuda')) {
            errorMessage = 'Model ran out of memory. Try reducing context size or using a smaller model.';
        } else if (errorDetails.toLowerCase().includes('parse') || errorDetails.toLowerCase().includes('decode') || errorDetails.toLowerCase().includes('encoding')) {
            errorMessage = 'Failed to process input. The file may contain unsupported characters.';
        } else if (error.response?.status === 502 || error.response?.status === 503) {
            errorMessage = 'Model backend unavailable. Please wait for it to finish loading.';
        } else if (errorDetails) {
            // Use the detailed error if available
            errorMessage = errorDetails.length > 200 ? errorDetails.substring(0, 200) + '...' : errorDetails;
        }

        if (!res.writableEnded) {
            // Send error as SSE event with details
            const errorEvent = {
                error: {
                    message: errorMessage,
                    details: errorDetails.length > 500 ? errorDetails.substring(0, 500) : errorDetails,
                    code: error.code || error.response?.status || 'UNKNOWN'
                },
                done: true
            };
            res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
            res.end();
        }
    }
});

// Simplified completion endpoint
app.post('/api/complete', requireAuth, async (req, res) => {
    const { prompt, model, temperature, maxTokens } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    // Check permission
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    try {
        // Find first running instance or use specified model
        let targetModel = model;
        let targetInstance = null;

        if (!model) {
            targetInstance = Array.from(modelInstances.values())[0];
            if (!targetInstance) {
                return res.status(400).json({ error: 'No running models. Please load a model first.' });
            }
            targetModel = targetInstance.modelName || 'default';
        } else {
            targetInstance = modelInstances.get(model);
            if (!targetInstance) {
                return res.status(400).json({ error: `Model ${model} is not running. Please load it first.` });
            }
        }

        // Use container name for Docker network communication
        const targetHost = targetInstance.containerName || `host.docker.internal`;
        const targetPort = targetInstance.internalPort || targetInstance.port;

        // Load system prompt for this model
        const systemPrompts = await loadSystemPrompts();
        const systemPrompt = systemPrompts[targetModel] || '';

        // Prepend system prompt if one exists
        let finalPrompt = prompt;
        if (systemPrompt) {
            finalPrompt = `${systemPrompt}\n\n${prompt}`;
        }

        // Compute a safe max_tokens value. vLLM rejects the request if
        // input_tokens + max_tokens > contextSize, so we always clamp to the
        // space actually available for generation.
        const contextSize = (targetInstance.config && (targetInstance.config.contextSize || targetInstance.config.maxModelLen)) || 4096;
        const estimatedInputTokens = Math.ceil(finalPrompt.length / 4);
        const safetyMargin = 200;
        const minResponse = Math.min(512, Math.max(64, Math.floor(contextSize * 0.1)));
        const available = Math.max(minResponse, contextSize - estimatedInputTokens - safetyMargin);
        const safeMaxTokens = maxTokens
            ? Math.min(maxTokens, available)
            : Math.min(Math.max(2048, Math.floor(contextSize * 0.2)), available);

        const requestBody = {
            prompt: finalPrompt,
            temperature: temperature || 0.7,
            max_tokens: safeMaxTokens
        };

        const response = await axios.post(`http://${targetHost}:${targetPort}/v1/completions`, requestBody);

        // Simplify response
        const choice = response.data.choices[0];
        let text = choice.text || '';

        // Handle different finish reasons with specific messages
        if (!text) {
            if (choice.finish_reason === 'length') {
                return res.status(400).json({
                    success: false,
                    error: 'Not enough tokens: The response was truncated because the token limit was reached. Please increase maxTokens in your request.'
                });
            } else if (choice.finish_reason === 'content_filter') {
                return res.status(400).json({
                    success: false,
                    error: 'Content filtered: The response was blocked by content filtering.'
                });
            } else {
                return res.status(500).json({
                    success: false,
                    error: 'Empty response: The model returned no content. This may indicate an issue with the model or prompt.'
                });
            }
        }

        res.json({
            success: true,
            completion: text,
            model: targetModel,
            tokens: response.data.usage
        });
    } catch (error) {
        console.error('Completion error:', error.message);

        // Check for specific error types
        const errorMessage = error.response?.data?.error?.message || error.message || '';

        // Context window exceeded
        if (errorMessage.includes('context') || errorMessage.includes('too long') || errorMessage.includes('exceeds')) {
            return res.status(400).json({
                success: false,
                error: 'Not enough context window: Your prompt is too large for the model\'s context window. Please reduce the input size or increase the context size in model settings.'
            });
        }

        // Token rate limit
        if (errorMessage.includes('rate limit') || errorMessage.includes('too many tokens')) {
            return res.status(429).json({
                success: false,
                error: 'Token rate limit exceeded: You have exceeded your token rate limit. Please wait or increase your rate limit.'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to get completion from model',
            details: error.message
        });
    }
});

// ============================================================================
// MODEL DELETION ENDPOINT
// ============================================================================

app.delete('/api/models/:modelName', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'Models permission required' });
    }
    const { modelName } = req.params;
    console.log(`Request to delete model: ${modelName}`);

    try {
        // Stop instance if running
        if (modelInstances.has(modelName)) {
            broadcast({ type: 'log', message: `Stopping instance for ${modelName}...` });
            const instance = modelInstances.get(modelName);
            const container = docker.getContainer(instance.containerId);

            try {
                const containerInfo = await container.inspect();
                if (containerInfo.State.Running) {
                    try {
                        await container.kill();
                    } catch (killErr) {
                        await container.stop({ t: 5 }).catch(() => {});
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 500));
                await container.remove({ force: true, v: true });
            } catch (containerErr) {
                console.log(`Container cleanup issue for ${modelName}:`, containerErr.message);
            }

            modelInstances.delete(modelName);
            if (modelInstances.size === 0) stopSystemMonitoring();
            broadcast({ type: 'log', message: `Instance stopped.` });
        }

        // Delete model directory
        const modelPath = path.join('/models', modelName);
        broadcast({ type: 'log', message: `Deleting model directory ${modelPath}...` });
        await fs.rm(modelPath, { recursive: true, force: true });
        broadcast({ type: 'log', message: `Model directory deleted.` });

        res.json({ message: `Model ${modelName} deleted successfully` });
    } catch (error) {
        console.error(`Error deleting model ${modelName}:`, error.message);
        res.status(500).json({ error: `Failed to delete model ${modelName}: ${error.message}` });
    }
});

// ============================================================================
// APPS MANAGEMENT ENDPOINTS
// ============================================================================

// Helper function to map app names to their docker-compose services
// Returns services in the order they should be operated (for stop: proxy first, then app)
function getAppServices(appName) {
    const serviceMap = {};
    return serviceMap[appName] || [appName];
}

// Helper function to restart a docker compose service using dockerode
async function runDockerComposeCommand(command, serviceName) {
    if (command !== 'restart' && command !== 'start' && command !== 'stop') {
        throw new Error(`Unsupported command: ${command}. Only restart, start, and stop are supported.`);
    }

    try {
        // List all containers
        const containers = await docker.listContainers({ all: true });

        // Find container by service name (compose services have names like "modelserver-servicename-1")
        const serviceContainer = containers.find(c =>
            c.Names.some(n => n.includes(serviceName))
        );

        if (!serviceContainer) {
            throw new Error(`Container for service ${serviceName} not found`);
        }

        const container = docker.getContainer(serviceContainer.Id);

        // Execute the requested command
        try {
            if (command === 'restart') {
                await container.restart();
            } else if (command === 'start') {
                await container.start();
            } else if (command === 'stop') {
                await container.stop();
            }
        } catch (cmdError) {
            // Handle "already started" (304) as success for start command
            if (command === 'start' && cmdError.statusCode === 304) {
                return { success: true, output: `${serviceName} was already running` };
            }
            // Handle "already stopped" (304) as success for stop command
            if (command === 'stop' && cmdError.statusCode === 304) {
                return { success: true, output: `${serviceName} was already stopped` };
            }
            throw cmdError;
        }

        return { success: true, output: `${command} completed for ${serviceName}` };
    } catch (error) {
        throw new Error(`Failed to ${command} ${serviceName}: ${error.message}`);
    }
}

// Helper function to get service status
async function getServiceStatus(serviceName) {
    try {
        const containers = await docker.listContainers({ all: true });
        const serviceContainer = containers.find(c =>
            c.Names.some(n => n.includes(serviceName))
        );

        if (!serviceContainer) {
            return { status: 'not_found', container: null };
        }

        const container = docker.getContainer(serviceContainer.Id);
        const inspect = await container.inspect();

        return {
            status: inspect.State.Running ? 'running' : 'stopped',
            container: {
                id: serviceContainer.Id,
                name: serviceContainer.Names[0],
                state: inspect.State.Status,
                startedAt: inspect.State.StartedAt,
                ports: serviceContainer.Ports
            }
        };
    } catch (error) {
        return { status: 'error', error: error.message };
    }
}

// Helper function to get the host IP address
function getHostIp() {
    // Try to get host IP from environment variable
    if (process.env.HOST_IP) {
        return process.env.HOST_IP;
    }

    // Try to resolve host.docker.internal to get the host IP
    try {
        const dns = require('dns');
        const addresses = dns.lookup('host.docker.internal', (err, address) => {
            if (!err && address) {
                return address;
            }
        });
    } catch (e) {
        // Ignore DNS errors
    }

    const interfaces = os.networkInterfaces();
    // Look for non-internal IPv4 address, skipping Docker bridge networks
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (loopback), non-IPv4, and Docker bridge networks (172.16.0.0/12)
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                // Skip Docker bridge networks (172.16.0.0 - 172.31.255.255)
                const parts = ip.split('.');
                if (parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) {
                    continue; // Skip Docker network
                }
                // Also skip 10.x.x.x Docker networks
                if (parts[0] === '10') {
                    continue;
                }
                return ip;
            }
        }
    }
    // Fallback to localhost if no external IP found
    return 'localhost';
}

// List all manageable apps
app.get('/api/apps', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    try {
        const hostIp = getHostIp();
        const apps = [
            {
                name: 'open-model-agents',
                displayName: 'Open Model Agents',
                description: 'AI agent management and automation system',
                ports: [],
                url: null,
                status: { status: 'running', type: 'integrated' },
                integrated: true // Built-in feature, not a Docker service
            },
            {
                name: 'backend-llamacpp',
                displayName: 'llama.cpp Backend',
                description: 'GGUF model inference - Works with older GPUs (Maxwell 5.2+)',
                ports: [],
                url: null,
                status: {
                    status: activeBackend === 'llamacpp' ? 'running' : 'stopped',
                    type: 'backend'
                },
                integrated: true,
                isBackend: true,
                backendType: 'llamacpp',
                isActive: activeBackend === 'llamacpp'
            },
            {
                name: 'backend-vllm',
                displayName: 'vLLM Backend',
                description: 'High-throughput inference - Best for newer GPUs (Pascal 6.0+)',
                ports: [],
                url: null,
                status: {
                    status: activeBackend === 'vllm' ? 'running' : 'stopped',
                    type: 'backend'
                },
                integrated: true,
                isBackend: true,
                backendType: 'vllm',
                isActive: activeBackend === 'vllm'
            }
        ];

        res.json(apps);
    } catch (error) {
        console.error('Error getting apps:', error);
        res.status(500).json({ error: 'Failed to get apps list' });
    }
});

// Start a service
app.post('/api/apps/:name/start', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    const { name } = req.params;

    try {
        const services = getAppServices(name);
        broadcast({ type: 'log', message: `Starting ${name}...` });

        // Start services in reverse order (app first, then proxy)
        for (const service of services.reverse()) {
            await runDockerComposeCommand('start', service);
        }

        broadcast({ type: 'status', message: `${name} started successfully` });
        broadcast({ type: 'service_status_changed', serviceName: name, status: 'running' });

        res.json({ success: true, message: `${name} started successfully` });
    } catch (error) {
        console.error(`Error starting ${name}:`, error);
        broadcast({ type: 'log', message: `Failed to start ${name}: ${error.message}`, level: 'error' });
        res.status(500).json({ error: `Failed to start ${name}`, details: error.message });
    }
});

// Stop a service
app.post('/api/apps/:name/stop', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    const { name } = req.params;

    // Send response immediately to prevent timeout
    res.json({ success: true, message: `Stopping ${name}...` });

    // Perform stop operation asynchronously
    try {
        const services = getAppServices(name);
        broadcast({ type: 'log', message: `Stopping ${name}...` });

        // Stop services in order (proxy first, then app)
        for (const service of services) {
            await runDockerComposeCommand('stop', service);
        }

        broadcast({ type: 'status', message: `${name} stopped successfully` });
        broadcast({ type: 'service_status_changed', serviceName: name, status: 'stopped' });
    } catch (error) {
        console.error(`Error stopping ${name}:`, error);
        broadcast({ type: 'log', message: `Failed to stop ${name}: ${error.message}`, level: 'error' });
    }
});

// Restart a service
app.post('/api/apps/:name/restart', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    const { name } = req.params;

    try {
        const services = getAppServices(name);
        broadcast({ type: 'log', message: `Restarting ${name}...` });

        // Restart services in order (proxy first, then app)
        for (const service of services) {
            await runDockerComposeCommand('restart', service);
        }

        broadcast({ type: 'status', message: `${name} restarted successfully` });
        broadcast({ type: 'service_status_changed', serviceName: name, status: 'running' });

        res.json({ success: true, message: `${name} restarted successfully` });
    } catch (error) {
        console.error(`Error restarting ${name}:`, error);
        broadcast({ type: 'log', message: `Failed to restart ${name}: ${error.message}`, level: 'error' });
        res.status(500).json({ error: `Failed to restart ${name}`, details: error.message });
    }
});

// ============================================================================
// BACKEND MANAGEMENT ENDPOINTS
// ============================================================================

// Get current active backend
app.get('/api/backend/active', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'models')) {
        return res.status(403).json({ error: 'models permission required' });
    }

    try {
        // Count running instances per backend
        let llamacppCount = 0;
        let vllmCount = 0;

        for (const [_, instance] of modelInstances) {
            if (instance.backend === 'llamacpp') llamacppCount++;
            else if (instance.backend === 'vllm') vllmCount++;
        }

        res.json({
            activeBackend,
            runningInstances: {
                llamacpp: llamacppCount,
                vllm: vllmCount
            }
        });
    } catch (error) {
        console.error('Error getting active backend:', error);
        res.status(500).json({ error: 'Failed to get active backend' });
    }
});

// Set active backend (switches backends, stops instances of old backend)
app.post('/api/backend/active', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    const { backend, stopInstances } = req.body;

    if (!backend || !['llamacpp', 'vllm'].includes(backend)) {
        return res.status(400).json({ error: 'Invalid backend. Must be "llamacpp" or "vllm"' });
    }

    try {
        const previousBackend = activeBackend;

        if (previousBackend === backend) {
            return res.json({
                success: true,
                message: `Backend is already set to ${backend}`,
                activeBackend: backend,
                instancesStopped: 0
            });
        }

        // If stopInstances is true, stop all instances of the previous backend
        let instancesStopped = 0;
        if (stopInstances !== false) {
            broadcast({ type: 'log', message: `Switching backend from ${previousBackend} to ${backend}...` });

            // Stop all instances of the previous backend
            for (const [modelName, instance] of modelInstances) {
                if (instance.backend === previousBackend) {
                    try {
                        broadcast({ type: 'log', message: `Stopping ${modelName} (${previousBackend})...` });
                        const container = docker.getContainer(instance.containerId);
                        await container.stop();
                        await container.remove();
                        modelInstances.delete(modelName);
                        if (modelInstances.size === 0) stopSystemMonitoring();
                        instancesStopped++;
                        broadcast({ type: 'model_stopped', modelName, instancesStopped });
                    } catch (err) {
                        console.error(`Error stopping instance ${modelName}:`, err);
                    }
                }
            }
        }

        // Set the new active backend
        activeBackend = backend;

        broadcast({
            type: 'backend_changed',
            previousBackend,
            activeBackend: backend,
            instancesStopped
        });

        broadcast({ type: 'status', message: `Backend switched to ${backend}` });

        res.json({
            success: true,
            message: `Backend switched from ${previousBackend} to ${backend}`,
            activeBackend: backend,
            instancesStopped
        });
    } catch (error) {
        console.error('Error switching backend:', error);
        res.status(500).json({ error: 'Failed to switch backend', details: error.message });
    }
});

// ============================================================================
// SYSTEM RESET ENDPOINT
// ============================================================================

app.post('/api/system/reset', requireAuth, async (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'admin')) {
        return res.status(403).json({ error: 'Admin permission required' });
    }

    const { confirmation } = req.body;

    // Require explicit confirmation
    if (confirmation !== 'RESET') {
        return res.status(400).json({ error: 'Invalid confirmation. Please type "RESET" to confirm.' });
    }

    broadcast({ type: 'log', message: '=== SYSTEM RESET INITIATED ===' });
    broadcast({ type: 'log', message: 'This will stop all instances and delete all models...' });

    try {
        // Step 1: Stop all vLLM instances
        broadcast({ type: 'log', message: 'Step 1/4: Stopping all vLLM instances...' });
        const instanceNames = Array.from(modelInstances.keys());

        for (const modelName of instanceNames) {
            try {
                const instance = modelInstances.get(modelName);
                if (instance) {
                    broadcast({ type: 'log', message: `  Stopping ${modelName}...` });
                    const container = docker.getContainer(instance.containerId);

                    try {
                        const containerInfo = await container.inspect();
                        if (containerInfo.State.Running) {
                            await container.kill().catch(() => container.stop({ t: 5 }));
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await container.remove({ force: true, v: true });
                    } catch (containerErr) {
                        // Container might not exist, continue
                    }

                    modelInstances.delete(modelName);
                    if (modelInstances.size === 0) stopSystemMonitoring();
                }
            } catch (error) {
                broadcast({ type: 'log', message: `  Warning: ${error.message}` });
            }
        }
        broadcast({ type: 'log', message: '  All instances stopped.' });

        // Step 2: Delete all model directories (except .modelserver)
        broadcast({ type: 'log', message: 'Step 2/4: Deleting all model directories...' });
        const modelsDir = '/models';

        try {
            const entries = await fs.readdir(modelsDir, { withFileTypes: true });
            const modelDirs = entries.filter(dirent =>
                dirent.isDirectory() &&
                !dirent.name.startsWith('.') &&
                !dirent.name.startsWith('models--')
            );

            for (const dirent of modelDirs) {
                const modelPath = path.join(modelsDir, dirent.name);
                broadcast({ type: 'log', message: `  Deleting ${dirent.name}...` });
                await fs.rm(modelPath, { recursive: true, force: true });
            }
            broadcast({ type: 'log', message: `  Deleted ${modelDirs.length} model(s).` });
        } catch (error) {
            broadcast({ type: 'log', message: `  Warning: ${error.message}` });
        }

        // Step 3: Docker cleanup
        broadcast({ type: 'log', message: 'Step 3/4: Running Docker cleanup...' });

        // Prune stopped vLLM containers
        try {
            broadcast({ type: 'log', message: '  Removing stopped vLLM containers...' });
            const containers = await docker.listContainers({ all: true });
            const vllmContainers = containers.filter(c => c.Names.some(n => n.includes('vllm-')));

            for (const containerInfo of vllmContainers) {
                try {
                    const container = docker.getContainer(containerInfo.Id);
                    const inspect = await container.inspect();
                    if (!inspect.State.Running) {
                        await container.remove({ force: true, v: true });
                        broadcast({ type: 'log', message: `    Removed ${containerInfo.Names[0]}` });
                    }
                } catch (err) {
                    // Container might be already removed
                }
            }
        } catch (error) {
            broadcast({ type: 'log', message: `  Warning: ${error.message}` });
        }

        // Prune unused images (optional - commented out to preserve base images)
        // broadcast({ type: 'log', message: '  Pruning unused Docker images...' });
        // await docker.pruneImages({ filters: { dangling: { false: true } } });

        broadcast({ type: 'log', message: '  Docker cleanup complete.' });

        // Step 4: Verification
        broadcast({ type: 'log', message: 'Step 4/4: Verifying reset...' });
        const remainingModels = await fs.readdir(modelsDir, { withFileTypes: true });
        const modelCount = remainingModels.filter(d =>
            d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('models--')
        ).length;

        broadcast({ type: 'log', message: `  Remaining models: ${modelCount}` });
        broadcast({ type: 'log', message: `  Running instances: ${modelInstances.size}` });

        broadcast({ type: 'log', message: '=== SYSTEM RESET COMPLETE ===' });
        broadcast({ type: 'status', message: 'System reset complete. All models deleted and instances stopped.' });

        res.json({
            success: true,
            message: 'System reset complete',
            details: {
                instancesStopped: instanceNames.length,
                modelsDeleted: modelDirs ? modelDirs.length : 0,
                remainingModels: modelCount,
                remainingInstances: modelInstances.size
            }
        });
    } catch (error) {
        console.error('System reset error:', error);
        broadcast({ type: 'log', message: `ERROR: ${error.message}`, level: 'error' });
        res.status(500).json({ error: 'System reset failed', details: error.message });
    }
});

// ============================================================================
// INITIALIZATION - Create default API keys
// ============================================================================

async function initializeDefaultSkills() {
    try {
        await ensureDataDir();
        const skills = await loadSkills();

        // Only initialize if no skills exist
        if (skills.length > 0) {
            return;
        }

        console.log('Initializing default Python skills...');

        // Load default skills from JSON file
        const defaultSkillsPath = path.join(__dirname, 'default-skills.json');
        const defaultSkillsJson = await fs.readFile(defaultSkillsPath, 'utf8');
        const defaultSkillsTemplate = JSON.parse(defaultSkillsJson);

        // Add IDs and timestamps
        const defaultSkills = defaultSkillsTemplate.map(skill => ({
            id: crypto.randomBytes(16).toString('hex'),
            ...skill,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }));

        // Save skills
        await saveSkills(defaultSkills);
        console.log(`✓ Created ${defaultSkills.length} default Python skills`);

    } catch (error) {
        console.error('Error initializing default skills:', error);
    }
}

// Old hardcoded version (kept for reference, can be deleted)
async function initializeDefaultSkillsOld() {
    try {
        await ensureDataDir();
        const skills = await loadSkills();

        if (skills.length > 0) {
            return;
        }

        console.log('Initializing default Python skills (old)...');

        const defaultSkills = [
            // FILE OPERATIONS (Functions)
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'create_file',
                description: 'Create a new file with specified content',
                type: 'function',
                parameters: { filePath: 'string', content: 'string' },
                code: `def execute(params):
    """Create a new file with specified content."""
    import os

    file_path = params.get('filePath')
    if not file_path:
        return {'success': False, 'error': 'filePath parameter is required'}

    content = params.get('content', '')

    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    with open(file_path, 'w') as f:
        f.write(content)

    return {
        'success': True,
        'message': f'File created: {file_path}',
        'filePath': file_path,
        'size': len(content)
    }`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'read_file',
                description: 'Read contents of a file',
                type: 'function',
                parameters: { filePath: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }
    const content = await fs.readFile(params.filePath, 'utf8');
    return { success: true, content };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'update_file',
                description: 'Update an existing file with new content',
                type: 'function',
                parameters: { filePath: 'string', content: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }
    const content = params.content || '';
    await fs.writeFile(params.filePath, content);
    return { success: true, message: \`File updated: \${params.filePath}\` };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'delete_file',
                description: 'Delete a file from the filesystem',
                type: 'function',
                parameters: { filePath: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }
    await fs.unlink(params.filePath);
    return { success: true, message: \`File deleted: \${params.filePath}\` };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'list_directory',
                description: 'List all files and directories in a path',
                type: 'function',
                parameters: { dirPath: 'string' },
                code: `async function execute(params) {
    if (!params.dirPath) {
        throw new Error('dirPath parameter is required');
    }
    const files = await fs.readdir(params.dirPath);
    return { success: true, files };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'move_file',
                description: 'Move or rename a file',
                type: 'function',
                parameters: { sourcePath: 'string', destPath: 'string' },
                code: `async function execute(params) {
    if (!params.sourcePath || !params.destPath) {
        throw new Error('sourcePath and destPath parameters are required');
    }
    await fs.rename(params.sourcePath, params.destPath);
    return { success: true, message: \`File moved: \${params.sourcePath} -> \${params.destPath}\` };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'copy_file',
                description: 'Copy a file to a new location',
                type: 'function',
                parameters: { sourcePath: 'string', destPath: 'string' },
                code: `async function execute(params) {
    if (!params.sourcePath || !params.destPath) {
        throw new Error('sourcePath and destPath parameters are required');
    }
    await fs.copyFile(params.sourcePath, params.destPath);
    return { success: true, message: \`File copied: \${params.sourcePath} -> \${params.destPath}\` };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },

            // WEB & NETWORK (Tools)
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'web_search',
                description: 'Search the web for information using DuckDuckGo (news, articles, websites)',
                type: 'tool',
                parameters: { query: 'string', maxResults: 'number' },
                code: `async function execute(params) {
    if (!params.query) {
        throw new Error('query parameter is required');
    }

    const axios = require('axios');
    const maxResults = Math.min(params.maxResults || 10, 20); // Cap at 20 results

    try {
        // Use DuckDuckGo HTML search (no API key required)
        const response = await axios.get('https://html.duckduckgo.com/html/', {
            params: { q: params.query },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000
        });

        const html = response.data;
        const results = [];

        // Parse DuckDuckGo HTML results
        // Results are in divs with class "result"
        const resultRegex = /<div class="result[^"]*"[^>]*>(.*?)<\\/div>\\s*<\\/div>\\s*<\\/div>/gs;
        const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\\/a>/s;
        const snippetRegex = /<a class="result__snippet"[^>]*>(.*?)<\\/a>/s;

        let match;
        let count = 0;

        while ((match = resultRegex.exec(html)) !== null && count < maxResults) {
            const resultHtml = match[1];

            const titleMatch = titleRegex.exec(resultHtml);
            const snippetMatch = snippetRegex.exec(resultHtml);

            if (titleMatch) {
                const url = titleMatch[1].replace(/&amp;/g, '&');
                const title = titleMatch[2]
                    .replace(/<[^>]*>/g, '') // Remove HTML tags
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&#x27;/g, "'")
                    .trim();

                const snippet = snippetMatch ? snippetMatch[1]
                    .replace(/<[^>]*>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&#x27;/g, "'")
                    .trim() : '';

                if (url && title) {
                    results.push({
                        title: title,
                        url: url,
                        snippet: snippet
                    });
                    count++;
                }
            }
        }

        if (results.length === 0) {
            return {
                success: true,
                query: params.query,
                results: [],
                message: 'No results found. Try a different search query.'
            };
        }

        return {
            success: true,
            query: params.query,
            resultCount: results.length,
            results: results
        };

    } catch (error) {
        throw new Error(\`Web search failed: \${error.message}\`);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'fetch_url',
                description: 'Fetch content from a URL',
                type: 'tool',
                parameters: { url: 'string' },
                code: `async function execute(params) {
    if (!params.url) {
        throw new Error('url parameter is required');
    }
    const axios = require('axios');
    try {
        const response = await axios.get(params.url, {
            timeout: 30000,
            maxRedirects: 5
        });
        return {
            success: true,
            status: response.status,
            headers: response.headers,
            data: response.data,
            url: params.url
        };
    } catch (error) {
        throw new Error(\`Failed to fetch URL: \${error.message}\`);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'dns_lookup',
                description: 'Perform DNS lookup for a domain',
                type: 'tool',
                parameters: { domain: 'string' },
                code: `async function execute(params) {
    if (!params.domain) {
        throw new Error('domain parameter is required');
    }
    const dns = require('dns').promises;
    try {
        const addresses = await dns.resolve4(params.domain);
        const addresses6 = await dns.resolve6(params.domain).catch(() => []);
        return {
            success: true,
            domain: params.domain,
            ipv4: addresses,
            ipv6: addresses6
        };
    } catch (error) {
        throw new Error(\`DNS lookup failed: \${error.message}\`);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'check_port',
                description: 'Check if a port is open on a host',
                type: 'tool',
                parameters: { host: 'string', port: 'number' },
                code: `async function execute(params) {
    if (!params.host || !params.port) {
        throw new Error('host and port parameters are required');
    }
    const net = require('net');
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = 5000;

        socket.setTimeout(timeout);
        socket.on('connect', () => {
            socket.destroy();
            resolve({
                success: true,
                host: params.host,
                port: params.port,
                open: true
            });
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({
                success: true,
                host: params.host,
                port: params.port,
                open: false,
                reason: 'timeout'
            });
        });

        socket.on('error', (err) => {
            socket.destroy();
            resolve({
                success: true,
                host: params.host,
                port: params.port,
                open: false,
                reason: err.code
            });
        });

        socket.connect(params.port, params.host);
    });
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'ping_host',
                description: 'Ping a host to check connectivity',
                type: 'tool',
                parameters: { host: 'string', count: 'number' },
                code: `async function execute(params) {
    if (!params.host) {
        throw new Error('host parameter is required');
    }
    const count = params.count || 4;
    const isWindows = process.platform === 'win32';
    const command = isWindows
        ? \`ping -n \${count} \${params.host}\`
        : \`ping -c \${count} \${params.host}\`;

    const { stdout, stderr } = await execPromise(command, { timeout: 30000 });

    // Parse output for basic stats
    const lines = stdout.split('\\n');
    return {
        success: true,
        host: params.host,
        count: count,
        output: stdout,
        reachable: !stderr && stdout.includes('bytes from')
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'http_request',
                description: 'Make custom HTTP requests (GET, POST, PUT, DELETE)',
                type: 'tool',
                parameters: { url: 'string', method: 'string', headers: 'object', body: 'string' },
                code: `async function execute(params) {
    if (!params.url) {
        throw new Error('url parameter is required');
    }
    const method = params.method || 'GET';
    const axios = require('axios');
    const config = {
        method: method.toUpperCase(),
        url: params.url,
        headers: params.headers || {},
        data: params.body
    };
    const response = await axios(config);
    return {
        success: true,
        status: response.status,
        headers: response.headers,
        data: response.data
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },

            // SYSTEM COMMANDS (Commands)
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'run_bash',
                description: 'Execute bash commands on Linux/macOS',
                type: 'command',
                parameters: { command: 'string', timeout: 'number' },
                code: `async function execute(params) {
    if (!params.command) {
        throw new Error('command parameter is required');
    }
    const timeout = params.timeout || 30000;
    const { stdout, stderr } = await execPromise(params.command, {
        shell: '/bin/bash',
        timeout: timeout
    });
    return {
        success: true,
        stdout: stdout,
        stderr: stderr
    };
}`,
                enabled: false, // Disabled by default for security
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'run_powershell',
                description: 'Execute PowerShell commands on Windows',
                type: 'command',
                parameters: { command: 'string', timeout: 'number' },
                code: `async function execute(params) {
    if (!params.command) {
        throw new Error('command parameter is required');
    }
    if (process.platform !== 'win32') {
        throw new Error('PowerShell is only available on Windows');
    }
    const timeout = params.timeout || 30000;
    const { stdout, stderr } = await execPromise(
        \`powershell.exe -Command "\${params.command}"\`,
        { shell: true, timeout: timeout }
    );
    return {
        success: true,
        stdout: stdout,
        stderr: stderr
    };
}`,
                enabled: false, // Disabled by default for security
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'run_python',
                description: 'Execute Python code',
                type: 'command',
                parameters: { code: 'string', timeout: 'number' },
                code: `async function execute(params) {
    if (!params.code) {
        throw new Error('code parameter is required');
    }
    const timeout = params.timeout || 30000;
    const tempFile = \`/tmp/python_script_\${Date.now()}.py\`;

    try {
        await fs.writeFile(tempFile, params.code);
        const { stdout, stderr } = await execPromise(
            \`python3 "\${tempFile}"\`,
            { timeout: timeout }
        );
        await fs.unlink(tempFile).catch(() => {});
        return {
            success: true,
            stdout: stdout,
            stderr: stderr
        };
    } catch (error) {
        await fs.unlink(tempFile).catch(() => {});
        throw new Error(\`Python execution failed: \${error.message}\`);
    }
}`,
                enabled: false, // Disabled by default for security
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'execute_command',
                description: 'Execute arbitrary system commands',
                type: 'command',
                parameters: { command: 'string', args: 'array', timeout: 'number' },
                code: `async function execute(params) {
    if (!params.command) {
        throw new Error('command parameter is required');
    }
    const timeout = params.timeout || 30000;
    const args = params.args || [];
    const fullCommand = \`\${params.command} \${args.join(' ')}\`;

    const { stdout, stderr } = await execPromise(fullCommand, {
        timeout: timeout,
        shell: true
    });
    return {
        success: true,
        command: params.command,
        args: args,
        stdout: stdout,
        stderr: stderr
    };
}`,
                enabled: false, // Disabled by default for security
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'netstat',
                description: 'Display network connections and listening ports',
                type: 'command',
                parameters: { flags: 'string' },
                code: `async function execute(params) {
    const flags = params.flags || '-tuln';
    const isWindows = process.platform === 'win32';
    const command = isWindows ? \`netstat \${flags}\` : \`netstat \${flags}\`;

    const { stdout, stderr } = await execPromise(command, { timeout: 10000 });
    return {
        success: true,
        output: stdout,
        stderr: stderr
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'process_list',
                description: 'List running processes',
                type: 'command',
                parameters: { filter: 'string' },
                code: `async function execute(params) {
    const isWindows = process.platform === 'win32';
    let command = isWindows ? 'tasklist' : 'ps aux';

    const { stdout, stderr } = await execPromise(command, { timeout: 10000 });

    let output = stdout;
    if (params.filter) {
        const lines = stdout.split('\\n');
        const filtered = lines.filter(line =>
            line.toLowerCase().includes(params.filter.toLowerCase())
        );
        output = filtered.join('\\n');
    }

    return {
        success: true,
        output: output,
        filter: params.filter || null
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'system_info',
                description: 'Get system information (CPU, memory, disk)',
                type: 'command',
                parameters: {},
                code: `async function execute(params) {
    const os = require('os');

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
        success: true,
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: os.uptime(),
        cpu: {
            model: os.cpus()[0].model,
            cores: os.cpus().length,
            speed: os.cpus()[0].speed
        },
        memory: {
            total: totalMem,
            free: freeMem,
            used: usedMem,
            percentUsed: ((usedMem / totalMem) * 100).toFixed(2)
        },
        loadAvg: os.loadavg()
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },

            // DATA PROCESSING (Functions)
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'parse_json',
                description: 'Parse and validate JSON data',
                type: 'function',
                parameters: { jsonString: 'string' },
                code: `function execute(params) {
    if (!params.jsonString) {
        throw new Error('jsonString parameter is required');
    }
    try {
        const data = JSON.parse(params.jsonString);
        return { success: true, data };
    } catch (error) {
        throw new Error('Invalid JSON: ' + error.message);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'parse_csv',
                description: 'Parse CSV data into structured format',
                type: 'function',
                parameters: { csvString: 'string', delimiter: 'string' },
                code: `function execute(params) {
    if (!params.csvString) {
        throw new Error('csvString parameter is required');
    }
    const delimiter = params.delimiter || ',';
    const lines = params.csvString.split('\\n').filter(l => l.trim());
    if (lines.length === 0) {
        return { success: true, data: [] };
    }
    const headers = lines[0].split(delimiter).map(h => h.trim());
    const data = lines.slice(1).map(line => {
        const values = line.split(delimiter);
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = values[i]?.trim() || '';
        });
        return obj;
    });
    return { success: true, data };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'format_markdown',
                description: 'Format text as Markdown',
                type: 'function',
                parameters: { text: 'string', options: 'object' },
                code: `function execute(params) {
    if (!params.text) {
        throw new Error('text parameter is required');
    }
    const options = params.options || {};
    let markdown = params.text;

    // Simple markdown formatting based on options
    if (options.bold) {
        markdown = \`**\${markdown}**\`;
    }
    if (options.italic) {
        markdown = \`*\${markdown}*\`;
    }
    if (options.code) {
        markdown = \`\\\`\${markdown}\\\`\`;
    }
    if (options.heading) {
        const level = options.heading || 1;
        markdown = \`\${'#'.repeat(level)} \${markdown}\`;
    }

    return { success: true, markdown };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'extract_text',
                description: 'Extract text/data from various file formats (TXT, JSON, XML, XLSX, PDF, DOCX, JPG, PNG, etc.)',
                type: 'function',
                parameters: { filePath: 'string', format: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }

    const filePath = params.filePath;
    // Auto-detect format from file extension if not specified
    let format = params.format;
    if (!format) {
        const ext = filePath.split('.').pop().toLowerCase();
        format = ext;
    }
    format = format.toLowerCase();

    try {
        // Text-based formats
        if (['txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv'].includes(format)) {
            const content = await fs.readFile(filePath, 'utf8');
            return { success: true, format, text: content, length: content.length };
        }

        // JSON format
        if (['json', 'jsonl'].includes(format)) {
            const content = await fs.readFile(filePath, 'utf8');
            try {
                const parsed = JSON.parse(content);
                return { success: true, format, data: parsed, text: JSON.stringify(parsed, null, 2) };
            } catch (e) {
                return { success: true, format, text: content, parseError: e.message };
            }
        }

        // XML format
        if (['xml', 'html', 'htm', 'svg'].includes(format)) {
            const content = await fs.readFile(filePath, 'utf8');
            // Simple text extraction - strip tags
            const textOnly = content.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
            return { success: true, format, text: textOnly, rawXml: content };
        }

        // Excel/XLSX format - requires xlsx package
        if (['xlsx', 'xls', 'xlsm'].includes(format)) {
            try {
                const XLSX = require('xlsx');
                const workbook = XLSX.readFile(filePath);
                const sheets = {};
                let allText = [];
                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const csv = XLSX.utils.sheet_to_csv(sheet);
                    sheets[sheetName] = csv;
                    allText.push(\`=== Sheet: \${sheetName} ===\\n\${csv}\`);
                }
                return { success: true, format, sheets, text: allText.join('\\n\\n'), sheetCount: workbook.SheetNames.length };
            } catch (e) {
                throw new Error(\`Failed to parse Excel file: \${e.message}. Make sure xlsx package is installed.\`);
            }
        }

        // PDF format - requires pdf-parse package
        if (format === 'pdf') {
            try {
                const pdfParse = require('pdf-parse');
                const buffer = await fs.readFile(filePath);
                const data = await pdfParse(buffer);
                return { success: true, format, text: repairPdfUrls(data.text), pages: data.numpages, info: data.info };
            } catch (e) {
                throw new Error(\`Failed to parse PDF: \${e.message}. Make sure pdf-parse package is installed.\`);
            }
        }

        // Word DOCX format - requires mammoth package
        if (['docx', 'doc'].includes(format)) {
            try {
                const mammoth = require('mammoth');
                const result = await mammoth.extractRawText({ path: filePath });
                return { success: true, format, text: result.value, messages: result.messages };
            } catch (e) {
                throw new Error(\`Failed to parse DOCX: \${e.message}. Make sure mammoth package is installed.\`);
            }
        }

        // Image formats - use jimp for basic info or OCR if available
        if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'].includes(format)) {
            try {
                const Jimp = require('jimp');
                const image = await Jimp.read(filePath);
                const info = {
                    width: image.bitmap.width,
                    height: image.bitmap.height,
                    format: image.getMIME(),
                    hasAlpha: image.hasAlpha()
                };
                return {
                    success: true,
                    format,
                    text: \`Image: \${info.width}x\${info.height} \${info.format}\`,
                    imageInfo: info,
                    note: 'For OCR text extraction, use the ocr_image skill instead'
                };
            } catch (e) {
                throw new Error(\`Failed to read image: \${e.message}\`);
            }
        }

        // Email format - requires mailparser
        if (['eml', 'email'].includes(format)) {
            try {
                const { simpleParser } = require('mailparser');
                const content = await fs.readFile(filePath);
                const parsed = await simpleParser(content);
                return {
                    success: true,
                    format,
                    text: parsed.text || parsed.textAsHtml || '',
                    subject: parsed.subject,
                    from: parsed.from?.text,
                    to: parsed.to?.text,
                    date: parsed.date,
                    attachments: parsed.attachments?.map(a => ({ filename: a.filename, size: a.size })) || []
                };
            } catch (e) {
                throw new Error(\`Failed to parse email: \${e.message}\`);
            }
        }

        // Default: try to read as text
        const content = await fs.readFile(filePath, 'utf8');
        return { success: true, format: 'unknown', text: content, note: 'Read as plain text' };
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(\`File not found: \${filePath}\`);
        }
        throw error;
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'base64_encode',
                description: 'Encode data to Base64',
                type: 'function',
                parameters: { data: 'string' },
                code: `function execute(params) {
    if (!params.data) {
        throw new Error('data parameter is required');
    }
    const encoded = Buffer.from(params.data).toString('base64');
    return { success: true, encoded };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'base64_decode',
                description: 'Decode Base64 data',
                type: 'function',
                parameters: { encodedData: 'string' },
                code: `function execute(params) {
    if (!params.encodedData) {
        throw new Error('encodedData parameter is required');
    }
    try {
        const decoded = Buffer.from(params.encodedData, 'base64').toString('utf8');
        return { success: true, decoded };
    } catch (error) {
        throw new Error('Invalid base64 data: ' + error.message);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },

            // CODE ANALYSIS (Tools)
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'analyze_code',
                description: 'Analyze code for patterns, complexity, and issues',
                type: 'tool',
                parameters: { code: 'string', language: 'string' },
                code: `function execute(params) {
    if (!params.code) {
        throw new Error('code parameter is required');
    }
    const code = params.code;
    const lines = code.split('\\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const commentLines = lines.filter(l => {
        const trimmed = l.trim();
        return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*');
    });

    return {
        success: true,
        language: params.language || 'unknown',
        totalLines: lines.length,
        codeLines: nonEmptyLines.length,
        commentLines: commentLines.length,
        averageLineLength: Math.round(code.length / lines.length)
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'find_patterns',
                description: 'Search for regex patterns in text or code',
                type: 'tool',
                parameters: { text: 'string', pattern: 'string', flags: 'string' },
                code: `function execute(params) {
    if (!params.text || !params.pattern) {
        throw new Error('text and pattern parameters are required');
    }
    const flags = params.flags || 'g';
    try {
        const regex = new RegExp(params.pattern, flags);
        const matches = [...params.text.matchAll(regex)];
        return {
            success: true,
            count: matches.length,
            matches: matches.map(m => ({
                match: m[0],
                index: m.index,
                groups: m.slice(1)
            }))
        };
    } catch (error) {
        throw new Error('Invalid regex pattern: ' + error.message);
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'count_lines',
                description: 'Count lines of code, comments, and blanks',
                type: 'tool',
                parameters: { filePath: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }
    const content = await fs.readFile(params.filePath, 'utf8');
    const lines = content.split('\\n');
    const blankLines = lines.filter(l => l.trim().length === 0).length;
    const commentLines = lines.filter(l => {
        const trimmed = l.trim();
        return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*');
    }).length;
    const codeLines = lines.length - blankLines - commentLines;

    return {
        success: true,
        filePath: params.filePath,
        totalLines: lines.length,
        codeLines: codeLines,
        commentLines: commentLines,
        blankLines: blankLines
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'syntax_check',
                description: 'Check syntax validity for various languages',
                type: 'tool',
                parameters: { code: 'string', language: 'string' },
                code: `function execute(params) {
    if (!params.code || !params.language) {
        throw new Error('code and language parameters are required');
    }

    try {
        if (params.language === 'javascript' || params.language === 'js') {
            // Try to parse as JavaScript
            new Function(params.code);
            return { success: true, valid: true, language: params.language };
        } else if (params.language === 'json') {
            JSON.parse(params.code);
            return { success: true, valid: true, language: params.language };
        } else {
            return {
                success: true,
                valid: null,
                language: params.language,
                message: 'Syntax checking not yet implemented for this language'
            };
        }
    } catch (error) {
        return {
            success: true,
            valid: false,
            language: params.language,
            error: error.message
        };
    }
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'git_status',
                description: 'Get git repository status',
                type: 'tool',
                parameters: { repoPath: 'string' },
                code: `async function execute(params) {
    if (!params.repoPath) {
        throw new Error('repoPath parameter is required');
    }
    const { stdout, stderr } = await execPromise(\`cd "\${params.repoPath}" && git status\`, {
        timeout: 10000
    });
    return {
        success: true,
        repoPath: params.repoPath,
        output: stdout,
        stderr: stderr
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'git_diff',
                description: 'Show git differences',
                type: 'tool',
                parameters: { repoPath: 'string', files: 'array' },
                code: `async function execute(params) {
    if (!params.repoPath) {
        throw new Error('repoPath parameter is required');
    }
    const filesArg = params.files && params.files.length > 0
        ? params.files.join(' ')
        : '';
    const { stdout, stderr } = await execPromise(
        \`cd "\${params.repoPath}" && git diff \${filesArg}\`,
        { timeout: 30000 }
    );
    return {
        success: true,
        repoPath: params.repoPath,
        files: params.files || [],
        diff: stdout,
        stderr: stderr
    };
}`,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ];

        await saveSkills(defaultSkills);
        console.log(`✓ Created ${defaultSkills.length} default skills`);

    } catch (error) {
        console.error('Error initializing default skills:', error);
    }
}

async function initializeDefaultApiKeys() {
    try {
        await ensureDataDir();
        const keys = await loadApiKeys();
        let keysCreated = false;

        // Check if chat integration key exists (for Model Chat on port 3002)
        // Also check for legacy name to avoid creating duplicates
        let chatKeyExists = keys.find(k => k.name === 'Model Chat Key' || k.name === 'OpenWebUI Integration Key');
        if (!chatKeyExists) {
            const chatKey = {
                id: crypto.randomUUID(),
                name: 'Model Chat Key',
                key: generateApiKey(),
                secret: generateApiSecret(),
                bearerOnly: true,
                permissions: ['query', 'models'],
                rateLimitRequests: null,
                rateLimitTokens: null,
                active: true,
                createdAt: new Date().toISOString()
            };
            keys.push(chatKey);
            console.log('');
            console.log('========================================');
            console.log('  Model Chat Key Created');
            console.log('========================================');
            console.log(`Bearer Token: ${chatKey.key}`);
            console.log('');
            keysCreated = true;
        }

        // Save API keys if any were created
        if (keysCreated) {
            await saveApiKeys(keys);
        }
    } catch (error) {
        console.error('Error initializing default API keys:', error);
    }
}

// ============================================================================
// CLI INSTALL SCRIPT ENDPOINT
// ============================================================================

/**
 * Validates and sanitizes the host header to prevent injection attacks.
 * Only allows valid hostname:port format.
 */
function sanitizeHost(hostHeader) {
    if (!hostHeader) return 'localhost:3001';

    // Only allow alphanumeric, dots, hyphens, colons (for port), and brackets (for IPv6)
    const sanitized = hostHeader.replace(/[^a-zA-Z0-9.:[\]-]/g, '');

    // Validate format: hostname or hostname:port or IP or [IPv6]:port
    const validHostPattern = /^([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?$/;
    if (!validHostPattern.test(sanitized)) {
        return 'localhost:3001';
    }

    return sanitized;
}

// Bash installer (Linux/macOS/WSL/Git Bash)
app.get('/api/cli/install', apiRateLimiter, (req, res) => {
    const scriptPath = path.join(__dirname, 'scripts/install-agents-cli.sh');
    const host = sanitizeHost(req.get('host'));
    const protocol = req.protocol || 'https';
    const apiUrl = `${protocol}://${host}`;

    fs.readFile(scriptPath, 'utf8')
        .then(content => {
            // Inject API URL into the script environment
            const modifiedContent = `export KODA_API_URL="${apiUrl}"\n` + content;

            res.setHeader('Content-Type', 'text/plain');
            res.send(modifiedContent);
        })
        .catch(error => {
            console.error('Error reading install script:', error);
            res.status(500).json({ error: 'Failed to load install script' });
        });
});

// PowerShell installer (Windows)
app.get('/api/cli/install.ps1', apiRateLimiter, (req, res) => {
    const scriptPath = path.join(__dirname, 'scripts/install-agents-cli.ps1');
    const host = sanitizeHost(req.get('host'));
    const protocol = req.protocol || 'https';
    const apiUrl = `${protocol}://${host}`;

    fs.readFile(scriptPath, 'utf8')
        .then(content => {
            // Inject API URL into the script
            const modifiedContent = `$env:KODA_API_URL = "${apiUrl}"\n` + content;

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(modifiedContent);
        })
        .catch(error => {
            console.error('Error reading PowerShell install script:', error);
            res.status(500).json({ error: 'Failed to load install script' });
        });
});

// Serve CLI files for download
app.get('/api/cli/files/package.json', apiRateLimiter, (req, res) => {
    const packagePath = path.join(__dirname, 'agents-cli/package.json');
    fs.readFile(packagePath, 'utf8')
        .then(content => {
            res.setHeader('Content-Type', 'application/json');
            res.send(content);
        })
        .catch(error => {
            console.error('Error reading package.json:', error);
            res.status(500).json({ error: 'Failed to load package.json' });
        });
});

app.get('/api/cli/files/koda.js', apiRateLimiter, (req, res) => {
    const kodaPath = path.join(__dirname, 'agents-cli/bin/koda.js');
    fs.readFile(kodaPath, 'utf8')
        .then(content => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(content);
        })
        .catch(error => {
            console.error('Error reading koda.js:', error);
            res.status(500).json({ error: 'Failed to load koda.js' });
        });
});

// ============================================================================
// OPENAI-COMPATIBLE API PROXY (Requires auth, forwards to vLLM instances)
// ============================================================================

// Proxy all /v1/* requests to vLLM instances with authentication
app.all('/v1/*', requireAuth, async (req, res) => {
    try {
        // Log authentication details for debugging
        const authType = req.apiKeyData?.bearerOnly ? 'Bearer Token' : 'API Key';
        const authName = req.apiKeyData?.name || 'Unknown';
        console.log(`[Proxy Auth] ${authType} (${authName}) accessing ${req.method} ${req.originalUrl}`);

        // Check permission
        if (!checkPermission(req.apiKeyData, 'query')) {
            console.log(`[Proxy] Permission denied for ${authName}`);
            return res.status(403).json({ error: 'Query permission required' });
        }

        // Get first running instance
        const instances = Array.from(modelInstances.values());
        if (instances.length === 0) {
            console.log('[Proxy] No running instances found');
            return res.status(503).json({ error: 'No models are currently running. Please load a model first.' });
        }

        const firstInstance = instances[0];
        // Use container name to reach vLLM via Docker network
        // Fall back to host.docker.internal for backwards compatibility
        const targetHost = firstInstance.containerName || `host.docker.internal`;
        const targetPort = firstInstance.internalPort || firstInstance.port;
        const targetUrl = `http://${targetHost}:${targetPort}${req.originalUrl}`;

        console.log(`[Proxy] Forwarding to ${targetUrl}`);

        // Check if this is a streaming request (handle both boolean and string "true")
        const streamParam = req.body?.stream;
        const isStreaming = streamParam === true || streamParam === 'true';
        if (req.body && streamParam !== undefined) {
            console.log(`[Proxy] Stream parameter:`, streamParam, `(type: ${typeof streamParam}, isStreaming: ${isStreaming})`);
        }

        if (isStreaming) {
            // Handle streaming response
            console.log('[Proxy] Streaming request detected');
            const response = await axios({
                method: req.method,
                url: targetUrl,
                data: req.body,
                headers: {
                    'Content-Type': req.headers['content-type'] || 'application/json',
                },
                responseType: 'stream',
                // Prevent axios from decompressing - let it pass through raw
                decompress: false
            });

            // Set chunked transfer encoding for streaming
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Content-Type', response.headers['content-type'] || 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Disable timeouts for streaming responses
            req.setTimeout(0);
            res.setTimeout(0);
            if (req.socket) req.socket.setTimeout(0);

            // Forward other response headers (excluding hop-by-hop headers)
            const headersToSkip = ['transfer-encoding', 'content-length', 'connection', 'keep-alive', 'content-type', 'cache-control'];
            Object.keys(response.headers).forEach(key => {
                if (!headersToSkip.includes(key.toLowerCase())) {
                    res.setHeader(key, response.headers[key]);
                }
            });

            // Set status code
            res.status(response.status);

            // Pipe the streaming response
            response.data.pipe(res);

            // Handle stream errors
            response.data.on('error', (error) => {
                console.error('[Proxy] Stream error:', error.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Stream error', details: error.message });
                } else {
                    res.end();
                }
            });

            // Handle stream end
            response.data.on('end', () => {
                if (!res.writableEnded) {
                    res.end();
                }
            });
        } else {
            // Handle non-streaming response (for token counting)
            const response = await axios({
                method: req.method,
                url: targetUrl,
                data: req.body,
                headers: {
                    'Content-Type': req.headers['content-type'] || 'application/json',
                }
            });

            // Track token usage
            if (response.data && (response.data.usage || response.data.tokens)) {
                const tokens = response.data.usage?.total_tokens || response.data.tokens?.total_tokens || 0;
                if (tokens > 0 && req.apiKeyData) {
                    const stats = apiKeyUsageStats.get(req.apiKeyData.id) || {
                        requestCount: 0,
                        tokenCount: 0,
                        lastUsed: Date.now(),
                        requests: []
                    };
                    stats.tokenCount += tokens;
                    const lastReq = stats.requests[stats.requests.length - 1];
                    if (lastReq) {
                        lastReq.tokens = tokens;
                    }
                    apiKeyUsageStats.set(req.apiKeyData.id, stats);
                    console.log(`[Proxy] Tracked ${tokens} tokens for ${req.apiKeyData.name}`);
                }
            }

            // Forward response headers (excluding hop-by-hop headers)
            const headersToSkip = ['transfer-encoding', 'content-length', 'connection', 'keep-alive'];
            Object.keys(response.headers).forEach(key => {
                if (!headersToSkip.includes(key.toLowerCase())) {
                    res.setHeader(key, response.headers[key]);
                }
            });

            // Forward status code and data
            res.status(response.status).json(response.data);
        }
    } catch (error) {
        console.error('[Proxy] Error:', error.message);
        if (error.response) {
            console.error('[Proxy] Response status:', error.response.status);
            console.error('[Proxy] Response data:', JSON.stringify(error.response.data));
            res.status(error.response.status).json(error.response.data || {
                error: 'Proxy error',
                details: error.message
            });
        } else {
            res.status(500).json({
                error: 'Failed to proxy request to vLLM',
                details: error.message
            });
        }
    }
});

// ============================================================================
// GLOBAL ERROR HANDLING MIDDLEWARE
// ============================================================================

// Catch-all error handler for Express routes (must be last middleware)
// This catches any errors thrown in async route handlers
app.use((err, req, res, next) => {
    console.error('Express error handler caught:', err);
    console.error('Stack:', err.stack);

    // Build detailed error message for the Logs tab
    const errorDetail = err.message || 'Internal server error';
    const route = `${req.method} ${req.originalUrl || req.url}`;
    const stack = err.stack
        ? err.stack.split('\n').slice(1, 3).join('\n').trim()
        : '';

    // Broadcast detailed error to connected clients (visible in Logs tab)
    try {
        broadcast({
            type: 'log',
            message: `[Error] ${route}: ${errorDetail}${stack ? `\n${stack}` : ''}`,
            level: 'error'
        });
    } catch (broadcastError) {
        console.error('Failed to broadcast error:', broadcastError);
    }

    // Return error message to API caller (useful for debugging in browser devtools)
    // Include the error message but not the stack trace for security
    res.status(err.status || 500).json({
        error: errorDetail
    });
});

// 404 handler - must come after all other routes
// Don't reveal endpoint information to prevent API discovery attacks
app.use((req, res) => {
    res.status(404).json({ error: 'Invalid request' });
});

// ============================================================================
// SERVER
// ============================================================================

const PORT = process.env.PORT || 3001;
const HTTP_REDIRECT_PORT = process.env.HTTP_REDIRECT_PORT || 3080;

server.listen(PORT, async () => {
    const protocol = useHttps ? 'https' : 'http';
    console.log(`Server is listening on ${protocol}://localhost:${PORT}`);

    // Parallel initialization for faster startup
    console.log('Starting parallel initialization...');

    // Phase 1: Independent async operations that don't depend on each other
    const [detectedPath, loadedStats] = await Promise.all([
        // Detect the host models path for creating dynamic containers
        // This is critical for cross-platform compatibility (Windows+WSL, macOS, Linux)
        detectHostModelsPath(),
        // Load API key usage stats from disk
        loadApiKeyUsageStats(),
        // Migrate unencrypted API keys to encrypted format (one-time operation)
        migrateApiKeysEncryption()
    ]);

    hostModelsPath = detectedPath;
    console.log(`Host models path configured: ${hostModelsPath}`);

    for (const [key, value] of loadedStats.entries()) {
        apiKeyUsageStats.set(key, value);
    }
    console.log(`Loaded usage stats for ${apiKeyUsageStats.size} API keys`);

    // Phase 2: Independent initialization tasks that can run in parallel
    await Promise.all([
        initializeDefaultSkills(),
        initializeDefaultApiKeys(),
        syncModelInstances()
    ]);

    console.log('Initialization complete');
});

// Start HTTP redirect server if HTTPS is enabled
if (useHttps && httpRedirectServer) {
    httpRedirectServer.listen(HTTP_REDIRECT_PORT, () => {
        console.log(`HTTP redirect server listening on port ${HTTP_REDIRECT_PORT} -> redirects to HTTPS`);
    });
}
