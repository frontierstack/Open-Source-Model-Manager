import React from 'react';
import { HardDrive as StorageIcon } from 'lucide-react';

// Phase 6: Tailwind chrome for the My Models tab.
//
// Owns only the page-header tile so the tab's outer surface matches
// LogsPanel / UsersPanel / AppsPanel. The three inner sections —
// Running Instances, Cached vLLM Models, Available Models — render
// inside via {children}; their cards are still MUI for now and
// inherit theme colors via the Phase 3 component overrides. A full
// rebuild of the running-instance cards (~260 lines: status/port/
// backend pills, KV-cache slots, log streams, control surface) is a
// dedicated future port — this commit just unifies the page chrome.
//
// Props:
//   instancesLoaded   number — used in the subtitle
//   children          the existing tab content (Grid + 3 sections)

export default function MyModelsPanel({ instancesLoaded = 0, children }) {
    return (
        <div className="flex flex-col gap-4">
            {/* Page header — same vocabulary as Logs/Users/Apps:
                9x9 accent-tinted icon tile + title/subtitle stack. */}
            <div
                className="flex items-center gap-3 rounded-xl border px-4 py-3"
                style={{
                    backgroundColor: 'var(--surface-primary)',
                    borderColor: 'var(--border-primary)',
                }}
            >
                <span
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                >
                    <StorageIcon size={20} strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        My Models
                    </div>
                    <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                        {instancesLoaded > 0
                            ? `${instancesLoaded} model${instancesLoaded > 1 ? 's' : ''} currently loaded · manage instances, cache, and downloads`
                            : 'Manage loaded instances, the vLLM cache, and your local model library'}
                    </div>
                </div>
            </div>

            {/* Tab body (still MUI inside, themed via Phase 3 overrides) */}
            {children}
        </div>
    );
}
