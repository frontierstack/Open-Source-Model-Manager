import React, { useCallback, useEffect, useState } from 'react';
import {
    Typography, Box, Chip, Select, MenuItem, Button, Alert, Tooltip,
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

const CONTEXTS = [[32768, '32K'], [65536, '64K'], [131072, '128K'], [262144, '256K']];

function EngineRow({ engine, isAdmin, onInstall }) {
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
                <Tooltip title="Pick this up with ./update.sh">
                    <Chip size="small" color="warning" variant="outlined" label={`${engine.latest} available`} />
                </Tooltip>
            )}
            {canPull && <Button size="small" onClick={() => onInstall(engine.id)} sx={{ textTransform: 'none' }}>Install</Button>}
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
                {data.engines.map(e => <EngineRow key={e.id} engine={e} isAdmin={isAdmin} onInstall={install} />)}

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
