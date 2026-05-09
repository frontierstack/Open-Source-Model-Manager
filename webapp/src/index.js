import React from 'react';
import ReactDOM from 'react-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';
import { AuthGuard } from './components/auth/AuthGuard';
import { darkTheme } from './theme';
// Tailwind directives + chat's theme tokens. The CSS file's @import
// loads Inter / JetBrains Mono / ~50 other Google Fonts at startup;
// fontLoader.js is for additional fonts the user picks at runtime.
import './index.css';

// Default the document to chat's "dark" theme so the new CSS variables
// resolve sanely until the user-prefs store applies whatever's saved.
if (typeof document !== 'undefined' && !document.documentElement.classList.contains('theme-dark')) {
    document.documentElement.classList.add('theme-dark');
}

ReactDOM.render(
    <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <AuthGuard>
            <App />
        </AuthGuard>
    </ThemeProvider>,
    document.getElementById('root')
);