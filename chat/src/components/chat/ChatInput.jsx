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
    MessageCircle
} from 'lucide-react';

/**
 * Format file size to human readable string
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get file type category from extension
 */
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

/**
 * ChatInput - Floating message input with drag-and-drop file attachments
 */
export default function ChatInput({
    onSend,
    onStop,
    isStreaming,
    disabled,
    attachments = [],
    onAddAttachment,
    onRemoveAttachment,
    onClearAllAttachments,
    systemPrompts = [],
    selectedSystemPromptId,
    onSystemPromptSelect,
    webSearchEnabled = false,
    onWebSearchToggle,
    urlFetchEnabled = false,
    onUrlFetchToggle,
    messages = [],
    maxContextTokens = 4096,
}) {
    const [message, setMessage] = useState('');
    const [isDragOver, setIsDragOver] = useState(false);
    const [isWindowDrag, setIsWindowDrag] = useState(false);
    const [uploadingFiles, setUploadingFiles] = useState([]);
    const [promptDropdownOpen, setPromptDropdownOpen] = useState(false);
    const fileInputRef = useRef(null);
    const textareaRef = useRef(null);
    const dragCounterRef = useRef(0);
    const promptDropdownRef = useRef(null);

    // Estimate context usage (rough approximation: ~4 chars per token)
    const contextStats = useMemo(() => {
        let totalChars = 0;

        // Count message content
        messages.forEach(msg => {
            totalChars += (msg.content || '').length;
            if (msg.reasoning) totalChars += msg.reasoning.length;
        });

        // Add current message being typed
        totalChars += message.length;

        // Add attachment content
        attachments.forEach(att => {
            totalChars += (att.content || '').length;
        });

        // Add system prompt if selected
        const selectedPrompt = systemPrompts.find(p => p.id === selectedSystemPromptId);
        if (selectedPrompt?.content) {
            totalChars += selectedPrompt.content.length;
        }

        // Rough token estimate (4 chars per token is a common approximation)
        const estimatedTokens = Math.ceil(totalChars / 4);

        // Check if context is unlimited (0, undefined, or null means no limit)
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

    // All file types are now allowed - no restrictions
    const allowAllFileTypes = true;

    // Window-level drag detection for full-screen drop zone
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

        const handleWindowDragOver = (e) => {
            e.preventDefault();
        };

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

    // Auto-resize textarea on mount and when message changes
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [message]);

    // Close prompt dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (promptDropdownRef.current && !promptDropdownRef.current.contains(e.target)) {
                setPromptDropdownOpen(false);
            }
        };

        if (promptDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [promptDropdownOpen]);

    // Get selected prompt name for display
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
        // All file types are now allowed - no filtering
        const validFiles = fileArray;

        if (validFiles.length === 0) return;

        // Add files to uploading state
        const uploadingIds = validFiles.map(file => ({
            id: crypto.randomUUID(),
            filename: file.name,
            size: file.size,
        }));
        setUploadingFiles(prev => [...prev, ...uploadingIds]);

        for (let i = 0; i < validFiles.length; i++) {
            const file = validFiles[i];
            const uploadId = uploadingIds[i].id;

            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64 = e.target.result.split(',')[1];

                try {
                    const response = await fetch('/api/chat/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            filename: file.name,
                            content: base64,
                            mimeType: file.type,
                        }),
                    });

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
                    }
                } catch (error) {
                    console.error('File upload error:', error);
                } finally {
                    // Remove from uploading state
                    setUploadingFiles(prev => prev.filter(f => f.id !== uploadId));
                }
            };
            reader.readAsDataURL(file);
        }
    }, [onAddAttachment]);

    // Convert large pasted text or clipboard images into file attachments
    const PASTE_AS_FILE_THRESHOLD = 500; // characters
    const handlePaste = useCallback(async (e) => {
        // Handle image/file paste from clipboard (e.g. screenshots, copied images)
        if (e.clipboardData?.files?.length > 0) {
            const files = Array.from(e.clipboardData.files);
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length > 0) {
                e.preventDefault();
                handleFileSelect(imageFiles);
                return;
            }
        }

        // Large text paste → convert to file attachment
        const pastedText = e.clipboardData?.getData('text/plain');
        if (!pastedText || pastedText.length < PASTE_AS_FILE_THRESHOLD) return;

        e.preventDefault();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `pasted-text-${timestamp}.txt`;
        const base64 = btoa(unescape(encodeURIComponent(pastedText)));

        // Show uploading indicator
        const uploadId = crypto.randomUUID();
        setUploadingFiles(prev => [...prev, { id: uploadId, filename, size: pastedText.length }]);

        try {
            const response = await fetch('/api/chat/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    filename,
                    content: base64,
                    mimeType: 'text/plain',
                }),
            });

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
            }
        } catch (error) {
            console.error('Paste-as-file upload error:', error);
        } finally {
            setUploadingFiles(prev => prev.filter(f => f.id !== uploadId));
        }
    }, [onAddAttachment, handleFileSelect]);

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
        const iconClass = "w-4 h-4";

        switch (category) {
            case 'image':
                return <Image className={iconClass} />;
            case 'code':
            case 'data':
                return <FileCode className={iconClass} />;
            case 'document':
            case 'pdf':
                return <FileText className={iconClass} />;
            default:
                return <File className={iconClass} />;
        }
    };

    const getFileTypeColor = (filename, type) => {
        const category = type || getFileCategory(filename);
        switch (category) {
            case 'image':
                return 'bg-purple-500/15 border-purple-500/30 text-purple-300';
            case 'code':
                return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300';
            case 'data':
                return 'bg-amber-500/15 border-amber-500/30 text-amber-300';
            case 'document':
            case 'pdf':
                return 'bg-blue-500/15 border-blue-500/30 text-blue-300';
            default:
                return 'bg-gray-500/15 border-gray-500/30 text-gray-300';
        }
    };

    const hasContent = message.trim() || attachments.length > 0;
    const canSend = hasContent && !isStreaming && !disabled;

    return (
        <>
            {/* Full-screen drop zone overlay */}
            {isWindowDrag && (
                <div
                    className="fixed inset-0 z-50 bg-dark-950/90 backdrop-blur-sm flex items-center justify-center transition-all duration-300 animate-fade-in"
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    role="region"
                    aria-label="File drop zone"
                >
                    <div
                        className={`
                            flex flex-col items-center justify-center p-12 rounded-3xl border-2 border-dashed
                            transition-all duration-300 transform
                            ${isDragOver
                                ? 'border-primary-400 bg-primary-500/10 scale-105'
                                : 'border-primary-500/50 bg-dark-900/50 scale-100'
                            }
                        `}
                    >
                        <div className={`
                            w-20 h-20 rounded-2xl bg-primary-500/20 flex items-center justify-center mb-6
                            transition-transform duration-300
                            ${isDragOver ? 'scale-110 animate-bounce' : 'scale-100'}
                        `}>
                            <Upload className="w-10 h-10 text-primary-400" />
                        </div>
                        <h3 className="text-xl font-semibold text-white mb-2">
                            Drop files to upload
                        </h3>
                        <p className="text-dark-400 text-sm text-center max-w-xs">
                            Supported: Images, PDFs, code files, and text documents
                        </p>
                    </div>
                </div>
            )}

            {/* Floating input container */}
            <div className="px-3 pt-1.5 pb-2.5 bg-gradient-to-t from-dark-950 via-dark-950/95 to-transparent">
                <div className="max-w-4xl mx-auto">
                    {/* Attachment preview cards */}
                    {(attachments.length > 0 || uploadingFiles.length > 0) && (
                        <div className="mb-1.5">
                            <div className="flex items-center justify-between mb-0.5">
                                <span className="text-[10px] text-dark-500 font-medium">
                                    {attachments.length} file{attachments.length !== 1 ? 's' : ''}
                                    {attachments.length > 0 && (
                                        <span className="ml-1 text-dark-600">
                                            ({(attachments.reduce((sum, a) => sum + (a.charCount || 0), 0) / 1000).toFixed(1)}k chars)
                                        </span>
                                    )}
                                </span>
                                {attachments.length > 1 && onClearAllAttachments && (
                                    <button
                                        onClick={onClearAllAttachments}
                                        className="text-[10px] text-red-400/80 hover:text-red-300 transition-colors"
                                    >
                                        Clear all
                                    </button>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1" role="list">
                                {/* Uploading files */}
                                {uploadingFiles.map((file) => (
                                    <div
                                        key={file.id}
                                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-dark-800/60 border border-dark-700/50 animate-pulse"
                                        role="listitem"
                                    >
                                        <FileIcon className="w-3 h-3 text-dark-400 animate-spin" />
                                        <span className="text-dark-300 truncate max-w-[100px] text-[11px]">
                                            {file.filename}
                                        </span>
                                    </div>
                                ))}

                                {/* Attached files */}
                                {attachments.map((att, index) => (
                                    <div
                                        key={att.id || index}
                                        className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] ${att.requiresChunking ? 'border-blue-500/50 bg-blue-500/10' : getFileTypeColor(att.filename, att.type)}`}
                                        role="listitem"
                                        title={att.requiresChunking
                                            ? `📄 Large file: ~${att.estimatedTokens?.toLocaleString()} tokens (${att.totalChunks} chunks). Will be processed automatically.`
                                            : (att.charCount ? `${att.charCount.toLocaleString()} characters (~${att.estimatedTokens?.toLocaleString() || Math.ceil(att.charCount/4).toLocaleString()} tokens)${att.saved ? ` (${att.saved} saved)` : ''}` : att.filename)}
                                    >
                                        {att.requiresChunking && <span className="text-blue-400">📄</span>}
                                        {getFileIcon(att.filename, att.type)}
                                        <span className="truncate max-w-[100px]">{att.filename}</span>
                                        <button
                                            onClick={() => onRemoveAttachment(index)}
                                            className="p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-white/10 transition-opacity"
                                            aria-label={`Remove ${att.filename}`}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Main input bar */}
                    <div
                        className={`
                            relative flex items-end gap-0.5 p-1 pl-1.5 rounded-lg
                            bg-dark-800/70 backdrop-blur-xl
                            border transition-all duration-200 shadow-md shadow-dark-950/20
                            ${isDragOver
                                ? 'border-primary-500/50 ring-1 ring-primary-500/10 bg-primary-500/5'
                                : 'border-dark-700/40 hover:border-dark-600/40 focus-within:border-primary-500/30'
                            }
                        `}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                    >
                        {/* Attach button */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                handleFileSelect(e.target.files);
                                e.target.value = ''; // Reset to allow re-selecting same file
                            }}
                            aria-hidden="true"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={disabled || isStreaming}
                            className="flex-shrink-0 p-1.5 rounded-md text-dark-500
                                       hover:text-dark-300 hover:bg-white/[0.05]
                                       disabled:opacity-30 disabled:cursor-not-allowed
                                       transition-all duration-150"
                            aria-label="Attach files"
                            title="Attach files"
                        >
                            <Paperclip className="w-[15px] h-[15px]" strokeWidth={1.75} />
                        </button>

                        {/* Web search toggle */}
                        <button
                            onClick={onWebSearchToggle}
                            disabled={disabled || isStreaming}
                            className={`flex-shrink-0 p-1.5 rounded-md transition-all duration-150
                                       disabled:opacity-30 disabled:cursor-not-allowed
                                       ${webSearchEnabled
                                           ? 'text-blue-400 bg-blue-500/12'
                                           : 'text-dark-500 hover:text-dark-300 hover:bg-white/[0.05]'
                                       }`}
                            aria-label={webSearchEnabled ? 'Disable web search' : 'Enable web search'}
                            title={webSearchEnabled ? 'Web search on' : 'Web search off'}
                        >
                            <Globe className="w-[15px] h-[15px]" strokeWidth={1.75} />
                        </button>

                        {/* URL fetch toggle */}
                        <button
                            onClick={onUrlFetchToggle}
                            disabled={disabled || isStreaming}
                            className={`flex-shrink-0 p-1.5 rounded-md transition-all duration-150
                                       disabled:opacity-30 disabled:cursor-not-allowed
                                       ${urlFetchEnabled
                                           ? 'text-emerald-400 bg-emerald-500/12'
                                           : 'text-dark-500 hover:text-dark-300 hover:bg-white/[0.05]'
                                       }`}
                            aria-label={urlFetchEnabled ? 'Disable URL fetch' : 'Enable URL fetch'}
                            title={urlFetchEnabled ? 'URL fetch on' : 'URL fetch off'}
                        >
                            <Link2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
                        </button>

                        {/* System prompt selector */}
                        {systemPrompts.length > 0 && (
                            <div className="relative flex-shrink-0" ref={promptDropdownRef}>
                                <button
                                    onClick={() => setPromptDropdownOpen(!promptDropdownOpen)}
                                    disabled={disabled || isStreaming}
                                    className={`
                                        flex items-center gap-0.5 px-1.5 py-1 rounded-md
                                        text-[10px] font-medium
                                        transition-all duration-150
                                        disabled:opacity-30 disabled:cursor-not-allowed
                                        ${selectedPrompt
                                            ? 'bg-primary-500/12 text-primary-300'
                                            : 'text-dark-500 hover:text-dark-300 hover:bg-white/[0.05]'
                                        }
                                    `}
                                    aria-label="Select system prompt"
                                    title={selectedPrompt ? selectedPrompt.name : 'System prompt'}
                                >
                                    <ScrollText className="w-3 h-3" strokeWidth={1.75} />
                                    <span className="max-w-[60px] truncate hidden sm:inline">
                                        {selectedPrompt ? selectedPrompt.name : 'Prompt'}
                                    </span>
                                    <ChevronDown className={`w-2.5 h-2.5 transition-transform duration-150 ${promptDropdownOpen ? 'rotate-180' : ''}`} />
                                </button>

                                {/* Dropdown menu */}
                                {promptDropdownOpen && (
                                    <div className="absolute bottom-full left-0 mb-2 w-56 py-1.5
                                                    bg-dark-800/95 backdrop-blur-xl rounded-xl
                                                    border border-dark-700/60 shadow-xl shadow-dark-950/50
                                                    animate-slide-up z-50">
                                        <div className="px-3 py-2 border-b border-dark-700/50">
                                            <p className="text-[10px] font-semibold text-dark-400 uppercase tracking-wider">
                                                System Prompt
                                            </p>
                                        </div>
                                        <div className="max-h-48 overflow-y-auto py-1">
                                            {/* None option */}
                                            <button
                                                onClick={() => {
                                                    onSystemPromptSelect?.(null);
                                                    setPromptDropdownOpen(false);
                                                }}
                                                className={`
                                                    w-full flex items-center gap-2.5 px-3 py-2 text-left
                                                    transition-all duration-150
                                                    ${!selectedSystemPromptId
                                                        ? 'bg-primary-500/10 text-primary-300'
                                                        : 'text-dark-300 hover:bg-dark-700/50 hover:text-dark-100'
                                                    }
                                                `}
                                            >
                                                <div className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0
                                                    ${!selectedSystemPromptId
                                                        ? 'border-primary-400 bg-primary-500/20'
                                                        : 'border-dark-500'
                                                    }`}>
                                                    {!selectedSystemPromptId && <Check className="w-2.5 h-2.5 text-primary-400" />}
                                                </div>
                                                <span className="text-xs font-medium">None</span>
                                            </button>

                                            {/* System prompts */}
                                            {systemPrompts.map((prompt) => (
                                                <button
                                                    key={prompt.id}
                                                    onClick={() => {
                                                        onSystemPromptSelect?.(prompt.id);
                                                        setPromptDropdownOpen(false);
                                                    }}
                                                    className={`
                                                        w-full flex items-center gap-2.5 px-3 py-2 text-left
                                                        transition-all duration-150
                                                        ${selectedSystemPromptId === prompt.id
                                                            ? 'bg-primary-500/10 text-primary-300'
                                                            : 'text-dark-300 hover:bg-dark-700/50 hover:text-dark-100'
                                                        }
                                                    `}
                                                >
                                                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0
                                                        ${selectedSystemPromptId === prompt.id
                                                            ? 'border-primary-400 bg-primary-500/20'
                                                            : 'border-dark-500'
                                                        }`}>
                                                        {selectedSystemPromptId === prompt.id && <Check className="w-2.5 h-2.5 text-primary-400" />}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-medium truncate">{prompt.name}</p>
                                                        {prompt.content && (
                                                            <p className="text-[10px] text-dark-500 truncate mt-0.5">
                                                                {prompt.content.slice(0, 50)}{prompt.content.length > 50 ? '...' : ''}
                                                            </p>
                                                        )}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Text input */}
                        <textarea
                            ref={textareaRef}
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            placeholder={isDragOver ? 'Drop files...' : 'Message...'}
                            disabled={disabled}
                            rows={1}
                            className="flex-1 bg-transparent text-dark-100 placeholder:text-dark-600
                                       resize-y focus:outline-none py-1.5 px-1.5 text-sm
                                       max-h-[400px] min-h-[32px] leading-relaxed"
                            style={{ height: 'auto' }}
                            aria-label="Message input"
                        />

                        {/* Send/Stop button */}
                        <div className="flex-shrink-0 mb-px">
                            {isStreaming ? (
                                <button
                                    onClick={onStop}
                                    className="w-7 h-7 rounded-md
                                               bg-red-500/15 text-red-400
                                               hover:bg-red-500/25
                                               active:scale-95
                                               flex items-center justify-center
                                               transition-all duration-150"
                                    aria-label="Stop"
                                    title="Stop"
                                >
                                    <Square className="w-2.5 h-2.5 fill-current" />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={!canSend}
                                    className={`
                                        w-7 h-7 rounded-md
                                        flex items-center justify-center
                                        transition-all duration-150
                                        ${canSend
                                            ? 'bg-primary-600 text-white hover:bg-primary-500 active:scale-95'
                                            : 'bg-dark-700/30 text-dark-600 cursor-not-allowed'
                                        }
                                    `}
                                    aria-label="Send"
                                    title="Send"
                                >
                                    <Send className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>

                        {/* Inline drag indicator */}
                        {isDragOver && (
                            <div
                                className="absolute inset-0 flex items-center justify-center
                                           bg-dark-900/90 rounded-2xl backdrop-blur-sm
                                           pointer-events-none animate-fade-in"
                                aria-hidden="true"
                            >
                                <div className="flex items-center gap-3 text-primary-400">
                                    <Upload className="w-5 h-5 animate-bounce" />
                                    <span className="font-medium">Drop to attach</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Context window status */}
                    <div className="flex items-center justify-between mt-1 px-0.5">
                        <span className="text-[10px] text-dark-600">
                            {contextStats.messageCount} msgs
                        </span>
                        <div className="flex items-center gap-1.5">
                            <div className="w-16 h-1 bg-dark-800/80 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-300 ${
                                        contextStats.usagePercent > 90
                                            ? 'bg-red-500'
                                            : contextStats.usagePercent > 70
                                            ? 'bg-amber-500'
                                            : 'bg-emerald-500/80'
                                    }`}
                                    style={{ width: `${contextStats.usagePercent}%` }}
                                />
                            </div>
                            <span className={`text-[10px] ${
                                contextStats.isUnlimited
                                    ? 'text-dark-600'
                                    : contextStats.usagePercent > 90
                                    ? 'text-red-400'
                                    : contextStats.usagePercent > 70
                                    ? 'text-amber-400'
                                    : 'text-dark-600'
                            }`}>
                                ~{(contextStats.estimatedTokens / 1000).toFixed(1)}k / {contextStats.isUnlimited ? '∞' : `${(contextStats.maxTokens / 1000).toFixed(0)}k`}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* CSS animations */}
            <style>{`
                @keyframes fade-in {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes slide-up {
                    from {
                        opacity: 0;
                        transform: translateY(8px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                .animate-fade-in {
                    animation: fade-in 0.2s ease-out;
                }
                .animate-slide-up {
                    animation: slide-up 0.2s ease-out;
                }
            `}</style>
        </>
    );
}
