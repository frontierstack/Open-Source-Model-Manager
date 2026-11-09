#!/bin/bash
# Optional inference engines: Strata and vLLM. llama.cpp and SGLang are built by
# build.sh / update.sh; these two are extra downloads, so they are opt-in.
#
#   sudo ./scripts/engines.sh status
#   sudo ./scripts/engines.sh install strata|vllm|all
#   sudo ./scripts/engines.sh refresh     # bring installed engines to the pinned versions
#
# Pinned versions live in webapp/services/engineVersions.json (the webapp reads
# the same file). On a CPU without AVX2 Strata is compiled from source for that
# CPU (strata/Dockerfile); elsewhere its published image is pulled.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
VERSIONS="$PROJECT_DIR/webapp/services/engineVersions.json"

json_field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$VERSIONS" | head -1; }
STRATA_VERSION="$(json_field strata)"
VLLM_VERSION="$(json_field vllm)"
VLLM_IMAGE="vllm/vllm-openai:$VLLM_VERSION"
STRATA_PUBLISHED="ghcr.io/niko1221/strata:$STRATA_VERSION-cuda13"
STRATA_LOCAL="modelserver-strata:latest"

has_avx2() { grep -m1 '^flags' /proc/cpuinfo | grep -qw avx2; }
has_image() { docker image inspect "$1" > /dev/null 2>&1; }
free_gb() { df -BG --output=avail "$PROJECT_DIR" | tail -1 | tr -dc '0-9'; }
need_disk() {
    if [ "$(free_gb)" -lt "$1" ]; then
        echo "Not enough disk: $1 GB needed, $(free_gb) GB free." >&2
        exit 1
    fi
}

strata_ref() { if has_avx2; then echo "$STRATA_PUBLISHED"; else echo "$STRATA_LOCAL"; fi; }

strata_local_version() {
    docker image inspect -f '{{ index .Config.Labels "modelserver.engine.version" }}' "$STRATA_LOCAL" 2>/dev/null || true
}

install_strata() {
    if has_avx2; then
        need_disk 5
        docker pull "$STRATA_PUBLISHED"
    else
        need_disk 30
        echo "This CPU has no AVX2: compiling Strata $STRATA_VERSION for SSE4.2 (experimental upstream, 20-60 min)."
        docker build --build-arg STRATA_VERSION="$STRATA_VERSION" \
            --build-arg RUNTIME_IMAGE="$STRATA_PUBLISHED" \
            --build-arg BUILD_JOBS="${BUILD_JOBS:-$(nproc)}" \
            -t "$STRATA_LOCAL" "$PROJECT_DIR/strata"
    fi
}

install_vllm() {
    need_disk 35
    docker pull "$VLLM_IMAGE"
}

status() {
    printf '%-8s %-12s %s\n' ENGINE VERSION IMAGE
    for pair in "strata:$STRATA_VERSION:$(strata_ref)" "vllm:$VLLM_VERSION:$VLLM_IMAGE"; do
        local name="${pair%%:*}" rest="${pair#*:}"
        local ver="${rest%%:*}" ref="${rest#*:}"
        if has_image "$ref"; then printf '%-8s %-12s %s\n' "$name" "$ver" "$ref"
        else printf '%-8s %-12s %s\n' "$name" "-" "not installed"; fi
    done
}

refresh() {
    if has_avx2; then
        # Any tag of the published image means Strata is in use here.
        if docker images --format '{{.Repository}}' | grep -qx 'ghcr.io/niko1221/strata' && ! has_image "$STRATA_PUBLISHED"; then
            install_strata
        fi
    elif has_image "$STRATA_LOCAL" && [ "$(strata_local_version)" != "$STRATA_VERSION" ]; then
        install_strata
    fi
    if docker images --format '{{.Repository}}' | grep -qx 'vllm/vllm-openai' && ! has_image "$VLLM_IMAGE"; then
        install_vllm
    fi
}

case "${1:-status}" in
    status) status ;;
    refresh) refresh ;;
    install)
        case "${2:-}" in
            strata) install_strata ;;
            vllm) install_vllm ;;
            all) install_strata; install_vllm ;;
            *) echo "Usage: $0 install strata|vllm|all" >&2; exit 2 ;;
        esac
        ;;
    *) echo "Usage: $0 status | install strata|vllm|all | refresh" >&2; exit 2 ;;
esac
