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
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

SYM_OK="${GREEN}✓${NC}"
SYM_ARROW="${CYAN}→${NC}"
SYM_WARN="${YELLOW}!${NC}"

log_success() { echo -e "  ${SYM_OK}  $1"; }
log_step()    { echo -e "  ${SYM_ARROW}  $1"; }
log_warn()    { echo -e "  ${SYM_WARN}  ${YELLOW}$1${NC}"; }

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

# Model inference containers are auto-created via dockerode (NOT docker-compose),
# so `docker compose down` never touches them — they keep the GPU busy after a
# naive stop. They are always built from the modelserver-llamacpp /
# modelserver-sglang base images and named llamacpp-* / sglang-* (sglang HF
# loads are sglang-hf-*). We match on BOTH name prefix AND image (ancestor) so a
# renamed, half-created, or otherwise-named instance can't slip through and leave
# a job running on the GPU. Includes Exited/Created/Dead containers — crashed or
# OOM-killed instances keep their name reserved, causing a 409 on the next load.
collect_model_containers() {
    {
        docker ps -a --filter "name=llamacpp-" -q
        docker ps -a --filter "name=sglang-" -q
        docker ps -a --filter "ancestor=modelserver-llamacpp:latest" -q
        docker ps -a --filter "ancestor=modelserver-sglang:latest" -q
    } 2>/dev/null | sort -u
}

# Deeper safety net: any OTHER running container still holding an NVIDIA GPU is,
# in this project, a model job (the only GPU consumers are inference instances).
# We deliberately EXCLUDE the compose infra (webapp/chat) — those request the GPU
# only for nvidia-smi monitoring and are stopped by `docker compose down` below.
collect_stray_gpu_containers() {
    local id img reqs
    for id in $(docker ps -q 2>/dev/null); do
        img=$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)
        case "$img" in
            modelserver-webapp*|modelserver-chat*|*sandbox*) continue ;;
        esac
        reqs=$(docker inspect -f '{{json .HostConfig.DeviceRequests}}' "$id" 2>/dev/null)
        if echo "$reqs" | grep -qi nvidia; then
            echo "$id"
        fi
    done
}

# Union of all model + stray-GPU containers, deduped to short IDs.
ALL_IDS=$( { collect_model_containers; collect_stray_gpu_containers; } | sort -u )

if [ -z "$ALL_IDS" ]; then
    log_success "No model instances present"
else
    # Partition into running vs. not-running (exited/created/dead) so we can
    # report accurately and only `stop` the live ones.
    RUNNING_SET=$(docker ps -q 2>/dev/null)
    RUNNING_IDS=""
    for id in $ALL_IDS; do
        if echo "$RUNNING_SET" | grep -qx "$id"; then
            RUNNING_IDS="$RUNNING_IDS $id"
        fi
    done
    RUNNING_COUNT=$(echo $RUNNING_IDS | wc -w)
    TOTAL_COUNT=$(echo "$ALL_IDS" | wc -l)

    if [ "$RUNNING_COUNT" -gt 0 ]; then
        start_spinner "Stopping $RUNNING_COUNT running model instance(s) — freeing GPU"
        # Short grace period (5s) then SIGKILL: inference servers rarely flush
        # cleanly and we want the GPU released promptly.
        echo $RUNNING_IDS | xargs -r docker stop -t 5 2>/dev/null || true
        stop_spinner
        log_success "Stopped $RUNNING_COUNT running model instance(s)"
    fi

    start_spinner "Removing $TOTAL_COUNT model container(s)"
    echo "$ALL_IDS" | xargs -r docker rm -f 2>/dev/null || true
    stop_spinner
    log_success "Removed $TOTAL_COUNT model container(s)"
fi

# Verify the GPU is actually idle. If a compute process survives container
# removal it's a true orphan (stuck driver handle) — surface its PID so the
# operator can kill it; the GPU won't free on its own.
if command -v nvidia-smi >/dev/null 2>&1; then
    GPU_APPS=""
    for _ in 1 2 3; do
        GPU_APPS=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null)
        [ -z "$GPU_APPS" ] && break
        sleep 1
    done
    if [ -z "$GPU_APPS" ]; then
        log_success "GPU is idle — no compute processes remain"
    else
        log_warn "GPU still has active compute process(es) after container cleanup:"
        echo "$GPU_APPS" | while IFS= read -r line; do
            [ -n "$line" ] && echo -e "       ${DIM}${line}${NC}"
        done
        ORPHAN_PIDS=$(echo "$GPU_APPS" | awk -F', *' '{print $1}' | tr '\n' ' ')
        log_warn "These are orphaned (no owning container). Kill manually:  sudo kill -9${ORPHAN_PIDS:+ }${ORPHAN_PIDS}"
    fi
fi

section "Services"

start_spinner "Stopping docker compose services"
docker compose down --remove-orphans > /dev/null 2>&1
stop_spinner
log_success "All services stopped"

echo ""
echo -e "  ${DIM}Restart:  ./start.sh${NC}"
echo ""
