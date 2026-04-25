import React, { useState, useRef, useEffect } from 'react';
import {
    ChevronDown,
    Settings,
    LogOut,
    PanelLeft,
    Eye,
    Menu,
    User,
} from 'lucide-react';

export default function ChatHeader({
    onSettingsClick,
    user,
    onLogout,
    sidebarCollapsed,
    onOpenSidebar,
    onOpenMobileSidebar,
    breadcrumb,
    artifactsOpen,
    onToggleArtifacts,
}) {
    const [userDropdownOpen, setUserDropdownOpen] = useState(false);
    const userDropdownRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (userDropdownRef.current && !userDropdownRef.current.contains(event.target)) {
                setUserDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const displayName = user?.username || user?.name || 'User';

    // Shared styles using the design palette bridge
    const topBtn = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 9px', borderRadius: 6,
        color: 'var(--ink-3)', fontSize: 12,
        background: 'transparent', border: 0, cursor: 'pointer',
        transition: 'background .1s, color .1s',
    };
    const topBtnActive = {
        ...topBtn,
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
    };
    const modelChip = {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderRadius: 8,
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        color: 'var(--ink-2)', fontSize: 12, fontWeight: 500,
        cursor: 'pointer',
        transition: 'border-color .1s, background .1s',
    };
    const dropdown = {
        position: 'absolute', top: 'calc(100% + 4px)',
        minWidth: 240,
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        borderRadius: 10,
        boxShadow: '0 10px 30px -10px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.15)',
        padding: 6,
        zIndex: 50,
    };
    const popItem = {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 10px', borderRadius: 6,
        textAlign: 'left',
        background: 'transparent', border: 0, cursor: 'pointer',
        color: 'var(--ink)',
        transition: 'background .08s',
    };

    return (
        <header
            style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: 'calc(10px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 10px calc(16px + env(safe-area-inset-left))',
                borderBottom: '1px solid var(--rule)',
                background: 'var(--bg)',
                flexShrink: 0,
                position: 'sticky',
                top: 0,
                zIndex: 30,
            }}
        >
            {/* Left: sidebar toggle + breadcrumb */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, overflow: 'hidden' }}>
                {/* Mobile hamburger — only visible <768px */}
                {onOpenMobileSidebar && (
                    <button
                        onClick={onOpenMobileSidebar}
                        className="md:hidden tap-feedback"
                        style={{ ...topBtn, padding: '8px', minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}
                        aria-label="Open sidebar"
                        title="Open sidebar"
                    >
                        <Menu style={{ width: 18, height: 18 }} strokeWidth={1.75} />
                    </button>
                )}
                {/* Desktop show-sidebar button when collapsed */}
                {sidebarCollapsed && onOpenSidebar && (
                    <button
                        onClick={onOpenSidebar}
                        className="hidden md:inline-flex"
                        style={{ ...topBtn, padding: '6px 7px' }}
                        title="Show sidebar"
                    >
                        <PanelLeft style={{ width: 15, height: 15 }} strokeWidth={1.75} />
                    </button>
                )}

                {/* Breadcrumb */}
                {breadcrumb && breadcrumb.length > 0 && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontSize: 12.5, color: 'var(--ink)',
                        maxWidth: 360, minWidth: 0, overflow: 'hidden',
                    }}>
                        {breadcrumb.map((item, i) => (
                            <React.Fragment key={i}>
                                <span className="breadcrumb-item" style={{
                                    color: i === breadcrumb.length - 1 ? 'var(--ink)' : 'var(--ink-3)',
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    maxWidth: 160,
                                }}>
                                    {item}
                                </span>
                                {i < breadcrumb.length - 1 && <span className="breadcrumb-spacer" style={{ color: 'var(--ink-4)' }}>/</span>}
                            </React.Fragment>
                        ))}
                    </div>
                )}

            </div>

            {/* Right: artifacts toggle + settings + user */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {onToggleArtifacts && (
                    <button
                        onClick={onToggleArtifacts}
                        style={artifactsOpen ? topBtnActive : topBtn}
                        onMouseEnter={(e) => { if (!artifactsOpen) e.currentTarget.style.background = 'var(--bg-2)'; }}
                        onMouseLeave={(e) => { if (!artifactsOpen) e.currentTarget.style.background = 'transparent'; }}
                        title="Toggle artifacts panel"
                    >
                        <Eye style={{ width: 14, height: 14 }} strokeWidth={1.75} />
                        <span className="artifacts-toggle-label">Artifacts</span>
                    </button>
                )}

                <button
                    onClick={onSettingsClick}
                    style={{ ...topBtn, padding: '6px 7px' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    title="Settings"
                >
                    <Settings style={{ width: 15, height: 15 }} strokeWidth={1.75} />
                </button>

                <div style={{ position: 'relative' }} ref={userDropdownRef}>
                    <button
                        onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                        style={{ ...topBtn, padding: '3px 3px 3px 6px' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-2)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                        <div
                            style={{
                                width: 24, height: 24, borderRadius: '50%',
                                background: 'transparent',
                                color: 'var(--ink-2)',
                                border: '1px solid var(--rule)',
                                display: 'grid', placeItems: 'center',
                            }}
                        >
                            <User style={{ width: 13, height: 13 }} strokeWidth={1.75} />
                        </div>
                        <ChevronDown
                            style={{
                                width: 12, height: 12, color: 'var(--ink-4)',
                                transform: userDropdownOpen ? 'rotate(180deg)' : 'none',
                                transition: 'transform .15s',
                            }}
                            strokeWidth={2}
                        />
                    </button>

                    {userDropdownOpen && (
                        <div style={{ ...dropdown, right: 0, minWidth: 160 }}>
                            <div style={{
                                padding: '8px 10px',
                                borderBottom: '1px solid var(--rule-2)',
                            }}>
                                <p style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ink-2)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {displayName}
                                </p>
                            </div>
                            <button
                                onClick={() => { setUserDropdownOpen(false); onLogout(); }}
                                style={{ ...popItem, color: 'var(--danger)', fontSize: 11.5 }}
                                onMouseEnter={(e) => e.currentTarget.style.background = 'color-mix(in oklab, var(--danger) 12%, transparent)'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <LogOut style={{ width: 12, height: 12 }} strokeWidth={1.75} />
                                Sign out
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
