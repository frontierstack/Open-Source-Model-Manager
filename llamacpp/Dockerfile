# Multi-stage build for llama.cpp with CUDA support
# Supports older GPUs (Maxwell 5.2+) through to modern GPUs (9.0)

# Stage 1: Build llama.cpp with CUDA support for wide GPU compatibility
FROM nvidia/cuda:12.8.0-devel-ubuntu22.04 AS builder

# Build arguments for corporate proxy/SSL environments
# Pass these at build time: docker build --build-arg HTTP_PROXY=http://proxy:port ...
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1
ARG GIT_SSL_NO_VERIFY

# Set proxy environment variables if provided
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV no_proxy=${NO_PROXY}

# Git SSL configuration for corporate environments (set to true to skip SSL verification)
ENV GIT_SSL_NO_VERIFY=${GIT_SSL_NO_VERIFY:-false}

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Clone llama.cpp
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp.git

# Build with CUDA support for multiple architectures
# 52  = Maxwell (Quadro M4000, GTX 900 series)
# 60  = Pascal (GTX 1000 series, Quadro P series)
# 70  = Volta (V100)
# 75  = Turing (RTX 2000 series, Quadro RTX)
# 80  = Ampere (RTX 3000 series, A100)
# 86  = Ampere (RTX 3000 series laptop)
# 89  = Ada Lovelace (RTX 4000 series)
# 90  = Hopper (H100)
# 120 = Blackwell (RTX 50 series, B100/B200)
WORKDIR /build/llama.cpp

# Link against CUDA driver stubs during build (actual driver provided at runtime)
# LIBRARY_PATH: helps the compiler find stubs when building shared libs
# LDFLAGS: tells linker to allow undefined symbols (resolved at runtime by driver)
ENV LIBRARY_PATH=/usr/local/cuda/lib64/stubs:$LIBRARY_PATH
ENV LDFLAGS="-L/usr/local/cuda/lib64/stubs -Wl,--allow-shlib-undefined"

# Notes on the non-obvious flags:
# - DO NOT SET -DGGML_NATIVE=OFF. It looks like the portable choice and
#   upstream's own .devops/cuda.Dockerfile uses it, but it is a LANDMINE here:
#   GGML_NATIVE=OFF does not mean "lowest common denominator", it means
#   "upstream's fixed baseline", which is
#     -msse4.2 -mf16c -mfma -mbmi2 -mavx -mavx2
#   This project's host is a `QEMU Virtual CPU version 2.5+` exposing ONLY
#   sse4.2 — no avx, avx2, fma, f16c or bmi2 (same non-AVX QEMU host that
#   forces the sglang UCX removal, see sglang/Dockerfile). Building with
#   NATIVE=OFF produced a llama-server that dies with SIGILL (exit 132) on
#   `--version`, before it can even parse a flag. Tested, not theorized.
#   Leaving GGML_NATIVE at its ON default makes cmake detect the ACTUAL build
#   host CPU, which is also the run host (build.sh builds locally), so the
#   binary matches the machine. If this image ever needs to be built on one
#   host and run on a weaker one, do NOT reach for NATIVE=OFF — pin the ISA
#   explicitly instead (-DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF
#   -DGGML_F16C=OFF -DGGML_BMI2=OFF) and re-test on the weakest target.
# - LLAMA_BUILD_UI / LLAMA_USE_PREBUILT_UI=OFF: llama-server links a new
#   llama-ui target whose assets are DOWNLOADED FROM HUGGING FACE at build
#   time (scripts/ui-assets.cmake fetches dist.tar.gz, then compiles a ~15 MB
#   generated ui.cpp). This container is API-only — the webapp talks to the
#   HTTP API and never opens llama.cpp's browser UI — so that's an undeclared
#   build-time network dependency and several minutes of compile for nothing.
# - CMAKE_CUDA_ARCHITECTURES: do NOT add 121 — it fails to configure on CUDA
#   12.8 (needs >=12.9) and only targets GB10/Thor parts. cmake rewrites 120
#   into 120a automatically. Do NOT move to a CUDA 13.x base either: 13.0
#   removed offline compilation for Maxwell/Pascal/Volta, which would break
#   this project's advertised Maxwell 5.2+ support.
RUN cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="52;60;70;75;80;86;89;90;120" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_BUILD_UI=OFF \
    -DLLAMA_USE_PREBUILT_UI=OFF \
    -DLLAMA_CURL=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-L/usr/local/cuda/lib64/stubs -Wl,--allow-shlib-undefined" \
    && cmake --build build --config Release -j$(nproc) --target llama-server

# Stage 2: Runtime image (smaller footprint)
FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the built static binary
COPY --from=builder /build/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# Ensure binary is executable
RUN chmod +x /usr/local/bin/llama-server

# Create models directory
RUN mkdir -p /models

# Expose API port
EXPOSE 8000

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
