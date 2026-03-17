import React, { useState, useMemo } from 'react';
import {
    MessageSquare,
    Plus,
    Trash2,
    Edit3,
    Check,
    X,
    ChevronLeft,
    ChevronRight,
    Search,
    Star,
    Clock,
    Calendar,
    Menu,
    Sparkles
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';

/**
 * ChatSidebar - Modern conversation history sidebar with search, filtering, favorites, and mobile support
 */
export default function ChatSidebar({
    conversations,
    activeConversationId,
    onSelectConversation,
    onNewConversation,
    onDeleteConversation,
    onRenameConversation,
    onToggleFavorite,
    isMobileOpen,
    onMobileClose,
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const confirm = useConfirm();

    const handleStartEdit = (conv, e) => {
        e.stopPropagation();
        setEditingId(conv.id);
        setEditTitle(conv.title);
    };

    const handleSaveEdit = (id) => {
        if (editTitle.trim()) {
            onRenameConversation(id, editTitle.trim());
        }
        setEditingId(null);
    };

    const handleCancelEdit = () => {
        setEditingId(null);
        setEditTitle('');
    };

    const handleDelete = async (id, e) => {
        e.stopPropagation();
        const confirmed = await confirm({
            title: 'Delete Conversation',
            message: 'Are you sure you want to delete this conversation? This action cannot be undone.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (confirmed) {
            onDeleteConversation(id);
        }
    };

    const handleToggleFavorite = (id, e) => {
        e.stopPropagation();
        onToggleFavorite?.(id);
    };

    const handleSelectConversation = (id) => {
        onSelectConversation(id);
        // Close mobile sidebar when selecting a conversation
        if (onMobileClose) {
            onMobileClose();
        }
    };

    const handleNewConversation = () => {
        onNewConversation();
        // Close mobile sidebar when creating new conversation
        if (onMobileClose) {
            onMobileClose();
        }
    };

    // Categorize date
    const categorizeDate = (dateString) => {
        const date = new Date(dateString);
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfYesterday = new Date(startOfToday);
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);
        const startOfWeek = new Date(startOfToday);
        startOfWeek.setDate(startOfWeek.getDate() - 7);
        const startOfMonth = new Date(startOfToday);
        startOfMonth.setDate(startOfMonth.getDate() - 30);

        if (date >= startOfToday) return 'Today';
        if (date >= startOfYesterday) return 'Yesterday';
        if (date >= startOfWeek) return 'Previous 7 Days';
        if (date >= startOfMonth) return 'Previous 30 Days';
        return 'Older';
    };

    // Filter and group conversations
    const { groupedConversations, favoriteConversations } = useMemo(() => {
        const convArray = Array.isArray(conversations) ? conversations : [];

        // Filter by search query
        const filtered = searchQuery.trim()
            ? convArray.filter(conv => {
                const title = (conv.title || '').toLowerCase();
                const query = searchQuery.toLowerCase();
                // Also search in messages
                const messageMatch = conv.messages?.some(m =>
                    (m.content || '').toLowerCase().includes(query)
                );
                return title.includes(query) || messageMatch;
            })
            : convArray;

        // Sort by date
        const sorted = [...filtered].sort(
            (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
        );

        // Separate favorites
        const favorites = sorted.filter(c => c.favorite);
        const nonFavorites = sorted.filter(c => !c.favorite);

        // Group non-favorites by date
        const groups = {};
        nonFavorites.forEach(conv => {
            const category = categorizeDate(conv.updatedAt || conv.createdAt);
            if (!groups[category]) groups[category] = [];
            groups[category].push(conv);
        });

        return { groupedConversations: groups, favoriteConversations: favorites };
    }, [conversations, searchQuery]);

    const categoryOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

    const renderConversationItem = (conv) => (
        <div
            key={conv.id}
            onClick={() => handleSelectConversation(conv.id)}
            className={`group relative flex items-center rounded-xl cursor-pointer transition-all duration-200 ${
                activeConversationId === conv.id
                    ? 'bg-gradient-to-r from-white/10 to-white/5 border-l-[3px] shadow-lg shadow-black/10'
                    : 'hover:bg-white/[0.06] border-l-[3px] border-transparent hover:border-white/20'
            } ${collapsed ? 'justify-center p-2.5 mx-1' : 'px-3 py-2.5 mx-1'}`}
            style={activeConversationId === conv.id ? { borderColor: 'var(--accent-primary)', backgroundColor: 'rgba(var(--primary-rgb), 0.12)' } : {}}
        >
            {collapsed ? (
                <div className="relative group/icon">
                    <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                            activeConversationId === conv.id
                                ? 'bg-gradient-to-br from-white/15 to-white/5'
                                : 'bg-white/5 group-hover:bg-white/10'
                        }`}
                        style={activeConversationId === conv.id ? { boxShadow: '0 0 12px rgba(var(--primary-rgb), 0.3)' } : {}}
                    >
                        <MessageSquare
                            className="w-4 h-4 text-dark-300"
                            style={activeConversationId === conv.id ? { color: 'var(--accent-primary)' } : {}}
                        />
                    </div>
                    {conv.favorite && (
                        <Star className="w-2.5 h-2.5 absolute -top-0.5 -right-0.5 fill-yellow-400 text-yellow-400 drop-shadow-sm" />
                    )}
                    {/* Tooltip on hover */}
                    <div className="absolute left-full ml-2 px-2 py-1 bg-dark-800 border border-white/10 rounded-lg text-xs text-dark-200 whitespace-nowrap opacity-0 group-hover/icon:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
                        {conv.title || 'New Conversation'}
                    </div>
                </div>
            ) : editingId === conv.id ? (
                <div className="flex items-center gap-2 w-full" onClick={e => e.stopPropagation()}>
                    <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit(conv.id);
                            if (e.key === 'Escape') handleCancelEdit();
                        }}
                        className="flex-1 px-2.5 py-1.5 text-sm bg-dark-800 border border-white/15 rounded-lg text-dark-100 focus:outline-none focus:border-primary-500/50 focus:ring-2 focus:ring-primary-500/20"
                        autoFocus
                    />
                    <button onClick={() => handleSaveEdit(conv.id)} className="p-1.5 text-green-400 hover:text-green-300 hover:bg-green-500/15 rounded-lg transition-colors">
                        <Check className="w-4 h-4" />
                    </button>
                    <button onClick={handleCancelEdit} className="p-1.5 text-dark-400 hover:text-dark-200 hover:bg-white/10 rounded-lg transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2.5">
                            <div
                                className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                                    activeConversationId === conv.id
                                        ? 'bg-gradient-to-br from-white/15 to-white/5'
                                        : 'bg-white/5'
                                }`}
                            >
                                <MessageSquare
                                    className="w-4 h-4 text-dark-400"
                                    style={activeConversationId === conv.id ? { color: 'var(--accent-primary)' } : {}}
                                />
                            </div>
                            <div className="flex-1 min-w-0">
                                <span
                                    className={`text-sm truncate block font-medium ${
                                        activeConversationId === conv.id ? 'text-dark-100' : 'text-dark-200'
                                    }`}
                                >
                                    {conv.title || 'New Conversation'}
                                </span>
                                <span className="text-[10px] text-dark-500 truncate block">
                                    {conv.messages?.length || 0} messages
                                </span>
                            </div>
                            {conv.favorite && (
                                <Star className="w-3.5 h-3.5 flex-shrink-0 fill-yellow-400 text-yellow-400" />
                            )}
                        </div>
                    </div>

                    {/* Action buttons - show on hover */}
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all bg-dark-900/95 backdrop-blur-md rounded-lg p-1 border border-white/10 shadow-xl">
                        <button
                            onClick={(e) => handleToggleFavorite(conv.id, e)}
                            className={`p-1.5 rounded-md transition-all ${
                                conv.favorite
                                    ? 'text-yellow-400 hover:bg-yellow-500/20'
                                    : 'text-dark-400 hover:text-yellow-400 hover:bg-white/10'
                            }`}
                            title={conv.favorite ? 'Remove from favorites' : 'Add to favorites'}
                        >
                            <Star className={`w-3.5 h-3.5 ${conv.favorite ? 'fill-current' : ''}`} />
                        </button>
                        <button
                            onClick={(e) => handleStartEdit(conv, e)}
                            className="p-1.5 rounded-md hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-all"
                            title="Rename"
                        >
                            <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={(e) => handleDelete(conv.id, e)}
                            className="p-1.5 rounded-md hover:bg-red-500/20 text-dark-400 hover:text-red-400 transition-all"
                            title="Delete"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );

    const sidebarContent = (
        <>
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-white/[0.06]">
                {!collapsed && (
                    <h2 className="text-sm font-semibold text-dark-100 flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center bg-gradient-to-br from-primary-500/20 to-primary-600/10">
                            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                        </div>
                        Chats
                    </h2>
                )}
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    className={`p-2 rounded-lg hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-all ${collapsed ? 'mx-auto' : 'ml-auto'}`}
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                </button>
            </div>

            {/* New Chat Button */}
            <div className={`p-2 ${collapsed ? 'px-1.5' : 'px-3'}`}>
                <button
                    onClick={handleNewConversation}
                    className={`flex items-center gap-2 rounded-lg font-medium transition-all duration-200 ${
                        collapsed
                            ? 'justify-center w-8 h-8 mx-auto bg-gradient-to-br from-primary-500/20 to-primary-600/10 hover:from-primary-500/30 hover:to-primary-600/20 border border-primary-500/20 hover:border-primary-500/30'
                            : 'w-full px-3 py-2.5 bg-gradient-to-r from-primary-500/15 to-primary-600/10 hover:from-primary-500/25 hover:to-primary-600/15 border border-primary-500/20 hover:border-primary-500/30'
                    }`}
                    style={{ color: 'var(--accent-primary)' }}
                    title="New Chat"
                >
                    <Plus className={`flex-shrink-0 ${collapsed ? 'w-4 h-4' : 'w-4 h-4'}`} />
                    {!collapsed && <span className="text-sm">New Chat</span>}
                </button>
            </div>

            {/* Search */}
            {!collapsed && (
                <div className="px-3 pb-2">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search conversations..."
                            className="w-full pl-9 pr-8 py-2 text-sm bg-dark-800/50 border border-white/[0.06] rounded-xl text-dark-200 placeholder-dark-500 focus:outline-none focus:border-white/15 focus:ring-2 focus:ring-primary-500/10 transition-all"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded-lg text-dark-400 hover:text-dark-200 transition-colors"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Conversation List */}
            <div className="flex-1 overflow-y-auto pb-3 space-y-0.5 scrollbar-thin scrollbar-thumb-dark-700 scrollbar-track-transparent">
                {!conversations || conversations.length === 0 ? (
                    !collapsed && (
                        <div className="px-4 py-16 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-dark-800/80 to-dark-800/40 flex items-center justify-center mx-auto mb-4 border border-white/5">
                                <MessageSquare className="w-8 h-8 text-dark-500" />
                            </div>
                            <p className="text-sm font-medium text-dark-300">No conversations yet</p>
                            <p className="text-xs text-dark-500 mt-1.5">Start a new chat to begin</p>
                        </div>
                    )
                ) : (
                    <>
                        {/* Favorites Section */}
                        {favoriteConversations.length > 0 && !collapsed && (
                            <div className="mb-2 pt-1">
                                <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold text-dark-500 uppercase tracking-widest">
                                    <Star className="w-3 h-3 fill-yellow-400/60 text-yellow-400/60" />
                                    Favorites
                                </div>
                                <div className="space-y-0.5">
                                    {favoriteConversations.map(conv => renderConversationItem(conv))}
                                </div>
                            </div>
                        )}

                        {/* Grouped Conversations */}
                        {categoryOrder.map(category => {
                            const convs = groupedConversations[category];
                            if (!convs || convs.length === 0) return null;

                            return (
                                <div key={category} className="mb-2 pt-1">
                                    {!collapsed && (
                                        <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold text-dark-500 uppercase tracking-widest">
                                            {category === 'Today' && <Clock className="w-3 h-3" />}
                                            {category === 'Yesterday' && <Clock className="w-3 h-3" />}
                                            {(category === 'Previous 7 Days' || category === 'Previous 30 Days' || category === 'Older') && <Calendar className="w-3 h-3" />}
                                            {category}
                                        </div>
                                    )}
                                    <div className="space-y-0.5">
                                        {convs.map(conv => renderConversationItem(conv))}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Collapsed view - just show all */}
                        {collapsed && (
                            <div className="space-y-1 pt-2">
                                {[...favoriteConversations, ...Object.values(groupedConversations).flat()].map(conv =>
                                    renderConversationItem(conv)
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );

    return (
        <>
            {/* Mobile Overlay */}
            {isMobileOpen && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
                    onClick={onMobileClose}
                />
            )}

            {/* Desktop Sidebar */}
            <aside
                className={`hidden md:flex flex-col bg-gradient-to-b from-dark-900 to-dark-950 border-r border-white/[0.06] transition-all duration-300 ease-out ${
                    collapsed ? 'w-[72px]' : 'w-80'
                }`}
            >
                {sidebarContent}
            </aside>

            {/* Mobile Sidebar (Drawer) */}
            <aside
                className={`fixed md:hidden inset-y-0 left-0 z-50 flex flex-col w-80 bg-gradient-to-b from-dark-900 to-dark-950 border-r border-white/[0.06] transition-transform duration-300 ease-out ${
                    isMobileOpen ? 'translate-x-0' : '-translate-x-full'
                }`}
            >
                {/* Mobile Close Button */}
                <button
                    onClick={onMobileClose}
                    className="absolute top-3 right-3 p-2 rounded-lg hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-all md:hidden"
                >
                    <X className="w-5 h-5" />
                </button>
                {sidebarContent}
            </aside>
        </>
    );
}
