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
// Java is compiled + run server-side in the same gVisor sandbox as Python
// (javac a single file in /tmp, then run it). See POST /api/sandbox/run-code.
const RUNNABLE_JAVA = new Set(['java']);
// NOTE: HTML/JS/CSS are intentionally NOT inline-runnable in the chat anymore —
// their interactive preview is the Artifacts panel's job. See CodePreviewBlock.

export default function CodePreviewBlock({ code, language = 'text', isStreaming = false }) {
    const enabled = useChatStore(s => !!s.settings?.codePreviewEnabled);

    const lang = (language || '').toLowerCase();
    const isPython = RUNNABLE_PYTHON.has(lang);
    const isJava = RUNNABLE_JAVA.has(lang);
    // HTML/JS/CSS are NO LONGER rendered inline in the chat. The interactive
    // preview lives in the Artifacts panel (its Preview tab renders the page in
    // a sandboxed iframe), so the per-block "Render" button and "allow scripts"
    // checkbox were removed as redundant — script execution is governed by the
    // "Live code preview" setting and the artifacts iframe sandbox. The chat
    // just shows the code. Python/Java keep their server-side Run output, which
    // has no equivalent inline-output surface in the chat.
    const runnable = enabled && !isStreaming && (isPython || isJava);

    if (!runnable) {
        return <CodeBlock code={code} language={language} isStreaming={isStreaming} />;
    }

    return <ServerRunBlock code={code} language={language} serverLang={isJava ? 'java' : 'python'} />;
}

// ---------------------------------------------------------------------------
// Server-side runner (Python + Java) — executes in the gVisor sandbox via
// POST /api/sandbox/run-code and renders stdout/stderr + any image artifacts.
// ---------------------------------------------------------------------------
function ServerRunBlock({ code, language, serverLang = 'python' }) {
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
                body: JSON.stringify({ language: serverLang, code, timeoutMs: 60_000 }),
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
        <div className="code-run my-3">
            <div className="code-run-bar">
                <span className="code-run-label">{serverLang} · sandbox</span>
                {state === 'running' ? (
                    <button
                        onClick={stop}
                        className="ui-btn ui-btn-sm"
                        style={{ background: 'color-mix(in oklab, var(--danger) 12%, transparent)', color: 'var(--danger)', height: 26 }}
                    >
                        <Square strokeWidth={2.5} style={{ width: 11, height: 11 }} /> Stop
                    </button>
                ) : (
                    <button
                        onClick={run}
                        className="ui-btn ui-btn-sm ui-btn-soft"
                        style={{ height: 26 }}
                    >
                        <Play strokeWidth={2.5} style={{ width: 11, height: 11 }} /> Run
                    </button>
                )}
            </div>
            <CodeBlock code={code} language={language} isStreaming={false} />
            {state === 'running' && (
                <div className="code-run-status">
                    <Loader2 className="animate-spin" />
                    <span>executing in sandbox…</span>
                    <span className="code-run-elapsed">
                        {(elapsedMs / 1000).toFixed(1)}s
                    </span>
                </div>
            )}
            {output && (state === 'done' || state === 'error') && (
                <div className="code-run-out">
                    <div className="code-run-out-head">
                        {state === 'error' && <AlertCircle style={{ color: 'var(--danger)' }} />}
                        output
                        {typeof output.durationMs === 'number' && (
                            <span className="ml-auto" style={{ color: 'var(--ink-4)' }}>{Math.round(output.durationMs)}ms</span>
                        )}
                    </div>
                    {output.stdout && (
                        <pre>{output.stdout}</pre>
                    )}
                    {output.stderr && (
                        <pre className="is-err">{output.stderr}</pre>
                    )}
                    {output.error && !output.stdout && !output.stderr && (
                        <pre className="is-err">{output.error}</pre>
                    )}
                    {output.timedOut && (
                        <div className="code-run-timeout">
                            execution timed out
                        </div>
                    )}
                    {Array.isArray(output.artifacts) && output.artifacts.length > 0 && (
                        <div className="p-2 space-y-2" style={{ borderTop: '1px solid var(--rule-2)' }}>
                            {output.artifacts.map(a => {
                                const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name);
                                return (
                                    <div key={a.runId + '/' + a.name} className="space-y-1">
                                        {isImage && (
                                            <img
                                                src={a.url}
                                                alt={a.name}
                                                className="max-h-64 max-w-full rounded-md block"
                                                style={{ border: '1px solid var(--rule)', background: '#fff' }}
                                            />
                                        )}
                                        <div className="flex items-center gap-2 font-mono" style={{ '--fs': '11.5px', color: 'var(--ink-3)' }}>
                                            <span>{a.name}</span>
                                            <span style={{ color: 'var(--ink-4)' }}>{formatBytes(a.size)}</span>
                                            <a
                                                href={a.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                download={a.name}
                                                className="ui-btn ui-btn-secondary ml-auto"
                                                style={{ height: 24, padding: '0 8px', '--fs': '11px', textDecoration: 'none' }}
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

