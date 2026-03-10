import React, { useState, useRef, useEffect } from 'react';
import {
    ChevronDown,
    Settings,
    Plus,
    LogOut,
    Check,
    Circle,
    Loader2,
    Palette
} from 'lucide-react';

/**
 * ChatHeader - Header with model selector, theme toggle, and user controls (Tailwind)
 */
export default function ChatHeader({
    models,
    selectedModel,
    onModelChange,
    webSearchEnabled,
    onWebSearchToggle,
    onSettingsClick,
    onNewChat,
    isLoading,
    user,
    onLogout,
    theme,
    onThemeChange,
}) {
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [userDropdownOpen, setUserDropdownOpen] = useState(false);
    const [themeDropdownOpen, setThemeDropdownOpen] = useState(false);
    const modelDropdownRef = useRef(null);
    const userDropdownRef = useRef(null);
    const themeDropdownRef = useRef(null);

    // Close dropdowns when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target)) {
                setModelDropdownOpen(false);
            }
            if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
                setUserDropdownOpen(false);
            }
            if (themeDropdownRef.current && !themeDropdownRef.current.contains(event.target)) {
                setThemeDropdownOpen(false);
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

    const themeOptions = [
        { value: 'midnight', label: 'Midnight', color: '#8b5cf6' },  // Purple
        { value: 'obsidian', label: 'Obsidian', color: '#a855f7' },  // Darker purple
        { value: 'ocean', label: 'Ocean', color: '#3b82f6' },        // Blue
        { value: 'forest', label: 'Forest', color: '#22c55e' },      // Green
        { value: 'sunset', label: 'Sunset', color: '#f97316' },      // Orange
    ];

    const currentTheme = theme || 'midnight';

    // Format backend display name
    const formatBackend = (backend) => {
        if (!backend) return null;
        if (backend === 'vllm') return 'vLLM';
        if (backend === 'llamacpp') return 'llama.cpp';
        return backend;
    };

    return (
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-dark-900/80 backdrop-blur-xl sticky top-0 z-30">
            {/* Left side - Model selector */}
            <div className="flex items-center gap-3">
                {/* Model Dropdown */}
                <div className="relative" ref={modelDropdownRef}>
                    <button
                        onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                        className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-gradient-to-b from-dark-800/90 to-dark-800/70 border border-white/10 hover:border-white/20 hover:from-dark-700/90 hover:to-dark-800/70 transition-all duration-200 shadow-lg shadow-black/10"
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
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wide ${
                                    selectedModelData.backend === 'vllm'
                                        ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
                                        : 'bg-primary-500/20 text-primary-400 border border-primary-500/30'
                                }`}>
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
                                                className={`w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-all duration-150 ${
                                                    selectedModel === model.name ? 'bg-primary-500/10' : ''
                                                }`}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <Circle className="w-2 h-2 flex-shrink-0 fill-green-400 text-green-400" />
                                                    <div className="min-w-0">
                                                        <span className={`text-sm block truncate ${
                                                            selectedModel === model.name ? 'text-primary-300 font-medium' : 'text-dark-200'
                                                        }`}>
                                                            {model.name}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                    {model.backend && (
                                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                                                            model.backend === 'vllm'
                                                                ? 'bg-accent-500/20 text-accent-400'
                                                                : 'bg-primary-500/20 text-primary-400'
                                                        }`}>
                                                            {formatBackend(model.backend)}
                                                        </span>
                                                    )}
                                                    {selectedModel === model.name && (
                                                        <Check className="w-4 h-4 text-primary-400" />
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
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary-500/10 border border-primary-500/20">
                        <Loader2 className="w-4 h-4 text-primary-400 animate-spin" />
                        <span className="text-xs text-primary-400 font-medium">Generating...</span>
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

                {/* Theme Selector */}
                <div className="relative" ref={themeDropdownRef}>
                    <button
                        onClick={() => setThemeDropdownOpen(!themeDropdownOpen)}
                        className="btn-icon"
                        title="Change theme"
                    >
                        <Palette className="w-5 h-5" />
                    </button>

                    {themeDropdownOpen && (
                        <div className="absolute top-full right-0 mt-2 w-44 py-2 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/30 z-50 animate-fade-in">
                            <div className="px-3 py-1.5 text-xs font-semibold text-dark-500 uppercase tracking-wider">
                                Theme
                            </div>
                            {themeOptions.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => {
                                        onThemeChange?.(option.value);
                                        setThemeDropdownOpen(false);
                                    }}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/5 transition-colors ${
                                        currentTheme === option.value ? 'bg-white/5' : ''
                                    }`}
                                >
                                    <div
                                        className="w-4 h-4 rounded-full ring-2 ring-white/10"
                                        style={{ backgroundColor: option.color }}
                                    />
                                    <span className={`text-sm ${currentTheme === option.value ? 'text-white font-medium' : 'text-dark-300'}`}>
                                        {option.label}
                                    </span>
                                    {currentTheme === option.value && (
                                        <Check className="w-4 h-4 ml-auto text-white" />
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

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
                        className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-gradient-to-b from-dark-800/80 to-dark-800/60 border border-white/5 hover:border-white/15 transition-all duration-200"
                    >
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center shadow-lg shadow-primary-500/20">
                            <span className="text-sm font-bold text-white">{userInitial}</span>
                        </div>
                        <span className="text-sm font-medium text-dark-200 hidden sm:inline max-w-[100px] truncate">
                            {displayName}
                        </span>
                        <ChevronDown className={`w-4 h-4 text-dark-400 transition-transform duration-200 ${userDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {userDropdownOpen && (
                        <div className="absolute top-full right-0 mt-2 w-56 py-2 bg-dark-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/30 z-50 animate-fade-in">
                            <div className="px-4 py-3 border-b border-white/5">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center">
                                        <span className="text-base font-bold text-white">{userInitial}</span>
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-dark-100 truncate">{displayName}</p>
                                        <p className="text-xs text-dark-400 truncate">{user?.email || 'No email'}</p>
                                    </div>
                                </div>
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
