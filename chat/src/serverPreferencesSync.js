// Bridge between chat's useChatStore (localStorage-backed) and the
// server-side /api/me/preferences endpoint, scoped to the `chat` bucket.
//
// On mount, chat calls hydrateFromServer() once after auth and applies the
// chat-scoped prefs to the local store. Subsequent local changes
// (setTheme, updateSettings) are pushed back via watchAndSync().
//
// The server stores webapp:3001 and chat:3002 prefs in separate buckets so
// changing the theme in one app does not silently alter the other.
// localStorage remains the source of truth between sessions on a single
// device; the server is the source of truth across devices.

import { useChatStore } from './stores/useChatStore';

// top-level fields on the chat store. `folders` + `conversationFolderMap`
// are arrays/objects (not scalars) — the store always replaces them with a
// fresh reference on every mutation, so the identity comparison in
// watchAndSync still detects changes correctly.
const SYNCED_TOP_LEVEL = ['theme', 'folders', 'conversationFolderMap'];
const SYNCED_SETTINGS = ['fontFamily', 'fontSize', 'layout', 'memoryDisabled']; // nested under settings
const REMOTE_FIELDS = new Set([...SYNCED_TOP_LEVEL, ...SYNCED_SETTINGS]);

let pushTimer = null;
function debouncedPush(patch) {
    if (Object.keys(patch).length === 0) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        fetch('/api/me/preferences?app=chat', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        }).catch((err) => console.warn('[prefs] PUT failed:', err));
    }, 350);
}

export async function hydrateFromServer() {
    try {
        const r = await fetch('/api/me/preferences?app=chat', { credentials: 'include' });
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

        // Sidebar folders + conversation→folder map. The server is the
        // cross-device source of truth: when it holds folder state we apply
        // it locally. When it doesn't yet (first load after this shipped, or
        // a brand-new account) we push this device's local folders up so the
        // pre-existing localStorage-only folders aren't stranded.
        if (Array.isArray(preferences.folders)) {
            store.setFolders(preferences.folders);
        } else if (Array.isArray(store.folders) && store.folders.length > 0) {
            debouncedPush({ folders: store.folders });
        }
        const remoteMap = preferences.conversationFolderMap;
        if (remoteMap && typeof remoteMap === 'object' && !Array.isArray(remoteMap)) {
            store.setConversationFolderMap(remoteMap);
        } else if (store.conversationFolderMap && Object.keys(store.conversationFolderMap).length > 0) {
            debouncedPush({ conversationFolderMap: store.conversationFolderMap });
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
