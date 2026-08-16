import React, { useState, useRef, useEffect } from 'react';
import {
    ChevronDown,
    Settings,
    LogOut,
    PanelLeft,
    Eye,
    Menu,
} from 'lucide-react';

/**
 * ChatHeader — the app toolbar above the conversation.
 *
 * All controls use the shared `.ctl` proportion system from index.css
 * (icon buttons 32px / chips 28px) so the header, sidebar and composer
 * read as one family. Hover / focus states are CSS-driven.
 */
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

    useEffect(() => {
        if (!userDropdownOpen) return;
        const onKey = (e) => { if (e.key === 'Escape') setUserDropdownOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [userDropdownOpen]);

    const displayName = user?.username || user?.name || 'User';
    const userInitial = displayName.charAt(0).toUpperCase();

    return (
        <header className="app-toolbar">
            {/* Left: sidebar toggle + breadcrumb */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1, overflow: 'hidden' }}>
                {/* Mobile hamburger — only visible <768px */}
                {onOpenMobileSidebar && (
                    <span className="md:hidden">
                        <button
                            type="button"
                            onClick={onOpenMobileSidebar}
                            className="ctl ctl-icon-md tap-feedback"
                            aria-label="Open sidebar"
                            title="Open sidebar"
                        >
                            <Menu strokeWidth={1.75} />
                        </button>
                    </span>
                )}
                {/* Desktop show-sidebar button when collapsed */}
                {sidebarCollapsed && onOpenSidebar && (
                    <span className="hidden md:inline-flex">
                        <button
                            type="button"
                            onClick={onOpenSidebar}
                            className="ctl ctl-icon-md"
                            aria-label="Show sidebar"
                            title="Show sidebar"
                        >
                            <PanelLeft strokeWidth={1.75} />
                        </button>
                    </span>
                )}

                {/* Breadcrumb */}
                {breadcrumb && breadcrumb.length > 0 && (
                    <nav className="app-toolbar-crumbs" aria-label="Breadcrumb">
                        {breadcrumb.map((item, i) => (
                            <React.Fragment key={i}>
                                <span
                                    className="breadcrumb-item"
                                    aria-current={i === breadcrumb.length - 1 ? 'page' : undefined}
                                >
                                    {item}
                                </span>
                                {i < breadcrumb.length - 1 && <span className="breadcrumb-spacer" aria-hidden="true">/</span>}
                            </React.Fragment>
                        ))}
                    </nav>
                )}
            </div>

            {/* Right: artifacts toggle + settings + user */}
            <div className="app-toolbar-right">
                {onToggleArtifacts && (
                    <button
                        type="button"
                        onClick={onToggleArtifacts}
                        className={`ctl ctl-chip${artifactsOpen ? ' is-active' : ''}`}
                        aria-pressed={!!artifactsOpen}
                        aria-label="Toggle artifacts panel"
                        title="Toggle artifacts panel"
                    >
                        <Eye strokeWidth={1.75} />
                        <span className="artifacts-toggle-label">Artifacts</span>
                    </button>
                )}

                <button
                    type="button"
                    onClick={onSettingsClick}
                    className="ctl ctl-icon-md"
                    aria-label="Settings"
                    title="Settings"
                >
                    <Settings strokeWidth={1.75} />
                </button>

                <div style={{ position: 'relative' }} ref={userDropdownRef}>
                    <button
                        type="button"
                        onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                        className="ctl app-toolbar-user"
                        aria-label={`Account menu — ${displayName}`}
                        aria-haspopup="menu"
                        aria-expanded={userDropdownOpen}
                        title={displayName}
                    >
                        <span className="app-avatar" aria-hidden="true">{userInitial}</span>
                        <ChevronDown className="app-chev" strokeWidth={2} />
                    </button>

                    {userDropdownOpen && (
                        <div className="ctl-pop app-toolbar-menu" role="menu">
                            <div className="app-toolbar-menu-head">
                                <p>{displayName}</p>
                                <span>Signed in</span>
                            </div>
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setUserDropdownOpen(false); onLogout(); }}
                                className="ctl-pop-item is-danger"
                            >
                                <LogOut strokeWidth={1.75} />
                                Sign out
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
