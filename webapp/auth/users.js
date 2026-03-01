const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Path to users data file
const USERS_FILE = path.join('/models/.modelserver', 'users.json');
const DATA_DIR = path.join('/models/.modelserver');

/**
 * Ensure the data directory exists
 */
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

/**
 * Load all users from the JSON file
 * @returns {Promise<Array>} Array of user objects
 */
async function loadUsers() {
    try {
        const data = await fs.readFile(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet, return empty array
            return [];
        }
        throw error;
    }
}

/**
 * Save users array to the JSON file
 * @param {Array} users - Array of user objects
 */
async function saveUsers(users) {
    await ensureDataDir();
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

/**
 * Get user by ID
 * @param {string} id - User ID
 * @returns {Promise<Object|null>} User object or null if not found
 */
async function getUserById(id) {
    const users = await loadUsers();
    return users.find(user => user.id === id) || null;
}

/**
 * Get user by username
 * @param {string} username - Username
 * @returns {Promise<Object|null>} User object or null if not found
 */
async function getUserByUsername(username) {
    const users = await loadUsers();
    return users.find(user => user.username.toLowerCase() === username.toLowerCase()) || null;
}

/**
 * Get user by email
 * @param {string} email - Email address
 * @returns {Promise<Object|null>} User object or null if not found
 */
async function getUserByEmail(email) {
    const users = await loadUsers();
    return users.find(user => user.email.toLowerCase() === email.toLowerCase()) || null;
}

/**
 * Create a new user
 * @param {Object} userData - User data
 * @param {string} userData.username - Username (required)
 * @param {string} userData.email - Email address (required)
 * @param {string} userData.password - Plain text password (required)
 * @param {string} userData.role - User role (optional, defaults to 'user')
 * @returns {Promise<Object>} Created user object (without password)
 */
async function createUser({ username, email, password, role = 'user' }) {
    // Validate required fields
    if (!username || !email || !password) {
        throw new Error('Username, email, and password are required');
    }

    // Check if username already exists
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
        throw new Error('Username already exists');
    }

    // Check if email already exists
    const existingEmail = await getUserByEmail(email);
    if (existingEmail) {
        throw new Error('Email already exists');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user object
    const user = {
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash,
        role,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Save to file
    const users = await loadUsers();
    users.push(user);
    await saveUsers(users);

    // Return user without password hash
    const { passwordHash: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
}

/**
 * Update user
 * @param {string} id - User ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated user object (without password)
 */
async function updateUser(id, updates) {
    const users = await loadUsers();
    const index = users.findIndex(user => user.id === id);

    if (index === -1) {
        throw new Error('User not found');
    }

    // Don't allow changing id or createdAt
    delete updates.id;
    delete updates.createdAt;

    // If updating password, hash it
    if (updates.password) {
        const salt = await bcrypt.genSalt(10);
        updates.passwordHash = await bcrypt.hash(updates.password, salt);
        delete updates.password;
    }

    // Update user
    users[index] = {
        ...users[index],
        ...updates,
        updatedAt: new Date().toISOString()
    };

    await saveUsers(users);

    // Return user without password hash
    const { passwordHash: _, ...userWithoutPassword } = users[index];
    return userWithoutPassword;
}

/**
 * Delete user
 * @param {string} id - User ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteUser(id) {
    const users = await loadUsers();
    const filtered = users.filter(user => user.id !== id);

    if (filtered.length === users.length) {
        throw new Error('User not found');
    }

    await saveUsers(filtered);
    return true;
}

/**
 * Get all users (without passwords)
 * @returns {Promise<Array>} Array of user objects
 */
async function getAllUsers() {
    const users = await loadUsers();
    return users.map(({ passwordHash: _, ...user }) => user);
}

/**
 * Change user password
 * @param {string} id - User ID
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<boolean>} True if password changed
 */
async function changePassword(id, currentPassword, newPassword) {
    const users = await loadUsers();
    const index = users.findIndex(user => user.id === id);

    if (index === -1) {
        throw new Error('User not found');
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, users[index].passwordHash);
    if (!isMatch) {
        throw new Error('Current password is incorrect');
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update user
    users[index].passwordHash = passwordHash;
    users[index].updatedAt = new Date().toISOString();

    await saveUsers(users);
    return true;
}

/**
 * Admin reset password (no current password required)
 * @param {string} username - Username
 * @param {string} newPassword - New password
 * @returns {Promise<boolean>} True if password reset
 */
async function adminResetPassword(username, newPassword) {
    const users = await loadUsers();
    const index = users.findIndex(user => user.username.toLowerCase() === username.toLowerCase());

    if (index === -1) {
        throw new Error('User not found');
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update user
    users[index].passwordHash = passwordHash;
    users[index].updatedAt = new Date().toISOString();

    await saveUsers(users);
    return true;
}

module.exports = {
    getUserById,
    getUserByUsername,
    getUserByEmail,
    createUser,
    updateUser,
    deleteUser,
    getAllUsers,
    changePassword,
    adminResetPassword,
    loadUsers,
    saveUsers
};
