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

RUN cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="52;60;70;75;80;86;89;90;120" \
    -DCMAKE_BUILD_TYPE=Release \
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
