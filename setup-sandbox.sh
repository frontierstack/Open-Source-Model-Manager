#!/bin/bash
# setup-sandbox.sh — install gVisor (runsc) and register it as a Docker
# runtime so the webapp can spawn tool-execution containers with strong
# syscall-level isolation.
#
# Safe to run repeatedly: no-ops if runsc is already registered and working.
# Called by build.sh during the prerequisites phase; can also be invoked
# standalone when troubleshooting.
#
# Usage:  sudo ./setup-sandbox.sh [--force] [--skip-check]
#   --force       reinstall even if runsc already works
#   --skip-check  skip the post-install smoke test

set -e

# ---------------------------------------------------------------------------
# Output helpers — standalone copies so this script works outside build.sh
# ---------------------------------------------------------------------------
if [ -z "${GREEN:-}" ]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
fi
say()  { echo -e "  ${CYAN}→${NC}  $1"; }
ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!${NC}  ${YELLOW}$1${NC}"; }
err()  { echo -e "  ${RED}✗${NC}  ${RED}$1${NC}"; }

if [ "$(id -u)" -ne 0 ]; then
    err "setup-sandbox.sh must run as root (needs to modify /etc/docker and restart the daemon)."
    err "Run with:  sudo $0 $*"
    exit 1
fi

FORCE=0
SKIP_CHECK=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --skip-check) SKIP_CHECK=1 ;;
        -h|--help)
            grep '^#' "$0" | head -20 | sed 's/^# \?//'
            exit 0 ;;
    esac
done

DAEMON_JSON=/etc/docker/daemon.json
DAEMON_JSON_BAK="${DAEMON_JSON}.lmstudio.bak"

# ---------------------------------------------------------------------------
# Step 1: Detect if runsc is already installed + registered
# ---------------------------------------------------------------------------
needs_install=1
if command -v runsc >/dev/null 2>&1 && [ "$FORCE" -ne 1 ]; then
    if docker info 2>/dev/null | grep -qw runsc; then
        ok "gVisor (runsc) already installed and registered as a Docker runtime."
        needs_install=0
    else
        warn "runsc binary is present but not registered with Docker — will register it."
    fi
fi

# ---------------------------------------------------------------------------
# Step 2: Install runsc
# ---------------------------------------------------------------------------
if [ "$needs_install" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/latest/x86_64" ;;
        aarch64) GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/latest/aarch64" ;;
        *)       err "Unsupported architecture: $ARCH (gVisor supports x86_64 and aarch64)"; exit 1 ;;
    esac

    say "Downloading runsc + containerd-shim-runsc-v1 for $ARCH"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    # Prefer curl; fall back to wget.
    fetch() {
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL -o "$2" "$1"
        elif command -v wget >/dev/null 2>&1; then
            wget -q -O "$2" "$1"
        else
            err "Neither curl nor wget is installed."
            return 1
        fi
    }

    (
        cd "$TMP"
        fetch "$GVISOR_URL/runsc" runsc
        fetch "$GVISOR_URL/runsc.sha512" runsc.sha512
        fetch "$GVISOR_URL/containerd-shim-runsc-v1" containerd-shim-runsc-v1
        fetch "$GVISOR_URL/containerd-shim-runsc-v1.sha512" containerd-shim-runsc-v1.sha512
        sha512sum -c runsc.sha512 >/dev/null
        sha512sum -c containerd-shim-runsc-v1.sha512 >/dev/null
    ) || { err "Download or checksum verification failed."; exit 1; }

    install -m 0755 -o root -g root "$TMP/runsc" /usr/local/bin/runsc
    install -m 0755 -o root -g root "$TMP/containerd-shim-runsc-v1" /usr/local/bin/containerd-shim-runsc-v1
    ok "Installed runsc $(runsc --version 2>&1 | head -1)"
fi

# ---------------------------------------------------------------------------
# Step 3: Register runsc as a Docker runtime in /etc/docker/daemon.json
# ---------------------------------------------------------------------------
need_reload=0
if docker info 2>/dev/null | grep -qw runsc && [ "$FORCE" -ne 1 ]; then
    ok "Docker already knows the runsc runtime."
else
    say "Registering runsc as a Docker runtime"
    mkdir -p /etc/docker
    if [ -f "$DAEMON_JSON" ]; then
        cp -a "$DAEMON_JSON" "$DAEMON_JSON_BAK"
        say "Backup of daemon.json saved to $DAEMON_JSON_BAK"
    fi

    # Merge: preserve any existing daemon.json keys, add/update runtimes.runsc.
    # We use python because jq isn't guaranteed on minimal images and because
    # we need "merge" semantics rather than overwrite.
    python3 - "$DAEMON_JSON" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError as e:
    print(f"daemon.json is not valid JSON: {e}", file=sys.stderr)
    sys.exit(2)
runtimes = cfg.setdefault('runtimes', {})
runtimes['runsc'] = {'path': '/usr/local/bin/runsc'}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
PY

    need_reload=1
    ok "daemon.json updated"
fi

# ---------------------------------------------------------------------------
# Step 4: Reload docker so it picks up the runtime registration
# ---------------------------------------------------------------------------
if [ "$need_reload" -eq 1 ]; then
    say "Reloading docker daemon (systemctl reload docker)"
    # Prefer reload to avoid restarting all running containers. Fall back
    # to restart if reload is not supported by this version.
    if systemctl reload docker 2>/dev/null; then
        ok "dockerd reloaded"
    else
        warn "reload not supported; restarting docker (running containers will be paused)"
        systemctl restart docker
        ok "dockerd restarted"
    fi
    # Give the daemon a moment to come back before the smoke test.
    sleep 2
fi

# ---------------------------------------------------------------------------
# Step 5: Smoke test — run a throwaway container with --runtime=runsc
# ---------------------------------------------------------------------------
if [ "$SKIP_CHECK" -eq 1 ]; then
    ok "Skipping smoke test (--skip-check)"
    exit 0
fi

say "Smoke test: docker run --runtime=runsc alpine echo ok"
# Pre-pull the image so its "downloading layers" output doesn't mix
# with the test output we're matching against.
docker pull alpine:3 >/dev/null 2>&1 || true
if output=$(docker run --rm --runtime=runsc alpine:3 echo ok 2>&1); then
    # The last line is what `echo ok` produced; ignore any preceding noise.
    last_line=$(echo "$output" | tail -1)
    if [ "$last_line" = "ok" ]; then
        ok "gVisor sandbox runs containers successfully."
    else
        warn "Container ran but returned unexpected output: $output"
    fi
else
    err "Smoke test failed:"
    echo "$output" | sed 's/^/      /'
    err "gVisor is installed but not working. Check kernel support:"
    err "  cat /proc/sys/kernel/unprivileged_userns_clone  (should be 1)"
    err "  docker info | grep -A2 Runtimes"
    exit 1
fi

echo
ok "${BOLD}gVisor setup complete.${NC} Tool-execution containers can now be launched with --runtime=runsc."
