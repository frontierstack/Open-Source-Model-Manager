import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink } from 'lucide-react';

// Full-size picture over the chat. Pictures are shown with <img>, so a
// script inside an SVG never runs (the browser treats an <img> SVG as a
// static picture).
export default function ImageLightbox({ src, alt, onClose }) {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    if (!src) return null;
    return createPortal(
        <div className="img-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
            <div className="img-lightbox-bar" onClick={e => e.stopPropagation()}>
                <span className="img-lightbox-title">{alt || ''}</span>
                <a href={src} target="_blank" rel="noopener noreferrer" className="ui-icon-btn" title="Open in a new tab">
                    <ExternalLink strokeWidth={2} />
                </a>
                <button type="button" className="ui-icon-btn" onClick={onClose} title="Close" aria-label="Close">
                    <X strokeWidth={2} />
                </button>
            </div>
            <img src={src} alt={alt || ''} className="img-lightbox-img" onClick={e => e.stopPropagation()} />
        </div>,
        document.body,
    );
}
