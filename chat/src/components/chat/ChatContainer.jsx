import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useChatStore } from '../../stores/useChatStore';
import ChatHeader from './ChatHeader';
import ChatSidebar from './ChatSidebar';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ChatSettings from './ChatSettings';

/**
 * Parse <think> tags from content and separate thinking from response
 * Handles both complete and partial (streaming) content
 */
function parseThinkTags(content) {
    if (!content) return { content: '', reasoning: '' };

    // Check for <think> tags (case insensitive)
    const thinkOpenRegex = /<think>/gi;
    const thinkCloseRegex = /<\/think>/gi;

    let reasoning = '';
    let cleanContent = content;

    // Find all complete <think>...</think> blocks
    const completeThinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match;
    while ((match = completeThinkRegex.exec(content)) !== null) {
        reasoning += match[1];
        cleanContent = cleanContent.replace(match[0], '');
    }

    // Handle unclosed <think> tag (content is still streaming)
    const lastOpenIdx = cleanContent.lastIndexOf('<think>');
    const lastCloseIdx = cleanContent.lastIndexOf('</think>');

    if (lastOpenIdx > lastCloseIdx) {
        // There's an unclosed <think> tag - everything after it is reasoning
        const partialReasoning = cleanContent.substring(lastOpenIdx + 7);
        reasoning += partialReasoning;
        cleanContent = cleanContent.substring(0, lastOpenIdx);
    }

    // Clean up extra whitespace
    cleanContent = cleanContent.replace(/^\s+/, '').replace(/\s+$/, '');

    return { content: cleanContent, reasoning };
}

/**
 * Extract URLs from text (max 3 URLs)
 */
function extractUrls(text, maxUrls = 3) {
    // Match http:// and https:// URLs, stopping at whitespace or common delimiters
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
    const matches = text.match(urlRegex) || [];
    // Remove duplicates and limit to maxUrls
    return [...new Set(matches)].slice(0, maxUrls);
}

/**
 * ChatContainer - Main chat interface container with Tailwind styling
 */
export default function ChatContainer({
    models,
    systemPrompts: initialSystemPrompts,
    showSnackbar,
    user,
    onLogout,
}) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [runningInstances, setRunningInstances] = useState([]);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const abortControllerRef = useRef(null);
    const streamingConversationRef = useRef(null); // Track which conversation is being streamed to

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
        processingStatus,
        processingMessage,
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
        setProcessingStatus,
        clearProcessingStatus,
        addAttachment,
        removeAttachment,
        clearAttachments,
        updateSettings,
        theme,
        setTheme,
        systemPrompts: storeSystemPrompts,
        setSystemPrompts,
    } = useChatStore();

    // Use system prompts from store, falling back to initial props
    const systemPrompts = storeSystemPrompts?.length > 0 ? storeSystemPrompts : initialSystemPrompts;

    // Load conversations on mount
    useEffect(() => {
        loadConversations();
    }, []);

    // Fetch running instances from both backends
    useEffect(() => {
        const fetchRunningInstances = async () => {
            try {
                const [llamacppRes, vllmRes] = await Promise.allSettled([
                    fetch('/api/llamacpp/instances', { credentials: 'include' }),
                    fetch('/api/vllm/instances', { credentials: 'include' }),
                ]);

                const instances = [];

                // Parse llama.cpp instances
                if (llamacppRes.status === 'fulfilled' && llamacppRes.value.ok) {
                    const llamacppData = await llamacppRes.value.json();
                    const llamacppInstances = Array.isArray(llamacppData) ? llamacppData : (llamacppData.instances || []);
                    llamacppInstances.forEach(inst => {
                        instances.push({
                            name: inst.name || inst.model,
                            status: inst.status || 'running',  // Use actual backend status
                            backend: 'llamacpp',
                            port: inst.port,
                            // Include context size from config for accurate context tracking
                            contextSize: inst.config?.contextSize || inst.contextSize,
                        });
                    });
                }

                // Parse vLLM instances
                if (vllmRes.status === 'fulfilled' && vllmRes.value.ok) {
                    const vllmData = await vllmRes.value.json();
                    const vllmInstances = Array.isArray(vllmData) ? vllmData : (vllmData.instances || []);
                    vllmInstances.forEach(inst => {
                        instances.push({
                            name: inst.name || inst.model,
                            status: inst.status || 'running',  // Use actual backend status
                            backend: 'vllm',
                            port: inst.port,
                            // Include context size from config for accurate context tracking
                            contextSize: inst.config?.contextSize || inst.contextSize,
                        });
                    });
                }

                setRunningInstances(instances);
            } catch (error) {
                console.error('Failed to fetch running instances:', error);
            }
        };

        fetchRunningInstances();
        // Poll for running instances every 10 seconds
        const interval = setInterval(fetchRunningInstances, 10000);
        return () => clearInterval(interval);
    }, []);

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

    const loadConversationMessages = async (conversationId) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setMessages(data.messages || []);

                // Check if there's active streaming for this conversation
                checkActiveStreaming(conversationId);
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    };

    // Check for active background streaming on a conversation
    const checkActiveStreaming = async (conversationId) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}/streaming`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                if (data.streaming) {
                    // There's active streaming - show the content and start polling
                    setStreaming(true);
                    setStreamingContent(data.content || '');
                    setStreamingReasoning(data.reasoning || '');
                    setIsLoading(true);
                    setProcessingStatus('thinking', 'Generating in background...');

                    // Start polling for updates
                    const pollInterval = setInterval(async () => {
                        try {
                            const pollResponse = await fetch(`/api/conversations/${conversationId}/streaming`, { credentials: 'include' });
                            if (pollResponse.ok) {
                                const pollData = await pollResponse.json();
                                if (pollData.streaming) {
                                    // Still streaming - update content
                                    setStreamingContent(pollData.content || '');
                                    setStreamingReasoning(pollData.reasoning || '');
                                } else {
                                    // Streaming finished - reload messages and clear streaming state
                                    clearInterval(pollInterval);
                                    clearStreaming();
                                    setIsLoading(false);
                                    clearProcessingStatus();
                                    // Reload messages to get the completed response
                                    const msgResponse = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' });
                                    if (msgResponse.ok) {
                                        const msgData = await msgResponse.json();
                                        setMessages(msgData.messages || []);
                                    }
                                    showSnackbar('Background response completed', 'success');
                                }
                            }
                        } catch (pollError) {
                            console.error('Failed to poll streaming status:', pollError);
                            clearInterval(pollInterval);
                            clearStreaming();
                            setIsLoading(false);
                        }
                    }, 500); // Poll every 500ms

                    // Store the interval ID so we can clear it if user navigates away
                    streamingConversationRef.current = conversationId;

                    // Clear interval after 5 minutes max (safety limit)
                    setTimeout(() => {
                        clearInterval(pollInterval);
                    }, 5 * 60 * 1000);
                }
            }
        } catch (error) {
            console.error('Failed to check streaming status:', error);
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

    // Load system prompts from API and update store
    const refreshSystemPrompts = async () => {
        try {
            const response = await fetch('/api/system-prompts', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                let promptsArray = [];
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    promptsArray = Object.entries(data).map(([name, content]) => ({
                        id: name,
                        name: name,
                        content: content || '',
                    }));
                } else if (Array.isArray(data)) {
                    promptsArray = data;
                }
                setSystemPrompts(promptsArray);
            }
        } catch (error) {
            console.error('Failed to refresh system prompts:', error);
        }
    };

    // Save system prompt via API
    const handleSaveSystemPrompt = async (promptData) => {
        try {
            const response = await fetch(`/api/system-prompts/${encodeURIComponent(promptData.name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ systemPrompt: promptData.content }),
            });

            if (response.ok) {
                await refreshSystemPrompts();
                showSnackbar('System prompt saved', 'success');
            } else {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to save system prompt');
            }
        } catch (error) {
            console.error('Failed to save system prompt:', error);
            showSnackbar(error.message || 'Failed to save system prompt', 'error');
        }
    };

    // Delete system prompt via API
    const handleDeleteSystemPrompt = async (promptId) => {
        try {
            const response = await fetch(`/api/system-prompts/${encodeURIComponent(promptId)}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (response.ok) {
                await refreshSystemPrompts();
                showSnackbar('System prompt deleted', 'success');
            } else {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to delete system prompt');
            }
        } catch (error) {
            console.error('Failed to delete system prompt:', error);
            showSnackbar(error.message || 'Failed to delete system prompt', 'error');
        }
    };

    const handleNewConversation = async () => {
        // Don't abort ongoing generation - let it complete in background
        // Only clear streaming UI if we're switching away from the streaming conversation
        if (streamingConversationRef.current && streamingConversationRef.current !== activeConversationId) {
            // Stream is for a different conversation, UI is already clear
        } else if (streamingConversationRef.current) {
            // Stream is for current conversation, clear UI but don't abort
            clearStreaming();
        }

        // Clear attachments and messages for the new conversation
        clearAttachments();
        setMessages([]);
        setActiveConversation(null);

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
            } else {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || 'Failed to create conversation');
            }
        } catch (error) {
            console.error('Failed to create conversation:', error);
            showSnackbar(error.message || 'Failed to create conversation', 'error');
        }
    };

    const handleSelectConversation = (conversationId) => {
        if (conversationId !== activeConversationId) {
            // Don't abort ongoing generation - let it complete in background
            // Clear streaming UI since we're switching to a different conversation
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
                    setActiveConversation(null);
                }
            } else {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || 'Failed to delete conversation');
            }
        } catch (error) {
            console.error('Failed to delete conversation:', error);
            showSnackbar(error.message || 'Failed to delete conversation', 'error');
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
        const conversation = conversations.find(c => c.id === conversationId);
        if (!conversation) return;

        const newFavorite = !conversation.favorite;

        try {
            const response = await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ favorite: newFavorite }),
            });

            if (response.ok) {
                updateConversation(conversationId, { favorite: newFavorite });
            }
        } catch (error) {
            console.error('Failed to toggle favorite:', error);
        }
    };

    /**
     * Parse error response and return user-friendly message
     */
    const parseErrorMessage = (error, response = null) => {
        // Handle abort errors
        if (error?.name === 'AbortError') {
            return { type: 'abort', message: 'Generation stopped' };
        }

        // Handle network errors
        if (error?.message === 'Failed to fetch' || error?.name === 'TypeError') {
            return {
                type: 'connection',
                message: 'Connection error: Unable to reach the server. Please check your connection.',
            };
        }

        // Handle HTTP errors
        if (response && !response.ok) {
            const status = response.status;

            switch (status) {
                case 401:
                    return { type: 'auth', message: 'Authentication error: Please log in again.' };
                case 403:
                    return { type: 'permission', message: 'Permission denied: You do not have access to this resource.' };
                case 404:
                    return { type: 'model', message: 'Model not found: The selected model may have been stopped.' };
                case 429:
                    return { type: 'rateLimit', message: 'Rate limit exceeded: Please wait before sending more requests.' };
                case 500:
                    return { type: 'server', message: 'Server error: An internal error occurred. Please try again.' };
                case 502:
                case 503:
                case 504:
                    return { type: 'model', message: 'Model unavailable: The model service is not responding. It may be loading or crashed.' };
                default:
                    return { type: 'unknown', message: `Request failed with status ${status}` };
            }
        }

        // Handle model-specific errors
        if (error?.message) {
            const msg = error.message.toLowerCase();

            if (msg.includes('model') && (msg.includes('not found') || msg.includes('not loaded'))) {
                return { type: 'model', message: 'Model error: The model is not available. Please start it from the management console.' };
            }

            if (msg.includes('context') || msg.includes('token') || msg.includes('length')) {
                return { type: 'context', message: 'Context length exceeded: The conversation is too long. Try starting a new chat.' };
            }

            if (msg.includes('memory') || msg.includes('oom') || msg.includes('cuda')) {
                return { type: 'memory', message: 'Memory error: The model ran out of memory. Try reducing context or using a smaller model.' };
            }

            if (msg.includes('timeout')) {
                return { type: 'timeout', message: 'Request timeout: The model took too long to respond. Please try again.' };
            }
        }

        // Default error
        return {
            type: 'unknown',
            message: error?.message || 'An unexpected error occurred. Please try again.',
        };
    };

    const handleSendMessage = async (content, attachedFiles) => {
        if (!settings.model) {
            showSnackbar('Please select a model first', 'warning');
            return;
        }

        // Check if selected model is still running
        const modelRunning = runningInstances.some(m => m.name === settings.model);
        if (!modelRunning && runningInstances.length > 0) {
            showSnackbar('Selected model is no longer running. Please select another model.', 'warning');
            return;
        }

        // Create conversation if none exists
        let conversationId = activeConversationId;
        let isNewConversation = false;
        if (!conversationId) {
            try {
                const response = await fetch('/api/conversations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ title: content.slice(0, 50) + (content.length > 50 ? '...' : '') }),
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.message || 'Failed to create conversation');
                }

                const conversation = await response.json();
                addConversation(conversation);
                setActiveConversation(conversation.id);
                conversationId = conversation.id;
                isNewConversation = true;
            } catch (error) {
                const { message } = parseErrorMessage(error);
                showSnackbar(message, 'error');
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

        // Handle URL fetching if enabled
        let urlFetchResults = null;
        let urlContextSummary = null;
        if (settings.urlFetchEnabled) {
            const urls = extractUrls(content);
            if (urls.length > 0) {
                try {
                    setIsLoading(true);
                    setProcessingStatus('parsing', `Fetching ${urls.length} URL${urls.length > 1 ? 's' : ''}`);

                    const fetchResponse = await fetch('/api/url/fetch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ urls, maxLength: 4000, timeout: 15000 }),
                    });

                    if (fetchResponse.ok) {
                        const fetchData = await fetchResponse.json();
                        const successfulResults = fetchData.results?.filter(r => r.success) || [];
                        const failedResults = fetchData.results?.filter(r => !r.success) || [];

                        if (successfulResults.length > 0) {
                            urlFetchResults = successfulResults;

                            // Create a summary for memory persistence
                            urlContextSummary = successfulResults
                                .map((r, i) => `${i + 1}. "${r.title || 'Untitled'}" - ${r.url}`)
                                .join('; ');

                            // Format fetched content for the model
                            const urlContext = successfulResults
                                .map((r) => {
                                    let resultText = `[${r.title || 'Untitled'}]\nSource: ${r.url}\n`;
                                    if (r.content) {
                                        // Truncate content if too long
                                        const truncatedContent = r.content.length > 3500
                                            ? r.content.slice(0, 3500) + '...'
                                            : r.content;
                                        resultText += `Content:\n${truncatedContent}\n`;
                                    }
                                    return resultText;
                                })
                                .join('\n---\n');

                            // Prepend URL content to fullContent
                            fullContent = `The following content was fetched from URLs in the user's message:\n\n` +
                                `--- Fetched URL Content ---\n${urlContext}\n--- End of Fetched Content ---\n\n` +
                                `User message: ${fullContent}`;
                        }

                        // Log failed URLs
                        if (failedResults.length > 0) {
                            console.warn('Some URLs failed to fetch:', failedResults.map(r => r.url));
                        }
                    }
                } catch (error) {
                    console.error('URL fetch failed:', error);
                    showSnackbar('URL fetch failed, proceeding without fetched content', 'warning');
                }
            }
        }

        // Add user message (display version without file content embedded)
        const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content,
            attachments: attachedFiles?.map(a => ({ filename: a.filename, type: a.type })),
            timestamp: new Date().toISOString(),
            // Add URL context metadata if URLs were fetched
            ...(urlContextSummary && { urlContext: urlContextSummary, hadUrlFetch: true }),
        };

        // For new conversations, start with empty array to avoid stale closure issues
        // For existing conversations, use the current messages from the store
        const currentMessages = isNewConversation ? [] : useChatStore.getState().messages;
        const updatedMessages = [...currentMessages, userMessage];

        // Update store with messages (including user message)
        setMessages(updatedMessages);
        clearAttachments();

        // Save user message immediately so it persists on refresh
        saveMessages(conversationId, updatedMessages);

        // Start streaming - track which conversation this stream belongs to
        streamingConversationRef.current = conversationId;
        setStreaming(true);
        setStreamingContent('');
        setStreamingReasoning('');
        setIsLoading(true);
        setProcessingStatus('processing', attachedFiles?.length > 0 ? 'Processing files' : 'Preparing request');

        // Prepare messages for API (use fullContent for the last message to include attachments)
        // Also include search context from previous messages if they had web search results
        const apiMessages = updatedMessages.map((m, idx) => {
            let msgContent = idx === updatedMessages.length - 1 ? fullContent : m.content;

            // If this is a previous user message with search context, include it
            if (m.role === 'user' && m.searchContext && idx !== updatedMessages.length - 1) {
                msgContent = `[Previous search context: ${m.searchContext}]\n\n${msgContent}`;
            }

            // If this is a previous user message with URL context, include it
            if (m.role === 'user' && m.urlContext && idx !== updatedMessages.length - 1) {
                msgContent = `[Previous URL context: ${m.urlContext}]\n\n${msgContent}`;
            }

            // For the current message with image attachments, use OpenAI vision format
            const isLastMessage = idx === updatedMessages.length - 1;
            const imageAttachments = isLastMessage && attachedFiles
                ? attachedFiles.filter(att => att.type === 'image' && att.dataUrl)
                : [];

            if (imageAttachments.length > 0) {
                // OpenAI vision format: content is an array of text and image_url objects
                const contentArray = [
                    { type: 'text', text: msgContent }
                ];

                imageAttachments.forEach(img => {
                    contentArray.push({
                        type: 'image_url',
                        image_url: { url: img.dataUrl }
                    });
                });

                return {
                    role: m.role,
                    content: contentArray,
                };
            }

            return {
                role: m.role,
                content: msgContent,
            };
        });

        // Add system prompt if selected
        const selectedSystemPrompt = systemPrompts.find(p => p.id === settings.selectedSystemPromptId);
        if (selectedSystemPrompt) {
            apiMessages.unshift({
                role: 'system',
                content: selectedSystemPrompt.content,
            });
        }

        // Handle web search
        let searchResults = null;
        let searchContextSummary = null;
        if (settings.webSearchEnabled) {
            try {
                setIsLoading(true);
                setProcessingStatus('searching', 'Searching the web');
                const searchResponse = await fetch(`/api/search?q=${encodeURIComponent(content)}&limit=5&fetchContent=true&contentLimit=3`, {
                    credentials: 'include',
                });

                if (searchResponse.ok) {
                    const searchData = await searchResponse.json();
                    if (searchData.results && searchData.results.length > 0) {
                        searchResults = searchData.results;

                        // Create a summary of search results for memory persistence
                        searchContextSummary = searchData.results
                            .slice(0, 3)
                            .map((r, i) => `${i + 1}. "${r.title}" - ${r.snippet?.slice(0, 100) || ''}`)
                            .join('; ');

                        // Format search results for the model
                        const searchContext = searchData.results
                            .map((r, i) => {
                                let resultText = `[${i + 1}] ${r.title}\nURL: ${r.url || r.link}\n`;
                                if (r.snippet) {
                                    resultText += `Summary: ${r.snippet}\n`;
                                }
                                if (r.content) {
                                    // Include fetched content if available
                                    const truncatedContent = r.content.length > 1000
                                        ? r.content.slice(0, 1000) + '...'
                                        : r.content;
                                    resultText += `Content: ${truncatedContent}\n`;
                                }
                                return resultText;
                            })
                            .join('\n---\n');

                        // Update the last user message with search context
                        apiMessages[apiMessages.length - 1].content =
                            `The following web search results are provided for context. Use them to answer the user's question if relevant.\n\n` +
                            `--- Web Search Results ---\n${searchContext}\n--- End of Search Results ---\n\n` +
                            `User question: ${content}`;

                        // Update the user message in store with search context for memory
                        const updatedUserMessage = {
                            ...userMessage,
                            searchContext: searchContextSummary,
                            hadWebSearch: true,
                        };
                        const messagesWithContext = [...currentMessages, updatedUserMessage];
                        setMessages(messagesWithContext);
                        saveMessages(conversationId, messagesWithContext);
                    }
                } else {
                    console.warn('Web search returned non-OK status:', searchResponse.status);
                }
            } catch (error) {
                console.error('Web search failed:', error);
                showSnackbar('Web search failed, proceeding without search results', 'warning');
            }
        }

        // Create abort controller for cancellation
        abortControllerRef.current = new AbortController();

        // Track response time
        const startTime = Date.now();

        try {
            setProcessingStatus('thinking', 'Model is thinking');

            const requestBody = {
                model: settings.model,
                messages: apiMessages,
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens,
                stream: true,
                conversationId: conversationId, // Include for background streaming support
            };

            // Include search results metadata if available
            if (searchResults) {
                requestBody.searchResults = searchResults;
            }

            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(requestBody),
                signal: abortControllerRef.current.signal,
            });

            setIsLoading(false);
            setProcessingStatus('generating', 'Generating response');

            if (!response.ok) {
                // Try to parse error body
                let errorBody = null;
                try {
                    errorBody = await response.json();
                } catch {
                    // Ignore parse errors
                }

                const { type, message } = parseErrorMessage(
                    errorBody ? new Error(errorBody.message || errorBody.error) : null,
                    response
                );

                throw new Error(message);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantContent = '';
            let assistantReasoning = '';
            let buffer = '';
            let tokenCount = 0;
            let inStreamError = null; // Track errors that occur mid-stream
            let lastFinishReason = null; // Track if response was cut off

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // Keep the last potentially incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;
                        if (!data) continue;

                        try {
                            const parsed = JSON.parse(data);

                            // Handle error in stream - store it but don't throw to preserve partial content
                            if (parsed.error) {
                                const errMsg = typeof parsed.error === 'object'
                                    ? parsed.error.message || JSON.stringify(parsed.error)
                                    : parsed.error;
                                inStreamError = errMsg;
                                // Don't throw - continue processing to preserve any partial content
                                // The error will be handled after the loop
                                continue;
                            }

                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                assistantContent += delta.content;
                                // Parse <think> tags from content and separate reasoning
                                const thinkParsed = parseThinkTags(assistantContent);
                                // Only update UI if we're still viewing the same conversation
                                const currentActiveId = useChatStore.getState().activeConversationId;
                                if (currentActiveId === conversationId) {
                                    setStreamingContent(thinkParsed.content);
                                    if (thinkParsed.reasoning) {
                                        assistantReasoning = thinkParsed.reasoning;
                                        setStreamingReasoning(assistantReasoning);
                                    }
                                } else if (thinkParsed.reasoning) {
                                    assistantReasoning = thinkParsed.reasoning;
                                }
                                tokenCount++; // Approximate token count by chunks
                            }

                            // Handle explicit reasoning field from model API
                            if (delta?.reasoning) {
                                assistantReasoning += delta.reasoning;
                                // Only update UI if we're still viewing the same conversation
                                const currentActiveId = useChatStore.getState().activeConversationId;
                                if (currentActiveId === conversationId) {
                                    setStreamingReasoning(assistantReasoning);
                                }
                            }

                            // Get actual token count from usage if available
                            if (parsed.usage?.completion_tokens) {
                                tokenCount = parsed.usage.completion_tokens;
                            }

                            // Handle map-reduce chunking progress events
                            if (parsed.type === 'chunking_progress') {
                                const { phase, totalChunks, currentChunk, message } = parsed;

                                if (phase === 'starting' || phase === 'chunking') {
                                    setProcessingStatus('chunking', message || 'Splitting content into chunks...');
                                } else if (phase === 'map') {
                                    const percentComplete = totalChunks > 0
                                        ? Math.round((currentChunk / totalChunks) * 100)
                                        : 0;
                                    setProcessingStatus(
                                        'processing',
                                        message || `Processing chunks (${percentComplete}% complete)`
                                    );
                                } else if (phase === 'reduce') {
                                    setProcessingStatus('synthesizing', message || 'Synthesizing responses...');
                                } else if (phase === 'complete') {
                                    setProcessingStatus('generating', 'Streaming response...');
                                }
                                continue; // Don't process this as a content event
                            }

                            // Handle map-reduce completion info
                            if (parsed.mapReduce?.enabled) {
                                const mr = parsed.mapReduce;
                                const statusMsg = mr.synthesized
                                    ? `Response synthesized from ${mr.chunkCount} chunks`
                                    : `Response compiled from ${mr.chunkCount} chunks (synthesis skipped)`;
                                if (mr.failedChunks > 0) {
                                    showSnackbar(
                                        `${statusMsg} | ${mr.failedChunks} chunk(s) had errors`,
                                        'warning'
                                    );
                                } else {
                                    showSnackbar(statusMsg, 'success');
                                }
                            }

                            // Handle continuation info (content was split due to context limits)
                            if (parsed.continuation?.hasMore) {
                                const cont = parsed.continuation;
                                const processedTokens = cont.processedTokens?.toLocaleString() || '0';
                                const totalTokens = (cont.processedTokens + cont.remainingTokens)?.toLocaleString() || '?';
                                const remainingTokens = cont.remainingTokens?.toLocaleString() || '0';
                                const percentComplete = cont.processedTokens && cont.remainingTokens
                                    ? Math.round((cont.processedTokens / (cont.processedTokens + cont.remainingTokens)) * 100)
                                    : Math.round((cont.currentChunk / cont.totalChunks) * 100);

                                // Update status indicator with detailed chunk info
                                setProcessingStatus(
                                    'chunking',
                                    `Chunk ${cont.currentChunk}/${cont.totalChunks} (${percentComplete}% complete)`
                                );

                                // Show detailed snackbar with token info
                                showSnackbar(
                                    `Processing chunk ${cont.currentChunk} of ${cont.totalChunks} | ${processedTokens} tokens processed | ${remainingTokens} tokens remaining`,
                                    'info'
                                );
                            }

                            // Handle finish reason
                            const finishReason = parsed.choices?.[0]?.finish_reason;
                            if (finishReason) {
                                lastFinishReason = finishReason;
                                if (finishReason === 'length') {
                                    showSnackbar('Response was cut off due to length limit. Click "Continue" to resume.', 'warning');
                                }
                            }
                        } catch (e) {
                            // Only log if it's not a JSON parse error for partial data
                            if (e.message && !e.message.includes('JSON')) {
                                console.error('Stream processing error:', e);
                            }
                        }
                    }
                }
            }

            // Process any remaining data in buffer
            if (buffer.trim() && buffer.startsWith('data: ')) {
                const data = buffer.slice(6).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta?.content) {
                            assistantContent += delta.content;
                        }
                        if (delta?.reasoning) {
                            assistantReasoning += delta.reasoning;
                        }
                    } catch {
                        // Ignore final parse errors
                    }
                }
            }

            // Add assistant message with response time and token count
            const responseTime = Date.now() - startTime;

            // Final parse of think tags to ensure clean separation
            const finalParsed = parseThinkTags(assistantContent);
            const finalContent = finalParsed.content;
            const finalReasoning = finalParsed.reasoning || assistantReasoning || undefined;

            // Check if user switched to a different conversation
            const currentActiveId = useChatStore.getState().activeConversationId;
            const userSwitchedConversation = currentActiveId !== conversationId;

            // Use the messages we had at the start (updatedMessages) since the user may have switched
            // This ensures we save to the correct conversation
            let finalMessages = [...updatedMessages];

            // Handle in-stream error - save partial content if any, then show error
            if (inStreamError) {
                // If we have partial content, save it first
                if (finalContent.trim()) {
                    const partialMessage = {
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: finalContent,
                        reasoning: finalReasoning,
                        timestamp: new Date().toISOString(),
                        searchResults: searchResults ? searchResults.length : undefined,
                        responseTime,
                        tokenCount: tokenCount > 0 ? tokenCount : undefined,
                        isPartial: true, // Mark as partial response
                    };
                    // Only update local store if still on same conversation
                    if (!userSwitchedConversation) {
                        addMessage(partialMessage);
                    }
                    finalMessages = [...finalMessages, partialMessage];
                }

                // Add error message explaining why the stream stopped
                const errorMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: `Error: ${inStreamError}`,
                    isError: true,
                    timestamp: new Date().toISOString(),
                };
                // Only update local store if still on same conversation
                if (!userSwitchedConversation) {
                    addMessage(errorMessage);
                }
                finalMessages = [...finalMessages, errorMessage];
                saveMessages(conversationId, finalMessages);

                // Show snackbar notification
                showSnackbar(inStreamError, 'error');
            } else {
                // Normal completion - save the full response
                // Check if response was cut off due to length limit
                const needsContinuation = lastFinishReason === 'length';

                const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: finalContent,
                    reasoning: finalReasoning,
                    timestamp: new Date().toISOString(),
                    searchResults: searchResults ? searchResults.length : undefined,
                    responseTime,
                    tokenCount: tokenCount > 0 ? tokenCount : undefined,
                    needsContinuation, // Mark if response was cut off
                    isPartial: needsContinuation, // Also mark as partial for UI
                };

                finalMessages = [...finalMessages, assistantMessage];
                // Only update local store if still on same conversation
                if (!userSwitchedConversation) {
                    addMessage(assistantMessage);
                }
                saveMessages(conversationId, finalMessages);

                // Show notification that response completed in background
                if (userSwitchedConversation) {
                    showSnackbar('Response completed in background', 'success');
                }
            }

            // Update conversation title if it's the first message (user message only)
            if (updatedMessages.length === 1) {
                handleRenameConversation(
                    conversationId,
                    content.slice(0, 50) + (content.length > 50 ? '...' : '')
                );
            }

        } catch (error) {
            const { type, message } = parseErrorMessage(error);

            if (type === 'abort') {
                showSnackbar(message, 'info');
            } else {
                console.error('Chat error:', error);
                showSnackbar(message, 'error');

                // Add error message to chat for context - only if still on same conversation
                const currentActiveId = useChatStore.getState().activeConversationId;
                if (currentActiveId === conversationId) {
                    const errorMessage = {
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: `Error: ${message}`,
                        isError: true,
                        timestamp: new Date().toISOString(),
                    };
                    addMessage(errorMessage);
                }
            }
        } finally {
            // Only clear loading/streaming UI if we're still on the same conversation
            const currentActiveId = useChatStore.getState().activeConversationId;
            if (currentActiveId === conversationId) {
                setIsLoading(false);
                clearStreaming();
                clearProcessingStatus();
            }
            streamingConversationRef.current = null;
            abortControllerRef.current = null;
        }
    };

    const handleStopGeneration = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };

    /**
     * Continue a response that was cut off due to length limits
     * Sends a continuation request to the model asking it to continue from where it left off
     */
    const handleContinueResponse = async (messageId, messageContent) => {
        if (isLoading || !settings.model) return;

        const conversationId = activeConversationId;
        if (!conversationId) return;

        // Create a continuation prompt that asks the model to continue
        const continuationPrompt = "Continue from where you left off. Do not repeat what you already said, just continue directly:";

        // Get current messages and find the message to continue
        const currentMsgs = useChatStore.getState().messages;

        // Build messages array with the continuation prompt
        const apiMessages = currentMsgs.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // Add continuation prompt
        apiMessages.push({
            role: 'user',
            content: continuationPrompt
        });

        // Add the user's continuation request to UI
        const continuationUserMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: continuationPrompt,
            timestamp: new Date().toISOString(),
            isContinuation: true,
        };
        addMessage(continuationUserMessage);

        // Start streaming - track which conversation this stream belongs to
        streamingConversationRef.current = conversationId;
        setIsLoading(true);
        setStreaming(true);
        setStreamingContent('');
        setStreamingReasoning('');
        setProcessingStatus('thinking', 'Continuing response...');
        abortControllerRef.current = new AbortController();

        // Capture messages at start for proper saving even if user switches
        const messagesAtStart = [...currentMsgs, continuationUserMessage];

        const startTime = Date.now();

        try {
            const requestBody = {
                model: settings.model,
                messages: apiMessages,
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens,
                stream: true,
            };

            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(requestBody),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantContent = '';
            let assistantReasoning = '';
            let buffer = '';
            let tokenCount = 0;
            let lastFinishReason = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;
                        if (!data) continue;

                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.error) continue;

                            const delta = parsed.choices?.[0]?.delta;
                            if (delta?.content) {
                                assistantContent += delta.content;
                                const thinkParsed = parseThinkTags(assistantContent);
                                // Only update UI if still on same conversation
                                const currentActiveId = useChatStore.getState().activeConversationId;
                                if (currentActiveId === conversationId) {
                                    setStreamingContent(thinkParsed.content);
                                    if (thinkParsed.reasoning) {
                                        assistantReasoning = thinkParsed.reasoning;
                                        setStreamingReasoning(assistantReasoning);
                                    }
                                } else if (thinkParsed.reasoning) {
                                    assistantReasoning = thinkParsed.reasoning;
                                }
                                tokenCount++;
                            }

                            if (delta?.reasoning) {
                                assistantReasoning += delta.reasoning;
                                const currentActiveId = useChatStore.getState().activeConversationId;
                                if (currentActiveId === conversationId) {
                                    setStreamingReasoning(assistantReasoning);
                                }
                            }

                            const finishReason = parsed.choices?.[0]?.finish_reason;
                            if (finishReason) {
                                lastFinishReason = finishReason;
                                if (finishReason === 'length') {
                                    showSnackbar('Response was cut off again. Click "Continue" to resume.', 'warning');
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            }

            const responseTime = Date.now() - startTime;
            const finalParsed = parseThinkTags(assistantContent);
            const finalContent = finalParsed.content;
            const finalReasoning = finalParsed.reasoning || assistantReasoning || undefined;
            const needsContinuation = lastFinishReason === 'length';

            // Check if user switched conversations
            const currentActiveId = useChatStore.getState().activeConversationId;
            const userSwitchedConversation = currentActiveId !== conversationId;

            const assistantMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: finalContent,
                reasoning: finalReasoning,
                timestamp: new Date().toISOString(),
                responseTime,
                tokenCount: tokenCount > 0 ? tokenCount : undefined,
                needsContinuation,
                isPartial: needsContinuation,
                isContinuation: true,
            };

            // Use messages captured at start for proper saving
            const updatedMsgs = [...messagesAtStart, assistantMessage];
            // Only update local store if still on same conversation
            if (!userSwitchedConversation) {
                addMessage(assistantMessage);
            }
            saveMessages(conversationId, updatedMsgs);

            // Show notification if completed in background
            if (userSwitchedConversation) {
                showSnackbar('Response completed in background', 'success');
            }

            // Mark the original message as no longer needing continuation
            if (!needsContinuation && !userSwitchedConversation) {
                const msgs = useChatStore.getState().messages;
                const updatedMessages = msgs.map(m =>
                    m.id === messageId ? { ...m, needsContinuation: false, isPartial: false } : m
                );
                useChatStore.getState().setMessages(updatedMessages);
                saveMessages(conversationId, updatedMessages);
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Continue error:', error);
                showSnackbar(error.message || 'Failed to continue response', 'error');
            }
        } finally {
            // Only clear loading/streaming UI if still on same conversation
            const currentActiveId = useChatStore.getState().activeConversationId;
            if (currentActiveId === conversationId) {
                setIsLoading(false);
                clearStreaming();
                clearProcessingStatus();
            }
            streamingConversationRef.current = null;
            abortControllerRef.current = null;
        }
    };

    const handleModelChange = (modelName) => {
        updateSettings({ model: modelName });
    };

    // Combine models prop with running instances for comprehensive list
    const combinedModels = React.useMemo(() => {
        const modelMap = new Map();

        // Add models from props (may include stopped models)
        const modelsArray = Array.isArray(models) ? models : [];
        modelsArray.forEach(m => {
            modelMap.set(m.name, { ...m });
        });

        // Update/add running instances (these are definitely running)
        runningInstances.forEach(inst => {
            const existing = modelMap.get(inst.name);
            if (existing) {
                modelMap.set(inst.name, { ...existing, status: 'running', backend: inst.backend, ...inst });
            } else {
                modelMap.set(inst.name, inst);
            }
        });

        return Array.from(modelMap.values());
    }, [models, runningInstances]);

    // Get the context size for the selected model
    const selectedModelContextSize = React.useMemo(() => {
        if (!settings.model) return 4096; // Default
        const model = combinedModels.find(m => m.name === settings.model);
        // Check various possible properties for context size
        return model?.contextSize || model?.context_size || model?.ctx_size || model?.maxContextLength || 4096;
    }, [settings.model, combinedModels]);

    // Auto-select first running model if none selected
    useEffect(() => {
        const runningModels = combinedModels.filter(m => m.status === 'running');
        if (!settings.model && runningModels.length > 0) {
            updateSettings({ model: runningModels[0].name });
        } else if (settings.model && runningModels.length > 0) {
            // Check if currently selected model is still running
            const stillRunning = runningModels.some(m => m.name === settings.model);
            if (!stillRunning) {
                // Auto-switch to first available model
                updateSettings({ model: runningModels[0].name });
                showSnackbar(`Model "${settings.model}" stopped. Switched to "${runningModels[0].name}"`, 'info');
            }
        }
    }, [combinedModels, settings.model]);

    return (
        <div className="flex h-full overflow-hidden">
            {/* Sidebar */}
            <ChatSidebar
                conversations={conversations}
                activeConversationId={activeConversationId}
                onSelectConversation={handleSelectConversation}
                onNewConversation={handleNewConversation}
                onDeleteConversation={handleDeleteConversation}
                onRenameConversation={handleRenameConversation}
                onToggleFavorite={handleToggleFavorite}
                isMobileOpen={mobileSidebarOpen}
                onMobileClose={() => setMobileSidebarOpen(false)}
            />

            {/* Main chat area */}
            <div className="flex-1 flex flex-col overflow-hidden bg-dark-950">
                {/* Header */}
                <ChatHeader
                    models={combinedModels}
                    selectedModel={settings.model}
                    onModelChange={handleModelChange}
                    onSettingsClick={() => setSettingsOpen(true)}
                    onNewChat={handleNewConversation}
                    isLoading={isLoading}
                    user={user}
                    onLogout={onLogout}
                    onMobileMenuClick={() => setMobileSidebarOpen(true)}
                />

                {/* Messages */}
                <ChatMessages
                    messages={messages}
                    isStreaming={isStreaming}
                    streamingContent={streamingContent}
                    streamingReasoning={streamingReasoning}
                    processingStatus={processingStatus}
                    processingMessage={processingMessage}
                    onContinue={handleContinueResponse}
                    isLoading={isLoading}
                />

                {/* Input */}
                <ChatInput
                    onSend={handleSendMessage}
                    onStop={handleStopGeneration}
                    isStreaming={isStreaming}
                    disabled={!settings.model}
                    attachments={attachments}
                    onAddAttachment={addAttachment}
                    onRemoveAttachment={removeAttachment}
                    onClearAllAttachments={clearAttachments}
                    systemPrompts={systemPrompts}
                    selectedSystemPromptId={settings.selectedSystemPromptId}
                    onSystemPromptSelect={(id) => updateSettings({ selectedSystemPromptId: id })}
                    webSearchEnabled={settings.webSearchEnabled}
                    onWebSearchToggle={() => updateSettings({ webSearchEnabled: !settings.webSearchEnabled })}
                    urlFetchEnabled={settings.urlFetchEnabled}
                    onUrlFetchToggle={() => updateSettings({ urlFetchEnabled: !settings.urlFetchEnabled })}
                    messages={messages}
                    maxContextTokens={selectedModelContextSize}
                />
            </div>

            {/* Settings drawer */}
            <ChatSettings
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                settings={settings}
                onUpdateSettings={updateSettings}
                systemPrompts={systemPrompts}
                onSaveSystemPrompt={handleSaveSystemPrompt}
                onDeleteSystemPrompt={handleDeleteSystemPrompt}
                theme={theme}
                onThemeChange={setTheme}
            />
        </div>
    );
}
