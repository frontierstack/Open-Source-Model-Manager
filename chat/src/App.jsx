import React, { useState, useEffect } from 'react';
import { MessageSquare, Eye, EyeOff, Loader2 } from 'lucide-react';
import ChatContainer from './components/chat/ChatContainer';
import { useChatStore } from './stores/useChatStore';
import { ToastProvider, useShowSnackbar } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { loadGoogleFont } from './fontLoader';

// Password Reset Form
function PasswordResetForm({ onBack, onSuccess }) {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showCurrentPassword, setShowCurrentPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (newPassword !== confirmPassword) {
            setError('New passwords do not match');
            return;
        }

        if (newPassword.length < 8) {
            setError('New password must be at least 8 characters');
            return;
        }

        setLoading(true);
        try {
            const response = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, currentPassword, newPassword }),
            });

            if (response.ok) {
                setSuccess(true);
                setTimeout(() => {
                    onSuccess?.();
                    onBack();
                }, 2000);
            } else {
                const data = await response.json();
                setError(data.error || 'Password reset failed');
            }
        } catch (err) {
            setError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)' }}>
            <div className="absolute top-[10%] left-[10%] w-[400px] h-[400px] rounded-full blur-[100px] pointer-events-none animate-pulse-subtle" style={{ backgroundColor: 'var(--accent-muted)' }} />
            <div className="absolute bottom-[10%] right-[10%] w-[350px] h-[350px] rounded-full blur-[100px] pointer-events-none animate-pulse-subtle" style={{ backgroundColor: 'var(--accent-muted)', opacity: 0.5 }} />

            <div className="w-full max-w-[420px] mx-4 relative z-10 animate-in">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-lg" style={{ background: 'linear-gradient(135deg, var(--accent-secondary), var(--accent-primary))', boxShadow: '0 8px 24px var(--shadow-accent)' }}>
                        <MessageSquare className="w-8 h-8 text-white" />
                    </div>
                    <h1 className="text-3xl font-bold text-gradient mb-1">Reset Password</h1>
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-sm">Enter your credentials to reset</p>
                </div>

                <div className="glass-card p-8">
                    {error && (
                        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm animate-slide-down">
                            {error}
                        </div>
                    )}

                    {success && (
                        <div className="mb-6 p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm animate-slide-down">
                            Password reset successfully! Redirecting...
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="input-field w-full"
                                placeholder="Enter your username"
                                disabled={loading || success}
                                autoFocus
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Email</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="input-field w-full"
                                placeholder="Enter your email"
                                disabled={loading || success}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Current Password</label>
                            <div className="relative">
                                <input
                                    type={showCurrentPassword ? 'text' : 'password'}
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    className="input-field w-full pr-12"
                                    placeholder="Enter current password"
                                    disabled={loading || success}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    {showCurrentPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>New Password</label>
                            <div className="relative">
                                <input
                                    type={showNewPassword ? 'text' : 'password'}
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    className="input-field w-full pr-12"
                                    placeholder="Enter new password (min 8 chars)"
                                    disabled={loading || success}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowNewPassword(!showNewPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    {showNewPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Confirm New Password</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                className="input-field w-full"
                                placeholder="Confirm new password"
                                disabled={loading || success}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading || success || !username || !email || !currentPassword || !newPassword || !confirmPassword}
                            className="btn-primary w-full py-3 text-base flex items-center justify-center gap-2"
                        >
                            {loading ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    Resetting...
                                </>
                            ) : (
                                'Reset Password'
                            )}
                        </button>

                        <button
                            type="button"
                            onClick={onBack}
                            disabled={loading}
                            className="w-full py-2 text-sm transition-colors"
                            style={{ color: 'var(--text-tertiary)' }}
                        >
                            Back to Sign In
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

// Modern Login component with Tailwind
function LoginForm({ onLogin, error, loading, onShowResetPassword }) {
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

                    <div className="mt-4 text-center">
                        <button
                            type="button"
                            onClick={onShowResetPassword}
                            className="text-sm transition-colors hover:underline"
                            style={{ color: 'var(--accent-primary)' }}
                        >
                            Forgot Password?
                        </button>
                    </div>
                </div>

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
    const [showResetPassword, setShowResetPassword] = useState(false);
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

        // Dynamically load Google Font when font family changes
        loadGoogleFont(fontFamily);
    }, [theme, settings?.fontSize, settings?.fontFamily]);

    // Check authentication status on mount.
    //
    // Also sweep any orphan localStorage keys that used to cache
    // server-owned data. Current sweep: `chat-system-prompts` —
    // the store stopped reading it but users who loaded the app
    // with the old bundle still have a stale blob sitting there,
    // which is what made "deleted prompts keep coming back" look
    // like it wasn't fixed. Safe to remove on every boot; server
    // is the source of truth and loadSystemPrompts() repopulates.
    useEffect(() => {
        try { localStorage.removeItem('chat-system-prompts'); } catch (_) {}
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
                // API returns { user: {...} } for session auth
                setUser(data.user);
                // Also set user in zustand store
                setStoreUser(data.user);
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

                const merged = modelsArray.map(m => {
                    const runningInfo = runningMap.get(m.name);
                    // Get context size from running instance config (most accurate)
                    const contextSize = runningInfo?.config?.contextSize || runningInfo?.contextSize || m.contextSize;
                    return {
                        ...m,
                        // Use actual backend status (starting, loading, running, unhealthy) or 'stopped' if not running
                        status: runningInfo ? (runningInfo.status || 'running') : 'stopped',
                        backend: runningInfo?.backend || m.backend || 'llamacpp',
                        // Include contextSize from running instance for accurate context tracking
                        ...(contextSize && { contextSize }),
                    };
                });
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

    // Show password reset form
    if (!user && showResetPassword) {
        return (
            <PasswordResetForm
                onBack={() => setShowResetPassword(false)}
                onSuccess={() => setLoginError('')}
            />
        );
    }

    // Show login form if not authenticated
    if (!user) {
        return (
            <LoginForm
                onLogin={handleLogin}
                error={loginError}
                loading={loginLoading}
                onShowResetPassword={() => setShowResetPassword(true)}
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
