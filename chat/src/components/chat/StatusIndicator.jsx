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
                    color: 'text-purple-400',
                    bgColor: 'bg-purple-500/10',
                    borderColor: 'border-purple-500/20',
                    iconAnimation: 'animate-spin',
                };
            case StatusType.SEARCHING:
                return {
                    icon: Globe,
                    label: message || 'Searching web',
                    color: 'text-blue-400',
                    bgColor: 'bg-blue-500/10',
                    borderColor: 'border-blue-500/20',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.PARSING:
                return {
                    icon: FileSearch,
                    label: message || 'Parsing files',
                    color: 'text-amber-400',
                    bgColor: 'bg-amber-500/10',
                    borderColor: 'border-amber-500/20',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.PROCESSING:
                return {
                    icon: Zap,
                    label: message || 'Processing',
                    color: 'text-emerald-400',
                    bgColor: 'bg-emerald-500/10',
                    borderColor: 'border-emerald-500/20',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.GENERATING:
                return {
                    icon: Sparkles,
                    label: message || 'Generating',
                    color: 'text-primary-400',
                    bgColor: 'bg-primary-500/10',
                    borderColor: 'border-primary-500/20',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.CHUNKING:
                return {
                    icon: Layers,
                    label: message || 'Processing chunks',
                    color: 'text-cyan-400',
                    bgColor: 'bg-cyan-500/10',
                    borderColor: 'border-cyan-500/20',
                    iconAnimation: 'animate-pulse',
                };
            case StatusType.SYNTHESIZING:
                return {
                    icon: GitMerge,
                    label: message || 'Synthesizing',
                    color: 'text-violet-400',
                    bgColor: 'bg-violet-500/10',
                    borderColor: 'border-violet-500/20',
                    iconAnimation: 'animate-pulse',
                };
            default:
                return {
                    icon: Loader2,
                    label: message || 'Loading',
                    color: 'text-dark-400',
                    bgColor: 'bg-dark-800/50',
                    borderColor: 'border-dark-700/30',
                    iconAnimation: 'animate-spin',
                };
        }
    };

    const config = getStatusConfig();
    const Icon = config.icon;

    return (
        <span
            className={`
                inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium
                ${config.bgColor} ${config.borderColor} border ${config.color}
            `}
        >
            <Icon className={`w-3 h-3 ${config.iconAnimation}`} />
            <span>{config.label}</span>
        </span>
    );
}
