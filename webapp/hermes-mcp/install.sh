#!/usr/bin/env bash
# Hermes Agent one-shot installer for the model server.
#
# Installs Hermes Agent (nousresearch) if missing, drops the modelserver MCP
# server under ~/.hermes/mcp-servers/modelserver/, and merges the provider +
# MCP config into ~/.hermes/config.yaml. Idempotent; self-corrects for common
# failure modes:
#   - corporate MITM proxies (writes ~/.curlrc, sets NODE_TLS_REJECT_UNAUTHORIZED=0,
#     npm strict-ssl=false)
#   - missing or old Node (installs Node 22 LTS via NodeSource, falls back to nvm)
#   - missing Hermes / curl
#   - broken sudo (skips when running as root, falls back when sudo is unusable)
#   - re-runs cleanly: skips work that's already done
#
# Usage:
#   export MODELSERVER_API_KEY="<your-bearer-key>"
#   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
#     <BASE_URL>/api/hermes/install | bash
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base URL
# when serving this script via /api/hermes/install.

# Don't `set -e` — we rely on individual step checks to keep going.
set -u

BASE_URL_DEFAULT="__MODELSERVER_BASE_URL__"
BASE_URL="${MODELSERVER_BASE_URL:-$BASE_URL_DEFAULT}"
MCP_DIR="$HOME/.hermes/mcp-servers/modelserver"

# ---------- helpers ----------
c_blue=$'\033[1;36m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_green=$'\033[1;32m'; c_off=$'\033[0m'
log()  { printf "%s[hermes-install]%s %s\n" "$c_blue"   "$c_off" "$*"; }
warn() { printf "%s[hermes-install]%s %s\n" "$c_yellow" "$c_off" "$*" >&2; }
err()  { printf "%s[hermes-install]%s %s\n" "$c_red"    "$c_off" "$*" >&2; }
ok()   { printf "%s[hermes-install]%s %s\n" "$c_green"  "$c_off" "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Privilege-escalation wrapper that copes with broken sudo.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if have sudo && sudo -n true 2>/dev/null; then
        SUDO="sudo"
    elif have sudo; then
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

node_major() { have node || { echo 0; return; }; node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
# The MCP SDK + global fetch in configure.mjs need Node >= 20.
node_ok() { [ "$(node_major)" -ge 20 ] 2>/dev/null; }

# Node v20+/v22 core-dumps at startup with a V8 StackOverflow when the stack
# ulimit is 'unlimited'. Clamp the soft limit to the normal 8 MB default so every
# node/npm invocation below inherits a sane stack.
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

# ---------- step 3: ensure Node >= 20 (MCP server + configure.mjs need it) ----------
log "Step 3/6: Node >= 20"
maj=$(node_major)
if node_ok; then
    log "  Node $(node -v) detected — OK"
else
    if [ "$maj" -gt 0 ]; then
        warn "  Node $(node -v) too old (need Node >=20); upgrading."
    else
        log "  Node not installed; installing Node 22 LTS"
    fi

    installed=0
    NODE_LOG=$(mktemp -t hermes-install-node.XXXXXX)
    log "  (full Node-install log: $NODE_LOG)"

    # Path A: NodeSource via apt (fast, system-wide).
    if [ "$installed" = 0 ] && have apt-get && [ -n "$SUDO" -o "$(id -u)" -eq 0 ]; then
        log "  trying NodeSource (apt path)"
        {
            printf '\n=== NodeSource setup script ===\n'
            curl -fsSLk https://deb.nodesource.com/setup_22.x | sudo_run -E bash -
            printf '\n=== apt install nodejs ===\n'
            sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs
        } >>"$NODE_LOG" 2>&1
        if node_ok; then
            installed=1
            ok "  installed system Node $(node -v)"
        else
            warn "  NodeSource path didn't produce Node>=20; tail of log:"
            tail -8 "$NODE_LOG" | sed 's/^/    /' >&2
        fi
    fi

    # Path B: nvm (per-user, no apt).
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
        if ! node_ok || ! have node; then
            for ver in 22.20.0 22.19.0 20.18.0; do
                log "  alias '22' unresolvable; trying pinned v$ver"
                {
                    printf '\n=== nvm install %s ===\n' "$ver"
                    NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install "$ver"
                } >>"$NODE_LOG" 2>&1
                if node_ok; then break; fi
            done
        fi
        # Final fallback: direct tarball install.
        if ! node_ok || ! have node; then
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
        if node_ok; then
            installed=1
            nvm use "$(node -v | sed 's/^v//')" >>"$NODE_LOG" 2>&1 || true
            ok "  installed Node $(node -v)"
        else
            err "Could not install Node>=20 by any path; tail of log:"
            tail -30 "$NODE_LOG" | sed 's/^/    /' >&2
            err "Full log: $NODE_LOG"
            exit 1
        fi
    fi

    if [ "$installed" = 0 ]; then
        err "Could not install Node >=20 by any path. Aborting."
        exit 1
    fi
fi

# ---------- step 3b: ensure npm, and make node/npm/npx GLOBALLY visible ----------
# Two real-world failures this fixes:
#   (1) The Hermes TUI shells out to `node` with a MINIMAL PATH — an nvm-only
#       install lives in ~/.nvm/.../bin and isn't on that PATH, so the TUI reports
#       "Node.js not found" even though `node -v` works in your login shell.
#   (2) Some setups have node without npm.
# Symlinking into /usr/local/bin (on every PATH, incl. non-interactive
# subprocesses) makes node/npm/npx resolvable for Hermes regardless of how Node
# was installed. The symlink targets are self-contained binaries, so they work
# without nvm being sourced.
log "Step 3b: npm + global node/npm/npx"
if ! have npm; then
    warn "  npm not found alongside node; attempting to install"
    if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    fi
    if ! have npm && have apt-get; then
        sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y npm >/dev/null 2>&1 \
            || sudo_run apt-get install -y npm >/dev/null 2>&1 || true
    fi
fi
sudo_run mkdir -p /usr/local/bin 2>/dev/null || true
for bin in node npm npx; do
    p="$(command -v "$bin" 2>/dev/null)"
    if [ -n "$p" ] && [ "$p" != "/usr/local/bin/$bin" ]; then
        if sudo_run ln -sf "$p" "/usr/local/bin/$bin" 2>/dev/null; then
            log "  linked $bin -> /usr/local/bin/$bin ($p)"
        fi
    fi
done
if have node; then log "  node: $(node -v 2>/dev/null), npm: $(npm -v 2>/dev/null || echo MISSING)"; fi

# ---------- step 4: ensure Hermes Agent ----------
log "Step 4/6: Hermes Agent CLI"
if have hermes && hermes --version >/dev/null 2>&1; then
    log "  Hermes already installed: $(hermes --version 2>/dev/null | head -1)"
else
    log "  installing Hermes Agent (nousresearch)"
    if curl -fsSLk https://hermes-agent.nousresearch.com/install.sh | bash; then
        # The Hermes installer edits shell rc; pull common install dirs onto PATH
        # for the rest of THIS script so `hermes` is callable below.
        for d in "$HOME/.local/bin" "$HOME/.hermes/bin"; do
            [ -d "$d" ] && case ":$PATH:" in *":$d:"*) :;; *) PATH="$d:$PATH";; esac
        done
        export PATH
        if have hermes; then
            ok "  installed Hermes $(hermes --version 2>/dev/null | head -1 || echo)"
        else
            warn "  Hermes installed but not on PATH in this shell — re-source your shell rc (e.g. 'source ~/.bashrc') after this finishes."
        fi
    else
        warn "  Hermes auto-install failed (network/MITM?). Install it manually:"
        warn "    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
        warn "  Continuing — the MCP server + config will still be installed."
    fi
fi

# ---------- step 5: drop the modelserver MCP server ----------
log "Step 5/6: modelserver MCP server at $MCP_DIR"
if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    err "MODELSERVER_API_KEY is not set. Re-run with:"
    err "    export MODELSERVER_API_KEY=<your-bearer-key>"
    err "    curl -fsSk -H \"Authorization: Bearer \$MODELSERVER_API_KEY\" \\"
    err "        $BASE_URL/api/hermes/install | bash"
    exit 1
fi

npm config set strict-ssl false >/dev/null 2>&1 || true
mkdir -p "$MCP_DIR"
fetch_file() {
    local file="$1"
    curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
        "$BASE_URL/api/hermes/files/$file" -o "$MCP_DIR/$file"
}
fetch_file modelserver-mcp.mjs || { err "Failed to download modelserver-mcp.mjs"; exit 1; }
fetch_file configure.mjs       || { err "Failed to download configure.mjs";       exit 1; }
fetch_file package.json        || { err "Failed to download package.json";        exit 1; }
log "  files dropped"

if [ -d "$MCP_DIR/node_modules/@modelcontextprotocol/sdk" ] && [ -d "$MCP_DIR/node_modules/yaml" ]; then
    log "  MCP server deps already present, skipping npm install"
else
    log "  installing MCP server deps (@modelcontextprotocol/sdk, yaml)"
    ( cd "$MCP_DIR" && npm install --omit=dev --silent >/dev/null 2>&1 ) \
        || { err "npm install in $MCP_DIR failed"; exit 1; }
fi

# ---------- step 6: merge Hermes config + persist env ----------
log "Step 6/6: ~/.hermes/config.yaml + shell rc"
if ( cd "$MCP_DIR" && MODELSERVER_BASE_URL="$BASE_URL" MODELSERVER_API_KEY="$MODELSERVER_API_KEY" node configure.mjs ); then
    ok "  merged provider + MCP config into ~/.hermes/config.yaml"
else
    err "  configure.mjs failed — set up ~/.hermes/config.yaml manually (see README)."
fi

# Persist MODELSERVER_BASE_URL (and a hint about the key) into shell rc.
shell_rc=""
case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    *)      shell_rc="$HOME/.bashrc" ;;
esac
if [ -f "$shell_rc" ] && ! grep -q 'MODELSERVER_BASE_URL' "$shell_rc"; then
    {
        printf '\n# Added by hermes-install for the modelserver MCP server\n'
        printf 'export MODELSERVER_BASE_URL=%q\n' "$BASE_URL"
        printf '# Set MODELSERVER_API_KEY to your bearer-mode API key (created in the API Keys tab):\n'
        printf '# export MODELSERVER_API_KEY="..."\n'
    } >> "$shell_rc"
    log "  appended MODELSERVER_BASE_URL to $shell_rc"
fi

# ---------- verification ----------
echo
ok "Install complete."
echo "  Node:        $(node -v 2>/dev/null || echo MISSING)"
echo "  Hermes:      $(hermes --version 2>/dev/null | head -1 || echo 'MISSING — re-source your shell rc or install manually')"
echo "  MCP server:  $MCP_DIR"
echo "  Config:      $HOME/.hermes/config.yaml"
echo "  Base URL:    $BASE_URL"
echo
echo "Provider, model, API key, and tool-approvals are pre-configured — no setup"
echo "wizard. Just run Hermes:"
echo "  hermes          # classic CLI"
echo "  hermes --tui    # modern TUI (recommended)"
echo
echo "(If 'hermes' isn't found, run 'source ~/.bashrc' — or 'source ~/.zshrc' — first.)"
echo "(Tool approvals default to OFF for frictionless runs — dial back up with"
echo " 'hermes config set approvals.mode smart'.)"
