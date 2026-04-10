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

# Print banner
echo ""
echo -e "  ${BOLD}Model Server Reset${NC}"

# Parse arguments
FORCE_RESET=false
REBUILD_IMAGES=false
FULL_WIPE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_RESET=true
            shift
            ;;
        --rebuild)
            REBUILD_IMAGES=true
            shift
            ;;
        --full)
            FULL_WIPE=true
            shift
            ;;
        -h|--help)
            echo ""
            echo "  Usage: $0 [OPTIONS]"
            echo ""
            echo "  Options:"
            echo "    -f, --force        Skip confirmation prompts"
            echo "    --rebuild          Rebuild Docker images from scratch"
            echo "    --full             Full factory reset (removes EVERYTHING including models)"
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

# Confirm reset
if [ "$FORCE_RESET" = false ]; then
    if [ "$FULL_WIPE" = true ]; then
        echo ""
        echo -e "  ${RED}${BOLD}FULL FACTORY RESET${NC}"
        echo -e "  ${DIM}This will permanently delete:${NC}"
        echo -e "  ${DIM}  - All downloaded models${NC}"
        echo -e "  ${DIM}  - All user accounts${NC}"
        echo -e "  ${DIM}  - All API keys and sessions${NC}"
        echo -e "  ${DIM}  - All agents, skills, and tasks${NC}"
        echo ""
        read -p "  Type 'YES' to confirm: " -r
        echo ""
        if [ "$REPLY" != "YES" ]; then
            echo -e "  ${DIM}Reset cancelled.${NC}"
            exit 0
        fi
    else
        echo ""
        echo -e "  ${DIM}This will remove API keys, settings, and model instances.${NC}"
        read -p "  Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "  ${DIM}Reset cancelled.${NC}"
            exit 0
        fi
    fi
fi

# ============================================================================
# RESET
# ============================================================================

section "Stop Services"

start_spinner "Stopping model instances"
docker ps --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true
docker ps --filter "name=vllm-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker ps -a --filter "name=vllm-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true
stop_spinner
log_success "Model instances stopped"

start_spinner "Stopping compose services"
docker compose down 2>/dev/null || true
stop_spinner
log_success "Services stopped"

section "Clean Data"

start_spinner "Removing webapp data volume"
docker volume rm modelserver_webapp_data 2>/dev/null || \
docker volume rm opensourcemodelmanager_webapp_data 2>/dev/null || \
docker volume rm webapp_data 2>/dev/null || true
stop_spinner
log_success "Webapp data removed"

if [ "$FULL_WIPE" = true ]; then
    start_spinner "Removing all downloaded models"
    if [ -d "$PROJECT_DIR/models" ]; then
        rm -rf "$PROJECT_DIR/models"/* 2>/dev/null || true
        rm -rf "$PROJECT_DIR/models"/.* 2>/dev/null || true
    fi
    stop_spinner
    log_success "Models deleted"
fi

if [ "$REBUILD_IMAGES" = true ]; then
    section "Rebuild Images"
    log_step "This may take 20–30 minutes"
    echo ""
    docker compose --profile build-only build llamacpp --no-cache 2>&1 | tail -3
    log_success "llamacpp rebuilt"
    docker compose --profile build-only build vllm --no-cache 2>&1 | tail -3
    log_success "vllm rebuilt"
    docker compose build webapp --no-cache 2>&1 | tail -3
    log_success "webapp rebuilt"
fi

section "Restart"

# SSL certificates
if [ ! -f "$PROJECT_DIR/certs/server.key" ] || [ ! -f "$PROJECT_DIR/certs/server.crt" ]; then
    start_spinner "Generating SSL certificates"
    mkdir -p "$PROJECT_DIR/certs"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$PROJECT_DIR/certs/server.key" \
        -out "$PROJECT_DIR/certs/server.crt" \
        -subj "/C=US/ST=Local/L=Local/O=ModelServer/OU=Development/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" 2>/dev/null
    chmod 600 "$PROJECT_DIR/certs/server.key"
    chmod 644 "$PROJECT_DIR/certs/server.crt"
    stop_spinner
    log_success "SSL certificates generated"
else
    log_success "SSL certificates found"
fi

start_spinner "Starting services"
docker compose up -d > /dev/null 2>&1
stop_spinner
log_success "Services started"

# Wait for webapp
MAX_RETRIES=30
RETRY_COUNT=0
WEBAPP_READY=false
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    CREDS=$(curl -sk https://localhost:3001/api/webapp-credentials 2>/dev/null || echo "")
    if [ -n "$CREDS" ] && [ "$CREDS" != "{}" ]; then
        WEBAPP_READY=true
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    printf "\r  ${CYAN}⠸${NC}  Waiting for webapp (%d/%d)" "$RETRY_COUNT" "$MAX_RETRIES"
    sleep 2
done
printf "\r\033[K"

if [ "$WEBAPP_READY" = true ]; then
    log_success "Webapp ready"
else
    log_warning "Webapp may still be starting"
fi

section "Done"

if [ "$FULL_WIPE" = true ]; then
    echo -e "  ${DIM}Factory reset complete. All data removed.${NC}"
    echo ""
fi
echo -e "  ${BOLD}https://localhost:3001${NC}"
echo ""
