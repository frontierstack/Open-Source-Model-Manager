// Bridge between chat's useChatStore (localStorage-backed) and the
// server-side /api/me/preferences endpoint shared with webapp:3001.
//
// On mount, chat calls hydrateFromServer() once after auth: any prefs
// that were set in webapp (or chat itself on a different device) are
// applied to the local store. Subsequent local changes (setTheme,
// updateSettings) are pushed back via watchAndSync().
//
// localStorage stays the source of truth between sessions on a single
// device for offline tolerance; the server endpoint is the source of
// truth across devices/apps.

import { useChatStore } from './stores/useChatStore';

const SYNCED_TOP_LEVEL = ['theme'];                                    // top-level fields on the chat store
const SYNCED_SETTINGS = ['fontFamily', 'fontSize', 'layout'];          // nested under settings
const REMOTE_FIELDS = new Set([...SYNCED_TOP_LEVEL, ...SYNCED_SETTINGS]);

let pushTimer = null;
function debouncedPush(patch) {
    if (Object.keys(patch).length === 0) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        fetch('/api/me/preferences', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        }).catch((err) => console.warn('[prefs] PUT failed:', err));
    }, 350);
}

export async function hydrateFromServer() {
    try {
        const r = await fetch('/api/me/preferences', { credentials: 'include' });
        if (!r.ok) return;
        const { preferences } = await r.json();
        if (!preferences) return;

        const store = useChatStore.getState();

        // Apply theme (top-level)
        if (preferences.theme && preferences.theme !== store.theme) {
            store.setTheme(preferences.theme);
        }

        // Apply settings.* fields via updateSettings (single batch)
        const settingsPatch = {};
        for (const k of SYNCED_SETTINGS) {
            if (preferences[k] != null && preferences[k] !== store.settings?.[k]) {
                settingsPatch[k] = preferences[k];
            }
        }
        if (Object.keys(settingsPatch).length > 0) {
            store.updateSettings(settingsPatch);
        }
    } catch (err) {
        console.warn('[prefs] hydrate failed:', err);
    }
}

// Subscribe to chat store changes; PUT diffs back to the server.
// Idempotent: calling watchAndSync more than once still leaves a single
// active subscription via the module-level guard.
let subscribed = false;
export function watchAndSync() {
    if (subscribed) return;
    subscribed = true;

    let prev = snapshot(useChatStore.getState());
    useChatStore.subscribe((state) => {
        const next = snapshot(state);
        const patch = {};
        for (const k of Object.keys(next)) {
            if (REMOTE_FIELDS.has(k) && next[k] !== prev[k] && next[k] != null) {
                patch[k] = next[k];
            }
        }
        if (Object.keys(patch).length > 0) {
            debouncedPush(patch);
            prev = next;
        }
    });
}

function snapshot(state) {
    const out = {};
    for (const k of SYNCED_TOP_LEVEL) out[k] = state[k];
    for (const k of SYNCED_SETTINGS) out[k] = state.settings?.[k];
    return out;
}
