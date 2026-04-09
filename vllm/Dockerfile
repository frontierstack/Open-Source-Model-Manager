FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

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
# Pin to a known-good minor range: 0.6.x has stable GGUF quantization for
# Qwen2/Qwen3/Llama/Mistral families and well-tested CUDA 12.1 wheels.
# Unpinning this has historically broken GGUF loading whenever upstream ships
# a breaking change in the quantization backend (see vLLM GH issues #8757,
# #9064). Bump this intentionally after verifying GGUF still works.
# Let vLLM manage its own torch version.
ARG VLLM_VERSION=0.6.6.post1
#
# Pin transformers to the 4.x line.
#
# vllm 0.6.6.post1 declares `transformers>=4.45.2` with no upper bound, and
# by default pip resolves to the latest, which is the 5.x line. transformers
# 5.x has a hard bug where `is_gguf_available()` crashes on every GGUF load:
#
#   1. Its `_is_package_available("gguf")` looks up the package in a hardcoded
#      `PACKAGE_DISTRIBUTION_MAPPING` table. `gguf` is not in the table, so
#      the primary lookup raises KeyError.
#   2. The fallback does `getattr(module, "__version__", "N/A")`, but the
#      gguf Python module never exposed `__version__` (only GGUF_VERSION,
#      which is a file format constant).
#   3. is_gguf_available then calls `packaging.version.parse("N/A")` and
#      crashes with `InvalidVersion: 'N/A'`.
#
# The 4.x line's `_is_package_available` reads version directly via
# `importlib.metadata.version(pkg_name)`, which works fine. Pin to 4.x.
RUN pip3 install --no-cache-dir "vllm==${VLLM_VERSION}" "transformers>=4.45.2,<5.0"

# Reinstall `gguf` with clean PyPI metadata. Defense in depth: transformers
# 4.x reads importlib.metadata directly, so we want the package metadata to
# report a real version string rather than 'N/A' under any circumstance.
# --no-deps ensures we don't disturb anything else vllm already pinned.
RUN pip3 install --no-cache-dir --force-reinstall --no-deps "gguf>=0.10.0,<0.18.0"

# Verify the fix at build time so a broken base image never ships.
RUN python3 -c "import transformers; print('transformers version:', transformers.__version__); assert transformers.__version__.startswith('4.'), 'transformers is not 4.x'" && \
    python3 -c "import gguf, importlib.metadata as m; v = m.version('gguf'); print('gguf version:', v); assert v and v != 'N/A', 'gguf metadata still broken'" && \
    python3 -c "from transformers.utils.import_utils import is_gguf_available; assert is_gguf_available(), 'transformers is_gguf_available() returned False'"

# Expose port for API server
EXPOSE 8000

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
