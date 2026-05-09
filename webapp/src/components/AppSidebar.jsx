import React from 'react';
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
export default function AppSidebar({
    tabs = [],
    visibleOrder = [],
    activeIndex = 0,
    onSelectIndex = () => {},
    appVersion,
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
                <div
                    className="mt-0.5 truncate text-[0.65rem] uppercase tracking-wider"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    {user?.username || 'guest'}
                    {user?.role === 'admin' && (
                        <span
                            className="ml-1.5 rounded px-1 py-px text-[0.55rem] font-semibold"
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
                    return (
                        <button
                            key={tabId}
                            type="button"
                            onClick={() => onSelectIndex(idx)}
                            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition focus:outline-none focus:ring-2"
                            style={
                                active
                                    ? {
                                          backgroundColor: 'var(--accent-muted)',
                                          color: 'var(--accent-primary)',
                                          boxShadow: 'inset 0 0 0 1px var(--border-focus)',
                                      }
                                    : {
                                          color: 'var(--text-secondary)',
                                      }
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
                            <span
                                className="flex h-5 w-5 items-center justify-center"
                                style={{ opacity: active ? 1 : 0.75 }}
                            >
                                {tab.icon}
                            </span>
                            <span className="truncate">{tab.label}</span>
                            {tab.adminOnly && !active && (
                                <span
                                    className="ml-auto rounded px-1 py-px text-[0.55rem]"
                                    style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
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
