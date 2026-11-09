import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const STORAGE_KEY = 'modelsPageSections';

function readStored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
}

// One collapsible card on the My Models page. Every section shares this header
// so the page reads as one structured list; each remembers its open state.
export default function ModelsSection({ id, icon: Icon, title, summary, actions, defaultOpen = true, children }) {
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
    return (
        <section className="rounded-xl border" style={{ backgroundColor: 'var(--surface-primary)', borderColor: 'var(--border-primary)' }}>
            <div className="flex items-center gap-3 px-4 py-2.5">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }}
                >
                    {Icon && (
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}>
                            <Icon size={15} strokeWidth={1.75} />
                        </span>
                    )}
                    <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
                        {summary && <span className="block truncate text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>{summary}</span>}
                    </span>
                </button>
                {actions && <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>}
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
                    className="flex-shrink-0"
                    style={{ background: 'none', border: 0, padding: 2, cursor: 'pointer', color: 'var(--text-tertiary)' }}
                >
                    <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
                </button>
            </div>
            {open && <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>{children}</div>}
        </section>
    );
}
