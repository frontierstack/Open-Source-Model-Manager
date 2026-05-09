import React from 'react';
import {
    LayoutGrid as AppsIcon,
    Play as PlayArrowIcon,
    Square as StopIcon,
    RefreshCw as RestartAltIcon,
} from 'lucide-react';

// Phase 5: Tailwind chrome for the Apps tab.
// Owns the page header and the grid of *non-integrated* app cards
// (start/stop/restart controls, port chips, status pill). The
// integrated open-model-agents block — with its Tools/Skills sub-tabs,
// dialog forms, and ToggleButtonGroup filters — stays MUI for now and
// is rendered by App.js after this panel; rebuilding those forms as
// Tailwind primitives is a multi-day port for marginal visual gain
// since they already inherit theme via Phase 3 component overrides.

function StatusPill({ status }) {
    let color;
    let label = status || 'unknown';
    if (status === 'running')      color = '#22c55e';
    else if (status === 'stopped') color = '#94a3b8';
    else                            color = '#ef4444';
    return (
        <span
            className="inline-flex h-6 items-center rounded-full border px-2 text-[0.7rem] font-medium capitalize"
            style={{
                color,
                backgroundColor: `${color}1A`,
                borderColor: `${color}55`,
            }}
        >
            {label}
        </span>
    );
}

function ActionPill({ icon: Icon, label, color, onClick, disabled }) {
    // Three semantic colors used here: green (start), red (stop),
    // theme-accent (restart, neutral). Hover and disabled states tint
    // accordingly. Heights match the new pill standard (h-8).
    const base = {
        green: { ring: '#22c55e', text: '#22c55e' },
        red:   { ring: '#ef4444', text: '#f87171' },
        accent:{ ring: 'var(--border-focus)', text: 'var(--accent-primary)' },
    }[color];
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
            style={{
                color: base.text,
                borderColor: base.ring,
                backgroundColor: 'transparent',
            }}
            onMouseEnter={(e) => {
                if (disabled) return;
                e.currentTarget.style.backgroundColor = `${typeof base.ring === 'string' && base.ring.startsWith('#') ? base.ring : '#fff'}${typeof base.ring === 'string' && base.ring.startsWith('#') ? '14' : ''}`;
                if (color === 'accent') e.currentTarget.style.backgroundColor = 'var(--accent-muted)';
            }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
            <Icon size={15} strokeWidth={2} />
            <span>{label}</span>
        </button>
    );
}

function AppCard({ app, onStart, onStop, onRestart }) {
    const status = app.status?.status;
    return (
        <div
            className="flex flex-col rounded-xl border p-4"
            style={{
                backgroundColor: 'var(--surface-primary)',
                borderColor: 'var(--border-primary)',
            }}
        >
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div
                        className="text-sm font-semibold mb-0.5"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {app.displayName}
                    </div>
                    <div className="text-[0.78rem]" style={{ color: 'var(--text-tertiary)' }}>
                        {app.description}
                    </div>
                </div>
                <StatusPill status={status} />
            </div>

            <div className="my-2 border-t" style={{ borderColor: 'var(--border-primary)' }} />

            {app.url && (
                <div className="mb-2">
                    <div className="text-[0.65rem] uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
                        Access URL
                    </div>
                    <div
                        className="font-mono text-xs truncate"
                        style={{ color: 'var(--accent-primary)' }}
                        title={app.url}
                    >
                        {app.url}
                    </div>
                </div>
            )}

            {app.ports && app.ports.length > 0 && (
                <div className="mb-3">
                    <div className="text-[0.65rem] uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
                        Ports
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {app.ports.map((port, idx) => (
                            <span
                                key={idx}
                                className="inline-flex h-6 items-center rounded-full border px-2 text-[0.7rem] font-medium"
                                style={{
                                    color: 'var(--text-secondary)',
                                    borderColor: 'var(--border-primary)',
                                    backgroundColor: 'var(--bg-tertiary)',
                                }}
                            >
                                {port.external} ({port.protocol.toUpperCase()})
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="mt-auto flex flex-wrap gap-2">
                <ActionPill
                    icon={PlayArrowIcon}
                    label="Start"
                    color="green"
                    onClick={() => onStart(app.name)}
                    disabled={status === 'running'}
                />
                <ActionPill
                    icon={StopIcon}
                    label="Stop"
                    color="red"
                    onClick={() => onStop(app.name)}
                    disabled={status === 'stopped' || status === 'not_found'}
                />
                <ActionPill
                    icon={RestartAltIcon}
                    label="Restart"
                    color="accent"
                    onClick={() => onRestart(app.name)}
                    disabled={status === 'stopped' || status === 'not_found'}
                />
            </div>
        </div>
    );
}

export default function AppsPanel({
    apps = [],
    onStart,
    onStop,
    onRestart,
    children,
}) {
    const externalApps = apps.filter((a) => !a.integrated);
    return (
        <div className="flex flex-col gap-4">
            {/* Page header */}
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
                    <AppsIcon size={20} strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Apps Management
                    </div>
                    <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                        Manage integrated applications and agent systems
                    </div>
                </div>
            </div>

            {/* External apps grid */}
            {externalApps.length > 0 && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {externalApps.map((app) => (
                        <AppCard
                            key={app.name}
                            app={app}
                            onStart={onStart}
                            onStop={onStop}
                            onRestart={onRestart}
                        />
                    ))}
                </div>
            )}

            {/* Integrated agents block (still MUI; rendered by App.js as
                children inside this panel so it shares the surrounding
                Tailwind layout). */}
            {children}
        </div>
    );
}
