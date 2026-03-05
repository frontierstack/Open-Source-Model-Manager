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

const app = express();

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
        // This allows services like Open WebUI to connect without SSL verification issues
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

// In-memory store for model instances (supports both vLLM and llama.cpp backends)
// Map structure: modelName -> { containerId, port, status, config, backend }
const modelInstances = new Map();

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

    // Try to broadcast error to connected clients
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: 'Internal error occurred. Check server logs.',
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

    // Try to broadcast error to connected clients
    try {
        if (typeof broadcast === 'function') {
            broadcast({
                type: 'log',
                message: 'Critical error occurred. Server may be unstable.',
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
async function syncModelInstances() {
    try {
        console.log('Syncing model instances from Docker...');
        const containers = await docker.listContainers({ all: true });

        for (const containerInfo of containers) {
            const name = containerInfo.Names[0].substring(1); // Remove leading /

            // Determine backend from container name prefix
            let backend = null;
            let modelName = null;

            if (name.startsWith('vllm-')) {
                backend = 'vllm';
                modelName = name.replace('vllm-', '');
            } else if (name.startsWith('llamacpp-')) {
                backend = 'llamacpp';
                modelName = name.replace('llamacpp-', '');
            } else {
                continue; // Skip non-model containers
            }

            const container = docker.getContainer(containerInfo.Id);
            const inspect = await container.inspect();

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
                config = {
                    maxModelLen: parseInt(getEnvValue('VLLM_MAX_MODEL_LEN') || '4096'),
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

            modelInstances.set(modelName, {
                containerId: containerInfo.Id,
                port,
                status,
                modelName,
                config,
                backend
            });

            console.log(`  - Found ${modelName} (${backend}) on port ${port} (${status})`);
        }

        console.log(`Synced ${modelInstances.size} model instance(s)`);
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
// AGENTS STORAGE HELPERS
// ============================================================================

async function loadAgents() {
    try {
        const data = await fs.readFile(AGENTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading agents:', err);
        return [];
    }
}

async function saveAgents(agents) {
    await ensureDataDir();
    await fs.writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

async function loadSkills() {
    try {
        const data = await fs.readFile(SKILLS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading skills:', err);
        return [];
    }
}

async function saveSkills(skills) {
    await ensureDataDir();
    await fs.writeFile(SKILLS_FILE, JSON.stringify(skills, null, 2));
}

async function loadTasks() {
    try {
        const data = await fs.readFile(TASKS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading tasks:', err);
        return [];
    }
}

async function saveTasks(tasks) {
    await ensureDataDir();
    await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

async function loadAgentPermissions() {
    try {
        const data = await fs.readFile(AGENT_PERMISSIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Default permissions - all enabled
            return {
                allowFileRead: true,
                allowFileWrite: true,
                allowFileDelete: true,
                allowToolExecution: true,
                allowModelAccess: true,
                allowCollaboration: true
            };
        }
        console.error('Error loading agent permissions:', err);
        return {};
    }
}

async function saveAgentPermissions(permissions) {
    await ensureDataDir();
    await fs.writeFile(AGENT_PERMISSIONS_FILE, JSON.stringify(permissions, null, 2));
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
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    try {
        // Try to bind WebSocket to user session
        const sessionId = parseSessionCookie(req.headers.cookie);
        const userId = await getUserIdFromSession(sessionId);

        ws.userId = userId;
        ws.sessionId = sessionId;

        if (userId) {
            console.log(`WebSocket bound to user: ${userId}`);
        }
    } catch (error) {
        console.error('Error setting up WebSocket connection:', error.message);
        // Continue anyway - connection can work without user binding
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

const { createUser, getUserById, changePassword } = require('./auth/users');

// Register a new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        // Validate password strength
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const user = await createUser({ username, email, password });

        res.status(201).json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(400).json({ error: error.message || 'Registration failed' });
    }
});

// Login user
app.post('/api/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            return res.status(500).json({ error: 'Authentication error' });
        }

        if (!user) {
            return res.status(401).json({ error: info.message || 'Invalid credentials' });
        }

        req.logIn(user, (err) => {
            if (err) {
                return res.status(500).json({ error: 'Login failed' });
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

// Change password
app.put('/api/auth/password', requireAuth, async (req, res) => {
    // requireAuth middleware handles both session and API key authentication
    // No need for additional isAuthenticated check

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

    // Parse progress from stdout
    const progressRegex = /(\d+)%/; // Match percentage like "45%"

    child.stdout.on('data', (data) => {
        try {
            const output = data.toString();
            console.log(`[Download ${downloadId}] stdout: ${output}`);

            // Try to extract progress percentage
            const match = output.match(progressRegex);
            if (match) {
                const progress = parseInt(match[1]);
                downloadInfo.progress = progress;
                broadcast({
                    type: 'download_progress',
                    downloadId,
                    progress,
                    message: output.trim()
                });
            } else {
                // Still broadcast as log for non-progress output
                broadcast({ type: 'log', message: `[${downloadInfo.modelName}] ${output}` });
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
        // Get running vLLM instances
        const instances = Array.from(modelInstances.entries()).map(([name, info]) => ({
            name,
            port: info.port,
            config: info.config,
            status: info.status
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

            // Get context size from instance config, or default to null
            if (instance?.config?.contextSize) {
                contextSize = instance.config.contextSize;
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
                    status = 'Loaded in vLLM';
                } else {
                    status = `Instance: ${instance.status}`;
                }
            }

            return {
                name: modelName,
                status,
                instanceStatus: instance?.status,
                format: hasGGUF ? 'GGUF' : 'Unknown',
                targetBackend: 'vllm',
                loadedIn: instance ? 'vllm' : null,
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
                disableThinking: req.body.disableThinking ?? false
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
                disableThinking: req.body.disableThinking ?? false
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

        const container = await docker.createContainer({
            Image: 'modelserver-vllm:latest',
            name: containerName,
            Env: [
                `VLLM_MODEL_PATH=${modelPath}`,
                `VLLM_PORT=${port}`,
                `VLLM_MAX_MODEL_LEN=${config.maxModelLen}`,
                `VLLM_CPU_OFFLOAD_GB=${config.cpuOffloadGb}`,
                `VLLM_GPU_MEMORY_UTILIZATION=${config.gpuMemoryUtilization}`,
                `VLLM_TENSOR_PARALLEL_SIZE=${config.tensorParallelSize}`,
                `VLLM_MAX_NUM_SEQS=${config.maxNumSeqs}`,
                `VLLM_KV_CACHE_DTYPE=${config.kvCacheDtype}`,
                `VLLM_TRUST_REMOTE_CODE=${config.trustRemoteCode}`,
                `VLLM_ENFORCE_EAGER=${config.enforceEager}`
            ],
            HostConfig: {
                Runtime: 'nvidia',
                Binds: [getModelsVolumeBind()],
                PortBindings: {
                    // Bind to all interfaces for container-to-container communication
                    [`${port}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: `${port}` }]
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
                    [`${port}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: `${port}` }]
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
                    // Clean up the line (remove non-printable chars from header)
                    const cleanLine = line.replace(/[\x00-\x08]/g, '').trim();
                    if (cleanLine) {
                        // Detect error patterns
                        const isError = /error|failed|fatal|exception|cannot|unable|oom|out of memory|killed/i.test(cleanLine);
                        broadcast({
                            type: 'log',
                            message: `[${modelName}] ${cleanLine}`,
                            level: isError ? 'error' : 'info'
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

                    // Only broadcast success message if transitioning from loading/unhealthy state
                    if (wasUnhealthy || wasLoading || instance.status === 'starting') {
                        if (wasUnhealthy) {
                            broadcast({
                                type: 'log',
                                message: `[${modelName}] Server recovered and is now healthy`,
                                level: 'success'
                            });
                            broadcast({
                                type: 'status',
                                message: `Instance ${modelName} recovered - now ready on port ${port}`,
                                level: 'success'
                            });
                        } else {
                            broadcast({
                                type: 'log',
                                message: `[${modelName}] Server is ready and healthy`,
                                level: 'success'
                            });
                            broadcast({
                                type: 'status',
                                message: `Instance ${modelName} ready on port ${port}`,
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
                    broadcast({
                        type: 'log',
                        message: `[${modelName}] Initial loading timeout (${PHASE1_DURATION + PHASE2_DURATION}s) - marked as unhealthy but monitoring continues`,
                        level: 'warning'
                    });
                    broadcast({
                        type: 'status',
                        message: `Instance ${modelName} slow to load - check logs. Will auto-recover when ready.`,
                        level: 'warning'
                    });
                    instance.status = 'unhealthy';
                    modelInstances.set(modelName, instance);
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

// List all running instances
app.get('/api/vllm/instances', requireAuth, (req, res) => {
    // Check permission
    if (!checkPermission(req.apiKeyData, 'instances')) {
        return res.status(403).json({ error: 'Instances permission required' });
    }
    const instances = Array.from(modelInstances.entries()).map(([name, info]) => ({
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
        broadcast({ type: 'status', message: `Instance ${modelName} stopped` });

        res.json({ message: 'Instance stopped' });
    } catch (error) {
        console.error(`Error stopping instance:`, error);
        // Even on error, try to clean up our state to prevent stale entries
        modelInstances.delete(modelName);
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
            return {
                id: model.id,
                downloads: model.downloads,
                likes: model.likes,
                tags: model.tags,
                paramSize: paramSize,  // Size in billions (null if unknown)
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
            // No NVIDIA GPU or nvidia-smi not available
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
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        console.error('Error loading API keys:', err);
        return [];
    }
}

async function saveApiKeys(keys) {
    await ensureDataDir();
    await fs.writeFile(API_KEYS_FILE, JSON.stringify(keys, null, 2));
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
        const keyData = keys.find(k => k.key === apiKey && k.secret === apiSecret && k.active);

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
        req.userId = req.user.id;
        req.apiKeyData = null; // Session users have full access (like no API key)
        return next();
    }

    const apiKey = req.header('X-API-Key');
    const apiSecret = req.header('X-API-Secret');
    const authHeader = req.header('Authorization');

    // Priority 2: Check for Bearer token authentication (for OpenWebUI)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const bearerToken = authHeader.substring(7);
        try {
            const keys = await loadApiKeys();
            const keyData = keys.find(k => k.key === bearerToken && k.active && k.bearerOnly === true);

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
// If userId is null (no auth), return all data (backward compatibility)
// Otherwise, return only items belonging to the user
function filterByUserId(items, userId) {
    if (!userId) {
        return items; // No filtering for unauthenticated requests
    }
    // Include items without userId (global/system items) or items owned by user
    return items.filter(item => !item.userId || item.userId === userId);
}

// Helper function to check if user owns an item
// If userId is null (no auth), allow access (backward compatibility)
// Otherwise, check if item belongs to user
function checkOwnership(item, userId) {
    if (!userId) {
        return true; // No ownership check for unauthenticated requests
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
            const keyData = keys.find(k => k.key === apiKey && k.secret === apiSecret && k.active);

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
            rateLimitRequests: rateLimitRequests !== undefined ? rateLimitRequests : 60, // null for no limit, default 60
            rateLimitTokens: rateLimitTokens !== undefined ? rateLimitTokens : 100000, // null for no limit, default 100k
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
                return res.status(500).json({ error: 'Skill execution failed: ' + error.message });
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
        res.status(500).json({ error: 'Failed to execute skill: ' + error.message });
    }
});

// Python skill executor
async function executePythonSkill(skill, params) {
    const tempFile = `/tmp/skill_${Date.now()}_${Math.random().toString(36).substring(7)}.py`;

    try {
        // Create Python script with JSON I/O
        // Write params to a separate JSON file to avoid shell escaping issues
        const paramsFile = `/tmp/skill_params_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.json`;
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

            case 'read_file':
                if (!params.filePath) {
                    throw new Error('filePath required' );
                }
                const fileContent = await fs.readFile(params.filePath, 'utf8');
                result = { success: true, content: fileContent };
                break;

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
                const netstatArgs = params.flags || '-tuln';
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
                try {
                    const { stdout } = await execPromise('git status', { cwd: repoPath });
                    result = { success: true, output: stdout };
                } catch (e) {
                    throw new Error('Git command failed: ' + e.message );
                }
                break;

            case 'git_diff':
                const gitRepoPath = params.repoPath || '.';
                const gitFiles = params.files ? params.files.join(' ') : '';
                try {
                    const { stdout } = await execPromise(`git diff ${gitFiles}`, { cwd: gitRepoPath });
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

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileRead) {
            return res.status(403).json({ error: 'File read operations are disabled' });
        }

        // Read file
        const content = await fs.readFile(filePath, 'utf8');
        res.json({ content, path: filePath });
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

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileWrite) {
            return res.status(403).json({ error: 'File write operations are disabled' });
        }

        // Ensure directory exists
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        // Write file
        await fs.writeFile(filePath, content, 'utf8');
        res.json({ message: 'File written successfully', path: filePath });
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

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileDelete) {
            return res.status(403).json({ error: 'File delete operations are disabled' });
        }

        // Delete file
        await fs.unlink(filePath);
        res.json({ message: 'File deleted successfully', path: filePath });
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

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileRead) {
            return res.status(403).json({ error: 'File read operations are disabled' });
        }

        // List directory
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const files = entries.map(entry => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile()
        }));

        res.json({ files, path: dirPath });
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

    try {
        // Check global agent permissions
        const globalPermissions = await loadAgentPermissions();
        if (!globalPermissions.allowFileWrite) {
            return res.status(403).json({ error: 'File write operations are disabled' });
        }

        // Ensure destination directory exists
        const destDir = path.dirname(destPath);
        await fs.mkdir(destDir, { recursive: true });

        // Move file
        await fs.rename(sourcePath, destPath);
        res.json({ message: 'File moved successfully', from: sourcePath, to: destPath });
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

    // Enhance query with current year/month for "recent" or "latest" queries
    let enhancedQuery = q;
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
        // DuckDuckGo HTML search with date filtering
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(enhancedQuery)}${dateFilter}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        const html = response.data;
        const results = [];
        const seenUrls = new Set(); // Deduplication

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
                const snippet = snippetMatch
                    ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
                    : '';

                // Only add if we have a valid URL and haven't seen it before
                if (decodedUrl && decodedUrl.startsWith('http') && !seenUrls.has(decodedUrl)) {
                    seenUrls.add(decodedUrl);
                    results.push({
                        title: title || 'No title',
                        url: decodedUrl,
                        snippet: snippet || 'No description available',
                        content: null // Will be populated if fetchContent is true
                    });
                }
            }
        }

        // Optionally fetch actual content from top URLs (in parallel)
        let contentFetchedCount = 0;
        if (shouldFetchContent && results.length > 0) {
            const urlsToFetch = results.slice(0, parseInt(contentLimit));

            const fetchPromises = urlsToFetch.map(async (result) => {
                const fetchResult = await fetchUrlContent(result.url);
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
            contentFetchedCount: shouldFetchContent ? contentFetchedCount : undefined
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

// Helper function to fetch content from a URL with timeout
// Uses Playwright for advanced bot-detection avoidance, falls back to axios
async function fetchUrlContent(url, options = {}) {
    const timeout = options.timeout || 12000;

    // Use Playwright if available (handles JS-rendered pages, avoids bot detection)
    if (playwrightEnabled && playwrightService) {
        try {
            const result = await playwrightService.fetchUrlContent(url, {
                timeout,
                waitForJS: options.waitForJS !== false,
                maxLength: options.maxLength || 6000,
                includeLinks: options.includeLinks || false
            });

            if (result.success) {
                return result;
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

// Playwright fetch endpoint - advanced web scraping with stealth mode
app.post('/api/playwright/fetch', requireAuth, async (req, res) => {
    if (!checkPermission(req.apiKeyData, 'query')) {
        return res.status(403).json({ error: 'Query permission required' });
    }

    const { url, urls, timeout = 15000, waitForJS = true, includeLinks = false, screenshot = false, maxLength = 8000 } = req.body;

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
                maxLength
            });
            return res.json({ ...result, engine: 'playwright' });
        } else {
            // Multiple URL fetch
            const results = await playwrightService.fetchMultipleUrls(
                urls.slice(0, 10),
                { timeout, waitForJS, includeLinks, maxLength },
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
        const contextSize = targetInstance.config?.contextSize || 4096;
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

        // Reserve space for response (default 20% of context or maxTokens if specified)
        const responseReserve = maxTokens || Math.floor(contextSize * 0.2);
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
                        temperature: temperature || 0.7
                    };

                    if (maxTokens) {
                        requestBody.max_tokens = maxTokens;
                    }

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
            temperature: temperature || 0.7
        };

        // Only include max_tokens if explicitly provided
        if (maxTokens) {
            requestBody.max_tokens = maxTokens;
        }

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

// Streaming chat endpoint - Server-Sent Events (SSE)
app.post('/api/chat/stream', requireAuth, async (req, res) => {
    const { message, model, temperature, maxTokens } = req.body;

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
        const contextSize = targetInstance.config?.contextSize || 4096;
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

        // Reserve space for response (default 20% of context or maxTokens if specified)
        const responseReserve = maxTokens || Math.floor(contextSize * 0.2);
        const availableContextForInput = contextSize - responseReserve;

        // Check if input exceeds available context
        if (totalInputTokens > availableContextForInput) {
            if (!contextShift) {
                return res.status(400).json({
                    success: false,
                    error: `Not enough context window: Input requires ~${totalInputTokens} tokens but only ${availableContextForInput} available (context: ${contextSize}, reserved for response: ${responseReserve}). Enable context shifting or reduce input size.`
                });
            }
            // If context shift enabled, truncate message
            const excessTokens = totalInputTokens - availableContextForInput;
            const targetMessageLength = userContent.length - (excessTokens * 4);

            if (targetMessageLength <= 0) {
                return res.status(400).json({
                    success: false,
                    error: `Input too large: Your message (${totalInputTokens} tokens) exceeds the model's context window (${contextSize} tokens). Please reduce input size or increase context size in model settings.`
                });
            }
        }

        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

        // Build messages array (with /no_think prepended if disableThinking is enabled)
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: userContent });

        const requestBody = {
            messages: messages,
            temperature: temperature || 0.7,
            stream: true // Enable streaming from the model
        };

        if (maxTokens) {
            requestBody.max_tokens = maxTokens;
        }

        // Make streaming request to model instance
        const response = await axios({
            method: 'post',
            url: `http://${targetHost}:${targetPort}/v1/chat/completions`,
            data: requestBody,
            responseType: 'stream'
        });

        let fullResponse = '';
        let tokenCount = 0;
        let promptTokens = 0;
        let completionTokens = 0;

        // Process the stream
        response.data.on('data', (chunk) => {
            try {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);

                        // Check for [DONE] marker
                        if (data === '[DONE]') {
                            console.log(`[Stream Token Tracking] [DONE] marker received. promptTokens=${promptTokens}, completionTokens=${completionTokens}`);
                            // Send final event with token stats
                            const finalEvent = {
                                done: true,
                                tokens: {
                                    prompt_tokens: promptTokens,
                                    completion_tokens: completionTokens,
                                    total_tokens: promptTokens + completionTokens
                                },
                                model: targetModel,
                                response: fullResponse,
                                contextSize: contextSize  // Include context window size for client tracking
                            };
                            res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);

                            // Manually update token usage stats (streaming doesn't use res.send interceptor)
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

                            res.end();
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            console.log(`[Stream Debug] Parsed chunk:`, JSON.stringify(parsed, null, 2).substring(0, 200));

                            // Extract token from delta
                            if (parsed.choices && parsed.choices[0]?.delta) {
                                const delta = parsed.choices[0].delta;
                                const content = delta.content || delta.reasoning_content || '';

                                if (content) {
                                    fullResponse += content;
                                    tokenCount++;
                                    completionTokens++;

                                    // Send token event
                                    const event = {
                                        token: content,
                                        done: false
                                    };
                                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                                }
                            }

                            // Capture usage stats if available
                            if (parsed.usage) {
                                promptTokens = parsed.usage.prompt_tokens || 0;
                                completionTokens = parsed.usage.completion_tokens || 0;
                            }
                            // llama.cpp uses timings instead of usage
                            if (parsed.timings) {
                                promptTokens = (parsed.timings.prompt_n || 0) + (parsed.timings.cache_n || 0);
                                completionTokens = parsed.timings.predicted_n || 0;
                                console.log(`[Stream Token Tracking] Extracted from timings: promptTokens=${promptTokens}, completionTokens=${completionTokens}`);
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
            // If stream ended without [DONE] marker, send final event
            if (!res.writableEnded) {
                const finalEvent = {
                    done: true,
                    tokens: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens
                    },
                    model: targetModel,
                    response: fullResponse,
                    contextSize: contextSize  // Include context window size for client tracking
                };
                res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);

                // Manually update token usage stats (streaming doesn't use res.send interceptor)
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

                res.end();
            }
        });

        response.data.on('error', (error) => {
            console.error('Stream error:', error);
            if (!res.writableEnded) {
                const errorEvent = {
                    error: error.message,
                    done: true
                };
                res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
                res.end();
            }
        });

        // Handle client disconnect
        req.on('close', () => {
            if (response.data) {
                response.data.destroy();
            }
        });

    } catch (error) {
        console.error('Chat stream error:', error.message);

        // Check for specific error types
        const errorMessage = error.response?.data?.error?.message || error.message || '';

        if (!res.writableEnded) {
            // Send error as SSE event
            const errorEvent = {
                error: errorMessage.includes('context') ?
                    'Not enough context window' :
                    'Failed to get response from model',
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

        // Make request to vLLM instance
        // Don't set default max_tokens - let the model/API key handle it
        const requestBody = {
            prompt: finalPrompt,
            temperature: temperature || 0.7
        };

        // Only include max_tokens if explicitly provided
        if (maxTokens) {
            requestBody.max_tokens = maxTokens;
        }

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
    const serviceMap = {
        'open-webui': ['nginx', 'open-webui']  // Stop nginx first, then open-webui
    };
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
                name: 'open-webui',
                displayName: 'Open WebUI',
                description: 'Chat interface for interacting with models',
                ports: [
                    { internal: 8080, external: 3002, protocol: 'https' }
                ],
                url: `https://${hostIp}:3002`,
                status: await getServiceStatus('open-webui')
            },
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
                description: 'Extract text from various file formats (PDF, DOCX, etc.)',
                type: 'function',
                parameters: { filePath: 'string', format: 'string' },
                code: `async function execute(params) {
    if (!params.filePath) {
        throw new Error('filePath parameter is required');
    }
    // Basic text file extraction
    const format = params.format || 'txt';
    if (format === 'txt') {
        const content = await fs.readFile(params.filePath, 'utf8');
        return { success: true, text: content };
    }
    // Other formats would require additional libraries (pdf-parse, mammoth, etc.)
    throw new Error(\`Format \${format} not yet implemented. Install required libraries and update skill code.\`);
}`,
                enabled: false,
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

        // Check if default OpenWebUI key exists
        let openWebuiKeyExists = keys.find(k => k.name === 'Default OpenWebUI Key');
        if (!openWebuiKeyExists) {
            const openwebuiKey = {
                id: crypto.randomUUID(),
                name: 'Default OpenWebUI Key',
                key: generateApiKey(),
                secret: generateApiSecret(),
                bearerOnly: true, // Bearer token for OpenWebUI
                permissions: ['query', 'models'],
                rateLimitRequests: null, // No rate limit
                rateLimitTokens: null, // No token limit
                active: true,
                createdAt: new Date().toISOString()
            };
            keys.push(openwebuiKey);
            console.log('');
            console.log('========================================');
            console.log('  OpenWebUI Bearer Token Created');
            console.log('========================================');
            console.log('');
            const hostIp = getHostIp();
            console.log('To configure Open WebUI:');
            console.log(`1. Open https://${hostIp}:3002`);
            console.log('2. Go to Settings > Connections');
            console.log('3. Set OpenAI API Base URL to:');
            console.log('   https://host.docker.internal:3001/v1');
            console.log('4. Set API Key to:');
            console.log(`   ${openwebuiKey.key}`);
            console.log('');
            console.log('========================================');
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

// Bash installer (Linux/macOS/WSL/Git Bash)
app.get('/api/cli/install', (req, res) => {
    const scriptPath = path.join(__dirname, 'scripts/install-agents-cli.sh');
    const host = req.get('host') || 'localhost:3001';
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
app.get('/api/cli/install.ps1', (req, res) => {
    const scriptPath = path.join(__dirname, 'scripts/install-agents-cli.ps1');
    const host = req.get('host') || 'localhost:3001';
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
app.get('/api/cli/files/package.json', (req, res) => {
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

app.get('/api/cli/files/koda.js', (req, res) => {
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
// OPEN WEBUI EXTERNAL WEB SEARCH
// ============================================================================
// Endpoint for Open WebUI's external web search feature
// Configure in Open WebUI: Admin > Settings > Web Search > External
// URL: http://host.docker.internal:3080/api/openwebui/search
// API Key: Your bearer token from API Keys tab

app.post('/api/openwebui/search', requireAuth, async (req, res) => {
    try {
        // Check permission
        if (!checkPermission(req.apiKeyData, 'query')) {
            return res.status(403).json({ error: 'Query permission required' });
        }

        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        console.log(`[OpenWebUI Search] Query: "${query}"`);

        // Use existing search functionality
        const searchParams = new URLSearchParams({
            q: query,
            limit: '5',
            fetchContent: 'true',
            contentLimit: '3'
        });

        // Make internal request to our search endpoint
        const searchUrl = `http://localhost:3080/api/search?${searchParams}`;
        const axios = require('axios');

        const response = await axios.get(searchUrl, {
            headers: {
                'X-API-Key': req.apiKeyData?.key || '',
                'X-API-Secret': req.apiKeyData?.secret || '',
                'Authorization': req.headers.authorization || ''
            },
            timeout: 30000
        });

        const searchResults = response.data.results || [];

        // Format for Open WebUI's expected structure
        const formattedResults = searchResults.map(r => ({
            title: r.title || 'Untitled',
            link: r.url || '',
            snippet: r.snippet || '',
            content: r.content || r.snippet || ''
        }));

        console.log(`[OpenWebUI Search] Found ${formattedResults.length} results`);

        res.json(formattedResults);

    } catch (error) {
        console.error('[OpenWebUI Search] Error:', error.message);
        res.status(500).json({ error: 'Search failed: ' + error.message });
    }
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

    // Try to broadcast error to connected clients
    try {
        broadcast({
            type: 'log',
            message: 'Server error occurred. Check logs for details.',
            level: 'error'
        });
    } catch (broadcastError) {
        console.error('Failed to broadcast error:', broadcastError);
    }

    // Don't expose internal error details to client
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // In production, use generic error messages to prevent information leakage
    const errorMessage = isDevelopment
        ? (err.message || 'Internal server error')
        : 'Request could not be processed';

    res.status(err.status || 500).json({
        error: errorMessage
        // Stack traces removed for security - check server logs for details
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

    // Detect the host models path for creating dynamic containers
    // This is critical for cross-platform compatibility (Windows+WSL, macOS, Linux)
    hostModelsPath = await detectHostModelsPath();
    console.log(`Host models path configured: ${hostModelsPath}`);

    // Load API key usage stats from disk
    const loadedStats = await loadApiKeyUsageStats();
    for (const [key, value] of loadedStats.entries()) {
        apiKeyUsageStats.set(key, value);
    }
    console.log(`Loaded usage stats for ${apiKeyUsageStats.size} API keys`);

    await initializeDefaultSkills();
    await initializeDefaultApiKeys();
    await syncModelInstances();
});

// Start HTTP redirect server if HTTPS is enabled
if (useHttps && httpRedirectServer) {
    httpRedirectServer.listen(HTTP_REDIRECT_PORT, () => {
        console.log(`HTTP redirect server listening on port ${HTTP_REDIRECT_PORT} -> redirects to HTTPS`);
    });
}
