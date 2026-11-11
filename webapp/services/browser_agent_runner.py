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
    'EASY HELPERS (pre-loaded, synchronous; prefer them over raw cdp/js):\n'
    '- open_url(url) -> {url,title,popups,obstacle}: navigates, waits, closes cookie banners, passes a simple human check.\n'
    '- elements(query=None) -> numbered visible controls [{i,tag,text,x,y,value?,options?,checked?,href?,covered?,offscreen?}]. '
    'Print it to see what you can click or fill.\n'
    '- click(target): target = a number from elements(), the visible text ("Search", "Next"), or a CSS selector ("#go"). '
    'Real mouse movement + click, waits for the page to react; returns {clicked,url,title,changed}.\n'
    '- fill(target, value, submit=False): text field by label/placeholder/name (clears and types), <select> by option text, '
    'checkbox by True/False. submit=True presses Enter.\n'
    '- read_page(max_chars=6000), find_text(term), scroll_down(), scroll_up(), scroll_to(text), back(), forward(), reload().\n'
    '- dismiss_popups(): close cookie/consent banners and nag dialogs.\n'
    '- obstacle() / solve_captcha(): a "Just a moment" page, a Turnstile / reCAPTCHA / hCaptcha "I am human" checkbox or a '
    'press-and-hold button is handled like a person would; it returns {found,kind,solved,detail}. If it says a picture '
    'puzzle needs a person, or it did not pass, stop and tell the user the site asks for a CAPTCHA. Never try to solve '
    'image puzzles yourself.\n'
    'Do several steps in ONE cell (e.g. open_url, fill, click, then print(read_page()[:3000])). After each action check the '
    'result (changed/url/title) before going on. If a click did nothing, call elements() and pick the right control. '
    'After choosing an option that reloads part of the page, read the page again before the next step. Submit forms with '
    'their real submit button or fill(..., submit=True). Login walls you have no credentials for: stop and say so.'
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
    state = {'n': 0}

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
                    'shot': shot,
                    't': round(time.time(), 2),
                })

            self.after_tool = after_tool

    bu_service.Session = ReportingSession  # Agent._run builds its Session through this name

    llm = ChatOpenAI(job['model'], base_url=job['baseUrl'], api_key=job.get('apiKey') or 'none',
                     temperature=job.get('temperature'))
    browser = Browser(
        'chromium', headless=True,
        executable_path=job.get('chromePath') or find_chrome(),
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
    emit({'type': 'start', 'task': clip(job['task'], 600), 'model': job['model'], 'maxSteps': job.get('maxSteps')})
    try:
        r = await agent.run(max_steps=int(job.get('maxSteps') or 20), timeout=float(job.get('timeoutS') or 300))
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


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(levelname)s %(name)s: %(message)s')
    asyncio.run(main())
