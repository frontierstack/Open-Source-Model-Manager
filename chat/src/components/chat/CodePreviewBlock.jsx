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

export default function CodePreviewBlock({ code, language = 'text', isStreaming = false }) {
    const enabled = useChatStore(s => !!s.settings?.codePreviewEnabled);

    const lang = (language || '').toLowerCase();
    const isPython = RUNNABLE_PYTHON.has(lang);
    const isHtml = RUNNABLE_HTML.has(lang);
    const runnable = enabled && !isStreaming && (isPython || isHtml);

    if (!runnable) {
        return <CodeBlock code={code} language={language} isStreaming={isStreaming} />;
    }

    return isPython
        ? <PythonRunBlock code={code} language={language} />
        : <HtmlRunBlock code={code} language={language} />;
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
                        <div className="border-t border-white/5 p-2 flex flex-wrap gap-2 bg-dark-900/60">
                            {output.artifacts.map(a => {
                                const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name);
                                if (isImage) {
                                    return (
                                        <a key={a.runId + '/' + a.name} href={a.url} target="_blank" rel="noreferrer"
                                           title={`${a.name} (${a.size} bytes)`}
                                           className="block">
                                            <img src={a.url} alt={a.name}
                                                 className="max-h-64 max-w-full rounded border border-white/10 bg-white/5" />
                                        </a>
                                    );
                                }
                                return (
                                    <a key={a.runId + '/' + a.name} href={a.url} target="_blank" rel="noreferrer"
                                       className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] bg-dark-800 hover:bg-dark-700 text-dark-200 border border-white/10 transition-colors">
                                        📎 {a.name}
                                        <span className="text-dark-500">{formatBytes(a.size)}</span>
                                    </a>
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
function HtmlRunBlock({ code, language }) {
    const [shown, setShown] = useState(false);
    const [allowScripts, setAllowScripts] = useState(false);

    // Build the sandbox attribute dynamically. Baseline denies everything;
    // user opts into scripts with the toggle.
    const sandboxAttr = allowScripts
        ? 'allow-scripts allow-same-origin'  // same-origin enables fetch to same origin; remove if concerned
        : '';

    return (
        <div className="my-3">
            <div className="flex items-center justify-between mb-1.5 pl-1">
                <span className="text-[11px] text-dark-400 font-mono">html · iframe</span>
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
                    <button
                        onClick={() => setShown(s => !s)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-primary-500/10 text-primary-400 hover:bg-primary-500/20 transition-colors"
                    >
                        <Play className="w-2.5 h-2.5" strokeWidth={2.5} />
                        {shown ? 'Hide' : 'Render'}
                    </button>
                </div>
            </div>
            <CodeBlock code={code} language={language} isStreaming={false} />
            {shown && (
                <div className="mt-1.5 rounded-md overflow-hidden border border-white/10 bg-white">
                    <iframe
                        key={`${allowScripts}`}  /* force reload on toggle change */
                        title="HTML preview"
                        sandbox={sandboxAttr}
                        srcDoc={code}
                        className="w-full h-80 border-0"
                    />
                </div>
            )}
        </div>
    );
}
