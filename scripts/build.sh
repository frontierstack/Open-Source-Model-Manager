#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Build state tracking directory
BUILD_STATE_DIR="$PROJECT_DIR/.build-state"
mkdir -p "$BUILD_STATE_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo "=========================================="
echo "  Model Server Advanced Build System"
echo "=========================================="
echo ""

# Parse arguments
NO_CACHE=false
CLEANUP=true
PARALLEL=true
RETRY_COUNT=2
RESUME=true

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
            echo "Features:"
            echo "  - Incremental builds (skip existing images)"
            echo "  - Build state tracking (resume interrupted builds)"
            echo "  - Dockerfile change detection (rebuild when changed)"
            echo "  - Parallel builds (llamacpp + vllm simultaneously)"
            echo "  - Automatic retry on transient failures"
            echo "  - Build timing and progress indicators"
            echo ""
            echo "Corporate Proxy/SSL Environment Variables:"
            echo "  HTTP_PROXY                    HTTP proxy URL"
            echo "  HTTPS_PROXY                   HTTPS proxy URL"
            echo "  NO_PROXY                      Hosts to bypass proxy (default: localhost,127.0.0.1)"
            echo "  NODE_TLS_REJECT_UNAUTHORIZED  Set to 0 to skip Node.js SSL verification"
            echo "  GIT_SSL_NO_VERIFY             Set to true to skip git SSL verification"
            echo "  PIP_TRUSTED_HOST              pip trusted hosts (e.g., pypi.org)"
            echo ""
            echo "Example for corporate environment:"
            echo "  HTTP_PROXY=http://proxy:8080 HTTPS_PROXY=http://proxy:8080 ./build.sh"
            echo "  NODE_TLS_REJECT_UNAUTHORIZED=0 GIT_SSL_NO_VERIFY=true ./build.sh"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

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
        log_info "${component}: Dockerfile changed, rebuild required"
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
build_image() {
    local component=$1
    local image_name=$2
    local build_time=$3
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
    while [ $attempt -le $((RETRY_COUNT + 1)) ]; do
        log_info "Building ${component} (attempt ${attempt}/$((RETRY_COUNT + 1)))..."

        local start_time=$(date +%s)
        if [ "$NO_CACHE" = true ]; then
            if docker compose $profile_arg build $build_args "$component" --no-cache; then
                local end_time=$(date +%s)
                local duration=$((end_time - start_time))
                log_success "${component} built in ${duration}s"
                mark_build_complete "$component"
                return 0
            fi
        else
            if docker compose $profile_arg build $build_args "$component"; then
                local end_time=$(date +%s)
                local duration=$((end_time - start_time))
                log_success "${component} built in ${duration}s"
                mark_build_complete "$component"
                return 0
            fi
        fi

        if [ $attempt -le $RETRY_COUNT ]; then
            log_warning "${component} build failed, retrying..."
            attempt=$((attempt + 1))
            sleep 2
        else
            log_error "${component} build failed after $((RETRY_COUNT + 1)) attempts"
            return 1
        fi
    done
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

# Generate SSL certificates if they don't exist
echo ">>> Checking SSL certificates..."
if [ ! -f "$PROJECT_DIR/certs/server.key" ] || [ ! -f "$PROJECT_DIR/certs/server.crt" ]; then
    echo ">>> Generating SSL certificates..."
    mkdir -p "$PROJECT_DIR/certs"
    if [ -f "$PROJECT_DIR/certs/generate-certs.sh" ]; then
        chmod +x "$PROJECT_DIR/certs/generate-certs.sh"
        "$PROJECT_DIR/certs/generate-certs.sh"
    else
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout "$PROJECT_DIR/certs/server.key" \
            -out "$PROJECT_DIR/certs/server.crt" \
            -subj "/C=US/ST=Local/L=Local/O=ModelServer/OU=Development/CN=localhost" \
            -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" 2>/dev/null
        chmod 600 "$PROJECT_DIR/certs/server.key"
        chmod 644 "$PROJECT_DIR/certs/server.crt"
    fi
else
    echo ">>> SSL certificates already exist"
fi

# ============================================================================
# SSL INSPECTION DETECTION
# ============================================================================
# Detect corporate SSL inspection proxies that intercept HTTPS traffic.
# If detected, automatically configure SSL bypass for web search features.

SSL_INSPECTION_DETECTED=false
ENV_FILE="$PROJECT_DIR/.env"

detect_ssl_inspection() {
    echo ""
    echo ">>> Checking for SSL inspection/corporate proxy..."

    # Test sites that are commonly used and should have valid certificates
    local test_urls=(
        "https://curl.se"
        "https://pypi.org"
        "https://registry.npmjs.org"
        "https://duckduckgo.com"
    )

    local failures=0
    local inspection_indicators=0
    local service_failures=0

    for url in "${test_urls[@]}"; do
        # Try to connect and check certificate (with timeout wrapper to catch DNS hangs)
        local result
        local exit_code
        result=$(timeout 15 curl -sS --connect-timeout 5 --max-time 10 "$url" -o /dev/null -w "%{ssl_verify_result}" 2>&1) || true
        exit_code=$?

        if [ $exit_code -ne 0 ]; then
            ((failures++))

            # Check for specific SSL errors indicating inspection
            if echo "$result" | grep -qiE "(certificate|ssl|tls|verify|self.signed|unable to get local issuer)"; then
                ((inspection_indicators++))
                log_warning "SSL issue detected with $url"
            fi
        fi
    done

    # Also check if we can detect a corporate proxy certificate
    # by comparing certificate issuers
    local cert_check
    cert_check=$(timeout 15 curl -sS --connect-timeout 5 -v https://google.com 2>&1 | grep -i "issuer:" | head -1) || true
    if echo "$cert_check" | grep -qiE "(zscaler|bluecoat|fortigate|paloalto|mcafee|symantec.*proxy|websense|barracuda|cisco.*umbrella|checkpoint)"; then
        ((inspection_indicators++))
        log_warning "Corporate proxy certificate detected: $cert_check"
    fi

    # ========================================
    # Extended service-specific tests
    # These test actual web search and API endpoints used by the application
    # ========================================
    echo ">>> Testing web search and API services..."

    # Test 1: DuckDuckGo HTML search endpoint (actual search, not just homepage)
    echo -n "    Testing DuckDuckGo search... "
    local ddg_result
    local ddg_exit
    ddg_result=$(timeout 20 curl -sS --connect-timeout 10 --max-time 15 \
        "https://html.duckduckgo.com/html/?q=test" \
        -H "User-Agent: Mozilla/5.0" 2>&1) || true
    ddg_exit=$?
    if [ $ddg_exit -ne 0 ]; then
        ((service_failures++))
        echo "FAILED"
        if echo "$ddg_result" | grep -qiE "(certificate|ssl|tls|verify)"; then
            ((inspection_indicators++))
            log_warning "SSL issue with DuckDuckGo search"
        fi
    elif ! echo "$ddg_result" | grep -qi "result\|web-result\|links"; then
        ((service_failures++))
        echo "FAILED (no results)"
        log_warning "DuckDuckGo search returned no results (possible block/SSL issue)"
    else
        echo "OK"
    fi

    # Test 2: HuggingFace API (model search)
    echo -n "    Testing HuggingFace API... "
    local hf_result
    local hf_exit
    hf_result=$(timeout 20 curl -sS --connect-timeout 10 --max-time 15 \
        "https://huggingface.co/api/models?limit=1" 2>&1) || true
    hf_exit=$?
    if [ $hf_exit -ne 0 ]; then
        ((service_failures++))
        echo "FAILED"
        if echo "$hf_result" | grep -qiE "(certificate|ssl|tls|verify)"; then
            ((inspection_indicators++))
            log_warning "SSL issue with HuggingFace API"
        fi
    elif ! echo "$hf_result" | grep -q '"id"'; then
        ((service_failures++))
        echo "FAILED (invalid response)"
        log_warning "HuggingFace API returned invalid response"
    else
        echo "OK"
    fi

    # Test 3: Brave Search (fallback search engine)
    echo -n "    Testing Brave Search... "
    local brave_result
    local brave_exit
    brave_result=$(timeout 20 curl -sS --connect-timeout 10 --max-time 15 \
        "https://search.brave.com/search?q=test&source=web" \
        -H "User-Agent: Mozilla/5.0" 2>&1) || true
    brave_exit=$?
    if [ $brave_exit -ne 0 ]; then
        ((service_failures++))
        echo "FAILED"
        if echo "$brave_result" | grep -qiE "(certificate|ssl|tls|verify)"; then
            ((inspection_indicators++))
            log_warning "SSL issue with Brave Search"
        fi
    elif ! echo "$brave_result" | grep -qi "result\|snippet\|search"; then
        ((service_failures++))
        echo "FAILED (no results)"
        log_warning "Brave Search returned no results (possible block/SSL issue)"
    else
        echo "OK"
    fi

    # Test 4: Python curl_cffi (used by Scrapling) - only if Python is available
    if command -v python3 &> /dev/null; then
        echo -n "    Testing Python SSL (curl_cffi/requests)... "
        local py_result
        py_result=$(timeout 20 python3 -c "
import sys
try:
    import urllib.request
    urllib.request.urlopen('https://httpbin.org/get', timeout=10)
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
            echo "FAILED (SSL)"
            log_warning "Python SSL verification failed"
        elif echo "$py_result" | grep -q "FAILED"; then
            ((service_failures++))
            echo "$py_result"
        elif echo "$py_result" | grep -q "OK"; then
            echo "OK"
        else
            # Module not available or other issue
            echo "SKIPPED"
        fi
    else
        echo "    Testing Python SSL... SKIPPED (python3 not found)"
    fi

    # Summary of service tests
    if [ $service_failures -gt 0 ]; then
        log_warning "$service_failures web service(s) failed connectivity tests"
    fi

    # Determine if SSL inspection is likely active
    # Now includes service-specific failures in the decision
    if [ $inspection_indicators -ge 1 ] || [ $failures -ge 2 ] || [ $service_failures -ge 2 ]; then
        SSL_INSPECTION_DETECTED=true
        log_warning "SSL inspection/corporate proxy detected!"
        log_info "Configuring automatic SSL bypass for web search features..."

        # Update .env file with SSL bypass setting (docker-compose reads this)
        if [ -f "$ENV_FILE" ]; then
            # Remove existing NODE_TLS_REJECT_UNAUTHORIZED line if present
            grep -v "^NODE_TLS_REJECT_UNAUTHORIZED=" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
            mv "$ENV_FILE.tmp" "$ENV_FILE"
        fi
        echo "# Auto-added by build.sh - SSL inspection detected" >> "$ENV_FILE"
        echo "NODE_TLS_REJECT_UNAUTHORIZED=0" >> "$ENV_FILE"

        # Set environment variables for the build process
        export NODE_TLS_REJECT_UNAUTHORIZED=0
        export GIT_SSL_NO_VERIFY=true
        export PIP_TRUSTED_HOST="pypi.org pypi.python.org files.pythonhosted.org"

        log_success "SSL bypass configured in .env file. Web search will work through corporate proxy."
    else
        log_success "No SSL inspection detected. Standard SSL verification will be used."
    fi
}

# Run SSL detection (can be skipped with --skip-ssl-check)
SKIP_SSL_CHECK=false
for arg in "$@"; do
    if [ "$arg" = "--skip-ssl-check" ]; then
        SKIP_SSL_CHECK=true
        break
    fi
done

if [ "$SKIP_SSL_CHECK" = false ]; then
    detect_ssl_inspection
else
    log_info "Skipping SSL inspection check (--skip-ssl-check)"
fi

echo ""
log_info "Analyzing build requirements..."

# Check which images need to be built
BUILD_LLAMACPP=false
BUILD_VLLM=false
BUILD_WEBAPP=false

# Check llamacpp
if [ "$NO_CACHE" = true ] || [ "$RESUME" = false ]; then
    BUILD_LLAMACPP=true
    log_info "llamacpp: rebuild requested"
elif [[ -z $(docker images -q modelserver-llamacpp:latest 2>/dev/null) ]]; then
    BUILD_LLAMACPP=true
    log_info "llamacpp: image not found"
elif ! is_build_complete "llamacpp"; then
    BUILD_LLAMACPP=true
    log_info "llamacpp: Dockerfile changed or incomplete build"
else
    log_info "llamacpp: image exists and up-to-date (skipping)"
fi

# Check vllm
if [ "$NO_CACHE" = true ] || [ "$RESUME" = false ]; then
    BUILD_VLLM=true
    log_info "vllm: rebuild requested"
elif [[ -z $(docker images -q modelserver-vllm:latest 2>/dev/null) ]]; then
    BUILD_VLLM=true
    log_info "vllm: image not found"
elif ! is_build_complete "vllm"; then
    BUILD_VLLM=true
    log_info "vllm: Dockerfile changed or incomplete build"
else
    log_info "vllm: image exists and up-to-date (skipping)"
fi

# Check webapp
if [ "$NO_CACHE" = true ] || [ "$RESUME" = false ]; then
    BUILD_WEBAPP=true
    log_info "webapp: rebuild requested"
elif [[ -z $(docker images -q modelserver-webapp:latest 2>/dev/null) ]]; then
    BUILD_WEBAPP=true
    log_info "webapp: image not found"
elif ! is_build_complete "webapp"; then
    BUILD_WEBAPP=true
    log_info "webapp: Dockerfile changed or incomplete build"
else
    log_info "webapp: image exists and up-to-date (skipping)"
fi

# Track overall build start time
TOTAL_START_TIME=$(date +%s)

# Build backend images in parallel if enabled
if [ "$BUILD_LLAMACPP" = true ] || [ "$BUILD_VLLM" = true ]; then
    echo ""
    log_info "Building backend images..."

    if [ "$PARALLEL" = true ] && [ "$BUILD_LLAMACPP" = true ] && [ "$BUILD_VLLM" = true ]; then
        log_info "Building llamacpp and vllm in parallel..."

        # Build both in background
        (
            build_image "llamacpp" "modelserver-llamacpp:latest" "20-30 minutes"
            echo $? > "$BUILD_STATE_DIR/llamacpp.exit"
        ) &
        PID_LLAMACPP=$!

        (
            build_image "vllm" "modelserver-vllm:latest" "10-15 minutes"
            echo $? > "$BUILD_STATE_DIR/vllm.exit"
        ) &
        PID_VLLM=$!

        # Wait for both to complete
        log_info "Waiting for parallel builds to complete..."
        wait $PID_LLAMACPP
        wait $PID_VLLM

        # Check exit codes
        LLAMACPP_EXIT=$(cat "$BUILD_STATE_DIR/llamacpp.exit" 2>/dev/null || echo "1")
        VLLM_EXIT=$(cat "$BUILD_STATE_DIR/vllm.exit" 2>/dev/null || echo "1")

        if [ "$LLAMACPP_EXIT" != "0" ]; then
            log_error "llamacpp build failed"
            exit 1
        fi

        if [ "$VLLM_EXIT" != "0" ]; then
            log_error "vllm build failed"
            exit 1
        fi

        # Verify images
        verify_image "modelserver-llamacpp:latest" || exit 1
        verify_image "modelserver-vllm:latest" || exit 1

    else
        # Sequential builds
        if [ "$BUILD_LLAMACPP" = true ]; then
            log_info "Building llamacpp (estimated: 20-30 minutes for CUDA compilation)..."
            build_image "llamacpp" "modelserver-llamacpp:latest" "20-30 minutes" || exit 1
            verify_image "modelserver-llamacpp:latest" || exit 1
        fi

        if [ "$BUILD_VLLM" = true ]; then
            log_info "Building vllm (estimated: 10-15 minutes)..."
            build_image "vllm" "modelserver-vllm:latest" "10-15 minutes" || exit 1
            verify_image "modelserver-vllm:latest" || exit 1
        fi
    fi
fi

# Build webapp (depends on backend images being available)
if [ "$BUILD_WEBAPP" = true ]; then
    echo ""
    log_info "Building webapp image..."
    build_image "webapp" "modelserver-webapp:latest" "2-5 minutes" || exit 1
    verify_image "modelserver-webapp:latest" || exit 1
fi

if [ "$CLEANUP" = true ]; then
    echo ""
    log_info "Cleaning up Docker build cache..."
    docker builder prune -af 2>&1 | tail -20
    log_success "Cleanup complete"
fi

# Calculate total build time
TOTAL_END_TIME=$(date +%s)
TOTAL_DURATION=$((TOTAL_END_TIME - TOTAL_START_TIME))
MINUTES=$((TOTAL_DURATION / 60))
SECONDS=$((TOTAL_DURATION % 60))

echo ""
echo "=========================================="
echo "  Build Complete!"
echo "=========================================="
echo ""

# Show what was built
echo "Build Summary:"
if [ "$BUILD_LLAMACPP" = true ]; then
    echo "  ✓ llamacpp image built"
else
    echo "  - llamacpp image skipped (already exists)"
fi

if [ "$BUILD_VLLM" = true ]; then
    echo "  ✓ vllm image built"
else
    echo "  - vllm image skipped (already exists)"
fi

if [ "$BUILD_WEBAPP" = true ]; then
    echo "  ✓ webapp image built"
else
    echo "  - webapp image skipped (already exists)"
fi

echo ""
echo "Total build time: ${MINUTES}m ${SECONDS}s"
echo "Build mode: $([ "$PARALLEL" = true ] && echo "parallel" || echo "sequential")"
echo "Build state saved in: $BUILD_STATE_DIR"
echo ""
echo "Next steps:"
echo "  ./start.sh    # Start all services"
echo ""
