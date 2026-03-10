const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Configuration
const PORT = process.env.PORT || 3002;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://host.docker.internal:3001';
// Use the same session secret as main webapp for shared authentication
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Session directory - matches main webapp location
const SESSION_DIR = process.env.SESSION_DIR || '/models/.modelserver/sessions';

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Session configuration - MUST match main webapp for shared authentication
const sessionConfig = {
    store: new FileStore({
        path: SESSION_DIR,
        ttl: 86400 * 7,
        retries: 3,
        secret: SESSION_SECRET,
        reapInterval: -1, // Disable automatic cleanup (matches main webapp)
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        httpOnly: true,
        maxAge: 86400 * 7 * 1000,
        sameSite: 'lax',
    },
    name: 'modelserver.sid', // Use same cookie name as main webapp
};

app.use(session(sessionConfig));

// Note: We intentionally DO NOT use express.json() or express.urlencoded() here
// because it would consume the request body before the proxy can forward it.
// All API requests are proxied to the main webapp which handles body parsing.

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Proxy all /api/* requests to the main webapp
const apiProxy = createProxyMiddleware({
    target: WEBAPP_URL,
    changeOrigin: true,
    secure: false, // Allow self-signed certs
    ws: true, // Proxy WebSocket connections
    onProxyReq: (proxyReq, req) => {
        // Forward session cookie
        if (req.headers.cookie) {
            proxyReq.setHeader('Cookie', req.headers.cookie);
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // Handle CORS for streaming responses
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    },
    onError: (err, req, res) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Backend service unavailable' });
        }
    },
});

// Apply proxy to all API routes
app.use('/api', apiProxy);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'chat-webapp' });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server with HTTPS
const startServer = () => {
    const certPath = path.join(__dirname, 'certs');
    const keyFile = path.join(certPath, 'server.key');
    const certFile = path.join(certPath, 'server.crt');

    // Generate self-signed certs if they don't exist
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
        console.log('Generating self-signed SSL certificates...');
        const { execSync } = require('child_process');
        fs.mkdirSync(certPath, { recursive: true });

        try {
            execSync(`openssl req -x509 -newkey rsa:4096 -keyout ${keyFile} -out ${certFile} -days 365 -nodes -subj "/CN=localhost"`, {
                stdio: 'pipe'
            });
            console.log('SSL certificates generated successfully');
        } catch (error) {
            console.error('Failed to generate SSL certificates:', error.message);
            console.log('Falling back to HTTP...');

            const httpServer = http.createServer(app);
            httpServer.listen(PORT, '0.0.0.0', () => {
                console.log(`Chat webapp running on http://localhost:${PORT}`);
            });
            return;
        }
    }

    const httpsOptions = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
    };

    const server = https.createServer(httpsOptions, app);

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Chat webapp running on https://localhost:${PORT}`);
    });

    // Handle WebSocket upgrade
    server.on('upgrade', (req, socket, head) => {
        apiProxy.upgrade(req, socket, head);
    });
};

startServer();
