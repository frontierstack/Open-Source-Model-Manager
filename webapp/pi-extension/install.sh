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
#   - re-runs cleanly: skips work that's already done. An nvm-managed Node
#     is detected even though `curl | bash` never sources your shell rc.
#
# Speed notes:
#   - Node via apt adds the NodeSource repo by hand and apt-updates ONLY
#     that list (piping setup_22.x re-indexes every apt source on the box —
#     that was the slow part). The setup script remains a fallback.
#   - npm runs with --no-audit --no-fund.
#
# Usage:
#   export MODELSERVER_API_KEY="<your-bearer-key>"
#   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
#     <BASE_URL>/api/pi/install | bash && source ~/.bashrc
#
# The trailing `source ~/.bashrc` matters: this script runs in a CHILD bash
# (curl | bash) and cannot modify the shell you invoked it from. It makes
# your rc self-sufficient (nvm init + MODELSERVER_BASE_URL), so one source
# in YOUR shell puts `pi` on PATH immediately. New terminals need nothing.
#
# Env:
#   PI_INSTALL_NO_SPINNER=1   disable the progress spinner (CI / log capture)
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/pi/install or /api/pi/config.

# Don't `set -e` — we rely on individual step checks to keep going.
set -u

BASE_URL_DEFAULT="__MODELSERVER_BASE_URL__"
BASE_URL="${MODELSERVER_BASE_URL:-$BASE_URL_DEFAULT}"
EXT_DIR="$HOME/.pi/agent/extensions/modelserver"
SETTINGS="$HOME/.pi/agent/settings.json"

# ---------- terminal output helpers ----------
c_red=$'\033[0;31m'; c_green=$'\033[0;32m'; c_yellow=$'\033[1;33m'
c_cyan=$'\033[0;36m'; c_dim=$'\033[2m'; c_bold=$'\033[1m'; c_off=$'\033[0m'

SYM_OK="${c_green}✓${c_off}"
SYM_FAIL="${c_red}✗${c_off}"
SYM_WARN="${c_yellow}!${c_off}"
SYM_ARROW="${c_cyan}→${c_off}"

# Spinner — braille frames, matches the repo utility scripts. Degrades to a
# plain "→" line when stdout isn't a TTY (CI, curl | bash > log) or when
# PI_INSTALL_NO_SPINNER is set.
SPINNER_PID=""
spinner_enabled() { [ -t 1 ] && [ -z "${PI_INSTALL_NO_SPINNER:-}" ]; }
start_spinner() {
    local msg="$1"
    if ! spinner_enabled; then
        printf "  %s  %s\n" "$SYM_ARROW" "$msg"
        return
    fi
    (
        local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
        local i=0 start=$SECONDS
        while true; do
            printf "\r\033[K  %s%s%s  %s %s(%ds)%s" \
                "$c_cyan" "${frames[$i]}" "$c_off" "$msg" \
                "$c_dim" "$(( SECONDS - start ))" "$c_off"
            i=$(( (i + 1) % ${#frames[@]} ))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    disown "$SPINNER_PID" 2>/dev/null || true
}
stop_spinner() {
    if [ -n "${SPINNER_PID:-}" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null || true
        wait "$SPINNER_PID" 2>/dev/null || true
        printf "\r\033[K"
    fi
    SPINNER_PID=""
}
trap stop_spinner EXIT INT TERM

# Result lines auto-stop a running spinner so output never garbles.
say()      { printf "  %b\n" "$*"; }
log_ok()   { stop_spinner; printf "  %b  %s\n" "$SYM_OK" "$*"; }
log_step() { stop_spinner; printf "  %b  %s\n" "$SYM_ARROW" "$*"; }
log_warn() { stop_spinner; printf "  %b  %b%s%b\n" "$SYM_WARN" "$c_yellow" "$*" "$c_off" >&2; }
log_err()  { stop_spinner; printf "  %b  %b%s%b\n" "$SYM_FAIL" "$c_red"    "$*" "$c_off" >&2; }

section() {
    stop_spinner
    # Count CHARACTERS, not bytes, for the underline — under a C locale the
    # multibyte '·'/'≥' in titles would otherwise pad the rule too long.
    local t="$1" n _lc="${LC_ALL-}"
    LC_ALL=C.UTF-8 2>/dev/null || true
    n=${#t}
    if [ -n "$_lc" ]; then LC_ALL="$_lc"; else unset LC_ALL 2>/dev/null || LC_ALL=""; fi
    echo ""
    printf "  %b%s%b\n" "${c_bold}${c_cyan}" "$t" "$c_off"
    printf "  %b%s%b\n" "$c_dim" "$(printf '%.0s─' $(seq 1 "$n"))" "$c_off"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- banner ----------
echo ""
printf "  %bPi (pi.dev) installer%b\n" "$c_bold" "$c_off"
printf "  %b%s · %s%b\n" "$c_dim" "$BASE_URL" "$(date '+%Y-%m-%d %H:%M:%S')" "$c_off"

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
            log_warn "sudo not usable here — system installs will be skipped if not root."
        fi
    else
        log_warn "Not root and no sudo — system installs will be skipped."
    fi
fi
sudo_run() { if [ -n "$SUDO" ]; then $SUDO "$@"; else "$@"; fi; }

node_major() {
    have node || { echo 0; return; }
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}
node_minor() {
    have node || { echo 0; return; }
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f2
}
# Pi engines require Node >=22.19.0. major>22 is fine; on the 22 line the
# minor must be >=19 (a bare 22.0–22.18 passes a major-only check but then
# pi/npm can fail engine validation or hit the V8 stack quirk).
node_ok() {
    local maj min
    maj=$(node_major); min=$(node_minor)
    [ "${maj:-0}" -gt 22 ] 2>/dev/null && return 0
    [ "${maj:-0}" -eq 22 ] 2>/dev/null && [ "${min:-0}" -ge 19 ] 2>/dev/null && return 0
    return 1
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
        log_warn "stack ulimit was 'unlimited' (crashes Node v20+); clamped to 8 MB for this run."
        log_warn "  make it permanent:  echo 'ulimit -S -s 8192' >> ~/.bashrc"
    fi
fi

# ---------- step 1: SSL bypass for MITM environments ----------
section "1/6 · SSL / MITM bypass"
if ! [ -f "$HOME/.curlrc" ] || ! grep -qE '^[[:space:]]*insecure' "$HOME/.curlrc" 2>/dev/null; then
    printf "insecure\n" >> "$HOME/.curlrc"
    log_ok "appended 'insecure' to ~/.curlrc"
else
    log_ok "~/.curlrc already has 'insecure'"
fi
export NODE_TLS_REJECT_UNAUTHORIZED=0

# ---------- step 2: ensure curl ----------
section "2/6 · curl"
if ! have curl; then
    start_spinner "installing curl"
    if have apt-get; then
        sudo_run apt-get update -y >/dev/null 2>&1 || true
        sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y curl >/dev/null 2>&1 \
            || sudo_run apt-get install -y curl >/dev/null 2>&1 \
            || { log_err "Failed to install curl"; exit 1; }
    else
        log_err "No apt-get; install curl manually then re-run."
        exit 1
    fi
fi
log_ok "curl present: $(curl --version | head -1 | cut -d' ' -f1-2)"

# ---------- step 3: ensure Node >= 22.19 (Pi engines require it) ----------
section "3/6 · Node ≥ 22.19"

# `curl | bash` never sources your shell rc, so an nvm-managed Node is
# invisible to a bare PATH check — source nvm first so re-runs on nvm
# machines take the instant fast path instead of re-installing Node.
if ! have node && [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    have node && log_step "found nvm-managed Node on a fresh shell (sourced ~/.nvm/nvm.sh)"
fi

if node_ok; then
    log_ok "Node $(node -v) detected — OK"
else
    maj=$(node_major)
    if [ "$maj" -gt 0 ]; then
        log_warn "Node $(node -v) too old (Pi needs Node ≥22.19); upgrading."
    else
        log_step "Node not installed; installing Node 22 LTS"
    fi

    installed=0
    NODE_LOG=$(mktemp -t pi-install-node.XXXXXX)
    say "${c_dim}full Node-install log: $NODE_LOG${c_off}"

    # Path A: NodeSource via apt (fast, system-wide). Speed: add the repo +
    # signing key by hand, then apt-update ONLY the NodeSource list — piping
    # setup_22.x re-indexes every apt source on the box, which is where the
    # old installer spent most of its time. The setup script stays as a
    # fallback when gpg is unavailable or the manual path fails.
    if [ "$installed" = 0 ] && have apt-get && { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; }; then
        ns_list=/etc/apt/sources.list.d/nodesource.list
        ns_key=/usr/share/keyrings/nodesource.gpg
        repo_ready=0
        apt_setup_tried=0

        if [ -s "$ns_list" ]; then
            repo_ready=1   # already configured by a previous run
        else
            start_spinner "adding NodeSource apt repo"
            {
                printf '\n=== NodeSource manual repo add ===\n'
                if have gpg; then
                    curl -fsSLk https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
                        | sudo_run gpg --dearmor --yes -o "$ns_key" \
                        && printf 'deb [signed-by=%s] https://deb.nodesource.com/node_22.x nodistro main\n' "$ns_key" \
                            | sudo_run tee "$ns_list" >/dev/null
                else
                    # No gpg (stock ubuntu containers ship without it): modern
                    # apt (>=2.2, Ubuntu 22.04/Debian 11+) accepts the armored
                    # key directly in signed-by. If apt is too old for this,
                    # the targeted update below fails and we cascade to the
                    # setup-script fallback.
                    ns_key_asc="${ns_key%.gpg}.asc"
                    curl -fsSLk https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
                        | sudo_run tee "$ns_key_asc" >/dev/null \
                        && printf 'deb [signed-by=%s] https://deb.nodesource.com/node_22.x nodistro main\n' "$ns_key_asc" \
                            | sudo_run tee "$ns_list" >/dev/null
                fi
            } >>"$NODE_LOG" 2>&1 && [ -s "$ns_list" ] && repo_ready=1
            stop_spinner
        fi

        if [ "$repo_ready" = 1 ]; then
            start_spinner "installing Node 22 (NodeSource apt, targeted update)"
            {
                printf '\n=== targeted apt update (NodeSource list only) + install ===\n'
                sudo_run apt-get update -y \
                    -o Acquire::https::Verify-Peer=false \
                    -o Dir::Etc::sourcelist="sources.list.d/nodesource.list" \
                    -o Dir::Etc::sourceparts="-" \
                    -o APT::Get::List-Cleanup="0" \
                && sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs
            } >>"$NODE_LOG" 2>&1
            stop_spinner
        fi

        # Fallback: the official setup script (slower — full apt update).
        if ! node_ok; then
            apt_setup_tried=1
            start_spinner "installing Node 22 (NodeSource setup script — slower fallback)"
            {
                printf '\n=== NodeSource setup script ===\n'
                # NOT `sudo_run -E bash -`: with no sudo (root), that execs the
                # literal command `-E` — the setup script never ran and the
                # apt install below grabbed the DISTRO's nodejs (12.x on
                # jammy). Branch explicitly, and only apt-install when the
                # repo script actually succeeded.
                setup_ok=0
                if [ -n "$SUDO" ]; then
                    curl -fsSLk https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && setup_ok=1
                else
                    curl -fsSLk https://deb.nodesource.com/setup_22.x | bash - && setup_ok=1
                fi
                if [ "$setup_ok" = 1 ]; then
                    printf '\n=== apt install nodejs ===\n'
                    sudo_run apt-get -o Acquire::https::Verify-Peer=false install -y nodejs
                fi
            } >>"$NODE_LOG" 2>&1
            stop_spinner
        fi

        if node_ok; then
            installed=1
            log_ok "installed system Node $(node -v)"
        else
            log_warn "NodeSource path didn't produce Node ≥22.19 (setup-script fallback tried: $apt_setup_tried); tail of log:"
            tail -8 "$NODE_LOG" | sed 's/^/      /' >&2
        fi
    fi

    # Path B: nvm (per-user, no apt). Always works around MITM if
    # ~/.curlrc has 'insecure' (which we set above). Also force-set
    # NODE_TLS_REJECT_UNAUTHORIZED=0 in the nvm subshell since some
    # corporate inspectors break nvm's curl differently than the
    # global curlrc fixes.
    if [ "$installed" = 0 ]; then
        log_step "trying nvm (per-user path)"
        export NVM_DIR="$HOME/.nvm"
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
            start_spinner "downloading nvm"
            {
                printf '\n=== nvm install.sh ===\n'
                curl -kfsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            } >>"$NODE_LOG" 2>&1
            stop_spinner
            if [ ! -s "$NVM_DIR/nvm.sh" ]; then
                log_err "nvm download failed; tail of log:"
                tail -15 "$NODE_LOG" | sed 's/^/      /' >&2
                log_err "Full log: $NODE_LOG"
                exit 1
            fi
        fi
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
        start_spinner "nvm install 22 (can take 1-3 min)"
        {
            printf '\n=== nvm install 22 ===\n'
            NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install 22
        } >>"$NODE_LOG" 2>&1
        stop_spinner
        # Some MITM proxies break nvm's fetch of nodejs.org/dist/index.tab,
        # which makes the `22` alias unresolvable. Fall back to pinned
        # Node 22 LTS releases (try latest first, then known-stable).
        if ! node_ok || ! have node; then
            for ver in 22.20.0 22.19.0; do
                start_spinner "alias '22' unresolvable; trying pinned v$ver"
                {
                    printf '\n=== nvm install %s ===\n' "$ver"
                    NODE_TLS_REJECT_UNAUTHORIZED=0 nvm install "$ver"
                } >>"$NODE_LOG" 2>&1
                stop_spinner
                if node_ok; then break; fi
            done
        fi
        # Final fallback: direct tarball install if nvm can't reach
        # nodejs.org/dist/ at all.
        if ! node_ok || ! have node; then
            tarball_ver=22.20.0
            arch=$(uname -m); case "$arch" in
                x86_64) arch=x64 ;;
                aarch64|arm64) arch=arm64 ;;
            esac
            tarball="node-v${tarball_ver}-linux-${arch}.tar.xz"
            start_spinner "nvm can't reach nodejs.org/dist/; direct tarball install ($tarball)"
            tdir=$(mktemp -d)
            {
                printf '\n=== direct tarball install (%s) ===\n' "$tarball"
                cd "$tdir" \
                    && curl -fkLO "https://nodejs.org/dist/v${tarball_ver}/${tarball}" \
                    && sudo_run tar -xJf "$tarball" -C /usr/local --strip-components=1
            } >>"$NODE_LOG" 2>&1
            rm -rf "$tdir"
            stop_spinner
        fi
        if node_ok; then
            installed=1
            nvm use "$(node -v | sed 's/^v//')" >>"$NODE_LOG" 2>&1 || true
            log_ok "installed Node $(node -v)"
        else
            log_err "Could not install Node ≥22.19 by any path; tail of log:"
            tail -30 "$NODE_LOG" | sed 's/^/      /' >&2
            log_err "Full log: $NODE_LOG"
            exit 1
        fi
    fi

    if [ "$installed" = 0 ]; then
        log_err "Could not install Node ≥22.19 by any path. Aborting."
        exit 1
    fi
fi

# ---------- step 4: ensure Pi CLI ----------
section "4/6 · Pi CLI"
npm config set strict-ssl false >/dev/null 2>&1 || true

# `pi --version` boots the whole Node CLI (~1-2s) — run it ONCE and reuse.
pi_ver=""
if have pi; then pi_ver="$(pi --version 2>/dev/null | tr -d '[:space:]')" || pi_ver=""; fi
# Pi <0.75 is missing context-overflow auto-recovery + supply-chain hardening,
# predates the Node 22.19 bump, and predates the TypeBox 1.x extension API
# (0.69) this extension now targets; force-upgrade. Major-aware so a future
# 1.x (minor resets to 0) isn't wrongly flagged as old.
pi_needs_upgrade=0
if [ -n "$pi_ver" ]; then
    pi_major="$(printf '%s' "$pi_ver" | cut -d. -f1)"
    pi_minor="$(printf '%s' "$pi_ver" | cut -d. -f2)"
    if [ "${pi_major:-0}" -gt 0 ] 2>/dev/null; then
        : # 1.x or newer — fine
    elif [ "${pi_minor:-0}" -ge 75 ] 2>/dev/null; then
        : # 0.75+ — fine
    else
        pi_needs_upgrade=1
    fi
fi
if [ -n "$pi_ver" ] && [ "$pi_needs_upgrade" = 0 ]; then
    log_ok "Pi already installed: $pi_ver"
else
    if [ -n "$pi_ver" ]; then
        log_step "Pi $pi_ver is older than 0.75 — upgrading to latest"
    fi
    # Capture combined npm output to a log so failures are DIAGNOSABLE. The
    # old `>/dev/null 2>&1` hid the real error (e.g. "RangeError: Maximum call
    # stack size exceeded" from a broken npm cache / too-old npm), leaving only
    # an opaque "npm install -g pi failed". --no-audit/--no-fund skip npm's
    # registry side-trips (audit metadata, funding banner) for a faster install.
    PI_NPM_LOG="$(mktemp 2>/dev/null || echo /tmp/pi-npm-install.log)"
    pi_npm_install() {
        # nvm globals are user-owned (no sudo); otherwise try sudo then plain.
        if [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
            npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1
        else
            sudo_run npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1 \
                || npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@latest >"$PI_NPM_LOG" 2>&1
        fi
    }
    start_spinner "installing @earendil-works/pi-coding-agent (npm)"
    if pi_npm_install; then
        pi_ver="$(pi --version 2>/dev/null | tr -d '[:space:]')" || pi_ver=""
        log_ok "installed Pi ${pi_ver:-unknown}"
        rm -f "$PI_NPM_LOG" 2>/dev/null || true
    else
        log_err "npm install -g @earendil-works/pi-coding-agent failed. Last npm output:"
        tail -n 25 "$PI_NPM_LOG" 2>/dev/null | sed 's/^/      /' >&2
        log_err "Full log: $PI_NPM_LOG"
        log_err "Common fixes for 'Maximum call stack size exceeded' / cache errors:"
        log_err "    npm cache clean --force"
        log_err "    npm install -g npm@latest        # update npm itself, then retry"
        log_err "    npm install -g @earendil-works/pi-coding-agent"
        log_err "  one-off workaround (raise Node's stack):"
        log_err "    node --stack-size=4000 \"\$(command -v npm)\" install -g @earendil-works/pi-coding-agent"
        # Don't hard-fail if a usable 'pi' is already on PATH — still install
        # the extension so a working Pi picks up our latest catalog.
        if [ -n "$pi_ver" ]; then
            log_warn "Existing pi found ($pi_ver); continuing with the extension install."
        else
            log_err "Pi CLI is required. Fix the npm error above, then re-run this installer."
            exit 1
        fi
    fi
fi

# ---------- step 5: drop the modelserver extension ----------
section "5/6 · modelserver extension"
say "${c_dim}$EXT_DIR${c_off}"
if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    log_err "MODELSERVER_API_KEY is not set. Re-run with:"
    log_err "    export MODELSERVER_API_KEY=<your-bearer-key>"
    log_err "    curl -fsSk -H \"Authorization: Bearer \$MODELSERVER_API_KEY\" \\"
    log_err "        $BASE_URL/api/pi/install | bash && source ~/.bashrc"
    exit 1
fi

mkdir -p "$EXT_DIR"
fetch_ext() {
    local file="$1"
    curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
        "$BASE_URL/api/pi/extension/$file" -o "$EXT_DIR/$file"
}
fetch_ext modelserver.ts || { log_err "Failed to download modelserver.ts"; exit 1; }
fetch_ext package.json   || { log_err "Failed to download package.json";   exit 1; }
log_ok "extension files dropped"

# install deps in the extension dir (Typebox). Pi 0.69+ uses the rebranded
# `typebox` package (1.x), not the old `@sinclair/typebox` — check for the
# CURRENT dep so an older install that only has @sinclair/typebox still gets
# `typebox` pulled in on re-run (the extension now imports from `typebox`).
if [ -d "$EXT_DIR/node_modules/typebox" ]; then
    log_ok "extension deps already present, skipping npm install"
else
    start_spinner "installing extension deps (Typebox)"
    ( cd "$EXT_DIR" && npm install --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1 ) \
        || { log_err "npm install in $EXT_DIR failed"; exit 1; }
    log_ok "extension deps installed"
fi

# ---------- step 6: settings.json + persist env ----------
section "6/6 · settings.json + shell rc"
mkdir -p "$HOME/.pi/agent"
if [ -f "$SETTINGS" ] && grep -q '"modelserver"' "$SETTINGS"; then
    log_ok "$SETTINGS already references modelserver, leaving alone"
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
    log_ok "wrote $SETTINGS"
fi

# Persist everything `pi` needs into the shell rc, so a single
# `source ~/.bashrc` in the invoking shell (and nothing at all in new
# terminals) makes the pi command work.
shell_rc=""
case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    *)      shell_rc="$HOME/.bashrc" ;;
esac
[ -f "$shell_rc" ] || touch "$shell_rc"

# nvm-managed Node puts pi in ~/.nvm/versions/node/*/bin — invisible to any
# shell that hasn't run the nvm init lines. nvm's own installer appends them,
# but a PRE-EXISTING nvm (or a stripped rc) may lack them; without this,
# `source ~/.bashrc` wouldn't surface `pi` and the summary below would lie.
if [ -s "$HOME/.nvm/nvm.sh" ] && [[ "$(command -v node 2>/dev/null)" == "$HOME/.nvm/"* ]]; then
    if ! grep -q 'NVM_DIR' "$shell_rc"; then
        {
            printf '\n# Added by pi-install (Node is nvm-managed; pi lives in the nvm bin dir)\n'
            printf 'export NVM_DIR="$HOME/.nvm"\n'
            printf '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"\n'
        } >> "$shell_rc"
        log_ok "appended nvm init to $shell_rc (puts pi on PATH for new shells)"
    else
        log_ok "$shell_rc already initializes nvm"
    fi
fi

if ! grep -q 'MODELSERVER_BASE_URL' "$shell_rc"; then
    {
        printf '\n# Added by pi-install for the modelserver Pi extension\n'
        printf 'export MODELSERVER_BASE_URL=%q\n' "$BASE_URL"
        printf '# Set MODELSERVER_API_KEY to your bearer-mode API key (created in the API Keys tab):\n'
        printf '# export MODELSERVER_API_KEY="..."\n'
    } >> "$shell_rc"
    log_ok "appended MODELSERVER_BASE_URL to $shell_rc"
fi

# ---------- verification ----------
section "Install complete"
say "Node:       ${c_green}$(node -v 2>/dev/null || echo MISSING)${c_off}"
say "Pi:         ${c_green}${pi_ver:-$(pi --version 2>/dev/null || echo MISSING)}${c_off}"
say "Extension:  $EXT_DIR"
say "Settings:   $SETTINGS"
say "Base URL:   $BASE_URL"
echo ""
# This script runs in a child bash (curl | bash) — it CANNOT export vars or
# PATH into the shell that invoked it. Everything needed is now in $shell_rc,
# so one source in the user's shell activates it; new terminals need nothing.
say "Activate in THIS shell, then run pi:"
say "  ${c_cyan}source $shell_rc${c_off}"
if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    say "  ${c_cyan}export MODELSERVER_API_KEY=\"<your-bearer-key>\"${c_off}  ${c_dim}# API Keys tab (bearer mode)${c_off}"
fi
say "  ${c_cyan}pi${c_off}"
echo ""
say "${c_dim}(new terminals pick everything up from $shell_rc automatically)${c_off}"
echo ""
