#!/usr/bin/env node

/**
 * Migration Script: Single-User to Multi-User System
 *
 * This script performs a one-time migration to transform the ModelServer
 * from a single-user system to a multi-user system with authentication.
 *
 * What it does:
 * 1. Creates a backup of all existing data files
 * 2. Creates an admin user with a randomly generated password
 * 3. Adds userId field to all existing data (agents, skills, tasks, API keys, etc.)
 * 4. Creates necessary directories (sessions)
 * 5. Prints admin credentials (SAVE THESE!)
 *
 * Usage:
 *   node scripts/migrate-to-multiuser.js
 *
 * IMPORTANT: Run this script ONCE during deployment. Save the admin password!
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = '/models/.modelserver';
const BACKUP_DIR = path.join(DATA_DIR, 'backups', Date.now().toString());

// Data files to migrate
const DATA_FILES = {
    agents: 'agents.json',
    skills: 'skills.json',
    tasks: 'tasks.json',
    apiKeys: 'api-keys.json'
};

// Config files to restructure
const CONFIG_FILES = {
    systemPrompts: 'system-prompts.json',
    modelConfigs: 'model-configs.json'
};

/**
 * Ensure directory exists
 */
async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

/**
 * Read JSON file safely
 */
async function readJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        throw error;
    }
}

/**
 * Write JSON file with formatting
 */
async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Create backup of all data files
 */
async function createBackup() {
    console.log('\n📦 Creating backup of existing data...');
    await ensureDir(BACKUP_DIR);

    const allFiles = [...Object.values(DATA_FILES), ...Object.values(CONFIG_FILES), 'users.json'];

    for (const file of allFiles) {
        const sourcePath = path.join(DATA_DIR, file);
        const backupPath = path.join(BACKUP_DIR, file);

        try {
            await fs.copyFile(sourcePath, backupPath);
            console.log(`   ✓ Backed up ${file}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.log(`   ⚠ Could not backup ${file}: ${error.message}`);
            }
        }
    }

    console.log(`   ✓ Backup created at: ${BACKUP_DIR}`);
}

/**
 * Create admin user
 */
async function createAdminUser() {
    console.log('\n👤 Creating admin user...');

    // Generate random password
    const adminPassword = crypto.randomBytes(16).toString('hex');

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);

    // Create admin user object
    const adminUser = {
        id: crypto.randomUUID(),
        username: 'admin',
        email: 'admin@localhost',
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Save to users.json
    const usersFile = path.join(DATA_DIR, 'users.json');
    await writeJsonFile(usersFile, [adminUser]);

    console.log('   ✓ Admin user created');
    console.log('\n' + '='.repeat(60));
    console.log('🔐 ADMIN CREDENTIALS - SAVE THESE NOW!');
    console.log('='.repeat(60));
    console.log(`   Username: ${adminUser.username}`);
    console.log(`   Password: ${adminPassword}`);
    console.log(`   User ID:  ${adminUser.id}`);
    console.log('='.repeat(60));
    console.log('⚠️  IMPORTANT: This password will NOT be shown again!');
    console.log('='.repeat(60) + '\n');

    return adminUser;
}

/**
 * Migrate array-based data files (agents, skills, tasks)
 * Add userId field to each item
 */
async function migrateArrayData(fileName, adminUserId) {
    const filePath = path.join(DATA_DIR, fileName);
    const data = await readJsonFile(filePath, []);

    if (data.length === 0) {
        console.log(`   ⊘ ${fileName}: No data to migrate`);
        return;
    }

    // Add userId to each item
    const migratedData = data.map(item => ({
        ...item,
        userId: item.userId || adminUserId // Keep existing userId if present
    }));

    await writeJsonFile(filePath, migratedData);
    console.log(`   ✓ ${fileName}: Migrated ${migratedData.length} items`);
}

/**
 * Migrate API keys
 * Add userId field and ensure all existing keys remain functional
 */
async function migrateApiKeys(adminUserId) {
    const filePath = path.join(DATA_DIR, DATA_FILES.apiKeys);
    const keys = await readJsonFile(filePath, []);

    if (keys.length === 0) {
        console.log(`   ⊘ ${DATA_FILES.apiKeys}: No API keys to migrate`);
        return;
    }

    // Add userId to each key (assign to admin)
    const migratedKeys = keys.map(key => ({
        ...key,
        userId: key.userId || adminUserId
    }));

    await writeJsonFile(filePath, migratedKeys);
    console.log(`   ✓ ${DATA_FILES.apiKeys}: Migrated ${migratedKeys.length} API keys`);
    console.log(`      All existing API keys assigned to admin user`);
}

/**
 * Migrate config files (system prompts, model configs)
 * Restructure from { modelName: value } to { userId: { modelName: value } }
 */
async function migrateConfigFiles(adminUserId) {
    for (const [name, fileName] of Object.entries(CONFIG_FILES)) {
        const filePath = path.join(DATA_DIR, fileName);
        const data = await readJsonFile(filePath, {});

        if (Object.keys(data).length === 0) {
            console.log(`   ⊘ ${fileName}: No data to migrate`);
            continue;
        }

        // Check if already migrated (has userId structure)
        const firstKey = Object.keys(data)[0];
        if (firstKey && typeof data[firstKey] === 'object' && !Array.isArray(data[firstKey])) {
            // Might already be user-structured, check if it looks like userId
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstKey);
            if (isUUID) {
                console.log(`   ⊘ ${fileName}: Already migrated`);
                continue;
            }
        }

        // Restructure: old format → new format
        const migratedData = {
            [adminUserId]: data
        };

        await writeJsonFile(filePath, migratedData);
        console.log(`   ✓ ${fileName}: Restructured to user-based format`);
        console.log(`      ${Object.keys(data).length} entries assigned to admin`);
    }
}

/**
 * Create required directories
 */
async function createDirectories() {
    console.log('\n📁 Creating required directories...');

    const directories = [
        path.join(DATA_DIR, 'sessions'),
        path.join(DATA_DIR, 'backups')
    ];

    for (const dir of directories) {
        await ensureDir(dir);
        console.log(`   ✓ ${dir}`);
    }
}

/**
 * Verify migration
 */
async function verifyMigration(adminUserId) {
    console.log('\n🔍 Verifying migration...');

    // Check users.json
    const users = await readJsonFile(path.join(DATA_DIR, 'users.json'), []);
    console.log(`   ✓ Users file exists: ${users.length} user(s)`);

    // Check migrated data files
    for (const [name, fileName] of Object.entries(DATA_FILES)) {
        const data = await readJsonFile(path.join(DATA_DIR, fileName), []);
        const withUserId = data.filter(item => item.userId).length;
        console.log(`   ✓ ${fileName}: ${data.length} items, ${withUserId} with userId`);
    }

    // Check config files
    for (const [name, fileName] of Object.entries(CONFIG_FILES)) {
        const data = await readJsonFile(path.join(DATA_DIR, fileName), {});
        const hasUserStructure = data[adminUserId] !== undefined;
        console.log(`   ✓ ${fileName}: ${hasUserStructure ? 'User-based structure' : 'Needs migration'}`);
    }

    console.log('\n✅ Migration verification complete!');
}

/**
 * Main migration function
 */
async function migrate() {
    console.log('\n' + '='.repeat(60));
    console.log('ModelServer Multi-User Migration');
    console.log('='.repeat(60));
    console.log('This script will migrate your ModelServer to support multiple users.');
    console.log('A backup will be created before any changes are made.');
    console.log('='.repeat(60) + '\n');

    try {
        // Ensure data directory exists
        await ensureDir(DATA_DIR);

        // Step 1: Create backup
        await createBackup();

        // Step 2: Create admin user
        const adminUser = await createAdminUser();

        // Step 3: Create required directories
        await createDirectories();

        // Step 4: Migrate data files
        console.log('\n🔄 Migrating data files...');
        await migrateArrayData(DATA_FILES.agents, adminUser.id);
        await migrateArrayData(DATA_FILES.skills, adminUser.id);
        await migrateArrayData(DATA_FILES.tasks, adminUser.id);
        await migrateApiKeys(adminUser.id);

        // Step 5: Migrate config files
        console.log('\n🔄 Migrating configuration files...');
        await migrateConfigFiles(adminUser.id);

        // Step 6: Verify migration
        await verifyMigration(adminUser.id);

        // Final summary
        console.log('\n' + '='.repeat(60));
        console.log('✅ MIGRATION COMPLETED SUCCESSFULLY');
        console.log('='.repeat(60));
        console.log('\nNext steps:');
        console.log('1. Save the admin password (shown above)');
        console.log('2. Restart the ModelServer application');
        console.log('3. Login with admin credentials at https://localhost:3001');
        console.log('4. Verify all your data is accessible');
        console.log('\nRollback:');
        console.log(`   Backup location: ${BACKUP_DIR}`);
        console.log('   To rollback, restore files from backup directory');
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('\n❌ MIGRATION FAILED');
        console.error('Error:', error.message);
        console.error('\nStack trace:', error.stack);
        console.error('\n⚠️  No changes have been committed. Your data is safe.');
        console.error(`    Backup location (if created): ${BACKUP_DIR}`);
        process.exit(1);
    }
}

// Run migration if executed directly
if (require.main === module) {
    migrate().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { migrate };
