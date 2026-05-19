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
