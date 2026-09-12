import React, { useEffect, useState } from 'react';
import {
    Card, CardContent, Typography, Box, Select, MenuItem, ToggleButtonGroup, ToggleButton,
    Switch, Chip, Alert, Collapse, Button,
} from '@mui/material';
import GroupWorkIcon from '@mui/icons-material/GroupWork';
import BoltIcon from '@mui/icons-material/Bolt';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

// Server-wide model roles for a two-model setup — set here by an admin, shown
// read-only to everyone else. PRIMARY does the work (the chat's worker agents
// run on it; pick it as the composer's model too), the CHECKER reviews or
// edits what the primary produced and answers its consult_expert questions.
// Only meaningful with two DIFFERENT models; the server ignores a checker that
// is the same model as the primary. Per-user chat Settings can override each
// field. Reads/writes /api/model-roles.

const DEFAULTS = { primary: '', checker: '', checkWorkers: true, checkFinal: 'off', consult: true };

const tileSx = (active) => ({
    flex: 1,
    minWidth: 0,
    p: 2,
    borderRadius: 2,
    border: '1px solid',
    borderColor: active ? 'var(--accent-primary)' : 'var(--border-primary, rgba(255,255,255,0.12))',
    bgcolor: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
});

const selectSx = {
    mt: 1,
    width: '100%',
    '& .MuiSelect-select': { py: 1, fontSize: '0.9rem' },
};

function RoleTile({ icon, title, blurb, value, placeholder, options, running, disabled, onChange }) {
    const isRunning = (name) => running.some((m) => m.name === name);
    const slotsOf = (name) => (running.find((m) => m.name === name) || {}).slots;
    return (
        <Box sx={tileSx(!!value)}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {icon}
                <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{title}</Typography>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, minHeight: 40 }}>{blurb}</Typography>
            <Select
                size="small"
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                displayEmpty
                disabled={disabled}
                sx={selectSx}
                renderValue={(v) => (v
                    ? <span>{v}{isRunning(v) ? '' : <span style={{ opacity: 0.6 }}> · not running</span>}</span>
                    : <span style={{ opacity: 0.6 }}>{placeholder}</span>)}
            >
                <MenuItem value=""><em>{placeholder}</em></MenuItem>
                {options.map((n) => (
                    <MenuItem key={n} value={n}>
                        {n}
                        {slotsOf(n) ? <span style={{ opacity: 0.6, marginLeft: 8, fontSize: '0.8em' }}>{slotsOf(n)} slot{slotsOf(n) > 1 ? 's' : ''}</span> : null}
                        {!isRunning(n) && <span style={{ opacity: 0.6, marginLeft: 8, fontSize: '0.8em' }}>not running</span>}
                    </MenuItem>
                ))}
            </Select>
        </Box>
    );
}

function OptionRow({ title, help, control, dim }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 1.25, opacity: dim ? 0.5 : 1, flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 0, flex: '1 1 260px' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{help}</Typography>
            </Box>
            <Box sx={{ flexShrink: 0 }}>{control}</Box>
        </Box>
    );
}

export default function ModelRolesCard({ instances = [], isAdmin = false }) {
    const [roles, setRoles] = useState(DEFAULTS);
    const [running, setRunning] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [savedAt, setSavedAt] = useState(0);
    const [showHelp, setShowHelp] = useState(false);

    const load = () => {
        fetch('/api/model-roles', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d) => {
                setRoles({ ...DEFAULTS, ...(d.roles || {}) });
                setRunning(Array.isArray(d.running) ? d.running : []);
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    };
    useEffect(() => { load(); }, []);
    // Refresh the running list when the instance list the page holds changes.
    useEffect(() => { if (!loading) load(); /* eslint-disable-next-line */ }, [instances.length]);

    const save = async (patch) => {
        const next = { ...roles, ...patch };
        setRoles(next);
        if (!isAdmin) return;
        setSaving(true);
        setError(null);
        try {
            const r = await fetch('/api/model-roles', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(next),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (d.roles) setRoles(d.roles);
            setSavedAt(Date.now());
        } catch (e) {
            setError(e.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const names = [...new Set([...running.map((m) => m.name), roles.primary, roles.checker].filter(Boolean))];
    const disabled = loading || saving || !isAdmin;
    const same = !!(roles.primary && roles.checker && roles.primary === roles.checker);
    const checkerActive = !!roles.checker && !same;
    const primaryLabel = roles.primary || 'the model picked in the chat';
    const checkerLabel = roles.checker || 'none';
    const afterLabel = roles.checkFinal === 'edit' ? 'refines it before you see it' : roles.checkFinal === 'note' ? 'adds a review note under it' : 'does nothing';

    return (
        <Card sx={{ mb: 2 }}>
            <CardContent>
                {/* Header */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <GroupWorkIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />
                    <Typography variant="h6" sx={{ mr: 1 }}>Model roles</Typography>
                    {savedAt > 0 && Date.now() - savedAt < 4000 && <Chip size="small" label="Saved" color="success" sx={{ fontSize: '0.7rem' }} />}
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" onClick={() => setShowHelp((v) => !v)} endIcon={<ExpandMoreIcon sx={{ transform: showHelp ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />} sx={{ textTransform: 'none' }}>
                        How it works
                    </Button>
                </Box>
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, mb: 2 }}>
                    A fast model drafts the answer, then hands it to a stronger one that refines it. Needs two different models loaded — one slot each is enough.
                </Typography>

                <Collapse in={showHelp}>
                    <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'var(--bg-tertiary, rgba(255,255,255,0.03))', border: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }} component="div">
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                                <li><strong>Primary</strong> runs the chat and the parallel worker agents. Pick it as the chat's model too.</li>
                                <li>When the primary is stuck, it can ask the <strong>checker</strong> one question (the <span style={{ fontFamily: 'monospace' }}>consult_expert</span> tool) and carry on with the answer.</li>
                                <li>Everything the primary produces can be passed on to the <strong>checker</strong>: each worker agent's report, and — if you turn it on below — the finished answer, which the checker either annotates or hands back rewritten.</li>
                                <li>With a single model, even with several parallel slots, nothing here applies: a model does not check itself.</li>
                                <li>{isAdmin ? 'Changes save immediately for everyone; each user can override them in the chat Settings.' : 'Only an administrator can change these; you can override them for yourself in the chat Settings.'}</li>
                            </ul>
                        </Typography>
                    </Box>
                </Collapse>

                {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
                {running.length === 0 && !loading && (
                    <Alert severity="info" sx={{ mb: 2 }}>No model is running yet. Load the models first, then assign the roles here.</Alert>
                )}

                {/* Role tiles */}
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch', flexDirection: { xs: 'column', md: 'row' } }}>
                    <RoleTile
                        icon={<BoltIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />}
                        title="Primary — does the work"
                        blurb="Usually the smaller, faster model. Runs the chat and the worker agents."
                        value={roles.primary}
                        placeholder="Use the model picked in the chat"
                        options={names}
                        running={running}
                        disabled={disabled}
                        onChange={(v) => save({ primary: v })}
                    />
                    <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', color: 'text.secondary' }}>
                        <ArrowForwardIcon fontSize="small" />
                    </Box>
                    <RoleTile
                        icon={<FactCheckIcon fontSize="small" sx={{ color: checkerActive ? 'var(--accent-primary)' : 'text.secondary' }} />}
                        title="Checker — reviews it"
                        blurb="The larger, smarter model. Receives the primary's draft and hands back a refined version, and answers its questions."
                        value={roles.checker}
                        placeholder="None — no checking"
                        options={names}
                        running={running}
                        disabled={disabled}
                        onChange={(v) => save({ checker: v })}
                    />
                </Box>

                {same && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                        Primary and checker are the same model, so the checker is ignored. Load a second, stronger model and select it as the checker.
                    </Alert>
                )}

                {/* Summary line */}
                <Typography variant="body2" sx={{ mt: 2, color: 'text.secondary' }}>
                    Right now: <strong>{primaryLabel}</strong> does the work
                    {checkerActive ? <> and <strong>{checkerLabel}</strong> {afterLabel === 'does nothing' ? 'checks worker reports only' : afterLabel}</> : <>; no checker is active</>}.
                </Typography>

                {/* Checker options */}
                <Box sx={{ mt: 2, pt: 1, borderTop: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.6 }}>
                        What the checker does with the primary's work{!checkerActive ? ' — select a checker to enable' : ''}
                    </Typography>
                    <OptionRow
                        title="The finished answer, before you see it"
                        help="The primary's draft goes to the checker with the evidence behind it. Add a note leaves the answer alone and appends the checker's verdict underneath. Refine it hands back the checker's corrected version in place, with a list of what it changed."
                        dim={!checkerActive}
                        control={(
                            <ToggleButtonGroup
                                size="small"
                                exclusive
                                value={roles.checkFinal || 'off'}
                                onChange={(e, v) => { if (v) save({ checkFinal: v }); }}
                                disabled={disabled || !checkerActive}
                                sx={{ '& .MuiToggleButton-root': { textTransform: 'none', px: 1.5, fontSize: '0.8rem' } }}
                            >
                                <ToggleButton value="off">Send it as is</ToggleButton>
                                <ToggleButton value="note">Add a note</ToggleButton>
                                <ToggleButton value="edit">Refine it</ToggleButton>
                            </ToggleButtonGroup>
                        )}
                    />
                    <OptionRow
                        title="Each worker agent's report"
                        help="A parallel worker's report goes to the checker before the primary builds on it — refined in place when Refine is on, otherwise sent back for one revision round."
                        dim={!checkerActive}
                        control={<Switch size="small" checked={roles.checkWorkers !== false} disabled={disabled || !checkerActive} onChange={(e) => save({ checkWorkers: e.target.checked })} />}
                    />
                    <OptionRow
                        title="Questions while the primary works"
                        help="Lets the primary stop mid-task and ask the checker one question (the consult_expert tool), then carry on with the answer."
                        dim={!checkerActive}
                        control={<Switch size="small" checked={roles.consult !== false} disabled={disabled || !checkerActive} onChange={(e) => save({ consult: e.target.checked })} />}
                    />
                </Box>
            </CardContent>
        </Card>
    );
}
