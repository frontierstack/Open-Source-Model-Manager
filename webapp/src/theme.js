import { createTheme } from '@mui/material/styles';

// LM Studio inspired dark theme
export const darkTheme = createTheme({
    palette: {
        mode: 'dark',
        background: {
            default: '#09090b',
            paper: '#18181b',
        },
        primary: {
            main: '#a78bfa',
            light: '#c4b5fd',
            dark: '#7c3aed',
        },
        secondary: {
            main: '#22d3ee',
            light: '#67e8f9',
            dark: '#06b6d4',
        },
        success: {
            main: '#22c55e',
            light: '#4ade80',
        },
        warning: {
            main: '#f59e0b',
        },
        error: {
            main: '#ef4444',
        },
        text: {
            primary: '#fafafa',
            secondary: '#a1a1aa',
        },
        divider: 'rgba(255, 255, 255, 0.06)',
    },
    typography: {
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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
            fontSize: '1rem',
            letterSpacing: '-0.01em',
        },
        h6: {
            fontWeight: 600,
            fontSize: '0.875rem',
        },
        body1: {
            fontSize: '0.875rem',
        },
        body2: {
            fontSize: '0.8125rem',
        },
        caption: {
            fontSize: '0.75rem',
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
                    background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                    '&:hover': {
                        background: 'linear-gradient(135deg, #c4b5fd 0%, #a78bfa 100%)',
                        boxShadow: '0 4px 12px rgba(167, 139, 250, 0.3)',
                    },
                },
                outlined: {
                    borderColor: 'rgba(167, 139, 250, 0.3)',
                    color: '#c4b5fd',
                    '&:hover': {
                        borderColor: 'rgba(167, 139, 250, 0.6)',
                        backgroundColor: 'rgba(167, 139, 250, 0.08)',
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
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: 12,
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                        borderColor: 'rgba(167, 139, 250, 0.3)',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
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
                            borderColor: 'rgba(255, 255, 255, 0.08)',
                        },
                        '&:hover fieldset': {
                            borderColor: 'rgba(255, 255, 255, 0.15)',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: '#a78bfa',
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
                    backgroundColor: 'rgba(167, 139, 250, 0.15)',
                    color: '#c4b5fd',
                },
                outlined: {
                    borderColor: 'rgba(255, 255, 255, 0.15)',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
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
    },
});
