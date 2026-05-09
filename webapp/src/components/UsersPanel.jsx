import React from 'react';
import {
    Users as PeopleIcon,
    Mail as EmailIcon,
    Pencil as EditIcon,
    KeyRound as VpnKeyIcon,
    Trash2 as DeleteIcon,
    UserCircle as AccountCircleIcon,
} from 'lucide-react';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';

// Phase 4: Tailwind rewrite of the Users tab.
// The MUI dialog (create / edit / invite / reset-password) stays inline
// in App.js — it's already themed via Phase 3 component overrides and
// rebuilding it as Tailwind primitives would 5x the diff for marginal
// visual gain. This panel only owns the surface chrome + table + row
// pills + per-row action buttons, all of which read CSS vars.
//
// Props:
//   users          array — server's user list
//   user           current logged-in user (for "You" badge)
//   usersLoading   bool
//   isAdmin        bool — gate the table rendering
//   isMobile       bool — use icon-only Invite button on small breakpoints
//   onInvite       () => void
//   onEdit         (user) => void
//   onResetPassword(user) => void
//   onDelete       (id) => void
//   onToggleStatus (id, nextDisabled) => void

function StatusPill({ disabled }) {
    const tint = disabled ? '#ef4444' : '#22c55e';
    const label = disabled ? 'Disabled' : 'Active';
    return (
        <span
            className="inline-flex h-6 min-w-[68px] items-center justify-center rounded-full border px-2 text-[0.7rem] font-medium"
            style={{
                color: tint,
                backgroundColor: `${tint}1A`,
                borderColor: `${tint}55`,
            }}
        >
            {label}
        </span>
    );
}

function RolePill({ role }) {
    const isAdmin = role === 'admin';
    return (
        <span
            className="inline-flex h-6 items-center rounded-full border px-2 text-[0.7rem] font-medium capitalize"
            style={
                isAdmin
                    ? {
                          color: 'var(--accent-primary)',
                          backgroundColor: 'var(--accent-muted)',
                          borderColor: 'var(--border-focus)',
                      }
                    : {
                          color: 'var(--text-tertiary)',
                          backgroundColor: 'var(--bg-tertiary)',
                          borderColor: 'var(--border-primary)',
                      }
            }
        >
            {role}
        </span>
    );
}

function ActionButton({ title, onClick, danger, children }) {
    return (
        <Tooltip title={title}>
            <button
                type="button"
                onClick={onClick}
                aria-label={title}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md transition"
                style={{
                    color: danger ? '#f87171' : 'var(--text-secondary)',
                    backgroundColor: 'transparent',
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = danger ? 'rgba(248,113,113,0.12)' : 'var(--bg-hover)';
                    e.currentTarget.style.color = danger ? '#ef4444' : 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = danger ? '#f87171' : 'var(--text-secondary)';
                }}
            >
                {children}
            </button>
        </Tooltip>
    );
}

export default function UsersPanel({
    users = [],
    user,
    usersLoading,
    isAdmin = false,
    isMobile = false,
    onInvite,
    onEdit,
    onResetPassword,
    onDelete,
    onToggleStatus,
}) {
    return (
        <div
            className="rounded-xl border"
            style={{
                backgroundColor: 'var(--surface-primary)',
                borderColor: 'var(--border-primary)',
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between gap-3 border-b px-4 py-3"
                style={{ borderColor: 'var(--border-primary)' }}
            >
                <div className="flex items-center gap-3 min-w-0">
                    <span
                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                        style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                    >
                        <PeopleIcon size={20} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                        <div
                            className="text-sm font-semibold truncate"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            User Management
                        </div>
                        <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                            Manage user accounts and permissions
                        </div>
                    </div>
                </div>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={onInvite}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition flex-shrink-0"
                        style={{
                            borderColor: 'var(--border-focus)',
                            color: 'var(--accent-primary)',
                            backgroundColor: 'var(--accent-muted)',
                        }}
                    >
                        <EmailIcon size={14} strokeWidth={2} />
                        <span>{isMobile ? 'Invite' : 'Invite User'}</span>
                    </button>
                )}
            </div>

            {/* Body */}
            {!isAdmin ? (
                <div className="flex flex-col items-center gap-3 py-12">
                    <PeopleIcon size={40} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
                    <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        Admin access required to manage users
                    </div>
                </div>
            ) : usersLoading ? (
                <div className="flex justify-center py-8">
                    <CircularProgress size={28} sx={{ color: 'var(--accent-primary)' }} />
                </div>
            ) : users.length === 0 ? (
                <div className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    No users found
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr
                                className="text-left text-[0.7rem] uppercase tracking-wider"
                                style={{
                                    color: 'var(--text-tertiary)',
                                    backgroundColor: 'var(--bg-tertiary)',
                                    borderTop: '1px solid var(--border-primary)',
                                    borderBottom: '1px solid var(--border-primary)',
                                }}
                            >
                                <th className="px-4 py-2 font-semibold">Username</th>
                                <th className="px-4 py-2 font-semibold">Email</th>
                                <th className="px-4 py-2 font-semibold">Role</th>
                                <th className="px-4 py-2 font-semibold">Status</th>
                                <th className="px-4 py-2 font-semibold">Last Login</th>
                                <th className="px-4 py-2 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((u) => (
                                <tr
                                    key={u.id}
                                    className="transition"
                                    style={{
                                        borderBottom: '1px solid var(--border-primary)',
                                        opacity: u.disabled ? 0.6 : 1,
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor = 'transparent';
                                    }}
                                >
                                    <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>
                                        <div className="flex items-center gap-2">
                                            <AccountCircleIcon
                                                size={16}
                                                strokeWidth={1.75}
                                                style={{
                                                    color: u.disabled ? 'var(--text-muted)' : 'var(--text-tertiary)',
                                                }}
                                            />
                                            <span className="truncate">{u.username}</span>
                                            {u.id === user?.id && (
                                                <span
                                                    className="inline-flex h-5 items-center rounded-full px-2 text-[0.6rem] font-semibold uppercase tracking-wider"
                                                    style={{
                                                        color: 'var(--accent-primary)',
                                                        backgroundColor: 'var(--accent-muted)',
                                                    }}
                                                >
                                                    you
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                                        {u.email}
                                    </td>
                                    <td className="px-4 py-3">
                                        <RolePill role={u.role} />
                                    </td>
                                    <td className="px-4 py-3">
                                        <StatusPill disabled={u.disabled} />
                                    </td>
                                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
                                        {u.lastLoginAt ? (
                                            <Tooltip title={new Date(u.lastLoginAt).toLocaleString()}>
                                                <span className="text-[0.85rem]">
                                                    {new Date(u.lastLoginAt).toLocaleDateString()}
                                                </span>
                                            </Tooltip>
                                        ) : (
                                            <span className="text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                                                Never
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <div className="inline-flex items-center gap-1">
                                            {u.id !== user?.id && (
                                                <Tooltip title={u.disabled ? 'Enable Account' : 'Disable Account'}>
                                                    <Switch
                                                        size="small"
                                                        checked={!u.disabled}
                                                        onChange={() => onToggleStatus(u.id, !u.disabled)}
                                                        color="success"
                                                    />
                                                </Tooltip>
                                            )}
                                            <ActionButton title="Edit" onClick={() => onEdit(u)}>
                                                <EditIcon size={15} strokeWidth={2} />
                                            </ActionButton>
                                            <ActionButton title="Reset Password" onClick={() => onResetPassword(u)}>
                                                <VpnKeyIcon size={15} strokeWidth={2} />
                                            </ActionButton>
                                            {u.id !== user?.id && (
                                                <ActionButton danger title="Delete" onClick={() => onDelete(u.id)}>
                                                    <DeleteIcon size={15} strokeWidth={2} />
                                                </ActionButton>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
