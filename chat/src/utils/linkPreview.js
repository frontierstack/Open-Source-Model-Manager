// Background loader for source-chip screenshots (WordPress mshots).
//
// mshots generates lazily: the first request for a page answers with a 307 to a
// 400×300 "generating…" GIF and starts rendering; only a request made after the
// render finishes (~3–10 s) gets the real 640×400 JPEG. The chips used to warm
// the URL ONCE — which only ever fetched the placeholder — and then did nothing
// until the user hovered, so the popup opened on a spinner and waited out the
// render every time. This module keeps polling each visible source until the
// real screenshot is in the browser cache, so a hover shows it instantly.

const SHOT_W = 640;
const SHOT_H = 400;
// Delay before each attempt (ms). ~45 s in total, then give up (text-only card).
const DELAYS = [0, 2500, 3000, 4000, 5000, 7000, 9000, 14000];
const MAX_IN_FLIGHT = 6;

const entries = new Map();   // url -> entry
const queue = [];            // entries waiting for a network slot
let inFlight = 0;

export function shotUrl(url, attempt = 0) {
    const base = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${SHOT_W}&h=${SHOT_H}`;
    return attempt ? `${base}&r=${attempt}` : base;
}

function view(e) {
    return { status: e.status, src: e.src, img: e.img || null };
}

function notify(e) {
    for (const fn of e.listeners) {
        try { fn(view(e)); } catch (_) { /* a listener must not break the loader */ }
    }
}

function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
        const e = queue.shift();
        e.queued = false;
        attempt(e);
    }
}

function enqueue(e, urgent) {
    if (e.queued || e.loading) return;
    e.queued = true;
    if (urgent) queue.unshift(e); else queue.push(e);
    pump();
}

function schedule(e) {
    const delay = DELAYS[e.attempt];
    if (delay === undefined) {
        e.status = 'failed';
        notify(e);
        return;
    }
    e.nextAt = Date.now() + delay;
    e.timer = setTimeout(() => { e.timer = null; enqueue(e, false); }, delay);
}

// Our own renderer (GET /api/link-preview, see webapp services/linkPreview.js)
// is asked first: it usually has the page already, because the server queued
// it the moment the web call returned. 202 = still rendering → ask again soon;
// anything else that is not an image → fall back to mshots.
const OWN_DELAYS = [0, 1500, 2500, 4000, 6000, 9000];

function attemptOwn(e) {
    e.loading = true;
    inFlight++;
    const done = () => { e.loading = false; inFlight = Math.max(0, inFlight - 1); e.lastAt = Date.now(); };
    const fallBack = () => { e.mode = 'mshots'; e.attempt = 0; schedule(e); };
    fetch(`/api/link-preview?url=${encodeURIComponent(e.url)}&wait=8000`, { credentials: 'same-origin' })
        .then(async (res) => {
            if (res.status === 202) {
                done();
                e.ownAttempt = (e.ownAttempt || 0) + 1;
                if (e.ownAttempt >= OWN_DELAYS.length) fallBack();
                else { e.nextAt = Date.now() + OWN_DELAYS[e.ownAttempt]; e.timer = setTimeout(() => { e.timer = null; enqueue(e, false); }, OWN_DELAYS[e.ownAttempt]); }
                pump();
                return;
            }
            const type = res.headers.get('content-type') || '';
            if (!res.ok || !type.startsWith('image/')) { done(); fallBack(); pump(); return; }
            const blob = await res.blob();
            const src = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                done();
                e.status = 'ready'; e.src = src; e.img = img;
                notify(e);
                pump();
            };
            img.onerror = () => { done(); URL.revokeObjectURL(src); fallBack(); pump(); };
            img.src = src;
        })
        .catch(() => { done(); fallBack(); pump(); });
}

function attempt(e) {
    if (e.mode !== 'mshots') { attemptOwn(e); return; }
    e.loading = true;
    inFlight++;
    const n = e.attempt;
    const src = shotUrl(e.url, n);
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const done = () => {
        e.loading = false;
        inFlight = Math.max(0, inFlight - 1);
        e.lastAt = Date.now();
    };
    img.onload = () => {
        done();
        // The placeholder is a 400×300 GIF; the real screenshot is exactly the
        // size we asked for.
        if (img.naturalWidth === SHOT_W && img.naturalHeight === SHOT_H) {
            e.status = 'ready';
            e.src = src;
            // Keep the DECODED element: the popup shows this exact node, so a
            // hover needs no network request (measured: a freshly generated
            // screenshot was re-downloaded on every hover, ~0.3 s each).
            e.img = img;
            notify(e);
        } else {
            e.attempt = n + 1;
            schedule(e);
        }
        pump();
    };
    img.onerror = () => {
        done();
        e.errors = (e.errors || 0) + 1;
        if (e.errors >= 3) { e.status = 'failed'; notify(e); }
        else { e.attempt = n + 1; schedule(e); }
        pump();
    };
    img.src = src;
}

function entryFor(url) {
    let e = entries.get(url);
    if (!e) {
        e = { url, status: 'idle', src: null, attempt: 0, mode: 'own', ownAttempt: 0, listeners: new Set(), timer: null, queued: false, loading: false, lastAt: 0 };
        entries.set(url, e);
    }
    return e;
}

/**
 * Start (or hurry) loading the screenshot for `url`.
 * `urgent` — the user is looking at it now: jump the queue, and skip what is
 * left of a back-off wait that has already run for a while.
 */
export function warmPreview(url, { urgent = false } = {}) {
    if (!url) return;
    const e = entryFor(url);
    if (e.status === 'idle') {
        e.status = 'pending';
        notify(e);
        enqueue(e, urgent);
        return;
    }
    if (e.status !== 'pending' || !urgent) return;
    if (e.timer && Date.now() - e.lastAt >= 1500) {
        clearTimeout(e.timer);
        e.timer = null;
        enqueue(e, true);
    } else if (e.queued) {
        const i = queue.indexOf(e);
        if (i > 0) { queue.splice(i, 1); queue.unshift(e); }
    }
}

export function getPreview(url) {
    const e = entries.get(url);
    return e ? view(e) : { status: 'idle', src: null, img: null };
}

export function subscribePreview(url, fn) {
    if (!url) return () => {};
    const e = entryFor(url);
    e.listeners.add(fn);
    return () => e.listeners.delete(fn);
}
