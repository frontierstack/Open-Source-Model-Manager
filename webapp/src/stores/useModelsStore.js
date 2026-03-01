import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Models Store
 * Manages models, instances, and downloads
 * Uses optimistic updates for real-time UI responsiveness
 */
export const useModelsStore = create(
    devtools((set, get) => ({
        // State
        models: [],
        instances: [],
        downloads: [],

        // Actions
        setModels: (models) => set({ models }),

        setInstances: (instances) => set({ instances }),

        setDownloads: (downloads) => set({ downloads }),

        // Optimistic update: Add download immediately
        addDownload: (download) => set((state) => ({
            downloads: [...state.downloads, download]
        })),

        // Update download progress in real-time
        updateDownloadProgress: (downloadId, progress, speed) => set((state) => ({
            downloads: state.downloads.map(d =>
                d.downloadId === downloadId
                    ? { ...d, progress, speed, updatedAt: Date.now() }
                    : d
            )
        })),

        // Remove completed or failed download
        removeDownload: (downloadId) => set((state) => ({
            downloads: state.downloads.filter(d => d.downloadId !== downloadId)
        })),

        // Optimistic update: Add instance immediately
        addInstance: (instance) => set((state) => ({
            instances: [...state.instances, instance]
        })),

        // Update instance status
        updateInstance: (modelName, updates) => set((state) => ({
            instances: state.instances.map(inst =>
                inst.modelName === modelName
                    ? { ...inst, ...updates }
                    : inst
            )
        })),

        // Remove instance
        removeInstance: (modelName) => set((state) => ({
            instances: state.instances.filter(inst => inst.modelName !== modelName)
        })),

        // Add model after download completes
        addModel: (model) => set((state) => ({
            models: [...state.models, model]
        })),

        // Remove model
        removeModel: (modelName) => set((state) => ({
            models: state.models.filter(m => m.name !== modelName)
        })),

        // Get download by ID
        getDownload: (downloadId) => {
            const { downloads } = get();
            return downloads.find(d => d.downloadId === downloadId);
        },

        // Get instance by model name
        getInstance: (modelName) => {
            const { instances } = get();
            return instances.find(inst => inst.modelName === modelName);
        },

        // Check if model is running
        isModelRunning: (modelName) => {
            const { instances } = get();
            return instances.some(inst => inst.modelName === modelName && inst.status === 'running');
        }
    }), { name: 'models-store' })
);
