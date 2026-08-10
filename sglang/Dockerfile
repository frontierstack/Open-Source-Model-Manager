# Stay on the cu129 variant: cu130 exists for the same tag but raises the CUDA
# runtime/driver floor, which is unverified against this project's R570 hosts.
FROM lmsysorg/sglang:v0.5.17-cu129-runtime

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

# openai's Python SDK imports `distro` for user-agent fingerprinting. The
# v0.5.12 base image shipped without it and crashed at import time, before any
# flag was parsed. v0.5.17 declares distro in its own pyproject and installs it
# in the upstream Dockerfile, so this is now belt-and-braces — kept because it
# is idempotent and near-free, and the runtime stage's dependency set has
# historically drifted. The build-time smoke test below is what actually
# guarantees the import works.
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

# Three of the four mixed-precision patches this file used to carry are now
# FIXED UPSTREAM as of v0.5.17 and have been deleted. Do not reinstate them —
# their anchor strings no longer exist, so the `assert src.count(old) == 1`
# guard would hard-fail `docker build`. For the record, and so the history is
# recoverable if a future base image regresses:
#   (a)+(b) mixed-precision format detection (unsloth NVFP4 "-Fast" class: FP8
#       attention + NVFP4 experts). Upstream now threads the PER-GROUP
#       `format` through _quantization_scheme_map_from_config and gives
#       _get_scheme_from_parts an explicit `format` param, so the global
#       "mixed-precision" tag no longer parses input_activations to None for
#       every target (which used to crash with
#       AttributeError: 'NoneType' object has no attribute 'num_bits', or
#       "No compressed-tensors compatible scheme was found" on shared_expert).
#   (c) ignore-list matching. should_ignore_layer now calls a new
#       check_equal_or_regex_match() — exact, regex, or dotted-path SUFFIX,
#       never a prefix — with our exact bug report as its docstring. A parent
#       ignore entry can no longer swallow its quantized children (which used
#       to cast FP8 bytes to bf16 without scales → fluent-looking gibberish).
# Only the lm_head patch below is still required.

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
#
# RE-ANCHORING NOTE (v0.5.17): load_weights_and_postprocess was rewritten
# upstream — it gained memory telemetry and an NVFP4-online branch, so there
# are now THREE `model.load_weights(weights)` call sites and the old
# three-line anchor is gone. The patch is therefore split in two: insert the
# helper before the (still unique) staticmethod signature, then inject the
# call on the unique quant_config/is_nvfp4_online pair, which sits above the
# branch and so covers BOTH the nvfp4-online and the plain path.
RUN python3 - <<'PYEOF'
path = "/sgl-workspace/sglang/python/sglang/srt/model_loader/loader.py"
src = open(path).read()
anchor_def = """    @staticmethod
    def load_weights_and_postprocess(model, weights, target_device):
"""
anchor_call = '''        quant_config = getattr(model, "quant_config", None)
        is_nvfp4_online = getattr(quant_config, "is_nvfp4_online", False)
'''
helper = '''    @staticmethod
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

'''
call = '''        weights = DefaultModelLoader._dequant_fp8_lm_head(model, weights)
'''

if "_dequant_fp8_lm_head" in src:
    print("already applied: lm_head dequant")
else:
    assert src.count(anchor_def) == 1, (
        f"expected 1 occurrence of the load_weights_and_postprocess staticmethod, "
        f"found {src.count(anchor_def)}"
    )
    assert src.count(anchor_call) == 1, (
        f"expected 1 occurrence of the quant_config/is_nvfp4_online pair, "
        f"found {src.count(anchor_call)}"
    )
    src = src.replace(anchor_def, helper + anchor_def)
    src = src.replace(anchor_call, call + anchor_call)
    open(path, "w").write(src)
    print("applied: lm_head dequant")

import py_compile
py_compile.compile(path, doraise=True)
print("loader.py compiles OK")

# Guard the three patches we DELETED because upstream fixed them. Their failure
# mode is silent — a checkpoint loads and generates fluent-looking GIBBERISH —
# so a base image that regresses must break the BUILD, not production. If this
# ever fires, re-read the deleted-patch notes above and reinstate them (adapted
# to the then-current source) rather than deleting this check.
base = "/sgl-workspace/sglang/python/sglang/srt/layers/quantization/compressed_tensors/"
utils_src = open(base + "utils.py").read()
ct_src = open(base + "compressed_tensors.py").read()
assert "def check_equal_or_regex_match(" in utils_src, (
    "UPSTREAM REGRESSION: compressed_tensors/utils.py no longer defines "
    "check_equal_or_regex_match — prefix-matching ignore entries can swallow "
    "quantized children again (symptom: fluent-looking gibberish)."
)
assert "check_contains=True" not in utils_src.split("def _find_first_match")[0], (
    "UPSTREAM REGRESSION: should_ignore_layer appears to use substring matching again."
)
assert "format: Optional[str] = None" in ct_src, (
    "UPSTREAM REGRESSION: _get_scheme_from_parts lost its per-group `format` "
    "parameter — mixed-precision checkpoints will crash or mis-select schemes."
)
print("upstream mixed-precision fixes verified present")
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
