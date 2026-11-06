'use strict';
// Page previews for the chat's source cards, rendered by OUR headless browser.
//
// The cards used WordPress mshots, a free screenshot service: a page it has not
// seen answers with a "generating…" placeholder for 4–10 s, and under load it
// answers 429 Too Many Requests — an HTML body Chrome blocks outright
// (ERR_BLOCKED_BY_ORB), so the card stayed text-only. Measured 2026-11-06:
// 0 of 4 fresh pages had a preview 15 s after hovering.
//
// Here: the `web` tool queues the pages it read (and the top search results)
// the moment it returns, a low-priority worker renders each with the warm
// browser pool (only while a browser is free for real work), the 640×400 JPEG
// is cached on disk for a day, and GET /api/link-preview serves it — so by the
// time the answer lands, the previews already exist.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DIR = '/models/.modelserver/link-previews';
const TTL_MS = parseInt(process.env.LINK_PREVIEW_TTL_MS, 10) || 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;
const MAX_FILES = parseInt(process.env.LINK_PREVIEW_MAX_FILES, 10) || 3000;
const QUEUE_MAX = 60;
const W = 640, H = 400;

let deps = null;            // { playwrightService, urlBlockReason, hostBlockReason }
const queue = [];           // urls waiting, most urgent first
const pending = new Map();  // url -> { promise, resolve }
let running = 0;
let pruneAt = 0;

function init(d) { deps = d; }
function keyOf(url) { return crypto.createHash('sha1').update(String(url)).digest('hex'); }
function fileOf(url) { return path.join(DIR, keyOf(url) + '.jpg'); }
function failOf(url) { return path.join(DIR, keyOf(url) + '.fail'); }

async function cached(url) {
    try {
        const st = await fsp.stat(fileOf(url));
        if (Date.now() - st.mtimeMs < TTL_MS) return fileOf(url);
    } catch (_) { /* none */ }
    return null;
}

async function failedRecently(url) {
    try {
        const st = await fsp.stat(failOf(url));
        return Date.now() - st.mtimeMs < FAIL_TTL_MS;
    } catch (_) { return false; }
}

function allowed(url) {
    if (!deps || !deps.playwrightService || typeof deps.playwrightService.capturePage !== 'function') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try { if (deps.urlBlockReason && deps.urlBlockReason(url)) return false; } catch (_) { return false; }
    try { if (deps.hostBlockReason && deps.hostBlockReason(url)) return false; } catch (_) { /* allow */ }
    return true;
}

/** Queue pages for a preview. `urgent` = a person is looking at the card now. */
function warm(urls, { urgent = false } = {}) {
    for (const u of [].concat(urls || [])) {
        const url = String(u || '').trim();
        if (!allowed(url)) continue;
        if (pending.has(url)) {
            if (urgent) { const i = queue.indexOf(url); if (i > 0) { queue.splice(i, 1); queue.unshift(url); } }
            continue;
        }
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        pending.set(url, { promise, resolve });
        if (urgent) queue.unshift(url); else queue.push(url);
        while (queue.length > QUEUE_MAX) { const drop = queue.pop(); const p = pending.get(drop); pending.delete(drop); if (p) p.resolve(null); }
    }
    pump();
}

function browserFree() {
    try {
        const st = deps.playwrightService.getPoolStatus();
        // Keep at least one browser slot for the model's own fetches.
        return st.inUse <= Math.max(0, st.maxSize - 2);
    } catch (_) { return true; }
}

function pump() {
    if (running >= 2 || !queue.length) return;
    if (!browserFree()) { const t = setTimeout(pump, 1500); if (t.unref) t.unref(); return; }
    const url = queue.shift();
    running++;
    render(url).catch(() => null).then((file) => {
        running--;
        const p = pending.get(url);
        pending.delete(url);
        if (p) p.resolve(file);
        pump();
    });
    // A second render may start if a browser is still free — checked once the
    // first one holds its browser, so the pool count is current.
    { const t = setTimeout(pump, 500); if (t.unref) t.unref(); }
}

async function render(url) {
    if (await cached(url)) return fileOf(url);
    if (await failedRecently(url)) return null;
    await fsp.mkdir(DIR, { recursive: true });
    const t0 = Date.now();
    const shot = await deps.playwrightService.capturePage(url, { timeout: 20000 });
    if (!shot || !shot.success || !shot.buffer) {
        await fsp.writeFile(failOf(url), String((shot && shot.error) || 'failed')).catch(() => {});
        console.log(`[linkPreview] ${url.slice(0, 100)} failed in ${Date.now() - t0}ms: ${String(shot && shot.error || '').slice(0, 100)}`);
        return null;
    }
    const { Jimp } = require('jimp');
    const img = await Jimp.read(shot.buffer);
    // Scale to the card width, keep the top: the header is what identifies a page.
    img.resize({ w: W });
    if (img.bitmap.height > H) img.crop({ x: 0, y: 0, w: W, h: H });
    const out = await img.getBuffer('image/jpeg', { quality: 74 });
    const file = fileOf(url);
    const tmp = file + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, out);
    await fsp.rename(tmp, file);
    console.log(`[linkPreview] ${url.slice(0, 100)} rendered in ${Date.now() - t0}ms (${out.length} bytes)`);
    if (Date.now() > pruneAt) { pruneAt = Date.now() + 10 * 60 * 1000; prune().catch(() => {}); }
    return file;
}

async function prune() {
    const names = await fsp.readdir(DIR).catch(() => []);
    const now = Date.now();
    const rows = [];
    for (const n of names) {
        const p = path.join(DIR, n);
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        const ttl = n.endsWith('.fail') ? FAIL_TTL_MS : TTL_MS;
        if (now - st.mtimeMs > ttl || n.endsWith('.tmp')) { await fsp.unlink(p).catch(() => {}); continue; }
        rows.push({ p, m: st.mtimeMs });
    }
    rows.sort((a, b) => a.m - b.m);
    for (const r of rows.slice(0, Math.max(0, rows.length - MAX_FILES))) await fsp.unlink(r.p).catch(() => {});
}

/**
 * The preview file for `url`, waiting up to `waitMs` for a render.
 * → { file } | { pending: true } | { failed: true } | { refused: true }
 */
async function get(url, { waitMs = 0 } = {}) {
    if (!allowed(url)) return { refused: true };
    const hit = await cached(url);
    if (hit) return { file: hit };
    if (await failedRecently(url)) return { failed: true };
    warm(url, { urgent: true });
    const p = pending.get(url);
    if (!p) return (await cached(url)) ? { file: fileOf(url) } : { failed: true };
    if (waitMs > 0) {
        const file = await Promise.race([p.promise, new Promise(r => { const t = setTimeout(() => r(undefined), waitMs); if (t.unref) t.unref(); })]);
        if (file) return { file };
        if (file === null) return { failed: true };
    }
    return { pending: true };
}

/** URLs worth previewing from a `web` tool result: pages read, then top search hits. */
function urlsFromWebResult(result) {
    if (!result || typeof result !== 'object' || result.success === false) return [];
    const out = [];
    const add = (u) => { if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
    if (result.mode === 'read' && result.url) add(result.finalUrl || result.url);
    if (Array.isArray(result.results)) {
        const isSearch = result.mode === 'search';
        const read = result.results.filter(r => r && r.content);
        for (const r of read) add(r.url);
        for (const r of result.results.slice(0, isSearch ? 3 : 4)) add(r && r.url);
    }
    if (Array.isArray(result.pages)) for (const p of result.pages.slice(0, 4)) add(p && p.url);
    return out.slice(0, 6);
}

module.exports = { init, warm, get, urlsFromWebResult, W, H };
