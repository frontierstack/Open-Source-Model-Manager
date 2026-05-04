import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useChatStore } from '../../stores/useChatStore';
import ChatHeader from './ChatHeader';
import ChatSidebar from './ChatSidebar';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ChatSettings from './ChatSettings';
import ArtifactsPanel, { extractArtifacts } from './ArtifactsPanel';
import ConvoHeader from './ConvoHeader';

// Track empty→messages transition for slide-down animation
function useSlideTransition(isEmpty) {
    const prevIsEmptyRef = useRef(isEmpty);
    const [slideDown, setSlideDown] = useState(false);

    useEffect(() => {
        if (prevIsEmptyRef.current && !isEmpty) {
            setSlideDown(true);
            const timer = setTimeout(() => setSlideDown(false), 900);
            return () => clearTimeout(timer);
        }
        prevIsEmptyRef.current = isEmpty;
    }, [isEmpty]);

    return slideDown;
}

// Reasoning tag names emitted by various thinking models
// (Qwen/DeepSeek use <think>; some llama.cpp templates and fine-tunes emit
// <thinking>, <reasoning>, or <reasoning_engine>)
// Names are dropped into a regex alternation (REASONING_TAG_ALT below).
// `antThinking` / `antml:thinking` cover Anthropic-style scratchpad tags
// some open-source fine-tunes emit; `:` is literal in regex alternation
// so the namespaced form works without further pattern changes.
const REASONING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'reasoning_engine', 'antThinking', 'antml:thinking', 'scratchpad'];
const REASONING_TAG_ALT = REASONING_TAG_NAMES.join('|');

/**
 * Parse reasoning tags from content and separate thinking from response.
 * Handles both complete and partial (streaming) content.
 *
 * If the entire response is wrapped in reasoning tags with no content outside,
 * the thinking content is returned as the main content (not as reasoning).
 * That promotion only fires when `streaming` is false — mid-stream, the
 * window between `</think>` arriving and the first real content character
 * would otherwise flash the entire thinking buffer into the bubble body
 * and then snap it back into the collapsed dropdown.
 */
function parseThinkTags(content, streaming = false) {
    if (!content) return { content: '', reasoning: '' };

    let reasoning = '';
    let cleanContent = content;
    let hasCompletedThinkBlock = false;

    // Find all complete <tag>...</tag> blocks with matching open/close names
    const completeRegex = new RegExp(`<(${REASONING_TAG_ALT})>([\\s\\S]*?)<\\/\\1>`, 'gi');
    let match;
    while ((match = completeRegex.exec(content)) !== null) {
        reasoning += match[2];
        cleanContent = cleanContent.replace(match[0], '');
        hasCompletedThinkBlock = true;
    }

    // Handle unclosed opening tag (content is still streaming).
    // After removing completed pairs, any remaining opening tag must be unclosed.
    const openRegex = new RegExp(`<(${REASONING_TAG_ALT})>`, 'gi');
    let lastOpen = null;
    let m;
    while ((m = openRegex.exec(cleanContent)) !== null) {
        lastOpen = { tag: m[1], index: m.index, fullLength: m[0].length };
    }

    let hasUnclosedThink = false;
    if (lastOpen) {
        const lowerClean = cleanContent.toLowerCase();
        const lastCloseIdx = lowerClean.lastIndexOf(`</${lastOpen.tag.toLowerCase()}>`);
        if (lastOpen.index > lastCloseIdx) {
            hasUnclosedThink = true;
            const partialReasoning = cleanContent.substring(lastOpen.index + lastOpen.fullLength);
            reasoning += partialReasoning;
            cleanContent = cleanContent.substring(0, lastOpen.index);
        }
    }

    // Streaming flicker guard: if cleanContent ends with a half-arrived
    // open tag (`<thi`, `<think`, `<reasoning_eng`, …), the rest of
    // the tag hasn't streamed yet. The completeRegex / openRegex above both
    // need the closing `>` to fire, so without this the partial tag renders
    // as literal text for one or more frames and pops away once `>` lands.
    // That's the most visible flicker source during generation.
    //
    // Match conservatively — only `<` followed by tag-name characters at the
    // very end of the buffer. Bare `<` (or `<3`, `<5`, `< `) is left alone
    // so chat content like math comparisons doesn't get clipped.
    const partialTagAtEnd = cleanContent.match(/<[a-zA-Z][a-zA-Z0-9_:]*$/);
    if (partialTagAtEnd) {
        cleanContent = cleanContent.slice(0, partialTagAtEnd.index);
    }

    // Clean up extra whitespace
    cleanContent = cleanContent.replace(/^\s+/, '').replace(/\s+$/, '');
    reasoning = reasoning.replace(/^\s+/, '').replace(/\s+$/, '');

    // If content is empty but we have reasoning from COMPLETED blocks,
    // the model likely wrapped its entire response in reasoning tags.
    // Only apply this on the final parse — mid-stream this same condition
    // hits the moment </think> closes (before the first real content
    // character arrives), which would briefly render the entire thinking
    // buffer as the main bubble body and then flicker it back into the
    // dropdown one frame later.
    if (!streaming && !cleanContent && reasoning && hasCompletedThinkBlock && !hasUnclosedThink) {
        return { content: reasoning, reasoning: '' };
    }

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
 * Pull link references out of a native tool's structured result so the
 * UI can render them as clickable source cards (SearchSources).
 *
 * Recognizes the shapes the built-in tools return:
 *   web_search: { results: [{ title, url, snippet }, ...] }
 *   fetch_url:  { url, title, content }   (single page)
 *
 * Returns null when the tool doesn't expose URL-shaped data. Unknown
 * tools return null — no surprises.
 */
function extractSources(toolName, result) {
    if (!result || typeof result !== 'object') return null;
    if (toolName === 'web_search' && Array.isArray(result.results)) {
        return result.results
            .filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
            .map(r => ({ url: r.url, title: r.title || '', snippet: r.snippet || '' }));
    }
    if (toolName === 'fetch_url' && typeof result.url === 'string' && /^https?:\/\//.test(result.url)) {
        return [{
            url: result.url,
            title: result.title || '',
            snippet: typeof result.content === 'string' ? result.content.slice(0, 220) : '',
        }];
    }
    return null;
}

// Map a tool name to one of ProcessingLogFeed's icon keys.
function pickToolIcon(name) {
    if (!name) return 'cpu';
    const n = String(name).toLowerCase();
    if (n.includes('search')) return 'search';
    if (n.includes('fetch') || n.includes('url') || n.includes('crawl') || n.includes('http')) return 'link';
    if (n === 'load_skill') return 'paperclip';
    if (n.includes('read') || n.includes('write') || n.includes('edit') || n.includes('file')) return 'edit';
    if (n.includes('think') || n.includes('memory') || n.includes('recall')) return 'brain';
    return 'cpu';
}

// Turn a snake_case tool id into a friendly verb phrase for the status row.
function humanizeToolName(name) {
    if (!name) return 'tool';
    return String(name).replace(/_/g, ' ');
}

// One-line argument summary for the live progress feed. Picks the first
// "interesting" string-typed arg by a known priority list, falls back to
// the first string field, and truncates so a giant base64 / file body
// doesn't blow up the row width.
function summarizeToolArgs(rawArgs) {
    if (rawArgs == null) return '';
    let args = rawArgs;
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (!trimmed) return '';
        try { args = JSON.parse(trimmed); }
        catch { return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed; }
    }
    if (!args || typeof args !== 'object') return '';
    const priority = ['query', 'q', 'url', 'urls', 'name', 'skill', 'domain', 'host',
        'path', 'file', 'filepath', 'filename', 'command', 'cmd', 'text', 'input',
        'pattern', 'regex', 'ip', 'hash'];
    const pickValue = (v) => {
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join(', ');
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return '';
    };
    let key = null;
    let val = '';
    for (const p of priority) {
        if (p in args) {
            const candidate = pickValue(args[p]);
            if (candidate) { key = p; val = candidate; break; }
        }
    }
    if (!val) {
        for (const [k, v] of Object.entries(args)) {
            const candidate = pickValue(v);
            if (candidate) { key = k; val = candidate; break; }
        }
    }
    if (!val) return '';
    val = val.replace(/\s+/g, ' ').trim();
    if (val.length > 80) val = val.slice(0, 80) + '…';
    return key ? `${key}: ${val}` : val;
}

// Compact summary of what a tool returned — shown after the call completes
// so the feed reads "Calling X… → Got N results in Ys".
function summarizeToolResult(toolName, result) {
    if (!result || typeof result !== 'object') return '';
    if (Array.isArray(result.results)) {
        const n = result.results.length;
        if (toolName === 'web_search') return `${n} result${n === 1 ? '' : 's'}`;
        return `${n} item${n === 1 ? '' : 's'}`;
    }
    if (typeof result.content === 'string' && result.content.length) {
        return `${result.content.length.toLocaleString()} chars`;
    }
    if (typeof result.body === 'string' && result.body.length) {
        return `${result.body.length.toLocaleString()} chars`;
    }
    if (typeof result.decoded === 'string' && result.decoded.length) {
        return `decoded ${result.decoded.length} chars`;
    }
    if (typeof result.id === 'string' && toolName === 'load_skill') {
        return `loaded ${result.id}`;
    }
    return '';
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
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [artifactsOpen, setArtifactsOpen] = useState(false);
    const [activeArtifactId, setActiveArtifactId] = useState(null);
    const abortControllerRef = useRef(null);
    const switchingConversationRef = useRef(false); // Track if abort was due to conversation switch
    const streamingConversationRef = useRef(null); // Track which conversation is being streamed to
    const throttleTimerRef = useRef(null); // Throttle streaming UI updates to reduce jitter
    const pendingContentRef = useRef(''); // Buffer for throttled content updates
    const pendingReasoningRef = useRef(''); // Buffer for throttled reasoning updates
    const backgroundPollRef = useRef(null); // Track background streaming poll interval for cleanup
    const handleContinueRef = useRef(null); // Stable reference for continue handler (avoids React.memo invalidation)

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
        startStreamingToolCall,
        finishStreamingToolCall,
        clearStreaming,
        commitStreamingMessage,
        setProcessingStatus,
        clearProcessingStatus,
        processingLog,
        pushProcessingLog,
        resolveProcessingLog,
        clearProcessingLog,
        setProcessingLog,
        addAttachment,
        removeAttachment,
        clearAttachments,
        updateSettings,
        theme,
        setTheme,
        systemPrompts: storeSystemPrompts,
        setSystemPrompts,
    } = useChatStore();

    // System prompts come entirely from the server (user-managed in
    // Settings). The built-in "Research partner / Line editor / Code
    // reviewer" presets were removed per user request — they cluttered
    // both the Settings management list and the composer persona chip
    // with entries that couldn't be edited or deleted.
    const userSystemPrompts = storeSystemPrompts?.length > 0 ? storeSystemPrompts : initialSystemPrompts;
    const systemPrompts = Array.isArray(userSystemPrompts) ? userSystemPrompts : [];

    // Slide-down animation when transitioning from empty to messages
    const chatIsEmpty = messages.length === 0 && !isStreaming;
    const slideDown = useSlideTransition(chatIsEmpty);

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
        // Clean up background polling from previous conversation
        clearBackgroundPoll();
        // Only abort the stream if we're switching AWAY from the streaming
        // conversation. Don't abort if switching TO it (e.g. new conversation
        // just created — activeConversationId changes to match the stream).
        const streamConvId = streamingConversationRef.current;
        if (abortControllerRef.current && streamConvId && streamConvId !== activeConversationId) {
            switchingConversationRef.current = true;
            abortControllerRef.current.abort();
            // Clear streaming UI so it doesn't bleed into the new conversation.
            clearStreaming();
            setIsLoading(false);
            clearProcessingStatus();
        }
        if (activeConversationId) {
            loadConversationMessages(activeConversationId);
        } else {
            // No active conversation (new chat) - clear messages
            setMessages([]);
        }
    }, [activeConversationId]);

    const loadConversations = async () => {
        try {
            const response = await fetch('/api/conversations', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setConversations(data);
                // If we have a restored activeConversationId (from localStorage
                // on page refresh) that no longer exists server-side, clear it
                // so the UI doesn't try to load a ghost conversation. This also
                // prevents the Memories tab from firing a GET that would 404.
                const currentActive = useChatStore.getState().activeConversationId;
                if (currentActive && Array.isArray(data) && !data.some(c => c.id === currentActive)) {
                    setActiveConversation(null);
                }
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
                // Guard against race condition: only update messages if we're still
                // viewing the same conversation (user may have switched while loading)
                const currentActiveId = useChatStore.getState().activeConversationId;
                if (currentActiveId === conversationId) {
                    setMessages(data.messages || []);
                    // Check if there's active streaming for this conversation
                    checkActiveStreaming(conversationId);
                }
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    };

    // Clean up any active background polling timeout
    const clearBackgroundPoll = () => {
        if (backgroundPollRef.current) {
            clearTimeout(backgroundPollRef.current);
            backgroundPollRef.current = null;
        }
    };

    // Check for active background streaming on a conversation
    const checkActiveStreaming = async (conversationId) => {
        try {
            const response = await fetch(`/api/conversations/${conversationId}/streaming`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                if (data.streaming) {
                    // The fetch is async — the user may have switched to a
                    // different conversation between the request and response.
                    // Setting streaming state here would leak this conversation's
                    // in-progress response into the bubble the user is now
                    // viewing. Bail out if the active conversation no longer
                    // matches.
                    const currentActiveId = useChatStore.getState().activeConversationId;
                    if (currentActiveId !== conversationId) {
                        return;
                    }
                    // There's active streaming - show the content and start polling
                    setStreaming(true);
                    setStreamingContent(data.content || '');
                    setStreamingReasoning(data.reasoning || '');
                    setIsLoading(false);
                    // Map the server's phase to a user-facing status. The
                    // server registers the job up front, so phase can be any
                    // of: preparing, waiting, generating, chunking, mapping,
                    // synthesizing. Without this the bubble sat empty during
                    // heavy prep work (tokenizing, chunking 24k+ tokens) with
                    // no "in progress" signal.
                    const modelLabel = data.model || 'model';
                    const phaseToStatus = (phase, hasContent) => {
                        switch (phase) {
                            case 'preparing':
                                return { kind: 'processing', text: 'Preparing request...' };
                            case 'chunking':
                                return { kind: 'chunking', text: 'Preparing content for parallel processing...' };
                            case 'mapping': {
                                const p = data.progress || {};
                                const done = (p.completedChunks || 0) + (p.failedChunks || 0);
                                const total = p.totalChunks || 0;
                                const label = total
                                    ? `Analyzing chunks (${done}/${total})`
                                    : 'Analyzing chunks in parallel';
                                return { kind: 'processing', text: label };
                            }
                            case 'synthesizing':
                                return { kind: 'synthesizing', text: 'Synthesizing chunks into final response...' };
                            case 'generating':
                                return {
                                    kind: 'generating',
                                    text: hasContent ? 'Resuming response...' : 'Generating response',
                                };
                            case 'waiting':
                            default:
                                return {
                                    kind: 'generating',
                                    text: hasContent ? 'Resuming response...' : `Waiting for ${modelLabel} to respond`,
                                };
                        }
                    };
                    const { kind, text } = phaseToStatus(data.phase, !!data.content);
                    setProcessingStatus(kind, text);
                    // Replay the server-side event log so the ProcessingLogFeed
                    // on a reconnected client matches what a continuously-
                    // connected client would have shown (rolling credits of
                    // chunking → map → synthesize → generate events instead
                    // of a single stub line). Mark all replayed events as
                    // done except the newest, which becomes the active row.
                    if (Array.isArray(data.events) && data.events.length > 0) {
                        const replayed = data.events.map((e, i) => ({
                            ...e,
                            status: i === data.events.length - 1 ? 'active' : 'done',
                        }));
                        setProcessingLog(replayed);
                    } else {
                        clearProcessingLog();
                        pushProcessingLog({ icon: 'sparkles', text, kind });
                    }

                    // Capture start time for response stats
                    const streamStartTime = data.startTime || Date.now();

                    // Clear any previous poll before starting a new one
                    clearBackgroundPoll();

                    // Poll with chained setTimeout (not setInterval) to prevent
                    // overlapping requests. 100ms gives ~10fps content updates —
                    // much smoother than the 2fps of 500ms polling.
                    const schedulePoll = () => {
                        backgroundPollRef.current = setTimeout(async () => {
                            const currentActiveId = useChatStore.getState().activeConversationId;
                            if (currentActiveId !== conversationId) {
                                clearBackgroundPoll();
                                return;
                            }
                            try {
                                const pollResponse = await fetch(`/api/conversations/${conversationId}/streaming`, { credentials: 'include' });
                                if (pollResponse.ok) {
                                    const pollData = await pollResponse.json();
                                    if (pollData.streaming) {
                                        setStreamingContent(pollData.content || '');
                                        setStreamingReasoning(pollData.reasoning || '');
                                        // Keep the status indicator in sync as
                                        // the server transitions through phases
                                        // (preparing → chunking → mapping →
                                        // synthesizing → generating). Once
                                        // tokens appear, the content displaces
                                        // the indicator anyway, but this keeps
                                        // the pre-token phases meaningful.
                                        const poll = pollData;
                                        const hasContent = !!poll.content;
                                        let pkind = 'generating';
                                        let ptext = hasContent ? 'Resuming response...' : `Waiting for ${poll.model || 'model'} to respond`;
                                        if (poll.phase === 'preparing') {
                                            pkind = 'processing';
                                            ptext = 'Preparing request...';
                                        } else if (poll.phase === 'chunking') {
                                            pkind = 'chunking';
                                            ptext = 'Preparing content for parallel processing...';
                                        } else if (poll.phase === 'mapping') {
                                            const pr = poll.progress || {};
                                            const done = (pr.completedChunks || 0) + (pr.failedChunks || 0);
                                            const total = pr.totalChunks || 0;
                                            pkind = 'processing';
                                            ptext = total ? `Analyzing chunks (${done}/${total})` : 'Analyzing chunks in parallel';
                                        } else if (poll.phase === 'synthesizing') {
                                            pkind = 'synthesizing';
                                            ptext = 'Synthesizing chunks into final response...';
                                        }
                                        setProcessingStatus(pkind, ptext);
                                        // Keep the event feed in sync with
                                        // the server's log so new rolling-
                                        // credits lines appear as phases
                                        // progress (same behavior the
                                        // stay-connected client sees).
                                        if (Array.isArray(poll.events) && poll.events.length > 0) {
                                            const replayed = poll.events.map((e, i) => ({
                                                ...e,
                                                status: i === poll.events.length - 1 ? 'active' : 'done',
                                            }));
                                            setProcessingLog(replayed);
                                        }
                                        // Schedule next poll AFTER this one completes
                                        schedulePoll();
                                    } else {
                                        // Streaming finished — fetch saved response from server.
                                        // Race: the server flips streaming→false *before*
                                        // saveConversationMessages completes, so a poll that
                                        // lands in that window gets the pre-save message list
                                        // (no new assistant turn). The old "any assistant
                                        // anywhere" check passed on stale conversations that
                                        // already had an assistant from a prior turn — the
                                        // freshly-streamed long response then got wiped when
                                        // setMessages(stale list) ran. Only trust the server
                                        // if its LAST message is a non-error assistant AND
                                        // the total count is ≥ the local count (i.e. it
                                        // actually contains our new turn).
                                        clearBackgroundPoll();
                                        let loaded = false;
                                        const localMessages = useChatStore.getState().messages || [];
                                        const storeContent = useChatStore.getState().streamingContent || '';
                                        const storeReasoning = useChatStore.getState().streamingReasoning || '';
                                        const hasLocalStreamContent = !!(storeContent && storeContent.trim());
                                        try {
                                            const msgResponse = await fetch(
                                                `/api/conversations/${conversationId}`,
                                                { credentials: 'include' }
                                            );
                                            if (msgResponse.ok) {
                                                const msgData = await msgResponse.json();
                                                const serverMsgs = msgData.messages || [];
                                                const last = serverMsgs[serverMsgs.length - 1];
                                                const serverHasNewAssistant =
                                                    last && last.role === 'assistant' && !last.isError &&
                                                    serverMsgs.length >= localMessages.length;
                                                if (serverHasNewAssistant) {
                                                    setMessages(serverMsgs);
                                                    loaded = true;
                                                } else if (!hasLocalStreamContent && serverMsgs.length > 0) {
                                                    // No local streaming content to rescue *and*
                                                    // server has something — accept it even if the
                                                    // tail is a user turn. Avoids zeroing out a
                                                    // valid-but-older conversation.
                                                    setMessages(serverMsgs);
                                                    loaded = true;
                                                }
                                            }
                                        } catch (loadErr) {
                                            console.error('Failed to load completed messages:', loadErr);
                                        }
                                        if (!loaded && hasLocalStreamContent) {
                                            // The save hasn't landed yet (or failed). Rescue
                                            // from the streaming content we captured live —
                                            // this is the whole point of the fallback path.
                                            const parsed = parseThinkTags(storeContent);
                                            const responseTime = streamStartTime ? Date.now() - streamStartTime : undefined;
                                            const estimatedTokens = Math.ceil((parsed.content || storeContent).length / 3);
                                            commitStreamingMessage({
                                                id: crypto.randomUUID(),
                                                role: 'assistant',
                                                content: parsed.content || storeContent,
                                                reasoning: parsed.reasoning || storeReasoning || undefined,
                                                timestamp: new Date().toISOString(),
                                                responseTime,
                                                tokenCount: estimatedTokens,
                                                backgroundCompleted: true,
                                            });
                                            saveMessages(conversationId, useChatStore.getState().messages);
                                        } else {
                                            clearStreaming();
                                        }
                                        setIsLoading(false);
                                        clearProcessingStatus();
                                        showSnackbar('Background response completed', 'success');
                                    }
                                } else {
                                    schedulePoll(); // Retry on non-ok response
                                }
                            } catch (pollError) {
                                console.error('Failed to poll streaming status:', pollError);
                                clearBackgroundPoll();
                                const rescueContent = useChatStore.getState().streamingContent || '';
                                const parsed = rescueContent.trim() ? parseThinkTags(rescueContent) : null;
                                if (parsed && parsed.content.trim()) {
                                    commitStreamingMessage({
                                        id: crypto.randomUUID(),
                                        role: 'assistant',
                                        content: parsed.content,
                                        reasoning: parsed.reasoning || undefined,
                                        timestamp: new Date().toISOString(),
                                        isPartial: true,
                                    });
                                    saveMessages(conversationId, useChatStore.getState().messages);
                                } else {
                                    clearStreaming();
                                }
                                setIsLoading(false);
                            }
                        }, 100);
                    };
                    schedulePoll();
                    streamingConversationRef.current = conversationId;

                    // Safety timeout: stop polling after 10 minutes
                    setTimeout(() => {
                        clearBackgroundPoll();
                    }, 10 * 60 * 1000);
                }
            }
        } catch (error) {
            console.error('Failed to check streaming status:', error);
        }
    };

    const saveMessages = async (conversationId, msgs) => {
        // Guard: never save empty messages array (prevents accidental data loss)
        if (!msgs || msgs.length === 0) {
            console.warn('saveMessages called with empty array, skipping to prevent data loss');
            return;
        }
        try {
            await fetch(`/api/conversations/${conversationId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ messages: msgs }),
            });
            // Update messageCount in sidebar
            updateConversation(conversationId, { messageCount: msgs.length });
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

    // Delete system prompt via API.
    //
    // On success, refreshes the prompt list from the server. On 404
    // ("not found"), the entry the user clicked doesn't exist on the
    // server — usually because the list the UI was showing had grown
    // stale since the last fetch. Refresh too in that case so the
    // ghost entry disappears instead of hanging around with a
    // misleading error.
    const handleDeleteSystemPrompt = async (promptId) => {
        try {
            const response = await fetch(`/api/system-prompts/${encodeURIComponent(promptId)}`, {
                method: 'DELETE',
                credentials: 'include',
            });

            if (response.ok) {
                await refreshSystemPrompts();
                showSnackbar('System prompt deleted', 'success');
                return;
            }

            const error = await response.json().catch(() => ({}));
            if (response.status === 404) {
                // Stale UI. Pull fresh list and tell the user what
                // happened in plain terms.
                await refreshSystemPrompts();
                showSnackbar(
                    'Prompt was already gone on the server — list refreshed.',
                    'warning',
                );
                return;
            }
            throw new Error(error.error || 'Failed to delete system prompt');
        } catch (error) {
            console.error('Failed to delete system prompt:', error);
            showSnackbar(error.message || 'Failed to delete system prompt', 'error');
        }
    };

    const creatingConversationRef = useRef(false);
    const handleNewConversation = async () => {
        // Guard: ignore rapid repeat clicks while a create is still in flight.
        if (creatingConversationRef.current) return;

        // If the current conversation is already empty (no user/assistant
        // messages yet), don't spawn a duplicate blank chat — just stay on it.
        const activeConv = conversations.find(c => c.id === activeConversationId);
        const activeIsEmpty = activeConv
            && (!activeConv.messages || activeConv.messages.length === 0)
            && (!messages || messages.length === 0);
        if (activeIsEmpty) return;

        // Abort any active stream to prevent responses leaking into new conversation
        // The server continues processing in background and saves the result
        if (abortControllerRef.current) {
            switchingConversationRef.current = true;
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        clearStreaming();

        // Clear attachments and messages for the new conversation
        clearAttachments();
        setMessages([]);
        setActiveConversation(null);

        creatingConversationRef.current = true;
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
        } finally {
            creatingConversationRef.current = false;
        }
    };

    const handleSelectConversation = (conversationId) => {
        if (conversationId !== activeConversationId) {
            // Abort any active stream to prevent responses leaking into other conversation
            // The server continues processing in background and saves the result
            if (abortControllerRef.current) {
                switchingConversationRef.current = true;
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
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

        // Reset the rolling-credits log at the very start of the turn so the
        // streaming bubble can narrate everything Koda is about to do (URL
        // fetch, search, model thinking, streaming, chunking, synthesis).
        clearProcessingLog();

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
        // Each file is clearly labeled with index and filename so the model
        // can reference all uploaded files, not just the last one.
        let fullContent = content;
        if (attachedFiles && attachedFiles.length > 0) {
            const textParts = [];
            let fileIndex = 0;

            // Include non-image file content
            attachedFiles
                .filter(att => att.type !== 'image')
                .forEach(att => {
                    fileIndex++;
                    textParts.push(`=== FILE ${fileIndex}: ${att.filename} ===\n${att.content}\n=== END FILE ${fileIndex} ===`);
                });

            // Include OCR text from images (if available)
            attachedFiles
                .filter(att => att.type === 'image' && att.content)
                .forEach(att => {
                    fileIndex++;
                    textParts.push(`=== FILE ${fileIndex}: ${att.filename} (OCR) ===\n${att.content}\n=== END FILE ${fileIndex} ===`);
                });

            if (textParts.length > 0) {
                // The header below is load-bearing: it tells the model the
                // file content is ALREADY inline and is NOT on disk. Without
                // this, the model sees a filename-looking header and reaches
                // for read_email_file / read_pdf / read_file / search_files
                // — those will fail because uploads never land in the
                // sandbox workspace, only their parsed text is forwarded.
                const header =
                    `The user uploaded ${fileIndex} file${fileIndex > 1 ? 's' : ''}. ` +
                    `Their FULL content is included inline in the === FILE N === blocks below. ` +
                    `These files are NOT on disk — do NOT call read_email_file, read_pdf, read_file, ` +
                    `search_files, list_directory, or any other "read from path" tool for them. ` +
                    `Read and reason from the inline content directly.\n\n`;
                fullContent = `${header}${textParts.join('\n\n')}\n\n---\n\nUser message: ${content}`;
            }
        } else {
            // No new attachments on this turn — but the user may still be
            // referring to a file uploaded earlier in the conversation
            // ("the csv", "the attachment", "list indicators from the file",
            // "from it"). In long conversations the old upload can get
            // evicted from context by memory compression or token-budget
            // truncation, which is why the model starts claiming it can't
            // see the file. Re-inject the most recent prior attachment
            // content directly into *this* turn when the wording looks like
            // a file reference.
            const refersToFile = /\b(csv|file|attachment|upload(ed)?|document|spreadsheet|pdf|doc|image|screenshot|the data|from (it|that|this))\b/i.test(content);
            if (refersToFile) {
                const priorMessages = useChatStore.getState().messages || [];
                // Walk back to find the most recent user message whose
                // apiContent carries one of our "=== FILE N:" blocks.
                for (let i = priorMessages.length - 1; i >= 0; i--) {
                    const pm = priorMessages[i];
                    if (pm.role !== 'user' || !pm.apiContent) continue;
                    if (!pm.apiContent.includes('=== FILE ')) continue;
                    const priorFileSection = pm.apiContent.split(/\n\n---\n\nUser message:/)[0];
                    fullContent =
                        `[The user is referring to a file uploaded earlier in this conversation. Re-including it so you have the content:]\n\n` +
                        priorFileSection + `\n\n---\n\nUser message: ${content}`;
                    break;
                }
            }
        }
        // Collect tool-call metadata across this turn so we can attach it to
        // the final assistant message. The chat UI renders each entry as a
        // collapsible ToolCallBlock above the message body, giving the user
        // transparency into what Koda did before answering (web search, URL
        // fetch, etc). Neither tool is streamed over SSE — both run here on
        // the client before the chat request is sent — so this is the only
        // place where the metadata is actually known.
        const toolCalls = [];


        // Save enriched content (attachments + URL fetch) for follow-up message context
        const enrichedContent = fullContent;

        // Add user message (display version without file content embedded)
        // apiContent preserves full enriched text so follow-up messages retain context
        const userMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content,
            ...(enrichedContent !== content && { apiContent: enrichedContent }),
            // Persist enough metadata for FilePreviewModal to re-open the
            // attachment after the response lands. Stripping to just
            // {filename, type} broke click-to-preview for every prior turn:
            // isAttachmentPreviewable() needs at least one of content /
            // dataUrl / attachmentId / sheets to enable the chip. PDFs and
            // spreadsheets keep their bytes in the attachment store, so the
            // attachmentId pointer is small; text/code/csv/email content is
            // already echoed inside apiContent so persisting `content` here
            // is redundant rather than incremental cost. Images persist
            // their dataUrl since that's the only thing the preview can
            // render from.
            attachments: attachedFiles?.map(a => ({
                filename: a.filename,
                type: a.type,
                ...(a.attachmentId ? { attachmentId: a.attachmentId } : {}),
                ...(a.content ? { content: a.content } : {}),
                ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}),
                ...(Array.isArray(a.sheets) ? { sheets: a.sheets } : {}),
                ...(a.mimeType ? { mimeType: a.mimeType } : {}),
                ...(a.charCount != null ? { charCount: a.charCount } : {}),
                ...(a.pageCount != null ? { pageCount: a.pageCount } : {}),
                ...(a.sheetCount != null ? { sheetCount: a.sheetCount } : {}),
                ...(a.estimatedTokens != null ? { estimatedTokens: a.estimatedTokens } : {}),
            })),
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

        // Start streaming - track which conversation this stream belongs to
        streamingConversationRef.current = conversationId;
        abortControllerRef.current = new AbortController();
        setStreaming(true);
        setStreamingContent('');
        setStreamingReasoning('');
        setIsLoading(true);
        setProcessingStatus('processing', attachedFiles?.length > 0 ? 'Processing files' : 'Preparing request');
        pushProcessingLog({
            icon: attachedFiles?.length > 0 ? 'paperclip' : 'edit',
            text: attachedFiles?.length > 0
                ? `Preparing ${attachedFiles.length} attachment${attachedFiles.length === 1 ? '' : 's'}`
                : 'Preparing request',
            kind: 'setup'
        });

        // Prepare messages for API (use fullContent for the last message to include attachments)
        // Also include search context from previous messages if they had web search results
        // Only include context from last N messages to prevent context overflow
        const MAX_CONTEXT_MESSAGES = 4; // Only include search/url context from last 4 user messages
        const userMessageIndices = updatedMessages
            .map((m, i) => m.role === 'user' ? i : -1)
            .filter(i => i !== -1);
        const recentUserIndices = new Set(userMessageIndices.slice(-MAX_CONTEXT_MESSAGES));

        const apiMessages = updatedMessages.map((m, idx) => {
            let msgContent = idx === updatedMessages.length - 1 ? fullContent : (m.apiContent || m.content);
            const isRecentUserMessage = recentUserIndices.has(idx);

            // If this is a recent previous user message, include search/URL context
            // Skip if apiContent already has the full enriched content baked in
            // Legacy: earlier versions of the app did client-side web search and URL
            // fetch before the chat request and stashed the result text on the user
            // message as `searchContext` / `urlContext`. Native tool calling
            // replaced both (the model now calls web_search / fetch_url on demand
            // and the results stream back as tool events) — so we no longer
            // generate these fields on new turns. We still READ them here so old
            // conversations replay correctly.
            if (m.role === 'user' && idx !== updatedMessages.length - 1 && isRecentUserMessage && !m.apiContent) {
                if (m.searchContext) {
                    msgContent = `[Previous search context: ${m.searchContext}]\n\n${msgContent}`;
                }
                if (m.urlContext) {
                    msgContent = `[Previous URL context: ${m.urlContext}]\n\n${msgContent}`;
                }
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




        // Track response time
        const startTime = Date.now();
        let connectionLost = false; // Track if stream died due to network (hoisted for finally block access)
        let messageSaved = false; // Track if assistant message was saved (for finally rescue)

        try {
            setProcessingStatus('thinking', 'Model is thinking');
            pushProcessingLog({
                icon: 'brain',
                text: `Waiting for ${settings.model || 'model'} to respond`,
                kind: 'thinking'
            });

            const requestBody = {
                model: settings.model,
                messages: apiMessages,
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens || undefined,  // Only send if explicitly set; backend uses smart defaults
                stream: true,
                conversationId: conversationId, // Include for background streaming support
            };

            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(requestBody),
                signal: abortControllerRef.current.signal,
            });

            setIsLoading(false);
            setProcessingStatus('generating', 'Generating response');
            pushProcessingLog({
                icon: 'sparkles',
                text: 'Generating response',
                kind: 'generating'
            });

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
            // Tracks whether a tool fired this turn so we can flip the
            // top-of-bubble status from "Reading … result" back to
            // "Generating response" the moment real content resumes.
            let sawToolEventThisTurn = false;

            // Wrap stream reading in try-catch to handle network errors
            try {
                while (true) {
                    let readResult;
                    try {
                        readResult = await reader.read();
                    } catch (readError) {
                        if (readError.name === 'AbortError') {
                            if (switchingConversationRef.current) {
                                // User switched conversations — server continues in
                                // background. Don't save anything client-side.
                                console.log('[Chat] Stream aborted due to conversation switch — server continues');
                                connectionLost = true;
                            } else {
                                // User manually stopped - save partial content
                                lastFinishReason = 'stop_by_user';
                            }
                        } else {
                            // Network error (page refresh, tab close, connection drop).
                            // The server continues generating in background and will save
                            // the complete response. Don't save partial content or error
                            // messages — just transition to background polling.
                            console.log('[Chat] Stream connection lost — server continues in background');
                            connectionLost = true;
                        }
                        break;
                    }

                    const { done, value } = readResult;
                    if (done) break;

                    let decodedChunk;
                    try {
                        decodedChunk = decoder.decode(value, { stream: true });
                    } catch (decodeError) {
                        console.error('Decode error:', decodeError);
                        inStreamError = 'Error decoding response data';
                        break;
                    }

                    buffer += decodedChunk;
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

                            // Native tool-calling events. Server emits these
                            // out-of-band (no `choices` field) so chip UI can
                            // reflect in-flight / finished tools live. At
                            // stream commit, these get folded into the
                            // assistant message's toolCalls array so they
                            // persist for reloads and history.
                            if (parsed.type === 'tool_executing') {
                                startStreamingToolCall({
                                    tool_call_id: parsed.tool_call_id,
                                    name: parsed.name,
                                    arguments: parsed.arguments,
                                    sandboxed: parsed.sandboxed,
                                    source: parsed.source,
                                    network: parsed.network,
                                    workspace: parsed.workspace,
                                });
                                // Surface the active tool in the rolling feed
                                // and the top-of-bubble status so a long
                                // multi-tool turn doesn't read as a silent
                                // "Generating response" for minutes.
                                {
                                    const human = humanizeToolName(parsed.name);
                                    const argSummary = summarizeToolArgs(parsed.arguments);
                                    const text = argSummary
                                        ? `Calling ${human} — ${argSummary}`
                                        : `Calling ${human}`;
                                    setProcessingStatus('processing', text);
                                    pushProcessingLog({
                                        icon: pickToolIcon(parsed.name),
                                        text,
                                        kind: `tool_call:${parsed.name}`,
                                    });
                                }
                                continue;
                            }
                            if (parsed.type === 'tool_result') {
                                // Prefer the structured `result` field (full
                                // parsed tool output, included by the server
                                // when small enough). Fall back to parsing the
                                // truncated preview for an error field.
                                let error = null;
                                const result = parsed.result ?? null;
                                if (result && typeof result === 'object' && result.error) {
                                    error = String(result.error);
                                } else if (!result) {
                                    try {
                                        const obj = JSON.parse(parsed.preview || '{}');
                                        if (obj && obj.error) error = String(obj.error);
                                    } catch (_) { /* non-JSON preview */ }
                                }
                                finishStreamingToolCall({
                                    tool_call_id: parsed.tool_call_id,
                                    preview: parsed.preview,
                                    result,
                                    error,
                                });
                                // Close the active "Calling …" feed entry and
                                // push a follow-up so the user sees the model
                                // moving from tool execution back into
                                // reasoning. Top-of-bubble status flips to
                                // "thinking" until the next content delta or
                                // tool call arrives.
                                {
                                    const human = humanizeToolName(parsed.name);
                                    if (error) {
                                        resolveProcessingLog('failed');
                                        const msg = `${human} failed — ${String(error).slice(0, 80)}`;
                                        setProcessingStatus('thinking', `Recovering from ${human} error…`);
                                        pushProcessingLog({
                                            icon: 'alert',
                                            text: msg,
                                            kind: `tool_failed:${parsed.name}`,
                                        });
                                        // Mark this synthetic follow-up done
                                        // immediately — the next event (more
                                        // tools, content, or another error)
                                        // will become the active row.
                                        resolveProcessingLog('failed');
                                    } else {
                                        resolveProcessingLog('done');
                                        const summary = summarizeToolResult(parsed.name, result);
                                        const text = summary
                                            ? `${human} → ${summary}`
                                            : `${human} done`;
                                        setProcessingStatus('thinking', `Reading ${human} result…`);
                                        pushProcessingLog({
                                            icon: 'check',
                                            text,
                                            kind: `tool_done:${parsed.name}`,
                                        });
                                        resolveProcessingLog('done');
                                    }
                                    sawToolEventThisTurn = true;
                                }
                                continue;
                            }
                            if (parsed.type === 'tool_call_delta') {
                                // Argument fragments — we already track
                                // finalized args in tool_executing. Safe to
                                // drop these for the chip UI.
                                continue;
                            }
                            if (parsed.type === 'reasoning_reclassified') {
                                // Server detected that this turn's whole
                                // answer got routed to reasoning_content
                                // by the model's chat template (Gemma-4
                                // misroutes when the model emits a
                                // `[{"thought":""}]` JSON preamble).
                                // Swap the local buffers so the final
                                // render puts the text in the main bubble
                                // instead of keeping it stuck in the
                                // Thinking dropdown.
                                assistantContent = parsed.content || '';
                                assistantReasoning = '';
                                pendingContentRef.current = assistantContent;
                                pendingReasoningRef.current = '';
                                setStreamingContent(assistantContent);
                                setStreamingReasoning('');
                                continue;
                            }

                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                if (sawToolEventThisTurn) {
                                    setProcessingStatus('generating', 'Generating response');
                                    pushProcessingLog({
                                        icon: 'sparkles',
                                        text: 'Generating response',
                                        kind: 'generating_after_tools',
                                    });
                                    sawToolEventThisTurn = false;
                                }
                                assistantContent += delta.content;
                                // Parse <think> tags from content and separate reasoning.
                                // streaming=true keeps the parser from briefly promoting
                                // a closed <think> block to the bubble body before the
                                // first real content character arrives.
                                const thinkParsed = parseThinkTags(assistantContent, true);
                                pendingContentRef.current = thinkParsed.content;
                                if (thinkParsed.reasoning) {
                                    assistantReasoning = thinkParsed.reasoning;
                                    pendingReasoningRef.current = assistantReasoning;
                                }
                                // 60fps UI update via requestAnimationFrame — plain text
                                // rendering during streaming makes this cheap enough
                                // to run every frame without jank.
                                if (!throttleTimerRef.current) {
                                    throttleTimerRef.current = requestAnimationFrame(() => {
                                        const currentActiveId = useChatStore.getState().activeConversationId;
                                        if (currentActiveId === conversationId) {
                                            setStreamingContent(pendingContentRef.current);
                                            if (pendingReasoningRef.current) {
                                                setStreamingReasoning(pendingReasoningRef.current);
                                            }
                                        }
                                        throttleTimerRef.current = null;
                                    });
                                }
                                tokenCount++; // Approximate token count by chunks
                            }

                            // Handle explicit reasoning field from model API
                            if (delta?.reasoning) {
                                assistantReasoning += delta.reasoning;
                                pendingReasoningRef.current = assistantReasoning;
                                if (!throttleTimerRef.current) {
                                    throttleTimerRef.current = requestAnimationFrame(() => {
                                        const currentActiveId = useChatStore.getState().activeConversationId;
                                        if (currentActiveId === conversationId) {
                                            setStreamingReasoning(pendingReasoningRef.current);
                                        }
                                        throttleTimerRef.current = null;
                                    });
                                }
                            }

                            // Get actual token count from usage if available
                            if (parsed.usage?.completion_tokens) {
                                tokenCount = parsed.usage.completion_tokens;
                            }

                            // Handle map-reduce chunking progress events
                            if (parsed.type === 'chunking_progress') {
                                const { phase, totalChunks, totalTokens, totalChars, completedChunks = 0, failedChunks = 0, elapsedMs = 0, retrying, condensation, chunkTokens } = parsed;
                                const elapsed = elapsedMs > 0 ? `${Math.round(elapsedMs / 1000)}s` : '';
                                const tokenStr = totalTokens ? `${totalTokens.toLocaleString()} tokens` : '';
                                const chunkWord = (n) => n === 1 ? 'chunk' : 'chunks';

                                if (phase === 'agentic_indexed') {
                                    // Agentic flow took over — server stashed the
                                    // oversized content into an indexed attachment
                                    // and the model will walk it via query_document
                                    // / read_document_chunk tool calls. Subsequent
                                    // status comes from native_tool_call events.
                                    const charsStr = totalChars ? `${totalChars.toLocaleString()} chars` : '';
                                    const msg = `Indexed ${charsStr} into ${totalChunks} ${chunkWord(totalChunks)} — model will query/read via tools`;
                                    setProcessingStatus('processing', msg);
                                    pushProcessingLog({ icon: 'layers', text: msg, kind: 'agentic_indexed' });
                                    continue;
                                }
                                if (phase === 'starting') {
                                    let msg = 'Preparing content for parallel processing...';
                                    if (tokenStr) msg = `Preparing ${tokenStr} for parallel processing...`;
                                    if (condensation) {
                                        msg += ` (condensed ${condensation.reductionPercent}%)`;
                                    }
                                    setProcessingStatus('chunking', msg);
                                    pushProcessingLog({ icon: 'layers', text: msg, kind: 'chunk_start' });
                                } else if (phase === 'chunking') {
                                    let msg = `Splitting into ${totalChunks} ${chunkWord(totalChunks)}`;
                                    if (tokenStr) msg += ` — ${tokenStr}`;
                                    if (chunkTokens) msg += ` (~${chunkTokens.toLocaleString()} tokens/chunk)`;
                                    setProcessingStatus('chunking', msg);
                                    pushProcessingLog({ icon: 'scissors', text: msg, kind: 'chunk_split' });
                                } else if (phase === 'map') {
                                    const done = completedChunks + failedChunks;
                                    const pct = totalChunks > 0 ? Math.round((done / totalChunks) * 100) : 0;
                                    let msg;
                                    if (retrying) {
                                        msg = `Retrying chunk ${retrying.chunk}/${totalChunks} (attempt ${retrying.attempt}/${retrying.maxRetries}) — ${elapsed}`;
                                    } else if (done === 0) {
                                        msg = `Analyzing ${totalChunks} ${chunkWord(totalChunks)} in parallel`;
                                        if (tokenStr) msg += ` — ${tokenStr} total`;
                                    } else {
                                        msg = `Analyzed ${completedChunks}/${totalChunks} ${chunkWord(totalChunks)} (${pct}%)`;
                                        if (failedChunks) msg += ` — ${failedChunks} failed`;
                                        if (elapsed) msg += ` — ${elapsed}`;
                                    }
                                    setProcessingStatus('processing', msg);
                                    pushProcessingLog({ icon: 'cpu', text: msg, kind: 'chunk_map' });
                                } else if (phase === 'reduce') {
                                    let msg = `Synthesizing ${completedChunks} ${chunkWord(completedChunks)} into final response`;
                                    if (elapsed) msg += ` — ${elapsed} elapsed`;
                                    setProcessingStatus('synthesizing', msg);
                                    pushProcessingLog({ icon: 'combine', text: msg, kind: 'chunk_reduce' });
                                } else if (phase === 'complete') {
                                    setProcessingStatus('generating', `Streaming synthesized response${elapsed ? ` — completed in ${elapsed}` : ''}...`);
                                    pushProcessingLog({ icon: 'sparkles', text: 'Streaming synthesized response', kind: 'chunk_complete' });
                                }
                                continue; // Don't process this as a content event
                            }

                            // Handle memory injection notice (server pulled in
                            // relevant memories from earlier in this convo as
                            // context for this turn).
                            if (parsed.type === 'memory_injected') {
                                const count = parsed.count || 0;
                                const tokens = parsed.tokens || 0;
                                const noun = count === 1 ? 'memory' : 'memories';
                                const msg = `Referenced ${count} ${noun} from this conversation (${tokens} tokens)`;
                                pushProcessingLog({ icon: 'brain', text: msg, kind: 'memory_injected' });
                                showSnackbar(msg, 'info');
                                continue;
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

                            // Handle auto-continuation events (server auto-continues when response hits length limit)
                            if (parsed.type === 'auto_continuation') {
                                setProcessingStatus('generating', `Auto-continuing response (${parsed.continuation}/${parsed.maxContinuations})...`);
                                continue;
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
                                    const maxReached = parsed.autoContinuation?.maxReached;
                                    showSnackbar(
                                        maxReached
                                            ? 'Response reached max auto-continuations. Click "Continue" to resume.'
                                            : 'Response was cut off due to length limit. Click "Continue" to resume.',
                                        'warning'
                                    );
                                }
                            }

                            // Log auto-continuation summary
                            if (parsed.autoContinuation) {
                                console.log(`[Chat] Response used ${parsed.autoContinuation.continuations} auto-continuation(s)`);
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
            } catch (streamError) {
                // Catch any unexpected errors during stream processing
                console.error('Unexpected stream error:', streamError);
                if (!inStreamError) {
                    inStreamError = streamError.message || 'An error occurred while processing the response';
                }
            }

            // Final flush of any pending throttled content
            if (throttleTimerRef.current) {
                cancelAnimationFrame(throttleTimerRef.current);
                throttleTimerRef.current = null;
            }
            const currentActiveIdFlush = useChatStore.getState().activeConversationId;
            if (currentActiveIdFlush === conversationId) {
                if (pendingContentRef.current) {
                    setStreamingContent(pendingContentRef.current);
                }
                if (pendingReasoningRef.current) {
                    setStreamingReasoning(pendingReasoningRef.current);
                }
            }
            pendingContentRef.current = '';
            pendingReasoningRef.current = '';

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

            // Fold any native tool calls observed during streaming into the
            // same `toolCalls` array used by the existing client-side tools.
            // Mapping to ToolCallBlock's shape: type='native_tool_call',
            // status=success/failed, resultCount=n/a, label="<name>(args)".
            const nativeToolCallEntries = useChatStore.getState().streamingToolCalls || [];
            for (const tc of nativeToolCallEntries) {
                let argPreview = '';
                let parsedArgsForChip = null;
                if (tc.arguments) {
                    try {
                        parsedArgsForChip = JSON.parse(tc.arguments);
                        const pairs = Object.entries(parsedArgsForChip)
                            .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`);
                        argPreview = pairs.join(', ');
                    } catch (_) {
                        argPreview = String(tc.arguments).slice(0, 80);
                    }
                }
                // Pull link references from the structured result when the
                // tool was a search / URL fetch — promotes them to the
                // top-level `sources` field so SearchSources can render
                // clickable cards below the chip, matching the old
                // client-side web-search UX.
                const sources = extractSources(tc.name, tc.result);
                // Lift the chartSpec / summary out of `tc.result` for
                // render_chart calls so the chip carries just the chart
                // payload — not the full tool result, which for other
                // tools (fetch_url, web_search) would bloat the persisted
                // message and SSE round-trips with redundant data.
                const tcChartSpec = (tc.result && typeof tc.result === 'object' && tc.result.chartSpec) ? tc.result.chartSpec : null;
                const tcChartSummary = (tc.result && typeof tc.result === 'object' && typeof tc.result.summary === 'string') ? tc.result.summary : '';
                // Lift the _artifacts list out of the tool result so the chip
                // (and the inline links rendered below the bubble) can show
                // download buttons. Same shape as chartSpec lifting — keeps
                // the persisted message lean by carrying just the artifact
                // metadata, not the full tool_result payload.
                const tcArtifacts = (
                    tc.result && typeof tc.result === 'object' && Array.isArray(tc.result._artifacts)
                        ? tc.result._artifacts
                            .filter(a => a && typeof a === 'object' && typeof a.url === 'string' && typeof a.name === 'string')
                            .map(a => ({ name: a.name, size: a.size, url: a.url, runId: a.runId }))
                        : null
                );
                toolCalls.push({
                    type: 'native_tool_call',
                    label: tc.name || 'tool',
                    query: argPreview,
                    args: parsedArgsForChip,
                    durationMs: tc.durationMs,
                    status: tc.status === 'running' ? 'partial'
                        : tc.status === 'success' ? 'success'
                        : 'failed',
                    error: tc.error,
                    preview: tc.preview,
                    sources: sources && sources.length ? sources : undefined,
                    chartSpec: tcChartSpec || undefined,
                    chartSummary: tcChartSummary || undefined,
                    artifacts: tcArtifacts && tcArtifacts.length ? tcArtifacts : undefined,
                    // Sandbox metadata for the chip badge. Undefined when the
                    // server didn't supply it (older stream or native tool
                    // for which the policy couldn't be resolved).
                    sandboxed: tc.sandboxed,
                    sandboxSource: tc.sandboxSource,
                    sandboxNetwork: tc.sandboxNetwork,
                });
            }

            // Use the messages we had at the start (updatedMessages) since the user may have switched
            // This ensures we save to the correct conversation
            let finalMessages = [...updatedMessages];

            // Handle connection lost — server continues in background, don't persist anything.
            // Just transition to background polling so the UI picks up when the server finishes.
            if (connectionLost) {
                if (!userSwitchedConversation) {
                    // Immediately check for background streaming and start polling
                    checkActiveStreaming(conversationId);
                }
                // Skip saving partial content or error messages — the server
                // will save the complete response when it finishes.
            } else if (inStreamError) {
                // Genuine server-sent error (not a network disconnect)
                // Save partial content if any, then show error
                const partialMessage = finalContent.trim()
                    ? {
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: finalContent,
                        reasoning: finalReasoning,
                        timestamp: new Date().toISOString(),
                        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                        responseTime,
                        tokenCount: tokenCount > 0 ? tokenCount : undefined,
                        isPartial: true,
                    }
                    : null;
                const errorMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: `Error: ${inStreamError}`,
                    isError: true,
                    timestamp: new Date().toISOString(),
                };
                if (partialMessage) finalMessages = [...finalMessages, partialMessage];
                finalMessages = [...finalMessages, errorMessage];
                // Atomic commit — partial (if any) + error together, plus
                // clearing streaming, so no frame has the streaming bubble
                // visible alongside the new final bubbles.
                if (!userSwitchedConversation) {
                    commitStreamingMessage([partialMessage, errorMessage]);
                }
                saveMessages(conversationId, finalMessages);
                messageSaved = true;

                showSnackbar(inStreamError, 'error');
            } else {
                // Normal completion or user-stopped
                const stoppedByUser = lastFinishReason === 'stop_by_user';
                const needsContinuation = lastFinishReason === 'length';

                const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: finalContent,
                    reasoning: finalReasoning,
                    timestamp: new Date().toISOString(),
                    // Link references now travel inside individual toolCalls
                    // entries (native_tool_call.sources) rather than on a
                    // message-level searchResults field — see extractSources
                    // in ChatContainer and SearchSources in ToolCallBlock.
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                    responseTime,
                    tokenCount: tokenCount > 0 ? tokenCount : undefined,
                    needsContinuation, // Mark if response was cut off by length
                    isPartial: needsContinuation, // Only show continuation UI for length cutoffs
                };

                finalMessages = [...finalMessages, assistantMessage];
                // Only update local store if still on same conversation.
                // (If user switched away, the stream was aborted and this
                // path won't execute — server handles the save.)
                // Commit the final message AND clear streaming state in a
                // single atomic store update so there's no frame where
                // both the message-list bubble and the StreamingMessage
                // bubble are rendered side-by-side. Without this the user
                // saw the finished response briefly "underneath" the final
                // bubble before the streaming one unmounted.
                if (!userSwitchedConversation) {
                    commitStreamingMessage(assistantMessage);
                }
                saveMessages(conversationId, finalMessages);
                messageSaved = true;

                // Auto-continue if response was cut off by length limit
                // The server already auto-continues up to 8 times, so this only fires
                // if the server hit its max or the continuation failed
                if (needsContinuation && !userSwitchedConversation && finalContent.length > 0) {
                    console.log('[Chat] Auto-continuing response from frontend...');
                    // Small delay to let state settle, then auto-continue
                    setTimeout(() => {
                        handleContinueResponse(assistantMessage.id, finalContent);
                    }, 500);
                }

                if (stoppedByUser) {
                    showSnackbar('Generation stopped', 'info');
                } else if (userSwitchedConversation) {
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
                // Only show "Generation stopped" for explicit user stop, not conversation switch
                if (switchingConversationRef.current) {
                    // Silently handle - user switched conversations, server continues in background
                    switchingConversationRef.current = false;
                } else {
                    showSnackbar(message, 'info');
                }
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
            // Always stop background polling — if handleSendMessage completed
            // (saved or errored), any concurrent poll is redundant and would
            // create duplicate messages.
            clearBackgroundPoll();

            if (connectionLost) {
                // Connection was lost — restart background polling to track
                // the server-side stream that's still running.
                checkActiveStreaming(conversationId);
                abortControllerRef.current = null;
                switchingConversationRef.current = false;
            } else {
                // Only clear loading/streaming UI if we're still on the same conversation
                const currentActiveId = useChatStore.getState().activeConversationId;
                if (currentActiveId === conversationId) {
                    // If the normal save path didn't run (e.g. an exception was thrown
                    // between stream end and addMessage), rescue the response from the
                    // streaming content so it doesn't vanish.
                    if (!messageSaved) {
                        const streamContent = useChatStore.getState().streamingContent;
                        if (streamContent && streamContent.trim()) {
                            console.warn('[Chat] Message was not saved — rescuing from streaming content');
                            const parsed = parseThinkTags(streamContent);
                            if (parsed.content.trim()) {
                                const rescuedMessage = {
                                    id: crypto.randomUUID(),
                                    role: 'assistant',
                                    content: parsed.content,
                                    reasoning: parsed.reasoning || undefined,
                                    timestamp: new Date().toISOString(),
                                    responseTime: Date.now() - startTime,
                                    isPartial: true,
                                };
                                // Atomic append + streaming-clear so the
                                // rescued bubble replaces the streaming
                                // bubble in a single frame.
                                commitStreamingMessage(rescuedMessage);
                                const currentMsgs = useChatStore.getState().messages;
                                try {
                                    await saveMessages(conversationId, currentMsgs);
                                } catch (e) {
                                    console.error('[Chat] Failed to save rescued message:', e);
                                }
                            } else {
                                clearStreaming();
                            }
                        } else {
                            clearStreaming();
                        }
                    } else {
                        clearStreaming();
                    }

                    setIsLoading(false);
                    clearProcessingStatus();
                }
                streamingConversationRef.current = null;
                abortControllerRef.current = null;
                switchingConversationRef.current = false;
            }
        }
    };

    const handleStopGeneration = async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        // Stop any active background polling
        clearBackgroundPoll();
        // Immediate UI feedback — don't wait for the async cleanup
        setIsLoading(false);
        setProcessingStatus(null, null);

        // Also cancel the server-side background stream
        const convId = streamingConversationRef.current || activeConversationId;
        if (convId) {
            try {
                const cancelRes = await fetch(`/api/conversations/${convId}/streaming`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
                if (cancelRes.ok) {
                    const result = await cancelRes.json();
                    if (result.cancelled) {
                        // Reload messages to pick up the saved partial response
                        if (result.hadContent) {
                            const msgResponse = await fetch(`/api/conversations/${convId}`, { credentials: 'include' });
                            if (msgResponse.ok) {
                                const msgData = await msgResponse.json();
                                setMessages(msgData.messages || []);
                            }
                        }
                        clearStreaming();
                    }
                }
            } catch (e) {
                // Cancel request failed — not critical
            }
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

        // Create a continuation prompt (sent to API only, not shown in UI)
        const continuationPrompt = "Continue from where you left off. Do not repeat what you already said, just continue directly.";

        // Get current messages
        const currentMsgs = useChatStore.getState().messages;

        // Build messages array with the continuation prompt
        const apiMessages = currentMsgs.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // Add continuation prompt to API request only (not visible in chat)
        apiMessages.push({
            role: 'user',
            content: continuationPrompt
        });

        // Find the original message and remember its position
        const originalMsg = currentMsgs.find(m => m.id === messageId);
        const originalContent = originalMsg?.content || messageContent || '';
        const originalReasoning = originalMsg?.reasoning || '';
        const originalMsgIndex = currentMsgs.findIndex(m => m.id === messageId);

        // Temporarily hide the original message so the streaming bubble replaces it
        // (avoids showing two bubbles: original + streaming continuation)
        const msgsWithoutOriginal = currentMsgs.filter(m => m.id !== messageId);
        setMessages(msgsWithoutOriginal);

        // Start streaming - seed with original content so continuation appears in same bubble
        streamingConversationRef.current = conversationId;
        setIsLoading(true);
        setStreaming(true);
        setStreamingContent(originalContent);
        setStreamingReasoning(originalReasoning);
        setProcessingStatus('thinking', 'Continuing response...');
        abortControllerRef.current = new AbortController();

        // Capture messages at start for proper saving even if user switches
        const messagesAtStart = [...currentMsgs];

        const startTime = Date.now();

        try {
            const requestBody = {
                model: settings.model,
                messages: apiMessages,
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens || undefined,  // Only send if explicitly set; backend uses smart defaults
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
            let inStreamError = null;

            // Wrap stream reading in try-catch to handle network errors
            try {
                while (true) {
                    let readResult;
                    try {
                        readResult = await reader.read();
                    } catch (readError) {
                        if (readError.name === 'AbortError') {
                            // User manually stopped continuation - not an error
                            lastFinishReason = 'stop_by_user';
                        } else {
                            // Network error — server continues in background
                            console.log('[Chat] Continuation stream connection lost — server continues in background');
                            // Check for background streaming instead of saving error
                            checkActiveStreaming(conversationId);
                            return; // Exit early — background poll handles the rest
                        }
                        break;
                    }

                    const { done, value } = readResult;
                    if (done) break;

                    let decodedChunk;
                    try {
                        decodedChunk = decoder.decode(value, { stream: true });
                    } catch (decodeError) {
                        console.error('Continuation decode error:', decodeError);
                        inStreamError = 'Error decoding response data';
                        break;
                    }

                    buffer += decodedChunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') continue;
                            if (!data) continue;

                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.error) {
                                    inStreamError = typeof parsed.error === 'object'
                                        ? parsed.error.message || JSON.stringify(parsed.error)
                                        : parsed.error;
                                    continue;
                                }
                                if (parsed.type === 'reasoning_reclassified') {
                                    // Continuation path mirror of the main-stream handler.
                                    // See the main loop for rationale — server detected
                                    // that the whole turn's output got misrouted to
                                    // reasoning_content by the model template.
                                    assistantContent = parsed.content || '';
                                    assistantReasoning = '';
                                    const currentActiveId = useChatStore.getState().activeConversationId;
                                    if (currentActiveId === conversationId) {
                                        setStreamingContent(originalContent + '\n\n' + assistantContent);
                                        setStreamingReasoning(originalReasoning || '');
                                    }
                                    continue;
                                }

                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content) {
                                    assistantContent += delta.content;
                                    const thinkParsed = parseThinkTags(assistantContent, true);
                                    // Show original content + continuation in the same streaming bubble
                                    const currentActiveId = useChatStore.getState().activeConversationId;
                                    if (currentActiveId === conversationId) {
                                        setStreamingContent(originalContent + '\n\n' + thinkParsed.content);
                                        if (thinkParsed.reasoning) {
                                            assistantReasoning = thinkParsed.reasoning;
                                            const combinedReasoning = originalReasoning
                                                ? originalReasoning + '\n\n' + assistantReasoning
                                                : assistantReasoning;
                                            setStreamingReasoning(combinedReasoning);
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
                                        const combinedReasoning = originalReasoning
                                            ? originalReasoning + '\n\n' + assistantReasoning
                                            : assistantReasoning;
                                        setStreamingReasoning(combinedReasoning);
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
            } catch (streamError) {
                console.error('Unexpected continuation stream error:', streamError);
                if (!inStreamError) {
                    inStreamError = streamError.message || 'An error occurred while processing the response';
                }
            }

            // If there was an error, throw it to be caught by the outer catch
            if (inStreamError && !assistantContent.trim()) {
                throw new Error(inStreamError);
            }

            const responseTime = Date.now() - startTime;
            const finalParsed = parseThinkTags(assistantContent);
            const finalContent = finalParsed.content;
            const finalReasoning = finalParsed.reasoning || assistantReasoning || undefined;
            const stoppedByUser = lastFinishReason === 'stop_by_user';
            const needsContinuation = lastFinishReason === 'length';

            // Check if user switched conversations
            const currentActiveId = useChatStore.getState().activeConversationId;
            const userSwitchedConversation = currentActiveId !== conversationId;

            // Merge continuation content into the original message and restore it
            const mergedMsg = {
                ...originalMsg,
                content: finalContent.trim()
                    ? originalContent + '\n\n' + finalContent
                    : originalContent,
                reasoning: finalReasoning
                    ? (originalReasoning ? originalReasoning + '\n\n' + finalReasoning : finalReasoning)
                    : originalReasoning || undefined,
                responseTime: (originalMsg.responseTime || 0) + responseTime,
                tokenCount: ((originalMsg.tokenCount || 0) + (tokenCount > 0 ? tokenCount : 0)) || undefined,
                needsContinuation,
                isPartial: needsContinuation,
            };

            // Restore the merged message at its original position
            const currentMsgs = useChatStore.getState().messages;
            const restoredMessages = [...currentMsgs];
            restoredMessages.splice(originalMsgIndex, 0, mergedMsg);

            if (!userSwitchedConversation) {
                setMessages(restoredMessages);
            }
            saveMessages(conversationId, restoredMessages);

            if (stoppedByUser) {
                showSnackbar('Generation stopped', 'info');
            } else if (userSwitchedConversation) {
                showSnackbar('Response completed in background', 'success');
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
                // Ensure the original message is restored even if an error occurred.
                // The try block may have removed it from the list for the streaming UX.
                const currentMsgs = useChatStore.getState().messages;
                const msgStillPresent = currentMsgs.some(m => m.id === messageId);
                if (!msgStillPresent && originalMsg) {
                    // Restore original (unmodified) message at its position
                    const restored = [...currentMsgs];
                    restored.splice(originalMsgIndex, 0, originalMsg);
                    setMessages(restored);
                    saveMessages(conversationId, restored);
                    console.log(`[Chat] Restored original message after continuation error`);
                }

                setIsLoading(false);
                clearStreaming();
                clearProcessingStatus();
            }
            streamingConversationRef.current = null;
            abortControllerRef.current = null;
            switchingConversationRef.current = false;
        }
    };

    // Stable callback wrapper — keeps the same reference across re-renders
    // so React.memo on ChatMessages doesn't break. The ref always points to
    // the latest handleContinueResponse without creating a new closure.
    handleContinueRef.current = handleContinueResponse;
    const stableHandleContinue = React.useCallback(
        (...args) => handleContinueRef.current(...args),
        []
    );

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

    // Detect artifacts (code blocks) from assistant messages.
    const artifacts = useMemo(() => extractArtifacts(messages), [messages]);
    const activeConversation = conversations.find(c => c.id === activeConversationId);
    const breadcrumb = activeConversation
        ? ['Chat', activeConversation.title || 'Untitled']
        : ['Chat'];

    return (
        <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg)' }}>
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
                collapsed={sidebarCollapsed}
                onToggleCollapsed={() => setSidebarCollapsed(c => !c)}
            />

            {/* Main chat area */}
            <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg)', minWidth: 0 }}>
                {/* Header */}
                <ChatHeader
                    onSettingsClick={() => setSettingsOpen(true)}
                    user={user}
                    onLogout={onLogout}
                    sidebarCollapsed={sidebarCollapsed}
                    onOpenSidebar={() => setSidebarCollapsed(false)}
                    onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
                    breadcrumb={breadcrumb}
                    artifactsOpen={artifactsOpen}
                    onToggleArtifacts={artifacts.length > 0 ? () => setArtifactsOpen(o => !o) : null}
                />

                {/* Content area - centered when empty, normal when messages */}
                {chatIsEmpty ? (
                    <div className="flex-1 flex flex-col items-center justify-center px-4 pb-[8vh] supports-[height:100svh]:pb-[8svh]">
                        <div className="w-full max-w-2xl">
                            <ChatInput
                                onSend={handleSendMessage}
                                onStop={handleStopGeneration}
                                isStreaming={isStreaming}
                                disabled={!settings.model}
                                attachments={attachments}
                                onAddAttachment={addAttachment}
                                onRemoveAttachment={removeAttachment}
                                onClearAllAttachments={clearAttachments}
                                onUploadError={(msg) => showSnackbar(msg, 'error')}
                                systemPrompts={systemPrompts}
                                selectedSystemPromptId={settings.selectedSystemPromptId}
                                onSystemPromptSelect={(id) => updateSettings({ selectedSystemPromptId: id })}
                                messages={messages}
                                maxContextTokens={selectedModelContextSize}
                                models={combinedModels}
                                selectedModel={settings.model}
                                onModelChange={handleModelChange}
                            />
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Messages */}
                        <div className={`flex-1 min-h-0 overflow-hidden flex flex-col${slideDown ? ' animate-messages-enter' : ''}`}>
                            <ChatMessages
                                messages={messages}
                                isStreaming={isStreaming}
                                onContinue={stableHandleContinue}
                                isLoading={isLoading}
                                chatStyle={settings.chatStyle}
                                messageBorderStrength={settings.messageBorderStrength}
                                onOpenArtifacts={artifacts.length > 0 ? () => setArtifactsOpen(true) : null}
                                header={activeConversation ? (
                                    <ConvoHeader
                                        title={activeConversation.title}
                                        createdAt={activeConversation.createdAt}
                                        messageCount={messages.length}
                                        estimatedTokens={Math.ceil(
                                            messages.reduce((sum, m) => sum + (m.content?.length || 0) + (m.reasoning?.length || 0), 0) / 4
                                        )}
                                        maxContextTokens={selectedModelContextSize || 0}
                                        favorite={activeConversation.favorite}
                                        onToggleFavorite={() => handleToggleFavorite(activeConversation.id)}
                                    />
                                ) : null}
                            />
                        </div>

                        {/* Input - slides down from center on first message */}
                        <div className={`flex-shrink-0 input-area ${slideDown ? 'animate-input-slide-down' : ''}`}>
                            <ChatInput
                                onSend={handleSendMessage}
                                onStop={handleStopGeneration}
                                isStreaming={isStreaming}
                                disabled={!settings.model}
                                attachments={attachments}
                                onAddAttachment={addAttachment}
                                onRemoveAttachment={removeAttachment}
                                onClearAllAttachments={clearAttachments}
                                onUploadError={(msg) => showSnackbar(msg, 'error')}
                                systemPrompts={systemPrompts}
                                selectedSystemPromptId={settings.selectedSystemPromptId}
                                onSystemPromptSelect={(id) => updateSettings({ selectedSystemPromptId: id })}
                                messages={messages}
                                maxContextTokens={selectedModelContextSize}
                                models={combinedModels}
                                selectedModel={settings.model}
                                onModelChange={handleModelChange}
                            />
                        </div>
                    </>
                )}
            </div>

            {/* Artifacts side panel */}
            <ArtifactsPanel
                open={artifactsOpen && artifacts.length > 0}
                artifacts={artifacts}
                activeId={activeArtifactId}
                onSelect={setActiveArtifactId}
                onClose={() => setArtifactsOpen(false)}
            />

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
                contextSize={selectedModelContextSize}
                activeConversationId={activeConversationId}
                activeConversationTitle={conversations.find(c => c.id === activeConversationId)?.title || ''}
            />
        </div>
    );
}
