#!/bin/bash
# Entrypoint for llama.cpp server
# Configuration via environment variables:
# - LLAMA_MODEL_PATH: Path to GGUF model file
# - LLAMA_PORT: API server port (default: 8000)
# - LLAMA_N_GPU_LAYERS: Number of layers to offload to GPU (-1 = all, default: -1)
# - LLAMA_CTX_SIZE: Context size (default: 4096)
# - LLAMA_CTX_SHIFT: Enable context shifting (default: true)
# - LLAMA_FLASH_ATTN: Flash attention — true|false|auto (default: false)
# - LLAMA_REASONING: Reasoning/thinking mode — on|off|auto (default: auto).
#                    Set to 'off' to disable <think> blocks server-side for
#                    reasoning models (e.g. Gemma thinking variants, DeepSeek
#                    R1). Works for any model llama.cpp recognizes — unlike
#                    the '/no_think' prompt prefix which is Qwen-specific.
# - LLAMA_CACHE_TYPE_K: KV cache type for keys (f16/q8_0/q4_0, default: f16)
# - LLAMA_CACHE_TYPE_V: KV cache type for values (f16/q8_0/q4_0, default: f16)
# - LLAMA_THREADS: Number of CPU threads (default: auto-detect)
# - LLAMA_PARALLEL: Number of parallel slots (default: 1)
# - LLAMA_BATCH_SIZE: Batch size for prompt processing (default: 2048)
# - LLAMA_UBATCH_SIZE: Micro-batch size (default: 512)
# - LLAMA_REPEAT_PENALTY: Repetition penalty (default: 1.1)
# - LLAMA_REPEAT_LAST_N: Last N tokens for repetition penalty (default: 64)
# - LLAMA_PRESENCE_PENALTY: Presence penalty (default: 0.0)
# - LLAMA_FREQUENCY_PENALTY: Frequency penalty (default: 0.0)
# - LLAMA_CTX_CHECKPOINTS: Max SWA/context checkpoints stored per slot
#   (default: 2). llama.cpp's built-in default is 8 which, with a large
#   --ctx-size and SWA models like Gemma, can accumulate multi-GB of KV
#   state in host RAM per slot and OOM-kill the container. A small cap
#   preserves some prefix-reuse benefit without unbounded growth.

set -e

# Default values
MODEL_PATH=${LLAMA_MODEL_PATH:-/models/default.gguf}
PORT=${LLAMA_PORT:-8000}
N_GPU_LAYERS=${LLAMA_N_GPU_LAYERS:--1}
CTX_SIZE=${LLAMA_CTX_SIZE:-4096}
CTX_SHIFT=${LLAMA_CTX_SHIFT:-true}
FLASH_ATTN=${LLAMA_FLASH_ATTN:-false}
REASONING=${LLAMA_REASONING:-auto}
CACHE_TYPE_K=${LLAMA_CACHE_TYPE_K:-f16}
CACHE_TYPE_V=${LLAMA_CACHE_TYPE_V:-f16}
THREADS=${LLAMA_THREADS:-}
PARALLEL=${LLAMA_PARALLEL:-1}
BATCH_SIZE=${LLAMA_BATCH_SIZE:-2048}
UBATCH_SIZE=${LLAMA_UBATCH_SIZE:-512}
REPEAT_PENALTY=${LLAMA_REPEAT_PENALTY:-1.1}
REPEAT_LAST_N=${LLAMA_REPEAT_LAST_N:-64}
PRESENCE_PENALTY=${LLAMA_PRESENCE_PENALTY:-0.0}
FREQUENCY_PENALTY=${LLAMA_FREQUENCY_PENALTY:-0.0}
CTX_CHECKPOINTS=${LLAMA_CTX_CHECKPOINTS:-2}

echo ">>> Starting llama.cpp server"
echo "    Model: $MODEL_PATH"
echo "    Port: $PORT"
echo "    GPU Layers: $N_GPU_LAYERS"
echo "    Context Size: $CTX_SIZE"
echo "    Context Shift: $CTX_SHIFT"
echo "    Flash Attention: $FLASH_ATTN"
echo "    Reasoning: $REASONING"
echo "    Cache Type K/V: $CACHE_TYPE_K / $CACHE_TYPE_V"
echo "    Threads: ${THREADS:-auto}"
echo "    Parallel Slots: $PARALLEL"
echo "    Batch Size: $BATCH_SIZE"
echo "    Micro-batch Size: $UBATCH_SIZE"
echo "    Repeat Penalty: $REPEAT_PENALTY"
echo "    Repeat Last N: $REPEAT_LAST_N"
echo "    Presence Penalty: $PRESENCE_PENALTY"
echo "    Frequency Penalty: $FREQUENCY_PENALTY"
echo "    Context Checkpoints: $CTX_CHECKPOINTS"

# Build command arguments
CMD_ARGS=(
    --model "$MODEL_PATH"
    --port "$PORT"
    --host 0.0.0.0
    --n-gpu-layers "$N_GPU_LAYERS"
    --ctx-size "$CTX_SIZE"
    --parallel "$PARALLEL"
    --batch-size "$BATCH_SIZE"
    --ubatch-size "$UBATCH_SIZE"
    --cache-type-k "$CACHE_TYPE_K"
    --cache-type-v "$CACHE_TYPE_V"
    --repeat-penalty "$REPEAT_PENALTY"
    --repeat-last-n "$REPEAT_LAST_N"
    --presence-penalty "$PRESENCE_PENALTY"
    --frequency-penalty "$FREQUENCY_PENALTY"
    --ctx-checkpoints "$CTX_CHECKPOINTS"
)

# Add threads if specified
if [ -n "$THREADS" ]; then
    CMD_ARGS+=(--threads "$THREADS")
    echo "    [Threads set to $THREADS]"
fi

# Disable context shift if requested (enabled by default in llama.cpp)
if [ "$CTX_SHIFT" = "false" ]; then
    CMD_ARGS+=(--no-context-shift)
    echo "    [Context shift DISABLED]"
fi

# Flash attention — current llama.cpp requires an explicit value.
# Map LLAMA_FLASH_ATTN to on/off/auto and always pass it so the UI
# toggle has deterministic, observable behavior (default 'auto'
# would otherwise silently enable FA on capable hardware regardless
# of the user's toggle state).
case "$FLASH_ATTN" in
    true|on|1)   FA_MODE=on ;;
    auto)        FA_MODE=auto ;;
    *)           FA_MODE=off ;;
esac
CMD_ARGS+=(--flash-attn "$FA_MODE")
echo "    [Flash attention: $FA_MODE]"

# Reasoning/thinking mode — same on/off/auto shape as --flash-attn.
# Passing 'off' makes llama.cpp disable <think> blocks server-side for
# any reasoning model it recognizes from the chat template.
case "$REASONING" in
    on|1|true)   REASONING_MODE=on ;;
    off|0|false) REASONING_MODE=off ;;
    *)           REASONING_MODE=auto ;;
esac
CMD_ARGS+=(--reasoning "$REASONING_MODE")
echo "    [Reasoning: $REASONING_MODE]"

echo ""
echo ">>> Starting llama.cpp with OpenAI-compatible API"
echo ""

# Start the llama.cpp server
exec llama-server "${CMD_ARGS[@]}"
