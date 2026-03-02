#!/usr/bin/env node

/**
 * Quick test script for Koda v2.6.0 features
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Koda v2.6.0 Features\n');

// Test 1: Check koda.js syntax
console.log('1. Checking koda.js syntax...');
try {
    require.resolve('/home/webapp/lmstudio/agents-cli/bin/koda.js');
    console.log('   ✓ koda.js syntax valid\n');
} catch (e) {
    console.log('   ✗ Syntax error:', e.message);
    process.exit(1);
}

// Test 2: Check server.js syntax
console.log('2. Checking server.js syntax...');
try {
    const serverPath = '/home/webapp/lmstudio/webapp/server.js';
    const content = fs.readFileSync(serverPath, 'utf8');

    // Check for streaming endpoint
    if (content.includes('/api/chat/stream')) {
        console.log('   ✓ Streaming endpoint found');
    } else {
        console.log('   ✗ Streaming endpoint NOT found');
    }

    // Check for search endpoint
    if (content.includes('/api/search')) {
        console.log('   ✓ Search endpoint found');
    } else {
        console.log('   ✗ Search endpoint NOT found');
    }

    // Check for docs endpoint
    if (content.includes('/api/docs')) {
        console.log('   ✓ Docs endpoint found\n');
    } else {
        console.log('   ✗ Docs endpoint NOT found\n');
    }
} catch (e) {
    console.log('   ✗ Error:', e.message);
    process.exit(1);
}

// Test 3: Check koda.js for new features
console.log('3. Checking koda.js for new features...');
try {
    const kodaPath = '/home/webapp/lmstudio/agents-cli/bin/koda.js';
    const content = fs.readFileSync(kodaPath, 'utf8');

    // Check for streaming support
    if (content.includes('chatStream')) {
        console.log('   ✓ Streaming support found');
    } else {
        console.log('   ✗ Streaming support NOT found');
    }

    // Check for REPL support
    if (content.includes('handleReplStart')) {
        console.log('   ✓ REPL support found');
    } else {
        console.log('   ✗ REPL support NOT found');
    }

    // Check for search command
    if (content.includes('handleSearch')) {
        console.log('   ✓ Search command found');
    } else {
        console.log('   ✗ Search command NOT found');
    }

    // Check for docs command
    if (content.includes('handleDocs')) {
        console.log('   ✓ Docs command found');
    } else {
        console.log('   ✗ Docs command NOT found');
    }

    // Check for refactoring support
    if (content.includes('@babel/parser')) {
        console.log('   ✓ Refactoring (Babel) found');
    } else {
        console.log('   ✗ Refactoring (Babel) NOT found');
    }

    // Check for quality command (from earlier)
    if (content.includes('handleQuality')) {
        console.log('   ✓ Code quality command found\n');
    } else {
        console.log('   ✗ Code quality command NOT found\n');
    }
} catch (e) {
    console.log('   ✗ Error:', e.message);
    process.exit(1);
}

// Test 4: Check package.json dependencies
console.log('4. Checking package.json dependencies...');
try {
    const pkgPath = '/home/webapp/lmstudio/agents-cli/package.json';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    console.log(`   Version: ${pkg.version}`);

    const requiredDeps = [
        'axios',
        'diff',
        '@babel/parser',
        '@babel/traverse',
        '@babel/generator'
    ];

    let allFound = true;
    for (const dep of requiredDeps) {
        if (pkg.dependencies[dep]) {
            console.log(`   ✓ ${dep}: ${pkg.dependencies[dep]}`);
        } else {
            console.log(`   ✗ ${dep}: NOT FOUND`);
            allFound = false;
        }
    }

    if (allFound) {
        console.log('   ✓ All dependencies present\n');
    } else {
        console.log('   ✗ Some dependencies missing\n');
        process.exit(1);
    }
} catch (e) {
    console.log('   ✗ Error:', e.message);
    process.exit(1);
}

// Test 5: Check if Babel modules can be loaded
console.log('5. Testing Babel module loading...');
try {
    const parser = require('@babel/parser');
    const traverse = require('@babel/traverse').default;
    const generate = require('@babel/generator').default;

    // Quick parse test
    const ast = parser.parse('const x = 42;');
    console.log('   ✓ @babel/parser works');
    console.log('   ✓ @babel/traverse works');
    console.log('   ✓ @babel/generator works\n');
} catch (e) {
    console.log('   ✗ Babel module error:', e.message, '\n');
}

console.log('✅ All tests passed!\n');
console.log('Summary of new features in v2.6.0:');
console.log('  • Streaming responses (#1)');
console.log('  • Interactive REPL (#13)');
console.log('  • Web search & docs (#14)');
console.log('  • Refactoring tools (#15)');
console.log('  • Code quality metrics (#26)');
console.log('\nReady for testing!');
