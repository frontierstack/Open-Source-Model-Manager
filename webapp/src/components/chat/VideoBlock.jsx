import React, { useState } from 'react';
import Box from '@mui/material/Box';

// Inline video renderer for find_video tool results. Receives the videoSpec
// the server returned in tool_result.result.videoSpec:
//   { query, videos: [{ url, embedUrl, videoUrl, thumbnail, title, duration,
//                        source, publisher, uploader, sourceUrl, views }] }
//
// Mirrors chat/src/components/chat/VideoBlock.jsx. Each tile is a click-to-play
// poster — the heavy provider <iframe> / native <video> is only mounted after
// the user clicks. All tile elements are phrasing-content (span/button/iframe/
// video/img — NO div) so a single tile is also valid inside a markdown <p>,
// which is how InlineVideoLink renders model-emitted video links.
function withAutoplay(url) {
    if (!url) return url;
    return url + (url.includes('?') ? '&' : '?') + 'autoplay=1';
}

// Map a single URL (a model-emitted markdown link, or a web-search hit) to a
// playable video descriptor — the same per-item shape find_video returns.
// Recognizes YouTube / Vimeo / Dailymotion links and direct video files in a
// wide range of formats. Returns null for non-video URLs.
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

    const frameSx = {
        position: 'relative',
        display: 'block',
        width: '100%',
        aspectRatio: '16 / 9',
        borderRadius: '8px',
        overflow: 'hidden',
        backgroundColor: '#000',
        border: '1px solid var(--border-primary)',
        textDecoration: 'none',
    };
    const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' };

    if (playing && canEmbed) {
        return (
            <Box component="span" sx={frameSx}>
                <Box
                    component="iframe"
                    src={withAutoplay(video.embedUrl)}
                    title={caption || 'video'}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    sx={fill}
                />
            </Box>
        );
    }
    if (playing && canFile) {
        return (
            <Box component="span" sx={frameSx}>
                <Box component="video" src={video.videoUrl} poster={poster || undefined} controls autoPlay sx={{ ...fill, objectFit: 'contain', backgroundColor: '#000' }} />
            </Box>
        );
    }

    const overlay = (
        <>
            {poster
                ? <Box component="img" src={poster} alt={caption} loading="lazy" onError={() => setPosterFailed(true)} sx={{ ...fill, objectFit: 'cover' }} />
                : <Box component="span" sx={{ ...fill, background: 'linear-gradient(135deg, #1a1a2e, #0a0a0f)' }} />}
            <Box component="span" sx={{
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
            </Box>
            {(caption || meta) && (
                <Box component="span" sx={{
                    position: 'absolute', left: 0, right: 0, bottom: 0,
                    display: 'block', px: 1, pt: 2, pb: 0.75,
                    background: 'linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0))',
                    color: '#fff', pointerEvents: 'none',
                }}>
                    {caption && (
                        <Box component="span" sx={{
                            display: 'block',
                            fontSize: 12, fontWeight: 600, lineHeight: 1.25,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{caption}</Box>
                    )}
                    {meta && <Box component="span" sx={{ display: 'block', fontSize: 10, opacity: 0.85, mt: '1px' }}>{meta}</Box>}
                </Box>
            )}
        </>
    );

    if (playable) {
        return (
            <Box component="button" type="button" onClick={() => setPlaying(true)} title={caption} sx={{ ...frameSx, cursor: 'pointer', p: 0 }}>
                {overlay}
            </Box>
        );
    }
    return (
        <Box component="a" href={video.sourceUrl || video.url} target="_blank" rel="noopener noreferrer" title={caption} sx={frameSx}>
            {overlay}
        </Box>
    );
}

// Single inline player for a markdown video link — span wrapper, valid in a <p>.
export function InlineVideoLink({ video }) {
    if (!video) return null;
    return (
        <Box component="span" sx={{ display: 'block', width: '100%', maxWidth: 520, my: 1 }}>
            <VideoTile video={video} />
        </Box>
    );
}

export default function VideoBlock({ spec }) {
    const videos = Array.isArray(spec?.videos)
        ? spec.videos.filter(v => v && (v.embedUrl || v.videoUrl || v.url))
        : [];
    if (videos.length === 0) return null;
    const cols = videos.length === 1 ? 1 : 2;
    return (
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 1,
                width: '100%',
                maxWidth: videos.length === 1 ? 520 : '100%',
                my: 1,
            }}
        >
            {videos.map((v, i) => (
                <VideoTile key={`${v.url || v.embedUrl || v.videoUrl}-${i}`} video={v} />
            ))}
        </Box>
    );
}
