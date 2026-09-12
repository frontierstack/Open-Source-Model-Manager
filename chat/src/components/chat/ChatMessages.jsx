import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import ChatMessage from './ChatMessage';
import { useChatStore } from '../../stores/useChatStore';

/**
 * StreamingMessage — reads streaming content directly from the Zustand store
 * via selectors so that only THIS component re-renders on each token, not the
 * entire ChatContainer → ChatMessages prop chain.
 */
function StreamingMessage() {
    const streamingContent = useChatStore(state => state.streamingContent);
    const streamingReasoning = useChatStore(state => state.streamingReasoning);
    const streamingToolCalls = useChatStore(state => state.streamingToolCalls);
    const streamingStatus = useChatStore(state => state.streamingStatus);
    // Two-model pairing: who is working right now (primary, secondary, or both)
    // and what each is doing. Live for this turn only; nothing persists.
    const streamingHandoff = useChatStore(state => state.streamingHandoff);

    // Map the in-flight tool records to the ToolCallBlock shape so chips can
    // render live alongside streaming content.
    const liveToolCalls = (streamingToolCalls || []).map(tc => {
        // A chip handed over by the server on reconnect is already in the
        // persisted shape — render it as-is.
        if (tc.chip && typeof tc.chip === 'object') return { ...tc.chip };
        let argPreview = '';
        // Parsed args mid-flight too, so the chip's args table renders the
        // structured view (delegate's per-task lines) instead of raw JSON.
        let parsedArgs = null;
        if (tc.arguments) {
            try {
                const args = JSON.parse(tc.arguments);
                parsedArgs = args;
                argPreview = Object.entries(args)
                    .map(([k, v]) => {
                        let s;
                        if (v == null) s = String(v);
                        else if (typeof v === 'string') s = v;
                        else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
                        return `${k}: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
                    })
                    .join(', ');
            } catch (_) { argPreview = (String(tc.arguments).length > 80 ? String(tc.arguments).slice(0, 80) + '…' : String(tc.arguments)); }
        }
        // Surface link references for web_search / fetch_url live too.
        let sources = null;
        const r = tc.result;
        if (r && typeof r === 'object') {
            const snip = (c) => (typeof c === 'string' ? c.slice(0, 220) : '');
            if (tc.name === 'web') {
                if (Array.isArray(r.results)) {
                    sources = r.results
                        .filter(x => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url))
                        .map(x => ({ url: x.url, title: x.title || '', snippet: x.snippet || snip(x.content) }));
                } else if (Array.isArray(r.pages)) {
                    sources = r.pages
                        .filter(p => p && typeof p.url === 'string' && /^https?:\/\//.test(p.url))
                        .map(p => ({ url: p.url, title: p.title || '', snippet: snip(p.content) }));
                } else if (typeof r.url === 'string' && /^https?:\/\//.test(r.url)) {
                    sources = [{ url: r.url, title: r.title || '', snippet: snip(r.content) }];
                }
            } else if (tc.name === 'web_search' && Array.isArray(r.results)) {
                sources = r.results
                    .filter(x => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url))
                    .map(x => ({ url: x.url, title: x.title || '', snippet: x.snippet || '' }));
            } else if (tc.name === 'fetch_url' && typeof r.url === 'string' && /^https?:\/\//.test(r.url)) {
                sources = [{ url: r.url, title: r.title || '',
                             snippet: typeof r.content === 'string' ? r.content.slice(0, 220) : '' }];
            }
        }
        // Lift rich render specs onto the LIVE chip the same way the committed
        // path (buildNativeChipEntries) does — without these, find_image's
        // imageSpec (and find_video's videoSpec / render_chart's chartSpec /
        // sandbox artifacts) only appeared after the stream finished and the
        // message was committed.
        const tcChartSpec = (r && typeof r === 'object' && r.chartSpec) ? r.chartSpec : null;
        const tcChartSummary = (r && typeof r === 'object' && typeof r.summary === 'string') ? r.summary : '';
        const tcImageSpec = (r && typeof r === 'object' && r.imageSpec && Array.isArray(r.imageSpec.images)) ? r.imageSpec : null;
        const tcVideoSpec = (r && typeof r === 'object' && r.videoSpec && Array.isArray(r.videoSpec.videos)) ? r.videoSpec : null;
        const tcArtifacts = (
            r && typeof r === 'object' && Array.isArray(r._artifacts)
                ? r._artifacts
                    .filter(a => a && typeof a === 'object' && typeof a.url === 'string' && typeof a.name === 'string')
                    .map(a => ({ name: a.name, size: a.size, url: a.url, runId: a.runId }))
                : null
        );
        return {
            type: 'native_tool_call',
            label: tc.name,
            purpose: tc.purpose || undefined,
            query: argPreview,
            args: parsedArgs || undefined,
            durationMs: tc.durationMs,
            // Drives ToolCallBlock's live "running… 4.2s" clock.
            startedAt: tc.startedAt,
            status: tc.status === 'running' ? 'partial'
                : tc.status === 'success' ? 'success'
                : 'failed',
            error: tc.error,
            preview: tc.preview,
            sources: sources && sources.length ? sources : undefined,
            chartSpec: tcChartSpec || undefined,
            chartSummary: tcChartSummary || undefined,
            imageSpec: tcImageSpec || undefined,
            videoSpec: tcVideoSpec || undefined,
            artifacts: tcArtifacts && tcArtifacts.length ? tcArtifacts : undefined,
            sandboxed: tc.sandboxed,
            sandboxSource: tc.sandboxSource,
            sandboxNetwork: tc.sandboxNetwork,
            // Which model made this call — paired turns only, so a
            // single-model chat shows no attribution on the chip.
            model: tc.model || undefined,
            // delegate: live worker-agent progress (delegate_progress frames)
            // and, once the result is in, each agent's compact outcome.
            agents: Array.isArray(tc.agents) && tc.agents.length ? tc.agents : undefined,
            agentResults: (tc.name === 'delegate' && r && typeof r === 'object' && Array.isArray(r.results))
                ? r.results.slice(0, 8).map(x => ({
                    name: x && x.name, status: x && x.status, model: x && x.model, calls: x && x.toolCalls, seconds: x && x.seconds,
                    tools: Array.isArray(x && x.tools) ? x.tools.slice(0, 12) : [],
                    answerChars: x && typeof x.answer === 'string' ? x.answer.length : undefined,
                    review: x && x.review ? { verdict: x.review.verdict, edited: !!x.review.edited, issues: Array.isArray(x.review.issues) ? x.review.issues.length : 0 } : undefined,
                }))
                : undefined,
        };
    });

    // The background jobs the lead handed back ride on the ask_assistant chip
    // that dispatched them — live, and then on the saved message. The frames
    // are cumulative for the turn, so the newest such chip carries the list.
    const liveJobs = (streamingHandoff && Array.isArray(streamingHandoff.jobs)) ? streamingHandoff.jobs : [];
    if (liveJobs.length) {
        for (let i = liveToolCalls.length - 1; i >= 0; i--) {
            if (liveToolCalls[i] && liveToolCalls[i].label === 'ask_assistant') {
                liveToolCalls[i] = { ...liveToolCalls[i], assistantJobs: liveJobs };
                break;
            }
        }
    }

    return (
        <ChatMessage
            key="streaming-message"
            role="assistant"
            content={streamingContent}
            reasoning={streamingReasoning}
            isStreaming={true}
            streamingContent={streamingContent}
            streamingReasoning={streamingReasoning}
            toolCalls={liveToolCalls.length ? liveToolCalls : undefined}
            streamingStatus={streamingStatus}
            handoff={streamingHandoff}
            modelName={assistantLabel({
                answeredBy: streamingHandoff && (streamingHandoff.lead || streamingHandoff.primary),
            })}
            modelTitle={(streamingHandoff && streamingHandoff.phase === 'solo' && streamingHandoff.reason)
                ? `Answered without handing over — ${streamingHandoff.reason}`
                : undefined}
            assistedBy={(streamingHandoff && streamingHandoff.phase === 'lead')
                ? (streamingHandoff.assistant || streamingHandoff.helper || undefined)
                : undefined}
        />
    );
}

// The bubble's name in the meta row. With two models paired it names the one
// that WROTE this answer, so the transcript is never anonymous about which
// model did the work; with a single model it returns undefined and the bubble
// reads "Assistant" exactly as before.
function assistantLabel(message) {
    if (!message) return undefined;
    const parts = [];
    if (message.parallel) parts.push('parallel');
    if (message.answeredBy) parts.push(message.answeredBy);
    return parts.length ? `Assistant · ${parts.join(' · ')}` : undefined;
}

/**
 * ChatMessages - Scrollable message list with auto-scroll (Tailwind)
 *
 * Wrapped in React.memo — only re-renders when messages, isStreaming, or
 * layout props change. Streaming content updates bypass this component
 * entirely (StreamingMessage reads from the store directly).
 */
// A parallel (sidecar) reply in flight: the user's message plus a live
// assistant bubble fed by the poll — its own response window, so a second
// question on a free slot streams next to the first instead of hiding in a
// composer pill. Committed into `messages` in order once the first reply lands.
function ParallelTurn({ turn }) {
    const running = Array.isArray(turn.runningToolCalls) ? turn.runningToolCalls : [];
    // Smooth reveal: the poll delivers text in ~600 ms lumps; reveal the
    // backlog a slice per animation frame (same feel as the foreground
    // bubble's pump) so the second window reads as streaming, not jumping.
    const targetText = (turn.status === 'done' && turn.result) ? (turn.result.content || '') : (turn.partial || '');
    const [shown, setShown] = useState(turn.status === 'done' ? targetText : '');
    const shownRef = useRef(shown);
    const targetRef = useRef(targetText);
    targetRef.current = targetText;
    useEffect(() => {
        if (turn.status === 'done') { shownRef.current = targetText; setShown(targetText); return undefined; }
        let raf = 0;
        let cancelled = false;
        const step = () => {
            if (cancelled) return;
            const target = targetRef.current;
            const cur = shownRef.current;
            if (!target.startsWith(cur)) { shownRef.current = target; setShown(target); }
            else if (cur.length < target.length) {
                const backlog = target.length - cur.length;
                // ~12% of the backlog per frame, at least 2 chars, at most 40 —
                // finishes a 600 ms lump in ~40 frames without racing ahead.
                const take = Math.max(2, Math.min(40, Math.ceil(backlog * 0.12)));
                const next = target.slice(0, cur.length + take);
                shownRef.current = next; setShown(next);
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => { cancelled = true; cancelAnimationFrame(raf); };
    }, [turn.status, turn.status === 'done' ? targetText : '']);
    const done = Array.isArray(turn.toolChips) ? turn.toolChips : [];
    const liveToolCalls = [
        ...done.map(c => ({ ...c })),
        ...running.map(rc => ({
            type: 'native_tool_call',
            label: rc.name || 'tool',
            purpose: rc.purpose || undefined,
            query: typeof rc.arguments === 'string' ? rc.arguments.slice(0, 80) : '',
            startedAt: rc.startedAt,
            status: 'partial',
        })),
    ];
    const content = turn.status === 'done' ? targetText : shown;
    const isLive = turn.status !== 'done';
    const statusText = turn.status === 'done'
        ? 'Finished — will be placed after the current reply'
        : (turn.progress ? `In parallel — ${turn.progress}` : 'In parallel — starting');
    return (
        <div className="parallel-turn" style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 10, marginTop: 6, opacity: 0.97 }}>
            <ChatMessage
                key={`${turn.id}-user`}
                id={`${turn.id}-user`}
                role="user"
                content={turn.content}
                attachments={turn.userMessage && turn.userMessage.attachments}
                timestamp={turn.userMessage && turn.userMessage.timestamp}
                isStreaming={false}
            />
            <ChatMessage
                key={`${turn.id}-assistant`}
                role="assistant"
                modelName="Assistant · parallel"
                content={content}
                isStreaming={isLive}
                streamingContent={content}
                toolCalls={liveToolCalls.length ? liveToolCalls : undefined}
                streamingStatus={{ text: statusText }}
                responseTime={turn.status === 'done' && turn.result ? turn.result.responseTime : undefined}
            />
            {!isLive && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-4)', margin: '2px 0 8px' }}>{statusText}</div>
            )}
        </div>
    );
}

const ChatMessages = React.memo(function ChatMessages({
    messages,
    isStreaming,
    parallelTurns = [],
    onContinue,
    isLoading,
    chatStyle = 'default',
    messageBorderStrength = 10,
    header,
    onOpenArtifacts,
}) {
    const messagesEndRef = useRef(null);
    const containerRef = useRef(null);
    const [userHasScrolled, setUserHasScrolled] = useState(false);
    const prevMessagesLengthRef = useRef(messages.length);
    const prevStreamingRef = useRef(isStreaming);

    // Track if user manually scrolled up
    const handleScroll = () => {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
        setUserHasScrolled(!isNearBottom);
    };

    // Auto-scroll only when:
    // 1. New message is added (messages.length increases)
    // 2. Streaming just started
    // 3. User hasn't manually scrolled up
    useEffect(() => {
        const messagesLengthChanged = messages.length !== prevMessagesLengthRef.current;
        const streamingJustStarted = isStreaming && !prevStreamingRef.current;

        if ((messagesLengthChanged || streamingJustStarted) && !userHasScrolled) {
            if (messagesEndRef.current) {
                messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
            }
        }

        prevMessagesLengthRef.current = messages.length;
        prevStreamingRef.current = isStreaming;
    }, [messages.length, isStreaming, userHasScrolled, parallelTurns.length]);

    // Reset scroll tracking when streaming ends
    useEffect(() => {
        if (!isStreaming) {
            setUserHasScrolled(false);
        }
    }, [isStreaming]);

    // Empty state handled by ChatContainer for centered layout
    if (messages.length === 0 && !isStreaming) {
        return null;
    }

    // Get chat style class
    const chatStyleClass = chatStyle && chatStyle !== 'default' ? `chat-style-${chatStyle}` : '';

    return (
        <div
            ref={containerRef}
            onScroll={handleScroll}
            className={`flex-1 overflow-y-auto ${chatStyleClass}`}
            style={{ '--message-border-opacity': (messageBorderStrength || 10) / 100 }}
        >
            {/* Design-spec column: max-width 800, padding 28/28/8 (reduced on mobile) */}
            <div className="messages-column" style={{
                maxWidth: 800,
                width: '100%',
                margin: '0 auto',
                minWidth: 0,
            }}>
            {header}
            {messages.map((message, index) => (
                <ChatMessage
                    key={message.id || `msg-${index}-${message.timestamp || index}`}
                    id={message.id}
                    role={message.role}
                    content={message.content}
                    reasoning={message.reasoning}
                    timestamp={message.timestamp}
                    attachments={message.attachments}
                    isStreaming={false}
                    responseTime={message.responseTime}
                    tokenCount={message.tokenCount}
                    needsContinuation={message.needsContinuation}
                    isPartial={message.isPartial}
                    toolCalls={message.toolCalls}
                    modelName={assistantLabel(message)}
                    assistedBy={message.assistedBy}
                    review={message.review}
                    searchResults={message.searchResults}
                    onContinue={onContinue}
                    isLoading={isLoading}
                    onOpenArtifacts={onOpenArtifacts}
                />
            ))}

            {/* Streaming message — reads content from store directly */}
            {isStreaming && <StreamingMessage />}

            {/* Parallel replies in flight — each gets its own live window */}
            {parallelTurns.map(turn => <ParallelTurn key={turn.id} turn={turn} />)}

            <div ref={messagesEndRef} />
            </div>
        </div>
    );
});

export default ChatMessages;
