import React, { useEffect, useRef } from 'react';
import {
    Search, Link, Brain, Sparkles, Layers, Scissors, Cpu, Combine,
    Check, CheckCircle2, Edit3, Paperclip, Loader2, AlertCircle
} from 'lucide-react';

/**
 * ProcessingLogFeed
 *
 * Rolling-credits-style live feed of processing events during a streaming
 * turn. Replaces the mute "Thinking..." spinner with a scrolling list of
 * what's actually happening: web search running, N results found, URLs
 * fetched, model waiting, streaming, chunking, synthesis, etc.
 *
 * Shape of each entry (pushed from ChatContainer via useChatStore):
 *   {
 *     id:     string,
 *     at:     number (ms),
 *     icon:   'search' | 'link' | 'brain' | 'sparkles' | 'layers' |
 *             'scissors' | 'cpu' | 'combine' | 'check' | 'edit' |
 *             'paperclip' | 'alert',
 *     text:   string,
 *     status: 'active' | 'done' | 'failed',
 *     kind?:  free-form tag for styling (unused today)
 *   }
 *
 * Only the latest ~5 entries are visible at a time; older entries fade
 * upward so the feed behaves like film credits rolling past.
 */

const ICON_MAP = {
    search: Search,
    link: Link,
    brain: Brain,
    sparkles: Sparkles,
    layers: Layers,
    scissors: Scissors,
    cpu: Cpu,
    combine: Combine,
    check: CheckCircle2,
    edit: Edit3,
    paperclip: Paperclip,
    alert: AlertCircle,
};

const MAX_VISIBLE = 5;

function statusColor(status) {
    if (status === 'done') return { className: 'text-emerald-400/70' };
    if (status === 'failed') return { className: 'text-red-400/80' };
    return { className: '', style: { color: 'var(--accent)' } };
}

function statusRowColor(status) {
    if (status === 'done') return 'text-dark-300/80';
    if (status === 'failed') return 'text-red-300';
    return 'text-white';
}

export default React.memo(function ProcessingLogFeed({ log }) {
    const scrollRef = useRef(null);

    // Auto-scroll feed to the bottom whenever a new entry arrives so the
    // active line always stays in view even after many events.
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [log?.length]);

    if (!Array.isArray(log) || log.length === 0) {
        return null;
    }

    // Only show the last N entries. Older entries stay in the store but
    // fade off the top as the feed scrolls.
    const visible = log.slice(-MAX_VISIBLE);
    const firstVisibleIdx = log.length - visible.length;

    return (
        <div
            ref={scrollRef}
            className="flex flex-col gap-1 overflow-hidden text-[12px] leading-5 max-h-36 pr-1"
        >
            {visible.map((entry, idx) => {
                const Icon = ICON_MAP[entry.icon] || Sparkles;
                const isLatest = idx === visible.length - 1;
                // Entries further from the bottom fade out progressively.
                const distanceFromLatest = visible.length - 1 - idx;
                const opacity = distanceFromLatest === 0 ? 1
                    : distanceFromLatest === 1 ? 0.75
                    : distanceFromLatest === 2 ? 0.5
                    : distanceFromLatest === 3 ? 0.3
                    : 0.18;

                const isActive = entry.status === 'active' && isLatest;
                const iconColor = statusColor(entry.status);
                const textColor = statusRowColor(entry.status);

                return (
                    <div
                        key={entry.id || `log-${firstVisibleIdx + idx}`}
                        className={`flex items-center gap-2 transition-all duration-300 animate-fade-in-up ${textColor}`}
                        style={{ opacity }}
                    >
                        <span
                            className={`flex-shrink-0 flex items-center justify-center w-4 h-4 ${iconColor.className || ''}`}
                            style={iconColor.style}
                        >
                            {isActive ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : entry.status === 'done' ? (
                                <Check className="w-3.5 h-3.5" />
                            ) : (
                                <Icon className="w-3.5 h-3.5" />
                            )}
                        </span>
                        <span className="truncate font-medium tracking-tight">
                            {entry.text}
                        </span>
                    </div>
                );
            })}
        </div>
    );
});
