import React, { useCallback, useEffect, useState } from 'react';
import {
    Typography, Box, Chip, Select, MenuItem, Button, Alert, Tooltip,
    Dialog, DialogTitle, DialogContent, DialogActions, LinearProgress, FormControlLabel, Switch,
} from '@mui/material';
import { Cpu } from 'lucide-react';
import ModelsSection from './ModelsSection';

// One line in a load dialog: which engine the router picked and why.
export function EngineHint({ modelName, hfRepoId, format }) {
    const [rec, setRec] = useState(null);
    useEffect(() => {
        if (!modelName && !hfRepoId) { setRec(null); return undefined; }
        let live = true;
        fetch('/api/engines/plan', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelName, hfRepoId, format }),
        }).then(r => (r.ok ? r.json() : null)).then((j) => {
            if (live && j) setRec(j.plan.ranked.find(r => r.engine === j.plan.recommended) || null);
        }).catch(() => {});
        return () => { live = false; };
    }, [modelName, hfRepoId, format]);
    if (!rec) return null;
    return <Alert severity="info" sx={{ py: 0 }}>Best engine here: <b>{rec.label}</b>. {rec.reasons[0]}</Alert>;
}

// Token counts use K = 1024, as Strata does (its own list has 200K = 204800).
// Strata's conversation-memory formats, smallest first. Measured here at 256K:
// q4_0 fastest (97% of experts on the GPUs); int8 ~5% slower, better quality.
const KV_TYPES = [
    ['q4_0', 'q4_0 · smallest, fastest'],
    ['int8', 'int8 · better quality'],
    ['k8v4', 'k8v4 · 8-bit keys, 4-bit values'],
    ['fp16', 'fp16 · full precision'],
];
const PARALLEL = [1, 2, 3, 4, 6, 8];
const SMALL_BTN = { textTransform: 'none', fontSize: '0.75rem', lineHeight: 1.2, py: 0.5, px: 1.5, minHeight: 0, minWidth: 0, borderRadius: '8px' };
const SELECT_SX = { width: '100%', fontSize: '0.85rem' };

const CONTEXTS = [32, 64, 100, 128, 150, 180, 200, 256].map(k => [k * 1024, `${k}K`]);

function fmtAgo(sec) {
    if (!sec) return '';
    const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// What an upgrade of each engine does, for the confirm dialog.
const UPGRADE_TEXT = {
    llamacpp: (cur, next) => [
        `The new release is compiled on this server (20 to 90 minutes), then tested against ${cur} on a small model: it must answer, make tool calls if the current build can, and decode at least 85% as fast.`,
        `Only then is it installed. ${cur} keeps serving the whole time and stays available for rollback. Loaded models move to the new build by themselves when nothing is using them.`,
    ],
    sglang: (cur) => [
        'The new release is built on this server from SGLang\'s image with our patches (downloads about 30 GB), then started to check that it imports, sees the GPUs and its server starts.',
        `Only then is it installed. ${cur} stays available for rollback; loaded models move to the new build when idle.`,
    ],
    strata: (cur, next, loaded) => [
        `The new version is downloaded, then the real model is loaded on ${next} and on ${cur} with the same settings and compared: it must answer, make tool calls if the current version can, and decode at least 85% as fast. Each load takes a few minutes.`,
        loaded.length
            ? `The test needs every GPU, so ${loaded.join(', ')} is unloaded now and loaded again when the upgrade ends (on ${next} if it passed, else on ${cur}). Chats cannot use it in between.`
            : `${cur} stays available for rollback.`,
    ],
    vllm: (cur, next) => [
        `The new image is downloaded (about 20 GB) and started to check that it runs and sees the GPUs. There is no vLLM model on this server to compare speeds with.`,
        `Models loaded afterwards use ${next}; ${cur} stays available for rollback.`,
    ],
};

function fmtElapsed(sec) {
    if (!sec) return '';
    const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Upgrade state for one engine: the button, a progress bar with the stages,
// and the last result. `info` comes from GET /api/engines/upgrades.
function EngineUpgrade({ engine, info, busyEngine, isAdmin, showSnackbar, onChanged, reload }) {
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [showLog, setShowLog] = useState(false);
    const st = info?.status;
    const running = !!info?.running;
    const prevState = React.useRef(null);
    useEffect(() => {
        if (prevState.current === 'running' && st && st.state !== 'running') onChanged?.();
        prevState.current = st?.state || null;
    }, [st?.state, onChanged]);

    const post = (url, body) => {
        setBusy(true);
        fetch(url, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        }).then(r => r.json().then((j) => {
            showSnackbar?.(j.message || j.error, r.ok ? 'info' : 'error');
            reload();
        })).catch(e => showSnackbar?.(e.message, 'error')).finally(() => { setBusy(false); setConfirm(false); });
    };

    const otherBusy = busyEngine && busyEngine !== engine.id;
    const canUpgrade = isAdmin && engine.updateAvailable && !running && (engine.installed || engine.id === 'vllm');
    const canRollback = isAdmin && info?.rollbackAvailable && !running;
    const showResult = st && !running && (st.state === 'failed' || st.state === 'interrupted'
        || (st.state === 'succeeded' && Date.now() / 1000 - (st.promotedAt || 0) < 7 * 86400));
    const stages = Array.isArray(st?.stages) ? st.stages : [];
    const pct = info?.progress?.value != null ? Math.round(info.progress.value * 100) : null;
    const inner = info?.progress?.stageProgress;
    if (!canUpgrade && !canRollback && !running && !showResult) return null;
    const text = (UPGRADE_TEXT[engine.id] || UPGRADE_TEXT.vllm)(engine.version || 'the current version', engine.latest, engine.running || []);
    return (
        <Box sx={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {(canUpgrade || canRollback) && (
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                    {canUpgrade && (
                        <Tooltip title={otherBusy ? 'Another engine is upgrading; one at a time.' : ''}>
                            <span>
                                <Button size="small" variant="contained" disabled={busy || !!otherBusy} onClick={() => setConfirm(true)} sx={SMALL_BTN}>
                                    {engine.installed ? `Upgrade to ${engine.latest}` : `Install ${engine.latest}`}
                                </Button>
                            </span>
                        </Tooltip>
                    )}
                    {canRollback && (
                        <Tooltip title={`Go back to ${st?.rollbackVersion || st?.from || 'the previous version'}`}>
                            <span>
                                <Button size="small" variant="outlined" disabled={busy || !!otherBusy} onClick={() => post(`/api/engines/${engine.id}/rollback`)} sx={SMALL_BTN}>
                                    Roll back{st?.rollbackVersion || st?.from ? ` to ${st.rollbackVersion || st.from}` : ''}
                                </Button>
                            </span>
                        </Tooltip>
                    )}
                </Box>
            )}
            {running && (
                <Box className="mm-upgrade">
                    <div className="mm-upgrade__head">
                        <span className="mm-upgrade__title">Upgrading to {st?.target || engine.latest}</span>
                        <span className="mm-upgrade__meta">{pct != null ? `${pct}% · ` : ''}{fmtElapsed(st?.startedAt)}</span>
                    </div>
                    <LinearProgress variant={pct != null ? 'determinate' : 'indeterminate'} value={pct ?? 0} sx={{ height: 5, borderRadius: 3 }} />
                    {stages.length > 0 && (
                        <ol className="mm-upgrade__stages">
                            {stages.map((name, i) => {
                                const state = i < st.stageIndex ? 'done' : i === st.stageIndex ? 'active' : 'todo';
                                return (
                                    <li key={name} data-state={state}>
                                        <span className="mm-upgrade__dot" />
                                        {name}{state === 'active' && inner != null ? ` · ${Math.round(inner * 100)}%` : ''}
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                        {st?.step || 'Starting'}. {engine.version || 'The current version'} stays in place until the new one passes.
                    </Typography>
                </Box>
            )}
            {showResult && (
                <Alert severity={st.state === 'succeeded' ? 'success' : 'warning'} sx={{ py: 0 }}>
                    {st.state === 'succeeded' && (st.rolledBack
                        ? `Rolled back to ${st.target} ${fmtAgo(st.promotedAt)}.`
                        : `Upgraded ${st.from} → ${st.target} ${fmtAgo(st.promotedAt)}.${st.test?.verdict ? ` Test: ${st.test.verdict.replace(/^OK /, '')}.` : ''}`)}
                    {st.state === 'failed' && `Upgrade to ${st.target} was not installed: ${st.error || st.step}. ${st.from} is still in use.`}
                    {st.state === 'interrupted' && `The upgrade to ${st.target} stopped without finishing. ${st.from} is still in use.`}
                    {info?.pendingReloads?.length > 0 && ` Moving ${info.pendingReloads.join(', ')} when idle.`}
                    {info?.restorePending && ' Loading the Strata model again…'}
                </Alert>
            )}
            {isAdmin && info?.log?.length > 0 && (running || st?.state === 'failed') && (
                <Box>
                    <Button size="small" onClick={() => setShowLog(v => !v)} sx={{ textTransform: 'none', p: 0, minWidth: 0 }}>
                        {showLog ? 'Hide log' : 'Show log'}
                    </Button>
                    {showLog && (
                        <Box component="pre" sx={{ m: 0, mt: 0.5, p: 1, maxHeight: 220, overflow: 'auto', fontSize: '0.72rem', bgcolor: 'var(--bg-tertiary)', borderRadius: 1, whiteSpace: 'pre-wrap' }}>
                            {info.log.join('\n')}
                        </Box>
                    )}
                </Box>
            )}
            <Dialog open={confirm} onClose={() => setConfirm(false)} maxWidth="xs" fullWidth>
                <DialogTitle>{engine.installed ? 'Upgrade' : 'Install'} {engine.label} {engine.latest}?</DialogTitle>
                <DialogContent>
                    {text.map((t, i) => <Typography key={i} variant="body2" sx={{ mb: i < text.length - 1 ? 1 : 0 }}>{t}</Typography>)}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirm(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" disabled={busy}
                        onClick={() => post(`/api/engines/${engine.id}/upgrade`, { version: engine.latest, unload: engine.id === 'strata' })}
                        sx={{ textTransform: 'none' }}>
                        {engine.id === 'strata' && engine.running?.length ? 'Unload and upgrade' : engine.installed ? 'Upgrade' : 'Install'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

function StatusBadge({ tone = 'neutral', children }) {
    return <span className={`mm-badge mm-badge--${tone}`}>{children}</span>;
}

function EngineRow({ engine, upgrade, busyEngine, reloadUpgrades, isAdmin, onInstall, showSnackbar, onChanged }) {
    const running = engine.running.length;
    const canPull = isAdmin && !engine.installed && engine.id === 'vllm' && !engine.updateAvailable;
    return (
        <div className="mm-engine">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-[1_1_280px]">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{engine.label}</div>
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{engine.summary}</div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {running
                        ? <StatusBadge tone="ok">Running · {running}</StatusBadge>
                        : engine.installed ? <StatusBadge>Installed</StatusBadge> : <StatusBadge tone="muted">Not installed</StatusBadge>}
                    {engine.version && <StatusBadge tone="muted">{engine.version}</StatusBadge>}
                    {upgrade?.running
                        ? <StatusBadge tone="ok">Upgrading{upgrade.progress?.value != null ? ` · ${Math.round(upgrade.progress.value * 100)}%` : ''}</StatusBadge>
                        : engine.updateAvailable && <StatusBadge tone="warn">{engine.latest} available</StatusBadge>}
                    {canPull && <Button size="small" variant="outlined" onClick={() => onInstall(engine.id)} sx={{ ...SMALL_BTN, ml: 0.5 }}>Install</Button>}
                </div>
            </div>
            <div className="mt-2 empty:hidden">
                <EngineUpgrade engine={engine} info={upgrade} busyEngine={busyEngine} isAdmin={isAdmin} showSnackbar={showSnackbar} onChanged={onChanged} reload={reloadUpgrades} />
            </div>
        </div>
    );
}

function Field({ label, children }) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[0.7rem] font-medium" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
            {children}
        </label>
    );
}

function ToggleCard({ title, description, checked, onChange, disabled }) {
    return (
        <label className={`mm-toggle ${checked ? 'is-on' : ''}`} style={{ opacity: disabled ? 0.6 : 1 }}>
            <span className="min-w-0 flex-1">
                <span className="block text-[0.82rem] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
                <span className="mt-0.5 block text-[0.72rem] leading-snug" style={{ color: 'var(--text-tertiary)' }}>{description}</span>
            </span>
            <Switch size="small" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        </label>
    );
}

// The engine catalog, what the router would do with Qwen3.8-Flash-Next on this
// machine, and the controls for loading it. Every other model is routed from
// its own load dialog.
export default function EnginesCard({ isAdmin, showSnackbar, onChanged }) {
    const [data, setData] = useState(null);
    const [plan, setPlan] = useState(null);
    const [size, setSize] = useState('q2_0');
    const [context, setContext] = useState(262144);
    const [kv, setKv] = useState('q4_0');
    const [parallel, setParallel] = useState(1);
    const [contextShift, setContextShift] = useState(true);
    const [compressMemory, setCompressMemory] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        fetch('/api/engines', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null)).then(setData).catch(() => {});
    }, []);
    useEffect(() => { refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t); }, [refresh]);
    // Upgrade progress for every engine: every 4 s while one runs, else 30 s.
    const [upgrades, setUpgrades] = useState(null);
    const loadUpgrades = useCallback(() => {
        fetch('/api/engines/upgrades', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null)).then(setUpgrades).catch(() => {});
    }, []);
    const upgrading = !!upgrades?.busy || Object.values(upgrades?.engines || {}).some(u => u.running || u.restorePending || u.pendingReloads?.length);
    useEffect(() => {
        loadUpgrades();
        const t = setInterval(loadUpgrades, upgrading ? 4000 : 30000);
        return () => clearInterval(t);
    }, [loadUpgrades, upgrading]);
    useEffect(() => {
        fetch('/api/engines/plan', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelName: 'Qwen3.8-Flash-Next', format: 'gguf', size }),
        }).then(r => (r.ok ? r.json() : null)).then(setPlan).catch(() => {});
    }, [size, data?.engines?.find(e => e.id === 'strata')?.running?.length]);

    // While the model is loaded, the form shows what it was loaded with.
    const loadedNow = !!data?.engines?.find(e => e.id === 'strata')?.running?.includes('Qwen3.8-Flash-Next');
    useEffect(() => {
        if (!loadedNow) return;
        fetch('/api/engines/instances', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null)).then((list) => {
                const cfg = (list || []).find(i => i.name === 'Qwen3.8-Flash-Next')?.config;
                if (!cfg) return;
                const sizeKey = Object.entries(data.flashNextSizes || {}).find(([, v]) => v.label === cfg.strataSize)?.[0];
                if (sizeKey) setSize(sizeKey);
                if (cfg.contextSize) setContext(cfg.contextSize);
                if (cfg.kv) setKv(cfg.kv);
                if (cfg.parallelSlots) setParallel(cfg.parallelSlots);
                setContextShift(cfg.contextShift !== false);
                setCompressMemory(cfg.compressMemory === true);
            }).catch(() => {});
    }, [loadedNow]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!data) return null;
    const strata = plan?.plan?.ranked?.find(r => r.engine === 'strata');
    const strataEngine = data.engines.find(e => e.id === 'strata');
    const loaded = strataEngine?.running?.includes('Qwen3.8-Flash-Next');
    const gpusBusy = strata?.requires?.includes('free-gpus');
    const blocked = !strata?.viable || !strata?.installed || gpusBusy || loaded;

    const install = (id) => {
        fetch(`/api/engines/${id}/install`, { method: 'POST', credentials: 'include' })
            .then(r => r.json().then(j => { showSnackbar?.(j.message || j.error, r.ok ? 'info' : 'error'); }))
            .catch(e => showSnackbar?.(e.message, 'error'));
    };
    const load = () => {
        setBusy(true);
        fetch('/api/engines/strata/load', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size, context, kv, parallel, contextShift, compressMemory }),
        }).then(r => r.json().then((j) => {
            if (!r.ok) throw new Error(j.error || 'Failed to start Strata');
            showSnackbar?.('Strata is starting. Progress appears in Logs.', 'success');
            refresh(); onChanged?.();
        })).catch(e => showSnackbar?.(e.message, 'error')).finally(() => setBusy(false));
    };

    return (
        <ModelsSection
            id="engines"
            icon={Cpu}
            title="Inference engines"
            summary="The engines that run your models. Each model goes to the one that suits its format and this machine."
            defaultOpen={false}
        >
            <div className="flex flex-col gap-4">
                <div className="mm-engine-list">
                    {data.engines.map(e => <EngineRow key={e.id} engine={e} upgrade={upgrades?.engines?.[e.id]} busyEngine={upgrades?.busy} reloadUpgrades={loadUpgrades} isAdmin={isAdmin} onInstall={install} showSnackbar={showSnackbar} onChanged={refresh} />)}
                </div>

                <div className="mm-panel">
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Load Qwen3.8-Flash-Next with Strata</div>
                            <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {loaded ? 'Loaded now. Stop it under Running to load it again with other settings.' : 'Choose the settings, then load. Loading takes about 2–3 minutes.'}
                            </div>
                        </div>
                        {loaded && <StatusBadge tone="ok">Loaded</StatusBadge>}
                    </div>
                    <div className="mm-fields">
                        <Field label="Model file">
                            <Select size="small" value={size} onChange={e => setSize(e.target.value)} disabled={loaded} sx={SELECT_SX}>
                                {Object.entries(data.flashNextSizes).map(([k, v]) => (
                                    <MenuItem key={k} value={k}>{v.label} · {v.downloadGiB} GB</MenuItem>
                                ))}
                            </Select>
                        </Field>
                        <Field label="Context">
                            <Select size="small" value={context} onChange={e => setContext(e.target.value)} disabled={loaded} sx={SELECT_SX}>
                                {(CONTEXTS.some(([v]) => v === context) ? CONTEXTS : [...CONTEXTS, [context, `${Math.round(context / 1024)}K`]]).map(([v, l]) => <MenuItem key={v} value={v}>{l} tokens</MenuItem>)}
                            </Select>
                        </Field>
                        <Field label="KV cache">
                            <Select size="small" value={kv} onChange={e => setKv(e.target.value)} disabled={loaded} sx={SELECT_SX}>
                                {KV_TYPES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
                            </Select>
                        </Field>
                        <Field label="Requests at once">
                            <Select size="small" value={parallel} onChange={e => setParallel(e.target.value)} disabled={loaded} sx={SELECT_SX}>
                                {PARALLEL.map(n => <MenuItem key={n} value={n}>{n === 1 ? '1 (fastest)' : n}</MenuItem>)}
                            </Select>
                        </Field>
                    </div>
                    <div className="mm-toggles mt-3">
                        <ToggleCard
                            title="Context shifting"
                            description="When a chat outgrows the context, drop the oldest messages instead of failing."
                            checked={contextShift} onChange={setContextShift} disabled={loaded}
                        />
                        <ToggleCard
                            title="Compress memory"
                            description="Compress older messages once a chat fills most of the context."
                            checked={compressMemory} onChange={setCompressMemory} disabled={loaded}
                        />
                    </div>
                    {!loaded && strata && !strata.viable && <Alert severity="error" sx={{ mt: 2 }}>{strata.reasons[strata.reasons.length - 1]}</Alert>}
                    {!loaded && strata?.warnings?.map(w => <Alert key={w} severity="warning" sx={{ mt: 2 }}>{w}</Alert>)}
                    {!loaded && (
                        <div className="mt-4 flex justify-end">
                            <Button variant="contained" size="small" disabled={blocked || busy || !isAdmin} onClick={load} sx={{ textTransform: 'none', px: 2.5 }}>
                                {busy ? 'Starting…' : 'Load model'}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </ModelsSection>
    );
}
