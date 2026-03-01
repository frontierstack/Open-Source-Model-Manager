import React, { useState } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Paper,
    Alert,
    CircularProgress,
    Link
} from '@mui/material';
import { login } from '../../services/auth';
import { useAuthStore } from '../../stores/useAuthStore';

export function LoginForm({ onRegisterClick }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!username || !password) {
            setError('Please enter username and password');
            return;
        }

        setLoading(true);

        try {
            const result = await login(username, password);

            if (result.success) {
                // Success - AuthGuard will redirect
                console.log('Login successful');
            } else {
                setError(result.error || 'Login failed');
            }
        } catch (err) {
            setError(err.message || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '100vh',
                backgroundColor: 'background.default'
            }}
        >
            <Paper
                elevation={3}
                sx={{
                    p: 4,
                    width: '100%',
                    maxWidth: 400,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2
                }}
            >
                <Typography variant="h4" component="h1" textAlign="center" gutterBottom>
                    ModelServer
                </Typography>
                <Typography variant="body2" color="text.secondary" textAlign="center" gutterBottom>
                    Sign in to continue
                </Typography>

                {error && (
                    <Alert severity="error" onClose={() => setError('')}>
                        {error}
                    </Alert>
                )}

                <form onSubmit={handleSubmit}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <TextField
                            label="Username"
                            variant="outlined"
                            fullWidth
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            autoFocus
                            disabled={loading}
                        />

                        <TextField
                            label="Password"
                            type="password"
                            variant="outlined"
                            fullWidth
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={loading}
                        />

                        <Button
                            type="submit"
                            variant="contained"
                            fullWidth
                            size="large"
                            disabled={loading}
                            sx={{ mt: 1 }}
                        >
                            {loading ? <CircularProgress size={24} /> : 'Sign In'}
                        </Button>
                    </Box>
                </form>

                {onRegisterClick && (
                    <Box sx={{ textAlign: 'center', mt: 2 }}>
                        <Typography variant="body2" color="text.secondary">
                            Don't have an account?{' '}
                            <Link
                                component="button"
                                variant="body2"
                                onClick={onRegisterClick}
                                sx={{ cursor: 'pointer' }}
                            >
                                Register
                            </Link>
                        </Typography>
                    </Box>
                )}
            </Paper>
        </Box>
    );
}
