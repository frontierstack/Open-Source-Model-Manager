import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Globe, ExternalLink, Loader2 } from 'lucide-react';
import { warmPreview, getPreview, subscribePreview } from '../../utils/linkPreview';

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
 * Screenshot previews come from WordPress mshots through utils/linkPreview,
 * which keeps polling a VISIBLE chip's page until the real screenshot has been
 * rendered and cached — mshots answers the first requests with a "generating"
 * placeholder — so a hover shows it immediately instead of waiting it out.
 */
function usePreview(url, enabled) {
    const [state, setState] = useState(() => (enabled ? getPreview(url) : { status: 'idle', src: null }));
    useEffect(() => {
        if (!enabled) return undefined;
        setState(getPreview(url));
        return subscribePreview(url, setState);
    }, [url, enabled]);
    return state;
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
    const hostname = getHostname(source?.url);
    const isValidUrl = !!hostname;
    const isHovered = hoveredIdx === index;
    const preview = usePreview(source?.url, isValidUrl);
    const [imgShown, setImgShown] = useState(false);

    // Start the screenshot as soon as the chip is on (or near) the screen, so it
    // has finished rendering by the time the user hovers. Chips in old messages
    // far up the conversation do not fire requests until scrolled to.
    useEffect(() => {
        if (!isValidUrl) return undefined;
        const el = chipRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') { warmPreview(source.url); return undefined; }
        const io = new IntersectionObserver((items) => {
            if (items.some((it) => it.isIntersecting)) { warmPreview(source.url); io.disconnect(); }
        }, { rootMargin: '300px 0px' });
        io.observe(el);
        return () => io.disconnect();
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
        if (isValidUrl) warmPreview(source.url, { urgent: true });
        hoverTimerRef.current = setTimeout(() => {
            setPopupPos(computePopupPos());
            setHoveredIdx(index);
        }, 150);
    };

    // Touch devices never fire mouseenter, so the preview popup was unreachable
    // on a phone. First tap opens the preview, second tap follows the link.
    const isCoarsePointer = () =>
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(hover: none)').matches;

    const handleChipClick = (e) => {
        if (!isCoarsePointer()) return;      // desktop keeps pure hover behaviour
        if (isHovered) return;               // already previewing → let the tap navigate
        e.preventDefault();
        e.stopPropagation();
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        if (isValidUrl) warmPreview(source.url, { urgent: true });
        setPopupPos(computePopupPos());
        setHoveredIdx(index);
    };

    const handleMouseLeave = () => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        setHoveredIdx((current) => (current === index ? null : current));
    };

    // Dismiss a tap-opened preview with an outside tap or Escape (touch has no
    // mouseleave to close it).
    useEffect(() => {
        if (!isHovered) return;
        const close = (e) => {
            if (chipRef.current && chipRef.current.contains(e.target)) return;
            setHoveredIdx((current) => (current === index ? null : current));
        };
        const onKey = (e) => {
            if (e.key === 'Escape') setHoveredIdx((current) => (current === index ? null : current));
        };
        document.addEventListener('pointerdown', close, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', close, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [isHovered, index, setHoveredIdx]);

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
            {isValidUrl && preview.status !== 'failed' && (
                <div className="src-popup-shot">
                    {!(preview.status === 'ready' && imgShown) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--ink-4)' }} />
                            {preview.status === 'pending' && (
                                <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Rendering preview…</span>
                            )}
                        </div>
                    )}
                    {preview.status === 'ready' && preview.src && (
                        <img
                            src={preview.src}
                            alt=""
                            referrerPolicy="no-referrer"
                            className={`w-full h-full object-cover transition-opacity duration-150 ${imgShown ? 'opacity-100' : 'opacity-0'}`}
                            onLoad={() => setImgShown(true)}
                            ref={(el) => { if (el && el.complete && el.naturalWidth) setImgShown(true); }}
                        />
                    )}
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
            onClick={handleChipClick}
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
