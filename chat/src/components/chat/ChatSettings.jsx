import React, { useState, useEffect, useRef, useCallback } from 'react';
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
    Monitor,
    Target,
    AlignCenter,
    GitCommitVertical,
    MessageCircle,
    PanelLeft,
    Rows3,
    Type,
    Brain,
    RefreshCw,
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';
import { loadGoogleFonts } from '../../fontLoader';

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
    activeConversationId = null,
}) {
    const [activeTab, setActiveTab] = useState('chat');
    const [editingPrompt, setEditingPrompt] = useState(null);
    const [newPromptName, setNewPromptName] = useState('');
    const [newPromptContent, setNewPromptContent] = useState('');
    const [isCreatingPrompt, setIsCreatingPrompt] = useState(false);
    const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
    const [fontSearch, setFontSearch] = useState('');
    const fontDropdownRef = useRef(null);
    const confirm = useConfirm();

    // Memories tab state — fetched lazily when the tab opens.
    const [memories, setMemories] = useState([]);
    const [memoriesLoading, setMemoriesLoading] = useState(false);
    const [memoriesError, setMemoriesError] = useState(null);
    const [editingMemoryId, setEditingMemoryId] = useState(null);
    const [editingMemoryText, setEditingMemoryText] = useState('');

    const fetchMemories = useCallback(async () => {
        if (!activeConversationId) {
            setMemories([]);
            setMemoriesError(null);
            return;
        }
        setMemoriesLoading(true);
        setMemoriesError(null);
        try {
            const res = await fetch(`/api/conversations/${activeConversationId}/memories`, {
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setMemories(Array.isArray(data.memories) ? data.memories : []);
        } catch (e) {
            setMemoriesError(e.message || 'Failed to load memories');
            setMemories([]);
        } finally {
            setMemoriesLoading(false);
        }
    }, [activeConversationId]);

    // Refetch whenever the Memories tab is opened or the conversation changes.
    useEffect(() => {
        if (open && activeTab === 'memories') {
            fetchMemories();
        }
    }, [open, activeTab, fetchMemories]);

    const handleDeleteMemory = async (memId) => {
        const confirmed = await confirm({
            title: 'Delete Memory',
            message: 'Delete this memory? The assistant will no longer use it as context on future turns in this conversation.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`/api/conversations/${activeConversationId}/memories/${memId}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setMemories(prev => prev.filter(m => m.id !== memId));
        } catch (e) {
            setMemoriesError(e.message || 'Failed to delete memory');
        }
    };

    const handleClearAllMemories = async () => {
        const confirmed = await confirm({
            title: 'Clear All Memories',
            message: `Delete all ${memories.length} memories for this conversation? They will be regenerated automatically as the conversation continues.`,
            confirmText: 'Clear All',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`/api/conversations/${activeConversationId}/memories`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setMemories([]);
        } catch (e) {
            setMemoriesError(e.message || 'Failed to clear memories');
        }
    };

    const handleStartEditMemory = (mem) => {
        setEditingMemoryId(mem.id);
        setEditingMemoryText(mem.text);
    };

    const handleCancelEditMemory = () => {
        setEditingMemoryId(null);
        setEditingMemoryText('');
    };

    const handleSaveMemoryEdit = async () => {
        if (!editingMemoryId || !editingMemoryText.trim()) return;
        try {
            const res = await fetch(`/api/conversations/${activeConversationId}/memories/${editingMemoryId}`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: editingMemoryText.trim() }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setMemories(prev => prev.map(m =>
                m.id === editingMemoryId
                    ? { ...m, ...data.memory, id: editingMemoryId }
                    : m
            ));
            handleCancelEditMemory();
        } catch (e) {
            setMemoriesError(e.message || 'Failed to save memory edit');
        }
    };

    const {
        temperature = 0.7,
        maxTokens = contextSize,  // Default to model's context window
        selectedSystemPromptId = null,
        topP = 1.0,
        frequencyPenalty = 0,
        presencePenalty = 0,
        fontSize = 'medium',
        fontFamily = 'system',
        chatStyle = 'default',
        messageBorderStrength = 10,
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
            value: 'timeline',
            label: 'Timeline',
            icon: GitCommitVertical,
            description: 'Vertical timeline flow',
            preview: { userAlign: 'left', assistantAlign: 'left', width: 'normal' }
        },
        {
            value: 'bubbles',
            label: 'Bubbles',
            icon: MessageCircle,
            description: 'Rounded iMessage-style bubbles',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'normal' }
        },
        {
            value: 'slack',
            label: 'Slack',
            icon: PanelLeft,
            description: 'Flat, left-aligned messages',
            preview: { userAlign: 'left', assistantAlign: 'left', width: 'normal' }
        },
        {
            value: 'minimal',
            label: 'Minimal',
            icon: Rows3,
            description: 'Clean dividers, no bubbles',
            preview: { userAlign: 'right', assistantAlign: 'left', width: 'normal' }
        },
    ];

    // Font options with resolution presets
    const fontSizeOptions = [
        { value: 'small', label: 'Small', description: '1080p / Compact' },
        { value: 'medium', label: 'Medium', description: '2K / Default' },
        { value: 'large', label: 'Large', description: '4K / Spacious' },
    ];

    // Font CSS family mapping for live preview in dropdown
    const fontCssMap = {
        system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        inter: '"Inter", sans-serif', roboto: '"Roboto", sans-serif', opensans: '"Open Sans", sans-serif',
        lato: '"Lato", sans-serif', poppins: '"Poppins", sans-serif', nunito: '"Nunito", sans-serif',
        sourcesans: '"Source Sans 3", "Source Sans Pro", sans-serif', dmsans: '"DM Sans", sans-serif',
        worksans: '"Work Sans", sans-serif', plusjakarta: '"Plus Jakarta Sans", sans-serif',
        lexend: '"Lexend", sans-serif', outfit: '"Outfit", sans-serif',
        spacegrotesk: '"Space Grotesk", sans-serif', ibmplex: '"IBM Plex Sans", sans-serif',
        manrope: '"Manrope", sans-serif', urbanist: '"Urbanist", sans-serif', sora: '"Sora", sans-serif',
        atkinson: '"Atkinson Hyperlegible", sans-serif', geist: '"Geist", sans-serif',
        figtree: '"Figtree", sans-serif', onest: '"Onest", sans-serif', rubik: '"Rubik", sans-serif',
        quicksand: '"Quicksand", sans-serif', comfortaa: '"Comfortaa", sans-serif',
        overpass: '"Overpass", sans-serif', karla: '"Karla", sans-serif', assistant: '"Assistant", sans-serif',
        exo2: '"Exo 2", sans-serif', barlow: '"Barlow", sans-serif', publicsans: '"Public Sans", sans-serif',
        redhatdisplay: '"Red Hat Display", sans-serif', readexpro: '"Readex Pro", sans-serif',
        merriweather: '"Merriweather", serif', playfair: '"Playfair Display", serif', georgia: 'Georgia, serif',
        crimsonpro: '"Crimson Pro", serif', librebaskerville: '"Libre Baskerville", serif',
        lora: '"Lora", serif', sourceserpro: '"Source Serif 4", "Source Serif Pro", serif',
        jetbrains: '"JetBrains Mono", monospace', firacode: '"Fira Code", monospace',
        consolas: 'Consolas, monospace', spacemono: '"Space Mono", monospace',
        ubuntumono: '"Ubuntu Mono", monospace', anonymouspro: '"Anonymous Pro", monospace',
        cascadiacode: '"Cascadia Code", monospace', victormono: '"Victor Mono", monospace',
        geistmono: '"Geist Mono", monospace', sourcecodepro: '"Source Code Pro", monospace',
        intelone: '"Intel One Mono", monospace', inconsolata: '"Inconsolata", monospace',
        martianmono: '"Martian Mono", monospace',
    };

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
        { value: 'sourcecodepro', label: 'Source Code Pro', category: 'mono' },
        { value: 'intelone', label: 'Intel One Mono', category: 'mono' },
        { value: 'inconsolata', label: 'Inconsolata', category: 'mono' },
        { value: 'martianmono', label: 'Martian Mono', category: 'mono' },
    ];

    // Reset state when modal closes
    useEffect(() => {
        if (!open) {
            setEditingPrompt(null);
            setIsCreatingPrompt(false);
            setNewPromptName('');
            setNewPromptContent('');
            setFontDropdownOpen(false);
            setFontSearch('');
        }
    }, [open]);

    // Close font dropdown on click outside
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (fontDropdownRef.current && !fontDropdownRef.current.contains(e.target)) {
                setFontDropdownOpen(false);
            }
        };
        if (fontDropdownOpen) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [fontDropdownOpen]);

    if (!open) return null;

    const themeOptions = [
        { label: 'Standard', options: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
        ]},
        { label: 'Nature', options: [
            { value: 'ocean', label: 'Ocean' },
            { value: 'sunset', label: 'Sunset' },
            { value: 'sand', label: 'Sand' },
        ]},
        { label: 'Warm Tones', options: [
            { value: 'copper', label: 'Copper' },
            { value: 'mocha', label: 'Mocha' },
        ]},
        { label: 'Neutral', options: [
            { value: 'slate', label: 'Slate' },
            { value: 'storm', label: 'Storm' },
        ]},
        { label: 'Dev Classics', options: [
            { value: 'solarized', label: 'Solarized' },
            { value: 'kanagawa', label: 'Kanagawa' },
            { value: 'palenight', label: 'Palenight' },
            { value: 'ayu', label: 'Ayu' },
        ]},
        { label: 'Vibrant', options: [
            { value: 'matrix', label: 'Matrix' },
            { value: 'andromeda', label: 'Andromeda' },
            { value: 'poimandres', label: 'Poimandres' },
            { value: 'oxocarbon', label: 'Oxocarbon' },
            { value: 'crimson', label: 'Crimson' },
        ]},
    ];

    const currentTheme = theme || 'system';

    const tabs = [
        { id: 'chat', label: 'Chat Settings', icon: Settings },
        { id: 'prompts', label: 'System Prompts', icon: MessageSquare },
        { id: 'memories', label: 'Memories', icon: Brain },
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
            if (selectedSystemPromptId === promptId) {
                onUpdateSettings({ selectedSystemPromptId: null });
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
                                        value={selectedSystemPromptId || ''}
                                        onChange={(e) => onUpdateSettings({ selectedSystemPromptId: e.target.value || null })}
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

                            {/* Temperature */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-xs font-medium text-dark-200 flex items-center gap-1.5">
                                        Temperature
                                        <span className="group relative">
                                            <svg className="w-3.5 h-3.5 text-dark-500 hover:text-dark-300 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="absolute left-0 top-full mt-1.5 px-2.5 py-2 text-[10px] leading-relaxed text-dark-100 bg-dark-800 border border-dark-700 rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none w-52 z-50">
                                                How "creative" the responses are. Low values give predictable, consistent answers (good for facts, code, math). High values give more varied, imaginative responses (good for stories, brainstorming).
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
                                            <span className="absolute left-0 top-full mt-1.5 px-2.5 py-2 text-[10px] leading-relaxed text-dark-100 bg-dark-800 border border-dark-700 rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none w-52 z-50">
                                                Limits which words the model considers. At 1.0 all words are possible. Lower values (0.5-0.9) make the model only pick from the most likely words, giving more focused and on-topic responses.
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
                                                    selectedSystemPromptId === prompt.id
                                                        ? 'bg-primary-500/10 border-primary-500/30'
                                                        : 'bg-dark-800/50 border-white/5 hover:border-white/10'
                                                }`}
                                            >
                                                <div
                                                    className="flex-1 min-w-0 cursor-pointer"
                                                    onClick={() => onUpdateSettings({ selectedSystemPromptId: prompt.id })}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className={`text-xs font-medium ${
                                                            selectedSystemPromptId === prompt.id ? 'text-primary-300' : 'text-dark-200'
                                                        }`}>
                                                            {prompt.name || prompt.id}
                                                        </span>
                                                        {selectedSystemPromptId === prompt.id && (
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

                    {/* Memories Tab */}
                    {activeTab === 'memories' && (
                        <>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="text-xs font-semibold text-dark-200 mb-1">
                                        Conversation Memories
                                    </h3>
                                    <p className="text-[11px] text-dark-400 leading-relaxed">
                                        Facts automatically extracted from this conversation.
                                        They're injected as context on future turns so details
                                        survive even after older messages roll off the context window.
                                    </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                        type="button"
                                        onClick={fetchMemories}
                                        disabled={!activeConversationId || memoriesLoading}
                                        className="p-1.5 rounded-md hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        title="Refresh"
                                    >
                                        <RefreshCw className={`w-3.5 h-3.5 ${memoriesLoading ? 'animate-spin' : ''}`} />
                                    </button>
                                    {memories.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={handleClearAllMemories}
                                            className="px-2 py-1 rounded-md text-[10px] font-medium bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-colors"
                                        >
                                            Clear All
                                        </button>
                                    )}
                                </div>
                            </div>

                            {memoriesError && (
                                <div className="p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-[11px]">
                                    {memoriesError}
                                </div>
                            )}

                            {!activeConversationId ? (
                                <div className="text-center py-8">
                                    <Brain className="w-8 h-8 text-dark-500 mx-auto mb-2" />
                                    <p className="text-xs text-dark-400">
                                        Select a conversation to view its memories.
                                    </p>
                                </div>
                            ) : memoriesLoading && memories.length === 0 ? (
                                <div className="text-center py-8">
                                    <RefreshCw className="w-5 h-5 text-dark-500 mx-auto mb-2 animate-spin" />
                                    <p className="text-xs text-dark-400">Loading memories…</p>
                                </div>
                            ) : memories.length === 0 ? (
                                <div className="text-center py-8">
                                    <Brain className="w-8 h-8 text-dark-500 mx-auto mb-2" />
                                    <p className="text-xs text-dark-400 mb-1">
                                        No memories yet for this conversation.
                                    </p>
                                    <p className="text-[10px] text-dark-500">
                                        Memories are extracted automatically as you chat.
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <div className="text-[10px] text-dark-500 -mt-1">
                                        {memories.length} {memories.length === 1 ? 'memory' : 'memories'} stored
                                    </div>
                                    <div className="space-y-2">
                                        {memories.map((mem) => {
                                            const isEditing = editingMemoryId === mem.id;
                                            return (
                                                <div
                                                    key={mem.id}
                                                    className="group p-2.5 rounded-lg bg-dark-800/50 border border-white/5 hover:border-white/10 transition-colors"
                                                >
                                                    {isEditing ? (
                                                        <>
                                                            <textarea
                                                                value={editingMemoryText}
                                                                onChange={(e) => setEditingMemoryText(e.target.value)}
                                                                rows={3}
                                                                className="w-full px-2 py-1.5 bg-dark-900 border border-white/10 rounded-md text-[12px] text-dark-100 resize-none focus:border-primary-500/50 focus:outline-none"
                                                                autoFocus
                                                            />
                                                            <div className="flex items-center justify-end gap-1.5 mt-1.5">
                                                                <button
                                                                    type="button"
                                                                    onClick={handleCancelEditMemory}
                                                                    className="px-2 py-1 rounded text-[10px] font-medium text-dark-300 hover:bg-white/5 transition-colors"
                                                                >
                                                                    Cancel
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={handleSaveMemoryEdit}
                                                                    disabled={!editingMemoryText.trim()}
                                                                    className="px-2 py-1 rounded text-[10px] font-medium bg-primary-500/20 hover:bg-primary-500/30 text-primary-300 border border-primary-500/30 transition-colors disabled:opacity-40"
                                                                >
                                                                    Save
                                                                </button>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <div className="flex items-start gap-2">
                                                                <p className="flex-1 text-[12px] text-dark-200 leading-relaxed break-words">
                                                                    {mem.text}
                                                                </p>
                                                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleStartEditMemory(mem)}
                                                                        className="p-1 rounded hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-colors"
                                                                        title="Edit"
                                                                    >
                                                                        <Edit3 className="w-3 h-3" />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleDeleteMemory(mem.id)}
                                                                        className="p-1 rounded hover:bg-red-500/20 text-dark-400 hover:text-red-300 transition-colors"
                                                                        title="Delete"
                                                                    >
                                                                        <Trash2 className="w-3 h-3" />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-2 mt-1.5 text-[9px] text-dark-500">
                                                                <span className={`px-1.5 py-0.5 rounded font-medium ${
                                                                    mem.sourceRole === 'user'
                                                                        ? 'bg-blue-500/10 text-blue-300'
                                                                        : 'bg-emerald-500/10 text-emerald-300'
                                                                }`}>
                                                                    {mem.sourceRole}
                                                                </span>
                                                                <span>{mem.tokens || 0} tokens</span>
                                                                {mem.keywords?.length > 0 && (
                                                                    <span className="truncate">
                                                                        {mem.keywords.slice(0, 4).join(' · ')}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
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
                                <div className="space-y-3">
                                    {themeOptions.map((group) => (
                                        <div key={group.label}>
                                            <div className="text-[10px] font-medium text-dark-400 uppercase tracking-wider mb-1.5">{group.label}</div>
                                            <div className="grid grid-cols-4 gap-2">
                                                {group.options.map((option) => {
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
                                    ))}
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

                            {/* Message Border Strength - only show for layouts that use borders */}
                            {['slack', 'minimal'].includes(chatStyle) && (
                                <>
                                    <div className="border-t border-white/5" />
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <label className="text-xs font-medium text-dark-200">
                                                Message Borders
                                            </label>
                                            <span className="text-xs font-mono text-primary-400 bg-primary-500/10 px-1.5 py-0.5 rounded">
                                                {messageBorderStrength}%
                                            </span>
                                        </div>
                                        <input
                                            type="range"
                                            value={messageBorderStrength}
                                            onChange={(e) => onUpdateSettings({ messageBorderStrength: parseInt(e.target.value) })}
                                            min={0}
                                            max={40}
                                            step={1}
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
                                            <span>Subtle</span>
                                            <span>Strong</span>
                                        </div>
                                    </div>
                                </>
                            )}

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

                            {/* Font Family - Custom dropdown with live preview */}
                            <div ref={fontDropdownRef}>
                                <label className="block text-xs font-medium text-dark-200 mb-1.5">
                                    Font Family
                                </label>
                                <div className="relative">
                                    {/* Selected font trigger */}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (!fontDropdownOpen) {
                                                loadGoogleFonts(fontFamilyOptions.map(f => f.value));
                                            }
                                            setFontDropdownOpen(!fontDropdownOpen);
                                        }}
                                        className="w-full flex items-center justify-between px-3 py-2 bg-dark-800/80 border border-white/10 rounded-md text-dark-200 text-sm cursor-pointer hover:border-white/20 transition-all"
                                        style={{ fontFamily: fontCssMap[fontFamily] || 'inherit' }}
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Type className="w-3.5 h-3.5 text-dark-400 flex-shrink-0" />
                                            <span className="truncate">{fontFamilyOptions.find(f => f.value === fontFamily)?.label || 'System Default'}</span>
                                            <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-white/5 text-dark-400 flex-shrink-0">
                                                {fontFamilyOptions.find(f => f.value === fontFamily)?.category || 'sans'}
                                            </span>
                                        </div>
                                        <ChevronDown className={`w-3.5 h-3.5 text-dark-400 flex-shrink-0 transition-transform ${fontDropdownOpen ? 'rotate-180' : ''}`} />
                                    </button>

                                    {/* Font dropdown list */}
                                    {fontDropdownOpen && (
                                        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-dark-900/98 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl overflow-hidden">
                                            {/* Search */}
                                            <div className="p-2 border-b border-white/5">
                                                <input
                                                    type="text"
                                                    value={fontSearch}
                                                    onChange={(e) => setFontSearch(e.target.value)}
                                                    placeholder="Search fonts..."
                                                    className="w-full px-2.5 py-1.5 bg-dark-800/60 border border-white/10 rounded text-xs text-dark-200 placeholder-dark-500 focus:outline-none focus:border-white/20"
                                                    autoFocus
                                                />
                                            </div>
                                            {/* Font list */}
                                            <div className="max-h-56 overflow-y-auto">
                                                {['sans', 'serif', 'mono'].map(cat => {
                                                    const filtered = fontFamilyOptions
                                                        .filter(f => f.category === cat)
                                                        .filter(f => !fontSearch || f.label.toLowerCase().includes(fontSearch.toLowerCase()));
                                                    if (filtered.length === 0) return null;
                                                    return (
                                                        <div key={cat}>
                                                            <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-dark-500 font-semibold bg-dark-800/40 sticky top-0">
                                                                {cat === 'sans' ? 'Sans-Serif' : cat === 'serif' ? 'Serif' : 'Monospace'}
                                                            </div>
                                                            {filtered.map(option => (
                                                                <button
                                                                    key={option.value}
                                                                    onClick={() => {
                                                                        onUpdateSettings({ fontFamily: option.value });
                                                                        setFontDropdownOpen(false);
                                                                        setFontSearch('');
                                                                    }}
                                                                    className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-white/5 transition-colors ${fontFamily === option.value ? 'bg-white/8' : ''}`}
                                                                    style={{ fontFamily: fontCssMap[option.value] || 'inherit' }}
                                                                >
                                                                    <span className={`truncate ${fontFamily === option.value ? 'text-dark-100' : 'text-dark-300'}`}>
                                                                        {option.label}
                                                                    </span>
                                                                    {fontFamily === option.value && (
                                                                        <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                                                                    )}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
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
