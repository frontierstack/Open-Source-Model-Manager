'use strict';
/**
 * Ad / tracker awareness shared by every web-retrieval layer.
 *
 *  - isAdUrl(url)          request-level: block the request in the headless
 *                          browser (Playwright). Host-suffix match against the
 *                          bundled domain list (Peter Lowe's list, snapshotted
 *                          from Scrapling's built-in `ad_domains.py` into
 *                          adblock_domains.list) plus a few URL-shape rules for
 *                          ad delivery paths on first-party CDNs.
 *  - AD_TOKEN_RE / isAdElementDescriptor(id, className)
 *                          DOM-level: an element whose id/class TOKENS name an
 *                          ad slot. Token-exact on purpose — a substring test on
 *                          "ad" would strip "header", "read", "loading", and a
 *                          test on "sponsor" would strip a sponsors PAGE.
 *  - stripAdMarkup(html)   the same idea for the no-browser layers (axios /
 *                          impersonate) that only ever see raw HTML: removes ad
 *                          containers with a balanced-tag scan so a nested
 *                          <div> inside the slot cannot leave the tail of the
 *                          page behind.
 *
 * Ad blocking is ON by default (WEB_ADBLOCK=0 disables request blocking; the
 * DOM/markup stripping is always on — it only removes elements that DECLARE
 * themselves ads). Bot-protection vendors are never on this list: blocking a
 * challenge script would turn a readable page into a wall.
 */
const fs = require('fs');
const path = require('path');

const ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.WEB_ADBLOCK || '1'));

let DOMAINS = null;
function domains() {
    if (DOMAINS) return DOMAINS;
    DOMAINS = new Set(EXTRA_DOMAINS);
    try {
        const txt = fs.readFileSync(path.join(__dirname, 'adblock_domains.list'), 'utf8');
        for (const line of txt.split('\n')) {
            const d = line.trim().toLowerCase();
            if (d && !d.startsWith('#')) DOMAINS.add(d);
        }
    } catch (_) { /* list missing → extras only */ }
    for (const d of NEVER_BLOCK) DOMAINS.delete(d);
    return DOMAINS;
}

// Ad networks the snapshot lacks or names only by a sub-brand.
const EXTRA_DOMAINS = [
    'googlesyndication.com', 'doubleclick.net', 'googleadservices.com', 'adtrafficquality.google',
    'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'mgid.com', 'revcontent.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'indexww.com',
    'casalemedia.com', 'sharethrough.com', 'media.net', 'adsafeprotected.com', 'moatads.com',
    'doubleverify.com', 'scorecardresearch.com', 'quantserve.com', 'chartbeat.com', 'chartbeat.net',
    'permutive.com', 'id5-sync.com', 'rlcdn.com', 'bidswitch.net', 'smartadserver.com', 'teads.tv',
    'adform.net', 'yieldmo.com', '33across.com', 'lijit.com', 'sovrn.com', 'gumgum.com', 'nativo.net',
    'zergnet.com', 'adsrvr.org', 'agkn.com', 'bluekai.com', 'demdex.net', 'krxd.net', 'exelator.com',
    'tapad.com', 'liveintent.com', 'adlightning.com', 'ad-delivery.net', 'fwmrm.net', 'spotxchange.com',
    'connatix.com', 'primis.tech', 'vidazoo.com', 'ex.co', 'playwire.com', 'raptive.com', 'adthrive.com',
    'mediavine.com', 'ezoic.net', 'ezodn.com', 'freestar.com', 'pbstck.com', 'browsiprod.com',
    'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'hotjar.com', 'fullstory.com',
    'mouseflow.com', 'crazyegg.com', 'clarity.ms', 'onesignal.com', 'pushengage.com', 'pushnami.com',
    'admiral.mgr.consensu.org', 'getadmiral.com', 'blockadblock.com', 'fuckadblock.com',
];
// Never block: page infrastructure some sites route content through, and the
// bot-protection vendors (a blocked challenge script = a wall).
const NEVER_BLOCK = [
    'google.com', 'gstatic.com', 'googleapis.com', 'cloudflare.com', 'cloudfront.net', 'akamaihd.net',
    'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'jquery.com', 'bootstrapcdn.com',
    'youtube.com', 'ytimg.com', 'vimeo.com', 'vimeocdn.com', 'twitter.com', 'twimg.com', 'facebook.com',
    'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'reddit.com', 'redd.it', 'wp.com', 'wordpress.com',
    'gravatar.com', 'disqus.com', 'recaptcha.net', 'hcaptcha.com', 'datadome.co', 'perimeterx.net',
    'px-cloud.net', 'imperva.com', 'incapsula.com', 'kasada.io', 'queue-it.net', 'arkoselabs.com',
];

// URL shapes that are ad delivery regardless of host (first-party CDNs proxy
// ad calls): path segments, not substrings — "/ads/" yes, "/leads/" no.
const AD_PATH_RE = /(^|\/)(ads?|adserver|adservers?|adsystem|adframe|adview|adx|adsense|adsbygoogle|pagead2?|prebid|openrtb|banners?|sponsored|native-ads|ad-?units?|ad-?slots?|ad-?calls?|ad-?requests?|ad-?tags?|adtech|adnetwork|vast|vpaid)(\/|\?|$|\.js|\.html)/i;
const AD_HOST_RE = /(^|\.)(ads?|adserv\w*|adsystem|adtech|adnetwork|advertising|banners?|prebid|pixel|beacon|trk|track(?:ing)?|telemetry|metrics|stats?)\d*\./i;
// Hosts whose name only LOOKS like an ad host.
const HOST_ALLOW_RE = /(^|\.)(stats\.wikimedia\.org|metrics\.dev|track\.toggl\.com|pixel\.(?:art|garden))$/i;

function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch (_) { return ''; }
}
function hostMatches(host, set) {
    if (!host) return false;
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        if (set.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}
const NEVER = new Set(NEVER_BLOCK);

/** Is this request an ad / tracker call that a browser should not make? */
function isAdUrl(url) {
    if (!ENABLED) return false;
    const s = String(url || '');
    const host = hostOf(s);
    if (!host || hostMatches(host, NEVER) || HOST_ALLOW_RE.test(host)) return false;
    if (hostMatches(host, domains())) return true;
    if (AD_HOST_RE.test(host)) return true;
    let pathname = '';
    try { pathname = new URL(s).pathname; } catch (_) { return false; }
    return AD_PATH_RE.test(pathname);
}

// A class/id TOKEN that declares an ad slot. Whole-token match only.
const AD_TOKEN_RE = /^(ad|ads|advert|adverts|advertisement|advertisements|advertising|advertorial|adsbygoogle|adslot|ad-slot|ad_slot|adunit|ad-unit|ad_unit|ad-container|ad_container|adcontainer|ad-wrapper|ad_wrapper|adwrapper|ad-banner|ad_banner|adbanner|banner-ad|banner_ad|bannerad|ad-box|adbox|ad-block|adblock-notice|ad-placeholder|ad-placement|ad_placement|adplacement|ad-label|sponsored|sponsored-content|sponsored-post|sponsoredcontent|sponsored_content|sponsorship|promoted|promoted-content|taboola|trc_related_container|outbrain|OUTBRAIN|ob-widget|mgid|revcontent|zergnet|dfp|dfp-ad|gpt-ad|google-ad|google_ads|googleads|adsense|adsense-ad|ad-leaderboard|ad-skyscraper|ad-sidebar|ad-rail|ad-rectangle|mrec|leaderboard-ad|skyscraper-ad|interstitial-ad|sticky-ad|ad-sticky|ad-footer|ad-header|ad-top|ad-bottom|ad-inline|inline-ad|ad-native|native-ad|ad-video|video-ad|ad-overlay|adOverlay)$/i;
const AD_ID_PREFIX_RE = /^(div-gpt-ad|google_ads_|google_ad_|gpt-|ad-|ads-|ad_|adunit|adslot|taboola-|outbrain_|ob_|mgid-|dfp-|sponsored-|criteo-)/i;

/** Does this element's id/class declare an ad slot? (id + className strings) */
function isAdElementDescriptor(id, className) {
    const idv = String(id || '');
    if (idv && (AD_TOKEN_RE.test(idv) || AD_ID_PREFIX_RE.test(idv))) return true;
    const cls = String(className || '');
    if (!cls) return false;
    for (const tok of cls.split(/\s+/)) {
        if (tok && AD_TOKEN_RE.test(tok)) return true;
    }
    return false;
}

// Selectors for attribute-declared ad slots (no token guessing needed).
const AD_ATTR_SELECTORS = [
    'ins.adsbygoogle', '[data-ad-slot]', '[data-ad-unit]', '[data-ad-client]', '[data-adunit]',
    '[data-ad-name]', '[data-google-query-id]', '[data-taboola-id]', '[data-widget-id^="ob_"]',
    '[aria-label="Advertisement"]', '[aria-label="advertisement"]', '[title="Advertisement"]',
    'amp-ad', 'amp-embed', 'amp-sticky-ad', 'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
    'iframe[id^="google_ads_iframe"]', 'div[id^="google_ads_iframe"]',
];

/**
 * Source of the in-page ad removal, run through page.evaluate. Removes only
 * elements that DECLARE themselves ads (attributes, id/class tokens) and never
 * an element holding a large share of the page text — a site that names its
 * content column "sponsored" keeps it. Returns the number removed.
 */
const DOM_STRIP_SOURCE = `
(function(tokenSrc, idPrefixSrc, attrSelectors, maxShare) {
    const TOKEN = new RegExp(tokenSrc, 'i');
    const IDPFX = new RegExp(idPrefixSrc, 'i');
    const bodyLen = ((document.body && document.body.innerText) || '').length || 1;
    const declares = (el) => {
        const id = el.id || '';
        if (id && (TOKEN.test(id) || IDPFX.test(id))) return true;
        const cls = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
        if (!cls) return false;
        for (const t of cls.split(/\\s+/)) if (t && TOKEN.test(t)) return true;
        return false;
    };
    const victims = new Set();
    try { document.querySelectorAll(attrSelectors.join(',')).forEach(el => victims.add(el)); } catch (_) {}
    document.querySelectorAll('div, section, aside, ins, span, li, figure, article, iframe, a').forEach(el => {
        if (declares(el)) victims.add(el);
    });
    let removed = 0;
    for (const el of victims) {
        if (!el.isConnected) continue;
        const share = ((el.innerText || '').length) / bodyLen;
        if (share > maxShare) continue;        // that is content wearing an ad class
        el.remove(); removed++;
    }
    return removed;
})
`;
const DOM_STRIP_ARGS = () => [AD_TOKEN_RE.source, AD_ID_PREFIX_RE.source, AD_ATTR_SELECTORS, 0.4];

/**
 * Remove ad containers from raw HTML (no DOM available). Balanced-tag scan on
 * the container's own tag name so nested same-name tags are consumed with it.
 * Returns the cleaned HTML and the number of containers removed.
 */
function stripAdMarkup(html) {
    if (!html || typeof html !== 'string') return { html: html || '', removed: 0 };
    let out = html, removed = 0;
    // Self-contained ad furniture first.
    out = out.replace(/<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][^>]*>[\s\S]*?<\/ins>/gi, () => { removed++; return ' '; });
    out = out.replace(/<amp-(?:ad|embed|sticky-ad)\b[^>]*>[\s\S]*?<\/amp-(?:ad|embed|sticky-ad)>/gi, () => { removed++; return ' '; });
    out = out.replace(/<iframe\b[^>]*src=["'][^"']*(?:doubleclick|googlesyndication|adnxs|amazon-adsystem|criteo|taboola|outbrain)[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, () => { removed++; return ' '; });
    // Containers declared by id/class token or data-ad-* attribute.
    const openRe = /<(div|section|aside|span|li|figure)\b([^>]*)>/gi;
    let m, guard = 0;
    while ((m = openRe.exec(out)) && guard++ < 5000) {
        const tag = m[1].toLowerCase(), attrs = m[2];
        const id = (/\bid=["']([^"']*)["']/i.exec(attrs) || [])[1];
        const cls = (/\bclass=["']([^"']*)["']/i.exec(attrs) || [])[1];
        const dataAd = /\bdata-(?:ad-slot|ad-unit|ad-client|adunit|google-query-id)=/i.test(attrs);
        if (!dataAd && !isAdElementDescriptor(id, cls)) continue;
        const start = m.index;
        // find the matching close for this tag, counting nested opens
        const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
        scan.lastIndex = openRe.lastIndex;
        let depth = 1, end = -1, s;
        while ((s = scan.exec(out))) {
            depth += s[1] ? -1 : 1;
            if (depth === 0) { end = s.index + s[0].length; break; }
        }
        if (end < 0) continue;                              // unbalanced — leave it
        const chunk = out.slice(start, end);
        if (chunk.length > out.length * 0.4) continue;      // too big to be an ad slot
        out = out.slice(0, start) + ' ' + out.slice(end);
        removed++;
        openRe.lastIndex = start;
    }
    return { html: out, removed };
}

module.exports = {
    ENABLED,
    isAdUrl,
    isAdElementDescriptor,
    stripAdMarkup,
    AD_TOKEN_RE,
    AD_ID_PREFIX_RE,
    AD_ATTR_SELECTORS,
    DOM_STRIP_SOURCE,
    DOM_STRIP_ARGS,
    _domainCount: () => domains().size,
};
