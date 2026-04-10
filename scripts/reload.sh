#!/bin/bash

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

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Check what to reload
if [ "$1" == "webapp" ]; then
    echo ""
    echo -e "  ${BOLD}Reload Webapp${NC}"

    section "Rebuild & Restart"
    ./update.sh
    exit 0
fi

if [ "$1" == "all" ]; then
    echo ""
    echo -e "  ${BOLD}Reload All Services${NC}"
    echo -e "  ${DIM}Preserves all data${NC}"

    section "Stopping"
    start_spinner "Stopping services"
    docker compose down > /dev/null 2>&1
    stop_spinner
    log_success "Services stopped"

    section "Rebuilding"
    start_spinner "Building webapp"
    docker compose build webapp > /dev/null 2>&1
    stop_spinner
    log_success "Webapp rebuilt"

    section "Starting"
    start_spinner "Starting services"
    docker compose up -d > /dev/null 2>&1
    stop_spinner
    log_success "Services started"

    # Brief wait for logs
    sleep 3
    echo ""
    echo -e "  ${DIM}Recent webapp logs:${NC}"
    docker compose logs webapp --tail 10 2>/dev/null | sed 's/^/    /'

    echo ""
    log_success "All services reloaded"
    echo ""
    exit 0
fi

# Default: show usage
echo ""
echo -e "  ${BOLD}Reload${NC}"
echo ""
echo -e "  Usage:"
echo -e "    ./reload.sh ${BOLD}webapp${NC}     Rebuild and restart webapp only"
echo -e "    ./reload.sh ${BOLD}all${NC}        Rebuild and restart all services"
echo ""
