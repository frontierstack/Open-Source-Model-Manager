FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

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

# Install vLLM with CUDA support
# Note: vLLM requires specific torch version, let vLLM manage its dependencies
RUN pip3 install --no-cache-dir vllm

# Expose port for API server
EXPOSE 8000

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
