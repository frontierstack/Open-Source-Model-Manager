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
    Calendar
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';

/**
 * ChatSidebar - Conversation history sidebar with search, filtering, and favorites (Tailwind)
 */
export default function ChatSidebar({
    conversations,
    activeConversationId,
    onSelectConversation,
    onNewConversation,
    onDeleteConversation,
    onRenameConversation,
    onToggleFavorite,
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
            onClick={() => onSelectConversation(conv.id)}
            className={`group relative flex items-center rounded-lg cursor-pointer transition-all duration-200 ${
                activeConversationId === conv.id
                    ? 'bg-white/10 border-l-2'
                    : 'hover:bg-white/5'
            } ${collapsed ? 'justify-center p-2' : 'px-2.5 py-2'}`}
            style={activeConversationId === conv.id ? { borderColor: 'var(--accent-primary)' } : {}}
        >
            {collapsed ? (
                <div className="relative">
                    <MessageSquare
                        className="w-4 h-4 text-dark-400"
                        style={activeConversationId === conv.id ? { color: 'var(--accent-primary)' } : {}}
                    />
                    {conv.favorite && (
                        <Star className="w-2 h-2 absolute -top-1 -right-1 fill-yellow-400 text-yellow-400" />
                    )}
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
                        className="flex-1 px-2 py-1.5 text-sm bg-dark-800 border border-white/10 rounded-lg text-dark-100 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30"
                        autoFocus
                    />
                    <button onClick={() => handleSaveEdit(conv.id)} className="p-1 text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded">
                        <Check className="w-4 h-4" />
                    </button>
                    <button onClick={handleCancelEdit} className="p-1 text-dark-400 hover:text-dark-200 hover:bg-white/5 rounded">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <MessageSquare
                                className="w-4 h-4 flex-shrink-0 text-dark-500"
                                style={activeConversationId === conv.id ? { color: 'var(--accent-primary)' } : {}}
                            />
                            <span
                                className={`text-sm truncate font-medium ${
                                    activeConversationId === conv.id ? 'text-dark-100' : 'text-dark-200'
                                }`}
                            >
                                {conv.title || 'New Conversation'}
                            </span>
                            {conv.favorite && (
                                <Star className="w-3 h-3 flex-shrink-0 fill-yellow-400 text-yellow-400" />
                            )}
                        </div>
                    </div>

                    {/* Action buttons - show on hover */}
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-dark-900/90 backdrop-blur-sm rounded-lg p-1">
                        <button
                            onClick={(e) => handleToggleFavorite(conv.id, e)}
                            className={`p-1.5 rounded-md transition-colors ${
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
                            className="p-1.5 rounded-md hover:bg-white/10 text-dark-400 hover:text-dark-200 transition-colors"
                            title="Rename"
                        >
                            <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={(e) => handleDelete(conv.id, e)}
                            className="p-1.5 rounded-md hover:bg-red-500/20 text-dark-400 hover:text-red-400 transition-colors"
                            title="Delete"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );

    return (
        <aside
            className={`flex flex-col bg-dark-900/95 border-r border-white/5 transition-all duration-300 ease-out ${
                collapsed ? 'w-16' : 'w-72'
            }`}
            style={{
                transitionProperty: 'width',
            }}
        >
            {/* Header */}
            <div className="flex items-center justify-between p-2.5 border-b border-white/5">
                {!collapsed && (
                    <h2 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                        <MessageSquare className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                        Conversations
                    </h2>
                )}
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="btn-icon ml-auto hover:bg-white/10"
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                </button>
            </div>

            {/* Search */}
            {!collapsed && (
                <div className="px-2 pb-1">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-500" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search..."
                            className="w-full pl-8 pr-3 py-1.5 text-sm bg-dark-800/60 border border-white/5 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-white/20 transition-all"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded text-dark-400 hover:text-dark-200"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* New Chat Button */}
            <div className="px-2 pb-2">
                <button
                    onClick={onNewConversation}
                    className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/15 transition-all duration-200 ${
                        collapsed ? 'justify-center' : ''
                    }`}
                    style={{ color: 'var(--accent-primary)' }}
                    title="New Chat"
                >
                    <Plus className="w-4 h-4 flex-shrink-0" />
                    {!collapsed && <span className="text-sm font-medium">New Chat</span>}
                </button>
            </div>

            {/* Conversation List */}
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1 scrollbar-thin scrollbar-thumb-dark-700 scrollbar-track-transparent">
                {!conversations || conversations.length === 0 ? (
                    !collapsed && (
                        <div className="px-3 py-12 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-dark-800/80 flex items-center justify-center mx-auto mb-3">
                                <MessageSquare className="w-7 h-7 text-dark-600" />
                            </div>
                            <p className="text-sm font-medium text-dark-400">No conversations yet</p>
                            <p className="text-xs text-dark-500 mt-1">Start a new chat to begin</p>
                        </div>
                    )
                ) : (
                    <>
                        {/* Favorites Section */}
                        {favoriteConversations.length > 0 && !collapsed && (
                            <div className="mb-3">
                                <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-dark-500 uppercase tracking-wider">
                                    <Star className="w-3 h-3 fill-yellow-400/50 text-yellow-400/50" />
                                    Favorites
                                </div>
                                <div className="space-y-1">
                                    {favoriteConversations.map(conv => renderConversationItem(conv))}
                                </div>
                            </div>
                        )}

                        {/* Grouped Conversations */}
                        {categoryOrder.map(category => {
                            const convs = groupedConversations[category];
                            if (!convs || convs.length === 0) return null;

                            return (
                                <div key={category} className="mb-3">
                                    {!collapsed && (
                                        <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-dark-500 uppercase tracking-wider">
                                            {category === 'Today' && <Clock className="w-3 h-3" />}
                                            {category === 'Yesterday' && <Clock className="w-3 h-3" />}
                                            {(category === 'Previous 7 Days' || category === 'Previous 30 Days' || category === 'Older') && <Calendar className="w-3 h-3" />}
                                            {category}
                                        </div>
                                    )}
                                    <div className="space-y-1">
                                        {convs.map(conv => renderConversationItem(conv))}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Collapsed view - just show all */}
                        {collapsed && (
                            <div className="space-y-1">
                                {[...favoriteConversations, ...Object.values(groupedConversations).flat()].map(conv =>
                                    renderConversationItem(conv)
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </aside>
    );
}
