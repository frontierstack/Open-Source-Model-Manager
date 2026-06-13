import React, { useState } from 'react';

// Inline image renderer for the find_image native tool result. Receives the
// imageSpec object the server returned in tool_result.result.imageSpec:
//   { query, images: [{ url, thumbnail, title, source, sourceUrl, license,
//                        attribution, width, height }] }
//
// The wrapping ToolCallBlock chip already shows the tool name + status — here
// we render the pictures themselves as a responsive thumbnail grid. Clicking a
// tile opens the original image in a new tab. A tile that fails to load (dead
// origin / hotlink block) hides itself rather than showing a broken-image icon.
function ImageTile({ image }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;
    const src = image.thumbnail || image.url;
    const caption = image.title || '';
    const meta = [image.source, image.license].filter(Boolean).join(' · ');
    return (
        <a
            href={image.sourceUrl || image.url}
            target="_blank"
            rel="noopener noreferrer"
            title={image.attribution ? `${caption} — ${image.attribution}` : caption}
            style={{
                position: 'relative',
                display: 'block',
                borderRadius: 8,
                overflow: 'hidden',
                background: 'var(--bg-2)',
                border: '1px solid var(--rule-2)',
                textDecoration: 'none',
                aspectRatio: '4 / 3',
            }}
        >
            <img
                src={src}
                alt={caption}
                loading="lazy"
                onError={() => setFailed(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {(caption || meta) && (
                <div
                    style={{
                        position: 'absolute', left: 0, right: 0, bottom: 0,
                        padding: '14px 8px 6px',
                        background: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))',
                        color: '#fff',
                        pointerEvents: 'none',
                    }}
                >
                    {caption && (
                        <div style={{
                            fontSize: 11.5, fontWeight: 600, lineHeight: 1.25,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{caption}</div>
                    )}
                    {meta && (
                        <div style={{ fontSize: 10, opacity: 0.85, marginTop: 1 }}>{meta}</div>
                    )}
                </div>
            )}
        </a>
    );
}

export default function ImageBlock({ spec }) {
    const images = Array.isArray(spec?.images) ? spec.images.filter(im => im && im.url) : [];
    if (images.length === 0) {
        return (
            <div style={{ padding: '12px 16px', color: 'var(--ink-3)', fontSize: 13, fontStyle: 'italic' }}>
                No images to display.
            </div>
        );
    }
    // One image reads better large and centered; multiples go in a 2-up grid.
    const cols = images.length === 1 ? 1 : 2;
    return (
        <div style={{ width: '100%' }}>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gap: 8,
                    width: '100%',
                    maxWidth: images.length === 1 ? 420 : '100%',
                }}
            >
                {images.map((im, i) => (
                    <ImageTile key={`${im.url}-${i}`} image={im} />
                ))}
            </div>
        </div>
    );
}
