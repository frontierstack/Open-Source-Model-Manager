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
 * WordPress mshots is a free, no-auth public link-preview service. The FIRST
 * request for an uncached target returns a "generating…" placeholder and kicks
 * off the real screenshot in the background; only a later request gets the real
 * image. That is why the preview used to look blank until you hovered a few
 * times. We (1) PRE-WARM the screenshot the moment the sources render so mshots
 * starts generating immediately, and (2) RETRY with a cache-buster while the
 * popup is open so a placeholder gets swapped for the real screenshot as soon as
 * it is ready — no more "hover repeatedly to make it appear".
 */
function mshotsUrl(url, retry = 0) {
    const base = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=640&h=400`;
    return retry ? `${base}&r=${retry}` : base;
}

const warmedPreviews = new Set();
function prewarmPreview(url) {
    if (!url || warmedPreviews.has(url)) return;
    warmedPreviews.add(url);
    try {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.src = mshotsUrl(url);
    } catch (_) { /* best-effort */ }
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
function SourceChip({ source, index, hoveredIdx, setHoveredIdx }) {
    const hoverTimerRef = useRef(null);
    const chipRef = useRef(null);
    const [popupPos, setPopupPos] = useState(null);
    // Per-chip preview state (was shared across all chips, which let one chip's
    // load state leak onto another). 'loading' | 'loaded' | 'error'.
    const [previewStatus, setPreviewStatus] = useState('loading');
    const [retry, setRetry] = useState(0);
    const retryTimersRef = useRef([]);

    const hostname = getHostname(source?.url);
    const isValidUrl = !!hostname;
    const isHovered = hoveredIdx === index;

    // Pre-warm this source's screenshot as soon as the chip mounts so mshots is
    // generating it well before the user hovers.
    useEffect(() => {
        if (isValidUrl) prewarmPreview(source.url);
    }, [source?.url, isValidUrl]);

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
        }, 150);
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

    // While the popup is open, retry the screenshot a couple of times so an
    // initial mshots placeholder is replaced by the real screenshot the moment
    // it finishes generating, instead of sitting on a blank/placeholder frame.
    useEffect(() => {
        retryTimersRef.current.forEach(clearTimeout);
        retryTimersRef.current = [];
        if (!isHovered || !isValidUrl) return;
        // Don't reset to 'loading' if we already have a real image cached.
        setPreviewStatus((s) => (s === 'loaded' ? 'loaded' : 'loading'));
        // Cache-busted reloads at 2.5s and 5s upgrade a placeholder → real.
        retryTimersRef.current.push(setTimeout(() => setRetry((r) => r + 1), 2500));
        retryTimersRef.current.push(setTimeout(() => setRetry((r) => r + 1), 5000));
        // Safety: if nothing has loaded after 9s, show the text-only card.
        retryTimersRef.current.push(setTimeout(() => {
            setPreviewStatus((prev) => (prev === 'loading' ? 'error' : prev));
        }, 9000));
        return () => { retryTimersRef.current.forEach(clearTimeout); retryTimersRef.current = []; };
    }, [isHovered, isValidUrl]);

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            retryTimersRef.current.forEach(clearTimeout);
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
                    className="src-avatar"
                    style={{ backgroundColor: avatarColor.bg, color: avatarColor.fg }}
                    aria-hidden="true"
                >
                    {letter}
                </span>
            ) : (
                <Globe style={{ width: 14, height: 14, color: 'var(--ink-3)', flexShrink: 0 }} />
            )}
            <span className="src-host">
                {displayHost}
            </span>
        </>
    );

    const popupContent = (
        <div
            className="src-popup"
            style={{
                left: popupPos?.left ?? 0,
                top: popupPos?.top ?? 0,
                zIndex: 9999,
            }}
        >
            {isValidUrl && previewStatus !== 'error' && (
                <div className="src-popup-shot">
                    {previewStatus === 'loading' && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--ink-4)' }} />
                        </div>
                    )}
                    <img
                        key={retry}
                        src={mshotsUrl(source.url, retry)}
                        alt=""
                        referrerPolicy="no-referrer"
                        className={`w-full h-full object-cover transition-opacity duration-200 ${
                            previewStatus === 'loaded' ? 'opacity-100' : 'opacity-0'
                        }`}
                        onLoad={() => setPreviewStatus('loaded')}
                        onError={() => setPreviewStatus((p) => (p === 'loaded' ? 'loaded' : 'error'))}
                    />
                </div>
            )}
            {source?.title && (
                <div className="src-popup-title line-clamp-2">
                    {source.title}
                </div>
            )}
            <div className="src-popup-host">{displayHost}</div>
            {previewText && (
                <div className="src-popup-text line-clamp-4">
                    {previewText}
                </div>
            )}
            <div className="src-popup-foot">
                <span>Click to open</span>
                <ExternalLink />
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
                    className="src-chip"
                >
                    {chipInner}
                </a>
            ) : (
                <span className="src-chip">
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

    // Pre-warm every visible source's screenshot as soon as the row renders, so
    // mshots has finished generating by the time the user hovers a chip.
    useEffect(() => {
        if (!Array.isArray(sources)) return;
        sources.slice(0, maxVisible).forEach((s) => { if (s?.url) prewarmPreview(s.url); });
    }, [sources, maxVisible]);

    if (!Array.isArray(sources) || sources.length === 0) {
        return null;
    }

    const visible = sources.slice(0, maxVisible);
    const overflow = sources.length - visible.length;

    return (
        <div className="src-chips">
            {visible.map((source, idx) => (
                <SourceChip
                    key={`${source?.url || 'src'}-${idx}`}
                    source={source}
                    index={idx}
                    hoveredIdx={hoveredIdx}
                    setHoveredIdx={setHoveredIdx}
                />
            ))}
            {overflow > 0 && (
                <span className="src-chip src-chip-more">
                    + {overflow} more
                </span>
            )}
        </div>
    );
}
