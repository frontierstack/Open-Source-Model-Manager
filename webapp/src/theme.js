import { createTheme, alpha } from '@mui/material/styles';

// Theme color palettes
const themes = {
    dark: {
        background: { default: '#09090b', paper: '#18181b' },
        primary: { main: '#a78bfa', light: '#c4b5fd', dark: '#7c3aed' },
        secondary: { main: '#22d3ee', light: '#67e8f9', dark: '#06b6d4' },
        success: { main: '#22c55e', light: '#4ade80' },
        warning: { main: '#f59e0b' },
        error: { main: '#ef4444' },
        text: { primary: '#fafafa', secondary: '#a1a1aa' },
        divider: 'rgba(255, 255, 255, 0.06)',
        accent: '#a78bfa',
    },
    light: {
        background: { default: '#fafafa', paper: '#ffffff' },
        primary: { main: '#7c3aed', light: '#a78bfa', dark: '#5b21b6' },
        secondary: { main: '#06b6d4', light: '#22d3ee', dark: '#0891b2' },
        success: { main: '#16a34a', light: '#22c55e' },
        warning: { main: '#d97706' },
        error: { main: '#dc2626' },
        text: { primary: '#18181b', secondary: '#52525b' },
        divider: 'rgba(0, 0, 0, 0.08)',
        accent: '#7c3aed',
    },
    midnight: {
        background: { default: '#0a0a1a', paper: '#12122a' },
        primary: { main: '#6366f1', light: '#818cf8', dark: '#4f46e5' },
        secondary: { main: '#ec4899', light: '#f472b6', dark: '#db2777' },
        success: { main: '#10b981', light: '#34d399' },
        warning: { main: '#f59e0b' },
        error: { main: '#f43f5e' },
        text: { primary: '#e2e8f0', secondary: '#94a3b8' },
        divider: 'rgba(255, 255, 255, 0.06)',
        accent: '#6366f1',
    },
    ocean: {
        background: { default: '#0c1929', paper: '#132f4c' },
        primary: { main: '#0ea5e9', light: '#38bdf8', dark: '#0284c7' },
        secondary: { main: '#14b8a6', light: '#2dd4bf', dark: '#0d9488' },
        success: { main: '#22c55e', light: '#4ade80' },
        warning: { main: '#f59e0b' },
        error: { main: '#ef4444' },
        text: { primary: '#e2e8f0', secondary: '#94a3b8' },
        divider: 'rgba(255, 255, 255, 0.08)',
        accent: '#0ea5e9',
    },
    forest: {
        background: { default: '#0d1f0d', paper: '#1a331a' },
        primary: { main: '#22c55e', light: '#4ade80', dark: '#16a34a' },
        secondary: { main: '#84cc16', light: '#a3e635', dark: '#65a30d' },
        success: { main: '#10b981', light: '#34d399' },
        warning: { main: '#eab308' },
        error: { main: '#ef4444' },
        text: { primary: '#e2e8f0', secondary: '#a3a3a3' },
        divider: 'rgba(255, 255, 255, 0.06)',
        accent: '#22c55e',
    },
    sunset: {
        background: { default: '#1a0f0f', paper: '#2d1a1a' },
        primary: { main: '#f97316', light: '#fb923c', dark: '#ea580c' },
        secondary: { main: '#f43f5e', light: '#fb7185', dark: '#e11d48' },
        success: { main: '#22c55e', light: '#4ade80' },
        warning: { main: '#eab308' },
        error: { main: '#ef4444' },
        text: { primary: '#fef2f2', secondary: '#fca5a5' },
        divider: 'rgba(255, 255, 255, 0.06)',
        accent: '#f97316',
    },
    matrix: {
        background: { default: '#000000', paper: '#0a0a0a' },
        primary: { main: '#00ff00', light: '#33ff33', dark: '#00cc00' },
        secondary: { main: '#00ff00', light: '#33ff33', dark: '#00cc00' },
        success: { main: '#00ff00', light: '#33ff33' },
        warning: { main: '#00ff00' },
        error: { main: '#ff0000' },
        text: { primary: '#00ff00', secondary: '#00aa00' },
        divider: 'rgba(0, 255, 0, 0.15)',
        accent: '#00ff00',
    },
    cyberpunk: {
        background: { default: '#0a0014', paper: '#1a0a2e' },
        primary: { main: '#ff00ff', light: '#ff66ff', dark: '#cc00cc' },
        secondary: { main: '#00ffff', light: '#66ffff', dark: '#00cccc' },
        success: { main: '#00ff66', light: '#66ff99' },
        warning: { main: '#ffff00' },
        error: { main: '#ff0066' },
        text: { primary: '#ffffff', secondary: '#b388ff' },
        divider: 'rgba(255, 0, 255, 0.15)',
        accent: '#ff00ff',
    },
};

// Font configurations
const fontConfigs = {
    default: {
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    mono: {
        fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
    },
    system: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    serif: {
        fontFamily: '"Georgia", "Times New Roman", Times, serif',
    },
};

// Font size configurations
const fontSizes = {
    small: {
        body1: { fontSize: '0.8125rem' },
        body2: { fontSize: '0.75rem' },
        caption: { fontSize: '0.6875rem' },
        h5: { fontSize: '0.9375rem' },
        h6: { fontSize: '0.8125rem' },
    },
    medium: {
        body1: { fontSize: '0.875rem' },
        body2: { fontSize: '0.8125rem' },
        caption: { fontSize: '0.75rem' },
        h5: { fontSize: '1rem' },
        h6: { fontSize: '0.875rem' },
    },
    large: {
        body1: { fontSize: '1rem' },
        body2: { fontSize: '0.9375rem' },
        caption: { fontSize: '0.8125rem' },
        h5: { fontSize: '1.125rem' },
        h6: { fontSize: '1rem' },
    },
};

// Create theme function
export const createAppTheme = (themeName = 'dark', fontFamily = 'default', fontSize = 'medium') => {
    const colors = themes[themeName] || themes.dark;
    const fonts = fontConfigs[fontFamily] || fontConfigs.default;
    const sizes = fontSizes[fontSize] || fontSizes.medium;
    const isDark = themeName !== 'light';

    return createTheme({
        palette: {
            mode: isDark ? 'dark' : 'light',
            background: colors.background,
            primary: colors.primary,
            secondary: colors.secondary,
            success: colors.success,
            warning: colors.warning,
            error: colors.error,
            text: colors.text,
            divider: colors.divider,
        },
        typography: {
            fontFamily: fonts.fontFamily,
            h1: {
                fontWeight: 700,
                fontSize: '2rem',
                letterSpacing: '-0.025em',
            },
            h2: {
                fontWeight: 600,
                fontSize: '1.5rem',
                letterSpacing: '-0.02em',
            },
            h3: {
                fontWeight: 600,
                fontSize: '1.25rem',
                letterSpacing: '-0.015em',
            },
            h5: {
                fontWeight: 600,
                letterSpacing: '-0.01em',
                ...sizes.h5,
            },
            h6: {
                fontWeight: 600,
                ...sizes.h6,
            },
            body1: sizes.body1,
            body2: sizes.body2,
            caption: sizes.caption,
        },
        shape: {
            borderRadius: 8,
        },
        components: {
            MuiButton: {
                styleOverrides: {
                    root: {
                        borderRadius: 8,
                        textTransform: 'none',
                        fontWeight: 500,
                        fontSize: '0.875rem',
                        padding: '8px 16px',
                        boxShadow: 'none',
                        transition: 'all 0.2s ease',
                        '&:hover': {
                            boxShadow: 'none',
                            transform: 'translateY(-1px)',
                        },
                    },
                    contained: {
                        background: `linear-gradient(135deg, ${colors.primary.main} 0%, ${colors.primary.dark} 100%)`,
                        '&:hover': {
                            background: `linear-gradient(135deg, ${colors.primary.light} 0%, ${colors.primary.main} 100%)`,
                            boxShadow: `0 4px 12px ${alpha(colors.primary.main, 0.3)}`,
                        },
                    },
                    outlined: {
                        borderColor: alpha(colors.primary.main, 0.3),
                        color: colors.primary.light,
                        '&:hover': {
                            borderColor: alpha(colors.primary.main, 0.6),
                            backgroundColor: alpha(colors.primary.main, 0.08),
                        },
                    },
                },
            },
            MuiPaper: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        borderRadius: 8,
                    },
                },
            },
            MuiCard: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        backgroundColor: alpha(isDark ? '#ffffff' : '#000000', isDark ? 0.02 : 0.02),
                        borderRadius: 12,
                        border: `1px solid ${alpha(isDark ? '#ffffff' : '#000000', 0.08)}`,
                        boxShadow: `0 4px 16px ${alpha('#000000', isDark ? 0.4 : 0.1)}`,
                        transition: 'all 0.2s ease',
                        '&:hover': {
                            borderColor: alpha(colors.primary.main, 0.3),
                            boxShadow: `0 8px 24px ${alpha('#000000', isDark ? 0.5 : 0.15)}`,
                        },
                    },
                },
            },
            MuiTextField: {
                styleOverrides: {
                    root: {
                        '& .MuiOutlinedInput-root': {
                            borderRadius: 8,
                            fontSize: '0.875rem',
                            '& fieldset': {
                                borderColor: alpha(isDark ? '#ffffff' : '#000000', 0.08),
                            },
                            '&:hover fieldset': {
                                borderColor: alpha(isDark ? '#ffffff' : '#000000', 0.15),
                            },
                            '&.Mui-focused fieldset': {
                                borderColor: colors.primary.main,
                                borderWidth: 1,
                            },
                        },
                    },
                },
            },
            MuiChip: {
                styleOverrides: {
                    root: {
                        borderRadius: 6,
                        fontWeight: 500,
                        fontSize: '0.75rem',
                        height: 26,
                        backdropFilter: 'blur(8px)',
                    },
                    filled: {
                        backgroundColor: alpha(colors.primary.main, 0.15),
                        color: colors.primary.light,
                    },
                    outlined: {
                        borderColor: alpha(isDark ? '#ffffff' : '#000000', 0.15),
                        backgroundColor: alpha(isDark ? '#ffffff' : '#000000', 0.03),
                    },
                },
            },
            MuiSelect: {
                styleOverrides: {
                    root: {
                        fontSize: '0.875rem',
                    },
                },
            },
            MuiInputLabel: {
                styleOverrides: {
                    root: {
                        fontSize: '0.875rem',
                    },
                },
            },
            MuiTab: {
                styleOverrides: {
                    root: {
                        textTransform: 'none',
                        fontWeight: 500,
                        fontSize: '0.8125rem',
                        minHeight: 40,
                        padding: '8px 16px',
                    },
                },
            },
            MuiTabs: {
                styleOverrides: {
                    indicator: {
                        height: 2,
                    },
                },
            },
            MuiListItemButton: {
                styleOverrides: {
                    root: {
                        '&.Mui-selected': {
                            backgroundColor: alpha(colors.primary.main, 0.1),
                            borderLeft: `2px solid ${colors.primary.main}`,
                        },
                    },
                },
            },
        },
    });
};

// Export theme options for settings UI
export const themeOptions = [
    { value: 'dark', label: 'Dark', description: 'Default dark theme with purple accents' },
    { value: 'light', label: 'Light', description: 'Clean light theme for daytime use' },
    { value: 'midnight', label: 'Midnight', description: 'Deep blue with indigo accents' },
    { value: 'ocean', label: 'Ocean', description: 'Calm blues and teals' },
    { value: 'forest', label: 'Forest', description: 'Natural greens' },
    { value: 'sunset', label: 'Sunset', description: 'Warm oranges and reds' },
    { value: 'matrix', label: 'Matrix', description: 'Classic green terminal style' },
    { value: 'cyberpunk', label: 'Cyberpunk', description: 'Neon pink and cyan' },
];

export const fontOptions = [
    { value: 'default', label: 'Inter (Default)', description: 'Modern sans-serif' },
    { value: 'mono', label: 'JetBrains Mono', description: 'Monospace for code' },
    { value: 'system', label: 'System Default', description: 'Your OS default font' },
    { value: 'serif', label: 'Serif', description: 'Traditional serif font' },
];

export const fontSizeOptions = [
    { value: 'small', label: 'Small', description: 'Compact text' },
    { value: 'medium', label: 'Medium (Default)', description: 'Standard size' },
    { value: 'large', label: 'Large', description: 'Larger text for readability' },
];

// Legacy export for backwards compatibility
export const darkTheme = createAppTheme('dark', 'default', 'medium');
