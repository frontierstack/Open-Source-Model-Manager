import React, { useState, useRef, useEffect } from 'react';
import {
    ChevronDown,
    Settings,
    LogOut,
    Circle,
    Check,
    Menu
} from 'lucide-react';

/**
 * ChatHeader - Compact header with model selector and user controls
 */
export default function ChatHeader({
    models,
    selectedModel,
    onModelChange,
    onSettingsClick,
    user,
    onLogout,
    onMobileMenuClick,
}) {
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [userDropdownOpen, setUserDropdownOpen] = useState(false);
    const modelDropdownRef = useRef(null);
    const userDropdownRef = useRef(null);

    // Close dropdowns when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target)) {
                setModelDropdownOpen(false);
            }
            if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
                setUserDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const modelsArray = Array.isArray(models) ? models : [];
    const runningModels = modelsArray.filter(m => m.status === 'running');
    const selectedModelData = modelsArray.find(m => m.name === selectedModel);

    // Get user's display name or first initial
    const displayName = user?.username || user?.name || 'User';
    const userInitial = displayName.charAt(0).toUpperCase();

    // Format backend display name
    const formatBackend = (backend) => {
        if (!backend) return null;
        if (backend === 'vllm') return 'vLLM';
        if (backend === 'llamacpp') return 'llama.cpp';
        return backend;
    };

    // Get status color and animation based on model status
    const getStatusStyles = (status) => {
        switch (status) {
            case 'running':
                return {
                    color: 'fill-green-400 text-green-400',
                    animation: 'animate-pulse-glow',
                    label: 'Running'
                };
            case 'loading':
            case 'starting':
                return {
                    color: 'fill-amber-400 text-amber-400',
                    animation: 'animate-pulse',
                    label: status === 'loading' ? 'Loading' : 'Starting'
                };
            case 'unhealthy':
            case 'error':
                return {
                    color: 'fill-red-400 text-red-400',
                    animation: '',
                    label: 'Error'
                };
            default:
                return {
                    color: 'fill-dark-500 text-dark-500',
                    animation: '',
                    label: 'Not loaded'
                };
        }
    };

    const selectedModelStatus = getStatusStyles(selectedModelData?.status);

    return (
        <header className="flex items-center justify-between px-2.5 py-1 border-b border-white/[0.04] bg-dark-900/90 backdrop-blur-xl sticky top-0 z-30">
            {/* Left side - Mobile menu + Model selector */}
            <div className="flex items-center gap-1">
                {/* Mobile Menu Button */}
                {onMobileMenuClick && (
                    <button
                        onClick={onMobileMenuClick}
                        className="p-1.5 rounded-md text-dark-400 hover:text-dark-200 hover:bg-white/5 transition-all md:hidden"
                        title="Menu"
                    >
                        <Menu className="w-4 h-4" />
                    </button>
                )}
                {/* Model Dropdown */}
                <div className="relative" ref={modelDropdownRef}>
                    <button
                        onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-dark-800/40 border border-white/[0.06] hover:border-white/[0.12] hover:bg-dark-800/60 active:scale-[0.98] transition-all duration-150"
                    >
                        <Circle
                            className={`w-1.5 h-1.5 flex-shrink-0 ${selectedModelStatus.color} ${selectedModelStatus.animation}`}
                            title={selectedModelStatus.label}
                        />
                        <span className="text-[11px] font-medium text-dark-100 max-w-[180px] truncate">
                            {selectedModel || 'Select Model'}
                        </span>
                        {selectedModelData?.backend && (
                            <span
                                className="text-[8px] font-semibold px-1 py-px rounded uppercase leading-none"
                                style={{
                                    backgroundColor: 'rgba(var(--primary-rgb), 0.12)',
                                    color: 'var(--accent-primary)'
                                }}
                            >
                                {formatBackend(selectedModelData.backend)}
                            </span>
                        )}
                        <ChevronDown className={`w-3 h-3 text-dark-500 transition-transform duration-150 ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Dropdown menu */}
                    {modelDropdownOpen && (
                        <div className="absolute top-full left-0 mt-0.5 w-52 py-0.5 bg-dark-900/95 backdrop-blur-xl border border-white/[0.08] rounded-md shadow-xl z-50">
                            {runningModels.length === 0 ? (
                                <div className="px-3 py-2.5 text-center">
                                    <p className="text-[11px] text-dark-400">No models running</p>
                                    <p className="text-[10px] text-dark-500 mt-0.5">Load a model from the main app</p>
                                </div>
                            ) : (
                                <div className="max-h-48 overflow-y-auto">
                                    {runningModels.map(model => {
                                        const modelStatus = getStatusStyles(model.status);
                                        return (
                                            <button
                                                key={model.name}
                                                onClick={() => {
                                                    onModelChange(model.name);
                                                    setModelDropdownOpen(false);
                                                }}
                                                className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition-all"
                                                style={selectedModel === model.name ? { backgroundColor: 'rgba(var(--primary-rgb), 0.08)' } : {}}
                                            >
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                    <Circle
                                                        className={`w-1.5 h-1.5 flex-shrink-0 ${modelStatus.color} ${modelStatus.animation}`}
                                                        title={modelStatus.label}
                                                    />
                                                    <span className={`text-[11px] truncate ${selectedModel === model.name ? 'font-medium text-dark-100' : 'text-dark-300'}`}>
                                                        {model.name}
                                                    </span>
                                                    {model.status && model.status !== 'running' && (
                                                        <span className={`text-[8px] px-1 py-px rounded ${
                                                            model.status === 'loading' || model.status === 'starting'
                                                                ? 'bg-amber-500/20 text-amber-400'
                                                                : model.status === 'unhealthy'
                                                                    ? 'bg-red-500/20 text-red-400'
                                                                    : 'bg-dark-700 text-dark-400'
                                                        }`}>
                                                            {modelStatus.label}
                                                        </span>
                                                    )}
                                                </div>
                                                {selectedModel === model.name && (
                                                    <Check className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>



            </div>

            {/* Right side - Actions */}
            <div className="flex items-center gap-0.5">
                {/* Settings */}
                <button
                    onClick={onSettingsClick}
                    className="p-1.5 rounded-md text-dark-400 hover:text-dark-200 hover:bg-white/[0.06] active:scale-95 transition-all duration-150"
                    title="Settings"
                >
                    <Settings className="w-4 h-4" strokeWidth={1.8} />
                </button>

                {/* User Menu */}
                <div className="relative" ref={userDropdownRef}>
                    <button
                        onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                        className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded-md hover:bg-white/[0.06] active:scale-95 transition-all duration-150"
                    >
                        <div
                            className="w-6 h-6 rounded flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, var(--accent-hover), var(--accent-secondary))' }}
                        >
                            <span className="text-[10px] font-bold text-white">{userInitial}</span>
                        </div>
                        <ChevronDown className={`w-3 h-3 text-dark-500 transition-transform ${userDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {userDropdownOpen && (
                        <div className="absolute top-full right-0 mt-0.5 w-36 py-0.5 bg-dark-900/95 backdrop-blur-xl border border-white/[0.08] rounded-md shadow-xl z-50">
                            <div className="px-2.5 py-1.5 border-b border-white/5">
                                <p className="text-[11px] font-medium text-dark-200 truncate">{displayName}</p>
                            </div>
                            <button
                                onClick={() => {
                                    setUserDropdownOpen(false);
                                    onLogout();
                                }}
                                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                                <LogOut className="w-3 h-3" />
                                Sign Out
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
