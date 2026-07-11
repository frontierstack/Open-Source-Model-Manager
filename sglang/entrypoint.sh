#!/bin/bash
set -euo pipefail

MODEL_PATH="${SGLANG_MODEL_PATH:-}"
SERVED_MODEL_NAME="${SGLANG_SERVED_MODEL_NAME:-}"
HOST="${SGLANG_HOST:-0.0.0.0}"
PORT="${SGLANG_PORT:-8001}"
MAX_MODEL_LEN="${SGLANG_MAX_MODEL_LEN:-}"
MEM_FRACTION_STATIC="${SGLANG_MEM_FRACTION_STATIC:-0.88}"
TP_SIZE="${SGLANG_TENSOR_PARALLEL_SIZE:-1}"
CHUNKED_PREFILL_SIZE="${SGLANG_CHUNKED_PREFILL_SIZE:-4096}"
MAX_RUNNING_REQUESTS="${SGLANG_MAX_RUNNING_REQUESTS:-}"
SCHEDULE_POLICY="${SGLANG_SCHEDULE_POLICY:-lpm}"
KV_CACHE_DTYPE="${SGLANG_KV_CACHE_DTYPE:-auto}"
TOOL_CALL_PARSER="${SGLANG_TOOL_CALL_PARSER:-}"
REASONING_PARSER="${SGLANG_REASONING_PARSER:-}"
TRUST_REMOTE_CODE="${SGLANG_TRUST_REMOTE_CODE:-0}"
DTYPE="${SGLANG_DTYPE:-auto}"
QUANTIZATION="${SGLANG_QUANTIZATION:-}"
LOAD_FORMAT="${SGLANG_LOAD_FORMAT:-auto}"
CHAT_TEMPLATE="${SGLANG_CHAT_TEMPLATE:-}"
EXTRA_ARGS="${SGLANG_EXTRA_ARGS:-}"

# CRITICAL: unset SGLANG_PORT after capturing it. sglang's internal
# get_open_port() (srt/utils/network.py) honors a SGLANG_PORT env var when
# allocating INTERNAL scheduler/dist-init ports — with TP>=2 the scheduler
# asks for a port before uvicorn starts, gets handed $PORT, and the actual
# HTTP server then dies with "[Errno 98] address already in use" AFTER the
# whole model has loaded. SGLANG_HOST unset too for symmetry (harmless).
unset SGLANG_PORT SGLANG_HOST

if [ -z "$MODEL_PATH" ]; then
    echo "[sglang] ERROR: SGLANG_MODEL_PATH is required (HF repo id or /models/<path>)" >&2
    exit 2
fi

GPU_COUNT=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0)
if [ "$GPU_COUNT" -lt 1 ]; then
    echo "[sglang] ERROR: no GPUs visible to container (nvidia-smi -L empty). Check --gpus all / nvidia runtime." >&2
    exit 2
fi
# Requesting more shards than GPUs hangs sglang at NCCL init with no useful log; clamp early.
if [ "$TP_SIZE" -gt "$GPU_COUNT" ]; then
    echo "[sglang] WARN: requested TP=$TP_SIZE but only $GPU_COUNT GPU(s) visible; clamping to $GPU_COUNT" >&2
    TP_SIZE="$GPU_COUNT"
fi

if [[ "$MODEL_PATH" == *.gguf ]]; then
    IS_GGUF=1
    RESOLVED_GGUF="$MODEL_PATH"
elif [ -d "$MODEL_PATH" ] && compgen -G "$MODEL_PATH"/*.gguf > /dev/null; then
    IS_GGUF=1
    # Multi-shard GGUFs follow the llama.cpp naming convention <name>-00001-of-0000N.gguf;
    # only the 00001 shard is the entry point. sglang/llama.cpp opens the primary and
    # discovers siblings by suffix — pointing at a non-primary shard fails to load.
    PRIMARIES=()
    while IFS= read -r f; do
        base=$(basename "$f")
        if [[ "$base" =~ -0000[2-9]-of-|-001[0-9]-of-|-0[1-9][0-9][0-9]-of- ]]; then
            continue
        fi
        PRIMARIES+=("$f")
    done < <(find "$MODEL_PATH" -maxdepth 1 -type f -name '*.gguf' | sort)
    if [ "${#PRIMARIES[@]}" -eq 0 ]; then
        echo "[sglang] ERROR: directory contains only non-primary GGUF shards: $MODEL_PATH" >&2
        exit 2
    fi
    if [ "${#PRIMARIES[@]}" -gt 1 ]; then
        echo "[sglang] ERROR: multiple primary GGUF files in $MODEL_PATH:" >&2
        printf '  %s\n' "${PRIMARIES[@]}" >&2
        echo "[sglang] Merge them first: llama-gguf-split --merge <first-shard> <output.gguf>" >&2
        exit 2
    fi
    RESOLVED_GGUF="${PRIMARIES[0]}"
    MODEL_PATH="$RESOLVED_GGUF"
else
    IS_GGUF=0
fi

if [ "$IS_GGUF" -eq 1 ]; then
    # sglang accepts GGUF only when BOTH flags are set; --load-format gguf alone
    # picks the right loader but leaves quantization=None, which then trips the
    # weight-shape check on packed tensors.
    LOAD_FORMAT="gguf"
    QUANTIZATION="gguf"
    if [ ! -r "$RESOLVED_GGUF" ]; then
        echo "[sglang] ERROR: GGUF file not readable: $RESOLVED_GGUF" >&2
        exit 2
    fi
    echo "[sglang] GGUF detected: $RESOLVED_GGUF (forcing --load-format gguf --quantization gguf)"
fi

if [[ "$MODEL_PATH" == /models/* ]] || [[ "$MODEL_PATH" == /* ]]; then
    if [ ! -e "$MODEL_PATH" ]; then
        echo "[sglang] ERROR: model path does not exist: $MODEL_PATH" >&2
        exit 2
    fi
fi

if [ -z "$SERVED_MODEL_NAME" ]; then
    if [ "$IS_GGUF" -eq 1 ]; then
        SERVED_MODEL_NAME=$(basename "$MODEL_PATH" .gguf)
    else
        SERVED_MODEL_NAME=$(basename "$MODEL_PATH")
    fi
fi

CMD=(python3 -m sglang.launch_server
    --model-path "$MODEL_PATH"
    --served-model-name "$SERVED_MODEL_NAME"
    --host "$HOST"
    --port "$PORT"
    --mem-fraction-static "$MEM_FRACTION_STATIC"
    --tp "$TP_SIZE"
    --chunked-prefill-size "$CHUNKED_PREFILL_SIZE"
    --schedule-policy "$SCHEDULE_POLICY"
    --kv-cache-dtype "$KV_CACHE_DTYPE"
    --dtype "$DTYPE"
    --load-format "$LOAD_FORMAT"
)

[ -n "$MAX_MODEL_LEN" ] && CMD+=(--context-length "$MAX_MODEL_LEN")
[ -n "$MAX_RUNNING_REQUESTS" ] && CMD+=(--max-running-requests "$MAX_RUNNING_REQUESTS")
[ -n "$QUANTIZATION" ] && CMD+=(--quantization "$QUANTIZATION")
[ -n "$TOOL_CALL_PARSER" ] && CMD+=(--tool-call-parser "$TOOL_CALL_PARSER")
[ -n "$REASONING_PARSER" ] && CMD+=(--reasoning-parser "$REASONING_PARSER")
[ -n "$CHAT_TEMPLATE" ] && CMD+=(--chat-template "$CHAT_TEMPLATE")
case "${TRUST_REMOTE_CODE,,}" in 1|true|yes) CMD+=(--trust-remote-code) ;; esac
[ -n "$EXTRA_ARGS" ] && read -r -a EXTRA_ARR <<< "$EXTRA_ARGS" && CMD+=("${EXTRA_ARR[@]}")

echo "[sglang] launching $SERVED_MODEL_NAME on $HOST:$PORT | TP=$TP_SIZE | mem=$MEM_FRACTION_STATIC | parsers: tool=${TOOL_CALL_PARSER:-none} reasoning=${REASONING_PARSER:-none}"
echo "[sglang] cmd: ${CMD[*]}"

# Forward SIGTERM so sglang's signal handler runs graceful shutdown (drains
# inflight requests, releases KV cache) instead of dying mid-decode.
trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child"' TERM INT
"${CMD[@]}" &
child=$!
wait "$child"
