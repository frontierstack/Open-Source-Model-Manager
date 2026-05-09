import React, { useEffect, useRef, useState } from 'react';
import { usePreferencesStore, PREFERENCES_OPTIONS } from '../stores/usePreferencesStore';

// Theme display order + label, mirroring chat's ChatSettings picker.
const THEME_META = [
    { id: 'dark',          label: 'Dark',          dot: '#a78bfa' },
    { id: 'midnight',      label: 'Midnight',      dot: '#7dd3fc' },
    { id: 'ocean',         label: 'Ocean',         dot: '#22d3ee' },
    { id: 'sunset',        label: 'Sunset',        dot: '#fb923c' },
    { id: 'matrix',        label: 'Matrix',        dot: '#22c55e' },
    { id: 'solarized',     label: 'Solarized',     dot: '#eab308' },
    { id: 'kanagawa',      label: 'Kanagawa',      dot: '#7e9cd8' },
    { id: 'palenight',     label: 'Palenight',     dot: '#c792ea' },
    { id: 'research',      label: 'Research',      dot: '#a78bfa' },
    { id: 'research-dark', label: 'Research Dark', dot: '#a78bfa' },
    { id: 'light',         label: 'Light',         dot: '#525252' },
];

const ACCENT_META = [
    { id: 'violet',  swatch: 'oklch(0.55 0.13 290)' },
    { id: 'amber',   swatch: 'oklch(0.7 0.13 70)' },
    { id: 'emerald', swatch: 'oklch(0.6 0.13 160)' },
    { id: 'slate',   swatch: 'oklch(0.48 0.04 260)' },
    { id: 'rose',    swatch: 'oklch(0.6 0.17 15)' },
];

export default function ThemePicker() {
    const theme = usePreferencesStore((s) => s.theme);
    const accent = usePreferencesStore((s) => s.accent);
    const setTheme = usePreferencesStore((s) => s.setTheme);
    const setAccent = usePreferencesStore((s) => s.setAccent);

    const [open, setOpen] = useState(false);
    const popRef = useRef(null);
    const btnRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        function onDoc(e) {
            if (!popRef.current || !btnRef.current) return;
            if (popRef.current.contains(e.target) || btnRef.current.contains(e.target)) return;
            setOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const currentMeta = THEME_META.find((t) => t.id === theme) || THEME_META[0];

    return (
        <div className="relative inline-block">
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                // Match MUI Chip variant="outlined" size="medium" — height 32px,
                // 1px border, ~14px horizontal padding, 0.75rem font. Keeps the
                // header row consistent with the Connected / Active / username
                // chips that sit beside this picker.
                className="inline-flex h-8 items-center gap-2 rounded-2xl border px-3 text-xs font-medium transition"
                style={{
                    borderColor: 'var(--border-primary)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-primary)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                aria-expanded={open}
                aria-haspopup="menu"
            >
                <span
                    className="inline-block h-3 w-3 rounded-full ring-1 ring-black/30"
                    style={{ background: currentMeta.dot }}
                />
                <span>{currentMeta.label}</span>
                <svg className="h-3 w-3 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M5.516 7.548a.75.75 0 011.06 0L10 10.972l3.424-3.424a.75.75 0 111.06 1.06l-3.954 3.954a.75.75 0 01-1.06 0L5.516 8.608a.75.75 0 010-1.06z"/></svg>
            </button>

            {open && (
                <div
                    ref={popRef}
                    role="menu"
                    className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-dark-700 bg-dark-900/95 p-3 shadow-2xl backdrop-blur-sm"
                >
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-dark-400">Theme</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                        {THEME_META.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTheme(t.id)}
                                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                                    theme === t.id
                                        ? 'bg-primary-100 text-primary-500 ring-1 ring-primary-500/40'
                                        : 'text-dark-200 hover:bg-dark-800'
                                }`}
                                role="menuitemradio"
                                aria-checked={theme === t.id}
                            >
                                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.dot }} />
                                <span className="truncate">{t.label}</span>
                            </button>
                        ))}
                    </div>

                    <div className="mt-3 mb-2 flex items-center justify-between">
                        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-dark-400">Accent</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {ACCENT_META.map((a) => (
                            <button
                                key={a.id}
                                type="button"
                                onClick={() => setAccent(a.id)}
                                aria-label={`accent ${a.id}`}
                                className={`relative h-7 w-7 rounded-full transition ${
                                    accent === a.id
                                        ? 'ring-2 ring-offset-2 ring-offset-dark-900 ring-white/80'
                                        : 'hover:scale-105'
                                }`}
                                style={{ background: a.swatch }}
                            />
                        ))}
                    </div>

                    <div className="mt-3 border-t border-dark-700 pt-2 text-[0.65rem] text-dark-500">
                        Synced with chat:3002 via your account preferences.
                    </div>
                </div>
            )}
        </div>
    );
}

export { THEME_META, ACCENT_META };
