import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListItemSecondaryAction from '@mui/material/ListItemSecondaryAction';
import Drawer from '@mui/material/Drawer';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import MenuIcon from '@mui/icons-material/Menu';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';

/**
 * ChatSidebar - Conversation history list with mobile support
 */
export default function ChatSidebar({
    conversations,
    activeConversationId,
    onSelectConversation,
    onNewConversation,
    onDeleteConversation,
    onRenameConversation,
    onToggleFavorite,
    collapsed,
}) {
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const [mobileOpen, setMobileOpen] = useState(false);

    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

    const handleStartEdit = (conversation, e) => {
        e.stopPropagation();
        setEditingId(conversation.id);
        setEditTitle(conversation.title);
    };

    const handleSaveEdit = (id, e) => {
        e?.stopPropagation();
        if (editTitle.trim()) {
            onRenameConversation(id, editTitle.trim());
        }
        setEditingId(null);
        setEditTitle('');
    };

    const handleCancelEdit = (e) => {
        e?.stopPropagation();
        setEditingId(null);
        setEditTitle('');
    };

    const handleKeyDown = (e, id) => {
        if (e.key === 'Enter') {
            handleSaveEdit(id, e);
        } else if (e.key === 'Escape') {
            handleCancelEdit(e);
        }
    };

    const handleSelectConversation = (id) => {
        onSelectConversation(id);
        if (isMobile) {
            setMobileOpen(false);
        }
    };

    const formatDate = (dateString) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        return date.toLocaleDateString();
    };

    const sidebarContent = (
        <Box
            sx={{
                width: { xs: 280, sm: 240 },
                minWidth: { xs: 280, sm: 240 },
                borderRight: isMobile ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'background.paper',
                height: '100%',
            }}
        >
            {/* Header */}
            <Box
                sx={{
                    p: 1.5,
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    minHeight: 44,
                }}
            >
                <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                    Conversations
                </Typography>
                <Tooltip title="New conversation">
                    <IconButton
                        size="small"
                        onClick={onNewConversation}
                        sx={{ color: 'primary.light', p: 0.5 }}
                    >
                        <AddIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                </Tooltip>
            </Box>

            {/* Conversation list */}
            <List
                sx={{
                    flexGrow: 1,
                    overflow: 'auto',
                    py: 0,
                    '&::-webkit-scrollbar': {
                        width: '4px',
                    },
                    '&::-webkit-scrollbar-thumb': {
                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '2px',
                    },
                }}
            >
                {conversations.length === 0 ? (
                    <Box sx={{ p: 2, textAlign: 'center' }}>
                        <Typography variant="caption" color="text.secondary">
                            No conversations yet
                        </Typography>
                    </Box>
                ) : (
                    conversations.map((conversation) => (
                        <ListItemButton
                            key={conversation.id}
                            selected={activeConversationId === conversation.id}
                            onClick={() => handleSelectConversation(conversation.id)}
                            sx={{
                                py: 0.75,
                                px: 1.5,
                                minHeight: 40,
                                '&.Mui-selected': {
                                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                                    borderLeft: '2px solid',
                                    borderColor: 'primary.main',
                                },
                                '&:hover': {
                                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                },
                                '&:hover .conversation-actions': {
                                    opacity: 1,
                                },
                            }}
                        >
                            {editingId === conversation.id ? (
                                <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 0.5 }}>
                                    <TextField
                                        value={editTitle}
                                        onChange={(e) => setEditTitle(e.target.value)}
                                        onKeyDown={(e) => handleKeyDown(e, conversation.id)}
                                        onClick={(e) => e.stopPropagation()}
                                        autoFocus
                                        size="small"
                                        fullWidth
                                        variant="standard"
                                        sx={{ fontSize: '0.8rem' }}
                                    />
                                    <IconButton
                                        size="small"
                                        onClick={(e) => handleSaveEdit(conversation.id, e)}
                                        sx={{ color: 'success.main', p: 0.25 }}
                                    >
                                        <CheckIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                    <IconButton
                                        size="small"
                                        onClick={handleCancelEdit}
                                        sx={{ color: 'error.main', p: 0.25 }}
                                    >
                                        <CloseIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                </Box>
                            ) : (
                                <>
                                    {/* Favorite star - always visible when favorited */}
                                    {conversation.favorite && (
                                        <IconButton
                                            size="small"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onToggleFavorite?.(conversation.id);
                                            }}
                                            sx={{
                                                color: 'warning.main',
                                                p: 0.25,
                                                mr: 0.5,
                                                minWidth: 'auto'
                                            }}
                                        >
                                            <StarIcon sx={{ fontSize: 14 }} />
                                        </IconButton>
                                    )}
                                    <ListItemText
                                        primary={conversation.title}
                                        secondary={formatDate(conversation.updatedAt || conversation.createdAt)}
                                        primaryTypographyProps={{
                                            noWrap: true,
                                            sx: { fontSize: '0.8rem' },
                                        }}
                                        secondaryTypographyProps={{
                                            sx: { fontSize: '0.65rem' },
                                        }}
                                    />
                                    <ListItemSecondaryAction
                                        className="conversation-actions"
                                        sx={{
                                            opacity: 0,
                                            transition: 'opacity 0.2s',
                                            display: 'flex',
                                            gap: 0,
                                        }}
                                    >
                                        {/* Favorite toggle - only show unfavorite star in actions when not already favorited */}
                                        <IconButton
                                            size="small"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onToggleFavorite?.(conversation.id);
                                            }}
                                            sx={{
                                                color: conversation.favorite ? 'warning.main' : 'text.secondary',
                                                p: 0.25
                                            }}
                                        >
                                            {conversation.favorite ? (
                                                <StarIcon sx={{ fontSize: 14 }} />
                                            ) : (
                                                <StarBorderIcon sx={{ fontSize: 14 }} />
                                            )}
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => handleStartEdit(conversation, e)}
                                            sx={{ color: 'text.secondary', p: 0.25 }}
                                        >
                                            <EditIcon sx={{ fontSize: 14 }} />
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteConversation(conversation.id);
                                            }}
                                            sx={{ color: 'error.main', p: 0.25 }}
                                        >
                                            <DeleteIcon sx={{ fontSize: 14 }} />
                                        </IconButton>
                                    </ListItemSecondaryAction>
                                </>
                            )}
                        </ListItemButton>
                    ))
                )}
            </List>
        </Box>
    );

    // Mobile: Hamburger menu button and drawer
    if (isMobile) {
        return (
            <>
                <IconButton
                    onClick={() => setMobileOpen(true)}
                    sx={{
                        position: 'fixed',
                        top: 8,
                        left: 8,
                        zIndex: 1100,
                        color: 'text.secondary',
                        backgroundColor: 'background.paper',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        '&:hover': {
                            backgroundColor: 'background.paper',
                        },
                    }}
                >
                    <MenuIcon />
                </IconButton>
                <Drawer
                    anchor="left"
                    open={mobileOpen}
                    onClose={() => setMobileOpen(false)}
                    PaperProps={{
                        sx: {
                            backgroundColor: 'background.paper',
                        },
                    }}
                >
                    {sidebarContent}
                </Drawer>
            </>
        );
    }

    // Collapsed mode
    if (collapsed) {
        return (
            <Box
                sx={{
                    width: 44,
                    borderRight: '1px solid rgba(255, 255, 255, 0.1)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    py: 1,
                }}
            >
                <Tooltip title="New conversation" placement="right">
                    <IconButton
                        onClick={onNewConversation}
                        sx={{ color: 'text.secondary', p: 0.5 }}
                    >
                        <AddIcon sx={{ fontSize: 20 }} />
                    </IconButton>
                </Tooltip>
            </Box>
        );
    }

    // Desktop mode
    return sidebarContent;
}
