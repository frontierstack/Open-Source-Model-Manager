#!/usr/bin/env node
// End-to-end verification that tool usage SHOWS UP in the web chat.
//
// Two parts:
//   A. Server emits the SSE events the UI needs (tool_executing,
//      tool_result) during a real chat stream that triggers a tool.
//   B. When a conversation has toolCalls saved on its messages, the
//      chat UI renders them as chips via ToolCallBlock.
//
// Part A hits the real /api/chat/stream. Part B uses Playwright with
// mocked conversation endpoints to inject fixture data.
//
// Usage:
//   docker cp test-tool-chip-ui.js modelserver-webapp-1:/usr/src/app/
//   docker exec -e API_KEY=... -e API_SECRET=... modelserver-webapp-1 \
//       node /usr/src/app/test-tool-chip-ui.js

const https = require('https');
const { chromium } = require('playwright');

const BACKEND = process.env.BACKEND_URL || 'https://webapp:3001';
const CHAT = process.env.CHAT_URL || 'https://chat:3002';
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
if (!API_KEY || !API_SECRET) {
    console.error('API_KEY and API_SECRET required in env');
    process.exit(2);
}

function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(BACKEND + path);
        const data = body ? JSON.stringify(body) : null;
        const r = https.request({
            method, hostname: u.hostname, port: u.port, path: u.pathname,
            rejectUnauthorized: false,
            headers: { 'X-API-Key': API_KEY, 'X-API-Secret': API_SECRET,
                       ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
        }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => resolve({ status: res.statusCode,
                body: (() => { try { return JSON.parse(out); } catch { return out; } })() }));
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

// --- A. Server emits tool events ---------------------------------------
async function testServerEmitsEvents() {
    const inst = await req('GET', '/api/llamacpp/instances');
    const model = (Array.isArray(inst.body) && inst.body[0]?.name) || null;
    if (!model) {
        console.log('  ~  no running model — skipping live stream test');
        return { skipped: true };
    }

    const counts = { tool_executing: 0, tool_result: 0, content: 0 };
    let sawName = null;
    await new Promise((resolve, reject) => {
        const u = new URL(BACKEND + '/api/chat/stream');
        const body = JSON.stringify({
            message: 'Use web_search to find what Rust is in one sentence.',
            model, maxTokens: 200,
        });
        const r = https.request({
            method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
            rejectUnauthorized: false,
            headers: { 'X-API-Key': API_KEY, 'X-API-Secret': API_SECRET,
                       'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let buf = '';
            res.on('data', c => {
                buf += c;
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl).trimEnd();
                    buf = buf.slice(nl + 1);
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6);
                    if (raw === '[DONE]') return;
                    try {
                        const ev = JSON.parse(raw);
                        if (ev.type === 'tool_executing') { counts.tool_executing++; sawName = ev.name; }
                        else if (ev.type === 'tool_result') counts.tool_result++;
                        else if (ev.choices) counts.content++;
                    } catch (_) {}
                }
            });
            res.on('end', resolve);
        });
        r.on('error', reject);
        r.setTimeout(60_000, () => { r.destroy(new Error('stream timeout')); });
        r.write(body);
        r.end();
    });

    console.log(`  counts: tool_executing=${counts.tool_executing} tool_result=${counts.tool_result} content=${counts.content}  (tool name=${sawName})`);
    const ok = counts.tool_executing >= 1 && counts.tool_result >= 1 && counts.content >= 1;
    return { ok, counts, sawName };
}

// --- B. UI renders chips from saved message ----------------------------
async function testUiRendersChips() {
    const conv = { id: 'c-fixture', title: 'chip test',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const full = {
        id: 'c-fixture',
        messages: [
            { id: 'm1', role: 'user', content: 'use web_search', timestamp: new Date().toISOString() },
            { id: 'm2', role: 'assistant',
              content: 'Rust is a systems programming language focused on safety.',
              timestamp: new Date().toISOString(),
              toolCalls: [
                  { type: 'native_tool_call', label: 'web_search',
                    query: 'query: what is Rust programming language',
                    durationMs: 1240, status: 'success',
                    preview: '{"count":3}',
                    sources: [
                        { url: 'https://www.rust-lang.org',
                          title: 'Rust Programming Language',
                          snippet: 'A language empowering everyone to build reliable software.' },
                        { url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
                          title: 'Rust - Wikipedia',
                          snippet: 'Rust is a multi-paradigm, general-purpose programming language...' },
                        { url: 'https://doc.rust-lang.org/book/',
                          title: 'The Rust Programming Language Book',
                          snippet: 'The ultimate introduction to Rust.' },
                    ] },
                  { type: 'native_tool_call', label: 'load_skill',
                    query: 'name: summarize-url',
                    durationMs: 85, status: 'success',
                    preview: '{"id":"summarize-url"}' },
              ],
            },
        ],
    };

    const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
    try {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();

        await page.route('**/api/auth/me', r => r.fulfill({ status:200, contentType:'application/json',
            body: JSON.stringify({ user:{id:'t',username:'t',email:'t'} }) }));
        await page.route('**/api/conversations', r => r.fulfill({ status:200, contentType:'application/json',
            body: JSON.stringify([conv]) }));
        await page.route('**/api/conversations/**', r => {
            const u = r.request().url();
            if (u.endsWith('/streaming')) return r.fulfill({ status:200, contentType:'application/json', body:'{"active":false}' });
            if (u.endsWith('/messages')) return r.fulfill({ status:200, contentType:'application/json', body:'{"ok":true}' });
            return r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(full) });
        });
        await page.route('**/api/llamacpp/instances', r => r.fulfill({ status:200, contentType:'application/json',
            body: JSON.stringify([{name:'test-model',status:'running',backend:'llamacpp',port:8001}]) }));
        await page.route('**/api/vllm/instances', r => r.fulfill({ status:200, contentType:'application/json', body: '[]' }));
        await page.route('**/api/system-prompts', r => r.fulfill({ status:200, contentType:'application/json', body: '[]' }));
        await page.route('**/api/models**', r => r.fulfill({ status:200, contentType:'application/json', body: '[]' }));

        await page.goto(CHAT, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await page.locator('text=chip test').first().click();
        await page.waitForTimeout(1500);

        // Expand the web_search chip — SearchSources renders inside the
        // expanded body (hasDetail gates the expand).
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const chipBtn = buttons.find(b => /web_search/.test(b.textContent || ''));
            if (chipBtn) chipBtn.click();
        });
        await page.waitForTimeout(400);

        const findings = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const links = Array.from(document.querySelectorAll('a[href]'))
                .map(a => a.getAttribute('href'))
                .filter(h => /^https?:/.test(h));
            return {
                has_web_search: /web_search/.test(bodyText),
                has_load_skill: /load_skill/.test(bodyText),
                has_timing: /1\.2s|85ms/.test(bodyText),
                has_assistant_text: /Rust is a systems/.test(bodyText),
                has_3_sources_badge: /3 sources/.test(bodyText),
                source_links: links.filter(u => u.includes('rust-lang.org') || u.includes('wikipedia.org')),
            };
        });
        return findings;
    } finally {
        await browser.close();
    }
}

// -----------------------------------------------------------------------
(async () => {
    let pass = 0, fail = 0;
    const ok = (label, cond) => {
        if (cond) { console.log(`  [32m✓[0m ${label}`); pass++; }
        else      { console.log(`  [31m✗[0m ${label}`); fail++; }
    };

    console.log('\n[1;36mA. Server emits tool events during live stream[0m');
    const a = await testServerEmitsEvents();
    if (!a.skipped) {
        ok('tool_executing event fired', a.counts.tool_executing >= 1);
        ok('tool_result event fired', a.counts.tool_result >= 1);
        ok('text content streamed after tool result', a.counts.content >= 1);
    }

    console.log('\n[1;36mB. UI renders chips for saved toolCalls[0m');
    const b = await testUiRendersChips();
    ok('web_search chip visible', b.has_web_search);
    ok('load_skill chip visible', b.has_load_skill);
    ok('timing ("1.2s" / "85ms") visible', b.has_timing);
    ok('assistant message text visible', b.has_assistant_text);
    ok('"3 sources" badge visible on web_search chip', b.has_3_sources_badge);
    ok('source links rendered (rust-lang.org / wikipedia.org)',
        b.source_links.length >= 2);

    console.log(`\n  [1m${pass} passed, ${fail} failed[0m\n`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
