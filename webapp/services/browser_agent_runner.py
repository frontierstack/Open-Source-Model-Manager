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


# A short, readable label for a cell, from the helper it calls first.
_HELPERS = [
    (r'\bnew_tab\(\s*[\'"]([^\'"]+)', 'Opened {0}'),
    (r'\bgoto_url\(\s*[\'"]([^\'"]+)', 'Went to {0}'),
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
    (r'\bpage_info\(', 'Checked the page'),
    (r'\bcheckpoint\(', 'Saved progress'),
    (r'\bfinish\(|\bdone\(', 'Finished'),
    (r'Accessibility\.|getFullAXTree|DOM\.getBoxModel|DOM\.getDocument', 'Mapped the page elements'),
    (r'innerText|textContent|querySelectorAll|outerHTML|innerHTML', 'Read the page'),
    (r'\bjs\(', 'Ran a script on the page'),
]


def describe(code):
    for pattern, label in _HELPERS:
        m = re.search(pattern, code)
        if m:
            try:
                return label.format(*[clip(g, 80) for g in m.groups()])
            except Exception:
                return label
    first = next((x.strip() for x in code.splitlines()
                  if x.strip() and not re.match(r'\s*(#|import |from \S+ import )', x)), '')
    return clip(first or 'Ran a step', 90)


SHOT_CODE = r'''
import json as __ms_json
try:
    __ms_info = page_info()
except Exception as __ms_e:
    __ms_info = {"error": str(__ms_e)}
__ms_path = None
if not (isinstance(__ms_info, dict) and __ms_info.get("dialog")):
    try:
        __ms_path = capture_screenshot("/tmp/bu-shot.png", max_dim=%d)
    except Exception:
        __ms_path = None
print("__MS_SHOT__" + __ms_json.dumps({"info": __ms_info, "path": __ms_path}))
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
    'never answer from memory. Prefer reading the page text (js / page_info) over guessing. If a site shows a login wall, '
    'CAPTCHA or bot check you cannot pass, stop and say so plainly. Report only what the page actually showed, with the URL. '
    'Interact like a person so the page\'s own scripts react: use real clicks, typing and key presses (click_at_xy, type_text, '
    'press_key) on the element\'s on-screen position. If you set a field or <select> through js() instead, dispatch "input" and '
    '"change" events on it afterwards, and after choosing an option that reloads part of the page, wait and read the page again '
    'before the next step. Submit forms by clicking their real submit button.'
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
    state = {'n': 0}

    class ReportingSession(bu_loop.Session):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            session = self

            async def after_tool(name, args, r):
                state['n'] += 1
                code = (args or {}).get('code', '') or ''
                info, shot = {}, None
                try:
                    s = await session.repl.call('exec', SHOT_CODE % max_dim, 20)
                    m = re.search(r'__MS_SHOT__(\{.*\})', s.get('output') or '')
                    if m:
                        got = json.loads(m.group(1))
                        info = got.get('info') or {}
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
