import React, { useState } from 'react';
import Box from '@mui/material/Box';

// Inline image renderer for find_image tool results. Receives the imageSpec
// the server returned in tool_result.result.imageSpec:
//   { query, images: [{ url, thumbnail, title, source, sourceUrl, license,
//                        attribution, width, height }] }
//
// Mirrors chat/src/components/chat/ImageBlock.jsx but styled with the webapp's
// MUI + CSS-var palette. Clicking a tile opens the original in a new tab; a
// tile that fails to load (dead origin / hotlink block) hides itself rather
// than showing a broken-image icon.
function ImageTile({ image }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;
    const src = image.thumbnail || image.url;
    const caption = image.title || '';
    const meta = [image.source, image.license].filter(Boolean).join(' · ');
    return (
        <Box
            component="a"
            href={image.sourceUrl || image.url}
            target="_blank"
            rel="noopener noreferrer"
            title={image.attribution ? `${caption} — ${image.attribution}` : caption}
            sx={{
                position: 'relative',
                display: 'block',
                borderRadius: '8px',
                overflow: 'hidden',
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-primary)',
                textDecoration: 'none',
                aspectRatio: '4 / 3',
            }}
        >
            <Box
                component="img"
                src={src}
                alt={caption}
                loading="lazy"
                onError={() => setFailed(true)}
                sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {(caption || meta) && (
                <Box
                    sx={{
                        position: 'absolute', left: 0, right: 0, bottom: 0,
                        px: 1, pt: 1.75, pb: 0.75,
                        background: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))',
                        color: '#fff',
                        pointerEvents: 'none',
                    }}
                >
                    {caption && (
                        <Box sx={{
                            fontSize: 12, fontWeight: 600, lineHeight: 1.25,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{caption}</Box>
                    )}
                    {meta && (
                        <Box sx={{ fontSize: 10, opacity: 0.85, mt: '1px' }}>{meta}</Box>
                    )}
                </Box>
            )}
        </Box>
    );
}

export default function ImageBlock({ spec }) {
    const images = Array.isArray(spec?.images) ? spec.images.filter(im => im && im.url) : [];
    if (images.length === 0) return null;
    // One image reads better large; multiples go in a 2-up grid.
    const cols = images.length === 1 ? 1 : 2;
    return (
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 1,
                width: '100%',
                maxWidth: images.length === 1 ? 420 : '100%',
                my: 1,
            }}
        >
            {images.map((im, i) => (
                <ImageTile key={`${im.url}-${i}`} image={im} />
            ))}
        </Box>
    );
}
