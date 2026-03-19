import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useModelsStore } from '../stores/useModelsStore';
import { useAgentsStore } from '../stores/useAgentsStore';
import { useAppStore } from '../stores/useAppStore';
import { wsService } from '../services/websocket';

/**
 * WebSocket Hook
 * Manages WebSocket connection and routes messages to appropriate stores
 * Handles real-time updates for downloads, instances, agents, and more
 */
export function useWebSocket() {
    const queryClient = useQueryClient();
    const wsRef = useRef(null);

    // Get store actions
    const updateDownloadProgress = useModelsStore(state => state.updateDownloadProgress);
    const removeDownload = useModelsStore(state => state.removeDownload);
    const addModel = useModelsStore(state => state.addModel);
    const updateInstance = useModelsStore(state => state.updateInstance);
    const removeInstance = useModelsStore(state => state.removeInstance);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    useEffect(() => {
        // Connect to WebSocket
        wsService.connect();

        // Handle connection events
        const unsubConnected = wsService.on('connected', () => {
            console.log('WebSocket connected to server');
        });

        const unsubDisconnected = wsService.on('disconnected', () => {
            console.log('WebSocket disconnected from server');
        });

        const unsubError = wsService.on('error', (data) => {
            console.error('WebSocket error:', data.error);
        });

        // Handle download progress updates
        const unsubDownloadProgress = wsService.on('download_progress', (data) => {
            const { downloadId, progress, speed } = data;
            updateDownloadProgress(downloadId, progress, speed);
        });

        // Handle download finished
        const unsubDownloadFinished = wsService.on('download_finished', (data) => {
            const { downloadId, modelName, success, error } = data;

            if (success) {
                removeDownload(downloadId);
                showSnackbar(`Download completed: ${modelName}`, 'success');

                // Invalidate models query to refetch
                queryClient.invalidateQueries({ queryKey: ['models'] });

                // Optionally add model to store immediately
                if (data.model) {
                    addModel(data.model);
                }
            } else {
                removeDownload(downloadId);
                showSnackbar(`Download failed: ${error || 'Unknown error'}`, 'error');
            }
        });

        // Handle download started
        const unsubDownloadStarted = wsService.on('download_started', (data) => {
            const { downloadId, repoId, filename } = data;
            console.log('Download started:', { downloadId, repoId, filename });
        });

        // Handle instance status updates
        const unsubStatus = wsService.on('status', (data) => {
            const { modelName, status, port, error } = data;

            if (status === 'running') {
                updateInstance(modelName, { status: 'running', port });
                showSnackbar(`${modelName} is now running`, 'success');
            } else if (status === 'starting') {
                updateInstance(modelName, { status: 'starting' });
                // No snackbar for starting - it's expected
            } else if (status === 'loading') {
                updateInstance(modelName, { status: 'loading' });
                showSnackbar(`${modelName} is still loading...`, 'info');
            } else if (status === 'unhealthy') {
                updateInstance(modelName, { status: 'unhealthy', error });
                showSnackbar(`${modelName} is unhealthy`, 'warning');
            } else if (status === 'stopped') {
                removeInstance(modelName);
                showSnackbar(`${modelName} stopped`, 'info');
            } else if (status === 'error') {
                updateInstance(modelName, { status: 'error', error });
                showSnackbar(`${modelName} error: ${error}`, 'error');
            }

            // Invalidate instances query
            queryClient.invalidateQueries({ queryKey: ['instances'] });
        });

        // Handle log messages (optional - can be used for logs page)
        const unsubLog = wsService.on('log', (data) => {
            // console.log('Log:', data);
            // Can be used to update logs in UI
        });

        // Handle agent updates
        const unsubAgentUpdate = wsService.on('agent_updated', (data) => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        });

        // Handle skill updates
        const unsubSkillUpdate = wsService.on('skill_updated', (data) => {
            queryClient.invalidateQueries({ queryKey: ['skills'] });
        });

        // Handle task updates
        const unsubTaskUpdate = wsService.on('task_updated', (data) => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
        });

        // Cleanup on unmount
        return () => {
            unsubConnected();
            unsubDisconnected();
            unsubError();
            unsubDownloadProgress();
            unsubDownloadFinished();
            unsubDownloadStarted();
            unsubStatus();
            unsubLog();
            unsubAgentUpdate();
            unsubSkillUpdate();
            unsubTaskUpdate();

            // Don't disconnect - let it stay connected for the app lifetime
            // wsService.disconnect();
        };
    }, [queryClient, updateDownloadProgress, removeDownload, addModel, updateInstance, removeInstance, showSnackbar]);

    return {
        isConnected: wsService.isConnected(),
        send: (data) => wsService.send(data)
    };
}
