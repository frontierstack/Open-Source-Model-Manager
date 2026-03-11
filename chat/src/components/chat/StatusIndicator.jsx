import React from 'react';
import {
    Brain,
    Globe,
    FileSearch,
    Loader2,
    Sparkles,
    Zap
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
};

/**
 * StatusIndicator - Animated status display for various processing states
 */
export default function StatusIndicator({ status, message }) {
    if (!status || status === StatusType.IDLE) {
        return null;
    }

    const getStatusConfig = () => {
        switch (status) {
            case StatusType.THINKING:
                return {
                    icon: Brain,
                    label: message || 'Thinking',
                    color: 'text-purple-400',
                    bgColor: 'bg-purple-500/10',
                    borderColor: 'border-purple-500/30',
                    animation: 'animate-pulse-subtle',
                };
            case StatusType.SEARCHING:
                return {
                    icon: Globe,
                    label: message || 'Searching the web',
                    color: 'text-blue-400',
                    bgColor: 'bg-blue-500/10',
                    borderColor: 'border-blue-500/30',
                    animation: 'animate-searching',
                };
            case StatusType.PARSING:
                return {
                    icon: FileSearch,
                    label: message || 'Parsing files',
                    color: 'text-amber-400',
                    bgColor: 'bg-amber-500/10',
                    borderColor: 'border-amber-500/30',
                    animation: 'animate-pulse-subtle',
                };
            case StatusType.PROCESSING:
                return {
                    icon: Zap,
                    label: message || 'Processing',
                    color: 'text-emerald-400',
                    bgColor: 'bg-emerald-500/10',
                    borderColor: 'border-emerald-500/30',
                    animation: 'animate-pulse-subtle',
                };
            case StatusType.GENERATING:
                return {
                    icon: Sparkles,
                    label: message || 'Generating response',
                    color: 'text-primary-400',
                    bgColor: 'bg-primary-500/10',
                    borderColor: 'border-primary-500/30',
                    animation: '',
                };
            default:
                return {
                    icon: Loader2,
                    label: message || 'Loading',
                    color: 'text-dark-300',
                    bgColor: 'bg-dark-800/50',
                    borderColor: 'border-dark-700/50',
                    animation: 'animate-spin',
                };
        }
    };

    const config = getStatusConfig();
    const Icon = config.icon;

    return (
        <div
            className={`
                inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                ${config.bgColor} ${config.borderColor} border
                transition-all duration-300 animate-fade-in
            `}
        >
            <Icon className={`w-4 h-4 ${config.color} ${config.animation}`} />
            <span className={`text-xs font-medium ${config.color}`}>
                {config.label}
            </span>
            <div className="flex gap-0.5">
                <span className={`w-1 h-1 rounded-full ${config.bgColor.replace('/10', '/60')} animate-processing-dot`} />
                <span className={`w-1 h-1 rounded-full ${config.bgColor.replace('/10', '/60')} animate-processing-dot`} />
                <span className={`w-1 h-1 rounded-full ${config.bgColor.replace('/10', '/60')} animate-processing-dot`} />
            </div>
        </div>
    );
}

/**
 * MultiStatusIndicator - Shows multiple concurrent status indicators
 */
export function MultiStatusIndicator({ statuses = [] }) {
    if (!statuses || statuses.length === 0) {
        return null;
    }

    return (
        <div className="flex flex-wrap gap-2 justify-center">
            {statuses.map((s, idx) => (
                <StatusIndicator key={idx} status={s.type} message={s.message} />
            ))}
        </div>
    );
}
