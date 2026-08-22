/**
 * Shared "is this actually content?" helpers.
 *
 * A retrieval layer can return HTTP 200 and a healthy-looking payload that
 * contains no page content at all — a bot-protection wall, an error page, or (the
 * case that motivated this module) a blob of session tokens captured from the
 * page's own anti-bot XHRs. Nothing downstream could tell that apart from a real
 * page, so a change monitor snapshotted the token blob, compared junk to junk,
 * and reported "no change" on every run for weeks while the page changed daily.
 *
 * The test is deliberately about NOISE DOMINANCE, not length: a four-character
 * verdict ("NONE") is perfectly good content, while 2 KB of base64 session tokens
 * is not. Everything here is pure and dependency-free so the fetch cascade, the
 * browser service and the automation engine can all share one definition.
 *
 * The masking rules are mirrored in the `track_changes` skill (Python, runs in
 * the sandbox) — keep the two in step.
 */

// Volatile spans: values that differ on every fetch of the same unchanged page.
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[0-9a-fA-F]{0,16}\b/g;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const AGO_RE = /\b(?:about |over |almost |nearly )?\d+\+?\s*(?:sec(?:ond)?s?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?)\s+ago\b/gi;
const HEX_RE = /\b[0-9a-fA-F]{24,}\b/g;
const CHAIN_RE = /[A-Za-z0-9+/=_-]{8,}(?::[A-Za-z0-9+/=_-]{8,})+/g;
const RUN_RE = /[A-Za-z0-9+/=_.-]{24,}/g;

// Masking is OPAQUENESS-gated, never length-gated. A blanket "long run → noise"
// rule also eats ordinary long slugs ("unsloth/Llama-4-Scout-17B-16E-Instruct-UD-Q4_K_XL-GGUF",
// a jobs-board URL path) — which is precisely the text a page monitor exists to
// notice. Split on - _ / . and a real name never leaves an unbroken generated-
// looking stretch behind; a token always does.
function looksOpaque(token, minLen) {
    for (const seg of String(token).split(/[-_/.]+/)) {
        if (seg.length < minLen) continue;
        if (seg.includes('+') || seg.includes('=')) return true;
        const hasDigit = /\d/.test(seg);
        const hasAlpha = /[A-Za-z]/.test(seg);
        if (hasDigit && hasAlpha) return true;
        if (hasAlpha && !hasDigit && seg.length >= minLen + 12 && !/[aeiouAEIOU]/.test(seg)) return true;
    }
    return false;
}

function maskVolatile(text) {
    return String(text == null ? '' : text)
        .replace(UUID_RE, '~')
        .replace(ISO_RE, '~')
        .replace(AGO_RE, '~')
        .replace(HEX_RE, '~')
        .replace(CHAIN_RE, m => (looksOpaque(m, 14) ? '~' : m))
        .replace(RUN_RE, m => (looksOpaque(m, 24) ? '~' : m));
}

/** The part of the text that carries stable meaning (volatile spans removed). */
function signalText(text) {
    return maskVolatile(text).replace(/~+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** { length, signal, ratio } — ratio is the share of the body that is real text. */
function contentSignal(text) {
    const raw = String(text == null ? '' : text);
    const sig = signalText(raw);
    return { length: raw.length, signal: sig.length, ratio: raw.length ? sig.length / raw.length : 0 };
}

// Bot-wall / interstitial markers. Matched only against a SHORT body: a real
// article about CAPTCHAs or DDoS protection says all of these words too.
const BOT_WALL_RE = /(just a moment|checking your (?:browser|connection)|enable javascript(?: and cookies)?|attention required|verify(?:ing)? you are (?:a )?human|are you a robot|unusual traffic|access denied|request blocked|ddos protection|cf-browser-verification|cf_chl_|__cf_chl|awswaf|aws-waf|datadome|perimeterx|px-captcha|hcaptcha|recaptcha)/i;

function looksLikeBotWall(text, { maxSignal = 1500 } = {}) {
    const raw = String(text == null ? '' : text);
    if (!raw) return false;
    if (!BOT_WALL_RE.test(raw.slice(0, 20000))) return false;
    return signalText(raw).length < maxSignal;
}

// Hosts/paths that serve bot-protection, analytics or telemetry. Their JSON is
// never page content, so capturing it (and worse, presenting it AS the page) only
// pollutes whatever reads the result.
//
// Matched against the HOST and the PATH separately, on purpose. Substring-testing
// the whole URL is how a filter like this starts eating real data: "amplitude",
// "analytics" and "collect" are ordinary words that appear in legitimate
// first-party API paths (a site's own /api/analytics is exactly the data an
// extractor wants), while as third-party HOSTS they are unambiguous. Only paths
// that cannot plausibly be first-party content are listed below. Note this filter
// says nothing about the HTTP method — POST is a completely normal transport for
// real page data (GraphQL, site search), so method is not a signal.
const NON_CONTENT_HOST_RE = new RegExp([
    'awswaf', 'aws-waf', 'datadome', 'perimeterx', 'px-cloud', 'px-cdn',
    'hcaptcha', 'recaptcha', 'challenges\\.cloudflare', 'turnstile', 'captcha-delivery',
    'google-analytics', 'googletagmanager', 'doubleclick', 'segment\\.(?:io|com)',
    'mixpanel', 'amplitude\\.com', 'hotjar', 'fullstory', 'newrelic', 'nr-data',
    'sentry\\.io', 'bugsnag', 'clarity\\.ms', 'quantserve', 'scorecardresearch',
    'adservice', 'adsystem', 'adnxs', 'criteo', 'taboola', 'outbrain', 'branch\\.io',
].join('|'), 'i');
// Each pattern ends on a segment boundary so an ARTICLE about one of these
// ("/articles/captcha-explained") is not mistaken for the thing itself.
const NON_CONTENT_PATH_RE = /(\/cdn-cgi\/|\/awswaf(?:$|[/?])|\/captcha(?:$|[/?])|\/turnstile(?:$|[/?])|\/pagead\/|\/gtm\.js|\/telemetry(?:$|[/?])|\/beacon(?:$|[/?]))/i;

function isNonContentUrl(url) {
    const s = String(url || '');
    let u;
    try { u = new URL(s); } catch (_) { return NON_CONTENT_HOST_RE.test(s) || NON_CONTENT_PATH_RE.test(s); }
    return NON_CONTENT_HOST_RE.test(u.hostname) || NON_CONTENT_PATH_RE.test(u.pathname);
}

// A JSON payload whose keys are only session/telemetry plumbing.
const PLUMBING_KEY_RE = /^(token|tokens|session|session_?id|session_?storage|next_?interval|interval|expires?|expiry|ttl|ts|timestamp|nonce|challenge|captcha|cookie|csrf|uuid|guid|id|status|ok|success|refresh|retry|version|v)$/i;

function isPlumbingPayload(data) {
    if (!data || typeof data !== 'object') return false;
    const keys = Object.keys(Array.isArray(data) ? (data[0] || {}) : data);
    if (!keys.length || keys.length > 12) return false;
    return keys.every(k => PLUMBING_KEY_RE.test(k));
}

/**
 * Why `text` is not usable content, or null when it is.
 *
 * @param {object}  opts
 * @param {number}  opts.minRatio   share of readable text below which a body is
 *                                  judged noise (only applied past noiseFloor).
 * @param {number}  opts.noiseFloor bodies shorter than this are never judged by
 *                                  ratio — a short body is not a broken one.
 * @param {number}  opts.signalFloor absolute readable-text length that always
 *                                  counts as content regardless of ratio.
 */
function unusableContentReason(text, { minRatio = 0.15, noiseFloor = 200, signalFloor = 400 } = {}) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return 'the body is empty';
    if (looksLikeBotWall(raw)) return 'it is a bot-protection / challenge page, not the real content';
    const { ratio, signal } = contentSignal(raw);
    // Ratio ALONE would reject a real page carrying one big opaque payload — an
    // inline base64 logo, a checksum manifest, a digest list — so a body with a
    // healthy absolute amount of readable text is content no matter what share of
    // its bytes that is. Only a body that is both proportionally and absolutely
    // devoid of text is judged noise.
    if (raw.length >= noiseFloor && ratio < minRatio && signal < signalFloor) {
        return `it is ${Math.round(ratio * 100)}% opaque tokens/ids with almost no readable text `
            + '(session tokens or telemetry, not page content)';
    }
    return null;
}

// An error page served with a 200 (or presented as content by a fetch layer that
// dropped the status). Deliberately TITLE-anchored and length-gated: a real
// article about HTTP status codes says "404" in its body all day, but a page
// whose <title> is "Page Not Found" is not the article anyone asked for. This is
// what let a model conclude a URL was dead — and go hunting for mirrors —
// while the correct URL sat one transcription error away.
const ERROR_PAGE_TITLE_RE = /(page not found|404 not found|not found\s*[-–|]|error 404|\b404\b\s*[-–|:]|page (?:doesn't|does not) exist|no longer (?:available|exists)|page unavailable|oops[!,. ].{0,20}(?:not found|wrong))/i;

/**
 * Why this looks like an error page rather than the requested content, or null.
 * `title` is the strong signal; the body is only used to keep a long, real
 * article from being judged by a sloppy title.
 */
function errorPageReason(text, title, { maxSignal = 1800 } = {}) {
    const t = String(title || '');
    if (!t || !ERROR_PAGE_TITLE_RE.test(t)) return null;
    if (signalText(text).length >= maxSignal) return null;
    return `the page returned an error page ("${t.trim().slice(0, 80)}"), not the requested content`;
}

module.exports = {
    maskVolatile,
    signalText,
    contentSignal,
    looksOpaque,
    looksLikeBotWall,
    isNonContentUrl,
    isPlumbingPayload,
    unusableContentReason,
    errorPageReason,
    ERROR_PAGE_TITLE_RE,
    BOT_WALL_RE,
};
