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
        danger:  { icon: Trash2,        iconClass: 'is-danger',  btnClass: 'ui-btn-danger' },
        warning: { icon: AlertTriangle, iconClass: 'is-warning', btnClass: 'ui-btn-warning' },
        info:    { icon: AlertTriangle, iconClass: 'is-info',    btnClass: 'ui-btn-primary' },
    };

    const styles = variantConfig[variant] || variantConfig.danger;
    const Icon = styles.icon;

    return (
        <>
            {/* Backdrop */}
            <div
                className="dlg-backdrop z-[9998] animate-in"
                onClick={onCancel}
            />

            {/* Dialog */}
            <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-dlg-title"
                    className="dlg confirm-dlg animate-scale-in"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="confirm-body">
                        <div className={`confirm-icon ${styles.iconClass}`}>
                            <Icon strokeWidth={1.75} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 id="confirm-dlg-title">{title}</h3>
                            <p>{message}</p>
                        </div>
                        <button
                            onClick={onCancel}
                            className="ui-icon-btn ui-icon-btn-lg"
                            style={{ margin: '-6px -4px 0 0' }}
                            aria-label="Close"
                        >
                            <X strokeWidth={2} />
                        </button>
                    </div>

                    {/* Actions */}
                    <div className="dlg-footer">
                        <button
                            onClick={onCancel}
                            className="ui-btn ui-btn-secondary"
                        >
                            {cancelText}
                        </button>
                        <button
                            onClick={onConfirm}
                            className={`ui-btn ${styles.btnClass}`}
                            autoFocus
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
