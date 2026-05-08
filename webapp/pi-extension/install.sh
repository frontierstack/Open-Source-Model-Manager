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

# ---------- step 3: ensure Node >= 20 ----------
log "Step 3/6: Node >= 20"
maj=$(node_major)
if [ "$maj" -ge 20 ] 2>/dev/null; then
    log "  Node $(node -v) detected — OK"
else
    if [ "$maj" -gt 0 ]; then
        warn "  Node $(node -v) too old (need >=20); upgrading."
    else
        log "  Node not installed; installing Node 22 LTS"
    fi

    installed=0

    # Path A: NodeSource via apt (fast, system-wide). Use -k for the
    # setup script; it adds the apt source then we install with the
    # apt cert-verify bypass.
    if [ "$installed" = 0 ] && have apt-get && [ -n "$SUDO" -o "$(id -u)" -eq 0 ]; then
        log "  trying NodeSource (apt path)"
        if curl -fsSLk https://deb.nodesource.com/setup_22.x | sudo_run -E bash - >/dev/null 2>&1; then
            if sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs >/dev/null 2>&1; then
                if [ "$(node_major)" -ge 20 ] 2>/dev/null; then installed=1; fi
            fi
        fi
        [ "$installed" = 1 ] && ok "  installed system Node $(node -v)"
    fi

    # Path B: nvm (per-user, no apt). Always works around MITM if
    # ~/.curlrc has 'insecure' (which we set above).
    if [ "$installed" = 0 ]; then
        log "  trying nvm (per-user path)"
        export NVM_DIR="$HOME/.nvm"
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
            curl -kfsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 \
                || { err "nvm download failed"; exit 1; }
        fi
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
        nvm install 22 >/dev/null 2>&1 || { err "nvm install 22 failed"; exit 1; }
        nvm use 22 >/dev/null 2>&1 || true
        if [ "$(node_major)" -ge 20 ] 2>/dev/null; then
            installed=1
            ok "  nvm installed Node $(node -v)"
        fi
    fi

    if [ "$installed" = 0 ]; then
        err "Could not install Node >=20 by any path. Aborting."
        exit 1
    fi
fi

# ---------- step 4: ensure Pi CLI ----------
log "Step 4/6: Pi CLI"
npm config set strict-ssl false >/dev/null 2>&1 || true

if have pi && pi --version >/dev/null 2>&1; then
    log "  Pi already installed: $(pi --version)"
else
    log "  installing @earendil-works/pi-coding-agent globally"
    # If we're using nvm, npm globals are user-owned (no sudo).
    if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
        npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1 \
            || { err "npm install -g pi failed"; exit 1; }
    else
        sudo_run npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1 \
            || npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1 \
            || { err "npm install -g pi failed"; exit 1; }
    fi
    ok "  installed Pi $(pi --version 2>/dev/null || echo unknown)"
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
echo "Run:"
echo "  export MODELSERVER_API_KEY=\"<your-bearer-key>\"   # if not already set"
echo "  pi"
