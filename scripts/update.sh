#!/bin/bash
set -e

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
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

SYM_OK="${GREEN}✓${NC}"
SYM_FAIL="${RED}✗${NC}"
SYM_WARN="${YELLOW}!${NC}"
SYM_ARROW="${CYAN}→${NC}"

log_success() { echo -e "  ${SYM_OK}  $1"; }
log_warning() { echo -e "  ${SYM_WARN}  ${YELLOW}$1${NC}"; }
log_error()   { echo -e "  ${SYM_FAIL}  ${RED}$1${NC}"; }
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

fmt_duration() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then
        echo "$((secs / 60))m $((secs % 60))s"
    else
        echo "${secs}s"
    fi
}

# Print banner
echo ""
echo -e "  ${BOLD}Update Webapp${NC}"

# Parse arguments
STOP_INSTANCES=false
NO_CACHE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --stop-instances)
            STOP_INSTANCES=true
            shift
            ;;
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        -h|--help)
            echo ""
            echo "  Usage: $0 [OPTIONS]"
            echo ""
            echo "  Options:"
            echo "    --stop-instances   Stop running model instances before update"
            echo "    --no-cache         Rebuild without Docker cache"
            echo "    -h, --help         Show this help message"
            echo ""
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Optionally stop model instances
if [ "$STOP_INSTANCES" = true ]; then
    section "Stop Instances"
    start_spinner "Stopping model instances"
    docker ps --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
    docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true
    docker ps --filter "name=vllm-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
    docker ps -a --filter "name=vllm-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true
    stop_spinner
    log_success "Model instances stopped"
fi

section "Build"

BUILD_START=$(date +%s)
start_spinner "Rebuilding webapp image"
if [ "$NO_CACHE" = true ]; then
    docker compose build webapp --no-cache > /dev/null 2>&1
else
    docker compose build webapp > /dev/null 2>&1
fi
stop_spinner
BUILD_DUR=$(( $(date +%s) - BUILD_START ))
log_success "Image rebuilt  ${DIM}$(fmt_duration $BUILD_DUR)${NC}"

section "Deploy"

start_spinner "Recreating container"
docker compose up -d webapp > /dev/null 2>&1
stop_spinner
log_success "Container recreated"

# Wait for webapp to be ready
start_spinner "Waiting for webapp"
MAX_RETRIES=30
RETRY_COUNT=0
WEBAPP_READY=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -sk https://localhost:3001/api/webapp-credentials 2>/dev/null | grep -q "apiKey"; then
        WEBAPP_READY=true
        break
    elif curl -s http://localhost:3001/api/webapp-credentials 2>/dev/null | grep -q "apiKey"; then
        WEBAPP_READY=true
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 2
done
stop_spinner

if [ "$WEBAPP_READY" = true ]; then
    log_success "Webapp ready"
    echo ""
    echo -e "  ${BOLD}https://localhost:3001${NC}"
    echo -e "  ${DIM}Hard refresh your browser (Ctrl+Shift+R) to see changes.${NC}"
else
    log_warning "Webapp may still be starting"
    echo -e "  ${DIM}Check logs: docker compose logs -f webapp${NC}"
fi
echo ""
