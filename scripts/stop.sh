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

# Count both running and exited containers. Crashed/OOM-killed instances
# stay in "Exited" state and would otherwise be skipped, leaving their
# container name reserved so the next load fails with a 409 conflict.
cleanup_instances() {
    local label="$1"
    local filter="$2"
    local running_count exited_count total_count
    running_count=$(docker ps --filter "$filter" -q 2>/dev/null | wc -l)
    exited_count=$(docker ps -a --filter "$filter" --filter "status=exited" --filter "status=created" --filter "status=dead" -q 2>/dev/null | wc -l)
    total_count=$((running_count + exited_count))
    if [ "$total_count" -eq 0 ]; then
        return
    fi
    if [ "$running_count" -gt 0 ]; then
        start_spinner "Stopping $running_count running $label instance(s)"
        docker ps --filter "$filter" -q | xargs -r docker stop 2>/dev/null || true
        stop_spinner
    fi
    start_spinner "Removing $total_count $label container(s)"
    docker ps -a --filter "$filter" -q | xargs -r docker rm -f 2>/dev/null || true
    stop_spinner
    if [ "$exited_count" -gt 0 ] && [ "$running_count" -eq 0 ]; then
        log_success "Cleaned $exited_count stale $label container(s)"
    else
        log_success "Stopped $total_count $label instance(s)"
    fi
}

cleanup_instances "llama.cpp" "name=llamacpp-"
cleanup_instances "vLLM" "name=vllm-"

# Combined check across both backends for the "nothing to do" message.
LLAMACPP_REMAINING=$(docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | wc -l)
VLLM_REMAINING=$(docker ps -a --filter "name=vllm-" -q 2>/dev/null | wc -l)
if [ "$((LLAMACPP_REMAINING + VLLM_REMAINING))" -eq 0 ]; then
    log_success "No model instances present"
fi

section "Services"

start_spinner "Stopping docker compose services"
docker compose down --remove-orphans > /dev/null 2>&1
stop_spinner
log_success "All services stopped"

echo ""
echo -e "  ${DIM}Restart:  ./start.sh${NC}"
echo ""
