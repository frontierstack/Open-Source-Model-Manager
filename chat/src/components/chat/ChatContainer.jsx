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
                            status: 'running',
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
                            status: 'running',
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
        // Stop any ongoing generation
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        // Clear current state immediately for responsive UI
        clearStreaming();
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
            // Stop any ongoing generation
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
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

        // Add user message (display version without file content embedded)
        const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content,
            attachments: attachedFiles?.map(a => ({ filename: a.filename, type: a.type })),
            timestamp: new Date().toISOString(),
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

        // Start streaming
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
                                setStreamingContent(thinkParsed.content);
                                if (thinkParsed.reasoning) {
                                    assistantReasoning = thinkParsed.reasoning;
                                    setStreamingReasoning(assistantReasoning);
                                }
                                tokenCount++; // Approximate token count by chunks
                            }

                            // Handle explicit reasoning field from model API
                            if (delta?.reasoning) {
                                assistantReasoning += delta.reasoning;
                                setStreamingReasoning(assistantReasoning);
                            }

                            // Get actual token count from usage if available
                            if (parsed.usage?.completion_tokens) {
                                tokenCount = parsed.usage.completion_tokens;
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
                            if (finishReason === 'length') {
                                showSnackbar('Response was cut off due to length limit', 'warning');
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

            // Get current messages from store to ensure we have the latest state
            const currentMsgs = useChatStore.getState().messages;
            let finalMessages = [...currentMsgs];

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
                    addMessage(partialMessage);
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
                addMessage(errorMessage);
                finalMessages = [...finalMessages, errorMessage];
                saveMessages(conversationId, finalMessages);

                // Show snackbar notification
                showSnackbar(inStreamError, 'error');
            } else {
                // Normal completion - save the full response
                const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: finalContent,
                    reasoning: finalReasoning,
                    timestamp: new Date().toISOString(),
                    searchResults: searchResults ? searchResults.length : undefined,
                    responseTime,
                    tokenCount: tokenCount > 0 ? tokenCount : undefined,
                };

                finalMessages = [...finalMessages, assistantMessage];
                addMessage(assistantMessage);
                saveMessages(conversationId, finalMessages);
            }

            // Update conversation title if it's the first message (user message only)
            if (currentMsgs.length === 1) {
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

                // Add error message to chat for context
                const errorMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: `Error: ${message}`,
                    isError: true,
                    timestamp: new Date().toISOString(),
                };
                addMessage(errorMessage);
            }
        } finally {
            setIsLoading(false);
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
                />

                {/* Messages */}
                <ChatMessages
                    messages={messages}
                    isStreaming={isStreaming}
                    streamingContent={streamingContent}
                    streamingReasoning={streamingReasoning}
                    processingStatus={processingStatus}
                    processingMessage={processingMessage}
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
