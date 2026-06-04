import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

// Storage key constants
const STORAGE_KEYS = {
    THEME: 'chat-theme',
    SYSTEM_PROMPTS: 'chat-system-prompts',
    SETTINGS: 'chat-settings',
    ACTIVE_CONVERSATION: 'chat-active-conversation-id',
    FOLDERS: 'chat-folders',
    CONVERSATION_FOLDER_MAP: 'chat-conversation-folder-map'
};

// Load persisted data from localStorage
const loadFromStorage = (key, defaultValue) => {
    try {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : defaultValue;
    } catch (e) {
        console.error(`Failed to load ${key} from localStorage:`, e);
        return defaultValue;
    }
};

// Save data to localStorage
const saveToStorage = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error(`Failed to save ${key} to localStorage:`, e);
    }
};

// Migrate old settings - clear hardcoded maxTokens defaults
const migrateSettings = () => {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        if (stored) {
            const settings = JSON.parse(stored);
            let dirty = false;

            // If maxTokens was set to old hardcoded default (1024), reset to null
            // so it uses the model's context window dynamically
            if (settings.maxTokens === 1024) {
                settings.maxTokens = null;
                dirty = true;
                console.log('[Settings] Migrated maxTokens from 1024 to null (dynamic)');
            }

            // Removed chat layouts: 'terminal' (replaced by 'bubbles') and
            // 'wide' (functionally the same as 'default'). Migrate anyone
            // who had either saved to 'default'.
            if (settings.chatStyle === 'terminal' || settings.chatStyle === 'wide') {
                const prev = settings.chatStyle;
                settings.chatStyle = 'default';
                dirty = true;
                console.log(`[Settings] Migrated chatStyle ${prev} -> default (${prev} removed)`);
            }

            if (dirty) {
                localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
            }
        }

        // Theme lives in its own localStorage key, not inside settings.
        // Vesper was replaced with Mocha — migrate stored value so the UI
        // doesn't render unthemed.
        const storedTheme = localStorage.getItem(STORAGE_KEYS.THEME);
        if (storedTheme) {
            // localStorage stores JSON-encoded strings here
            const parsed = (() => { try { return JSON.parse(storedTheme); } catch { return storedTheme; } })();
            if (parsed === 'vesper') {
                localStorage.setItem(STORAGE_KEYS.THEME, JSON.stringify('mocha'));
                console.log('[Settings] Migrated theme vesper -> mocha (vesper removed)');
            }
        }
    } catch (e) {
        console.error('Failed to migrate settings:', e);
    }
};

// Run migration on load
migrateSettings();

/**
 * Chat Store
 * Manages conversations, messages, chat settings, theme, and user info
 */
export const useChatStore = create(
    devtools((set, get) => ({
        // ==================== State ====================

        // Conversations
        conversations: [],
        // Restored from localStorage so that a browser refresh reopens the
        // last-viewed conversation (and its memories) without requiring
        // the user to re-click a sidebar item. Falls back to null if no
        // prior selection exists.
        activeConversationId: loadFromStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, null),
        // Top-level view switch: 'chat' (default) or 'automation' (the
        // full-screen workflow editor). Not persisted — always start in chat.
        view: 'chat',
        messages: [],

        // Streaming
        isStreaming: false,
        streamingContent: '',
        streamingReasoning: '',
        // Native tool calls observed during the current stream. Each entry:
        //   { tool_call_id, name, arguments, status: 'running'|'success'|'failed',
        //     preview?, durationMs?, startedAt }
        // Displayed live in the streaming bubble and merged into the final
        // assistant message on commit.
        streamingToolCalls: [],

        // Optional server-driven status for the streaming bubble (chunking,
        // synthesizing, etc.). Cleared when streaming ends or when token
        // content arrives. Shape: { kind, text } or null.
        streamingStatus: null,

        // Collapse state: object mapping messageId -> true. Lives in the store
        // (not local component state) so it survives React remounts/re-renders.
        // The streaming message uses the key '__streaming__'.
        collapsedMessageIds: {},

        // Attachments
        attachments: [],

        // Theme (persisted to localStorage)
        theme: loadFromStorage(STORAGE_KEYS.THEME, 'dark'),

        // System Prompts — server is source of truth. Previously persisted
        // to localStorage, which caused deleted prompts to linger on the UI
        // after a reload (store hydrated stale data before the network GET
        // populated the fresh list). Always start empty; the app's
        // loadSystemPrompts() on boot populates via /api/system-prompts.
        systemPrompts: [],

        // Folders — client-side only, { id, name, order, createdAt }[]
        folders: loadFromStorage(STORAGE_KEYS.FOLDERS, []),
        // Map of { [conversationId]: folderId } — conversations not in map are unassigned
        conversationFolderMap: loadFromStorage(STORAGE_KEYS.CONVERSATION_FOLDER_MAP, {}),

        // User Info
        user: null,

        // Settings
        // maxTokens: null means "use model's context window" (dynamic)
        // The order here matters: built-in defaults first, persisted values
        // last so a user toggle survives reloads. Previously
        // `codePreviewEnabled: false` sat AFTER the spread which silently
        // reset the user's choice on every page load.
        settings: {
            model: null,
            temperature: 0.7,
            topP: 1.0,
            maxTokens: null,  // null = use model's context window dynamically
            selectedSystemPromptId: null,
            fontSize: 'medium',
            fontFamily: 'system',
            // Live code previewer — default OFF so arbitrary code blocks
            // from the model never execute without the user opting in.
            // The persisted value in localStorage takes precedence (spread
            // below) so a user who turned it on stays opted in across
            // reloads.
            codePreviewEnabled: false,
            // Account memory — ON by default. When true, the server stops
            // injecting, extracting, and recording memories for this user.
            // Synced to the server (see serverPreferencesSync) so the backend
            // can honor it; managed in the webapp Memory tab.
            memoryDisabled: false,
            ...loadFromStorage(STORAGE_KEYS.SETTINGS, {}),
        },

        // ==================== Theme Actions ====================

        setTheme: (theme) => {
            saveToStorage(STORAGE_KEYS.THEME, theme);
            set({ theme });
        },

        // ==================== User Actions ====================

        setUser: (user) => set({ user }),

        clearUser: () => set({ user: null }),

        // ==================== System Prompt Actions ====================

        setSystemPrompts: (systemPrompts) => set({ systemPrompts }),

        addSystemPrompt: (prompt) => set(state => ({
            systemPrompts: [...state.systemPrompts, prompt],
        })),

        updateSystemPrompt: (id, updates) => set(state => ({
            systemPrompts: state.systemPrompts.map(p =>
                p.id === id ? { ...p, ...updates } : p
            ),
        })),

        deleteSystemPrompt: (id) => set(state => {
            const newPrompts = state.systemPrompts.filter(p => p.id !== id);
            // Clear selection if deleted prompt was selected
            const newSettings = state.settings.selectedSystemPromptId === id
                ? { ...state.settings, selectedSystemPromptId: null }
                : state.settings;
            if (state.settings.selectedSystemPromptId === id) {
                saveToStorage(STORAGE_KEYS.SETTINGS, newSettings);
            }
            return {
                systemPrompts: newPrompts,
                settings: newSettings
            };
        }),

        selectSystemPrompt: (id) => set(state => {
            const newSettings = { ...state.settings, selectedSystemPromptId: id };
            saveToStorage(STORAGE_KEYS.SETTINGS, newSettings);
            return { settings: newSettings };
        }),

        getSelectedSystemPrompt: () => {
            const state = get();
            if (!state.settings.selectedSystemPromptId) return null;
            return state.systemPrompts.find(p => p.id === state.settings.selectedSystemPromptId);
        },

        // ==================== Conversation Actions ====================

        setConversations: (conversations) => set({ conversations }),

        setActiveConversation: (conversationId) => {
            saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, conversationId);
            set(state => ({
                activeConversationId: conversationId,
                // Only keep messages if staying on same conversation; otherwise clear streaming
                // but DON'T clear messages[] - let loadConversationMessages() replace them
                // This prevents flash of empty state and race conditions during long streaming
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                isStreaming: false
            }));
        },

        // Switch the top-level view ('chat' | 'automation').
        setView: (view) => set({ view }),

        // Create a new conversation and set it as active
        createNewConversation: (conversation) => {
            saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, conversation.id);
            set(state => ({
                conversations: [conversation, ...state.conversations],
                activeConversationId: conversation.id,
                messages: [],
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                isStreaming: false,
                attachments: []
            }));
        },

        addConversation: (conversation) => set(state => ({
            conversations: [conversation, ...state.conversations]
        })),

        updateConversation: (id, updates) => set(state => ({
            conversations: state.conversations.map(c =>
                c.id === id ? { ...c, ...updates } : c
            )
        })),

        deleteConversation: (id) => {
            const current = get().activeConversationId;
            if (current === id) saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, null);
            set(state => {
                // Remove from folder map
                const newMap = { ...state.conversationFolderMap };
                if (newMap[id]) {
                    delete newMap[id];
                    saveToStorage(STORAGE_KEYS.CONVERSATION_FOLDER_MAP, newMap);
                }
                return {
                    conversations: state.conversations.filter(c => c.id !== id),
                    activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
                    messages: state.activeConversationId === id ? [] : state.messages,
                    conversationFolderMap: newMap,
                };
            });
        },

        // ==================== Folder Actions ====================

        createFolder: (name) => {
            const trimmed = (name || '').trim();
            if (!trimmed) return null;
            const folder = {
                id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: trimmed,
                order: get().folders.length,
                createdAt: new Date().toISOString(),
            };
            set(state => {
                const newFolders = [...state.folders, folder];
                saveToStorage(STORAGE_KEYS.FOLDERS, newFolders);
                return { folders: newFolders };
            });
            return folder;
        },

        renameFolder: (id, name) => {
            const trimmed = (name || '').trim();
            if (!trimmed) return;
            set(state => {
                const newFolders = state.folders.map(f =>
                    f.id === id ? { ...f, name: trimmed } : f
                );
                saveToStorage(STORAGE_KEYS.FOLDERS, newFolders);
                return { folders: newFolders };
            });
        },

        deleteFolder: (id) => {
            set(state => {
                const newFolders = state.folders.filter(f => f.id !== id);
                // Strip any assignments to this folder (conversations become unassigned)
                const newMap = { ...state.conversationFolderMap };
                let mapDirty = false;
                for (const [convId, folderId] of Object.entries(newMap)) {
                    if (folderId === id) {
                        delete newMap[convId];
                        mapDirty = true;
                    }
                }
                saveToStorage(STORAGE_KEYS.FOLDERS, newFolders);
                if (mapDirty) saveToStorage(STORAGE_KEYS.CONVERSATION_FOLDER_MAP, newMap);
                return { folders: newFolders, conversationFolderMap: newMap };
            });
        },

        setConversationFolder: (conversationId, folderId) => {
            set(state => {
                const newMap = { ...state.conversationFolderMap };
                if (folderId == null) {
                    delete newMap[conversationId];
                } else {
                    newMap[conversationId] = folderId;
                }
                saveToStorage(STORAGE_KEYS.CONVERSATION_FOLDER_MAP, newMap);
                return { conversationFolderMap: newMap };
            });
        },

        reorderFolders: (ids) => {
            set(state => {
                const byId = new Map(state.folders.map(f => [f.id, f]));
                const next = [];
                ids.forEach((id, idx) => {
                    const f = byId.get(id);
                    if (f) {
                        next.push({ ...f, order: idx });
                        byId.delete(id);
                    }
                });
                // Append any folders not in the supplied ids list (safety)
                byId.forEach(f => next.push({ ...f, order: next.length }));
                saveToStorage(STORAGE_KEYS.FOLDERS, next);
                return { folders: next };
            });
        },

        // Bulk replace — used by serverPreferencesSync to apply the
        // per-account folder state pulled from /api/me/preferences so
        // folders persist across browsers/devices, not just localStorage.
        setFolders: (folders) => set(() => {
            const next = Array.isArray(folders) ? folders : [];
            saveToStorage(STORAGE_KEYS.FOLDERS, next);
            return { folders: next };
        }),

        setConversationFolderMap: (map) => set(() => {
            const next = (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
            saveToStorage(STORAGE_KEYS.CONVERSATION_FOLDER_MAP, next);
            return { conversationFolderMap: next };
        }),

        // Start a fresh chat (clears active conversation without deleting it)
        startNewChat: () => {
            saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, null);
            set({
                activeConversationId: null,
                messages: [],
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                isStreaming: false,
                attachments: []
            });
        },

        // ==================== Message Actions ====================

        setMessages: (messages) => set({ messages }),

        addMessage: (message) => set(state => ({
            messages: [...state.messages, message]
        })),

        updateLastMessage: (content) => set(state => {
            const messages = [...state.messages];
            if (messages.length > 0) {
                messages[messages.length - 1] = {
                    ...messages[messages.length - 1],
                    content
                };
            }
            return { messages };
        }),

        updateMessage: (index, updates) => set(state => {
            const messages = [...state.messages];
            if (index >= 0 && index < messages.length) {
                messages[index] = { ...messages[index], ...updates };
            }
            return { messages };
        }),

        removeMessage: (index) => set(state => ({
            messages: state.messages.filter((_, i) => i !== index)
        })),

        // ==================== Streaming Actions ====================

        setStreaming: (isStreaming) => set({ isStreaming }),

        setStreamingContent: (streamingContent) => set({ streamingContent }),

        setStreamingReasoning: (streamingReasoning) => set({ streamingReasoning }),

        appendStreamingContent: (content) => set(state => ({
            streamingContent: state.streamingContent + content
        })),

        appendStreamingReasoning: (reasoning) => set(state => ({
            streamingReasoning: state.streamingReasoning + reasoning
        })),

        // Record a newly-started server-side tool call.
        startStreamingToolCall: (tc) => set(state => ({
            streamingToolCalls: [
                ...state.streamingToolCalls,
                {
                    tool_call_id: tc.tool_call_id,
                    name: tc.name,
                    arguments: tc.arguments || '',
                    status: 'running',
                    startedAt: Date.now(),
                    // Sandbox policy, piped through from the server so the
                    // chip UI can label this call. undefined is fine — the
                    // chip renders no badge in that case (e.g. for very
                    // old conversations restored from disk).
                    sandboxed: tc.sandboxed,
                    sandboxSource: tc.source,
                    sandboxNetwork: tc.network,
                    sandboxWorkspace: tc.workspace,
                },
            ],
        })),

        // Update an in-flight tool call with its result.
        finishStreamingToolCall: (tc) => set(state => {
            const next = state.streamingToolCalls.map(existing => {
                if (existing.tool_call_id !== tc.tool_call_id) return existing;
                return {
                    ...existing,
                    status: tc.error ? 'failed' : 'success',
                    preview: tc.preview,
                    // Full parsed tool result — lets the UI render search
                    // sources / URL snippets / anything structured without
                    // re-parsing the truncated preview.
                    result: tc.result,
                    error: tc.error,
                    durationMs: Date.now() - existing.startedAt,
                };
            });
            return { streamingToolCalls: next };
        }),

        clearStreamingToolCalls: () => set({ streamingToolCalls: [] }),

        setStreamingStatus: (streamingStatus) => set({ streamingStatus }),

        // Atomically append the final assistant message(s) AND clear the
        // streaming state in one set() call. Doing these separately (append
        // first, clear in a later finally block) left a one-frame window
        // where both the messages-list bubble and the StreamingMessage
        // bubble rendered simultaneously — the user saw the response "under"
        // the final bubble for a moment before the streaming one unmounted.
        // Accepts a single message object or an array (for the partial +
        // error two-bubble case on in-stream errors).
        commitStreamingMessage: (messageOrArray) => set(state => {
            const toAdd = Array.isArray(messageOrArray)
                ? messageOrArray.filter(Boolean)
                : messageOrArray ? [messageOrArray] : [];
            return {
                messages: toAdd.length ? [...state.messages, ...toAdd] : state.messages,
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                streamingToolCalls: [],
                isStreaming: false,
                collapsedMessageIds: (() => {
                    const next = { ...state.collapsedMessageIds };
                    delete next['__streaming__'];
                    return next;
                })(),
            };
        }),

        clearStreaming: () => set(state => ({
            streamingContent: '',
            streamingReasoning: '',
            streamingStatus: null,
            streamingToolCalls: [],
            isStreaming: false,
            // Clear the streaming message collapse entry when streaming ends
            collapsedMessageIds: (() => {
                const next = { ...state.collapsedMessageIds };
                delete next['__streaming__'];
                return next;
            })(),
        })),

        // ==================== Collapse Actions ====================

        toggleMessageCollapsed: (messageId) => set(state => {
            const next = { ...state.collapsedMessageIds };
            if (next[messageId]) {
                delete next[messageId];
            } else {
                next[messageId] = true;
            }
            return { collapsedMessageIds: next };
        }),

        setMessageCollapsed: (messageId, collapsed) => set(state => {
            const next = { ...state.collapsedMessageIds };
            if (collapsed) {
                next[messageId] = true;
            } else {
                delete next[messageId];
            }
            return { collapsedMessageIds: next };
        }),

        // ==================== Attachment Actions ====================

        setAttachments: (attachments) => set({ attachments }),

        addAttachment: (attachment) => set(state => ({
            attachments: [...state.attachments, attachment]
        })),

        removeAttachment: (index) => set(state => ({
            attachments: state.attachments.filter((_, i) => i !== index)
        })),

        clearAttachments: () => set({ attachments: [] }),

        // ==================== Settings Actions ====================

        updateSettings: (newSettings) => set(state => {
            const settings = { ...state.settings, ...newSettings };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setModel: (model) => set(state => {
            const settings = { ...state.settings, model };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setTemperature: (temperature) => set(state => {
            const settings = { ...state.settings, temperature };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setMaxTokens: (maxTokens) => set(state => {
            const settings = { ...state.settings, maxTokens };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setSystemPromptId: (selectedSystemPromptId) => set(state => {
            const settings = { ...state.settings, selectedSystemPromptId };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        // ==================== Utility Actions ====================

        resetChat: () => {
            saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, null);
            set({
                activeConversationId: null,
                messages: [],
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                isStreaming: false,
                attachments: []
            });
        },

        // Full reset including conversations
        resetAll: () => {
            saveToStorage(STORAGE_KEYS.ACTIVE_CONVERSATION, null);
            set({
                conversations: [],
                activeConversationId: null,
                messages: [],
                streamingContent: '',
                streamingReasoning: '',
                streamingStatus: null,
                isStreaming: false,
                attachments: []
            });
        },

        // Get current conversation
        getCurrentConversation: () => {
            const state = get();
            return state.conversations.find(c => c.id === state.activeConversationId);
        },

        // Check if there's an active conversation
        hasActiveConversation: () => {
            const state = get();
            return state.activeConversationId !== null;
        },

        // Get conversation by ID
        getConversationById: (id) => {
            const state = get();
            return state.conversations.find(c => c.id === id);
        }
    }), { name: 'chat-store' })
);
