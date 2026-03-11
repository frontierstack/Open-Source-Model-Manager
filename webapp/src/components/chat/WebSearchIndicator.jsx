import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import LinkIcon from '@mui/icons-material/Link';
import SearchIcon from '@mui/icons-material/Search';

/**
 * WebSearchIndicator - Shows live web search progress
 */
export default function WebSearchIndicator({ searching, sites, query }) {
    return (
        <Box
            sx={{
                px: 2,
                py: 1.5,
                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                backgroundColor: 'rgba(99, 102, 241, 0.05)',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: sites.length > 0 ? 1 : 0 }}>
                {searching ? (
                    <>
                        <CircularProgress size={14} sx={{ color: 'secondary.main' }} />
                        <Typography variant="caption" color="secondary.main" sx={{ fontWeight: 500 }}>
                            Searching the web...
                        </Typography>
                    </>
                ) : (
                    <>
                        <SearchIcon sx={{ fontSize: 14, color: 'secondary.main' }} />
                        <Typography variant="caption" color="secondary.main" sx={{ fontWeight: 500 }}>
                            Found {sites.length} source{sites.length !== 1 ? 's' : ''}
                        </Typography>
                    </>
                )}
                {query && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        "{query.slice(0, 50)}{query.length > 50 ? '...' : ''}"
                    </Typography>
                )}
            </Box>

            {sites.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {sites.map((site, index) => (
                        <Chip
                            key={index}
                            icon={<LinkIcon sx={{ fontSize: '12px !important' }} />}
                            label={site.title.slice(0, 30) + (site.title.length > 30 ? '...' : '')}
                            size="small"
                            component="a"
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            clickable
                            sx={{
                                height: 22,
                                fontSize: '0.7rem',
                                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                                borderColor: 'rgba(99, 102, 241, 0.2)',
                                color: 'secondary.light',
                                '& .MuiChip-icon': {
                                    color: 'secondary.main',
                                },
                                '&:hover': {
                                    backgroundColor: 'rgba(99, 102, 241, 0.2)',
                                },
                            }}
                        />
                    ))}
                </Box>
            )}
        </Box>
    );
}
