'use strict';
// Which inference engine should run this model on this machine?
//
// Pure: it takes facts about the model, the hardware and past measurements and
// returns a ranked list with the reasons, so the same answer drives the load
// route, the UI and the tests. Nothing here touches Docker or the network.
//
// The scores are an ORDER, not a benchmark. A real measurement of the model on
// an engine (see `measured`) outranks every static rule.

const ENGINE_IDS = ['llamacpp', 'sglang', 'vllm', 'strata'];

const ENGINES = {
    llamacpp: {
        id: 'llamacpp', label: 'llama.cpp', formats: ['gguf'],
        summary: 'GGUF on any GPU, CPU offload, speculative decoding. Best for one or two users on consumer cards.',
    },
    sglang: {
        id: 'sglang', label: 'SGLang', formats: ['safetensors'], minCompute: 7.5,
        summary: 'Hugging Face weights with shared-prefix caching and native tool parsers. Best for concurrent requests.',
    },
    vllm: {
        id: 'vllm', label: 'vLLM', formats: ['safetensors'], minCompute: 7.5,
        summary: 'Widest Hugging Face architecture coverage and the most complete compressed-tensors support.',
    },
    strata: {
        id: 'strata', label: 'Strata', formats: ['gguf'], minCompute: 7.5, minDriver: 580,
        summary: 'Very large MoE models on consumer hardware: frequently used experts on the GPU, the rest in RAM.',
    },
};

// Families Strata has tuned packs for. Its pack format is per family, so any
// other model is not something it can load.
const STRATA_FAMILIES = [
    { id: 'qwen3.8-flash-next', re: /qwen[-_ ]?3\.?8[-_ ]?(flash[-_ ]?next|next[-_ ]?flash)/i, strataFamily: 'qwen' },
    { id: 'qwen3.6-35b-a3b', re: /qwen[-_ ]?3\.?6[-_ ]?35b[-_ ]?a3b/i, strataFamily: 'unsloth' },
    { id: 'deepseek-v4.1-flash', re: /deepseek[-_ ]?v?4\.?1[-_ ]?flash/i, strataFamily: 'deepseek41' },
];

// GiB of weights each published Flash-Next size needs across RAM + VRAM, and the
// expert share that has to reside somewhere (Strata docs/MODELS.md, v0.2.13).
const FLASH_NEXT_SIZES = {
    q2_0: { label: 'Q2_0', totalGiB: 37.6, expertsGiB: 34, downloadGiB: 68.5 },
    iq2_xs: { label: 'IQ2_XS', totalGiB: 39.2, expertsGiB: 35.5, downloadGiB: 76 },
    iq3_xxs: { label: 'IQ3_XXS', totalGiB: 47, expertsGiB: 43, downloadGiB: 84 },
    iq3_s: { label: 'IQ3_S', totalGiB: 54.8, expertsGiB: 50, downloadGiB: 92 },
    coder: { label: 'Coder IQ1_M', totalGiB: 27, expertsGiB: 23, downloadGiB: 60, family: 'coder' },
};

// GPU memory Strata needs beyond the experts: the non-expert weights, about
// 4 GiB for the KV cache and draft layer, and 1.5 GiB of prompt buffers on every
// card (docs/MULTI_GPU.md).
function strataVramNeedGiB(size, gpuCount) {
    return size.expertsGiB + (size.totalGiB - size.expertsGiB) + 4 + 1.5 * Math.max(1, gpuCount);
}

function modelFamily(name) {
    const text = String(name || '');
    return STRATA_FAMILIES.find(f => f.re.test(text)) || null;
}

function detectQuant(text) {
    const s = String(text || '');
    const m = s.match(/\b(NVFP4|MXFP4|FP4|FP8|AWQ|GPTQ|BF16|F16)\b/i);
    if (m) return m[1].toUpperCase();
    const g = s.match(/\b(U?D?-?I?Q\d(?:_[A-Z0-9]+)*)\b/i);
    return g ? g[1].toUpperCase() : null;
}

// Facts about a model from its name and the files it has.
function describeModel({ name, files = [], weightBytes = 0, format = null, hfRepoId = null } = {}) {
    const list = (files || []).map(f => String(f).toLowerCase());
    const hasGguf = format === 'gguf' || list.some(f => f.endsWith('.gguf')) || /gguf/i.test(name || '');
    const hasSafetensors = format === 'safetensors' || list.some(f => f.endsWith('.safetensors'))
        || (!!hfRepoId && !/gguf/i.test(hfRepoId));
    const family = modelFamily(`${name || ''} ${hfRepoId || ''}`);
    return {
        name: name || hfRepoId || '',
        hfRepoId,
        weightGiB: weightBytes > 0 ? weightBytes / (1024 ** 3) : null,
        formats: { gguf: hasGguf, safetensors: hasSafetensors },
        family: family ? family.id : null,
        strataFamily: family ? family.strataFamily : null,
        quant: detectQuant(`${name || ''} ${hfRepoId || ''}`),
        mixedPrecision: /nvfp4-fast|mixed[-_ ]?precision/i.test(`${name || ''} ${hfRepoId || ''}`),
    };
}

function vramTotals(hardware) {
    const gpus = (hardware && hardware.gpus) || [];
    const totalGiB = gpus.reduce((s, g) => s + (g.memoryTotalMiB || 0), 0) / 1024;
    const freeGiB = gpus.reduce((s, g) => s + (g.memoryFreeMiB || 0), 0) / 1024;
    return { count: gpus.length, totalGiB, freeGiB };
}

function pushIf(arr, cond, text) { if (cond) arr.push(text); }

function rankLlamacpp(model, hw, vram) {
    const out = { score: 0, viable: !!model.formats.gguf, reasons: [], warnings: [] };
    if (!out.viable) { out.reasons.push('llama.cpp needs a GGUF file and this model has none.'); return out; }
    out.score = 72;
    out.reasons.push('Runs GGUF directly and supports speculative decoding and CPU offload.');
    if (model.weightGiB && vram.totalGiB && model.weightGiB <= vram.totalGiB * 0.92) {
        out.score += 8;
        out.reasons.push(`The ${model.weightGiB.toFixed(1)} GB of weights fit entirely on the GPUs.`);
    } else if (model.weightGiB && vram.totalGiB) {
        out.score -= hw.cpu && hw.cpu.avx2 ? 22 : 48;
        out.warnings.push(`The weights (${model.weightGiB.toFixed(1)} GB) are larger than the GPUs (${vram.totalGiB.toFixed(0)} GB), so part of the model would run on the CPU${hw.cpu && !hw.cpu.avx2 ? ', which has no AVX2 here and would be very slow' : ''}.`);
    }
    if (hw.gpus && hw.gpus.length && hw.gpus.every(g => (g.computeCap || 9) < 7.5)) {
        out.score += 20;
        out.reasons.push('These GPUs are too old for the other engines.');
    }
    return out;
}

function rankHfEngine(engine, model, hw, vram) {
    const out = { score: 0, viable: !!model.formats.safetensors, reasons: [], warnings: [] };
    const label = ENGINES[engine].label;
    if (!out.viable) { out.reasons.push(`${label} needs Hugging Face weights and this model is only a GGUF.`); return out; }
    if (hw.gpus && hw.gpus.length && hw.gpus.some(g => (g.computeCap || 9) < 7.5)) {
        out.viable = false;
        out.reasons.push(`${label} needs an RTX 20 series GPU or newer.`);
        return out;
    }
    out.score = engine === 'sglang' ? 78 : 66;
    if (engine === 'sglang') out.reasons.push('Best throughput for Hugging Face weights, with prefix caching and a native tool parser.');
    else out.reasons.push('Widest Hugging Face architecture support.');
    if (engine === 'vllm' && model.mixedPrecision) {
        out.score += 16;
        out.reasons.push('This is a mixed-precision checkpoint, which vLLM loads natively.');
    }
    if (engine === 'sglang' && model.quant === 'NVFP4') out.warnings.push('NVFP4 needs an RTX 50 series GPU and the patched SGLang image; verify with a code-writing prompt.');
    if (model.weightGiB && vram.totalGiB && model.weightGiB > vram.totalGiB * 0.92) {
        out.viable = false;
        out.reasons.push(`The weights (${model.weightGiB.toFixed(1)} GB) do not fit in ${vram.totalGiB.toFixed(0)} GB of GPU memory and ${label} cannot offload to the CPU.`);
    }
    return out;
}

function rankStrata(model, hw, vram, opts = {}) {
    const out = { score: 0, viable: !!model.family, reasons: [], warnings: [], requires: [] };
    if (!model.family) { out.reasons.push('Strata only loads the model families it has packs for.'); return out; }
    if (hw.driverMajor && hw.driverMajor < ENGINES.strata.minDriver) {
        out.viable = false;
        out.reasons.push(`Strata needs NVIDIA driver ${ENGINES.strata.minDriver} or newer (this host has ${hw.driverMajor}).`);
        return out;
    }
    const size = FLASH_NEXT_SIZES[opts.size || 'q2_0'] || FLASH_NEXT_SIZES.q2_0;
    const ramGiB = hw.ramGiB || 0;
    const vramNeedGiB = strataVramNeedGiB(size, vram.count);
    const allExpertsOnGpu = vram.totalGiB >= vramNeedGiB;
    const expertsInRam = ramGiB >= size.expertsGiB + 10;
    out.score = 92;
    out.reasons.push('Purpose-built for this model family: it does not need the whole model in GPU memory.');
    if (hw.cpu && !hw.cpu.avx2) {
        out.requires.push('sse42-build');
        out.score -= 14;
        out.warnings.push('This CPU has no AVX2, so Strata must use the SSE4.2 engine built from source (experimental upstream). Any expert not held on a GPU runs very slowly on this CPU.');
        if (!allExpertsOnGpu) {
            out.viable = false;
            out.reasons.push(`Without AVX2 the experts must fit on the GPUs (${size.label}: about ${vramNeedGiB.toFixed(0)} GB; this host has ${vram.totalGiB.toFixed(0)} GB).`);
            return out;
        }
    } else if (!allExpertsOnGpu && !expertsInRam) {
        out.score -= 18;
        out.warnings.push(`${size.label} needs about ${(size.expertsGiB + 10).toFixed(0)} GB of RAM to hold its experts; this host has ${ramGiB.toFixed(0)} GB, so it reads them from the SSD and is much slower.`);
    }
    if (!expertsInRam) out.warnings.push(`Only ${ramGiB.toFixed(0)} GB of RAM: it runs in low-RAM mode, with experts mapped from the model files.`);
    if (hw.diskFreeGiB != null && hw.diskFreeGiB < size.downloadGiB + 40) {
        out.warnings.push(`Needs about ${(size.downloadGiB + 40).toFixed(0)} GB free for the download and prepared pack; ${hw.diskFreeGiB.toFixed(0)} GB is free now.`);
    }
    if (vram.freeGiB < vramNeedGiB) {
        out.requires.push('free-gpus');
        out.warnings.push('The GPUs are occupied by other loaded models, which must be unloaded first.');
    }
    return out;
}

// measured: { engine: { tokensPerSecond, samples } } for THIS model.
function applyMeasured(ranked, measured) {
    if (!measured) return ranked;
    const withSpeed = ranked.filter(r => r.viable && measured[r.engine] && measured[r.engine].tokensPerSecond > 0);
    if (withSpeed.length === 0) return ranked;
    for (const r of withSpeed) {
        r.tokensPerSecond = measured[r.engine].tokensPerSecond;
        r.reasons.unshift(`Measured on this host: ${r.tokensPerSecond.toFixed(1)} tok/s.`);
    }
    if (withSpeed.length < 2) return ranked;
    const best = withSpeed.reduce((a, b) => (b.tokensPerSecond > a.tokensPerSecond ? b : a));
    const runnerUp = Math.max(...withSpeed.filter(r => r !== best).map(r => r.tokensPerSecond));
    // A small difference is noise; do not let it override the static order.
    if (best.tokensPerSecond >= runnerUp * 1.15) best.score += 40;
    return ranked;
}

function rankEngines({ model, hardware = {}, measured = null, installed = null, size = null } = {}) {
    const vram = vramTotals(hardware);
    const results = ENGINE_IDS.map((engine) => {
        let r;
        if (engine === 'llamacpp') r = rankLlamacpp(model, hardware, vram);
        else if (engine === 'strata') r = rankStrata(model, hardware, vram, { size });
        else r = rankHfEngine(engine, model, hardware, vram);
        const isInstalled = !installed || installed[engine] !== false;
        if (r.viable && !isInstalled) {
            r.score -= 6;
            r.warnings.push(`${ENGINES[engine].label} is not installed on this server yet.`);
        }
        return { engine, label: ENGINES[engine].label, installed: isInstalled, requires: [], ...r };
    });
    applyMeasured(results, measured);
    results.sort((a, b) => (b.viable - a.viable) || (b.score - a.score));
    const best = results.find(r => r.viable) || null;
    return { recommended: best ? best.engine : null, label: best ? best.label : null, ranked: results };
}

// Keep to engines the caller can actually start for this load path.
function pickEngine(plan, allowed) {
    const row = plan.ranked.find(r => r.viable && r.installed && (!allowed || allowed.includes(r.engine)));
    return row ? row.engine : null;
}

module.exports = {
    ENGINES, ENGINE_IDS, FLASH_NEXT_SIZES, describeModel, modelFamily, detectQuant, rankEngines, pickEngine,
};
