const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Path to API keys file
const API_KEYS_FILE = path.join('/models/.modelserver', 'api-keys.json');

/**
 * Load API keys from file
 * @returns {Promise<Array>} Array of API key objects
 */
async function loadApiKeys() {
    try {
        const data = await fs.readFile(API_KEYS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Verify API key and secret
 * @param {string} apiKey - API key
 * @param {string} apiSecret - API secret
 * @returns {Promise<Object|null>} API key object if valid, null otherwise
 */
async function verifyApiKey(apiKey, apiSecret) {
    const keys = await loadApiKeys();
    const keyObj = keys.find(k => k.key === apiKey && k.secret === apiSecret);

    if (!keyObj) {
        return null;
    }

    // Check if key is enabled
    if (keyObj.enabled === false) {
        return null;
    }

    return keyObj;
}

/**
 * Verify Bearer token (matches API key)
 * @param {string} token - Bearer token
 * @returns {Promise<Object|null>} API key object if valid, null otherwise
 */
async function verifyBearerToken(token) {
    const keys = await loadApiKeys();
    const keyObj = keys.find(k => k.key === token);

    if (!keyObj) {
        return null;
    }

    // Check if key is enabled
    if (keyObj.enabled === false) {
        return null;
    }

    return keyObj;
}

/**
 * Check if user has required permission
 * @param {Object} keyObj - API key object or user session
 * @param {string} permission - Required permission
 * @returns {boolean} True if user has permission
 */
function hasPermission(keyObj, permission) {
    // If it's a session user (from passport), they have all permissions
    if (keyObj.username) {
        return true;
    }

    // If it's an API key, check permissions array
    if (keyObj.permissions && Array.isArray(keyObj.permissions)) {
        return keyObj.permissions.includes(permission) || keyObj.permissions.includes('admin');
    }

    return false;
}

/**
 * Hybrid authentication middleware
 * Supports three authentication methods:
 * 1. Session-based (Passport.js) - req.isAuthenticated()
 * 2. API Key + Secret headers (X-API-Key, X-API-Secret)
 * 3. Bearer token (Authorization: Bearer <token>)
 *
 * @param {Object} options - Middleware options
 * @param {string} options.permission - Required permission (optional)
 * @returns {Function} Express middleware
 */
function requireAuth(options = {}) {
    return async (req, res, next) => {
        try {
            // Method 1: Check session authentication (Passport.js)
            if (req.isAuthenticated && req.isAuthenticated()) {
                // Check if user account has been disabled
                if (req.user.status === 'disabled') {
                    // Destroy session and reject request
                    req.logout((err) => {
                        if (err) console.error('Error during logout:', err);
                    });
                    return res.status(403).json({ error: 'Account is disabled' });
                }

                req.userId = req.user.id;
                req.authMethod = 'session';
                req.authUser = req.user;

                // Check permission if required
                if (options.permission && !hasPermission(req.user, options.permission)) {
                    return res.status(403).json({ error: 'Insufficient permissions' });
                }

                return next();
            }

            // Method 2: Check API Key + Secret headers
            const apiKey = req.headers['x-api-key'];
            const apiSecret = req.headers['x-api-secret'];

            if (apiKey && apiSecret) {
                const keyObj = await verifyApiKey(apiKey, apiSecret);

                if (keyObj) {
                    req.userId = keyObj.userId || 'api-key-user';
                    req.authMethod = 'api-key';
                    req.authKeyObj = keyObj;

                    // Check permission if required
                    if (options.permission && !hasPermission(keyObj, options.permission)) {
                        return res.status(403).json({ error: 'Insufficient permissions' });
                    }

                    return next();
                }
            }

            // Method 3: Check Bearer token
            const authHeader = req.headers['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                const keyObj = await verifyBearerToken(token);

                if (keyObj) {
                    req.userId = keyObj.userId || 'bearer-token-user';
                    req.authMethod = 'bearer';
                    req.authKeyObj = keyObj;

                    // Check permission if required
                    if (options.permission && !hasPermission(keyObj, options.permission)) {
                        return res.status(403).json({ error: 'Insufficient permissions' });
                    }

                    return next();
                }
            }

            // No valid authentication method found
            return res.status(401).json({ error: 'Authentication required' });

        } catch (error) {
            console.error('Authentication error:', error);
            return res.status(500).json({ error: 'Authentication error' });
        }
    };
}

/**
 * Optional authentication middleware
 * Attempts to authenticate but doesn't require it
 * Sets req.userId if authenticated, otherwise continues
 */
function optionalAuth(req, res, next) {
    requireAuth()(req, res, (err) => {
        if (err) {
            // If there's an error, just continue without auth
            next();
        } else {
            // Authentication succeeded, continue
            next();
        }
    }).catch(() => {
        // If authentication fails, just continue without auth
        next();
    });
}

module.exports = {
    requireAuth,
    optionalAuth,
    hasPermission,
    verifyApiKey,
    verifyBearerToken
};
