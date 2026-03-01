import React from 'react';
import ReactDOM from 'react-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';
import { AuthGuard } from './components/auth/AuthGuard';
import { darkTheme } from './theme';

ReactDOM.render(
    <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <AuthGuard>
            <App />
        </AuthGuard>
    </ThemeProvider>,
    document.getElementById('root')
);