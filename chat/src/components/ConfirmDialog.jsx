import React, { createContext, useContext, useState, useCallback } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

// Confirm Dialog Context
const ConfirmContext = createContext(null);

// Confirmation Dialog Component
function ConfirmDialogModal({ config, onConfirm, onCancel }) {
    if (!config) return null;

    const {
        title = 'Confirm',
        message = 'Are you sure?',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        variant = 'danger', // 'danger' | 'warning' | 'info'
    } = config;

    const variantConfig = {
        danger: {
            icon: Trash2,
            iconBg: 'bg-red-500/20',
            iconColor: 'text-red-400',
            confirmBg: 'bg-red-500 hover:bg-red-600',
            confirmRing: 'focus:ring-red-500/30',
        },
        warning: {
            icon: AlertTriangle,
            iconBg: 'bg-amber-500/20',
            iconColor: 'text-amber-400',
            confirmBg: 'bg-amber-500 hover:bg-amber-600',
            confirmRing: 'focus:ring-amber-500/30',
        },
        info: {
            icon: AlertTriangle,
            iconBg: '',
            iconColor: '',
            confirmBg: '',
            confirmRing: '',
            iconBgStyle: { background: 'color-mix(in oklab, var(--accent) 20%, transparent)' },
            iconColorStyle: { color: 'var(--accent)' },
            confirmStyle: { background: 'var(--accent)', color: 'var(--accent-ink)' },
        },
    };

    const styles = variantConfig[variant] || variantConfig.danger;
    const Icon = styles.icon;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] animate-in"
                onClick={onCancel}
            />

            {/* Dialog */}
            <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                <div
                    className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-2xl shadow-2xl shadow-black/40 overflow-hidden animate-scale-in"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-start gap-4 p-6 pb-4">
                        <div className={`p-3 rounded-xl ${styles.iconBg}`} style={styles.iconBgStyle}>
                            <Icon className={`w-6 h-6 ${styles.iconColor}`} style={styles.iconColorStyle} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                                {title}
                            </h3>
                            <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                                {message}
                            </p>
                        </div>
                        <button
                            onClick={onCancel}
                            className="p-2 -m-2 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-3 px-6 py-4 bg-[var(--bg-primary)]/50 border-t border-[var(--border-secondary)]">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-primary)] rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--border-focus)]"
                        >
                            {cancelText}
                        </button>
                        <button
                            onClick={onConfirm}
                            className={`px-4 py-2.5 text-sm font-medium text-white rounded-xl transition-colors focus:outline-none focus:ring-2 ${styles.confirmBg} ${styles.confirmRing}`}
                            style={styles.confirmStyle}
                        >
                            {confirmText}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

// Confirm Provider
export function ConfirmProvider({ children }) {
    const [config, setConfig] = useState(null);
    const [resolveRef, setResolveRef] = useState(null);

    const confirm = useCallback((options) => {
        return new Promise((resolve) => {
            setConfig(typeof options === 'string' ? { message: options } : options);
            setResolveRef(() => resolve);
        });
    }, []);

    const handleConfirm = useCallback(() => {
        resolveRef?.(true);
        setConfig(null);
        setResolveRef(null);
    }, [resolveRef]);

    const handleCancel = useCallback(() => {
        resolveRef?.(false);
        setConfig(null);
        setResolveRef(null);
    }, [resolveRef]);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <ConfirmDialogModal
                config={config}
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        </ConfirmContext.Provider>
    );
}

// Hook to use confirm dialog
export function useConfirm() {
    const context = useContext(ConfirmContext);
    if (!context) {
        throw new Error('useConfirm must be used within a ConfirmProvider');
    }
    return context;
}

export default ConfirmProvider;
