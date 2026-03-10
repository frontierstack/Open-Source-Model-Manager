import React, { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import { useChatStore } from '../../stores/useChatStore';
import ChatHeader from './ChatHeader';
import ChatSidebar from './ChatSidebar';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ChatSettings from './ChatSettings';
import WebSearchIndicator from './WebSearchIndicator';

/**
 * ChatContainer - Main chat interface container
 */
export default function ChatContainer({
    models,
    systemPrompts: initialSystemPrompts = [],
    onSystemPromptsChange,
    showSnackbar,
}) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [systemPrompts, setSystemPrompts] = useState(initialSystemPrompts);
    const [webSearchState, setWebSearchState] = useState({
        searching: false,
        sites: [],
        query: ''
    });
    const abortControllerRef = useRef(null);

    // Chat store
    const {
        conversations,
        activeConversationId,
        messages,
        isStreaming,
        streamingContent,
        streamingReasoning,
        attachments,
        settings,
        setConversations,
        setActiveConversation,
        addConversation,
        updateConversation,
        deleteConversation,
        setMessages,
        addMessage,
        setStreaming,
        setStreamingContent,
        setStreamingReasoning,
        appendStreamingContent,
        appendStreamingReasoning,
        clearStreaming,
        addAttachment,
        removeAttachment,
        clearAttachments,
        updateSettings,
    } = useChatStore();

    // Load conversations and system prompts on mount
    useEffect(() => {
        loadConversations();
        loadSystemPrompts();
    }, []);

    // Sync system prompts from props
    useEffect(() => {
        if (initialSystemPrompts.length > 0) {
            setSystemPrompts(initialSystemPrompts);
        }
    }, [initialSystemPrompts]);

    // Load conversation messages when active changes
    useEffect(() => {
        if (activeConversationId) {
            loadConversationMessages(activeConversationId);
        }
    }, [activeConversationId]);

    const loadConversations = async () => {
        try {
            const response = await fetch('/api/conversations', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setConversations(data);
            }
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    };

    const loadSystemPrompts = async () => {
        try {
            const response = await fetch('/api/system-prompts', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                // Convert object to array format with id and name
                const promptsArray = Object.entries(data).map(([name, content]) => ({
                    id: name,
                    name: name,
                    content: typeof content === 'string' ? content : content.content || ''
                }));
                setSystemPrompts(promptsArray);
            }
        } catch (error) {
            console.error('Failed to load system prompts:', error);
        }
    };

    const handleSaveSystemPrompt = async (prompt) => {
        try {
            const response = await fetch(`/api/system-prompts/${encodeURIComponent(prompt.name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ systemPrompt: prompt.content }),
            });

            if (response.ok) {
                showSnackbar('System prompt saved', 'success');
                await loadSystemPrompts();
            } else {
                showSnackbar('Failed to save system prompt', 'error');
            }
        } catch (error) {
            console.error('Failed to save system prompt:', error);
            showSnackbar('Failed to save system prompt', 'error');
        }
    };

    const handleDeleteSystemPrompt = async (promptId) => {
        try {
            const response = await fetch(`/api/system-prompts/${encodeURIComponent(promptId)}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (response.ok) {
                showSnackbar('System prompt deleted', 'success');
                await loadSystemPrompts();
                // Clear selection if deleted prompt was active
                if (settings.systemPromptId === promptId) {
                    updateSettings({ systemPromptId: null });
                }
            } else {
                showSnackbar('Failed to delete system prompt', 'error');
            }
        } catch (error) {
            console.error('Failed to delete system prompt:', error);
            showSnackbar('Failed to delete system prompt', 'error');
        }
    };

    const loadConversationMessages = async (conversationId) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setMessages(data.messages || []);
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    };

    const saveMessages = async (conversationId, msgs) => {
        try {
            await fetch(`/api/conversations/${conversationId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ messages: msgs }),
            });
        } catch (error) {
            console.error('Failed to save messages:', error);
        }
    };

    const handleNewConversation = async () => {
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ title: 'New Conversation' }),
            });

            if (response.ok) {
                const conversation = await response.json();
                addConversation(conversation);
                setActiveConversation(conversation.id);
                setMessages([]);
                clearAttachments();
            }
        } catch (error) {
            console.error('Failed to create conversation:', error);
            showSnackbar('Failed to create conversation', 'error');
        }
    };

    const handleSelectConversation = (conversationId) => {
        if (conversationId !== activeConversationId) {
            clearStreaming();
            clearAttachments();
            setActiveConversation(conversationId);
        }
    };

    const handleDeleteConversation = async (conversationId) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (response.ok) {
                deleteConversation(conversationId);
                if (conversationId === activeConversationId) {
                    setMessages([]);
                }
            }
        } catch (error) {
            console.error('Failed to delete conversation:', error);
            showSnackbar('Failed to delete conversation', 'error');
        }
    };

    const handleRenameConversation = async (conversationId, newTitle) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ title: newTitle }),
            });

            if (response.ok) {
                updateConversation(conversationId, { title: newTitle });
            }
        } catch (error) {
            console.error('Failed to rename conversation:', error);
        }
    };

    const handleToggleFavorite = async (conversationId) => {
        // Find current conversation to toggle its favorite status
        const conversation = conversations.find(c => c.id === conversationId);
        if (!conversation) return;

        const newFavoriteStatus = !conversation.favorite;

        try {
            const response = await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ favorite: newFavoriteStatus }),
            });

            if (response.ok) {
                updateConversation(conversationId, { favorite: newFavoriteStatus });
            }
        } catch (error) {
            console.error('Failed to toggle favorite:', error);
        }
    };

    const handleSendMessage = async (content, attachedFiles) => {
        if (!settings.model) {
            showSnackbar('Please select a model first', 'warning');
            return;
        }

        // Create conversation if none exists
        let conversationId = activeConversationId;
        if (!conversationId) {
            try {
                const response = await fetch('/api/conversations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ title: content.slice(0, 50) + (content.length > 50 ? '...' : '') }),
                });

                if (response.ok) {
                    const conversation = await response.json();
                    addConversation(conversation);
                    setActiveConversation(conversation.id);
                    conversationId = conversation.id;
                }
            } catch (error) {
                showSnackbar('Failed to create conversation', 'error');
                return;
            }
        }

        // Build message with attachments
        let fullContent = content;
        if (attachedFiles && attachedFiles.length > 0) {
            const attachmentContext = attachedFiles
                .filter(att => att.type !== 'image')
                .map(att => `--- ${att.filename} ---\n${att.content}\n`)
                .join('\n');

            if (attachmentContext) {
                fullContent = `${attachmentContext}\n---\n\n${content}`;
            }
        }

        // Add user message
        const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content,
            attachments: attachedFiles?.map(a => ({ filename: a.filename, type: a.type })),
            timestamp: new Date().toISOString(),
        };

        const updatedMessages = [...messages, userMessage];
        addMessage(userMessage);
        clearAttachments();

        // Start streaming
        setStreaming(true);
        setStreamingContent('');
        setStreamingReasoning('');

        // Prepare messages for API
        const apiMessages = updatedMessages.map(m => ({
            role: m.role,
            content: m.content,
        }));

        // Add system prompt if selected
        const selectedSystemPrompt = systemPrompts.find(p => p.id === settings.systemPromptId);
        if (selectedSystemPrompt) {
            apiMessages.unshift({
                role: 'system',
                content: selectedSystemPrompt.content,
            });
        }

        // Handle web search with live display
        let searchContext = '';
        if (settings.webSearchEnabled) {
            setWebSearchState({ searching: true, sites: [], query: content });
            try {
                const searchResponse = await fetch(`/api/search?q=${encodeURIComponent(content)}&limit=5&fetchContent=true&contentLimit=3`, {
                    credentials: 'include',
                });
                if (searchResponse.ok) {
                    const searchData = await searchResponse.json();
                    if (searchData.results && searchData.results.length > 0) {
                        // Update sites for live display
                        setWebSearchState({
                            searching: false,
                            sites: searchData.results.map(r => ({ title: r.title, url: r.url })),
                            query: searchData.enhancedQuery || content
                        });

                        searchContext = searchData.results
                            .map(r => `[${r.title}](${r.url}): ${r.snippet}${r.content ? '\n' + r.content.slice(0, 500) : ''}`)
                            .join('\n\n');
                        // Add search context to the last user message
                        apiMessages[apiMessages.length - 1].content =
                            `Web search results:\n${searchContext}\n\n---\n\nUser question: ${content}`;
                    }
                }
            } catch (error) {
                console.error('Web search failed:', error);
            }
            // Clear search state after a delay
            setTimeout(() => setWebSearchState({ searching: false, sites: [], query: '' }), 3000);
        }

        // Create abort controller for cancellation
        abortControllerRef.current = new AbortController();

        try {
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    model: settings.model,
                    messages: apiMessages,
                    temperature: settings.temperature,
                    max_tokens: settings.maxTokens,
                    stream: true,
                }),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) {
                throw new Error('Failed to send message');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantContent = '';
            let assistantReasoning = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                assistantContent += delta.content;
                                setStreamingContent(assistantContent);
                            }

                            if (delta?.reasoning) {
                                assistantReasoning += delta.reasoning;
                                setStreamingReasoning(assistantReasoning);
                            }
                        } catch (e) {
                            // Ignore parse errors for partial chunks
                        }
                    }
                }
            }

            // Add assistant message
            const assistantMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: assistantContent,
                reasoning: assistantReasoning || undefined,
                timestamp: new Date().toISOString(),
            };

            const finalMessages = [...updatedMessages, assistantMessage];
            addMessage(assistantMessage);
            saveMessages(conversationId, finalMessages);

            // Update conversation title if it's the first message
            if (updatedMessages.length === 1) {
                handleRenameConversation(
                    conversationId,
                    content.slice(0, 50) + (content.length > 50 ? '...' : '')
                );
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                showSnackbar('Generation stopped', 'info');
            } else {
                console.error('Streaming error:', error);
                showSnackbar('Failed to get response', 'error');
            }
        } finally {
            clearStreaming();
            abortControllerRef.current = null;
        }
    };

    const handleStopGeneration = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };

    const handleModelChange = (modelName) => {
        updateSettings({ model: modelName });
    };

    const handleExportContent = (content, format, filename) => {
        // Handle file exports from AI responses
        let blob;
        let downloadFilename = filename || `export.${format}`;

        switch (format) {
            case 'csv':
                blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
                break;
            case 'json':
                blob = new Blob([content], { type: 'application/json;charset=utf-8;' });
                break;
            case 'txt':
                blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
                break;
            case 'md':
                blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
                break;
            default:
                blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = downloadFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showSnackbar(`Downloaded ${downloadFilename}`, 'success');
    };

    // Auto-select first running model if none selected
    useEffect(() => {
        const runningModels = models.filter(m => m.status === 'running');
        if (!settings.model && runningModels.length > 0) {
            updateSettings({ model: runningModels[0].name });
        }
    }, [models, settings.model]);

    return (
        <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
            {/* Sidebar */}
            <ChatSidebar
                conversations={conversations}
                activeConversationId={activeConversationId}
                onSelectConversation={handleSelectConversation}
                onNewConversation={handleNewConversation}
                onDeleteConversation={handleDeleteConversation}
                onRenameConversation={handleRenameConversation}
                onToggleFavorite={handleToggleFavorite}
            />

            {/* Main chat area */}
            <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Header */}
                <ChatHeader
                    models={models}
                    selectedModel={settings.model}
                    onModelChange={handleModelChange}
                    onSettingsClick={() => setSettingsOpen(true)}
                    onNewChat={handleNewConversation}
                    isLoading={isLoading}
                />

                {/* Messages */}
                <ChatMessages
                    messages={messages}
                    isStreaming={isStreaming}
                    streamingContent={streamingContent}
                    streamingReasoning={streamingReasoning}
                    onExportContent={handleExportContent}
                />

                {/* Web Search Indicator */}
                {(webSearchState.searching || webSearchState.sites.length > 0) && (
                    <WebSearchIndicator
                        searching={webSearchState.searching}
                        sites={webSearchState.sites}
                        query={webSearchState.query}
                    />
                )}

                {/* Input with web search toggle */}
                <ChatInput
                    onSend={handleSendMessage}
                    onStop={handleStopGeneration}
                    isStreaming={isStreaming}
                    disabled={!settings.model}
                    attachments={attachments}
                    onAddAttachment={addAttachment}
                    onRemoveAttachment={removeAttachment}
                    webSearchEnabled={settings.webSearchEnabled}
                    onWebSearchToggle={() => updateSettings({ webSearchEnabled: !settings.webSearchEnabled })}
                />
            </Box>

            {/* Settings drawer */}
            <ChatSettings
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                settings={settings}
                onUpdateSettings={updateSettings}
                systemPrompts={systemPrompts}
                onSaveSystemPrompt={handleSaveSystemPrompt}
                onDeleteSystemPrompt={handleDeleteSystemPrompt}
            />
        </Box>
    );
}
