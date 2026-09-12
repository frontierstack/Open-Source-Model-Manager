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
// read-only to everyone else. PRIMARY is the everyday model: it answers most
// turns on its own, which is what keeps a quick question quick. SECONDARY is
// the model you trust with the hard work: it stays out of
// the way until the ask is substantial, then takes the lead and writes the answer
// itself, while the primary does background legwork for it on its own GPU. Only
// meaningful with two DIFFERENT models. Per-user chat Settings can override each
// field. Reads/writes /api/model-roles.

// Help text under a control must describe what is SELECTED, not list every
// option — the user reads it to confirm the choice they just made.
function describeMode(mode, primaryName, secondaryName) {
    const p = primaryName || 'the primary';
    const sec = secondaryName || 'the secondary';
    if (mode === 'off') return `${p} answers every turn on its own. ${sec} is never brought in.`;
    if (mode === 'always') return `Every turn goes to ${sec}, including one-line questions — those get slower.`;
    return `Short factual questions stay on ${p}. ${sec} takes over only when the ask is substantial — building something, analysing a file, a multi-step request.`;
}

// The remaining switches read better with the real model names in them too.
function describeFirstPass(on, primaryName, secondaryName) {
    const p = primaryName || 'the primary';
    const sec = secondaryName || 'the secondary';
    return on
        ? `${p} spends a few seconds restating the task and gathering anything cheap, then hands ${sec} a short brief to start from.`
        : `${sec} starts cold from the user's message — no brief, no gathering, one less step before it begins.`;
}

function describeLegwork(on, primaryName, secondaryName) {
    const p = primaryName || 'the primary';
    const sec = secondaryName || 'the secondary';
    return on
        ? `While ${sec} writes, it hands jobs back to ${p} — look something up, read or list files, run a script and report back. They run at the same time on ${p}'s own GPU, so ${sec} never waits.`
        : `${sec} does everything itself, including every lookup and file read. ${p} sits idle while it works.`;
}

function describeCheckWorkers(on, primaryName, secondaryName) {
    const sec = secondaryName || 'the secondary';
    return on
        ? `When a turn fans work out to parallel worker agents, each report goes to ${sec} before the answer builds on it — more accurate, but it adds ${sec}'s reading time per worker.`
        : 'Worker reports go straight into the answer without a second read.';
}

function describeReview(review, primaryName, secondaryName) {
    const p = primaryName || 'the primary';
    const sec = secondaryName || 'the secondary';
    if (review === 'note') return `${sec} reads the answer and appends its verdict underneath. The answer itself is left alone.`;
    if (review === 'edit') return `${sec} reads the answer and, when it finds a problem, replaces it with a corrected version and lists what changed.`;
    return `Answers ${p} wrote alone are sent straight through, unread by ${sec}.`;
}

const DEFAULTS = {
    primary: '',
    secondary: '',
    mode: 'auto',          // off | auto | always
    firstPass: true,
    legwork: true,
    review: 'off',         // off | note | edit
    checkWorkers: false,
};

const PLACEHOLDER_PRIMARY = 'the model picked in the chat';
const ROLES_CARD_OPEN_KEY = 'modelRolesCardOpen';

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
    const secondary = roles.secondary || '';
    const mode = roles.mode || 'off';
    const sameModel = !!(roles.primary && secondary && roles.primary === secondary);
    const secondaryActive = !!secondary && !sameModel && mode !== 'off';

    if (!secondaryActive) {
        let reason = null;
        if (mode === 'off') reason = 'The secondary is switched off below.';
        else if (!secondary) reason = 'No secondary model is selected.';
        else if (sameModel) reason = 'The secondary is the same model as the primary, so it is ignored — a model does not hand over to itself.';
        return {
            solo: true,
            primary,
            secondary,
            line: `${roles.primary ? primary : 'The model picked in the chat'} answers every turn on its own. No second model is involved.`,
            summary: `${roles.primary ? primary : 'The model picked in the chat'} answers on its own`,
            reason,
            steps: [],
            when: null,
            caveat: null,
        };
    }

    const always = mode === 'always';
    const steps = [];

    if (!always) {
        steps.push(`${primary} answers the turn — quick questions never leave it`);
        steps.push(roles.firstPass !== false
            ? 'On substantial work it hands over instead: a few seconds sizing up the task, then a brief'
            : 'On substantial work it hands the turn over instead');
    } else if (roles.firstPass !== false) {
        steps.push(`${primary} spends a few seconds sizing up the task, then hands ${secondary} a brief`);
    }

    steps.push(`${secondary} takes the lead and writes the answer`);

    if (roles.legwork !== false) {
        steps.push(`…handing ${primary} background jobs that run at the same time on its own GPU — it never waits for them`);
    }
    if (roles.checkWorkers === true) {
        steps.push(`When the turn fans work out to parallel worker agents, ${secondary} reviews each worker's report before the answer builds on it`);
    }

    // The review is of an answer the PRIMARY wrote alone — on "every turn" the
    // secondary writes them all, so there is nothing left for it to review.
    const review = roles.review || 'off';
    let caveat = null;
    if (review !== 'off' && always) {
        caveat = `Review is on, but on every turn ${secondary} writes the answer itself — there is never a primary-only answer left to review.`;
    } else if (review === 'note') {
        steps.push(`On the turns ${primary} answered alone, ${secondary} reads the answer afterwards and adds a note underneath it`);
    } else if (review === 'edit') {
        steps.push(`On the turns ${primary} answered alone, ${secondary} reads the answer afterwards and hands back a corrected version in its place`);
    }

    const when = always
        ? `On every turn — even a one-line question goes to ${secondary}.`
        : `Only on substantial work — building something, analysing a file, a multi-step request. A quick question stays a single fast turn on ${primary}.`;

    const speeds = { primary: speedOf(running, roles.primary), secondary: speedOf(running, secondary) };
    const summary = `${primary} \u2192 ${secondary} ${always ? 'on every turn' : 'on substantial work'}`;

    return { solo: false, primary, secondary, steps, when, caveat, speeds, summary, reason: null, line: null };
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
    const names = [plan.primary, plan.secondary];
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
                    {plan.caveat && (
                        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: 0.75 }}>
                            <Highlighted text={plan.caveat} names={names} />
                        </Typography>
                    )}
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                        <Highlighted text={plan.when} names={names} />
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
    // The card is configuration people set once, so it starts collapsed and
    // remembers whatever the user last did with it. Private windows throw on
    // localStorage, so every touch is guarded.
    const [open, setOpen] = useState(() => {
        try { return window.localStorage.getItem(ROLES_CARD_OPEN_KEY) === '1'; } catch (e) { return false; }
    });
    const toggleOpen = () => setOpen((v) => {
        const next = !v;
        try { window.localStorage.setItem(ROLES_CARD_OPEN_KEY, next ? '1' : '0'); } catch (e) { /* private window */ }
        return next;
    });

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

    const names = [...new Set([...running.map((m) => m.name), roles.primary, roles.secondary].filter(Boolean))];
    const disabled = loading || saving || !isAdmin;
    const mode = roles.mode || 'off';
    const same = !!(roles.primary && roles.secondary && roles.primary === roles.secondary);
    const secondaryActive = !!roles.secondary && !same && mode !== 'off';
    const jobsDisabled = disabled || !roles.secondary || same || mode === 'off';
    const plan = buildTurnPlan(roles, running);

    const primarySpeed = speedOf(running, roles.primary);
    const secondarySpeed = speedOf(running, roles.secondary);
    // Only the secondary's turns cost its full speed, so the slower model
    // usually belongs there. Flag the reverse as something to double-check —
    // not as an error, since the user may have a reason.
    const speedBackwards = !!(secondaryActive && primarySpeed && secondarySpeed && secondarySpeed > primarySpeed);
    // A problem must never hide behind a collapsed section.
    const forceOpen = !!error || (!loading && running.length === 0);
    const bodyOpen = open || forceOpen;

    return (
        <Card sx={{ mb: 2 }}>
            <CardContent>
                {/* Header — also the toggle for the whole body */}
                <Box
                    role="button"
                    tabIndex={0}
                    aria-expanded={bodyOpen}
                    onClick={toggleOpen}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(); }
                    }}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none' }}
                >
                    <GroupWorkIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />
                    <Typography variant="h6" sx={{ mr: 1 }}>Model roles</Typography>
                    {savedAt > 0 && Date.now() - savedAt < 4000 && <Chip size="small" label="Saved" color="success" sx={{ fontSize: '0.7rem' }} />}
                    {!bodyOpen && (
                        <Typography
                            variant="body2"
                            sx={{ color: 'text.secondary', minWidth: 0, flex: '1 1 180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                            {plan.summary}
                        </Typography>
                    )}
                    <Box sx={{ flex: 1 }} />
                    {bodyOpen && (
                        <Button
                            size="small"
                            onClick={(e) => { e.stopPropagation(); setShowHelp((v) => !v); }}
                            endIcon={<ExpandMoreIcon sx={{ transform: showHelp ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />}
                            sx={{ textTransform: 'none' }}
                        >
                            How it works
                        </Button>
                    )}
                    <ExpandMoreIcon
                        fontSize="small"
                        sx={{ color: 'text.secondary', transform: bodyOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}
                    />
                </Box>

                <Collapse in={bodyOpen}>
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, mb: 2 }}>
                    Your everyday model answers most turns on its own, so a quick question stays quick. When the ask is substantial it hands
                    over to a second model, which writes the answer while the everyday model runs background jobs for it on its own GPU.
                    Needs two different models loaded — which one you put where is up to you.
                </Typography>

                <Collapse in={showHelp}>
                    <Box sx={{ mb: 2, p: 1.5, borderRadius: 2, bgcolor: 'var(--bg-tertiary, rgba(255,255,255,0.03))', border: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }} component="div">
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                                <li><strong>Primary</strong> is your everyday model. It answers most turns on its own, which is what keeps a quick question quick.</li>
                                <li><strong>Secondary</strong> stays out of the way until the ask is substantial, then takes the lead and writes the answer itself. Put the model you trust more with hard work here.</li>
                                <li><strong>First pass:</strong> before the secondary starts, the primary spends a few seconds restating the task, gathering anything cheap, and handing over a short brief.</li>
                                <li><strong>Legwork:</strong> while the secondary writes, it hands background jobs back to the primary — lookups, file reads, a script to run and report back. They run on the primary&apos;s own GPU at the same time, so the secondary never waits. This is where the time is won.</li>
                                <li><strong>Review:</strong> on a turn the primary answered alone, the secondary can add a note under the answer, or hand back a corrected version in its place.</li>
                                <li><strong>Worker reports:</strong> when a turn fans work out to parallel worker agents, the secondary can review each report before the answer builds on it.</li>
                                <li>Only the secondary&apos;s turns cost its full speed, so if one model is much slower than the other it usually belongs there — the tok/s beside each name tells you which is which. Putting the slower model first sends every quick question through it.</li>
                                <li>With a single model, even with several parallel slots, none of this applies: a model does not hand over to itself.</li>
                                <li>{isAdmin ? 'Changes save immediately for everyone; each user can override them in the chat Settings.' : 'Only an administrator can change these; you can override them for yourself in the chat Settings.'}</li>
                            </ul>
                        </Typography>
                    </Box>
                </Collapse>

                {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
                {!loading && running.length === 0 && (
                    <Alert severity="info" sx={{ mb: 2 }}>No model is running yet. Load a model — two, to use a secondary — then assign the roles here.</Alert>
                )}
                {!loading && running.length === 1 && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                        Only <strong>{running[0].name}</strong> is running. The secondary needs a second model loaded on its own slot, otherwise
                        the primary answers everything on its own.
                    </Alert>
                )}

                {/* Role pickers */}
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch', flexDirection: { xs: 'column', md: 'row' } }}>
                    <RoleTile
                        icon={<BoltIcon fontSize="small" sx={{ color: 'var(--accent-primary)' }} />}
                        title="Primary — answers most turns"
                        blurb="Your everyday model. It answers on its own, so quick questions start and finish here."
                        value={roles.primary}
                        placeholder="Use the model picked in the chat"
                        options={sortNames(names, running, 'fastest')}
                        running={running}
                        disabled={disabled}
                        accent
                        onChange={(v) => save({ primary: v })}
                    />
                    <RoleTile
                        icon={<PsychologyIcon fontSize="small" sx={{ color: secondaryActive ? 'var(--accent-primary)' : 'text.secondary' }} />}
                        title="Secondary — takes over the hard ones"
                        blurb="Steps in when the ask is substantial and writes the answer itself, with the primary fetching things for it."
                        value={roles.secondary}
                        placeholder="None — the primary answers everything"
                        options={sortNames(names, running, 'slowest')}
                        running={running}
                        disabled={disabled}
                        accent={secondaryActive}
                        onChange={(v) => save({ secondary: v })}
                    />
                </Box>

                {same && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                        Primary and secondary are the same model, so the secondary is ignored — a model does not hand over to itself. Load a
                        second, stronger model and select it as the secondary.
                    </Alert>
                )}
                {speedBackwards && (
                    <Alert severity="info" sx={{ mt: 2 }}>
                        Worth a check: your secondary is the <strong>faster</strong> of the two ({fmtSpeed(secondarySpeed)} vs {fmtSpeed(primarySpeed)}).
                        Every quick question goes through the primary, so the slower model usually belongs in the secondary slot. Leave it as
                        it is if the secondary really is the one you want on the hard work.
                    </Alert>
                )}

                {/* The centrepiece: what will actually happen */}
                <TurnPlanPanel plan={plan} />

                {/* When the secondary takes over */}
                <Box sx={{ mt: 2, pt: 1, borderTop: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                    <OptionRow
                        title="When the secondary takes over"
                        help={describeMode(mode, roles.primary, roles.secondary)}
                        dim={!roles.secondary || same}
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
                                <ToggleButton value="auto">Only on substantial work</ToggleButton>
                                <ToggleButton value="always">Every turn</ToggleButton>
                            </ToggleButtonGroup>
                        )}
                    />
                </Box>

                {/* How the two split the work */}
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid var(--border-primary, rgba(255,255,255,0.1))' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.6 }}>
                        How the two split the work
                        {!roles.secondary ? ' — select a secondary to enable' : same ? ' — needs a different model' : mode === 'off' ? ' — switched off above' : ''}
                    </Typography>
                    <OptionRow
                        title="First pass, before the secondary starts"
                        help={describeFirstPass(roles.firstPass !== false, roles.primary, roles.secondary)}
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.firstPass !== false} disabled={jobsDisabled} onChange={(e) => save({ firstPass: e.target.checked })} />}
                    />
                    <OptionRow
                        title="Legwork, while the secondary writes"
                        help={describeLegwork(roles.legwork !== false, roles.primary, roles.secondary)}
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.legwork !== false} disabled={jobsDisabled} onChange={(e) => save({ legwork: e.target.checked })} />}
                    />
                    <OptionRow
                        title="Review of the answers the primary wrote alone"
                        help={describeReview(roles.review || 'off', roles.primary, roles.secondary)}
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
                        help={describeCheckWorkers(roles.checkWorkers === true, roles.primary, roles.secondary)}
                        dim={jobsDisabled}
                        control={<Switch size="small" checked={roles.checkWorkers === true} disabled={jobsDisabled} onChange={(e) => save({ checkWorkers: e.target.checked })} />}
                    />
                </Box>
                </Collapse>
            </CardContent>
        </Card>
    );
}
