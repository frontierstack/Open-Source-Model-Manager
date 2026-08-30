import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    X,
    ChevronDown,
    ChevronRight,
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
    RefreshCw,
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';
import { loadGoogleFonts } from '../../fontLoader';
import { useChatStore } from '../../stores/useChatStore';

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
    activeConversationTitle = '',
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

    // Server-wide upload size limit. Editable when the caller is an admin
    // (probed via the admin GET — 403 means regular user → read-only display).
    const [uploadMaxMb, setUploadMaxMb] = useState(null);      // saved value on the server
    const [uploadMaxDraft, setUploadMaxDraft] = useState('');  // input field contents
    const [uploadLimitEditable, setUploadLimitEditable] = useState(false);
    const [uploadLimitSaving, setUploadLimitSaving] = useState(false);
    const [uploadLimitError, setUploadLimitError] = useState('');

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        (async () => {
            try {
                const r = await fetch('/api/system-settings', { credentials: 'include' });
                if (r.ok) {
                    const d = await r.json();
                    if (cancelled) return;
                    setUploadLimitEditable(true);
                    setUploadMaxMb(d.uploadMaxMb);
                    setUploadMaxDraft(String(d.uploadMaxMb));
                    return;
                }
            } catch (_) { /* fall through to public read */ }
            try {
                const r = await fetch('/api/system-settings/public', { credentials: 'include' });
                if (r.ok) {
                    const d = await r.json();
                    if (cancelled) return;
                    setUploadLimitEditable(false);
                    setUploadMaxMb(d.uploadMaxMb);
                    setUploadMaxDraft(String(d.uploadMaxMb));
                }
            } catch (_) {}
        })();
        return () => { cancelled = true; };
    }, [open]);

    const saveUploadLimit = async () => {
        const mb = Math.round(Number(uploadMaxDraft));
        if (!Number.isFinite(mb) || mb < 1 || mb > 1024) {
            setUploadLimitError('Enter a value between 1 and 1024 MB');
            return;
        }
        setUploadLimitSaving(true);
        setUploadLimitError('');
        try {
            const r = await fetch('/api/system-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ uploadMaxMb: mb }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            setUploadMaxMb(d.uploadMaxMb);
            setUploadMaxDraft(String(d.uploadMaxMb));
        } catch (e) {
            setUploadLimitError(e.message || 'Failed to save');
        } finally {
            setUploadLimitSaving(false);
        }
    };

    const {
        temperature = 0.7,
        maxTokens = contextSize,  // Default to model's context window
        selectedSystemPromptId = null,
        topP = 1.0,
        reasoningEffort = 'default',
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
                className="dlg-backdrop z-40"
                onClick={onClose}
            />

            {/* Modal */}
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="chat-settings-title"
                className="dlg set-dlg fixed inset-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 z-50 animate-fade-in"
            >
                {/* Header */}
                <div className="dlg-header">
                    <h2 id="chat-settings-title" className="dlg-title flex-1">Settings</h2>
                    <button
                        onClick={onClose}
                        className="ui-icon-btn ui-icon-btn-lg"
                        aria-label="Close settings"
                    >
                        <X strokeWidth={2} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="set-tabs">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`set-tab ${activeTab === tab.id ? 'is-active' : ''}`}
                            >
                                <Icon strokeWidth={1.75} />
                                <span className="hidden sm:inline">{tab.label}</span>
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="dlg-body set-body">
                    {/* Chat Settings Tab */}
                    {activeTab === 'chat' && (
                        <>
                            {/* System Prompt Selector */}
                            <div>
                                <label className="set-label">
                                    Active System Prompt
                                </label>
                                <div className="relative">
                                    <select
                                        value={selectedSystemPromptId || ''}
                                        onChange={(e) => onUpdateSettings({ selectedSystemPromptId: e.target.value || null })}
                                        className="set-select"
                                    >
                                        <option value="">None (default behavior)</option>
                                        {promptsList.map((prompt) => (
                                            <option key={prompt.id} value={prompt.id}>
                                                {prompt.name || prompt.id}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none" style={{ color: 'var(--ink-4)' }} />
                                </div>
                            </div>

                            <div className="set-divider" />

                            {/* Temperature */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="set-label-inline">
                                        Temperature
                                        <span className="group relative">
                                            <svg className="set-help-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="set-tooltip">
                                                How "creative" the responses are. Low values give predictable, consistent answers (good for facts, code, math). High values give more varied, imaginative responses (good for stories, brainstorming).
                                            </span>
                                        </span>
                                    </label>
                                    <span className="set-value">
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
                                    className="set-range"
                                />
                                <div className="set-range-ends">
                                    <span>Precise</span>
                                    <span>Creative</span>
                                </div>
                            </div>

                            {/* Top P */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="set-label-inline">
                                        Top P
                                        <span className="group relative">
                                            <svg className="set-help-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="set-tooltip">
                                                Limits which words the model considers. At 1.0 all words are possible. Lower values (0.5-0.9) make the model only pick from the most likely words, giving more focused and on-topic responses.
                                            </span>
                                        </span>
                                    </label>
                                    <span className="set-value">
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
                                    className="set-range"
                                />
                                <div className="set-range-ends">
                                    <span>Focused</span>
                                    <span>Diverse</span>
                                </div>
                            </div>

                            {/* Reasoning effort — same setting as the composer's Effort chip */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="set-label-inline">
                                        Reasoning effort
                                        <span className="group relative">
                                            <svg className="set-help-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span className="set-tooltip">
                                                How much the model thinks before answering. Off disables the thinking trace; Low/Medium cap it (fast); High lets it reason at length. Default keeps the model's own setting. Applied natively where the model supports it, otherwise as a prompt hint.
                                            </span>
                                        </span>
                                    </label>
                                </div>
                                <div className="set-seg" role="radiogroup" aria-label="Reasoning effort">
                                    {[['default','Default'],['off','Off'],['low','Low'],['medium','Medium'],['high','High']].map(([v, label]) => (
                                        <button
                                            key={v}
                                            type="button"
                                            role="radio"
                                            aria-checked={reasoningEffort === v}
                                            className={`set-seg-btn${reasoningEffort === v ? ' is-active' : ''}`}
                                            onClick={() => onUpdateSettings({ reasoningEffort: v })}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Live code preview — default OFF; opt in per session. */}
                            <div className="set-divider" style={{ paddingTop: 16 }}>
                                <label className="flex items-start justify-between gap-3 cursor-pointer">
                                    <div className="flex-1 min-w-0">
                                        <div className="set-row-title">
                                            Live code preview
                                        </div>
                                        <div className="set-row-help">
                                            Adds a Run button to Python and HTML code blocks the assistant writes. Python executes in the gVisor sandbox; HTML renders in an isolated iframe. Off by default — when off, no Run button and no preview is rendered.
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={!!settings?.codePreviewEnabled}
                                        onClick={() => onUpdateSettings({ codePreviewEnabled: !settings?.codePreviewEnabled })}
                                        className={`set-toggle ${settings?.codePreviewEnabled ? 'is-on' : ''}`}
                                    >
                                        <span className="set-toggle-knob" />
                                    </button>
                                </label>
                            </div>

                            {/* Account memory — on by default. Management lives in the
                                webapp Memory tab; here we only offer the on/off switch. */}
                            <div className="set-divider" style={{ paddingTop: 16 }}>
                                <label className="flex items-start justify-between gap-3 cursor-pointer">
                                    <div className="flex-1 min-w-0">
                                        <div className="set-row-title">
                                            Account memory
                                        </div>
                                        <div className="set-row-help">
                                            Lets the assistant remember preferences, facts, and lessons across all your chats and pull the most relevant into each reply. Manage what's stored from the Memory tab in the main app. Turn off to stop using, extracting, and recording memories.
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={!settings?.memoryDisabled}
                                        onClick={() => onUpdateSettings({ memoryDisabled: !settings?.memoryDisabled })}
                                        className={`set-toggle ${!settings?.memoryDisabled ? 'is-on' : ''}`}
                                    >
                                        <span className="set-toggle-knob" />
                                    </button>
                                </label>
                            </div>

                            {/* Upload size limit — server-wide; editable by admins only. */}
                            <div className="set-divider" style={{ paddingTop: 16 }}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="set-row-title">Max upload size</div>
                                        <div className="set-row-help">
                                            {uploadLimitEditable
                                                ? 'Largest file that can be attached to a chat. Applies to everyone on this server.'
                                                : 'Largest file that can be attached to a chat. Set by an administrator.'}
                                        </div>
                                        {uploadLimitError && (
                                            <div className="mt-1" style={{ '--fs': '11.5px', color: 'var(--danger)' }}>{uploadLimitError}</div>
                                        )}
                                    </div>
                                    {uploadLimitEditable ? (
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                            <input
                                                type="number"
                                                min={1}
                                                max={1024}
                                                value={uploadMaxDraft}
                                                onChange={(e) => setUploadMaxDraft(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') saveUploadLimit(); }}
                                                className="set-input set-input-sm w-16 text-right"
                                            />
                                            <span style={{ '--fs': '12px', color: 'var(--ink-3)' }}>MB</span>
                                            {uploadMaxMb != null && String(uploadMaxMb) !== uploadMaxDraft.trim() && (
                                                <button
                                                    onClick={saveUploadLimit}
                                                    disabled={uploadLimitSaving}
                                                    className="ui-btn ui-btn-sm ui-btn-soft"
                                                >
                                                    {uploadLimitSaving ? 'Saving…' : 'Save'}
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        <span className="set-value mt-0.5">
                                            {uploadMaxMb != null ? `${uploadMaxMb} MB` : '—'}
                                        </span>
                                    )}
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
                                    className="ui-btn ui-btn-soft w-full"
                                    style={{ justifyContent: 'center' }}
                                >
                                    <Plus />
                                    <span>Create New Prompt</span>
                                </button>
                            )}

                            {/* Prompt Editor */}
                            {(isCreatingPrompt || editingPrompt) && (
                                <div className="set-editor">
                                    <div>
                                        <label className="set-label" style={{ marginBottom: 6 }}>
                                            Prompt Name
                                        </label>
                                        <input
                                            type="text"
                                            value={newPromptName}
                                            onChange={(e) => setNewPromptName(e.target.value)}
                                            placeholder="e.g., Code Assistant, Creative Writer..."
                                            className="set-input w-full"
                                        />
                                    </div>
                                    <div>
                                        <label className="set-label" style={{ marginBottom: 6 }}>
                                            Prompt Content
                                        </label>
                                        <textarea
                                            value={newPromptContent}
                                            onChange={(e) => setNewPromptContent(e.target.value)}
                                            placeholder="Enter the system prompt content..."
                                            rows={10}
                                            className="set-input w-full min-h-[120px] max-h-[400px]"
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={handleSavePrompt}
                                            disabled={!newPromptName.trim()}
                                            className="ui-btn ui-btn-primary"
                                        >
                                            <Save />
                                            Save
                                        </button>
                                        <button
                                            onClick={() => {
                                                setIsCreatingPrompt(false);
                                                setEditingPrompt(null);
                                                setNewPromptName('');
                                                setNewPromptContent('');
                                            }}
                                            className="ui-btn ui-btn-secondary"
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
                                        <div className="set-empty">
                                            <div className="set-empty-icon">
                                                <MessageSquare />
                                            </div>
                                            <p>No system prompts yet</p>
                                            <p>Create one to customize AI behavior</p>
                                        </div>
                                    ) : (
                                        promptsList.map((prompt) => (
                                            <div
                                                key={prompt.id}
                                                className={`group set-prompt-row ${selectedSystemPromptId === prompt.id ? 'is-active' : ''}`}
                                            >
                                                <div
                                                    className="flex-1 min-w-0 cursor-pointer"
                                                    onClick={() => onUpdateSettings({ selectedSystemPromptId: prompt.id })}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="set-prompt-name">
                                                            {prompt.name || prompt.id}
                                                        </span>
                                                        {selectedSystemPromptId === prompt.id && (
                                                            <span className="set-pill">Active</span>
                                                        )}
                                                    </div>
                                                    {prompt.content && (
                                                        <p className="set-prompt-preview">
                                                            {prompt.content.substring(0, 80)}...
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity ml-2" style={{ marginTop: -2 }}>
                                                    <button
                                                        onClick={() => handleStartEdit(prompt)}
                                                        className="ui-icon-btn"
                                                        title="Edit"
                                                    >
                                                        <Edit3 />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeletePrompt(prompt.id)}
                                                        className="ui-icon-btn is-danger"
                                                        title="Delete"
                                                    >
                                                        <Trash2 />
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
                                <label className="set-label">
                                    Theme
                                </label>
                                <div className="space-y-3">
                                    {themeOptions.map((group) => (
                                        <div key={group.label}>
                                            <div className="set-group-label">{group.label}</div>
                                            <div className="grid grid-cols-4 gap-2">
                                                {group.options.map((option) => {
                                                    const isActive = currentTheme === option.value;
                                                    return (
                                                        <button
                                                            key={option.value}
                                                            onClick={() => onThemeChange?.(option.value)}
                                                            className={`set-card ${isActive ? 'is-active' : ''}`}
                                                            style={{ minHeight: 36, padding: '6px 10px' }}
                                                        >
                                                            <div className="set-card-title">
                                                                {option.label}
                                                                {isActive && <Check strokeWidth={2.5} />}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="set-divider" />

                            {/* Chat Layout Style */}
                            <div>
                                <label className="set-label">
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
                                                className={`set-card ${isActive ? 'is-active' : ''}`}
                                                style={{ padding: '10px 10px 9px' }}
                                            >
                                                <div className="set-card-icon">
                                                    <Icon strokeWidth={1.75} />
                                                </div>
                                                <div className="text-center">
                                                    <div className="set-card-title justify-center">
                                                        {option.label}
                                                        {isActive && <Check strokeWidth={2.5} />}
                                                    </div>
                                                    <div className="set-card-sub">
                                                        {option.description}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Message Border Strength - applies to all chat layouts */}
                            {true && (
                                <>
                                    <div className="set-divider" />
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <label className="set-label-inline">
                                                Message Borders
                                            </label>
                                            <span className="set-value">
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
                                            className="set-range"
                                        />
                                        <div className="set-range-ends">
                                            <span>Subtle</span>
                                            <span>Strong</span>
                                        </div>
                                    </div>
                                </>
                            )}

                            <div className="set-divider" />

                            {/* Font Size */}
                            <div>
                                <label className="set-label">
                                    Font Size
                                </label>
                                <div className="grid grid-cols-3 gap-2">
                                    {fontSizeOptions.map((option) => {
                                        const isActive = fontSize === option.value;
                                        return (
                                            <button
                                                key={option.value}
                                                onClick={() => onUpdateSettings({ fontSize: option.value })}
                                                className={`set-card ${isActive ? 'is-active' : ''}`}
                                                style={{ padding: '10px 10px 9px' }}
                                            >
                                                <span style={{ fontWeight: 600, lineHeight: 1, '--fs': option.value === 'small' ? '13px' : option.value === 'large' ? '19px' : '16px', height: 20, display: 'inline-flex', alignItems: 'flex-end' }}>
                                                    Aa
                                                </span>
                                                <div className="text-center">
                                                    <div className="set-card-title justify-center">
                                                        {option.label}
                                                        {isActive && <Check strokeWidth={2.5} />}
                                                    </div>
                                                    <div className="set-card-sub">
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
                                <label className="set-label" style={{ marginBottom: 6 }}>
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
                                        className="set-select w-full flex items-center justify-between"
                                        style={{ fontFamily: fontCssMap[fontFamily] || 'inherit', paddingRight: 12 }}
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Type className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--ink-4)' }} />
                                            <span className="truncate">{fontFamilyOptions.find(f => f.value === fontFamily)?.label || 'System Default'}</span>
                                            <span className="set-pill" style={{ textTransform: 'uppercase', letterSpacing: '.04em', background: 'color-mix(in oklab, var(--ink) 8%, transparent)', color: 'var(--ink-3)' }}>
                                                {fontFamilyOptions.find(f => f.value === fontFamily)?.category || 'sans'}
                                            </span>
                                        </div>
                                        <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform ${fontDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--ink-4)' }} />
                                    </button>

                                    {/* Font dropdown list */}
                                    {fontDropdownOpen && (
                                        <div className="set-dropdown">
                                            {/* Search */}
                                            <div className="set-dropdown-search">
                                                <input
                                                    type="text"
                                                    value={fontSearch}
                                                    onChange={(e) => setFontSearch(e.target.value)}
                                                    placeholder="Search fonts..."
                                                    className="set-input set-input-sm w-full"
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
                                                            <div className="set-dropdown-group">
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
                                                                    className={`set-dropdown-item ${fontFamily === option.value ? 'is-active' : ''}`}
                                                                    style={{ fontFamily: fontCssMap[option.value] || 'inherit' }}
                                                                >
                                                                    <span className="truncate">
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

                            <div className="set-divider" />

                            {/* Theme Preview */}
                            <div>
                                <label className="set-label">
                                    Preview
                                </label>
                                <div className="set-preview">
                                    <div className="flex items-start gap-2 mb-2">
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in oklab, var(--ink) 12%, transparent)', color: 'var(--ink)' }}>
                                            <MessageSquare className="w-3 h-3" />
                                        </div>
                                        <div className="flex-1 py-1 pr-2" style={{ color: 'var(--ink)' }}>
                                            <p style={{ '--fs': '13px', lineHeight: 1.5 }}>
                                                Messages in {currentTheme === 'system' ? 'system' : currentTheme} mode.
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-2 flex-row-reverse">
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                                            <span style={{ '--fs': '10.5px', fontWeight: 700 }}>U</span>
                                        </div>
                                        <div className="px-3 py-1.5" style={{ background: 'var(--bubble-user-bg)', color: 'var(--bubble-user-ink)', borderRadius: '14px 14px 4px 14px' }}>
                                            <p style={{ '--fs': '13px', lineHeight: 1.5 }}>
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
