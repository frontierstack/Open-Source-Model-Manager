import React from 'react';
import { Box, Typography } from '@mui/material';
import AutomationAppsPanel from './AutomationAppsPanel';

// User-visible "Automations" tab: the building-block library. Stacks the three
// self-collapsing category panels (Triggers / Connectors / Logic Gates). Admins
// see every user's blocks (owner chips); regular users see their own + globals.
// Workflows themselves are built visually in the Chat app (sidebar → Automation).
export default function AutomationLibrary({ showSnackbar, isAdmin = false }) {
    return (
        <Box>
            <Typography variant="h6" sx={{ mb: 0.5 }}>Automation Building Blocks</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Reusable Triggers, Connectors, and Logic Gates for your workflows. Build and run
                automations visually in the Chat app (sidebar → Automation).
                {isAdmin ? ' As an admin you see every user’s building blocks (owner shown on each).' : ''}
            </Typography>
            <AutomationAppsPanel category="trigger" showSnackbar={showSnackbar} isAdmin={isAdmin} defaultExpanded />
            <AutomationAppsPanel category="connector" showSnackbar={showSnackbar} isAdmin={isAdmin} />
            <AutomationAppsPanel category="gate" showSnackbar={showSnackbar} isAdmin={isAdmin} />
        </Box>
    );
}
