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

# Build state tracking directory
BUILD_STATE_DIR="$PROJECT_DIR/.build-state"
mkdir -p "$BUILD_STATE_DIR"

# ============================================================================
# TERMINAL OUTPUT HELPERS
# ============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# Status symbols
SYM_OK="${GREEN}✓${NC}"
SYM_FAIL="${RED}✗${NC}"
SYM_SKIP="${DIM}–${NC}"
SYM_WARN="${YELLOW}!${NC}"
SYM_ARROW="${CYAN}→${NC}"

# Logging — compact, single-line where possible
log_info()    { echo -e "  ${BLUE}ℹ${NC}  $1"; }
log_success() { echo -e "  ${SYM_OK}  $1"; }
log_warning() { echo -e "  ${SYM_WARN}  ${YELLOW}$1${NC}"; }
log_error()   { echo -e "  ${SYM_FAIL}  ${RED}$1${NC}"; }
log_step()    { echo -e "  ${SYM_ARROW}  $1"; }

# Section header — visually separates build phases
section() {
    echo ""
    echo -e "  ${BOLD}${CYAN}$1${NC}"
    echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${NC}"
}

# Spinner for long-running tasks (runs in background, call stop_spinner to end)
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
    printf "\r\033[K"  # clear the spinner line
}

# Format seconds as "Xm Ys"
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
echo -e "  ${BOLD}Model Server Build System${NC}"
echo -e "  ${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo ""

# ============================================================================
# PARSE ARGUMENTS
# ============================================================================

NO_CACHE=false
CLEANUP=true
PARALLEL=true
RETRY_COUNT=2
RESUME=true
SKIP_SSL_CHECK=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        --no-cleanup)
            CLEANUP=false
            shift
            ;;
        --no-parallel)
            PARALLEL=false
            shift
            ;;
        --no-resume)
            RESUME=false
            rm -rf "$BUILD_STATE_DIR"
            mkdir -p "$BUILD_STATE_DIR"
            shift
            ;;
        --retry)
            RETRY_COUNT="$2"
            shift 2
            ;;
        --skip-ssl-check)
            SKIP_SSL_CHECK=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --no-cache       Force rebuild all images without Docker cache"
            echo "  --no-cleanup     Skip Docker system cleanup after build"
            echo "  --no-parallel    Build images sequentially instead of parallel"
            echo "  --no-resume      Start fresh build (ignore previous state)"
            echo "  --retry <n>      Number of retries on failure (default: 2)"
            echo "  --skip-ssl-check Skip SSL inspection detection"
            echo "  -h, --help       Show this help message"
            echo ""
            echo "Corporate Proxy/SSL Environment Variables:"
            echo "  HTTP_PROXY                    HTTP proxy URL"
            echo "  HTTPS_PROXY                   HTTPS proxy URL"
            echo "  NO_PROXY                      Hosts to bypass proxy"
            echo "  NODE_TLS_REJECT_UNAUTHORIZED  Set to 0 to skip SSL verification"
            echo "  GIT_SSL_NO_VERIFY             Set to true to skip git SSL verification"
            echo "  PIP_TRUSTED_HOST              pip trusted hosts"
            echo ""
            echo "Example:"
            echo "  HTTP_PROXY=http://proxy:8080 ./build.sh"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Calculate checksum of a file
get_checksum() {
    if [ -f "$1" ]; then
        md5sum "$1" | awk '{print $1}'
    else
        echo "missing"
    fi
}

# Check if build state is valid
is_build_complete() {
    local component=$1
    local state_file="$BUILD_STATE_DIR/${component}.state"
    local dockerfile="$PROJECT_DIR/${component}/Dockerfile"

    if [ ! -f "$state_file" ]; then
        return 1
    fi

    local saved_checksum=$(cat "$state_file" 2>/dev/null || echo "")
    local current_checksum=$(get_checksum "$dockerfile")

    if [ "$saved_checksum" != "$current_checksum" ]; then
        return 1
    fi

    return 0
}

# Mark build as complete
mark_build_complete() {
    local component=$1
    local dockerfile="$PROJECT_DIR/${component}/Dockerfile"
    local checksum=$(get_checksum "$dockerfile")
    echo "$checksum" > "$BUILD_STATE_DIR/${component}.state"
}

# Build a single image with retry logic
# Runs silently to a log file. Use build_with_progress() for spinner + checkpoints.
build_image() {
    local component=$1
    local image_name=$2
    local profile_arg=""

    if [ "$component" = "llamacpp" ] || [ "$component" = "vllm" ]; then
        profile_arg="--profile build-only"
    fi

    # Build args for corporate proxy/SSL environments
    local build_args=""
    [ -n "$HTTP_PROXY" ] && build_args="$build_args --build-arg HTTP_PROXY=$HTTP_PROXY"
    [ -n "$HTTPS_PROXY" ] && build_args="$build_args --build-arg HTTPS_PROXY=$HTTPS_PROXY"
    [ -n "$NO_PROXY" ] && build_args="$build_args --build-arg NO_PROXY=$NO_PROXY"
    [ -n "$NODE_TLS_REJECT_UNAUTHORIZED" ] && build_args="$build_args --build-arg NODE_TLS_REJECT_UNAUTHORIZED=$NODE_TLS_REJECT_UNAUTHORIZED"
    [ -n "$GIT_SSL_NO_VERIFY" ] && build_args="$build_args --build-arg GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY"
    [ -n "$PIP_TRUSTED_HOST" ] && build_args="$build_args --build-arg PIP_TRUSTED_HOST=$PIP_TRUSTED_HOST"
    [ -n "$PIP_CERT" ] && build_args="$build_args --build-arg PIP_CERT=$PIP_CERT"

    local attempt=1
    local max_attempts=$((RETRY_COUNT + 1))
    while [ $attempt -le $max_attempts ]; do
        if [ $attempt -gt 1 ]; then
            log_warning "${component}: retry ${attempt}/${max_attempts}"
            sleep 2
        fi

        local start_time=$(date +%s)
        local build_cmd="docker compose $profile_arg build $build_args $component"
        [ "$NO_CACHE" = true ] && build_cmd="$build_cmd --no-cache"

        if eval "$build_cmd" > "$BUILD_STATE_DIR/${component}.log" 2>&1; then
            local duration=$(( $(date +%s) - start_time ))
            mark_build_complete "$component"
            echo "$duration" > "$BUILD_STATE_DIR/${component}.duration"
            return 0
        fi

        attempt=$((attempt + 1))
    done

    log_error "${component} build failed after ${max_attempts} attempts"
    echo ""
    echo -e "  ${DIM}Last 15 lines of build log:${NC}"
    tail -15 "$BUILD_STATE_DIR/${component}.log" 2>/dev/null | sed 's/^/    /'
    echo ""
    return 1
}

# Spinner with periodic checkpoint monitoring.
# Watches one or more log files and prints key milestones below the spinner.
# Usage: start_build_spinner "label" logfile1 [logfile2 ...]
#   Stores PID in BUILD_SPINNER_PID. Call stop_build_spinner to end.
BUILD_SPINNER_PID=""

# Maps raw grep matches to friendly checkpoint descriptions
friendly_checkpoint() {
    local raw="$1"
    case "$(echo "$raw" | tr '[:upper:]' '[:lower:]')" in
        *"downloading cuda"*)  echo "Downloading CUDA toolkit" ;;
        *"installing cuda"*)   echo "Installing CUDA toolkit" ;;
        *"compiling llama"*)   echo "Compiling llama.cpp (CUDA)" ;;
        *"cmake"*)             echo "Running CMake" ;;
        *"make -j"*)           echo "Compiling native code" ;;
        *"pip install"*)       echo "Installing Python packages" ;;
        *"installing vllm"*)   echo "Installing vLLM" ;;
        *"npm ci"*)            echo "Installing npm packages" ;;
        *"npm install"*)       echo "Installing npm packages" ;;
        *"npm run build"*)     echo "Building frontend bundle" ;;
        *"webpack"*)           echo "Bundling with webpack" ;;
        *"apt-get update"*)    echo "Updating package lists" ;;
        *"apt-get install"*)   echo "Installing system packages" ;;
        *"exporting layers"*)  echo "Exporting image layers" ;;
        *"exporting manifest"*) echo "Finalizing image" ;;
        *)                     echo "$raw" ;;
    esac
}

CHECKPOINT_PATTERNS='downloading cuda|installing cuda|compiling llama|cmake|make -j|pip install|installing vllm|npm install|npm run build|npm ci|webpack|apt-get install|apt-get update|exporting layers|exporting manifest'

start_build_spinner() {
    local label="$1"
    shift
    local log_files=("$@")
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

    (
        local i=0
        local last_checkpoint=""
        local tick=0
        local display="$label"
        while true; do
            printf "\r\033[K  \033[0;36m${frames[$i]}\033[0m  %s" "$display"
            i=$(( (i + 1) % ${#frames[@]} ))
            tick=$((tick + 1))

            # Check logs every ~20 ticks (~3s)
            if [ $((tick % 20)) -eq 0 ]; then
                for lf in "${log_files[@]}"; do
                    if [ -f "$lf" ]; then
                        local latest
                        latest=$(grep -oiE "$CHECKPOINT_PATTERNS" "$lf" 2>/dev/null | tail -1)
                        if [ -n "$latest" ] && [ "$latest" != "$last_checkpoint" ]; then
                            last_checkpoint="$latest"
                            display=$(friendly_checkpoint "$latest")
                        fi
                    fi
                done
            fi

            sleep 0.15
        done
    ) &
    BUILD_SPINNER_PID=$!
    disown $BUILD_SPINNER_PID 2>/dev/null
}

stop_build_spinner() {
    if [ -n "$BUILD_SPINNER_PID" ] && kill -0 "$BUILD_SPINNER_PID" 2>/dev/null; then
        kill "$BUILD_SPINNER_PID" 2>/dev/null
        wait "$BUILD_SPINNER_PID" 2>/dev/null || true
    fi
    BUILD_SPINNER_PID=""
    printf "\r\033[K"
}

# Verify image exists
verify_image() {
    local image_name=$1
    if [[ -z $(docker images -q "$image_name" 2>/dev/null) ]]; then
        log_error "Image $image_name not found after build"
        return 1
    fi
    return 0
}

# ============================================================================
# PHASE 1: PREREQUISITES
# ============================================================================

section "Prerequisites"

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
# PHASE 2: SSL INSPECTION DETECTION
# ============================================================================

SSL_INSPECTION_DETECTED=false
ENV_FILE="$PROJECT_DIR/.env"

# Helper function to run a command with timeout (works across different environments)
run_with_timeout() {
    local timeout_secs=$1
    shift
    if command -v timeout &> /dev/null; then
        timeout "$timeout_secs" "$@" 2>&1
    else
        "$@" 2>&1
    fi
}

detect_ssl_inspection() {
    section "Network & SSL"

    local failures=0
    local inspection_indicators=0
    local service_failures=0

    # Quick connectivity check
    start_spinner "Checking network connectivity"
    local quick_check
    quick_check=$(curl -sS --connect-timeout 3 --max-time 5 -o /dev/null -w "%{http_code}" "https://google.com" 2>&1) || true
    stop_spinner

    if [ "$quick_check" != "200" ] && [ "$quick_check" != "301" ] && [ "$quick_check" != "302" ]; then
        log_warning "Network issues detected — skipping SSL checks"
        return 0
    fi
    log_success "Network connectivity OK"

    # Test certificate validation
    local test_urls=("https://curl.se" "https://pypi.org")
    for url in "${test_urls[@]}"; do
        local result exit_code
        result=$(curl -sS --connect-timeout 3 --max-time 5 "$url" -o /dev/null -w "%{ssl_verify_result}" 2>&1) || true
        exit_code=$?

        if [ $exit_code -ne 0 ]; then
            ((failures++))
            if echo "$result" | grep -qiE "(certificate|ssl|tls|verify|self.signed|unable to get local issuer)"; then
                ((inspection_indicators++))
                log_warning "SSL issue with $url"
            fi
        fi
    done

    # Check for corporate proxy certificate
    local cert_check
    cert_check=$(curl -sS --connect-timeout 3 -v https://google.com 2>&1 | grep -i "issuer:" | head -1) || true
    if echo "$cert_check" | grep -qiE "(zscaler|bluecoat|fortigate|paloalto|mcafee|symantec.*proxy|websense|barracuda|cisco.*umbrella|checkpoint)"; then
        ((inspection_indicators++))
        log_warning "Corporate proxy certificate: $(echo "$cert_check" | sed 's/.*issuer: //')"
    fi

    # Service-specific tests
    start_spinner "Testing HuggingFace API"
    local hf_result hf_exit
    hf_result=$(curl -sS --connect-timeout 5 --max-time 10 "https://huggingface.co/api/models?limit=1" 2>&1) || true
    hf_exit=$?
    stop_spinner

    if [ $hf_exit -ne 0 ]; then
        ((service_failures++))
        log_warning "HuggingFace API unreachable"
        if echo "$hf_result" | grep -qiE "(certificate|ssl|tls|verify)"; then
            ((inspection_indicators++))
        fi
    elif echo "$hf_result" | grep -q '"id"'; then
        log_success "HuggingFace API OK"
    else
        ((service_failures++))
        log_warning "HuggingFace API returned invalid response"
    fi

    # Python SSL test
    if command -v python3 &> /dev/null; then
        local py_result
        py_result=$(python3 -c "
import sys
try:
    import urllib.request
    urllib.request.urlopen('https://pypi.org', timeout=5)
    print('OK')
except Exception as e:
    if 'certificate' in str(e).lower() or 'ssl' in str(e).lower():
        print('SSL_ERROR')
    else:
        print('FAILED: ' + str(e)[:50])
" 2>&1) || true
        if echo "$py_result" | grep -q "SSL_ERROR"; then
            ((service_failures++))
            ((inspection_indicators++))
            log_warning "Python SSL verification failed"
        elif echo "$py_result" | grep -q "OK"; then
            log_success "Python SSL OK"
        fi
    fi

    # Decision
    if [ $inspection_indicators -ge 1 ] || [ $failures -ge 2 ] || [ $service_failures -ge 2 ]; then
        SSL_INSPECTION_DETECTED=true
        echo ""
        log_warning "SSL inspection / corporate proxy detected"
        log_step "Configuring automatic SSL bypass"

        # Update .env file
        if [ -f "$ENV_FILE" ]; then
            grep -v "^NODE_TLS_REJECT_UNAUTHORIZED=" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
            mv "$ENV_FILE.tmp" "$ENV_FILE"
        fi
        echo "# Auto-added by build.sh - SSL inspection detected" >> "$ENV_FILE"
        echo "NODE_TLS_REJECT_UNAUTHORIZED=0" >> "$ENV_FILE"

        export NODE_TLS_REJECT_UNAUTHORIZED=0
        export GIT_SSL_NO_VERIFY=true
        export PIP_TRUSTED_HOST="pypi.org pypi.python.org files.pythonhosted.org"

        # Disable BuildKit — it has its own HTTP client that ignores system CA certs,
        # causing TLS failures even when docker pull works fine through the proxy.
        export DOCKER_BUILDKIT=0
        log_step "BuildKit disabled (legacy builder respects system CA bundle)"

        log_success "SSL bypass configured"
    else
        log_success "No SSL inspection detected"
    fi
}

if [ "$SKIP_SSL_CHECK" = false ]; then
    detect_ssl_inspection
else
    log_info "SSL check skipped (--skip-ssl-check)"
fi

# ============================================================================
# PHASE 3: ANALYZE BUILD REQUIREMENTS
# ============================================================================

section "Build Plan"

BUILD_LLAMACPP=false
BUILD_VLLM=false
BUILD_WEBAPP=false

# Track reasons for the summary
declare -A BUILD_REASON

analyze_component() {
    local component=$1
    local image=$2

    if [ "$NO_CACHE" = true ] || [ "$RESUME" = false ]; then
        eval "BUILD_$(echo $component | tr '[:lower:]' '[:upper:]')=true"
        BUILD_REASON[$component]="rebuild requested"
        return
    fi

    if [[ -z $(docker images -q "$image" 2>/dev/null) ]]; then
        eval "BUILD_$(echo $component | tr '[:lower:]' '[:upper:]')=true"
        BUILD_REASON[$component]="image not found"
        return
    fi

    if ! is_build_complete "$component"; then
        eval "BUILD_$(echo $component | tr '[:lower:]' '[:upper:]')=true"
        BUILD_REASON[$component]="Dockerfile changed"
        return
    fi

    BUILD_REASON[$component]="up to date"
}

analyze_component "llamacpp" "modelserver-llamacpp:latest"
analyze_component "vllm" "modelserver-vllm:latest"
analyze_component "webapp" "modelserver-webapp:latest"

# Display build plan
for comp in llamacpp vllm webapp; do
    reason="${BUILD_REASON[$comp]}"
    needs_build=false
    eval "needs_build=\$BUILD_$(echo $comp | tr '[:lower:]' '[:upper:]')"

    if [ "$needs_build" = true ]; then
        log_step "${comp}  ${DIM}${reason}${NC}"
    else
        log_success "${comp}  ${DIM}${reason}${NC}"
    fi
done

# Check if anything needs building
if [ "$BUILD_LLAMACPP" = false ] && [ "$BUILD_VLLM" = false ] && [ "$BUILD_WEBAPP" = false ]; then
    echo ""
    log_success "All images up to date — nothing to build"
    echo ""
    echo -e "  ${DIM}Use --no-cache to force rebuild, or --no-resume to start fresh${NC}"
    echo ""
    exit 0
fi

# ============================================================================
# PHASE 4: BUILD IMAGES
# ============================================================================

TOTAL_START_TIME=$(date +%s)

# Build backend images
if [ "$BUILD_LLAMACPP" = true ] || [ "$BUILD_VLLM" = true ]; then
    section "Backend Images"

    if [ "$PARALLEL" = true ] && [ "$BUILD_LLAMACPP" = true ] && [ "$BUILD_VLLM" = true ]; then
        log_info "Building llamacpp + vllm in parallel"
        echo ""

        # Clear any stale logs so the checkpoint monitor starts fresh
        > "$BUILD_STATE_DIR/llamacpp.log" 2>/dev/null || true
        > "$BUILD_STATE_DIR/vllm.log" 2>/dev/null || true

        # Build both in background
        (
            build_image "llamacpp" "modelserver-llamacpp:latest"
            echo $? > "$BUILD_STATE_DIR/llamacpp.exit"
        ) &
        PID_LLAMACPP=$!

        (
            build_image "vllm" "modelserver-vllm:latest"
            echo $? > "$BUILD_STATE_DIR/vllm.exit"
        ) &
        PID_VLLM=$!

        # Spinner monitoring both log files for checkpoints
        start_build_spinner "Building backend images (~20–30 min)" \
            "$BUILD_STATE_DIR/llamacpp.log" "$BUILD_STATE_DIR/vllm.log"
        wait $PID_LLAMACPP 2>/dev/null || true
        wait $PID_VLLM 2>/dev/null || true
        stop_build_spinner

        echo ""

        # Check exit codes and report
        LLAMACPP_EXIT=$(cat "$BUILD_STATE_DIR/llamacpp.exit" 2>/dev/null || echo "1")
        VLLM_EXIT=$(cat "$BUILD_STATE_DIR/vllm.exit" 2>/dev/null || echo "1")

        if [ "$LLAMACPP_EXIT" = "0" ]; then
            local_dur=$(cat "$BUILD_STATE_DIR/llamacpp.duration" 2>/dev/null || echo "?")
            log_success "llamacpp  ${DIM}$(fmt_duration $local_dur)${NC}"
        else
            log_error "llamacpp build failed"
            echo ""
            echo -e "  ${DIM}Build log: $BUILD_STATE_DIR/llamacpp.log${NC}"
            tail -10 "$BUILD_STATE_DIR/llamacpp.log" 2>/dev/null | sed 's/^/    /'
            exit 1
        fi

        if [ "$VLLM_EXIT" = "0" ]; then
            local_dur=$(cat "$BUILD_STATE_DIR/vllm.duration" 2>/dev/null || echo "?")
            log_success "vllm  ${DIM}$(fmt_duration $local_dur)${NC}"
        else
            log_error "vllm build failed"
            echo ""
            echo -e "  ${DIM}Build log: $BUILD_STATE_DIR/vllm.log${NC}"
            tail -10 "$BUILD_STATE_DIR/vllm.log" 2>/dev/null | sed 's/^/    /'
            exit 1
        fi

        verify_image "modelserver-llamacpp:latest" || exit 1
        verify_image "modelserver-vllm:latest" || exit 1

    else
        # Sequential builds
        if [ "$BUILD_LLAMACPP" = true ]; then
            > "$BUILD_STATE_DIR/llamacpp.log" 2>/dev/null || true
            start_build_spinner "Building llamacpp (~20–30 min)" "$BUILD_STATE_DIR/llamacpp.log"
            if build_image "llamacpp" "modelserver-llamacpp:latest"; then
                stop_build_spinner
                local_dur=$(cat "$BUILD_STATE_DIR/llamacpp.duration" 2>/dev/null || echo "?")
                log_success "llamacpp  ${DIM}$(fmt_duration $local_dur)${NC}"
            else
                stop_build_spinner
                exit 1
            fi
            verify_image "modelserver-llamacpp:latest" || exit 1
        fi

        if [ "$BUILD_VLLM" = true ]; then
            > "$BUILD_STATE_DIR/vllm.log" 2>/dev/null || true
            start_build_spinner "Building vllm (~10–15 min)" "$BUILD_STATE_DIR/vllm.log"
            if build_image "vllm" "modelserver-vllm:latest"; then
                stop_build_spinner
                local_dur=$(cat "$BUILD_STATE_DIR/vllm.duration" 2>/dev/null || echo "?")
                log_success "vllm  ${DIM}$(fmt_duration $local_dur)${NC}"
            else
                stop_build_spinner
                exit 1
            fi
            verify_image "modelserver-vllm:latest" || exit 1
        fi
    fi
fi

# Build webapp
if [ "$BUILD_WEBAPP" = true ]; then
    section "Webapp Image"

    > "$BUILD_STATE_DIR/webapp.log" 2>/dev/null || true
    start_build_spinner "Building webapp (~2–5 min)" "$BUILD_STATE_DIR/webapp.log"
    if build_image "webapp" "modelserver-webapp:latest"; then
        stop_build_spinner
        local_dur=$(cat "$BUILD_STATE_DIR/webapp.duration" 2>/dev/null || echo "?")
        log_success "webapp  ${DIM}$(fmt_duration $local_dur)${NC}"
    else
        stop_build_spinner
        exit 1
    fi
    verify_image "modelserver-webapp:latest" || exit 1
fi

# ============================================================================
# PHASE 5: CLEANUP & SUMMARY
# ============================================================================

if [ "$CLEANUP" = true ]; then
    start_spinner "Cleaning up build cache"
    docker builder prune -af > /dev/null 2>&1 || true
    stop_spinner
    log_success "Build cache cleaned"
fi

# Calculate total build time
TOTAL_DURATION=$(( $(date +%s) - TOTAL_START_TIME ))

section "Summary"

# Build results table
for comp in llamacpp vllm webapp; do
    needs_build=false
    eval "needs_build=\$BUILD_$(echo $comp | tr '[:lower:]' '[:upper:]')"
    dur_file="$BUILD_STATE_DIR/${comp}.duration"

    if [ "$needs_build" = true ] && [ -f "$dur_file" ]; then
        echo -e "  ${SYM_OK}  ${comp}  ${DIM}built in $(fmt_duration $(cat "$dur_file"))${NC}"
    elif [ "$needs_build" = true ]; then
        echo -e "  ${SYM_OK}  ${comp}  ${DIM}built${NC}"
    else
        echo -e "  ${SYM_SKIP}  ${comp}  ${DIM}skipped${NC}"
    fi
done

echo ""
echo -e "  ${DIM}Total time:  $(fmt_duration $TOTAL_DURATION)${NC}"
echo -e "  ${DIM}Build mode:  $([ "$PARALLEL" = true ] && echo "parallel" || echo "sequential")${NC}"
if [ "$SSL_INSPECTION_DETECTED" = true ]; then
    echo -e "  ${DIM}SSL bypass:  enabled${NC}"
fi
echo ""
echo -e "  Next: ${BOLD}./start.sh${NC}"
echo ""
