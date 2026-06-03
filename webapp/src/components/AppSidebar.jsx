import React from 'react';
import { GripVertical } from 'lucide-react';
import { useAuthStore } from '../stores/useAuthStore';

// Phase 1b shell: chat-style left rail. Replaces the desktop MUI Tabs
// strip. Mobile flow (hamburger → MUI Drawer) is unaffected — this
// component is `hidden md:flex` and the Drawer keeps owning small
// breakpoints until Phase 5 rewrites it.
//
// Props:
//   tabs            full tabDefinitions array  [{id, label, icon, adminOnly}]
//   visibleOrder    array of tabIds in display order (admin-filtered)
//   activeIndex     current activeTab — index INTO visibleOrder
//   onSelectIndex   fn(index) when a nav item is clicked
//   appVersion      optional string shown in the footer
//   onDragStart/onDragOver/onDragEnd  drag-reorder handlers, called with
//                   (event, index-into-visibleOrder). Reordering + persistence
//                   live in the parent (App.js handleDrag* / tabOrder).
//   draggedIndex    index currently being dragged (for grab styling), or null
export default function AppSidebar({
    tabs = [],
    visibleOrder = [],
    activeIndex = 0,
    onSelectIndex = () => {},
    appVersion,
    onDragStart = () => {},
    onDragOver = () => {},
    onDragEnd = () => {},
    draggedIndex = null,
}) {
    const user = useAuthStore((s) => s.user);

    return (
        <aside
            className="hidden md:flex w-56 shrink-0 flex-col border-r"
            style={{
                backgroundColor: 'var(--bg-secondary)',
                borderColor: 'var(--border-primary)',
            }}
        >
            {/* Brand */}
            <div
                className="px-5 py-4 border-b"
                style={{ borderColor: 'var(--border-primary)' }}
            >
                <div
                    className="text-base font-semibold"
                    style={{
                        background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                    }}
                >
                    Model Server
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                    {/* Username — natural case, no uppercase transform.
                        Previously this row had `uppercase tracking-wider`
                        which together with a same-text role badge produced
                        "ADMIN ADMIN" when the user happened to be named
                        admin. Drop the global uppercase; the role badge
                        carries its own caps. */}
                    <span
                        className="truncate text-xs"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        {user?.username || 'guest'}
                    </span>
                    {user?.role === 'admin' && user?.username !== 'admin' && (
                        <span
                            className="inline-flex h-4 items-center rounded px-1 text-[0.55rem] font-semibold uppercase tracking-wider"
                            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                        >
                            admin
                        </span>
                    )}
                </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
                {visibleOrder.map((tabId, idx) => {
                    const tab = tabs.find((t) => t.id === tabId);
                    if (!tab) return null;
                    const active = idx === activeIndex;
                    const dragging = draggedIndex === idx;
                    const baseStyle = active
                        ? {
                              backgroundColor: 'var(--accent-muted)',
                              color: 'var(--accent-primary)',
                              boxShadow: 'inset 0 0 0 1px var(--border-focus)',
                          }
                        : {
                              color: 'var(--text-secondary)',
                          };
                    return (
                        <button
                            key={tabId}
                            type="button"
                            draggable
                            onClick={() => onSelectIndex(idx)}
                            onDragStart={(e) => onDragStart(e, idx)}
                            onDragOver={(e) => onDragOver(e, idx)}
                            onDragEnd={onDragEnd}
                            onDrop={(e) => e.preventDefault()}
                            className="group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition focus:outline-none focus:ring-2"
                            style={
                                dragging
                                    ? { ...baseStyle, opacity: 0.5, cursor: 'grabbing' }
                                    : { ...baseStyle, cursor: 'grab' }
                            }
                            onMouseEnter={(e) => {
                                if (!active) {
                                    e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                                    e.currentTarget.style.color = 'var(--text-primary)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                if (!active) {
                                    e.currentTarget.style.backgroundColor = '';
                                    e.currentTarget.style.color = 'var(--text-secondary)';
                                }
                            }}
                            aria-current={active ? 'page' : undefined}
                        >
                            {/* Drag affordance — sits in the row's left padding so
                                it reveals on hover without shifting the icon/label. */}
                            <span
                                aria-hidden="true"
                                className="absolute inset-y-0 left-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-50"
                                style={{ width: '12px', color: 'var(--text-muted)', pointerEvents: 'none' }}
                            >
                                <GripVertical size={12} strokeWidth={1.75} />
                            </span>
                            <span
                                className="flex h-5 w-5 items-center justify-center"
                                style={{ opacity: active ? 1 : 0.75 }}
                            >
                                {tab.icon}
                            </span>
                            <span className="truncate">{tab.label}</span>
                            {tab.adminOnly && !active && (
                                <span
                                    className="ml-auto inline-flex h-[18px] items-center rounded px-1.5 text-[0.6rem] font-semibold uppercase tracking-wider"
                                    style={{
                                        backgroundColor: 'var(--accent-muted)',
                                        color: 'var(--accent-primary)',
                                        opacity: 0.85,
                                    }}
                                >
                                    admin
                                </span>
                            )}
                        </button>
                    );
                })}
            </nav>

            {/* Footer hint */}
            <div
                className="border-t px-3 py-2.5 text-[0.65rem]"
                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-muted)' }}
            >
                <div className="flex items-center gap-1.5">
                    <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: 'var(--success)' }}
                    />
                    <span>Synced with chat:3002</span>
                </div>
                {appVersion && (
                    <div className="mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                        v{appVersion}
                    </div>
                )}
            </div>
        </aside>
    );
}
