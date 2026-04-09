import React, { useState, useRef, useEffect } from 'react';
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
 */
function SourceChip({ source, index, hoveredIdx, setHoveredIdx, previewStatus, setPreviewStatus }) {
    const [faviconFailed, setFaviconFailed] = useState(false);
    const hoverTimerRef = useRef(null);

    const hostname = getHostname(source?.url);
    const isValidUrl = !!hostname;
    const isHovered = hoveredIdx === index;

    const handleMouseEnter = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
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

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        };
    }, []);

    const faviconUrl = isValidUrl
        ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`
        : null;

    const displayHost = hostname || 'unknown';
    const previewText = truncate(source?.content || source?.snippet || '', 280);

    const chipInner = (
        <>
            {faviconFailed || !faviconUrl ? (
                <Globe className="w-3.5 h-3.5 text-dark-300 flex-shrink-0" />
            ) : (
                <img
                    src={faviconUrl}
                    alt=""
                    className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                    onError={() => setFaviconFailed(true)}
                />
            )}
            <span className="text-[10.5px] text-dark-300 truncate max-w-[140px]">
                {displayHost}
            </span>
        </>
    );

    return (
        <div
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

            {isHovered && (source?.title || previewText) && (
                <div className="absolute bottom-full mb-2 left-0 z-50 w-80 p-3 rounded-lg bg-dark-900 border border-white/10 shadow-xl pointer-events-none">
                    {isValidUrl && previewStatus !== 'error' && (
                        <div className="relative w-full h-36 mb-2 rounded-md overflow-hidden bg-white/[0.03] ring-1 ring-white/10">
                            {previewStatus === 'loading' && (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <Loader2 className="w-5 h-5 text-dark-300 animate-spin" />
                                </div>
                            )}
                            <img
                                src={`https://image.thum.io/get/width/640/crop/400/${source.url}`}
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
            )}
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

    // Reset preview state whenever the hovered source changes
    useEffect(() => {
        if (hoveredIdx !== null) {
            setPreviewStatus('loading');
        }
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
