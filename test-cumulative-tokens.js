#!/usr/bin/env node

const https = require('https');

const API_KEY = 'a1b4ca600f47d36296a69931eb9905791472d93245f83ab3dd16a7df016ebbfa';
const API_SECRET = 'joVleuaqJLtMykas5nDgg71trt2S3jo8wrEDhZ8LavxV0dFLsKM89IIkGaEBYyF6';

function makeStreamingRequest(message) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ message, maxTokens: 50 });
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
            rejectUnauthorized: false
        };

        const req = https.request(options, (res) => {
            let tokenStats = null;
            res.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.done && data.tokens) {
                                tokenStats = data.tokens;
                            }
                        } catch (e) {}
                    }
                }
            });
            res.on('end', () => resolve(tokenStats));
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function getApiKeyStats() {
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
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const apiKeys = JSON.parse(data);
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

async function runTest() {
    console.log('='.repeat(80));
    console.log('CUMULATIVE TOKEN TRACKING TEST');
    console.log('='.repeat(80));

    const initialStats = await getApiKeyStats();
    console.log('\n[Initial Stats]');
    console.log(`  Request Count: ${initialStats.requestCount}`);
    console.log(`  Token Count: ${initialStats.tokenCount}`);

    console.log('\n[Test] Running 3 streaming requests...\n');
    
    let totalExpectedTokens = 0;
    for (let i = 1; i <= 3; i++) {
        console.log(`Request ${i}:`);
        const tokens = await makeStreamingRequest(`Count to ${i}`);
        console.log(`  Tokens used: ${tokens.total_tokens}`);
        totalExpectedTokens += tokens.total_tokens;
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n[Expected] Total new tokens: ${totalExpectedTokens}`);

    await new Promise(resolve => setTimeout(resolve, 1000));

    const finalStats = await getApiKeyStats();
    console.log('\n[Final Stats]');
    console.log(`  Request Count: ${finalStats.requestCount}`);
    console.log(`  Token Count: ${finalStats.tokenCount}`);

    const tokenDiff = finalStats.tokenCount - initialStats.tokenCount;
    const requestDiff = finalStats.requestCount - initialStats.requestCount;

    console.log('\n[Results]');
    console.log(`  Request difference: ${requestDiff} (expected: 3)`);
    console.log(`  Token difference: ${tokenDiff} (expected: ${totalExpectedTokens})`);

    if (tokenDiff === totalExpectedTokens && requestDiff === 3) {
        console.log('\n✓✓ SUCCESS: Cumulative token tracking works correctly!');
    } else {
        console.log('\n✗ FAILURE: Token tracking mismatch!');
    }

    console.log('='.repeat(80));
}

runTest().catch(console.error);
