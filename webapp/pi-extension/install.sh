#!/usr/bin/env bash
# Pi (pi.dev) one-shot installer for the model server.
#
# Idempotent. Self-corrects for common failure modes:
#   - corporate MITM proxies (writes ~/.curlrc, sets npm strict-ssl=false,
#     exports NODE_TLS_REJECT_UNAUTHORIZED=0)
#   - missing or old Node (installs Node 22 LTS via NodeSource, falls
#     back to nvm if apt path fails)
#   - missing Pi CLI
#   - missing curl / jq
#   - broken sudo (skips when running as root, falls back when sudo binary
#     itself is unusable)
#   - re-runs cleanly: skips work that's already done
#
# Usage:
#   export MODELSERVER_API_KEY="<your-bearer-key>"
#   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
#     <BASE_URL>/api/pi/install | bash
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/pi/install or /api/pi/config.

# Don't `set -e` — we rely on individual step checks to keep going.
set -u

BASE_URL_DEFAULT="__MODELSERVER_BASE_URL__"
BASE_URL="${MODELSERVER_BASE_URL:-$BASE_URL_DEFAULT}"
EXT_DIR="$HOME/.pi/agent/extensions/modelserver"
SETTINGS="$HOME/.pi/agent/settings.json"

# ---------- helpers ----------
c_blue=$'\033[1;36m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_green=$'\033[1;32m'; c_off=$'\033[0m'
log()  { printf "%s[pi-install]%s %s\n" "$c_blue"   "$c_off" "$*"; }
warn() { printf "%s[pi-install]%s %s\n" "$c_yellow" "$c_off" "$*" >&2; }
err()  { printf "%s[pi-install]%s %s\n" "$c_red"    "$c_off" "$*" >&2; }
ok()   { printf "%s[pi-install]%s %s\n" "$c_green"  "$c_off" "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Privilege-escalation wrapper that copes with broken sudo.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if have sudo && sudo -n true 2>/dev/null; then
        SUDO="sudo"
    elif have sudo; then
        # sudo exists but may need a password; try a probe
        if sudo true 2>/dev/null; then
            SUDO="sudo"
        else
            warn "sudo not usable here — system installs will be skipped if not root."
        fi
    else
        warn "Not root and no sudo — system installs will be skipped."
    fi
fi
sudo_run() { if [ -n "$SUDO" ]; then $SUDO "$@"; else "$@"; fi; }

node_major() {
    have node || { echo 0; return; }
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

# Node v20+/v22 core-dumps at startup with a V8 StackOverflow
# ("Trace/breakpoint trap (core dumped)") the moment it runs real JS when the
# stack ulimit is 'unlimited' — it mis-computes its own stack limit. `node -v`
# survives (no JS), so this hides until npm/pi actually run. Clamp the soft
# limit to the normal 8 MB default (a lower-than-hard change needs no privilege)
# so every node/npm invocation below inherits a sane stack. Harmless when the
# limit is already finite.
if [ "$(ulimit -s 2>/dev/null)" = "unlimited" ]; then
    if ulimit -S -s 8192 2>/dev/null; then
        warn "stack ulimit was 'unlimited' (crashes Node v20+); clamped to 8 MB for this run."
        warn "  make it permanent:  echo 'ulimit -S -s 8192' >> ~/.bashrc"
    fi
fi

# ---------- step 1: SSL bypass for MITM environments ----------
log "Step 1/6: SSL/MITM bypass"
if ! [ -f "$HOME/.curlrc" ] || ! grep -qE '^[[:space:]]*insecure' "$HOME/.curlrc" 2>/dev/null; then
    printf "insecure\n" >> "$HOME/.curlrc"
    log "  appended 'insecure' to ~/.curlrc"
else
    log "  ~/.curlrc already has 'insecure'"
fi
export NODE_TLS_REJECT_UNAUTHORIZED=0

# ---------- step 2: ensure curl ----------
log "Step 2/6: curl"
if ! have curl; then
    log "  installing curl"
    if have apt-get; then
        sudo_run apt-get update -y >/dev/null 2>&1 || true
        sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y curl \
            || sudo_run apt-get install -y curl \
            || { err "Failed to install curl"; exit 1; }
    else
        err "No apt-get; install curl manually then re-run."
        exit 1
    fi
fi
log "  curl present: $(curl --version | head -1)"

# ---------- step 3: ensure Node >= 22 (Pi >=0.75 requires 22.19+) ----------
log "Step 3/6: Node >= 22.19"
maj=$(node_major)
if [ "$maj" -ge 22 ] 2>/dev/null; then
    log "  Node $(node -v) detected — OK"
else
    if [ "$maj" -gt 0 ]; then
        warn "  Node $(node -v) too old (Pi >=0.75 needs Node >=22.19); upgrading."
    else
        log "  Node not installed; installing Node 22 LTS"
    fi

    installed=0
    NODE_LOG=$(mktemp -t pi-install-node.XXXXXX)
    log "  (full Node-install log: $NODE_LOG)"

    # Path A: NodeSource via apt (fast, system-wide). Use -k for the
    # setup script; it adds the apt source then we install with the
    # apt cert-verify bypass.
    if [ "$installed" = 0 ] && have apt-get && [ -n "$SUDO" -o "$(id -u)" -eq 0 ]; then
        log "  trying NodeSource (apt path)"
        {
            printf '\n=== NodeSource setup script ===\n'
            curl -fsSLk https://deb.nodesource.com/setup_22.x | sudo_run -E bash -
            printf '\n=== apt install nodejs ===\n'
            sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs
        } >>"$NODE_LOG" 2>&1
        if [ "$(node_major)" -ge 22 ] 2>/dev/null; then
            installed=1
            ok "  installed system Node $(node -v)"
        else
            warn "  NodeSource path didn't produce Node>=22; tail of log:"
            tail -8 "$NODE_LOG" | sed 's/^/    /' >&2
        fi
    fi

    # Path B: nvm (per-user, no apt). Always works around MITM if
    # ~/.curlrc has 'insecure' (which we set above). Also force-set
    # NODE_TLS_REJECT_UNAUTHORIZED=0 in the nvm subshell since some
    # corporate inspectors break nvm's curl differently than the
    # global curlrc fixes.
    if [ "$installed" = 0 ]; then
        log "  trying nvm (per-user path)"
        export NVM_DIR="$HOME/.nvm"
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
            log "  downloading nvm"
            {
                printf '\n=== nvm install.sh ===\n'
                curl -kfsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            } >>"$NODE_LOG" 2>&1
            if [ ! -s "$NVM_DIR/nvm.sh" ]; then
                err "nvm download failed; tail of log:"
                tail -15 "$NODE_LOG" | sed 's/^/    /' >&2
                err "Full log: $NODE_LOG"
                exit 1
            fi
        fi
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
        log "  running 'nvm install 22' (this can take 1-3 min)"
        {
            printf '\n=== nvm install 22 ===\n'
            NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install 22
        } >>"$NODE_LOG" 2>&1
        # Some MITM proxies break nvm's fetch of nodejs.org/dist/index.tab,
        # which makes the `22` alias unresolvable. Fall back to pinned
        # Node 22 LTS releases (try latest first, then known-stable).
        if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! have node; then
            for ver in 22.20.0 22.19.0 22.11.0; do
                log "  alias '22' unresolvable; trying pinned v$ver"
                {
                    printf '\n=== nvm install %s ===\n' "$ver"
                    NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install "$ver"
                } >>"$NODE_LOG" 2>&1
                if [ "$(node_major)" -ge 22 ] 2>/dev/null; then break; fi
            done
        fi
        # Final fallback: direct tarball install if nvm can't reach
        # nodejs.org/dist/ at all.
        if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! have node; then
            log "  nvm can't reach nodejs.org/dist/; trying direct tarball install"
            tarball_ver=22.20.0
            arch=$(uname -m); case "$arch" in
                x86_64) arch=x64 ;;
                aarch64|arm64) arch=arm64 ;;
            esac
            tarball="node-v${tarball_ver}-linux-${arch}.tar.xz"
            tdir=$(mktemp -d)
            {
                printf '\n=== direct tarball install (%s) ===\n' "$tarball"
                cd "$tdir" \
                    && curl -fkLO "https://nodejs.org/dist/v${tarball_ver}/${tarball}" \
                    && sudo_run tar -xJf "$tarball" -C /usr/local --strip-components=1
            } >>"$NODE_LOG" 2>&1
            rm -rf "$tdir"
        fi
        if [ "$(node_major)" -ge 22 ] 2>/dev/null; then
            installed=1
            nvm use "$(node -v | sed 's/^v//')" >>"$NODE_LOG" 2>&1 || true
            ok "  installed Node $(node -v)"
        else
            err "Could not install Node>=22 by any path; tail of log:"
            tail -30 "$NODE_LOG" | sed 's/^/    /' >&2
            err "Full log: $NODE_LOG"
            exit 1
        fi
    fi

    if [ "$installed" = 0 ]; then
        err "Could not install Node >=22 by any path. Aborting."
        exit 1
    fi
fi

# ---------- step 4: ensure Pi CLI ----------
log "Step 4/6: Pi CLI"
npm config set strict-ssl false >/dev/null 2>&1 || true

pi_ver=""
if have pi && pi --version >/dev/null 2>&1; then pi_ver="$(pi --version 2>/dev/null | tr -d '[:space:]')"; fi
# Pi <0.75 is missing context-overflow auto-recovery + supply-chain hardening
# and predates the Node 22.19 requirement bump; force-upgrade.
pi_needs_upgrade=0
if [ -n "$pi_ver" ]; then
    pi_minor="$(printf '%s' "$pi_ver" | cut -d. -f2)"
    [ "${pi_minor:-0}" -ge 75 ] 2>/dev/null || pi_needs_upgrade=1
fi
if [ -n "$pi_ver" ] && [ "$pi_needs_upgrade" = 0 ]; then
    log "  Pi already installed: $pi_ver"
else
    if [ -n "$pi_ver" ]; then
        log "  Pi $pi_ver is older than 0.75 — upgrading to latest"
    else
        log "  installing @earendil-works/pi-coding-agent globally"
    fi
    # Capture combined npm output to a log so failures are DIAGNOSABLE. The
    # old `>/dev/null 2>&1` hid the real error (e.g. "RangeError: Maximum call
    # stack size exceeded" from a broken npm cache / too-old npm), leaving only
    # an opaque "npm install -g pi failed".
    PI_NPM_LOG="$(mktemp 2>/dev/null || echo /tmp/pi-npm-install.log)"
    pi_npm_install() {
        # nvm globals are user-owned (no sudo); otherwise try sudo then plain.
        if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
            npm install -g @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1
        else
            sudo_run npm install -g @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1 \
                || npm install -g @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1
        fi
    }
    if pi_npm_install; then
        ok "  installed Pi $(pi --version 2>/dev/null || echo unknown)"
        rm -f "$PI_NPM_LOG" 2>/dev/null || true
    else
        err "npm install -g @earendil-works/pi-coding-agent failed. Last npm output:"
        tail -n 25 "$PI_NPM_LOG" 2>/dev/null | sed 's/^/    /' >&2
        err "Full log: $PI_NPM_LOG"
        err "Common fixes for 'Maximum call stack size exceeded' / cache errors:"
        err "    npm cache clean --force"
        err "    npm install -g npm@latest        # update npm itself, then retry"
        err "    npm install -g @earendil-works/pi-coding-agent"
        err "  one-off workaround (raise Node's stack):"
        err "    node --stack-size=4000 \"\$(command -v npm)\" install -g @earendil-works/pi-coding-agent"
        # Don't hard-fail if a usable 'pi' is already on PATH — still install
        # the extension so a working Pi picks up our latest catalog.
        if have pi && pi --version >/dev/null 2>&1; then
            warn "  Existing pi found ($(pi --version)); continuing with the extension install."
        else
            err "  Pi CLI is required. Fix the npm error above, then re-run this installer."
            exit 1
        fi
    fi
fi

# ---------- step 5: drop the modelserver extension ----------
log "Step 5/6: modelserver extension at $EXT_DIR"
if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    err "MODELSERVER_API_KEY is not set. Re-run with:"
    err "    export MODELSERVER_API_KEY=<your-bearer-key>"
    err "    curl -fsSk -H \"Authorization: Bearer \$MODELSERVER_API_KEY\" \\"
    err "        $BASE_URL/api/pi/install | bash"
    exit 1
fi

mkdir -p "$EXT_DIR"
fetch_ext() {
    local file="$1"
    curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
        "$BASE_URL/api/pi/extension/$file" -o "$EXT_DIR/$file"
}
fetch_ext modelserver.ts || { err "Failed to download modelserver.ts"; exit 1; }
fetch_ext package.json   || { err "Failed to download package.json";   exit 1; }
log "  files dropped"

# install deps in the extension dir (Typebox)
if [ -d "$EXT_DIR/node_modules/@sinclair/typebox" ]; then
    log "  extension deps already present, skipping npm install"
else
    log "  installing extension deps (Typebox)"
    ( cd "$EXT_DIR" && npm install --omit=dev --silent >/dev/null 2>&1 ) \
        || { err "npm install in $EXT_DIR failed"; exit 1; }
fi

# ---------- step 6: settings.json + persist env ----------
log "Step 6/6: settings.json + shell rc"
mkdir -p "$HOME/.pi/agent"
if [ -f "$SETTINGS" ] && grep -q '"modelserver"' "$SETTINGS"; then
    log "  $SETTINGS already references modelserver, leaving alone"
else
    cat > "$SETTINGS" <<'PI_SETTINGS_EOF'
{
  "defaultProvider": "modelserver",
  "packages": [],
  "extensions": [
    "~/.pi/agent/extensions/modelserver/modelserver.ts"
  ]
}
PI_SETTINGS_EOF
    log "  wrote $SETTINGS"
fi

# Persist MODELSERVER_BASE_URL (and a hint about the key) into shell rc.
shell_rc=""
case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    *)      shell_rc="$HOME/.bashrc" ;;
esac
if [ -f "$shell_rc" ] && ! grep -q 'MODELSERVER_BASE_URL' "$shell_rc"; then
    {
        printf '\n# Added by pi-install for the modelserver Pi extension\n'
        printf 'export MODELSERVER_BASE_URL=%q\n' "$BASE_URL"
        printf '# Set MODELSERVER_API_KEY to your bearer-mode API key (created in the API Keys tab):\n'
        printf '# export MODELSERVER_API_KEY="..."\n'
    } >> "$shell_rc"
    log "  appended MODELSERVER_BASE_URL to $shell_rc"
fi

# ---------- verification ----------
echo
ok "Install complete."
echo "  Node:       $(node -v 2>/dev/null || echo MISSING)"
echo "  Pi:         $(pi --version 2>/dev/null || echo MISSING)"
echo "  Extension:  $EXT_DIR"
echo "  Settings:   $SETTINGS"
echo "  Base URL:   $BASE_URL"
echo
echo "Run (in THIS shell — bashrc edits don't take effect until next login):"
if [ -n "${MODELSERVER_API_KEY:-}" ]; then
    echo "  export MODELSERVER_BASE_URL=\"$BASE_URL\""
    echo "  pi"
    echo
    echo "(MODELSERVER_API_KEY is already set; MODELSERVER_BASE_URL was appended to your shell rc but won't be live until you re-source it.)"
else
    echo "  export MODELSERVER_BASE_URL=\"$BASE_URL\""
    echo "  export MODELSERVER_API_KEY=\"<your-bearer-key>\""
    echo "  pi"
fi
