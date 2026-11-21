"""Runs one browser-use agent task and streams its progress as JSON lines.

Started by services/browserAgentService.js inside a throwaway container (no
volumes, no Docker socket, capabilities dropped), with the job in the BU_JOB
environment variable (base64 JSON):

    {task, baseUrl, apiKey, model, maxSteps, timeoutS, vision, shotMaxDim}

stdout carries one JSON object per line (everything else goes to stderr):

    {"type":"start", ...}
    {"type":"step", "n", "action", "code", "output", "error", "url", "title", "shot": <base64 jpeg> | null}
    {"type":"done", "status", "success", "result", "steps", "durationS", "error"}

browser-use 1.0 has the model write Python cells against the browser; the
step hook below runs after each cell, captures the page and reports it.
"""
import asyncio
import base64
import io
import json
import logging
import os
import re
import sys
import time
import traceback

os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
os.environ.setdefault('BH_TELEMETRY', '0')
os.environ.setdefault('BROWSER_USE_SETUP_LOGGING', 'false')

_out = sys.stdout
sys.stdout = sys.stderr  # stray prints from libraries must never corrupt the event stream


def emit(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + '\n')
    _out.flush()


def clip(s, n):
    s = '' if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + '…'


# A short, readable label for a cell, from the helper it calls first (earliest
# in the code wins; the generic page-reading patterns only when nothing else).
_HELPERS = [
    (r'\bopen_url\(\s*[\'"]([^\'"]+)', 'Opened {0}'),
    (r'\bnew_tab\(\s*[\'"]([^\'"]+)', 'Opened {0}'),
    (r'\bgoto_url\(\s*[\'"]([^\'"]+)', 'Went to {0}'),
    (r'\bfill\(\s*[\'"]([^\'"]{0,50})[\'"]\s*,\s*[\'"]([^\'"]{0,50})', 'Filled "{0}" with "{1}"'),
    (r'\bfill\(', 'Filled in a field'),
    (r'\bclick\(\s*[\'"]([^\'"]{0,60})', 'Clicked "{0}"'),
    (r'\bclick\(\s*(\d+)', 'Clicked element {0}'),
    (r'\bsolve_captcha\(', 'Handled a human check'),
    (r'\bgoto\(\s*[\'"]([^\'"]+)', 'Opened {0}'),
    (r'\bsearch\(\s*[\'"]([^\'"]{0,60})', 'Searched the site for "{0}"'),
    (r'\bnext_page\(', 'Went to the next page'),
    (r'\bdismiss_popups\(', 'Closed pop-ups'),
    (r'\bback\(\)', 'Went back'),
    (r'\bforward\(\)', 'Went forward'),
    (r'\breload\(\)', 'Reloaded the page'),
    (r'\bscroll_to\(\s*[\'"]([^\'"]{0,50})', 'Scrolled to "{0}"'),
    (r'\bscroll_down\(', 'Scrolled down'),
    (r'\bscroll_up\(', 'Scrolled up'),
    (r'\bclick_at_xy\(', 'Clicked on the page'),
    (r'\bfill_input\(', 'Filled in a field'),
    (r'\btype_text\(\s*[\'"]([^\'"]{0,60})', 'Typed "{0}"'),
    (r'\btype_secret\(', 'Typed a saved secret'),
    (r'\bpress_key\(\s*[\'"]([^\'"]+)', 'Pressed {0}'),
    (r'\bscroll\(', 'Scrolled the page'),
    (r'\bupload_file\(', 'Uploaded a file'),
    (r'\bswitch_tab\(|\bactivate_tab\(', 'Switched tabs'),
    (r'\bclose_tab\(', 'Closed a tab'),
    (r'\bwait_for_element\(', 'Waited for an element'),
    (r'\bwait_for_load\(|\bwait_for_network_idle\(|\bwait\(', 'Waited for the page'),
    (r'\bcapture_screenshot\(|\bscreenshot\(', 'Took a screenshot'),
    (r'\bhttp_get\(', 'Fetched a URL directly'),
    (r'\.click\(\)', 'Clicked an element'),
    (r'\.value\s*=', 'Filled in a field'),
    (r'\.submit\(\)', 'Submitted a form'),
    (r'\bcheckpoint\(', 'Saved progress'),
    (r'\bfinish\(|\bdone\(', 'Finished'),
]
_GENERIC = [
    (r'\blook\(', 'Looked at the page'),
    (r'\btables\(', 'Read the tables'),
    (r'\blinks\(', 'Listed the links'),
    (r'\belements\(', 'Listed the page controls'),
    (r'\bfind_text\(\s*[\'"]([^\'"]{0,50})', 'Searched the page for "{0}"'),
    (r'\bread_page\(', 'Read the page'),
    (r'\bpage_info\(', 'Checked the page'),
    (r'Accessibility\.|getFullAXTree|DOM\.getBoxModel|DOM\.getDocument', 'Mapped the page elements'),
    (r'innerText|textContent|querySelectorAll|outerHTML|innerHTML', 'Read the page'),
    (r'\bjs\(', 'Ran a script on the page'),
]


def _label(m, label):
    try:
        return label.format(*[clip(g, 80) for g in m.groups()])
    except Exception:
        return label


def describe(code):
    body = '\n'.join(x for x in code.splitlines() if not x.strip().startswith('#'))
    best = None
    for pattern, label in _HELPERS:
        m = re.search(pattern, body)
        if m and (best is None or m.start() < best[0].start()):
            best = (m, label)
    if best:
        return _label(*best)
    for pattern, label in _GENERIC:
        m = re.search(pattern, body)
        if m:
            return _label(m, label)
    first = next((x.strip() for x in code.splitlines()
                  if x.strip() and not re.match(r'\s*(#|import |from \S+ import )', x)), '')
    return clip(first or 'Ran a step', 90)


def intent(code):
    """The model's own comment at the top of the cell, when it wrote one."""
    for x in code.splitlines():
        x = x.strip()
        if not x:
            continue
        if x.startswith('#'):
            t = x.lstrip('#').strip()
            if len(t) > 6 and not t.lower().startswith(('-*-', 'noqa', 'type:')):
                return clip(t, 160)
            continue
        break
    return ''


SHOT_CODE = r'''
import json as __ms_json
try:
    __ms_rep = _ms_step_report(%s)
except Exception as __ms_e:
    try:
        __ms_rep = {"info": page_info(), "clicks": []}
    except Exception as __ms_e2:
        __ms_rep = {"info": {"error": str(__ms_e2)}, "clicks": []}
__ms_path = None
if not (isinstance(__ms_rep.get("info"), dict) and __ms_rep["info"].get("dialog")):
    try:
        __ms_path = capture_screenshot("/tmp/bu-shot.png", max_dim=%d)
    except Exception:
        __ms_path = None
__ms_rep["path"] = __ms_path
print("__MS_SHOT__" + __ms_json.dumps(__ms_rep, default=str))
'''

# Loads browser_agent_helpers.py into the REPL namespace when it is missing
# (first cell, and after a cell timeout restarted the worker).
ENSURE_CODE = '''
try:
    _ms_ready
except NameError:
    import base64 as __ms_b64, json as __ms_j
    _ms_cfg = __ms_j.loads(__ms_b64.b64decode(%r).decode("utf-8"))
    exec(compile(__ms_b64.b64decode(%r).decode("utf-8"), "browser_agent_helpers.py", "exec"), globals())
'''


# CDP's Runtime.enable makes the page observable to anti-bot scripts (the
# classic leak: console/Error serialisation fires only while a client has the
# Runtime domain on). Measured: Realtor's Kasada check answered 429 "This is
# taking longer than usual" with Runtime enabled and served the page with every
# other domain (Page, DOM, Network, the Fetch guard) on. Nothing in
# browser-use/browser-harness consumes Runtime EVENTS (Runtime.evaluate and
# isolated worlds work without the domain enabled), so the enable is skipped in
# every process that talks CDP: this one, and through sitecustomize on
# PYTHONPATH the browser-harness daemon and the REPL workers it starts.
NO_RUNTIME_ENABLE = r'''
def _ms_patch_cdp():
    try:
        from cdp_use.client import CDPClient
    except Exception:
        return
    if getattr(CDPClient.send_raw, "_ms_patched", False):
        return
    orig = CDPClient.send_raw

    async def send_raw(self, method, *a, **kw):
        if method == "Runtime.enable":
            return {}
        return await orig(self, method, *a, **kw)

    send_raw._ms_patched = True
    CDPClient.send_raw = send_raw


_ms_patch_cdp()
'''


def install_cdp_quiet():
    if os.environ.get('BU_RUNTIME_ENABLE') == '1':
        return
    d = '/tmp/ms-site'
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'sitecustomize.py'), 'w') as f:
            f.write(NO_RUNTIME_ENABLE)
        os.environ['PYTHONPATH'] = d + (os.pathsep + os.environ['PYTHONPATH'] if os.environ.get('PYTHONPATH') else '')
        exec(compile(NO_RUNTIME_ENABLE, 'ms-sitecustomize', 'exec'), {})
    except Exception as e:
        print(f'[browser-agent] could not install the CDP patch: {e}', file=sys.stderr)


def start_display():
    """A real (virtual) screen so Chrome runs as an ordinary HEADED browser.
    Headless Chrome is told apart from a normal one by more than its user agent
    (rendering, window/screen metrics, missing GPU/plugins, timing); measured on
    this host, Lowe's (Akamai) and Redfin served the headed browser and refused
    the headless one with identical flags. BU_HEADED=0 keeps headless."""
    import shutil
    import subprocess
    if os.environ.get('BU_HEADED') == '0' or not shutil.which('Xvfb'):
        return None
    if os.environ.get('DISPLAY'):
        return None
    for n in range(90, 100):
        if os.path.exists(f'/tmp/.X{n}-lock'):
            continue
        os.makedirs('/tmp/.X11-unix', exist_ok=True)
        try:
            p = subprocess.Popen(['Xvfb', f':{n}', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            print(f'[browser-agent] Xvfb failed to start: {e}', file=sys.stderr)
            return None
        for _ in range(40):
            if os.path.exists(f'/tmp/.X11-unix/X{n}'):
                os.environ['DISPLAY'] = f':{n}'
                return p
            if p.poll() is not None:
                break
            time.sleep(0.05)
        try:
            p.kill()
        except Exception:
            pass
    print('[browser-agent] no virtual display; running headless', file=sys.stderr)
    return None


def stealth_args(chrome, headed=False):
    """Launch flags that stop the browser announcing itself as automated.
    Headless Chrome says "HeadlessChrome" in its user agent and sets the
    AutomationControlled blink feature; Cloudflare Turnstile and similar checks
    refuse it on that alone (measured: gsmarena's Turnstile passed invisibly with
    these two changes, and never passed without them, however often clicked)."""
    import subprocess
    major = None
    if os.environ.get('BU_STEALTH') == '0':
        return []
    try:
        v = subprocess.run([chrome, '--version'], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r'(\d+)\.\d+\.\d+', v)
        major = m.group(1) if m else None
    except Exception:
        major = None
    out = ['--disable-blink-features=AutomationControlled', '--lang=en-US,en']
    if headed:
        # A headed Chrome already reports its real user agent; overriding it
        # would only add a mismatch (client hints, platform) a site can see.
        return out + ['--window-size=1440,900', '--window-position=0,0',
                     '--use-angle=swiftshader', '--enable-unsafe-swiftshader']  # WebGL: having none is a tell
    if major:
        out.append(f'--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36')
    return out


def find_chrome():
    import glob
    for pat in ('/root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome',
                '/usr/src/app/.playwright/chromium-*/chrome-linux*/chrome'):
        hits = sorted(glob.glob(pat), key=lambda p: int(re.search(r'chromium-(\d+)', p).group(1)), reverse=True)
        if hits:
            return hits[0]
    return None


BASE_RULES = (
    'You are driving a real browser for a user. Always open and look at the page with python() before you answer; '
    'never answer from memory. Report only what the page actually showed, with the URL.\n'
    'EASY HELPERS (pre-loaded, synchronous; use them, not raw cdp()/js() or CSS selectors you guessed):\n'
    '- open_url(url) -> {url,title,popups,obstacle,text}: navigates, waits, accepts cookie banners, passes a simple human check; text = start of the page.\n'
    '- look() -> one printable view: URL, title, headings, start of the text, numbered controls, next page. print(look()) whenever you are unsure what is on screen.\n'
    '- click(target) / fill(target, value, submit=False): target = a number from look()/elements(), the visible text ("Search", "Next") '
    'or a label/placeholder. fill handles text boxes, <select> (by option text) and checkboxes (True/False). '
    'Both return {changed, url, title, new_text}: new_text is the text that APPEARED after the action (search results, an opened panel) - read it instead of re-reading the page.\n'
    '- search(query): uses the site\'s own search box. next_page(): goes to the next page of results.\n'
    '- links(query=None) -> [{text, href}] absolute URLs; open_url(href) is faster than clicking a link you can see.\n'
    '- tables() -> rows of every data/spec table. read_page(max_chars=6000, start=0), find_text(term) for longer text.\n'
    '- elements(query=None), scroll_down(), scroll_to(text), back(), reload(), dismiss_popups().\n'
    '- solve_captcha(): a "Just a moment" page, a Turnstile / reCAPTCHA / hCaptcha checkbox or press-and-hold is handled like a person; '
    'open_url() already tries it once. If it reports solved=False, try reload() once and look() again; if still blocked, stop and say exactly what '
    'the page shows. Never try to solve picture puzzles.\n'
    'WORK IN FEW STEPS: do several actions in ONE cell and print what you need, e.g.\n'
    '  r = open_url("https://site/x"); print(r["title"]); print(look())\n'
    '  print(fill("Author", "Albert Einstein")); print(fill("Tag", "change")); print(click("Search")["new_text"])\n'
    'Check each result (changed/new_text) before going on; if a click did nothing, print(look()) and pick the right control by number. '
    'As soon as you have what the task asks for, finish with the answer - do not re-verify what you already printed. '
    'Login walls you have no credentials for: stop and say so.\n'
    'BLOCKED PAGES: if open_url() returns blocked=True (or obstacle kind "blocked"), the site refused this browser; '
    'no reload, wait or click changes that. Do not retry that site: open another site that has the same information, '
    'or finish at once and say the site blocked access.'
)


def to_jpeg(path, max_dim):
    try:
        from PIL import Image
        img = Image.open(path).convert('RGB')
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim))
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=62, optimize=True)
        return base64.b64encode(buf.getvalue()).decode('ascii')
    except Exception:
        return None


async def main():
    job = json.loads(base64.b64decode(os.environ['BU_JOB']).decode('utf-8'))
    from browser_use import Agent, Browser, ChatOpenAI
    from browser_use.agent import loop as bu_loop
    from browser_use.agent import service as bu_service

    max_dim = int(job.get('shotMaxDim') or 960)
    auto_captcha = job.get('autoCaptcha', True) is not False
    state = {'n': 0, 'blocks': {}}

    # Helpers into the REPL before the model's first cell (and after a restart).
    from browser_use.repl.session import Repl
    here = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/tmp'
    helpers_src = os.environ.get('BU_HELPERS') or ''
    if not helpers_src and os.path.exists(os.path.join(here, 'browser_agent_helpers.py')):
        helpers_src = base64.b64encode(open(os.path.join(here, 'browser_agent_helpers.py'), 'rb').read()).decode()
    cfg_src = base64.b64encode(json.dumps(job.get('helperConfig') or {}).encode()).decode()
    ensure = ENSURE_CODE % (cfg_src, helpers_src) if helpers_src else None
    orig_call = Repl.call

    async def call(self, op, code, timeout):
        if ensure and op == 'exec' and not getattr(self, '_ms_loading', False):
            self._ms_loading = True
            try:
                r = await orig_call(self, 'exec', ensure, 30)
                if r.get('error'):
                    print(f'[browser-agent] helpers failed to load: {str(r["error"])[-400:]}', file=sys.stderr)
            except Exception as e:
                print(f'[browser-agent] helpers failed to load: {e}', file=sys.stderr)
            finally:
                self._ms_loading = False
        return await orig_call(self, op, code, timeout)

    Repl.call = call

    class ReportingSession(bu_loop.Session):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            session = self

            async def after_tool(name, args, r):
                state['n'] += 1
                code = (args or {}).get('code', '') or ''
                info, shot, rep = {}, None, {}
                try:
                    s = await session.repl.call('exec', SHOT_CODE % ('True' if auto_captcha else 'False', max_dim), 75)
                    m = re.search(r'__MS_SHOT__(\{.*\})', s.get('output') or '')
                    if m:
                        got = json.loads(m.group(1))
                        info = got.get('info') or {}
                        rep = got
                        if got.get('path'):
                            shot = to_jpeg(got['path'], max_dim)
                except Exception as e:
                    print(f'[browser-agent] screenshot failed: {e}', file=sys.stderr)
                err = (r or {}).get('error') or ''
                blk = rep.get('blocked') if isinstance(rep, dict) else None
                if blk:
                    h = blk.get('host') or ''
                    state['blocks'][h] = state['blocks'].get(h, 0) + 1
                    state['lastBlock'] = blk
                    # The page refused the browser twice: no step can change that,
                    # so end the run now instead of letting the model retry.
                    if state['blocks'][h] >= (1 if job.get('stopOnBlock') else 2) and state.get('task') and not state.get('stopped'):
                        state['stopped'] = 'blocked'
                        state['task'].cancel()
                emit({
                    'type': 'step', 'n': state['n'],
                    'action': describe(code),
                    'code': clip(code, 1500),
                    'output': clip((r or {}).get('output') or '', 600),
                    'error': clip(err.strip().splitlines()[-1] if err.strip() else '', 300),
                    'url': clip(info.get('url') or '', 500) if isinstance(info, dict) else '',
                    'title': clip(info.get('title') or '', 200) if isinstance(info, dict) else '',
                    'dialog': bool(isinstance(info, dict) and info.get('dialog')),
                    'note': intent(code),
                    'clicks': [c for c in (rep.get('clicks') or []) if isinstance(c, list) and len(c) == 2][-6:],
                    'viewport': [info.get('w'), info.get('h')] if isinstance(info, dict) and info.get('w') else None,
                    'obstacle': rep.get('obstacle'),
                    'captcha': rep.get('captcha'),
                    'blocked': rep.get('blocked'),
                    'shot': shot,
                    't': round(time.time(), 2),
                })

            self.after_tool = after_tool

    bu_service.Session = ReportingSession  # Agent._run builds its Session through this name

    install_cdp_quiet()
    display = start_display()
    headed = display is not None
    chrome = job.get('chromePath') or find_chrome()
    extra_args = stealth_args(chrome, headed) if chrome else []
    if extra_args:
        from browser_use.browser import local as bu_local
        orig_args = bu_local.chrome_args

        def chrome_args(*a, **kw):
            args = orig_args(*a, **kw)
            return [*args[:-1], *extra_args, args[-1]]

        bu_local.chrome_args = chrome_args

    llm = ChatOpenAI(job['model'], base_url=job['baseUrl'], api_key=job.get('apiKey') or 'none',
                     temperature=job.get('temperature'))
    browser = Browser(
        'chromium', headless=not headed,
        executable_path=chrome,
        block_ip_addresses=not job.get('allowInternal'),
    )
    agent = Agent(
        job['task'], llm=llm, browser=browser,
        use_vision=bool(job.get('vision')),
        highlight_actions=False,
        extend_system_message='\n'.join(x for x in (BASE_RULES, job.get('extraSystem')) if x),
        workspace='/tmp/bu-workspace',
    )
    t0 = time.time()
    emit({'type': 'start', 'task': clip(job['task'], 600), 'model': job['model'], 'maxSteps': job.get('maxSteps'),
          'headed': headed})
    try:
        state['task'] = asyncio.ensure_future(agent.run(max_steps=int(job.get('maxSteps') or 20), timeout=float(job.get('timeoutS') or 300)))
        try:
            r = await state['task']
        except asyncio.CancelledError:
            if state.get('stopped') != 'blocked':
                raise
            b = state.get('lastBlock') or {}
            st = f" (HTTP {b['status']})" if b.get('status') else ''
            emit({'type': 'done', 'status': 'blocked', 'success': False,
                  'result': f"BLOCKED: {b.get('host') or 'the site'} refused this browser{st}: {b.get('why') or 'access denied'}. "
                            f"Page said: {b.get('text') or ''}",
                  'blocked': b, 'steps': state['n'], 'cells': state['n'], 'durationS': round(time.time() - t0, 1),
                  'error': None, 'usage': {}})
            return
        partial = getattr(r, 'partial', None)
        emit({
            'type': 'done', 'status': r.status, 'success': r.success,
            'result': clip(r.final_result() or '', 12000),
            'partial': clip(json.dumps(partial, ensure_ascii=False) if partial is not None and not isinstance(partial, str) else (partial or ''), 4000),
            'steps': r.steps, 'cells': state['n'], 'durationS': round(time.time() - t0, 1),
            'error': clip(r.error or '', 1000) or None,
            'usage': dict(r.usage or {}),
        })
    except Exception as e:
        traceback.print_exc()
        emit({'type': 'done', 'status': 'error', 'success': False, 'result': '', 'steps': state['n'],
              'cells': state['n'], 'durationS': round(time.time() - t0, 1), 'error': clip(f'{type(e).__name__}: {e}', 1000)})
    finally:
        try:
            await agent.close()
        except Exception:
            pass
        if display is not None:
            try:
                display.kill()
            except Exception:
                pass


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(levelname)s %(name)s: %(message)s')
    asyncio.run(main())
