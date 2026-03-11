import React from 'react';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import SearchIcon from '@mui/icons-material/Search';
import TuneIcon from '@mui/icons-material/Tune';
import AddIcon from '@mui/icons-material/Add';
import CircularProgress from '@mui/material/CircularProgress';

/**
 * ChatHeader - Model selector, web search toggle, and settings
 */
export default function ChatHeader({
    models,
    selectedModel,
    onModelChange,
    webSearchEnabled,
    onWebSearchToggle,
    onSettingsClick,
    onNewChat,
    isLoading,
}) {
    const runningModels = models.filter(m => m.status === 'running');
    const hasRunningModels = runningModels.length > 0;

    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                p: 2,
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                backgroundColor: 'background.paper',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {/* New chat button */}
                <Tooltip title="New conversation">
                    <IconButton
                        onClick={onNewChat}
                        sx={{
                            color: 'text.secondary',
                            '&:hover': {
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            },
                        }}
                    >
                        <AddIcon />
                    </IconButton>
                </Tooltip>

                {/* Model selector */}
                <FormControl size="small" sx={{ minWidth: 200 }}>
                    <Select
                        value={selectedModel || ''}
                        onChange={(e) => onModelChange(e.target.value)}
                        displayEmpty
                        disabled={!hasRunningModels || isLoading}
                        sx={{
                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                            '& .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'rgba(255, 255, 255, 0.1)',
                            },
                            '&:hover .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'rgba(255, 255, 255, 0.2)',
                            },
                        }}
                    >
                        {!hasRunningModels ? (
                            <MenuItem value="" disabled>
                                <Typography color="text.secondary">
                                    No running models
                                </Typography>
                            </MenuItem>
                        ) : (
                            runningModels.map((model) => (
                                <MenuItem key={model.name} value={model.name}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography>{model.displayName || model.name}</Typography>
                                        <Chip
                                            label={model.backend}
                                            size="small"
                                            sx={{
                                                height: 18,
                                                fontSize: '0.65rem',
                                                backgroundColor: model.backend === 'vllm'
                                                    ? 'rgba(99, 102, 241, 0.2)'
                                                    : 'rgba(99, 102, 241, 0.2)',
                                            }}
                                        />
                                    </Box>
                                </MenuItem>
                            ))
                        )}
                    </Select>
                </FormControl>

                {isLoading && (
                    <CircularProgress size={20} sx={{ color: 'primary.light' }} />
                )}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {/* Web search toggle */}
                <Tooltip title={webSearchEnabled ? 'Web search enabled' : 'Enable web search'}>
                    <IconButton
                        onClick={onWebSearchToggle}
                        sx={{
                            color: webSearchEnabled ? 'secondary.main' : 'text.secondary',
                            backgroundColor: webSearchEnabled
                                ? 'rgba(99, 102, 241, 0.1)'
                                : 'transparent',
                            '&:hover': {
                                backgroundColor: webSearchEnabled
                                    ? 'rgba(99, 102, 241, 0.2)'
                                    : 'rgba(255, 255, 255, 0.1)',
                            },
                        }}
                    >
                        <SearchIcon />
                    </IconButton>
                </Tooltip>

                {/* Settings button */}
                <Tooltip title="Chat settings">
                    <IconButton
                        onClick={onSettingsClick}
                        sx={{
                            color: 'text.secondary',
                            '&:hover': {
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            },
                        }}
                    >
                        <TuneIcon />
                    </IconButton>
                </Tooltip>
            </Box>
        </Box>
    );
}
