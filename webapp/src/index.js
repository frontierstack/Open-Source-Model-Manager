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

// Theme + accent are applied pre-mount by the inline script in
// public/index.template.html (reads localStorage `app-storage`).
// usePreferencesStore.hydrate() refreshes from the server after mount.

ReactDOM.render(
    <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <AuthGuard>
            <App />
        </AuthGuard>
    </ThemeProvider>,
    document.getElementById('root')
);