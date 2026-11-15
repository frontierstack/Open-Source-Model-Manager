import React, { useCallback, useEffect, useState } from 'react';
import {
    Typography, Box, Chip, Select, MenuItem, Button, Alert, Tooltip,
    Dialog, DialogTitle, DialogContent, DialogActions, LinearProgress,
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
const CONTEXTS = [32, 64, 100, 128, 150, 180, 200, 256].map(k => [k * 1024, `${k}K`]);

function fmtAgo(sec) {
    if (!sec) return '';
    const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// Upgrade state for llama.cpp: the button, live progress and the last result.
function LlamaUpgrade({ engine, isAdmin, showSnackbar, onChanged }) {
    const [info, setInfo] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [showLog, setShowLog] = useState(false);
    const load = useCallback(() => {
        fetch('/api/engines/llamacpp/upgrade', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null)).then(setInfo).catch(() => {});
    }, []);
    const st = info?.status;
    const running = st?.state === 'running' || info?.helperRunning;
    useEffect(() => {
        load();
        const t = setInterval(load, running || info?.pendingReloads?.length ? 5000 : 30000);
        return () => clearInterval(t);
    }, [load, running, info?.pendingReloads?.length]);
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
            load();
        })).catch(e => showSnackbar?.(e.message, 'error')).finally(() => { setBusy(false); setConfirm(false); });
    };

    const canUpgrade = isAdmin && engine.updateAvailable && !running;
    const showResult = st && !running && (st.state === 'failed' || st.state === 'interrupted'
        || (st.state === 'succeeded' && Date.now() / 1000 - (st.promotedAt || 0) < 7 * 86400));
    return (
        <Box sx={{ flexBasis: '100%', pl: 0, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {(canUpgrade || (isAdmin && info?.rollbackAvailable && !running)) && (
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {canUpgrade && (
                        <Button size="small" variant="contained" disabled={busy} onClick={() => setConfirm(true)} sx={{ textTransform: 'none' }}>
                            Upgrade to {engine.latest}
                        </Button>
                    )}
                    {isAdmin && info?.rollbackAvailable && !running && (
                        <Tooltip title={`Go back to the build that was installed before ${st?.target || 'the last upgrade'}`}>
                            <Button size="small" disabled={busy} onClick={() => post('/api/engines/llamacpp/rollback')} sx={{ textTransform: 'none' }}>
                                Roll back
                            </Button>
                        </Tooltip>
                    )}
                </Box>
            )}
            {running && (
                <Box>
                    <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                        {st?.step || 'Starting'} · started {fmtAgo(st?.startedAt)}. The current build keeps serving until the new one passes.
                    </Typography>
                    <LinearProgress sx={{ mt: 0.5, height: 3, borderRadius: 2 }} />
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
                <DialogTitle>Upgrade llama.cpp to {engine.latest}?</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                        The new release is compiled on this server (20 to 90 minutes), then tested against {engine.version} on a small model: it must answer, make tool calls if the current build can, and decode at least 85% as fast.
                    </Typography>
                    <Typography variant="body2">
                        Only then is it installed. {engine.version} keeps serving the whole time and stays available for rollback. Loaded models move to the new build by themselves when nothing is using them.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirm(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" disabled={busy} onClick={() => post('/api/engines/llamacpp/upgrade', { version: engine.latest })} sx={{ textTransform: 'none' }}>
                        Upgrade
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

function EngineRow({ engine, isAdmin, onInstall, showSnackbar, onChanged }) {
    const status = engine.running.length
        ? `Running ${engine.running.length}`
        : engine.installed ? 'Installed' : 'Not installed';
    const canPull = isAdmin && !engine.installed && engine.id === 'vllm';
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75, flexWrap: 'wrap', borderTop: '1px solid var(--border-primary)' }}>
            <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600, fontSize: '0.875rem' }}>{engine.label}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{engine.summary}</Typography>
            </Box>
            <Chip size="small" label={status} color={engine.running.length ? 'success' : 'default'} variant={engine.installed ? 'filled' : 'outlined'} />
            {engine.version && <Chip size="small" variant="outlined" label={engine.version} />}
            {engine.updateAvailable && (
                <Tooltip title={engine.id === 'llamacpp' ? 'Upgrade here, or with sudo ./update.sh' : 'Pick this up with ./update.sh'}>
                    <Chip size="small" color="warning" variant="outlined" label={`${engine.latest} available`} />
                </Tooltip>
            )}
            {canPull && <Button size="small" onClick={() => onInstall(engine.id)} sx={{ textTransform: 'none' }}>Install</Button>}
            {engine.id === 'llamacpp' && engine.installed && (
                <LlamaUpgrade engine={engine} isAdmin={isAdmin} showSnackbar={showSnackbar} onChanged={onChanged} />
            )}
        </Box>
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
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        fetch('/api/engines', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null)).then(setData).catch(() => {});
    }, []);
    useEffect(() => { refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t); }, [refresh]);
    useEffect(() => {
        fetch('/api/engines/plan', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelName: 'Qwen3.8-Flash-Next', format: 'gguf', size }),
        }).then(r => (r.ok ? r.json() : null)).then(setPlan).catch(() => {});
    }, [size, data?.engines?.find(e => e.id === 'strata')?.running?.length]);

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
            body: JSON.stringify({ size, context }),
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
            summary="Each model is routed to the engine that suits its format and this machine. Speeds measured here take priority."
            defaultOpen={false}
        >
            <Box>
                {data.engines.map(e => <EngineRow key={e.id} engine={e} isAdmin={isAdmin} onInstall={install} showSnackbar={showSnackbar} onChanged={refresh} />)}

                <Box sx={{ borderTop: '1px solid var(--border-primary)', pt: 1.5, mt: 0.5 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: '0.875rem', mb: 1 }}>Qwen3.8-Flash-Next with Strata</Typography>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Select size="small" value={size} onChange={e => setSize(e.target.value)} sx={{ minWidth: 150 }}>
                            {Object.entries(data.flashNextSizes).map(([k, v]) => (
                                <MenuItem key={k} value={k}>{v.label} ({v.downloadGiB} GB)</MenuItem>
                            ))}
                        </Select>
                        <Select size="small" value={context} onChange={e => setContext(e.target.value)}>
                            {CONTEXTS.map(([v, l]) => <MenuItem key={v} value={v}>{l} context</MenuItem>)}
                        </Select>
                        <Button variant="contained" size="small" disabled={blocked || busy || !isAdmin} onClick={load} sx={{ textTransform: 'none' }}>
                            {loaded ? 'Loaded' : 'Load'}
                        </Button>
                    </Box>
                    {!loaded && strata && !strata.viable && <Alert severity="error" sx={{ mt: 1 }}>{strata.reasons[strata.reasons.length - 1]}</Alert>}
                    {!loaded && strata?.warnings?.map(w => <Alert key={w} severity="warning" sx={{ mt: 1 }}>{w}</Alert>)}
                </Box>
            </Box>
        </ModelsSection>
    );
}
