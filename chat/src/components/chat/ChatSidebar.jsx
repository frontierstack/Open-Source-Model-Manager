import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
    MessageSquare,
    Plus,
    Trash2,
    Edit3,
    Check,
    X,
    Search,
    Star,
    PanelLeftClose,
    ChevronDown,
    Folder,
    FolderOpen,
    FolderPlus,
    FolderInput,
} from 'lucide-react';
import { useConfirm } from '../ConfirmDialog';
import { useChatStore } from '../../stores/useChatStore';

/**
 * ChatSidebar — workspace-style sidebar with user-defined folders.
 *
 * Layout:
 *   - Workspace header (logo + name + collapse)
 *   - Search box
 *   - New chat button
 *   - New folder inline button
 *   - Favorites section (top)
 *   - User folder sections (created via "+ New folder")
 *   - Unassigned section (bottom), date-grouped internally
 *   - User footer
 *
 * Folders and conversation→folder mapping live in useChatStore and persist to
 * localStorage via saveToStorage (no backend).
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
    collapsed,
    onToggleCollapsed,
}) {
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [collapsedGroups, setCollapsedGroups] = useState({});
    const [editingFolderId, setEditingFolderId] = useState(null);
    const [editingFolderName, setEditingFolderName] = useState('');
    const [moveMenuConvId, setMoveMenuConvId] = useState(null);
    // Drag & drop: which drop target is currently being hovered.
    // `null` = none, a folder id = that folder, `'unassigned'` = unassigned bucket.
    const [dragOverTarget, setDragOverTarget] = useState(null);
    const [draggingConvId, setDraggingConvId] = useState(null);
    const moveMenuRef = useRef(null);
    const confirm = useConfirm();

    const collapsedDesktop = collapsed && !isMobileOpen;

    const user = useChatStore(s => s.user);
    const folders = useChatStore(s => s.folders);
    const conversationFolderMap = useChatStore(s => s.conversationFolderMap);
    const createFolder = useChatStore(s => s.createFolder);
    const renameFolder = useChatStore(s => s.renameFolder);
    const deleteFolder = useChatStore(s => s.deleteFolder);
    const setConversationFolder = useChatStore(s => s.setConversationFolder);

    // Close menus on outside click
    useEffect(() => {
        const onDocClick = (e) => {
            if (moveMenuRef.current && !moveMenuRef.current.contains(e.target)) {
                setMoveMenuConvId(null);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, []);

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
        if (confirmed) onDeleteConversation(id);
    };

    const handleToggleFavorite = (id, e) => {
        e.stopPropagation();
        onToggleFavorite?.(id);
    };

    const handleSelectConversation = (id) => {
        onSelectConversation(id);
        if (onMobileClose) onMobileClose();
    };

    const handleNewConversation = () => {
        onNewConversation();
        if (onMobileClose) onMobileClose();
    };

    // Click "New folder" → creates immediately with a default name and
    // jumps straight into rename mode so the user can name it without
    // a two-step input flow.
    const handleCreateFolder = () => {
        const existing = new Set((folders || []).map(f => (f.name || '').toLowerCase()));
        let name = 'New folder';
        let n = 2;
        while (existing.has(name.toLowerCase())) {
            name = `New folder ${n++}`;
        }
        const folder = createFolder(name);
        if (folder) {
            // Default new folders to collapsed — user can expand once they
            // start dragging chats into them.
            setCollapsedGroups(prev => ({ ...prev, [`folder:${folder.id}`]: true }));
            setEditingFolderId(folder.id);
            setEditingFolderName(folder.name);
        }
    };

    // Close rename mode without touching the folder. If the user wants the
    // folder gone, the always-visible trash icon handles that.
    const handleCancelFolderRename = () => {
        setEditingFolderId(null);
        setEditingFolderName('');
    };

    // Bulk-delete any folders still carrying the auto-assigned default name
    // ("New folder", "New folder 2", …). Lets users clean up orphans left
    // behind by earlier rapid-click behavior in one step.
    const handleClearOrphanFolders = async () => {
        const orphans = (folders || []).filter(f => /^New folder( \d+)?$/i.test(f.name || ''));
        if (!orphans.length) return;
        const confirmed = await confirm({
            title: 'Clear unnamed folders',
            message: `Delete ${orphans.length} unnamed folder${orphans.length === 1 ? '' : 's'} ("New folder", "New folder 2", …)? Any conversations inside will move to Unassigned.`,
            confirmText: 'Clear',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (!confirmed) return;
        orphans.forEach(f => deleteFolder(f.id));
    };
    const orphanCount = (folders || []).filter(f => /^New folder( \d+)?$/i.test(f.name || '')).length;

    const handleStartFolderRename = (folder) => {
        setEditingFolderId(folder.id);
        setEditingFolderName(folder.name);
    };

    const handleSaveFolderRename = (id) => {
        if (editingFolderName.trim()) {
            renameFolder(id, editingFolderName.trim());
        }
        setEditingFolderId(null);
        setEditingFolderName('');
    };

    const handleDeleteFolder = async (folder) => {
        const confirmed = await confirm({
            title: 'Delete Folder',
            message: `Delete folder "${folder.name}"? Its conversations will move to Unassigned. This cannot be undone.`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            variant: 'danger',
        });
        if (confirmed) deleteFolder(folder.id);
    };

    const handleMoveToFolder = (conversationId, folderId) => {
        setConversationFolder(conversationId, folderId);
        setMoveMenuConvId(null);
    };

    // ---------- Drag & drop helpers ----------
    const handleChatDragStart = (conv) => (e) => {
        e.dataTransfer.setData('application/x-conv-id', conv.id);
        // Fallback plain text for browsers that ignore custom MIME
        e.dataTransfer.setData('text/plain', conv.id);
        e.dataTransfer.effectAllowed = 'move';
        setDraggingConvId(conv.id);
    };
    const handleChatDragEnd = () => {
        setDraggingConvId(null);
        setDragOverTarget(null);
    };
    const dropTargetProps = (targetId) => ({
        onDragOver: (e) => {
            if (!draggingConvId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverTarget !== targetId) setDragOverTarget(targetId);
        },
        onDragLeave: (e) => {
            // Only clear if leaving the element entirely (not entering a child)
            if (!e.currentTarget.contains(e.relatedTarget)) {
                setDragOverTarget(prev => (prev === targetId ? null : prev));
            }
        },
        onDrop: (e) => {
            e.preventDefault();
            const convId = e.dataTransfer.getData('application/x-conv-id')
                || e.dataTransfer.getData('text/plain');
            if (convId) {
                // targetId === 'unassigned' → null folder
                setConversationFolder(convId, targetId === 'unassigned' ? null : targetId);
            }
            setDragOverTarget(null);
            setDraggingConvId(null);
        },
    });

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
        if (date >= startOfWeek) return 'This week';
        if (date >= startOfMonth) return 'This month';
        return 'Older';
    };

    const {
        favorites,
        folderBuckets,
        unassignedDateGroups,
    } = useMemo(() => {
        const convArray = Array.isArray(conversations) ? conversations : [];
        const filtered = searchQuery.trim()
            ? convArray.filter(conv => {
                const title = (conv.title || '').toLowerCase();
                const query = searchQuery.toLowerCase();
                const messageMatch = conv.messages?.some(m =>
                    (m.content || '').toLowerCase().includes(query)
                );
                return title.includes(query) || messageMatch;
            })
            : convArray;

        const sorted = [...filtered].sort(
            (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
        );

        const favs = sorted.filter(c => c.favorite);
        const rest = sorted.filter(c => !c.favorite);

        // Bucket by folder id
        const folderIdSet = new Set((folders || []).map(f => f.id));
        const buckets = {};
        (folders || []).forEach(f => { buckets[f.id] = []; });

        const unassigned = [];
        rest.forEach(conv => {
            const fid = conversationFolderMap?.[conv.id];
            if (fid && folderIdSet.has(fid)) {
                buckets[fid].push(conv);
            } else {
                unassigned.push(conv);
            }
        });

        // Date-group unassigned
        const dateGroups = {};
        unassigned.forEach(conv => {
            const cat = categorizeDate(conv.updatedAt || conv.createdAt);
            if (!dateGroups[cat]) dateGroups[cat] = [];
            dateGroups[cat].push(conv);
        });

        return {
            favorites: favs,
            folderBuckets: buckets,
            unassignedDateGroups: dateGroups,
        };
    }, [conversations, searchQuery, folders, conversationFolderMap]);

    const dateGroupOrder = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];
    const sortedFolders = useMemo(
        () => [...(folders || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        [folders]
    );
    const unassignedTotal = Object.values(unassignedDateGroups).reduce((n, arr) => n + arr.length, 0);

    const displayName = user?.username || user?.name || 'User';
    const userInitial = displayName.charAt(0).toUpperCase();
    const totalChats = Array.isArray(conversations) ? conversations.length : 0;

    const toggleGroup = (key) => {
        setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // Styles
    const aside = {
        height: '100%',
        flexShrink: 0,
        background: 'var(--bg-2)',
        overflow: 'hidden',
        // Width + border animated together for a smooth collapse
        transition: 'width 0.22s ease, border-right-color 0.22s ease',
    };
    const asideInner = {
        width: 268,
        minWidth: 268,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
    };
    const workspaceHeader = {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 14px 12px',
    };
    const workspaceRow = { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 };
    const iconBtn = {
        width: 26, height: 26, borderRadius: 6,
        display: 'grid', placeItems: 'center',
        color: 'var(--ink-3)',
        background: 'transparent', border: 0, cursor: 'pointer',
        transition: 'background .1s, color .1s',
    };
    const searchRow = { padding: '0 12px 8px' };
    const searchWrap = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        background: 'var(--bg)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
        color: 'var(--ink-3)',
    };
    const searchInput = {
        flex: 1, border: 0, outline: 0, background: 'transparent',
        fontSize: 12.5, color: 'var(--ink)',
    };
    const newChatRow = { padding: '0 12px 6px' };
    const newChatBtn = {
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '8px 10px',
        border: '1px dashed var(--rule-2)',
        borderRadius: 8,
        color: 'var(--ink-2)', fontSize: 12.5, fontWeight: 500,
        background: 'transparent', cursor: 'pointer',
        transition: 'background .1s, border-color .1s',
    };
    const newFolderRow = { padding: '0 12px 8px' };
    const newFolderBtn = {
        display: 'flex', alignItems: 'center', gap: 6,
        width: '100%', padding: '5px 8px',
        border: 0,
        borderRadius: 6,
        color: 'var(--ink-3)', fontSize: 11.5, fontWeight: 500,
        background: 'transparent', cursor: 'pointer',
        transition: 'background .1s, color .1s',
    };
    const scroll = {
        flex: 1, overflowY: 'auto',
        padding: '4px 8px 8px',
    };
    const folderHeader = {
        display: 'flex', alignItems: 'center', gap: 7,
        width: '100%', padding: '6px 8px',
        color: 'var(--ink-2)', fontSize: 12,
        borderRadius: 6,
        background: 'transparent', border: 0, cursor: 'pointer',
        transition: 'background .08s',
        position: 'relative',
    };
    const count = {
        marginLeft: 'auto',
        fontSize: 10.5, color: 'var(--ink-4)',
        fontVariantNumeric: 'tabular-nums',
    };
    const chatRow = (active) => ({
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px 6px 14px',
        textAlign: 'left',
        borderRadius: '0 6px 6px 0',
        marginLeft: 6,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--ink)' : 'var(--ink-2)',
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background .08s',
    });
    const footer = {
        borderTop: '1px solid var(--rule)',
        padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        flexShrink: 0,
    };
    const avatar = {
        width: 28, height: 28, borderRadius: '50%',
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'grid', placeItems: 'center',
        fontSize: 11, fontWeight: 600,
        flexShrink: 0,
    };
    const popover = {
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 4,
        minWidth: 160,
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
        boxShadow: '0 8px 24px color-mix(in oklab, var(--ink) 18%, transparent)',
        padding: 4,
        zIndex: 100,
        display: 'flex', flexDirection: 'column', gap: 1,
    };
    const popoverItem = {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        fontSize: 12,
        color: 'var(--ink-2)',
        background: 'transparent', border: 0,
        borderRadius: 4,
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
        transition: 'background .08s, color .08s',
    };

    const renderChatRow = (conv) => {
        const active = activeConversationId === conv.id;
        const isEditing = editingId === conv.id;
        const moveMenuOpen = moveMenuConvId === conv.id;
        const currentFolderId = conversationFolderMap?.[conv.id] || null;
        const isDragging = draggingConvId === conv.id;
        return (
            <div
                key={conv.id}
                onClick={() => !isEditing && handleSelectConversation(conv.id)}
                style={{
                    ...chatRow(active),
                    opacity: isDragging ? 0.45 : 1,
                }}
                onMouseEnter={(e) => { if (!active && !isEditing) e.currentTarget.style.background = 'var(--bg-3, var(--bg))'; }}
                onMouseLeave={(e) => { if (!active && !isEditing) e.currentTarget.style.background = 'transparent'; }}
                className="sidebar-chat-row"
                draggable={!isEditing}
                onDragStart={handleChatDragStart(conv)}
                onDragEnd={handleChatDragEnd}
            >
                {isEditing ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }} onClick={e => e.stopPropagation()}>
                        <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveEdit(conv.id);
                                if (e.key === 'Escape') handleCancelEdit();
                            }}
                            style={{
                                flex: 1, padding: '4px 6px',
                                fontSize: 12.5, color: 'var(--ink)',
                                background: 'var(--surface)',
                                border: '1px solid var(--accent)',
                                borderRadius: 4,
                                outline: 0,
                            }}
                            autoFocus
                        />
                        <button
                            onClick={() => handleSaveEdit(conv.id)}
                            style={{ ...iconBtn, width: 22, height: 22, color: 'var(--ok)' }}
                            title="Save"
                        >
                            <Check style={{ width: 13, height: 13 }} strokeWidth={2} />
                        </button>
                        <button
                            onClick={handleCancelEdit}
                            style={{ ...iconBtn, width: 22, height: 22 }}
                            title="Cancel"
                        >
                            <X style={{ width: 13, height: 13 }} strokeWidth={2} />
                        </button>
                    </div>
                ) : (
                    <>
                        <span style={{
                            flex: 1, minWidth: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontSize: 12.5,
                            fontWeight: active ? 500 : 400,
                        }}>
                            {conv.title || 'New Conversation'}
                        </span>
                        {conv.favorite && (
                            <Star
                                style={{
                                    width: 11, height: 11,
                                    fill: 'var(--warning)',
                                    color: 'var(--warning)',
                                    flexShrink: 0,
                                }}
                            />
                        )}
                        {/* Hover actions */}
                        <div
                            className="chat-row-actions"
                            style={{
                                position: 'absolute', right: 4, top: '50%',
                                transform: 'translateY(-50%)',
                                display: 'flex', alignItems: 'center', gap: 1,
                                background: 'var(--surface)',
                                border: '1px solid var(--rule)',
                                borderRadius: 5,
                                padding: 1,
                                opacity: moveMenuOpen ? 1 : 0,
                                transition: 'opacity .1s',
                            }}
                        >
                            <button
                                onClick={(e) => handleToggleFavorite(conv.id, e)}
                                style={{
                                    ...iconBtn,
                                    width: 20, height: 20,
                                    color: conv.favorite ? 'var(--warning)' : 'var(--ink-3)',
                                }}
                                title={conv.favorite ? 'Unfavorite' : 'Favorite'}
                            >
                                <Star
                                    style={{
                                        width: 11, height: 11,
                                        fill: conv.favorite ? 'currentColor' : 'none',
                                    }}
                                    strokeWidth={1.75}
                                />
                            </button>
                            <div style={{ position: 'relative' }} ref={moveMenuOpen ? moveMenuRef : null}>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMoveMenuConvId(moveMenuOpen ? null : conv.id);
                                    }}
                                    style={{ ...iconBtn, width: 20, height: 20 }}
                                    title="Move to folder"
                                >
                                    <FolderInput style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                                </button>
                                {moveMenuOpen && (
                                    <div
                                        style={{ ...popover, right: 0, maxHeight: 240, overflowY: 'auto' }}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <div style={{
                                            padding: '4px 8px 6px',
                                            fontSize: 10.5, fontWeight: 600,
                                            color: 'var(--ink-4)',
                                            textTransform: 'uppercase',
                                            letterSpacing: 0.4,
                                        }}>
                                            Move to
                                        </div>
                                        {sortedFolders.length === 0 ? (
                                            <div style={{
                                                padding: '6px 8px',
                                                fontSize: 11.5,
                                                color: 'var(--ink-4)',
                                                fontStyle: 'italic',
                                            }}>
                                                No folders yet
                                            </div>
                                        ) : (
                                            sortedFolders.map(f => {
                                                const isCurrent = currentFolderId === f.id;
                                                return (
                                                    <button
                                                        key={f.id}
                                                        onClick={() => handleMoveToFolder(conv.id, f.id)}
                                                        style={{
                                                            ...popoverItem,
                                                            background: isCurrent ? 'var(--accent-soft)' : 'transparent',
                                                            color: isCurrent ? 'var(--ink)' : 'var(--ink-2)',
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            if (!isCurrent) e.currentTarget.style.background = 'var(--bg-3, var(--bg))';
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            if (!isCurrent) e.currentTarget.style.background = 'transparent';
                                                        }}
                                                    >
                                                        <Folder style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                                                        <span style={{
                                                            flex: 1, minWidth: 0,
                                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                        }}>{f.name}</span>
                                                        {isCurrent && (
                                                            <Check style={{ width: 11, height: 11, color: 'var(--accent)' }} strokeWidth={2.25} />
                                                        )}
                                                    </button>
                                                );
                                            })
                                        )}
                                        <div style={{
                                            height: 1, background: 'var(--rule)', margin: '4px 2px',
                                        }} />
                                        <button
                                            onClick={() => handleMoveToFolder(conv.id, null)}
                                            style={{
                                                ...popoverItem,
                                                color: currentFolderId == null ? 'var(--ink)' : 'var(--ink-3)',
                                                background: currentFolderId == null ? 'var(--accent-soft)' : 'transparent',
                                            }}
                                            onMouseEnter={(e) => {
                                                if (currentFolderId != null) e.currentTarget.style.background = 'var(--bg-3, var(--bg))';
                                            }}
                                            onMouseLeave={(e) => {
                                                if (currentFolderId != null) e.currentTarget.style.background = 'transparent';
                                            }}
                                        >
                                            <X style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                                            <span style={{ flex: 1 }}>Unassigned</span>
                                            {currentFolderId == null && (
                                                <Check style={{ width: 11, height: 11, color: 'var(--accent)' }} strokeWidth={2.25} />
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={(e) => handleStartEdit(conv, e)}
                                style={{ ...iconBtn, width: 20, height: 20 }}
                                title="Rename"
                            >
                                <Edit3 style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                            </button>
                            <button
                                onClick={(e) => handleDelete(conv.id, e)}
                                style={{ ...iconBtn, width: 20, height: 20, color: 'var(--ink-3)' }}
                                title="Delete"
                                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--danger)'}
                                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-3)'}
                            >
                                <Trash2 style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                            </button>
                        </div>
                    </>
                )}
            </div>
        );
    };

    // Generic group renderer for Favorites + Unassigned date sub-groups
    const renderSimpleGroup = (key, label, items, { icon: Icon = Folder, accent = false, indented = false } = {}) => {
        if (!items.length) return null;
        const open = !collapsedGroups[key];
        return (
            <div key={key} style={{ marginBottom: 4, marginLeft: indented ? 8 : 0 }}>
                <button
                    onClick={() => toggleGroup(key)}
                    style={folderHeader}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-3, var(--bg))'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                    <span style={{
                        display: 'inline-flex',
                        transform: open ? 'rotate(0)' : 'rotate(-90deg)',
                        transition: 'transform .15s',
                        color: 'var(--ink-4)',
                    }}>
                        <ChevronDown style={{ width: 11, height: 11 }} strokeWidth={2} />
                    </span>
                    <Icon
                        style={{
                            width: 13, height: 13,
                            color: accent ? 'var(--warning)' : 'var(--ink-3)',
                            ...(accent ? { fill: 'var(--warning)' } : {}),
                        }}
                        strokeWidth={1.75}
                    />
                    <span style={{ fontWeight: 500 }}>{label}</span>
                    <span style={count}>{items.length}</span>
                </button>
                {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                        {items.map(renderChatRow)}
                    </div>
                )}
            </div>
        );
    };

    // User-folder renderer (with rename + menu)
    const renderUserFolder = (folder) => {
        const items = folderBuckets[folder.id] || [];
        const key = `folder:${folder.id}`;
        const open = !collapsedGroups[key];
        const Icon = open ? FolderOpen : Folder;
        const isRenaming = editingFolderId === folder.id;
        const isDropTarget = dragOverTarget === folder.id;
        return (
            <div
                key={folder.id}
                style={{
                    marginBottom: 4,
                    position: 'relative',
                    borderRadius: 6,
                    outline: isDropTarget ? '1.5px dashed var(--accent)' : '1.5px dashed transparent',
                    outlineOffset: -1,
                    background: isDropTarget ? 'var(--accent-soft)' : 'transparent',
                    transition: 'background .1s, outline-color .1s',
                }}
                {...dropTargetProps(folder.id)}
            >
                {isRenaming ? (
                    <div
                        style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            padding: '4px 8px',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <Folder style={{ width: 13, height: 13, color: 'var(--ink-3)' }} strokeWidth={1.75} />
                        <input
                            type="text"
                            value={editingFolderName}
                            onChange={(e) => setEditingFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveFolderRename(folder.id);
                                if (e.key === 'Escape') handleCancelFolderRename();
                            }}
                            onBlur={(e) => {
                                // If blur is going to Save/Cancel buttons in
                                // the same row, let those handle it.
                                const next = e.relatedTarget;
                                if (next && e.currentTarget.parentElement?.contains(next)) return;
                                // Commit whatever the user typed (or leave the
                                // default name if they typed nothing). Either
                                // way, exit rename mode — never silently delete.
                                if ((editingFolderName || '').trim()
                                    && editingFolderName.trim() !== folder.name) {
                                    handleSaveFolderRename(folder.id);
                                } else {
                                    handleCancelFolderRename();
                                }
                            }}
                            style={{
                                flex: 1, padding: '3px 6px',
                                fontSize: 12, color: 'var(--ink)',
                                background: 'var(--surface)',
                                border: '1px solid var(--accent)',
                                borderRadius: 4,
                                outline: 0,
                            }}
                            autoFocus
                        />
                        <button
                            onClick={() => handleSaveFolderRename(folder.id)}
                            style={{ ...iconBtn, width: 20, height: 20, color: 'var(--ok)' }}
                            title="Save"
                        >
                            <Check style={{ width: 11, height: 11 }} strokeWidth={2} />
                        </button>
                        <button
                            onClick={handleCancelFolderRename}
                            style={{ ...iconBtn, width: 20, height: 20 }}
                            title="Cancel"
                        >
                            <X style={{ width: 11, height: 11 }} strokeWidth={2} />
                        </button>
                    </div>
                ) : (
                    <div
                        className="sidebar-folder-row"
                        style={{ position: 'relative' }}
                    >
                        <button
                            onClick={() => toggleGroup(key)}
                            style={folderHeader}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-3, var(--bg))'}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            <span style={{
                                display: 'inline-flex',
                                transform: open ? 'rotate(0)' : 'rotate(-90deg)',
                                transition: 'transform .15s',
                                color: 'var(--ink-4)',
                            }}>
                                <ChevronDown style={{ width: 11, height: 11 }} strokeWidth={2} />
                            </span>
                            <Icon style={{ width: 13, height: 13, color: 'var(--ink-3)' }} strokeWidth={1.75} />
                            <span style={{
                                fontWeight: 500,
                                flex: 1, minWidth: 0,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                textAlign: 'left',
                            }}>{folder.name}</span>
                            <span style={{ ...count, paddingRight: 46 }}>{items.length}</span>
                        </button>
                        {/* Direct Rename + Delete — always visible so users
                            can delete a folder regardless of its contents. */}
                        <div
                            className="folder-menu-trigger"
                            style={{
                                position: 'absolute',
                                right: 4, top: '50%', transform: 'translateY(-50%)',
                                display: 'flex', alignItems: 'center', gap: 1,
                                background: 'var(--bg-2)',
                                borderRadius: 5,
                                padding: 1,
                            }}
                        >
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleStartFolderRename(folder);
                                }}
                                style={{ ...iconBtn, width: 20, height: 20 }}
                                title="Rename folder"
                            >
                                <Edit3 style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteFolder(folder);
                                }}
                                style={{ ...iconBtn, width: 20, height: 20, color: 'var(--ink-3)' }}
                                title="Delete folder"
                                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--danger)'}
                                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-3)'}
                            >
                                <Trash2 style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                            </button>
                        </div>
                    </div>
                )}
                {open && !isRenaming && (
                    items.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                            {items.map(renderChatRow)}
                        </div>
                    ) : (
                        <div style={{
                            padding: '4px 8px 6px 26px',
                            fontSize: 11,
                            color: 'var(--ink-4)',
                            fontStyle: 'italic',
                        }}>
                            Empty — move chats here
                        </div>
                    )
                )}
            </div>
        );
    };

    const sidebarContent = (
        <>
            {/* Workspace header */}
            <div style={workspaceHeader}>
                <div style={workspaceRow}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
                            Model Chat
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 1 }}>
                            {totalChats} conversation{totalChats === 1 ? '' : 's'}
                        </div>
                    </div>
                </div>
                <button
                    onClick={() => {
                        if (isMobileOpen && onMobileClose) onMobileClose();
                        else if (onToggleCollapsed) onToggleCollapsed();
                    }}
                    style={iconBtn}
                    title="Collapse sidebar"
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-3, var(--bg))'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                    <PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={1.75} />
                </button>
            </div>

            {/* Search */}
            <div style={searchRow}>
                <div style={searchWrap}>
                    <Search style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                    <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search chats…"
                        style={searchInput}
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            style={{ ...iconBtn, width: 16, height: 16 }}
                            title="Clear"
                        >
                            <X style={{ width: 11, height: 11 }} strokeWidth={2} />
                        </button>
                    )}
                </div>
            </div>

            {/* New chat */}
            <div style={newChatRow}>
                <button
                    onClick={handleNewConversation}
                    style={newChatBtn}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--accent-soft)';
                        e.currentTarget.style.borderColor = 'var(--accent)';
                        e.currentTarget.style.color = 'var(--accent)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.borderColor = 'var(--rule-2)';
                        e.currentTarget.style.color = 'var(--ink-2)';
                    }}
                >
                    <Plus style={{ width: 14, height: 14 }} strokeWidth={2} />
                    <span>New chat</span>
                </button>
            </div>

            {/* New folder — one-click: creates + opens rename inline.
                "Clear unnamed" only appears when auto-named "New folder" rows
                have accumulated, so users can purge them without trashing
                each one individually. */}
            <div style={{ ...newFolderRow, display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                    onClick={handleCreateFolder}
                    style={{ ...newFolderBtn, flex: 1 }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--bg-3, var(--bg))';
                        e.currentTarget.style.color = 'var(--ink-2)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--ink-3)';
                    }}
                >
                    <FolderPlus style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                    <span>New folder</span>
                </button>
                {orphanCount > 1 && (
                    <button
                        onClick={handleClearOrphanFolders}
                        style={{
                            ...newFolderBtn,
                            width: 'auto',
                            padding: '5px 8px',
                            color: 'var(--danger)',
                            fontSize: 10.5,
                            flex: 'initial',
                        }}
                        title={`Delete ${orphanCount} unnamed folders`}
                    >
                        <Trash2 style={{ width: 11, height: 11 }} strokeWidth={1.75} />
                        <span>Clear {orphanCount}</span>
                    </button>
                )}
            </div>

            {/* Conversation list. Folders always render (even with zero chats)
                so the user can organize before they start chatting. */}
            <div style={scroll} className="sidebar-scroll">
                {/* Favorites — top */}
                {renderSimpleGroup('Favorites', 'Favorites', favorites, { icon: Star, accent: true })}

                {/* User folders */}
                {sortedFolders.map(renderUserFolder)}

                {/* Empty-state hint: only when nothing exists at all */}
                {(!conversations || conversations.length === 0) && sortedFolders.length === 0 && (
                    <div style={{
                        padding: '40px 16px', textAlign: 'center',
                        color: 'var(--ink-3)',
                    }}>
                        <MessageSquare
                            style={{ width: 24, height: 24, color: 'var(--ink-4)', margin: '0 auto 8px' }}
                            strokeWidth={1.5}
                        />
                        <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>No conversations</div>
                        <div style={{ fontSize: 11, marginTop: 2 }}>Start a new chat</div>
                    </div>
                )}

                {/* Unassigned chats — flat list with plain date labels. Drop
                    target for "unassign from folder". */}
                {unassignedTotal > 0 && (
                    <div
                        key="unassigned"
                        style={{
                            marginTop: 4,
                            borderRadius: 6,
                            outline: dragOverTarget === 'unassigned'
                                ? '1.5px dashed var(--accent)'
                                : '1.5px dashed transparent',
                            outlineOffset: -1,
                            background: dragOverTarget === 'unassigned'
                                ? 'var(--accent-soft)'
                                : 'transparent',
                            transition: 'background .1s, outline-color .1s',
                        }}
                        {...dropTargetProps('unassigned')}
                    >
                        {dateGroupOrder.map(name => {
                            const items = unassignedDateGroups[name] || [];
                            if (!items.length) return null;
                            return (
                                <div key={`unassigned:${name}`} style={{ marginBottom: 2 }}>
                                    <div style={{
                                        padding: '8px 10px 3px',
                                        fontSize: 10,
                                        fontWeight: 600,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        color: 'var(--ink-4)',
                                    }}>
                                        {name}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                        {items.map(renderChatRow)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* User footer */}
            <div style={footer}>
                <div style={avatar}>{userInitial}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontSize: 12, fontWeight: 500, color: 'var(--ink)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {displayName}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                        {totalChats} chat{totalChats === 1 ? '' : 's'}
                    </div>
                </div>
            </div>

            <style>{`
                .sidebar-chat-row:hover .chat-row-actions { opacity: 1 !important; }
                .sidebar-scroll::-webkit-scrollbar { width: 6px; }
                .sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
                .sidebar-scroll::-webkit-scrollbar-thumb {
                    background: var(--rule-2);
                    border-radius: 3px;
                }
                .sidebar-scroll::-webkit-scrollbar-thumb:hover {
                    background: var(--rule);
                }
            `}</style>
        </>
    );

    return (
        <>
            {/* Mobile overlay */}
            {isMobileOpen && (
                <div
                    className="fixed inset-0 z-40 md:hidden"
                    style={{ background: 'color-mix(in oklab, var(--ink) 60%, transparent)', backdropFilter: 'blur(4px)' }}
                    onClick={onMobileClose}
                />
            )}

            {/* Desktop sidebar — width animates for smooth collapse */}
            <aside
                className="hidden md:flex"
                style={{
                    ...aside,
                    width: collapsedDesktop ? 0 : 268,
                    borderRight: collapsedDesktop
                        ? '1px solid transparent'
                        : '1px solid var(--rule)',
                }}
                aria-hidden={collapsedDesktop}
            >
                <div style={asideInner}>
                    {sidebarContent}
                </div>
            </aside>

            {/* Mobile drawer */}
            <aside
                className="md:hidden"
                style={{
                    ...aside,
                    width: 268,
                    position: 'fixed', inset: '0 auto 0 0',
                    zIndex: 50,
                    borderRight: '1px solid var(--rule)',
                    transform: isMobileOpen ? 'translateX(0)' : 'translateX(-100%)',
                    transition: 'transform 0.3s ease-out',
                }}
            >
                <div style={asideInner}>
                    {sidebarContent}
                </div>
            </aside>
        </>
    );
}
