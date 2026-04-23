import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
    Send,
    Paperclip,
    Square,
    X,
    FileText,
    Image,
    FileCode,
    FileIcon,
    Upload,
    File,
    ScrollText,
    ChevronDown,
    Check,
    Globe,
    Link2,
    Sparkles,
    Circle,
} from 'lucide-react';

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileCategory(filename) {
    const ext = '.' + filename.split('.').pop().toLowerCase();
    const codeExts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql'];
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
    const docExts = ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf'];
    const dataExts = ['.json', '.yaml', '.yml', '.xml', '.csv', '.toml', '.ini', '.env'];

    if (codeExts.includes(ext)) return 'code';
    if (imageExts.includes(ext)) return 'image';
    if (docExts.includes(ext)) return 'document';
    if (dataExts.includes(ext)) return 'data';
    return 'file';
}

export default function ChatInput({
    onSend,
    onStop,
    isStreaming,
    disabled,
    attachments = [],
    onAddAttachment,
    onRemoveAttachment,
    onClearAllAttachments,
    onUploadError,
    systemPrompts = [],
    selectedSystemPromptId,
    onSystemPromptSelect,
    messages = [],
    maxContextTokens = 4096,
    models = [],
    selectedModel,
    onModelChange,
}) {
    const [message, setMessage] = useState('');
    const [isDragOver, setIsDragOver] = useState(false);
    const [isWindowDrag, setIsWindowDrag] = useState(false);
    const [uploadingFiles, setUploadingFiles] = useState([]);
    const [promptDropdownOpen, setPromptDropdownOpen] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const fileInputRef = useRef(null);
    const textareaRef = useRef(null);
    const dragCounterRef = useRef(0);
    const promptDropdownRef = useRef(null);
    const modelDropdownRef = useRef(null);

    const contextStats = useMemo(() => {
        let totalChars = 0;
        messages.forEach(msg => {
            totalChars += (msg.content || '').length;
            if (msg.reasoning) totalChars += msg.reasoning.length;
        });
        totalChars += message.length;
        attachments.forEach(att => {
            totalChars += (att.content || '').length;
        });
        const selectedPrompt = systemPrompts.find(p => p.id === selectedSystemPromptId);
        if (selectedPrompt?.content) {
            totalChars += selectedPrompt.content.length;
        }
        const estimatedTokens = Math.ceil(totalChars / 4);
        const isUnlimited = !maxContextTokens || maxContextTokens === 0;
        const usagePercent = isUnlimited ? 0 : Math.min(100, (estimatedTokens / maxContextTokens) * 100);
        return {
            estimatedTokens,
            maxTokens: maxContextTokens,
            usagePercent,
            messageCount: messages.length,
            isUnlimited,
        };
    }, [messages, message, attachments, systemPrompts, selectedSystemPromptId, maxContextTokens]);

    useEffect(() => {
        const handleWindowDragEnter = (e) => {
            e.preventDefault();
            dragCounterRef.current++;
            if (e.dataTransfer?.types?.includes('Files')) {
                setIsWindowDrag(true);
            }
        };
        const handleWindowDragLeave = (e) => {
            e.preventDefault();
            dragCounterRef.current--;
            if (dragCounterRef.current === 0) {
                setIsWindowDrag(false);
                setIsDragOver(false);
            }
        };
        const handleWindowDragOver = (e) => { e.preventDefault(); };
        const handleWindowDrop = (e) => {
            e.preventDefault();
            dragCounterRef.current = 0;
            setIsWindowDrag(false);
            setIsDragOver(false);
        };
        window.addEventListener('dragenter', handleWindowDragEnter);
        window.addEventListener('dragleave', handleWindowDragLeave);
        window.addEventListener('dragover', handleWindowDragOver);
        window.addEventListener('drop', handleWindowDrop);
        return () => {
            window.removeEventListener('dragenter', handleWindowDragEnter);
            window.removeEventListener('dragleave', handleWindowDragLeave);
            window.removeEventListener('dragover', handleWindowDragOver);
            window.removeEventListener('drop', handleWindowDrop);
        };
    }, []);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 220) + 'px';
        }
    }, [message]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (promptDropdownRef.current && !promptDropdownRef.current.contains(e.target)) {
                setPromptDropdownOpen(false);
            }
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target)) {
                setModelDropdownOpen(false);
            }
        };
        if (promptDropdownOpen || modelDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [promptDropdownOpen, modelDropdownOpen]);

    const runningModels = Array.isArray(models) ? models.filter(m => m.status === 'running') : [];
    const selectedModelData = Array.isArray(models) ? models.find(m => m.name === selectedModel) : null;
    const getModelStatusColor = (status) => {
        if (status === 'running') return 'var(--ok)';
        if (status === 'loading' || status === 'starting') return 'var(--warning, #f59e0b)';
        if (status === 'unhealthy' || status === 'error') return 'var(--danger)';
        return 'var(--ink-4)';
    };

    const selectedPrompt = systemPrompts.find(p => p.id === selectedSystemPromptId);

    const handleSend = useCallback(() => {
        if ((message.trim() || attachments.length > 0) && !isStreaming && !disabled) {
            onSend(message.trim(), attachments);
            setMessage('');
            if (textareaRef.current) {
                textareaRef.current.style.height = 'auto';
            }
        }
    }, [message, attachments, isStreaming, disabled, onSend]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleFileSelect = useCallback(async (files) => {
        const fileArray = Array.from(files);
        const validFiles = fileArray;
        if (validFiles.length === 0) return;

        const uploadingIds = validFiles.map(file => ({
            id: crypto.randomUUID(),
            filename: file.name,
            size: file.size,
        }));
        setUploadingFiles(prev => [...prev, ...uploadingIds]);

        const readAsBase64 = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result.split(',')[1]);
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
        });

        const uploadFile = async (base64, file) => {
            const doFetch = () => fetch('/api/chat/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    filename: file.name,
                    content: base64,
                    mimeType: file.type,
                }),
            });
            let response = await doFetch();
            if (response.status === 401 || response.status >= 500) {
                await new Promise(r => setTimeout(r, 500));
                response = await doFetch();
            }
            return response;
        };

        let failedFiles = [];
        for (let i = 0; i < validFiles.length; i++) {
            const file = validFiles[i];
            const uploadId = uploadingIds[i].id;
            try {
                const base64 = await readAsBase64(file);
                const response = await uploadFile(base64, file);
                if (response.ok) {
                    const data = await response.json();
                    onAddAttachment({
                        id: crypto.randomUUID(),
                        filename: file.name,
                        size: file.size,
                        type: data.type,
                        content: data.content,
                        dataUrl: data.dataUrl,
                        charCount: data.charCount,
                        pageCount: data.pageCount,
                        estimatedTokens: data.estimatedTokens,
                        requiresChunking: data.requiresChunking,
                        totalChunks: data.totalChunks,
                    });
                } else {
                    const errBody = await response.json().catch(() => ({}));
                    const reason = errBody.error || `HTTP ${response.status}`;
                    console.error(`Upload failed for ${file.name}: ${reason}`);
                    failedFiles.push(file.name);
                }
            } catch (error) {
                console.error(`File upload error for ${file.name}:`, error);
                failedFiles.push(file.name);
            } finally {
                setUploadingFiles(prev => prev.filter(f => f.id !== uploadId));
            }
        }

        if (failedFiles.length > 0 && onUploadError) {
            const msg = failedFiles.length === 1
                ? `Failed to upload: ${failedFiles[0]}`
                : `Failed to upload ${failedFiles.length} files: ${failedFiles.join(', ')}`;
            onUploadError(msg);
        }
    }, [onAddAttachment, onUploadError]);

    const PASTE_AS_FILE_THRESHOLD = 500;
    const handlePaste = useCallback(async (e) => {
        if (e.clipboardData?.files?.length > 0) {
            const files = Array.from(e.clipboardData.files);
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length > 0) {
                e.preventDefault();
                handleFileSelect(imageFiles);
                return;
            }
        }
        const pastedText = e.clipboardData?.getData('text/plain');
        if (!pastedText || pastedText.length < PASTE_AS_FILE_THRESHOLD) return;
        e.preventDefault();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `pasted-text-${timestamp}.txt`;
        const base64 = btoa(unescape(encodeURIComponent(pastedText)));
        const uploadId = crypto.randomUUID();
        setUploadingFiles(prev => [...prev, { id: uploadId, filename, size: pastedText.length }]);
        try {
            const doFetch = () => fetch('/api/chat/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ filename, content: base64, mimeType: 'text/plain' }),
            });
            let response = await doFetch();
            if (response.status === 401 || response.status >= 500) {
                await new Promise(r => setTimeout(r, 500));
                response = await doFetch();
            }
            if (response.ok) {
                const data = await response.json();
                onAddAttachment({
                    id: crypto.randomUUID(),
                    filename,
                    size: pastedText.length,
                    type: data.type,
                    content: data.content,
                    charCount: data.charCount,
                    estimatedTokens: data.estimatedTokens,
                    requiresChunking: data.requiresChunking,
                    totalChunks: data.totalChunks,
                });
            } else if (onUploadError) {
                const errBody = await response.json().catch(() => ({}));
                onUploadError(`Failed to upload pasted text: ${errBody.error || `HTTP ${response.status}`}`);
            }
        } catch (error) {
            console.error('Paste-as-file upload error:', error);
            if (onUploadError) onUploadError('Failed to upload pasted text');
        } finally {
            setUploadingFiles(prev => prev.filter(f => f.id !== uploadId));
        }
    }, [onAddAttachment, onUploadError, handleFileSelect]);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        setIsWindowDrag(false);
        dragCounterRef.current = 0;
        if (e.dataTransfer?.files?.length > 0) {
            handleFileSelect(e.dataTransfer.files);
        }
    }, [handleFileSelect]);

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
    };

    const getFileIcon = (filename, type) => {
        const category = type || getFileCategory(filename);
        const iconClass = "w-[13px] h-[13px]";
        switch (category) {
            case 'image': return <Image className={iconClass} />;
            case 'code':
            case 'data': return <FileCode className={iconClass} />;
            case 'document':
            case 'pdf': return <FileText className={iconClass} />;
            default: return <File className={iconClass} />;
        }
    };

    const hasContent = message.trim() || attachments.length > 0;
    const canSend = hasContent && !isStreaming && !disabled;

    // Style objects — use CSS variables so they respect the active theme
    const iconChip = {
        width: 30, height: 30, borderRadius: 8,
        display: 'grid', placeItems: 'center',
        color: 'var(--ink-3)',
        transition: 'background .1s, color .1s',
        cursor: 'pointer',
        border: 0,
        background: 'transparent',
    };
    const iconChipActive = (activeColor) => ({
        ...iconChip,
        color: activeColor,
        background: 'var(--accent-soft)',
    });
    const chip = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderRadius: 8,
        color: 'var(--ink-2)', fontSize: 12.5, fontWeight: 500,
        transition: 'background .1s',
        cursor: 'pointer',
        border: 0,
        background: 'transparent',
    };
    const chipActive = {
        ...chip,
        color: 'var(--accent)',
        background: 'var(--accent-soft)',
    };
    const sendBtn = {
        width: 32, height: 32, borderRadius: 8,
        background: 'var(--accent)',
        color: 'var(--accent-ink)',
        display: 'grid', placeItems: 'center',
        transition: 'transform .1s, opacity .1s',
        border: 0,
    };
    const stopBtn = {
        width: 32, height: 32, borderRadius: 8,
        background: 'var(--danger)',
        color: '#fff',
        display: 'grid', placeItems: 'center',
        border: 0,
        cursor: 'pointer',
    };
    const kbdStyle = {
        border: '1px solid var(--rule)', borderRadius: 3,
        padding: '0 4px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        color: 'var(--ink-3)',
    };
    const popover = {
        position: 'absolute',
        bottom: 'calc(100% + 6px)',
        left: 0,
        minWidth: 280,
        maxWidth: 360,
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        borderRadius: 10,
        boxShadow: '0 10px 30px -10px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.15)',
        padding: 6,
        zIndex: 20,
    };
    const popHeader = {
        fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase',
        color: 'var(--ink-3)', fontWeight: 600,
        padding: '6px 10px 4px',
    };
    const popItem = {
        display: 'block', width: '100%', textAlign: 'left',
        padding: '8px 10px', borderRadius: 6,
        transition: 'background .08s',
        cursor: 'pointer',
        border: 0,
        background: 'transparent',
        color: 'var(--ink)',
    };
    const popItemActive = {
        ...popItem,
        background: 'var(--accent-soft)',
    };

    return (
        <>
            {/* Full-screen drop zone overlay — unchanged behavior, themed via variables */}
            {isWindowDrag && (
                <div
                    className="fixed inset-0 z-50 backdrop-blur-sm flex items-center justify-center transition-all duration-300 animate-fade-in"
                    style={{ background: 'color-mix(in oklab, var(--bg) 85%, transparent)' }}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    role="region"
                    aria-label="File drop zone"
                >
                    <div
                        className="flex flex-col items-center justify-center p-12 rounded-3xl border-2 border-dashed transition-all duration-300 transform"
                        style={{
                            borderColor: isDragOver ? 'var(--accent)' : 'var(--rule-2)',
                            background: isDragOver ? 'var(--accent-soft)' : 'var(--bg-2)',
                            transform: isDragOver ? 'scale(1.05)' : 'scale(1)',
                        }}
                    >
                        <div
                            className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-transform duration-300"
                            style={{
                                background: 'var(--accent-soft)',
                                color: 'var(--accent)',
                                transform: isDragOver ? 'scale(1.1)' : 'scale(1)',
                            }}
                        >
                            <Upload className="w-10 h-10" />
                        </div>
                        <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--ink)' }}>
                            Drop files to upload
                        </h3>
                        <p className="text-sm text-center max-w-xs" style={{ color: 'var(--ink-3)' }}>
                            Images, PDFs, code, data, and text documents all work.
                        </p>
                    </div>
                </div>
            )}

            {/* Composer wrapper — centered at 720px with generous padding
                (matches the design's `padding: 10px 28px 16px` and keeps
                the input compact per the chat-input-compact memory). */}
            <div className="mx-auto w-full" style={{ maxWidth: 720, padding: '10px 28px 16px' }}>
                {/* Attachment chips above the box */}
                {(attachments.length > 0 || uploadingFiles.length > 0) && (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontSize: 10.5, color: 'var(--ink-4)', fontWeight: 500 }}>
                                {attachments.length} file{attachments.length !== 1 ? 's' : ''}
                                {attachments.length > 0 && (
                                    <span style={{ marginLeft: 4, color: 'var(--ink-4)' }}>
                                        ({(attachments.reduce((sum, a) => sum + (a.charCount || 0), 0) / 1000).toFixed(1)}k chars)
                                    </span>
                                )}
                            </span>
                            {attachments.length > 1 && onClearAllAttachments && (
                                <button
                                    onClick={onClearAllAttachments}
                                    style={{ fontSize: 10.5, color: 'var(--danger)', opacity: 0.8, background: 'transparent', border: 0, cursor: 'pointer' }}
                                    onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                                    onMouseLeave={(e) => e.currentTarget.style.opacity = 0.8}
                                >
                                    Clear all
                                </button>
                            )}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="list">
                            {uploadingFiles.map((file) => (
                                <div
                                    key={file.id}
                                    className="animate-pulse"
                                    style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 6,
                                        padding: '4px 8px', borderRadius: 6,
                                        background: 'var(--bg-2)', border: '1px solid var(--rule)',
                                        fontSize: 11, color: 'var(--ink-3)',
                                    }}
                                    role="listitem"
                                >
                                    <FileIcon className="w-3 h-3 animate-spin" />
                                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {file.filename}
                                    </span>
                                </div>
                            ))}
                            {attachments.map((att, index) => (
                                <div
                                    key={att.id || index}
                                    style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 6,
                                        padding: '4px 8px', borderRadius: 6,
                                        background: att.requiresChunking ? 'var(--accent-soft)' : 'var(--bg-2)',
                                        border: `1px solid ${att.requiresChunking ? 'var(--accent)' : 'var(--rule)'}`,
                                        fontSize: 11, color: 'var(--ink-2)',
                                    }}
                                    role="listitem"
                                    title={att.requiresChunking
                                        ? `Large file: ~${att.estimatedTokens?.toLocaleString()} tokens (${att.totalChunks} chunks). Processed automatically.`
                                        : (att.charCount ? `${att.charCount.toLocaleString()} chars (~${att.estimatedTokens?.toLocaleString() || Math.ceil(att.charCount/4).toLocaleString()} tokens)` : att.filename)}
                                >
                                    {getFileIcon(att.filename, att.type)}
                                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {att.filename}
                                    </span>
                                    <button
                                        onClick={() => onRemoveAttachment(index)}
                                        style={{ padding: 2, borderRadius: 3, opacity: 0.6, background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }}
                                        onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                                        onMouseLeave={(e) => e.currentTarget.style.opacity = 0.6}
                                        aria-label={`Remove ${att.filename}`}
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Main composer box */}
                <div
                    style={{
                        position: 'relative',
                        border: `1px solid ${isDragOver ? 'var(--accent)' : 'var(--rule-2)'}`,
                        borderRadius: 14,
                        background: 'var(--surface)',
                        padding: '4px 4px 4px',
                        boxShadow: '0 1px 0 rgba(0,0,0,.02), 0 10px 30px -20px rgba(0,0,0,.25)',
                        transition: 'border-color .12s',
                    }}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            handleFileSelect(e.target.files);
                            e.target.value = '';
                        }}
                        aria-hidden="true"
                    />

                    {/* Textarea */}
                    <textarea
                        ref={textareaRef}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={isDragOver ? 'Drop files…' : 'Ask anything, attach a file, or paste a paper…'}
                        disabled={disabled}
                        rows={1}
                        style={{
                            width: '100%',
                            minHeight: 44,
                            maxHeight: 220,
                            border: 0,
                            outline: 0,
                            resize: 'none',
                            padding: '12px 14px 6px',
                            background: 'transparent',
                            fontSize: 14.5,
                            lineHeight: 1.55,
                            color: 'var(--ink)',
                            fontFamily: 'inherit',
                        }}
                        aria-label="Message input"
                    />

                    {/* Bottom control row */}
                    <div style={{ display: 'flex', alignItems: 'center', padding: '6px 6px 6px 8px' }}>
                        {/* Left controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={disabled || isStreaming}
                                style={{ ...iconChip, opacity: (disabled || isStreaming) ? 0.3 : 1 }}
                                aria-label="Attach files"
                                title="Attach files"
                                onMouseEnter={(e) => { if (!disabled && !isStreaming) e.currentTarget.style.background = 'var(--bg-2)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                <Paperclip className="w-[15px] h-[15px]" strokeWidth={1.75} />
                            </button>

                            {/* Persona (system prompt) chip */}
                            {systemPrompts.length > 0 && (
                                <div style={{ position: 'relative' }} ref={promptDropdownRef}>
                                    <button
                                        onClick={() => setPromptDropdownOpen(!promptDropdownOpen)}
                                        disabled={disabled || isStreaming}
                                        style={{ ...(selectedPrompt ? chipActive : chip), opacity: (disabled || isStreaming) ? 0.3 : 1, maxWidth: 180 }}
                                        aria-label="Choose persona"
                                        title={selectedPrompt ? `Persona: ${selectedPrompt.name}` : 'Choose persona'}
                                    >
                                        <Sparkles className="w-[13px] h-[13px]" strokeWidth={1.75} />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {selectedPrompt ? selectedPrompt.name : 'Persona'}
                                        </span>
                                        <ChevronDown className={`w-[11px] h-[11px] transition-transform duration-150 ${promptDropdownOpen ? 'rotate-180' : ''}`} strokeWidth={1.75} />
                                    </button>
                                    {promptDropdownOpen && (
                                        <div style={popover} className="animate-slide-up">
                                            <div style={popHeader}>Persona</div>
                                            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                                                <button
                                                    onClick={() => { onSystemPromptSelect?.(null); setPromptDropdownOpen(false); }}
                                                    style={!selectedSystemPromptId ? popItemActive : popItem}
                                                    onMouseEnter={(e) => { if (selectedSystemPromptId) e.currentTarget.style.background = 'var(--bg-2)'; }}
                                                    onMouseLeave={(e) => { if (selectedSystemPromptId) e.currentTarget.style.background = 'transparent'; }}
                                                >
                                                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>Default</div>
                                                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>No persona instructions.</div>
                                                </button>
                                                {systemPrompts.map((prompt) => (
                                                    <button
                                                        key={prompt.id}
                                                        onClick={() => { onSystemPromptSelect?.(prompt.id); setPromptDropdownOpen(false); }}
                                                        style={selectedSystemPromptId === prompt.id ? popItemActive : popItem}
                                                        onMouseEnter={(e) => { if (selectedSystemPromptId !== prompt.id) e.currentTarget.style.background = 'var(--bg-2)'; }}
                                                        onMouseLeave={(e) => { if (selectedSystemPromptId !== prompt.id) e.currentTarget.style.background = 'transparent'; }}
                                                    >
                                                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{prompt.name}</div>
                                                        {prompt.content && (
                                                            <div style={{ fontSize: 11, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {prompt.content.slice(0, 60)}{prompt.content.length > 60 ? '…' : ''}
                                                            </div>
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Right controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {/* Model chip */}
                            {onModelChange && (
                                <div style={{ position: 'relative' }} ref={modelDropdownRef}>
                                    <button
                                        onClick={() => { setModelDropdownOpen(o => !o); setPromptDropdownOpen(false); }}
                                        disabled={disabled || isStreaming}
                                        style={{ ...chip, opacity: (disabled || isStreaming) ? 0.3 : 1, maxWidth: 220 }}
                                        aria-label="Choose model"
                                        title={selectedModel ? `Model: ${selectedModel}` : 'Select model'}
                                    >
                                        <Circle
                                            style={{
                                                width: 6, height: 6,
                                                fill: getModelStatusColor(selectedModelData?.status),
                                                color: getModelStatusColor(selectedModelData?.status),
                                            }}
                                        />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {selectedModel || 'Select model'}
                                        </span>
                                        <ChevronDown
                                            className={`w-[11px] h-[11px] transition-transform duration-150 ${modelDropdownOpen ? 'rotate-180' : ''}`}
                                            strokeWidth={1.75}
                                        />
                                    </button>
                                    {modelDropdownOpen && (
                                        <div style={{ ...popover, left: 'auto', right: 0 }} className="animate-slide-up">
                                            <div style={popHeader}>Model</div>
                                            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                                                {runningModels.length === 0 ? (
                                                    <div style={{ padding: '10px 12px', textAlign: 'center' }}>
                                                        <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>No models running</div>
                                                        <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Load a model from the main app</div>
                                                    </div>
                                                ) : runningModels.map(m => (
                                                    <button
                                                        key={m.name}
                                                        onClick={() => { onModelChange(m.name); setModelDropdownOpen(false); }}
                                                        style={selectedModel === m.name ? popItemActive : popItem}
                                                        onMouseEnter={(e) => { if (selectedModel !== m.name) e.currentTarget.style.background = 'var(--bg-2)'; }}
                                                        onMouseLeave={(e) => { if (selectedModel !== m.name) e.currentTarget.style.background = 'transparent'; }}
                                                    >
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                            <Circle
                                                                style={{
                                                                    width: 6, height: 6,
                                                                    fill: getModelStatusColor(m.status),
                                                                    color: getModelStatusColor(m.status),
                                                                    flexShrink: 0,
                                                                }}
                                                            />
                                                            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{m.name}</span>
                                                            {m.backend && (
                                                                <span style={{
                                                                    fontSize: 9, padding: '1px 5px', borderRadius: 3,
                                                                    background: 'var(--accent-soft)', color: 'var(--accent)',
                                                                    fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase',
                                                                }}>
                                                                    {m.backend === 'vllm' ? 'vLLM' : m.backend === 'llamacpp' ? 'llama.cpp' : m.backend}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {m.contextSize && (
                                                            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                                                                {Math.round(m.contextSize / 1000)}k context
                                                            </div>
                                                        )}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {isStreaming ? (
                                <button
                                    onClick={onStop}
                                    style={stopBtn}
                                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                                    aria-label="Stop"
                                    title="Stop"
                                >
                                    <Square className="w-3 h-3 fill-current" />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={!canSend}
                                    style={{
                                        ...sendBtn,
                                        opacity: canSend ? 1 : 0.4,
                                        cursor: canSend ? 'pointer' : 'default',
                                    }}
                                    onMouseEnter={(e) => { if (canSend) e.currentTarget.style.transform = 'scale(1.05)'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                                    aria-label="Send"
                                    title="Send"
                                >
                                    <Send className="w-[15px] h-[15px]" strokeWidth={2} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Inline drag indicator */}
                    {isDragOver && (
                        <div
                            style={{
                                position: 'absolute', inset: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'color-mix(in oklab, var(--surface) 90%, transparent)',
                                borderRadius: 14, backdropFilter: 'blur(4px)',
                                pointerEvents: 'none',
                            }}
                            className="animate-fade-in"
                            aria-hidden="true"
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--accent)' }}>
                                <Upload className="w-5 h-5 animate-bounce" />
                                <span style={{ fontWeight: 500 }}>Drop to attach</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* Context usage row */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '6px 8px 0',
                    fontSize: 10.5, color: 'var(--ink-4)',
                }}>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span>{contextStats.messageCount} msgs</span>
                        <span>·</span>
                        <div style={{ width: 56, height: 4, borderRadius: 2, background: 'var(--rule)', overflow: 'hidden' }}>
                            <div
                                style={{
                                    height: '100%',
                                    width: `${contextStats.usagePercent}%`,
                                    background: contextStats.usagePercent > 90
                                        ? 'var(--danger)'
                                        : contextStats.usagePercent > 70
                                            ? 'var(--warning, #f59e0b)'
                                            : 'var(--ok)',
                                    transition: 'width .3s',
                                }}
                            />
                        </div>
                        <span style={{
                            fontFamily: 'var(--font-mono)',
                            color: contextStats.isUnlimited ? 'var(--ink-4)'
                                : contextStats.usagePercent > 90 ? 'var(--danger)'
                                : contextStats.usagePercent > 70 ? 'var(--warning, #f59e0b)'
                                : 'var(--ink-4)',
                        }}>
                            ~{(contextStats.estimatedTokens / 1000).toFixed(1)}k / {contextStats.isUnlimited ? '∞' : `${(contextStats.maxTokens / 1000).toFixed(0)}k`}
                        </span>
                    </span>
                </div>
            </div>

            <style>{`
                @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
                @keyframes slide-up {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in { animation: fade-in 0.2s ease-out; }
                .animate-slide-up { animation: slide-up 0.2s ease-out; }
            `}</style>
        </>
    );
}
