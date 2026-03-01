import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useAgentsStore } from '../../stores/useAgentsStore';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Fetch all agents
 */
export function useAgents() {
    const setAgents = useAgentsStore(state => state.setAgents);

    return useQuery({
        queryKey: ['agents'],
        queryFn: async () => {
            const agents = await api.agents.list();
            setAgents(agents);
            return agents;
        },
        staleTime: 30000,
        refetchOnWindowFocus: false
    });
}

/**
 * Get specific agent
 */
export function useAgent(agentId) {
    return useQuery({
        queryKey: ['agents', agentId],
        queryFn: () => api.agents.get(agentId),
        enabled: !!agentId,
        staleTime: 30000
    });
}

/**
 * Create agent
 */
export function useCreateAgent() {
    const queryClient = useQueryClient();
    const addAgent = useAgentsStore(state => state.addAgent);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (agentData) => api.agents.create(agentData),
        onMutate: async (agentData) => {
            // Optimistic update
            const tempId = `temp-${Date.now()}`;
            addAgent({
                id: tempId,
                ...agentData,
                createdAt: new Date().toISOString()
            });
            return { tempId };
        },
        onSuccess: (data, variables, context) => {
            showSnackbar('Agent created successfully', 'success');
            // Remove temp agent and add real one
            if (context?.tempId) {
                useAgentsStore.getState().removeAgent(context.tempId);
            }
            addAgent(data);
        },
        onError: (error, variables, context) => {
            showSnackbar(`Failed to create agent: ${error.message}`, 'error');
            if (context?.tempId) {
                useAgentsStore.getState().removeAgent(context.tempId);
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        }
    });
}

/**
 * Update agent
 */
export function useUpdateAgent() {
    const queryClient = useQueryClient();
    const updateAgent = useAgentsStore(state => state.updateAgent);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: ({ id, data }) => api.agents.update(id, data),
        onMutate: async ({ id, data }) => {
            // Optimistic update
            updateAgent(id, data);
        },
        onSuccess: () => {
            showSnackbar('Agent updated successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to update agent: ${error.message}`, 'error');
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        }
    });
}

/**
 * Delete agent
 */
export function useDeleteAgent() {
    const queryClient = useQueryClient();
    const removeAgent = useAgentsStore(state => state.removeAgent);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (agentId) => api.agents.delete(agentId),
        onMutate: async (agentId) => {
            // Optimistic update
            removeAgent(agentId);
        },
        onSuccess: () => {
            showSnackbar('Agent deleted successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to delete agent: ${error.message}`, 'error');
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
        }
    });
}

/**
 * Fetch all skills
 */
export function useSkills() {
    const setSkills = useAgentsStore(state => state.setSkills);

    return useQuery({
        queryKey: ['skills'],
        queryFn: async () => {
            const skills = await api.skills.list();
            setSkills(skills);
            return skills;
        },
        staleTime: 30000,
        refetchOnWindowFocus: false
    });
}

/**
 * Create skill
 */
export function useCreateSkill() {
    const queryClient = useQueryClient();
    const addSkill = useAgentsStore(state => state.addSkill);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (skillData) => api.skills.create(skillData),
        onSuccess: (data) => {
            addSkill(data);
            showSnackbar('Skill created successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to create skill: ${error.message}`, 'error');
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['skills'] });
        }
    });
}

/**
 * Delete skill
 */
export function useDeleteSkill() {
    const queryClient = useQueryClient();
    const removeSkill = useAgentsStore(state => state.removeSkill);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (skillId) => api.skills.delete(skillId),
        onMutate: async (skillId) => {
            removeSkill(skillId);
        },
        onSuccess: () => {
            showSnackbar('Skill deleted successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to delete skill: ${error.message}`, 'error');
            queryClient.invalidateQueries({ queryKey: ['skills'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['skills'] });
        }
    });
}

/**
 * Fetch all tasks
 */
export function useTasks() {
    const setTasks = useAgentsStore(state => state.setTasks);

    return useQuery({
        queryKey: ['tasks'],
        queryFn: async () => {
            const tasks = await api.tasks.list();
            setTasks(tasks);
            return tasks;
        },
        staleTime: 10000,
        refetchInterval: 30000, // Poll every 30 seconds
        refetchOnWindowFocus: false
    });
}

/**
 * Create task
 */
export function useCreateTask() {
    const queryClient = useQueryClient();
    const addTask = useAgentsStore(state => state.addTask);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: (taskData) => api.tasks.create(taskData),
        onSuccess: (data) => {
            addTask(data);
            showSnackbar('Task created successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to create task: ${error.message}`, 'error');
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
        }
    });
}

/**
 * Update task
 */
export function useUpdateTask() {
    const queryClient = useQueryClient();
    const updateTask = useAgentsStore(state => state.updateTask);
    const showSnackbar = useAppStore(state => state.showSnackbar);

    return useMutation({
        mutationFn: ({ id, data }) => api.tasks.update(id, data),
        onMutate: async ({ id, data }) => {
            updateTask(id, data);
        },
        onSuccess: () => {
            showSnackbar('Task updated successfully', 'success');
        },
        onError: (error) => {
            showSnackbar(`Failed to update task: ${error.message}`, 'error');
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
        }
    });
}
