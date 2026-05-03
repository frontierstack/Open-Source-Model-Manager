# Optional image generation service. Disabled by default — runs only when
# the `imagegen` compose profile is enabled (`docker compose --profile
# imagegen up -d imagegen`). Loaded by the `generate_image` skill via
# http://imagegen:5000/generate over the modelserver_default network.
#
# Model: SDXL-Turbo (stabilityai/sdxl-turbo). 4-step diffusion at
# guidance_scale=0; ~3-8s/image on a typical GPU after warm. Cold start
# downloads the model (~5GB) on first request and caches it under
# /root/.cache/huggingface (mounted as a docker volume so it survives
# container restarts). The model is NOT baked into the image to keep
# the build artifact under ~6GB instead of ~11GB.

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-dev \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Torch first (large, cached separately so subsequent rebuilds are fast).
RUN pip3 install --no-cache-dir --break-system-packages \
        --index-url https://download.pytorch.org/whl/cu124 \
        torch==2.5.1

# Diffusers + a tiny FastAPI server. Pin exact versions for build
# reproducibility; bumping these requires retesting SDXL-Turbo's pipeline
# class API (AutoPipelineForText2Image).
RUN pip3 install --no-cache-dir --break-system-packages \
        diffusers==0.31.0 \
        transformers==4.46.3 \
        accelerate==1.1.1 \
        safetensors==0.4.5 \
        huggingface-hub==0.26.2 \
        pillow==11.0.0 \
        fastapi==0.115.5 \
        uvicorn[standard]==0.32.1

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 5000

# Single worker — the GPU is the bottleneck and we keep one warm pipeline
# in memory. uvicorn's default reload + multiple workers would each load
# their own copy and OOM the GPU. Healthcheck hits /health which doesn't
# trigger model load.
CMD ["python3", "-m", "uvicorn", "server:app", \
     "--host", "0.0.0.0", "--port", "5000", \
     "--workers", "1", "--log-level", "warning"]
