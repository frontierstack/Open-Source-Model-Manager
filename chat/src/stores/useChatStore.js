import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

// Storage key constants
const STORAGE_KEYS = {
    THEME: 'chat-theme',
    SYSTEM_PROMPTS: 'chat-system-prompts',
    SETTINGS: 'chat-settings'
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
        activeConversationId: null,
        messages: [],

        // Streaming
        isStreaming: false,
        streamingContent: '',
        streamingReasoning: '',

        // Processing status for UI indicators
        processingStatus: null, // null, 'thinking', 'searching', 'parsing', 'processing', 'generating'
        processingMessage: null,

        // Rolling credits-style processing log: an ordered array of
        // { id, icon, text, status: 'active' | 'done' | 'failed', at }
        // pushed by ChatContainer as real events happen during a turn
        // (web search started, N results found, URLs fetched, waiting for
        // model, synthesizing chunks, etc). The streaming assistant bubble
        // renders this so users see what's happening instead of a mute
        // spinner.
        processingLog: [],

        // Attachments
        attachments: [],

        // Theme (persisted to localStorage)
        theme: loadFromStorage(STORAGE_KEYS.THEME, 'dark'),

        // System Prompts (persisted to localStorage)
        systemPrompts: loadFromStorage(STORAGE_KEYS.SYSTEM_PROMPTS, []),

        // User Info
        user: null,

        // Settings
        // maxTokens: null means "use model's context window" (dynamic)
        settings: {
            model: null,
            temperature: 0.7,
            topP: 1.0,
            maxTokens: null,  // null = use model's context window dynamically
            selectedSystemPromptId: null,
            fontSize: 'medium',
            fontFamily: 'system',
            ...loadFromStorage(STORAGE_KEYS.SETTINGS, {}),
            // Always start with web search and URL fetch off
            webSearchEnabled: false,
            urlFetchEnabled: false
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

        setSystemPrompts: (systemPrompts) => {
            saveToStorage(STORAGE_KEYS.SYSTEM_PROMPTS, systemPrompts);
            set({ systemPrompts });
        },

        addSystemPrompt: (prompt) => set(state => {
            const newPrompts = [...state.systemPrompts, prompt];
            saveToStorage(STORAGE_KEYS.SYSTEM_PROMPTS, newPrompts);
            return { systemPrompts: newPrompts };
        }),

        updateSystemPrompt: (id, updates) => set(state => {
            const newPrompts = state.systemPrompts.map(p =>
                p.id === id ? { ...p, ...updates } : p
            );
            saveToStorage(STORAGE_KEYS.SYSTEM_PROMPTS, newPrompts);
            return { systemPrompts: newPrompts };
        }),

        deleteSystemPrompt: (id) => set(state => {
            const newPrompts = state.systemPrompts.filter(p => p.id !== id);
            saveToStorage(STORAGE_KEYS.SYSTEM_PROMPTS, newPrompts);
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

        setActiveConversation: (conversationId) => set(state => ({
            activeConversationId: conversationId,
            // Only keep messages if staying on same conversation; otherwise clear streaming
            // but DON'T clear messages[] - let loadConversationMessages() replace them
            // This prevents flash of empty state and race conditions during long streaming
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false
        })),

        // Create a new conversation and set it as active
        createNewConversation: (conversation) => set(state => ({
            conversations: [conversation, ...state.conversations],
            activeConversationId: conversation.id,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            attachments: []
        })),

        addConversation: (conversation) => set(state => ({
            conversations: [conversation, ...state.conversations]
        })),

        updateConversation: (id, updates) => set(state => ({
            conversations: state.conversations.map(c =>
                c.id === id ? { ...c, ...updates } : c
            )
        })),

        deleteConversation: (id) => set(state => ({
            conversations: state.conversations.filter(c => c.id !== id),
            activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
            messages: state.activeConversationId === id ? [] : state.messages
        })),

        // Start a fresh chat (clears active conversation without deleting it)
        startNewChat: () => set({
            activeConversationId: null,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            attachments: []
        }),

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

        clearStreaming: () => set({
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            processingStatus: null,
            processingMessage: null,
            processingLog: [],
        }),

        // ==================== Processing Status Actions ====================

        setProcessingStatus: (status, message = null) => set({
            processingStatus: status,
            processingMessage: message,
        }),

        clearProcessingStatus: () => set({
            processingStatus: null,
            processingMessage: null,
        }),

        // ==================== Processing Log Actions ====================

        // Push a new rolling-credits entry. If the most recent entry has the
        // same `key`, mark IT as done and append the new one — avoids
        // duplicate "searching..." rows when a step is re-entered, and keeps
        // the previous entries on-screen as a trail.
        pushProcessingLog: (entry) => set(state => {
            const next = state.processingLog.slice();
            // Mark any still-active entries as done when a new one arrives,
            // so only the newest is "running" at any given time.
            for (let i = 0; i < next.length; i++) {
                if (next[i].status === 'active') {
                    next[i] = { ...next[i], status: 'done' };
                }
            }
            next.push({
                id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                at: Date.now(),
                status: 'active',
                ...entry,
            });
            // Cap length so this doesn't grow forever on very long turns
            return { processingLog: next.slice(-20) };
        }),

        // Mark the most recent active entry as done/failed without adding a
        // new row — useful when you just want to close the last step.
        resolveProcessingLog: (status = 'done') => set(state => {
            const next = state.processingLog.slice();
            for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].status === 'active') {
                    next[i] = { ...next[i], status };
                    break;
                }
            }
            return { processingLog: next };
        }),

        clearProcessingLog: () => set({ processingLog: [] }),

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

        toggleWebSearch: () => set(state => {
            const settings = {
                ...state.settings,
                webSearchEnabled: !state.settings.webSearchEnabled
            };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setWebSearchEnabled: (enabled) => set(state => {
            const settings = { ...state.settings, webSearchEnabled: enabled };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        toggleUrlFetch: () => set(state => {
            const settings = {
                ...state.settings,
                urlFetchEnabled: !state.settings.urlFetchEnabled
            };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setUrlFetchEnabled: (enabled) => set(state => {
            const settings = { ...state.settings, urlFetchEnabled: enabled };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        setSystemPromptId: (selectedSystemPromptId) => set(state => {
            const settings = { ...state.settings, selectedSystemPromptId };
            saveToStorage(STORAGE_KEYS.SETTINGS, settings);
            return { settings };
        }),

        // ==================== Utility Actions ====================

        resetChat: () => set({
            activeConversationId: null,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            attachments: []
        }),

        // Full reset including conversations
        resetAll: () => set({
            conversations: [],
            activeConversationId: null,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false,
            attachments: []
        }),

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
