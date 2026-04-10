#!/bin/bash
set -e

# Require root / sudo for Docker access
if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo "  This script requires root privileges (for Docker)."
    echo "  Run with:  sudo $0 $*"
    echo ""
    exit 1
fi

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ============================================================================
# TERMINAL OUTPUT HELPERS
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

SYM_OK="${GREEN}✓${NC}"
SYM_ARROW="${CYAN}→${NC}"

log_success() { echo -e "  ${SYM_OK}  $1"; }
log_step()    { echo -e "  ${SYM_ARROW}  $1"; }

section() {
    echo ""
    echo -e "  ${BOLD}${CYAN}$1${NC}"
    echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${NC}"
}

SPINNER_PID=""
start_spinner() {
    local msg="$1"
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    (
        local i=0
        while true; do
            printf "\r  ${CYAN}${frames[$i]}${NC}  %s" "$msg"
            i=$(( (i + 1) % ${#frames[@]} ))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    disown $SPINNER_PID 2>/dev/null
}

stop_spinner() {
    if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null || true
    fi
    SPINNER_PID=""
    printf "\r\033[K"
}

# Print banner
echo ""
echo -e "  ${BOLD}Model Server Stop${NC}"

section "Model Instances"

# Stop llama.cpp instances
LLAMACPP_COUNT=$(docker ps --filter "name=llamacpp-" -q 2>/dev/null | wc -l)
if [ "$LLAMACPP_COUNT" -gt 0 ]; then
    start_spinner "Stopping $LLAMACPP_COUNT llama.cpp instance(s)"
    docker ps --filter "name=llamacpp-" -q | xargs -r docker stop 2>/dev/null || true
    sleep 1
    docker ps -a --filter "name=llamacpp-" -q | xargs -r docker rm 2>/dev/null || true
    stop_spinner
    log_success "Stopped $LLAMACPP_COUNT llama.cpp instance(s)"
fi

# Stop vLLM instances
VLLM_COUNT=$(docker ps --filter "name=vllm-" -q 2>/dev/null | wc -l)
if [ "$VLLM_COUNT" -gt 0 ]; then
    start_spinner "Stopping $VLLM_COUNT vLLM instance(s)"
    docker ps --filter "name=vllm-" -q | xargs -r docker stop 2>/dev/null || true
    sleep 1
    docker ps -a --filter "name=vllm-" -q | xargs -r docker rm 2>/dev/null || true
    stop_spinner
    log_success "Stopped $VLLM_COUNT vLLM instance(s)"
fi

TOTAL_COUNT=$((LLAMACPP_COUNT + VLLM_COUNT))
if [ "$TOTAL_COUNT" -eq 0 ]; then
    log_success "No model instances running"
fi

section "Services"

start_spinner "Stopping docker compose services"
docker compose down --remove-orphans > /dev/null 2>&1
stop_spinner
log_success "All services stopped"

echo ""
echo -e "  ${DIM}Restart:  ./start.sh${NC}"
echo ""
