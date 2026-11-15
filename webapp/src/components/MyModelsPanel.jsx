import React from 'react';
import { HardDrive as StorageIcon } from 'lucide-react';

// Page header for the My Models tab: title, three figures (loaded, downloaded,
// on disk) and jump links to each section below. Sections open when jumped to
// (see ModelsSection's `models-section-open` listener).

const LINKS = [
    ['running', 'Running'],
    ['available', 'Library'],
    ['hf-cache', 'HF cache'],
    ['engines', 'Engines'],
    ['roles', 'Model roles'],
];

function Stat({ label, value }) {
    return (
        <div className="min-w-0 rounded-xl px-3 py-2.5 sm:min-w-[96px] sm:px-3.5" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <div className="text-[0.68rem] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</div>
        </div>
    );
}

function jump(id) {
    window.dispatchEvent(new CustomEvent('models-section-open', { detail: id }));
    // Let the section render open before scrolling to it.
    setTimeout(() => {
        document.getElementById(`models-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
}

export default function MyModelsPanel({ instancesLoaded = 0, modelsCount = 0, diskBytes = 0, hasHfCache = false, children }) {
    const disk = diskBytes > 0 ? `${(diskBytes / 1024 ** 3).toFixed(diskBytes > 100 * 1024 ** 3 ? 0 : 1)} GB` : '—';
    const links = LINKS.filter(([id]) => (id === 'running' ? instancesLoaded > 0 : id === 'hf-cache' ? hasHfCache : true));
    return (
        <div className="flex flex-col gap-4">
            <div
                className="rounded-2xl border px-5 py-4"
                style={{ backgroundColor: 'var(--surface-primary)', borderColor: 'var(--border-primary)' }}
            >
                <div className="flex flex-wrap items-center gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span
                            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                        >
                            <StorageIcon size={20} strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0">
                            <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>My Models</div>
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                Loaded models, your local library and the engines that run them
                            </div>
                        </div>
                    </div>
                    <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
                        <Stat label="Loaded" value={instancesLoaded} />
                        <Stat label="Downloaded" value={modelsCount} />
                        <Stat label="On disk" value={disk} />
                    </div>
                </div>
                <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="My Models sections">
                    {links.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => jump(id)}
                            className="mm-jump rounded-full px-3 py-1 text-xs font-medium"
                        >
                            {label}
                        </button>
                    ))}
                </nav>
            </div>
            {children}
        </div>
    );
}
