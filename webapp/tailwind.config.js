/** @type {import('tailwindcss').Config} */
// Mirror chat/tailwind.config.js so the same utility classes resolve to
// the same CSS variables in both apps.
module.exports = {
    content: ['./src/**/*.{js,jsx}', './public/index.html'],
    darkMode: 'class',
    important: true, // win against MUI's emotion runtime styles during the
                     // tokens+structure migration. Drop after Phase 5 when
                     // MUI is removed.
    theme: {
        extend: {
            colors: {
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
                accent: {
                    300: 'var(--accent-hover)',
                    400: 'var(--accent-hover)',
                    500: 'var(--accent-primary)',
                    600: 'var(--accent-secondary)',
                },
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
                surface: {
                    primary: 'var(--surface-primary)',
                    secondary: 'var(--surface-secondary)',
                    glass: 'var(--surface-glass)',
                },
            },
            fontFamily: {
                sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
            },
        },
    },
    plugins: [],
};
