# vLLM 0.19.x ships PyTorch 2.10 + cu128. The CUDA base image MUST match
# torch's CUDA version or the AWQ-Marlin / FlashInfer / NVFP4 kernel PTX
# fails to load with cudaErrorUnsupportedPtxVersion. cu128 also covers
# Blackwell sm_120 natively (RTX 5060 Ti and friends).
#
# Use -devel (not -runtime): FlashInfer JIT-compiles FP4 / NVFP4 kernels
# for sm_120a at first model load, which requires nvcc + the full CUDA
# headers. With the runtime image, NVFP4 loads die with:
#   /bin/sh: 1: /usr/local/cuda/bin/nvcc: not found
# (FAILED: ... /root/.cache/flashinfer/.../fp4_gemm_cutlass_*.cuda.o)
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04

# Build arguments for corporate proxy/SSL environments
# Pass these at build time: docker build --build-arg HTTP_PROXY=http://proxy:port ...
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1
ARG PIP_TRUSTED_HOST
ARG PIP_CERT

# Set proxy environment variables if provided
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV no_proxy=${NO_PROXY}

# Python/pip SSL configuration for corporate environments
ENV PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
ENV PIP_CERT=${PIP_CERT}

# Install Python, build tools (for Triton compilation), and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --no-cache-dir --upgrade pip

# Install vLLM with CUDA support.
# 0.19.x adds Qwen3.6 (gated-delta-networks MoE, 35B/3B-active, 262K context)
# and Gemma 4 (multimodal text+image+audio MoE, 26B/4B-active, 256K context),
# plus FP8 / NVFP4 improvements for Blackwell sm_120. The .1 patch upgrades
# transformers to 5.5.3 and ships the Gemma4 model_type fix. Let vLLM resolve
# its own torch / transformers pins on this minor.
ARG VLLM_VERSION=0.19.1
RUN pip3 install --no-cache-dir "vllm==${VLLM_VERSION}"

# Reinstall gguf and patch its package __init__ to expose __version__.
# transformers 5.x is_gguf_available() reads gguf.__version__ directly as a
# module attribute (not via importlib.metadata), but the gguf package only
# defines GGUF_VERSION (a file-format constant). Without __version__,
# packaging.version.parse('N/A') crashes on every GGUF load. Inject the
# real PyPI version into the package's __init__ at build time.
RUN pip3 install --no-cache-dir --force-reinstall --no-deps "gguf>=0.10.0" && \
    GGUF_VER=$(python3 -c "import importlib.metadata as m; print(m.version('gguf'))") && \
    GGUF_INIT=$(python3 -c "import gguf, os; print(os.path.join(os.path.dirname(gguf.__file__), '__init__.py'))") && \
    if ! grep -q '^__version__' "$GGUF_INIT"; then echo "__version__ = \"$GGUF_VER\"" >> "$GGUF_INIT"; fi

# Verify at build time so a broken base image never ships.
RUN python3 -c "import vllm; print('vllm version:', vllm.__version__)" && \
    python3 -c "import transformers; print('transformers version:', transformers.__version__)" && \
    python3 -c "import gguf; v = getattr(gguf, '__version__', None); print('gguf.__version__:', v); assert v and v != 'N/A', 'gguf module __version__ still missing'" && \
    python3 -c "from transformers.utils.import_utils import is_gguf_available; assert is_gguf_available(), 'transformers is_gguf_available() returned False'"

# Expose port for API server
EXPOSE 8000

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
