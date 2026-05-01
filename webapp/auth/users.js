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
 * Check if any users exist (for first admin setup)
 * @returns {Promise<boolean>} True if users exist
 */
async function hasAnyUsers() {
    const users = await loadUsers();
    return users.length > 0;
}

/**
 * Create a pending user (admin invites user with email only)
 * User must complete registration with username and password
 * @param {string} email - Email address
 * @returns {Promise<Object>} Created pending user object
 */
async function createPendingUser(email) {
    if (!email) {
        throw new Error('Email is required');
    }

    // Check if email already exists
    const existingEmail = await getUserByEmail(email);
    if (existingEmail) {
        throw new Error('Email already exists');
    }

    // Create pending user object
    const user = {
        id: crypto.randomUUID(),
        email,
        status: 'pending', // pending, active, disabled
        role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Save to file
    const users = await loadUsers();
    users.push(user);
    await saveUsers(users);

    return user;
}

/**
 * Complete registration for a pending user
 * @param {string} email - Email address
 * @param {string} username - Username
 * @param {string} password - Password
 * @returns {Promise<Object>} Completed user object (without password)
 */
async function completeRegistration(email, username, password) {
    if (!email || !username || !password) {
        throw new Error('Email, username, and password are required');
    }

    const users = await loadUsers();
    const index = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());

    if (index === -1) {
        throw new Error('Email not found. Please contact an admin to be invited.');
    }

    if (users[index].status === 'active') {
        throw new Error('Account already activated');
    }

    // Don't disclose disabled state — fold into the same error as
    // "no invite found" so an attacker can't tell whether a given email
    // was previously invited and then disabled.
    if (users[index].status === 'disabled' || users[index].disabled === true) {
        throw new Error('Email not found. Please contact an admin to be invited.');
    }

    // Check if username already exists
    const existingUser = users.find(u => u.username && u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
        throw new Error('Username already exists');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Complete registration
    users[index] = {
        ...users[index],
        username,
        passwordHash,
        status: 'active',
        updatedAt: new Date().toISOString()
    };

    await saveUsers(users);

    const { passwordHash: _, ...userWithoutPassword } = users[index];
    return userWithoutPassword;
}

/**
 * Create a new user (full registration)
 * @param {Object} userData - User data
 * @param {string} userData.username - Username (required)
 * @param {string} userData.email - Email address (required)
 * @param {string} userData.password - Plain text password (required)
 * @param {string} userData.role - User role (optional, defaults to 'user')
 * @param {boolean} isFirstUser - If true, bypasses email pre-registration requirement
 * @returns {Promise<Object>} Created user object (without password)
 */
async function createUser({ username, email, password, role = 'user' }, isFirstUser = false) {
    // Validate required fields
    if (!username || !email || !password) {
        throw new Error('Username, email, and password are required');
    }

    const users = await loadUsers();

    // If not first user, check if email was pre-registered (pending user)
    if (!isFirstUser && users.length > 0) {
        const pendingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.status === 'pending');
        if (pendingUser) {
            // Complete the pending registration
            return completeRegistration(email, username, password);
        }
        // Email not pre-registered
        throw new Error('Email not pre-registered. Please contact an admin to be invited.');
    }

    // Check if username already exists
    const existingUser = users.find(u => u.username && u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
        throw new Error('Username already exists');
    }

    // Check if email already exists (active user)
    const existingEmail = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.status === 'active');
    if (existingEmail) {
        throw new Error('Email already exists');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // First user becomes admin
    const actualRole = users.length === 0 ? 'admin' : role;

    // Create user object
    const user = {
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash,
        role: actualRole,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Save to file
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
    const index = users.findIndex(user => user.username && user.username.toLowerCase() === username.toLowerCase());

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

/**
 * Self-service password reset (requires username, email, and current password)
 * @param {string} username - Username
 * @param {string} email - Email address
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<boolean>} True if password reset
 */
// Decoy bcrypt hash used to equalize timing between "user not found" and
// "wrong password". Must be a REAL bcrypt hash — malformed inputs make
// bcrypt.compare return instantly, re-introducing the timing leak.
// Generated via bcrypt.hashSync('decoy_for_timing_equalization', 10).
const _DECOY_RESET_HASH = '$2a$10$uVs2O5O9SU0oHC/48Sl2Oebx/9OtPJp4BovEXTEyCTIpgrmfxmWLe';

async function selfServicePasswordReset(username, email, currentPassword, newPassword) {
    // Reject non-string inputs up front. We still run bcrypt to keep timing
    // similar to the normal failure path.
    if (typeof username !== 'string' || typeof email !== 'string' ||
        typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        await bcrypt.compare('decoy', _DECOY_RESET_HASH);
        throw new Error('Invalid credentials');
    }

    const users = await loadUsers();
    const index = users.findIndex(user =>
        user.username &&
        user.username.toLowerCase() === username.toLowerCase() &&
        user.email.toLowerCase() === email.toLowerCase()
    );

    // Always run bcrypt — against the real hash if the (username,email) pair
    // exists, against a decoy otherwise — so the response time does not
    // reveal whether the user exists. The error message is also unified.
    const hashToCompare = (index !== -1 && users[index].passwordHash) || _DECOY_RESET_HASH;
    const isMatch = await bcrypt.compare(currentPassword, hashToCompare);

    // All failure modes return the SAME generic message. Disclosing
    // "account is disabled" or "user not found" lets an attacker confirm a
    // username/email pair and shape a targeted brute-force.
    if (index === -1 ||
        users[index].status === 'disabled' ||
        users[index].disabled === true ||
        !isMatch ||
        !users[index].passwordHash) {
        throw new Error('Invalid credentials');
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
 * Disable a user account
 * @param {string} id - User ID
 * @returns {Promise<Object>} Updated user object
 */
async function disableUser(id) {
    const users = await loadUsers();
    const index = users.findIndex(user => user.id === id);

    if (index === -1) {
        throw new Error('User not found');
    }

    // Can't disable the last admin
    if (users[index].role === 'admin') {
        const activeAdmins = users.filter(u => u.role === 'admin' && u.status === 'active');
        if (activeAdmins.length <= 1) {
            throw new Error('Cannot disable the only admin account');
        }
    }

    users[index].status = 'disabled';
    users[index].updatedAt = new Date().toISOString();

    await saveUsers(users);

    const { passwordHash: _, ...userWithoutPassword } = users[index];
    return userWithoutPassword;
}

/**
 * Enable a user account
 * @param {string} id - User ID
 * @returns {Promise<Object>} Updated user object
 */
async function enableUser(id) {
    const users = await loadUsers();
    const index = users.findIndex(user => user.id === id);

    if (index === -1) {
        throw new Error('User not found');
    }

    users[index].status = 'active';
    users[index].updatedAt = new Date().toISOString();

    await saveUsers(users);

    const { passwordHash: _, ...userWithoutPassword } = users[index];
    return userWithoutPassword;
}

module.exports = {
    getUserById,
    getUserByUsername,
    getUserByEmail,
    createUser,
    createPendingUser,
    completeRegistration,
    updateUser,
    deleteUser,
    disableUser,
    enableUser,
    getAllUsers,
    hasAnyUsers,
    changePassword,
    adminResetPassword,
    selfServicePasswordReset,
    loadUsers,
    saveUsers
};
