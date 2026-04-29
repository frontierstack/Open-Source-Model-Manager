import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, FileText, Image as ImageIcon, FileCode, FileSpreadsheet, FileArchive, Mail, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import MessageContent from './MessageContent';

// Single source of truth for "is this attachment worth opening a modal
// for?" — exported so the composer chips and persisted-message chips
// agree. Archives are deliberately excluded: their `content` is a tool
// instruction marker ("Call extract_archive with archiveId=…"), not
// user-visible content. Any other type with text content (txt, md,
// code, csv, json, email, etc.) qualifies.
export function isAttachmentPreviewable(att) {
    if (!att) return false;
    if (att.type === 'archive') return false;
    return !!(
        att.content ||
        att.dataUrl ||
        att.attachmentId ||
        (Array.isArray(att.sheets) && att.sheets.length > 0)
    );
}

// Map common extensions to prism language ids. Falls back to 'markup' for
// anything we don't recognise — readable, just no highlighting.
const EXT_TO_LANG = {
    js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php',
    swift: 'swift', kt: 'kotlin', scala: 'scala', sh: 'bash', bash: 'bash',
    zsh: 'bash', ps1: 'powershell', sql: 'sql',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'markup', html: 'markup', svg: 'markup',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
};

function extFromFilename(filename) {
    if (!filename) return '';
    const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function isProbablyCode(filename) {
    const ext = extFromFilename(filename);
    return ext in EXT_TO_LANG && ext !== 'md' && ext !== 'markdown';
}

function isMarkdownish(filename) {
    const ext = extFromFilename(filename);
    return ext === 'md' || ext === 'markdown' || ext === 'txt' || filename?.startsWith('pasted-text-');
}

function isCsv(filename) {
    return extFromFilename(filename) === 'csv';
}

// Backdrop + centered card. Reuses the same z-index / animation pattern
// ConfirmDialog.jsx uses so layered modals don't fight over stacking.
export default function FilePreviewModal({ attachment, onClose }) {
    // Disable body scroll while open and bind Escape to close.
    useEffect(() => {
        if (!attachment) return;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = prevOverflow;
            window.removeEventListener('keydown', onKey);
        };
    }, [attachment, onClose]);

    if (!attachment) return null;

    const { filename, type, charCount, pageCount, sheetCount, estimatedTokens } = attachment;

    const headerMeta = [];
    if (typeof charCount === 'number') headerMeta.push(`${charCount.toLocaleString()} chars`);
    if (typeof pageCount === 'number') headerMeta.push(`${pageCount} page${pageCount === 1 ? '' : 's'}`);
    if (typeof sheetCount === 'number') headerMeta.push(`${sheetCount} sheet${sheetCount === 1 ? '' : 's'}`);
    if (typeof estimatedTokens === 'number') headerMeta.push(`~${estimatedTokens.toLocaleString()} tokens`);

    return (
        <>
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] animate-in"
                onClick={onClose}
            />
            <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                <div
                    className="w-full max-w-5xl flex flex-col rounded-2xl shadow-2xl shadow-black/40 overflow-hidden animate-scale-in"
                    style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--rule)',
                        maxHeight: '90vh',
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div
                        style={{
                            display: 'flex', alignItems: 'center', gap: 12,
                            padding: '14px 18px',
                            borderBottom: '1px solid var(--rule-2)',
                            background: 'var(--bg-2)',
                        }}
                    >
                        <PreviewIcon type={type} filename={filename} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {filename || 'Preview'}
                            </div>
                            {headerMeta.length > 0 && (
                                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>
                                    {headerMeta.join(' · ')}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            aria-label="Close preview"
                            style={{
                                width: 32, height: 32, borderRadius: 8,
                                display: 'grid', placeItems: 'center',
                                background: 'transparent', border: 0,
                                color: 'var(--ink-3)', cursor: 'pointer',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-3, var(--bg))'; e.currentTarget.style.color = 'var(--ink)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-3)'; }}
                        >
                            <X style={{ width: 18, height: 18 }} />
                        </button>
                    </div>

                    {/* Body */}
                    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18, background: 'var(--bg)' }}>
                        <PreviewBody attachment={attachment} />
                    </div>
                </div>
            </div>
        </>
    );
}

function PreviewIcon({ type, filename }) {
    const sx = { width: 16, height: 16 };
    const wrap = (icon, color) => (
        <div style={{
            width: 32, height: 32, borderRadius: 8,
            display: 'grid', placeItems: 'center',
            background: 'color-mix(in oklab, ' + color + ' 14%, transparent)',
            color,
            flexShrink: 0,
        }}>{icon}</div>
    );
    if (type === 'image') return wrap(<ImageIcon style={sx} />, 'var(--accent)');
    if (type === 'spreadsheet') return wrap(<FileSpreadsheet style={sx} />, '#10b981');
    if (type === 'archive') return wrap(<FileArchive style={sx} />, '#f59e0b');
    if (type === 'pdf') return wrap(<FileText style={sx} />, '#ef4444');
    if (type === 'email') return wrap(<Mail style={sx} />, '#06b6d4');
    if (isProbablyCode(filename)) return wrap(<FileCode style={sx} />, 'var(--accent)');
    return wrap(<FileText style={sx} />, 'var(--ink-3)');
}

function PreviewBody({ attachment }) {
    const { type, filename, content, dataUrl, sheets, mimeType, attachmentId } = attachment;

    // PDF: prefer the inline dataUrl (legacy / not-yet-persisted attachments)
    // and fall back to /api/attachments/:id when only an attachmentId is
    // present (the new path — bytes live on disk, not in the message).
    if (type === 'pdf') {
        if (dataUrl) return <PdfPreview dataUrl={dataUrl} />;
        if (attachmentId) return <PdfPreviewFromStore attachmentId={attachmentId} />;
    }
    if (type === 'image' && dataUrl) {
        return (
            <div style={{ display: 'grid', placeItems: 'center' }}>
                <img
                    src={dataUrl}
                    alt={filename || 'image'}
                    style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 6, border: '1px solid var(--rule-2)' }}
                />
            </div>
        );
    }
    if (type === 'spreadsheet') {
        if (Array.isArray(sheets) && sheets.length > 0) {
            return <SpreadsheetPreview sheets={sheets} />;
        }
        if (attachmentId) return <SpreadsheetPreviewFromStore attachmentId={attachmentId} />;
    }
    if (type === 'archive') {
        // Defensive: normally the chip isn't clickable for archives
        // (isAttachmentPreviewable returns false). If a stale chip
        // somehow triggers the modal, explain instead of leaking the
        // tool-call marker text.
        return (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)', fontSize: 13 }}>
                Archives can't be previewed inline. Ask the model to extract this file — it'll use the <code style={{ fontFamily: 'var(--font-mono)' }}>extract_archive</code> tool.
            </div>
        );
    }
    if (type === 'email' && content) {
        return <EmailPreview content={content} attachment={attachment} />;
    }
    if (isCsv(filename) && content) {
        return <CsvPreview text={content} />;
    }
    if (isProbablyCode(filename) && content) {
        const lang = EXT_TO_LANG[extFromFilename(filename)] || 'markup';
        return <CodePreview code={content} language={lang} />;
    }
    if (isMarkdownish(filename) && content) {
        // Treat .md as markdown; .txt and pasted text get a plain
        // pre-wrap block (markdown lib would mangle plain prose with
        // accidental markdown-like syntax).
        const ext = extFromFilename(filename);
        if (ext === 'md' || ext === 'markdown') {
            return (
                <div style={{ background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--rule-2)', padding: '14px 18px' }}>
                    <MessageContent content={content} isStreaming={false} />
                </div>
            );
        }
        return <PlainText text={content} />;
    }
    if (content) {
        return <PlainText text={content} />;
    }
    if (dataUrl) {
        // Unknown binary — offer download.
        return (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
                <div style={{ marginBottom: 12, fontSize: 13 }}>No inline preview available for this file type.</div>
                <a
                    href={dataUrl}
                    download={filename || 'download'}
                    style={{
                        display: 'inline-block',
                        padding: '8px 14px', borderRadius: 8,
                        background: 'var(--accent)', color: 'var(--accent-ink)',
                        fontSize: 13, fontWeight: 500, textDecoration: 'none',
                    }}
                >
                    Download {filename || 'file'}
                </a>
            </div>
        );
    }
    return (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
            Nothing to preview.
        </div>
    );
}

// Email preview — splits the server-emitted email content into a
// header card (Subject/From/To/CC/Date + link list) and a body block.
// The server's /api/chat/upload handler for .eml/.msg writes this
// shape:
//
//   Subject: …
//   From: …
//   To: …
//   Date: …
//
//   Links found: N
//     1. https://…
//
//   ---
//
//   <body text>
//
//   ---
//   Attachments:
//   - …
//
// We parse leading "Key: value" lines as headers and treat everything
// after the first `---` separator as the body. If parsing fails for
// any reason we fall back to plain text — the raw server output is
// already readable.
function EmailPreview({ content }) {
    const { headers, links, body, footer } = React.useMemo(() => {
        const out = { headers: {}, links: [], body: '', footer: '' };
        if (typeof content !== 'string') return out;
        const sepIdx = content.indexOf('\n---\n');
        const headerBlock = sepIdx >= 0 ? content.slice(0, sepIdx) : '';
        const rest = sepIdx >= 0 ? content.slice(sepIdx + 5) : content;
        // Split header block: leading "Key: value" lines, optional
        // "Links found: N" + numbered list afterward.
        const lines = headerBlock.split('\n');
        let inLinks = false;
        for (const line of lines) {
            if (!line.trim()) { inLinks = false; continue; }
            if (/^Links found:/i.test(line)) { inLinks = true; continue; }
            if (inLinks) {
                const m = line.match(/^\s*\d+\.\s*(?:(.+?):\s*)?(https?:\/\/\S+)\s*$/i);
                if (m) {
                    out.links.push({ text: m[1] || m[2], url: m[2] });
                }
                continue;
            }
            const m = line.match(/^([A-Z][a-zA-Z]+):\s*(.+)$/);
            if (m) {
                out.headers[m[1]] = m[2];
            }
        }
        // Body may have a trailing `---\nAttachments:` footer or
        // `--- Attachment Contents ---` block. Keep them visible but
        // styled so the body text reads cleanly first.
        const footerIdx = rest.search(/\n---\n(?:Attachments:|\s*--- Attachment Contents)/);
        if (footerIdx >= 0) {
            out.body = rest.slice(0, footerIdx).trim();
            out.footer = rest.slice(footerIdx + 1).trim();
        } else {
            out.body = rest.trim();
        }
        return out;
    }, [content]);

    const headerEntries = Object.entries(headers);
    const subject = headers.Subject;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(headerEntries.length > 0 || links.length > 0) && (
                <div style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'var(--surface)',
                    border: '1px solid var(--rule-2)',
                }}>
                    {subject && (
                        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', marginBottom: headerEntries.length > 1 ? 10 : 0, lineHeight: 1.3 }}>
                            {subject}
                        </div>
                    )}
                    {headerEntries.length > (subject ? 1 : 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, fontSize: 12.5 }}>
                            {headerEntries.filter(([k]) => k !== 'Subject').map(([k, v]) => (
                                <React.Fragment key={k}>
                                    <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}>{k}</span>
                                    <span style={{ color: 'var(--ink-2)', wordBreak: 'break-word' }}>{v}</span>
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                    {links.length > 0 && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule-2)' }}>
                            <div style={{ fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
                                {links.length} link{links.length === 1 ? '' : 's'}
                            </div>
                            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {links.slice(0, 25).map((l, i) => (
                                    <li key={i} style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                                            {l.text}
                                        </a>
                                    </li>
                                ))}
                                {links.length > 25 && (
                                    <li style={{ fontSize: 11, color: 'var(--ink-3)' }}>… and {links.length - 25} more</li>
                                )}
                            </ul>
                        </div>
                    )}
                </div>
            )}
            <PlainText text={body || content} />
            {footer && (
                <details style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Attachments / footer</summary>
                    <div style={{ marginTop: 6 }}>
                        <PlainText text={footer} muted />
                    </div>
                </details>
            )}
        </div>
    );
}

function PlainText({ text, muted }) {
    return (
        <pre
            style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: 1.55,
                color: muted ? 'var(--ink-3)' : 'var(--ink)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--surface)',
                border: '1px solid var(--rule-2)',
                borderRadius: 8,
                padding: '14px 16px',
            }}
        >
            {text}
        </pre>
    );
}

function CodePreview({ code, language }) {
    return (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--rule-2)', borderRadius: 8, overflow: 'hidden' }}>
            <Highlight code={code} language={language} theme={themes.vsDark}>
                {({ className, style, tokens, getLineProps, getTokenProps }) => (
                    <pre
                        className={className}
                        style={{ ...style, margin: 0, padding: '14px 16px', fontSize: 12.5, lineHeight: 1.55, overflow: 'auto', background: 'transparent' }}
                    >
                        {tokens.map((line, i) => {
                            const lineProps = getLineProps({ line });
                            return (
                                <div key={i} {...lineProps} style={{ ...lineProps.style, display: 'flex' }}>
                                    <span style={{
                                        display: 'inline-block', width: 40, paddingRight: 12, textAlign: 'right',
                                        color: 'var(--ink-4)', userSelect: 'none', flexShrink: 0,
                                    }}>{i + 1}</span>
                                    <span style={{ flex: 1, minWidth: 0 }}>
                                        {line.map((token, k) => {
                                            const tp = getTokenProps({ token });
                                            return <span key={k} {...tp} />;
                                        })}
                                    </span>
                                </div>
                            );
                        })}
                    </pre>
                )}
            </Highlight>
        </div>
    );
}

// CSV preview: parse client-side (simple split — handles quoted commas).
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; continue; }
            if (c === '"') { inQuotes = false; continue; }
            cell += c;
            continue;
        }
        if (c === '"') { inQuotes = true; continue; }
        if (c === ',') { row.push(cell); cell = ''; continue; }
        if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            rows.push(row);
            row = []; cell = '';
            continue;
        }
        cell += c;
    }
    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function CsvPreview({ text }) {
    const rows = React.useMemo(() => parseCsv(text), [text]);
    if (rows.length === 0) return <PlainText text={text} />;
    return <DataTable rows={rows} />;
}

function SpreadsheetPreview({ sheets }) {
    const [active, setActive] = useState(0);
    const sheet = sheets[active];
    return (
        <div>
            {sheets.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                    {sheets.map((s, i) => (
                        <button
                            key={s.name + i}
                            onClick={() => setActive(i)}
                            style={{
                                padding: '5px 10px', borderRadius: 6,
                                fontSize: 12, fontWeight: 500,
                                background: i === active ? 'var(--accent)' : 'var(--surface)',
                                color: i === active ? 'var(--accent-ink)' : 'var(--ink-2)',
                                border: '1px solid ' + (i === active ? 'var(--accent)' : 'var(--rule-2)'),
                                cursor: 'pointer',
                            }}
                        >
                            {s.name} <span style={{ opacity: 0.7, fontWeight: 400 }}>({s.rowCount})</span>
                        </button>
                    ))}
                </div>
            )}
            {sheet?.truncated && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 8 }}>
                    Showing first {sheet.rows.length.toLocaleString()} of {sheet.rowCount.toLocaleString()} rows. Full data is sent to the model.
                </div>
            )}
            {sheet ? <DataTable rows={sheet.rows} /> : <PlainText text="Sheet has no rows." muted />}
        </div>
    );
}

function DataTable({ rows }) {
    if (!rows || rows.length === 0) return <PlainText text="(empty)" muted />;
    const header = rows[0];
    const body = rows.slice(1);
    return (
        <div style={{ overflow: 'auto', maxHeight: '70vh', border: '1px solid var(--rule-2)', borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5, minWidth: 'max-content' }}>
                <thead>
                    <tr style={{ background: 'var(--bg-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={cellStyleHeader}>#</th>
                        {header.map((h, i) => (
                            <th key={i} style={cellStyleHeader}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {body.map((r, ri) => (
                        <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--bg-2)' }}>
                            <td style={{ ...cellStyleBody, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>{ri + 2}</td>
                            {/* iterate by header length so short rows still align */}
                            {Array.from({ length: header.length }).map((_, ci) => (
                                <td key={ci} style={cellStyleBody}>{r[ci] != null ? String(r[ci]) : ''}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const cellStyleHeader = {
    padding: '8px 10px',
    textAlign: 'left',
    fontWeight: 600,
    color: 'var(--ink)',
    borderBottom: '1px solid var(--rule)',
    whiteSpace: 'nowrap',
};
const cellStyleBody = {
    padding: '6px 10px',
    color: 'var(--ink-2)',
    borderBottom: '1px solid var(--rule-2)',
    whiteSpace: 'nowrap',
    maxWidth: 280,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
};

// PDF rendering — pdfjs-dist directly. Lazy-imported on first mount so the
// ~1 MB pdfjs core doesn't ship with the main bundle. Worker is bundled as
// a separate asset by the webpack rule for *.worker.min.mjs.
function PdfPreview({ dataUrl }) {
    const canvasRef = useRef(null);
    const [pdf, setPdf] = useState(null);
    const [pageNum, setPageNum] = useState(1);
    const [renderError, setRenderError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        let task = null;
        (async () => {
            try {
                setLoading(true);
                setRenderError(null);
                // Dynamic import — keeps pdfjs out of the main bundle until
                // a user actually previews a PDF.
                const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
                const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs')).default;
                pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
                // Strip the data: prefix and decode to Uint8Array.
                const base64 = dataUrl.split(',')[1] || '';
                const bin = atob(base64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                task = pdfjs.getDocument({ data: bytes });
                const doc = await task.promise;
                if (cancelled) return;
                setPdf(doc);
                setLoading(false);
            } catch (e) {
                if (!cancelled) {
                    console.error('[PdfPreview] load failed:', e);
                    setRenderError(e.message || String(e));
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
            if (task && typeof task.destroy === 'function') task.destroy();
        };
    }, [dataUrl]);

    const renderPage = useCallback(async () => {
        if (!pdf || !canvasRef.current) return;
        try {
            const page = await pdf.getPage(pageNum);
            const canvas = canvasRef.current;
            // Scale so the page width hits ~900 CSS px on most displays;
            // the canvas is responsive width:100% so this is just a target.
            const baseViewport = page.getViewport({ scale: 1 });
            const targetWidth = Math.min(900, canvas.parentElement?.clientWidth || 900);
            const scale = targetWidth / baseViewport.width;
            const viewport = page.getViewport({ scale });
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = viewport.width * dpr;
            canvas.height = viewport.height * dpr;
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            await page.render({ canvasContext: ctx, viewport }).promise;
        } catch (e) {
            console.error('[PdfPreview] render failed:', e);
        }
    }, [pdf, pageNum]);

    useEffect(() => { renderPage(); }, [renderPage]);

    if (renderError) {
        return (
            <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>
                Failed to render PDF: {renderError}
            </div>
        );
    }
    if (loading || !pdf) {
        return (
            <div style={{ display: 'grid', placeItems: 'center', padding: 60, color: 'var(--ink-3)' }}>
                <Loader2 className="animate-spin" style={{ width: 20, height: 20, marginBottom: 8 }} />
                <span style={{ fontSize: 12 }}>Loading PDF…</span>
            </div>
        );
    }

    const total = pdf.numPages;
    const goPrev = () => setPageNum(n => Math.max(1, n - 1));
    const goNext = () => setPageNum(n => Math.min(total, n + 1));

    return (
        <div>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px',
                marginBottom: 12,
                background: 'var(--surface)', border: '1px solid var(--rule-2)',
                borderRadius: 8,
            }}>
                <button
                    onClick={goPrev}
                    disabled={pageNum <= 1}
                    style={pdfNavBtn(pageNum <= 1)}
                    aria-label="Previous page"
                >
                    <ChevronLeft style={{ width: 14, height: 14 }} />
                </button>
                <span style={{ fontSize: 12, color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
                    Page {pageNum} of {total}
                </span>
                <button
                    onClick={goNext}
                    disabled={pageNum >= total}
                    style={pdfNavBtn(pageNum >= total)}
                    aria-label="Next page"
                >
                    <ChevronRight style={{ width: 14, height: 14 }} />
                </button>
            </div>
            <div style={{ display: 'grid', placeItems: 'center', background: 'var(--surface)', border: '1px solid var(--rule-2)', borderRadius: 8, padding: 12 }}>
                <canvas ref={canvasRef} style={{ maxWidth: '100%', height: 'auto', display: 'block', borderRadius: 4 }} />
            </div>
        </div>
    );
}

function pdfNavBtn(disabled) {
    return {
        width: 28, height: 28, borderRadius: 6,
        display: 'grid', placeItems: 'center',
        background: 'transparent', border: '1px solid var(--rule)',
        color: 'var(--ink-3)', cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
    };
}

// Store-backed wrappers. When a persisted attachment carries only an
// attachmentId, fetch the blob/meta on demand. Object URLs are revoked on
// unmount so we don't leak memory across modal opens.
function PdfPreviewFromStore({ attachmentId }) {
    const [blobUrl, setBlobUrl] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        let createdUrl = null;
        (async () => {
            try {
                const resp = await fetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, { credentials: 'include' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const blob = await resp.blob();
                if (cancelled) return;
                createdUrl = URL.createObjectURL(blob);
                // Convert blob to data URL so PdfPreview can re-use the
                // same atob path it already uses for inline-served PDFs.
                const reader = new FileReader();
                reader.onload = () => { if (!cancelled) setBlobUrl(String(reader.result)); };
                reader.onerror = () => { if (!cancelled) setError('Failed to read PDF blob'); };
                reader.readAsDataURL(blob);
            } catch (e) {
                if (!cancelled) setError(e.message || String(e));
            }
        })();
        return () => {
            cancelled = true;
            if (createdUrl) URL.revokeObjectURL(createdUrl);
        };
    }, [attachmentId]);
    if (error) {
        return <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>Failed to load PDF: {error}</div>;
    }
    if (!blobUrl) {
        return (
            <div style={{ display: 'grid', placeItems: 'center', padding: 60, color: 'var(--ink-3)' }}>
                <Loader2 className="animate-spin" style={{ width: 20, height: 20, marginBottom: 8 }} />
                <span style={{ fontSize: 12 }}>Fetching PDF…</span>
            </div>
        );
    }
    return <PdfPreview dataUrl={blobUrl} />;
}

function SpreadsheetPreviewFromStore({ attachmentId }) {
    const [sheets, setSheets] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const resp = await fetch(`/api/attachments/${encodeURIComponent(attachmentId)}/meta`, { credentials: 'include' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const meta = await resp.json();
                if (cancelled) return;
                if (Array.isArray(meta?.sheets)) {
                    setSheets(meta.sheets);
                } else {
                    setError('attachment has no sheet data');
                }
            } catch (e) {
                if (!cancelled) setError(e.message || String(e));
            }
        })();
        return () => { cancelled = true; };
    }, [attachmentId]);
    if (error) {
        return <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>Failed to load spreadsheet: {error}</div>;
    }
    if (!sheets) {
        return (
            <div style={{ display: 'grid', placeItems: 'center', padding: 60, color: 'var(--ink-3)' }}>
                <Loader2 className="animate-spin" style={{ width: 20, height: 20, marginBottom: 8 }} />
                <span style={{ fontSize: 12 }}>Fetching sheet data…</span>
            </div>
        );
    }
    return <SpreadsheetPreview sheets={sheets} />;
}
