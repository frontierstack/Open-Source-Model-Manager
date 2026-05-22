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

// Friendly explanations for each configurable field a built-in exposes, so the
// detail card explains how the block is set up rather than just listing keys.
const FIELD_HELP = {
    cron:         'Cron expression (min hour dom mon dow), e.g. "0 9 * * 1-5".',
    intervalMs:   'Fixed interval in milliseconds (minimum 60000) — used instead of cron.',
    event:        'System event name to listen for, e.g. "model.loaded".',
    prompt:       'User prompt sent to the model. Leave blank to receive the upstream node\'s output automatically, or template with {{last}} / {{nodes.id.field}}.',
    systemPrompt: 'Optional system prompt that frames the model\'s behavior.',
    model:        'Which loaded model to run (defaults to the current model).',
    temperature:  'Sampling temperature (higher = more random).',
    maxTokens:    'Maximum tokens to generate in the response.',
    query:        'Search query string.',
    limit:        'Maximum number of results to return.',
    url:          'URL to fetch and extract content from.',
    maxLength:    'Maximum characters of extracted content to keep.',
    args:         'Arguments object (JSON) passed to the underlying tool/skill. Values support {{...}} templating.',
    tool:         'Name of the skill or native tool to invoke.',
    ms:           'How long to pause, in milliseconds.',
    name:         'Variable name to store in the run scope.',
    value:        'Value to store (supports {{...}} templating).',
    condition:    'Condition to evaluate — { left, op, right } or a {{...}} expression.',
    cases:        'Array of { equals, handle } cases; the first match routes the flow, else "default".',
    source:       'JSON string or value to parse. Leave blank to use the previous node\'s output.',
    path:         'Dotted path to extract, e.g. "results.0.title". Blank passes the whole object through.',
    html:         'HTML (or text) to render. Leave blank to wrap the previous node\'s output.',
    format:       'Output file format: txt, csv, json, md, html, or pdf.',
    filename:     'Output filename (the extension is added automatically if omitted).',
    content:      'File contents. Leave blank to use the previous node\'s output.',
    webhookUrl:   'Slack Incoming Webhook URL (from your Slack app settings).',
    text:         'Message text to send. Leave blank to send the previous node\'s output.',
    botToken:     'Telegram bot token from @BotFather.',
    chatId:       'Telegram chat id (a number, or @channelname).',
    keyword:      'For the Telegram trigger: only fire when the message text matches (blank = any message).',
    match:        'How to match the keyword: contains (default), equals, startsWith, or regex.',
    forward:      'Optional output mapping — what this node passes to the next node. Blank forwards the whole output; drag data tags to forward only specific fields.',
};

// Build a starter "Default values" object for a built-in: its own presets plus a
// blank slot for each configurable field, so the author sees exactly what they
// can preset and just fills in the values.
function buildDefaultsSkeleton(b) {
    if (!b) return {};
    const out = { ...(b.defaults || {}) };
    for (const f of (b.fields || [])) {
        if (out[f] !== undefined) continue;
        out[f] = f === 'args' ? {} : f === 'cases' ? [] : '';
    }
    return out;
}

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
    const [detail, setDetail] = useState(null); // built-in being inspected

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
                                <Card
                                    variant="outlined"
                                    onClick={() => setDetail(t)}
                                    role="button" tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(t); } }}
                                    sx={{ ...cardSx, cursor: 'pointer', transition: 'border-color 0.15s, background-color 0.15s', '&:hover': { borderColor: 'var(--accent-primary)', bgcolor: 'var(--bg-hover)' } }}
                                >
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

            {/* Built-in detail dialog */}
            <Dialog open={!!detail} onClose={() => setDetail(null)} maxWidth="sm" fullWidth>
                {detail && (() => {
                    const inputs = Array.isArray(detail.inputs) ? detail.inputs : [];
                    const outputs = Array.isArray(detail.outputs) ? detail.outputs : [];
                    const fields = Array.isArray(detail.fields) ? detail.fields : [];
                    const hasDefaults = detail.defaults && Object.keys(detail.defaults).length > 0;
                    return (
                        <>
                            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                {detail.label}
                                <Chip label="Built-in" size="small" variant="outlined" sx={{ height: 20 }} />
                                <IconButton size="small" onClick={() => setDetail(null)} sx={{ ml: 'auto' }}><ClearIcon size={16} /></IconButton>
                            </DialogTitle>
                            <DialogContent dividers>
                                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                    {detail.description}
                                </Typography>

                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
                                    <Chip label={`type: ${detail.type}`} size="small" sx={{ height: 22, bgcolor: 'var(--accent-muted)', color: 'var(--accent-primary)' }} />
                                    <Chip label={`category: ${meta.label}`} size="small" variant="outlined" sx={{ height: 22 }} />
                                    {detail.defaults?.tool && (
                                        <Chip label={`tool: ${detail.defaults.tool}`} size="small" variant="outlined" sx={{ height: 22 }} />
                                    )}
                                </Box>

                                <Typography variant="overline" color="text.secondary">Handles</Typography>
                                <Box sx={{ display: 'flex', gap: 3, mb: 2, mt: 0.5 }}>
                                    <Box>
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Inputs</Typography>
                                        {inputs.length ? inputs.map((h) => (
                                            <Chip key={h} label={h} size="small" variant="outlined" sx={{ height: 20, mr: 0.5, mb: 0.5 }} />
                                        )) : <Typography variant="caption" color="text.secondary">— none (entry point)</Typography>}
                                    </Box>
                                    <Box>
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Outputs</Typography>
                                        {outputs.length ? outputs.map((h) => (
                                            <Chip key={h} label={h} size="small" variant="outlined" sx={{ height: 20, mr: 0.5, mb: 0.5 }} />
                                        )) : <Typography variant="caption" color="text.secondary">— none (terminal)</Typography>}
                                    </Box>
                                </Box>

                                <Typography variant="overline" color="text.secondary">Configurable fields</Typography>
                                {fields.length ? (
                                    <Box component="ul" sx={{ pl: 2, mt: 0.5, mb: 2 }}>
                                        {fields.map((f) => (
                                            <Box component="li" key={f} sx={{ mb: 0.75 }}>
                                                <Typography variant="body2" component="span" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>{f}</Typography>
                                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                                    {FIELD_HELP[f] || 'Configured per node in the editor.'}
                                                </Typography>
                                            </Box>
                                        ))}
                                    </Box>
                                ) : (
                                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                                        No configuration — this block works as-is.
                                    </Typography>
                                )}

                                {hasDefaults && (<>
                                    <Typography variant="overline" color="text.secondary">Preset values</Typography>
                                    <Box component="pre" sx={{ mt: 0.5, mb: 2, p: 1.25, bgcolor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'auto' }}>
                                        {JSON.stringify(detail.defaults, null, 2)}
                                    </Box>
                                </>)}

                                <Alert severity="info" sx={{ mt: 1 }}>
                                    Drag this block onto the canvas in the chat <strong>Automation</strong> editor, then set its fields per node. To make a reusable preset, click <strong>New {meta.singular}</strong> and choose <em>{detail.type}</em> as the base type.
                                </Alert>
                            </DialogContent>
                            <DialogActions>
                                <Button onClick={() => setDetail(null)}>Close</Button>
                            </DialogActions>
                        </>
                    );
                })()}
            </Dialog>

            {/* Create / Edit dialog */}
            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{editing ? `Edit ${meta.singular}` : `New ${meta.singular}`}</DialogTitle>
                <DialogContent>
                    {(() => {
                        // Resolve which built-in the current form maps to, for live
                        // field guidance under the JSON editor.
                        let parsed = {};
                        try { parsed = form.defaults.trim() ? JSON.parse(form.defaults) : {}; } catch (_) { /* mid-edit */ }
                        const activeBuiltin =
                            (parsed.tool && builtins.find(b => b.defaults?.tool === parsed.tool)) ||
                            builtins.find(b => b.type === form.baseType) || null;
                        const guideFields = (activeBuiltin && Array.isArray(activeBuiltin.fields)) ? activeBuiltin.fields : [];
                        const applyTemplate = (b) => {
                            setForm(prev => ({
                                ...prev,
                                baseType: b.type,
                                description: prev.description || b.description || '',
                                defaults: JSON.stringify(buildDefaultsSkeleton(b), null, 2),
                            }));
                        };
                        return (<>
                            <Alert severity="info" sx={{ mt: 1, mb: 2 }}>
                                A custom {meta.singular.toLowerCase()} is a built-in primitive plus <strong>preset values</strong>.
                                It then appears in the editor palette ready to drop in. Pick a starting point below,
                                fill in the values you want baked in, and save.
                            </Alert>
                            <TextField
                                label="Name" fullWidth size="small" sx={{ mb: 2 }}
                                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                                autoFocus
                                helperText={`How it appears in the palette, e.g. "${category === 'trigger' ? 'Every weekday 9am' : category === 'gate' ? 'Only if score > 80' : 'Search cybersecurity news'}".`}
                            />
                            {!editing && (
                                <TextField
                                    select label="Start from a built-in" fullWidth size="small" sx={{ mb: 2 }}
                                    value="" displayEmpty
                                    onChange={(e) => { const b = builtins.find(x => (x.key || x.type) === e.target.value); if (b) applyTemplate(b); }}
                                    helperText="Loads that block's fields into the defaults below as a starting template."
                                >
                                    <MenuItem value="" disabled>Choose a built-in to start from…</MenuItem>
                                    {builtins.map((b) => (
                                        <MenuItem key={b.key || b.type} value={b.key || b.type}>{b.label}</MenuItem>
                                    ))}
                                </TextField>
                            )}
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
                                helperText='Preset data merged into a node when dropped. Keep only the fields you want baked in; remove the rest.'
                            />
                            {guideFields.length > 0 && (
                                <Box sx={{ mt: 1.5, p: 1.25, bgcolor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 1 }}>
                                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                                        Fields you can preset for {activeBuiltin.label}:
                                    </Typography>
                                    <Box component="ul" sx={{ pl: 2, m: 0 }}>
                                        {guideFields.map((f) => (
                                            <Box component="li" key={f} sx={{ mb: 0.5 }}>
                                                <Typography variant="caption" component="span" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>{f}</Typography>
                                                <Typography variant="caption" color="text.secondary"> — {FIELD_HELP[f] || 'configured per node.'}</Typography>
                                            </Box>
                                        ))}
                                    </Box>
                                </Box>
                            )}
                        </>);
                    })()}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={save}>{editing ? 'Save' : 'Create'}</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
