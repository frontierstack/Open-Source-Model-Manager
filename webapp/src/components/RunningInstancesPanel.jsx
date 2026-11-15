import React from 'react';
import { Cpu as MemoryIcon, Square as StopIcon } from 'lucide-react';
import Tooltip from '@mui/material/Tooltip';
import ModelsSection from './ModelsSection';

// Running instances on the My Models page. Each card shows the model, its
// engine and port, then every setting it was loaded with as a label/value
// grid, so what a model runs with is readable at a glance for every engine
// (llama.cpp, SGLang, Strata, vLLM).

const ENGINE_LABEL = { llamacpp: 'llama.cpp', sglang: 'SGLang', vllm: 'vLLM', strata: 'Strata' };

function fmtCtx(n) {
    const v = Number(n) || 0;
    if (!v) return '—';
    if (v >= 1048576) return `${+(v / 1048576).toFixed(1)}M`;
    if (v >= 1024) return `${Math.round(v / 1024)}K`;
    return String(v);
}
const onOff = (v) => (v ? 'On' : 'Off');
const gpus = (cfg) => (Array.isArray(cfg?.gpuDevices) && cfg.gpuDevices.length ? `GPU ${cfg.gpuDevices.join(', ')}` : 'All GPUs');

// [label, value, tooltip, highlight]
function specsFor(instance) {
    const cfg = instance.config || {};
    const backend = instance.backend || 'llamacpp';
    const common = [
        ['Context shift', onOff(cfg.contextShift), 'When a conversation outgrows the context, the oldest messages are dropped (and an oversized earlier upload is indexed) instead of the request failing.', !!cfg.contextShift],
        ['Compress memory', onOff(cfg.compressMemory), 'AIMem compresses older messages once a conversation fills most of the context.', !!cfg.compressMemory],
    ];
    if (backend === 'strata') {
        return [
            ['Context', fmtCtx(cfg.contextSize), `${Number(cfg.contextSize || 0).toLocaleString()} tokens`],
            ['Quant', cfg.strataSize || '—', 'Model file Strata runs'],
            ['KV cache', cfg.kv || 'q4_0', 'Format of the conversation memory'],
            ['Requests', cfg.parallelSlots ?? 1, 'Requests served at the same time'],
            ['GPUs', gpus(cfg), 'Cards this model uses'],
            ['Tuning', cfg.tune && cfg.tune !== 'skip' ? cfg.tune : 'Saved preset', 'Strata measures settings for this machine once and reuses them'],
            ...common,
        ];
    }
    if (backend === 'sglang') {
        return [
            ['Context', fmtCtx(cfg.maxModelLen || cfg.contextSize), `${Number(cfg.maxModelLen || cfg.contextSize || 0).toLocaleString()} tokens`],
            ['KV cache', cfg.kvCacheDtype || 'auto', 'KV cache data type'],
            ['Requests', cfg.maxRunningRequests ?? 256, 'Max concurrent batched requests'],
            ['Tensor parallel', cfg.tensorParallelSize ?? 1, 'GPUs the model is sharded across'],
            ['GPU memory', `${Math.round((cfg.memFractionStatic ?? 0.88) * 100)}%`, '--mem-fraction-static'],
            ['GPUs', gpus(cfg), 'Cards this model uses'],
            ['Tool parser', cfg.toolCallParser || 'auto', 'sglang tool-call parser'],
            ['Reasoning parser', cfg.reasoningParser || '—', 'Reasoning/thinking parser'],
            ...common,
        ];
    }
    if (backend === 'vllm') {
        return [
            ['Context', fmtCtx(cfg.maxModelLen || cfg.contextSize), `${Number(cfg.maxModelLen || cfg.contextSize || 0).toLocaleString()} tokens`],
            ['Requests', cfg.parallelSlots ?? 4, 'Concurrent requests'],
            ['GPUs', gpus(cfg), 'Cards this model uses'],
            ['Tool parser', cfg.toolCallParser || 'auto', 'Tool-call parser'],
            ...common,
        ];
    }
    const spec = cfg.specType === 'draft-mtp'
        ? `MTP · n${cfg.specDraftNMax ?? 3}${cfg.specNgram ? ' + n-gram' : ''}`
        : cfg.specType === 'draft-simple'
            ? `Draft model · n${cfg.specDraftNMax ?? 3}`
            : (cfg.specNgram ? 'N-gram' : 'Off');
    const layers = cfg.nGpuLayers === -1 || cfg.nGpuLayers == null ? 'All' : Number(cfg.nGpuLayers) === 0 ? 'CPU only' : cfg.nGpuLayers;
    return [
        ['Context', fmtCtx(cfg.contextSize), `${Number(cfg.contextSize || 0).toLocaleString()} tokens${Number(cfg.parallelSlots) > 1 ? `, shared by ${cfg.parallelSlots} slots` : ''}`],
        ['KV cache', cfg.cacheTypeK || 'f16', 'KV cache quantization'],
        ['Slots', cfg.parallelSlots ?? 1, 'Parallel requests'],
        ['GPUs', gpus(cfg), 'Cards this model uses'],
        ['GPU layers', layers, 'Layers offloaded to the GPUs'],
        ['Split', cfg.splitMode === 'tensor' ? 'Tensor' : cfg.splitMode === 'row' ? 'Row' : 'Layer', 'How the model is spread over several cards'],
        ['Speculative', spec, 'Speculative decoding', spec !== 'Off'],
        ['Prompt cache', cfg.cacheRam != null && cfg.cacheRam !== '' ? (Number(cfg.cacheRam) > 0 ? `${Math.round(Number(cfg.cacheRam) / 1024)} GB RAM` : 'Off') : 'Auto', 'Host-RAM prompt cache (--cache-ram)'],
        ['Reasoning', cfg.disableThinking ? 'Off' : 'On', 'Whether the model thinks before answering'],
        ...(cfg.flashAttention ? [['Flash attention', 'On', 'Flash attention', true]] : []),
        ...(cfg.backendSampling ? [['GPU sampling', 'On', 'Sampling runs on the GPU', true]] : []),
        ...common,
    ];
}

function InstanceCard({ instance, onStop }) {
    const engine = ENGINE_LABEL[instance.backend] || 'llama.cpp';
    const status = instance.status || 'running';
    const ready = status === 'running';
    return (
        <div className="mm-instance flex flex-col rounded-xl border" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}>
            <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
                <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: ready ? '#22c55e' : '#f59e0b', boxShadow: ready ? '0 0 0 3px rgba(34,197,94,0.15)' : '0 0 0 3px rgba(245,158,11,0.15)' }}
                    title={ready ? 'Running' : status}
                />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" style={{ color: 'var(--text-primary)' }} title={instance.name}>{instance.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{engine}</span>
                        <span>·</span>
                        <span>port {instance.port}</span>
                        {!ready && (<><span>·</span><span style={{ color: '#f59e0b' }}>{status}</span></>)}
                    </div>
                </div>
                <Tooltip title="Stop this model and free its GPUs">
                    <button
                        type="button"
                        onClick={() => onStop(instance.name, instance.backend)}
                        aria-label={`Stop ${instance.name}`}
                        className="mm-stop inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium"
                    >
                        <StopIcon size={12} strokeWidth={2.5} />
                        Stop
                    </button>
                </Tooltip>
            </div>
            <dl className="mm-specs grid border-t px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
                {specsFor(instance).map(([label, value, tip, on]) => (
                    <Tooltip key={label} title={tip || ''} placement="top" disableInteractive>
                        <div className="min-w-0">
                            <dt className="truncate text-[0.68rem]" style={{ color: 'var(--text-tertiary)' }}>{label}</dt>
                            <dd className="m-0 truncate text-[0.8rem] font-medium tabular-nums" style={{ color: on ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{value}</dd>
                        </div>
                    </Tooltip>
                ))}
            </dl>
        </div>
    );
}

export default function RunningInstancesPanel({ instances = [], onStop }) {
    if (!instances.length) return null;
    return (
        <ModelsSection
            id="running"
            icon={MemoryIcon}
            title="Running"
            count={instances.length}
            summary="Models loaded right now and the settings they run with"
        >
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {instances.map((instance) => (
                    <InstanceCard key={instance.name} instance={instance} onStop={onStop} />
                ))}
            </div>
        </ModelsSection>
    );
}
