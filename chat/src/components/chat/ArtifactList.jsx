import React from 'react';
import { Download, FileText, FileSpreadsheet, Image as ImageIcon, FileArchive, FileCode } from 'lucide-react';

const EXT_ICON = {
    pdf: FileText, txt: FileText, md: FileText, log: FileText,
    docx: FileText, doc: FileText, rtf: FileText, odt: FileText,
    xlsx: FileSpreadsheet, xls: FileSpreadsheet, csv: FileSpreadsheet, ods: FileSpreadsheet,
    png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon, webp: ImageIcon, svg: ImageIcon,
    zip: FileArchive, tar: FileArchive, gz: FileArchive, '7z': FileArchive, rar: FileArchive,
    json: FileCode, xml: FileCode, html: FileCode, js: FileCode, ts: FileCode, py: FileCode,
};

function iconFor(name) {
    const ext = (name || '').toLowerCase().split('.').pop();
    return EXT_ICON[ext] || FileText;
}

function fmtSize(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Append `?download=1` to force the server to send
// `Content-Disposition: attachment`. The HTML `download` attr alone is
// advisory — Chrome / Edge silently drop it under corporate policies,
// COOP-isolated contexts, and some self-signed-HTTPS edge cases. A
// server-side attachment header is the only reliable way to make the
// download actually save instead of navigating to the file.
function withDownloadFlag(url) {
    if (typeof url !== 'string' || !url) return url;
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

// fetch the artifact as a blob, then hand the bytes to the browser via a
// `blob:` URL + synthetic <a> click. The native <a href download> path
// can be blocked by Chrome with "Network issue" when the server URL is
// served via a self-signed cert + HSTS — Chrome refuses to honor the
// user's cert exception for background download requests. A blob URL is
// in-memory and same-origin, so it bypasses those heuristics entirely.
async function saveViaBlob(url, filename) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

/**
 * ArtifactList — vertical stack of clickable cards, one per file the
 * server staged in /artifacts during a tool call. The filename link
 * opens in a new tab (server sends `inline` for renderable types like
 * PDF / images, so they preview; binaries get `attachment` and download
 * directly even from this link). The download icon always appends
 * `?download=1` so the server forces `Content-Disposition: attachment`
 * regardless of the file type — this is what guarantees a save dialog
 * in browsers that ignore the HTML `download` attribute.
 */
export default function ArtifactList({ artifacts }) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {artifacts.map((a, i) => {
                if (!a || !a.url || !a.name) return null;
                const Icon = iconFor(a.name);
                const sizeText = fmtSize(a.size);
                const dlUrl = withDownloadFlag(a.url);
                return (
                    <div
                        key={(a.runId || '') + ':' + a.name + ':' + i}
                        className="artifact-card"
                    >
                        <span className="artifact-card-icon"><Icon strokeWidth={1.8} /></span>
                        <a
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                flex: 1, minWidth: 0,
                                display: 'flex', flexDirection: 'column', gap: 1,
                                color: 'var(--ink)',
                                textDecoration: 'none',
                            }}
                            title={`Open ${a.name} in a new tab`}
                        >
                            <span className="artifact-card-name">
                                {a.name}
                            </span>
                            {sizeText && (
                                <span className="artifact-card-size">{sizeText}</span>
                            )}
                        </a>
                        <a
                            href={dlUrl}
                            download={a.name}
                            title={`Download ${a.name}`}
                            onClick={(e) => {
                                // Try fetch+blob first; the native <a download>
                                // is the fallback if the blob fetch fails (kept
                                // on the href so right-click → Save As also works).
                                e.preventDefault();
                                saveViaBlob(dlUrl, a.name).catch(() => {
                                    window.location.href = dlUrl;
                                });
                            }}
                            className="ui-icon-btn"
                            style={{ textDecoration: 'none' }}
                        >
                            <Download strokeWidth={2} />
                        </a>
                    </div>
                );
            })}
        </div>
    );
}
