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

/**
 * StatusIndicator - Compact tag-style status display for response box
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
                };
            case StatusType.SEARCHING:
                return {
                    icon: Globe,
                    label: message || 'Searching web',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.PARSING:
                return {
                    icon: FileSearch,
                    label: message || 'Parsing files',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.PROCESSING:
                return {
                    icon: Zap,
                    label: message || 'Processing',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.GENERATING:
                return {
                    icon: Sparkles,
                    label: message || 'Generating',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.CHUNKING:
                return {
                    icon: Layers,
                    label: message || 'Processing chunks',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.SYNTHESIZING:
                return {
                    icon: GitMerge,
                    label: message || 'Synthesizing',
                    iconAnimation: 'animate-pulse',
                };
            default:
                return {
                    icon: Loader2,
                    label: message || 'Loading',
                    iconAnimation: 'animate-spin',
                };
        }
    };

    const config = getStatusConfig();
    const Icon = config.icon;

    const themeStyles = {
        backgroundColor: 'rgba(var(--primary-rgb), 0.1)',
        borderColor: 'rgba(var(--primary-rgb), 0.2)',
        color: 'var(--accent-primary)',
    };

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
