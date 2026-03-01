/**
 * Auth Service
 * Helper functions for authentication
 */

import { api } from './api';
import { useAuthStore } from '../stores/useAuthStore';

/**
 * Login user
 */
export async function login(username, password) {
    try {
        const response = await api.auth.login({ username, password });

        if (response.success && response.user) {
            useAuthStore.getState().setUser(response.user);
            return { success: true, user: response.user };
        }

        return { success: false, error: 'Login failed' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Register new user
 */
export async function register(username, email, password) {
    try {
        const response = await api.auth.register({ username, email, password });

        if (response.success && response.user) {
            useAuthStore.getState().setUser(response.user);
            return { success: true, user: response.user };
        }

        return { success: false, error: 'Registration failed' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Logout user
 */
export async function logout() {
    try {
        await api.auth.logout();
        useAuthStore.getState().logout();
        return { success: true };
    } catch (error) {
        // Even if API call fails, clear local state
        useAuthStore.getState().logout();
        return { success: true };
    }
}

/**
 * Check if user is authenticated by fetching current user
 */
export async function checkAuth() {
    try {
        const response = await api.auth.getCurrentUser();

        if (response.user) {
            useAuthStore.getState().setUser(response.user);
            return { success: true, user: response.user };
        }

        useAuthStore.getState().logout();
        return { success: false, error: 'Not authenticated' };
    } catch (error) {
        useAuthStore.getState().logout();
        return { success: false, error: error.message };
    }
}

/**
 * Change password
 */
export async function changePassword(currentPassword, newPassword) {
    try {
        const response = await api.auth.changePassword({
            currentPassword,
            newPassword
        });

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Get current user from store
 */
export function getCurrentUser() {
    return useAuthStore.getState().user;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated() {
    return useAuthStore.getState().isAuthenticated;
}
