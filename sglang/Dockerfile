FROM lmsysorg/sglang:v0.5.12-cu129-runtime

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1
ARG PIP_TRUSTED_HOST
ARG PIP_CERT

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV no_proxy=${NO_PROXY}

ENV PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
ENV PIP_CERT=${PIP_CERT}

ENV SGLANG_HOST=0.0.0.0
ENV SGLANG_PORT=8001
# HF_HOME must point at a WRITABLE path. /models is bind-mounted read-only
# (set in webapp's createContainer for safety — keeps model files from being
# clobbered by a runaway server). The docker-compose-managed `hf_cache`
# named volume gets mounted at /root/.cache/huggingface for the HF-load
# code path; HF_HOME points there so transformers caches downloaded
# configs/tokenizers in a place it's allowed to write.
ENV HF_HOME=/root/.cache/huggingface
ENV HF_TOKEN=""

RUN if ! command -v curl >/dev/null 2>&1; then \
        apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*; \
    fi

# Patch missing transitive dep: openai's Python SDK imports `distro` for
# user-agent fingerprinting, but lmsysorg/sglang:v0.5.12-cu129-runtime ships
# without it. Without this line, `python3 -m sglang.launch_server` crashes at
# import time with ModuleNotFoundError before any flag is parsed.
RUN pip install --no-cache-dir --root-user-action=ignore distro

# The `nixl_cu12` Python package (NVIDIA NIM Exchange Library, used for
# disaggregated prefill/decode KV-cache transfer) bundles its own copy of
# libucs/UCX compiled with AVX. On QEMU virtual CPUs and other hosts
# without AVX support, dlopen of this UCX bombs out with
#   FATAL: UCX library was compiled with avx but CPU does not support it.
# and segfaults during sglang server init — before any chat request is
# accepted. We only use the non-disaggregated TP path here, so remove the
# bundled UCX libs so sglang skips them. (Leaves nixl_cu12 itself
# importable; only the AVX-compiled UCX transport is dropped.)
RUN rm -rf /usr/local/lib/python3.12/dist-packages/nixl_cu12.libs/libucs*.so* \
           /usr/local/lib/python3.12/dist-packages/nixl_cu12.libs/ucx \
    2>/dev/null || true

# Patch compressed-tensors format detection for mixed-precision checkpoints
# (e.g. unsloth NVFP4 "-Fast" quants: FP8 attention + NVFP4 MoE experts).
# Those checkpoints set the TOP-LEVEL quantization format to "mixed-precision"
# and carry the real format per config_group ("float-quantized" /
# "nvfp4-pack-quantized"). sglang's _quantization_scheme_map_from_config only
# checks the global format, is_activation_quantization_format("mixed-precision")
# is False, so input_activations parses to None for every target — the NVFP4
# detector then can't match and _is_dynamic_token_w8a8 crashes with
# AttributeError: 'NoneType' object has no attribute 'num_bits'. Two spots,
# mirroring vLLM: (1) the config parser prefers the per-group format, falling
# back to the global one (no-op for checkpoints without per-group formats);
# (2) _get_scheme_from_parts' activation-scheme gate also accepts a parsed
# input_quant — with fix (1), input_quant is only non-None when that group's
# format IS activation-quantized, so the global "mixed-precision" tag no
# longer blocks linear W4A4/W8A8 scheme selection ("No compressed-tensors
# compatible scheme was found" on the shared_expert projections).
RUN python3 - <<'PYEOF'
path = "/sgl-workspace/sglang/python/sglang/srt/layers/quantization/compressed_tensors/compressed_tensors.py"
src = open(path).read()
patches = [
    (
        "                if is_activation_quantization_format(quant_format):",
        "                if is_activation_quantization_format(\n"
        "                    quant_config.get(\"format\") or quant_format\n"
        "                ):",
    ),
    (
        "        if is_activation_quantization_format(self.quant_format):",
        "        if (\n"
        "            is_activation_quantization_format(self.quant_format)\n"
        "            or input_quant is not None\n"
        "        ):",
    ),
]
for old, new in patches:
    if new in src:
        print("already applied:", old.strip()[:60])
        continue
    assert src.count(old) == 1, f"expected 1 occurrence, found {src.count(old)}: {old.strip()[:60]}"
    src = src.replace(old, new)
    print("applied:", old.strip()[:60])
open(path, "w").write(src)

# Ignore-list matching must be exact-or-regex like vLLM, NOT substring.
# sglang's should_ignore_layer passes check_contains=True, so a checkpoint
# ignore entry naming a PARENT module (e.g. Qwen3.6's
# "model.language_model.layers.N.linear_attn", meant for its non-linear
# internals) swallows quantized CHILDREN (in_proj_qkvz / out_proj, FP8 with
# weight_scale in the checkpoint). Those layers then build unquantized, the
# FP8 bytes cast into bf16 without scales, and the model generates gibberish
# ("Parameter ...weight_scale not found in params_dict" warnings at load are
# the tell). Checkpoints enumerate ignored children explicitly because the
# reference (vLLM) semantics are exact-match. Only caller is
# should_ignore_layer in this file; quark has its own separate copy.
path = "/sgl-workspace/sglang/python/sglang/srt/layers/quantization/compressed_tensors/utils.py"
src = open(path).read()
patches = [
    (
        "        if _is_equal_or_regex_match(layer_name, target, check_contains=True):",
        "        if _is_equal_or_regex_match(layer_name, target):",
    ),
]
for old, new in patches:
    if new in src:
        print("already applied:", old.strip()[:60])
        continue
    assert src.count(old) == 1, f"expected 1 occurrence, found {src.count(old)}: {old.strip()[:60]}"
    src = src.replace(old, new)
    print("applied:", old.strip()[:60])
open(path, "w").write(src)

# Dequantize an FP8 lm_head at load time. Checkpoints like the unsloth NVFP4
# "-Fast" series quantize lm_head to FP8 (weight fp8_e4m3 + per-channel
# weight_scale), but sglang builds lm_head unquantized (CompressedTensors
# get_quant_method only handles LinearBase/FusedMoE, and _compute_lm_head
# matmuls lm_head.weight DIRECTLY whenever the attribute exists — it never
# consults a quant scheme). Without this, the fp8 bytes are cast to bf16
# WITHOUT the scale: per-vocab-row logit warping — short high-margin answers
# survive, longer generations degrade into wrong tokens and repetition loops,
# and the load logs "Parameter lm_head.weight_scale not found in params_dict".
# Fix: pair lm_head.weight (fp8) with lm_head.weight_scale in the weight
# stream and emit the dequantized bf16 tensor instead; drop the now-consumed
# scale. Only fires when the MODEL's lm_head param is non-fp8 (a model that
# natively supports a quantized lm_head is untouched), chunked to bound the
# fp32 temp.
path = "/sgl-workspace/sglang/python/sglang/srt/model_loader/loader.py"
src = open(path).read()
old = """    @staticmethod
    def load_weights_and_postprocess(model, weights, target_device):
        model.load_weights(weights)
"""
new = '''    @staticmethod
    def _dequant_fp8_lm_head(model, weights):
        import torch

        fp8_dtypes = (torch.float8_e4m3fn, torch.float8_e5m2)
        needs = any(
            n.endswith("lm_head.weight") and p.dtype not in fp8_dtypes
            for n, p in model.named_parameters()
        )
        held = {}
        for name, tensor in weights:
            if needs and name.endswith("lm_head.weight") and tensor.dtype in fp8_dtypes:
                base = name[: -len(".weight")]
                held.setdefault(base, {})["w"] = tensor
            elif needs and name.endswith("lm_head.weight_scale"):
                base = name[: -len(".weight_scale")]
                held.setdefault(base, {})["s"] = tensor
            else:
                yield name, tensor
                continue
            entry = held[base]
            if "w" in entry and "s" in entry:
                w = entry.pop("w")
                s = entry.pop("s")
                held.pop(base, None)
                out = torch.empty(w.shape, dtype=torch.bfloat16, device=w.device)
                scale = s.to(torch.float32).reshape(-1, 1)
                step = 16384
                for i in range(0, w.shape[0], step):
                    sl = scale[i : i + step] if scale.shape[0] > 1 else scale
                    out[i : i + step] = (
                        w[i : i + step].to(torch.float32) * sl
                    ).to(torch.bfloat16)
                logger.info(
                    "Dequantized fp8 %s.weight with its weight_scale "
                    "(model lm_head is unquantized).", base
                )
                yield base + ".weight", out
        # Unpaired leftovers (weight without scale): pass the weight through.
        for base, entry in held.items():
            if "w" in entry:
                yield base + ".weight", entry["w"]

    @staticmethod
    def load_weights_and_postprocess(model, weights, target_device):
        weights = DefaultModelLoader._dequant_fp8_lm_head(model, weights)
        model.load_weights(weights)
'''
if "_dequant_fp8_lm_head" in src:
    print("already applied: lm_head dequant")
else:
    assert src.count(old) == 1, f"expected 1 occurrence of load_weights_and_postprocess, found {src.count(old)}"
    src = src.replace(old, new)
    open(path, "w").write(src)
    print("applied: lm_head dequant")
import py_compile
py_compile.compile(path, doraise=True)
print("loader.py compiles OK")
# Reset path+src so the shared tail below rewrites utils.py with its own
# (unchanged) content — NOT loader.py.
path = "/sgl-workspace/sglang/python/sglang/srt/layers/quantization/compressed_tensors/utils.py"
src = open(path).read()
patches = []
for old, new in patches:
    if new in src:
        print("already applied:", old.strip()[:60])
        continue
    assert src.count(old) == 1, f"expected 1 occurrence, found {src.count(old)}: {old.strip()[:60]}"
    src = src.replace(old, new)
    print("applied:", old.strip()[:60])
open(path, "w").write(src)
PYEOF

# Fail the build now rather than at first model load if the base image is broken.
# Importing `openai` exercises the distro patch above; importing `sglang` proves
# the entrypoint path will resolve.
RUN python3 -c "import sglang, openai, distro; print('sglang version:', sglang.__version__)"

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=3s --start-period=180s --retries=30 \
    CMD curl -fsS http://localhost:8001/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
