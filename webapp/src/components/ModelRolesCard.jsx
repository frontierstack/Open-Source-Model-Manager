import React, { useEffect, useState } from 'react';
import { Select, MenuItem, Switch, Alert, Collapse } from '@mui/material';
import { Users } from 'lucide-react';
import ModelsSection from './ModelsSection';
import StrongModelIcon from '@mui/icons-material/WorkspacePremium';
import BoltIcon from '@mui/icons-material/Bolt';

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
    if (mode === 'off') return `${p} answers every turn on its own. ${sec.charAt(0).toUpperCase()}${sec.slice(1)} is never brought in.`;
    if (mode === 'always') return `Every turn with real work goes to ${sec}. Easy turns — a greeting, a summary or rewrite of the last answer, arithmetic, a small code snippet — stay on ${p}. Questions that need knowledge, translation and creative writing still go to ${sec}.`;
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
    if (review === 'note') return `${sec} reads the answer and appends its verdict underneath as a second block. The answer itself is left alone.`;
    if (review === 'edit') return `${p} does the work, ${sec} checks it and corrects it behind the scenes — you get one polished answer, with nothing appended to it. What it changed is recorded beside the message, not inside it. Only answers ${p} wrote alone are polished: on a turn ${sec} leads itself (real work in "All but easy turns", or a substantial ask in "auto") there is nothing for it to check.`;
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

const SELECT_SX = { width: '100%', fontSize: '0.85rem', '& .MuiSelect-select': { py: 1 } };

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
            ? 'On substantial work it hands over instead, after a second or two planning any background lookups'
            : 'On substantial work it hands the turn over instead');
    } else {
        steps.push(`${primary} answers easy turns itself — greetings, summaries or rewrites of the last answer, arithmetic, small code snippets`);
        steps.push(roles.firstPass !== false
            ? `Every other turn it hands to ${secondary}, after a second or two planning any background lookups`
            : `Every other turn it hands straight to ${secondary}`);
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
    const caveat = null;
    if (review === 'note') {
        steps.push(`On the turns ${primary} answered alone, ${secondary} reads the answer afterwards and adds a note underneath it`);
    } else if (review === 'edit') {
        steps.push(`On the turns ${primary} answered alone, ${secondary} reads the answer afterwards and hands back a corrected version in its place`);
    }

    const when = always
        ? `On every turn with real work. Easy turns stay a single fast turn on ${primary}.`
        : `Only on substantial work — building something, analysing a file, a multi-step request. A quick question stays a single fast turn on ${primary}.`;

    const speeds = { primary: speedOf(running, roles.primary), secondary: speedOf(running, secondary) };
    const summary = `${primary} \u2192 ${secondary} ${always ? 'on every turn except easy ones' : 'on substantial work'}`;

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

function RoleTile({ icon, title, blurb, value, placeholder, options, running, disabled, onChange, active }) {
    const isRunning = (name) => running.some((m) => m.name === name);
    const slotsOf = (name) => (running.find((m) => m.name === name) || {}).slots;
    const meta = (name) => {
        const bits = [];
        const sp = speedOf(running, name);
        if (sp) bits.push(fmtSpeed(sp));
        const slots = slotsOf(name);
        if (slots) bits.push(`${slots} slot${slots > 1 ? 's' : ''}`);
        if (!isRunning(name)) bits.push('not running');
        return bits.join(' · ');
    };
    return (
        <div className={`mm-panel mm-role ${active ? 'is-active' : ''}`}>
            <div className="flex items-start gap-3">
                <span className="mm-role-icon">{icon}</span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
                    <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-tertiary)' }}>{blurb}</div>
                </div>
            </div>
            <div className="mt-3">
                <Select
                    size="small"
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    displayEmpty
                    disabled={disabled}
                    sx={SELECT_SX}
                    renderValue={(v) => (v
                        ? (
                            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {v}
                                {meta(v) ? <span style={{ opacity: 0.55 }}> · {meta(v)}</span> : null}
                            </span>
                        )
                        : <span style={{ opacity: 0.55 }}>{placeholder}</span>)}
                >
                    <MenuItem value=""><em>{placeholder}</em></MenuItem>
                    {options.map((n) => (
                        <MenuItem key={n} value={n}>
                            {n}
                            {meta(n) ? <span style={{ opacity: 0.55, marginLeft: 8, fontSize: '0.8em' }}>· {meta(n)}</span> : null}
                        </MenuItem>
                    ))}
                </Select>
            </div>
        </div>
    );
}

// A compact segmented control (replaces MUI ToggleButtonGroup here).
function Segmented({ value, options, onChange, disabled }) {
    return (
        <div className="mm-seg" role="radiogroup">
            {options.map(([v, label]) => (
                <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={value === v}
                    className={value === v ? 'is-on' : ''}
                    disabled={disabled}
                    onClick={() => onChange(v)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

function OptionRow({ title, help, control, dim, stack }) {
    return (
        <div className={`mm-option ${stack ? 'is-stacked' : ''}`} style={{ opacity: dim ? 0.5 : 1 }}>
            <div className="min-w-0 flex-1">
                <div className="text-[0.85rem] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</div>
                <div className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>{help}</div>
            </div>
            <div className="flex-shrink-0">{control}</div>
        </div>
    );
}

// The plan for the next turn, rendered from the selections.
function TurnPlanPanel({ plan }) {
    const names = [plan.primary, plan.secondary];
    return (
        <div className="mm-panel mm-plan">
            <div className="mm-eyebrow">What happens on a turn</div>
            {plan.solo ? (
                <>
                    <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}><Highlighted text={plan.line} names={names} /></p>
                    {plan.reason && <p className="m-0 mt-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{plan.reason}</p>}
                </>
            ) : (
                <>
                    <ol className="mm-steps">
                        {plan.steps.map((st, i) => (
                            <li key={i}><span className="mm-step-n">{i + 1}</span><span><Highlighted text={st} names={names} /></span></li>
                        ))}
                    </ol>
                    {plan.caveat && <p className="m-0 mt-2 text-xs" style={{ color: '#f59e0b' }}><Highlighted text={plan.caveat} names={names} /></p>}
                    <p className="m-0 mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }}><Highlighted text={plan.when} names={names} /></p>
                </>
            )}
        </div>
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
    const [open] = useState(() => {
        try { return window.localStorage.getItem(ROLES_CARD_OPEN_KEY) === '1'; } catch (e) { return false; }
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
        <ModelsSection
            id="roles"
            icon={Users}
            title="Model roles"
            summary={plan.summary}
            defaultOpen={bodyOpen}
            actions={(
                <>
                    {savedAt > 0 && Date.now() - savedAt < 4000 && <span className="mm-badge mm-badge--ok">Saved</span>}
                    <button type="button" className="mm-link" onClick={() => setShowHelp((v) => !v)}>
                        {showHelp ? 'Hide help' : 'How it works'}
                    </button>
                </>
            )}
        >
            <div className="flex flex-col gap-4">
                <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                    Your everyday model answers most turns on its own. On substantial work it hands over to a second model, which writes
                    the answer while the everyday model runs background jobs for it. Needs two different models loaded.
                </p>

                <Collapse in={showHelp} unmountOnExit>
                    <div className="mm-panel">
                        <ul className="mm-help">
                            <li><strong>Primary</strong> is your everyday model. It answers most turns on its own, which keeps a quick question quick.</li>
                            <li><strong>Secondary</strong> stays out of the way until the ask is substantial, then takes the lead and writes the answer. Put the model you trust more with hard work here.</li>
                            <li><strong>First pass:</strong> before the secondary starts, the primary spends a few seconds restating the task and handing over a short brief.</li>
                            <li><strong>Legwork:</strong> while the secondary writes, it hands background jobs back to the primary (lookups, file reads, a script to run). They run on the primary&apos;s own GPU at the same time, so the secondary never waits.</li>
                            <li><strong>Review:</strong> on a turn the primary answered alone, the secondary can add a note under the answer or hand back a corrected version.</li>
                            <li><strong>Worker reports:</strong> when a turn fans work out to parallel worker agents, the secondary can review each report first.</li>
                            <li>Only the secondary&apos;s turns cost its full speed, so the slower model usually belongs there. The tok/s beside each name tells you which is which.</li>
                            <li>With a single model, even with several parallel slots, none of this applies: a model does not hand over to itself.</li>
                            <li>{isAdmin ? 'Changes save immediately for everyone; each user can override them in the chat Settings.' : 'Only an administrator can change these; you can override them for yourself in the chat Settings.'}</li>
                        </ul>
                    </div>
                </Collapse>

                {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
                {!loading && running.length === 0 && (
                    <Alert severity="info">No model is running yet. Load a model (two, to use a secondary), then assign the roles here.</Alert>
                )}
                {!loading && running.length === 1 && (
                    <Alert severity="info">
                        Only <strong>{running[0].name}</strong> is running. The secondary needs a second model loaded, otherwise the primary
                        answers everything on its own.
                    </Alert>
                )}

                <div className="mm-roles">
                    <RoleTile
                        icon={<BoltIcon sx={{ fontSize: 16 }} />}
                        title="Primary"
                        blurb="Your everyday model. Quick questions start and finish here."
                        value={roles.primary}
                        placeholder="Use the model picked in the chat"
                        options={sortNames(names, running, 'fastest')}
                        running={running}
                        disabled={disabled}
                        active={!!roles.primary}
                        onChange={(v) => save({ primary: v })}
                    />
                    <RoleTile
                        icon={<StrongModelIcon sx={{ fontSize: 16 }} />}
                        title="Secondary"
                        blurb="Takes over substantial work and writes the answer, with the primary fetching things for it."
                        value={roles.secondary}
                        placeholder="None, the primary answers everything"
                        options={sortNames(names, running, 'slowest')}
                        running={running}
                        disabled={disabled}
                        active={secondaryActive}
                        onChange={(v) => save({ secondary: v })}
                    />
                </div>

                {same && (
                    <Alert severity="warning">
                        Primary and secondary are the same model, so the secondary is ignored: a model does not hand over to itself. Load a
                        second, stronger model and select it as the secondary.
                    </Alert>
                )}
                {speedBackwards && (
                    <Alert severity="info">
                        Worth a check: your secondary is the <strong>faster</strong> of the two ({fmtSpeed(secondarySpeed)} vs {fmtSpeed(primarySpeed)}).
                        Every quick question goes through the primary, so the slower model usually belongs in the secondary slot.
                    </Alert>
                )}

                <TurnPlanPanel plan={plan} />

                <div>
                    <div className="mm-eyebrow mb-2">Hand-over</div>
                    <div className="mm-option-list">
                        <OptionRow
                            title="When the secondary takes over"
                            help={describeMode(mode, roles.primary, roles.secondary)}
                            dim={!roles.secondary || same}
                            stack
                            control={(
                                <Segmented
                                    value={mode}
                                    disabled={disabled}
                                    onChange={(v) => save({ mode: v })}
                                    options={[['off', 'Off'], ['auto', 'Substantial work'], ['always', 'All but easy turns']]}
                                />
                            )}
                        />
                    </div>
                </div>

                <div>
                    <div className="mm-eyebrow mb-2">
                        How the two split the work
                        {!roles.secondary ? ' · select a secondary to enable' : same ? ' · needs a different model' : mode === 'off' ? ' · switched off above' : ''}
                    </div>
                    <div className="mm-option-list">
                        <OptionRow
                            title="First pass"
                            help={describeFirstPass(roles.firstPass !== false, roles.primary, roles.secondary)}
                            dim={jobsDisabled}
                            control={<Switch size="small" checked={roles.firstPass !== false} disabled={jobsDisabled} onChange={(e) => save({ firstPass: e.target.checked })} />}
                        />
                        <OptionRow
                            title="Legwork"
                            help={describeLegwork(roles.legwork !== false, roles.primary, roles.secondary)}
                            dim={jobsDisabled}
                            control={<Switch size="small" checked={roles.legwork !== false} disabled={jobsDisabled} onChange={(e) => save({ legwork: e.target.checked })} />}
                        />
                        <OptionRow
                            title="Review answers the primary wrote alone"
                            help={describeReview(roles.review || 'off', roles.primary, roles.secondary)}
                            dim={jobsDisabled}
                            stack
                            control={(
                                <Segmented
                                    value={roles.review || 'off'}
                                    disabled={jobsDisabled}
                                    onChange={(v) => save({ review: v })}
                                    options={[['off', 'Off'], ['note', 'Add a note'], ['edit', 'Polish silently']]}
                                />
                            )}
                        />
                        <OptionRow
                            title="Check worker reports"
                            help={describeCheckWorkers(roles.checkWorkers === true, roles.primary, roles.secondary)}
                            dim={jobsDisabled}
                            control={<Switch size="small" checked={roles.checkWorkers === true} disabled={jobsDisabled} onChange={(e) => save({ checkWorkers: e.target.checked })} />}
                        />
                    </div>
                </div>
            </div>
        </ModelsSection>
    );
}
