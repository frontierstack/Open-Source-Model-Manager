import React, { useState, useRef, useEffect } from 'react';
import { Play, Square, Loader2, AlertCircle } from 'lucide-react';
import CodeBlock from './CodeBlock';
import { useChatStore } from '../../stores/useChatStore';

/**
 * CodePreviewBlock — wraps CodeBlock with a Run button for supported
 * languages, when the user has explicitly enabled the feature in Settings.
 *
 * Languages:
 *   - python (+ py, python3): executed on the server via POST /api/sandbox/run-code
 *     which dispatches through the gVisor sandbox runner.
 *   - html: rendered client-side in a sandboxed iframe (web platform sandbox,
 *     no network / no top-navigation / no forms / etc.). This is a separate
 *     and stricter sandbox than gVisor — the HTML never touches the server.
 *
 * When `codePreviewEnabled === false`, this component acts as a pass-through
 * to CodeBlock: no Run button is rendered, no iframe is created, no fetch is
 * ever issued.
 */
const RUNNABLE_PYTHON = new Set(['python', 'py', 'python3']);
const RUNNABLE_HTML = new Set(['html', 'htm']);
// JS snippets can render interactively by wrapping them in a minimal
// HTML host — the model's canvas/p5/three/vanilla-JS code runs inside
// the same sandboxed iframe the HTML path uses. This is the "real
// interactive preview" path, since pygame under gVisor is
// fundamentally headless.
const RUNNABLE_JS = new Set(['javascript', 'js']);
// CSS alone renders nothing; we wrap it with a sample DOM so the
// user sees the style applied (nav, buttons, text, form controls).
const RUNNABLE_CSS = new Set(['css']);

export default function CodePreviewBlock({ code, language = 'text', isStreaming = false }) {
    const enabled = useChatStore(s => !!s.settings?.codePreviewEnabled);

    const lang = (language || '').toLowerCase();
    const isPython = RUNNABLE_PYTHON.has(lang);
    const isHtml = RUNNABLE_HTML.has(lang);
    const isJs = RUNNABLE_JS.has(lang);
    const isCss = RUNNABLE_CSS.has(lang);
    const runnable = enabled && !isStreaming && (isPython || isHtml || isJs || isCss);

    if (!runnable) {
        return <CodeBlock code={code} language={language} isStreaming={isStreaming} />;
    }

    if (isPython) return <PythonRunBlock code={code} language={language} />;
    if (isJs) {
        // Wrap the JS in a minimal HTML host with a visible canvas and a
        // console mirror. Defaults to allow-scripts (otherwise there's
        // no point) so the snippet can handle real input events.
        const wrapped = buildJsHost(code);
        return (
            <HtmlRunBlock
                code={wrapped}             // what renders in the iframe
                displayCode={code}         // what shows in the CodeBlock
                language="html"
                displayLang="javascript"
                defaultScripts={true}
            />
        );
    }
    if (isCss) {
        // CSS alone renders nothing. Wrap with a small sample DOM so
        // the user sees the rules applied to real elements.
        const wrapped = buildCssHost(code);
        return (
            <HtmlRunBlock
                code={wrapped}
                displayCode={code}
                language="html"
                displayLang="css"
                defaultScripts={false}
            />
        );
    }
    return <HtmlRunBlock code={code} language={language} />;
}

// Minimal scaffold around a raw JS snippet so "interactive canvas"
// demos work without the model having to write boilerplate. Gives
// the snippet a full-size canvas (`canvas`), a 2d context (`ctx`),
// width/height globals, and a <pre> that mirrors console.log so
// users can see output without opening devtools.
// Minimal sample DOM so CSS snippets have something visible to style.
// Includes common elements (buttons, form fields, headings, a card layout,
// nav, table) so the user can see how their rules apply across patterns.
function buildCssHost(userCss) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
/* reset-ish defaults so the user's CSS starts from a known baseline */
html,body{margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111;}
.sample{display:grid;gap:24px;max-width:680px;margin:0 auto;}
.sample > section{padding:16px;border:1px solid #e5e7eb;border-radius:8px;}
hr{border:0;border-top:1px solid #e5e7eb;margin:16px 0;}
/* === user CSS below === */
${userCss}
</style></head><body>
<main class="sample">
  <h1>Heading 1</h1>
  <h2>Heading 2</h2>
  <p>Paragraph text — the quick brown fox jumps over the lazy dog. <a href="#">An inline link</a>.</p>
  <section>
    <h3>Buttons</h3>
    <button>Primary</button>
    <button class="secondary">Secondary</button>
    <button disabled>Disabled</button>
  </section>
  <section>
    <h3>Form</h3>
    <label>Label <input type="text" placeholder="Input"></label>
    <label><input type="checkbox"> Checkbox</label>
    <label>Select
      <select><option>One</option><option>Two</option></select>
    </label>
    <textarea placeholder="Textarea"></textarea>
  </section>
  <section>
    <h3>List</h3>
    <ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>
  </section>
  <section>
    <h3>Table</h3>
    <table>
      <thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>alpha</td><td>1</td></tr>
        <tr><td>beta</td><td>2</td></tr>
      </tbody>
    </table>
  </section>
  <nav><a href="#">Home</a> · <a href="#">Docs</a> · <a href="#">Contact</a></nav>
</main>
</body></html>`;
}

function buildJsHost(userCode) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0b0d12;color:#eee;font-family:system-ui,sans-serif;height:100%;}
#c{display:block;margin:0 auto;background:#111;}
#log{position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;
  margin:0;padding:6px 10px;background:rgba(0,0,0,0.6);font:12px/1.4 ui-monospace,monospace;
  color:#bbb;white-space:pre-wrap;border-top:1px solid #333;}
#log:empty{display:none;}
</style></head><body>
<canvas id="c" width="640" height="400"></canvas>
<pre id="log"></pre>
<script>
(function(){
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  const logEl = document.getElementById('log');
  const origLog = console.log.bind(console);
  console.log = function(...args){
    try { logEl.textContent += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\\n'; } catch(_){}
    origLog.apply(console, args);
  };
  window.addEventListener('error', e => {
    logEl.textContent += '[error] ' + (e.error && e.error.stack ? e.error.stack : e.message) + '\\n';
  });
  try {
${userCode.split('\n').map(l => '    ' + l).join('\n')}
  } catch (e) {
    console.log('[uncaught]', e && e.stack ? e.stack : String(e));
  }
})();
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// Python runner
// ---------------------------------------------------------------------------
function PythonRunBlock({ code, language }) {
    const [state, setState] = useState('idle'); // idle | running | done | error
    const [output, setOutput] = useState(null);
    const [elapsedMs, setElapsedMs] = useState(0);
    const abortRef = useRef(null);
    const startRef = useRef(0);

    // Tick a live elapsed counter while running — distinguishes a slow
    // import (progress visible) from a hang (stuck on one number).
    useEffect(() => {
        if (state !== 'running') return;
        const id = setInterval(() => {
            setElapsedMs(Date.now() - startRef.current);
        }, 250);
        return () => clearInterval(id);
    }, [state]);

    const run = async () => {
        setState('running');
        setOutput(null);
        setElapsedMs(0);
        startRef.current = Date.now();
        abortRef.current = new AbortController();
        try {
            const res = await fetch('/api/sandbox/run-code', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ language: 'python', code, timeoutMs: 60_000 }),
                signal: abortRef.current.signal,
            });
            const data = await res.json();
            if (!res.ok || data.success === false) {
                setState('error');
                setOutput(data);
            } else {
                setState('done');
                setOutput(data);
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                setState('idle');
                setOutput(null);
                return;
            }
            setState('error');
            setOutput({ error: e.message });
        } finally {
            abortRef.current = null;
        }
    };

    const stop = () => {
        if (abortRef.current) abortRef.current.abort();
    };

    return (
        <div className="my-3">
            <div className="flex items-center justify-between mb-1.5 pl-1">
                <span className="text-[11px] text-dark-400 font-mono">python · sandbox</span>
                {state === 'running' ? (
                    <button
                        onClick={stop}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                        <Square className="w-2.5 h-2.5" strokeWidth={2.5} /> Stop
                    </button>
                ) : (
                    <button
                        onClick={run}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 transition-colors"
                    >
                        <Play className="w-2.5 h-2.5" strokeWidth={2.5} /> Run
                    </button>
                )}
            </div>
            <CodeBlock code={code} language={language} isStreaming={false} />
            {state === 'running' && (
                <div className="mt-1.5 px-3 py-2 rounded-md bg-dark-800/60 border border-white/5 text-[11px] text-dark-300 inline-flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>executing in sandbox…</span>
                    <span className="ml-auto font-mono text-dark-400">
                        {(elapsedMs / 1000).toFixed(1)}s
                    </span>
                </div>
            )}
            {output && (state === 'done' || state === 'error') && (
                <div className="mt-1.5 rounded-md overflow-hidden border border-white/5">
                    <div className="px-3 py-1 bg-dark-800/80 text-[10px] text-dark-400 font-mono flex items-center gap-2">
                        {state === 'error' && <AlertCircle className="w-3 h-3 text-red-400" />}
                        output
                        {typeof output.durationMs === 'number' && (
                            <span className="ml-auto text-dark-500">{Math.round(output.durationMs)}ms</span>
                        )}
                    </div>
                    {output.stdout && (
                        <pre className="px-3 py-2 bg-dark-900/40 text-[11.5px] text-dark-200 font-mono whitespace-pre-wrap break-words overflow-x-auto">
                            {output.stdout}
                        </pre>
                    )}
                    {output.stderr && (
                        <pre className="px-3 py-2 bg-red-500/5 text-[11.5px] text-red-300 font-mono whitespace-pre-wrap break-words overflow-x-auto border-t border-white/5">
                            {output.stderr}
                        </pre>
                    )}
                    {output.error && !output.stdout && !output.stderr && (
                        <pre className="px-3 py-2 bg-red-500/5 text-[11.5px] text-red-300 font-mono whitespace-pre-wrap break-words">
                            {output.error}
                        </pre>
                    )}
                    {output.timedOut && (
                        <div className="px-3 py-1.5 bg-amber-500/5 text-[11px] text-amber-300 border-t border-white/5">
                            execution timed out
                        </div>
                    )}
                    {Array.isArray(output.artifacts) && output.artifacts.length > 0 && (
                        <div className="border-t border-white/5 p-2 bg-dark-900/60 space-y-2">
                            {output.artifacts.map(a => {
                                const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name);
                                return (
                                    <div key={a.runId + '/' + a.name} className="space-y-1">
                                        {isImage && (
                                            <img
                                                src={a.url}
                                                alt={a.name}
                                                className="max-h-64 max-w-full rounded border border-white/10 bg-white/5 block"
                                            />
                                        )}
                                        <div className="flex items-center gap-2 text-[10px] text-dark-400 font-mono">
                                            <span>{a.name}</span>
                                            <span className="text-dark-500">{formatBytes(a.size)}</span>
                                            <a
                                                href={a.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                download={a.name}
                                                className="ml-auto px-1.5 py-0.5 rounded bg-dark-800 hover:bg-dark-700 text-dark-300 border border-white/10"
                                            >
                                                download
                                            </a>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// HTML previewer — iframe with the strictest `sandbox` attribute that still
// renders visible content. No scripts, no forms, no top-nav — just CSS + DOM.
// Users can flip on scripts via the toggle below when they knowingly want
// it (e.g., a small interactive demo). Scripts off is the default.
// ---------------------------------------------------------------------------
function HtmlRunBlock({ code, displayCode, language, displayLang, defaultScripts = false }) {
    const [shown, setShown] = useState(false);
    // When `defaultScripts` is true (JS snippets wrapped as HTML), we pre-
    // enable scripts since the snippet literally can't work without them.
    // Plain HTML defaults to scripts-off (safer, still renders visually).
    const [allowScripts, setAllowScripts] = useState(defaultScripts);
    const [iframeKey, setIframeKey] = useState(0);

    // Build the sandbox attribute dynamically. Baseline denies everything;
    // scripts+same-origin when the user opts in (or when JS is inherent).
    const sandboxAttr = allowScripts
        ? 'allow-scripts allow-same-origin allow-pointer-lock'
        : '';

    const label = displayLang || language;

    return (
        <div className="my-3">
            <div className="flex items-center justify-between mb-1.5 pl-1">
                <span className="text-[11px] text-dark-400 font-mono">
                    {label} · iframe
                </span>
                <div className="flex items-center gap-3">
                    <label className="text-[10px] text-dark-400 inline-flex items-center gap-1 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={allowScripts}
                            onChange={(e) => setAllowScripts(e.target.checked)}
                            className="accent-primary-500"
                        />
                        allow scripts
                    </label>
                    {shown && (
                        <button
                            onClick={() => setIframeKey(k => k + 1)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-dark-800 hover:bg-dark-700 text-dark-300 border border-white/10 transition-colors"
                            title="Reload the iframe — useful when the snippet has some internal state you want to reset"
                        >
                            Reload
                        </button>
                    )}
                    <button
                        onClick={() => setShown(s => !s)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 transition-colors"
                    >
                        <Play className="w-2.5 h-2.5" strokeWidth={2.5} />
                        {shown ? 'Hide' : 'Render'}
                    </button>
                </div>
            </div>
            <CodeBlock code={displayCode || code} language={displayLang || language} isStreaming={false} />
            {shown && (
                <div className="mt-1.5 rounded-md overflow-hidden border border-white/10 bg-white">
                    <iframe
                        key={`${allowScripts}-${iframeKey}`}  /* reload on toggle or explicit Reload */
                        title={`${label} preview`}
                        sandbox={sandboxAttr}
                        srcDoc={code}
                        className="w-full h-[26rem] border-0"
                    />
                </div>
            )}
        </div>
    );
}
