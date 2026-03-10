import React, { useState, useEffect } from 'react';
import { MessageSquare, Eye, EyeOff, Loader2 } from 'lucide-react';
import ChatContainer from './components/chat/ChatContainer';
import { useChatStore } from './stores/useChatStore';
import { ToastProvider, useShowSnackbar } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';

// Modern Login component with Tailwind
function LoginForm({ onLogin, error, loading }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    const handleSubmit = (e) => {
        e.preventDefault();
        onLogin(username, password);
    };

    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)' }}>
            {/* Animated gradient orbs */}
            <div className="absolute top-[10%] left-[10%] w-[400px] h-[400px] rounded-full blur-[100px] pointer-events-none animate-pulse-subtle" style={{ backgroundColor: 'var(--accent-muted)' }} />
            <div className="absolute bottom-[10%] right-[10%] w-[350px] h-[350px] rounded-full blur-[100px] pointer-events-none animate-pulse-subtle" style={{ backgroundColor: 'var(--accent-muted)', opacity: 0.5 }} />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full blur-[120px] pointer-events-none" style={{ backgroundColor: 'var(--accent-muted)', opacity: 0.3 }} />

            {/* Login card */}
            <div className="w-full max-w-[420px] mx-4 relative z-10 animate-in">
                {/* Logo/Brand section */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-lg" style={{ background: 'linear-gradient(135deg, var(--accent-secondary), var(--accent-primary))', boxShadow: '0 8px 24px var(--shadow-accent)' }}>
                        <MessageSquare className="w-8 h-8 text-white" />
                    </div>
                    <h1 className="text-3xl font-bold text-gradient mb-1">
                        Model Chat
                    </h1>
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-sm">Sign in to continue</p>
                </div>

                {/* Form card */}
                <div className="glass-card p-8">
                    {error && (
                        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm animate-slide-down">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div>
                            <label htmlFor="username" className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                                Username
                            </label>
                            <input
                                id="username"
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="input-field w-full"
                                placeholder="Enter your username"
                                autoComplete="username"
                                disabled={loading}
                                autoFocus
                            />
                        </div>

                        <div>
                            <label htmlFor="password" className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                                Password
                            </label>
                            <div className="relative">
                                <input
                                    id="password"
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="input-field w-full pr-12"
                                    placeholder="Enter your password"
                                    autoComplete="current-password"
                                    disabled={loading}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading || !username || !password}
                            className="btn-primary w-full py-3.5 text-base flex items-center justify-center gap-2"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    Signing in...
                                </>
                            ) : (
                                'Sign In'
                            )}
                        </button>
                    </form>
                </div>

                {/* Footer note */}
                <p className="text-center mt-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Accounts are managed in the Management Console
                </p>
            </div>
        </div>
    );
}

// Inner App component that has access to toast context
function AppContent() {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loginError, setLoginError] = useState('');
    const [loginLoading, setLoginLoading] = useState(false);
    const [models, setModels] = useState([]);
    const [systemPrompts, setSystemPrompts] = useState([]);

    // Get theme and settings from zustand store
    const theme = useChatStore((state) => state.theme);
    const settings = useChatStore((state) => state.settings);
    const setStoreUser = useChatStore((state) => state.setUser);
    const setStoreSystemPrompts = useChatStore((state) => state.setSystemPrompts);

    // Toast notification system
    const showSnackbar = useShowSnackbar();

    // Apply theme and font classes to document body
    useEffect(() => {
        const fontSize = settings?.fontSize || 'medium';
        const fontFamily = settings?.fontFamily || 'system';
        document.body.className = `theme-${theme} font-size-${fontSize} font-family-${fontFamily}`;
    }, [theme, settings?.fontSize, settings?.fontFamily]);

    // Check authentication status on mount
    useEffect(() => {
        checkAuth();
    }, []);

    // Load models and system prompts when authenticated
    useEffect(() => {
        if (user) {
            loadModels();
            loadSystemPrompts();
        }
    }, [user]);

    const checkAuth = async () => {
        try {
            const response = await fetch('/api/auth/me', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setUser(data);
                // Also set user in zustand store
                setStoreUser(data);
            }
        } catch (error) {
            console.error('Auth check failed:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleLogin = async (username, password) => {
        setLoginLoading(true);
        setLoginError('');

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password }),
            });

            if (response.ok) {
                const data = await response.json();
                setUser(data.user);
                // Also set user in zustand store for components that read from store
                setStoreUser(data.user);
            } else {
                const error = await response.json();
                setLoginError(error.error || 'Login failed');
            }
        } catch (error) {
            setLoginError('Network error. Please try again.');
        } finally {
            setLoginLoading(false);
        }
    };

    const handleLogout = async () => {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include',
            });
        } catch (error) {
            console.error('Logout failed:', error);
        }
        setUser(null);
    };

    const loadModels = async () => {
        try {
            const [modelsRes, llamacppRes, vllmRes] = await Promise.all([
                fetch('/api/models', { credentials: 'include' }),
                fetch('/api/llamacpp/instances', { credentials: 'include' }),
                fetch('/api/vllm/instances', { credentials: 'include' }),
            ]);

            if (modelsRes.ok) {
                const modelsData = await modelsRes.json();
                const modelsArray = Array.isArray(modelsData) ? modelsData : [];

                // Get running instances from both backends
                const llamacppInstances = llamacppRes.ok ? await llamacppRes.json() : [];
                const vllmInstances = vllmRes.ok ? await vllmRes.json() : [];

                const llamacppArray = Array.isArray(llamacppInstances)
                    ? llamacppInstances
                    : (llamacppInstances?.instances || []);
                const vllmArray = Array.isArray(vllmInstances)
                    ? vllmInstances
                    : (vllmInstances?.instances || []);

                // Create a map of running instances with their backend
                const runningMap = new Map();
                llamacppArray.forEach(i => runningMap.set(i.name, { ...i, backend: 'llamacpp' }));
                vllmArray.forEach(i => runningMap.set(i.name, { ...i, backend: 'vllm' }));

                const merged = modelsArray.map(m => ({
                    ...m,
                    status: runningMap.has(m.name) ? 'running' : 'stopped',
                    backend: runningMap.get(m.name)?.backend || m.backend || 'llamacpp',
                }));
                setModels(merged);
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            setModels([]);
        }
    };

    const loadSystemPrompts = async () => {
        try {
            const response = await fetch('/api/system-prompts', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                let promptsArray = [];
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    promptsArray = Object.entries(data).map(([name, content]) => ({
                        id: name,
                        name: name,
                        content: content || '',
                    }));
                } else if (Array.isArray(data)) {
                    promptsArray = data;
                }
                setSystemPrompts(promptsArray);
                // Also set in zustand store
                setStoreSystemPrompts(promptsArray);
            }
        } catch (error) {
            console.error('Failed to load system prompts:', error);
            setSystemPrompts([]);
            setStoreSystemPrompts([]);
        }
    };

    // Show loading spinner during initial auth check
    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-dark-950 via-dark-900 to-dark-850">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-10 h-10 text-primary-500 animate-spin" />
                    <p className="text-dark-400 text-sm">Loading...</p>
                </div>
            </div>
        );
    }

    // Show login form if not authenticated
    if (!user) {
        return (
            <LoginForm
                onLogin={handleLogin}
                error={loginError}
                loading={loginLoading}
            />
        );
    }

    // Main chat interface
    return (
        <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)' }}>
            <ChatContainer
                models={models}
                systemPrompts={systemPrompts}
                showSnackbar={showSnackbar}
                user={user}
                onLogout={handleLogout}
                onRefreshModels={loadModels}
            />
        </div>
    );
}

// Main App component wrapped with providers
export default function App() {
    return (
        <ToastProvider>
            <ConfirmProvider>
                <AppContent />
            </ConfirmProvider>
        </ToastProvider>
    );
}
