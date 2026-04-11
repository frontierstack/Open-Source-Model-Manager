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
# - VLLM_TOKENIZER: HuggingFace tokenizer repo (optional, for GGUF models)
# - VLLM_CHAT_TEMPLATE: Path or inline Jinja2 chat template (optional, auto-detected for GGUF)

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
TOKENIZER=${VLLM_TOKENIZER:-}
CHAT_TEMPLATE=${VLLM_CHAT_TEMPLATE:-}

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

    # Tokenizer handling for GGUF:
    # vLLM >= 0.5 can read the tokenizer embedded in GGUF metadata, so we
    # should NOT override it unless the user explicitly configured one.
    # Previously this script hardcoded sizes (Qwen3 -> Qwen3-8B, Qwen2 ->
    # Qwen2-7B, Llama-2 -> Llama-2-7b, ...), which silently loaded the wrong
    # tokenizer for any non-7B/8B variant (26B MoE, 70B, etc.) and produced
    # garbled outputs or hard-to-diagnose load failures. If you need a
    # specific tokenizer, pass VLLM_TOKENIZER explicitly.
    if [ -z "$TOKENIZER" ]; then
        echo "    [GGUF tokenizer: using embedded metadata (set VLLM_TOKENIZER to override)]"
    fi
fi

# For GGUF models, provide a default ChatML chat template as fallback.
# vLLM requires a chat template for /v1/chat/completions — without one it
# returns 400 Bad Request. Many GGUF files lack embedded template metadata.
if [[ "$MODEL_PATH" == *.gguf ]] && [ -z "$CHAT_TEMPLATE" ]; then
    CHAT_TEMPLATE="/tmp/default_chat_template.jinja"
    cat > "$CHAT_TEMPLATE" << 'TMPL'
{% for message in messages %}
{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}
{% endfor %}
{% if add_generation_prompt %}
{{'<|im_start|>assistant\n'}}
{% endif %}
TMPL
    echo "    [Using default ChatML chat template (set VLLM_CHAT_TEMPLATE to override)]"
fi

# Add chat template if specified (or auto-generated for GGUF)
if [ -n "$CHAT_TEMPLATE" ]; then
    CMD_ARGS+=(--chat-template "$CHAT_TEMPLATE")
fi

# Add tokenizer only if the caller explicitly provided one.
if [ -n "$TOKENIZER" ]; then
    CMD_ARGS+=(--tokenizer "$TOKENIZER")
    echo "    [Using tokenizer: $TOKENIZER]"
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
