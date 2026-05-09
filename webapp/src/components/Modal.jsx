import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import CloseIcon from '@mui/icons-material/Close';

// Tailwind dialog primitive replacing MUI's <Dialog>. Used by the
// per-feature dialog ports (UserDialog, ApiKeyDialog, AgentDialog, …)
// scheduled across the Phase 7 follow-ups.
//
// Behaviors covered here so each dialog port doesn't reimplement them:
//   - Fixed-position overlay rendered through a portal on document.body
//     so the modal escapes z-index/transform-clipped ancestors.
//   - Backdrop blur + dim using --bg-primary at low opacity (theme-aware).
//   - ESC closes (only when topmost — relies on `open` prop gating; no
//     stack tracking needed yet because we never render two at once).
//   - Click-on-backdrop closes; click inside the panel does not.
//   - Body scroll lock while open.
//   - Auto-focus the panel on open so subsequent Tab traps inside it
//     reasonably well without a full focus-trap library.
//   - Mobile: full-screen panel (max-h-screen, rounded-none) so
//     long forms aren't truncated under the keyboard.
//   - Desktop: centered, sized via size prop (sm | md | lg | xl).
//
// Layout slots:
//   <Modal title="..." subtitle="..." size="md" open onClose footer={...}>
//     <ModalBody>...inputs...</ModalBody>
//   </Modal>
//
// Or if the consumer wants total control, omit `title` / `footer` and
// just pass children — the panel will render unstructured.

const SIZE_MAX_WIDTH = {
    sm: '24rem',
    md: '32rem',
    lg: '42rem',
    xl: '56rem',
};

export function ModalBody({ children, className = '' }) {
    return (
        <div
            className={`flex-1 overflow-y-auto px-5 py-4 ${className}`}
            style={{ color: 'var(--text-primary)' }}
        >
            {children}
        </div>
    );
}

export function ModalFooter({ children, className = '' }) {
    return (
        <div
            className={`flex items-center justify-end gap-2 border-t px-5 py-3 ${className}`}
            style={{ borderColor: 'var(--border-primary)' }}
        >
            {children}
        </div>
    );
}

export default function Modal({
    open,
    onClose,
    title,
    subtitle,
    size = 'md',
    footer,
    closable = true,
    children,
}) {
    const panelRef = useRef(null);

    // ESC + body-scroll lock
    useEffect(() => {
        if (!open) return undefined;
        function onKey(e) {
            if (e.key === 'Escape' && closable) {
                e.stopPropagation();
                onClose?.();
            }
        }
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', onKey);
        // Auto-focus on next tick so the portal subtree exists
        setTimeout(() => { panelRef.current?.focus?.(); }, 0);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, onClose, closable]);

    if (!open || typeof document === 'undefined') return null;

    const node = (
        <div
            className="fixed inset-0 z-[1300] flex items-center justify-center px-0 py-0 sm:px-4 sm:py-6"
            style={{
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
                backdropFilter: 'blur(4px)',
            }}
            onMouseDown={(e) => {
                // Close only when the mousedown target is the backdrop itself —
                // prevents drag-selecting text inside the panel from triggering
                // close when the mouse lifts outside the panel bounds.
                if (closable && e.target === e.currentTarget) onClose?.();
            }}
        >
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? 'modal-title' : undefined}
                className="flex max-h-screen w-full flex-col overflow-hidden border shadow-2xl outline-none sm:max-h-[90vh] sm:rounded-xl"
                style={{
                    maxWidth: SIZE_MAX_WIDTH[size] || SIZE_MAX_WIDTH.md,
                    backgroundColor: 'var(--surface-primary)',
                    borderColor: 'var(--border-primary)',
                    color: 'var(--text-primary)',
                }}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {(title || closable) && (
                    <div
                        className="flex items-start justify-between gap-3 border-b px-5 py-3"
                        style={{ borderColor: 'var(--border-primary)' }}
                    >
                        <div className="min-w-0">
                            {title && (
                                <div
                                    id="modal-title"
                                    className="text-base font-semibold"
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    {title}
                                </div>
                            )}
                            {subtitle && (
                                <div className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--text-tertiary)' }}>
                                    {subtitle}
                                </div>
                            )}
                        </div>
                        {closable && (
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close"
                                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition"
                                style={{ color: 'var(--text-tertiary)' }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                                    e.currentTarget.style.color = 'var(--text-primary)';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                    e.currentTarget.style.color = 'var(--text-tertiary)';
                                }}
                            >
                                <CloseIcon style={{ fontSize: 18 }} />
                            </button>
                        )}
                    </div>
                )}

                {children}

                {footer && <ModalFooter>{footer}</ModalFooter>}
            </div>
        </div>
    );

    return createPortal(node, document.body);
}
