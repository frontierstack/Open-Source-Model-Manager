import React, { useEffect, useState } from 'react';
import {
    Card, CardContent, Typography, Box, Select, MenuItem, ToggleButtonGroup, ToggleButton,
    Switch, Chip, Alert, Collapse, Button,
} from '@mui/material';
import GroupWorkIcon from '@mui/icons-material/GroupWork';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BoltIcon from '@mui/icons-material/Bolt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

// Server-wide model roles for a two-model setup — set here by an admin, shown
// read-only to everyone else. PRIMARY is the main model: it does the work and
// writes every answer the user sees. HELPER is a faster second model that works
// ALONGSIDE it — a first pass before the primary starts, background legwork on
// its own GPU while the primary writes, a review afterwards, and (optionally) a
// review of each parallel worker agent's report. The helper never writes the
// answer. Only meaningful with two DIFFERENT models. Per-user chat Settings can
// override each field. Reads/writes /api/model-roles.

const DEFAULTS = {
    primary: '',
    helper: '',
    mode: 'auto',          // off | auto | always
    firstPass: true,
    legwork: true,
    review: 'off',         // off | note | edit
    checkWorkers: false,
};

const PLACEHOLDER_PRIMARY = 'the model picked in the chat';

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

const toggleSx = {
    flexWrap: 'wrap',
    '& .MuiToggleButton-root': { textTransform: 'none', px: 1.5, fontSize: '0.8rem', lineHeight: 1.3 },
};

// ---------------------------------------------------------------- helpers ---

const speedOf = (running, name) => {
    const m = running.find((x) => x.name === name);
    const v = m ? Number(m.tokensPerSecond) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
};

const fmtSpeed = (v) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} tok/s`;

// Running models first, then models with a measured speed, then by speed in the
// direction that puts the likely pick for this role at the top.
const sortNames = (names, running, dir) => {
    const rows = names.map((n) => ({
        n,
        s: speedOf(running, n),
        r: running.some((m) => m.name === n),
    }));
    rows.sort((a, b) => {
        if (a.r !== b.r) return a.r ? -1 : 1;
        if ((a.s === null) !== (b.s === null)) return a.s === null ? 1 : -1;
        if (a.s !== null && b.s !== null && a.s !== b.s) return dir === 'fastest' ? b.s - a.s : a.s - b.s;
        return a.n.localeCompare(b.n);
    });
    return rows.map((x) => x.n);
};

// Build the ordered list of steps that will actually run on the next chat turn,
// from the current selections. Pure — the "What happens on a turn" panel is
// nothing but a render of this.
export function buildTurnPlan(roles, running = []) {
    const primary = roles.primary || PLACEHOLDER_PRIMARY;
    const helper = roles.helper || '';
    const mode = roles.mode || 'off';
    const sameModel = !!(roles.primary && helper && roles.primary === helper);
    const helperActive = !!helper && !sameModel && mode !== 'off';

    if (!helperActive) {
        let reason = null;
        if (mode === 'off') reason = 'The helper is switched off below.';
        else if (!helper) reason = 'No helper model is selected.';
        else if (sameModel) reason = 'The helper is the same model as the primary, so it is ignored — a model does not assist itself.';
        return {
            solo: true,
            primary,
            helper,
            line: `${roles.primary ? primary : 'The model picked in the chat'} answers on its own. No second model is involved.`,
            reason,
            steps: [],
            when: null,
            idle: false,
        };
    }

    const steps = [];
    if (roles.firstPass !== false) {
        steps.push(`${helper} sizes up the task and hands over a brief (a few seconds)`);
    }
    steps.push(`${primary} writes the answer — everything you read is its own words`);
    if (roles.legwork !== false) {
        steps.push(`…handing ${helper} background jobs (look something up, read or list files, run a script and report back) that run at the same time on its own GPU — ${primary} never waits for them`);
    }
    if (roles.checkWorkers === true) {
        steps.push(`When the turn fans work out to parallel worker agents, ${helper} reviews each worker's report before ${primary} builds on it`);
    }
    const review = roles.review || 'off';
    if (review === 'note') {
        steps.push(`${helper} reviews the finished answer and adds a note underneath it`);
    } else if (review === 'edit') {
        steps.push(`${helper} reviews the finished answer and hands back a corrected version in its place`);
    }

    const when = mode === 'always'
        ? 'On every turn.'
        : 'Only on substantial work — building something, analysing a file, a multi-step request. A quick question stays a single fast turn.';

    const idle = steps.length === 1; // only "the primary writes the answer"
    const speeds = { primary: speedOf(running, roles.primary), helper: speedOf(running, helper) };

    return { solo: false, primary, helper, steps, when, idle, speeds, reason: null, line: null };
}

// --------------------------------------------------------------- pieces -----

// Wraps the two model names in <strong> wherever they appear in a step line.
function Highlighted({ text, names }) {
    const marks = (names || []).filter(Boolean).sort((a, b) => b.length - a.length);
    let parts = [text];
    marks.forEach((m) => {
        const next = [];
        parts.forEach((p) => {
            if (typeof p !== 'string') { next.push(p); return; }
            p.split(m).forEach((chunk, i) => {
                if (i) next.push(<strong key={`m${next.length}`}>{m}</strong>);
                if (chunk) next.push(chunk);
            });
        });
        parts = next;
    });
    return <>{parts.map((p, i) => <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}

function RoleTile({ icon, title, blurb, value, placeholder, options, running, disabled, onChange, accent }) {
    const isRunning = (name) => running.some((m) => m.name === name);
    const slotsOf = (name) => (running.find((m) => m.name === name) || {}).slots;
    const meta = (name) => {
        const bits = [];
        const s = speedOf(running, name);
        if (s) bits.push(fmtSpeed(s));
        const slots = slotsOf(name);
        if (slots) bits.push(`${slots} slot${slots > 1 ? 's' : ''}`);
        if (!isRunning(name)) bits.push('not running');
        return bits.join(' · ');
    };
    return (
        <Box sx={tileSx(!!value && accent)}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {icon}
                <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>{title}</Typography>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, minHeight: { xs: 0, md: 40 } }}>{blurb}</Typography>
            <Select
                size="small"
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                displayEmpty
                disabled={disabled}
                sx={selectSx}
                renderValue={(v) => (v
                    ? (
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {v}
                            {meta(v) ? <span style={{ opacity: 0.6 }}> · {meta(v)}</span> : null}
                        </span>
                    )
                    : <span style={{ opacity: 0.6 }}>{placeholder}</span>)}
            >
                <MenuItem value=""><em>{placeholder}</em></MenuItem>
                {options.map((n) => (
                    <MenuItem key={n} value={n}>
                        {n}
                        {meta(n) ? <span style={{ opacity: 0.6, marginLeft: 8, fontSize: '0.8em' }}>· {meta(n)}</span> : null}
                    </MenuItem>
                ))}
            </Select>
        </Box>
    );
}

function OptionRow({ title, help, control, dim }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 1.25, opacity: dim ? 0.5 : 1, flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 0, flex: '1 1 240px' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{help}</Typography>
            </Box>
            <Box sx={{ flexShrink: 0 }}>{control}</Box>
        </Box>
    );
}

// The centrepiece: the plan for the next turn, rendered from the selections.
function TurnPlanPanel({ plan }) {
    const names = [plan.primary, plan.helper];
    return (
        <Box
            sx={{
                mt: 2,
                p: { xs: 1.5, md: 2 },
                borderRadius: 2,
                border: '1px solid var(--accent-primary, rgba(255,255,255,0.2))',
                borderLeft: '3px solid var(--accent-primary)',
                bgcolor: 'var(--bg-tertiary, rgba(255,255,255,0.04))',
            }}
        >
            <Typography variant="overline" sx={{ color: 'var(--accent-primary)', letterSpacing: 0.6, display: 'block', mb: 0.5 }}>
                What happens on a turn
            </Typography>

            {plan.solo ? (
                <>
                    <Typography variant="body2">
                        <Highlighted text={plan.line} names={names} />
                    </Typography>
                    {plan.reason && (
                        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.75 }}>
                            {plan.reason}
                        </Typography>
                    )}
                </>
            ) : (
                <>
                    <Box component="ol" sx={{ m: 0, pl: 2.5, lineHeight: 1.7 }}>
                        {plan.steps.map((s, i) => (
                            <Typography component="li" variant="body2" key={i} sx={{ mb: 0.25, wordBreak: 'break-word' }}>
                                <Highlighted text={s} names={names} />
                            </Typography>
                        ))}
                    </Box>
                    {plan.idle && (
                        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.75 }}>
                            No helper job is switched on, so <strong>{plan.helper}</strong> sits idle. Turn one on below.
                        </Typography>
                    )}
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                        {plan.when}
                    </Typography>
                </>
            )}
        </Box>
    );
}

// --------------------------------------------------------------- the card ---

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
            if (d.roles) setRoles({ ...DEFAULTS, ...d.roles });
            setSavedAt(Date.now());
        } catch (e) {
            setError(e.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const names = [...new Set([...running.map((m) => m.name), roles.primary, roles.helper].filter(Boolean))];
    const disabled = loading || saving || !isAdmin;
    const mode = roles.mode || 'off';
    const same = !!(roles.primary && roles.helper && roles.primary === roles.helper);
    const helperActive = !!roles.helper && !same && mode !== 'off';
    const jobsDisabled = disabled || !roles.helper || same || mode === 'off';
    const plan = buildTurnPlan(roles, running);

    const primarySpeed = speedOf(running, roles.primary);
    const helperSpeed = speedOf(running, roles.helper);
    const speedBackwards = !!(helperActive && primarySpeed && helperSpeed && helperSpeed < primarySpeed);

    return (
        <Card sx={{ mb: 2 }}>
            <CardContent>
                {/* Header */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <GroupWorkIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />
                    <Typography variant="h6" sx={{ mr: 1 }}>Model roles</Typography>
                    {savedAt > 0 && Date.now() - savedAt < 4000 && <Chip size="small" label="Saved" color="success" sx={{ fontSize: '0.7rem' }} />}
                    <Box sx={{ flex: 1 }} />
                    <Button
                        size="small"
                        onClick={() => setShowHelp((v) => !v)}
                        endIcon={<ExpandMoreIcon sx={{ transform: showHelp ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />}
                        sx={{ textTransform: 'none' }}
                    >
                        How it works
                    </Button>
                </Box>
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, mb: 2 }}>
                    Your main model does the work and writes the answers. A second, faster model works alongside it — a quick first pass,
                    background jobs on its own GPU while the main model writes, and a review at the end. Needs two different models loaded.
                </Typography>

                <Collapse in={showHelp}>
                    <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'var(--bg-tertiary, rgba(255,255,255,0.03))', border: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }} component="div">
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                                <li><strong>Primary</strong> is the main model — usually the bigger, smarter, slower one. It does the work, and every word you read is written by it.</li>
                                <li><strong>Helper</strong> is a faster second model that works beside it. It never writes the answer.</li>
                                <li><strong>First pass:</strong> before the primary starts, the helper spends a few seconds restating the task, gathering anything cheap, and handing over a short brief.</li>
                                <li><strong>Legwork:</strong> while the primary writes, it hands the helper background jobs — lookups, file reads, a script to run and report back. They run on the helper&apos;s own GPU at the same time, so the primary never waits. This is where the time is won.</li>
                                <li><strong>Review:</strong> when the primary finishes, the helper can add a note under the answer, or hand back a corrected version in its place.</li>
                                <li><strong>Worker reports:</strong> when a turn fans work out to parallel worker agents, the helper can review each report before the primary builds on it.</li>
                                <li>Pick the <em>faster</em> model as the helper — the tok/s next to each name tells you which is which. A slower helper just costs time.</li>
                                <li>With a single model, even with several parallel slots, none of this applies: a model does not assist itself.</li>
                                <li>{isAdmin ? 'Changes save immediately for everyone; each user can override them in the chat Settings.' : 'Only an administrator can change these; you can override them for yourself in the chat Settings.'}</li>
                            </ul>
                        </Typography>
                    </Box>
                </Collapse>

                {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
                {!loading && running.length === 0 && (
                    <Alert severity="info" sx={{ mb: 2 }}>No model is running yet. Load a model — two, to use a helper — then assign the roles here.</Alert>
                )}
                {!loading && running.length === 1 && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                        Only <strong>{running[0].name}</strong> is running. The helper needs a second model loaded on its own slot, otherwise
                        the primary works alone.
                    </Alert>
                )}

                {/* Role pickers */}
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch', flexDirection: { xs: 'column', md: 'row' } }}>
                    <RoleTile
                        icon={<PsychologyIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />}
                        title="Primary — does the work"
                        blurb="The main model, usually the bigger and slower one. It writes every answer you see."
                        value={roles.primary}
                        placeholder="Use the model picked in the chat"
                        options={sortNames(names, running, 'slowest')}
                        running={running}
                        disabled={disabled}
                        accent
                        onChange={(v) => save({ primary: v })}
                    />
                    <RoleTile
                        icon={<BoltIcon fontSize="small" sx={{ color: helperActive ? 'var(--accent-primary)' : 'text.secondary' }} />}
                        title="Helper — assists it"
                        blurb="A faster second model that works alongside the primary. It never writes the answer."
                        value={roles.helper}
                        placeholder="None — the primary works alone"
                        options={sortNames(names, running, 'fastest')}
                        running={running}
                        disabled={disabled}
                        accent={helperActive}
                        onChange={(v) => save({ helper: v })}
                    />
                </Box>

                {same && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                        Primary and helper are the same model, so the helper is ignored — a model does not assist itself. Load a second,
                        faster model and select it as the helper.
                    </Alert>
                )}
                {speedBackwards && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                        The helper is <strong>slower</strong> than the primary ({fmtSpeed(helperSpeed)} vs {fmtSpeed(primarySpeed)}) — that is backwards
                        and costs you time. Swap them, or pick a lighter model as the helper.
                    </Alert>
                )}

                {/* The centrepiece: what will actually happen */}
                <TurnPlanPanel plan={plan} />

                {/* When the pair works together */}
                <Box sx={{ mt: 2, pt: 1, borderTop: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                    <OptionRow
                        title="When the helper joins in"
                        help="Off keeps the primary working alone. Only when it helps skips short factual questions, so they stay a single fast turn."
                        dim={!roles.helper || same}
                        control={(
                            <ToggleButtonGroup
                                size="small"
                                exclusive
                                value={mode}
                                onChange={(e, v) => { if (v) save({ mode: v }); }}
                                disabled={disabled}
                                sx={toggleSx}
                            >
                                <ToggleButton value="off">Off</ToggleButton>
                                <ToggleButton value="auto">Only when it helps</ToggleButton>
                                <ToggleButton value="always">Every turn</ToggleButton>
                            </ToggleButtonGroup>
                        )}
                    />
                </Box>

                {/* What the helper does */}
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.6 }}>
                        What the helper does
                        {!roles.helper ? ' — select a helper to enable' : same ? ' — needs a different model' : mode === 'off' ? ' — switched off above' : ''}
                    </Typography>
                    <OptionRow
                        title="First pass, before the primary starts"
                        help="A few seconds on the helper: restate the task, gather anything cheap, hand the primary a short brief to start from."
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.firstPass !== false} disabled={jobsDisabled} onChange={(e) => save({ firstPass: e.target.checked })} />}
                    />
                    <OptionRow
                        title="Legwork, while the primary writes"
                        help="The primary hands off background jobs — look something up, read or list files, run a script and report back. They run at the same time on the helper's GPU; the primary does not wait."
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.legwork !== false} disabled={jobsDisabled} onChange={(e) => save({ legwork: e.target.checked })} />}
                    />
                    <OptionRow
                        title="Review, after the primary finishes"
                        help="Add a note leaves the answer alone and appends the helper's verdict underneath. Rewrite it hands back the helper's corrected version in place."
                        dim={jobsDisabled}
                        control={(
                            <ToggleButtonGroup
                                size="small"
                                exclusive
                                value={roles.review || 'off'}
                                onChange={(e, v) => { if (v) save({ review: v }); }}
                                disabled={jobsDisabled}
                                sx={toggleSx}
                            >
                                <ToggleButton value="off">Off</ToggleButton>
                                <ToggleButton value="note">Add a note</ToggleButton>
                                <ToggleButton value="edit">Rewrite it</ToggleButton>
                            </ToggleButtonGroup>
                        )}
                    />
                    <OptionRow
                        title="Check worker reports"
                        help="When the chat fans work out to parallel worker agents, each worker's report goes to the helper before the primary builds on it."
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.checkWorkers === true} disabled={jobsDisabled} onChange={(e) => save({ checkWorkers: e.target.checked })} />}
                    />
                </Box>
            </CardContent>
        </Card>
    );
}
