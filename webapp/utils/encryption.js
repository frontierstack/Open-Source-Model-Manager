/**
 * Encryption Utility for Sensitive Data
 *
 * Uses AES-256-GCM for authenticated encryption of sensitive data
 * stored in JSON files (api-keys.json, etc.)
 *
 * The encryption key is derived from:
 * 1. ENCRYPTION_KEY environment variable (if set)
 * 2. Auto-generated key stored in /models/.modelserver/.encryption-key
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

// Key file location (inside data directory, not in repo)
const DATA_DIR = '/models/.modelserver';
const KEY_FILE = path.join(DATA_DIR, '.encryption-key');

let encryptionKey = null;

/**
 * Get or create the encryption key
 * Priority: ENV variable > stored key file > generate new
 */
function getEncryptionKey() {
    if (encryptionKey) {
        return encryptionKey;
    }

    // Check environment variable first
    if (process.env.ENCRYPTION_KEY) {
        const envKey = process.env.ENCRYPTION_KEY;
        // If it's a hex string, convert to buffer
        if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
            encryptionKey = Buffer.from(envKey, 'hex');
        } else {
            // Derive key from passphrase using PBKDF2
            encryptionKey = crypto.pbkdf2Sync(envKey, 'modelserver-salt', 100000, KEY_LENGTH, 'sha256');
        }
        console.log('[Encryption] Using encryption key from environment variable');
        return encryptionKey;
    }

    // Check for stored key file
    try {
        if (fs.existsSync(KEY_FILE)) {
            const keyHex = fs.readFileSync(KEY_FILE, 'utf8').trim();
            encryptionKey = Buffer.from(keyHex, 'hex');
            console.log('[Encryption] Using stored encryption key');
            return encryptionKey;
        }
    } catch (err) {
        console.error('[Encryption] Error reading key file:', err.message);
    }

    // Generate new key
    encryptionKey = crypto.randomBytes(KEY_LENGTH);

    // Save to file
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(KEY_FILE, encryptionKey.toString('hex'), { mode: 0o600 });
        console.log('[Encryption] Generated and stored new encryption key');
    } catch (err) {
        console.error('[Encryption] Error saving key file:', err.message);
        // Continue without saving - key will be regenerated on restart
        // This means existing encrypted data won't be readable
    }

    return encryptionKey;
}

/**
 * Encrypt a string value
 * @param {string} plaintext - The string to encrypt
 * @returns {string} Encrypted string in format: iv:authTag:ciphertext (all hex)
 */
function encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        return plaintext;
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Return format: iv:authTag:ciphertext
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string value
 * @param {string} encryptedData - Encrypted string in format: iv:authTag:ciphertext
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedData) {
    if (!encryptedData || typeof encryptedData !== 'string') {
        return encryptedData;
    }

    // Check if data is encrypted (contains two colons)
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
        // Not encrypted, return as-is (for backward compatibility)
        return encryptedData;
    }

    const [ivHex, authTagHex, ciphertext] = parts;

    // Validate hex strings
    if (!/^[0-9a-fA-F]+$/.test(ivHex) || !/^[0-9a-fA-F]+$/.test(authTagHex)) {
        // Not valid encrypted format, return as-is
        return encryptedData;
    }

    try {
        const key = getEncryptionKey();
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        console.error('[Encryption] Decryption failed:', err.message);
        // Return original data if decryption fails
        // This handles cases where data format looks encrypted but isn't
        return encryptedData;
    }
}

/**
 * Check if a string appears to be encrypted
 * @param {string} value - The string to check
 * @returns {boolean} True if the string appears to be encrypted
 */
function isEncrypted(value) {
    if (!value || typeof value !== 'string') {
        return false;
    }
    const parts = value.split(':');
    if (parts.length !== 3) {
        return false;
    }
    const [ivHex, authTagHex, ciphertext] = parts;
    // Check if all parts are valid hex and have expected lengths
    return /^[0-9a-fA-F]{32}$/.test(ivHex) &&  // 16 bytes = 32 hex chars
           /^[0-9a-fA-F]{32}$/.test(authTagHex) &&  // 16 bytes = 32 hex chars
           /^[0-9a-fA-F]+$/.test(ciphertext) &&
           ciphertext.length > 0;
}

/**
 * Encrypt sensitive fields in an API key object
 * @param {Object} apiKey - API key object with key, secret fields
 * @returns {Object} API key object with encrypted sensitive fields
 */
function encryptApiKey(apiKey) {
    if (!apiKey) return apiKey;

    const encrypted = { ...apiKey };

    // Encrypt the API key if not already encrypted
    if (apiKey.key && !isEncrypted(apiKey.key)) {
        encrypted.key = encrypt(apiKey.key);
    }

    // Encrypt the secret if present and not already encrypted
    if (apiKey.secret && !isEncrypted(apiKey.secret)) {
        encrypted.secret = encrypt(apiKey.secret);
    }

    return encrypted;
}

/**
 * Decrypt sensitive fields in an API key object
 * @param {Object} apiKey - API key object with encrypted key, secret fields
 * @returns {Object} API key object with decrypted sensitive fields
 */
function decryptApiKey(apiKey) {
    if (!apiKey) return apiKey;

    const decrypted = { ...apiKey };

    // Decrypt the API key
    if (apiKey.key) {
        decrypted.key = decrypt(apiKey.key);
    }

    // Decrypt the secret if present
    if (apiKey.secret) {
        decrypted.secret = decrypt(apiKey.secret);
    }

    return decrypted;
}

/**
 * Encrypt all API keys in an array
 * @param {Array} apiKeys - Array of API key objects
 * @returns {Array} Array with encrypted API key objects
 */
function encryptApiKeys(apiKeys) {
    if (!Array.isArray(apiKeys)) return apiKeys;
    return apiKeys.map(encryptApiKey);
}

/**
 * Decrypt all API keys in an array
 * @param {Array} apiKeys - Array of encrypted API key objects
 * @returns {Array} Array with decrypted API key objects
 */
function decryptApiKeys(apiKeys) {
    if (!Array.isArray(apiKeys)) return apiKeys;
    return apiKeys.map(decryptApiKey);
}

module.exports = {
    encrypt,
    decrypt,
    isEncrypted,
    encryptApiKey,
    decryptApiKey,
    encryptApiKeys,
    decryptApiKeys,
    getEncryptionKey
};
