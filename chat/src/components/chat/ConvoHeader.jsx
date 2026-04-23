import React, { useMemo } from 'react';
import { Star } from 'lucide-react';

/**
 * ConvoHeader — title + metadata block rendered above the message list,
 * matching the design reference. Shows conversation title, a metadata
 * strip (created time, message count, context usage), and quick actions.
 */
export default function ConvoHeader({
    title,
    createdAt,
    messageCount = 0,
    estimatedTokens = 0,
    maxContextTokens = 0,
    favorite,
    onToggleFavorite,
}) {
    const startedStr = useMemo(() => {
        if (!createdAt) return null;
        const d = new Date(createdAt);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        if (sameDay) {
            return `Started ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
        return `Started ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    }, [createdAt]);

    const isUnlimited = !maxContextTokens;
    const tokensStr = isUnlimited
        ? `${Math.round(estimatedTokens).toLocaleString()} tokens`
        : `${estimatedTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens`;

    const head = {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 16,
        paddingBottom: 22, marginBottom: 24,
        borderBottom: '1px solid var(--rule)',
    };
    const titleStyle = {
        margin: 0,
        fontSize: 22, fontWeight: 600,
        letterSpacing: '-0.015em',
        color: 'var(--ink)',
    };
    const breadcrumb = {
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 4,
    };
    const crumbText = {
        fontSize: 11, color: 'var(--ink-3)',
        fontFamily: 'var(--font-mono)',
    };
    const crumbAccent = {
        fontSize: 11, color: 'var(--accent)',
        fontFamily: 'var(--font-mono)',
    };
    const metaLine = {
        fontSize: 12, color: 'var(--ink-3)',
        marginTop: 6,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    };
    const sep = { color: 'var(--ink-4)' };
    const headBtn = {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 10px', borderRadius: 6,
        border: '1px solid var(--rule)',
        color: 'var(--ink-2)',
        fontSize: 12,
        background: 'var(--surface)',
        cursor: 'pointer',
        transition: 'background .1s, border-color .1s',
    };

    return (
        <div style={head}>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={breadcrumb}>
                    <span style={crumbText}>Chat</span>
                    <span style={sep}>/</span>
                    {favorite && <span style={crumbAccent}>pinned</span>}
                </div>
                <h1 style={titleStyle}>{title || 'New conversation'}</h1>
                <div style={metaLine}>
                    {startedStr && <><span>{startedStr}</span><span style={sep}>·</span></>}
                    <span>{messageCount} {messageCount === 1 ? 'message' : 'messages'}</span>
                    {estimatedTokens > 0 && <>
                        <span style={sep}>·</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{tokensStr}</span>
                    </>}
                </div>
            </div>
            {onToggleFavorite && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                        style={{
                            ...headBtn,
                            padding: '6px 8px',
                            color: favorite ? 'var(--warning, #f59e0b)' : 'var(--ink-2)',
                        }}
                        onClick={onToggleFavorite}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--rule-2)'}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--rule)'}
                        title={favorite ? 'Unpin conversation' : 'Pin conversation'}
                    >
                        <Star
                            style={{
                                width: 13, height: 13,
                                fill: favorite ? 'currentColor' : 'none',
                            }}
                            strokeWidth={1.75}
                        />
                    </button>
                </div>
            )}
        </div>
    );
}
