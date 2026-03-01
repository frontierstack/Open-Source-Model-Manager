import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useModelsStore } from '../../stores/useModelsStore';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Fetch all models
 */
export function useModels() {
    const setModels = useModelsStore(state => state.setModels);

    return useQuery({
        queryKey: ['models'],
        queryFn: async () => {
            const models = await api.models.list();
            setModels(models);
            return models;
        },
        staleTime: 30000, // 30 seconds
        refetchOnWindowFocus: false
    });
}

/**
 * Search HuggingFace models
 */
export function useSearchModels(query) {
    return useQuery({
        queryKey: ['models', 'search', query],
        queryFn: () => api.models.search(query),
        enabled: !!query && query.length > 2,
        staleTime: 60000 // 1 minute
    });
}

/**
 * Download/pull a model from HuggingFace
 */
export function useDownloadModel() {
    const queryClient = useQueryClient();
    const addDownload = useModelsStore(state => state.addDownload);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: ({ repoId, filename }) => api.models.pull(repoId, filename),
        onMutate: async ({ repoId, filename }) => {
            // Optimistic update: Add download to store
            const downloadId = `${Date.now()}-${repoId}`;
            addDownload({
                downloadId,
                repoId,
                filename,
                progress: 0,
                speed: 0,
                status: 'downloading'
            });

            return { downloadId };
        },
        onSuccess: (data, variables, context) => {
            showSnackbar('Download started successfully', 'success');
        },
        onError: (error, variables, context) => {
            showSnackbar(`Download failed: ${error.message}`, 'error');
            if (context?.downloadId) {
                useModelsStore.getState().removeDownload(context.downloadId);
            }
        },
        onSettled: () => {
            // Invalidate models query to refetch
            queryClient.invalidateQueries({ queryKey: ['models'] });
        }
    });
}

/**
 * Load a model (create vLLM instance)
 */
export function useLoadModel() {
    const queryClient = useQueryClient();
    const addInstance = useModelsStore(state => state.addInstance);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: ({ modelName, config }) => api.models.load(modelName, config),
        onMutate: async ({ modelName, config }) => {
            // Optimistic update: Add instance with loading status
            addInstance({
                modelName,
                status: 'loading',
                port: null,
                config
            });

            showSnackbar(`Loading ${modelName}...`, 'info');
        },
        onSuccess: (data, { modelName }) => {
            showSnackbar(`${modelName} loaded successfully`, 'success');
        },
        onError: (error, { modelName }) => {
            showSnackbar(`Failed to load ${modelName}: ${error.message}`, 'error');
            // Remove failed instance
            useModelsStore.getState().removeInstance(modelName);
        },
        onSettled: () => {
            // Invalidate instances query
            queryClient.invalidateQueries({ queryKey: ['instances'] });
        }
    });
}

/**
 * Delete a model
 */
export function useDeleteModel() {
    const queryClient = useQueryClient();
    const removeModel = useModelsStore(state => state.removeModel);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (modelName) => api.models.delete(modelName),
        onMutate: async (modelName) => {
            // Optimistic update
            removeModel(modelName);
            showSnackbar(`Deleting ${modelName}...`, 'info');
        },
        onSuccess: (data, modelName) => {
            showSnackbar(`${modelName} deleted successfully`, 'success');
        },
        onError: (error, modelName) => {
            showSnackbar(`Failed to delete ${modelName}: ${error.message}`, 'error');
            // Refetch to restore
            queryClient.invalidateQueries({ queryKey: ['models'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['models'] });
        }
    });
}
