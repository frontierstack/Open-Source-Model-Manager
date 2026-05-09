import { createTheme, alpha } from '@mui/material/styles';

// Theme color palettes
const themes = {
    dark: {
        background: { default: '#09090b', paper: '#18181b' },
        primary: { main: '#52525b', light: '#a1a1aa', dark: '#27272a' },
        secondary: { main: '#6366f1', light: '#818cf8', dark: '#4f46e5' },
        success: { main: '#22c55e', light: '#4ade80' },
        warning: { main: '#f59e0b' },
        error: { main: '#ef4444' },
        text: { primary: '#fafafa', secondary: '#a1a1aa' },
        divider: 'rgba(255, 255, 255, 0.06)',
        accent: '#6366f1',
    },
    light: {
        background: { default: '#ffffff', paper: '#ffffff' },
        primary: { main: '#18181b', light: '#52525b', dark: '#09090b' },
        secondary: { main: '#4f46e5', light: '#6366f1', dark: '#4338ca' },
        success: { main: '#16a34a', light: '#22c55e' },
        warning: { main: '#d97706' },
        error: { main: '#dc2626' },
        text: { primary: '#18181b', secondary: '#52525b' },
        divider: 'rgba(0, 0, 0, 0.08)',
        accent: '#4f46e5',
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
    // The following palettes mirror chat:3002's CSS variables so the
    // MUI theme paints the same color family the user sees in Tailwind
    // utilities. Sourced from webapp/src/index.css .theme-* blocks.
    solarized: {
        background: { default: '#fdf6e3', paper: '#eee8d5' },
        primary: { main: '#586e75', light: '#657b83', dark: '#073642' },
        secondary: { main: '#268bd2', light: '#2aa198', dark: '#005f87' },
        success: { main: '#859900', light: '#a3b832' },
        warning: { main: '#cb4b16' },
        error: { main: '#dc322f' },
        text: { primary: '#586e75', secondary: '#93a1a1' },
        divider: 'rgba(101, 123, 131, 0.18)',
        accent: '#268bd2',
    },
    kanagawa: {
        background: { default: '#1f1f28', paper: '#2a2a37' },
        primary: { main: '#7e9cd8', light: '#9eb1d8', dark: '#5d779e' },
        secondary: { main: '#7fb4ca', light: '#9ec9d8', dark: '#5f8aa3' },
        success: { main: '#76946a', light: '#98bb6c' },
        warning: { main: '#dca561' },
        error: { main: '#e82424' },
        text: { primary: '#dcd7ba', secondary: '#a6a39a' },
        divider: 'rgba(126, 156, 216, 0.14)',
        accent: '#7e9cd8',
    },
    palenight: {
        background: { default: '#141624', paper: '#181a29' },
        primary: { main: '#c792ea', light: '#d8acf0', dark: '#a366c0' },
        secondary: { main: '#82aaff', light: '#9bbcff', dark: '#5582d6' },
        success: { main: '#c3e88d', light: '#d4f0a8' },
        warning: { main: '#ffcb6b' },
        error: { main: '#f07178' },
        text: { primary: '#a6accd', secondary: '#959dcb' },
        divider: 'rgba(199, 146, 234, 0.12)',
        accent: '#c792ea',
    },
    research: {
        background: { default: '#fbf6ee', paper: '#ffffff' },
        primary: { main: '#3a3530', light: '#675f56', dark: '#241f1a' },
        secondary: { main: '#7c3aed', light: '#a78bfa', dark: '#5b21b6' },
        success: { main: '#16a34a', light: '#22c55e' },
        warning: { main: '#d97706' },
        error: { main: '#dc2626' },
        text: { primary: '#3a3530', secondary: '#6b6258' },
        divider: 'rgba(58, 53, 48, 0.1)',
        accent: '#7c3aed',
    },
    'research-dark': {
        background: { default: '#1a1818', paper: '#252220' },
        primary: { main: '#a78bfa', light: '#c4b5fd', dark: '#7c3aed' },
        secondary: { main: '#f5deb3', light: '#fde68a', dark: '#d6b870' },
        success: { main: '#34d399', light: '#6ee7b7' },
        warning: { main: '#fbbf24' },
        error: { main: '#f87171' },
        text: { primary: '#e9e4dc', secondary: '#a8a29e' },
        divider: 'rgba(167, 139, 250, 0.14)',
        accent: '#a78bfa',
    },
};

// Accent palettes — when an accent is picked, these override the active
// theme's `secondary` palette (MUI's accent color). Hex values chosen to
// match the oklch values written into --accent-primary on body so the
// MUI side and the Tailwind/CSS-var side render the same hue.
const ACCENT_PALETTES = {
    violet:  { main: '#8b5cf6', light: '#a78bfa', dark: '#7c3aed' },
    amber:   { main: '#f59e0b', light: '#fbbf24', dark: '#d97706' },
    emerald: { main: '#10b981', light: '#34d399', dark: '#059669' },
    slate:   { main: '#64748b', light: '#94a3b8', dark: '#475569' },
    rose:    { main: '#f43f5e', light: '#fb7185', dark: '#e11d48' },
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

// Font size is now numeric (pixels) instead of preset strings

// Create theme function
export const createAppTheme = (themeName = 'dark', fontFamily = 'default', fontSize = 14, accentName = null) => {
    const baseColors = themes[themeName] || themes.dark;
    // When an accent is chosen, override the theme's secondary palette
    // and `accent` shorthand so MUI's chips/buttons/focus rings track
    // the picker. `primary` is left alone (it's the neutral surface
    // accent in most themes), and bg/text/divider stay theme-defined.
    const accentOverride = accentName && ACCENT_PALETTES[accentName];
    const colors = accentOverride
        ? { ...baseColors, secondary: accentOverride, accent: accentOverride.main }
        : baseColors;
    const fonts = fontConfigs[fontFamily] || fontConfigs.default;
    // fontSize is now numeric pixels (10-24), default 14
    const baseFontSize = typeof fontSize === 'number' ? fontSize : 14;
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
            fontSize: baseFontSize,
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
                fontSize: `${(baseFontSize * 1.125) / 16}rem`,
            },
            h6: {
                fontWeight: 600,
                fontSize: `${baseFontSize / 16}rem`,
            },
            body1: {
                fontSize: `${baseFontSize / 16}rem`,
            },
            body2: {
                fontSize: `${(baseFontSize * 0.875) / 16}rem`,
            },
            caption: {
                fontSize: `${(baseFontSize * 0.75) / 16}rem`,
            },
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
                        background: `linear-gradient(135deg, ${colors.secondary.main} 0%, ${colors.secondary.dark} 100%)`,
                        color: '#ffffff',
                        '&:hover': {
                            background: `linear-gradient(135deg, ${colors.secondary.light} 0%, ${colors.secondary.main} 100%)`,
                            boxShadow: `0 4px 12px ${alpha(colors.secondary.main, 0.4)}`,
                        },
                    },
                    outlined: {
                        borderColor: alpha(colors.secondary.main, 0.5),
                        color: colors.secondary.light,
                        '&:hover': {
                            borderColor: colors.secondary.main,
                            backgroundColor: alpha(colors.secondary.main, 0.1),
                        },
                    },
                },
            },
            MuiPaper: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        borderRadius: 8,
                        // Paper bg/border previously inherited from
                        // palette.background.paper; route through the same
                        // theme variables Tailwind components use so
                        // tokens stay in sync across both styling layers.
                        backgroundColor: 'var(--surface-primary)',
                        color: 'var(--text-primary)',
                    },
                    outlined: {
                        borderColor: 'var(--border-primary)',
                    },
                },
            },
            MuiCard: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        backgroundColor: 'var(--surface-primary)',
                        color: 'var(--text-primary)',
                        borderRadius: 12,
                        border: '1px solid var(--border-primary)',
                        boxShadow: `0 4px 16px ${alpha('#000000', isDark ? 0.4 : 0.1)}`,
                        transition: 'all 0.2s ease',
                        '&:hover': {
                            borderColor: 'var(--border-hover)',
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
                            backgroundColor: 'var(--input-bg, var(--bg-tertiary))',
                            color: 'var(--text-primary)',
                            '& fieldset': {
                                borderColor: 'var(--input-border, var(--border-primary))',
                            },
                            '&:hover fieldset': {
                                borderColor: 'var(--border-hover)',
                            },
                            '&.Mui-focused fieldset': {
                                borderColor: 'var(--border-focus)',
                                borderWidth: 1,
                            },
                        },
                        '& .MuiInputLabel-root': {
                            color: 'var(--text-tertiary)',
                            '&.Mui-focused': { color: 'var(--accent-primary)' },
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
                        backgroundColor: alpha(colors.secondary.main, 0.2),
                        color: colors.secondary.light,
                    },
                    outlined: {
                        borderColor: alpha(colors.secondary.main, 0.3),
                        color: colors.secondary.light,
                        backgroundColor: alpha(colors.secondary.main, 0.05),
                    },
                },
            },
            MuiSelect: {
                styleOverrides: {
                    root: {
                        fontSize: '0.875rem',
                        color: 'var(--text-primary)',
                    },
                    icon: { color: 'var(--text-tertiary)' },
                },
            },
            MuiMenu: {
                styleOverrides: {
                    paper: {
                        backgroundColor: 'var(--surface-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-primary)',
                    },
                },
            },
            MuiMenuItem: {
                styleOverrides: {
                    root: {
                        color: 'var(--text-primary)',
                        '&:hover': { backgroundColor: 'var(--bg-hover)' },
                        '&.Mui-selected': {
                            backgroundColor: 'var(--accent-muted)',
                            color: 'var(--accent-primary)',
                            '&:hover': { backgroundColor: 'var(--accent-muted)' },
                        },
                    },
                },
            },
            MuiDialog: {
                styleOverrides: {
                    paper: {
                        backgroundColor: 'var(--surface-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-primary)',
                        backgroundImage: 'none',
                    },
                },
            },
            MuiDialogTitle: {
                styleOverrides: {
                    root: {
                        color: 'var(--text-primary)',
                        borderBottom: '1px solid var(--border-primary)',
                    },
                },
            },
            MuiDialogContent: {
                styleOverrides: {
                    root: { color: 'var(--text-primary)' },
                },
            },
            MuiAccordion: {
                styleOverrides: {
                    root: {
                        backgroundColor: 'var(--surface-primary)',
                        color: 'var(--text-primary)',
                        backgroundImage: 'none',
                        border: '1px solid var(--border-primary)',
                        '&:before': { display: 'none' },
                    },
                },
            },
            MuiAccordionSummary: {
                styleOverrides: {
                    root: {
                        color: 'var(--text-primary)',
                        '&:hover': { backgroundColor: 'var(--bg-hover)' },
                    },
                    expandIconWrapper: { color: 'var(--text-tertiary)' },
                },
            },
            MuiTableCell: {
                styleOverrides: {
                    root: {
                        borderBottomColor: 'var(--border-primary)',
                        color: 'var(--text-primary)',
                    },
                    head: {
                        color: 'var(--text-secondary)',
                        backgroundColor: 'var(--bg-tertiary)',
                    },
                },
            },
            MuiDivider: {
                styleOverrides: {
                    root: { borderColor: 'var(--border-primary)' },
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
                        color: colors.text.primary,
                        opacity: 0.7,
                        transition: 'all 0.2s ease',
                        '&:hover': {
                            opacity: 1,
                            color: colors.secondary.light,
                            backgroundColor: alpha(colors.secondary.main, 0.08),
                        },
                        '&.Mui-selected': {
                            opacity: 1,
                            color: colors.secondary.light,
                            fontWeight: 600,
                        },
                    },
                },
            },
            MuiTabs: {
                styleOverrides: {
                    indicator: {
                        height: 3,
                        backgroundColor: colors.secondary.main,
                        borderRadius: '3px 3px 0 0',
                        boxShadow: `0 0 8px ${alpha(colors.secondary.main, 0.5)}`,
                    },
                },
            },
            MuiListItemButton: {
                styleOverrides: {
                    root: {
                        '&.Mui-selected': {
                            backgroundColor: alpha(colors.secondary.main, 0.1),
                            borderLeft: `2px solid ${colors.secondary.main}`,
                        },
                        '&:hover': {
                            backgroundColor: alpha(colors.secondary.main, 0.08),
                        },
                    },
                },
            },
            // Switches need a much clearer on/off visual. The MUI default
            // uses color=primary, and in dark/light themes primary.main is
            // a grey — so checked switches were indistinguishable from
            // unchecked ones. Force color=success globally (green palette)
            // and override the track opacity/contrast so the state reads
            // unambiguously from across the room.
            MuiSwitch: {
                defaultProps: {
                    color: 'success',
                },
                styleOverrides: {
                    root: {
                        width: 44,
                        height: 24,
                        padding: 0,
                        '& .MuiSwitch-switchBase': {
                            padding: 2,
                            '&.Mui-checked': {
                                transform: 'translateX(20px)',
                                '& + .MuiSwitch-track': {
                                    backgroundColor: colors.success.main,
                                    opacity: 1,
                                    border: 'none',
                                },
                                '& .MuiSwitch-thumb': {
                                    backgroundColor: '#ffffff',
                                },
                            },
                        },
                        '& .MuiSwitch-thumb': {
                            width: 20,
                            height: 20,
                            backgroundColor: alpha(colors.text.secondary, 0.9),
                            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                        },
                        '& .MuiSwitch-track': {
                            borderRadius: 12,
                            backgroundColor: alpha(colors.text.secondary, 0.2),
                            opacity: 1,
                            border: `1px solid ${alpha(colors.text.secondary, 0.3)}`,
                            transition: 'background-color 150ms ease, border-color 150ms ease',
                        },
                    },
                    sizeSmall: {
                        width: 36,
                        height: 20,
                        '& .MuiSwitch-switchBase': {
                            padding: 2,
                            '&.Mui-checked': {
                                transform: 'translateX(16px)',
                            },
                        },
                        '& .MuiSwitch-thumb': {
                            width: 16,
                            height: 16,
                        },
                    },
                },
            },
        },
    });
};

// Export theme options for settings UI
export const themeOptions = [
    { value: 'dark', label: 'Dark', description: 'Default dark theme with indigo accents' },
    { value: 'light', label: 'Light', description: 'Clean pure white theme for daytime use' },
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

// Font size is now a numeric input (10-24px) instead of preset options

// Legacy export for backwards compatibility
export const darkTheme = createAppTheme('dark', 'default', 14);
