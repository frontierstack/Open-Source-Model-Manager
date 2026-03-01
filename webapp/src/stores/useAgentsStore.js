import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Agents Store
 * Manages agents, skills, and tasks
 * Uses optimistic updates for real-time UI responsiveness
 */
export const useAgentsStore = create(
    devtools((set, get) => ({
        // State
        agents: [],
        skills: [],
        tasks: [],
        selectedAgent: null,

        // Actions
        setAgents: (agents) => set({ agents }),

        setSkills: (skills) => set({ skills }),

        setTasks: (tasks) => set({ tasks }),

        setSelectedAgent: (agent) => set({ selectedAgent: agent }),

        // Optimistic update: Add agent immediately
        addAgent: (agent) => set((state) => ({
            agents: [...state.agents, agent]
        })),

        // Update agent
        updateAgent: (agentId, updates) => set((state) => ({
            agents: state.agents.map(agent =>
                agent.id === agentId
                    ? { ...agent, ...updates, updatedAt: new Date().toISOString() }
                    : agent
            )
        })),

        // Remove agent
        removeAgent: (agentId) => set((state) => ({
            agents: state.agents.filter(agent => agent.id !== agentId),
            selectedAgent: state.selectedAgent?.id === agentId ? null : state.selectedAgent
        })),

        // Optimistic update: Add skill immediately
        addSkill: (skill) => set((state) => ({
            skills: [...state.skills, skill]
        })),

        // Update skill
        updateSkill: (skillId, updates) => set((state) => ({
            skills: state.skills.map(skill =>
                skill.id === skillId
                    ? { ...skill, ...updates, updatedAt: new Date().toISOString() }
                    : skill
            )
        })),

        // Remove skill
        removeSkill: (skillId) => set((state) => ({
            skills: state.skills.filter(skill => skill.id !== skillId)
        })),

        // Optimistic update: Add task immediately
        addTask: (task) => set((state) => ({
            tasks: [...state.tasks, task]
        })),

        // Update task
        updateTask: (taskId, updates) => set((state) => ({
            tasks: state.tasks.map(task =>
                task.id === taskId
                    ? { ...task, ...updates, updatedAt: new Date().toISOString() }
                    : task
            )
        })),

        // Remove task
        removeTask: (taskId) => set((state) => ({
            tasks: state.tasks.filter(task => task.id !== taskId)
        })),

        // Get agent by ID
        getAgent: (agentId) => {
            const { agents } = get();
            return agents.find(agent => agent.id === agentId);
        },

        // Get skill by ID
        getSkill: (skillId) => {
            const { skills } = get();
            return skills.find(skill => skill.id === skillId);
        },

        // Get tasks by agent ID
        getTasksByAgent: (agentId) => {
            const { tasks } = get();
            return tasks.filter(task => task.agentId === agentId);
        },

        // Get skills for agent
        getSkillsForAgent: (agentId) => {
            const { agents, skills } = get();
            const agent = agents.find(a => a.id === agentId);
            if (!agent || !agent.skillIds) return [];
            return skills.filter(skill => agent.skillIds.includes(skill.id));
        }
    }), { name: 'agents-store' })
);
