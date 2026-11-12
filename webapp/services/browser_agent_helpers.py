# Helpers loaded into the browser agent's Python REPL (browser-use 1.0 /
# browser-harness). services/browser_agent_runner.py runs this file in the REPL
# namespace before the model's first cell and again after a worker restart (a
# cell timeout loses the namespace). It runs AFTER browser-harness's helpers
# are star-imported, so cdp(), js(), goto_url(), page_info(), type_text(),
# press_key(), wait_for_load() ... already exist here.
#
# What it adds, for small local models that fumble raw CDP:
#   elements()            numbered list of the visible controls on the page
#   click(target)         click by number, visible text or CSS selector, with real mouse movement
#   fill(target, value)   fill a text field / choose a <select> option / tick a checkbox
#   open_url(url)         navigate, wait, close cookie banners, handle a simple captcha
#   back() forward() reload() scroll_down() scroll_up() scroll_to(text)
#   read_page() find_text(term) dismiss_popups() obstacle() solve_captcha()
#   look() links() tables() next_page() search(query)
# click_at_xy() is replaced by a version that moves the mouse there first and
# records the click, so the chat can mark it on the step's screenshot.

import json as _msj
import random as _msr
import re as _msre
import time as _mst

_ms_ready = True
_ms_clicks = []          # [[x, y], ...] since the last step report (viewport CSS px)
_ms_mouse = [320.0, 240.0]
_ms_els = []             # last elements() result
_ms_cfg = globals().get('_ms_cfg') or {}
try:
    _ms_raw_click
except NameError:
    _ms_raw_click = click_at_xy  # noqa: F821  (browser-harness helper)


def _ms_sleep(a, b):
    _mst.sleep(_msr.uniform(a, b))


def _ms_move(x, y):
    """Move the mouse along a slight curve, like a hand would (hover menus and
    some bot checks only react to real pointer movement)."""
    sx, sy = _ms_mouse
    d = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5
    n = max(4, min(16, int(d / 45)))
    bend = min(60.0, d * 0.15)
    cx = (sx + x) / 2 + _msr.uniform(-bend, bend)
    cy = (sy + y) / 2 + _msr.uniform(-bend, bend)
    for i in range(1, n + 1):
        t = i / n
        t = t * t * (3 - 2 * t)
        px = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * x
        py = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * y
        try:
            cdp('Input.dispatchMouseEvent', type='mouseMoved', x=px, y=py)  # noqa: F821
        except Exception:
            break
        _mst.sleep(_msr.uniform(0.004, 0.014))
    _ms_mouse[0], _ms_mouse[1] = float(x), float(y)


def click_at_xy(x, y, button='left', clicks=1):
    """Real mouse click at viewport coordinates (moves the pointer there first)."""
    x, y = float(x), float(y)
    _ms_move(x, y)
    _ms_clicks.append([round(x, 1), round(y, 1)])
    cdp('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y, button=button, clickCount=clicks)  # noqa: F821
    _ms_sleep(0.035, 0.11)
    cdp('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y, button=button, clickCount=clicks)  # noqa: F821


# ---- page-side scripts --------------------------------------------------------
# One JS library installed per document (window.__ms). It walks the document,
# open shadow roots and same-origin iframes, and maps elements to TOP-viewport
# coordinates (frame offsets added), so a click lands where the element shows.
_MS_LIB = r'''
(() => {
  if (window.__ms && window.__ms.v === 3) return true;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[role=switch],[role=searchbox],[role=textbox],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const roots = () => {
    const out = [];
    const walk = (root, ox, oy, depth) => {
      out.push({ root, ox, oy });
      if (depth > 3) return;
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) walk(el.shadowRoot, ox, oy, depth + 1);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            const d = el.contentDocument;
            if (d && d.documentElement) {
              const r = el.getBoundingClientRect();
              walk(d, ox + r.left + el.clientLeft, oy + r.top + el.clientTop, depth + 1);
            }
          } catch (_) {}
        }
      });
    };
    walk(document, 0, 0, 0);
    return out;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  };
  const label = (el) => {
    const doc = el.ownerDocument;
    let t = el.getAttribute('aria-label') || '';
    if (!t && el.id) { const l = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText; }
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\s+/).map(id => (doc.getElementById(id) || {}).innerText || '').join(' ');
    }
    if (!t && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const l = el.closest('label'); if (l) t = l.innerText;
      if (!t) t = el.placeholder || el.name || el.title || '';
      if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test(el.type)) t = el.value || t;
    }
    if (!t) t = (el.innerText || el.textContent || '').trim();
    if (!t) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) t = img.alt; }
    if (!t) t = el.title || el.getAttribute('data-tooltip') || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 90);
  };
  const box = (el, ox, oy) => {
    const r = el.getBoundingClientRect();
    return { x: ox + r.left + r.width / 2, y: oy + r.top + r.height / 2, w: r.width, h: r.height, top: oy + r.top, left: ox + r.left };
  };
  const covered = (el, b) => {
    if (b.x < 0 || b.y < 0 || b.x > innerWidth || b.y > innerHeight) return false;
    let hit = document.elementFromPoint(b.x, b.y);
    for (let i = 0; i < 4 && hit && hit.shadowRoot; i++) { const d = hit.shadowRoot.elementFromPoint(b.x, b.y); if (!d || d === hit) break; hit = d; }
    if (!hit || hit.tagName === 'IFRAME') return false;
    return !(hit === el || el.contains(hit) || hit.contains(el));
  };
  const find = (opts) => {
    const all = [];
    for (const { root, ox, oy } of roots()) {
      root.querySelectorAll(opts.css || INTERACTIVE).forEach(el => {
        if (!visible(el)) return;
        if (!opts.css && el.tagName === 'LABEL' && el.control && visible(el.control)) return;
        all.push({ el, ox, oy });
      });
    }
    // Drop an element whose interactive ancestor is also listed (a <span> inside a <button>).
    const set = new Set(all.map(a => a.el));
    return all.filter(a => { let p = a.el.parentElement; for (let i = 0; i < 4 && p; i++, p = p.parentElement) if (set.has(p) && !opts.css) return false; return true; });
  };
  const describe = (a, i) => {
    const el = a.el, b = box(el, a.ox, a.oy);
    const tag = el.tagName.toLowerCase();
    const o = { i, tag, text: label(el), x: Math.round(b.x), y: Math.round(b.y) };
    const role = el.getAttribute('role'); if (role) o.role = role;
    if (tag === 'input') { o.type = el.type; if (!/^(submit|button|reset|checkbox|radio)$/.test(el.type) && el.value) o.value = String(el.value).slice(0, 60); }
    if (tag === 'textarea' && el.value) o.value = el.value.slice(0, 60);
    if (tag === 'select') { o.value = (el.options[el.selectedIndex] || {}).text || ''; o.options = Array.from(el.options).slice(0, 12).map(x => x.text.trim()).filter(Boolean); }
    if (el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox' || role === 'switch') o.checked = !!(el.checked || el.getAttribute('aria-checked') === 'true');
    if (tag === 'a') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript')) o.href = h.slice(0, 120); }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') o.disabled = true;
    if (b.y < 0 || b.y > innerHeight || b.x < 0 || b.x > innerWidth) o.offscreen = true;
    else if (covered(el, b)) o.covered = true;
    return o;
  };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pick = (target, opts) => {
    opts = opts || {};
    let list;
    if (typeof target === 'number') return (window.__ms.last || [])[target] || null;
    const t = String(target);
    if (/^css:/.test(t) || /^[#.\[]/.test(t) || /^[a-z]+[#.\[]/.test(t)) {
      try { list = find({ css: t.replace(/^css:/, '') }); } catch (e) { return { error: 'bad selector: ' + e.message }; }
      return list[opts.nth || 0] || null;
    }
    const want = norm(t);
    list = find({});
    const fields = opts.field ? list.filter(a => /^(INPUT|TEXTAREA|SELECT)$/.test(a.el.tagName) || a.el.isContentEditable || /textbox|searchbox|combobox/.test(a.el.getAttribute('role') || '')) : list;
    const scored = [];
    for (const a of fields) {
      const l = norm(label(a.el));
      const extra = norm([a.el.placeholder, a.el.name, a.el.id, a.el.title, a.el.value].filter(Boolean).join(' '));
      let s = 0;
      if (l === want) s = 100; else if (l.startsWith(want)) s = 70; else if (l.includes(want)) s = 50;
      else if (extra.includes(want)) s = 40;
      if (!s) continue;
      if (/^(BUTTON|INPUT)$/.test(a.el.tagName) || a.el.getAttribute('role') === 'button') s += 5;
      if (l.length > want.length * 4) s -= 15;
      const b = box(a.el, a.ox, a.oy);
      if (b.y >= 0 && b.y <= innerHeight) s += 3;
      scored.push({ a, s });
    }
    scored.sort((p, q) => q.s - p.s);
    const hit = scored[opts.nth || 0];
    return hit ? hit.a : null;
  };
  window.__ms = {
    v: 3,
    elements(limit, query) {
      let list = find({});
      if (query) { const q = norm(query); list = list.filter(a => norm(label(a.el)).includes(q)); }
      const inView = list.filter(a => { const b = box(a.el, a.ox, a.oy); return b.y >= -40 && b.y <= innerHeight + 40; });
      const rest = list.filter(a => !inView.includes(a));
      list = inView.concat(rest).slice(0, limit || 60);
      window.__ms.last = list;
      return list.map((a, i) => describe(a, i));
    },
    locate(target, opts) {
      const a = typeof target === 'number' ? (window.__ms.last || [])[target] : pick(target, opts);
      if (!a) return null;
      if (a.error) return a;
      a.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const d = describe(a, -1);
      const b = box(a.el, a.ox, a.oy);
      window.__ms.cur = a;
      return Object.assign(d, { w: Math.round(b.w), h: Math.round(b.h), tagName: a.el.tagName, editable: /^(INPUT|TEXTAREA)$/.test(a.el.tagName) || a.el.isContentEditable });
    },
    setSelect(text) {
      const a = window.__ms.cur; if (!a || a.el.tagName !== 'SELECT') return { error: 'not a <select>' };
      const want = norm(text); const opts = Array.from(a.el.options);
      const o = opts.find(x => norm(x.text) === want || norm(x.value) === want) || opts.find(x => norm(x.text).includes(want) || norm(x.value).includes(want));
      if (!o) return { error: 'no option matches', options: opts.slice(0, 30).map(x => x.text.trim()) };
      const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      proto.set.call(a.el, o.value);
      a.el.dispatchEvent(new Event('input', { bubbles: true }));
      a.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { chosen: o.text.trim() };
    },
    curValue() { const a = window.__ms.cur; return a ? (a.el.value != null ? String(a.el.value) : (a.el.innerText || '')) : null; },
    sig() { return location.href + '|' + document.title + '|' + (document.body ? document.body.innerText.length : 0); },
  };
  return true;
})()
'''


def _ms_js(expr):
    js(_MS_LIB)  # noqa: F821  (cheap after the first call per document)
    return js(expr)  # noqa: F821


def _ms_sig():
    try:
        return _ms_js('window.__ms.sig()')
    except Exception:
        return None


# Text the page shows, minus the option lists of <select>s (a form's option
# lists otherwise fill read_page before the results get a line).
_MS_TEXT_JS = r'''(() => {
  const opt = new Set();
  document.querySelectorAll('select').forEach(s => { if (s.options.length > 4) Array.from(s.options).forEach(o => opt.add(o.text.trim())); });
  const pick = () => {
    const b = document.body; if (!b) return '';
    const m = document.querySelector('main,[role=main]') || (document.querySelectorAll('article').length === 1 ? document.querySelector('article') : null);
    return m && m.innerText.length > b.innerText.length * 0.4 ? m.innerText : b.innerText;
  };
  return pick().split('\n').map(x => x.replace(/\s+$/, '')).filter(x => !(opt.size && opt.has(x.trim()))).join('\n').replace(/\n{3,}/g, '\n\n');
})()'''


def _ms_text():
    try:
        return js(_MS_TEXT_JS) or ''  # noqa: F821
    except Exception:
        return ''


def _ms_new_text(before_lines, limit=1500):
    """Lines that appeared since before_lines (a set), in page order."""
    if before_lines is None:
        return ''
    out, n = [], 0
    for line in _ms_text().split('\n'):
        t = line.strip()
        if not t or t in before_lines:
            continue
        out.append(t)
        n += len(t) + 1
        if n > limit:
            out.append('…')
            break
    return '\n'.join(out)


def _ms_lines():
    return set(x.strip() for x in _ms_text().split('\n') if x.strip())


def _ms_wait_change(before, timeout=4.0):
    """Wait until the page changed after an action (URL, title or text), then
    for it to finish loading. Returns True when anything changed."""
    end = _mst.time() + timeout
    changed = False
    while _mst.time() < end:
        _mst.sleep(0.25)
        now = _ms_sig()
        if now is None:      # mid-navigation
            changed = True
            continue
        if now != before:
            changed = True
            break
    if changed:
        try:
            wait_for_load(timeout=10)  # noqa: F821
        except Exception:
            pass
        _mst.sleep(0.4)
    return changed


def elements(query=None, limit=60):
    """Visible controls on the page, numbered, in-view ones first:
    [{i, tag, text, x, y, type?, value?, options?, checked?, href?, offscreen?, covered?, disabled?}].
    click(i) / fill(i, value) use these numbers (valid until the page changes).
    query filters by text. Print it to read it."""
    global _ms_els
    _ms_els = _ms_js(f'window.__ms.elements({int(limit)}, {_msj.dumps(query)})') or []
    return _ms_els


def _ms_locate(target, nth=0, field=False):
    t = target if isinstance(target, int) else str(target)
    got = _ms_js(f'window.__ms.locate({_msj.dumps(t)}, {_msj.dumps({"nth": nth, "field": field})})')
    if got or not isinstance(target, int):
        return got
    # The number came from an earlier elements()/look() and the page has since
    # reloaded (a form post-back): find the same control again by its label.
    old = next((e for e in _ms_els if e.get('i') == target), None)
    if not old or not old.get('text'):
        return None
    is_field = old.get('tag') in ('input', 'textarea', 'select')
    same = [e for e in _ms_els if e.get('text') == old['text'] and e.get('tag') == old.get('tag')]
    k = same.index(old) if old in same else 0
    got = _ms_js(f'window.__ms.locate({_msj.dumps(old["text"])}, {_msj.dumps({"nth": k, "field": is_field})})')
    if got and old.get('tag') and got.get('tag') != old.get('tag'):
        return None
    return got


def click(target, nth=0, wait=True):
    """Click an element like a person: target = a number from elements(), the
    element's visible text (exact, then partial match), or a CSS selector
    ("#id", ".cls", "css:a.more"). Scrolls it into view, closes a covering
    cookie banner first, moves the mouse and clicks. Returns
    {clicked, url, title, changed}."""
    el = _ms_locate(target, nth)
    if not el:
        hint = [e['text'] for e in (elements(limit=40) or []) if e.get('text')][:25]
        raise LookupError(f'nothing clickable matches {target!r}. Visible controls: {hint}')
    if el.get('error'):
        raise ValueError(el['error'])
    if el.get('covered'):
        dismiss_popups()
        el = _ms_locate(target, nth) or el
    if el.get('disabled'):
        print(f'note: {el.get("text")!r} looks disabled')
    before = _ms_sig()
    lines = _ms_lines()
    _mst.sleep(0.12)
    click_at_xy(el['x'] + _msr.uniform(-2, 2), el['y'] + _msr.uniform(-1.5, 1.5))
    changed = _ms_wait_change(before, 4.0) if wait else None
    info = page_info()  # noqa: F821
    out = {'clicked': el.get('text') or el.get('tag'), 'url': info.get('url'), 'title': info.get('title'), 'changed': changed}
    if changed:
        out['new_text'] = _ms_new_text(lines)
    return out


def fill(target, value, submit=False, nth=0):
    """Fill a form control found by its label / placeholder / name, a number
    from elements(), or a CSS selector. Text fields are clicked, cleared and
    typed into (the page's own input events fire). A <select> gets the option
    whose text or value matches. A checkbox/radio is ticked when value is
    truthy. submit=True presses Enter afterwards. Returns what was set."""
    el = _ms_locate(target, nth, field=not isinstance(target, int))
    if not el:
        fields = [e for e in (elements(limit=80) or []) if e['tag'] in ('input', 'textarea', 'select')]
        raise LookupError(f'no form field matches {target!r}. Fields: {[(e["i"], e["text"]) for e in fields][:25]}')
    if el.get('error'):
        raise ValueError(el['error'])
    if el['tag'] == 'select':
        before = _ms_sig()
        lines = _ms_lines()
        r = _ms_js(f'window.__ms.setSelect({_msj.dumps(str(value))})')
        if r.get('error'):
            raise ValueError(f'{r["error"]}; options: {r.get("options")}')
        # Some forms post back on change (ASP.NET, PHP filters): wait for it so
        # the next fill()/click() acts on the reloaded page.
        changed = _ms_wait_change(before, 2.0)
        out = {'field': el.get('text'), 'chose': r['chosen'], 'changed': changed}
        if changed:
            out['page_reloaded'] = True
            out['new_text'] = _ms_new_text(lines, 600)
        return out
    if el.get('type') in ('checkbox', 'radio') or el.get('role') in ('checkbox', 'switch', 'radio'):
        if bool(value) != bool(el.get('checked')):
            click_at_xy(el['x'], el['y'])
        return {'field': el.get('text'), 'checked': bool(value)}
    if el.get('covered'):
        dismiss_popups()
        el = _ms_locate(target, nth, field=not isinstance(target, int)) or el
    click_at_xy(el['x'], el['y'])
    _mst.sleep(0.15)
    mod = 4 if 'mac' in str(js('navigator.platform')).lower() else 2  # noqa: F821
    cdp('Input.dispatchKeyEvent', type='rawKeyDown', key='a', code='KeyA', modifiers=mod, windowsVirtualKeyCode=65, commands=['selectAll'])  # noqa: F821
    cdp('Input.dispatchKeyEvent', type='keyUp', key='a', code='KeyA', modifiers=mod, windowsVirtualKeyCode=65)  # noqa: F821
    press_key('Backspace')  # noqa: F821
    text = str(value)
    if len(text) <= 40:
        for ch in text:
            type_text(ch)  # noqa: F821
            _mst.sleep(_msr.uniform(0.015, 0.06))
    else:
        type_text(text)  # noqa: F821
    got = _ms_js('window.__ms.curValue()')
    out = {'field': el.get('text'), 'value': got}
    if submit:
        before = _ms_sig()
        lines = _ms_lines()
        press_key('Enter')  # noqa: F821
        out['changed'] = _ms_wait_change(before, 6.0)
        out['url'] = page_info().get('url')  # noqa: F821
        if out['changed']:
            out['new_text'] = _ms_new_text(lines)
    return out


def read_page(max_chars=6000, start=0):
    """The page's visible text (main content first; <select> option lists left
    out), trimmed. start= skips that many characters (read the next part)."""
    t = _ms_text()[int(start):]
    return t[: int(max_chars)] + (f'\n… [{len(t) - int(max_chars)} more chars: read_page(start={int(start) + int(max_chars)}) or find_text(term)]' if len(t) > int(max_chars) else '')


def find_text(term, context=1):
    """Lines of the page text containing term (case-insensitive), with neighbours."""
    lines = [x for x in (js('document.body ? document.body.innerText : ""') or '').split('\n') if x.strip()]  # noqa: F821
    want = str(term).lower()
    out = []
    for i, line in enumerate(lines):
        if want in line.lower():
            out.append('\n'.join(lines[max(0, i - context): i + context + 1]))
    return out[:30] or f'{term!r} does not appear in the page text'


def scroll_down(pages=1):
    info = page_info()  # noqa: F821
    for _ in range(max(1, int(pages))):
        scroll(info.get('w', 1280) / 2, info.get('h', 800) / 2, dy=int(info.get('h', 800) * 0.85))  # noqa: F821
        _mst.sleep(0.5)
    return page_info()  # noqa: F821


def scroll_up(pages=1):
    info = page_info()  # noqa: F821
    for _ in range(max(1, int(pages))):
        scroll(info.get('w', 1280) / 2, info.get('h', 800) / 2, dy=-int(info.get('h', 800) * 0.85))  # noqa: F821
        _mst.sleep(0.4)
    return page_info()  # noqa: F821


def scroll_to(text):
    """Scroll the first element whose text contains `text` into view."""
    ok = js(f'''(() => {{ const w = {_msj.dumps(str(text).lower())};
      const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = it.nextNode())) if (n.nodeValue.toLowerCase().includes(w)) {{ n.parentElement.scrollIntoView({{block:'center'}}); return true; }}
      return false; }})()''')  # noqa: F821
    _mst.sleep(0.4)
    return bool(ok)


def _ms_history(delta):
    h = cdp('Page.getNavigationHistory')  # noqa: F821
    i = h['currentIndex'] + delta
    if i < 0 or i >= len(h['entries']):
        return {'moved': False, 'url': h['entries'][h['currentIndex']]['url']}
    before = _ms_sig()
    cdp('Page.navigateToHistoryEntry', entryId=h['entries'][i]['id'])  # noqa: F821
    _ms_wait_change(before, 6.0)
    return {'moved': True, **{k: v for k, v in page_info().items() if k in ('url', 'title')}}  # noqa: F821


def back():
    """Browser Back button."""
    return _ms_history(-1)


def forward():
    return _ms_history(1)


def reload():
    cdp('Page.reload')  # noqa: F821
    _mst.sleep(0.5)
    wait_for_load(timeout=15)  # noqa: F821
    return page_info()  # noqa: F821


# ---- overlays -------------------------------------------------------------
_MS_CONSENT_RE = _ms_cfg.get('consentRe') or r'^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree( (and|&) (continue|close))?|i agree|i accept|got it|ok(ay)?|consent|yes,? i agree|alle akzeptieren|akzeptieren|tout accepter|accepter|aceptar( todo)?|accetta( tutto)?|aceitar)\s*[.!]?\s*$'
_MS_CONSENT_SEL = _ms_cfg.get('consentSelectors') or ['#onetrust-accept-btn-handler', '#didomi-notice-agree-button', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '.fc-cta-consent', '[data-testid="uc-accept-all-button"]', '#truste-consent-button']
_MS_POPUP_JS = r'''
((reSrc, sels) => {
  const re = new RegExp(reSrc, 'i');
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const out = r => { const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: (r.innerText || r.value || r.getAttribute('aria-label') || '').trim().slice(0, 40) }; };
  for (const s of sels) { try { const el = document.querySelector(s); if (el && vis(el)) return Object.assign(out(el), { via: s }); } catch (_) {} }
  const OVER = /cookie|consent|gdpr|privacy|cmp|banner|modal|overlay|popup|dialog|notice|newsletter|subscribe|interstitial/i;
  const inOverlay = el => { let n = el; for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement) {
      const cs = getComputedStyle(n); if (cs.position === 'fixed' || cs.position === 'sticky') return true;
      if (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') return true;
      if (OVER.test(n.id + ' ' + (typeof n.className === 'string' ? n.className : ''))) return true; }
    return window !== window.top; };
  const cands = Array.from(document.querySelectorAll('button,[role=button],a,input[type=submit],input[type=button]'));
  for (const el of cands) { const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (t && t.length <= 40 && re.test(t) && vis(el) && inOverlay(el)) return Object.assign(out(el), { via: 'consent' }); }
  // A modal (newsletter / sign-up nag) with a close button.
  for (const d of document.querySelectorAll('[role=dialog],[aria-modal=true],.modal,.popup,[class*="overlay"]')) {
    if (!vis(d)) continue; const r = d.getBoundingClientRect(); if (r.width < innerWidth * 0.25 || r.height < 80) continue;
    const c = d.querySelector('[aria-label*="close" i],[title*="close" i],button.close,.close,[class*="close" i],[data-dismiss]');
    if (c && vis(c)) return Object.assign(out(c), { via: 'close' });
  }
  return null;
})
'''


def dismiss_popups(rounds=2):
    """Close cookie-consent banners and nag dialogs (accept / close button,
    including consent frames from other sites). Returns what was clicked."""
    done = []
    for _ in range(rounds):
        hit = None
        try:
            hit = js(f'({_MS_POPUP_JS})({_msj.dumps(_MS_CONSENT_RE)}, {_msj.dumps(_MS_CONSENT_SEL)})')  # noqa: F821
        except Exception:
            hit = None
        if not hit:
            hit = _ms_consent_iframe()
        if not hit:
            break
        before = _ms_sig()
        click_at_xy(hit['x'], hit['y'])
        done.append(hit.get('text') or hit.get('via'))
        _ms_wait_change(before, 1.5)
    return done


_MS_CMP_FRAME = _msre.compile(r'sourcepoint|privacy-mgmt|consensu|cookiebot|onetrust|cookielaw|trustarc|usercentrics|didomi|consent', _msre.I)


def _ms_consent_iframe():
    """A consent dialog inside a cross-origin iframe (Sourcepoint and co.)."""
    try:
        targets = cdp('Target.getTargets')['targetInfos']  # noqa: F821
    except Exception:
        return None
    for t in targets:
        if t.get('type') != 'iframe' or not _MS_CMP_FRAME.search(t.get('url', '')):
            continue
        try:
            inner = js(f'({_MS_POPUP_JS})({_msj.dumps(_MS_CONSENT_RE)}, [])', target_id=t['targetId'])  # noqa: F821
        except Exception:
            continue
        if not inner:
            continue
        host = _msre.sub(r'^https?://([^/]+).*$', r'\1', t.get('url', ''))
        off = js(f'''(() => {{ for (const f of document.querySelectorAll('iframe')) if ((f.src || '').includes({_msj.dumps(host)})) {{
            const r = f.getBoundingClientRect(); if (r.width > 20) return {{x: r.left, y: r.top}}; }} return null; }})()''')  # noqa: F821
        if off:
            return {'x': off['x'] + inner['x'], 'y': off['y'] + inner['y'], 'text': inner.get('text'), 'via': 'consent frame'}
    return None


# ---- human checks ---------------------------------------------------------
_MS_WALL_RE = _msre.compile(r'just a moment|checking (if the site connection is secure|your browser)|verify(ing)? you are (a )?human|are you a robot|i\'?m not a robot|press (&|and) hold|security check|attention required|unusual traffic|please verify|bot detection|human verification|one (more )?quick check|before you continue|checking your connection|verifying your connection', _msre.I)
_MS_KINDS = [
    ('turnstile', _msre.compile(r'challenges\.cloudflare\.com', _msre.I)),
    ('recaptcha', _msre.compile(r'(google\.com|recaptcha\.net)/recaptcha/(api2|enterprise)/anchor', _msre.I)),
    ('recaptcha-images', _msre.compile(r'(google\.com|recaptcha\.net)/recaptcha/(api2|enterprise)/bframe', _msre.I)),
    ('hcaptcha', _msre.compile(r'hcaptcha\.com/.*(checkbox|frame=checkbox)', _msre.I)),
    ('hcaptcha-images', _msre.compile(r'hcaptcha\.com/.*(challenge|frame=challenge)', _msre.I)),
    ('datadome', _msre.compile(r'captcha-delivery\.com|geo\.captcha-delivery', _msre.I)),
    ('arkose', _msre.compile(r'arkoselabs\.com|funcaptcha', _msre.I)),
    ('geetest', _msre.compile(r'geetest', _msre.I)),
]


_MS_VISIBLE_FN = '''function () { let n = this;
  for (let i = 0; i < 30 && n; i++) {
    if (n.nodeType === 1) { const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) return false; }
    n = n.parentNode || (n.host || null);
  } return true; }'''


def _ms_node_visible(backend_id):
    try:
        obj = cdp('DOM.resolveNode', backendNodeId=backend_id)['object']['objectId']  # noqa: F821
        r = cdp('Runtime.callFunctionOn', objectId=obj, functionDeclaration=_MS_VISIBLE_FN, returnByValue=True)  # noqa: F821
        return r.get('result', {}).get('value') is not False
    except Exception:
        return True


def _ms_frames():
    """Every <iframe> in the page incl. closed shadow roots (Turnstile hides
    in one): [{kind, src, box:{x,y,w,h}}] for the visible ones."""
    out = []
    try:
        root = cdp('DOM.getDocument', depth=-1, pierce=True)['root']  # noqa: F821
    except Exception:
        return out
    stack = [root]
    while stack:
        n = stack.pop()
        for k in ('children', 'shadowRoots'):
            stack.extend(n.get(k) or [])
        if n.get('contentDocument'):
            stack.append(n['contentDocument'])
        if n.get('nodeName') != 'IFRAME':
            continue
        a = n.get('attributes') or []
        src = next((a[i + 1] for i in range(0, len(a) - 1, 2) if a[i] == 'src'), '')
        kind = next((k for k, rx in _MS_KINDS if rx.search(src)), None)
        if not kind and n.get('contentDocument'):
            doc_url = n['contentDocument'].get('documentURL') or ''
            kind = next((k for k, rx in _MS_KINDS if rx.search(doc_url)), None)
            src = src or doc_url
        if not kind:
            continue
        try:
            q = cdp('DOM.getBoxModel', backendNodeId=n['backendNodeId'])['model']['border']  # noqa: F821
        except Exception:
            continue
        xs, ys = q[0::2], q[1::2]
        b = {'x': min(xs), 'y': min(ys), 'w': max(xs) - min(xs), 'h': max(ys) - min(ys)}
        if b['w'] < 20 or b['h'] < 20 or b['y'] + b['h'] < 0 or b['x'] + b['w'] < 0:
            continue  # reCAPTCHA parks its hidden picture frame at top:-9999
        if not _ms_node_visible(n['backendNodeId']):
            continue
        out.append({'kind': kind, 'src': src[:160], 'box': b, 'backendNodeId': n['backendNodeId']})
    return out


def obstacle():
    """What stands between the agent and the page, if anything:
    {kind: turnstile|recaptcha|recaptcha-images|hcaptcha|hcaptcha-images|press-hold|datadome|arkose|geetest|interstitial, ...}
    or None."""
    frames = _ms_frames()
    if frames:
        f = sorted(frames, key=lambda f: f['kind'].endswith('-images'), reverse=True)[0]
        return {'kind': f['kind'], 'box': f['box']}
    try:
        t = js('(document.title + "\\n" + (document.body ? document.body.innerText : "")).slice(0, 3000)') or ''  # noqa: F821
    except Exception:
        return None
    try:
        hold = js('''(() => { const e = document.querySelector('#px-captcha,[id^="px-captcha"]'); if (!e) return null;
            const r = e.getBoundingClientRect(); return r.width > 20 ? {x: r.left, y: r.top, w: r.width, h: r.height} : null; })()''')  # noqa: F821
    except Exception:
        hold = None
    if hold:
        return {'kind': 'press-hold', 'box': hold}
    if _MS_WALL_RE.search(t) and len(t) < 2500:
        return {'kind': 'interstitial', 'text': t[:160]}
    return None


def _ms_hold(b, seconds):
    x, y = b['x'] + b['w'] / 2, b['y'] + b['h'] / 2
    _ms_move(x, y)
    cdp('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y, button='left', clickCount=1)  # noqa: F821
    end = _mst.time() + seconds
    while _mst.time() < end:
        _mst.sleep(0.4)
        try:
            cdp('Input.dispatchMouseEvent', type='mouseMoved', x=x + _msr.uniform(-1, 1), y=y + _msr.uniform(-1, 1), button='left', buttons=1)  # noqa: F821
        except Exception:
            break
    cdp('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y, button='left', clickCount=1)  # noqa: F821
    _ms_clicks.append([round(x, 1), round(y, 1)])


def solve_captcha(timeout=40):
    """Handle a human check the way a person would: wait out a Cloudflare
    "Just a moment" page, click a Turnstile / reCAPTCHA / hCaptcha "I am human"
    checkbox, or press and hold a press-and-hold button. Picture puzzles are
    NOT solved: they are reported so you can tell the user. Returns
    {found, kind, solved, detail, seconds}."""
    t0 = _mst.time()

    def res(found, kind, solved, detail):
        return {'found': found, 'kind': kind, 'solved': solved, 'detail': detail, 'seconds': round(_mst.time() - t0, 1)}

    ob = obstacle()
    if not ob:
        return res(False, None, True, 'no captcha or human check on this page')
    kind = ob['kind']
    tried = 0
    end = t0 + float(timeout)
    while _mst.time() < end:
        if kind == 'interstitial':
            # Cloudflare's JS often clears this alone; a Turnstile box may appear.
            _mst.sleep(1.5)
        elif kind in ('recaptcha-images', 'hcaptcha-images', 'arkose', 'geetest', 'datadome'):
            return res(True, kind, False, 'a picture/puzzle challenge is showing; it needs a person — tell the user the site asks for a CAPTCHA')
        elif kind == 'press-hold':
            if tried >= 2:
                return res(True, kind, False, 'press-and-hold check did not pass after 2 tries')
            _ms_hold(ob['box'], _msr.uniform(8, 11))
            tried += 1
            _mst.sleep(3)
        elif kind in ('turnstile', 'recaptcha', 'hcaptcha'):
            if tried >= 2:
                return res(True, kind, False, f'clicked the {kind} checkbox {tried} times; it did not pass (the site may not trust this browser)')
            b = ob['box']
            if kind == 'recaptcha':
                x, y = b['x'] + 27, b['y'] + min(b['h'] / 2, 39)
            else:
                x, y = b['x'] + min(32, b['w'] * 0.11), b['y'] + b['h'] / 2
            _mst.sleep(_msr.uniform(0.6, 1.4) if tried == 0 else _msr.uniform(2.5, 4))
            click_at_xy(x + _msr.uniform(-3, 3), y + _msr.uniform(-3, 3))
            tried += 1
            # A token or the page moving on means it passed.
            for _ in range(16):
                _mst.sleep(0.5)
                nb = obstacle()
                if not nb:
                    break
                if nb['kind'].endswith('-images'):
                    return res(True, nb['kind'], False, 'clicking the checkbox opened a picture challenge; it needs a person')
                if kind == 'recaptcha':
                    try:
                        ok = js('(() => { const t = document.querySelector("textarea[name=g-recaptcha-response],#g-recaptcha-response"); return !!(t && t.value); })()')  # noqa: F821
                    except Exception:
                        ok = False
                    if ok:
                        return res(True, kind, True, 'the reCAPTCHA checkbox passed; submit the form now if the page has one')
        nb = obstacle()
        if not nb:
            try:
                wait_for_load(timeout=10)  # noqa: F821
            except Exception:
                pass
            return res(True, kind, True, 'passed; the page moved on' if kind != 'interstitial' else 'the check cleared by itself')
        ob, kind = nb, nb['kind']
    return res(True, kind, False, f'still showing after {timeout}s')


def open_url(url, handle_popups=True):
    """Go to a URL (in the current tab, or a new one when there is none), wait
    for it, close cookie banners and pass a simple human check. Returns
    {url, title, popups, obstacle, text} where text is the start of the page
    (call look() for the controls, read_page() for more text)."""
    try:
        tabs = list_tabs(include_chrome=False)  # noqa: F821
    except Exception:
        tabs = []
    cur = {}
    try:
        cur = page_info() if tabs else {}  # noqa: F821
    except Exception:
        cur = {}
    same = bool(cur.get('url')) and cur.get('url', '').rstrip('/') == str(url).rstrip('/')
    if not same:
        if tabs:
            goto_url(url)  # noqa: F821
        else:
            new_tab(url)  # noqa: F821
        _mst.sleep(0.5)
        try:
            wait_for_load(timeout=20)  # noqa: F821
        except Exception:
            pass
        _mst.sleep(0.6)
    out = {'popups': [], 'obstacle': None}
    ob = obstacle()
    if ob:
        out['obstacle'] = solve_captcha(timeout=25)
    if handle_popups:
        out['popups'] = dismiss_popups()
    info = page_info()  # noqa: F821
    out.update({'url': info.get('url'), 'title': info.get('title')})
    out['text'] = read_page(1500)
    return out


goto = open_url


def links(query=None, limit=40):
    """Links on the page with ABSOLUTE urls, content links first:
    [{i, text, href}]. query filters by text or url. open_url(link['href'])
    goes there without hunting for the element."""
    js(_MS_LIB)  # noqa: F821
    got = js(f'''(() => {{
      const q = {_msj.dumps((query or '').lower())};
      const chrome = el => !!el.closest('nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo]');
      const seen = new Set(), main = [], rest = [];
      for (const a of document.querySelectorAll('a[href]')) {{
        const href = a.href; if (!/^https?:/.test(href) || seen.has(href)) continue;
        const r = a.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        const text = (a.innerText || a.getAttribute('aria-label') || a.title || (a.querySelector('img[alt]') || {{}}).alt || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
        if (q && !(text.toLowerCase().includes(q) || href.toLowerCase().includes(q))) continue;
        seen.add(href); (chrome(a) ? rest : main).push({{ text, href: href.slice(0, 300) }});
      }}
      return main.concat(rest);
    }})()''') or []  # noqa: F821
    return [dict(i=i, **x) for i, x in enumerate(got[: int(limit)])]


def tables(max_rows=40):
    """The page's data tables (and key/value lists) as rows of cell text:
    [{caption, rows: [[...], ...]}]. Spec sheets, result grids, price lists."""
    return js(f'''(() => {{
      const out = [], cell = c => c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200);
      for (const t of document.querySelectorAll('table')) {{
        const rows = Array.from(t.rows).map(r => Array.from(r.cells).map(cell)).filter(r => r.some(Boolean));
        if (rows.length < 2 || (t.closest('nav,header,footer'))) continue;
        out.push({{ caption: (t.caption ? cell(t.caption) : (t.previousElementSibling ? cell(t.previousElementSibling).slice(0, 80) : '')), rows: rows.slice(0, {int(max_rows)}), totalRows: rows.length }});
        if (out.length >= 8) break;
      }}
      for (const d of document.querySelectorAll('dl')) {{
        const rows = []; let k = null;
        for (const c of d.children) {{ if (c.tagName === 'DT') k = cell(c); else if (c.tagName === 'DD') rows.push([k || '', cell(c)]); }}
        if (rows.length >= 2) out.push({{ caption: 'list', rows: rows.slice(0, {int(max_rows)}), totalRows: rows.length }});
        if (out.length >= 10) break;
      }}
      return out;
    }})()''') or []  # noqa: F821


_MS_NEXT_JS = r'''(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const rel = document.querySelector('a[rel~=next],link[rel~=next]');
  if (rel && rel.href) return { href: rel.href, text: 'rel=next' };
  const re = /^(next( page)?|next ?[›»>→]|[›»→]|older( posts| entries)?|more results|load more|show more|weiter|suivant|siguiente|avanti|próxima)$/i;
  const c = Array.from(document.querySelectorAll('a,button,[role=button],[role=link]')).filter(vis);
  for (const el of c) {
    const t = (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 30 && re.test(t) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
      if (el.tagName === 'A' && el.href && /^https?:/.test(el.href)) return { href: el.href, text: t };
      const r = el.getBoundingClientRect(); return { text: t };
    }
  }
  return null;
})()'''


def next_page():
    """Go to the next page of a list / search results (rel=next, a "Next" /
    "›" / "Load more" control). Returns {moved, url, title, new_text} or
    {moved: False} when there is no next page."""
    hit = js(_MS_NEXT_JS)  # noqa: F821
    if not hit:
        return {'moved': False, 'detail': 'no next-page link or button on this page'}
    lines = _ms_lines()
    if hit.get('href'):
        before = _ms_sig()
        goto_url(hit['href'])  # noqa: F821
        _ms_wait_change(before, 8.0)
        info = page_info()  # noqa: F821
        return {'moved': True, 'via': hit['text'], 'url': info.get('url'), 'title': info.get('title'), 'new_text': _ms_new_text(lines)}
    r = click(hit['text'])
    r['moved'] = bool(r.get('changed'))
    r['via'] = hit['text']
    return r


def search(query):
    """Use the site's own search box: finds it (type=search, name q/s/query/
    search, a "Search" placeholder or label), types query and submits.
    Returns {field, value, changed, url, new_text}."""
    js(_MS_LIB)  # noqa: F821
    sel = js('''(() => {
      const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const c = Array.from(document.querySelectorAll('input[type=search],input[name=q],input[name=s],input[name=query],input[name=search],input[name*=search i],input[placeholder*=search i],input[aria-label*=search i],[role=searchbox],input[type=text]'));
      const el = c.find(vis);
      if (!el) return null;
      if (!el.id) el.id = '__ms_search_' + Math.floor(Math.random() * 1e6);
      return '#' + CSS.escape(el.id);
    })()''')  # noqa: F821
    if not sel:
        raise LookupError('no search box on this page; look for a search link in links("search") or elements("search")')
    return fill(sel, query, submit=True)


def look(max_controls=25, text_chars=1200):
    """One look at the page, as a person would take it in: URL, title, any
    human check or pop-up, the headings, the start of the text, the numbered
    controls (for click(i) / fill(i, ...)) and whether there is a next page.
    Returns a printable string; print(look())."""
    info = page_info()  # noqa: F821
    parts = [f"URL: {info.get('url')}", f"Title: {info.get('title')}"]
    ob = obstacle()
    if ob:
        parts.append(f"Human check on the page: {ob['kind']} (solve_captcha() handles a checkbox / wait page)")
    try:
        heads = js('''Array.from(document.querySelectorAll('h1,h2,h3')).filter(h => h.getBoundingClientRect().height > 2).map(h => h.tagName + ' ' + h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90)).filter(x => x.length > 3).slice(0, 14)''') or []  # noqa: F821
    except Exception:
        heads = []
    if heads:
        parts.append('Headings: ' + ' | '.join(heads))
    parts.append('Text:\n' + read_page(int(text_chars)))
    els = elements(limit=int(max_controls)) or []
    rows = []
    for e in els:
        bits = [str(e['i']), e['tag'] + (f"[{e['type']}]" if e.get('type') else ''), repr(e.get('text') or '')]
        if e.get('value'):
            bits.append(f"value={e['value']!r}")
        if e.get('options'):
            bits.append(f"options={e['options'][:8]}")
        if e.get('href'):
            bits.append(f"-> {e['href'][:70]}")
        for flag in ('checked', 'disabled', 'covered', 'offscreen'):
            if e.get(flag):
                bits.append(flag)
        rows.append('  ' + ' '.join(bits))
    parts.append(f'Controls ({len(els)} shown; elements(query) to filter):\n' + '\n'.join(rows))
    try:
        nx = js(_MS_NEXT_JS)  # noqa: F821
    except Exception:
        nx = None
    if nx:
        parts.append(f"Next page: yes ({nx.get('text')}) — next_page()")
    return '\n'.join(parts)


def _ms_step_report(auto_captcha=True):
    """Called by the runner after every cell: page state, the clicks made in
    that cell, and an automatic pass at a simple human check."""
    clicks = list(_ms_clicks)
    del _ms_clicks[:]
    info = page_info()  # noqa: F821
    rep = {'info': info, 'clicks': clicks, 'captcha': None}
    if isinstance(info, dict) and info.get('dialog'):
        return rep
    try:
        ob = obstacle()
    except Exception:
        ob = None
    if ob:
        rep['obstacle'] = ob['kind']
        seen = globals().setdefault('_ms_captcha_tries', {})
        key = (info.get('url') or '')[:200]
        blocking = ob['kind'] in ('interstitial', 'turnstile', 'press-hold')
        if not blocking and ob['kind'] in ('recaptcha', 'hcaptcha'):
            try:   # a check that IS the page (Google's "unusual traffic" page), not one inside a form
                blocking = len(js('document.body ? document.body.innerText : ""') or '') < 1500  # noqa: F821
            except Exception:
                blocking = False
        if auto_captcha and blocking and seen.get(key, 0) < 1:
            seen[key] = seen.get(key, 0) + 1
            rep['captcha'] = solve_captcha(timeout=20)
            rep['info'] = page_info()  # noqa: F821
            rep['clicks'] += list(_ms_clicks)
            del _ms_clicks[:]
    return rep
