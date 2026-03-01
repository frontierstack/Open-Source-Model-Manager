import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Authentication Store
 * Manages user authentication state and session information
 */
export const useAuthStore = create(
    devtools((set, get) => ({
        // State
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,

        // Actions
        setUser: (user) => set({
            user,
            isAuthenticated: !!user,
            error: null
        }),

        setLoading: (isLoading) => set({ isLoading }),

        setError: (error) => set({ error }),

        clearError: () => set({ error: null }),

        logout: () => set({
            user: null,
            isAuthenticated: false,
            error: null
        }),

        // Check if user has a specific role
        hasRole: (role) => {
            const { user } = get();
            return user?.role === role || user?.role === 'admin';
        },

        // Get user ID
        getUserId: () => {
            const { user } = get();
            return user?.id || null;
        }
    }), { name: 'auth-store' })
);
