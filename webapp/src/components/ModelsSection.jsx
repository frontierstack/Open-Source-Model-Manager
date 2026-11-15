import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const STORAGE_KEY = 'modelsPageSections';

function readStored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
}

// One collapsible card on the My Models page. Every section shares this header
// so the page reads as one structured list; each remembers its open state.
// `count` shows a small badge next to the title; the section is reachable from
// the page header's jump links via the element id `models-section-<id>`.
export default function ModelsSection({ id, icon: Icon, title, summary, count, actions, defaultOpen = true, children }) {
    const [open, setOpen] = useState(() => {
        const stored = readStored();
        return typeof stored[id] === 'boolean' ? stored[id] : defaultOpen;
    });
    const toggle = () => {
        setOpen((value) => {
            const next = !value;
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), [id]: next })); } catch (_) { /* private mode */ }
            return next;
        });
    };
    // Animate open/close: the body stays mounted once it has been opened
    // and its height eases between 0 and auto via a grid-row transition.
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(open);
    React.useEffect(() => {
        if (open) {
            setMounted(true);
            const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
            return () => cancelAnimationFrame(raf);
        }
        setShown(false);
        return undefined;
    }, [open]);
    React.useEffect(() => {
        // A jump link from the page header opens the section it points at.
        const onOpen = (e) => { if (e.detail === id) setOpen(true); };
        window.addEventListener('models-section-open', onOpen);
        return () => window.removeEventListener('models-section-open', onOpen);
    }, [id]);
    return (
        <section
            id={`models-section-${id}`}
            className="mm-section rounded-2xl border"
            style={{ backgroundColor: 'var(--surface-primary)', borderColor: 'var(--border-primary)', scrollMarginTop: 16 }}
        >
            <div className="flex items-center gap-3 px-5 py-4">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }}
                >
                    {Icon && (
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}>
                            <Icon size={16} strokeWidth={1.75} />
                        </span>
                    )}
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                            <span className="text-[0.95rem] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
                            {count != null && (
                                <span
                                    className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[0.68rem] font-semibold"
                                    style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                                >
                                    {count}
                                </span>
                            )}
                        </span>
                        {summary && <span className="mt-0.5 block truncate text-xs" style={{ color: 'var(--text-tertiary)' }}>{summary}</span>}
                    </span>
                </button>
                {actions && <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>}
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
                    style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--text-tertiary)' }}
                >
                    <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
                </button>
            </div>
            {mounted && (
                <div className={`mm-collapse ${shown ? 'is-open' : ''}`} aria-hidden={!open}>
                    <div className="mm-collapse-inner">
                        <div className="px-5 pb-5 pt-1">{children}</div>
                    </div>
                </div>
            )}
        </section>
    );
}
