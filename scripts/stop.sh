#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  Model Server Stop"
echo "=========================================="
echo ""

# Stop all model instances (both llama.cpp and vLLM)
echo ">>> Stopping model instances..."

# Stop llama.cpp instances
LLAMACPP_COUNT=$(docker ps --filter "name=llamacpp-" -q 2>/dev/null | wc -l)
if [ "$LLAMACPP_COUNT" -gt 0 ]; then
    docker ps --filter "name=llamacpp-" -q | xargs -r docker stop 2>/dev/null || true
    sleep 1
    docker ps -a --filter "name=llamacpp-" -q | xargs -r docker rm 2>/dev/null || true
    echo ">>> Stopped $LLAMACPP_COUNT llama.cpp instance(s)"
fi

# Stop vLLM instances
VLLM_COUNT=$(docker ps --filter "name=vllm-" -q 2>/dev/null | wc -l)
if [ "$VLLM_COUNT" -gt 0 ]; then
    docker ps --filter "name=vllm-" -q | xargs -r docker stop 2>/dev/null || true
    sleep 1
    docker ps -a --filter "name=vllm-" -q | xargs -r docker rm 2>/dev/null || true
    echo ">>> Stopped $VLLM_COUNT vLLM instance(s)"
fi

TOTAL_COUNT=$((LLAMACPP_COUNT + VLLM_COUNT))
if [ "$TOTAL_COUNT" -eq 0 ]; then
    echo ">>> No model instances running"
fi

echo ""
echo ">>> Stopping docker compose services..."
docker compose down --remove-orphans

echo ""
echo "=========================================="
echo "  Model Server Stopped"
echo "=========================================="
echo ""
echo "To start again: ./start.sh"
echo ""
