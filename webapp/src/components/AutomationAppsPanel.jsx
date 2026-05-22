import React, { useEffect, useState } from 'react';
import {
    Box, Typography, Button, Card, CardContent, CardActions, Chip, Switch,
    TextField, Grid, Dialog, DialogTitle, DialogContent, DialogActions,
    MenuItem, Alert, IconButton, Tooltip, CircularProgress, InputAdornment, Collapse
} from '@mui/material';
import { Plus, Pencil, Trash2, Search as SearchIcon, X as ClearIcon, ChevronDown } from 'lucide-react';

// Automation building-block library for ONE category, shown as a sub-tab next
// to Tools and Skills in the Apps tab. Lists the read-only built-in palette
// (the "robust list" the engine ships) plus the user's custom node-types, with
// create/edit/delete that mirrors the Skills CRUD flow (raw fetch +
// credentials, optimistic refetch). Backed by /api/node-types[/builtin].

const CATEGORY_META = {
    trigger:   { label: 'Triggers',    singular: 'Trigger',    blurb: 'Entry points that start a workflow — manual, schedule, webhook, on event.' },
    gate:      { label: 'Logic Gates', singular: 'Logic Gate', blurb: 'Branch, filter, and merge the flow — if/else, switch, filter, merge.' },
    connector: { label: 'Connectors',  singular: 'Connector',  blurb: 'Steps that do work — models, tools, web search, HTTP, files, charts.' },
};

const cardSx = {
    bgcolor: 'var(--bg-tertiary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 1.5,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
};

const clamp2 = {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
};

export default function AutomationAppsPanel({ category, showSnackbar, isAdmin = false, defaultExpanded = false }) {
    const meta = CATEGORY_META[category] || { label: category, singular: category, blurb: '' };

    const [expanded, setExpanded] = useState(defaultExpanded);
    const [builtins, setBuiltins] = useState([]);
    const [custom, setCustom] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState({ name: '', description: '', baseType: '', defaults: '{}' });

    const notify = (msg, sev = 'success') => { if (showSnackbar) showSnackbar(msg, sev); };

    const load = async () => {
        setLoading(true); setError(null);
        try {
            const [bRes, cRes] = await Promise.all([
                fetch('/api/node-types/builtin', { credentials: 'include' }),
                fetch('/api/node-types', { credentials: 'include' }),
            ]);
            const b = bRes.ok ? await bRes.json() : [];
            const c = cRes.ok ? await cRes.json() : [];
            setBuiltins((Array.isArray(b) ? b : []).filter(t => t.category === category));
            setCustom((Array.isArray(c) ? c : []).filter(t => t.category === category));
        } catch (e) {
            setError(e.message || 'Failed to load building blocks');
        }
        setLoading(false);
    };

    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [category]);

    const openCreate = () => {
        setEditing(null);
        setForm({ name: '', description: '', baseType: builtins[0]?.type || 'tool', defaults: '{}' });
        setDialogOpen(true);
    };
    const openEdit = (nt) => {
        setEditing(nt);
        setForm({
            name: nt.name || '',
            description: nt.description || '',
            baseType: nt.baseType || builtins[0]?.type || 'tool',
            defaults: JSON.stringify(nt.defaults || {}, null, 2),
        });
        setDialogOpen(true);
    };

    const save = async () => {
        if (!form.name.trim()) { notify('Name is required', 'error'); return; }
        let defaults;
        try { defaults = form.defaults.trim() ? JSON.parse(form.defaults) : {}; }
        catch (_) { notify('Defaults must be valid JSON', 'error'); return; }
        const body = {
            name: form.name.trim(),
            category,
            description: form.description,
            baseType: form.baseType,
            defaults,
        };
        try {
            const url = editing ? `/api/node-types/${editing.id}` : '/api/node-types';
            const method = editing ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method, credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed'); }
            notify(editing ? `${meta.singular} updated` : `${meta.singular} created`);
            setDialogOpen(false);
            load();
        } catch (e) { notify(e.message, 'error'); }
    };

    const toggleEnabled = async (nt) => {
        try {
            const res = await fetch(`/api/node-types/${nt.id}`, {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: nt.enabled === false }),
            });
            if (!res.ok) throw new Error('Update failed');
            load();
        } catch (e) { notify(e.message, 'error'); }
    };

    const remove = async (nt) => {
        if (!window.confirm(`Delete ${meta.singular.toLowerCase()} "${nt.name}"?`)) return;
        try {
            const res = await fetch(`/api/node-types/${nt.id}`, { method: 'DELETE', credentials: 'include' });
            if (!res.ok) throw new Error('Delete failed');
            notify(`${meta.singular} deleted`);
            load();
        } catch (e) { notify(e.message, 'error'); }
    };

    const q = search.trim().toLowerCase();
    const matchq = (t) => !q
        || (t.label || t.name || '').toLowerCase().includes(q)
        || (t.description || '').toLowerCase().includes(q);
    const shownBuiltins = builtins.filter(matchq);
    const shownCustom = custom.filter(matchq);

    const totalCount = builtins.length + custom.length;

    return (
        <Box sx={{ mb: 2, border: '1px solid var(--border-primary)', borderRadius: 1.5, overflow: 'hidden' }}>
            {/* Collapsible header */}
            <Box
                onClick={() => setExpanded(v => !v)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v); } }}
                sx={{
                    display: 'flex', alignItems: 'center', gap: 1, p: 1.25, cursor: 'pointer',
                    bgcolor: 'var(--bg-tertiary)', '&:hover': { bgcolor: 'var(--bg-hover)' },
                }}
            >
                <ChevronDown size={18} style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', flexShrink: 0 }} />
                <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        {meta.label} <Typography component="span" variant="caption" color="text.secondary">· {totalCount}</Typography>
                    </Typography>
                    {expanded && <Typography variant="body2" color="text.secondary">{meta.blurb}</Typography>}
                </Box>
                <Button
                    variant="contained" size="small"
                    startIcon={<Plus size={16} />}
                    onClick={(e) => { e.stopPropagation(); setExpanded(true); openCreate(); }}
                    sx={{ flexShrink: 0, ml: 'auto' }}
                >
                    New {meta.singular}
                </Button>
            </Box>

            <Collapse in={expanded} timeout="auto" unmountOnExit>
            <Box sx={{ p: 1.5 }}>
            <TextField
                size="small" fullWidth placeholder={`Search ${meta.label.toLowerCase()}…`}
                value={search} onChange={(e) => setSearch(e.target.value)}
                sx={{ mb: 2 }}
                InputProps={{
                    startAdornment: <InputAdornment position="start"><SearchIcon size={16} /></InputAdornment>,
                    endAdornment: search ? (
                        <InputAdornment position="end">
                            <IconButton size="small" onClick={() => setSearch('')}><ClearIcon size={14} /></IconButton>
                        </InputAdornment>
                    ) : null,
                }}
            />

            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            {loading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>
            )}

            {!loading && (
                <>
                    {/* Built-in palette (read-only) */}
                    <Typography variant="overline" color="text.secondary">
                        Built-in {meta.label} · {shownBuiltins.length}
                    </Typography>
                    <Grid container spacing={1.5} sx={{ mb: 3, mt: 0 }}>
                        {shownBuiltins.map((t) => (
                            <Grid item xs={12} sm={6} md={4} key={t.key || t.type}>
                                <Card variant="outlined" sx={cardSx}>
                                    <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 0.5 }}>
                                            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{t.label}</Typography>
                                            <Chip label="Built-in" size="small" variant="outlined" sx={{ height: 20 }} />
                                        </Box>
                                        <Typography variant="caption" color="text.secondary" sx={clamp2}>
                                            {t.description}
                                        </Typography>
                                    </CardContent>
                                </Card>
                            </Grid>
                        ))}
                        {shownBuiltins.length === 0 && (
                            <Grid item xs={12}>
                                <Typography variant="body2" color="text.secondary" sx={{ px: 0.5 }}>
                                    {q ? 'No built-ins match your search.' : 'No built-ins in this category.'}
                                </Typography>
                            </Grid>
                        )}
                    </Grid>

                    {/* Custom node-types (CRUD) */}
                    <Typography variant="overline" color="text.secondary">
                        Your {meta.label} · {shownCustom.length}
                    </Typography>
                    {shownCustom.length === 0 ? (
                        <Alert severity="info" sx={{ mt: 0.5 }}>
                            {q
                                ? 'No custom building blocks match your search.'
                                : `You haven't created any custom ${meta.label.toLowerCase()} yet. Click "New ${meta.singular}" to make a reusable building block with preset values.`}
                        </Alert>
                    ) : (
                        <Grid container spacing={1.5} sx={{ mt: 0 }}>
                            {shownCustom.map((nt) => (
                                <Grid item xs={12} sm={6} md={4} key={nt.id}>
                                    <Card variant="outlined" sx={cardSx}>
                                        <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                                                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{nt.name}</Typography>
                                                <Switch
                                                    size="small"
                                                    checked={nt.enabled !== false}
                                                    onChange={() => toggleEnabled(nt)}
                                                />
                                            </Box>
                                            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', my: 0.5 }}>
                                                {nt.baseType && (
                                                    <Chip label={nt.baseType} size="small" variant="outlined" sx={{ height: 20 }} />
                                                )}
                                                {isAdmin && nt._ownerName && (
                                                    <Chip label={nt._ownerName} size="small" sx={{ height: 20, bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)' }} />
                                                )}
                                            </Box>
                                            <Typography variant="caption" color="text.secondary" sx={{ ...clamp2, display: '-webkit-box' }}>
                                                {nt.description || 'No description'}
                                            </Typography>
                                        </CardContent>
                                        <CardActions sx={{ pt: 0, justifyContent: 'flex-end' }}>
                                            <Tooltip title="Edit">
                                                <IconButton size="small" onClick={() => openEdit(nt)} sx={{ color: 'var(--accent-primary)' }}>
                                                    <Pencil size={15} />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Delete">
                                                <IconButton size="small" onClick={() => remove(nt)} sx={{ color: 'var(--error, #f87171)' }}>
                                                    <Trash2 size={15} />
                                                </IconButton>
                                            </Tooltip>
                                        </CardActions>
                                    </Card>
                                </Grid>
                            ))}
                        </Grid>
                    )}
                </>
            )}
            </Box>
            </Collapse>

            {/* Create / Edit dialog */}
            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editing ? `Edit ${meta.singular}` : `New ${meta.singular}`}</DialogTitle>
                <DialogContent>
                    <TextField
                        label="Name" fullWidth size="small" sx={{ mt: 1, mb: 2 }}
                        value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                        autoFocus
                    />
                    <TextField
                        label="Description" fullWidth size="small" multiline minRows={2} sx={{ mb: 2 }}
                        value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                    <TextField
                        select label="Base type" fullWidth size="small" sx={{ mb: 2 }}
                        value={form.baseType} onChange={(e) => setForm({ ...form, baseType: e.target.value })}
                        helperText="Which built-in primitive this building block specializes."
                    >
                        {builtins.map((b) => (
                            <MenuItem key={b.key || b.type} value={b.type}>{b.label} ({b.type})</MenuItem>
                        ))}
                    </TextField>
                    <TextField
                        label="Default values (JSON)" fullWidth size="small" multiline minRows={4}
                        value={form.defaults} onChange={(e) => setForm({ ...form, defaults: e.target.value })}
                        InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
                        helperText='Preset data merged into a node when dropped. e.g. { "tool": "query_sqlite", "args": { "query": "SELECT 1" } }'
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={save}>{editing ? 'Save' : 'Create'}</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
