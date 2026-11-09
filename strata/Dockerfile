# Strata for CPUs without AVX2.
#
# The published images are built for AVX2 and can stop with "illegal instruction"
# on an older or virtual CPU. This image compiles the same engine release with
# Strata's own older-CPU switch (STRATA_ISA_FLOOR=none = SSE4.2 + POPCNT) and
# drops it into the official runtime image, so the Terminal, entrypoint and /data
# layout are upstream's. On an AVX2 host, use the published image instead: the
# webapp only prefers this one when the CPU needs it.
#
# Experimental upstream: Strata calls the older-CPU path unsupported for some
# model packs. CUDA 13.2.0 / 13.2.1 miscompile sm_120, so stay on 13.0.
ARG STRATA_VERSION=0.2.13
ARG RUNTIME_IMAGE=ghcr.io/niko1221/strata:${STRATA_VERSION}-cuda13

FROM nvidia/cuda:13.0.0-devel-ubuntu24.04 AS build
ARG STRATA_VERSION=0.2.13
ARG CUDA_ARCHITECTURES=120
ARG BUILD_JOBS
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PATH=/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates git libgomp1 libatomic1 python3 python3-pip python3-venv unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch v${STRATA_VERSION} https://github.com/Niko1221/Strata.git .
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt -r requirements-build.txt
RUN /venv/bin/python -c "import setup; print(setup.get_llama_cpp())"
# GGML_* off keeps the llama.cpp half of the engine to what this CPU has, too.
RUN set -e; \
    cmake -G Ninja -S . -B build -DCMAKE_BUILD_TYPE=Release -DSTRATA_ENABLE_CUDA=ON -DSTRATA_BUILD_TESTS=OFF \
        -DSTRATA_NATIVE_EXPERTS=ON -DSTRATA_Q6K_EXPERTS=ON -DSTRATA_MMQ_KQUANTS=ON \
        -DSTRATA_ISA_FLOOR=none \
        "-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES}" \
        -DSTRATA_GGML_DIR=/src/third_party/llama.cpp; \
    cmake --build build --target strata strata_kq -j "${BUILD_JOBS:-$(nproc)}"; \
    mkdir -p /stage; cp build/strata /stage/; \
    [ -f build/libstrata_kq.so ] && cp build/libstrata_kq.so /stage/ || true

FROM ${RUNTIME_IMAGE}
ARG STRATA_VERSION=0.2.13
LABEL modelserver.engine.version=${STRATA_VERSION}
COPY --from=build /stage/ /tmp/stage/
# Replace the AVX2 binaries in the engine component the runtime image ships.
RUN set -e; d=$(ls -d /opt/strata/components/engine/*-cuda-cuda13); \
    cp /tmp/stage/strata "$d/strata"; \
    [ -f /tmp/stage/libstrata_kq.so ] && cp /tmp/stage/libstrata_kq.so "$d/libstrata_kq.so" || true; \
    rm -rf /tmp/stage
