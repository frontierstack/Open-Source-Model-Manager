import React from 'react';
import { Cpu as MemoryIcon, Square as StopIcon } from 'lucide-react';
import Tooltip from '@mui/material/Tooltip';

// Phase 7: Tailwind rewrite of the Running Instances section in
// the My Models tab. Replaces the densest remaining MUI surface —
// ~260 lines of nested Card/Box/Chip/Tooltip — with a single
// component and a small set of pill primitives.
//
// Keeps the green semantic accent on the section card border (running
// = healthy state, not theme accent), but the inner pill rows and
// surfaces use the theme CSS variables so themes/accent switching
// repaints the rest of the chrome.

function Pill({ label, tooltip, tone = 'neutral' }) {
    // All tones now resolve through CSS vars so the pills track theme +
    // accent picks. Earlier version had hardcoded green/amber/cyan/etc.
    // for "semantic" effect; user's read on it was that the pills
    // ignored theme overall. Real semantic states (warning/error)
    // still pop, but the rest of the dimensions just tint with the
    // active accent.
    //
    // tones:
    //   neutral — muted text, no fill (default config dimensions)
    //   accent  — accent-primary text on accent-muted (e.g. AIMem,
    //             CtxShift, Reasoning On — feature-on pills)
    //   info    — accent-primary text, transparent fill (e.g. Port,
    //             Backend label, CPU offload — identifying pills)
    //   warning — kept fixed amber for actual quantization warnings
    //             (KV cache type, cache type) since those carry
    //             semantic information about resource tradeoffs.
    let style;
    switch (tone) {
        case 'warning':
            style = { color: 'var(--warning, #f59e0b)', borderColor: 'rgba(245,158,11,0.45)', backgroundColor: 'rgba(245,158,11,0.10)' };
            break;
        case 'info':
            style = { color: 'var(--accent-primary)', borderColor: 'var(--border-focus)', backgroundColor: 'transparent' };
            break;
        case 'accent':
            style = { color: 'var(--accent-primary)', borderColor: 'var(--border-focus)', backgroundColor: 'var(--accent-muted)' };
            break;
        case 'brand':
            // Backend label (sglang / llama.cpp): strong text on hover bg.
            style = { color: 'var(--text-primary)', borderColor: 'var(--border-hover)', backgroundColor: 'var(--bg-hover)', fontWeight: 600 };
            break;
        case 'success':
            // Was hardcoded green. Repoint to accent so theme picks recolor it
            // — keeps the "feature is on" semantics (CtxShift, SWA-Full,
            // Reasoning On) but in the active accent rather than a fixed hue.
            style = { color: 'var(--accent-primary)', borderColor: 'var(--border-focus)', backgroundColor: 'var(--accent-muted)' };
            break;
        case 'neutral':
        default:
            style = { color: 'var(--text-secondary)', borderColor: 'var(--border-primary)', backgroundColor: 'transparent' };
            break;
    }
    const pill = (
        <span
            className="inline-flex h-6 items-center rounded-full border px-2 text-[0.7rem] font-medium whitespace-nowrap"
            style={style}
        >
            {label}
        </span>
    );
    return tooltip ? <Tooltip title={tooltip}>{pill}</Tooltip> : pill;
}

function SglangPills({ cfg }) {
    // sglang-specific runtime config pills. Each renders only when
    // the config differs from the runtime default so the row stays
    // information-dense rather than cluttered.
    return (
        <>
            <Pill tooltip="Static memory fraction (--mem-fraction-static)" label={`Mem: ${Math.round((cfg?.memFractionStatic ?? 0.88) * 100)}%`} />
            <Pill tooltip="Tensor parallel size (GPUs)" label={`TP: ${cfg?.tensorParallelSize ?? 1}`} />
            <Pill tooltip="Max concurrent batched requests" label={`Reqs: ${cfg?.maxRunningRequests ?? 256}`} />
            {cfg?.chunkedPrefillSize && cfg.chunkedPrefillSize !== 4096 && (
                <Pill tooltip="Prefill chunk size (--chunked-prefill-size)" label={`Prefill: ${cfg.chunkedPrefillSize}`} />
            )}
            {cfg?.schedulePolicy && cfg.schedulePolicy !== 'lpm' && (
                <Pill tooltip="Request scheduling policy" label={`Sched: ${cfg.schedulePolicy}`} />
            )}
            {cfg?.kvCacheDtype && cfg.kvCacheDtype !== 'auto' && (
                <Pill tooltip="KV cache data type" label={`KV: ${cfg.kvCacheDtype}`} tone="warning" />
            )}
            {cfg?.toolCallParser && (
                <Pill tooltip="sglang tool-call parser" label={`Tools: ${cfg.toolCallParser}`} tone="info" />
            )}
            {cfg?.reasoningParser && (
                <Pill tooltip="Reasoning/thinking parser" label={`Reason: ${cfg.reasoningParser}`} tone="accent" />
            )}
            {cfg?.contextShift && <Pill tooltip="Context shifting enabled" label="CtxShift" tone="success" />}
            {cfg?.compressMemory && <Pill tooltip="AIMem memory compression enabled" label="AIMem" tone="accent" />}
        </>
    );
}

function LlamacppPills({ cfg }) {
    return (
        <>
            <Pill tooltip="GPU layers (-1 = all)" label={`Layers: ${cfg?.nGpuLayers === -1 ? 'All' : (cfg?.nGpuLayers ?? 'All')}`} />
            <Pill tooltip="Parallel slots" label={`Slots: ${cfg?.parallelSlots ?? 1}`} />
            {cfg?.threads > 0 && <Pill tooltip="CPU threads" label={`Threads: ${cfg.threads}`} />}
            {cfg?.batchSize && cfg.batchSize !== 2048 && <Pill tooltip="Batch size" label={`Batch: ${cfg.batchSize}`} />}
            {cfg?.cacheTypeK && cfg.cacheTypeK !== 'f16' && (
                <Pill tooltip="KV cache quantization" label={`Cache: ${cfg.cacheTypeK}`} tone="warning" />
            )}
            {cfg?.flashAttention && <Pill tooltip="Flash attention enabled" label="Flash" tone="info" />}
            {cfg?.swaFull && <Pill tooltip="Full SWA cache — prompt cache reuses across turns" label="SWA-Full" tone="success" />}
            {/* Speculative decoding chip — shows the active --spec-type mode
                (draft-mtp uses the model's built-in MTP heads, draft-simple
                pairs a smaller draft GGUF with the main model). Hidden when
                specType is unset or 'none' so the row stays compact for the
                default serial-decode path. */}
            {cfg?.specType === 'draft-mtp' && (
                <Pill tooltip={`MTP speculative decoding (draft-n-max=${cfg?.specDraftNMax ?? 3})`} label="MTP" tone="success" />
            )}
            {cfg?.specType === 'draft-simple' && (
                <Pill tooltip={`Speculative decoding with draft model (n-max=${cfg?.specDraftNMax ?? 3})`} label={`Spec: draft+${cfg?.specDraftNMax ?? 3}`} tone="success" />
            )}
            {cfg?.contextShift && <Pill tooltip="Context shifting enabled" label="CtxShift" tone="success" />}
            {cfg?.compressMemory && <Pill tooltip="AIMem memory compression enabled" label="AIMem" tone="accent" />}
            {/* Always show the reasoning state so it's unambiguous at a glance */}
            <Pill
                tooltip={cfg?.disableThinking
                    ? 'Reasoning disabled — model will not emit <think> blocks'
                    : 'Reasoning enabled — model may use <think> blocks for chain-of-thought'}
                label={cfg?.disableThinking ? 'Reasoning: Off' : 'Reasoning: On'}
                tone={cfg?.disableThinking ? 'neutral' : 'success'}
            />
        </>
    );
}

function InstanceCard({ instance, onStop }) {
    const cfg = instance.config || {};
    const isSglang = instance.backend === 'sglang';
    const ctx = isSglang ? (cfg.maxModelLen || cfg.contextSize || 4096) : (cfg.contextSize || 4096);
    return (
        <div
            // Card surface tracks the active theme/accent. Earlier version
            // forced a green-tinted bg + border to signal "running"; that
            // ran on top of every theme regardless. The Running Instances
            // section header still has a subtle green border at the
            // section-card level so the page-level "healthy" semantic
            // remains, but each instance card uses the standard surface.
            className="flex flex-col rounded-xl border p-3 transition"
            style={{
                backgroundColor: 'var(--bg-secondary)',
                borderColor: 'var(--border-primary)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div
                        className="text-sm font-semibold truncate mb-1.5"
                        style={{ color: 'var(--text-primary)' }}
                        title={instance.name}
                    >
                        {instance.name}
                    </div>

                    {/* Top pill row: identity + general config — all
                        accent-themed so theme/accent picks repaint them. */}
                    <div className="flex flex-wrap gap-1 mb-1">
                        <Pill label={`Port ${instance.port}`} tone="accent" />
                        <Pill
                            tooltip={`Backend: ${isSglang ? 'sglang' : 'llama.cpp'}`}
                            label={isSglang ? 'sglang' : 'llama.cpp'}
                            tone="brand"
                        />
                        <Pill tooltip="Context size" label={`${ctx} ctx`} />
                    </div>

                    {/* Second row: backend-specific runtime details */}
                    <div className="flex flex-wrap gap-1">
                        {isSglang ? <SglangPills cfg={cfg} /> : <LlamacppPills cfg={cfg} />}
                    </div>
                </div>

                {/* Stop control — stays MUI Tooltip + IconButton for parity
                    with the rest of the page's icon-button vocabulary. */}
                <Tooltip title="Stop Instance">
                    <button
                        type="button"
                        onClick={() => onStop(instance.name, instance.backend)}
                        aria-label={`Stop ${instance.name}`}
                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition"
                        style={{ color: '#f87171' }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(248,113,113,0.12)'; e.currentTarget.style.color = '#ef4444'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#f87171'; }}
                    >
                        <StopIcon size={16} strokeWidth={2} />
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}

export default function RunningInstancesPanel({ instances = [], onStop }) {
    if (!instances.length) return null;
    return (
        <div
            className="rounded-xl border p-4"
            style={{
                backgroundColor: 'var(--surface-primary)',
                borderColor: 'var(--border-primary)',
            }}
        >
            {/* Section header — accent tile matches the rest of the page's
                page-header pattern. */}
            <div className="mb-3 flex items-center gap-3">
                <span
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                >
                    <MemoryIcon size={20} strokeWidth={1.75} />
                </span>
                <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Running Instances
                    </div>
                    <div className="text-[0.7rem]" style={{ color: 'var(--text-tertiary)' }}>
                        {instances.length} model{instances.length > 1 ? 's' : ''} currently loaded
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {instances.map((instance) => (
                    <InstanceCard key={instance.name} instance={instance} onStop={onStop} />
                ))}
            </div>
        </div>
    );
}
