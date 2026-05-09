import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAppStore } from './useAppStore';

// Phase 1a bridge: mirror server-synced prefs into the legacy
// useAppStore so App.js's existing createAppTheme(useAppStore.preferences)
// useMemo rebuilds the MUI theme on each pref change. Without this,
// picking a theme in the new picker only swapped the CSS-variable class
// on <html> — Tailwind utilities updated, but MUI components stayed on
// the old hardcoded palette and looked unchanged. Drop this bridge in
// Phase 5 when MUI is removed.
const FONT_FAMILY_MAP = {
    inter: 'default',
    jetbrains: 'mono',
    system: 'system',
};
function mirrorPatchToLegacyStore(patch) {
    try {
        const legacy = useAppStore.getState();
        if (patch.theme != null && typeof legacy.setTheme === 'function') {
            legacy.setTheme(patch.theme);
        }
        if (patch.fontFamily != null && typeof legacy.setFontFamily === 'function') {
            legacy.setFontFamily(FONT_FAMILY_MAP[patch.fontFamily] || 'default');
        }
        if (patch.fontSize != null && typeof legacy.setFontSize === 'function') {
            // Legacy expects numeric pixels; new store uses 'small'|'medium'|'large'.
            const px = typeof patch.fontSize === 'number'
                ? patch.fontSize
                : ({ small: 12, medium: 14, large: 16 }[patch.fontSize] || 14);
            legacy.setFontSize(px);
        }
    } catch (_) { /* legacy store may not be initialized yet on first paint */ }
}

/**
 * Preferences Store — UI prefs (theme, accent, bubble, density, font, layout)
 * shared between webapp:3001 and chat:3002 via /api/me/preferences.
 *
 * On hydrate(): GET /api/me/preferences and apply to <html>/<body>.
 * On set(): write to local state + apply to DOM + debounced PUT.
 *
 * The same store shape lives in chat/src/stores/usePreferencesStore.js so a
 * theme picked in either app is reflected in the other on next mount.
 */

const VALID_THEMES = ['dark', 'midnight', 'ocean', 'sunset', 'matrix', 'solarized', 'kanagawa', 'palenight', 'research', 'research-dark', 'light'];
const VALID_ACCENTS = ['violet', 'amber', 'emerald', 'slate', 'rose'];
const VALID_BUBBLES = ['bubbles', 'cards', 'rows'];
const VALID_DENSITIES = ['comfortable', 'compact'];

const DEFAULTS = {
    theme: 'dark',
    accent: 'violet',
    bubble: 'cards',
    density: 'comfortable',
    fontFamily: 'inter',
    fontSize: 'medium',
    layout: 'default',
    codePreviewEnabled: true,
    compactSidebar: false,
};

// Apply prefs to the DOM. Idempotent.
function applyPreferencesToDom(prefs) {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;

    // Remove every theme-* class then add the active one. The list is
    // small enough that pruning by-name is faster than reading the full
    // classList and filtering.
    for (const t of VALID_THEMES) html.classList.remove('theme-' + t);
    if (prefs.theme && VALID_THEMES.includes(prefs.theme)) {
        html.classList.add('theme-' + prefs.theme);
    } else {
        html.classList.add('theme-dark');
    }

    if (body) {
        if (prefs.accent && VALID_ACCENTS.includes(prefs.accent)) body.dataset.accent = prefs.accent;
        if (prefs.bubble && VALID_BUBBLES.includes(prefs.bubble)) body.dataset.bubble = prefs.bubble;
        if (prefs.density && VALID_DENSITIES.includes(prefs.density)) body.dataset.density = prefs.density;
    }
}

// Coalesce rapid PUTs (e.g., user dragging a slider, picking colors fast).
function makeDebouncer(ms = 350) {
    let t = null;
    return (fn) => {
        if (t) clearTimeout(t);
        t = setTimeout(fn, ms);
    };
}
const debouncedSync = makeDebouncer(350);

async function pushToServer(patch) {
    try {
        await fetch('/api/me/preferences', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
    } catch (err) {
        console.warn('[preferences] PUT failed (kept local):', err);
    }
}

export const usePreferencesStore = create(
    devtools((set, get) => ({
        // State
        ...DEFAULTS,
        hydrated: false,
        loading: false,

        // Hydrate from the server. Safe to call repeatedly; subsequent
        // calls are cheap because the server returns the same payload.
        hydrate: async () => {
            if (get().loading) return;
            set({ loading: true });
            try {
                const r = await fetch('/api/me/preferences', { credentials: 'include' });
                if (!r.ok) {
                    // Not logged in or endpoint unavailable — keep defaults
                    // and apply them so the page still renders themed.
                    applyPreferencesToDom({ ...DEFAULTS });
                    set({ hydrated: true, loading: false });
                    return;
                }
                const { preferences } = await r.json();
                const merged = { ...DEFAULTS, ...(preferences || {}) };
                applyPreferencesToDom(merged);
                mirrorPatchToLegacyStore(merged);
                set({ ...merged, hydrated: true, loading: false });
            } catch (err) {
                console.warn('[preferences] hydrate failed (using defaults):', err);
                applyPreferencesToDom({ ...DEFAULTS });
                set({ hydrated: true, loading: false });
            }
        },

        // Update one or more pref fields. Applies to DOM immediately; the
        // PUT is debounced so a flurry of changes coalesces into one call.
        update: (patch) => {
            const next = { ...get(), ...patch };
            applyPreferencesToDom(next);
            mirrorPatchToLegacyStore(patch);
            set(patch);
            debouncedSync(() => pushToServer(patch));
        },

        // Convenience setters for common cases
        setTheme: (theme) => get().update({ theme }),
        setAccent: (accent) => get().update({ accent }),
        setBubble: (bubble) => get().update({ bubble }),
        setDensity: (density) => get().update({ density }),
        setLayout: (layout) => get().update({ layout }),
        setFontFamily: (fontFamily) => get().update({ fontFamily }),
        setFontSize: (fontSize) => get().update({ fontSize }),
        setCompactSidebar: (compactSidebar) => get().update({ compactSidebar }),
    }))
);

export const PREFERENCES_OPTIONS = {
    themes: VALID_THEMES,
    accents: VALID_ACCENTS,
    bubbles: VALID_BUBBLES,
    densities: VALID_DENSITIES,
};
