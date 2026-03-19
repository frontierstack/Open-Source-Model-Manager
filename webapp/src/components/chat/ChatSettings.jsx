import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CloseIcon from '@mui/icons-material/Close';
import TuneIcon from '@mui/icons-material/Tune';
import PaletteIcon from '@mui/icons-material/Palette';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { useAppStore } from '../../stores/useAppStore';
import { themeOptions, fontOptions } from '../../theme';

/**
 * ChatSettings - Settings drawer for chat configuration and appearance
 */
export default function ChatSettings({
    open,
    onClose,
    settings,
    onUpdateSettings,
    systemPrompts,
    onSaveSystemPrompt,
    onDeleteSystemPrompt,
    contextSize = 4096,
}) {
    const [activeTab, setActiveTab] = useState(0);
    const [newPromptName, setNewPromptName] = useState('');
    const [newPromptContent, setNewPromptContent] = useState('');
    const [editingPrompt, setEditingPrompt] = useState(null);

    const { preferences, setTheme, setFontFamily, setFontSize } = useAppStore();

    const {
        temperature = 0.7,
        topP = 1.0,
        maxTokens = contextSize,  // Default to model's context window
        systemPromptId = null,
    } = settings;

    const handleSaveNewPrompt = () => {
        if (newPromptName.trim() && newPromptContent.trim()) {
            onSaveSystemPrompt({
                name: newPromptName.trim(),
                content: newPromptContent.trim(),
            });
            setNewPromptName('');
            setNewPromptContent('');
        }
    };

    const handleUpdatePrompt = () => {
        if (editingPrompt && editingPrompt.content.trim()) {
            onSaveSystemPrompt(editingPrompt);
            setEditingPrompt(null);
        }
    };

    return (
        <Drawer
            anchor="right"
            open={open}
            onClose={onClose}
            PaperProps={{
                sx: {
                    width: { xs: '100%', sm: 380 },
                    maxWidth: '100vw',
                    backgroundColor: 'background.paper',
                    borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
                },
            }}
        >
            {/* Header */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    p: 2,
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                }}
            >
                <Typography variant="h6">Settings</Typography>
                <IconButton onClick={onClose} size="small">
                    <CloseIcon />
                </IconButton>
            </Box>

            {/* Tabs */}
            <Tabs
                value={activeTab}
                onChange={(_, v) => setActiveTab(v)}
                sx={{ px: 2, borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}
            >
                <Tab icon={<TuneIcon sx={{ fontSize: 18 }} />} label="Chat" sx={{ minHeight: 48 }} />
                <Tab icon={<PaletteIcon sx={{ fontSize: 18 }} />} label="Appearance" sx={{ minHeight: 48 }} />
            </Tabs>

            {/* Chat Settings Tab */}
            {activeTab === 0 && (
                <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {/* System Prompt Selection */}
                    <Box>
                        <FormControl fullWidth size="small">
                            <InputLabel>Active System Prompt</InputLabel>
                            <Select
                                value={systemPromptId || ''}
                                label="Active System Prompt"
                                onChange={(e) => onUpdateSettings({ systemPromptId: e.target.value || null })}
                            >
                                <MenuItem value="">
                                    <em>None (use default)</em>
                                </MenuItem>
                                {systemPrompts.map((prompt) => (
                                    <MenuItem key={prompt.id} value={prompt.id}>
                                        {prompt.name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                            Choose a system prompt to set the AI's behavior
                        </Typography>
                    </Box>

                    <Divider />

                    {/* Create New System Prompt */}
                    <Box>
                        <Typography variant="body2" sx={{ mb: 1.5, fontWeight: 500 }}>
                            Create System Prompt
                        </Typography>
                        <TextField
                            fullWidth
                            size="small"
                            label="Prompt Name"
                            value={newPromptName}
                            onChange={(e) => setNewPromptName(e.target.value)}
                            sx={{ mb: 1.5 }}
                        />
                        <TextField
                            fullWidth
                            size="small"
                            label="Prompt Content"
                            multiline
                            rows={3}
                            value={newPromptContent}
                            onChange={(e) => setNewPromptContent(e.target.value)}
                            sx={{ mb: 1.5 }}
                        />
                        <Button
                            variant="contained"
                            size="small"
                            startIcon={<SaveIcon />}
                            onClick={handleSaveNewPrompt}
                            disabled={!newPromptName.trim() || !newPromptContent.trim()}
                        >
                            Save Prompt
                        </Button>
                    </Box>

                    {/* Existing System Prompts */}
                    {systemPrompts.length > 0 && (
                        <Box>
                            <Typography variant="body2" sx={{ mb: 1.5, fontWeight: 500 }}>
                                Saved Prompts ({systemPrompts.length})
                            </Typography>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {systemPrompts.map((prompt) => (
                                    <Box
                                        key={prompt.id}
                                        sx={{
                                            p: 1.5,
                                            borderRadius: 1,
                                            border: '1px solid rgba(255, 255, 255, 0.1)',
                                            backgroundColor: 'rgba(255, 255, 255, 0.02)',
                                        }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                                            <Typography variant="body2" fontWeight={500}>
                                                {prompt.name}
                                            </Typography>
                                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                                                {systemPromptId === prompt.id && (
                                                    <Chip label="Active" size="small" color="primary" sx={{ height: 20 }} />
                                                )}
                                                <IconButton
                                                    size="small"
                                                    onClick={() => onDeleteSystemPrompt(prompt.id)}
                                                    sx={{ color: 'error.main' }}
                                                >
                                                    <DeleteIcon sx={{ fontSize: 16 }} />
                                                </IconButton>
                                            </Box>
                                        </Box>
                                        <Typography variant="caption" color="text.secondary" sx={{
                                            display: '-webkit-box',
                                            WebkitLineClamp: 2,
                                            WebkitBoxOrient: 'vertical',
                                            overflow: 'hidden',
                                        }}>
                                            {prompt.content}
                                        </Typography>
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    )}

                    <Divider />

                    {/* Temperature */}
                    <Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                            <Typography variant="body2">Temperature</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {temperature.toFixed(2)}
                            </Typography>
                        </Box>
                        <Slider
                            value={temperature}
                            onChange={(_, value) => onUpdateSettings({ temperature: value })}
                            min={0}
                            max={2}
                            step={0.01}
                            valueLabelDisplay="auto"
                            sx={{
                                '& .MuiSlider-thumb': {
                                    width: 16,
                                    height: 16,
                                },
                            }}
                        />
                        <Typography variant="caption" color="text.secondary">
                            Controls randomness. Lower values (0.1-0.3) are more focused; higher values (0.7-1.5) are more creative.
                        </Typography>
                    </Box>

                    {/* Top P */}
                    <Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                            <Typography variant="body2">Top P</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {topP.toFixed(2)}
                            </Typography>
                        </Box>
                        <Slider
                            value={topP}
                            onChange={(_, value) => onUpdateSettings({ topP: value })}
                            min={0}
                            max={1}
                            step={0.01}
                            valueLabelDisplay="auto"
                            sx={{
                                '& .MuiSlider-thumb': {
                                    width: 16,
                                    height: 16,
                                },
                            }}
                        />
                        <Typography variant="caption" color="text.secondary">
                            Nucleus sampling. Considers tokens comprising the top P probability mass. Lower values reduce randomness.
                        </Typography>
                    </Box>

                    {/* Max Tokens */}
                    <Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                            <Typography variant="body2">Max Tokens</Typography>
                        </Box>
                        <TextField
                            type="number"
                            value={maxTokens}
                            onChange={(e) => onUpdateSettings({ maxTokens: parseInt(e.target.value) || 256 })}
                            size="small"
                            fullWidth
                            inputProps={{ min: 64, max: 32768, step: 64 }}
                        />
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                            Maximum length of the response (64-32768)
                        </Typography>
                    </Box>

                    <Divider />

                    {/* Presets */}
                    <Box>
                        <Typography variant="body2" sx={{ mb: 1.5 }}>Quick Presets</Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {/* Presets use percentages of the model's context window */}
                            <PresetButton
                                label="Precise"
                                onClick={() => onUpdateSettings({ temperature: 0.2, topP: 0.9, maxTokens: Math.floor(contextSize * 0.5) })}
                            />
                            <PresetButton
                                label="Balanced"
                                onClick={() => onUpdateSettings({ temperature: 0.7, topP: 1.0, maxTokens: Math.floor(contextSize * 0.75) })}
                            />
                            <PresetButton
                                label="Creative"
                                onClick={() => onUpdateSettings({ temperature: 1.0, topP: 1.0, maxTokens: contextSize })}
                            />
                            <PresetButton
                                label="Code"
                                onClick={() => onUpdateSettings({ temperature: 0.1, topP: 0.95, maxTokens: contextSize })}
                            />
                        </Box>
                    </Box>
                </Box>
            )}

            {/* Appearance Tab */}
            {activeTab === 1 && (
                <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {/* Theme Selection */}
                    <Box>
                        <Typography variant="body2" sx={{ mb: 1.5, fontWeight: 500 }}>
                            Theme
                        </Typography>
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1 }}>
                            {themeOptions.map((theme) => (
                                <ThemeCard
                                    key={theme.value}
                                    theme={theme}
                                    selected={preferences.theme === theme.value}
                                    onClick={() => setTheme(theme.value)}
                                />
                            ))}
                        </Box>
                    </Box>

                    <Divider />

                    {/* Font Family */}
                    <Box>
                        <Typography variant="body2" sx={{ mb: 1.5, fontWeight: 500 }}>
                            Font Family
                        </Typography>
                        <FormControl fullWidth size="small">
                            <Select
                                value={preferences.fontFamily || 'default'}
                                onChange={(e) => setFontFamily(e.target.value)}
                            >
                                {fontOptions.map((font) => (
                                    <MenuItem key={font.value} value={font.value}>
                                        <Box>
                                            <Typography variant="body2">{font.label}</Typography>
                                            <Typography variant="caption" color="text.secondary">
                                                {font.description}
                                            </Typography>
                                        </Box>
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Box>

                    {/* Font Size */}
                    <Box>
                        <Typography variant="body2" sx={{ mb: 1.5, fontWeight: 500 }}>
                            Font Size
                        </Typography>
                        <TextField
                            type="number"
                            size="small"
                            fullWidth
                            value={preferences.fontSize}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                if (!isNaN(val) && val >= 10 && val <= 24) {
                                    setFontSize(val);
                                }
                            }}
                            inputProps={{ min: 10, max: 24, step: 1 }}
                            helperText="Range: 10-24px (default: 14px)"
                            sx={{
                                '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': {
                                    WebkitAppearance: 'none',
                                    margin: 0,
                                },
                                '& input[type=number]': {
                                    MozAppearance: 'textfield',
                                },
                            }}
                        />
                    </Box>
                </Box>
            )}
        </Drawer>
    );
}

function PresetButton({ label, onClick }) {
    return (
        <Box
            onClick={onClick}
            sx={{
                px: 1.5,
                py: 0.75,
                borderRadius: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                cursor: 'pointer',
                fontSize: '0.8125rem',
                '&:hover': {
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    borderColor: 'primary.main',
                },
                transition: 'all 0.2s',
            }}
        >
            {label}
        </Box>
    );
}

function ThemeCard({ theme, selected, onClick }) {
    const themeColors = {
        dark: { bg: '#18181b', accent: '#6366f1' },
        light: { bg: '#ffffff', accent: '#4f46e5' },
        midnight: { bg: '#12122a', accent: '#6366f1' },
        ocean: { bg: '#132f4c', accent: '#0ea5e9' },
        forest: { bg: '#1a331a', accent: '#22c55e' },
        sunset: { bg: '#2d1a1a', accent: '#f97316' },
        matrix: { bg: '#000000', accent: '#00ff00' },
        cyberpunk: { bg: '#1a0a2e', accent: '#ff00ff' },
    };

    const colors = themeColors[theme.value] || themeColors.dark;

    return (
        <Box
            onClick={onClick}
            sx={{
                p: 1.5,
                borderRadius: 1,
                border: '2px solid',
                borderColor: selected ? 'primary.main' : 'transparent',
                backgroundColor: 'rgba(255, 255, 255, 0.02)',
                cursor: 'pointer',
                transition: 'all 0.2s',
                '&:hover': {
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                },
            }}
        >
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <Box
                    sx={{
                        width: 24,
                        height: 24,
                        borderRadius: '4px',
                        backgroundColor: colors.bg,
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                    }}
                />
                <Box
                    sx={{
                        width: 24,
                        height: 24,
                        borderRadius: '4px',
                        backgroundColor: colors.accent,
                    }}
                />
            </Box>
            <Typography variant="body2" fontWeight={500}>
                {theme.label}
            </Typography>
            <Typography variant="caption" color="text.secondary">
                {theme.description}
            </Typography>
        </Box>
    );
}
