// VirusTotal lookup service. Primary path calls the VT API v3 using
// process.env.VIRUSTOTAL_API_KEY; fallback scrapes the GUI URL via
// scraplingService when no key is configured. All four resource types
// are supported (IP, domain, URL, file hash — md5/sha1/sha256).
//
// View modes:
//   detection — detection stats + flagging engines + metadata (1 call)
//   community — votes + recent comments (2 calls)
//   full      — detection + community combined (3 calls)

const axios = require('axios');

let scraplingService = null;
try { scraplingService = require('./scraplingService'); } catch (_) { /* optional */ }

let playwrightService = null;
try { playwrightService = require('./playwrightService'); } catch (_) { /* optional */ }

const VT_API_BASE = 'https://www.virustotal.com/api/v3';
const VT_GUI_BASE = 'https://www.virustotal.com/gui';

// -----------------------------------------------------------------------
// Resource-type detection
// -----------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;
const MD5_RE = /^[a-f0-9]{32}$/i;
const SHA1_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const URL_RE = /^https?:\/\//i;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function detectResourceType(raw) {
    const r = String(raw || '').trim();
    if (!r) return null;
    if (URL_RE.test(r)) return 'url';
    if (MD5_RE.test(r) || SHA1_RE.test(r) || SHA256_RE.test(r)) return 'file';
    if (IPV4_RE.test(r)) return 'ip_address';
    if (r.includes(':') && IPV6_RE.test(r)) return 'ip_address';
    if (DOMAIN_RE.test(r)) return 'domain';
    return null;
}

// Map resource_type → API path segment + GUI path segment.
const TYPE_MAP = {
    ip_address: { api: 'ip_addresses', gui: 'ip-address' },
    domain:     { api: 'domains',      gui: 'domain' },
    url:        { api: 'urls',         gui: 'url' },
    file:       { api: 'files',        gui: 'file' },
};

// VT expects URLs to be base64url-encoded (no padding) for both the API
// ID and the GUI deep-link. Node's 'base64url' output already drops
// padding and uses the URL-safe alphabet.
function encodeUrlId(url) {
    return Buffer.from(url, 'utf8').toString('base64url');
}

function resourceId(resource, type) {
    if (type === 'url') return encodeUrlId(resource);
    if (type === 'ip_address' || type === 'domain' || type === 'file') return resource;
    return resource;
}

function buildGuiUrl(resource, type, view = 'detection') {
    const meta = TYPE_MAP[type];
    if (!meta) return null;
    const id = resourceId(resource, type);
    return `${VT_GUI_BASE}/${meta.gui}/${id}/${view === 'full' ? 'detection' : view}`;
}

// -----------------------------------------------------------------------
// API calls
// -----------------------------------------------------------------------

async function vtRequest(pathname, apiKey, timeout) {
    const resp = await axios.get(`${VT_API_BASE}${pathname}`, {
        headers: {
            'x-apikey': apiKey,
            'Accept': 'application/json',
        },
        timeout,
        validateStatus: () => true,
    });
    return { status: resp.status, data: resp.data };
}

function condenseDetectionAttributes(type, attrs = {}) {
    const stats = attrs.last_analysis_stats || {};
    const total = Object.values(stats).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    const results = attrs.last_analysis_results || {};
    const detections = [];
    for (const [engine, r] of Object.entries(results)) {
        if (r?.category === 'malicious' || r?.category === 'suspicious') {
            detections.push({
                engine,
                category: r.category,
                result: r.result || null,
                method: r.method || null,
            });
        }
    }
    const metadata = {};
    if (type === 'ip_address') {
        if (attrs.country) metadata.country = attrs.country;
        if (attrs.as_owner) metadata.as_owner = attrs.as_owner;
        if (typeof attrs.asn === 'number') metadata.asn = attrs.asn;
        if (attrs.network) metadata.network = attrs.network;
        if (attrs.regional_internet_registry) metadata.rir = attrs.regional_internet_registry;
    } else if (type === 'domain') {
        if (attrs.registrar) metadata.registrar = attrs.registrar;
        if (attrs.creation_date) metadata.creation_date = new Date(attrs.creation_date * 1000).toISOString();
        if (attrs.last_update_date) metadata.last_update_date = new Date(attrs.last_update_date * 1000).toISOString();
        if (Array.isArray(attrs.categories)) metadata.categories = attrs.categories;
        else if (attrs.categories && typeof attrs.categories === 'object') metadata.categories = attrs.categories;
        if (attrs.tld) metadata.tld = attrs.tld;
    } else if (type === 'file') {
        if (attrs.type_description) metadata.type = attrs.type_description;
        if (attrs.size) metadata.size = attrs.size;
        if (attrs.md5) metadata.md5 = attrs.md5;
        if (attrs.sha1) metadata.sha1 = attrs.sha1;
        if (attrs.sha256) metadata.sha256 = attrs.sha256;
        if (Array.isArray(attrs.names) && attrs.names.length) metadata.names = attrs.names.slice(0, 10);
        if (attrs.meaningful_name) metadata.meaningful_name = attrs.meaningful_name;
        if (Array.isArray(attrs.tags)) metadata.tags = attrs.tags.slice(0, 20);
    } else if (type === 'url') {
        if (attrs.url) metadata.url = attrs.url;
        if (attrs.title) metadata.title = attrs.title;
        if (attrs.final_url) metadata.final_url = attrs.final_url;
    }

    return {
        stats: {
            malicious: stats.malicious || 0,
            suspicious: stats.suspicious || 0,
            harmless: stats.harmless || 0,
            undetected: stats.undetected || 0,
            timeout: stats.timeout || 0,
            total,
        },
        detections,
        reputation: typeof attrs.reputation === 'number' ? attrs.reputation : null,
        total_votes: attrs.total_votes || null,
        last_analysis_date: attrs.last_analysis_date
            ? new Date(attrs.last_analysis_date * 1000).toISOString()
            : null,
        metadata,
    };
}

function condenseComments(data = []) {
    return (Array.isArray(data) ? data : []).slice(0, 10).map(c => {
        const a = c?.attributes || {};
        return {
            date: a.date ? new Date(a.date * 1000).toISOString() : null,
            text: typeof a.text === 'string' ? a.text.slice(0, 2000) : '',
            tags: Array.isArray(a.tags) ? a.tags : [],
            votes: a.votes || null,
            html: undefined,
        };
    });
}

async function apiLookup(resource, type, view, apiKey, timeout) {
    const meta = TYPE_MAP[type];
    const id = resourceId(resource, type);
    const basePath = `/${meta.api}/${encodeURIComponent(id)}`;

    const out = {
        success: true,
        resource,
        resource_type: type,
        view,
        gui_url: buildGuiUrl(resource, type, view),
        engine: 'api',
    };

    const wantDetection = view === 'detection' || view === 'full';
    const wantCommunity = view === 'community' || view === 'full';

    if (wantDetection) {
        const res = await vtRequest(basePath, apiKey, timeout);
        if (res.status === 404) {
            return { success: false, resource, resource_type: type, error: `VirusTotal has no record for this ${type.replace('_', ' ')}`, gui_url: out.gui_url };
        }
        if (res.status === 401 || res.status === 403) {
            return { success: false, resource, resource_type: type, error: `VirusTotal API key rejected (${res.status}). Check VIRUSTOTAL_API_KEY.`, gui_url: out.gui_url };
        }
        if (res.status === 429) {
            return { success: false, resource, resource_type: type, error: 'VirusTotal rate limit hit (429). Free tier allows 4 requests/minute, 500/day.', gui_url: out.gui_url };
        }
        if (res.status >= 400 || !res.data?.data) {
            return { success: false, resource, resource_type: type, error: `VirusTotal API returned ${res.status}`, gui_url: out.gui_url };
        }
        const attrs = res.data.data.attributes || {};
        Object.assign(out, condenseDetectionAttributes(type, attrs));
    }

    if (wantCommunity) {
        const [votes, comments] = await Promise.all([
            vtRequest(`${basePath}/votes?limit=20`, apiKey, timeout).catch(e => ({ status: 0, data: null, err: e })),
            vtRequest(`${basePath}/comments?limit=10`, apiKey, timeout).catch(e => ({ status: 0, data: null, err: e })),
        ]);
        out.community = {};
        if (votes.status === 200 && votes.data?.data) {
            const tallied = { harmless: 0, malicious: 0 };
            for (const v of votes.data.data) {
                const verdict = v?.attributes?.verdict;
                if (verdict === 'harmless' || verdict === 'malicious') tallied[verdict] += 1;
            }
            out.community.votes = tallied;
        } else if (votes.status) {
            out.community.votes_error = `votes query returned ${votes.status}`;
        }
        if (comments.status === 200 && comments.data?.data) {
            out.community.comments = condenseComments(comments.data.data);
        } else if (comments.status) {
            out.community.comments_error = `comments query returned ${comments.status}`;
        }
    }

    return out;
}

// -----------------------------------------------------------------------
// Scrape fallback (no API key)
// -----------------------------------------------------------------------
//
// The GUI is a JS-rendered SPA behind Cloudflare. Scrapling handles the
// stealth side but the extracted text will be unstructured — best-effort
// only. We surface the raw content + the GUI URL so the model can reason
// over what it got and cite the page.

async function scrapeLookup(resource, type, view, timeout) {
    const guiUrl = buildGuiUrl(resource, type, view);
    if (!guiUrl) return { success: false, resource, resource_type: type, error: `unsupported resource type: ${type}` };

    // Try Playwright first. The VT GUI is a heavy SPA that fetches its data
    // from /api/v3/... at page load; playwrightService intercepts those XHR
    // responses and flattens captured JSON into the returned content.
    // That's the only reliable way to get detection numbers out of the GUI
    // without the API key. Scrapling (StealthyFetcher) handles stealth well
    // but doesn't capture SPA XHR payloads, so it often returns an empty
    // shell of the page.
    const attempts = [];
    if (playwrightService) {
        attempts.push({
            name: 'playwright',
            run: async () => playwrightService.fetchUrlContent(guiUrl, {
                timeout: Math.max(timeout, 20000),
                waitForJS: true,
                includeLinks: false,
                maxLength: 25000,
            }),
        });
    }
    if (scraplingService) {
        attempts.push({
            name: 'scrapling',
            run: async () => scraplingService.fetchUrl(guiUrl, { timeout }),
        });
    }

    if (!attempts.length) {
        return {
            success: false,
            resource,
            resource_type: type,
            error: 'VIRUSTOTAL_API_KEY not set and no scrape engine (Playwright/Scrapling) available. Set the env var to enable structured lookups.',
            gui_url: guiUrl,
        };
    }

    let lastErr = null;
    for (const a of attempts) {
        try {
            const r = await a.run();
            if (r?.success && (r.content || '').length > 200) {
                return {
                    success: true,
                    resource,
                    resource_type: type,
                    view,
                    gui_url: guiUrl,
                    engine: `scrape-${a.name}`,
                    note: 'No VIRUSTOTAL_API_KEY configured — fetched the GUI page instead of calling the API. Output is best-effort; set the env var for clean detection stats.',
                    title: r.title || '',
                    content: (r.content || '').slice(0, 20000),
                };
            }
            lastErr = r?.error || `${a.name} returned thin content (${(r?.content || '').length} chars)`;
        } catch (e) {
            lastErr = e.message || String(e);
        }
    }
    return {
        success: false,
        resource,
        resource_type: type,
        error: `all scrape engines failed — last error: ${lastErr}`,
        gui_url: guiUrl,
    };
}

// -----------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------

async function lookup(resource, options = {}) {
    const {
        resource_type,
        view = 'detection',
        timeout = 15000,
    } = options;

    const r = String(resource || '').trim();
    if (!r) return { success: false, error: 'resource is required' };

    const type = resource_type || detectResourceType(r);
    if (!type) {
        return {
            success: false,
            resource: r,
            error: 'Could not detect resource type. Pass resource_type explicitly: "ip_address", "domain", "url", or "file".',
        };
    }
    if (!TYPE_MAP[type]) {
        return { success: false, resource: r, error: `unsupported resource_type: ${type}` };
    }
    const normalizedView = ['detection', 'community', 'full'].includes(view) ? view : 'detection';

    const apiKey = process.env.VIRUSTOTAL_API_KEY && process.env.VIRUSTOTAL_API_KEY.trim();
    if (apiKey) {
        return apiLookup(r, type, normalizedView, apiKey, timeout);
    }
    return scrapeLookup(r, type, normalizedView, timeout);
}

module.exports = {
    lookup,
    detectResourceType, // exposed for tests
    buildGuiUrl,
};
