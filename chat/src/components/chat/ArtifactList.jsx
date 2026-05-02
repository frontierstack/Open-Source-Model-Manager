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

/**
 * ArtifactList — vertical stack of clickable cards, one per file the
 * server staged in /artifacts during a tool call. Each card opens the
 * file in a new tab (the server endpoint sends `Content-Disposition:
 * inline`, so PDFs / images render in-browser; the user can right-click
 * to save). The accompanying download icon button forces a fresh GET
 * with the `download` attribute set so the browser saves instead of
 * navigating away.
 */
export default function ArtifactList({ artifacts }) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {artifacts.map((a, i) => {
                if (!a || !a.url || !a.name) return null;
                const Icon = iconFor(a.name);
                const sizeText = fmtSize(a.size);
                return (
                    <div
                        key={(a.runId || '') + ':' + a.name + ':' + i}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 10px',
                            border: '1px solid var(--rule)',
                            borderRadius: 8,
                            background: 'var(--bg)',
                        }}
                    >
                        <Icon style={{ width: 18, height: 18, color: 'var(--accent)', flexShrink: 0 }} strokeWidth={1.8} />
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
                            <span style={{
                                fontSize: 13, fontWeight: 500,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                                {a.name}
                            </span>
                            {sizeText && (
                                <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{sizeText}</span>
                            )}
                        </a>
                        <a
                            href={a.url}
                            download={a.name}
                            title={`Download ${a.name}`}
                            style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 30, height: 30,
                                borderRadius: 6,
                                color: 'var(--ink-3)',
                                background: 'transparent',
                                textDecoration: 'none',
                                flexShrink: 0,
                                transition: 'background .12s, color .12s',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'var(--bg-2)';
                                e.currentTarget.style.color = 'var(--accent)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = 'var(--ink-3)';
                            }}
                        >
                            <Download style={{ width: 14, height: 14 }} strokeWidth={2} />
                        </a>
                    </div>
                );
            })}
        </div>
    );
}
