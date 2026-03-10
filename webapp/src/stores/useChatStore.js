import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Chat Store
 * Manages conversations, messages, and chat settings
 */
export const useChatStore = create(
    devtools((set, get) => ({
        // State
        conversations: [],
        activeConversationId: null,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        streamingReasoning: '',
        attachments: [],

        // Settings
        settings: {
            model: null,
            temperature: 0.7,
            maxTokens: 2048,
            webSearchEnabled: false,
            systemPromptId: null,
        },

        // Conversation Actions
        setConversations: (conversations) => set({ conversations }),

        setActiveConversation: (conversationId) => set({
            activeConversationId: conversationId,
            messages: [],
            streamingContent: '',
            streamingReasoning: '',
            isStreaming: false
        }),

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

        // Message Actions
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

        // Streaming Actions
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

        // Attachment Actions
        setAttachments: (attachments) => set({ attachments }),

        addAttachment: (attachment) => set(state => ({
            attachments: [...state.attachments, attachment]
        })),

        removeAttachment: (index) => set(state => ({
            attachments: state.attachments.filter((_, i) => i !== index)
        })),

        clearAttachments: () => set({ attachments: [] }),

        // Settings Actions
        updateSettings: (newSettings) => set(state => ({
            settings: { ...state.settings, ...newSettings }
        })),

        setModel: (model) => set(state => ({
            settings: { ...state.settings, model }
        })),

        setTemperature: (temperature) => set(state => ({
            settings: { ...state.settings, temperature }
        })),

        setMaxTokens: (maxTokens) => set(state => ({
            settings: { ...state.settings, maxTokens }
        })),

        toggleWebSearch: () => set(state => ({
            settings: {
                ...state.settings,
                webSearchEnabled: !state.settings.webSearchEnabled
            }
        })),

        setSystemPromptId: (systemPromptId) => set(state => ({
            settings: { ...state.settings, systemPromptId }
        })),

        // Utility Actions
        resetChat: () => set({
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
        }
    }), { name: 'chat-store' })
);
