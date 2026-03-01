import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useModelsStore } from '../../stores/useModelsStore';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Fetch all running instances
 */
export function useInstances() {
    const setInstances = useModelsStore(state => state.setInstances);

    return useQuery({
        queryKey: ['instances'],
        queryFn: async () => {
            const instances = await api.instances.list();
            setInstances(instances);
            return instances;
        },
        staleTime: 10000, // 10 seconds
        refetchInterval: 15000, // Poll every 15 seconds
        refetchOnWindowFocus: false
    });
}

/**
 * Get specific instance
 */
export function useInstance(modelName) {
    return useQuery({
        queryKey: ['instances', modelName],
        queryFn: () => api.instances.get(modelName),
        enabled: !!modelName,
        staleTime: 10000
    });
}

/**
 * Stop an instance
 */
export function useStopInstance() {
    const queryClient = useQueryClient();
    const removeInstance = useModelsStore(state => state.removeInstance);
    const updateInstance = useModelsStore(state => state.updateInstance);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (modelName) => api.instances.stop(modelName),
        onMutate: async (modelName) => {
            // Optimistic update: Mark as stopping
            updateInstance(modelName, { status: 'stopping' });
            showSnackbar(`Stopping ${modelName}...`, 'info');
        },
        onSuccess: (data, modelName) => {
            // Remove from store
            removeInstance(modelName);
            showSnackbar(`${modelName} stopped successfully`, 'success');
        },
        onError: (error, modelName) => {
            showSnackbar(`Failed to stop ${modelName}: ${error.message}`, 'error');
            // Refetch to get correct state
            queryClient.invalidateQueries({ queryKey: ['instances'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['instances'] });
        }
    });
}
