import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

// Toast Context
const ToastContext = createContext(null);

// Toast types configuration — colours come from the theme tokens via the
// .toast-item.is-* rules (index.css, message-area block).
const toastConfig = {
    success: { icon: CheckCircle,   cls: 'is-success' },
    error:   { icon: XCircle,       cls: 'is-error' },
    warning: { icon: AlertTriangle, cls: 'is-warning' },
    info:    { icon: Info,          cls: 'is-info' },
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
            className={`toast-item ${config.cls} ${isExiting ? 'animate-toast-exit' : 'animate-toast-enter'}`}
            role="alert"
            aria-live="polite"
        >
            {/* Icon */}
            <div className="toast-icon">
                <Icon strokeWidth={2} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <p className="toast-msg">{toast.message}</p>
            </div>

            {/* Close button */}
            <button
                onClick={handleDismiss}
                className="ui-icon-btn toast-close"
                aria-label="Dismiss notification"
            >
                <X strokeWidth={2} />
            </button>

            {/* Progress bar */}
            <div className="toast-bar">
                <div style={{ width: `${progress}%` }} />
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
