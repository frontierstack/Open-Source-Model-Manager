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

        // Attachments
        attachments: [],

        // Theme (persisted to localStorage)
        theme: loadFromStorage(STORAGE_KEYS.THEME, 'midnight'),

        // System Prompts (persisted to localStorage)
        systemPrompts: loadFromStorage(STORAGE_KEYS.SYSTEM_PROMPTS, []),

        // User Info
        user: null,

        // Settings
        settings: {
            model: null,
            temperature: 0.7,
            maxTokens: 2048,
            webSearchEnabled: false,
            selectedSystemPromptId: null,
            ...loadFromStorage(STORAGE_KEYS.SETTINGS, {})
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

        setActiveConversation: (conversationId) => set({
            activeConversationId: conversationId,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false
        }),

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
            isStreaming: false
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
