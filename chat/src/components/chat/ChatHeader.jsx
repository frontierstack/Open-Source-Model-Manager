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
        <header className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-dark-900/80 backdrop-blur-xl sticky top-0 z-30">
            {/* Left side - Model selector */}
            <div className="flex items-center gap-2">
                {/* Model Dropdown */}
                <div className="relative" ref={modelDropdownRef}>
                    <button
                        onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dark-800/80 border border-white/8 hover:border-white/15 transition-all duration-200"
                    >
                        <div className="flex items-center gap-2.5">
                            <div className="relative">
                                <Circle
                                    className={`w-2.5 h-2.5 ${selectedModelData?.status === 'running' ? 'fill-green-400 text-green-400' : 'fill-dark-500 text-dark-500'}`}
                                />
                                {selectedModelData?.status === 'running' && (
                                    <div className="absolute inset-0 w-2.5 h-2.5 bg-green-400 rounded-full animate-ping opacity-50" />
                                )}
                            </div>
                            <span className="text-sm font-medium text-dark-100 max-w-[180px] truncate">
                                {selectedModel || 'Select Model'}
                            </span>
                            {selectedModelData?.backend && (
                                <span
                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wide border"
                                    style={{
                                        backgroundColor: 'rgba(var(--primary-rgb), 0.15)',
                                        color: 'var(--accent-primary)',
                                        borderColor: 'rgba(var(--primary-rgb), 0.25)'
                                    }}
                                >
                                    {formatBackend(selectedModelData.backend)}
                                </span>
                            )}
                        </div>
                        <ChevronDown className={`w-4 h-4 text-dark-400 transition-transform duration-200 ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Dropdown menu */}
                    {modelDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-80 py-2 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl shadow-black/30 z-50 animate-fade-in">
                            {runningModels.length === 0 ? (
                                <div className="px-4 py-6 text-center">
                                    <div className="w-12 h-12 rounded-full bg-dark-800 flex items-center justify-center mx-auto mb-3">
                                        <Circle className="w-5 h-5 text-dark-500" />
                                    </div>
                                    <p className="text-sm text-dark-400 font-medium">No models running</p>
                                    <p className="text-xs text-dark-500 mt-1">Start a model from the Management Console</p>
                                </div>
                            ) : (
                                <>
                                    <div className="px-4 py-2 text-xs font-semibold text-dark-500 uppercase tracking-wider">
                                        Running Models ({runningModels.length})
                                    </div>
                                    <div className="max-h-64 overflow-y-auto">
                                        {runningModels.map(model => (
                                            <button
                                                key={model.name}
                                                onClick={() => {
                                                    onModelChange(model.name);
                                                    setModelDropdownOpen(false);
                                                }}
                                                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/5 transition-all duration-150"
                                                style={selectedModel === model.name ? { backgroundColor: 'rgba(var(--primary-rgb), 0.1)' } : {}}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <Circle className="w-2 h-2 flex-shrink-0 fill-green-400 text-green-400" />
                                                    <div className="min-w-0">
                                                        <span
                                                            className={`text-sm block truncate ${
                                                                selectedModel === model.name ? 'font-medium text-dark-100' : 'text-dark-200'
                                                            }`}
                                                        >
                                                            {model.name}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                    {model.backend && (
                                                        <span
                                                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide"
                                                            style={{
                                                                backgroundColor: 'rgba(var(--primary-rgb), 0.15)',
                                                                color: 'var(--accent-primary)'
                                                            }}
                                                        >
                                                            {formatBackend(model.backend)}
                                                        </span>
                                                    )}
                                                    {selectedModel === model.name && (
                                                        <Check className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                                                    )}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Loading indicator */}
                {isLoading && (
                    <div
                        className="flex items-center gap-2 px-2.5 py-1 rounded-lg border"
                        style={{
                            backgroundColor: 'rgba(var(--primary-rgb), 0.1)',
                            borderColor: 'rgba(var(--primary-rgb), 0.2)'
                        }}
                    >
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                        <span className="text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>Generating...</span>
                    </div>
                )}

            </div>

            {/* Right side - Actions */}
            <div className="flex items-center gap-2">
                {/* New Chat */}
                <button
                    onClick={onNewChat}
                    className="btn-icon group relative overflow-hidden"
                    title="New Chat"
                >
                    <Plus className="w-5 h-5 relative z-10 group-hover:rotate-90 transition-transform duration-200" />
                </button>

                {/* Settings */}
                <button
                    onClick={onSettingsClick}
                    className="btn-icon group"
                    title="Settings"
                >
                    <Settings className="w-5 h-5 group-hover:rotate-45 transition-transform duration-300" />
                </button>

                {/* User Menu */}
                <div className="relative" ref={userDropdownRef}>
                    <button
                        onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                        className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/5 transition-all duration-200"
                    >
                        <div
                            className="w-7 h-7 rounded-md flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, var(--accent-hover), var(--accent-secondary))' }}
                        >
                            <span className="text-xs font-bold text-white">{userInitial}</span>
                        </div>
                        <span className="text-sm text-dark-300 hidden sm:inline max-w-[80px] truncate">
                            {displayName}
                        </span>
                        <ChevronDown className={`w-3.5 h-3.5 text-dark-500 transition-transform duration-200 ${userDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {userDropdownOpen && (
                        <div className="absolute top-full right-0 mt-1 w-48 py-1 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-xl z-50 animate-fade-in">
                            <div className="px-3 py-2 border-b border-white/5">
                                <p className="text-sm font-medium text-dark-200 truncate">{displayName}</p>
                                <p className="text-xs text-dark-500 truncate">{user?.email || ''}</p>
                            </div>
                            <div className="py-1">
                                <button
                                    onClick={() => {
                                        setUserDropdownOpen(false);
                                        onLogout();
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                    <LogOut className="w-4 h-4" />
                                    Sign Out
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
