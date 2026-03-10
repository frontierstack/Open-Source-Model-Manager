import React, { useState, useRef, useEffect } from 'react';
import {
    ChevronDown,
    Settings,
    Plus,
    LogOut,
    Circle,
    Loader2
} from 'lucide-react';

/**
 * ChatHeader - Compact header with model selector and user controls
 */
export default function ChatHeader({
    models,
    selectedModel,
    onModelChange,
    onSettingsClick,
    onNewChat,
    isLoading,
    user,
    onLogout,
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

    return (
        <header className="flex items-center justify-between px-2 py-1.5 border-b border-white/5 bg-dark-900/80 backdrop-blur-xl sticky top-0 z-30">
            {/* Left side - Model selector */}
            <div className="flex items-center gap-1.5">
                {/* Model Dropdown */}
                <div className="relative" ref={modelDropdownRef}>
                    <button
                        onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-dark-800/60 border border-white/8 hover:border-white/15 transition-all duration-150"
                    >
                        <div className="flex items-center gap-2">
                            <Circle
                                className={`w-2 h-2 ${selectedModelData?.status === 'running' ? 'fill-green-400 text-green-400' : 'fill-dark-500 text-dark-500'}`}
                            />
                            <span className="text-xs font-medium text-dark-100 max-w-[140px] truncate">
                                {selectedModel || 'Select Model'}
                            </span>
                            {selectedModelData?.backend && (
                                <span
                                    className="text-[9px] font-semibold px-1 py-0.5 rounded uppercase"
                                    style={{
                                        backgroundColor: 'rgba(var(--primary-rgb), 0.15)',
                                        color: 'var(--accent-primary)'
                                    }}
                                >
                                    {formatBackend(selectedModelData.backend)}
                                </span>
                            )}
                        </div>
                        <ChevronDown className={`w-3 h-3 text-dark-400 transition-transform duration-150 ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Dropdown menu */}
                    {modelDropdownOpen && (
                        <div className="absolute top-full left-0 mt-1 w-56 py-1 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-xl z-50">
                            {runningModels.length === 0 ? (
                                <div className="px-3 py-3 text-center">
                                    <p className="text-xs text-dark-400">No models running</p>
                                </div>
                            ) : (
                                <div className="max-h-48 overflow-y-auto">
                                    {runningModels.map(model => (
                                        <button
                                            key={model.name}
                                            onClick={() => {
                                                onModelChange(model.name);
                                                setModelDropdownOpen(false);
                                            }}
                                            className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-white/5 transition-all"
                                            style={selectedModel === model.name ? { backgroundColor: 'rgba(var(--primary-rgb), 0.1)' } : {}}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <Circle className="w-1.5 h-1.5 flex-shrink-0 fill-green-400 text-green-400" />
                                                <span className={`text-xs truncate ${selectedModel === model.name ? 'font-medium text-dark-100' : 'text-dark-300'}`}>
                                                    {model.name}
                                                </span>
                                            </div>
                                            {selectedModel === model.name && (
                                                <Check className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Loading indicator */}
                {isLoading && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md" style={{ backgroundColor: 'rgba(var(--primary-rgb), 0.1)' }}>
                        <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                        <span className="text-[10px] font-medium" style={{ color: 'var(--accent-primary)' }}>Generating</span>
                    </div>
                )}

            </div>

            {/* Right side - Actions */}
            <div className="flex items-center gap-1">
                {/* New Chat */}
                <button
                    onClick={onNewChat}
                    className="p-1.5 rounded-md text-dark-400 hover:text-dark-200 hover:bg-white/5 transition-all"
                    title="New Chat"
                >
                    <Plus className="w-4 h-4" />
                </button>

                {/* Settings */}
                <button
                    onClick={onSettingsClick}
                    className="p-1.5 rounded-md text-dark-400 hover:text-dark-200 hover:bg-white/5 transition-all"
                    title="Settings"
                >
                    <Settings className="w-4 h-4" />
                </button>

                {/* User Menu */}
                <div className="relative" ref={userDropdownRef}>
                    <button
                        onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                        className="flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-white/5 transition-all"
                    >
                        <div
                            className="w-5 h-5 rounded flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, var(--accent-hover), var(--accent-secondary))' }}
                        >
                            <span className="text-[10px] font-bold text-white">{userInitial}</span>
                        </div>
                        <ChevronDown className={`w-3 h-3 text-dark-500 transition-transform ${userDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {userDropdownOpen && (
                        <div className="absolute top-full right-0 mt-1 w-40 py-1 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-xl z-50">
                            <div className="px-2.5 py-1.5 border-b border-white/5">
                                <p className="text-xs font-medium text-dark-200 truncate">{displayName}</p>
                            </div>
                            <button
                                onClick={() => {
                                    setUserDropdownOpen(false);
                                    onLogout();
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
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
