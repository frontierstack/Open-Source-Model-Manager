import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

// Toast Context
const ToastContext = createContext(null);

// Toast types configuration
const toastConfig = {
    success: {
        icon: CheckCircle,
        bgClass: 'bg-emerald-500/10',
        borderClass: 'border-emerald-500/30',
        iconClass: 'text-emerald-400',
        progressClass: 'bg-emerald-500',
    },
    error: {
        icon: XCircle,
        bgClass: 'bg-red-500/10',
        borderClass: 'border-red-500/30',
        iconClass: 'text-red-400',
        progressClass: 'bg-red-500',
    },
    warning: {
        icon: AlertTriangle,
        bgClass: 'bg-amber-500/10',
        borderClass: 'border-amber-500/30',
        iconClass: 'text-amber-400',
        progressClass: 'bg-amber-500',
    },
    info: {
        icon: Info,
        bgClass: 'bg-blue-500/10',
        borderClass: 'border-blue-500/30',
        iconClass: 'text-blue-400',
        progressClass: 'bg-blue-500',
    },
};

// Individual Toast component
function ToastItem({ toast, onDismiss }) {
    const [isExiting, setIsExiting] = useState(false);
    const [progress, setProgress] = useState(100);
    const config = toastConfig[toast.severity] || toastConfig.info;
    const Icon = config.icon;
    const duration = toast.duration || 3000;

    useEffect(() => {
        // Progress bar animation
        const startTime = Date.now();
        const animateProgress = () => {
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
            setProgress(remaining);

            if (remaining > 0) {
                requestAnimationFrame(animateProgress);
            }
        };
        const animationFrame = requestAnimationFrame(animateProgress);

        // Auto-dismiss timer
        const timer = setTimeout(() => {
            handleDismiss();
        }, duration);

        return () => {
            clearTimeout(timer);
            cancelAnimationFrame(animationFrame);
        };
    }, [duration]);

    const handleDismiss = () => {
        setIsExiting(true);
        setTimeout(() => {
            onDismiss(toast.id);
        }, 200); // Match animation duration
    };

    return (
        <div
            className={`
                relative overflow-hidden
                flex items-start gap-3
                min-w-[320px] max-w-[420px]
                p-4 pr-10
                rounded-xl
                border
                backdrop-blur-xl
                shadow-lg shadow-black/20
                ${config.bgClass}
                ${config.borderClass}
                ${isExiting ? 'animate-toast-exit' : 'animate-toast-enter'}
            `}
            role="alert"
            aria-live="polite"
        >
            {/* Icon */}
            <div className={`flex-shrink-0 mt-0.5 ${config.iconClass}`}>
                <Icon className="w-5 h-5" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)] leading-relaxed">
                    {toast.message}
                </p>
            </div>

            {/* Close button */}
            <button
                onClick={handleDismiss}
                className="absolute top-3 right-3 p-1 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-white/10 transition-colors"
                aria-label="Dismiss notification"
            >
                <X className="w-4 h-4" />
            </button>

            {/* Progress bar */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/10">
                <div
                    className={`h-full transition-none ${config.progressClass}`}
                    style={{ width: `${progress}%`, opacity: 0.6 }}
                />
            </div>
        </div>
    );
}

// Toast Container
function ToastContainer({ toasts, onDismiss }) {
    if (toasts.length === 0) return null;

    return (
        <div
            className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
            aria-live="polite"
            aria-label="Notifications"
        >
            {toasts.map((toast) => (
                <div key={toast.id} className="pointer-events-auto">
                    <ToastItem toast={toast} onDismiss={onDismiss} />
                </div>
            ))}
        </div>
    );
}

// Toast Provider
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((message, severity = 'info', duration = 3000) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newToast = { id, message, severity, duration };

        setToasts((prev) => [...prev, newToast]);

        return id;
    }, []);

    const dismissToast = useCallback((id) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const dismissAll = useCallback(() => {
        setToasts([]);
    }, []);

    // Convenience methods - memoized object with stable references
    const toast = React.useMemo(() => ({
        show: (message, severity, duration) => addToast(message, severity, duration),
        success: (message, duration) => addToast(message, 'success', duration),
        error: (message, duration) => addToast(message, 'error', duration),
        warning: (message, duration) => addToast(message, 'warning', duration),
        info: (message, duration) => addToast(message, 'info', duration),
        dismiss: dismissToast,
        dismissAll,
    }), [addToast, dismissToast, dismissAll]);

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </ToastContext.Provider>
    );
}

// Hook to use toast
export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

// Legacy showSnackbar compatibility wrapper
// Returns a function that matches the old showSnackbar(message, severity) signature
export function useShowSnackbar() {
    const toast = useToast();
    return useCallback((message, severity = 'info') => {
        toast.show(message, severity);
    }, [toast]);
}

export default ToastProvider;
