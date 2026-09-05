/**
 * Page-obstacle classifier — "why did this fetch not deliver the page?"
 *
 * A retrieval layer can answer 200 with a body that is not the page: a
 * Cloudflare / DataDome / Akamai interstitial, a cookie-consent wall, a login
 * wall, a paywall, an age gate, a geo block, a "please enable JavaScript"
 * shell. Every one of those used to reach the model as either an opaque
 * failure or, worse, as CONTENT — and the only hint it ever got named a tool
 * (`scrapling_fetch`) that is hidden from the catalog. So the model either
 * re-read the same URL the same way, or gave up.
 *
 * This module is the ONE definition of those obstacles, shared by the fetch
 * cascade (which uses it to decide whether a layer's answer is worth serving
 * or must escalate to the real browser), the browser service (which uses the
 * consent / age-gate vocabulary to dismiss overlays automatically) and the
 * `web` tool (which turns the verdict into a hint naming the exact next call).
 *
 * Pure and dependency-free. Everything is deliberately PRECISION-first: a
 * false "bot wall" over-escalates a benign page into a 15-25 s cascade or
 * fast-fails a working host, and a false "paywall" tells the model to abandon
 * an article it actually has. Vendor tokens are matched anywhere; generic
 * phrases ("access denied", "captcha", "sign in") only count when the body is
 * SHORT enough that the phrase is the page rather than a mention in prose.
 */

// ---------------------------------------------------------------------------
// Bot-protection / interstitial markers
// ---------------------------------------------------------------------------
// STRONG = tokens that identify an interstitial. Two tiers:
//   STRUCTURAL — the wall's own wording/plumbing ("Just a moment", "__cf_chl_",
//   an Akamai reference id, "Press & Hold"). Never in prose → any length.
//   VENDOR — a vendor NAME ("DataDome", "Imperva", "Cloudflare … Ray ID"). A
//   security article mentions these in prose, so they count only when the
//   readable body is short (VENDOR_MARKER_MAX_CHARS) — a real wall is short.
// Raw HTML is scanned only for a short page: Cloudflare injects
// `/cdn-cgi/challenge-platform/…/jsd/main.js` into ORDINARY pages it fronts.
const STRUCTURAL_WALL_MARKERS = [
    // Cloudflare
    /just a moment/i, /checking your browser/i, /checking if the site connection is secure/i,
    /cf-browser-verification/i, /__cf_chl_/i, /cf-turnstile/i,
    /attention required/i, /ddos protection by cloudflare/i,
    /error 10(?:15|20)\b/i, /sorry, you have been blocked/i,
    /needs to review the security of your connection/i, /enable javascript and cookies to continue/i,
    /verifying you are human/i, /verify(?:ing)? that you are not a (?:bot|robot)/i,
    /this process is automatic\. your browser will redirect/i,
    // PerimeterX / HUMAN
    /px-captcha/i, /press (?:&|and) hold/i, /_pxhc\b|_px3\b/i,
    // DataDome
    /captcha-delivery\.com/i, /geo\.captcha-delivery/i,
    // Imperva / Incapsula
    /_incapsula_/i, /incapsula incident id/i, /request unsuccessful\. incapsula/i,
    // Akamai Bot Manager: "Access Denied … Reference #18.2d1d1002.1717…"
    /reference\s*#\s*\d{1,3}\.[0-9a-f]{6,}\.\d{8,}/i,
    // Kasada
    /kpsdk/i, /ips\.js\?/i,
    // Queue-it waiting rooms
    /queue-it\.net/i, /you are now in line\b/i,
    // AWS WAF
    /aws-waf-token/i, /awswaf_session_storage/i, /x-amzn-waf/i,
    // Vercel / Shopify / others
    /vercel security checkpoint/i, /shopify[- ]challenge/i,
    /pardon our interruption/i, /anomaly-modal/i,
];
const VENDOR_WALL_MARKERS = [
    /cf-?challenge/i, /challenge-platform/i, /\bray id:/i, /perimeterx/i, /datadome/i,
    /imperva/i, /incapsula/i, /akamaighost/i, /awswaf/i, /distil networks/i, /sucuri/i, /unusual traffic/i,
];
const VENDOR_MARKER_MAX_CHARS = 1500;
const STRONG_WALL_MARKERS = [...STRUCTURAL_WALL_MARKERS, ...VENDOR_WALL_MARKERS];
// WEAK = generic phrases a security blog or a checkout page legitimately
// contains. They count as a wall only on a SHORT body (see WEAK_WALL_MAX_CHARS)
// and otherwise only as a soft hint.
const WEAK_WALL_MARKERS = [
    /\bcaptcha\b/i, /recaptcha/i, /hcaptcha/i, /h-captcha/i, /turnstile/i,
    /access denied/i, /one more step/i, /enable cookies/i, /bot detection/i,
    /are you a (?:robot|human)/i, /please verify you(?:'| a)re human/i,
    /you have been blocked/i, /request blocked/i, /forbidden/i, /blocked by/i,
    /too many requests/i, /rate limit/i, /automated (?:queries|requests|traffic)/i,
    /security check/i, /human verification/i, /prove you(?:'re| are) (?:not a robot|human)/i,
];
const WEAK_WALL_MAX_CHARS = 700;

// Response-header WAF signatures. A vendor header's PRESENCE only says "the
// site USES this WAF", not "it blocked us" — so every vendor rule is gated on a
// block status, except an explicit mitigation header a vendor sets ONLY when
// it is challenging (cf-mitigated / x-amzn-waf-action / x-vercel-mitigated).
const BLOCK_STATUSES = new Set([401, 403, 406, 429, 503]);
function wafFromHeaders(status, headers) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    const server = String(h['server'] || '');
    const sc = Array.isArray(h['set-cookie']) ? h['set-cookie'].join(';') : String(h['set-cookie'] || '');
    if (String(h['cf-mitigated'] || '').toLowerCase() === 'challenge') return 'cloudflare';
    if (/challenge|captcha/i.test(String(h['x-amzn-waf-action'] || ''))) return 'aws-waf';
    if (String(h['x-vercel-mitigated'] || '').toLowerCase() === 'challenge') return 'vercel';
    if (!BLOCK_STATUSES.has(Number(status))) return null;
    if (/cloudflare/i.test(server) || h['cf-ray']) return 'cloudflare';
    if (h['x-datadome'] || h['x-datadome-cid'] || /datadome/i.test(sc)) return 'datadome';
    if (h['x-iinfo'] || /^visid_incap|incap_ses/i.test(sc) || /incapsula|imperva/i.test(server)) return 'incapsula';
    if (/sucuri/i.test(server) || h['x-sucuri-id']) return 'sucuri';
    if (h['x-kpsdk-ct'] || h['x-kpsdk-cd'] || h['x-kpsdk-h']) return 'kasada';
    if (/akamaighost/i.test(server) || h['x-akamai-transformed'] || h['akamai-grn']) return 'akamai';
    if (/(?:^|[;,\s])(?:_px3|_pxhd|_pxvid|_pxde)\b/i.test(sc) || h['x-px-authorization']) return 'perimeterx';
    if (/queue-?it/i.test(sc) || h['x-queueit-token']) return 'queue-it';
    if (/aws-waf-token|awswaf/i.test(sc) || h['x-amzn-waf-action']) return 'aws-waf';
    if (h['x-vercel-id'] && Number(status) === 403) return 'vercel';
    return null;
}

// ---------------------------------------------------------------------------
// Non-bot obstacles: consent, login, paywall, age gate, geo, JS required
// ---------------------------------------------------------------------------
const CONSENT_RE = /\b(?:we (?:and our partners )?use cookies|this (?:web)?site uses cookies|cookie (?:consent|policy|preferences|settings|notice|banner)|accept (?:all )?cookies|manage (?:your )?(?:cookie|privacy) (?:preferences|settings|choices)|your privacy choices|consent to the use of cookies|we value your privacy|privacy (?:settings|preferences) cent(?:er|re)|zustimmen|alle akzeptieren|accepter (?:et fermer|tout)|tout accepter|aceptar (?:todo|todas)|accetta tutto|vendors? list|iab (?:tcf|europe)|legitimate interest)/i;
const CONSENT_OR_PAY_RE = /\b(?:consent or pay|with(?:out)? (?:advertising|ads)|zustimmen (?:oder|und weiter)|mit werbung|ohne werbung|contentpass|pur-abo|abonnement sans publicit)/i;
const CONSENT_BUTTON_RE = /^\s*(?:accept(?: all)?(?: cookies)?(?: (?:&|and) (?:close|continue))?|agree(?: (?:&|and) (?:close|continue|proceed))?|i (?:accept|agree|understand|consent)|allow all(?: cookies)?|allow cookies|got it!?|ok(?:ay)?!?|yes,? (?:i agree|accept|allow)|consent|continue(?: to (?:the )?site)?|akzeptieren|alle akzeptieren|zustimmen|einverstanden|accepter(?: (?:et|&) fermer)?|tout accepter|j'accepte|aceptar(?: todo| todas)?|accetta(?: tutto)?|accetto|aceitar(?: tudo)?|akkoord|alles accepteren|godkänn(?: alla)?|accepter alle|hyväksy(?: kaikki)?|zaakceptuj(?: wszystkie)?|принять(?: все)?)\s*$/i;
// Known consent-management-platform buttons (checked BEFORE the text scan —
// they're precise, and several live inside a cross-origin iframe).
const CONSENT_SELECTORS = [
    '#onetrust-accept-btn-handler', '#accept-recommended-btn-handler',
    '#didomi-notice-agree-button', 'button[id^="didomi-notice-agree"]',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
    'button[data-testid="uc-accept-all-button"]', 'button[data-testid="accept-all"]',
    '.qc-cmp2-summary-buttons button[mode="primary"]', '.qc-cmp2-buttons-desktop button[mode="primary"]',
    '#truste-consent-button', '.truste-button2', '#consent_prompt_submit',
    '.fc-cta-consent', '.fc-button.fc-cta-consent',
    '.cc-btn.cc-allow', '.cc-allow', '.cc-accept-all', '.cc-dismiss',
    '#sp-cc-accept', '#accept-cookies', '#acceptCookies', '#cookie-accept', '#cookies-accept',
    'button[aria-label="Accept all"]', 'button[aria-label="Accept All"]', 'button[aria-label="Accept cookies"]',
    'button[title="Accept all"]', 'button[title="Accept All"]', 'button[title="Accept cookies"]',
    '[data-cookiebanner="accept_button"]', '[data-action="accept-all"]', '[data-consent="accept"]',
    '.message-component.accept-all', 'button.sp_choice_type_11', 'button[title="Accept & continue"]',
    '.gdpr-accept', '.js-accept-cookies', '.js-cookie-consent-agree', '.cookie-consent-accept',
    'button.iubenda-cs-accept-btn', '.iubenda-cs-accept-btn', '#ez-accept-all',
    '.osano-cm-accept-all', '#cookiescript_accept', '#cookie_action_close_header',
    '#gdpr-consent-tool-wrapper button[type="submit"]', '#cmpbntyestxt', '.cmpboxbtnyes',
    '#_evidon-accept-button', '#ccc-recommended-settings', '.pdynamicbutton .call',
];
const LOGIN_RE = /\b(?:log ?in to (?:see|view|continue|read|access|your account)|sign ?in to (?:see|view|continue|read|access)|(?:log ?in|sign ?in|sign ?up|create an account|join now|register) (?:or (?:sign ?up|register|create an account) )?to (?:see|view|continue|read|access|unlock|comment)|you must (?:be logged in|log ?in|sign ?in)|please (?:log ?in|sign ?in) to|members? only|this content is (?:only )?available to (?:members|subscribers|registered users)|welcome back!? (?:log ?in|sign ?in)|log ?in with (?:facebook|google|apple)|see (?:more|photos|posts|content) from .{1,60} (?:by logging in|by signing in)|not (?:logged|signed) in)\b/i;
const LOGIN_SHELL_RE = /^\s*(?:log ?in|sign ?in)\b/i;
// A paywall TITLE is unambiguous at any length (FT serves the article stub under
// the title "Subscribe to read"; the body is long enough to look complete).
const PAYWALL_TITLE_RE = /^\s*(?:subscribe to (?:read|continue)|subscribe now|subscriber[- ]only|subscription required|sign in to read|log ?in to read|paywall|premium content|members? only)\b/i;
const PAYWALL_RE = /\b(?:subscribe to (?:continue|read|unlock|keep reading|access)|subscribe (?:now )?(?:for|to get) (?:full|unlimited) access|(?:this|the) (?:article|story|content) is (?:for|reserved for|available to) (?:subscribers|members|premium)|subscriber[- ]only|premium (?:article|content|story)|(?:you'?ve|you have) (?:reached|read) (?:your|the) (?:limit|maximum) of free (?:articles|stories)|free (?:articles?|stories) (?:remaining|left)|(?:already a subscriber|are you a subscriber)\??\s*(?:log|sign) ?in|start your (?:free )?trial to (?:continue|read)|unlock (?:this|the) (?:article|story)|continue reading (?:with|by subscribing)|(?:to )?keep reading,? (?:subscribe|sign ?up|log ?in)|paywall|become a (?:member|subscriber) to (?:continue|read|access)|(?:read|get) (?:the )?full (?:article|story) with a subscription)\b/i;
const AGE_RE = /\b(?:(?:are you|you must be) (?:over|at least|older than) (?:18|19|21)|(?:enter|confirm|verify) your (?:date of birth|birth ?date|age)|age (?:verification|check|gate|restricted)|(?:this|the) (?:site|content|product|page|game) (?:may )?contains? (?:content )?(?:only )?(?:appropriate|suitable|intended) for (?:adults|mature|people over)|you must be (?:18|19|21)(?: years)?(?: or older| years of age)|please enter your (?:age|birth ?date|date of birth)|by entering this site you (?:agree|confirm) that you are (?:over|at least))\b/i;
const GEO_RE = /\b(?:not available in your (?:country|region|location|area)|unavailable in your (?:country|region|location)|(?:content|service|video|page) (?:is )?(?:not )?(?:available|accessible) (?:only )?in (?:your|certain|selected|the following) (?:countries|regions|country|region)|(?:sorry,? )?(?:this|the) (?:site|content|service|page) (?:is )?(?:currently )?(?:un)?available (?:only )?(?:from|to|in) (?:your|the) (?:country|region|location)|geo-?(?:blocked|restricted)|451 unavailable for legal reasons|we(?:'re| are) sorry,? (?:but )?(?:this|our) (?:site|content) is not available in (?:your|the))\b/i;
const JS_REQUIRED_RE = /\b(?:please (?:enable|turn on|activate) javascript|javascript (?:is|must be) (?:required|enabled|disabled)|(?:this|the) (?:page|site|app|application) (?:requires|needs) javascript|you need to enable javascript|(?:doesn'?t|does not) (?:work|function) (?:properly )?without javascript|(?:browser|you) (?:does not|doesn'?t) support javascript|enable javascript to (?:run|use|view|continue)|we'?re sorry but .{0,60} doesn'?t work properly without javascript)\b/i;
const NOT_FOUND_RE = /^(?:404|page not found|not found|error 404)/i;

// A page's readable text minus whitespace noise, capped for the regex sweeps.
function textOf(s, cap = 20000) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, cap); }

// Layers that already ran a real browser — a "retry in the browser" hint after
// one of these is a lie, and the browser cannot log in or pay for anyone.
const BROWSER_SOURCES = new Set(['playwright', 'browser', 'scrapling', 'stealth', 'interact', 'crawl']);

function nextStep(kind, { source, url, vendor, tried } = {}) {
    const browserDone = BROWSER_SOURCES.has(String(source || '').toLowerCase()) || (tried && tried.browser);
    const u = url ? `"${url}"` : 'the same url';
    switch (kind) {
        case 'bot_challenge':
        case 'blocked':
            if (!browserDone) return {
                action: 'retry_browser',
                hint: `Bot protection${vendor ? ` (${vendor})` : ''} answered instead of the page. Call web again with url:${u} and mode:"browser" (real stealth browser — it waits out Cloudflare-style challenges); if that also fails, search for the same information on a different site.`,
            };
            return {
                action: 'switch_source',
                hint: `Bot protection${vendor ? ` (${vendor})` : ''} blocked every fetch layer including the stealth browser. Do NOT re-read ${u} or URL variants of it — search (web query:…) for the same information on a different site, or use the archived copy if one was returned.`,
            };
        case 'ratelimit':
            return { action: 'wait_retry', hint: `The host is rate-limiting requests. Do something else first (read another source), then retry ${u} once — do not fan out URL variants.` };
        case 'consent':
            if (!browserDone) return { action: 'retry_browser', hint: `The body is a cookie-consent wall, not the page. Call web again with url:${u} and mode:"browser" — the browser dismisses consent overlays automatically.` };
            return { action: 'interact', hint: `A cookie-consent overlay hides the page. Call web with url:${u}, mode:"interact" and actions:[{type:"click", selector:"<the accept button — e.g. button:has-text('Accept')>"}] to dismiss it, or read the content from a different site.` };
        case 'age_gate':
            if (!browserDone) return { action: 'retry_browser', hint: `An age-verification gate answered instead of the page. Call web again with url:${u} and mode:"browser" — the browser passes simple age gates automatically.` };
            return { action: 'interact', hint: `An age-verification gate hides the page. Call web with url:${u}, mode:"interact" and actions that fill the birth-date fields and click the confirm/enter button (selectors from the page), or use a different source.` };
        case 'login':
            if (!browserDone) return { action: 'retry_browser', hint: `The static fetch got a login wall. A real browser often renders the PUBLIC part of such a page — call web again with url:${u} and mode:"browser"; if that still shows a login wall, search for the same information on a public site.` };
            return { action: 'switch_source', hint: `This page requires an account login; no fetch layer can log in. Do NOT retry ${u} in another mode. Use the archived copy if one was returned, otherwise search for the same information on a public site (search the title / subject instead of the URL).` };
        case 'paywall':
            return { action: 'switch_source', hint: `A paywall hides most of this article; re-reading it in another mode will not unlock it. Use the archived copy if one was returned, otherwise search for the same story on a site without a paywall and cite that.` };
        case 'geo':
            return { action: 'switch_source', hint: `The site refuses this server's region (geo-block). Retrying ${u} in another mode will not help — find the same information on a different site.` };
        case 'js_required':
            if (!browserDone) return { action: 'retry_browser', hint: `The page needs JavaScript to render. Call web again with url:${u} and mode:"browser" (real browser render).` };
            return { action: 'switch_source', hint: `The page did not render even in a real browser. Use a different source for this information.` };
        case 'thin':
            if (!browserDone) return { action: 'retry_browser', hint: `The fetch returned almost no readable text. If you expected real content here, call web again with url:${u} and mode:"browser"; otherwise use a different source.` };
            return { action: 'switch_source', hint: `Even the browser render returned almost no readable text — use a different source (search for the subject) rather than re-reading ${u}.` };
        default:
            return { action: 'none', hint: '' };
    }
}

/**
 * Classify what stands between a fetch result and the page.
 *
 * @param {object} r
 * @param {string} [r.title]      page title
 * @param {string} [r.content]    extracted readable text
 * @param {string} [r.rawHtml]    raw markup (optional; challenge walls often live only here)
 * @param {number} [r.status]     HTTP status (0/undefined = unknown)
 * @param {object} [r.headers]    response headers (lower- or mixed-case)
 * @param {string} [r.source]     the layer that produced this result (axios-fast|impersonate|scrapling|playwright|…)
 * @param {string} [r.url]
 * @returns {null | { kind, vendor, strength: 'strong'|'weak', evidence, action, hint, escalate: boolean, browserHelps: boolean }}
 *   escalate     — the cascade should NOT serve this as content
 *   browserHelps — escalating to the real browser is worth the cost
 */
function classifyObstacle(r = {}) {
    const title = textOf(r.title, 300);
    const content = textOf(r.content);
    const raw = textOf(r.rawHtml, 30000);
    const status = Number(r.status || 0);
    const blob = `${title}\n${content}`;
    const scan = raw ? `${blob}\n${raw.slice(0, 12000)}` : blob;
    const len = content.length;
    const finish = (kind, vendor, strength, evidence) => {
        const step = nextStep(kind, r);
        const browserHelps = step.action === 'retry_browser';
        // Serve-or-escalate: a wall is never the page (escalate even when no layer
        // is left — the caller then attaches the verdict instead of the "content");
        // a paywall / geo block / post-browser login wall carries whatever readable
        // text the page did give, so it is served WITH the verdict.
        // `thin` is hint-only: the cascade's own thin-content logic (which can
        // see the raw markup and knows a tiny COMPLETE page from a shell) decides
        // whether to escalate on length.
        const escalate = ['bot_challenge', 'blocked', 'ratelimit', 'consent', 'age_gate', 'js_required'].includes(kind)
            || (kind === 'login' && browserHelps);
        return { kind, vendor: vendor || null, strength, evidence: String(evidence || '').slice(0, 120), action: step.action, hint: step.hint, escalate, browserHelps };
    };

    // 1. Bot protection — headers first (localization-proof), then strong body tokens.
    const waf = wafFromHeaders(status, r.headers);
    if (waf) return finish(status === 429 || (status === 503 && !/cloudflare|akamai/.test(waf)) ? 'ratelimit' : 'bot_challenge', waf, 'strong', `header:${waf} status:${status}`);
    // Structural tokens: title+content at any length; raw HTML only when the
    // readable body is short (a wall's extracted text always is).
    const shortBody = len < VENDOR_MARKER_MAX_CHARS;
    const strongScan = shortBody ? scan : blob;
    for (const re of STRUCTURAL_WALL_MARKERS) {
        const m = re.exec(strongScan);
        if (m) return finish('bot_challenge', vendorOf(re), 'strong', m[0]);
    }
    if (shortBody) {
        for (const re of VENDOR_WALL_MARKERS) {
            const m = re.exec(scan);
            if (m) return finish('bot_challenge', vendorOf(re), 'strong', m[0]);
        }
    }
    // 2. Hard status with no vendor signature.
    if (status === 429) return finish('ratelimit', null, 'strong', 'HTTP 429');
    if ([401, 403, 406].includes(status)) {
        const weak = WEAK_WALL_MARKERS.find(re => re.test(blob));
        return finish('blocked', null, weak ? 'strong' : 'weak', `HTTP ${status}${weak ? ' ' + weak.source : ''}`);
    }
    if (status === 503) return finish('ratelimit', null, 'weak', 'HTTP 503');
    if (status === 451) return finish('geo', null, 'strong', 'HTTP 451');
    // 3. A generic wall phrase IS the page when the page is tiny.
    if (len <= WEAK_WALL_MAX_CHARS) {
        const weak = WEAK_WALL_MARKERS.find(re => re.test(blob));
        if (weak) return finish('bot_challenge', null, 'strong', weak.source);
    }
    // 4. Content-side obstacles — precision depends on how much of the body the
    //    obstacle text accounts for. Head-anchored checks look at the first
    //    ~1200 chars (a wall is what you see first); a long article that merely
    //    ends with a subscribe pitch is NOT a paywall.
    const head = content.slice(0, 1200);
    if (JS_REQUIRED_RE.test(blob) && len < 1500) return finish('js_required', null, 'strong', (JS_REQUIRED_RE.exec(blob) || [])[0]);
    if (AGE_RE.test(head) && len < 2500) return finish('age_gate', null, 'strong', (AGE_RE.exec(head) || [])[0]);
    if (GEO_RE.test(head) && len < 2000) return finish('geo', null, 'strong', (GEO_RE.exec(head) || [])[0]);
    const consentHits = (content.match(new RegExp(CONSENT_RE.source, 'gi')) || []).length;
    const consentHead = CONSENT_RE.test(head) || CONSENT_OR_PAY_RE.test(head);
    // Consent text LEADS and DOMINATES: a tiny body, or several consent phrases
    // in a short one, or many anywhere, or a consent-or-pay wall. One cookie
    // sentence heading two thousand chars of article is a banner, not a wall.
    if (consentHead && (len < 900 || (consentHits >= 3 && len < 2500) || consentHits >= 6 || CONSENT_OR_PAY_RE.test(head))) {
        return finish('consent', null, len < 2500 ? 'strong' : 'weak', (CONSENT_RE.exec(head) || CONSENT_OR_PAY_RE.exec(head) || [])[0]);
    }
    if ((LOGIN_RE.test(head) || (LOGIN_SHELL_RE.test(title) && len < 800)) && len < 2500) return finish('login', null, 'strong', (LOGIN_RE.exec(head) || [title])[0]);
    if (PAYWALL_TITLE_RE.test(title)) return finish('paywall', null, 'strong', `title: ${title.slice(0, 60)}`);
    if (PAYWALL_RE.test(content) && len < 3500) return finish('paywall', null, len < 2000 ? 'strong' : 'weak', (PAYWALL_RE.exec(content) || [])[0]);
    if (LOGIN_RE.test(content) && len < 1500) return finish('login', null, 'weak', (LOGIN_RE.exec(content) || [])[0]);
    // 5. Nothing recognisable, but also nothing to read. A tiny page whose raw
    //    markup is ALSO tiny is complete (example.com) — nothing more to fetch.
    if (len < 200 && !NOT_FOUND_RE.test(title) && !(raw && raw.length < 5000)) return finish('thin', null, 'weak', `${len} chars`);
    return null;
}

function vendorOf(re) {
    const s = re.source;
    if (/cf|cloudflare|ray id|just a moment|checking your|attention required|sorry, you have been blocked|needs to review|verifying you are human|this process is automatic|error 10/i.test(s)) return 'cloudflare';
    if (/perimeterx|px-|press|_px/i.test(s)) return 'perimeterx';
    if (/datadome|captcha-delivery/i.test(s)) return 'datadome';
    if (/imperva|incapsula/i.test(s)) return 'incapsula';
    if (/reference|akamai|bot manager/i.test(s)) return 'akamai';
    if (/kasada|kpsdk|ips\.js/i.test(s)) return 'kasada';
    if (/queue-it/i.test(s)) return 'queue-it';
    if (/awswaf|aws-waf|amzn/i.test(s)) return 'aws-waf';
    if (/vercel/i.test(s)) return 'vercel';
    if (/shopify/i.test(s)) return 'shopify';
    if (/distil|sucuri|pardon/i.test(s)) return s.replace(/[^a-z ]/gi, '').trim().split(' ')[0].toLowerCase();
    return null;
}

/** Strong-marker scan (the host-block-strike / escalation gate): structural
 *  tokens at any length, vendor names only on a short body. */
function hasStrongWallMarker(text) {
    if (!text) return false;
    const blob = String(text).slice(0, 8000);
    if (STRUCTURAL_WALL_MARKERS.some(re => re.test(blob))) return true;
    return String(text).trim().length < VENDOR_MARKER_MAX_CHARS && VENDOR_WALL_MARKERS.some(re => re.test(blob));
}
/** Any marker, strong or weak (hint-only). */
function hasAnyWallMarker(text) {
    if (!text) return false;
    const blob = String(text).slice(0, 8000);
    return hasStrongWallMarker(text) || WEAK_WALL_MARKERS.some(re => re.test(blob));
}

module.exports = {
    STRONG_WALL_MARKERS, STRUCTURAL_WALL_MARKERS, VENDOR_WALL_MARKERS, VENDOR_MARKER_MAX_CHARS, WEAK_WALL_MARKERS, WEAK_WALL_MAX_CHARS,
    CONSENT_RE, CONSENT_BUTTON_RE, CONSENT_SELECTORS, LOGIN_RE, PAYWALL_RE, PAYWALL_TITLE_RE, AGE_RE, GEO_RE, JS_REQUIRED_RE,
    wafFromHeaders, classifyObstacle, nextStep, hasStrongWallMarker, hasAnyWallMarker,
};
