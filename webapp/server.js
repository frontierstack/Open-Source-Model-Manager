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
const { StringDecoder } = require('string_decoder');
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

// Persistent attachment store — keeps PDF bytes and structured xlsx
// rows on disk so they don't bloat conversation messages or the SSE
// stream. Loaded eagerly so upload + conversation-delete handlers can
// require it once.
const attachmentStore = require('./services/attachmentStore');

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

// SSRF protection: validate URLs against private IP ranges and dangerous protocols.
// Returns null if the URL is allowed, or a descriptive error string if it's blocked.
const PRIVATE_URL_MSG = 'URL points to a private/internal address — blocked for safety.';
function urlBlockReason(urlString) {
    let parsed;
    try { parsed = new URL(urlString); } catch { return 'Invalid URL.'; }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        const proto = parsed.protocol.replace(/:$/, '');
        return `Only http(s) URLs are accepted; got "${proto}://" — file://, javascript:, data:, etc. are not supported. To work with local files, use read_file / read_pdf instead of a fetch tool.`;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(hostname)) return PRIVATE_URL_MSG;
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
        if (parts[0] === 10) return PRIVATE_URL_MSG; // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return PRIVATE_URL_MSG; // 172.16.0.0/12
        if (parts[0] === 192 && parts[1] === 168) return PRIVATE_URL_MSG; // 192.168.0.0/16
        if (parts[0] === 169 && parts[1] === 254) return PRIVATE_URL_MSG; // 169.254.0.0/16 (link-local/AWS metadata)
        if (parts[0] === 0) return PRIVATE_URL_MSG; // 0.0.0.0/8
    }
    return null;
}

function isPrivateUrl(urlString) {
    return urlBlockReason(urlString) !== null;
}

// Validate model name to prevent path traversal (e.g. ../../etc/passwd)
function isValidModelName(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;
    // Reject path traversal sequences and absolute paths
    if (modelName.includes('..') || modelName.startsWith('/') || modelName.startsWith('\\')) return false;
    // Ensure resolved path stays within /models
    const resolved = path.resolve('/models', modelName);
    return resolved.startsWith('/models/');
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
    // Per-chunk timeout in milliseconds (legacy; kept for backward compat).
    // The active timeout used by the chunk request is chunkMaxTimeoutMs below.
    chunkTimeout: 300000,
    // Activity-based idle timeout (ms) — reserved for future streaming chunk
    // requests. The current chunk request is NON-streaming (stream: false),
    // so there is no per-token data-arrival event to reset against and this
    // value is NOT currently enforced. If the chunk path is ever converted
    // to SSE/streaming, wire setTimeout/reset to the response 'data' event
    // and abort via AbortController when the idle window elapses.
    chunkIdleTimeoutMs: 90000,
    // Wall-clock cap (ms) for a single chunk request. Because the request
    // is non-streaming we cannot reset on progress, so this is the hard
    // upper bound. Set generously (30 min) so legitimately-slow big chunks
    // on heavily-loaded backends are not killed mid-generation — the
    // previous 5 min cap was killing chunks the model was clearly still
    // working on. A model stuck in an infinite loop will still eventually
    // hit this cap and be aborted, preserving the safety net.
    chunkMaxTimeoutMs: 1800000,
    // Maximum retry attempts per chunk
    maxRetries: 3,
    // Enable content condensation before chunking
    enableCondensation: true,
    // Target compression ratio for condensation (0.3 = keep 30% of content)
    condensationRatio: 0.4,
    // Minimum sentences to keep even with condensation
    minSentencesToKeep: 50
};

// Default chat-completion stop strings. Needed for vLLM + GGUF chat models
// whose tokenizer EOS doesn't match the chat template turn terminator.
// Example: Qwen3 GGUF tokenizer EOS = <|endoftext|> (151643), but the ChatML
// template ends each turn with <|im_end|> (151645). Without explicit stops,
// vLLM happily generates past <|im_end|> and hallucinates further turns.
// These strings are safe to send for any backend/model — if the model never
// emits them, they're no-ops.
const DEFAULT_STOP_STRINGS = ['<|im_end|>', '<|im_start|>', '<|endoftext|>', '<|end|>', '<|eot_id|>'];

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
 * Cheap heuristic for "this content is code, not prose". Condensation and
 * map-reduce are both destructive on code: condenseContent drops ~60% of
 * sentences by relevance, and map-reduce splits the content so no single
 * chunk ever sees the whole program. For analytical tasks like malware
 * deobfuscation the model needs the raw payload, even if it means
 * truncating older chat turns instead.
 *
 * Two signals in the first ~3KB:
 *  1. Density of programming punctuation (brace / paren / semicolon /
 *     equals / brackets). Natural prose hovers around 1-2%; code is
 *     usually 6%+. This alone catches JSON, XML, minified JS, etc.
 *  2. Strict syntactic patterns — keywords only count when they appear
 *     in a position only real code uses (e.g. "function foo(",
 *     "const x =", "class Foo:", "require('..."). Bare English words
 *     like "for", "while", "public", "class" are NOT counted, because
 *     prose hits on them constantly and used to mis-classify markdown
 *     summaries as code, silently suppressing memory extraction.
 */
function looksLikeCode(content) {
    if (!content || content.length < 200) return false;
    const sample = content.slice(0, 3000);
    const codeSymbols = new Set(['{', '}', '(', ')', ';', '=', '[', ']', '<', '>']);
    let symbolHits = 0;
    for (let i = 0; i < sample.length; i++) {
        if (codeSymbols.has(sample[i])) symbolHits++;
    }
    const symbolDensity = symbolHits / sample.length;
    const strongPatterns = [
        /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/,          // function foo(
        /\bconst\s+[A-Za-z_$][\w$]*\s*=/,              // const x =
        /\blet\s+[A-Za-z_$][\w$]*\s*=/,                // let x =
        /\bvar\s+[A-Za-z_$][\w$]*\s*=/,                // var x =
        /\bdef\s+[A-Za-z_$][\w$]*\s*\(/,               // def foo(
        /\bclass\s+[A-Z][\w$]*\s*[\(:{]/,              // class Foo{/(/:
        /\bimport\s+.+?\s+from\s+['"]/,                // import X from '
        /\bfrom\s+['"][^'"]+['"]\s+import\b/,          // from "x" import
        /\brequire\s*\(\s*['"]/,                       // require('
        /\bmodule\.exports\s*=/,                       // module.exports =
        /#include\s*[<"]/,                             // C include
        /\btypedef\s+struct\b/,                        // C typedef struct
        /\basync\s+(function|def)\b/,                  // async function/def
        /\bthrow\s+new\s+\w+/,                         // throw new X
        /=>\s*[{(]/,                                   // arrow function
        /```[\w]*\n[\s\S]*?```/,                       // markdown fenced block
    ];
    let patternHits = 0;
    for (const p of strongPatterns) if (p.test(sample)) patternHits++;
    return symbolDensity >= 0.06 || patternHits >= 2;
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

    // Extract fenced code blocks and YARA-like rule blocks BEFORE splitting
    // into sentences. The sentence splitter doesn't understand multi-line
    // braced blocks — it would shatter a YARA rule or JSON object into
    // fragments that individually score near zero against a summarize-style
    // query and get stripped. Preserving these as atomic units (like URLs)
    // means users who ask follow-up questions about code in an article
    // ("give me the YARA rules", "show the config snippet") still find it
    // in the condensed content.
    const codeBlocks = [];
    let contentWithPlaceholders = content;
    const placeholder = (i) => `\u2063CODEBLOCK${i}\u2063`;

    // Markdown fenced blocks: ```lang\n...\n```
    contentWithPlaceholders = contentWithPlaceholders.replace(
        /```[\s\S]*?```/g,
        (match) => {
            const i = codeBlocks.length;
            codeBlocks.push(match);
            return placeholder(i);
        }
    );
    // Rule-style blocks: keyword Name { ... } where keyword is one the
    // detection/security community uses for standalone rule definitions.
    // Matches YARA (rule Foo {}), Sigma-like (detection: {}), Snort-ish
    // (alert tcp any ... (...)). Conservative — requires keyword + braces.
    contentWithPlaceholders = contentWithPlaceholders.replace(
        /\b(rule|detection|signature)\s+[A-Za-z_][\w]*\s*\{[\s\S]*?\n\}/g,
        (match) => {
            const i = codeBlocks.length;
            codeBlocks.push(match);
            return placeholder(i);
        }
    );
    // YAARA-L / Chronicle-style detection blocks: bare "events:" through
    // "condition:" body, no fence, no rule{} wrapper. These appear in
    // Google Cloud's threat intel posts (e.g. the ShinyHunters defense
    // article). The article has no consistent blank-line boundary between
    // a rule's condition body and the next rule's prose heading, so the
    // cleanest split is "from each events: to the next events: or end of
    // document". Each capture is atomic — rule body plus any trailing
    // description — and gets restored verbatim after condensation.
    contentWithPlaceholders = contentWithPlaceholders.replace(
        /(?:^|\n)events:\s*\n[\s\S]*?(?=\nevents:|$)/g,
        (match) => {
            const i = codeBlocks.length;
            codeBlocks.push(match.replace(/^\n/, ''));
            return (match.startsWith('\n') ? '\n' : '') + placeholder(i);
        }
    );

    // Split into sentences (handle various sentence endings)
    const sentenceRegex = /[^.!?\n]+[.!?\n]+/g;
    const sentences = contentWithPlaceholders.match(sentenceRegex) || [contentWithPlaceholders];

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
        length: sentence.length,
        // Sentences containing code block placeholders are preserved
        // unconditionally — they stand in for the verbatim block that
        // gets restored at the end of condensation.
        hasCodeBlock: /\u2063CODEBLOCK\d+\u2063/.test(sentence),
    }));

    // Sort by score (highest first)
    scoredSentences.sort((a, b) => b.score - a.score);

    // Always keep sentences containing URLs or code blocks — these are
    // high-value reference content that users frequently ask about and
    // should never be condensed out.
    const preserved = scoredSentences.filter(s => /https?:\/\//.test(s.sentence) || s.hasCodeBlock);
    const regular = scoredSentences.filter(s => !/https?:\/\//.test(s.sentence) && !s.hasCodeBlock);

    // Calculate target length
    const targetLength = Math.floor(originalLength * targetRatio);

    // Start with all preserved sentences, then fill remaining budget from scored regular sentences
    const selectedSentences = [...preserved];
    let currentLength = preserved.reduce((sum, s) => sum + s.length, 0);

    for (const scored of regular) {
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

    // Build condensed content then restore the verbatim code blocks that
    // were substituted out above. Sentences are joined with spaces, so a
    // placeholder that replaced a `\nevents:...` match now sits between
    // two spaces. Prepend `\n` on restoration so the restored block still
    // starts on its own line — both for the model's readability and for
    // downstream regexes (the YAARA-L detector relies on line-start).
    let condensed = selectedSentences.map(s => s.sentence).join(' ');
    condensed = condensed.replace(
        /\u2063CODEBLOCK(\d+)\u2063/g,
        (_, i) => '\n' + (codeBlocks[Number(i)] || '')
    );
    const condensedLength = condensed.length;
    const reductionPercent = Math.round((1 - condensedLength / originalLength) * 100);
    if (codeBlocks.length > 0) {
        console.log(`[Condensation] Preserved ${codeBlocks.length} code block(s) verbatim`);
    }

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
 * Whether a given model name recognises the `/no_think` control prefix as
 * a "disable chain-of-thought" directive. Qwen3 and DeepSeek-R1-style
 * checkpoints do; Gemma / Llama / Mistral / Phi / gpt-oss etc. treat it
 * as plain text and happily echo it back ("I don't understand the command
 * /no_think y"). Gate the prefix on this check so we don't poison turns
 * on models that aren't in on the protocol.
 */
function modelSupportsNoThinkPrefix(modelName) {
    if (!modelName) return false;
    return /qwen\s?[23]|qwen-?3|deepseek[-_ ]?r1|deepseek[-_ ]?v?3\.?\d*/i.test(modelName);
}

// Harmony / gpt-oss-style chat templates use special tokens like
// <|channel|>, <|message|>, <|tool_call|>, <|end|>. gemma-4 and some
// other GGUF fine-tunes run on a similar template and, when they get
// confused (tool-iteration cap hit, mid-turn de-rail), emit these
// tokens as literal TEXT in the content/reasoning stream instead of
// treating them as control. Users then see "<|channel><tool_call|>"
// flash by in the thinking area and the response just stops.
//
// Scrub any token-shaped sequence at the stream boundary so they never
// reach persisted content or the UI:
//   <|channel|>, <|tool_call|>         — well-formed
//   <|channel>, <|tool_call>           — missing closing `|`
//   <tool_call|>, <channel|>           — missing opening `|`
// Regular tags like <think>, <div>, </think> don't match (no `|`).
// Split-across-chunk leakage is accepted as a pragmatic tradeoff —
// token strings usually arrive in a single delta anyway.
const HARMONY_TOKEN_REGEX = /<\|[^>\n|]{0,60}\|?>|<[a-z_]{1,30}\|>/gi;
function scrubHarmonyTokens(s) {
    if (typeof s !== 'string' || !s) return s;
    return s.replace(HARMONY_TOKEN_REGEX, '');
}

// Reasoning-loop detector. Some models (observed on gemma-4 Harmony
// templates) get stuck in a "Wait, I will read X.**" style enumeration
// in their reasoning stream — 50+ numbered steps, no tool call, no
// content, just endless to-do restating. The tool-call loop detector
// can't catch this because there are no tool calls. This watches the
// reasoning accumulated during a single round and returns a reason
// string when it looks pathological; caller aborts the stream.
//
// Two signals:
//   - Hard cap: > REASONING_HARD_CAP chars of reasoning this round with
//     zero content and zero tool calls → abort. Safety net for cases
//     where the repeating phrase isn't one we recognize.
//   - Phrase repetition: recognizable loop phrases appearing 8+ times
//     in the last 4000 chars of the round's reasoning → abort. Catches
//     it earlier than the hard cap.
const REASONING_HARD_CAP = 15000;
const REASONING_CHECK_GRANULARITY = 1500;
const REASONING_LOOP_PHRASES = [
    { pattern: /\bWait,\s*I\s+will\b/gi, name: 'Wait, I will' },
    { pattern: /\bLet'?s\s+(go|start)\b/gi, name: "Let's go/start" },
    { pattern: /\bOkay,?\s+let'?s\b/gi, name: "Okay, let's" },
];
function makeReasoningLoopDetector() {
    // State per request. Tracks when we last ran the repetition check
    // so we don't scan the buffer on every 20-char SSE delta.
    let lastCheckAt = 0;
    return function detect(reasoningThisRound) {
        const len = reasoningThisRound.length;
        if (len - lastCheckAt < REASONING_CHECK_GRANULARITY) return null;
        lastCheckAt = len;
        if (len > REASONING_HARD_CAP) {
            return `hard cap (${REASONING_HARD_CAP} chars of reasoning with no content or tool call)`;
        }
        const tail = reasoningThisRound.slice(-4000);
        for (const { pattern, name } of REASONING_LOOP_PHRASES) {
            const matches = tail.match(pattern);
            if (matches && matches.length >= 8) {
                return `"${name}" appeared ${matches.length} times in the last ~4000 chars of reasoning`;
            }
        }
        return null;
    };
}

// Builds a short system-prompt prelude the chat stream prepends on every
// turn. Two jobs: (1) tell the model what today's actual date is — local
// models with training cutoffs earlier than "now" otherwise refuse queries
// about recent dates thinking they're in the future; (2) nudge tool
// selection so "current news / recent events" requests route to
// web_search instead of find_patterns or get_timestamp loops.
function buildChatRuntimePrelude() {
    const now = new Date();
    const iso = now.toISOString().slice(0, 10);
    const human = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    return (
        `Runtime context (injected by the server, not the user):\n` +
        `- Today's date is ${human} (${iso}). References to "today", "current", ` +
        `"recent", or a specific recent date refer to real data from the present, ` +
        `not the future. Your training cutoff is earlier than today; do not refuse ` +
        `or hedge a request on the basis of "not knowing" recent events — call a tool.\n` +
        `- For any question about current events, news, prices, release dates/times, ` +
        `sports results, stock/crypto prices, weather, real-time / recent information, ` +
        `or the current state of any public entity (companies, people, games, products): ` +
        `you MUST call web_search before answering. To read a specific URL, call fetch_url. ` +
        `find_patterns is a LOCAL regex on text you supply; it cannot search the web or ` +
        `any external corpus, so never use it to look up news or online data.\n` +
        `- Never state a specific date, time, price, version number, score, or other ` +
        `concrete fact about a real-world current event from memory. If the user asks ` +
        `"when does X release", "what's the price of Y", "who won Z" — call web_search ` +
        `first, cite the URL you pulled the fact from, and if the snippets don't contain ` +
        `the exact fact call fetch_url on the most authoritative-looking result.\n` +
        `- FOLLOW-UP questions: if the user asks about a specific detail (date, time, ` +
        `number, name) related to a topic you already searched, call web_search AGAIN ` +
        `with a query targeted at that detail. Do not paraphrase or infer from the ` +
        `previous turn's search snippets — they may not have contained the specific ` +
        `answer, and re-searching with a narrower query often surfaces it.\n` +
        `- If the user contests your answer ("wrong", "incorrect", "check again", ` +
        `"are you sure", "not right"): ALWAYS call web_search with a DIFFERENT, more ` +
        `specific query. Do not simply repeat your previous answer or re-run the same ` +
        `query. If two searches still disagree, present both and let the user decide ` +
        `— do not guess.\n` +
        `- When answering from web_search results, cite source URLs inline so the user ` +
        `can verify. Do not present search-derived facts as if from your own knowledge.\n` +
        `- If the same tool returns an empty or identical result twice in a row, stop ` +
        `calling it and switch strategy (usually: call web_search with different terms) ` +
        `or give the user a direct answer from what you already have.\n` +
        `- TOOL CATALOG: you have a large catalog of tools attached to this request — ` +
        `inspect the \`tools\` schemas, do not assume only web_search/fetch_url exist. ` +
        `Categories you can rely on: file ops (read_file, create_file, update_file, ` +
        `list_directory, search_files, grep_code, outline_file, replace_lines, ` +
        `diff_files, tail_file, head_file); parsing (parse_html, parse_xml, parse_yaml, ` +
        `parse_toml, parse_ini, parse_json, parse_csv, parse_url, parse_query_string, ` +
        `parse_jwt, parse_cookie, parse_user_agent, parse_email, parse_diff, parse_ip, ` +
        `parse_har, parse_pem, parse_sitemap, base64_decode); web (web_search, ` +
        `fetch_url, scrapling_fetch, playwright_fetch, crawl_pages); system & data ` +
        `(calculate, date_math, hash_data, ocr_image, system_info, dns_lookup, ` +
        `csv_describe, spreadsheet_query, chart_plot); git (git_status, git_diff, ` +
        `git_log, git_clone_shallow, git_show_commit, git_blame); plus many more. ` +
        `If the user's request matches a tool by name or purpose, USE IT.\n` +
        `- TOOL DISCIPLINE: when your reasoning concludes "I should use the X tool" ` +
        `or "I'll call Y", you must EMIT the tool_call immediately — do not narrate ` +
        `the call, do not say "I'll use calculate" and then answer from memory, do not ` +
        `apologize that the task is "trivial" and skip the call. Trivial tasks still ` +
        `get the tool call (calculate for "10+10", parse_url for any URL, base64_decode ` +
        `for any base64 string). Tools are cheap; guessing is expensive when wrong. ` +
        `Never write a tool name in prose as a substitute for invoking it.`
    );
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
function splitIntoChunks(content, chunkSizeTokens, overlapTokens = CHUNKING_CONFIG.overlapTokens, charsPerTokenOverride = null) {
    const { safetyMargin } = CHUNKING_CONFIG;
    // Use the measured ratio when caller provides one (from /tokenize),
    // otherwise fall back to the generic prose default.
    const charsPerToken = charsPerTokenOverride ?? CHUNKING_CONFIG.charsPerToken;

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

CRITICAL PRESERVATION RULES — these override any instinct to summarize:
- Copy the following content VERBATIM (byte-for-byte) from the chunk into your response, inside fenced code blocks. Do NOT paraphrase, abbreviate, describe, or omit them:
  * Fenced code blocks of any kind (\`\`\`...\`\`\`)
  * YARA rules, Sigma rules, Snort rules (blocks starting with "rule", "detection:", or "alert")
  * Regex patterns, SQL queries, shell commands, config snippets
  * JSON / XML / YAML objects that define structure or rules
  * Specific CVEs, IOCs (hashes, IPs, domains, URLs)
- If the chunk contains N code blocks or rules, your response must contain all N reproduced verbatim. These are the only way the synthesizer sees them.
- You may still add analysis PROSE around the preserved content. But the raw content must be present.
- When in doubt, include more, not less. A slightly long response is fine; a lossy summary is not.

CRITICAL ANTI-HALLUCINATION RULES:
- If the chunk REFERENCES code, rules, or data that are NOT actually present in the chunk text (e.g. placeholders like "21 lines hidden", "code omitted", "[collapsed]", or a section heading followed by no actual code), DO NOT invent or fabricate replacement content.
- Instead, explicitly record it as: "[SECTION "<section name>": code/rules referenced but NOT PRESENT in the chunk text]". The synthesizer will tell the user honestly that the content was missing from the source.
- NEVER write plausible-looking code, rules, regex, or configuration that approximates what you think the document probably contained. Output only what is literally present in the chunk text.
- If you are unsure whether a block is present or placeholder, include it verbatim only if the actual code tokens are visible. Otherwise mark as missing.
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

CRITICAL PRESERVATION RULES:
- If any chunk analysis contains fenced code blocks, YARA/Sigma/Snort rules,
  regex patterns, SQL, shell commands, config snippets, JSON/XML/YAML, or
  specific IOCs (hashes, IPs, domains, CVEs), reproduce them VERBATIM in
  your synthesis. These are data the user will ask follow-up questions
  about; paraphrasing them loses information.
- If two chunks show the same code block due to overlap, include it once.
- Prefer a longer, lossless response over a shorter one that drops code.

CRITICAL ANTI-HALLUCINATION RULES:
- If a chunk marked a section as missing (e.g. "[SECTION X: code/rules referenced but NOT PRESENT in the chunk text]"), pass that notice through to the user. State plainly in your response that the source document did not include the code for that section.
- NEVER invent code, rules, regex, or configuration that was not in the chunk analyses. If the user might later ask "give me the code for section X" and the code is not in the analyses, it is better to tell them up front than to fabricate.
- Distinguish clearly between "the document describes detection for X" and "here is the verbatim code for X" — only include the latter if the code actually appears above.

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
/**
 * Ask the backend's /tokenize endpoint for an exact token count. Both
 * llama.cpp and vLLM expose this. Used to replace our chars/token
 * estimator for map-reduce sizing — the estimator assumes ~4 chars/token
 * (prose-shaped) but code with heavy punctuation tokenizes at ~2
 * chars/token, so chunks sized by the estimator regularly blow past
 * the real context limit and the backend returns 400.
 *
 * Returns null on any failure so callers can fall back to estimation.
 */
async function getExactTokenCount(host, port, text) {
    if (!text) return 0;
    try {
        const response = await axios({
            method: 'post',
            url: `http://${host}:${port}/tokenize`,
            data: { content: text },
            timeout: 8000
        });
        const tokens = response.data?.tokens;
        if (Array.isArray(tokens)) return tokens.length;
        return null;
    } catch (e) {
        console.warn(`[Map-Reduce] /tokenize call failed: ${e.message} — falling back to estimation`);
        return null;
    }
}

async function processWithMapReduce(options) {
    const {
        targetHost,
        targetPort,
        model,
        largeContent,
        originalQuery,
        // priorMessages carries BOTH the system prompt AND the recent
        // conversation turns (user/assistant) so chunk and synthesis
        // requests have access to prior conversation context. The
        // caller is responsible for trimming it to a reasonable size
        // before handing it off — everything passed here is sent on
        // every chunk request, so it eats directly into the per-chunk
        // content budget.
        priorMessages = [],
        systemMessages, // legacy alias, still accepted
        contextSize,
        temperature = 0.7,
        topP = 1.0,
        maxTokens,
        onProgress
    } = options;

    const contextMessages = priorMessages.length > 0 ? priorMessages : (systemMessages || []);

    const { overlapTokens, maxParallelChunks, synthesisPromptReserve } = CHUNKING_CONFIG;

    // Ask the backend for EXACT token counts instead of trusting our
    // 4 chars/token estimator. On code/obfuscated payloads the
    // estimator is off by 2-3x and produces chunks that the backend
    // rejects with HTTP 400 ("request exceeds context size").
    const contextMessagesText = contextMessages.map(m =>
        typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '')
    ).join('\n');
    const [exactContentTokens, exactContextTokens, exactQueryTokens] = await Promise.all([
        getExactTokenCount(targetHost, targetPort, largeContent),
        getExactTokenCount(targetHost, targetPort, contextMessagesText),
        getExactTokenCount(targetHost, targetPort, originalQuery)
    ]);

    // Derive actual chars-per-token from the measurement so splitIntoChunks
    // can cut chunks at the right character boundary. Fall back to the
    // config default if /tokenize is unavailable.
    const exactRatioAvailable = exactContentTokens !== null && exactContentTokens > 0;
    const effectiveCharsPerToken = exactRatioAvailable
        ? Math.max(1.2, largeContent.length / exactContentTokens)
        : CHUNKING_CONFIG.charsPerToken;

    // Use exact counts when available, fall back to estimates otherwise.
    const contextMsgTokens = exactContextTokens ?? contextMessages.reduce((sum, msg) => sum + estimateTokenCount(msg.content), 0);
    const queryTokens = exactQueryTokens ?? estimateTokenCount(originalQuery);
    // Wrapper overhead from buildChunkPrompt — measured empirically; add
    // a conservative 200 tokens for the CHUNK/POSITION/NOTES boilerplate.
    const wrapperTokens = 200;
    // Cap response reserve at 80% of context to always leave room for chunk content
    const maxResponseReserve = Math.floor(contextSize * 0.8);
    const responseReserve = Math.min(maxTokens || Math.floor(contextSize * 0.2), maxResponseReserve);

    // Available for chunk content = context - prior messages - query - wrapper - response reserve - safety buffer
    const availableForChunkContent = contextSize - contextMsgTokens - queryTokens - wrapperTokens - responseReserve - 500;

    console.log(`[Map-Reduce] Token budget: context=${contextSize}, priorMsgs=${contextMsgTokens}, query=${queryTokens}, wrapper=${wrapperTokens}, response=${responseReserve}, available=${availableForChunkContent} (charsPerToken=${effectiveCharsPerToken.toFixed(2)}, exact=${exactRatioAvailable})`);

    if (availableForChunkContent < 1000) {
        return {
            success: false,
            error: 'Context window too small for map-reduce chunking',
            chunkCount: 0
        };
    }

    // Split content into overlapping chunks using the derived ratio so
    // the chunks match what the backend will actually see at tokenize time.
    const chunks = splitIntoChunks(largeContent, availableForChunkContent, overlapTokens, effectiveCharsPerToken);
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

        // Per-chunk request wall-clock cap. The chunk request is non-streaming
        // (stream: false) so we have no per-token data-arrival event to reset
        // against — the whole response lands at once. That means a smart
        // activity-based idle timeout isn't possible here without converting
        // the request to SSE. Instead we use a generous wall-clock cap from
        // CHUNKING_CONFIG.chunkMaxTimeoutMs (30 min) so large chunks on a
        // busy backend have room to finish. The model still dies if it hangs
        // indefinitely. NOTE: if/when this is converted to streaming, use
        // CHUNKING_CONFIG.chunkIdleTimeoutMs with setTimeout + response.data
        // event reset + AbortController for a proper smart timeout.
        const baseTimeout = CHUNKING_CONFIG.chunkMaxTimeoutMs;
        const maxRetries = 3;

        // Process a chunk with progressive shrinking on "context too large"
        // errors. A backend that returns 400 on a chunk means the chunk
        // content plus our wrapper/prior messages exceeded the real
        // context window (tokenizer mismatch, tighter limit than reported,
        // etc). Shrinking the chunk content in half and re-submitting is
        // more useful than returning an error string that gets stitched
        // into the user's synthesized response.
        const runChunk = async (chunk, shrinkDepth = 0) => {
            // Only the top-level call for a logical chunk should touch the
            // completed/failed counters. Recursive shrink calls (shrinkDepth >
            // 0) are splits of a single chunk — counting each half would
            // push "done" past totalChunks (e.g. 65/60) and confuse the UI.
            const isTopLevel = shrinkDepth === 0;
            const chunkPrompt = buildChunkPrompt(
                chunk.content,
                chunk.index,
                totalChunks,
                originalQuery,
                chunk.isFirst,
                chunk.isLast
            );

            const messages = [
                ...contextMessages,
                { role: 'user', content: chunkPrompt }
            ];

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                // Fresh AbortController + wall-clock timer per attempt so
                // retries never leak timers across iterations. The axios
                // `timeout` option is the primary mechanism; the abort
                // controller is a belt-and-suspenders safety net and the
                // hook we'd use if this path were ever converted to
                // streaming (idle timer reset on response.data events).
                const abortController = new AbortController();
                const attemptStart = Date.now();
                const wallClockTimer = setTimeout(() => {
                    console.warn(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} hit wall-clock cap of ${Math.round(baseTimeout / 1000)}s — aborting (non-streaming request, no idle signal available)`);
                    abortController.abort();
                }, baseTimeout);
                try {
                    const response = await axios({
                        method: 'post',
                        url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
                        data: {
                            model: model || undefined,
                            messages,
                            temperature,
                            top_p: topP,
                            max_tokens: responseReserve,
                            stream: false,
                            stop: DEFAULT_STOP_STRINGS
                        },
                        timeout: baseTimeout,
                        signal: abortController.signal
                    });
                    clearTimeout(wallClockTimer);

                    const responseContent = response.data?.choices?.[0]?.message?.content || '';
                    if (isTopLevel) completedChunks++;
                    const shrinkNote = shrinkDepth > 0 ? ` (shrunk x${shrinkDepth})` : '';
                    const elapsedSec = ((Date.now() - attemptStart) / 1000).toFixed(1);
                    console.log(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} completed in ${elapsedSec}s (${responseContent.length} chars)${attempt > 1 ? ` after ${attempt} attempts` : ''}${shrinkNote}`);

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
                        attempts: attempt,
                        shrinkDepth
                    };
                } catch (error) {
                    clearTimeout(wallClockTimer);
                    const status = error.response?.status;
                    const isAborted = error.name === 'CanceledError' || error.code === 'ERR_CANCELED' || abortController.signal.aborted;
                    const isTimeout = isAborted || error.code === 'ECONNABORTED' || error.message.includes('timeout');
                    const isContextTooLarge = status === 400 || status === 413;
                    const isRetryable = isTimeout || error.code === 'ECONNRESET' || (status && status >= 500);

                    // A 400 "context size" failure won't recover on retry —
                    // but will recover if we split the chunk in half. Cap
                    // the shrink recursion so a pathological input can't
                    // explode into many tiny chunks.
                    if (isContextTooLarge && shrinkDepth < 3 && chunk.content.length > 1000) {
                        console.log(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} rejected as too large (HTTP ${status}) — splitting in half (shrink depth ${shrinkDepth + 1})`);

                        const mid = Math.floor(chunk.content.length / 2);
                        // Break at nearest whitespace to avoid splitting mid-token
                        let splitPoint = chunk.content.lastIndexOf(' ', mid);
                        if (splitPoint < chunk.content.length * 0.3) splitPoint = mid;

                        const firstHalf = { ...chunk, content: chunk.content.substring(0, splitPoint) };
                        const secondHalf = { ...chunk, content: chunk.content.substring(splitPoint) };

                        const [firstResult, secondResult] = await Promise.all([
                            runChunk(firstHalf, shrinkDepth + 1),
                            runChunk(secondHalf, shrinkDepth + 1)
                        ]);

                        // Merge the two half-responses into a single logical
                        // chunk result. If either half succeeded we return
                        // combined content; success is true if ANY half worked.
                        const combined = [firstResult.response, secondResult.response]
                            .filter(r => r && !r.startsWith('[Error'))
                            .join('\n\n');

                        if (combined) {
                            // The sub-calls were not top-level so they did
                            // not increment completedChunks. Count the parent
                            // chunk exactly once on successful combine.
                            if (isTopLevel) completedChunks++;
                            return {
                                chunkIndex: chunk.index,
                                response: combined,
                                success: true,
                                attempts: attempt,
                                shrinkDepth: shrinkDepth + 1
                            };
                        }
                        // Both halves still failed — fall through to error path below
                    }

                    if (attempt < maxRetries && isRetryable) {
                        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                        console.log(`[Map-Reduce] Chunk ${chunk.index + 1}/${totalChunks} attempt ${attempt} failed (${error.message}), retrying in ${delay/1000}s...`);

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

                    if (isTopLevel) failedChunks++;
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

            return {
                chunkIndex: chunk.index,
                response: `[Error processing chunk ${chunk.index + 1}: Max retries exceeded]`,
                success: false,
                error: 'Max retries exceeded',
                attempts: maxRetries
            };
        };

        const batchPromises = batch.map(chunk => runChunk(chunk));

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
        ...contextMessages,
        { role: 'user', content: synthesisPrompt }
    ];

    try {
        console.log(`[Map-Reduce] Starting synthesis (${synthesisTokens} tokens input)`);

        const synthesisResponse = await axios({
            method: 'post',
            url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
            data: {
                model: model || undefined,
                messages: synthesisMessages,
                temperature: Math.max(0.3, temperature - 0.2), // Slightly lower temp for synthesis
                top_p: topP,
                max_tokens: responseReserve,
                stream: false,
                stop: DEFAULT_STOP_STRINGS
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

    // Broadcast error to connected clients (no stack traces — logged server-side only)
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: `[Error] Unhandled rejection: ${errorMsg}`,
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

    // Broadcast error to connected clients (no stack traces — logged server-side only)
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: `[Error] Uncaught exception: ${errorMsg}`,
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
                    repeatLastN: parseInt(getEnvValue('LLAMA_REPEAT_LAST_N') || '64'),
                    presencePenalty: parseFloat(getEnvValue('LLAMA_PRESENCE_PENALTY') || '0.0'),
                    frequencyPenalty: parseFloat(getEnvValue('LLAMA_FREQUENCY_PENALTY') || '0.0'),
                    ctxCheckpoints: parseInt(getEnvValue('LLAMA_CTX_CHECKPOINTS') || '2'),
                    swaFull: getEnvValue('LLAMA_SWA_FULL') === 'true',
                    // Reconstruct disableThinking from the llama.cpp --reasoning
                    // env var. Without this, the UI always shows the toggle as
                    // OFF for containers recovered on startup, even when the
                    // running process actually has --reasoning off.
                    disableThinking: getEnvValue('LLAMA_REASONING') === 'off'
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
        startDockerEventListener();
    } catch (error) {
        console.error('Error syncing model instances:', error);
    }
}

// Listen to Docker's event stream and react immediately when a tracked model
// container dies (OOM, crash, stop). Without this the only detector is the
// per-instance health-check polling loop, which runs at 30 s intervals once
// the model is healthy — so the UI can show a dead container as "running"
// for up to 30 s and chat requests in that window hit EAI_AGAIN on a
// now-unresolvable hostname. A subscribed event stream fires within ms.
let dockerEventStream = null;
async function startDockerEventListener() {
    if (dockerEventStream) return;
    try {
        dockerEventStream = await docker.getEvents({
            filters: { type: ['container'], event: ['die', 'oom', 'kill'] }
        });
        dockerEventStream.on('data', (chunk) => {
            let evt;
            try { evt = JSON.parse(chunk.toString()); } catch { return; }
            const name = evt?.Actor?.Attributes?.name;
            if (!name) return;
            // Find a tracked instance by container name or id.
            let matchedModel = null;
            for (const [modelName, inst] of modelInstances.entries()) {
                if (inst.containerName === name || inst.containerId === evt.id) {
                    matchedModel = modelName;
                    break;
                }
            }
            if (!matchedModel) return;
            const instance = modelInstances.get(matchedModel);
            const action = evt.Action; // 'die' | 'oom' | 'kill'
            const exitCode = evt?.Actor?.Attributes?.exitCode;
            // Keep the entry in the map so the UI can show that it crashed
            // (instead of silently vanishing); mark status and broadcast.
            // The existing health-check loop will remove/clean up as needed.
            instance.status = action === 'oom' ? 'oom_killed' : 'stopped';
            instance.lastExitCode = exitCode;
            modelInstances.set(matchedModel, instance);
            broadcast({
                type: 'status',
                modelName: matchedModel,
                status: instance.status,
                port: instance.port,
                error: action === 'oom'
                    ? 'Container was killed by the OOM killer — reduce context size or ctx-checkpoints and reload.'
                    : `Container exited (code ${exitCode ?? '?'}) — reload the model to retry.`
            });
            broadcast({
                type: 'log',
                message: `[${matchedModel}] Container ${action}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`,
                level: 'error'
            });
        });
        dockerEventStream.on('error', (err) => {
            console.error('[DockerEvents] stream error:', err.message);
            dockerEventStream = null;
            setTimeout(startDockerEventListener, 5000);
        });
        dockerEventStream.on('close', () => {
            dockerEventStream = null;
            setTimeout(startDockerEventListener, 5000);
        });
        console.log('[DockerEvents] subscribed to container die/oom/kill events');
    } catch (err) {
        console.error('[DockerEvents] failed to subscribe:', err.message);
        dockerEventStream = null;
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

// Tight body limit on unauthenticated/auth endpoints — they only ever take
// a small JSON object (username/email/password). Capping here prevents
// anonymous clients from forcing the server to parse 50 MB of JSON before
// auth runs. Mounted before the global 50 MB parser so it wins for /api/auth/*.
app.use('/api/auth', express.json({ limit: '16kb' }));
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

// Helper function to get userId from session ID.
//
// Session files on disk are encrypted by kruptein (session-file-store's
// default when `secret` is set). Reading the raw JSON and looking for
// `.passport.user` finds nothing — the parse succeeds because the file
// IS valid JSON (`{"hmac":..., "ct":...}`), but the passport data lives
// inside the encrypted `ct` field. So we delegate to `sessionStore.get()`
// which knows to decrypt via the kruptein instance we configured.
//
// Before this fix every WebSocket upgrade landed as "Connection without
// session" and per-user broadcasts (log events, sandbox wipes, download
// progress) went nowhere.
async function getUserIdFromSession(sessionId) {
    if (!sessionId) return null;
    return new Promise((resolve) => {
        sessionStore.get(sessionId, (err, session) => {
            if (err || !session) return resolve(null);
            if (session.passport && session.passport.user) {
                return resolve(session.passport.user);
            }
            resolve(null);
        });
    });
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
        console.warn('[WebSocket] Connection without session - will not receive messages');
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

        // Reject non-string inputs (avoids TypeError downstream and prevents
        // type-confusion attempts on toLowerCase()/length checks).
        if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'Username, email, and password must be strings' });
        }

        // Validate email format (matches /api/users/invite check)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Validate username characters (printable ASCII, no whitespace, no control)
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be 1-64 chars, alphanumeric / dot / dash / underscore' });
        }

        // Validate password strength
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }
        if (password.length > 256) {
            return res.status(400).json({ error: 'Password is too long (max 256 characters)' });
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

    if (!isValidModelName(modelName)) {
        return res.status(400).json({ error: 'Invalid model name' });
    }

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
                compressMemory: req.body.compressMemory ?? false,
                swaFull: req.body.swaFull === true
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

        // Set served model name so vLLM accepts it in the `model` request field
        envVars.push(`VLLM_SERVED_MODEL_NAME=${modelName}`);

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
            // disableThinking flows through the server-side --reasoning off
            // flag so it actually disables <think> blocks for any reasoning
            // model llama.cpp recognizes. The /no_think prompt prefix (added
            // elsewhere) stays as a fallback for Qwen models that respect it.
            `LLAMA_REASONING=${config.disableThinking ? 'off' : 'auto'}`,
            `LLAMA_CACHE_TYPE_K=${config.cacheTypeK}`,
            `LLAMA_CACHE_TYPE_V=${config.cacheTypeV}`,
            `LLAMA_PARALLEL=${config.parallelSlots}`,
            `LLAMA_BATCH_SIZE=${config.batchSize}`,
            `LLAMA_UBATCH_SIZE=${config.ubatchSize}`,
            `LLAMA_REPEAT_PENALTY=${config.repeatPenalty}`,
            `LLAMA_REPEAT_LAST_N=${config.repeatLastN}`,
            `LLAMA_PRESENCE_PENALTY=${config.presencePenalty}`,
            `LLAMA_FREQUENCY_PENALTY=${config.frequencyPenalty}`,
            // SWA/context-checkpoint storage cap. Unset (or high) values let
            // llama.cpp accumulate >1 GiB/checkpoint in host RAM on large
            // contexts, which OOM-kills the container mid-request. Default 2
            // keeps some prefix-reuse benefit without unbounded growth.
            `LLAMA_CTX_CHECKPOINTS=${config.ctxCheckpoints != null ? config.ctxCheckpoints : 2}`,
            // Full-size SWA cache — required for prompt-cache reuse across
            // turns on Gemma 3/4 and other SWA/hybrid models. Without it,
            // every turn re-evaluates the entire prompt from scratch (the
            // "forcing full prompt re-processing due to lack of cache data"
            // log line). See llama.cpp PR #13194.
            `LLAMA_SWA_FULL=${config.swaFull === true ? 'true' : 'false'}`
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
let gpuUnavailable = false; // Skip nvidia-smi calls after persistent failure
let gpuRetryAt = 0;         // Timestamp to retry nvidia-smi after failure
const GPU_RETRY_INTERVAL = 60000; // Retry nvidia-smi every 60s after failure

async function broadcastSystemMonitoring() {
    try {
        // ---- GPUs ----
        const gpus = [];
        let gpuError = null;

        // Skip nvidia-smi if it previously failed — retry every 60s
        if (gpuUnavailable && Date.now() < gpuRetryAt) {
            // Use cached error state, don't re-run nvidia-smi
        } else {
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
                // nvidia-smi recovered — reset failure state
                if (gpus.length > 0) {
                    gpuErrorLogged = false;
                    gpuUnavailable = false;
                }
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

                // Mark unavailable and schedule retry so we stop hammering a broken nvidia-smi
                gpuUnavailable = true;
                gpuRetryAt = Date.now() + GPU_RETRY_INTERVAL;

                // Log once to avoid flooding at 3s interval
                if (!gpuErrorLogged) {
                    gpuErrorLogged = true;
                    console.warn(`[Monitoring] GPU detection failed: ${gpuError}`);
                }
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

        let existed = false;
        if (req.userId) {
            // User-scoped deletion
            const bucket = prompts[req.userId];
            if (bucket && Object.prototype.hasOwnProperty.call(bucket, modelName)) {
                delete bucket[modelName];
                existed = true;
            }
        } else {
            // No userId (API-key auth without user scope). The stored
            // shape is { <userId>: { <name>: "..." }, ... } — "legacy
            // flat" storage no longer exists in practice. Sweep all
            // user buckets so the delete actually lands.
            for (const bucket of Object.values(prompts)) {
                if (bucket && typeof bucket === 'object' &&
                    Object.prototype.hasOwnProperty.call(bucket, modelName)) {
                    delete bucket[modelName];
                    existed = true;
                }
            }
        }

        if (!existed) {
            // Loud failure — previously the endpoint always returned
            // 200 "deleted" even when nothing was removed, which made
            // the Settings UI look like it had deleted a prompt that
            // was still there on refresh.
            console.warn('[DELETE system-prompts] name not found', {
                requested: modelName,
                requestedLen: modelName?.length,
                requestedCodes: [...(modelName || '')].slice(0, 40).map(c => c.charCodeAt(0)),
                userId: req.userId,
                bucketExists: !!prompts[req.userId],
                bucketKeys: Object.keys(prompts[req.userId] || {}),
            });
            return res.status(404).json({
                error: 'System prompt not found',
                modelName,
                // Tiny debugging hint for the client — ensures we
                // surface the mismatch so the user can tell us.
                availableNames: req.userId ? Object.keys(prompts[req.userId] || {}) : [],
            });
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
// One-shot code execution in the sandbox — powers the chat "Run code"
// button on code blocks. Accepts { language, code }, runs in the
// existing sandbox (workspace=false, network=none) and returns
// stdout/stderr/artifacts. Only 'python' is supported for execution;
// 'html' and friends are rendered client-side in an iframe and do not
// hit this endpoint.
app.post('/api/sandbox/run-code', requireAuth, async (req, res) => {
    // 30s default — the scientific image has a real cold-start
    // (numpy + pandas + matplotlib imports take 2-4s on their own
    // before the user snippet runs). Snippets that need longer
    // can pass timeoutMs explicitly up to 120s.
    const { language, code, timeoutMs = 30_000 } = req.body || {};
    if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'code (string) is required' });
    }
    const lang = String(language || '').toLowerCase();
    if (lang !== 'python' && lang !== 'py' && lang !== 'python3') {
        return res.status(400).json({
            error: `language "${language}" is not runnable server-side. HTML / CSS / JS render client-side in an iframe.`,
        });
    }
    try {
        const sandbox = require('./services/sandboxRunner');
        // Wrap arbitrary user code in the standard skill harness so it
        // can be top-level code (no execute() required). stdout is
        // captured as-is; the harness prints a final JSON envelope with
        // stdout/stderr collected from within the user code.
        //
        // We also monkey-patch a couple of common infinite-loop sources
        // so chat-generated snippets don't hit the timeout silently:
        //   - pygame.display.flip() / update() — saves the current surface
        //     to /artifacts/frame.png on the first call, then raises
        //     SystemExit to escape any while-running loop. The user sees
        //     the rendered frame as an inline image.
        //   - input() — raises a fast error rather than waiting forever
        //     on a stdin that doesn't exist.
        const harness = `
def execute(params):
    import sys, io, traceback, builtins
    _stdout = io.StringIO(); _stderr = io.StringIO()
    _orig_out, _orig_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _stdout, _stderr

    # Fast-fail on input() instead of blocking on absent stdin.
    def _no_stdin(prompt=""):
        raise EOFError("input() not available in sandbox — no stdin attached")
    builtins.input = _no_stdin

    # pygame auto-capture: on first flip/update, save the frame and exit
    # the snippet cleanly so typical "while running: ..." loops terminate
    # after one render. Snippets that call pygame.quit() themselves are
    # unaffected; SystemExit is caught below.
    try:
        import pygame as _pg
        _pg_frame_saved = [False]
        def _flip_save(*a, **kw):
            if not _pg_frame_saved[0]:
                try:
                    _surf = _pg.display.get_surface()
                    if _surf is not None:
                        _pg.image.save(_surf, "/artifacts/frame.png")
                        _stdout.write("[sandbox] pygame frame saved to /artifacts/frame.png; exiting game loop\\n")
                except Exception:
                    pass
                _pg_frame_saved[0] = True
            raise SystemExit(0)
        _pg.display.flip = _flip_save
        _pg.display.update = _flip_save
    except Exception:
        pass

    try:
${code.split('\n').map(l => '        ' + l).join('\n')}
    except SystemExit:
        # Clean exit — either user called sys.exit or our pygame helper
        # bailed out of a game loop. Not an error.
        pass
    except Exception as _e:
        _stderr.write(traceback.format_exc(limit=10))
    finally:
        sys.stdout, sys.stderr = _orig_out, _orig_err
    return {
        "stdout": _stdout.getvalue(),
        "stderr": _stderr.getvalue(),
    }
`;
        const run = await sandbox.runPythonSkill({
            code: harness,
            params: {},
            network: 'none',
            workspace: false,
            timeoutMs: Math.min(120_000, Math.max(1000, parseInt(timeoutMs, 10))),
            memory: '256m',
            cpus: '0.5',
            toolName: 'chat-code-preview',
            userId: req.userId || null,
        });
        // Artifacts written by the snippet to /artifacts survive long enough
        // for the client to fetch them via /api/tool-artifacts/:runId/:name
        // (same TTL sweep as skills). Only clean up immediately when nothing
        // was produced so idle preview runs don't leave disk residue.
        if (run.timedOut) {
            sandbox.cleanupRun(run.runId).catch(() => {});
            const effectiveMs = Math.min(120_000, Math.max(1000, parseInt(timeoutMs, 10)));
            return res.json({
                success: false,
                timedOut: true,
                error: `Code timed out after ${Math.round(effectiveMs / 1000)}s. Common causes: infinite loop (e.g. while True, pygame game loop), waiting for input() (no stdin in sandbox), or network call on a snippet that tried to reach the internet (no network by default). Send timeoutMs in the request body to extend, up to 120000.`,
                stdout: run.stdout?.slice(0, 4000) || '',
            });
        }
        if (!run.artifacts.length) {
            sandbox.cleanupRun(run.runId).catch(() => {});
        }
        const artifacts = (run.artifacts || []).map(a => ({
            name: a.name,
            size: a.size,
            runId: run.runId,
            url: `/api/tool-artifacts/${run.runId}/${encodeURIComponent(a.name)}`,
        }));
        if (run.result && typeof run.result === 'object') {
            return res.json({
                success: true,
                language: 'python',
                stdout: run.result.stdout || '',
                stderr: run.result.stderr || '',
                durationMs: run.durationMs,
                sandboxed: run.sandboxed,
                artifacts,
            });
        }
        return res.json({
            success: false,
            error: run.parseError || run.stderr?.slice(0, 2000) || 'no result',
            stdout: run.stdout?.slice(0, 2000) || '',
            artifacts,
        });
    } catch (e) {
        console.error('run-code failed:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Tool-run artifact download. Files produced by a sandboxed tool are
// staged under /models/.modelserver/sandbox/<runId>/artifacts/. A
// successful tool call returns `_artifacts: [{ name, size, runId }]` so
// the chat client can render download links via this endpoint.
//
// Security: runId is a crypto-random 24-hex string; unguessable per run.
// We still require auth + validate the filename against path traversal.
app.get('/api/tool-artifacts/:runId/:filename', requireAuth, async (req, res) => {
    const path_ = require('path');
    const { runId, filename } = req.params;
    if (!/^[a-f0-9]{16,48}$/i.test(runId || '')) {
        return res.status(400).json({ error: 'bad runId' });
    }
    // Reject any traversal or absolute components. path.basename normalizes
    // most cases but we also reject dots just to be safe.
    const safeName = path_.basename(filename || '');
    if (!safeName || safeName.startsWith('.') || safeName.includes('..')) {
        return res.status(400).json({ error: 'bad filename' });
    }
    const filePath = path_.join('/models/.modelserver/sandbox', runId, 'artifacts', safeName);
    try {
        const st = await fs.stat(filePath);
        if (!st.isFile()) return res.status(404).json({ error: 'not a file' });
        res.setHeader('Content-Disposition', `inline; filename="${safeName.replace(/"/g, '')}"`);
        res.setHeader('Content-Length', String(st.size));
        const stream = require('fs').createReadStream(filePath);
        stream.on('error', () => res.end());
        stream.pipe(res);
    } catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'artifact not found' });
        res.status(500).json({ error: e.message });
    }
});

// Native tool catalog — returns the full list of tools the chat model
// sees: static registry plus dynamic per-user skill surface.
app.get('/api/system/tools-catalog', requireAuth, async (req, res) => {
    try {
        const t = require('./services/chatTools');
        const full = await t.buildToolCatalog({ userId: req.userId });
        const names = full.map(f => f.function?.name).filter(Boolean);
        res.json({
            count: names.length,
            staticCount: t.toolRegistry.size,
            tools: names,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Egress-proxy stats — admin-only observability for the sandbox network
// allowlist. Returns grant counts, rejection reasons, and listening state.
app.get('/api/system/egress-proxy', requireAuth, (req, res) => {
    if (!checkPermission(req.apiKeyData, 'admin') && !req.user) {
        return res.status(403).json({ error: 'Admin permission required' });
    }
    try {
        res.json(require('./services/egressProxy').getStats());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/system/resources', requireAuth, async (req, res) => {

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

        // Get per-GPU info. llama.cpp's default tensor split is even across
        // visible GPUs: each card gets the same fraction of weights and KV.
        // That means the SMALLEST card bounds the per-card budget — having
        // 30 GB total free across 2 cards but with a lopsided 4 / 26 split
        // does NOT let you load a 20 GB model, because the small card can't
        // hold its half. We capture both per-card detail and the symmetric
        // effective budget below.
        const gpuDetails = []; // [{ index, totalGB, freeGB, usedGB, name }]
        try {
            const { stdout } = await execPromise(
                'nvidia-smi --query-gpu=index,name,memory.total,memory.free,memory.used --format=csv,noheader,nounits'
            );
            for (const line of stdout.trim().split('\n')) {
                const parts = line.split(',').map(s => s.trim());
                if (parts.length < 5) continue;
                const idx = parseInt(parts[0], 10);
                const name = parts[1];
                const tot = parseInt(parts[2], 10);
                const free = parseInt(parts[3], 10);
                const used = parseInt(parts[4], 10);
                if (!isNaN(tot)) {
                    gpuDetails.push({
                        index: idx,
                        name,
                        totalGB: tot / 1024,
                        freeGB: isNaN(free) ? 0 : free / 1024,
                        usedGB: isNaN(used) ? 0 : used / 1024,
                    });
                }
            }
        } catch (err) {
            // No GPU available
        }

        const gpuCount = gpuDetails.length;
        const totalGpuMemoryGB = gpuDetails.reduce((s, g) => s + g.totalGB, 0);
        const totalGpuFreeGB = gpuDetails.reduce((s, g) => s + g.freeGB, 0);
        const smallestGpuFreeGB = gpuCount ? Math.min(...gpuDetails.map(g => g.freeGB)) : 0;
        const largestGpuFreeGB = gpuCount ? Math.max(...gpuDetails.map(g => g.freeGB)) : 0;

        // Effective budget under llama.cpp's default even split:
        //   = min(free_per_card) * gpuCount
        // This is the largest model+KV size that can be loaded with NO
        // explicit --tensor-split tweaking. A heavily-imbalanced setup
        // surfaces a hint in notes so the user can flip on tensor-split.
        const effectiveBudgetGB = smallestGpuFreeGB * gpuCount;
        const imbalanced = gpuCount > 1 && (largestGpuFreeGB - smallestGpuFreeGB) > 1.5;

        const modelSizeGB = modelFileSize / (1024 * 1024 * 1024);
        const ramGB = totalMemory / (1024 * 1024 * 1024);
        // Aliases for backwards-compat with the rest of this handler.
        const gpuMemoryGB = totalGpuMemoryGB;
        const gpuFreeGB = totalGpuFreeGB;

        let notes = [];

        // ========================================================================
        // LLAMA.CPP OPTIMAL SETTINGS
        // ========================================================================
        if (backend === 'llamacpp') {
            let llamacppSettings = {
                nGpuLayers: -1,
                contextSize: 4096,
                contextShift: true,
                flashAttention: true,
                cacheTypeK: 'f16',
                cacheTypeV: 'f16',
                threads: 4,                 // Default low — almost always GPU-bound
                parallelSlots: 1,
                batchSize: 2048,
                ubatchSize: 1024,
                repeatPenalty: 1.1,
                repeatLastN: 64,
                presencePenalty: 0.0,
                frequencyPenalty: 0.0,
                ctxCheckpoints: 2,
                swaFull: true               // Eliminates the per-turn re-eval on SWA models
            };

            if (gpuCount === 0 || gpuMemoryGB === 0) {
                // CPU-only mode
                llamacppSettings.nGpuLayers = 0;
                llamacppSettings.threads = Math.max(4, cpuCount - 2);
                llamacppSettings.contextSize = 4096;
                llamacppSettings.batchSize = 512;
                llamacppSettings.ubatchSize = 256;
                llamacppSettings.flashAttention = false;
                llamacppSettings.swaFull = false; // Marginal benefit, can hurt CPU-bound runs
                notes.push('No GPU detected — using CPU-only mode');
                notes.push(`Using ${llamacppSettings.threads} CPU threads`);
                return res.json({
                    settings: llamacppSettings,
                    backend: 'llamacpp',
                    hardware: { gpuCount, gpuMemoryGB: gpuMemoryGB.toFixed(1), ramGB: ramGB.toFixed(1), cpuCores: cpuCount },
                    model: { sizeGB: modelSizeGB.toFixed(2), estimatedVRAM: modelSizeGB.toFixed(2) },
                    notes
                });
            }

            // ----------------------------------------------------------------
            // VRAM accounting model
            // ----------------------------------------------------------------
            //
            // Components that compete for VRAM:
            //   1. Model weights        (≈ modelFileSize, GGUF maps ~1:1)
            //   2. KV cache             (depends on ctx-size, KV dtype, layers, swa-full)
            //   3. CUDA workspace       (compute scratch, CUDA graphs, ~1.0–2.0 GB)
            //   4. Other GPU users      (already-loaded models, desktop, etc. — read live)
            //
            // We work in two passes:
            //   Pass 1: pick KV dtype based on free-VRAM headroom after model load
            //   Pass 2: pick the largest power-of-two ctx-size that still leaves
            //           a safety margin (~1.5 GB) on the most-constrained card.
            //
            // KV per-token cost is estimated from a representative average that
            // matches large-context dense and SWA models alike:
            //   - dense path:  60 layers × (n_kv_heads ≈ 8) × (head_dim ≈ 128) × 2 (K+V)
            //                  ≈ ~120 KB/tok at f16, 60 KB at q8_0, 30 KB at q4_0
            //   - SWA path with --swa-full: per-token cost roughly doubles because
            //                  every layer (full + SWA) holds a slot for every
            //                  context position. We use a 1.7× multiplier as a
            //                  conservative average across modern SWA models.
            //
            // These numbers are deliberately on the high side — we'd rather
            // recommend a slightly smaller ctx than OOM on load.

            const KV_PER_TOKEN_F16_DENSE = 120 * 1024;   // bytes/tok
            const KV_PER_TOKEN_F16_SWAFULL = 200 * 1024; // bytes/tok with --swa-full
            const COMPUTE_SCRATCH_GB = 1.5;
            const MIN_HEADROOM_GB = 1.0;
            const KV_DTYPE_FACTOR = { f16: 1.0, q8_0: 0.5, q4_0: 0.25 };

            // Use the EFFECTIVE budget under llama.cpp's even tensor split —
            // smallest_free_per_card × gpuCount — not the raw sum, because a
            // lopsided multi-GPU box (e.g. one card busy with a desktop
            // session) can't safely fit a model whose half won't squeeze
            // onto the smaller card. Per-card scratch + headroom reserve is
            // applied symmetrically: subtract (scratch + headroom) per card.
            const perCardReserveGB = COMPUTE_SCRATCH_GB + MIN_HEADROOM_GB;
            const symmetricBudgetGB = effectiveBudgetGB > 0
                ? effectiveBudgetGB
                : (gpuMemoryGB * 0.92);
            const availableGB = symmetricBudgetGB;
            const usableForModelAndKV = symmetricBudgetGB - perCardReserveGB * Math.max(1, gpuCount);

            // Can the full model fit on GPU at all?
            const modelFits = modelSizeGB <= usableForModelAndKV;

            if (!modelFits) {
                // Partial GPU offload. Estimate layer count by file size — most
                // GGUFs in the 1B–70B range have 24–80 layers, average ~50.
                // Without inspecting the GGUF metadata here we approximate by
                // assuming uniform per-layer size (good enough for offload
                // ratio, exact layer counts get refined at load time).
                const guessedLayers = Math.max(24, Math.min(80, Math.round(modelSizeGB * 2.4)));
                const fitFraction = Math.max(0.05, usableForModelAndKV / modelSizeGB);
                const offloadLayers = Math.max(1, Math.floor(guessedLayers * fitFraction));
                llamacppSettings.nGpuLayers = offloadLayers;
                llamacppSettings.contextSize = 4096;
                llamacppSettings.cacheTypeK = 'q8_0';
                llamacppSettings.cacheTypeV = 'q8_0';
                llamacppSettings.swaFull = false; // Memory-bound — skip extra SWA cost
                llamacppSettings.batchSize = 1024;
                llamacppSettings.ubatchSize = 512;
                llamacppSettings.threads = Math.max(4, Math.floor(cpuCount * 0.5));
                notes.push(`Model (${modelSizeGB.toFixed(1)} GB) exceeds free VRAM (${availableGB.toFixed(1)} GB) — partial offload`);
                notes.push(`Recommended: ${offloadLayers}/${guessedLayers} layers on GPU (estimate; refine after loading)`);
                notes.push('Using q8_0 KV cache; SWA full disabled to conserve memory');
            } else {
                // Model fits — pick the best KV dtype + ctx.
                const kvBudgetGB = usableForModelAndKV - modelSizeGB;

                // Try f16 → q8_0 → q4_0, accepting the first that fits a
                // reasonable target ctx (16K minimum). Use --swa-full math.
                const TARGET_CTX_FLOOR = 16384;
                const candidates = ['f16', 'q8_0', 'q4_0'];
                let chosenKv = 'q4_0';
                let maxCtxBytes = 0;
                for (const kv of candidates) {
                    const perTok = KV_PER_TOKEN_F16_SWAFULL * KV_DTYPE_FACTOR[kv];
                    const ctxAtThisKv = Math.floor((kvBudgetGB * 1024 * 1024 * 1024) / perTok);
                    if (ctxAtThisKv >= TARGET_CTX_FLOOR) {
                        chosenKv = kv;
                        maxCtxBytes = ctxAtThisKv;
                        break;
                    }
                    // If even q4_0 can't make 16K, take the largest we can.
                    if (kv === 'q4_0') {
                        chosenKv = kv;
                        maxCtxBytes = ctxAtThisKv;
                    }
                }

                // Round down to power of two — llama.cpp aligns context to
                // batch boundaries internally and the convention plays nice
                // with the chunking math elsewhere.
                let chosenCtx = 4096;
                for (const c of [262144, 131072, 65536, 32768, 16384, 8192, 4096]) {
                    if (c <= maxCtxBytes) { chosenCtx = c; break; }
                }

                llamacppSettings.cacheTypeK = chosenKv;
                llamacppSettings.cacheTypeV = chosenKv;
                llamacppSettings.contextSize = chosenCtx;
                llamacppSettings.swaFull = true;
                llamacppSettings.flashAttention = true;
                llamacppSettings.threads = 4;

                // Scale batch / ubatch with VRAM headroom remaining after
                // model + KV. Larger batch + ubatch = faster prompt eval on
                // long inputs but also larger compute scratch buffers.
                const predictedKvForBatch =
                    (chosenCtx * KV_PER_TOKEN_F16_SWAFULL * KV_DTYPE_FACTOR[chosenKv]) /
                    (1024 * 1024 * 1024);
                const headroomGB =
                    symmetricBudgetGB - modelSizeGB - predictedKvForBatch -
                    perCardReserveGB * Math.max(1, gpuCount);
                if (headroomGB >= 4) {
                    llamacppSettings.batchSize = 4096;
                    llamacppSettings.ubatchSize = 2048;
                } else if (headroomGB >= 1.5) {
                    llamacppSettings.batchSize = 2048;
                    llamacppSettings.ubatchSize = 1024;
                } else {
                    llamacppSettings.batchSize = 1024;
                    llamacppSettings.ubatchSize = 512;
                }

                // Predicted KV usage at the chosen ctx — surface in notes
                // so the user can sanity-check.
                const predictedKvGB =
                    (chosenCtx * KV_PER_TOKEN_F16_SWAFULL * KV_DTYPE_FACTOR[chosenKv]) /
                    (1024 * 1024 * 1024);
                const totalGB = modelSizeGB + predictedKvGB + COMPUTE_SCRATCH_GB * Math.max(1, gpuCount);
                const perCardLoadGB = totalGB / Math.max(1, gpuCount);
                notes.push(`Effective budget: ${symmetricBudgetGB.toFixed(1)} GB (smallest of ${gpuCount} GPU(s) × ${gpuCount}, even tensor split)`);
                notes.push(`Model: ${modelSizeGB.toFixed(1)} GB · predicted KV cache: ${predictedKvGB.toFixed(1)} GB · scratch: ${(COMPUTE_SCRATCH_GB * Math.max(1, gpuCount)).toFixed(1)} GB`);
                notes.push(`Predicted load per card: ${perCardLoadGB.toFixed(1)} GB · smallest card free: ${smallestGpuFreeGB.toFixed(1)} GB`);
                notes.push(`Context: ${chosenCtx >= 1024 ? (chosenCtx / 1024).toFixed(0) + 'K' : chosenCtx} · KV dtype: ${chosenKv} · SWA-full: ON (prompt cache reuses across turns)`);
                if (chosenKv !== 'f16') {
                    notes.push(`f16 KV would need ${(predictedKvGB / KV_DTYPE_FACTOR[chosenKv]).toFixed(1)} GB at ${chosenCtx >= 1024 ? (chosenCtx / 1024).toFixed(0) + 'K' : chosenCtx} ctx — ${chosenKv} chosen to fit`);
                }
            }

            // Per-GPU breakdown — always surface for multi-GPU systems so
            // the user can see exactly what each card has free.
            if (gpuCount > 1) {
                for (const g of gpuDetails) {
                    notes.push(`  GPU ${g.index} (${g.name || 'unknown'}): ${g.freeGB.toFixed(1)} GB free / ${g.totalGB.toFixed(1)} GB total`);
                }
                if (imbalanced) {
                    const ratio = gpuDetails
                        .map(g => Math.round((g.freeGB / largestGpuFreeGB) * 100))
                        .join(',');
                    notes.push(`Cards are imbalanced (${(largestGpuFreeGB - smallestGpuFreeGB).toFixed(1)} GB spread). Even split would waste headroom on the larger card; consider --tensor-split ${ratio} via env var to bias more weight toward the freer card.`);
                }
            }

            return res.json({
                settings: llamacppSettings,
                backend: 'llamacpp',
                hardware: {
                    gpuCount,
                    gpuMemoryGB: gpuMemoryGB.toFixed(1),
                    gpuFreeGB: gpuFreeGB.toFixed(1),
                    smallestGpuFreeGB: smallestGpuFreeGB.toFixed(1),
                    effectiveBudgetGB: symmetricBudgetGB.toFixed(1),
                    imbalanced,
                    gpus: gpuDetails.map(g => ({
                        index: g.index,
                        name: g.name,
                        totalGB: parseFloat(g.totalGB.toFixed(1)),
                        freeGB: parseFloat(g.freeGB.toFixed(1)),
                        usedGB: parseFloat(g.usedGB.toFixed(1)),
                    })),
                    ramGB: ramGB.toFixed(1),
                    cpuCores: cpuCount
                },
                model: {
                    sizeGB: modelSizeGB.toFixed(2),
                    estimatedVRAM: modelSizeGB.toFixed(2)
                },
                notes
            });
        }

        // ========================================================================
        // VLLM OPTIMAL SETTINGS
        // ========================================================================
        //
        // VRAM accounting differs from llama.cpp here in one important way:
        // vLLM allocates a FIXED pool per GPU at startup, sized as
        //   per_card_pool = total_per_card × gpu_memory_utilization
        // and never grows it. If anything else on the card is using
        // memory, the pool can OOM during init. So gpu_memory_utilization
        // must be capped at (free_per_card / total_per_card) on the
        // most-constrained card, never higher. After that, vLLM auto-tunes
        // max_num_seqs from leftover KV cache space — we just pass a
        // ceiling.
        //
        // Like llama.cpp, the effective per-card budget is bounded by the
        // SMALLEST GPU's free memory; tensor_parallel_size = gpuCount
        // splits the model evenly, so the smallest card decides whether
        // each shard fits.

        let settings = {
            maxModelLen: 4096,
            cpuOffloadGb: 0,
            gpuMemoryUtilization: 0.9,
            tensorParallelSize: 1,
            maxNumSeqs: 256,
            kvCacheDtype: 'auto',
            trustRemoteCode: true,
            enforceEager: false
        };

        if (gpuCount === 0 || gpuMemoryGB === 0) {
            notes.push('ERROR: No GPU detected — vLLM requires a GPU to run');
            notes.push('Please ensure NVIDIA drivers and CUDA are properly installed');
            return res.json({
                settings,
                backend: 'vllm',
                hardware: { gpuCount, gpuMemoryGB: '0', ramGB: ramGB.toFixed(1), cpuCores: cpuCount },
                model: { sizeGB: modelSizeGB.toFixed(2), estimatedVRAM: modelSizeGB.toFixed(2) },
                notes,
                error: 'GPU required for vLLM'
            });
        }

        // ---- Per-GPU sizing ----------------------------------------------
        const tp = gpuCount; // even split — assume all cards used
        settings.tensorParallelSize = tp;

        const smallestTotalGB = gpuCount ? Math.min(...gpuDetails.map(g => g.totalGB)) : 0;
        // gpu_memory_utilization is a fraction of TOTAL per-card. Cap it
        // at what's actually free on the most-constrained card so vLLM
        // doesn't try to grab more than exists.
        const liveUtilCap = smallestTotalGB > 0
            ? Math.max(0.1, Math.min(0.95, (smallestGpuFreeGB / smallestTotalGB) - 0.02))
            : 0.85;
        settings.gpuMemoryUtilization = parseFloat(liveUtilCap.toFixed(2));

        // Effective allocatable VRAM = per_card × util × count (matches what
        // vLLM will actually grab at init).
        const perCardAllocatedGB = smallestTotalGB * settings.gpuMemoryUtilization;
        const effectiveAllocatedGB = perCardAllocatedGB * tp;

        // KV-cache estimate per token at f16. vLLM uses an auto-paged KV
        // cache; per-token cost is roughly the same as llama.cpp dense path.
        const KV_PER_TOKEN_F16 = 120 * 1024;        // bytes/tok at f16
        const KV_PER_TOKEN_FP8 = KV_PER_TOKEN_F16 / 2;
        const VLLM_OVERHEAD_GB = 2.0;                // CUDA graphs, activations, profiler buffers

        // Step 1: does the model + minimal overhead fit on GPU?
        const usableForKvGB = effectiveAllocatedGB - modelSizeGB - VLLM_OVERHEAD_GB;

        if (usableForKvGB < 1.0) {
            // Doesn't fit — enable CPU offload (per-card amount).
            const overflowGB = Math.max(0, modelSizeGB - effectiveAllocatedGB + VLLM_OVERHEAD_GB + 2);
            settings.cpuOffloadGb = Math.ceil(overflowGB / tp);
            settings.maxModelLen = 4096;
            settings.maxNumSeqs = 64;
            settings.kvCacheDtype = 'fp8';
            notes.push(`Model (${modelSizeGB.toFixed(1)} GB) exceeds per-card allocation (${perCardAllocatedGB.toFixed(1)} GB × ${tp} = ${effectiveAllocatedGB.toFixed(1)} GB)`);
            notes.push(`CPU offloading ${settings.cpuOffloadGb} GB per GPU (${(settings.cpuOffloadGb * tp).toFixed(0)} GB total to system RAM)`);
            notes.push('Note: GGUF + CPU offload may have issues (vLLM GH #8757)');
        } else {
            // Step 2: pick KV dtype. Use fp8 only when budget is tight
            // (< 4 GB headroom for KV) — fp8 hurts long-context quality
            // slightly so prefer auto/f16 when there's room.
            const kvDtype = usableForKvGB < 4.0 ? 'fp8' : 'auto';
            settings.kvCacheDtype = kvDtype;
            const perTok = kvDtype === 'fp8' ? KV_PER_TOKEN_FP8 : KV_PER_TOKEN_F16;

            // Step 3: pick max model len. vLLM benefits from a power-of-two
            // boundary similar to llama.cpp.
            const maxCtx = Math.floor((usableForKvGB * 1024 * 1024 * 1024) / perTok);
            let chosenCtx = 4096;
            for (const c of [262144, 131072, 65536, 32768, 16384, 8192, 4096]) {
                if (c <= maxCtx) { chosenCtx = c; break; }
            }
            settings.maxModelLen = chosenCtx;

            // Step 4: max_num_seqs ceiling — vLLM auto-tunes inside this
            // cap based on remaining KV space. Larger ceiling = more
            // concurrent requests but only if KV pool can hold them.
            settings.maxNumSeqs = usableForKvGB >= 8 ? 512 :
                                  usableForKvGB >= 4 ? 256 :
                                                       128;

            const predictedKvGB = (chosenCtx * perTok) / (1024 * 1024 * 1024);
            notes.push(`Effective allocation: ${perCardAllocatedGB.toFixed(1)} GB per card × ${tp} GPU(s) = ${effectiveAllocatedGB.toFixed(1)} GB`);
            notes.push(`gpu_memory_utilization: ${settings.gpuMemoryUtilization} (capped to fit smallest card's free VRAM)`);
            notes.push(`Model: ${modelSizeGB.toFixed(1)} GB · predicted KV: ${predictedKvGB.toFixed(1)} GB · vLLM overhead: ${VLLM_OVERHEAD_GB} GB`);
            notes.push(`Context: ${chosenCtx >= 1024 ? (chosenCtx / 1024).toFixed(0) + 'K' : chosenCtx} · KV dtype: ${kvDtype} · max concurrent seqs: ${settings.maxNumSeqs}`);
            if (kvDtype === 'fp8') {
                notes.push('fp8 KV chosen to fit at this context — slight quality hit on long contexts');
            }
        }

        if (gpuCount > 1) {
            notes.push(`tensor_parallel_size = ${tp} (model split across ${tp} GPUs)`);
            for (const g of gpuDetails) {
                notes.push(`  GPU ${g.index} (${g.name || 'unknown'}): ${g.freeGB.toFixed(1)} GB free / ${g.totalGB.toFixed(1)} GB total`);
            }
            if (imbalanced) {
                notes.push(`Cards are imbalanced (${(largestGpuFreeGB - smallestGpuFreeGB).toFixed(1)} GB spread). vLLM uses an even split — gpu_memory_utilization was capped to fit the smallest card.`);
            }
        }

        res.json({
            settings,
            backend: 'vllm',
            hardware: {
                gpuCount,
                gpuMemoryGB: gpuMemoryGB.toFixed(1),
                gpuFreeGB: gpuFreeGB.toFixed(1),
                smallestGpuFreeGB: smallestGpuFreeGB.toFixed(1),
                effectiveBudgetGB: effectiveAllocatedGB.toFixed(1),
                imbalanced,
                gpus: gpuDetails.map(g => ({
                    index: g.index,
                    name: g.name,
                    totalGB: parseFloat(g.totalGB.toFixed(1)),
                    freeGB: parseFloat(g.freeGB.toFixed(1)),
                    usedGB: parseFloat(g.usedGB.toFixed(1)),
                })),
                ramGB: ramGB.toFixed(1),
                cpuCores: cpuCount
            },
            model: {
                sizeGB: modelSizeGB.toFixed(2),
                estimatedVRAM: modelSizeGB.toFixed(2)
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
        // Check if user account has been disabled. Two parallel disable
        // mechanisms exist (legacy `disabled: true` field vs canonical
        // `status: 'disabled'`) — accept either to avoid an auth bypass
        // where a user disabled via the UI button can still hold a session.
        // We do NOT disclose "account is disabled" — that confirms the
        // username for an attacker. Return a generic 401 instead.
        if (req.user.disabled === true || req.user.status === 'disabled') {
            // Destroy session and reject request
            req.logout((err) => {
                if (err) console.error('Error during logout:', err);
            });
            return res.status(401).json({ error: 'Authentication required' });
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
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin permission required' });
        }
        req.userId = req.user.id;
        req.apiKeyData = null;
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
//
// The user-visible concept is now called "Tools" (the UI was renamed in Phase
// 1). The stored data model + route handlers keep the "skills" name to avoid a
// risky rename, but we expose /api/tools/* as first-class aliases that rewrite
// to the existing /api/skills/* handlers. Both paths stay permanently — API
// keys and external clients built against /api/skills won't break.
//
// Also aliases /api/agents/tools/* → /api/agents/skills/* for the agent-scoped
// discovery/recommend endpoints that use a different prefix.
app.use((req, res, next) => {
    if (req.url.startsWith('/api/tools')) {
        req.url = '/api/skills' + req.url.slice('/api/tools'.length);
    } else if (req.url.startsWith('/api/agents/tools')) {
        req.url = '/api/agents/skills' + req.url.slice('/api/agents/tools'.length);
    }
    next();
});

// ============================================================================
// MARKDOWN SKILLS API ENDPOINTS
// ============================================================================
//
// Markdown "skills" are instructional documents the LLM reads when it needs
// to know how to do something (e.g. "here's how to research a GitHub repo").
// They are NOT executable — the chat stream exposes a `load_skill` tool that
// returns the body to the model, and the model uses real tools from the
// catalog to carry out the steps.
const markdownSkills = require('./services/markdownSkills');

app.get('/api/markdown-skills', requireAuth, async (req, res) => {
    try {
        const items = await markdownSkills.listSkills(req.userId);
        res.json(items);
    } catch (e) {
        console.error('list markdown-skills failed:', e);
        res.status(500).json({ error: 'Failed to list skills' });
    }
});

app.get('/api/markdown-skills/:id', requireAuth, async (req, res) => {
    try {
        const skill = await markdownSkills.getSkill(req.userId, req.params.id);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        res.json(skill);
    } catch (e) {
        console.error('get markdown-skill failed:', e);
        res.status(500).json({ error: 'Failed to load skill' });
    }
});

app.post('/api/markdown-skills', requireAuth, async (req, res) => {
    try {
        const { name, description, triggers, body, enabled } = req.body || {};
        const result = await markdownSkills.createSkill(req.userId, {
            name, description, triggers, body, enabled,
        });
        res.status(201).json(result);
    } catch (e) {
        const msg = e.message || 'Failed to create skill';
        const status = /already exists|required/i.test(msg) ? 400 : 500;
        res.status(status).json({ error: msg });
    }
});

app.put('/api/markdown-skills/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, triggers, body, enabled } = req.body || {};
        const result = await markdownSkills.updateSkill(req.userId, req.params.id, {
            name, description, triggers, body, enabled,
        });
        res.json(result);
    } catch (e) {
        const msg = e.message || 'Failed to update skill';
        if (msg === 'not_found') return res.status(404).json({ error: 'Skill not found' });
        if (msg === 'forbidden') return res.status(403).json({ error: 'Cannot modify another user\'s skill' });
        res.status(/exceeds/i.test(msg) ? 400 : 500).json({ error: msg });
    }
});

app.delete('/api/markdown-skills/:id', requireAuth, async (req, res) => {
    try {
        await markdownSkills.deleteSkill(req.userId, req.params.id);
        res.json({ ok: true });
    } catch (e) {
        const msg = e.message || 'Failed to delete skill';
        if (msg === 'not_found') return res.status(404).json({ error: 'Skill not found' });
        if (msg === 'forbidden') return res.status(403).json({ error: 'Cannot delete another user\'s skill' });
        res.status(500).json({ error: msg });
    }
});

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

// Python skill executor. By default runs in a gVisor-sandboxed container
// (see webapp/services/sandboxRunner.js). Individual skills can opt out with
// `sandbox: false` on the skill definition — useful for trusted built-ins
// that need host FS access (file ops etc.) which won't work under --read-only.
//
// The legacy in-process path is still here for opted-out skills and as an
// automatic fallback if the sandbox runner throws during setup (missing
// image, broken Docker socket, etc.) — we'd rather degrade to the old
// behavior than fail the whole request.
async function executePythonSkill(skill, params, ctx = null) {
    const sandbox = require('./services/sandboxRunner');
    // Sandbox policy:
    //   - explicit skill.sandbox true/false → respect it
    //   - user-created skill (has userId) → sandbox by default (untrusted origin)
    //   - built-in default skill (no userId) → in-process by default because
    //     many of them (create_file, read_file, list_directory, …) need
    //     host FS access that --read-only would break. Containerizing the
    //     full default catalog with workspace-bound mounts is follow-up
    //     work; for now we trust the built-ins that ship with the product.
    const wantSandbox = typeof skill.sandbox === 'boolean'
        ? skill.sandbox
        : !!skill.userId;

    if (wantSandbox) {
        try {
            // Network policy from the skill definition. Built-in skills that
            // need the internet (playwright, scrapling, web fetches) must
            // declare network: 'allowlist' + `allowlist: [...]` so we don't
            // grant open egress by accident.
            const network = skill.network || 'none';
            const allowlist = skill.allowlist || [];
            const run = await sandbox.runPythonSkill({
                code: skill.code,
                params,
                network,
                allowlist,
                workspace: !!skill.workspace,
                // Opt out of sandbox-side path rewriting when the skill
                // declares it. Needed for git_* skills where `path` is a
                // repo-relative filter ('.', 'src/app.py'), not a
                // filesystem path to be rerouted under /workspace.
                pathNormalize: skill.pathNormalize !== false,
                timeoutMs: skill.timeoutMs || 30_000,
                memory: skill.memory || '512m',
                cpus: skill.cpus || '1.0',
                toolName: skill.name,
                // userId scopes the workspace owner; ctx.userId (from the
                // chat stream) wins over skill.userId so anonymous/global
                // built-in skills still bucket under the caller's account.
                userId: (ctx && ctx.userId) || skill.userId || null,
                // conversationId scopes the per-chat sub-bucket so cleanup
                // on DELETE /api/conversations/:id can wipe everything the
                // chat produced. Null for direct /api/skills/:name/execute
                // (falls back to the 'global' bucket).
                conversationId: (ctx && ctx.conversationId) || null,
            });
            if (run.timedOut) {
                // Runs with no artifacts are cleaned up immediately; nothing
                // downstream will need them.
                sandbox.cleanupRun(run.runId).catch(() => {});
                return { success: false, error: 'Skill timed out', timedOut: true };
            }
            // Runs that produced artifacts are kept on disk so the
            // `/api/tool-artifacts/:runId/:filename` endpoint can stream
            // them to the client. Periodic sweep (set up at boot) removes
            // runs older than ARTIFACT_TTL_MS. Runs without artifacts are
            // cleaned up immediately.
            if (!run.artifacts.length) {
                sandbox.cleanupRun(run.runId).catch(() => {});
            }
            if (run.result && typeof run.result === 'object') {
                if (run.artifacts.length) {
                    run.result._artifacts = run.artifacts.map(a => ({
                        name: a.name,
                        size: a.size,
                        runId: run.runId,
                        url: `/api/tool-artifacts/${run.runId}/${encodeURIComponent(a.name)}`,
                    }));
                }
                return run.result;
            }
            // Fallback when skill didn't return JSON — expose raw output.
            return {
                success: run.exitCode === 0,
                error: run.parseError || (run.stderr ? `sandbox stderr: ${run.stderr.slice(0, 2000)}` : 'no JSON output'),
                stdout: run.stdout.slice(0, 2000),
            };
        } catch (sandboxErr) {
            console.warn(`[executePythonSkill] sandbox run failed for "${skill.name}", falling back to in-process:`, sandboxErr.message);
            // Fall through to the legacy path below.
        }
    }

    // ------------------------------------------------------------------
    // Legacy in-process path — runs on the webapp container directly.
    // Only reached when skill.sandbox === false or when the sandbox path
    // errored out of band.
    // ------------------------------------------------------------------
    const tempFile = `/tmp/skill_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.py`;
    try {
        const paramsFile = `/tmp/skill_params_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.json`;
        await fs.writeFile(paramsFile, JSON.stringify(params));

        const pythonScript = `#!/usr/bin/env python3
import json
import sys
import os

with open("${paramsFile}", "r") as f:
    params = json.load(f)

${skill.code}

try:
    result = execute(params)
    if not isinstance(result, dict):
        result = {"success": False, "error": "Skill must return a dictionary"}
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
`;

        await fs.writeFile(tempFile, pythonScript, { mode: 0o755 });
        const { stdout, stderr } = await execPromise(
            `python3 "${tempFile}"`,
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
        await fs.unlink(paramsFile).catch(() => {});
        await fs.unlink(tempFile).catch(() => {});
        try {
            return JSON.parse(stdout.trim());
        } catch (parseError) {
            console.error('Failed to parse Python output:', stdout, stderr);
            throw new Error(`Invalid JSON output from Python skill: ${parseError.message}`);
        }
    } catch (error) {
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

            case 'extract_archive': {
                const archiveExtractor = require('./services/archiveExtractor');
                const fname = params.filename || params.archiveName;
                const b64 = params.base64Data || params.archiveData;
                if (!b64) throw new Error('base64Data required');
                if (!fname) throw new Error('filename required (extension picks the extractor)');
                let buf;
                try {
                    buf = Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
                } catch (e) {
                    throw new Error('Invalid base64Data: ' + e.message);
                }
                if (!buf.length) throw new Error('Decoded buffer is empty');
                if (buf.length > 50 * 1024 * 1024) {
                    throw new Error(`Archive is ${buf.length} bytes; 50MB max.`);
                }
                result = await archiveExtractor.extractArchive(buf, fname);
                break;
            }

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
 * Parse an XLSX/XLS workbook buffer into concatenated CSV text, one
 * "=== Sheet: <name> ===" header per sheet.
 *
 * Uses `@e965/xlsx` — a community-maintained fork of SheetJS that
 * keeps the fast sync API (~5× faster than exceljs for read-only
 * sheet→CSV on typical office files) but has the GHSA-4r6h-8v6p-xvw6
 * (prototype pollution) and GHSA-5pgg-2g8v-p4x9 (ReDoS) patches the
 * upstream `xlsx` on npm never shipped. npm audit reports zero
 * advisories on this fork.
 */
function xlsxBufferToCsv(buffer) {
    const XLSX = require('@e965/xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const chunks = [];
    for (const sheetName of workbook.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]).trim();
        if (csv) chunks.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    }
    return chunks.join('\n\n');
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
        // XLSX/XLS - extract as text via exceljs
        else if (ext === 'xlsx' || ext === 'xls' || contentType.includes('spreadsheetml') || contentType.includes('ms-excel')) {
            try {
                extractedText = await xlsxBufferToCsv(buffer);
                title = filename;
            } catch (e) {
                console.warn(`[fetchUrlAsFile] XLSX parse failed: ${e.message} — falling through to HTML scraping`);
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

    // SSRF protection: block requests to private/internal networks
    for (const url of urlsToFetch) {
        if (isPrivateUrl(url)) {
            return res.status(400).json({ error: 'URLs pointing to private/internal networks are not allowed' });
        }
    }

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

    // SSRF protection: block requests to private/internal networks
    const allUrls = urls ? urls.slice(0, 10) : (url ? [url] : []);
    for (const u of allUrls) {
        if (isPrivateUrl(u)) {
            return res.status(400).json({ error: 'URLs pointing to private/internal networks are not allowed' });
        }
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

    // SSRF protection: block requests to private/internal networks
    if (isPrivateUrl(url)) {
        return res.status(400).json({ error: 'URLs pointing to private/internal networks are not allowed' });
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

// Base64 wrapper for conversation and memory files. This is obfuscation,
// not encryption — it just keeps casual disk inspection from showing
// plaintext chat history. Every write goes through encodeConversationData
// so new files are always base64; reads sniff the format so legacy JSON
// files keep loading and convert on next save. Format detection is cheap
// (one character check) and the conversion is transparent to callers.
function encodeConversationData(value) {
    const json = JSON.stringify(value, null, 2);
    return Buffer.from(json, 'utf8').toString('base64');
}
function decodeConversationData(raw, fallback = null) {
    if (!raw || !raw.trim()) return fallback;
    const trimmed = raw.trim();
    // Legacy plaintext JSON starts with { or [
    if (trimmed[0] === '{' || trimmed[0] === '[') {
        try { return JSON.parse(trimmed); }
        catch { return fallback; }
    }
    // Everything else is treated as base64-encoded JSON
    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch {
        return fallback;
    }
}

// Ensure conversations directory exists for a user
async function ensureUserConversationsDir(userId) {
    const userDir = path.join(CONVERSATIONS_DIR, userId);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

// Per-path write lock + atomic rename. Conversation indexes and message
// files are read-modify-write hotspots — chat-stream save, memory
// extraction, and explicit POST/PUT/DELETE routes can hit the same file
// within milliseconds. Plain fs.writeFile is neither atomic nor serialized,
// so two writes of different lengths can interleave at the byte level and
// leave a valid prefix from the shorter write followed by stray tail bytes
// from the longer one. The decoder then fails and the user's whole
// conversation list "disappears." safeWriteFile gives every write its own
// turn (per path) and only swaps the final file in via rename.
const _fileLocks = new Map();
function withFileLock(key, fn) {
    const prev = _fileLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _fileLocks.set(key, next.catch(() => {}));
    return next;
}
async function atomicWriteFile(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, filePath);
    } catch (err) {
        try { await fs.unlink(tmp); } catch {}
        throw err;
    }
}
async function safeWriteFile(filePath, data) {
    return withFileLock(filePath, () => atomicWriteFile(filePath, data));
}

// Load conversations index for a user. If the file is missing, empty,
// or corrupt, scan the user's directory for {uuid}.json conversation
// files and rebuild the index from them in place rather than returning
// an empty list (which would make every conversation appear "deleted").
async function loadConversationsIndex(userId) {
    const userDir = await ensureUserConversationsDir(userId);
    const indexPath = path.join(userDir, 'index.json');
    let parsed = null;
    try {
        const data = await fs.readFile(indexPath, 'utf8');
        parsed = decodeConversationData(data, null);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (Array.isArray(parsed)) return parsed;
    return await withFileLock(indexPath, async () => {
        // Re-check inside the lock — a concurrent caller may have rebuilt.
        try {
            const fresh = await fs.readFile(indexPath, 'utf8');
            const reparsed = decodeConversationData(fresh, null);
            if (Array.isArray(reparsed) && reparsed.length > 0) return reparsed;
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        const rebuilt = await rebuildConversationsIndexFromDisk(userId, userDir);
        if (rebuilt.length > 0) {
            console.warn(`Rebuilt conversations index for user ${userId} from ${rebuilt.length} on-disk files`);
            await atomicWriteFile(indexPath, encodeConversationData(rebuilt));
        }
        return rebuilt;
    });
}

// Walk a user's conversations dir and reconstruct an index from the
// {uuid}.json files actually on disk. Title comes from the first user
// message; timestamps from file stat; memoryCount from the per-conversation
// memory index when present. Sorted newest-first to match how new
// conversations are unshifted onto the live index.
async function rebuildConversationsIndexFromDisk(userId, userDir) {
    let names;
    try { names = await fs.readdir(userDir); }
    catch { return []; }
    const idRegex = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
    const entries = [];
    for (const name of names) {
        const m = name.match(idRegex);
        if (!m) continue;
        const id = m[1];
        const filePath = path.join(userDir, name);
        let stat;
        try { stat = await fs.stat(filePath); }
        catch { continue; }
        let messages = [];
        try { messages = await loadConversationMessages(userId, id); } catch {}
        let title = 'New Conversation';
        const firstUser = messages.find(msg => msg && msg.role === 'user');
        if (firstUser) {
            let txt = '';
            if (typeof firstUser.content === 'string') {
                txt = firstUser.content;
            } else if (Array.isArray(firstUser.content)) {
                const part = firstUser.content.find(p => p && p.type === 'text' && typeof p.text === 'string');
                txt = part ? part.text : '';
            }
            const cleaned = txt.replace(/\s+/g, ' ').trim();
            if (cleaned) title = cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
        }
        let memoryCount = 0;
        try {
            const memIndex = await loadMemoryIndex(userId, id);
            memoryCount = Array.isArray(memIndex.entries) ? memIndex.entries.length : 0;
        } catch {}
        const created = (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString();
        entries.push({
            id,
            title,
            createdAt: created,
            updatedAt: stat.mtime.toISOString(),
            messageCount: messages.length,
            memoryCount
        });
    }
    entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return entries;
}

// Save conversations index for a user
async function saveConversationsIndex(userId, conversations) {
    const userDir = await ensureUserConversationsDir(userId);
    const indexPath = path.join(userDir, 'index.json');
    await safeWriteFile(indexPath, encodeConversationData(conversations));
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
        const parsed = decodeConversationData(data, null);
        if (parsed === null) {
            console.error(`Corrupted conversation ${conversationId} for user ${userId}`);
            return [];
        }
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
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
    await safeWriteFile(messagesPath, encodeConversationData(messages));

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

    // Fire-and-forget memory extraction from any new user→assistant pairs
    // since the last save. Memory work must never block the save or leak
    // errors back to the caller — user turns always succeed to disk.
    extractNewMemoriesFromSave(userId, conversationId, messages).catch(err => {
        console.warn(`[Memory] Extraction failed for ${conversationId}: ${err.message}`);
    });
}

// ============================================================================
// PER-CONVERSATION MEMORY STORE
// ============================================================================
// Each conversation gets a memory directory that holds short, heuristically-
// compressed facts extracted from user↔assistant turns. On follow-up messages
// the chat stream handler scores these against the new query, packs the top
// matches into a system message, and injects them before the model call so
// relevant context survives even after AIMem compression or context rollover.
// All memory files are base64-wrapped via the same encode/decode helpers as
// conversations.

// Maximum total memories retained per conversation; oldest low-score entries
// are pruned once this is exceeded.
const MEMORY_MAX_ENTRIES = 200;
// Target token budget for injected memories on a single turn.
const MEMORY_RETRIEVAL_TOKEN_BUDGET = 1500;
// Minimum factuality score to keep a sentence as a memory.
const MEMORY_MIN_SCORE = 2;

async function ensureMemoryDir(userId, conversationId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        throw new Error('Invalid conversation ID format');
    }
    const dir = path.join(CONVERSATIONS_DIR, userId, 'memory', conversationId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function loadMemoryIndex(userId, conversationId) {
    // Reads only — do NOT call ensureMemoryDir here. A GET that finds
    // no memories should not leave an empty directory behind on disk.
    // Writes go through saveMemoryIndex / saveMemoryEntry which create
    // the directory lazily.
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
        throw new Error('Invalid conversation ID format');
    }
    const indexPath = path.join(CONVERSATIONS_DIR, userId, 'memory', conversationId, 'index.json');
    try {
        const data = await fs.readFile(indexPath, 'utf8');
        const parsed = decodeConversationData(data, null);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
            return parsed;
        }
        return { cursor: null, entries: [] };
    } catch (err) {
        if (err.code === 'ENOENT') return { cursor: null, entries: [] };
        throw err;
    }
}

async function saveMemoryIndex(userId, conversationId, index) {
    const dir = await ensureMemoryDir(userId, conversationId);
    const indexPath = path.join(dir, 'index.json');
    await safeWriteFile(indexPath, encodeConversationData(index));
}

async function loadMemoryEntry(userId, conversationId, memoryId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(memoryId)) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    // Pure read — do not create the memory directory as a side effect.
    const entryPath = path.join(CONVERSATIONS_DIR, userId, 'memory', conversationId, `${memoryId}.mem`);
    try {
        const data = await fs.readFile(entryPath, 'utf8');
        const parsed = decodeConversationData(data, null);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function saveMemoryEntry(userId, conversationId, memoryId, entry) {
    if (!/^[a-zA-Z0-9_-]+$/.test(memoryId)) {
        throw new Error('Invalid memory ID format');
    }
    const dir = await ensureMemoryDir(userId, conversationId);
    const entryPath = path.join(dir, `${memoryId}.mem`);
    await safeWriteFile(entryPath, encodeConversationData(entry));
}

async function deleteMemoryDir(userId, conversationId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return;
    const dir = path.join(CONVERSATIONS_DIR, userId, 'memory', conversationId);
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[Memory] Failed to delete memory dir for ${conversationId}: ${err.message}`);
        }
    }
}

async function updateConversationMemoryCount(userId, conversationId, count) {
    const conversations = await loadConversationsIndex(userId);
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) return;
    conv.memoryCount = count;
    await saveConversationsIndex(userId, conversations);
}

// Score a sentence for how "fact-like" it is. Facts are what we want to
// remember; filler phrases and meta-commentary are what we want to drop.
// This is a heuristic, not a classifier — tuned so the top-scored sentences
// from a typical Q&A turn are the ones a human would also pick.
function scoreFactuality(sentence) {
    const s = sentence.trim();
    if (s.length < 15 || s.length > 500) return 0;
    let score = 0;
    // URLs and identifiers are high-value
    if (/https?:\/\//.test(s)) score += 4;
    if (/\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]+\b/.test(s)) score += 2; // camelCase
    if (/\b[a-z0-9]+_[a-z0-9_]+\b/.test(s)) score += 2;               // snake_case
    if (/\b[A-Z][A-Z0-9_]{3,}\b/.test(s)) score += 2;                  // ALL_CAPS constants
    // Filesystem paths: absolute (/etc/foo), home (~/foo), or relative
    // (./foo, ../foo) — the dot-prefixed forms appear constantly in build
    // instructions ("./build.sh") and must score as high-value.
    if (/(^|\s)(\.{1,2}\/|[/~])[\w./-]+/.test(s)) score += 2;
    // Bare filenames with a common extension ("build.sh", "config.yaml",
    // "model.gguf") are also path-like facts worth keeping.
    if (/\b[\w-]+\.(sh|py|js|jsx|ts|tsx|json|ya?ml|toml|conf|cfg|ini|md|txt|log|sql|go|rs|rb|java|cpp|c|h|hpp|html|css|xml|env|lock|gguf|bin|onnx)\b/i.test(s)) score += 2;
    if (/`[^`]+`/.test(s)) score += 2;                                 // backtick code
    if (/"[^"]{3,}"|'[^']{3,}'/.test(s)) score += 1;                   // quoted strings
    // Numbers, dates, versions, amounts
    if (/\b\d+(\.\d+)?\b/.test(s)) score += 1;
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) score += 2;                   // ISO date
    if (/\bv?\d+\.\d+(\.\d+)?\b/.test(s)) score += 1;                  // version
    // Declarative predicates — expanded beyond the basic copula to cover
    // the verbs that most often introduce concrete facts in technical
    // prose. Missing these produces lots of false-negatives on simple
    // statements like "the webapp listens on port 3001" or "the build
    // runs ./build.sh".
    if (/\b(is|was|are|were|has|have|had|named|called|equals?|returns?|contains?|requires?|means?|uses|runs|listens?|provides?|accepts?|includes?|mounts?|exports?|handles?|matches?|starts?|stops?|binds?|loads?|writes?|reads?|stores?|points?|lives?|located|depends?\s+on)\b/i.test(s)) score += 1;
    // Capitalized words that are not sentence-initial — proper nouns
    const caps = (s.match(/(?<=[a-z]\s)[A-Z][a-zA-Z]+/g) || []).length;
    if (caps >= 1) score += Math.min(2, caps);
    // Filler/meta-commentary penalties
    if (/^(sure|okay|ok|yes|no|thanks|thank you|got it|great|alright|certainly)\b/i.test(s)) score -= 5;
    if (/\b(let me|I'll|I will|I can|here's|here is|as requested|as an ai)\b/i.test(s)) score -= 3;
    if (/\b(in summary|to summarize|in conclusion|overall|basically|essentially)\b/i.test(s)) score -= 2;
    return score;
}

// Lightweight JS-side shorthand compression — a subset of AIMem's shorthand
// stage ported over to avoid spawning a Python subprocess on every turn.
// These replacements are lossless for meaning but shave ~15-25% off length
// on typical prose. Longer replacements come first to avoid partial overlap.
const SHORTHAND_REPLACEMENTS = [
    [/\bin order to\b/gi, 'to'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bwith respect to\b/gi, 're:'],
    [/\bfor the purpose of\b/gi, 'to'],
    [/\bin the event that\b/gi, 'if'],
    [/\bat this point in time\b/gi, 'now'],
    [/\bfor example\b/gi, 'e.g.'],
    [/\bthat is\b/gi, 'i.e.'],
    [/\bas well as\b/gi, 'and'],
    [/\bin addition to\b/gi, 'and'],
    [/\bas a result\b/gi, 'so'],
    [/\bit is important to note that\b/gi, 'note:'],
    [/\bit should be noted that\b/gi, 'note:'],
    [/\bplease note that\b/gi, 'note:'],
    [/\bkeep in mind that\b/gi, 'note:'],
    [/\bthe user (?:is )?asking\b/gi, 'user asks'],
    [/\bthe user wants\b/gi, 'user wants'],
    [/\bthe user said\b/gi, 'user:'],
    [/\bI would like to\b/gi, "I'd"],
    [/\byou would like to\b/gi, "you'd"],
    [/\bdo not\b/gi, "don't"],
    [/\bdoes not\b/gi, "doesn't"],
    [/\bis not\b/gi, "isn't"],
    [/\bare not\b/gi, "aren't"],
    [/\bwill not\b/gi, "won't"],
    [/\bcannot\b/gi, "can't"],
    [/\s{2,}/g, ' '],
];
function shorthandCompress(text) {
    let out = text;
    for (const [pattern, repl] of SHORTHAND_REPLACEMENTS) {
        out = out.replace(pattern, repl);
    }
    return out.trim();
}

// Split text into sentences without breaking on dots inside filesystem
// paths, URLs, version numbers, decimals, or mid-word abbreviations. A
// sentence boundary is either a newline OR a .!? terminator followed by
// whitespace and a capital-letter sentence start (optionally preceded by
// an opening quote or paren). This preserves /etc/foo.conf, v1.2.3,
// https://example.com/a.html, and 3.14 as single tokens inside whatever
// sentence they belong to.
function splitIntoSentences(text) {
    if (!text) return [];
    const out = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        const parts = trimmedLine.split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z])/);
        for (const p of parts) {
            const t = p.trim();
            if (t) out.push(t);
        }
    }
    return out;
}

// Extract up to `maxKeep` memory-worthy sentences from a user→assistant pair.
// Returns an array of { text, keywords, tokens, sourceRole }. Runs entirely
// in-process, no subprocess spawn, safe to call on every save.
function extractMemoriesFromTurn(userText, assistantText, maxKeep = 5) {
    const memories = [];

    const processSide = (text, role) => {
        if (!text || typeof text !== 'string') return;
        // Strip reasoning blocks — they're introspection, not facts worth
        // remembering across turns. Covers <think>, <thinking>, <reasoning>,
        // and <reasoning_engine> variants emitted by different models.
        const clean = text.replace(/<(think|thinking|reasoning|reasoning_engine)>[\s\S]*?<\/\1>/gi, '').trim();
        if (!clean) return;
        // Skip pure-code payloads entirely — splitting code into "sentences"
        // produces garbage and the useful facts about code live in the prose
        // around it, not the code itself.
        if (looksLikeCode(clean)) return;
        const sentences = splitIntoSentences(clean);
        for (const sentence of sentences) {
            const score = scoreFactuality(sentence);
            if (score < MEMORY_MIN_SCORE) continue;
            const compressed = shorthandCompress(sentence);
            const keywords = extractQueryKeywords(compressed);
            if (keywords.length === 0) continue;
            memories.push({
                text: compressed,
                keywords,
                tokens: Math.ceil(compressed.length / 3),
                sourceRole: role,
                score,
            });
        }
    };

    processSide(userText, 'user');
    processSide(assistantText, 'assistant');

    // Sort by score and keep the top N; also dedup within the same turn by
    // keyword-set overlap so we don't save two paraphrases of the same fact.
    memories.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const m of memories) {
        const dup = kept.some(k => jaccardSimilarity(k.keywords, m.keywords) >= 0.7);
        if (!dup) kept.push(m);
        if (kept.length >= maxKeep) break;
    }
    return kept;
}

function jaccardSimilarity(aKeywords, bKeywords) {
    if (!aKeywords.length || !bKeywords.length) return 0;
    const a = new Set(aKeywords);
    const b = new Set(bKeywords);
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

// Get text content from a chat message, handling both string and vision-array
// formats. Strips image_url parts since memories are text-only.
function messageText(msg) {
    if (!msg || !msg.content) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
    }
    return '';
}

// After a saveConversationMessages call, walk any user→assistant pairs that
// are newer than the memory cursor and extract memories from each. Updates
// the cursor to the last processed assistant message id so we don't
// re-process on the next save. Swallows all errors — memory is advisory.
async function extractNewMemoriesFromSave(userId, conversationId, messages) {
    if (!Array.isArray(messages) || messages.length < 2) return;
    const index = await loadMemoryIndex(userId, conversationId);

    // Find the position after the cursor (or start from 0 if no cursor).
    let startIdx = 0;
    if (index.cursor) {
        const cursorIdx = messages.findIndex(m => m.id === index.cursor);
        if (cursorIdx >= 0) startIdx = cursorIdx + 1;
    }

    let newestCursor = index.cursor;
    let addedCount = 0;

    for (let i = startIdx; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;
        // Walk backwards to find the most recent user message before this one.
        let userMsg = null;
        for (let j = i - 1; j >= 0; j--) {
            if (messages[j].role === 'user') { userMsg = messages[j]; break; }
            if (messages[j].role === 'assistant') break; // not paired
        }
        if (!userMsg) { newestCursor = msg.id || newestCursor; continue; }

        const extracted = extractMemoriesFromTurn(messageText(userMsg), messageText(msg));
        for (const mem of extracted) {
            // Dedup against existing memories in the index by keyword overlap.
            const dup = index.entries.some(e =>
                jaccardSimilarity(e.keywords, mem.keywords) >= 0.75
            );
            if (dup) continue;
            const memId = crypto.randomUUID();
            await saveMemoryEntry(userId, conversationId, memId, {
                id: memId,
                text: mem.text,
                keywords: mem.keywords,
                tokens: mem.tokens,
                sourceRole: mem.sourceRole,
                sourceTurnId: msg.id || null,
                ts: new Date().toISOString(),
            });
            index.entries.push({
                id: memId,
                keywords: mem.keywords,
                tokens: mem.tokens,
                score: mem.score,
                ts: new Date().toISOString(),
            });
            addedCount++;
        }
        if (msg.id) newestCursor = msg.id;
    }

    // Prune if we've exceeded the cap — drop lowest-score oldest entries first.
    if (index.entries.length > MEMORY_MAX_ENTRIES) {
        index.entries.sort((a, b) => (a.score || 0) - (b.score || 0));
        const overflow = index.entries.length - MEMORY_MAX_ENTRIES;
        const dropped = index.entries.splice(0, overflow);
        for (const d of dropped) {
            const dir = path.join(CONVERSATIONS_DIR, userId, 'memory', conversationId);
            await fs.unlink(path.join(dir, `${d.id}.mem`)).catch(() => {});
        }
    }

    index.cursor = newestCursor;
    if (addedCount > 0 || index.cursor !== null) {
        await saveMemoryIndex(userId, conversationId, index);
    }
    if (addedCount > 0) {
        console.log(`[Memory] Extracted ${addedCount} memories for conversation ${conversationId} (total: ${index.entries.length})`);
        try {
            await updateConversationMemoryCount(userId, conversationId, index.entries.length);
        } catch (err) {
            console.warn(`[Memory] Failed to sync memoryCount for ${conversationId}: ${err.message}`);
        }
    }
}

// Pre-turn retrieval: score all memories for this conversation against the
// incoming query and pack the top matches into a token budget. Returns a
// single concatenated string ready to inject as a system message, or null
// if nothing meets the bar.
async function retrieveRelevantMemories(userId, conversationId, query, tokenBudget = MEMORY_RETRIEVAL_TOKEN_BUDGET) {
    if (!query || typeof query !== 'string') return null;
    let index;
    try {
        index = await loadMemoryIndex(userId, conversationId);
    } catch {
        return null;
    }
    if (!index.entries.length) return null;

    const queryKeywords = extractQueryKeywords(query);
    if (queryKeywords.length === 0) return null;

    // Score each index entry by keyword overlap. Cheap and local — no disk
    // read for non-matching entries.
    const scored = index.entries.map(e => ({
        entry: e,
        relevance: jaccardSimilarity(e.keywords, queryKeywords),
    }));
    scored.sort((a, b) => b.relevance - a.relevance);

    // Keep top entries with any overlap at all, within the token budget.
    const picked = [];
    let usedTokens = 0;
    for (const s of scored) {
        if (s.relevance <= 0) break;
        if (usedTokens + s.entry.tokens > tokenBudget) continue;
        const full = await loadMemoryEntry(userId, conversationId, s.entry.id);
        if (!full) continue;
        picked.push(full);
        usedTokens += s.entry.tokens;
        if (picked.length >= 25) break;
    }
    if (picked.length === 0) return null;

    // Order by timestamp so injected memories read as a chronological digest.
    picked.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const lines = picked.map(m => `- ${m.text}`).join('\n');
    console.log(`[Memory] Injecting ${picked.length} memories (${usedTokens} tokens) for conversation ${conversationId}`);
    return {
        block: `Relevant context from earlier in this conversation:\n${lines}`,
        count: picked.length,
        tokens: usedTokens,
        previews: picked.slice(0, 5).map(m => (m.text || '').slice(0, 120)),
    };
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
            if (conv.memoryCount === undefined) {
                try {
                    const memIndex = await loadMemoryIndex(userId, conv.id);
                    conv.memoryCount = memIndex.entries.length;
                } catch {
                    conv.memoryCount = 0;
                }
                needsSave = true;
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

        // Validate conversation ID format to prevent path traversal
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversations = await loadConversationsIndex(userId);
        const index = conversations.findIndex(c => c.id === id);

        if (index === -1) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        conversations.splice(index, 1);
        await saveConversationsIndex(userId, conversations);

        // Load the messages BEFORE unlinking so we can walk their
        // attachments and wipe matching entries from the persistent
        // attachment store. Errors here are non-fatal — orphan-sweep at
        // boot will catch anything we miss. Use loadConversationMessages
        // so the base64 wrapper applied by encodeConversationData is
        // transparently undone.
        const userDir = await ensureUserConversationsDir(userId);
        const messagesPath = path.join(userDir, `${id}.json`);
        let convMessages = [];
        try {
            convMessages = await loadConversationMessages(userId, id);
        } catch (_) { /* file may not exist */ }

        try {
            await fs.unlink(messagesPath);
        } catch (e) {
            // Ignore if file doesn't exist
        }

        // Wipe attachment-store entries for every PDF / xlsx / etc. the
        // user uploaded into this conversation. Same broadcast pattern as
        // the sandbox-workspace wipe below.
        try {
            const wipe = await attachmentStore.deleteForConversation(userId, convMessages);
            if (wipe.count > 0) {
                const kb = Math.round((wipe.byteSize || 0) / 1024);
                const logMsg = `[Attachments] Wiped ${wipe.count} attachment(s) for deleted conversation ${id.slice(0, 8)}… — ${kb} KB`;
                console.log(logMsg);
                try {
                    broadcast({ type: 'log', level: 'info', message: logMsg }, userId);
                } catch (_) { /* broadcast best-effort */ }
            }
        } catch (e) {
            console.warn('[Attachments] wipe on conv delete failed:', e.message);
        }

        // Delete per-conversation memory directory alongside the messages
        // file — leaving memories around for a deleted conversation would
        // accumulate dead state and leak content across reused ids.
        await deleteMemoryDir(userId, id);

        // Wipe the per-conversation sandbox workspace — git clones, files
        // written by run_python / create_file, chart PNGs, anything else
        // sandboxed skills produced during this chat. Non-blocking log
        // event to the user's Logs tab regardless of whether anything was
        // actually there to delete.
        //
        // Workspace owner must match the userId that the sandbox saw when
        // writing: tool dispatch passes req.userId (null for API-key auth
        // without a bound user; ensureWorkspace buckets those under
        // `global/`). Using the broader `userId` variable declared above
        // (which falls back to apiKeyData.id then 'default') would point at
        // the wrong dir and silently skip the cleanup.
        const workspaceUserId = req.userId ?? null;
        try {
            const sbRunner = require('./services/sandboxRunner');
            const wipe = await sbRunner.deleteConversationWorkspace(workspaceUserId, id);
            if (wipe && wipe.deleted) {
                const kb = Math.round((wipe.byteCount || 0) / 1024);
                const logMsg = `[Sandbox] Wiped workspace for deleted conversation ${id.slice(0, 8)}… — ${wipe.fileCount} file(s), ${kb} KB`;
                console.log(logMsg);
                try {
                    broadcast({ type: 'log', level: 'info', message: logMsg }, userId);
                } catch (_) { /* broadcast is best-effort */ }
            } else if (wipe && wipe.error) {
                const logMsg = `[Sandbox] Workspace cleanup for ${id.slice(0, 8)}… failed: ${wipe.error}`;
                console.warn(logMsg);
                try {
                    broadcast({ type: 'log', level: 'warn', message: logMsg }, userId);
                } catch (_) {}
            }
        } catch (e) {
            console.warn('[Sandbox] workspace wipe on conv delete failed:', e.message);
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

// ----------------------------------------------------------------------------
// MEMORY MANAGEMENT ROUTES
// ----------------------------------------------------------------------------
// List, edit, and delete per-conversation memories. The store is populated
// automatically on save (via extractNewMemoriesFromSave) and consumed on the
// next turn (via retrieveRelevantMemories). These routes exist so the chat
// UI has a management view — users can correct facts the heuristic got
// wrong, prune noise, or wipe the whole store for a conversation.

// Shared ownership check: the conversation must exist in this user's index
// before we touch its memory directory. Prevents a different user's API key
// from listing / editing / deleting someone else's memories by guessing an
// id. Returns the conversation object on success, null on 404.
async function ownsConversation(userId, conversationId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    const list = await loadConversationsIndex(userId);
    return list.find(c => c.id === conversationId) || null;
}

// GET /api/conversations/:id/memories — list all memories for a conversation
app.get('/api/conversations/:id/memories', requireAuth, async (req, res) => {
    try {
        if (!checkPermission(req.apiKeyData, 'query')) {
            return res.status(403).json({ error: 'Query permission required for memory access' });
        }
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;
        if (!(await ownsConversation(userId, id))) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        const index = await loadMemoryIndex(userId, id);
        // Hydrate each index entry with its full text. We return full entries
        // (not just metadata) so the UI can render without a second round-trip.
        const entries = [];
        for (const meta of index.entries) {
            const full = await loadMemoryEntry(userId, id, meta.id);
            if (full) {
                entries.push({
                    id: meta.id,
                    text: full.text,
                    keywords: full.keywords || meta.keywords || [],
                    tokens: full.tokens || meta.tokens || 0,
                    sourceRole: full.sourceRole || 'assistant',
                    sourceTurnId: full.sourceTurnId || null,
                    ts: full.ts || meta.ts || null,
                    score: meta.score ?? null,
                });
            }
        }
        // Newest first for a more useful default sort in the UI.
        entries.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
        res.json({
            conversationId: id,
            cursor: index.cursor,
            count: entries.length,
            memories: entries,
        });
    } catch (error) {
        console.error('Error listing memories:', error);
        res.status(500).json({ error: 'Failed to list memories' });
    }
});

// DELETE /api/conversations/:id/memories — clear all memories for a conversation
app.delete('/api/conversations/:id/memories', requireAuth, async (req, res) => {
    try {
        if (!checkPermission(req.apiKeyData, 'query')) {
            return res.status(403).json({ error: 'Query permission required for memory access' });
        }
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id } = req.params;
        if (!(await ownsConversation(userId, id))) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        await deleteMemoryDir(userId, id);
        try {
            await updateConversationMemoryCount(userId, id, 0);
        } catch (err) {
            console.warn(`[Memory] Failed to sync memoryCount for ${id}: ${err.message}`);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error clearing memories:', error);
        res.status(500).json({ error: 'Failed to clear memories' });
    }
});

// DELETE /api/conversations/:id/memories/:memId — delete one memory
app.delete('/api/conversations/:id/memories/:memId', requireAuth, async (req, res) => {
    try {
        if (!checkPermission(req.apiKeyData, 'query')) {
            return res.status(403).json({ error: 'Query permission required for memory access' });
        }
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id, memId } = req.params;
        if (!/^[a-zA-Z0-9_-]+$/.test(memId)) {
            return res.status(400).json({ error: 'Invalid memory id' });
        }
        if (!(await ownsConversation(userId, id))) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        const index = await loadMemoryIndex(userId, id);
        const before = index.entries.length;
        index.entries = index.entries.filter(e => e.id !== memId);
        if (index.entries.length === before) {
            return res.status(404).json({ error: 'Memory not found' });
        }
        await saveMemoryIndex(userId, id, index);
        // Remove the .mem file — best-effort, index is source of truth.
        const dir = path.join(CONVERSATIONS_DIR, userId, 'memory', id);
        await fs.unlink(path.join(dir, `${memId}.mem`)).catch(() => {});
        try {
            await updateConversationMemoryCount(userId, id, index.entries.length);
        } catch (err) {
            console.warn(`[Memory] Failed to sync memoryCount for ${id}: ${err.message}`);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting memory:', error);
        res.status(500).json({ error: 'Failed to delete memory' });
    }
});

// PUT /api/conversations/:id/memories/:memId — edit a memory's text
app.put('/api/conversations/:id/memories/:memId', requireAuth, async (req, res) => {
    try {
        if (!checkPermission(req.apiKeyData, 'query')) {
            return res.status(403).json({ error: 'Query permission required for memory access' });
        }
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const { id, memId } = req.params;
        const { text } = req.body;
        if (!/^[a-zA-Z0-9_-]+$/.test(memId)) {
            return res.status(400).json({ error: 'Invalid memory id' });
        }
        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Memory text must be a non-empty string' });
        }
        if (text.length > 2000) {
            return res.status(400).json({ error: 'Memory text too long (max 2000 chars)' });
        }
        if (!(await ownsConversation(userId, id))) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        const entry = await loadMemoryEntry(userId, id, memId);
        if (!entry) {
            return res.status(404).json({ error: 'Memory not found' });
        }
        const trimmed = text.trim();
        // Re-derive keywords and token count from the edited text so retrieval
        // scoring stays consistent with extractor output.
        const keywords = extractQueryKeywords(trimmed);
        const tokens = Math.ceil(trimmed.length / 3);
        const updated = {
            ...entry,
            text: trimmed,
            keywords,
            tokens,
            editedAt: new Date().toISOString(),
        };
        await saveMemoryEntry(userId, id, memId, updated);

        // Update the corresponding index entry so retrieval scoring uses the
        // new keyword set without a second disk read.
        const index = await loadMemoryIndex(userId, id);
        const idxEntry = index.entries.find(e => e.id === memId);
        if (idxEntry) {
            idxEntry.keywords = keywords;
            idxEntry.tokens = tokens;
            await saveMemoryIndex(userId, id, index);
        }

        res.json({ success: true, memory: { id: memId, ...updated } });
    } catch (error) {
        console.error('Error editing memory:', error);
        res.status(500).json({ error: 'Failed to edit memory' });
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
            clientConnected: job.clientConnected,
            phase: job.phase || null,
            progress: job.progress || null,
            events: Array.isArray(job.events) ? job.events : [],
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

                // Save the raw PDF to the attachment store so the chat UI
                // can fetch it on demand for inline rendering. Conversations
                // only persist the small attachmentId, not 8 MB of base64.
                let attachmentId = null;
                try {
                    const ownerId = req.user?.id || req.apiKeyData?.id || 'default';
                    attachmentId = await attachmentStore.save(ownerId, {
                        filename,
                        mimeType: 'application/pdf',
                        type: 'pdf',
                        bytes: buffer,
                        meta: { pageCount, charCount: prepared.content.length },
                    });
                } catch (storeErr) {
                    console.warn('[Chat Upload] attachmentStore save failed (PDF):', storeErr.message);
                }

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
                    ocrPerformed: ocrPerformed,
                    ...(attachmentId ? { attachmentId } : {}),
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

        // For Excel files (.xlsx) — parsed via @e965/xlsx
        if (ext === 'xlsx' || ext === 'xls' || mimeType?.includes('spreadsheet')) {
            try {
                const buffer = Buffer.from(content, 'base64');
                const XLSX = require('@e965/xlsx');
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                // Two views of the same data: a CSV blob (what the model sees;
                // matches the legacy xlsxBufferToCsv format byte-for-byte) and
                // a structured `sheets[]` payload that the chat UI's
                // FilePreviewModal renders as a real HTML table. Cap rows
                // per sheet so a 100k-row workbook doesn't bloat the upload
                // response — the model still gets the full CSV in `content`.
                const PREVIEW_ROWS_PER_SHEET = 1000;
                const csvChunks = [];
                const sheetsStructured = [];
                for (const sheetName of workbook.SheetNames) {
                    const ws = workbook.Sheets[sheetName];
                    const csv = XLSX.utils.sheet_to_csv(ws).trim();
                    if (csv) csvChunks.push(`=== Sheet: ${sheetName} ===\n${csv}`);
                    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
                    sheetsStructured.push({
                        name: sheetName,
                        rowCount: aoa.length,
                        truncated: aoa.length > PREVIEW_ROWS_PER_SHEET,
                        rows: aoa.slice(0, PREVIEW_ROWS_PER_SHEET).map(row =>
                            Array.isArray(row) ? row.map(cell => cell == null ? '' : String(cell)) : []
                        ),
                    });
                }
                const textContent = csvChunks.join('\n\n');

                const originalLength = textContent.length;
                const optimized = sanitizeForModel(maybeOptimize(textContent));
                const prepared = prepareContent(optimized, originalLength);

                // Save the structured sheets to the attachment store.
                // FilePreviewModal fetches them on demand via
                // /api/attachments/:id/meta so conversations don't carry
                // hundreds of KB of cell data per upload.
                let attachmentId = null;
                try {
                    const ownerId = req.user?.id || req.apiKeyData?.id || 'default';
                    attachmentId = await attachmentStore.save(ownerId, {
                        filename,
                        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        type: 'spreadsheet',
                        // No raw bytes — sheets[] is the only thing the UI
                        // needs and the model already has the CSV content.
                        bytes: null,
                        meta: {
                            sheetCount: sheetsStructured.length,
                            sheets: sheetsStructured,
                        },
                    });
                } catch (storeErr) {
                    console.warn('[Chat Upload] attachmentStore save failed (xlsx):', storeErr.message);
                }

                return res.json({
                    type: 'spreadsheet',
                    filename,
                    content: prepared.content,
                    charCount: prepared.content.length,
                    originalCharCount: originalLength,
                    saved: originalLength - prepared.content.length,
                    sheetCount: sheetsStructured.length,
                    estimatedTokens: prepared.estimatedTokens,
                    requiresChunking: prepared.requiresChunking,
                    totalChunks: prepared.totalChunks,
                    ...(attachmentId ? { attachmentId } : {}),
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

        // Archive uploads: persist to disk and return a short id the
        // model passes to extract_archive. Bytes never transit through
        // tool-call arguments (where base64 routinely gets truncated or
        // mangled by the tokenizer — observed with 15MB 7z files that
        // arrived as 30 bytes of random-looking data on the tool side).
        const ARCHIVE_EXTS = /\.(zip|7z|rar|tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|gz|bz2|xz)$/i;
        if (filename && ARCHIVE_EXTS.test(filename)) {
            try {
                const archiveRootDir = '/tmp/modelserver-archives';
                const userDir = String(req.apiKeyData?.userId || req.user?.id || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_');
                const userArchiveDir = `${archiveRootDir}/${userDir}`;
                await require('fs').promises.mkdir(userArchiveDir, { recursive: true, mode: 0o700 });

                // TTL sweep: delete archive dirs older than 1 hour. Cheap,
                // keeps /tmp from growing without bound.
                try {
                    const entries = await require('fs').promises.readdir(userArchiveDir);
                    const now = Date.now();
                    for (const e of entries) {
                        const p = `${userArchiveDir}/${e}`;
                        const st = await require('fs').promises.stat(p).catch(() => null);
                        if (st && (now - st.mtimeMs) > 60 * 60 * 1000) {
                            await require('fs').promises.rm(p, { recursive: true, force: true }).catch(() => {});
                        }
                    }
                } catch (_) { /* sweep is best-effort */ }

                const archiveId = crypto.randomBytes(16).toString('hex');
                const dir = `${userArchiveDir}/${archiveId}`;
                await require('fs').promises.mkdir(dir, { mode: 0o700 });
                // Strip any directory component from the filename defensively;
                // the extension is the only thing archiveExtractor cares about.
                const safeName = require('path').basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
                const diskPath = `${dir}/${safeName}`;
                const buf = Buffer.from(content, 'base64');
                await require('fs').promises.writeFile(diskPath, buf);

                const marker = `[Archive uploaded: ${safeName} (archiveId=${archiveId}, size=${buf.length} bytes). Call the extract_archive tool with {"archiveId":"${archiveId}"} to list and read its contents.]`;
                return res.json({
                    type: 'archive',
                    filename: safeName,
                    archiveId,
                    archiveSize: buf.length,
                    content: marker,
                    charCount: marker.length,
                    estimatedTokens: Math.ceil(marker.length / 4),
                });
            } catch (archiveErr) {
                console.error('[Chat Upload] archive persist failed:', archiveErr);
                // Fall through to catch-all so the user still gets *something*.
            }
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

// ----- Attachment store endpoints --------------------------------------
// PDFs and structured spreadsheet rows live under
// /models/.modelserver/attachments/<userId>/<aid>/ (see attachmentStore.js).
// FilePreviewModal fetches via these routes when the persisted attachment
// has only an attachmentId, no inline dataUrl/sheets. Ownership is path-
// scoped: a user's bucket is /attachments/<userIdSafe>/, derived from
// auth — there's no cross-user lookup.
app.get('/api/attachments/:id', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }
    const { id } = req.params;
    if (!attachmentStore.isValidId(id)) {
        return res.status(400).json({ error: 'invalid attachment id' });
    }
    const ownerId = req.user?.id || req.apiKeyData?.id || 'default';
    const loaded = await attachmentStore.loadBytes(ownerId, id);
    if (!loaded) {
        return res.status(404).json({ error: 'attachment not found' });
    }
    res.setHeader('Content-Type', loaded.meta.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(loaded.bytes.length));
    // Allow inline rendering (the chat UI reads this as a Blob via fetch).
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (loaded.meta.filename) {
        res.setHeader('Content-Disposition', `inline; filename="${loaded.meta.filename.replace(/"/g, '')}"`);
    }
    res.end(loaded.bytes);
});

app.get('/api/attachments/:id/meta', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }
    const { id } = req.params;
    if (!attachmentStore.isValidId(id)) {
        return res.status(400).json({ error: 'invalid attachment id' });
    }
    const ownerId = req.user?.id || req.apiKeyData?.id || 'default';
    const meta = await attachmentStore.loadMeta(ownerId, id);
    if (!meta) {
        return res.status(404).json({ error: 'attachment not found' });
    }
    res.json(meta);
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

        // Apply thinking mode control — only models that recognise the
        // /no_think control prefix (Qwen3, DeepSeek-R1) get it. Other
        // families would surface it as literal text in the response.
        let userContent = message;
        if (disableThinking && modelSupportsNoThinkPrefix(targetModel)) {
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
                        model: targetModel,
                        messages: messages,
                        temperature: temperature || 0.7,
                        // Always clamped to contextSize - inputTokens to prevent
                        // vLLM's "0 input tokens" VLLMValidationError.
                        max_tokens: responseReserve,
                        stop: DEFAULT_STOP_STRINGS
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
            model: targetModel,
            messages: messages,
            temperature: temperature || 0.7,
            // Always clamped to contextSize - inputTokens to prevent vLLM's
            // "0 input tokens" VLLMValidationError when the caller sends a
            // raw max_tokens value equal to contextSize.
            max_tokens: responseReserve,
            stop: DEFAULT_STOP_STRINGS
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

        // Register the streaming job IMMEDIATELY so refresh / conversation
        // switch-back can see that work is in flight. Prep work (memory
        // compression, chunking prep, file parsing) can take many seconds and
        // the map-reduce path never reaches the old registration site at all,
        // so without this the UI shows an empty bubble during those phases.
        // The job's `phase` field is updated at each transition below.
        const userId = req.user?.id || req.apiKeyData?.id || 'default';
        const streamingConversationId = conversationId || req.body.conversationId;
        const streamStartTime = Date.now();
        const streamAbortController = new AbortController();
        if (streamingConversationId) {
            // Seed with a "Processing request" entry so a reconnecting client
            // starts from a rolling-credits feed with at least one line, not
            // a bare spinner — matches what a stay-connected client sees
            // immediately after hitting send.
            const seedEvent = {
                id: `evt-${streamStartTime}-0`,
                at: streamStartTime,
                status: 'active',
                icon: 'edit',
                text: 'Processing request',
                kind: 'setup',
            };
            activeStreamingJobs.set(streamingConversationId, {
                userId,
                content: '',
                reasoning: '',
                startTime: streamStartTime,
                model: targetModel,
                clientConnected: true,
                phase: 'preparing',
                // Server-side mirror of the rolling-credits processing log
                // entries the client would otherwise only see via SSE. On
                // refresh / switch-back the client replays these so the
                // reconnected bubble shows the same rich feed (chunking,
                // map progress, synthesis) instead of a single stub line.
                events: [seedEvent],
                abortController: streamAbortController
            });
        }
        const updateJobPhase = (phase, extra) => {
            if (!streamingConversationId) return;
            const job = activeStreamingJobs.get(streamingConversationId);
            if (!job) return;
            job.phase = phase;
            if (extra) Object.assign(job, extra);
        };
        const pushJobEvent = (entry) => {
            if (!streamingConversationId) return;
            const job = activeStreamingJobs.get(streamingConversationId);
            if (!job) return;
            if (!Array.isArray(job.events)) job.events = [];
            job.events.push({
                id: `evt-${Date.now()}-${job.events.length}`,
                at: Date.now(),
                status: 'active',
                ...entry,
            });
            // Keep the log bounded — the UI only ever displays the last
            // ~5 anyway, but a runaway chunking operation could otherwise
            // let this grow unbounded for the lifetime of the job.
            if (job.events.length > 100) job.events.splice(0, job.events.length - 100);
        };
        const clearStreamingJob = () => {
            if (streamingConversationId) {
                activeStreamingJobs.delete(streamingConversationId);
            }
        };
        // Broadcast to the Process Logs tab so chat activity shows up in
        // real time alongside model / download logs. The completion log
        // already exists below; this covers the start and prep phases.
        const logChatActivity = (message, level = 'info') => {
            try {
                broadcast({ type: 'log', message: `[Chat] ${message}`, level });
            } catch (e) { /* broadcast is best-effort */ }
        };
        logChatActivity(`Request received for ${targetModel}${streamingConversationId ? ` (conv ${streamingConversationId.substring(0, 8)})` : ''}`);

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

            // Apply thinking mode control to the last user message if
            // disableThinking is enabled AND the model actually recognises
            // /no_think (Qwen3 / DeepSeek-R1). Other models echo it.
            if (disableThinking && modelSupportsNoThinkPrefix(targetModel)) {
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
            if (disableThinking && modelSupportsNoThinkPrefix(targetModel)) {
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

        // Inject per-conversation memories before counting tokens. We score
        // memories against the latest user message, pack the top matches
        // into a small token budget, and prepend them as a system message.
        // Anything injected here is part of the normal token accounting —
        // it flows through AIMem compression and the chunking gate just
        // like any other system context, so injection can't blow up the
        // context budget.
        let pendingMemoryNotice = null;
        try {
            const chatUserId = req.user?.id || req.apiKeyData?.id || 'default';
            const chatConvId = conversationId || req.body.conversationId;
            if (chatConvId && /^[a-zA-Z0-9_-]+$/.test(chatConvId)) {
                // Find latest user message text for scoring
                let latestUserText = '';
                for (let i = chatMessages.length - 1; i >= 0; i--) {
                    if (chatMessages[i].role === 'user') {
                        const c = chatMessages[i].content;
                        latestUserText = typeof c === 'string'
                            ? c
                            : (Array.isArray(c) ? (c.find(p => p.type === 'text')?.text || '') : '');
                        break;
                    }
                }
                if (latestUserText) {
                    const memoryResult = await retrieveRelevantMemories(
                        chatUserId, chatConvId, latestUserText, MEMORY_RETRIEVAL_TOKEN_BUDGET
                    );
                    if (memoryResult && memoryResult.block) {
                        const memoryBlock = memoryResult.block;
                        // Append to existing system message if one exists,
                        // otherwise insert a new system message at position 0.
                        if (chatMessages.length > 0 && chatMessages[0].role === 'system') {
                            const existing = chatMessages[0].content;
                            if (typeof existing === 'string') {
                                chatMessages[0] = {
                                    ...chatMessages[0],
                                    content: `${existing}\n\n${memoryBlock}`,
                                };
                            }
                        } else {
                            chatMessages.unshift({ role: 'system', content: memoryBlock });
                        }
                        // Defer the SSE notice — at this point the response
                        // is still in pre-stream mode (headers not yet set).
                        // Stash the payload and emit it once SSE setup runs
                        // below.
                        pendingMemoryNotice = {
                            type: 'memory_injected',
                            count: memoryResult.count,
                            tokens: memoryResult.tokens,
                            previews: memoryResult.previews,
                        };
                    }
                }
            }
        } catch (memErr) {
            console.warn(`[Memory] Retrieval failed (continuing without): ${memErr.message}`);
        }

        // Inject runtime context (today's date + tool-use guidance) into
        // the leading system message. Local models with older training
        // cutoffs otherwise refuse queries that reference recent dates,
        // and without this nudge they reach for find_patterns / get_timestamp
        // instead of web_search on "current news" style prompts.
        try {
            const prelude = buildChatRuntimePrelude();
            if (chatMessages.length > 0 && chatMessages[0].role === 'system') {
                const existing = chatMessages[0].content;
                if (typeof existing === 'string') {
                    chatMessages[0] = {
                        ...chatMessages[0],
                        content: `${prelude}\n\n${existing}`,
                    };
                }
            } else {
                chatMessages.unshift({ role: 'system', content: prelude });
            }
        } catch (preludeErr) {
            console.warn(`[Chat] Runtime prelude injection failed: ${preludeErr.message}`);
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
        // Normal trigger: 6+ non-system messages and input exceeds 60% of context
        // Early trigger: 3+ messages when input exceeds 80% of context (e.g. bulk file uploads
        // that fill most of the context — without early compression, context shifting would
        // drop the file-heavy messages entirely, leaving follow-ups with no file data)
        const compressMemory = targetInstance.config?.compressMemory || false;
        const aimemThreshold = Math.floor(availableContextForInput * 0.6);
        const aimemCriticalThreshold = Math.floor(availableContextForInput * 0.8);
        const nonSystemCount = chatMessages.filter(m => m.role !== 'system').length;
        const minMessages = totalInputTokens > aimemCriticalThreshold ? 3 : 6;
        let aimemApplied = false;
        let aimemStats = null;

        if (aimemEnabled && memoryCompressorService && compressMemory && nonSystemCount >= minMessages && totalInputTokens > aimemThreshold) {
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

                console.log(`[AIMem] Attempting compression: ${nonSystemCount} non-system messages (min: ${minMessages}), ${totalInputTokens} tokens (threshold: ${aimemThreshold}${minMessages < 6 ? ', early trigger: >80% context' : ''})`);

                // When few messages but high context usage (bulk file uploads), keep fewer
                // recent messages uncompressed so the file-heavy message gets compressed
                // instead of being skipped entirely then dropped by context shifting
                const keepRecent = nonSystemCount <= 4 ? Math.max(1, nonSystemCount - 2) : 4;
                const compressResult = await memoryCompressorService.compressConversation(
                    chatMessages, currentQuery, availableContextForInput,
                    { keepRecentCount: keepRecent, dedupThreshold: 0.45 }
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

        // Refine totalInputTokens with an exact /tokenize count. The char-based
        // estimator above uses ~3.3 effective chars/token, which works for
        // prose but undercounts dense content (unicode, code, base64) by 2x+
        // and lets messages past the chunking gate that then get rejected by
        // the backend with "request exceeds context size". /tokenize is cheap
        // (one POST) and authoritative for exactly this model's tokenizer.
        try {
            const concatenatedText = chatMessages.map(m => {
                if (typeof m.content === 'string') return m.content;
                if (Array.isArray(m.content)) {
                    return m.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
                }
                return '';
            }).join('\n');
            if (concatenatedText.length > 0) {
                const exactCount = await getExactTokenCount(targetHost, targetPort, concatenatedText);
                if (exactCount !== null && exactCount > 0) {
                    // Chat templates add per-message turn markers (role, separators).
                    // Budget ~8 tokens per message as a conservative overhead.
                    const templateOverhead = chatMessages.length * 8;
                    // Array-format messages count ~1000 tokens per image_url part.
                    let imageOverhead = 0;
                    for (const m of chatMessages) {
                        if (Array.isArray(m.content)) {
                            imageOverhead += m.content.filter(p => p.type === 'image_url').length * 1000;
                        }
                    }
                    const refinedTotal = exactCount + templateOverhead + imageOverhead;
                    if (Math.abs(refinedTotal - totalInputTokens) > 50) {
                        console.log(`[Chat Stream] Token count refined via /tokenize: estimate=${totalInputTokens} → exact=${refinedTotal} (raw=${exactCount}, template=${templateOverhead}, images=${imageOverhead})`);
                    }
                    totalInputTokens = refinedTotal;
                }
            }
        } catch (e) {
            console.warn(`[Chat Stream] /tokenize refinement failed: ${e.message} — using estimate ${totalInputTokens}`);
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
                        // Code content still goes through map-reduce — we just
                        // skip the CONDENSATION step inside it, because that's
                        // the part that drops whole sentences by relevance and
                        // mangles the payload. Raw overlapping chunks are fine
                        // for code; sentence-level relevance scoring is not.
                        const contentIsCode = looksLikeCode(textContent);
                        if (contentIsCode) {
                            console.log(`[Chat Stream] Content looks like code (${contentTokens} tokens) — map-reduce will run, condensation will be skipped`);
                            broadcast({
                                type: 'log',
                                level: 'info',
                                message: `Content looks like code (${contentTokens} tokens > ${availableForContent} available). Map-reduce enabled, condensation skipped.`
                            });
                        }

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

                            // Apply content condensation if enabled, but NEVER on
                            // code content — condenseContent scores "sentences"
                            // by TF-IDF relevance to the query and drops ~60% of
                            // them. On code that shatters the payload (dropped
                            // declarations, missing function bodies) and the
                            // prepended "[Note: condensed ... N% reduction]"
                            // header leaks into the model's context where it
                            // reads it as evidence the user's input was cut.
                            let finalContent = contentPart;
                            let condensationInfo = null;

                            if (CHUNKING_CONFIG.enableCondensation && !contentIsCode) {
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
                        clearStreamingJob();
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
                        clearStreamingJob();
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
                    clearStreamingJob();
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

        // Flush any deferred pre-stream notices now that SSE is live.
        if (pendingMemoryNotice) {
            try { res.write(`data: ${JSON.stringify(pendingMemoryNotice)}\n\n`); } catch {}
            pendingMemoryNotice = null;
        }
        if (req.socket) req.socket.setTimeout(0);

        // SSE keepalive: emit a comment line every 25s for as long as the
        // response is open. Slow reasoning models can spend several minutes
        // on first-token latency, during which the server sends no data.
        // Clients with their own data-activity timeouts (Koda CLI's 5-min
        // ACTIVITY_TIMEOUT, browsers/proxies/LBs that drop idle SSE
        // connections) would otherwise kill the socket while the server is
        // legitimately working. SSE comment lines start with ':' and are
        // ignored by EventSource parsers, but they still count as bytes on
        // the wire, resetting any inactivity timer.
        const heartbeatInterval = setInterval(() => {
            try {
                if (!res.writableEnded) res.write(': heartbeat\n\n');
            } catch (e) { /* socket closing */ }
        }, 25000);
        const stopHeartbeat = () => {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        };
        res.on('close', stopHeartbeat);
        res.on('finish', stopHeartbeat);

        // =====================================================================
        // MAP-REDUCE PROCESSING PATH
        // =====================================================================
        // If content exceeds context window and map-reduce is enabled,
        // process chunks in parallel and synthesize the response
        if (useMapReduce && mapReduceContent && mapReduceQuery) {
            console.log(`[Chat Stream] Starting map-reduce processing...`);
            updateJobPhase('chunking');
            logChatActivity(`Map-reduce started: ${estimateTokens(mapReduceContent).toLocaleString()} tokens`);

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
            // Mirror the 'starting' entry to the server-side event log so
            // a reconnected client sees the same opening line as a client
            // that stayed connected.
            {
                let startMsg = `Preparing ${mapReduceTokens.toLocaleString()} tokens for parallel processing...`;
                if (mapReduceCondensationInfo) {
                    startMsg += ` (condensed ${mapReduceCondensationInfo.reductionPercent}%)`;
                }
                pushJobEvent({ icon: 'layers', text: startMsg, kind: 'chunk_start' });
            }

            // Build the context messages to forward to map-reduce:
            //   - ALL system messages
            //   - Recent user/assistant turns EXCLUDING the large message
            //     we're chunking (it's in mapReduceContent already)
            //
            // Without this, follow-up questions in a multi-turn
            // conversation lose all prior context the moment chunking
            // triggers — the user sees "the context is lost".
            //
            // Budget prior turns to ~15% of the context window so the
            // chunks still have room to work. Walk the message list
            // newest-first and include turns until we hit the budget.
            const lastUserIdx = chatMessages.map(m => m.role).lastIndexOf('user');
            const priorBudgetTokens = Math.max(0, Math.floor(contextSize * 0.15));
            const systemMsgs = chatMessages.filter(m => m.role === 'system');
            const nonSystemMsgs = chatMessages
                .map((m, idx) => ({ m, idx }))
                .filter(({ m, idx }) => m.role !== 'system' && idx !== lastUserIdx);

            const priorTurns = [];
            let priorTokensUsed = 0;
            for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
                const { m } = nonSystemMsgs[i];
                const msgTokens = estimateTokens(m.content);
                if (priorTokensUsed + msgTokens > priorBudgetTokens && priorTurns.length > 0) break;
                priorTurns.unshift(m);
                priorTokensUsed += msgTokens;
                if (priorTokensUsed >= priorBudgetTokens) break;
            }

            const priorMsgs = [...systemMsgs, ...priorTurns];
            if (priorTurns.length > 0) {
                console.log(`[Chat Stream] Map-reduce: forwarding ${priorTurns.length} prior turns (${priorTokensUsed} tokens) + ${systemMsgs.length} system message(s)`);
            }

            try {
                const mapReduceResult = await processWithMapReduce({
                    targetHost,
                    targetPort,
                    model: targetModel,
                    largeContent: mapReduceContent,
                    originalQuery: mapReduceQuery,
                    priorMessages: priorMsgs,
                    contextSize,
                    temperature: temperature || 0.7,
                    topP: effectiveTopP,
                    maxTokens: responseReserve,
                    onProgress: (progress) => {
                        // Mirror progress into the persisted job so a reconnected
                        // client (refresh / switch-back) can show the current
                        // map-reduce phase without the SSE stream.
                        const phaseMap = {
                            chunking: 'chunking',
                            map: 'mapping',
                            reduce: 'synthesizing',
                            complete: 'generating',
                        };
                        updateJobPhase(phaseMap[progress.phase] || 'mapping', { progress });

                        // Mirror to the server-side event log so the
                        // reconnected client's ProcessingLogFeed matches
                        // exactly what a continuously-connected client
                        // would have seen. The message text duplicates
                        // the client-side formatting in ChatContainer.jsx.
                        const {
                            phase: pPhase,
                            totalChunks = 0,
                            totalTokens = 0,
                            completedChunks = 0,
                            failedChunks = 0,
                            elapsedMs = 0,
                            retrying,
                            chunkTokens,
                        } = progress;
                        const elapsed = elapsedMs > 0 ? `${Math.round(elapsedMs / 1000)}s` : '';
                        const tokenStr = totalTokens ? `${totalTokens.toLocaleString()} tokens` : '';
                        const chunkWord = (n) => n === 1 ? 'chunk' : 'chunks';
                        if (pPhase === 'chunking') {
                            let msg = `Splitting into ${totalChunks} ${chunkWord(totalChunks)}`;
                            if (tokenStr) msg += ` — ${tokenStr}`;
                            if (chunkTokens) msg += ` (~${chunkTokens.toLocaleString()} tokens/chunk)`;
                            pushJobEvent({ icon: 'scissors', text: msg, kind: 'chunk_split' });
                            logChatActivity(msg);
                        } else if (pPhase === 'map') {
                            const done = completedChunks + failedChunks;
                            const pct = totalChunks > 0 ? Math.round((done / totalChunks) * 100) : 0;
                            let msg;
                            if (retrying) {
                                msg = `Retrying chunk ${retrying.chunk}/${totalChunks} (attempt ${retrying.attempt}/${retrying.maxRetries}) — ${elapsed}`;
                            } else if (done === 0) {
                                msg = `Analyzing ${totalChunks} ${chunkWord(totalChunks)} in parallel`;
                                if (tokenStr) msg += ` — ${tokenStr} total`;
                            } else {
                                msg = `Analyzed ${completedChunks}/${totalChunks} ${chunkWord(totalChunks)} (${pct}%)`;
                                if (failedChunks) msg += ` — ${failedChunks} failed`;
                                if (elapsed) msg += ` — ${elapsed}`;
                            }
                            pushJobEvent({ icon: 'cpu', text: msg, kind: 'chunk_map' });
                        } else if (pPhase === 'reduce') {
                            let msg = `Synthesizing ${completedChunks} ${chunkWord(completedChunks)} into final response`;
                            if (elapsed) msg += ` — ${elapsed} elapsed`;
                            pushJobEvent({ icon: 'combine', text: msg, kind: 'chunk_reduce' });
                            logChatActivity(msg);
                        } else if (pPhase === 'complete') {
                            const msg = `Streaming synthesized response${elapsed ? ` — completed in ${elapsed}` : ''}`;
                            pushJobEvent({ icon: 'sparkles', text: msg, kind: 'chunk_complete' });
                        }

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
                    updateJobPhase('generating');
                    // Stream the synthesized response token by token for consistent UX
                    const words = mapReduceResult.response.split(/(\s+)/);
                    let fullResponse = '';

                    for (const word of words) {
                        fullResponse += word;
                        // Mirror streamed content into the job so a reconnected
                        // client can pick up the synthesized response mid-flow.
                        updateJobPhase('generating', { content: fullResponse });
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

                    // If the client disconnected mid-stream, persist the full
                    // synthesized response to the conversation so switching
                    // back shows the completed answer instead of a stub.
                    const jobAtEnd = streamingConversationId ? activeStreamingJobs.get(streamingConversationId) : null;
                    if (streamingConversationId && jobAtEnd && !jobAtEnd.clientConnected && fullResponse) {
                        try {
                            const conversationMsgs = await loadConversationMessages(userId, streamingConversationId);
                            conversationMsgs.push({
                                id: crypto.randomUUID(),
                                role: 'assistant',
                                content: fullResponse,
                                timestamp: new Date().toISOString(),
                                responseTime: Date.now() - streamStartTime,
                                backgroundCompleted: true,
                            });
                            await saveConversationMessages(userId, streamingConversationId, conversationMsgs);
                            console.log(`[Chat Stream] Map-reduce background response saved to conversation ${streamingConversationId}`);
                        } catch (saveErr) {
                            console.error(`[Chat Stream] Failed to save map-reduce background response:`, saveErr);
                        }
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
                    try { res.write(`data: ${JSON.stringify(finalEvent)}\n\n`); } catch (e) {}
                    try { res.write(`data: [DONE]\n\n`); } catch (e) {}
                    try { res.end(); } catch (e) {}
                    clearStreamingJob();

                    console.log(`[Chat Stream] Map-reduce complete: ${mapReduceResult.chunkCount} chunks, synthesized=${mapReduceResult.synthesized}`);
                    return;
                } else {
                    // Map-reduce failed, return error
                    const errorEvent = {
                        error: mapReduceResult.error || 'Map-reduce processing failed',
                        done: true
                    };
                    try { res.write(`data: ${JSON.stringify(errorEvent)}\n\n`); } catch (e) {}
                    try { res.end(); } catch (e) {}
                    clearStreamingJob();
                    return;
                }
            } catch (mapReduceError) {
                console.error('[Chat Stream] Map-reduce error:', mapReduceError);
                const errorEvent = {
                    error: `Map-reduce processing failed: ${mapReduceError.message}`,
                    done: true
                };
                try { res.write(`data: ${JSON.stringify(errorEvent)}\n\n`); } catch (e) {}
                try { res.end(); } catch (e) {}
                clearStreamingJob();
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
        // NORMAL STREAMING PATH (with automatic continuation + native tools)
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

        // --- Native tool calling -------------------------------------------
        // Build the tool catalog once per user turn. Subsequent tool-call
        // rounds within this turn reuse the same catalog.
        const chatTools = require('./services/chatTools');
        // conversationId is plumbed through so per-conv workspace scoping
        // (see sandboxRunner.ensureWorkspace) buckets all skills fired in
        // this turn under `workspaces/<userId>/conv-<id>/`.
        // latestUserText is the last user message extracted to plain text;
        // tools (e.g. base64_decode) can salvage from it when the model
        // invokes them with empty/unusable args.
        let latestUserText = '';
        for (let i = chatMessages.length - 1; i >= 0; i--) {
            if (chatMessages[i].role === 'user') {
                const c = chatMessages[i].content;
                if (typeof c === 'string') latestUserText = c;
                else if (Array.isArray(c)) {
                    latestUserText = c.filter(p => p?.type === 'text' && typeof p.text === 'string')
                        .map(p => p.text).join('\n');
                }
                break;
            }
        }
        const toolCtx = {
            userId: req.userId,
            conversationId: conversationId || null,
            latestUserText,
        };
        let toolCatalog = [];
        try {
            toolCatalog = await chatTools.buildToolCatalog(toolCtx);
        } catch (e) {
            console.warn('[Chat Stream] tool catalog build failed:', e.message);
        }
        // Accumulator is reset at the start of every model turn (outer loop).
        let accumulatedToolCalls = [];
        let toolCallRound = 0;
        // Fingerprint + result-hash history across rounds. Used to detect
        // the model calling the same tool with the same args repeatedly
        // and getting the same (usually empty) result — a pathological
        // loop we short-circuit with a nudge instead of burning iterations.
        // Cleared per user turn, not per conversation.
        const toolCallHistory = []; // { fp: 'name:args', resultHash: string }

        // --- Auto-invoke base64_decode on input ---------------------------
        // Models inconsistently pick base64_decode out of a 70+ tool catalog
        // and often guess the decoded value inline. Detect base64 in the
        // latest user message server-side, run the skill, and prepend the
        // decoded values to the user message as a clearly-marked server
        // note so the model answers against ground truth.
        //
        // Earlier attempts injected a synthetic assistant+tool_calls+tool
        // triplet into the message list. That serialized in the chat
        // template as tool-call markers, which some models (gemma4,
        // gpt-oss-style templates on llama.cpp) then echoed as visible
        // content — users saw garbled `<|tool_call|>…<|channel|>…` strings
        // instead of answers. Plain-text injection avoids the template
        // tokenization path entirely. The UI still gets tool_executing +
        // tool_result SSE events for transparency; they're purely
        // frontend-visible and never touch the model's prompt.
        //
        // Skipped silently when base64_decode isn't in the catalog (user
        // disabled it) or no base64 in the message decodes to
        // mostly-printable UTF-8.
        const base64Detector = require('./services/base64Detector');
        const b64PreflightEncoded = new Set();
        const b64CatalogExposed = toolCatalog.some(t => t?.function?.name === 'base64_decode');
        if (b64CatalogExposed) {
            try {
                let userText = '';
                let userMsgIdx = -1;
                for (let i = chatMessages.length - 1; i >= 0; i--) {
                    if (chatMessages[i].role === 'user') {
                        userText = base64Detector.extractTextFromContent(chatMessages[i].content);
                        userMsgIdx = i;
                        break;
                    }
                }
                const found = userMsgIdx >= 0 ? base64Detector.findBase64InText(userText) : [];
                if (found.length > 0) {
                    const callId = `call_auto_b64_in_${Date.now()}`;
                    const result = {
                        success: true,
                        mode: found.length === 1 ? 'single' : 'scan',
                        count: found.length,
                        results: found,
                        note: `Auto-decoded ${found.length} base64 string(s) detected in user message`,
                    };
                    // UI-only events. Compact arguments (just the count)
                    // so a multi-KB user paste doesn't ship to the frontend
                    // twice.
                    if (clientConnected) {
                        try {
                            res.write(`data: ${JSON.stringify({
                                type: 'tool_executing',
                                tool_call_id: callId,
                                name: 'base64_decode',
                                arguments: JSON.stringify({ candidates: found.length }),
                            })}\n\n`);
                            res.write(`data: ${JSON.stringify({
                                type: 'tool_result',
                                tool_call_id: callId,
                                name: 'base64_decode',
                                preview: JSON.stringify(result).slice(0, 240),
                                result,
                            })}\n\n`);
                        } catch (_) { clientConnected = false; }
                    }
                    // Build a compact decoded-values note. Truncate
                    // individual decoded strings so one huge payload can't
                    // blow the context; the full decoded text is available
                    // in the UI panel via the tool_result event.
                    const MAX_NOTE_DECODED_CHARS = 4000;
                    const bullets = [];
                    let remaining = MAX_NOTE_DECODED_CHARS;
                    for (const f of found) {
                        const encShort = f.encoded.length > 60
                            ? f.encoded.slice(0, 60) + '…'
                            : f.encoded;
                        const perBullet = Math.max(120, Math.min(f.decoded.length, remaining));
                        const decShort = f.decoded.length > perBullet
                            ? f.decoded.slice(0, perBullet) + '…[truncated]'
                            : f.decoded;
                        const layerSuffix = f.layers > 1 ? ` (${f.layers} nested layers)` : '';
                        bullets.push(`- "${encShort}"${layerSuffix} → ${JSON.stringify(decShort)}`);
                        remaining -= decShort.length;
                        if (remaining <= 0) break;
                    }
                    const note = [
                        '[SERVER NOTE: The server auto-decoded base64 strings found in this message. Use these decoded values directly; do not attempt to decode them yourself.]',
                        ...bullets,
                        '',
                    ].join('\n');
                    // Prepend the note to the user message's text content.
                    // Handles both plain-string and vision-array formats.
                    const msg = chatMessages[userMsgIdx];
                    if (typeof msg.content === 'string') {
                        msg.content = `${note}\n${msg.content}`;
                    } else if (Array.isArray(msg.content)) {
                        const textIdx = msg.content.findIndex(p => p?.type === 'text');
                        if (textIdx >= 0) {
                            msg.content[textIdx].text = `${note}\n${msg.content[textIdx].text || ''}`;
                        } else {
                            msg.content.unshift({ type: 'text', text: note });
                        }
                    }
                    for (const f of found) b64PreflightEncoded.add(f.encoded);
                    // Keep base64_decode in the catalog — if a blob slipped
                    // past the detector (split across lines, odd framing)
                    // or the nested peeler bottomed out before fully
                    // unwrapping, the model can still invoke the skill.
                    logChatActivity(`Auto-invoked base64_decode on input (${found.length} candidate(s))`);
                }
            } catch (e) {
                console.warn('[Chat Stream] base64 pre-flight failed:', e.message);
            }
        }

        // Job was registered at the top of the handler so refresh / switch-back
        // can see prep-phase work. Update the existing record with the live
        // inputMessages snapshot and flip phase to 'waiting' (model about to
        // receive the first request).
        updateJobPhase('waiting', { inputMessages });
        pushJobEvent({
            icon: 'brain',
            text: `Sending request to ${targetModel}`,
            kind: 'waiting',
        });

        // Reasoning-loop guard — per-request state. Once a loop is detected
        // and aborted, we stay in the aborted state for the rest of the turn.
        let reasoningLoopAborted = false;
        const reasoningLoopDetector = makeReasoningLoopDetector();

        // Helper: stream one request to the model and return the finish_reason.
        // roundContentStart / roundReasoningStart let the loop detector measure
        // "progress within this round" instead of cumulative fullResponse
        // growth (which would read as "progress" on round 2 of a tool-using
        // turn even if round 2 itself is the one stuck looping).
        const streamOneRequest = (requestMessages, maxTokens, options = {}) => {
            const roundContentStart = options.roundContentStart ?? fullResponse.length;
            const roundReasoningStart = options.roundReasoningStart ?? fullReasoning.length;
            return new Promise(async (resolve, reject) => {
                let lastFinishReason = 'stop';

                try {
                    const requestBody = {
                        model: targetModel,
                        messages: requestMessages,
                        temperature: temperature || 0.7,
                        top_p: effectiveTopP,
                        stream: true,
                        max_tokens: maxTokens,
                        stop: DEFAULT_STOP_STRINGS,
                        // Native tool calling — only attach `tools` when the
                        // catalog has something. Empty arrays confuse some
                        // backends; omitting the key is the safer default.
                        ...(toolCatalog.length ? { tools: toolCatalog } : {}),
                    };

                    const response = await axios({
                        method: 'post',
                        url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
                        data: requestBody,
                        responseType: 'stream',
                        signal: streamAbortController.signal
                    });

                    // Persistent buffer across chunks — TCP packet boundaries do not
                    // align with SSE line boundaries. Without buffering, a frame split
                    // across two 'data' events causes JSON.parse to fail silently and
                    // the content tokens inside it to be dropped. StringDecoder also
                    // holds partial multi-byte UTF-8 sequences until the next chunk.
                    const sseDecoder = new StringDecoder('utf8');
                    let sseBuffer = '';
                    response.data.on('data', (chunk) => {
                        try {
                            sseBuffer += sseDecoder.write(chunk);
                            const lines = sseBuffer.split('\n');
                            sseBuffer = lines.pop() || ''; // keep incomplete tail for next chunk

                            for (const rawLine of lines) {
                                const line = rawLine.trim();
                                if (!line) continue;
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
                                            // Scrub Harmony control tokens that some templates
                                            // leak as literal text when the model de-rails.
                                            const content = scrubHarmonyTokens(delta.content || '');
                                            const reasoning = scrubHarmonyTokens(delta.reasoning_content || delta.reasoning || '');

                                            // Native tool calling — model streams tool_calls as
                                            // delta fragments; accumulate by index across chunks.
                                            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
                                                chatTools.accumulateToolCallDelta(accumulatedToolCalls, delta.tool_calls);
                                                if (clientConnected) {
                                                    try {
                                                        res.write(`data: ${JSON.stringify({
                                                            type: 'tool_call_delta',
                                                            tool_calls: delta.tool_calls,
                                                        })}\n\n`);
                                                    } catch (_) { clientConnected = false; }
                                                }
                                            }

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

                                                // Reasoning-loop guard. Only triggers when this round
                                                // has produced NO content and NO tool calls — a valid
                                                // turn that happens to have long reasoning sprinkled
                                                // with actual output won't be killed.
                                                if (!reasoningLoopAborted) {
                                                    const roundContentLen = fullResponse.length - roundContentStart;
                                                    const noProgress = roundContentLen === 0 && accumulatedToolCalls.length === 0;
                                                    if (noProgress) {
                                                        const reason = reasoningLoopDetector(fullReasoning.slice(roundReasoningStart));
                                                        if (reason) {
                                                            reasoningLoopAborted = true;
                                                            const note = `\n\n_[The model got stuck in a reasoning loop — ${reason}. Stream was stopped before burning the completion budget. Try rephrasing the request, breaking it into smaller steps, or using a different model.]_`;
                                                            fullResponse += note;
                                                            console.warn(`[Chat Stream] Reasoning loop detected — ${reason}; aborting stream`);
                                                            if (clientConnected) {
                                                                try {
                                                                    res.write(`data: ${JSON.stringify({
                                                                        choices: [{ delta: { content: note }, index: 0 }]
                                                                    })}\n\n`);
                                                                } catch (_) { clientConnected = false; }
                                                            }
                                                            if (streamingConversationId) {
                                                                const job = activeStreamingJobs.get(streamingConversationId);
                                                                if (job) job.content = fullResponse;
                                                            }
                                                            streamAbortController.abort();
                                                        }
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
                        // Flush any residual bytes held by StringDecoder (partial
                        // multi-byte UTF-8) and process any trailing buffered line
                        // that didn't end with '\n'.
                        sseBuffer += sseDecoder.end();
                        const trailing = sseBuffer.trim();
                        sseBuffer = '';
                        if (trailing && trailing.startsWith('data: ')) {
                            const data = trailing.slice(6);
                            if (data && data !== '[DONE]') {
                                try {
                                    const parsed = JSON.parse(data);
                                    if (parsed.choices && parsed.choices[0]?.finish_reason) {
                                        lastFinishReason = parsed.choices[0].finish_reason;
                                    }
                                    const delta = parsed.choices?.[0]?.delta;
                                    if (delta) {
                                        const content = scrubHarmonyTokens(delta.content || '');
                                        const reasoning = scrubHarmonyTokens(delta.reasoning_content || delta.reasoning || '');
                                        if (content) fullResponse += content;
                                        if (reasoning) fullReasoning += reasoning;
                                        if ((content || reasoning) && clientConnected) {
                                            try {
                                                res.write(`data: ${JSON.stringify({
                                                    token: content || undefined,
                                                    choices: [{
                                                        delta: {
                                                            content: content || undefined,
                                                            reasoning: reasoning || undefined
                                                        },
                                                        index: 0
                                                    }]
                                                })}\n\n`);
                                            } catch (writeErr) { clientConnected = false; }
                                        }
                                    }
                                } catch (e) { /* ignore trailing parse errors */ }
                            }
                        }
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
            updateJobPhase('generating');
            pushJobEvent({
                icon: 'sparkles',
                text: 'Generating response',
                kind: 'generating',
            });
            logChatActivity(`Generating response (context: ${contextSize}, input: ${totalInputTokens} tokens, reserve: ${responseReserve})`);

            // Native-tool-calling outer loop. Each iteration:
            //   1. stream the model's next turn (may auto-continue on length)
            //   2. if it ended with tool_calls, execute them and loop with the
            //      tool results appended to the conversation
            //   3. otherwise, break
            let currentMessages = chatMessages;
            let finishReason = 'stop';
            // Don't gate this loop on clientConnected — when the user
            // refreshes the page or switches conversations, the request
            // closes and clientConnected flips false, but the streaming
            // job is registered in activeStreamingJobs and the response
            // must keep being generated in the background. Every
            // res.write inside the loop already self-guards, so writes
            // to a dead socket are safe.
            while (toolCallRound <= chatTools.MAX_TOOL_ITERATIONS) {
                // Reset per-round state. fullResponse is cumulative for the
                // client stream; roundStart marks where THIS turn's text began
                // so we can feed only this turn's content back as the assistant
                // message when re-prompting after tool execution.
                accumulatedToolCalls = [];
                const roundStart = fullResponse.length;

                // Recompute the per-round max_tokens budget from the *current*
                // message list. initialMaxTokens was sized for the first
                // round's input; after a chain of tool calls, currentMessages
                // grows by up to TOOL_RESULT_CHAR_CAP per round (plus the
                // assistant turn's content). Without this recomputation,
                // currentInputTokens + initialMaxTokens eventually overshoots
                // contextSize and llama.cpp rejects with HTTP 400.
                const roundInputTokens = currentMessages.reduce(
                    (sum, m) => sum + estimateTokens(m.content), 0
                );
                const roundMaxTokens = Math.max(
                    512,
                    Math.min(initialMaxTokens, contextSize - roundInputTokens - 200)
                );

                finishReason = await streamOneRequest(currentMessages, roundMaxTokens);

                // Auto-continuation loop: if model hit length limit, keep going.
                // Skipped when tool calls are accumulated — the slim continuation
                // request below drops the partial tool_calls context entirely
                // (only system + truncated user + responseTail + "Continue"),
                // which corrupts state when the cap was hit mid-arguments.
                // Length-with-pending-tools is handled by the dispatch block
                // below: the truncation guard in chatTools.executeToolCall
                // surfaces a clean retry hint to the model on the next round.
                // Background-streaming: do NOT gate on clientConnected.
                // The user may have refreshed or switched conversations
                // mid-response; we still need to finish generating so
                // the saved message contains the full continuation
                // chain rather than the truncated first chunk.
                while (finishReason === 'length'
                       && continuationCount < MAX_AUTO_CONTINUATIONS
                       && accumulatedToolCalls.length === 0) {
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

                // --- Tool-call dispatch (native) ---------------------------
                // If the model's turn ended with tool_calls, execute each
                // tool, append the assistant+tool messages to the conversation,
                // and loop back to let the model continue with tool results.
                //
                // Also dispatch when finish_reason is 'length' and tool calls
                // accumulated — the cap was hit mid-arguments JSON, so the
                // last tool call is truncated. The truncation guard in
                // chatTools.executeToolCall returns a clean retry hint for
                // the damaged call; any other calls in the same turn that
                // closed cleanly run normally. Without this, the partial
                // tool_calls would silently be discarded when the outer
                // loop breaks at the bottom.
                if (accumulatedToolCalls.length
                    && (finishReason === 'tool_calls' || finishReason === 'length')) {
                    const finalizedCalls = chatTools.finalizeToolCalls(accumulatedToolCalls);
                    if (!finalizedCalls.length) break; // no valid calls — bail

                    logChatActivity(`Tool-call round ${toolCallRound + 1}: ${finalizedCalls.length} call(s)`);
                    // Pre-resolve the sandbox policy for each tool call so the
                    // UI can label every chip. For skills this mirrors
                    // executePythonSkill's wantSandbox logic; for static native
                    // tools (web_search, fetch_url, chart_plot, ...) it's
                    // always false because those are hand-coded JS in-process.
                    const allSkillsForPolicy = await loadSkills().catch(() => []);
                    const skillByName = new Map(allSkillsForPolicy.map(s => [s.name, s]));
                    const toolPolicy = (toolName) => {
                        // Native handlers take precedence: if a tool is
                        // registered in chatTools.toolRegistry, executeToolCall
                        // dispatches to the in-process JS handler and never
                        // touches the Python skill record — even when a
                        // matching default-skill stub exists (e.g. fetch_url,
                        // web_search, playwright_fetch all ship comment-only
                        // Python stubs purely for catalog/system-prompt
                        // purposes). Label by what actually executes.
                        if (chatTools.toolRegistry?.has(toolName)) {
                            return { sandboxed: false, source: 'native' };
                        }
                        const s = skillByName.get(toolName);
                        if (!s) {
                            return { sandboxed: false, source: 'native' };
                        }
                        const wantSandbox = typeof s.sandbox === 'boolean'
                            ? s.sandbox
                            : !!s.userId;
                        return {
                            sandboxed: !!wantSandbox,
                            source: 'skill',
                            workspace: !!s.workspace,
                            network: s.network || 'none',
                        };
                    };
                    const toolResultMessages = [];
                    for (const call of finalizedCalls) {
                        const policy = toolPolicy(call.function.name);
                        if (clientConnected) {
                            try {
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_executing',
                                    tool_call_id: call.id,
                                    name: call.function.name,
                                    arguments: call.function.arguments,
                                    sandboxed: policy.sandboxed,
                                    source: policy.source,
                                    ...(policy.source === 'skill' ? { network: policy.network, workspace: policy.workspace } : {}),
                                })}\n\n`);
                            } catch (_) { clientConnected = false; }
                        }
                        // Loop-detection short-circuit. If the model is
                        // calling the same (name, args) that already
                        // produced an identical result in this turn, the
                        // odds of a different outcome on a third try are
                        // ~zero and we've seen the model burn all 10
                        // iterations on "find_patterns count:0" spins.
                        // Intercept, return a nudge, and let the model
                        // pick a different tool next round.
                        const fp = `${call.function.name}:${call.function.arguments || ''}`;
                        const priorHits = toolCallHistory.filter(h => h.fp === fp);
                        let resultMsg;
                        if (priorHits.length >= 2 &&
                            priorHits[priorHits.length - 1].resultHash === priorHits[priorHits.length - 2].resultHash) {
                            const nudge = {
                                error: 'loop_detected',
                                message: `You have called ${call.function.name} with the same arguments ${priorHits.length} times this turn and received an identical result each time. Stop calling this tool with these arguments. If you need external/current information, call web_search or fetch_url. Otherwise, write a direct answer from what you already have and end your turn.`,
                                previous_call_count: priorHits.length,
                            };
                            resultMsg = {
                                tool_call_id: call.id,
                                role: 'tool',
                                name: call.function.name,
                                content: JSON.stringify(nudge),
                            };
                            console.warn(`[Chat Stream] Loop detected for ${call.function.name}; short-circuited with nudge after ${priorHits.length} identical calls`);
                        } else {
                            resultMsg = await chatTools.executeToolCall(call, toolCtx);
                        }
                        // Per-tool-result size cap. Without this a single
                        // archive extraction or large file read can dump
                        // hundreds of KB of text into currentMessages, which
                        // then re-ships to the backend on the next round and
                        // overflows the model's context (observed: 243k tokens
                        // vs 131k context after a tar.gz upload). 24k chars ≈
                        // 8k tokens — generous enough for normal tool output,
                        // tight enough that 5+ rounds still fit. The model can
                        // always re-call the tool with a narrower scope (a
                        // specific archive entry, a single line range) if the
                        // truncated tail mattered.
                        const TOOL_RESULT_CHAR_CAP = 24_000;
                        if (typeof resultMsg.content === 'string' && resultMsg.content.length > TOOL_RESULT_CHAR_CAP) {
                            const original = resultMsg.content.length;
                            resultMsg = {
                                ...resultMsg,
                                content: resultMsg.content.slice(0, TOOL_RESULT_CHAR_CAP) +
                                    `\n\n[Tool result truncated by server: ${original} -> ${TOOL_RESULT_CHAR_CAP} chars. ` +
                                    `If you need more, re-call ${call.function.name} with a narrower scope ` +
                                    `(e.g. a specific entry path, a smaller line range, an entryPath / startLine+endLine arg).]`,
                            };
                            console.warn(`[Chat Stream] Capped ${call.function.name} result: ${original} -> ${TOOL_RESULT_CHAR_CAP} chars`);
                        }
                        // Record fingerprint + result hash for future loop checks.
                        try {
                            const rh = crypto.createHash('sha1')
                                .update(String(resultMsg.content || ''))
                                .digest('hex')
                                .slice(0, 16);
                            toolCallHistory.push({ fp, resultHash: rh });
                            // Cap history so a long session doesn't grow unbounded.
                            if (toolCallHistory.length > 40) toolCallHistory.shift();
                        } catch (_) { /* ignore hash failures */ }
                        toolResultMessages.push(resultMsg);
                        if (clientConnected) {
                            try {
                                const preview = String(resultMsg.content || '').slice(0, 240);
                                // Parse the tool's JSON result once so the client
                                // can render structured data (search sources,
                                // URL snippets) — not just a truncated preview.
                                // Safely no-op if the tool returned a non-JSON
                                // string (rare; load_skill returns JSON, web_search
                                // and fetch_url return JSON, etc.).
                                let parsedResult = null;
                                if (resultMsg.content && typeof resultMsg.content === 'string') {
                                    try { parsedResult = JSON.parse(resultMsg.content); } catch { /* non-JSON */ }
                                }
                                // Guard: don't ship a huge result down the SSE
                                // stream. 32 KB is generous for search results
                                // (5 hits × a few KB each) but much smaller than
                                // typical skill bodies.
                                const RESULT_SIZE_CAP = 32 * 1024;
                                const resultPayload = parsedResult && Buffer.byteLength(resultMsg.content) < RESULT_SIZE_CAP
                                    ? parsedResult
                                    : undefined;
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_result',
                                    tool_call_id: call.id,
                                    name: call.function.name,
                                    preview,
                                    sandboxed: policy.sandboxed,
                                    source: policy.source,
                                    ...(policy.source === 'skill' ? { network: policy.network } : {}),
                                    ...(resultPayload !== undefined ? { result: resultPayload } : {}),
                                })}\n\n`);
                            } catch (_) { clientConnected = false; }
                        }
                    }

                    // Build the next round's message list. The assistant
                    // message must carry ONLY this turn's generated content
                    // (not the cumulative stream) alongside its tool_calls.
                    const turnContent = fullResponse.slice(roundStart);
                    // Sanitize tool_calls arguments before re-shipping. When
                    // the model hit its output cap mid-arguments (handled
                    // above by the truncation guard in executeToolCall),
                    // the call's `arguments` string is incomplete JSON.
                    // Some backends (vLLM in particular) return 500 when
                    // they re-parse an assistant turn whose tool_calls
                    // carry malformed JSON — which surfaces in the chat UI
                    // as "Request failed with status code 500" / response
                    // cut off. Replace any unparseable args with '{}'; the
                    // matching tool result already conveys the truncation
                    // error to the model so context isn't lost.
                    const safeToolCalls = finalizedCalls.map(tc => {
                        const a = tc?.function?.arguments;
                        if (typeof a !== 'string') return tc;
                        try { JSON.parse(a); return tc; }
                        catch (_) {
                            return {
                                ...tc,
                                function: { ...tc.function, arguments: '{}' },
                            };
                        }
                    });
                    currentMessages = [
                        ...currentMessages,
                        {
                            role: 'assistant',
                            content: turnContent || null,
                            tool_calls: safeToolCalls,
                        },
                        ...toolResultMessages,
                    ];
                    toolCallRound++;
                    continuationCount = 0; // fresh length budget for next turn
                    continue;
                }

                // Normal end — no tool calls. Exit outer loop.
                break;
            } // end tool-call outer loop

            // Forced synthesis triggers in two distinct situations:
            //
            // 1. We hit MAX_TOOL_ITERATIONS with the model still asking for
            //    tool calls. Historic trigger — model wants more tools but
            //    we cut it off; need to force it to write text now.
            //
            // 2. The model exited the tool loop before the cap but with
            //    EMPTY fullResponse. Observed on gemma-4 after 5 real tool
            //    calls, where round 6 emits `finish_reason=tool_calls`
            //    with malformed/empty args (accumulator drops them) or
            //    `finish_reason=stop` with zero content. Outer loop breaks,
            //    user sees tool chips run and then nothing — no summary,
            //    no answer. Re-run with tools suppressed so the model has
            //    to write text from the tool results already in context.
            //
            // Skip forced synthesis when reasoningLoopAborted is set —
            // fullResponse already carries the "loop detected" note that
            // the user needs to see, and forcing another round would
            // likely re-enter the same loop.
            const hitIterationCap = toolCallRound > chatTools.MAX_TOOL_ITERATIONS
                && (finishReason === 'tool_calls'
                    || (finishReason === 'length' && accumulatedToolCalls.length > 0));
            const exitedEmptyAfterTools = toolCallRound > 0 && !fullResponse.trim() && !reasoningLoopAborted;
            if (hitIterationCap || exitedEmptyAfterTools) {
                if (hitIterationCap) {
                    console.warn(`[Chat Stream] Max tool iterations (${chatTools.MAX_TOOL_ITERATIONS}) reached — forcing synthesis`);
                } else {
                    console.warn(`[Chat Stream] Tool loop exited with empty response after ${toolCallRound} tool call(s) — forcing synthesis`);
                }
                if (clientConnected) {
                    try {
                        if (clientConnected) {
                            try {
                                res.write(`data: ${JSON.stringify({
                                    type: 'status',
                                    message: 'Tool call budget exhausted — synthesizing from collected results',
                                })}\n\n`);
                            } catch (_) { clientConnected = false; }
                        }
                        const synthesisMessages = [
                            ...currentMessages,
                            {
                                role: 'user',
                                content: hitIterationCap
                                    ? 'You have reached the maximum number of tool calls allowed for this turn. ' +
                                      'Synthesize your final answer now from the tool results already in this conversation — ' +
                                      'do not request any more tools. If some information is missing, state that clearly ' +
                                      'and summarize what you did find.'
                                    : 'You have called several tools and now must write your actual answer. ' +
                                      'Do not call any more tools. Respond directly to the original question using the ' +
                                      'tool results already in this conversation. If you need more information to be ' +
                                      'fully confident, state that clearly and summarize what you did find — but you ' +
                                      'must write an answer now.',
                            },
                        ];
                        // Suppress the tools catalog for this last round so
                        // the backend can't re-offer function calls. The
                        // closure captures toolCatalog by reference; mutating
                        // it in place is enough for the next streamOneRequest.
                        const savedCatalog = toolCatalog.slice();
                        toolCatalog.length = 0;
                        try {
                            // Same per-round budget recomputation as the main
                            // tool loop — synthesisMessages is currentMessages
                            // plus a forcing user note, so its size has drifted
                            // from initialMaxTokens' assumptions.
                            const synthInputTokens = synthesisMessages.reduce(
                                (sum, m) => sum + estimateTokens(m.content), 0
                            );
                            const synthMaxTokens = Math.max(
                                512,
                                Math.min(initialMaxTokens, contextSize - synthInputTokens - 200)
                            );
                            await streamOneRequest(synthesisMessages, synthMaxTokens);
                        } finally {
                            toolCatalog.length = 0;
                            toolCatalog.push(...savedCatalog);
                        }
                    } catch (synthErr) {
                        console.warn('[Chat Stream] Forced synthesis failed:', synthErr.message);
                    }
                }
            }

            // --- Misrouted-reasoning fix ------------------------------
            // Some llama.cpp chat templates (observed on Gemma-4 family)
            // route the entire response to delta.reasoning_content when
            // the model emits a `[{"thought": "..."}]` JSON preamble.
            // Result: persisted message has content="" and reasoning=
            // <the full answer>. UI shows the whole thing inside the
            // Thinking dropdown and never renders the main bubble.
            //
            // Detect the preamble signature, strip it, and move the
            // remainder into content. Emit a `reasoning_reclassified`
            // SSE event so the streaming client can swap its local
            // state before finalizing the message (otherwise the in-
            // session bubble stays stuck in the Thinking panel).
            if (!fullResponse.trim() && fullReasoning) {
                const THOUGHT_PREFIX = /^\s*\[\s*(?:\{\s*"thought"\s*:\s*"[^"]*"\s*\}\s*,?\s*)+\]\s*/;
                const match = fullReasoning.match(THOUGHT_PREFIX);
                if (match) {
                    const remainder = fullReasoning.slice(match[0].length);
                    if (remainder.trim()) {
                        console.log(`[Chat Stream] Misrouted content detected: ${remainder.length} chars in reasoning → moving to content`);
                        fullResponse = remainder;
                        fullReasoning = '';
                        if (streamingConversationId) {
                            const job = activeStreamingJobs.get(streamingConversationId);
                            if (job) {
                                job.content = fullResponse;
                                job.reasoning = '';
                            }
                        }
                        if (clientConnected) {
                            try {
                                res.write(`data: ${JSON.stringify({
                                    type: 'reasoning_reclassified',
                                    content: remainder,
                                })}\n\n`);
                            } catch (_) { clientConnected = false; }
                        }
                    }
                }
            }

            // --- Auto-invoke base64_decode on output ------------------
            // If the model's final response contains base64 the
            // pre-flight didn't already cover (e.g. the model quoted
            // an encoded blob and offered a hallucinated "decoding"),
            // run the skill against the response and push a
            // tool_result SSE event so the UI surfaces the real
            // decoded values. The response text itself is left as the
            // model wrote it — the tool_result sits alongside as a
            // trustworthy ground-truth panel.
            if (fullResponse && b64CatalogExposed) {
                try {
                    const found = base64Detector
                        .findBase64InText(fullResponse)
                        .filter(f => !b64PreflightEncoded.has(f.encoded));
                    if (found.length > 0) {
                        const call = {
                            id: `call_auto_b64_out_${Date.now()}`,
                            type: 'function',
                            function: {
                                name: 'base64_decode',
                                arguments: JSON.stringify({ text: fullResponse }),
                            },
                        };
                        const result = {
                            success: true,
                            mode: found.length === 1 ? 'single' : 'scan',
                            count: found.length,
                            results: found,
                            note: `Auto-decoded ${found.length} base64 string(s) found in response`,
                            source: 'response',
                        };
                        if (clientConnected) {
                            try {
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_executing',
                                    tool_call_id: call.id,
                                    name: 'base64_decode',
                                    arguments: call.function.arguments,
                                })}\n\n`);
                                res.write(`data: ${JSON.stringify({
                                    type: 'tool_result',
                                    tool_call_id: call.id,
                                    name: 'base64_decode',
                                    preview: JSON.stringify(result).slice(0, 240),
                                    result,
                                })}\n\n`);
                            } catch (_) { clientConnected = false; }
                        }
                        logChatActivity(`Auto-invoked base64_decode on response (${found.length} candidate(s))`);
                    }
                } catch (e) {
                    console.warn('[Chat Stream] base64 post-flight failed:', e.message);
                }
            }
        } catch (streamError) {
            const isAborted = streamAbortController.signal.aborted || streamError.name === 'AbortError' || streamError.code === 'ERR_CANCELED';
            if (isAborted) {
                console.log(`[Chat Stream] Stream aborted by user for conversation ${streamingConversationId}`);
            } else {
                console.error('Stream error:', streamError);
                if (clientConnected && !res.writableEnded) {
                    // Translate DNS failures for the model hostname into an
                    // actionable message. axios/dockerode raises EAI_AGAIN or
                    // ENOTFOUND when the container is gone from the Docker
                    // network — usually because it crashed or was OOM-killed
                    // between requests. The raw getaddrinfo error is confusing
                    // in the chat UI; tell the user what actually happened.
                    const rawCode = streamError.code || streamError.cause?.code;
                    const isDnsFailure = rawCode === 'EAI_AGAIN' || rawCode === 'ENOTFOUND';
                    const isRefused = rawCode === 'ECONNREFUSED' || rawCode === 'ECONNRESET';
                    let friendly = streamError.message;
                    if (isDnsFailure || isRefused) {
                        const inst = targetInstance;
                        const status = inst?.status;
                        friendly = status === 'oom_killed'
                            ? `Model container was killed by the OOM killer. Reload the model with a smaller context size (current: ${inst?.config?.contextSize ?? 'unknown'}) and try again.`
                            : `Model container is not reachable (${rawCode}). It likely crashed or was stopped — reload it from the Running Instances panel and retry.`;
                    }
                    const errorEvent = { error: friendly, done: true };
                    try {
                        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                    } catch (writeErr) { /* client disconnected */ }
                }
            }
        }

        // Save the completed assistant response to disk on every successful
        // stream, regardless of whether the client is still connected.
        //
        // The old guard (!clientConnected) trusted the client to POST its
        // own save once it received [DONE]. In practice, if the user
        // refreshed the tab or switched conversations in the ~100 ms
        // window between [DONE] arriving and the fire-and-forget save POST
        // landing, the save was aborted by the page unload and the whole
        // response was lost. By saving server-side too we turn this into
        // a belt-and-suspenders: disk is up-to-date before the client even
        // sees [DONE], and the client's subsequent POST overwrites with
        // the same array — idempotent, no duplicate assistant turn.
        //
        // Aborted streams still skip; the DELETE /streaming cancel
        // endpoint handles partial-response persistence for those.
        const wasAborted = streamAbortController.signal.aborted;
        // User-cancelled aborts skip this save — DELETE /streaming handles
        // persistence for those. Reasoning-loop aborts DO save, because
        // fullResponse already contains the "loop detected" note that the
        // user needs to see persisted (otherwise the chat reloads as an
        // empty assistant bubble with no explanation).
        if ((!wasAborted || reasoningLoopAborted) && streamingConversationId && fullResponse) {
            try {
                const conversationMsgs = await loadConversationMessages(userId, streamingConversationId);
                // Only append if the last message isn't already this
                // assistant turn (guards against a racing client-save
                // having landed first with a slightly different id).
                const last = conversationMsgs[conversationMsgs.length - 1];
                const alreadyPresent = last && last.role === 'assistant' &&
                    typeof last.content === 'string' &&
                    last.content.length >= fullResponse.length - 2 &&
                    last.content.slice(0, 200) === fullResponse.slice(0, 200);
                if (!alreadyPresent) {
                    const assistantMessage = {
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: fullResponse,
                        reasoning: fullReasoning || undefined,
                        timestamp: new Date().toISOString(),
                        responseTime: Date.now() - streamStartTime,
                        tokenCount: completionTokens,
                        backgroundCompleted: !clientConnected
                    };
                    conversationMsgs.push(assistantMessage);
                    await saveConversationMessages(userId, streamingConversationId, conversationMsgs);
                    console.log(`[Chat Stream] Response saved to ${streamingConversationId} (clientConnected=${clientConnected})`);
                }
            } catch (saveErr) {
                console.error(`[Chat Stream] Failed to save response:`, saveErr);
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
                ...(toolCallRound > 0 && {
                    toolCalls: {
                        rounds: toolCallRound,
                        maxReached: toolCallRound > chatTools.MAX_TOOL_ITERATIONS,
                    },
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

        // If we registered a streaming job before the failure, clear it so
        // reconnecting clients don't see a ghost "in-progress" response.
        // streamingConversationId is scoped to the try block above, so pull
        // it from req.body directly here.
        const failedConvId = req.body.conversationId;
        if (failedConvId) {
            activeStreamingJobs.delete(failedConvId);
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
            model: targetModel,
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

    if (!isValidModelName(modelName)) {
        return res.status(400).json({ error: 'Invalid model name' });
    }

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
app.get('/api/apps', requireAdmin, async (req, res) => {

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
app.post('/api/apps/:name/start', requireAdmin, async (req, res) => {

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
app.post('/api/apps/:name/stop', requireAdmin, async (req, res) => {

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
app.post('/api/apps/:name/restart', requireAdmin, async (req, res) => {

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
app.post('/api/backend/active', requireAdmin, async (req, res) => {

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

app.post('/api/system/reset', requireAdmin, async (req, res) => {

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

// Known default skills that touch the filesystem — these get opted into the
// workspace sandbox automatically. Non-exhaustive; skills not on this list
// keep their current behavior (in-process for built-ins, per-policy for
// user-created). Centralized here so it's easy to extend.
const WORKSPACE_SANDBOX_DEFAULTS = new Set([
    // file ops
    'create_file', 'update_file', 'read_file', 'delete_file',
    'create_directory', 'delete_directory', 'list_directory',
    'move_file', 'copy_file', 'append_to_file',
    'tail_file', 'head_file', 'search_files', 'search_replace_file',
    'diff_files', 'grep_code', 'outline_file', 'replace_lines',
    // archives
    'create_archive', 'extract_archive',
    // pdf / docs generation + reading
    'create_pdf', 'html_to_pdf', 'markdown_to_html',
    'read_pdf', 'pdf_page_count', 'pdf_to_images',
]);

// NETWORK-requiring default skills. These get sandboxed with an allowlist
// so the model can still use them. Each entry declares the egress hostnames
// the skill actually needs — everything else is blocked by the egress proxy.
const NETWORK_SANDBOX_DEFAULTS = {
    download_file:   { allowlist: ['*'], note: 'arbitrary URL download; tighten if policy allows' },
    fetch_url:       { allowlist: ['*'], note: 'user-supplied URLs' },
    http_request:    { allowlist: ['*'], note: 'user-supplied URLs' },
    web_search:      { allowlist: ['duckduckgo.com', 'html.duckduckgo.com', 'www.bing.com'] },
    playwright_fetch: { allowlist: ['*'], note: 'user-supplied URLs; browser renders' },
    dns_lookup:      { allowlist: [] }, // doesn't use HTTP proxy; noop
};

/** Walk existing skills and opt-in known defaults to sandbox + workspace /
 *  allowlisted-network. Idempotent — safe to run at every boot. Never
 *  clobbers a skill that already has sandbox/workspace explicitly set. */
async function migrateDefaultSkillsToSandbox() {
    try {
        const skills = await loadSkills();
        let dirty = 0;
        for (const s of skills) {
            if (!s || !s.name) continue;
            // User-created skills (have a userId) are left alone — their
            // default is already sandbox=true per executePythonSkill's policy.
            if (s.userId) continue;
            let changed = false;

            if (WORKSPACE_SANDBOX_DEFAULTS.has(s.name)) {
                if (s.sandbox !== true)   { s.sandbox = true;   changed = true; }
                if (s.workspace !== true) { s.workspace = true; changed = true; }
                if (!s.network) { s.network = 'none'; changed = true; }
            } else if (NETWORK_SANDBOX_DEFAULTS[s.name]) {
                const spec = NETWORK_SANDBOX_DEFAULTS[s.name];
                if (s.sandbox !== true) { s.sandbox = true; changed = true; }
                if (!s.network)   { s.network = 'allowlist'; changed = true; }
                if (!s.allowlist) { s.allowlist = spec.allowlist; changed = true; }
            }
            if (changed) dirty++;
        }
        if (dirty) {
            await saveSkills(skills);
            console.log(`[skill-migration] flagged ${dirty} default skill(s) for sandbox/workspace`);
        }
    } catch (e) {
        console.error('[skill-migration] failed (non-fatal):', e.message);
    }
}

// Sync new default skills into an existing install. `initializeDefaultSkills`
// short-circuits when skills.json is non-empty (the seed has already run at
// least once), so new entries in default-skills.json would otherwise never
// reach existing users. This compares on-disk skills by name against the
// current default-skills.json template and appends anything missing —
// idempotent, safe to run every boot. Does NOT modify or delete existing
// skills, only adds new ones.
async function addMissingDefaultSkills() {
    try {
        const defaultSkillsPath = path.join(__dirname, 'default-skills.json');
        const template = JSON.parse(await fs.readFile(defaultSkillsPath, 'utf8'));
        const skills = await loadSkills();
        const existingNames = new Set(
            skills.filter(s => !s.userId).map(s => s.name)
        );
        const missing = template.filter(t => t && t.name && !existingNames.has(t.name));
        if (!missing.length) return;
        const stamped = missing.map(skill => {
            const out = {
                id: crypto.randomBytes(16).toString('hex'),
                ...skill,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            // Honor sandbox/workspace/network flags declared on the template,
            // then layer the global WORKSPACE_/NETWORK_SANDBOX_DEFAULTS maps
            // so older defaults still get the right policy.
            if (WORKSPACE_SANDBOX_DEFAULTS.has(out.name)) {
                out.sandbox = true;
                out.workspace = true;
                out.network = out.network || 'none';
            } else if (NETWORK_SANDBOX_DEFAULTS[out.name]) {
                const spec = NETWORK_SANDBOX_DEFAULTS[out.name];
                out.sandbox = true;
                out.network = out.network || 'allowlist';
                out.allowlist = out.allowlist || spec.allowlist;
            }
            return out;
        });
        const merged = [...skills, ...stamped];
        await saveSkills(merged);
        console.log(`[skill-migration] added ${stamped.length} missing default skill(s): ${stamped.map(s => s.name).join(', ')}`);
    } catch (e) {
        console.error('[skill-migration] addMissingDefaultSkills failed (non-fatal):', e.message);
    }
}

// Force-refresh the code (and a few sibling fields) of named built-in skills
// from the current template, even if a skill with the same name already
// exists on disk. Used to ship correctness/security fixes to skills the
// user already has installed — addMissingDefaultSkills only ADDs missing
// entries, so without this the patched code never reaches existing users.
//
// Only refreshes built-in skills (no userId). User-created skills with the
// same name are left alone. Idempotent — safe to run every boot.
const REFRESH_STALE_SKILLS = new Set([
    // calculate — added BitXor/BitAnd/BitOr/LShift/RShift/Invert support and
    // hex/bin/char output for integer results. Older installs have the
    // pre-bitwise code on disk and would still fail on `0xf1 ^ 0xff`.
    'calculate',
    // base64_decode — widened the accepted parameter alias list from
    // text/encodedData/data to also include input/string/value/content/
    // payload/b64/encoded. Without this refresh, existing installs keep
    // the narrow list and the model still fails when it guesses an
    // unsupported parameter name (e.g. 'input').
    'base64_decode',
    // Disk-read skills — extended the "file not found" message to
    // point the model at inline === FILE N === blocks when an upload
    // was the actual source. Without this refresh, the model wastes
    // turns calling search_files / list_directory after the first
    // miss instead of reading the inline content already in context.
    'read_file',
    'read_email_file',
    'get_file_metadata',
    'hash_file',
    'tail_file',
    'head_file',
]);

async function refreshStaleDefaultSkills() {
    try {
        const defaultSkillsPath = path.join(__dirname, 'default-skills.json');
        const template = JSON.parse(await fs.readFile(defaultSkillsPath, 'utf8'));
        const templateByName = new Map(template.map(t => [t.name, t]));
        const skills = await loadSkills();
        let dirty = 0;
        for (const s of skills) {
            if (!s || !s.name || s.userId) continue;
            if (!REFRESH_STALE_SKILLS.has(s.name)) continue;
            const t = templateByName.get(s.name);
            if (!t || !t.code) continue;
            if (s.code === t.code) continue;
            s.code = t.code;
            if (t.description) s.description = t.description;
            if (t.systemPrompt) s.systemPrompt = t.systemPrompt;
            if (t.parameters) s.parameters = t.parameters;
            s.updatedAt = new Date().toISOString();
            dirty++;
        }
        if (dirty) {
            await saveSkills(skills);
            console.log(`[skill-migration] refreshed ${dirty} stale built-in skill(s) from template: ${[...REFRESH_STALE_SKILLS].join(', ')}`);
        }
    } catch (e) {
        console.error('[skill-migration] refreshStaleDefaultSkills failed (non-fatal):', e.message);
    }
}

async function initializeDefaultSkills() {
    try {
        await ensureDataDir();
        const skills = await loadSkills();

        // Existing install — opt in known defaults to sandbox/workspace,
        // sync any new defaults from the template, and refresh code for
        // built-ins on the stale list. Harmless no-op when fully migrated.
        // Runs BEFORE the early-return so all migrations reach older installs.
        if (skills.length > 0) {
            await migrateDefaultSkillsToSandbox();
            await addMissingDefaultSkills();
            await refreshStaleDefaultSkills();
            return;
        }

        console.log('Initializing default Python skills...');

        // Load default skills from JSON file
        const defaultSkillsPath = path.join(__dirname, 'default-skills.json');
        const defaultSkillsJson = await fs.readFile(defaultSkillsPath, 'utf8');
        const defaultSkillsTemplate = JSON.parse(defaultSkillsJson);

        // Add IDs, timestamps, AND sandbox/workspace flags for known
        // file-op / network-requiring default skills. Same logic as the
        // migration, applied up-front on first install.
        const defaultSkills = defaultSkillsTemplate.map(skill => {
            const out = {
                id: crypto.randomBytes(16).toString('hex'),
                ...skill,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            if (WORKSPACE_SANDBOX_DEFAULTS.has(out.name)) {
                out.sandbox = true;
                out.workspace = true;
                out.network = out.network || 'none';
            } else if (NETWORK_SANDBOX_DEFAULTS[out.name]) {
                const spec = NETWORK_SANDBOX_DEFAULTS[out.name];
                out.sandbox = true;
                out.network = out.network || 'allowlist';
                out.allowlist = out.allowlist || spec.allowlist;
            }
            return out;
        });

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

        // Excel/XLSX format — parsed via @e965/xlsx (maintained SheetJS
        // fork with the proto-pollution + ReDoS patches).
        if (['xlsx', 'xls', 'xlsm'].includes(format)) {
            try {
                const XLSX = require('@e965/xlsx');
                const workbook = XLSX.readFile(filePath);
                const sheets = {};
                const allText = [];
                for (const sheetName of workbook.SheetNames) {
                    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                    sheets[sheetName] = csv;
                    allText.push(\`=== Sheet: \${sheetName} ===\\n\${csv}\`);
                }
                return { success: true, format, sheets, text: allText.join('\\n\\n'), sheetCount: workbook.SheetNames.length };
            } catch (e) {
                throw new Error(\`Failed to parse Excel file: \${e.message}\`);
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
            {
                id: crypto.randomBytes(16).toString('hex'),
                name: 'extract_archive',
                description: 'Extract an archive (.zip, .7z, .rar, .tar, .tar.gz/.tgz, .tar.bz2, .tar.xz, .gz, .bz2, .xz) from base64 bytes; returns entry list and inline text for small UTF-8 files.',
                type: 'function',
                parameters: { base64Data: 'string', filename: 'string' },
                // "Runs " prefix routes this skill to executeLegacySkill
                // instead of executePythonSkill (see the dispatcher at
                // ~line 6386). Actual work lives in the 'extract_archive'
                // switch case there, backed by services/archiveExtractor.js.
                code: 'Runs natively via executeLegacySkill — see archiveExtractor.js',
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
                description: 'Apply a regex to TEXT YOU PROVIDE in the `text` parameter and return the matches. LOCAL operation only — does not search the web, news, files, or any external source. If you need information from the internet, call web_search or fetch_url first, then pass the returned text to this tool.',
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
                name: 'search_string',
                description: 'Search for a string or regex inside provided text or a file and return matching lines with context. Use after fetch_url / web_search to pinpoint specific data (names, numbers, dates, error codes, IPs) without re-reading the whole page. Provide either `text` or `file` (path under /tmp, /models, or /app).',
                type: 'tool',
                parameters: { query: 'string', text: 'string', file: 'string', mode: 'string', case_sensitive: 'boolean', context_lines: 'number', max_matches: 'number' },
                code: `async function execute(params) {
    const fs = require('fs').promises;
    const path = require('path');
    if (!params.query) throw new Error('query is required');
    const hasText = typeof params.text === 'string' && params.text.length > 0;
    const hasFile = typeof params.file === 'string' && params.file.length > 0;
    if (hasText === hasFile) throw new Error('Provide exactly one of text or file');
    const mode = params.mode === 'regex' ? 'regex' : 'literal';
    const caseSensitive = params.case_sensitive === true;
    const contextLines = Math.min(10, Math.max(0, parseInt(params.context_lines ?? 2, 10)));
    const maxMatches = Math.min(500, Math.max(1, parseInt(params.max_matches ?? 50, 10)));

    let content, sourceLabel;
    if (hasFile) {
        const filePath = path.resolve(String(params.file));
        const allowed = ['/tmp/', '/models/', '/app/'];
        if (!allowed.some(r => filePath === r.slice(0, -1) || filePath.startsWith(r))) {
            throw new Error('file path must be under /tmp, /models, or /app');
        }
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('not a regular file');
        if (stat.size > 20 * 1024 * 1024) throw new Error('file too large; cap is 20MB');
        content = await fs.readFile(filePath, 'utf8');
        sourceLabel = filePath;
    } else {
        content = String(params.text);
        sourceLabel = 'text';
    }

    const escaped = mode === 'regex' ? params.query : String(params.query).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');

    const lines = content.split(/\\r?\\n/);
    const matches = [];
    let totalMatches = 0;
    for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        totalMatches++;
        if (matches.length >= maxMatches) continue;
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
            line_number: i + 1,
            line: lines[i].length > 500 ? lines[i].slice(0, 500) + '…' : lines[i],
            ...(contextLines > 0 ? { context_before: lines.slice(start, i), context_after: lines.slice(i + 1, end + 1) } : {}),
        });
    }
    return {
        success: true,
        source: sourceLabel,
        query: params.query,
        mode,
        case_sensitive: caseSensitive,
        total_lines: lines.length,
        total_matches: totalMatches,
        returned_matches: matches.length,
        truncated: totalMatches > matches.length,
        matches,
    };
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

/**
 * Resolve the base URL embedded in the CLI install scripts. Prefers an
 * operator-configured PUBLIC_BASE_URL over the request's Host header — a
 * crafted Host: would otherwise let an attacker (or any virtual-host
 * misroute) point freshly-installed CLIs at an arbitrary URL.
 *
 * Falls back to req protocol + sanitized Host when no env var is set, which
 * is the legacy behavior for self-hosted single-tenant deployments.
 */
function resolveInstallBaseUrl(req) {
    const configured = process.env.PUBLIC_BASE_URL || process.env.KODA_API_URL;
    if (configured && /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/.*)?$/.test(configured)) {
        return configured.replace(/\/+$/, '');
    }
    const host = sanitizeHost(req.get('host'));
    const protocol = (req.protocol === 'http' || req.protocol === 'https') ? req.protocol : 'https';
    return `${protocol}://${host}`;
}

// Bash installer (Linux/macOS/WSL/Git Bash)
app.get('/api/cli/install', apiRateLimiter, (req, res) => {
    const scriptPath = path.join(__dirname, 'scripts/install-agents-cli.sh');
    const apiUrl = resolveInstallBaseUrl(req);

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
    const apiUrl = resolveInstallBaseUrl(req);

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

    // Broadcast error to connected clients (visible in Logs tab)
    // Stack traces are logged server-side only — not broadcast to prevent info leakage
    try {
        broadcast({
            type: 'log',
            message: `[Error] ${route}: ${errorDetail}`,
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
// NATIVE TOOL REGISTRATIONS
// ============================================================================
//
// Registered here at the bottom of server.js because the tool `execute`
// closures need in-scope access to helpers defined earlier in the file
// (fetchUrlContent, extractSearchQuery, isPrivateUrl, axios). chatTools
// is a singleton module, so this registration is visible to the chat
// stream handler without further wiring.
(() => {
    const tools = require('./services/chatTools');

    // ----- bot-protection heuristic ---------------------------------------
    // When fetch_url or playwright_fetch come back with a Cloudflare/DataDome
    // interstitial (or a suspiciously thin body) the model has no clean
    // signal that the fetch was challenged rather than genuinely empty —
    // so it gives up. This helper inspects the result and returns an
    // escalation hint the tool payload can carry alongside the content.
    // Callers attach the hint when present; models that read it will
    // retry via scrapling_fetch.
    const CHALLENGE_MARKERS = [
        /checking your browser/i,
        /enable javascript and cookies to continue/i,
        /cf-browser-verification/i,
        /cf-challenge/i,
        /challenge-platform/i,
        /__cf_chl_/i,
        /just a moment\.\.\./i,
        /attention required/i,
        /access denied/i,
        /please verify you are a human/i,
        /ddos protection by cloudflare/i,
        /perimeterx/i,
        /datadome/i,
        /px-captcha/i,
        /h-captcha/i,
        /recaptcha/i,
    ];
    function detectBotChallenge({ title = '', content = '' } = {}) {
        const blob = `${title}\n${content}`.slice(0, 8000);
        const hit = CHALLENGE_MARKERS.find(rx => rx.test(blob));
        if (hit) return `bot protection detected (${hit.source}) — retry with scrapling_fetch for better evasion`;
        const trimmed = typeof content === 'string' ? content.trim() : '';
        if (trimmed.length < 400) {
            return 'response body is very thin — page may be JS-gated or bot-challenged; if unexpected, retry with scrapling_fetch';
        }
        return null;
    }

    // ----- web_search ------------------------------------------------------
    tools.registerTool({
        name: 'web_search',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'web_search',
                    description:
                        'Search the web via DuckDuckGo; returns up to 5 results (title, url, snippet). Snippets are short — almost always follow up with fetch_url on top results. ' +
                        'For single-fact lookups, fetch 1 result; for lists / comparisons / "what\'s new" / multi-aspect questions, fetch 2–3 in parallel in the same round. ' +
                        'Trust the snippets over training when they conflict, and cite URLs in answers. Use search_string on long fetched pages instead of re-reading them.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query.' },
                            limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results (default 5).' },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const rawQuery = String(args?.query || '').trim();
            if (!rawQuery) return { error: 'query is required' };
            const q = extractSearchQuery(rawQuery);
            const limit = Math.min(10, Math.max(1, parseInt(args?.limit || 5, 10)));
            try {
                const resp = await axios.get(
                    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
                    {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Accept-Language': 'en-US,en;q=0.9',
                        },
                        timeout: 8000,
                    },
                );
                const html = resp.data || '';
                if (html.includes('anomaly-modal')) {
                    // DDG hit CAPTCHA — fall back through the same chain
                    // /api/search uses: Scrapling → Brave Search HTML parse.
                    if (scraplingService) {
                        try {
                            const sr = await scraplingService.search(q, limit);
                            if (sr?.success && Array.isArray(sr.results) && sr.results.length) {
                                return {
                                    query: q,
                                    source: 'scrapling',
                                    count: sr.results.length,
                                    results: sr.results.slice(0, limit).map(r => ({
                                        title: r.title || 'No title',
                                        url: r.url,
                                        snippet: r.snippet || '',
                                    })),
                                };
                            }
                        } catch (_) { /* fall through to Brave */ }
                    }
                    try {
                        const braveResp = await axios.get(
                            `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
                            {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                    'Accept-Language': 'en-US,en;q=0.9',
                                },
                                timeout: 10000,
                            },
                        );
                        const bhtml = braveResp.data || '';
                        // Reuse the same Brave parsing /api/search uses.
                        const linkPattern = /<a\s+href="(https?:\/\/(?!(?:search\.)?brave\.com|cdn\.search\.brave\.com|imgs\.search\.brave\.com|tiles\.search\.brave\.com)[^"]+)"[^>]*target="_self"[^>]*class="[^"]*svelte[^"]*"[^>]*>/gi;
                        const titlePattern = /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/gi;
                        const descPattern = /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
                        const bUrls = [];
                        const bTitles = [];
                        const bDescs = [];
                        let lm;
                        while ((lm = linkPattern.exec(bhtml)) !== null) bUrls.push(lm[1]);
                        while ((lm = titlePattern.exec(bhtml)) !== null) bTitles.push(lm[1].trim());
                        while ((lm = descPattern.exec(bhtml)) !== null) bDescs.push(lm[1].replace(/<[^>]*>/g, '').trim());
                        const bSeen = new Set();
                        const bResults = [];
                        for (let i = 0; i < bUrls.length && bResults.length < limit; i++) {
                            const url = bUrls[i];
                            if (bSeen.has(url)) continue;
                            bSeen.add(url);
                            let title = bTitles[i] || '';
                            if (!title) {
                                try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { title = 'Web Result'; }
                            }
                            bResults.push({ title, url, snippet: bDescs[i] || '' });
                        }
                        if (bResults.length) {
                            return { query: q, source: 'brave', count: bResults.length, results: bResults };
                        }
                    } catch (_) { /* fall through to error */ }
                    return { error: 'search rate-limited by DuckDuckGo; Scrapling and Brave fallbacks also failed. Consider calling scrapling_fetch directly on the target domain.', query: q };
                }
                const resultRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
                const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
                const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
                const seen = new Set();
                const results = [];
                let m;
                while ((m = resultRegex.exec(html)) !== null && results.length < limit) {
                    const htmlFrag = m[1];
                    const tm = titleRegex.exec(htmlFrag);
                    if (!tm) continue;
                    const sm = snippetRegex.exec(htmlFrag);
                    const url = decodeURIComponent(tm[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0]);
                    if (!url.startsWith('http') || seen.has(url)) continue;
                    seen.add(url);
                    results.push({
                        title: tm[2].replace(/<[^>]*>/g, '').trim() || 'No title',
                        url,
                        snippet: sm ? sm[1].replace(/<[^>]*>/g, '').trim() : '',
                    });
                }
                return { query: q, count: results.length, results };
            } catch (e) {
                return { error: `search failed: ${e.message}`, query: q };
            }
        },
    });

    // ----- fetch_url -------------------------------------------------------
    tools.registerTool({
        name: 'fetch_url',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'fetch_url',
                    description:
                        'Fetch a URL and return its readable text. Rejects private/internal addresses. Pipeline: Scrapling → Playwright → axios. ' +
                        'Trust the fetched content over training when they conflict, and cite the URL. ' +
                        'If the result includes a `hint` about bot protection or thin content, retry with scrapling_fetch. ' +
                        'For long results (>1000 chars) where the user wants a specific fact, follow up with search_string on the returned text.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute HTTP(S) URL to fetch.' },
                            maxLength: { type: 'integer', minimum: 100, maximum: 100000, description: 'Truncate content to this many chars (default 15000).' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const url = String(args?.url || '').trim();
            if (!url) return { error: 'url is required' };
            { const _block = urlBlockReason(url); if (_block) return { error: _block }; }
            const maxLength = Math.min(100_000, Math.max(100, parseInt(args?.maxLength || 15000, 10)));
            try {
                const result = await fetchUrlContent(url, { timeout: 20_000, maxLength, waitForJS: true });
                if (!result.success) {
                    return { url, success: false, error: result.error || 'fetch failed' };
                }
                const content = (result.content || '').slice(0, maxLength);
                const title = result.title || '';
                const hint = detectBotChallenge({ title, content });
                return {
                    url,
                    success: true,
                    title,
                    source: result.source || 'unknown',
                    content,
                    ...(hint ? { hint } : {}),
                };
            } catch (e) {
                return { url, success: false, error: e.message || String(e) };
            }
        },
    });

    // ----- render_chart ----------------------------------------------------
    // Lets the model emit a structured chart spec that the chat UI renders
    // inline as a real Recharts SVG. The tool itself does no I/O — it just
    // validates the spec and echoes it back inside `chartSpec`. The
    // ToolCallBlock chip in chat/ detects this field and mounts ChartBlock
    // instead of the text preview.
    tools.registerTool({
        name: 'render_chart',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'render_chart',
                    description:
                        'Render an inline chart in the chat UI. Use whenever the user asks to graph, plot, chart, or visualize data — either data they provided in the conversation or data you fetched via fetch_timeseries / fetch_url / web_search. ' +
                        'Pick the chart type from the data shape: line/area for time series, bar for categorical comparisons, pie for parts-of-a-whole (≤8 slices), scatter for correlations. ' +
                        'For multi-series charts, pass each series as `{ name, color? }` in `series[]` and one `{ x, <seriesName>: y, ... }` object per x-value in `data[]`. For single-series charts, just use `{ x, y }`. ' +
                        'Always include a clear `title` and axis labels — the user reads the chart, not your prose summary.',
                    parameters: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: ['line', 'bar', 'area', 'pie', 'scatter'],
                                description: 'Chart type.',
                            },
                            title: { type: 'string', description: 'Chart title.' },
                            xLabel: { type: 'string', description: 'X-axis label (omit for pie).' },
                            yLabel: { type: 'string', description: 'Y-axis label (omit for pie).' },
                            data: {
                                type: 'array',
                                description:
                                    'Rows of data. Single-series: [{x, y}, ...]. Multi-series: [{x, seriesName1: y1, seriesName2: y2, ...}, ...]. ' +
                                    'Pie: [{label, value}, ...].',
                                items: { type: 'object' },
                            },
                            series: {
                                type: 'array',
                                description: 'Optional explicit series for multi-series charts.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string', description: 'Series name — must match a key in each data row.' },
                                        color: { type: 'string', description: 'CSS color (hex / rgb / named). Optional; auto-assigned if omitted.' },
                                    },
                                    required: ['name'],
                                    additionalProperties: false,
                                },
                            },
                            summary: {
                                type: 'string',
                                description: 'One-sentence takeaway shown above the chart (e.g. "S&P 500 rose 18% over the period").',
                            },
                        },
                        required: ['type', 'data'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const type = String(args?.type || '').toLowerCase();
            if (!['line', 'bar', 'area', 'pie', 'scatter'].includes(type)) {
                return { error: `Unsupported chart type "${args?.type}". Use line, bar, area, pie, or scatter.` };
            }
            const data = Array.isArray(args?.data) ? args.data : null;
            if (!data || data.length === 0) {
                return { error: 'data must be a non-empty array of objects.' };
            }
            // Hard cap to keep the tool_result SSE event under the 32 KB
            // serialization cap that gates structured payload shipping.
            const MAX_POINTS = 1000;
            const trimmed = data.length > MAX_POINTS ? data.slice(0, MAX_POINTS) : data;
            const series = Array.isArray(args?.series)
                ? args.series.filter(s => s && typeof s.name === 'string').map(s => ({
                      name: s.name,
                      ...(typeof s.color === 'string' ? { color: s.color } : {}),
                  }))
                : null;
            const chartSpec = {
                type,
                title: typeof args?.title === 'string' ? args.title : '',
                xLabel: typeof args?.xLabel === 'string' ? args.xLabel : '',
                yLabel: typeof args?.yLabel === 'string' ? args.yLabel : '',
                data: trimmed,
                ...(series && series.length > 0 ? { series } : {}),
            };
            return {
                chartSpec,
                summary: typeof args?.summary === 'string' ? args.summary : '',
                pointCount: trimmed.length,
                truncated: data.length > MAX_POINTS,
            };
        },
    });

    // ----- fetch_timeseries ------------------------------------------------
    // Pulls historical OHLC data from Yahoo Finance's v8 chart endpoint —
    // free, no API key, JSON, broad coverage (stocks, indexes, FX, crypto).
    // Stooq used to be the obvious choice but they moved their CSV endpoint
    // behind an apikey gate in 2026, so any unauthenticated request now
    // returns the apikey-instructions blurb instead of data.
    //
    // Symbol normalisation lets the model use its training-era instincts:
    // `^spx`/`^ndq`/`^dji` get rewritten to Yahoo's `^GSPC`/`^IXIC`/`^DJI`,
    // `aapl.us` strips to `AAPL`, `eurusd` becomes `EURUSD=X`. Anything
    // else passes through verbatim.
    const YF_INDEX_ALIASES = {
        '^spx': '^GSPC', '^sp500': '^GSPC', '^sp': '^GSPC',
        '^dji': '^DJI', '^dow': '^DJI',
        '^ndq': '^IXIC', '^nasdaq': '^IXIC', '^ixic': '^IXIC',
        '^rut': '^RUT', '^russell': '^RUT', '^russell2000': '^RUT',
        '^vix': '^VIX', '^ftse': '^FTSE', '^dax': '^GDAXI',
        '^nikkei': '^N225', '^n225': '^N225',
    };
    function normaliseYahooSymbol(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        const lower = s.toLowerCase();
        if (YF_INDEX_ALIASES[lower]) return YF_INDEX_ALIASES[lower];
        // US stock with .us suffix → strip
        if (/^[a-z0-9.-]+\.us$/i.test(s)) return s.replace(/\.us$/i, '').toUpperCase();
        // Six-letter forex pair with no =X → add =X
        if (/^[a-z]{6}$/i.test(s)) return s.toUpperCase() + '=X';
        // Index-style with caret → uppercase preserves Yahoo's convention
        if (s.startsWith('^')) return '^' + s.slice(1).toUpperCase();
        // Plain ticker → uppercase
        if (/^[a-z]+$/i.test(s)) return s.toUpperCase();
        return s;
    }
    tools.registerTool({
        name: 'fetch_timeseries',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'fetch_timeseries',
                    description:
                        'Fetch historical OHLC time series from Yahoo Finance (free, no API key). Use for stock tickers (AAPL, MSFT), market indexes (^GSPC for S&P 500, ^DJI for Dow, ^IXIC for Nasdaq — also accepts ^spx/^dji/^ndq aliases), forex (EURUSD=X or just "eurusd"), crypto (BTC-USD), and commodities (GC=F gold, CL=F oil). ' +
                        'After fetching, pass the rows into render_chart with type=line and a `close` series for a price chart. If a symbol returns no data, the model should suggest the user check the ticker — Yahoo uses different symbols than some other sources (e.g. ^GSPC not ^SPX).',
                    parameters: {
                        type: 'object',
                        properties: {
                            symbol: {
                                type: 'string',
                                description: 'Yahoo Finance symbol. Stocks: bare ticker (AAPL, MSFT). Indexes: ^GSPC (S&P 500), ^DJI (Dow), ^IXIC (Nasdaq), ^RUT, ^VIX, ^FTSE, ^GDAXI, ^N225. FX: EURUSD=X, GBPUSD=X (or just "eurusd" — auto-suffixed). Crypto: BTC-USD, ETH-USD.',
                            },
                            period: {
                                type: 'string',
                                enum: ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'ytd', 'max'],
                                description: 'Lookback window (default 1y).',
                            },
                            interval: {
                                type: 'string',
                                enum: ['d', 'w', 'm'],
                                description: 'Bar interval: d=daily, w=weekly, m=monthly (default d).',
                            },
                        },
                        required: ['symbol'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const rawSymbol = String(args?.symbol || '').trim();
            if (!rawSymbol) return { error: 'symbol is required' };
            if (!/^[\^a-zA-Z0-9.=_-]{1,32}$/.test(rawSymbol)) {
                return { error: 'symbol contains invalid characters' };
            }
            const symbol = normaliseYahooSymbol(rawSymbol);
            const period = ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'ytd', 'max'].includes(args?.period) ? args.period : '1y';
            const interval = ['d', 'w', 'm'].includes(args?.interval) ? args.interval : 'd';
            const yfInterval = interval === 'd' ? '1d' : interval === 'w' ? '1wk' : '1mo';
            // Yahoo's chart endpoint accepts the period as `range` directly.
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${yfInterval}&range=${period}`;
            try {
                const resp = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'application/json,text/plain,*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                    timeout: 12000,
                    // Surface non-2xx responses (e.g. 404 for unknown tickers)
                    // without throwing so we can return a structured error.
                    validateStatus: () => true,
                });
                const body = resp.data;
                // Yahoo packages errors inside the chart envelope, e.g.
                //   { chart: { result: null, error: { code: "Not Found", description: "..." } } }
                if (body?.chart?.error) {
                    return {
                        symbol, normalisedSymbol: symbol, period, interval,
                        error: `Yahoo error: ${body.chart.error.description || body.chart.error.code || 'unknown'} — check ticker (Yahoo uses ^GSPC for S&P 500, ^DJI for Dow, ^IXIC for Nasdaq)`,
                    };
                }
                const result = body?.chart?.result?.[0];
                if (!result || !Array.isArray(result.timestamp) || result.timestamp.length === 0) {
                    return {
                        symbol, normalisedSymbol: symbol, period, interval,
                        error: 'no data returned — symbol may be wrong, delisted, or this period/interval combo is unsupported',
                    };
                }
                const ts = result.timestamp;
                const quote = result.indicators?.quote?.[0] || {};
                const adjclose = result.indicators?.adjclose?.[0]?.adjclose;
                const opens = quote.open || [];
                const highs = quote.high || [];
                const lows = quote.low || [];
                const closes = quote.close || [];
                const volumes = quote.volume || [];
                const rows = [];
                for (let i = 0; i < ts.length; i++) {
                    const close = closes[i];
                    if (close == null || !Number.isFinite(close)) continue;
                    const d = new Date(ts[i] * 1000);
                    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
                    const row = { date, close };
                    if (Number.isFinite(opens[i])) row.open = opens[i];
                    if (Number.isFinite(highs[i])) row.high = highs[i];
                    if (Number.isFinite(lows[i])) row.low = lows[i];
                    if (Number.isFinite(volumes[i])) row.volume = volumes[i];
                    if (adjclose && Number.isFinite(adjclose[i])) row.adjclose = adjclose[i];
                    rows.push(row);
                }
                if (rows.length === 0) {
                    return {
                        symbol, normalisedSymbol: symbol, period, interval,
                        error: 'data returned but every close is null (likely an off-market period or a non-trading symbol)',
                    };
                }
                // Cap rows so a `period: max` request doesn't blow past the
                // tool_result SSE size cap. 800 daily bars ≈ 3.2 years.
                const MAX_ROWS = 800;
                const truncated = rows.length > MAX_ROWS;
                const data = truncated ? rows.slice(-MAX_ROWS) : rows;
                return {
                    symbol: rawSymbol,
                    normalisedSymbol: symbol,
                    period,
                    interval,
                    count: data.length,
                    truncated,
                    source: 'finance.yahoo.com',
                    currency: result.meta?.currency,
                    longName: result.meta?.longName || result.meta?.shortName,
                    data,
                };
            } catch (e) {
                return { symbol: rawSymbol, normalisedSymbol: symbol, period, interval, error: `fetch failed: ${e.message || e}` };
            }
        },
    });

    // ----- scrapling_fetch -------------------------------------------------
    // Exposes Scrapling (StealthyFetcher + curl_cffi) as a first-class tool.
    // Today Scrapling only runs as a fallback inside fetch_url / web_search;
    // this lets the model deliberately pick it when a site is known to block
    // bots (Cloudflare, PerimeterX, etc.) instead of burning a failed
    // playwright_fetch first.
    tools.registerTool({
        name: 'scrapling_fetch',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'scrapling_fetch',
                    description:
                        'Fetch a webpage with Scrapling stealth (StealthyFetcher + curl_cffi). Strongest anti-bot tool — use when fetch_url/playwright_fetch returned a `hint` about bot protection or thin content, ' +
                        'on Cloudflare/PerimeterX/DataDome/Akamai-gated sites, threat-intel portals (abuse.ch, threatfox, urlhaus), or pages showing "Checking your browser" / "Just a moment" / "Access denied" / CAPTCHA. ' +
                        'Slower than fetch_url; reach for it only when evasion is needed, but try it before asking the user to paste. Rejects private addresses.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute HTTP(S) URL to fetch.' },
                            timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Timeout in ms (default 30000).' },
                            extractLinks: { type: 'boolean', description: 'Include extracted links in the result (default false).' },
                            maxLength: { type: 'integer', minimum: 100, maximum: 100000, description: 'Truncate content to this many chars (default 15000).' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const url = String(args?.url || '').trim();
            if (!url) return { error: 'url is required' };
            { const _block = urlBlockReason(url); if (_block) return { error: _block }; }
            if (!scraplingService) {
                return { success: false, error: 'Scrapling service not available on this host' };
            }
            if (scraplingEnabled === false) {
                return { success: false, error: 'Scrapling Python module not installed — fall back to fetch_url or playwright_fetch' };
            }
            const timeout = Math.min(120_000, Math.max(1000, parseInt(args?.timeout || 30000, 10)));
            const maxLength = Math.min(100_000, Math.max(100, parseInt(args?.maxLength || 15000, 10)));
            const extractLinks = args?.extractLinks === true;
            try {
                const result = await scraplingService.fetchUrl(url, { timeout, extractLinks });
                if (!result?.success) {
                    return { url, success: false, error: result?.error || 'scrapling fetch failed', engine: 'scrapling' };
                }
                const content = typeof result.content === 'string' ? result.content.slice(0, maxLength) : '';
                return {
                    url,
                    success: true,
                    title: result.title || '',
                    content,
                    ...(extractLinks && Array.isArray(result.links) ? { links: result.links.slice(0, 100) } : {}),
                    engine: 'scrapling',
                };
            } catch (e) {
                return { url, success: false, error: e.message || String(e), engine: 'scrapling' };
            }
        },
    });

    // ----- playwright_fetch -----------------------------------------------
    // The default skill's `code` field is comment-only documentation — the
    // real work lives at /api/playwright/fetch. Register as a static native
    // tool so the chat tool-call dispatcher routes straight to
    // playwrightService instead of trying to exec the comments as Python
    // (which fails with `name 'execute' is not defined`). The dynamic skill
    // provider dedupes against toolRegistry, so the comment-only skill is
    // skipped there.
    tools.registerTool({
        name: 'playwright_fetch',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'playwright_fetch',
                    description:
                        'Fetch a webpage rendered by a real browser (Playwright + stealth). Use for JavaScript-heavy pages, SPAs, and sites where fetch_url returned empty or wrong content. Falls back to axios if Playwright is unavailable. Rejects private/internal addresses. ' +
                        'If the result includes a `hint` mentioning bot protection or thin content (Cloudflare, "Just a moment...", CAPTCHA), retry the same URL with scrapling_fetch — do NOT ask the user to paste before trying it.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute HTTP(S) URL to fetch.' },
                            timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Timeout in ms (default 15000).' },
                            waitForJS: { type: 'boolean', description: 'Wait for JS to render (default true).' },
                            includeLinks: { type: 'boolean', description: 'Include extracted links (default false).' },
                            maxLength: { type: 'integer', minimum: 100, maximum: 100000, description: 'Truncate content to this many chars (default 8000).' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const url = String(args?.url || '').trim();
            if (!url) return { error: 'url is required' };
            { const _block = urlBlockReason(url); if (_block) return { error: _block }; }
            const timeout = Math.min(120_000, Math.max(1000, parseInt(args?.timeout || 15000, 10)));
            const maxLength = Math.min(100_000, Math.max(100, parseInt(args?.maxLength || 8000, 10)));
            const waitForJS = args?.waitForJS !== false;
            const includeLinks = args?.includeLinks === true;
            if (!playwrightEnabled || !playwrightService) {
                try {
                    const fallback = await fetchUrlContentAxios(url, timeout);
                    return { ...fallback, engine: 'axios' };
                } catch (e) {
                    return { url, success: false, error: e.message || String(e), engine: 'axios' };
                }
            }
            try {
                const result = await playwrightService.fetchUrlContent(url, {
                    timeout, waitForJS, includeLinks, maxLength,
                });
                const hint = result?.success
                    ? detectBotChallenge({ title: result.title, content: result.content })
                    : null;
                return { ...result, engine: 'playwright', ...(hint ? { hint } : {}) };
            } catch (e) {
                return { url, success: false, error: e.message || String(e), engine: 'playwright' };
            }
        },
    });

    // ----- playwright_interact --------------------------------------------
    // Same shape as playwright_fetch — the default skill's code is
    // comment-only, so we register a static handler that calls
    // playwrightService.interactAndFetch directly.
    tools.registerTool({
        name: 'playwright_interact',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'playwright_interact',
                    description:
                        'Navigate a page and perform an action sequence (click, type, wait, scroll, waitForNavigation) before extracting content. Use when a page needs interaction (accept cookies, submit a form, scroll for lazy content) before it renders useful text. Requires Playwright; errors if unavailable.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute HTTP(S) URL to navigate to.' },
                            actions: {
                                type: 'array',
                                description: 'Ordered list of actions. Each action is an object with `type` (click|type|wait|scroll|waitForNavigation), plus `selector`, `text`, or `timeout` as needed.',
                                items: { type: 'object' },
                            },
                            timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Overall timeout in ms (default 30000).' },
                            maxLength: { type: 'integer', minimum: 100, maximum: 100000, description: 'Truncate content to this many chars (default 8000).' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const url = String(args?.url || '').trim();
            if (!url) return { error: 'url is required' };
            { const _block = urlBlockReason(url); if (_block) return { error: _block }; }
            if (!playwrightEnabled || !playwrightService) {
                return { success: false, error: 'Playwright not available — interaction requires browser automation' };
            }
            const timeout = Math.min(120_000, Math.max(1000, parseInt(args?.timeout || 30000, 10)));
            const maxLength = Math.min(100_000, Math.max(100, parseInt(args?.maxLength || 8000, 10)));
            const actions = Array.isArray(args?.actions) ? args.actions : [];
            try {
                const result = await playwrightService.interactAndFetch(url, actions, { timeout, maxLength });
                return { ...result, engine: 'playwright' };
            } catch (e) {
                return { url, success: false, error: e.message || String(e), engine: 'playwright' };
            }
        },
    });

    // ----- virustotal_lookup -----------------------------------------------
    // Queries VirusTotal for an IP, domain, URL, or file hash. Primary
    // path hits VT API v3 with process.env.VIRUSTOTAL_API_KEY; when the
    // key is absent, falls back to a Scrapling scrape of the GUI page so
    // the model still gets *something* (unstructured, best-effort) to
    // work with. Resource type is auto-detected from the input.
    const virustotalService = require('./services/virustotalService');
    tools.registerTool({
        name: 'virustotal_lookup',
        build() {
            const keySet = !!(process.env.VIRUSTOTAL_API_KEY && process.env.VIRUSTOTAL_API_KEY.trim());
            const keyNote = keySet
                ? 'API key configured — returns structured detection stats, flagging engines, and metadata.'
                : 'No VIRUSTOTAL_API_KEY set — falls back to scraping the GUI page (unstructured text). Set the env var for full detection data.';
            return {
                type: 'function',
                function: {
                    name: 'virustotal_lookup',
                    description:
                        `Query VirusTotal for an IP, domain, URL, or file hash (md5/sha1/sha256). ${keyNote} ` +
                        'view=detection (default): stats + flagging engines + metadata; view=community: votes + comments; view=full: both. ' +
                        'Resource type auto-detected; pass resource_type to override. Use before asking the user to paste VT screenshots.',
                    parameters: {
                        type: 'object',
                        properties: {
                            resource: { type: 'string', description: 'IP address, domain, absolute URL, or file hash (md5/sha1/sha256).' },
                            resource_type: { type: 'string', enum: ['ip_address', 'domain', 'url', 'file'], description: 'Optional override when auto-detection is wrong.' },
                            view: { type: 'string', enum: ['detection', 'community', 'full'], description: 'Which slice to fetch (default detection).' },
                            timeout: { type: 'integer', minimum: 1000, maximum: 60000, description: 'Per-request timeout in ms (default 15000).' },
                        },
                        required: ['resource'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const resource = String(args?.resource || '').trim();
            if (!resource) return { error: 'resource is required' };
            const timeout = Math.min(60_000, Math.max(1000, parseInt(args?.timeout || 15000, 10)));
            try {
                const result = await virustotalService.lookup(resource, {
                    resource_type: args?.resource_type,
                    view: args?.view || 'detection',
                    timeout,
                });
                return result;
            } catch (e) {
                return { success: false, resource, error: e.message || String(e) };
            }
        },
    });

    // ----- crawl_pages ----------------------------------------------------
    // Walks paginated listings. Four modes — url-pattern (fast, stateless;
    // increments a ?page=N / /page/N/ / ?offset=N marker), link-follow
    // (clicks Next), load-more (clicks a Load-more button), and
    // infinite-scroll (scrolls the viewport). `auto` picks one by
    // inspecting the URL and, if needed, the rendered DOM.
    const crawlerService = require('./services/crawlerService');
    tools.registerTool({
        name: 'crawl_pages',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'crawl_pages',
                    description:
                        'Walk a paginated listing across multiple pages in one call. Use for "top N / most recent N" requests or when a fetch returned only page 1. ' +
                        'Modes: auto (default; URL pattern then DOM Next/Load-more), url-pattern (increments ?page=/?p=/?offset=//page/N/), link-follow (clicks Next; pass nextSelector to override), ' +
                        'load-more (clicks button; pass loadMoreSelector), infinite-scroll. Rejects private addresses. Stops on duplicate content.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'Absolute HTTP(S) starting URL.' },
                            maxPages: { type: 'integer', minimum: 1, maximum: 20, description: 'Hard cap on pages to walk (default 5).' },
                            mode: { type: 'string', enum: ['auto', 'url-pattern', 'link-follow', 'load-more', 'infinite-scroll'], description: 'Pagination strategy (default auto).' },
                            nextSelector: { type: 'string', description: 'CSS selector for the Next link (link-follow mode). Optional override when auto-detection picks the wrong element.' },
                            loadMoreSelector: { type: 'string', description: 'CSS selector for the Load-more button (load-more mode).' },
                            waitForSelector: { type: 'string', description: 'CSS selector to wait for on each page before extracting.' },
                            timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Per-page timeout in ms (default 20000).' },
                            maxLength: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Total combined content cap across all pages (default 30000).' },
                            includeLinks: { type: 'boolean', description: 'Include extracted links per page (default false).' },
                            stealth: { type: 'boolean', description: 'Prefer Scrapling for url-pattern fetches (use when a site is known to be bot-gated).' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const url = String(args?.url || '').trim();
            if (!url) return { error: 'url is required' };
            { const _block = urlBlockReason(url); if (_block) return { error: _block }; }
            const mode = args?.mode || 'auto';
            const maxPages = Math.min(20, Math.max(1, parseInt(args?.maxPages || 5, 10)));
            const timeout = Math.min(120_000, Math.max(1000, parseInt(args?.timeout || 20000, 10)));
            const maxLength = Math.min(200_000, Math.max(1000, parseInt(args?.maxLength || 30000, 10)));
            const includeLinks = args?.includeLinks === true;
            const stealth = args?.stealth === true;
            try {
                const result = await crawlerService.crawl(url, {
                    mode, maxPages, timeout, maxLength, includeLinks, stealth,
                    nextSelector: args?.nextSelector,
                    loadMoreSelector: args?.loadMoreSelector,
                    waitForSelector: args?.waitForSelector,
                });
                if (!result?.success) {
                    return { url, success: false, error: result?.error || 'crawl failed', mode: result?.mode };
                }
                // Build the combined content here (rather than inside the
                // service) so we can attach a challenge hint at the outer
                // tool layer, same as fetch_url / playwright_fetch.
                const combinedContent = (result.pages || [])
                    .map(p => `=== Page ${p.index + 1}: ${p.title || '(no title)'} — ${p.url} ===\n${p.content}`)
                    .join('\n\n');
                const hint = detectBotChallenge({ content: combinedContent });
                return {
                    url,
                    success: true,
                    mode: result.mode,
                    pagesVisited: result.pagesVisited,
                    pages: result.pages,
                    combinedContent,
                    ...(hint ? { hint } : {}),
                };
            } catch (e) {
                return { url, success: false, error: e.message || String(e) };
            }
        },
    });

    // ----- search_string --------------------------------------------------
    // Line-oriented search inside provided text or a file on disk. Use this
    // instead of dumping a whole fetched page or large file back to yourself
    // when you only need lines that mention a specific keyword/pattern —
    // saves a lot of tokens and lets the model pinpoint data quickly.
    tools.registerTool({
        name: 'search_string',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'search_string',
                    description:
                        'Search for a string or regex in text content or a file; return only matching lines with surrounding context. ' +
                        'Provide exactly one of `text` (raw content) or `file` (path under /tmp, /models, or /app). ' +
                        'Use after fetch_url / web_search / playwright_fetch / crawl_pages whenever the user asked for specific data (price, date, name, number, error code, IP, hash, version) — searching the returned body is far cheaper than re-reading it. ' +
                        'mode="regex" for patterns; default mode is literal.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The string or regex pattern to search for.' },
                            text: { type: 'string', description: 'Raw text content to search within. Pass the body returned by a previous fetch_url / web_search call.' },
                            file: { type: 'string', description: 'Absolute path to a text file to search within. Use only for paths under /tmp or /models.' },
                            mode: { type: 'string', enum: ['literal', 'regex'], description: 'How to interpret query (default literal).' },
                            case_sensitive: { type: 'boolean', description: 'Match case (default false).' },
                            context_lines: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines of surrounding context to include around each match (default 2).' },
                            max_matches: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned matches (default 50).' },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args) {
            const query = String(args?.query || '');
            if (!query) return { error: 'query is required' };
            const hasText = typeof args?.text === 'string' && args.text.length > 0;
            const hasFile = typeof args?.file === 'string' && args.file.length > 0;
            if (hasText === hasFile) {
                return { error: 'Provide exactly one of `text` or `file`.' };
            }
            const mode = args?.mode === 'regex' ? 'regex' : 'literal';
            const caseSensitive = args?.case_sensitive === true;
            const contextLines = Math.min(10, Math.max(0, parseInt(args?.context_lines ?? 2, 10)));
            const maxMatches = Math.min(500, Math.max(1, parseInt(args?.max_matches ?? 50, 10)));

            let content;
            let sourceLabel;
            if (hasFile) {
                const filePath = path.resolve(String(args.file));
                // Confine file access to the same areas existing tools touch:
                // /tmp (chat uploads, archive extracts) and /models (mounted
                // models tree which holds .modelserver/conversations etc.).
                const allowedRoots = ['/tmp/', '/models/', '/app/'];
                if (!allowedRoots.some(r => filePath === r.slice(0, -1) || filePath.startsWith(r))) {
                    return { error: `file path must be under one of: ${allowedRoots.join(', ')}` };
                }
                try {
                    const stat = await fs.stat(filePath);
                    if (!stat.isFile()) return { error: 'file is not a regular file' };
                    if (stat.size > 20 * 1024 * 1024) {
                        return { error: `file too large (${stat.size} bytes); cap is 20MB` };
                    }
                    content = await fs.readFile(filePath, 'utf8');
                    sourceLabel = filePath;
                } catch (e) {
                    return { error: `failed to read file: ${e.message}` };
                }
            } else {
                content = String(args.text);
                sourceLabel = 'text';
            }

            let regex;
            try {
                const escaped = mode === 'regex'
                    ? query
                    : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
            } catch (e) {
                return { error: `invalid regex: ${e.message}` };
            }

            const lines = content.split(/\r?\n/);
            const matches = [];
            let totalMatches = 0;
            for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (!regex.test(lines[i])) continue;
                totalMatches++;
                if (matches.length >= maxMatches) continue;
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length - 1, i + contextLines);
                const before = lines.slice(start, i);
                const after = lines.slice(i + 1, end + 1);
                matches.push({
                    line_number: i + 1,
                    line: lines[i].length > 500 ? lines[i].slice(0, 500) + '…' : lines[i],
                    ...(contextLines > 0 ? { context_before: before, context_after: after } : {}),
                });
            }

            return {
                success: true,
                source: sourceLabel,
                query,
                mode,
                case_sensitive: caseSensitive,
                total_lines: lines.length,
                total_matches: totalMatches,
                returned_matches: matches.length,
                truncated: totalMatches > matches.length,
                matches,
            };
        },
    });

    // ----- extract_archive ------------------------------------------------
    // Unpack an archive (zip, 7z, rar, tar, tar.gz/bz2/xz, gz, bz2, xz).
    // Two input modes:
    //   1. archiveId — refers to a file persisted by /api/chat/upload
    //      (the normal chat-UI path). The upload endpoint writes the
    //      bytes to disk and puts a [Archive uploaded: ...archiveId=X...]
    //      marker in the user's message. This is the ONLY reliable path
    //      for archives >~100KB — passing raw base64 through tool-call
    //      arguments truncates silently.
    //   2. base64Data + filename — direct bytes. Fine for tiny archives,
    //      fails in practice for anything bigger due to tokenizer limits.
    //
    // Returns entry listing + inline text for small UTF-8 entries so the
    // model can read them without a follow-up tool call. Cleans up its
    // temp extraction directory on return.
    const archiveExtractor = require('./services/archiveExtractor');
    const ARCHIVE_STORE_ROOT = '/tmp/modelserver-archives';

    async function resolveArchiveById(archiveId, userId) {
        if (!/^[a-f0-9]{32}$/.test(String(archiveId || ''))) {
            throw new Error('archiveId must be a 32-char hex string.');
        }
        const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = `${ARCHIVE_STORE_ROOT}/${safeUser}/${archiveId}`;
        const fsp = require('fs').promises;
        const pathMod = require('path');
        const resolved = pathMod.resolve(dir);
        if (!resolved.startsWith(pathMod.resolve(`${ARCHIVE_STORE_ROOT}/${safeUser}`) + pathMod.sep)) {
            throw new Error('Resolved archive path escapes the store.');
        }
        const entries = await fsp.readdir(dir).catch(() => null);
        if (!entries || !entries.length) {
            throw new Error(`No archive found for id ${archiveId}. It may have expired (1-hour TTL) or the id is wrong.`);
        }
        const filename = entries[0];
        const diskPath = `${dir}/${filename}`;
        const buf = await fsp.readFile(diskPath);
        return { buffer: buf, filename };
    }

    tools.registerTool({
        name: 'extract_archive',
        build() {
            return {
                type: 'function',
                function: {
                    name: 'extract_archive',
                    description:
                        'Extract an archive (.zip, .7z, .rar, .tar, .tar.gz/.tgz, .tar.bz2, .tar.xz, .gz, .bz2, .xz). ' +
                        'When the user uploads an archive, the chat puts an `[Archive uploaded: ... archiveId=... ]` marker in their message — pass that archiveId; do NOT paste archive bytes (base64 in tool args gets truncated). ' +
                        'For tiny inline archives only, pass `base64Data` + `filename`. Returns entry list + inline UTF-8 text for files <200KB (total cap ~2MB).',
                    parameters: {
                        type: 'object',
                        properties: {
                            archiveId: {
                                type: 'string',
                                description: '32-char hex id from the [Archive uploaded: ...] marker in the user message. Preferred input.',
                            },
                            base64Data: {
                                type: 'string',
                                description: 'Fallback for small inline archives only. Raw archive bytes encoded as standard base64 (no data: URL prefix).',
                            },
                            filename: {
                                type: 'string',
                                description: 'Required when using base64Data. The extension picks the extractor (e.g. "report.tar.gz").',
                            },
                        },
                        additionalProperties: false,
                    },
                },
            };
        },
        async execute(args, ctx) {
            let buffer, filename;
            const archiveId = String(args?.archiveId || '').trim();
            if (archiveId) {
                try {
                    const resolved = await resolveArchiveById(archiveId, ctx?.userId);
                    buffer = resolved.buffer;
                    filename = resolved.filename;
                } catch (e) {
                    return { error: e.message };
                }
            } else {
                const b64 = String(args?.base64Data || '').trim();
                filename = String(args?.filename || '').trim();
                if (!b64) return { error: 'Provide archiveId (preferred) or base64Data + filename.' };
                if (!filename) return { error: 'filename is required when using base64Data.' };
                try {
                    buffer = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
                } catch (e) {
                    return { error: `Invalid base64Data: ${e.message}` };
                }
            }
            if (!buffer?.length) return { error: 'Decoded buffer is empty' };
            if (buffer.length > 50 * 1024 * 1024) {
                return { error: `Archive is ${buffer.length} bytes; 50MB max.` };
            }
            try {
                // Persist extracted contents into the conversation's workspace
                // bucket so subsequent read_file calls (sandboxed, rooted at
                // /workspace) can read individual entries on demand. Without
                // this the extractor would either inline ~2 MB of text into the
                // tool result (overflowing the model's context — observed:
                // 243k-token request against a 131k-token model after a tar.gz
                // upload) or extract to a temp dir the sandboxed read_file
                // can't see.
                const sandboxRunner = require('./services/sandboxRunner');
                let workspace;
                try {
                    workspace = await sandboxRunner.ensureWorkspace(
                        ctx?.userId ?? null,
                        ctx?.conversationId ?? null,
                    );
                } catch (wsErr) {
                    // Fall back to legacy inline-extraction mode if no workspace
                    // (e.g. /v1 passthrough callers without conv plumbing).
                    return await archiveExtractor.extractArchive(buffer, filename);
                }
                const fsp = require('fs').promises;
                const pathMod = require('path');
                const extractRoot = pathMod.join(workspace.localInContainer, 'archives', archiveId || crypto.randomBytes(8).toString('hex'));
                await fsp.mkdir(extractRoot, { recursive: true });
                await fsp.chmod(extractRoot, 0o777);
                const result = await archiveExtractor.extractArchive(buffer, filename, {
                    extractTo: extractRoot,
                    pathBase: workspace.localInContainer,
                });
                return {
                    ...result,
                    workspaceRoot: workspace.containerMount,
                    note: (result.note ? result.note + ' ' : '') +
                        `Files extracted into the conversation workspace. Each entry's \`path\` is workspace-relative — pass it to read_file to inspect contents (e.g. read_file(filePath="${result.entries?.[0]?.path || 'archives/.../foo'}")).`,
                };
            } catch (e) {
                return { error: e.message || String(e) };
            }
        },
    });

    // --------------------------------------------------------------
    // Expose every enabled skill as a native tool call.
    // --------------------------------------------------------------
    //
    // The model sees these as first-class OpenAI tools alongside
    // load_skill / web_search / fetch_url, so prompts like "decode this
    // base64" / "list the directory" / "do a dns lookup on X" resolve
    // to a direct tool call instead of a text answer.
    //
    // Built per-request via setDynamicToolProvider so we always pull
    // the current (user-scoped) skill set, including anything the user
    // just added. Dispatch goes through executePythonSkill which already
    // applies the sandbox / workspace / network-allowlist policy on the
    // skill record.

    // OpenAI tool names accept only [a-zA-Z0-9_-]{1,64}. Skills follow
    // that convention already (snake_case), but sanitize defensively.
    function safeToolName(name) {
        return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    }

    // Skills store their parameter list as a flat map
    //   { paramName: 'string' | 'number' | 'boolean' | 'array' | 'object' }
    // Convert to a JSON Schema object that OpenAI tool-calling understands.
    // Every listed param is treated as required — skill implementations
    // generally throw on missing arguments, so this matches their
    // runtime contract. Unknown type hints fall back to "string".
    function paramsToJsonSchema(params) {
        const properties = {};
        const required = [];
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
                const hint = String(v || '').toLowerCase();
                let type = 'string';
                if (hint === 'number' || hint === 'integer' || hint === 'float') type = 'number';
                else if (hint === 'boolean' || hint === 'bool') type = 'boolean';
                else if (hint === 'array' || hint === 'list') type = 'array';
                else if (hint === 'object' || hint === 'dict' || hint === 'map') type = 'object';
                properties[k] = type === 'array'
                    ? { type: 'array', items: { type: 'string' } }
                    : { type };
                required.push(k);
            }
        }
        return {
            type: 'object',
            properties,
            ...(required.length ? { required } : {}),
            additionalProperties: false,
        };
    }

    tools.setDynamicToolProvider(async (ctx) => {
        try {
            const all = await loadSkills();
            const scoped = filterByUserId(all, ctx?.userId);
            const out = [];
            // Tool names must be unique — load_skill / web_search /
            // fetch_url are already in the static registry. Dedupe.
            const taken = new Set(tools.toolRegistry.keys());
            for (const s of scoped) {
                if (!s || s.enabled === false || !s.name) continue;
                const name = safeToolName(s.name);
                if (!name || taken.has(name)) continue;
                taken.add(name);
                // Description is the primary selection signal — most skills
                // have a clear, terse description (avg ~97 chars). When
                // description is short and systemPrompt has a useful trigger
                // sentence, append the first sentence of systemPrompt as
                // hinting. Final cap at 150 chars (was 400): with 100
                // tools the catalog can otherwise approach 30 KB, dominating
                // the per-turn prompt eval. Beyond ~150 chars, additional
                // verbosity actively hurts selection accuracy on small
                // models because each schema sprawls.
                let desc = (typeof s.description === 'string' ? s.description.trim() : '') || s.name;
                if (desc.length < 80 && typeof s.systemPrompt === 'string' && s.systemPrompt.trim()) {
                    // Pull the first sentence of systemPrompt — usually the
                    // load-bearing trigger phrase ("Use this skill to ...").
                    const firstSentence = s.systemPrompt.trim().split(/(?<=[.!?])\s+/)[0] || '';
                    if (firstSentence) desc = (desc + ' — ' + firstSentence).slice(0, 150);
                }
                out.push({
                    type: 'function',
                    function: {
                        name,
                        description: desc.slice(0, 150),
                        parameters: paramsToJsonSchema(s.parameters),
                    },
                });
            }
            return out;
        } catch (e) {
            console.warn('[chatTools] dynamic skill provider failed:', e.message);
            return [];
        }
    });

    tools.setFallbackDispatch(async (toolName, args, ctx) => {
        // Called when the model invokes a tool name that isn't in the
        // static registry — expected to be a skill from the dynamic
        // catalog. Dispatch via executePythonSkill so the sandbox /
        // workspace / network-allowlist policy on the skill record is
        // respected, same as if it were called through /api/skills/:name/execute.
        const all = await loadSkills();
        const scoped = filterByUserId(all, ctx?.userId);
        const safe = toolName;
        const skill = scoped.find(s => safeToolName(s.name) === safe);
        if (!skill) {
            return { success: false, error: `Unknown skill: ${toolName}` };
        }
        if (skill.enabled === false) {
            return { success: false, error: `Skill "${toolName}" is disabled` };
        }
        try {
            let result;
            if (skill.code && skill.code.trim() && !skill.code.startsWith('Uses ') && !skill.code.startsWith('Runs ')) {
                result = await executePythonSkill(skill, args, ctx);
            } else {
                result = await executeLegacySkill(skill.name, args);
            }
            return result;
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    });

    console.log(`[chatTools] registered ${tools.toolRegistry.size} static native tools:`,
        [...tools.toolRegistry.keys()].join(', '),
        '+ dynamic skill catalog');
})();

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

    // Sandbox runner needs the host path to stage scratch dirs that sibling
    // tool-exec containers can mount. Tell it now that hostModelsPath is known.
    try {
        require('./services/sandboxRunner').setHostBase(hostModelsPath);
    } catch (_) { /* sandbox runner absent — runs will throw on use */ }

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

    // Start the egress proxy used by sandboxed tool-execution containers.
    // Safe to start even when no tools use 'allowlist' — it just sits idle.
    try {
        require('./services/egressProxy').start();
    } catch (e) {
        console.warn('[Startup] egressProxy failed to start:', e.message);
    }

    // One-shot legacy-workspace migration: older installs kept per-user
    // files directly under /models/.modelserver/workspaces/<userId>/; the
    // new per-conversation scheme buckets into <userId>/{conv-<id>|global}/.
    // Shuffle loose legacy entries into the `global` bucket so existing
    // content stays accessible to non-chat callers. Idempotent.
    try {
        const sbRunner = require('./services/sandboxRunner');
        if (typeof sbRunner.migrateLegacyWorkspaces === 'function') {
            await sbRunner.migrateLegacyWorkspaces();
        }
    } catch (e) {
        console.warn('[workspace-migration] failed (non-fatal):', e.message);
    }

    // Attachment-store orphan sweep. Walks every user's conversations,
    // collects every attachmentId still referenced, and deletes any
    // attachment dir older than 14 days that no live message references.
    // Catches:
    //   - uploads that never made it into a sent message (browser closed
    //     before send, conversation never persisted)
    //   - persistence races where the message file was overwritten without
    //     the attachment getting a chance to be referenced
    // Runs once at boot and again every 12 hours so a long-running webapp
    // doesn't grow attachments without bound.
    async function sweepAttachmentOrphans() {
        try {
            const refsByUser = new Map();
            let userEntries;
            try {
                userEntries = await fs.readdir(CONVERSATIONS_DIR, { withFileTypes: true });
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
                userEntries = [];
            }
            for (const userEnt of userEntries) {
                if (!userEnt.isDirectory()) continue;
                const userId = userEnt.name;
                const userBucket = attachmentStore.userIdSafe(userId);
                let refs = refsByUser.get(userBucket);
                if (!refs) { refs = new Set(); refsByUser.set(userBucket, refs); }
                let convFiles;
                try {
                    convFiles = await fs.readdir(path.join(CONVERSATIONS_DIR, userId));
                } catch (_) { continue; }
                for (const f of convFiles) {
                    if (!f.endsWith('.json') || f === 'index.json') continue;
                    const convId = f.replace(/\.json$/, '');
                    if (!/^[a-zA-Z0-9_-]+$/.test(convId)) continue;
                    let messages;
                    try {
                        messages = await loadConversationMessages(userId, convId);
                    } catch (_) { continue; }
                    for (const msg of messages) {
                        const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
                        for (const att of atts) {
                            if (att && typeof att.attachmentId === 'string') {
                                refs.add(att.attachmentId);
                            }
                        }
                    }
                }
            }
            const result = await attachmentStore.sweepOrphans(refsByUser);
            if (result.swept > 0) {
                const kb = Math.round((result.byteSize || 0) / 1024);
                console.log(`[AttachmentSweeper] removed ${result.swept} orphan attachment(s), reclaimed ${kb} KB`);
            }
        } catch (e) {
            console.warn('[AttachmentSweeper] failed:', e.message);
        }
    }
    // Boot pass — fires after server is listening so it doesn't block.
    sweepAttachmentOrphans();
    const ATTACHMENT_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
    setInterval(sweepAttachmentOrphans, ATTACHMENT_SWEEP_INTERVAL_MS).unref();

    // Sandbox scratch dir TTL sweeper — deletes run directories older than
    // ARTIFACT_TTL_MS so artifact files from sandboxed tool runs don't
    // accumulate on disk. Runs every 10 minutes; default TTL 1 hour.
    const ARTIFACT_TTL_MS = parseInt(process.env.SANDBOX_ARTIFACT_TTL_MS || '3600000', 10);
    const SANDBOX_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
    setInterval(async () => {
        const sandboxDir = '/models/.modelserver/sandbox';
        try {
            const entries = await fs.readdir(sandboxDir, { withFileTypes: true }).catch(() => []);
            const now = Date.now();
            let swept = 0;
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                const p = `${sandboxDir}/${e.name}`;
                try {
                    const st = await fs.stat(p);
                    if (now - st.mtimeMs > ARTIFACT_TTL_MS) {
                        await fs.rm(p, { recursive: true, force: true });
                        swept++;
                    }
                } catch (_) { /* ignore */ }
            }
            if (swept) console.log(`[SandboxSweeper] removed ${swept} expired tool-run dir(s)`);
        } catch (e) {
            console.warn('[SandboxSweeper] failed:', e.message);
        }
    }, SANDBOX_SWEEP_INTERVAL_MS).unref();

    console.log('Initialization complete');
});

// Start HTTP redirect server if HTTPS is enabled
if (useHttps && httpRedirectServer) {
    httpRedirectServer.listen(HTTP_REDIRECT_PORT, () => {
        console.log(`HTTP redirect server listening on port ${HTTP_REDIRECT_PORT} -> redirects to HTTPS`);
    });
}
