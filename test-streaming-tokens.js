#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

// Test configuration (using Koda CLI Test Key with admin permissions)
const API_KEY = 'a1b4ca600f47d36296a69931eb9905791472d93245f83ab3dd16a7df016ebbfa';
const API_SECRET = 'joVleuaqJLtMykas5nDgg71trt2S3jo8wrEDhZ8LavxV0dFLsKM89IIkGaEBYyF6';
const API_URL = 'https://localhost:3001';
const API_KEYS_FILE = '/home/webapp/lmstudio/models/.modelserver/api-keys.json';

// Helper to get current token stats
function getCurrentTokenStats() {
    try {
        const apiKeys = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
        const testKey = apiKeys.find(k => k.key === API_KEY);
        if (!testKey) {
            console.error('Test API key not found');
            return null;
        }
        return {
            id: testKey.id,
            name: testKey.name,
            rateLimitTokens: testKey.rateLimitTokens
        };
    } catch (error) {
        console.error('Error reading API keys:', error.message);
        return null;
    }
}

// Helper to make streaming request
function makeStreamingRequest(message) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            message: message,
            maxTokens: 100
        });

        const options = {
            hostname: 'localhost',
            port: 3001,
            path: '/api/chat/stream',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-API-Key': API_KEY,
                'X-API-Secret': API_SECRET
            },
            rejectUnauthorized: false // Allow self-signed certificate
        };

        const req = https.request(options, (res) => {
            let fullResponse = '';
            let tokenStats = null;

            console.log(`\n[Response] Status: ${res.statusCode}`);
            console.log(`[Response] Headers:`, res.headers);

            res.on('data', (chunk) => {
                const chunkStr = chunk.toString();
                process.stdout.write(chunkStr); // Show raw stream

                // Parse SSE events
                const lines = chunkStr.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.token) {
                                fullResponse += data.token;
                            }
                            if (data.done && data.tokens) {
                                tokenStats = data.tokens;
                                console.log(`\n[Token Stats] Received from stream:`, tokenStats);
                            }
                        } catch (e) {
                            // Skip parsing errors
                        }
                    }
                }
            });

            res.on('end', () => {
                console.log('\n[Stream] Ended');
                resolve({
                    response: fullResponse,
                    tokens: tokenStats
                });
            });
        });

        req.on('error', (error) => {
            console.error('[Request Error]:', error.message);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Helper to get API key usage stats from webapp API
function getApiKeyUsageFromAPI() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3001,
            path: '/api/api-keys',
            method: 'GET',
            headers: {
                'X-API-Key': API_KEY,
                'X-API-Secret': API_SECRET
            },
            rejectUnauthorized: false
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const apiKeys = JSON.parse(data);
                    // API returns an array of key objects with stats embedded
                    const testKey = Array.isArray(apiKeys) ? apiKeys.find(k => k.key === API_KEY) : null;
                    resolve(testKey?.stats || null);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Main test function
async function runTest() {
    console.log('='.repeat(80));
    console.log('STREAMING CHAT TOKEN TRACKING TEST');
    console.log('='.repeat(80));

    // Get initial stats
    const keyInfo = getCurrentTokenStats();
    if (!keyInfo) {
        console.error('Failed to get API key info');
        process.exit(1);
    }

    console.log(`\n[Test Key] ID: ${keyInfo.id}`);
    console.log(`[Test Key] Name: ${keyInfo.name}`);
    console.log(`[Test Key] Token Limit: ${keyInfo.rateLimitTokens}`);

    // Get initial usage from API
    console.log('\n[Pre-Test] Getting current usage stats from API...');
    let initialUsage;
    try {
        initialUsage = await getApiKeyUsageFromAPI();
        console.log('[Pre-Test] Initial Usage:', initialUsage);
    } catch (error) {
        console.error('[Pre-Test] Failed to get initial usage:', error.message);
    }

    // Make streaming request
    console.log('\n[Test] Making streaming chat request...');
    console.log('[Test] Message: "Write a haiku about coding"');
    console.log('-'.repeat(80));

    let result;
    try {
        result = await makeStreamingRequest('Write a haiku about coding');
    } catch (error) {
        console.error('[Test] Request failed:', error.message);
        process.exit(1);
    }

    // Wait a bit for stats to update
    console.log('\n[Test] Waiting 2 seconds for stats to update...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get final usage from API
    console.log('[Post-Test] Getting updated usage stats from API...');
    let finalUsage;
    try {
        finalUsage = await getApiKeyUsageFromAPI();
        console.log('[Post-Test] Final Usage:', finalUsage);
    } catch (error) {
        console.error('[Post-Test] Failed to get final usage:', error.message);
    }

    // Verify token tracking
    console.log('\n' + '='.repeat(80));
    console.log('TEST RESULTS');
    console.log('='.repeat(80));

    if (result.tokens) {
        console.log('\n✓ Token stats received in stream');
        console.log(`  Prompt tokens: ${result.tokens.prompt_tokens}`);
        console.log(`  Completion tokens: ${result.tokens.completion_tokens}`);
        console.log(`  Total tokens: ${result.tokens.total_tokens}`);
    } else {
        console.log('\n✗ No token stats received in stream');
    }

    if (initialUsage && finalUsage) {
        const tokenDiff = finalUsage.tokenCount - initialUsage.tokenCount;
        const requestDiff = finalUsage.requestCount - initialUsage.requestCount;

        console.log('\n✓ Usage stats comparison:');
        console.log(`  Initial token count: ${initialUsage.tokenCount}`);
        console.log(`  Final token count: ${finalUsage.tokenCount}`);
        console.log(`  Token difference: ${tokenDiff}`);
        console.log(`  Request difference: ${requestDiff}`);

        if (result.tokens && tokenDiff === result.tokens.total_tokens) {
            console.log('\n✓✓ SUCCESS: Token usage was tracked correctly!');
            console.log(`   Expected ${result.tokens.total_tokens} tokens, got ${tokenDiff} tokens difference`);
        } else if (tokenDiff > 0) {
            console.log('\n⚠ PARTIAL SUCCESS: Tokens were tracked, but count may differ slightly');
            console.log(`   Expected ${result.tokens?.total_tokens || 'unknown'} tokens, got ${tokenDiff} tokens difference`);
        } else {
            console.log('\n✗✗ FAILURE: Token usage was NOT tracked!');
            console.log(`   Expected ${result.tokens?.total_tokens || 'unknown'} tokens, but usage did not increase`);
        }
    } else {
        console.log('\n✗ Could not compare usage stats (API call failed)');
    }

    console.log('\n' + '='.repeat(80));
}

// Run the test
runTest().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
