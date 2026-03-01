import React, { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { useAuthStore } from '../../stores/useAuthStore';
import { checkAuth } from '../../services/auth';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';

/**
 * AuthGuard Component
 * Protects routes by checking authentication status
 * Shows login form if not authenticated
 */
export function AuthGuard({ children }) {
    const { isAuthenticated, user } = useAuthStore();
    const [loading, setLoading] = useState(true);
    const [showRegister, setShowRegister] = useState(false);

    useEffect(() => {
        // Check if user is authenticated on mount
        const verifyAuth = async () => {
            await checkAuth();
            setLoading(false);
        };

        verifyAuth();
    }, []);

    // Show loading spinner while checking auth
    if (loading) {
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
                <CircularProgress size={60} />
                <Typography variant="body1" sx={{ mt: 2 }} color="text.secondary">
                    Loading...
                </Typography>
            </Box>
        );
    }

    // Show login/register form if not authenticated
    if (!isAuthenticated || !user) {
        if (showRegister) {
            return <RegisterForm onLoginClick={() => setShowRegister(false)} />;
        }
        return <LoginForm onRegisterClick={() => setShowRegister(true)} />;
    }

    // User is authenticated, render children
    return <>{children}</>;
}
