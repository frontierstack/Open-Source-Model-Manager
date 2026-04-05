import React from 'react';
import {
    Globe,
    FileSearch,
    Loader2,
    Sparkles,
    Zap,
    Layers,
    GitMerge
} from 'lucide-react';

/**
 * Status types for the indicator
 */
export const StatusType = {
    IDLE: 'idle',
    THINKING: 'thinking',
    SEARCHING: 'searching',
    PARSING: 'parsing',
    PROCESSING: 'processing',
    GENERATING: 'generating',
    CHUNKING: 'chunking',
    SYNTHESIZING: 'synthesizing',
};

// Chunking-related statuses that get the enhanced display
const CHUNKING_STATUSES = new Set([
    StatusType.CHUNKING,
    StatusType.PROCESSING,
    StatusType.SYNTHESIZING,
]);

/**
 * StatusIndicator - Compact tag-style status display for response box
 * Enhanced display for chunking/processing/synthesizing phases
 */
export default function StatusIndicator({ status, message }) {
    if (!status || status === StatusType.IDLE) {
        return null;
    }

    const getStatusConfig = () => {
        switch (status) {
            case StatusType.THINKING:
                return {
                    icon: Loader2,
                    label: message || 'Thinking',
                    iconAnimation: 'animate-spin',
                    phase: null,
                };
            case StatusType.SEARCHING:
                return {
                    icon: Globe,
                    label: message || 'Searching web',
                    iconAnimation: 'animate-pulse',
                    phase: null,
                };
            case StatusType.PARSING:
                return {
                    icon: FileSearch,
                    label: message || 'Parsing files',
                    iconAnimation: 'animate-pulse',
                    phase: null,
                };
            case StatusType.PROCESSING:
                return {
                    icon: Zap,
                    label: message || 'Processing',
                    iconAnimation: 'animate-pulse',
                    phase: 'Map',
                };
            case StatusType.GENERATING:
                return {
                    icon: Sparkles,
                    label: message || 'Generating',
                    iconAnimation: 'animate-pulse',
                    phase: null,
                };
            case StatusType.CHUNKING:
                return {
                    icon: Layers,
                    label: message || 'Processing chunks',
                    iconAnimation: 'animate-pulse',
                    phase: 'Split',
                };
            case StatusType.SYNTHESIZING:
                return {
                    icon: GitMerge,
                    label: message || 'Synthesizing',
                    iconAnimation: 'animate-pulse',
                    phase: 'Reduce',
                };
            default:
                return {
                    icon: Loader2,
                    label: message || 'Loading',
                    iconAnimation: 'animate-spin',
                    phase: null,
                };
        }
    };

    const config = getStatusConfig();
    const Icon = config.icon;
    const isChunkingPhase = CHUNKING_STATUSES.has(status);

    // Extract progress percentage from message if present (e.g., "Analyzed 2/3 chunks (67%)")
    const pctMatch = message?.match(/\((\d+)%\)/);
    const progressPct = pctMatch ? parseInt(pctMatch[1], 10) : null;

    const themeStyles = {
        backgroundColor: 'rgba(var(--primary-rgb), 0.1)',
        borderColor: 'rgba(var(--primary-rgb), 0.2)',
        color: 'var(--accent-primary)',
    };

    // Enhanced display for chunking-related statuses
    if (isChunkingPhase) {
        return (
            <div
                className="inline-flex flex-col gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border min-w-[220px]"
                style={themeStyles}
            >
                <div className="flex items-center gap-2">
                    <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${config.iconAnimation}`} />
                    <span className="truncate">{config.label}</span>
                </div>
                {/* Progress bar */}
                <div className="w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(var(--primary-rgb), 0.15)' }}>
                    <div
                        className="h-full rounded-full transition-all duration-500 ease-out"
                        style={{
                            width: progressPct != null ? `${progressPct}%` : '100%',
                            background: 'var(--accent-primary)',
                            opacity: progressPct != null ? 1 : 0.4,
                            animation: progressPct == null ? 'indeterminate-progress 1.5s ease-in-out infinite' : 'none',
                        }}
                    />
                </div>
            </div>
        );
    }

    // Standard compact display for non-chunking statuses
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border"
            style={themeStyles}
        >
            <Icon className={`w-3 h-3 ${config.iconAnimation}`} />
            <span>{config.label}</span>
        </span>
    );
}
