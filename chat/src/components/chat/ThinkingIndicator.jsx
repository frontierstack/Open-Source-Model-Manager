import React from 'react';

/**
 * ThinkingIndicator - Animated three-dot loading indicator (Tailwind)
 */
export default function ThinkingIndicator() {
    return (
        <div className="flex items-center gap-1 py-2">
            <div className="thinking-dot" style={{ animationDelay: '0s' }} />
            <div className="thinking-dot" style={{ animationDelay: '0.2s' }} />
            <div className="thinking-dot" style={{ animationDelay: '0.4s' }} />
        </div>
    );
}
