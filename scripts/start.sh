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
echo -e "  ${BOLD}Model Server${NC}"
echo -e "  ${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"

# ============================================================================
# CHECK PREREQUISITES
# ============================================================================

section "Preflight"

# Check required Docker images
REQUIRED_IMAGES=("modelserver-webapp:latest" "modelserver-llamacpp:latest" "modelserver-vllm:latest")
MISSING_IMAGES=()

for img in "${REQUIRED_IMAGES[@]}"; do
    if [[ -z $(docker images -q $img 2>/dev/null) ]]; then
        MISSING_IMAGES+=("$img")
    fi
done

if [ ${#MISSING_IMAGES[@]} -gt 0 ]; then
    log_error "Missing Docker images:"
    for img in "${MISSING_IMAGES[@]}"; do
        echo -e "    ${DIM}$img${NC}"
    done
    echo ""
    echo -e "  Run ${BOLD}./build.sh${NC} first."
    echo ""
    exit 1
fi
log_success "Docker images found"

# SSL certificates
if [ ! -f "$PROJECT_DIR/certs/server.key" ] || [ ! -f "$PROJECT_DIR/certs/server.crt" ]; then
    start_spinner "Generating SSL certificates"
    mkdir -p "$PROJECT_DIR/certs"
    if [ -f "$PROJECT_DIR/certs/generate-certs.sh" ]; then
        chmod +x "$PROJECT_DIR/certs/generate-certs.sh"
        "$PROJECT_DIR/certs/generate-certs.sh" >/dev/null 2>&1
    else
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout "$PROJECT_DIR/certs/server.key" \
            -out "$PROJECT_DIR/certs/server.crt" \
            -subj "/C=US/ST=Local/L=Local/O=ModelServer/OU=Development/CN=localhost" \
            -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" 2>/dev/null
        chmod 600 "$PROJECT_DIR/certs/server.key"
        chmod 644 "$PROJECT_DIR/certs/server.crt"
    fi
    stop_spinner
    log_success "SSL certificates generated"
else
    log_success "SSL certificates found"
fi

# ============================================================================
# START SERVICES
# ============================================================================

section "Starting Services"

log_step "Creating containers"
docker compose up -d 2>&1 | while IFS= read -r line; do
    # Show container lifecycle events
    if echo "$line" | grep -qiE '(created|started|running|pulling|recreat)'; then
        svc=$(echo "$line" | sed 's/.*Container //' | sed 's/ .*//' | head -c 40)
        action=$(echo "$line" | grep -oiE '(Created|Started|Running|Pulling|Recreated)' | head -1)
        if [ -n "$svc" ] && [ -n "$action" ]; then
            echo -e "  ${DIM}  $svc: $action${NC}"
        fi
    fi
done
log_success "Containers started"

# Wait for webapp to be ready with countdown
MAX_RETRIES=30
RETRY_COUNT=0
WEBAPP_READY=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -sk https://localhost:3001/api/models 2>/dev/null > /dev/null; then
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
    log_warning "Webapp may still be starting — check logs if it doesn't respond"
fi

# Check chat service
if curl -sk https://localhost:3002/health 2>/dev/null | grep -q "ok"; then
    log_success "Chat UI ready"
else
    log_warning "Chat UI not responding yet"
fi

# ============================================================================
# SUMMARY
# ============================================================================

section "Ready"

echo -e "  ${BOLD}Webapp${NC}   https://localhost:3001"
echo -e "  ${BOLD}Chat UI${NC}  https://localhost:3002"
echo ""
echo -e "  ${DIM}Your browser will show a certificate warning — this is expected.${NC}"
echo ""
echo -e "  ${DIM}Logs:   docker compose logs -f${NC}"
echo -e "  ${DIM}Stop:   ./stop.sh${NC}"
echo ""
