import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Globe, ExternalLink, Loader2 } from 'lucide-react';

/**
 * Safely parse a URL and return a cleaned hostname (www. stripped).
 * Returns null if the URL is invalid.
 */
function getHostname(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./i, '');
    } catch (e) {
        return null;
    }
}

/**
 * Deterministic color for a hostname. No network call: we hash the
 * hostname and index into a curated palette. This replaces the previous
 * favicon-service approach which fired visible 404s in the console
 * whenever the service couldn't resolve the domain (Google, DDG, and
 * thum.io all did this for some subset of sites). A client-side letter
 * avatar is guaranteed clean and looks consistent.
 */
const AVATAR_PALETTE = [
    { bg: '#4338ca', fg: '#ffffff' }, // indigo
    { bg: '#0e7490', fg: '#ffffff' }, // cyan
    { bg: '#15803d', fg: '#ffffff' }, // green
    { bg: '#b45309', fg: '#ffffff' }, // amber
    { bg: '#be123c', fg: '#ffffff' }, // rose
    { bg: '#7c3aed', fg: '#ffffff' }, // violet
    { bg: '#0369a1', fg: '#ffffff' }, // sky
    { bg: '#ea580c', fg: '#ffffff' }, // orange
    { bg: '#047857', fg: '#ffffff' }, // emerald
    { bg: '#a21caf', fg: '#ffffff' }, // fuchsia
];

function colorForHostname(hostname) {
    if (!hostname) return AVATAR_PALETTE[0];
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
        hash = (hash * 31 + hostname.charCodeAt(i)) | 0;
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

/**
 * First letter of the hostname's base name — e.g. 'nytimes.com' -> 'N'.
 */
function avatarLetter(hostname) {
    if (!hostname) return '?';
    // Drop a leading subdomain if there's one so 'en.wikipedia.org' -> 'W'
    // and 'blog.github.com' -> 'G'. Keep single-label hosts as-is.
    const parts = hostname.split('.').filter(Boolean);
    const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return (base || '?').charAt(0).toUpperCase();
}

/**
 * Truncate text to a maximum length, preserving word boundaries when possible.
 */
function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trim() + '…';
}

/**
 * SourceChip - Individual favicon chip with hover preview
 *
 * The preview popup is rendered via a React portal to document.body and
 * positioned with `position: fixed` coordinates computed from the chip's
 * getBoundingClientRect(). This prevents the surrounding chat message
 * bubble, ToolCallBlock body, or the scrollable chat container from
 * clipping the popup — the previous `absolute bottom-full` layout got
 * chopped off at the top of the bubble when a chip was near the top
 * of a message.
 */
function SourceChip({ source, index, hoveredIdx, setHoveredIdx, previewStatus, setPreviewStatus }) {
    const hoverTimerRef = useRef(null);
    const chipRef = useRef(null);
    const [popupPos, setPopupPos] = useState(null);

    const hostname = getHostname(source?.url);
    const isValidUrl = !!hostname;
    const isHovered = hoveredIdx === index;

    const computePopupPos = () => {
        const el = chipRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        // Popup is 320px wide (w-80), variable height ~240-280px.
        // Decide above vs below based on available space; fall back to
        // clamping left so the popup stays on-screen horizontally.
        const POPUP_W = 320;
        const POPUP_H = 280;
        const margin = 8;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        let left = rect.left;
        if (left + POPUP_W > viewportW - margin) left = viewportW - POPUP_W - margin;
        if (left < margin) left = margin;
        // Prefer above (matches old behavior); flip below when there isn't room.
        const spaceAbove = rect.top;
        const spaceBelow = viewportH - rect.bottom;
        let top;
        if (spaceAbove >= POPUP_H + margin || spaceAbove >= spaceBelow) {
            top = Math.max(margin, rect.top - POPUP_H - margin);
        } else {
            top = Math.min(rect.bottom + margin, viewportH - POPUP_H - margin);
        }
        return { left, top };
    };

    const handleMouseEnter = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
            setPopupPos(computePopupPos());
            setHoveredIdx(index);
        }, 200);
    };

    const handleMouseLeave = () => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        setHoveredIdx((current) => (current === index ? null : current));
    };

    // Re-compute popup position on scroll / resize while it's visible —
    // otherwise scrolling leaves a stale anchor point.
    useEffect(() => {
        if (!isHovered) return;
        const onMove = () => setPopupPos(computePopupPos());
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [isHovered]);

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        };
    }, []);

    const displayHost = hostname || 'unknown';
    const previewText = truncate(source?.content || source?.snippet || '', 280);

    // Letter avatar derived from hostname. Purely client-side so we can
    // never generate favicon 404s in the console regardless of the target
    // domain. See the AVATAR_PALETTE + colorForHostname helpers above.
    const avatarColor = isValidUrl ? colorForHostname(hostname) : { bg: '#334155', fg: '#cbd5e1' };
    const letter = isValidUrl ? avatarLetter(hostname) : '?';

    const chipInner = (
        <>
            {isValidUrl ? (
                <span
                    className="flex-shrink-0 flex items-center justify-center w-4 h-4 rounded-sm text-[8.5px] font-semibold tracking-tight leading-none select-none"
                    style={{ backgroundColor: avatarColor.bg, color: avatarColor.fg }}
                    aria-hidden="true"
                >
                    {letter}
                </span>
            ) : (
                <Globe className="w-3.5 h-3.5 text-dark-300 flex-shrink-0" />
            )}
            <span className="text-[10.5px] text-dark-300 truncate max-w-[140px]">
                {displayHost}
            </span>
        </>
    );

    const popupContent = (
        <div
            className="fixed w-80 p-3 rounded-lg bg-dark-900 border border-white/10 shadow-2xl pointer-events-none"
            style={{
                left: popupPos?.left ?? 0,
                top: popupPos?.top ?? 0,
                zIndex: 9999,
            }}
        >
            {isValidUrl && previewStatus !== 'error' && (
                <div className="relative w-full h-36 mb-2 rounded-md overflow-hidden bg-white/[0.03] ring-1 ring-white/10">
                    {previewStatus === 'loading' && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="w-5 h-5 text-dark-300 animate-spin" />
                        </div>
                    )}
                    {/*
                        WordPress mshots is a free, no-auth public
                        link-preview service. First request for an
                        uncached URL returns a placeholder then
                        generates the real screenshot in the
                        background, so subsequent hovers get the
                        real thing.
                    */}
                    <img
                        src={`https://s.wordpress.com/mshots/v1/${encodeURIComponent(source.url)}?w=640&h=400`}
                        alt=""
                        className={`w-full h-full object-cover transition-opacity duration-200 ${
                            previewStatus === 'loaded' ? 'opacity-100' : 'opacity-0'
                        }`}
                        onLoad={() => setPreviewStatus('loaded')}
                        onError={() => setPreviewStatus('error')}
                    />
                </div>
            )}
            {source?.title && (
                <div className="text-[12px] font-semibold text-white leading-snug mb-1 line-clamp-2">
                    {source.title}
                </div>
            )}
            <div className="text-[10.5px] text-dark-400 mb-1.5">{displayHost}</div>
            {previewText && (
                <div className="text-[11.5px] text-dark-200 leading-relaxed line-clamp-4 mb-2">
                    {previewText}
                </div>
            )}
            <div className="flex items-center gap-1 text-[10.5px] text-dark-400 pt-1.5 border-t border-white/[0.06]">
                <span>Click to open</span>
                <ExternalLink className="w-2.5 h-2.5" />
            </div>
        </div>
    );

    return (
        <div
            ref={chipRef}
            className="relative"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {isValidUrl ? (
                <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] transition-colors"
                >
                    {chipInner}
                </a>
            ) : (
                <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-white/[0.04] border border-white/[0.06]">
                    {chipInner}
                </span>
            )}

            {isHovered && popupPos && (source?.title || previewText) &&
                typeof document !== 'undefined' &&
                createPortal(popupContent, document.body)}
        </div>
    );
}

/**
 * SearchSources - Horizontal row of favicon chips representing searched sources.
 *
 * @param {Object} props
 * @param {Array<{url: string, title: string, snippet?: string, content?: string}>} props.sources - Source list
 * @param {number} [props.maxVisible=8] - Maximum chips to render before collapsing into "+ N more"
 */
export default function SearchSources({ sources, maxVisible = 8 }) {
    const [hoveredIdx, setHoveredIdx] = useState(null);
    const [previewStatus, setPreviewStatus] = useState('loading'); // 'loading' | 'loaded' | 'error'

    // Reset preview state whenever the hovered source changes. Also arm
    // a safety timeout: if the preview image hasn't reported onLoad or
    // onError within 8 seconds, mark it as errored so the spinner doesn't
    // hang forever on slow/unresponsive preview services.
    useEffect(() => {
        if (hoveredIdx === null) return;
        setPreviewStatus('loading');
        const timer = setTimeout(() => {
            setPreviewStatus(prev => (prev === 'loading' ? 'error' : prev));
        }, 8000);
        return () => clearTimeout(timer);
    }, [hoveredIdx]);

    if (!Array.isArray(sources) || sources.length === 0) {
        return null;
    }

    const visible = sources.slice(0, maxVisible);
    const overflow = sources.length - visible.length;

    return (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {visible.map((source, idx) => (
                <SourceChip
                    key={`${source?.url || 'src'}-${idx}`}
                    source={source}
                    index={idx}
                    hoveredIdx={hoveredIdx}
                    setHoveredIdx={setHoveredIdx}
                    previewStatus={previewStatus}
                    setPreviewStatus={setPreviewStatus}
                />
            ))}
            {overflow > 0 && (
                <span className="inline-flex items-center h-6 px-2 rounded-full bg-white/[0.04] border border-white/[0.06] text-[10.5px] text-dark-300">
                    + {overflow} more
                </span>
            )}
        </div>
    );
}
