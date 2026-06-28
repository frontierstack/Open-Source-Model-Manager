import React, { useState, useEffect } from 'react';
import {
    LayoutGrid as AppsIcon,
    Play as PlayArrowIcon,
    Square as StopIcon,
    RefreshCw as RestartAltIcon,
    ShieldAlert as ShieldAlertIcon,
    Loader2 as SpinnerIcon,
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

// Admin toggle for internal/private network access. Default OFF (the SSRF
// guard on web tools + the sandbox egress proxy both block private/internal
// addresses). Turning it ON relaxes both — except the cloud-metadata IP
// (169.254.x), which stays blocked. Self-contained: reads/writes
// /api/system-settings directly.
function NetworkAccessCard() {
    const [allow, setAllow] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/system-settings', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d) => { if (!cancelled) setAllow(!!d.allowInternalNetwork); })
            .catch((e) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const toggle = async () => {
        const next = !allow;
        setSaving(true);
        setError(null);
        try {
            const r = await fetch('/api/system-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ allowInternalNetwork: next }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            setAllow(!!d.allowInternalNetwork);
        } catch (e) {
            setError(e.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className="rounded-lg border p-4"
            style={{ borderColor: 'var(--border-color, rgba(255,255,255,0.1))', background: 'var(--bg-secondary, rgba(255,255,255,0.02))' }}
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <ShieldAlertIcon size={18} className="mt-0.5 shrink-0" style={{ color: allow ? '#f59e0b' : 'var(--text-secondary)' }} />
                    <div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            Internal network access
                        </div>
                        <div className="mt-0.5 text-[0.78rem] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            When <strong>off</strong> (default, recommended), web tools and sandbox skills cannot reach
                            private/internal addresses (localhost, 10.x, 172.16–31.x, 192.168.x, Docker hosts) — an SSRF
                            safeguard. Turn <strong>on</strong> only if you need the server to reach your LAN/internal
                            services. The cloud-metadata IP (169.254.x) stays blocked either way.
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={allow}
                    disabled={loading || saving}
                    onClick={toggle}
                    title={allow ? 'Disable internal network access' : 'Enable internal network access'}
                    className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
                    style={{ background: allow ? '#f59e0b' : 'var(--border-color, rgba(255,255,255,0.2))' }}
                >
                    <span
                        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${allow ? 'translate-x-[22px]' : 'translate-x-[2px]'}`}
                    />
                </button>
            </div>
            {(saving || error) && (
                <div className="mt-2 flex items-center gap-1.5 text-[0.72rem]" style={{ color: error ? '#ef4444' : 'var(--text-secondary)' }}>
                    {saving && <SpinnerIcon size={12} className="animate-spin" />}
                    {error ? `Couldn't save: ${error}` : 'Saving…'}
                </div>
            )}
            {allow && !saving && !error && (
                <div className="mt-2 text-[0.72rem]" style={{ color: '#f59e0b' }}>
                    ⚠ Internal/private network access is currently ALLOWED.
                </div>
            )}
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
            {/* Admin: internal/private network access toggle (SSRF safeguard) */}
            <NetworkAccessCard />

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
