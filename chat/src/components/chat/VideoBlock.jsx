import React, { useState } from 'react';

// Inline video renderer for the find_video native tool result. Receives the
// videoSpec object the server returned in tool_result.result.videoSpec:
//   { query, videos: [{ url, embedUrl, videoUrl, thumbnail, title, duration,
//                        source, publisher, uploader, sourceUrl, views }] }
//
// Each tile is a click-to-play poster — the heavy provider <iframe> / native
// <video> is only mounted after the user clicks (a grid of auto-loading
// embeds is slow and noisy). All elements are phrasing-content (span/button/
// iframe/video/img — NO div) so a single tile is also valid inside a markdown
// <p>, which is how InlineVideoLink renders model-emitted video links.
function withAutoplay(url) {
    if (!url) return url;
    return url + (url.includes('?') ? '&' : '?') + 'autoplay=1';
}

// Map a single URL (a model-emitted markdown link, or a web-search hit) to a
// playable video descriptor — the same per-item shape find_video returns.
// Recognizes YouTube / Vimeo / Dailymotion watch+embed links and direct video
// files in a wide range of formats. Returns null for non-video URLs.
export function videoDescriptorFromUrl(rawUrl, title) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const url = /^http:\/\//i.test(rawUrl) ? rawUrl.replace(/^http:\/\//i, 'https://') : rawUrl;
    if (!/^https?:\/\//i.test(url)) return null;
    let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    if (m) return { embedUrl: `https://www.youtube-nocookie.com/embed/${m[1]}`, thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`, url, sourceUrl: url, title: title || '', source: 'youtube' };
    m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, url, sourceUrl: url, title: title || '', source: 'vimeo' };
    m = url.match(/(?:dailymotion\.com\/(?:video|embed\/video)\/|dai\.ly\/)([A-Za-z0-9]+)/i);
    if (m) return { embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}`, url, sourceUrl: url, title: title || '', source: 'dailymotion' };
    if (/\.(mp4|webm|ogg|ogv|mov|m4v|mkv|avi|3gp|3g2|mpeg|mpg|m2ts|ts|flv|wmv)(?:[?#]|$)/i.test(url)) {
        return { videoUrl: url, url, sourceUrl: url, title: title || '', source: 'video' };
    }
    return null;
}

function VideoTile({ video }) {
    const [playing, setPlaying] = useState(false);
    const [posterFailed, setPosterFailed] = useState(false);
    const caption = video.title || '';
    const meta = [video.source, video.duration, video.uploader].filter(Boolean).join(' · ');
    const poster = !posterFailed ? (video.thumbnail || null) : null;
    const canEmbed = !!video.embedUrl;
    const canFile = !!video.videoUrl;
    const playable = canEmbed || canFile;

    const frame = {
        position: 'relative',
        display: 'block',
        width: '100%',
        aspectRatio: '16 / 9',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#000',
        border: '1px solid var(--rule-2)',
        textDecoration: 'none',
    };
    const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' };

    if (playing && canEmbed) {
        return (
            <span style={frame}>
                <iframe
                    src={withAutoplay(video.embedUrl)}
                    title={caption || 'video'}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    style={fill}
                />
            </span>
        );
    }
    if (playing && canFile) {
        return (
            <span style={frame}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video src={video.videoUrl} poster={poster || undefined} controls autoPlay style={{ ...fill, objectFit: 'contain', background: '#000' }} />
            </span>
        );
    }

    // Poster / click-to-play state — all phrasing-content elements.
    const overlay = (
        <>
            {poster
                ? <img src={poster} alt={caption} loading="lazy" onError={() => setPosterFailed(true)} style={{ ...fill, objectFit: 'cover' }} />
                : <span style={{ ...fill, background: 'linear-gradient(135deg, #1a1a2e, #0a0a0f)' }} />}
            <span style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 52, height: 52, borderRadius: '50%',
                background: 'rgba(0,0,0,0.55)',
                border: '2px solid rgba(255,255,255,0.9)',
                display: 'grid', placeItems: 'center',
                pointerEvents: 'none',
            }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 3 }}>
                    <path d="M8 5v14l11-7z" />
                </svg>
            </span>
            {(caption || meta) && (
                <span style={{
                    position: 'absolute', left: 0, right: 0, bottom: 0,
                    display: 'block', padding: '16px 8px 6px',
                    background: 'linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0))',
                    color: '#fff', pointerEvents: 'none',
                }}>
                    {caption && (
                        <span style={{
                            display: 'block',
                            fontSize: 11.5, fontWeight: 600, lineHeight: 1.25,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{caption}</span>
                    )}
                    {meta && <span style={{ display: 'block', fontSize: 10, opacity: 0.85, marginTop: 1 }}>{meta}</span>}
                </span>
            )}
        </>
    );

    if (playable) {
        return (
            <button type="button" onClick={() => setPlaying(true)} title={caption} style={{ ...frame, cursor: 'pointer', padding: 0 }}>
                {overlay}
            </button>
        );
    }
    return (
        <a href={video.sourceUrl || video.url} target="_blank" rel="noopener noreferrer" title={caption} style={frame}>
            {overlay}
        </a>
    );
}

// Single inline player for a markdown video link — span wrapper so it's valid
// inside a <p>, capped width so it doesn't blow out the bubble.
export function InlineVideoLink({ video }) {
    if (!video) return null;
    return (
        <span style={{ display: 'block', width: '100%', maxWidth: 520, margin: '8px 0' }}>
            <VideoTile video={video} />
        </span>
    );
}

export default function VideoBlock({ spec }) {
    const videos = Array.isArray(spec?.videos)
        ? spec.videos.filter(v => v && (v.embedUrl || v.videoUrl || v.url))
        : [];
    if (videos.length === 0) {
        return (
            <div style={{ padding: '12px 16px', color: 'var(--ink-3)', fontSize: 13, fontStyle: 'italic' }}>
                No videos to display.
            </div>
        );
    }
    // One video reads better large; multiples go in a 2-up grid.
    const cols = videos.length === 1 ? 1 : 2;
    return (
        <div style={{ width: '100%' }}>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gap: 8,
                    width: '100%',
                    maxWidth: videos.length === 1 ? 520 : '100%',
                }}
            >
                {videos.map((v, i) => (
                    <VideoTile key={`${v.url || v.embedUrl || v.videoUrl}-${i}`} video={v} />
                ))}
            </div>
        </div>
    );
}
