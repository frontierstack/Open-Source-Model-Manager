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
START_TS=$SECONDS

# ============================================================================
# TERMINAL OUTPUT HELPERS  (mirrors the style of build.sh / start.sh)
# ============================================================================

# Colors — only when stdout is a terminal and NO_COLOR isn't set, so a
# `curl | bash > install.log` stays clean.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
    BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; DIM=''; BOLD=''; NC=''
fi

SYM_OK="${GREEN}✓${NC}"; SYM_FAIL="${RED}✗${NC}"; SYM_SKIP="${DIM}–${NC}"
SYM_WARN="${YELLOW}!${NC}"; SYM_ARROW="${CYAN}→${NC}"; SYM_INFO="${BLUE}ℹ${NC}"

log_info()    { printf "  %s  %s\n" "$SYM_INFO"  "$*"; }
log_success() { printf "  %s  %s\n" "$SYM_OK"    "$*"; }
log_warning() { printf "  %s  %s%s%s\n" "$SYM_WARN" "$YELLOW" "$*" "$NC" >&2; }
log_error()   { printf "  %s  %s%s%s\n" "$SYM_FAIL" "$RED"    "$*" "$NC" >&2; }
log_step()    { printf "  %s  %s\n" "$SYM_ARROW" "$*"; }
log_skip()    { printf "  %s  %s%s%s\n" "$SYM_SKIP" "$DIM" "$*" "$NC"; }

# Back-compat aliases for the older call sites below.
log()  { log_info "$*"; }
warn() { log_warning "$*"; }
err()  { log_error "$*"; }
ok()   { log_success "$*"; }

# Section header — visually separates install phases.
section() {
    printf "\n  %s%s%s%s\n" "$BOLD" "$CYAN" "$1" "$NC"
    printf "  %s" "$DIM"; printf '%.0s─' $(seq 1 "${#1}"); printf "%s\n" "$NC"
}

# Braille spinner for long-running tasks. Animates only on a TTY; otherwise it
# prints a single static step line so piped/redirected runs stay readable.
SPINNER_PID=""
start_spinner() {
    local msg="$1"
    if [ ! -t 1 ]; then
        log_step "$msg"
        SPINNER_PID=""
        return
    fi
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
    disown "$SPINNER_PID" 2>/dev/null || true
}
stop_spinner() {
    if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null || true
    fi
    SPINNER_PID=""
    [ -t 1 ] && printf "\r\033[K"  # clear the spinner line
    return 0
}
# Make sure a stray spinner never survives an early exit / Ctrl-C.
trap 'stop_spinner' EXIT INT TERM

# Format seconds as "Xm Ys".
fmt_duration() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then echo "$((secs / 60))m $((secs % 60))s"; else echo "${secs}s"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- banner ----------
printf "\n  %s%sHermes Agent Installer%s\n" "$BOLD" "$CYAN" "$NC"
printf "  %smodelserver MCP server + provider setup%s\n" "$DIM" "$NC"
printf "  %s%s%s\n" "$DIM" "$BASE_URL" "$NC"

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

# ============================================================================
# Step 1/6 · SSL / MITM bypass
# ============================================================================
section "Step 1/6 · SSL / MITM bypass"
if ! [ -f "$HOME/.curlrc" ] || ! grep -qE '^[[:space:]]*insecure' "$HOME/.curlrc" 2>/dev/null; then
    printf "insecure\n" >> "$HOME/.curlrc"
    log_success "appended 'insecure' to ~/.curlrc"
else
    log_skip "~/.curlrc already has 'insecure'"
fi
export NODE_TLS_REJECT_UNAUTHORIZED=0
log_success "NODE_TLS_REJECT_UNAUTHORIZED=0 for this run"

# ============================================================================
# Step 2/6 · curl
# ============================================================================
section "Step 2/6 · curl"
if have curl; then
    log_skip "curl present  ${DIM}$(curl --version | head -1)${NC}"
else
    if ! have apt-get; then
        err "No apt-get; install curl manually then re-run."
        exit 1
    fi
    start_spinner "Installing curl"
    {
        sudo_run apt-get update -y
        sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y curl \
            || sudo_run apt-get install -y curl
    } >/dev/null 2>&1
    stop_spinner
    if have curl; then
        log_success "curl installed  ${DIM}$(curl --version | head -1)${NC}"
    else
        err "Failed to install curl"
        exit 1
    fi
fi

# ============================================================================
# Step 3/6 · Node >= 20  (MCP server + configure.mjs need it)
# ============================================================================
section "Step 3/6 · Node >= 20"
maj=$(node_major)
if node_ok; then
    log_skip "Node $(node -v) detected — OK"
else
    if [ "$maj" -gt 0 ]; then
        log_warning "Node $(node -v) too old (need Node >=20); upgrading."
    else
        log_info "Node not installed; installing Node 22 LTS"
    fi

    installed=0
    NODE_LOG=$(mktemp -t hermes-install-node.XXXXXX)
    log_info "full Node-install log: ${DIM}$NODE_LOG${NC}"

    # Path A: NodeSource via apt (fast, system-wide).
    if [ "$installed" = 0 ] && have apt-get && [ -n "$SUDO" -o "$(id -u)" -eq 0 ]; then
        start_spinner "Installing Node 22 LTS via NodeSource (apt)"
        {
            printf '\n=== NodeSource setup script ===\n'
            curl -fsSLk https://deb.nodesource.com/setup_22.x | sudo_run -E bash -
            printf '\n=== apt install nodejs ===\n'
            sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs
        } >>"$NODE_LOG" 2>&1
        stop_spinner
        if node_ok; then
            installed=1
            log_success "installed system Node $(node -v)"
        else
            log_warning "NodeSource path didn't produce Node>=20; tail of log:"
            tail -8 "$NODE_LOG" | sed 's/^/      /' >&2
        fi
    fi

    # Path B: nvm (per-user, no apt).
    if [ "$installed" = 0 ]; then
        export NVM_DIR="$HOME/.nvm"
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
            start_spinner "Downloading nvm (per-user Node)"
            {
                printf '\n=== nvm install.sh ===\n'
                curl -kfsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            } >>"$NODE_LOG" 2>&1
            stop_spinner
            if [ ! -s "$NVM_DIR/nvm.sh" ]; then
                err "nvm download failed; tail of log:"
                tail -15 "$NODE_LOG" | sed 's/^/      /' >&2
                err "Full log: $NODE_LOG"
                exit 1
            fi
            log_success "nvm installed"
        fi
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
        start_spinner "Installing Node 22 via nvm (can take 1-3 min)"
        {
            printf '\n=== nvm install 22 ===\n'
            NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install 22
        } >>"$NODE_LOG" 2>&1
        stop_spinner
        if ! node_ok || ! have node; then
            for ver in 22.20.0 22.19.0 20.18.0; do
                start_spinner "alias '22' unresolvable; trying pinned v$ver"
                {
                    printf '\n=== nvm install %s ===\n' "$ver"
                    NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install "$ver"
                } >>"$NODE_LOG" 2>&1
                stop_spinner
                if node_ok; then break; fi
            done
        fi
        # Final fallback: direct tarball install.
        if ! node_ok || ! have node; then
            tarball_ver=22.20.0
            arch=$(uname -m); case "$arch" in
                x86_64) arch=x64 ;;
                aarch64|arm64) arch=arm64 ;;
            esac
            tarball="node-v${tarball_ver}-linux-${arch}.tar.xz"
            tdir=$(mktemp -d)
            start_spinner "nvm can't reach nodejs.org; trying direct tarball ($tarball)"
            {
                printf '\n=== direct tarball install (%s) ===\n' "$tarball"
                cd "$tdir" \
                    && curl -fkLO "https://nodejs.org/dist/v${tarball_ver}/${tarball}" \
                    && sudo_run tar -xJf "$tarball" -C /usr/local --strip-components=1
            } >>"$NODE_LOG" 2>&1
            stop_spinner
            rm -rf "$tdir"
        fi
        if node_ok; then
            installed=1
            nvm use "$(node -v | sed 's/^v//')" >>"$NODE_LOG" 2>&1 || true
            log_success "installed Node $(node -v)"
        else
            err "Could not install Node>=20 by any path; tail of log:"
            tail -30 "$NODE_LOG" | sed 's/^/      /' >&2
            err "Full log: $NODE_LOG"
            exit 1
        fi
    fi

    if [ "$installed" = 0 ]; then
        err "Could not install Node >=20 by any path. Aborting."
        exit 1
    fi
fi

# ============================================================================
# Step 3b · npm + global node/npm/npx
# ============================================================================
# Two real-world failures this fixes:
#   (1) The Hermes TUI shells out to `node` with a MINIMAL PATH — an nvm-only
#       install lives in ~/.nvm/.../bin and isn't on that PATH, so the TUI reports
#       "Node.js not found" even though `node -v` works in your login shell.
#   (2) Some setups have node without npm.
# Symlinking into /usr/local/bin (on every PATH, incl. non-interactive
# subprocesses) makes node/npm/npx resolvable for Hermes regardless of how Node
# was installed. The symlink targets are self-contained binaries, so they work
# without nvm being sourced.
section "Step 3b · npm + global node/npm/npx"
if ! have npm; then
    log_warning "npm not found alongside node; attempting to install"
    if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    fi
    if ! have npm && have apt-get; then
        start_spinner "Installing npm via apt"
        { sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y npm \
            || sudo_run apt-get install -y npm; } >/dev/null 2>&1
        stop_spinner
    fi
fi
sudo_run mkdir -p /usr/local/bin 2>/dev/null || true
for bin in node npm npx; do
    p="$(command -v "$bin" 2>/dev/null)"
    if [ -n "$p" ] && [ "$p" != "/usr/local/bin/$bin" ]; then
        if sudo_run ln -sf "$p" "/usr/local/bin/$bin" 2>/dev/null; then
            log_success "linked $bin ${DIM}→ /usr/local/bin/$bin ($p)${NC}"
        fi
    fi
done
if have node; then log_info "node $(node -v 2>/dev/null), npm $(npm -v 2>/dev/null || echo MISSING)"; fi

# ============================================================================
# Step 4/6 · Hermes Agent CLI
# ============================================================================
section "Step 4/6 · Hermes Agent CLI"
if have hermes && hermes --version >/dev/null 2>&1; then
    log_skip "Hermes already installed: $(hermes --version 2>/dev/null | head -1)"
else
    HERMES_LOG=$(mktemp -t hermes-install-cli.XXXXXX)
    start_spinner "Installing Hermes Agent (nousresearch)"
    curl -fsSLk https://hermes-agent.nousresearch.com/install.sh 2>>"$HERMES_LOG" | bash >>"$HERMES_LOG" 2>&1
    hermes_rc=$?
    stop_spinner
    if [ "$hermes_rc" = 0 ]; then
        # The Hermes installer edits shell rc; pull common install dirs onto PATH
        # for the rest of THIS script so `hermes` is callable below.
        for d in "$HOME/.local/bin" "$HOME/.hermes/bin"; do
            [ -d "$d" ] && case ":$PATH:" in *":$d:"*) :;; *) PATH="$d:$PATH";; esac
        done
        export PATH
        if have hermes; then
            log_success "installed Hermes $(hermes --version 2>/dev/null | head -1 || echo)"
        else
            log_warning "Hermes installed but not on PATH in this shell — re-source your shell rc (e.g. 'source ~/.bashrc') after this finishes."
        fi
    else
        log_warning "Hermes auto-install failed (network/MITM?); tail of log:"
        tail -8 "$HERMES_LOG" | sed 's/^/      /' >&2
        log_warning "Install it manually:  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
        log_warning "Continuing — the MCP server + config will still be installed."
    fi
fi

# ============================================================================
# Step 4b · Hermes tool dependencies (ripgrep, ffmpeg)
# ============================================================================
# Hermes' optional tool deps that "degrade gracefully" when missing: ripgrep
# (fast file search; falls back to grep) and ffmpeg (TTS voice messages).
# Installing them makes every Hermes feature work out of the box. node + a
# browser engine are handled by Hermes' own installer above.
section "Step 4b · Hermes tool dependencies"
missing_deps=""
for pair in "ripgrep:rg" "ffmpeg:ffmpeg"; do
    pkg="${pair%%:*}"; bin="${pair##*:}"
    if have "$bin"; then
        log_skip "$pkg present"
    else
        missing_deps="$missing_deps $pkg"
    fi
done
missing_deps="$(echo "$missing_deps" | xargs 2>/dev/null || true)"
if [ -z "$missing_deps" ]; then
    :
elif have apt-get && { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; }; then
    start_spinner "Installing Hermes tool deps: $missing_deps"
    {
        sudo_run apt-get update -y
        sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y $missing_deps \
            || sudo_run apt-get install -y $missing_deps
    } >/dev/null 2>&1
    stop_spinner
    still_missing=""
    for pair in "ripgrep:rg" "ffmpeg:ffmpeg"; do
        pkg="${pair%%:*}"; bin="${pair##*:}"
        case " $missing_deps " in
            *" $pkg "*) if have "$bin"; then log_success "$pkg installed"; else still_missing="$still_missing $pkg"; fi ;;
        esac
    done
    [ -n "$still_missing" ] && log_warning "could not install:$still_missing (optional — Hermes degrades gracefully: ripgrep→grep, ffmpeg→skip TTS)"
else
    log_warning "missing:$missing_deps — can't apt-install (no sudo/apt). Optional; Hermes degrades gracefully."
fi

# ============================================================================
# Step 5/6 · modelserver MCP server
# ============================================================================
section "Step 5/6 · modelserver MCP server"
log_info "target: ${DIM}$MCP_DIR${NC}"
if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    err "MODELSERVER_API_KEY is not set. Re-run with:"
    err "    export MODELSERVER_API_KEY=<your-bearer-key>"
    err "    curl -fsSk -H \"Authorization: Bearer \$MODELSERVER_API_KEY\" \\"
    err "        $BASE_URL/api/hermes/install | bash"
    exit 1
fi

npm config set strict-ssl false >/dev/null 2>&1 || true
mkdir -p "$MCP_DIR"

# Print actionable guidance for a rejected bearer key. $1 = HTTP code,
# $2 = path to the saved response body (may contain the server's JSON error).
auth_hint() {
    local code="$1" body="$2"
    err "HTTP $code from the server — the bearer key was rejected."
    if [ "$code" = "401" ]; then
        err "  401 Unauthorized. The Authorization header didn't pass auth. Check that:"
        err "    • the key is a *Bearer Only* key (API Keys tab → 'Bearer Only' flag);"
        err "      a standard key+secret pair is NOT accepted as a Bearer token."
        err "    • the key is Active (not disabled/revoked)."
        err "    • MODELSERVER_API_KEY is set in THIS shell with no stray spaces/newline:"
        err "        export MODELSERVER_API_KEY=<your-bearer-key>"
        err "    • you're hitting the right host: $BASE_URL"
    elif [ "$code" = "403" ]; then
        err "  403 Forbidden — the key authenticated but lacks the 'agents' permission."
        err "  Edit the key in the API Keys tab and grant 'agents'."
    fi
    if [ -n "$body" ] && [ -s "$body" ]; then
        err "  server said: $(head -c 300 "$body" | tr -d '\n')"
    fi
}

fetch_file() {
    local file="$1"
    local out="$MCP_DIR/$file"
    local code
    # No -f: we want to read the error BODY/STATUS on failure (a -f'd curl
    # exits silently on 401, which is exactly what hides auth problems).
    # -w prints the HTTP status to stdout; the body goes to -o.
    code=$(curl -sSk -w '%{http_code}' \
        -H "Authorization: Bearer $MODELSERVER_API_KEY" \
        "$BASE_URL/api/hermes/files/$file" -o "$out" 2>/dev/null)
    if [ "$code" = "200" ]; then
        return 0
    fi
    stop_spinner
    err "Download of '$file' failed."
    auth_hint "$code" "$out"
    rm -f "$out"
    return 1
}
start_spinner "Downloading MCP server files"
fetch_file modelserver-mcp.mjs || { err "Failed to download modelserver-mcp.mjs"; exit 1; }
fetch_file configure.mjs       || { err "Failed to download configure.mjs";       exit 1; }
fetch_file package.json        || { err "Failed to download package.json";        exit 1; }
stop_spinner
log_success "downloaded modelserver-mcp.mjs, configure.mjs, package.json"

if [ -d "$MCP_DIR/node_modules/@modelcontextprotocol/sdk" ] && [ -d "$MCP_DIR/node_modules/yaml" ]; then
    log_skip "MCP server deps already present, skipping npm install"
else
    start_spinner "Installing MCP server deps (@modelcontextprotocol/sdk, yaml)"
    ( cd "$MCP_DIR" && npm install --omit=dev --silent >/dev/null 2>&1 )
    deps_rc=$?
    stop_spinner
    if [ "$deps_rc" = 0 ]; then
        log_success "MCP server deps installed"
    else
        err "npm install in $MCP_DIR failed"
        exit 1
    fi
fi

# ============================================================================
# Step 6/6 · ~/.hermes/config.yaml + shell rc
# ============================================================================
section "Step 6/6 · ~/.hermes/config.yaml + shell rc"
CONF_LOG=$(mktemp -t hermes-install-config.XXXXXX)
start_spinner "Merging provider + MCP config into ~/.hermes/config.yaml"
( cd "$MCP_DIR" && MODELSERVER_BASE_URL="$BASE_URL" MODELSERVER_API_KEY="$MODELSERVER_API_KEY" node configure.mjs ) >>"$CONF_LOG" 2>&1
conf_rc=$?
stop_spinner
if [ "$conf_rc" = 0 ]; then
    log_success "merged provider + MCP config into ~/.hermes/config.yaml"
else
    err "configure.mjs failed — set up ~/.hermes/config.yaml manually (see README). tail of log:"
    tail -12 "$CONF_LOG" | sed 's/^/      /' >&2
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
    log_success "appended MODELSERVER_BASE_URL to $shell_rc"
else
    log_skip "MODELSERVER_BASE_URL already in $shell_rc"
fi

# ============================================================================
# Summary
# ============================================================================
section "Install complete  ${DIM}($(fmt_duration $((SECONDS - START_TS))))${NC}"
printf "  %s  Node        %s%s%s\n" "$SYM_OK" "$DIM" "$(node -v 2>/dev/null || echo MISSING)" "$NC"
if have hermes && hermes --version >/dev/null 2>&1; then
    printf "  %s  Hermes      %s%s%s\n" "$SYM_OK" "$DIM" "$(hermes --version 2>/dev/null | head -1)" "$NC"
else
    printf "  %s  Hermes      %s%s%s\n" "$SYM_WARN" "$DIM" "MISSING — re-source your shell rc or install manually" "$NC"
fi
printf "  %s  MCP server  %s%s%s\n" "$SYM_OK" "$DIM" "$MCP_DIR" "$NC"
printf "  %s  Config      %s%s%s\n" "$SYM_OK" "$DIM" "$HOME/.hermes/config.yaml" "$NC"
printf "  %s  Base URL    %s%s%s\n" "$SYM_OK" "$DIM" "$BASE_URL" "$NC"

printf "\n  %sProvider, model, API key, and tool-approvals are pre-configured — no setup\n" "$BOLD"
printf "  wizard. Just run Hermes:%s\n" "$NC"
printf "    %shermes%s          %s# classic CLI%s\n" "$CYAN" "$NC" "$DIM" "$NC"
printf "    %shermes --tui%s    %s# modern TUI (recommended)%s\n" "$CYAN" "$NC" "$DIM" "$NC"
printf "\n  %s(If 'hermes' isn't found, run 'source ~/.bashrc' — or 'source ~/.zshrc' — first.)%s\n" "$DIM" "$NC"
printf "  %s(Tool approvals default to OFF for frictionless runs — dial back up with%s\n" "$DIM" "$NC"
printf "  %s 'hermes config set approvals.mode smart'.)%s\n" "$DIM" "$NC"

# Successful end — drop the EXIT spinner-cleanup trap so it doesn't re-fire.
trap - EXIT INT TERM
