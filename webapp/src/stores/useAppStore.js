import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

/**
 * App Store
 * Manages UI state (tabs, snackbar, dialogs, preferences)
 */
export const useAppStore = create(
    devtools(
        persist(
            (set, get) => ({
                // Tab state
                activeTab: 0,
                tabOrder: [0, 1, 2, 3, 4, 5, 6],

                // Snackbar state
                snackbar: {
                    open: false,
                    message: '',
                    severity: 'info'
                },

                // Dialog state
                dialogs: {
                    agentDialog: false,
                    skillDialog: false,
                    apiKeyDialog: false,
                    launchSettingsDialog: false
                },

                // UI preferences with theme support
                preferences: {
                    theme: 'dark',
                    fontFamily: 'default',
                    fontSize: 'medium',
                    docsAccordionOrder: [0, 1, 2, 3, 4, 5]
                },

                // Actions
                setActiveTab: (tab) => set({ activeTab: tab }),

                setTabOrder: (order) => set({ tabOrder: order }),

                showSnackbar: (message, severity = 'info') => set({
                    snackbar: {
                        open: true,
                        message,
                        severity
                    }
                }),

                hideSnackbar: () => set({
                    snackbar: {
                        open: false,
                        message: '',
                        severity: 'info'
                    }
                }),

                openDialog: (dialogName) => set((state) => ({
                    dialogs: {
                        ...state.dialogs,
                        [dialogName]: true
                    }
                })),

                closeDialog: (dialogName) => set((state) => ({
                    dialogs: {
                        ...state.dialogs,
                        [dialogName]: false
                    }
                })),

                closeAllDialogs: () => set({
                    dialogs: {
                        agentDialog: false,
                        skillDialog: false,
                        apiKeyDialog: false,
                        launchSettingsDialog: false
                    }
                }),

                setPreference: (key, value) => set((state) => ({
                    preferences: {
                        ...state.preferences,
                        [key]: value
                    }
                })),

                // Theme actions
                setTheme: (theme) => set((state) => ({
                    preferences: {
                        ...state.preferences,
                        theme
                    }
                })),

                setFontFamily: (fontFamily) => set((state) => ({
                    preferences: {
                        ...state.preferences,
                        fontFamily
                    }
                })),

                setFontSize: (fontSize) => set((state) => ({
                    preferences: {
                        ...state.preferences,
                        fontSize
                    }
                }))
            }),
            {
                name: 'app-storage', // localStorage key
                partialize: (state) => ({
                    tabOrder: state.tabOrder,
                    preferences: state.preferences
                })
            }
        ),
        { name: 'app-store' }
    )
);
