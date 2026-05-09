import React from 'react';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Modal, { ModalBody } from './Modal';

// User dialog — first port off MUI Dialog onto the Tailwind Modal
// primitive. TextField + Select stay MUI for now since Phase 3
// component overrides theme them already; rebuilding form primitives
// is its own future sweep.
//
// Modes: 'create' | 'edit' | 'invite' | 'resetPassword'
// All four were stacked into one Dialog in App.js with conditional
// fields; same shape preserved here.

const TITLES = {
    create: 'Create New User',
    edit: 'Edit User',
    invite: 'Invite User by Email',
    resetPassword: 'Reset Password',
};

function isValid(mode, data) {
    if (mode === 'create') {
        return !!(data.username && data.email && data.password && data.password.length >= 8);
    }
    if (mode === 'edit') return !!data.email;
    if (mode === 'invite') return !!data.email;
    if (mode === 'resetPassword') return !!(data.password && data.password.length >= 8);
    return false;
}

export default function UserDialog({
    open,
    mode,
    selectedUser,
    formData,
    setFormData,
    onClose,
    onCreate,
    onUpdate,
    onInvite,
    onResetPassword,
}) {
    const title = mode === 'edit' && selectedUser
        ? `Edit User: ${selectedUser.username}`
        : mode === 'resetPassword' && selectedUser
            ? `Reset Password: ${selectedUser.username}`
            : (TITLES[mode] || 'User');

    const submit = () => {
        if (mode === 'create') return onCreate?.();
        if (mode === 'edit') return onUpdate?.();
        if (mode === 'invite') return onInvite?.();
        if (mode === 'resetPassword') return onResetPassword?.();
    };

    const submitLabel = mode === 'create' ? 'Create'
        : mode === 'edit' ? 'Save'
        : mode === 'invite' ? 'Send Invite'
        : 'Reset Password';

    const set = (patch) => setFormData({ ...formData, ...patch });

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={title}
            size="md"
            footer={
                <>
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition"
                        style={{
                            borderColor: 'var(--border-primary)',
                            color: 'var(--text-secondary)',
                            backgroundColor: 'transparent',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!isValid(mode, formData)}
                        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                        style={{
                            borderColor: 'var(--border-focus)',
                            color: 'var(--accent-primary)',
                            backgroundColor: 'var(--accent-muted)',
                        }}
                    >
                        {submitLabel}
                    </button>
                </>
            }
        >
            <ModalBody>
                <div className="flex flex-col gap-3">
                    {mode === 'create' && (
                        <TextField
                            label="Username"
                            value={formData.username || ''}
                            onChange={(e) => set({ username: e.target.value })}
                            fullWidth
                            size="small"
                        />
                    )}
                    {(mode === 'create' || mode === 'edit') && (
                        <>
                            <TextField
                                label="Email"
                                type="email"
                                value={formData.email || ''}
                                onChange={(e) => set({ email: e.target.value })}
                                fullWidth
                                size="small"
                            />
                            <FormControl fullWidth size="small">
                                <InputLabel>Role</InputLabel>
                                <Select
                                    value={formData.role || 'user'}
                                    label="Role"
                                    onChange={(e) => set({ role: e.target.value })}
                                >
                                    <MenuItem value="user">User</MenuItem>
                                    <MenuItem value="admin">Admin</MenuItem>
                                </Select>
                            </FormControl>
                        </>
                    )}
                    {mode === 'invite' && (
                        <>
                            <TextField
                                autoFocus
                                label="Email Address"
                                type="email"
                                value={formData.email || ''}
                                onChange={(e) => set({ email: e.target.value })}
                                fullWidth
                                required
                                size="small"
                                helperText="User will receive an email to complete registration"
                            />
                            <FormControl fullWidth size="small">
                                <InputLabel>Role</InputLabel>
                                <Select
                                    value={formData.role || 'user'}
                                    label="Role"
                                    onChange={(e) => set({ role: e.target.value })}
                                >
                                    <MenuItem value="user">User</MenuItem>
                                    <MenuItem value="admin">Admin</MenuItem>
                                </Select>
                            </FormControl>
                        </>
                    )}
                    {(mode === 'create' || mode === 'resetPassword') && (
                        <TextField
                            label={mode === 'create' ? 'Password' : 'New Password'}
                            type="password"
                            value={formData.password || ''}
                            onChange={(e) => set({ password: e.target.value })}
                            fullWidth
                            size="small"
                            helperText="Minimum 8 characters"
                        />
                    )}
                </div>
            </ModalBody>
        </Modal>
    );
}
