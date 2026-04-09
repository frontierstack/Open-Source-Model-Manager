/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{js,jsx}', './public/index.html'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                // Primary colors using CSS variables for theming
                primary: {
                    50: 'rgba(var(--primary-rgb), 0.05)',
                    100: 'rgba(var(--primary-rgb), 0.1)',
                    200: 'rgba(var(--primary-rgb), 0.2)',
                    300: 'rgba(var(--primary-rgb), 0.4)',
                    400: 'var(--accent-hover)',
                    500: 'var(--accent-primary)',
                    600: 'var(--accent-secondary)',
                    700: 'var(--accent-secondary)',
                    800: 'rgba(var(--primary-rgb), 0.8)',
                    900: 'rgba(var(--primary-rgb), 0.9)',
                },
                // Accent colors
                accent: {
                    300: 'var(--accent-hover)',
                    400: 'var(--accent-hover)',
                    500: 'var(--accent-primary)',
                    600: 'var(--accent-secondary)',
                },
                // Dark background - these stay consistent
                dark: {
                    50: '#fafafa',
                    100: '#f4f4f5',
                    200: '#e4e4e7',
                    300: '#d4d4d8',
                    400: '#a1a1aa',
                    500: '#71717a',
                    600: '#52525b',
                    700: '#3f3f46',
                    800: '#27272a',
                    850: '#1f1f23',
                    900: '#18181b',
                    950: '#09090b',
                },
            },
            fontFamily: {
                sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'fade-in': 'fadeIn 0.3s ease-out',
                'fade-in-up': 'fadeInUp 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
                'slide-up': 'slideUp 0.3s ease-out',
                'slide-down': 'slideDown 0.3s ease-out',
                'thinking': 'thinking 1.4s ease-in-out infinite',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                fadeInUp: {
                    '0%': { transform: 'translateY(6px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                slideUp: {
                    '0%': { transform: 'translateY(10px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                slideDown: {
                    '0%': { transform: 'translateY(-10px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                thinking: {
                    '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: '0.5' },
                    '40%': { transform: 'scale(1)', opacity: '1' },
                },
            },
            boxShadow: {
                'glow-primary': '0 0 20px var(--shadow-accent)',
                'glow-accent': '0 0 20px var(--shadow-accent)',
            },
        },
    },
    plugins: [],
};
