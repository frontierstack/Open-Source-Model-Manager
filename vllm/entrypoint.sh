#!/bin/bash
# Entrypoint for vLLM server
# Configuration via environment variables:
# - VLLM_MODEL_PATH: Path to model file (GGUF or HuggingFace model)
# - VLLM_PORT: API server port (default: 8000)
# - VLLM_MAX_MODEL_LEN: Maximum context length (default: 4096)
# - VLLM_CPU_OFFLOAD_GB: GB of model weights to offload to CPU RAM (default: 0)
# - VLLM_GPU_MEMORY_UTILIZATION: Fraction of GPU memory to use 0.0-1.0 (default: 0.9)
# - VLLM_TENSOR_PARALLEL_SIZE: Number of GPUs for tensor parallelism (default: 1)
# - VLLM_MAX_NUM_SEQS: Maximum number of concurrent sequences (default: 256)
# - VLLM_KV_CACHE_DTYPE: KV cache data type: auto or fp8 (default: auto)
# - VLLM_TRUST_REMOTE_CODE: Trust remote code from model repo (default: true)
# - VLLM_ENFORCE_EAGER: Disable CUDA graph for debugging (default: false)

set -e

# Default values
MODEL_PATH=${VLLM_MODEL_PATH:-/models/default.gguf}
PORT=${VLLM_PORT:-8000}
MAX_MODEL_LEN=${VLLM_MAX_MODEL_LEN:-4096}
CPU_OFFLOAD_GB=${VLLM_CPU_OFFLOAD_GB:-0}
GPU_MEMORY_UTILIZATION=${VLLM_GPU_MEMORY_UTILIZATION:-0.9}
TENSOR_PARALLEL_SIZE=${VLLM_TENSOR_PARALLEL_SIZE:-1}
MAX_NUM_SEQS=${VLLM_MAX_NUM_SEQS:-256}
KV_CACHE_DTYPE=${VLLM_KV_CACHE_DTYPE:-auto}
TRUST_REMOTE_CODE=${VLLM_TRUST_REMOTE_CODE:-true}
ENFORCE_EAGER=${VLLM_ENFORCE_EAGER:-false}

echo ">>> Starting vLLM server"
echo "    Model: $MODEL_PATH"
echo "    Port: $PORT"
echo "    Max Model Length: $MAX_MODEL_LEN"
echo "    CPU Offload: ${CPU_OFFLOAD_GB}GB"
echo "    GPU Memory Utilization: $GPU_MEMORY_UTILIZATION"
echo "    Tensor Parallel Size: $TENSOR_PARALLEL_SIZE"
echo "    Max Concurrent Sequences: $MAX_NUM_SEQS"
echo "    KV Cache Dtype: $KV_CACHE_DTYPE"
echo "    Trust Remote Code: $TRUST_REMOTE_CODE"
echo "    Enforce Eager: $ENFORCE_EAGER"

# Build command arguments
CMD_ARGS=(
    --model "$MODEL_PATH"
    --port "$PORT"
    --host 0.0.0.0
    --max-model-len "$MAX_MODEL_LEN"
    --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
    --tensor-parallel-size "$TENSOR_PARALLEL_SIZE"
    --max-num-seqs "$MAX_NUM_SEQS"
    --kv-cache-dtype "$KV_CACHE_DTYPE"
)

# Add CPU offload if specified
if [ "$CPU_OFFLOAD_GB" != "0" ]; then
    CMD_ARGS+=(--cpu-offload-gb "$CPU_OFFLOAD_GB")
    echo "    [CPU offload ENABLED - ${CPU_OFFLOAD_GB}GB to system RAM]"
fi

# Auto-detect GGUF models and add quantization flag
if [[ "$MODEL_PATH" == *.gguf ]]; then
    CMD_ARGS+=(--quantization gguf)
    echo "    [GGUF model detected - using GGUF quantization]"
fi

# Add trust remote code if enabled
if [ "$TRUST_REMOTE_CODE" = "true" ]; then
    CMD_ARGS+=(--trust-remote-code)
    echo "    [Trust remote code ENABLED]"
fi

# Add enforce eager if enabled (useful for debugging)
if [ "$ENFORCE_EAGER" = "true" ]; then
    CMD_ARGS+=(--enforce-eager)
    echo "    [Enforce eager mode ENABLED - CUDA graphs disabled]"
fi

echo ""
echo ">>> Starting vLLM with OpenAI-compatible API"
echo ""

# Start the vLLM server with OpenAI-compatible API
python3 -m vllm.entrypoints.openai.api_server "${CMD_ARGS[@]}"
