import React, { useState, useRef, useCallback, useEffect } from 'react';
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
    Check
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
    systemPrompts = [],
    selectedSystemPromptId,
    onSystemPromptSelect,
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

    // Supported file types
    const supportedTypes = {
        text: ['.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.html', '.css', '.scss', '.less', '.sh', '.bash', '.sql', '.rb', '.php', '.swift', '.kt', '.toml', '.ini', '.env'],
        image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
        pdf: ['.pdf'],
    };

    const allSupportedExtensions = [...supportedTypes.text, ...supportedTypes.image, ...supportedTypes.pdf];

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
        const validFiles = fileArray.filter(file => {
            const extension = '.' + file.name.split('.').pop().toLowerCase();
            return allSupportedExtensions.includes(extension);
        });

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
    }, [onAddAttachment, allSupportedExtensions]);

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
            <div className="p-4 pb-6 bg-gradient-to-t from-dark-950 via-dark-950/95 to-transparent">
                <div className="max-w-4xl mx-auto">
                    {/* Attachment preview cards */}
                    {(attachments.length > 0 || uploadingFiles.length > 0) && (
                        <div
                            className="flex flex-wrap gap-2 mb-3 animate-slide-up"
                            role="list"
                            aria-label="Attached files"
                        >
                            {/* Uploading files */}
                            {uploadingFiles.map((file) => (
                                <div
                                    key={file.id}
                                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-dark-800/60 border border-dark-700/50 text-sm animate-pulse"
                                    role="listitem"
                                >
                                    <div className="w-8 h-8 rounded-lg bg-dark-700/50 flex items-center justify-center">
                                        <FileIcon className="w-4 h-4 text-dark-400 animate-spin" />
                                    </div>
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-dark-300 truncate max-w-[140px] text-xs font-medium">
                                            {file.filename}
                                        </span>
                                        <span className="text-dark-500 text-[10px]">
                                            Uploading...
                                        </span>
                                    </div>
                                </div>
                            ))}

                            {/* Attached files */}
                            {attachments.map((att, index) => (
                                <div
                                    key={att.id || index}
                                    className={`
                                        group flex items-center gap-2.5 px-3 py-2 rounded-xl border text-sm
                                        transition-all duration-200 hover:scale-[1.02]
                                        ${getFileTypeColor(att.filename, att.type)}
                                    `}
                                    role="listitem"
                                >
                                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                                        {getFileIcon(att.filename, att.type)}
                                    </div>
                                    <div className="flex flex-col min-w-0">
                                        <span className="truncate max-w-[140px] text-xs font-medium">
                                            {att.filename}
                                        </span>
                                        <span className="text-[10px] opacity-60">
                                            {att.size ? formatFileSize(att.size) :
                                             att.charCount ? `${att.charCount.toLocaleString()} chars` :
                                             att.pageCount ? `${att.pageCount} pages` : ''}
                                        </span>
                                    </div>
                                    <button
                                        onClick={() => onRemoveAttachment(index)}
                                        className="ml-1 p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10
                                                   transition-all duration-200 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/20"
                                        aria-label={`Remove ${att.filename}`}
                                        tabIndex={0}
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Main input bar */}
                    <div
                        className={`
                            relative flex items-end gap-2 p-2 pl-3 rounded-2xl
                            bg-dark-800/80 backdrop-blur-xl
                            border transition-all duration-300 shadow-xl shadow-dark-950/50
                            ${isDragOver
                                ? 'border-primary-500/60 ring-4 ring-primary-500/20 bg-primary-500/5'
                                : 'border-dark-700/50 hover:border-dark-600/50 focus-within:border-primary-500/40 focus-within:ring-2 focus-within:ring-primary-500/10'
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
                            accept={allSupportedExtensions.join(',')}
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
                            className="flex-shrink-0 p-2 rounded-xl text-dark-400
                                       hover:text-dark-200 hover:bg-dark-700/50
                                       disabled:opacity-40 disabled:cursor-not-allowed
                                       transition-all duration-200
                                       focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                            aria-label="Attach files"
                            title="Attach files (images, PDFs, code, text)"
                        >
                            <Paperclip className="w-5 h-5" />
                        </button>

                        {/* System prompt selector */}
                        {systemPrompts.length > 0 && (
                            <div className="relative flex-shrink-0" ref={promptDropdownRef}>
                                <button
                                    onClick={() => setPromptDropdownOpen(!promptDropdownOpen)}
                                    disabled={disabled || isStreaming}
                                    className={`
                                        flex items-center gap-1.5 px-2 py-1.5 rounded-lg
                                        text-[11px] font-medium tracking-wide
                                        transition-all duration-200
                                        disabled:opacity-40 disabled:cursor-not-allowed
                                        focus:outline-none focus:ring-2 focus:ring-primary-500/40
                                        ${selectedPrompt
                                            ? 'bg-primary-500/15 text-primary-300 border border-primary-500/30 hover:bg-primary-500/25'
                                            : 'text-dark-400 hover:text-dark-200 hover:bg-dark-700/50'
                                        }
                                    `}
                                    aria-label="Select system prompt"
                                    title={selectedPrompt ? `System prompt: ${selectedPrompt.name}` : 'Select system prompt'}
                                >
                                    <ScrollText className="w-3.5 h-3.5" />
                                    <span className="max-w-[80px] truncate">
                                        {selectedPrompt ? selectedPrompt.name : 'Prompt'}
                                    </span>
                                    <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${promptDropdownOpen ? 'rotate-180' : ''}`} />
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
                            placeholder={isDragOver ? 'Drop files here...' : 'Message...'}
                            disabled={disabled}
                            rows={1}
                            className="flex-1 bg-transparent text-dark-100 placeholder:text-dark-500
                                       resize-none focus:outline-none py-2.5 px-1
                                       max-h-[200px] min-h-[44px] leading-relaxed"
                            style={{ height: 'auto' }}
                            aria-label="Message input"
                            aria-describedby="input-hint"
                        />

                        {/* Send/Stop button */}
                        <div className="flex-shrink-0 pb-0.5">
                            {isStreaming ? (
                                <button
                                    onClick={onStop}
                                    className="w-10 h-10 rounded-xl
                                               bg-red-500/20 text-red-400
                                               hover:bg-red-500/30 hover:text-red-300
                                               active:scale-95
                                               flex items-center justify-center
                                               transition-all duration-200
                                               focus:outline-none focus:ring-2 focus:ring-red-500/40"
                                    aria-label="Stop generating"
                                    title="Stop generating"
                                >
                                    <Square className="w-4 h-4 fill-current" />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={!canSend}
                                    className={`
                                        w-10 h-10 rounded-xl
                                        flex items-center justify-center
                                        transition-all duration-200
                                        focus:outline-none focus:ring-2 focus:ring-primary-500/40
                                        ${canSend
                                            ? 'bg-primary-600 text-white hover:bg-primary-500 active:scale-95 shadow-lg shadow-primary-600/30'
                                            : 'bg-dark-700/50 text-dark-500 cursor-not-allowed'
                                        }
                                    `}
                                    aria-label="Send message"
                                    title={canSend ? 'Send message' : 'Type a message or attach files'}
                                >
                                    <Send className="w-4 h-4" />
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

                    {/* Helper text */}
                    <p
                        id="input-hint"
                        className="text-[11px] text-dark-500 mt-2.5 text-center select-none"
                    >
                        <kbd className="px-1.5 py-0.5 rounded bg-dark-800/50 text-dark-400 font-mono text-[10px]">Enter</kbd>
                        {' '}to send{' '}
                        <span className="text-dark-600 mx-1">|</span>
                        {' '}<kbd className="px-1.5 py-0.5 rounded bg-dark-800/50 text-dark-400 font-mono text-[10px]">Shift + Enter</kbd>
                        {' '}for new line
                    </p>
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
