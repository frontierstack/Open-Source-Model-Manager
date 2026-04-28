#!/bin/bash
set -e

# WSL Native-Docker Setup
# -----------------------
# Replaces Docker Desktop's WSL integration with a real, systemd-managed
# Docker Engine inside the WSL distro so that:
#   1. ./build.sh works without needing Docker Desktop on Windows.
#   2. setup-sandbox.sh (gVisor / runsc) can register the runtime — it needs
#      a real /etc/docker/daemon.json + a systemctl-managed docker.service,
#      neither of which exist when Docker Desktop owns the daemon.
#
# Idempotent — re-runnable. Two-phase: enabling systemd requires a `wsl
# --shutdown` from PowerShell which the script can't do itself, so it exits
# with explicit next-step instructions when a restart is needed.

# Allow --help without sudo
for arg in "$@"; do
    case "$arg" in
        -h|--help)
            cat <<EOF
Usage: sudo $0 [OPTIONS]

Sets up a native Docker Engine inside this WSL distro so the Model Server
build can run without Docker Desktop and so the gVisor sandbox can install.

Options:
  --gpu           Force nvidia-container-toolkit install
  --no-gpu        Skip nvidia-container-toolkit install
                  (default: auto-detect from /dev/dxg or /dev/nvidia*)
  --no-gvisor     Skip gVisor (runsc) install
  --no-smoke      Skip the GPU/Docker smoke tests at the end
  -h, --help      Show this help

The script is idempotent. If it needs a WSL distro restart (after enabling
systemd in /etc/wsl.conf), it exits and prints the exact PowerShell command
to run. Re-running the script after restart picks up where it left off.
EOF
            exit 0
            ;;
    esac
done

# Require root for the actual run
if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo "  This script needs root (apt, systemctl, /etc/wsl.conf)."
    echo "  Run with:  sudo $0 $*"
    echo ""
    exit 1
fi

# Resolve script + project location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ============================================================================
# TERMINAL OUTPUT HELPERS  (mirrors build.sh styling)
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

SYM_OK="${GREEN}✓${NC}"
SYM_FAIL="${RED}✗${NC}"
SYM_SKIP="${DIM}–${NC}"
SYM_WARN="${YELLOW}!${NC}"
SYM_ARROW="${CYAN}→${NC}"

log_info()    { echo -e "  ${BLUE}ℹ${NC}  $1"; }
log_success() { echo -e "  ${SYM_OK}  $1"; }
log_warning() { echo -e "  ${SYM_WARN}  ${YELLOW}$1${NC}"; }
log_error()   { echo -e "  ${SYM_FAIL}  ${RED}$1${NC}"; }
log_step()    { echo -e "  ${SYM_ARROW}  $1"; }

section() {
    echo ""
    echo -e "  ${BOLD}${CYAN}$1${NC}"
    echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${NC}"
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

INSTALL_GPU=auto       # auto | yes | no
INSTALL_GVISOR=true
SKIP_SMOKE_TEST=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-gpu)      INSTALL_GPU=no;        shift ;;
        --gpu)         INSTALL_GPU=yes;       shift ;;
        --no-gvisor)   INSTALL_GVISOR=false;  shift ;;
        --no-smoke)    SKIP_SMOKE_TEST=true;  shift ;;
        -h|--help)     exit 0 ;;  # already handled before root check
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Banner
echo ""
echo -e "  ${BOLD}WSL Native-Docker Setup${NC}"
echo -e "  ${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"

# ============================================================================
# PHASE 1: ENVIRONMENT CHECKS
# ============================================================================

section "Environment"

# WSL?
if ! grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
   && ! grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then
    log_error "Not running inside WSL. This script is WSL-only."
    log_info  "On a regular Linux host, install Docker the normal way and run ./build.sh"
    exit 1
fi
log_success "Running inside WSL"

# Distro?
if [ ! -f /etc/os-release ]; then
    log_error "/etc/os-release missing — cannot identify distro"
    exit 1
fi
. /etc/os-release
case "$ID" in
    ubuntu|debian)
        log_success "Distro: $PRETTY_NAME"
        ;;
    *)
        log_warning "Distro '$ID' isn't officially supported by this script (works on ubuntu/debian)."
        log_info    "You can keep going, but apt repo paths may not match — install Docker manually if it fails."
        ;;
esac

# Docker Desktop integration still active?
DD_INTEGRATION_ACTIVE=false
if [ -d /mnt/wsl/docker-desktop ] || [ -d /mnt/wsl/docker-desktop-data ]; then
    DD_INTEGRATION_ACTIVE=true
fi
if command -v docker >/dev/null 2>&1; then
    docker_path=$(readlink -f "$(command -v docker)" 2>/dev/null || true)
    if echo "$docker_path" | grep -qE 'docker-desktop|/mnt/wsl/'; then
        DD_INTEGRATION_ACTIVE=true
        log_warning "'docker' currently resolves to Docker Desktop ($docker_path)"
    fi
fi
if [ "$DD_INTEGRATION_ACTIVE" = true ]; then
    log_warning "Docker Desktop's WSL integration is still active for this distro."
    echo ""
    echo -e "  ${BOLD}Before you continue:${NC}"
    echo "    1. Open Docker Desktop on Windows"
    echo "    2. Settings → Resources → WSL Integration"
    echo -e "    3. Toggle integration ${BOLD}OFF${NC} for this distro (keep Docker Desktop"
    echo "       running for other distros if you want — just not this one)"
    echo "    4. From PowerShell:  wsl --shutdown"
    echo "    5. Reopen this WSL terminal and re-run this script"
    echo ""
    read -r -p "  Continue anyway? [y/N] " ans
    case "$ans" in
        y|Y|yes|YES) log_info "Continuing — but Docker install may conflict" ;;
        *) exit 0 ;;
    esac
else
    log_success "Docker Desktop WSL integration not detected"
fi

# systemd?
SYSTEMD_RUNNING=false
if [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
    SYSTEMD_RUNNING=true
    log_success "systemd is PID 1"
else
    log_warning "systemd is not PID 1 — must be enabled before Docker can install"
fi

# ============================================================================
# PHASE 2: ENABLE SYSTEMD VIA /etc/wsl.conf
# ============================================================================

section "WSL systemd"

WSL_CONF=/etc/wsl.conf
WROTE_WSL_CONF=false

if [ -f "$WSL_CONF" ] && grep -qE '^\s*systemd\s*=\s*true' "$WSL_CONF"; then
    log_success "/etc/wsl.conf already has systemd=true"
else
    if [ -f "$WSL_CONF" ]; then
        backup="$WSL_CONF.bak.$(date +%s)"
        cp "$WSL_CONF" "$backup"
        log_step "Backed up existing wsl.conf to $backup"
    fi
    log_step "Writing $WSL_CONF (enables systemd at boot)"
    cat > "$WSL_CONF" <<'EOF'
[boot]
systemd=true

[network]
generateResolvConf=true
EOF
    WROTE_WSL_CONF=true
    log_success "/etc/wsl.conf written"
fi

if [ "$SYSTEMD_RUNNING" = false ]; then
    echo ""
    echo -e "  ${BOLD}${YELLOW}Distro restart required${NC}"
    echo -e "  ${DIM}─────────────────────────${NC}"
    echo ""
    echo "  WSL needs to be shut down and restarted before systemd takes effect."
    echo "  This script can't do that from inside WSL."
    echo ""
    echo -e "  ${BOLD}1. Run this in PowerShell (as your user, not Admin):${NC}"
    echo ""
    echo -e "       ${CYAN}wsl --shutdown${NC}"
    echo ""
    echo -e "  ${BOLD}2. Reopen the WSL terminal and re-run this script:${NC}"
    echo ""
    echo -e "       ${CYAN}sudo $0 $*${NC}"
    echo ""
    echo -e "  ${DIM}(The script is idempotent — it picks up where it left off.)${NC}"
    echo ""
    exit 0
fi

if [ "$WROTE_WSL_CONF" = true ]; then
    log_warning "wsl.conf was just changed but systemd is already running."
    log_info    "You may want to 'wsl --shutdown' from PowerShell after this script finishes,"
    log_info    "to make sure subsequent boots use the new config."
fi

# ============================================================================
# PHASE 3: INSTALL DOCKER ENGINE
# ============================================================================

section "Docker Engine"

DOCKER_ALREADY_RUNNING=false
if command -v docker >/dev/null 2>&1 \
   && systemctl list-unit-files docker.service >/dev/null 2>&1 \
   && systemctl is-active --quiet docker 2>/dev/null \
   && docker info >/dev/null 2>&1; then
    DOCKER_ALREADY_RUNNING=true
fi

if [ "$DOCKER_ALREADY_RUNNING" = true ]; then
    docker_ver=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
    log_success "Docker daemon already running (${docker_ver})"
else
    log_step "Removing any conflicting old Docker packages"
    apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

    log_step "Installing prerequisites (curl, gnupg, lsb-release)"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        ca-certificates curl gnupg lsb-release

    log_step "Adding Docker's official apt repo"
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        curl -fsSL "https://download.docker.com/linux/$ID/gpg" \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list

    log_step "Installing docker-ce + compose plugin (this can take a few minutes)"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin

    log_step "Enabling and starting docker.service"
    systemctl enable --now docker
    log_success "Docker installed and running"
fi

# ============================================================================
# PHASE 4: ADD INVOKING USER TO docker GROUP
# ============================================================================

if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    if id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        log_success "User '$SUDO_USER' is already in the docker group"
    else
        log_step "Adding '$SUDO_USER' to the docker group"
        usermod -aG docker "$SUDO_USER"
        log_warning "Log out + back into WSL for docker-without-sudo to take effect"
    fi
fi

# ============================================================================
# PHASE 5: NVIDIA CONTAINER TOOLKIT (OPTIONAL)
# ============================================================================

section "GPU Support"

GPU_DETECTED=false
if [ -e /dev/dxg ] || ls /dev/nvidia* >/dev/null 2>&1; then
    GPU_DETECTED=true
fi

INSTALL_GPU_FINAL=$INSTALL_GPU
if [ "$INSTALL_GPU" = auto ]; then
    if [ "$GPU_DETECTED" = true ]; then
        INSTALL_GPU_FINAL=yes
        log_success "NVIDIA GPU detected (/dev/dxg or /dev/nvidia*)"
    else
        INSTALL_GPU_FINAL=no
        log_info "No NVIDIA GPU detected — skipping nvidia-container-toolkit"
        log_info "Re-run with --gpu if you do have one and the auto-detect missed it"
    fi
fi

if [ "$INSTALL_GPU_FINAL" = yes ]; then
    if dpkg -l nvidia-container-toolkit >/dev/null 2>&1; then
        log_success "nvidia-container-toolkit already installed"
    else
        log_step "Adding NVIDIA container-toolkit apt repo"
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
            | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
        distribution=$(. /etc/os-release; echo "${ID}${VERSION_ID}")
        curl -fsSL "https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list" \
            | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
            > /etc/apt/sources.list.d/nvidia-container-toolkit.list

        log_step "Installing nvidia-container-toolkit"
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-container-toolkit

        log_step "Configuring Docker to use the NVIDIA runtime"
        nvidia-ctk runtime configure --runtime=docker
        systemctl restart docker
        log_success "NVIDIA runtime configured"
    fi

    if [ "$SKIP_SMOKE_TEST" = false ]; then
        log_step "Smoke test: docker run --gpus all nvidia/cuda nvidia-smi"
        if docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
            log_success "GPU passthrough works"
        else
            log_warning "GPU smoke test failed."
            log_info    "Common causes: outdated Windows NVIDIA driver, or driver doesn't support WSL2 GPU."
            log_info    "Update your driver from nvidia.com/Download — any recent version supports WSL2."
        fi
    fi
fi

# ============================================================================
# PHASE 6: gVisor SANDBOX RUNTIME (OPTIONAL)
# ============================================================================

if [ "$INSTALL_GVISOR" = true ]; then
    section "gVisor Sandbox Runtime"

    SANDBOX_SCRIPT=""
    for cand in \
        "$PROJECT_DIR/setup-sandbox.sh" \
        "$SCRIPT_DIR/setup-sandbox.sh" \
        "$(pwd)/setup-sandbox.sh"; do
        if [ -f "$cand" ]; then
            SANDBOX_SCRIPT="$cand"
            break
        fi
    done

    if [ -z "$SANDBOX_SCRIPT" ]; then
        log_warning "setup-sandbox.sh not found — skipping gVisor"
        log_info    "Re-run from inside the project directory if you want gVisor"
    elif docker info 2>/dev/null | grep -qw runsc; then
        log_success "gVisor (runsc) runtime already registered"
    else
        log_step "Running $SANDBOX_SCRIPT"
        if bash "$SANDBOX_SCRIPT" >/tmp/setup-sandbox.log 2>&1; then
            log_success "gVisor installed — tool exec containers will use --runtime=runsc"
        else
            log_warning "gVisor install failed (non-fatal — build will fall back to default runtime)"
            echo ""
            echo -e "  ${DIM}── setup-sandbox.sh output (tail) ──────────────────────${NC}"
            err_lines=$(grep -iE '(error|fail|fatal|cannot|denied|not found|unable)' \
                          /tmp/setup-sandbox.log 2>/dev/null | tail -8)
            if [ -n "$err_lines" ]; then
                echo "$err_lines" | sed 's/^/    /'
                echo -e "  ${DIM}── (last 5 log lines) ──${NC}"
                tail -5 /tmp/setup-sandbox.log 2>/dev/null | sed 's/^/    /'
            else
                tail -15 /tmp/setup-sandbox.log 2>/dev/null | sed 's/^/    /'
            fi
            echo -e "  ${DIM}─────────────────────────────────────────────────────────${NC}"
            echo ""
        fi
    fi
else
    section "gVisor Sandbox Runtime"
    log_info "gVisor setup skipped (--no-gvisor)"
fi

# ============================================================================
# PHASE 7: SUMMARY
# ============================================================================

section "Summary"

if systemctl is-active --quiet docker 2>/dev/null; then
    log_success "docker.service: active"
else
    log_error "docker.service: not active"
fi

docker_ver=$(docker --version 2>/dev/null || echo "not found")
compose_ver=$(docker compose version 2>/dev/null | head -1 || echo "not found")
echo -e "  ${DIM}    ${docker_ver}${NC}"
echo -e "  ${DIM}    ${compose_ver}${NC}"

if [ "$INSTALL_GPU_FINAL" = yes ] && command -v nvidia-ctk >/dev/null 2>&1; then
    echo -e "  ${DIM}    nvidia-ctk:    $(nvidia-ctk --version 2>/dev/null | head -1)${NC}"
fi

if docker info 2>/dev/null | grep -qw runsc; then
    echo -e "  ${DIM}    gVisor:        registered as runsc${NC}"
fi

echo ""
echo -e "  ${BOLD}Next steps${NC}"
echo -e "  ${DIM}──────────${NC}"
if [ -n "$SUDO_USER" ] && ! id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    echo "    1. Log out of WSL and back in (so docker-without-sudo activates)"
    echo -e "    2. ${BOLD}cd $PROJECT_DIR && sudo ./build.sh${NC}"
else
    echo -e "    ${BOLD}cd $PROJECT_DIR && sudo ./build.sh${NC}"
fi
echo ""
