#!/usr/bin/env python3
"""
Resident web-retrieval engine (speed + anti-bot layers for the `web` tool).

Runs as a Python subprocess inside the webapp container (same pattern as
embedding_engine.py): a stdlib ThreadingHTTPServer on 127.0.0.1, ephemeral port,
printing `WEB_ENGINE_LISTENING <port>` on stdout so Node can find it.

Why it exists — measured on the live box (2026-08-23):
  * scrapling_fetch.py was a COLD subprocess per call: interpreter + Scrapling
    import + a fresh stealth-browser launch on EVERY url (3.5–9 s each, and the
    busiest non-axios layer in the cascade).
  * A curl_cffi browser-impersonating HTTP fetch (Chrome TLS/JA3 + headers, no
    browser at all) reads most "axios gets 403 / thin" hosts in ~0.3–0.5 s:
    bleepingcomputer 3.4 s → 0.47 s, nytimes 6.8 s → 0.37 s, zillow 9.2 s → 0.55 s.
  * A WARM Scrapling StealthySession (patchright Chrome) reads in 1–3 s AND got
    past hosts the cold cascade failed on entirely (indeed 403 → 200/17k chars,
    glassdoor security wall → real jobs page, reddit 603-char stub → 7k).

Layers exposed:
  POST /fetch   {url, layer:'impersonate'|'stealth', timeout(ms), extractLinks,
                 impersonate?: profile, maxLength?}
        → {success, url, finalUrl, httpStatus, headers{subset}, title, content,
           links[], bodyHead (first 6k of raw html — for Node's WAF/challenge
           classifiers), layer, profile, ms, error?}
  POST /search  {query, limit, engines?: ['ddg','bing','yahoo','brave'], timeout?}
        → {success, engine, results:[{title,url,snippet}], tried:[{engine,status,blocked,ms}]}
  GET  /health  → {ok, stealthWorkers, stealthReady, impersonateOk, uptime}

Threading model: ThreadingHTTPServer spawns a thread per request. The
impersonate layer (curl_cffi) is thread-safe. Playwright's SYNC API is NOT
usable across threads, so each stealth browser lives in ONE dedicated worker
thread that owns its StealthySession and drains a job queue; requests post a
job and wait on an Event. WEB_ENGINE_STEALTH_WORKERS (default 2) browsers.
A session is recycled after WEB_ENGINE_STEALTH_MAX_USES fetches or on any
exception (a wedged browser never poisons the next request).
"""

import os
import sys
import json
import time
import re
import threading
import queue
import traceback
import urllib.parse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# SSL inspection bypass (mirrors scrapling_fetch.py — must precede curl_cffi import)
# ---------------------------------------------------------------------------
SSL_BYPASS_ENABLED = os.environ.get('NODE_TLS_REJECT_UNAUTHORIZED') == '0'
if SSL_BYPASS_ENABLED:
    os.environ['PYTHONHTTPSVERIFY'] = '0'
    os.environ['CURL_CA_BUNDLE'] = ''
    os.environ['REQUESTS_CA_BUNDLE'] = ''
    os.environ['SSL_CERT_FILE'] = ''
    os.environ['CURL_SSL_NO_REVOKE'] = '1'
    import ssl, warnings
    warnings.filterwarnings('ignore')
    try:
        ssl._create_default_https_context = ssl._create_unverified_context
    except AttributeError:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    # Reuse the battle-tested extractors from the subprocess script.
    from scrapling_fetch import extract_main_content, _status_of  # noqa: E402
except Exception:  # pragma: no cover — keep the engine bootable even if that file moves
    def _status_of(page):
        for attr in ('status', 'status_code'):
            v = getattr(page, attr, None)
            if isinstance(v, int) and v > 0:
                return v
        return None

    def extract_main_content(page):
        return page.get_all_text(separator='\n', strip=True) or ''

STARTED_AT = time.time()
STEALTH_WORKERS = max(0, int(os.environ.get('WEB_ENGINE_STEALTH_WORKERS', '2') or 2))
STEALTH_MAX_USES = max(5, int(os.environ.get('WEB_ENGINE_STEALTH_MAX_USES', '40') or 40))
STEALTH_IDLE_CLOSE_S = max(60, int(os.environ.get('WEB_ENGINE_STEALTH_IDLE_S', '900') or 900))
DEFAULT_PROFILE = os.environ.get('WEB_ENGINE_IMPERSONATE', 'chrome')
# Rotation order when a profile is refused: a different TLS/HTTP2 fingerprint
# family sometimes passes where the first is blocked (Akamai/Cloudflare keep
# per-fingerprint reputations).
PROFILE_ROTATION = ['chrome', 'safari', 'firefox', 'edge', 'chrome_android']
HEADER_KEEP = ('server', 'cf-ray', 'cf-mitigated', 'cf-cache-status', 'x-datadome', 'x-iinfo',
               'x-sucuri-id', 'x-akamai-transformed', 'retry-after', 'content-type', 'location',
               'x-amzn-waf-action', 'x-cdn', 'via', 'x-cache', 'set-cookie')


def log(*a):
    print('[web_engine]', *a, file=sys.stderr, flush=True)


def _pick_headers(h):
    out = {}
    try:
        items = h.items() if hasattr(h, 'items') else []
    except Exception:
        items = []
    for k, v in items:
        lk = str(k).lower()
        if lk in HEADER_KEEP:
            if lk == 'set-cookie':
                # names only — cookie VALUES are tokens we never want in a tool result
                names = re.findall(r'(?:^|,\s*)([A-Za-z0-9_\-.]+)=', str(v))
                out['set-cookie'] = ','.join(sorted(set(names)))[:300]
            else:
                out[lk] = str(v)[:300]
    return out


def _body_text(page):
    b = getattr(page, 'body', None)
    if isinstance(b, (bytes, bytearray)):
        return b.decode('utf-8', 'ignore')
    if b is None:
        return ''
    return str(b)


SPA_MARKER_RE = re.compile(
    r"""<div[^>]+id=["'](?:root|app|__next|__nuxt|app-root|q-app)["']|data-reactroot|data-server-rendered|__NEXT_DATA__|window\.__NUXT__|__remixContext|window\.__INITIAL_STATE__|data-sveltekit|<noscript[^>]*>\s*(?:you|please)?[^<]*enable[^<]*javascript""",
    re.I)


def _html_stats(raw):
    """True full-length markup stats so Node's shell heuristic isn't fooled by a
    truncated bodyHead (a JS app-shell has a huge script-heavy body with tiny
    text; a small complete page does not). Mirrors server.js htmlShellSignal."""
    raw = raw or ''
    head = raw[:200000]
    return {
        'htmlLen': len(raw),
        'scriptCount': head.count('<script'),
        'spaMarker': bool(SPA_MARKER_RE.search(head)),
    }


def _title_of(page):
    try:
        t = page.css('title::text').get()
        if t:
            return str(t).strip()[:300]
    except Exception:
        pass
    return ''


def _links_of(page, limit=100):
    links = []
    try:
        for link in page.css('a[href]'):
            href = link.attrib.get('href', '')
            if href.startswith(('http://', 'https://')):
                links.append({'url': href, 'text': (link.text or href)[:100]})
                if len(links) >= limit:
                    break
    except Exception:
        pass
    return links


def _content_type_is_html(ct):
    ct = (ct or '').lower()
    return ('text/html' in ct) or ('application/xhtml' in ct) or ct == ''


# ---------------------------------------------------------------------------
# Layer 1: curl_cffi browser impersonation (no browser)
# ---------------------------------------------------------------------------
_impersonate_ok = None


def _attempt_impersonate(url, prof, timeout_ms, extract_links, max_length):
    """One impersonated GET with profile `prof`. Returns (res, refused) where
    refused is True on a bot-status/challenge (caller may rotate fingerprint)."""
    res = {'success': False, 'url': url, 'finalUrl': url, 'layer': 'impersonate', 'profile': prof,
           'httpStatus': None, 'headers': {}, 'title': '', 'content': '', 'links': [], 'bodyHead': ''}
    from scrapling.fetchers import Fetcher
    kw = {'impersonate': prof, 'timeout': max(2, int(timeout_ms / 1000)), 'stealthy_headers': True,
          'retries': 1, 'follow_redirects': True}
    if SSL_BYPASS_ENABLED:
        kw['verify'] = False
    page = Fetcher.get(url, **kw)
    status = _status_of(page)
    res['httpStatus'] = status
    res['headers'] = _pick_headers(getattr(page, 'headers', {}) or {})
    try:
        res['finalUrl'] = str(getattr(page, 'url', url) or url)
    except Exception:
        pass
    raw = _body_text(page)
    res['bodyHead'] = raw[:6000]
    res.update(_html_stats(raw))
    ct = res['headers'].get('content-type', '')
    if not _content_type_is_html(ct):
        res['error'] = 'Not HTML content'
        res['contentType'] = ct
        return res, False
    res['title'] = _title_of(page)
    if status is not None and status >= 400:
        res['error'] = f'HTTP {status}'
        try:
            res['content'] = (page.get_all_text(separator='\n', strip=True) or '')[:4000]
        except Exception:
            pass
        # A bot-status is worth rotating the fingerprint for; a 404/410/5xx is the
        # host's real answer and rotating just repeats it.
        return res, status in (401, 403, 406, 429)
    text = extract_main_content(page) or ''
    # A 200 that is really a challenge interstitial (body markers) — rotate too.
    if BLOCK_RE.search((res['title'] + '\n' + raw[:8000])):
        res['error'] = 'challenge interstitial'
        res['content'] = text[:4000]
        return res, True
    res['content'] = text[:max_length]
    if extract_links:
        res['links'] = _links_of(page)
    res['success'] = True
    return res, False


def fetch_impersonate(url, timeout_ms=12000, extract_links=False, profile=None, max_length=50000):
    """Impersonated HTTP fetch with FINGERPRINT ROTATION. Many hosts keep
    per-JA3/HTTP2-fingerprint reputations — measured: indeed & reddit 403 the
    chrome fingerprint but 200 the safari/firefox one, so a rotation reads them
    in ~0.3 s where the browser layer would cost 4-6 s. On a bot-status/challenge
    the next profile is tried; a 404/5xx (the host's real answer) stops early."""
    global _impersonate_ok
    t0 = time.time()
    start = profile or DEFAULT_PROFILE
    order = [start] + [p for p in PROFILE_ROTATION if p != start]
    last = None
    for i, prof in enumerate(order[:3]):
        try:
            res, refused = _attempt_impersonate(url, prof, timeout_ms, extract_links, max_length)
            _impersonate_ok = True
            last = res
            if res.get('success') or not refused:
                break
        except Exception as e:  # network / TLS / curl error
            if _impersonate_ok is None:
                _impersonate_ok = False
            last = {'success': False, 'url': url, 'finalUrl': url, 'layer': 'impersonate', 'profile': prof,
                    'httpStatus': None, 'headers': {}, 'title': '', 'content': '', 'links': [], 'bodyHead': '',
                    'error': str(e)[:300]}
            break
    last = last or {'success': False, 'url': url, 'layer': 'impersonate', 'error': 'no attempt'}
    last['ms'] = int((time.time() - t0) * 1000)
    if len(order[:3]) > 1 and last.get('profile') and last['profile'] != start:
        last['rotated'] = True
    return last


# ---------------------------------------------------------------------------
# Layer 2: warm stealth browser workers (Scrapling StealthySession)
# ---------------------------------------------------------------------------
class StealthWorker(threading.Thread):
    def __init__(self, idx, jobs):
        super().__init__(name=f'stealth-{idx}', daemon=True)
        self.idx = idx
        self.jobs = jobs
        self.session = None
        self.uses = 0
        self.last_used = 0
        self.ready = False
        self.busy = False
        self.lock = threading.Lock()

    def _open(self, timeout_ms):
        from scrapling.fetchers import StealthySession
        opts = {'headless': True, 'disable_resources': False, 'timeout': timeout_ms,
                'block_ads': True, 'solve_cloudflare': True, 'retries': 1}
        if SSL_BYPASS_ENABLED:
            opts['additional_args'] = {'ignore_https_errors': True}
        s = StealthySession(**opts)
        s.__enter__()
        self.session = s
        self.uses = 0
        self.ready = True
        log(f'stealth worker {self.idx}: browser session opened')

    def _close(self, why=''):
        s, self.session, self.ready = self.session, None, False
        if s is not None:
            try:
                s.__exit__(None, None, None)
            except Exception:
                pass
            log(f'stealth worker {self.idx}: browser session closed ({why})')

    def run(self):
        while True:
            try:
                job = self.jobs.get(timeout=30)
            except queue.Empty:
                if self.session is not None and time.time() - self.last_used > STEALTH_IDLE_CLOSE_S:
                    self._close('idle')
                continue
            if job is None:
                self._close('shutdown')
                return
            self.busy = True
            try:
                job['result'] = self._fetch(job)
            except Exception as e:
                job['result'] = {'success': False, 'url': job['url'], 'layer': 'stealth',
                                 'error': f'stealth worker error: {str(e)[:300]}'}
            finally:
                self.busy = False
                self.last_used = time.time()
                job['done'].set()

    def _fetch(self, job):
        url = job['url']
        timeout_ms = int(job.get('timeout') or 20000)
        t0 = time.time()
        res = {'success': False, 'url': url, 'finalUrl': url, 'layer': 'stealth', 'httpStatus': None,
               'headers': {}, 'title': '', 'content': '', 'links': [], 'bodyHead': ''}
        if self.session is None or self.uses >= STEALTH_MAX_USES:
            self._close('recycle') if self.session is not None else None
            self._open(timeout_ms)
        try:
            page = self.session.fetch(url, timeout=timeout_ms, network_idle=bool(job.get('networkIdle', False)))
            self.uses += 1
        except Exception as e:
            # A dead browser must not poison the next request — recycle it.
            self._close(f'fetch error: {str(e)[:80]}')
            res['error'] = str(e)[:300]
            res['ms'] = int((time.time() - t0) * 1000)
            return res
        status = _status_of(page)
        res['httpStatus'] = status
        res['headers'] = _pick_headers(getattr(page, 'headers', {}) or {})
        try:
            res['finalUrl'] = str(getattr(page, 'url', url) or url)
        except Exception:
            pass
        raw = _body_text(page)
        res['bodyHead'] = raw[:6000]
        res.update(_html_stats(raw))
        res['title'] = _title_of(page)
        if status is not None and status >= 400:
            res['error'] = f'HTTP {status}'
            try:
                res['content'] = (page.get_all_text(separator='\n', strip=True) or '')[:4000]
            except Exception:
                pass
            res['ms'] = int((time.time() - t0) * 1000)
            return res
        text = extract_main_content(page) or ''
        # A thin render sometimes just needs a beat more JS — one cheap re-read of
        # the SAME page object is not possible with Scrapling's response model, so
        # re-fetch once with network_idle (what the cold script did with a 2 s sleep).
        if len(text.strip()) < 200 and not job.get('_retried'):
            try:
                page2 = self.session.fetch(url, timeout=max(timeout_ms, 30000), network_idle=True)
                self.uses += 1
                text2 = extract_main_content(page2) or ''
                if len(text2) > len(text):
                    text, page = text2, page2
                    res['title'] = _title_of(page) or res['title']
                    res['bodyHead'] = _body_text(page)[:6000]
            except Exception:
                pass
        res['content'] = text[: int(job.get('maxLength') or 50000)]
        if job.get('extractLinks'):
            res['links'] = _links_of(page)
        res['success'] = True
        res['ms'] = int((time.time() - t0) * 1000)
        return res


_stealth_jobs = queue.Queue()
_stealth_workers = []


def start_stealth_workers():
    for i in range(STEALTH_WORKERS):
        w = StealthWorker(i, _stealth_jobs)
        w.start()
        _stealth_workers.append(w)


def fetch_stealth(url, timeout_ms=20000, extract_links=False, max_length=50000, network_idle=False):
    if not _stealth_workers:
        return {'success': False, 'url': url, 'layer': 'stealth', 'error': 'stealth workers disabled'}
    job = {'url': url, 'timeout': timeout_ms, 'extractLinks': extract_links, 'maxLength': max_length,
           'networkIdle': network_idle, 'done': threading.Event(), 'result': None}
    _stealth_jobs.put(job)
    # Queue wait + fetch: bound at timeout + browser (re)launch headroom.
    if not job['done'].wait(timeout=(timeout_ms / 1000) + 45):
        return {'success': False, 'url': url, 'layer': 'stealth', 'error': 'stealth fetch timed out in queue'}
    return job['result'] or {'success': False, 'url': url, 'layer': 'stealth', 'error': 'no result'}


# ---------------------------------------------------------------------------
# Search (impersonated HTTP against several engines' HTML endpoints)
# ---------------------------------------------------------------------------
BLOCK_RE = re.compile(r'anomaly-modal|unusual traffic|Just a moment|verify you are human|'
                      r'cf-challenge|challenge-platform|<title>\s*Captcha|Please enable JavaScript', re.I)


def _ddg_decode(href):
    if '//duckduckgo.com/l/' in href and 'uddg=' in href:
        try:
            q = urllib.parse.urlparse(href).query
            return urllib.parse.parse_qs(q).get('uddg', [href])[0]
        except Exception:
            return href
    return href


def _bing_decode(href):
    # https://www.bing.com/ck/a?...&u=a1<base64url>&ntb=1
    try:
        if 'bing.com/ck/' in href:
            q = urllib.parse.urlparse(href).query
            u = urllib.parse.parse_qs(q).get('u', [''])[0]
            if u.startswith('a1'):
                s = u[2:]
                s += '=' * (-len(s) % 4)
                return base64.urlsafe_b64decode(s).decode('utf-8', 'ignore')
    except Exception:
        pass
    return href


def _yahoo_decode(href):
    # https://r.search.yahoo.com/_ylt=.../RU=<urlencoded>/RK=2/RS=...
    try:
        if 'r.search.yahoo.com' in href:
            m = re.search(r'/RU=([^/]+)/', href)
            if m:
                return urllib.parse.unquote(m.group(1))
    except Exception:
        pass
    return href


def _txt(el):
    try:
        return (el.get_all_text(separator=' ', strip=True) or '').strip()
    except Exception:
        try:
            return (el.text or '').strip()
        except Exception:
            return ''


def _search_one(engine, query, limit, timeout_s):
    eq = urllib.parse.quote_plus(query)
    t0 = time.time()
    tried = {'engine': engine, 'status': None, 'blocked': False, 'ms': 0}
    results = []
    from scrapling.fetchers import Fetcher
    kw = {'impersonate': 'chrome', 'timeout': timeout_s, 'stealthy_headers': True, 'retries': 1}
    if SSL_BYPASS_ENABLED:
        kw['verify'] = False
    try:
        if engine == 'ddg':
            page = Fetcher.get('https://html.duckduckgo.com/html/?q=' + eq, **kw)
            tried['status'] = _status_of(page)
            body = _body_text(page)
            if BLOCK_RE.search(body[:20000]) or tried['status'] in (202, 403, 429):
                tried['blocked'] = True
            else:
                for r in page.css('.result'):
                    a = r.css('a.result__a')
                    if not a:
                        continue
                    url = _ddg_decode(a[0].attrib.get('href', ''))
                    sn = r.css('.result__snippet')
                    if url.startswith('http'):
                        results.append({'title': _txt(a[0])[:200] or 'No title', 'url': url,
                                        'snippet': (_txt(sn[0]) if sn else '')[:300]})
        elif engine == 'bing':
            page = Fetcher.get('https://www.bing.com/search?q=' + eq + '&setlang=en&cc=US', **kw)
            tried['status'] = _status_of(page)
            for li in page.css('li.b_algo'):
                a = li.css('h2 a')
                if not a:
                    continue
                url = _bing_decode(a[0].attrib.get('href', ''))
                p = li.css('p')
                if url.startswith('http') and 'bing.com' not in urllib.parse.urlparse(url).netloc:
                    snippet = _txt(p[0]) if p else ''
                    snippet = re.sub(r'^\w{3} \d{1,2}, \d{4}\s*·\s*|^\d+ (?:day|hour|week)s? ago\s*·\s*', '', snippet)
                    results.append({'title': _txt(a[0])[:200] or 'No title', 'url': url, 'snippet': snippet[:300]})
            if not results and (tried['status'] != 200 or BLOCK_RE.search(_body_text(page)[:20000])):
                tried['blocked'] = True
        elif engine == 'yahoo':
            page = Fetcher.get('https://search.yahoo.com/search?p=' + eq, **kw)
            tried['status'] = _status_of(page)
            for d in page.css('div.algo'):
                h = d.css('h3 a')
                if not h:
                    continue
                url = _yahoo_decode(h[0].attrib.get('href', ''))
                sn = d.css('.compText p, p.fc-falcon, div.compText')
                if url.startswith('http') and 'yahoo.com' not in urllib.parse.urlparse(url).netloc:
                    results.append({'title': _txt(h[0])[:200] or 'No title', 'url': url,
                                    'snippet': (_txt(sn[0]) if sn else '')[:300]})
            if not results and tried['status'] != 200:
                tried['blocked'] = True
        elif engine == 'brave':
            page = Fetcher.get('https://search.brave.com/search?q=' + eq, **kw)
            tried['status'] = _status_of(page)
            body = _body_text(page)
            if tried['status'] in (403, 429) or BLOCK_RE.search(body[:20000]):
                tried['blocked'] = True
            else:
                for a in page.css('a[href^="http"]'):
                    href = a.attrib.get('href', '')
                    cls = a.attrib.get('class', '')
                    if 'brave.com' in href or 'svelte' not in cls:
                        continue
                    title_el = a.css('.title')
                    title = _txt(title_el[0]) if title_el else _txt(a)
                    if href.startswith('http') and title:
                        results.append({'title': title[:200], 'url': href, 'snippet': ''})
        else:
            tried['error'] = 'unknown engine'
    except Exception as e:
        tried['error'] = str(e)[:200]
        tried['blocked'] = True
    # de-dup, cap
    seen, out = set(), []
    for r in results:
        if r['url'] in seen:
            continue
        seen.add(r['url'])
        out.append(r)
        if len(out) >= limit:
            break
    tried['ms'] = int((time.time() - t0) * 1000)
    tried['count'] = len(out)
    return out, tried


def search(query, limit=5, engines=None, timeout_s=8):
    engines = [e for e in (engines or ['ddg', 'bing', 'yahoo', 'brave']) if e in ('ddg', 'bing', 'yahoo', 'brave')]
    tried = []
    for eng in engines:
        results, t = _search_one(eng, query, limit, timeout_s)
        tried.append(t)
        if results:
            return {'success': True, 'engine': eng, 'query': query, 'count': len(results),
                    'results': results, 'tried': tried}
    return {'success': False, 'engine': None, 'query': query, 'count': 0, 'results': [], 'tried': tried,
            'error': 'no engine returned results'}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._send(200, {
                'ok': True,
                'uptime': int(time.time() - STARTED_AT),
                'stealthWorkers': len(_stealth_workers),
                'stealthReady': sum(1 for w in _stealth_workers if w.ready),
                'stealthBusy': sum(1 for w in _stealth_workers if w.busy),
                'queued': _stealth_jobs.qsize(),
                'impersonateOk': _impersonate_ok,
            })
        self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        except Exception as e:
            return self._send(400, {'ok': False, 'error': f'bad json: {e}'})
        try:
            if self.path.startswith('/fetch'):
                url = str(body.get('url') or '').strip()
                if not url:
                    return self._send(400, {'ok': False, 'error': 'url required'})
                layer = body.get('layer') or 'impersonate'
                timeout = int(body.get('timeout') or 15000)
                links = bool(body.get('extractLinks'))
                max_len = int(body.get('maxLength') or 50000)
                if layer == 'stealth':
                    res = fetch_stealth(url, timeout, links, max_len, bool(body.get('networkIdle')))
                else:
                    res = fetch_impersonate(url, timeout, links, body.get('impersonate'), max_len)
                res['ok'] = True
                return self._send(200, res)
            if self.path.startswith('/search'):
                q = str(body.get('query') or '').strip()
                if not q:
                    return self._send(400, {'ok': False, 'error': 'query required'})
                res = search(q, int(body.get('limit') or 5), body.get('engines'), int(body.get('timeout') or 8))
                res['ok'] = True
                return self._send(200, res)
            return self._send(404, {'ok': False, 'error': 'not found'})
        except Exception as e:
            log('handler error', traceback.format_exc())
            return self._send(500, {'ok': False, 'error': str(e)[:300]})


def main():
    port = int(os.environ.get('WEB_ENGINE_PORT', '0') or 0)
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    start_stealth_workers()
    print(f'WEB_ENGINE_LISTENING {srv.server_address[1]}', flush=True)
    log(f'listening on 127.0.0.1:{srv.server_address[1]} stealth_workers={STEALTH_WORKERS}')
    # Warm the impersonate stack (imports) off the request path.
    threading.Thread(target=lambda: __import__('scrapling.fetchers'), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
