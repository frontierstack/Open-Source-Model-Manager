import React from 'react';

/**
 * ThinkingIndicator - Animated three-dot loading indicator with an
 * optional short verb-phrase label (e.g. "Reading file", "Searching the
 * web") so the user has a hint at what's happening without staring at
 * silent dots during a tool call.
 */
export default function ThinkingIndicator({ label }) {
    return (
        <div className="flex items-center gap-2 py-2">
            {label ? (
                <span className="text-sm" style={{ color: 'var(--ink-3)' }}>{label}</span>
            ) : null}
            <div className="flex items-center gap-1">
                <div className="thinking-dot" style={{ animationDelay: '0s' }} />
                <div className="thinking-dot" style={{ animationDelay: '0.2s' }} />
                <div className="thinking-dot" style={{ animationDelay: '0.4s' }} />
            </div>
        </div>
    );
}
