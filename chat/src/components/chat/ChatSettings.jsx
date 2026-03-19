import React, { useState, useEffect } from 'react';
import {
    X,
    ChevronDown,
    Settings,
    MessageSquare,
    Palette,
    Save,
    Plus,
    Trash2,
    Edit3,
    Check,
    Sun,
    Moon,
    Monitor,
    Zap,
    Sparkles,
    Code,
    Target,
    Layout,
    Minimize2,
    Maximize2,
    AlignCenter,
    Square
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';

/**
 * ChatSettings - Modern tabbed settings modal with chat, prompts, and appearance (Tailwind)
 */
export default function ChatSettings({
    open,
    onClose,
    settings,
    onUpdateSettings,
    systemPrompts,
    onSaveSystemPrompt,
    onDeleteSystemPrompt,
    theme,
    onThemeChange,
    contextSize = 4096,
}) {
    const [activeTab, setActiveTab] = useState('chat');
    const [editingPrompt, setEditingPrompt] = useState(null);
    const [newPromptName, setNewPromptName] = useState('');
    const [newPromptContent, setNewPromptContent] = useState('');
    const [isCreatingPrompt, setIsCreatingPrompt] = useState(false);
    const confirm = useConfirm();

    const {
        temperature = 0.7,
        maxTokens = contextSize,  // Default to model's context window
        systemPromptId = null,
        topP = 1.0,
        frequencyPenalty = 0,
        presencePenalty = 0,
        fontSize = 'medium',
        fontFamily = 'system',
        chatStyle = 'default',
    } = settings;

    // Chat window style options
    const chatStyleOptions = [
        {
            value: 'default',
            label: 'Default',
            icon: MessageSquare,
            description: 'Classic chat layout',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'normal' }
        },
        {
            value: 'centered',
            label: 'Centered',
            icon: AlignCenter,
            description: 'Messages centered',
            preview: { userAlign: 'center', assistantAlign: 'center', width: 'normal' }
        },
        {
            value: 'bubbles',
            label: 'Bubbles',
            icon: Square,
            description: 'Rounded bubble style',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'compact' }
        },
        {
            value: 'cozy',
            label: 'Cozy',
            icon: Maximize2,
            description: 'Extra spacious layout',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'wide' }
        },
        {
            value: 'compact',
            label: 'Compact',
            icon: Minimize2,
            description: 'Tight, minimal spacing',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'tight' }
        },
        {
            value: 'wide',
            label: 'Wide',
            icon: Layout,
            description: 'Full width messages',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'full' }
        },
    ];

    // Font options with resolution presets
    const fontSizeOptions = [
        { value: 'small', label: 'Small', description: '1080p / Compact' },
        { value: 'medium', label: 'Medium', description: '2K / Default' },
        { value: 'large', label: 'Large', description: '4K / Spacious' },
    ];

    const fontFamilyOptions = [
        // Sans-Serif - Modern
        { value: 'system', label: 'System Default', category: 'sans' },
        { value: 'inter', label: 'Inter', category: 'sans' },
        { value: 'roboto', label: 'Roboto', category: 'sans' },
        { value: 'opensans', label: 'Open Sans', category: 'sans' },
        { value: 'lato', label: 'Lato', category: 'sans' },
        { value: 'poppins', label: 'Poppins', category: 'sans' },
        { value: 'nunito', label: 'Nunito', category: 'sans' },
        { value: 'sourcesans', label: 'Source Sans Pro', category: 'sans' },
        { value: 'dmsans', label: 'DM Sans', category: 'sans' },
        { value: 'worksans', label: 'Work Sans', category: 'sans' },
        { value: 'plusjakarta', label: 'Plus Jakarta Sans', category: 'sans' },
        { value: 'lexend', label: 'Lexend', category: 'sans' },
        { value: 'outfit', label: 'Outfit', category: 'sans' },
        { value: 'spacegrotesk', label: 'Space Grotesk', category: 'sans' },
        { value: 'ibmplex', label: 'IBM Plex Sans', category: 'sans' },
        { value: 'manrope', label: 'Manrope', category: 'sans' },
        { value: 'urbanist', label: 'Urbanist', category: 'sans' },
        { value: 'sora', label: 'Sora', category: 'sans' },
        { value: 'atkinson', label: 'Atkinson Hyperlegible', category: 'sans' },
        { value: 'geist', label: 'Geist', category: 'sans' },
        { value: 'figtree', label: 'Figtree', category: 'sans' },
        { value: 'onest', label: 'Onest', category: 'sans' },
        { value: 'rubik', label: 'Rubik', category: 'sans' },
        { value: 'quicksand', label: 'Quicksand', category: 'sans' },
        { value: 'comfortaa', label: 'Comfortaa', category: 'sans' },
        { value: 'overpass', label: 'Overpass', category: 'sans' },
        { value: 'karla', label: 'Karla', category: 'sans' },
        { value: 'assistant', label: 'Assistant', category: 'sans' },
        { value: 'exo2', label: 'Exo 2', category: 'sans' },
        { value: 'barlow', label: 'Barlow', category: 'sans' },
        { value: 'publicsans', label: 'Public Sans', category: 'sans' },
        { value: 'redhatdisplay', label: 'Red Hat Display', category: 'sans' },
        { value: 'readexpro', label: 'Readex Pro', category: 'sans' },
        // Serif
        { value: 'merriweather', label: 'Merriweather', category: 'serif' },
        { value: 'playfair', label: 'Playfair Display', category: 'serif' },
        { value: 'georgia', label: 'Georgia', category: 'serif' },
        { value: 'crimsonpro', label: 'Crimson Pro', category: 'serif' },
        { value: 'librebaskerville', label: 'Libre Baskerville', category: 'serif' },
        { value: 'lora', label: 'Lora', category: 'serif' },
        { value: 'sourceserpro', label: 'Source Serif Pro', category: 'serif' },
        // Monospace
        { value: 'jetbrains', label: 'JetBrains Mono', category: 'mono' },
        { value: 'firacode', label: 'Fira Code', category: 'mono' },
        { value: 'consolas', label: 'Consolas', category: 'mono' },
        { value: 'spacemono', label: 'Space Mono', category: 'mono' },
        { value: 'ubuntumono', label: 'Ubuntu Mono', category: 'mono' },
        { value: 'anonymouspro', label: 'Anonymous Pro', category: 'mono' },
        { value: 'cascadiacode', label: 'Cascadia Code', category: 'mono' },
        { value: 'victormono', label: 'Victor Mono', category: 'mono' },
        { value: 'geistmono', label: 'Geist Mono', category: 'mono' },
        { value: 'monaspace', label: 'Monaspace', category: 'mono' },
        { value: 'intelone', label: 'Intel One Mono', category: 'mono' },
        { value: 'commitmono', label: 'Commit Mono', category: 'mono' },
        { value: 'martianmono', label: 'Martian Mono', category: 'mono' },
    ];

    // Reset state when modal closes
    useEffect(() => {
        if (!open) {
            setEditingPrompt(null);
            setIsCreatingPrompt(false);
            setNewPromptName('');
            setNewPromptContent('');
        }
    }, [open]);

    if (!open) return null;

    // Presets use percentages of the model's context window
    const presets = [
        {
            label: 'Precise',
            icon: Target,
            temperature: 0.2,
            maxTokens: Math.floor(contextSize * 0.5),  // 50% of context
            topP: 0.9,
            description: 'Focused, deterministic responses'
        },
        {
            label: 'Balanced',
            icon: Zap,
            temperature: 0.7,
            maxTokens: Math.floor(contextSize * 0.75), // 75% of context
            topP: 1.0,
            description: 'Good for general tasks'
        },
        {
            label: 'Creative',
            icon: Sparkles,
            temperature: 1.0,
            maxTokens: contextSize,                    // Full context
            topP: 1.0,
            description: 'Imaginative, varied outputs'
        },
        {
            label: 'Code',
            icon: Code,
            temperature: 0.1,
            maxTokens: contextSize,                    // Full context for code
            topP: 0.95,
            description: 'Precise code generation'
        },
    ];

    const themeOptions = [
        // Standard
        { value: 'dark', label: 'Dark', icon: Moon, description: 'Default dark theme' },
        { value: 'light', label: 'Light', icon: Sun, description: 'Clean white theme' },
        { value: 'obsidian', label: 'Obsidian', icon: Moon, description: 'Pure black OLED' },
        // Nature
        { value: 'ocean', label: 'Ocean', icon: Sparkles, description: 'Deep blue theme' },
        { value: 'forest', label: 'Forest', icon: Sparkles, description: 'Natural greens' },
        { value: 'sunset', label: 'Sunset', icon: Sun, description: 'Warm orange tones' },
        { value: 'rose', label: 'Rose', icon: Sparkles, description: 'Soft pink theme' },
        { value: 'aurora', label: 'Aurora', icon: Sparkles, description: 'Northern lights' },
        { value: 'midnight', label: 'Midnight', icon: Moon, description: 'Deep night blue' },
        { value: 'evergreen', label: 'Evergreen', icon: Sparkles, description: 'Deep forest greens' },
        { value: 'mint', label: 'Mint', icon: Sparkles, description: 'Fresh green teal' },
        { value: 'arctic', label: 'Arctic', icon: Moon, description: 'Cold blue white' },
        { value: 'sand', label: 'Sand', icon: Sun, description: 'Warm beige tan' },
        { value: 'terracotta', label: 'Terracotta', icon: Sun, description: 'Earthy red orange' },
        // Warm Tones
        { value: 'coffee', label: 'Coffee', icon: Moon, description: 'Warm brown tones' },
        { value: 'ember', label: 'Ember', icon: Zap, description: 'Warm red orange' },
        { value: 'copper', label: 'Copper', icon: Sparkles, description: 'Warm metallic' },
        // Neutral
        { value: 'slate', label: 'Slate', icon: Moon, description: 'Blue-gray neutral' },
        { value: 'graphite', label: 'Graphite', icon: Moon, description: 'Dark neutral gray' },
        // Classic Dev
        { value: 'nord', label: 'Nord', icon: Moon, description: 'Arctic palette' },
        { value: 'solarized', label: 'Solarized', icon: Sun, description: 'Solarized Dark' },
        { value: 'gruvbox', label: 'Gruvbox', icon: Moon, description: 'Retro groove' },
        { value: 'dracula', label: 'Dracula', icon: Moon, description: 'Dark theme' },
        { value: 'monokai', label: 'Monokai', icon: Code, description: 'Sublime classic' },
        { value: 'onedark', label: 'One Dark', icon: Moon, description: 'Atom inspired' },
        { value: 'tokyo', label: 'Tokyo Night', icon: Moon, description: 'Neon city' },
        { value: 'catppuccin', label: 'Catppuccin', icon: Sparkles, description: 'Pastel colors' },
        { value: 'palenight', label: 'Palenight', icon: Moon, description: 'Material dark' },
        // Vibrant
        { value: 'matrix', label: 'Matrix', icon: Code, description: 'Hacker terminal' },
        { value: 'cyberpunk', label: 'Cyberpunk', icon: Zap, description: 'Neon vibes' },
        { value: 'synthwave', label: 'Synthwave', icon: Zap, description: '80s retro' },
        { value: 'vaporwave', label: 'Vaporwave', icon: Sparkles, description: 'Aesthetic pink' },
        { value: 'neonoir', label: 'Neo Noir', icon: Moon, description: 'Dark neon' },
    ];

    const currentTheme = theme || 'system';

    const tabs = [
        { id: 'chat', label: 'Chat Settings', icon: Settings },
        { id: 'prompts', label: 'System Prompts', icon: MessageSquare },
        { id: 'appearance', label: 'Appearance', icon: Palette },
    ];

    const handleStartEdit = (prompt) => {
        setEditingPrompt(prompt);
        setNewPromptName(prompt.name || '');
        setNewPromptContent(prompt.content || '');
    };

    const handleSavePrompt = async () => {
        if (!newPromptName.trim()) return;

        const promptData = {
            id: editingPrompt?.id || `prompt_${Date.now()}`,
            name: newPromptName.trim(),
            content: newPromptContent.trim(),
        };

        await onSaveSystemPrompt?.(promptData);
        setEditingPrompt(null);
        setIsCreatingPrompt(false);
        setNewPromptName('');
        setNewPromptContent('');
    };

    const handleDeletePrompt = async (promptId) => {
        const confirmed = await confirm({
            title: 'Delete System Prompt',
            message: 'Are you sure you want to delete this system prompt? This action cannot be undone.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (confirmed) {
            await onDeleteSystemPrompt?.(promptId);
            if (systemPromptId === promptId) {
                onUpdateSettings({ systemPromptId: null });
            }
        }
    };

    const promptsList = Array.isArray(systemPrompts) ? systemPrompts : [];

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[720px] md:max-h-[90vh] bg-dark-900 border border-white/10 rounded-xl shadow-2xl shadow-black/40 z-50 flex flex-col overflow-hidden animate-fade-in">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                    <h2 className="text-sm font-semibold text-dark-100">Settings</h2>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/5 px-1">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                                    activeTab === tab.id
                                        ? 'text-primary-400 border-primary-500'
                                        : 'text-dark-400 border-transparent hover:text-dark-200 hover:border-white/10'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">{tab.label}</span>
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Chat Settings Tab */}
                    {activeTab === 'chat' && (
                        <>
                            {/* System Prompt Selector */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-1.5">
                                    Active System Prompt
                                </label>
                                <div className="relative">
                                    <select
                                        value={systemPromptId || ''}
                                        onChange={(e) => onUpdateSettings({ systemPromptId: e.target.value || null })}
                                        className="w-full px-3 py-2 bg-dark-800/80 border border-white/10 rounded-lg text-dark-200 text-xs appearance-none cursor-pointer hover:border-white/20 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/20 transition-all"
                                    >
                                        <option value="">None (default behavior)</option>
                                        {promptsList.map((prompt) => (
                                            <option key={prompt.id} value={prompt.id}>
                                                {prompt.name || prompt.id}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-400 pointer-events-none" />
                                </div>
                            </div>

                            <div className="border-t border-white/5" />

                            {/* Quick Presets */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-2">
                                    Quick Presets
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {presets.map((preset) => {
                                        const Icon = preset.icon;
                                        const isActive = temperature === preset.temperature && maxTokens === preset.maxTokens;
                                        return (
                                            <button
                                                key={preset.label}
                                                onClick={() => onUpdateSettings({
                                                    temperature: preset.temperature,
                                                    maxTokens: preset.maxTokens,
                                                    topP: preset.topP,
                                                })}
                                                className={`flex items-start gap-2 p-2.5 rounded-lg border transition-all duration-200 text-left ${
                                                    isActive
                                                        ? 'bg-primary-500/15 border-primary-500/40 text-primary-300'
                                                        : 'bg-dark-800/50 border-white/5 text-dark-300 hover:bg-dark-800 hover:border-white/10'
                                                }`}
                                            >
                                                <div className={`p-1.5 rounded-md ${isActive ? 'bg-primary-500/20' : 'bg-dark-700'}`}>
                                                    <Icon className="w-3.5 h-3.5" />
                                                </div>
                                                <div>
                                                    <div className="text-xs font-medium">{preset.label}</div>
                                                    <div className="text-[10px] text-dark-500 mt-0.5">{preset.description}</div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="border-t border-white/5" />

                            {/* Temperature */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-xs font-medium text-dark-200 flex items-center gap-1.5">
                                        Temperature
                                        <span className="group relative">
                                            <svg className="w-3.5 h-3.5 text-dark-500 hover:text-dark-300 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1.5 text-[10px] leading-tight text-dark-100 bg-dark-800 border border-dark-700 rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                                                Controls randomness. Lower values (0.1-0.3) are<br/>more focused and deterministic. Higher values<br/>(0.7-1.5) are more creative and varied.
                                            </span>
                                        </span>
                                    </label>
                                    <span className="text-xs font-mono text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
                                        {temperature.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    value={temperature}
                                    onChange={(e) => onUpdateSettings({ temperature: parseFloat(e.target.value) })}
                                    min={0}
                                    max={2}
                                    step={0.01}
                                    className="w-full h-1.5 bg-dark-800 rounded-full appearance-none cursor-pointer
                                               [&::-webkit-slider-thumb]:appearance-none
                                               [&::-webkit-slider-thumb]:w-4
                                               [&::-webkit-slider-thumb]:h-4
                                               [&::-webkit-slider-thumb]:rounded-full
                                               [&::-webkit-slider-thumb]:bg-primary-500
                                               [&::-webkit-slider-thumb]:shadow-lg
                                               [&::-webkit-slider-thumb]:shadow-primary-500/30
                                               [&::-webkit-slider-thumb]:cursor-pointer
                                               [&::-webkit-slider-thumb]:border-2
                                               [&::-webkit-slider-thumb]:border-dark-900
                                               [&::-webkit-slider-thumb]:transition-transform
                                               [&::-webkit-slider-thumb]:hover:scale-110"
                                />
                                <div className="flex justify-between text-[10px] text-dark-500 mt-1.5">
                                    <span>Precise</span>
                                    <span>Creative</span>
                                </div>
                            </div>

                            {/* Top P */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-xs font-medium text-dark-200 flex items-center gap-1.5">
                                        Top P
                                        <span className="group relative">
                                            <svg className="w-3.5 h-3.5 text-dark-500 hover:text-dark-300 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1.5 text-[10px] leading-tight text-dark-100 bg-dark-800 border border-dark-700 rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                                                Nucleus sampling. Considers tokens comprising<br/>the top P probability mass. 1.0 = all tokens.<br/>Lower values (0.5-0.9) reduce randomness.
                                            </span>
                                        </span>
                                    </label>
                                    <span className="text-xs font-mono text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
                                        {topP.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    value={topP}
                                    onChange={(e) => onUpdateSettings({ topP: parseFloat(e.target.value) })}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    className="w-full h-1.5 bg-dark-800 rounded-full appearance-none cursor-pointer
                                               [&::-webkit-slider-thumb]:appearance-none
                                               [&::-webkit-slider-thumb]:w-4
                                               [&::-webkit-slider-thumb]:h-4
                                               [&::-webkit-slider-thumb]:rounded-full
                                               [&::-webkit-slider-thumb]:bg-primary-500
                                               [&::-webkit-slider-thumb]:shadow-lg
                                               [&::-webkit-slider-thumb]:shadow-primary-500/30
                                               [&::-webkit-slider-thumb]:cursor-pointer
                                               [&::-webkit-slider-thumb]:border-2
                                               [&::-webkit-slider-thumb]:border-dark-900"
                                />
                                <div className="flex justify-between text-[10px] text-dark-500 mt-1.5">
                                    <span>Focused</span>
                                    <span>Diverse</span>
                                </div>
                            </div>
                        </>
                    )}

                    {/* System Prompts Tab */}
                    {activeTab === 'prompts' && (
                        <>
                            {/* Create New Prompt */}
                            {!isCreatingPrompt && !editingPrompt && (
                                <button
                                    onClick={() => setIsCreatingPrompt(true)}
                                    className="flex items-center gap-1.5 w-full px-3 py-2 rounded-lg bg-primary-500/10 text-primary-400 border border-primary-500/20 hover:bg-primary-500/20 transition-all"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    <span className="text-xs font-medium">Create New Prompt</span>
                                </button>
                            )}

                            {/* Prompt Editor */}
                            {(isCreatingPrompt || editingPrompt) && (
                                <div className="space-y-3 p-3 bg-dark-800/50 rounded-lg border border-white/10">
                                    <div>
                                        <label className="block text-xs font-medium text-dark-200 mb-1.5">
                                            Prompt Name
                                        </label>
                                        <input
                                            type="text"
                                            value={newPromptName}
                                            onChange={(e) => setNewPromptName(e.target.value)}
                                            placeholder="e.g., Code Assistant, Creative Writer..."
                                            className="w-full px-3 py-2 bg-dark-800 border border-white/10 rounded-md text-dark-200 text-xs placeholder-dark-500 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/20"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-dark-200 mb-1.5">
                                            Prompt Content
                                        </label>
                                        <textarea
                                            value={newPromptContent}
                                            onChange={(e) => setNewPromptContent(e.target.value)}
                                            placeholder="Enter the system prompt content..."
                                            rows={10}
                                            className="w-full px-3 py-2 bg-dark-800 border border-white/10 rounded-md text-dark-200 text-xs placeholder-dark-500 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/20 resize-y min-h-[120px] max-h-[400px]"
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={handleSavePrompt}
                                            disabled={!newPromptName.trim()}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary-500 text-white font-medium text-xs hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <Save className="w-3.5 h-3.5" />
                                            Save
                                        </button>
                                        <button
                                            onClick={() => {
                                                setIsCreatingPrompt(false);
                                                setEditingPrompt(null);
                                                setNewPromptName('');
                                                setNewPromptContent('');
                                            }}
                                            className="px-3 py-1.5 rounded-md bg-dark-700 text-dark-300 font-medium text-xs hover:bg-dark-600 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Prompts List */}
                            {!isCreatingPrompt && !editingPrompt && (
                                <div className="space-y-1.5">
                                    {promptsList.length === 0 ? (
                                        <div className="text-center py-6">
                                            <div className="w-10 h-10 rounded-full bg-dark-800 flex items-center justify-center mx-auto mb-2">
                                                <MessageSquare className="w-4 h-4 text-dark-500" />
                                            </div>
                                            <p className="text-xs text-dark-400">No system prompts yet</p>
                                            <p className="text-[10px] text-dark-500 mt-0.5">Create one to customize AI behavior</p>
                                        </div>
                                    ) : (
                                        promptsList.map((prompt) => (
                                            <div
                                                key={prompt.id}
                                                className={`group flex items-start justify-between p-2.5 rounded-lg border transition-all ${
                                                    systemPromptId === prompt.id
                                                        ? 'bg-primary-500/10 border-primary-500/30'
                                                        : 'bg-dark-800/50 border-white/5 hover:border-white/10'
                                                }`}
                                            >
                                                <div
                                                    className="flex-1 min-w-0 cursor-pointer"
                                                    onClick={() => onUpdateSettings({ systemPromptId: prompt.id })}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className={`text-xs font-medium ${
                                                            systemPromptId === prompt.id ? 'text-primary-300' : 'text-dark-200'
                                                        }`}>
                                                            {prompt.name || prompt.id}
                                                        </span>
                                                        {systemPromptId === prompt.id && (
                                                            <span className="text-[10px] bg-primary-500/20 text-primary-400 px-1.5 py-0.5 rounded">
                                                                Active
                                                            </span>
                                                        )}
                                                    </div>
                                                    {prompt.content && (
                                                        <p className="text-[10px] text-dark-500 mt-0.5 truncate">
                                                            {prompt.content.substring(0, 80)}...
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                                                    <button
                                                        onClick={() => handleStartEdit(prompt)}
                                                        className="p-1.5 rounded-md hover:bg-white/10 text-dark-400 hover:text-dark-200"
                                                        title="Edit"
                                                    >
                                                        <Edit3 className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeletePrompt(prompt.id)}
                                                        className="p-1.5 rounded-md hover:bg-red-500/20 text-dark-400 hover:text-red-400"
                                                        title="Delete"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* Appearance Tab */}
                    {activeTab === 'appearance' && (
                        <>
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-2">
                                    Theme
                                </label>
                                <div className="grid grid-cols-4 gap-2">
                                    {themeOptions.map((option) => {
                                        const Icon = option.icon;
                                        const isActive = currentTheme === option.value;
                                        return (
                                            <button
                                                key={option.value}
                                                onClick={() => onThemeChange?.(option.value)}
                                                className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-all duration-200 ${
                                                    isActive
                                                        ? 'bg-primary-500/15 border-primary-500/40 text-primary-300'
                                                        : 'bg-dark-800/50 border-white/5 text-dark-300 hover:bg-dark-800 hover:border-white/10'
                                                }`}
                                            >
                                                <div className={`p-1.5 rounded-md ${isActive ? 'bg-primary-500/20' : 'bg-dark-700'}`}>
                                                    <Icon className="w-4 h-4" />
                                                </div>
                                                <div className="text-center">
                                                    <div className="text-[10px] font-medium flex items-center gap-1 justify-center">
                                                        {option.label}
                                                        {isActive && <Check className="w-2.5 h-2.5" />}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="border-t border-white/5" />

                            {/* Chat Layout Style */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-2">
                                    Chat Layout
                                </label>
                                <div className="grid grid-cols-3 gap-2">
                                    {chatStyleOptions.map((option) => {
                                        const Icon = option.icon;
                                        const isActive = chatStyle === option.value;
                                        return (
                                            <button
                                                key={option.value}
                                                onClick={() => onUpdateSettings({ chatStyle: option.value })}
                                                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-lg border transition-all duration-200 ${
                                                    isActive
                                                        ? 'bg-primary-500/15 border-primary-500/40 text-primary-300'
                                                        : 'bg-dark-800/50 border-white/5 text-dark-300 hover:bg-dark-800 hover:border-white/10'
                                                }`}
                                            >
                                                <div className={`p-1.5 rounded-md ${isActive ? 'bg-primary-500/20' : 'bg-dark-700'}`}>
                                                    <Icon className="w-4 h-4" />
                                                </div>
                                                <div className="text-center">
                                                    <div className="text-[10px] font-medium flex items-center gap-1 justify-center">
                                                        {option.label}
                                                        {isActive && <Check className="w-2.5 h-2.5" />}
                                                    </div>
                                                    <div className="text-[9px] text-dark-500 mt-0.5">
                                                        {option.description}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="border-t border-white/5" />

                            {/* Font Size */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-2">
                                    Font Size
                                </label>
                                <div className="grid grid-cols-3 gap-2">
                                    {fontSizeOptions.map((option) => {
                                        const isActive = fontSize === option.value;
                                        return (
                                            <button
                                                key={option.value}
                                                onClick={() => onUpdateSettings({ fontSize: option.value })}
                                                className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-all duration-200 ${
                                                    isActive
                                                        ? 'bg-primary-500/15 border-primary-500/40 text-primary-300'
                                                        : 'bg-dark-800/50 border-white/5 text-dark-300 hover:bg-dark-800 hover:border-white/10'
                                                }`}
                                            >
                                                <span className={`font-medium ${
                                                    option.value === 'small' ? 'text-[10px]' :
                                                    option.value === 'large' ? 'text-sm' : 'text-xs'
                                                }`}>
                                                    Aa
                                                </span>
                                                <div className="text-center">
                                                    <div className="text-[10px] font-medium flex items-center gap-0.5 justify-center">
                                                        {option.label}
                                                        {isActive && <Check className="w-2.5 h-2.5" />}
                                                    </div>
                                                    <div className="text-[9px] text-dark-500">
                                                        {option.description}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Font Family */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-1.5">
                                    Font Family
                                </label>
                                <div className="relative">
                                    <select
                                        value={fontFamily}
                                        onChange={(e) => onUpdateSettings({ fontFamily: e.target.value })}
                                        className="w-full px-3 py-1.5 bg-dark-800/80 border border-white/10 rounded-md text-dark-200 text-xs appearance-none cursor-pointer hover:border-white/20 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/20 transition-all"
                                    >
                                        {fontFamilyOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-400 pointer-events-none" />
                                </div>
                            </div>

                            <div className="border-t border-white/5" />

                            {/* Theme Preview */}
                            <div>
                                <label className="block text-xs font-medium text-dark-200 mb-2">
                                    Preview
                                </label>
                                <div className={`p-3 rounded-lg border ${
                                    currentTheme === 'light'
                                        ? 'bg-white border-gray-200'
                                        : 'bg-dark-800 border-white/10'
                                }`}>
                                    <div className="flex items-start gap-2 mb-2">
                                        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${
                                            currentTheme === 'light' ? 'bg-gray-100' : 'bg-dark-700'
                                        }`}>
                                            <MessageSquare className={`w-3 h-3 ${
                                                currentTheme === 'light' ? 'text-gray-500' : 'text-dark-400'
                                            }`} />
                                        </div>
                                        <div className={`flex-1 p-2 rounded-md ${
                                            currentTheme === 'light' ? 'bg-gray-100' : 'bg-dark-700'
                                        }`}>
                                            <p className={`text-xs ${
                                                currentTheme === 'light' ? 'text-gray-700' : 'text-dark-300'
                                            }`}>
                                                Messages in {currentTheme === 'system' ? 'system' : currentTheme} mode.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-2 flex-row-reverse">
                                        <div className="w-6 h-6 rounded-md bg-primary-500 flex items-center justify-center">
                                            <span className="text-[10px] font-bold text-white">U</span>
                                        </div>
                                        <div className="flex-1 p-2 rounded-md bg-primary-500/20">
                                            <p className="text-xs text-primary-300">
                                                Your messages look like this.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
