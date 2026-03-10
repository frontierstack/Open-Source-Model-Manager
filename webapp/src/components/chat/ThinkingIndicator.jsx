import React from 'react';
import Box from '@mui/material/Box';

/**
 * ThinkingIndicator - Animated three-dot loading indicator
 */
export default function ThinkingIndicator({ size = 8, color = '#a78bfa' }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                py: 1,
            }}
        >
            {[0, 1, 2].map((i) => (
                <Box
                    key={i}
                    sx={{
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        backgroundColor: color,
                        animation: 'thinking-pulse 1.4s infinite ease-in-out both',
                        animationDelay: `${i * 0.16}s`,
                        '@keyframes thinking-pulse': {
                            '0%, 80%, 100%': {
                                transform: 'scale(0.6)',
                                opacity: 0.4,
                            },
                            '40%': {
                                transform: 'scale(1)',
                                opacity: 1,
                            },
                        },
                    }}
                />
            ))}
        </Box>
    );
}
