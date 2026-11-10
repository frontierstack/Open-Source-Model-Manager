#!/usr/bin/env bash
# omp (https://omp.sh — oh-my-pi) one-shot installer for the model server.
#
# Installs:
#   1. the omp CLI — the official PREBUILT binary into ~/.local/bin (a single
#      self-contained executable: no Node, npm or Bun needed);
#   2. the modelserver extension into ~/.omp/agent/extensions/modelserver/
#      (TypeScript loaded by omp itself — no npm install, no node_modules);
#   3. ~/.omp/agent/config.yml defaults: the model server's models as the
#      default / smol / slow roles, and omp's local-server auto-discovery
#      (ollama / llama.cpp / LM Studio on 127.0.0.1) switched off;
#   4. MODELSERVER_BASE_URL + PATH in your shell rc.
#
# Idempotent: re-running upgrades the extension, keeps a current omp, and
# leaves a config.yml that points somewhere else alone.
#
# Usage:
#   export MODELSERVER_API_KEY="<your-bearer-key>"
#   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
#     <BASE_URL>/api/omp/install | bash && source ~/.bashrc
#
# The trailing `source ~/.bashrc` matters: this script runs in a CHILD bash
# (curl | bash) and cannot modify the shell you invoked it from.
#
# Env:
#   OMP_INSTALL_NO_SPINNER=1   disable the progress spinner (CI / log capture)
#   OMP_INSTALL_REF=v18.14.1   install a specific omp release instead of latest
#   OMP_INSTALL_FORCE=1        reinstall omp even when one is already present
#   OMP_INSTALL_REMOVE_PI=1    also uninstall an old Pi (pi.dev) CLI + its
#                              modelserver extension (replaced by omp)
#   PI_INSTALL_DIR             omp's own installer: where the binary goes
#                              (default ~/.local/bin)
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/omp/install.

# Don't `set -e` — we rely on individual step checks to keep going.
set -u

BASE_URL_DEFAULT="__MODELSERVER_BASE_URL__"
BASE_URL="${MODELSERVER_BASE_URL:-$BASE_URL_DEFAULT}"
BASE_URL="${BASE_URL%/}"
OMP_BIN_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EXT_DIR="$AGENT_DIR/extensions/modelserver"
CONFIG="$AGENT_DIR/config.yml"
# Oldest omp this extension is tested against (TypeBox shim, array system
# prompts, getBranch session entries, session_before_compact preparation).
OMP_MIN_VERSION="18.18.6"

# ---------- terminal output helpers ----------
c_red=$'\033[0;31m'; c_green=$'\033[0;32m'; c_yellow=$'\033[1;33m'
c_cyan=$'\033[0;36m'; c_dim=$'\033[2m'; c_bold=$'\033[1m'; c_off=$'\033[0m'

SYM_OK="${c_green}✓${c_off}"
SYM_FAIL="${c_red}✗${c_off}"
SYM_WARN="${c_yellow}!${c_off}"
SYM_ARROW="${c_cyan}→${c_off}"

SPINNER_PID=""
spinner_enabled() { [ -t 1 ] && [ -z "${OMP_INSTALL_NO_SPINNER:-${PI_INSTALL_NO_SPINNER:-}}" ]; }
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
    return 0
}
trap stop_spinner EXIT INT TERM

say()      { printf "  %b\n" "$*"; }
log_ok()   { stop_spinner; printf "  %b  %s\n" "$SYM_OK" "$*"; }
log_step() { stop_spinner; printf "  %b  %s\n" "$SYM_ARROW" "$*"; }
log_warn() { stop_spinner; printf "  %b  %b%s%b\n" "$SYM_WARN" "$c_yellow" "$*" "$c_off" >&2; }
log_err()  { stop_spinner; printf "  %b  %b%s%b\n" "$SYM_FAIL" "$c_red"    "$*" "$c_off" >&2; }

section() {
    stop_spinner
    local t="$1" n _lc="${LC_ALL-}"
    LC_ALL=C.UTF-8 2>/dev/null || true
    n=${#t}
    if [ -n "$_lc" ]; then LC_ALL="$_lc"; else unset LC_ALL 2>/dev/null || LC_ALL=""; fi
    echo ""
    printf "  %b%s%b\n" "${c_bold}${c_cyan}" "$t" "$c_off"
    printf "  %b%s%b\n" "$c_dim" "$(printf '%.0s─' $(seq 1 "$n"))" "$c_off"
}

have() { command -v "$1" >/dev/null 2>&1; }

# a >= b for dotted versions (x.y.z, pre-release suffix ignored)
version_ge() {
    local a="${1%%-*}" b="${2%%-*}" i x y
    for i in 1 2 3; do
        x="$(printf '%s' "$a" | cut -d. -f$i)"; y="$(printf '%s' "$b" | cut -d. -f$i)"
        x="${x:-0}"; y="${y:-0}"
        [ "$x" -gt "$y" ] 2>/dev/null && return 0
        [ "$x" -lt "$y" ] 2>/dev/null && return 1
    done
    return 0
}

authed_get() {  # authed_get <path> [curl args…]
    local p="$1"; shift
    curl -fsSk --connect-timeout 10 -H "Authorization: Bearer $MODELSERVER_API_KEY" "$BASE_URL$p" "$@"
}

# ---------- banner ----------
echo ""
printf "  %bomp (oh-my-pi) installer%b\n" "$c_bold" "$c_off"
printf "  %b%s · %s%b\n" "$c_dim" "$BASE_URL" "$(date '+%Y-%m-%d %H:%M:%S')" "$c_off"

if [ -z "${MODELSERVER_API_KEY:-}" ]; then
    log_err "MODELSERVER_API_KEY is not set. Re-run with:"
    log_err "    export MODELSERVER_API_KEY=<your-bearer-key>"
    log_err "    curl -fsSk -H \"Authorization: Bearer \$MODELSERVER_API_KEY\" \\"
    log_err "        $BASE_URL/api/omp/install | bash && source ~/.bashrc"
    exit 1
fi

# ---------- step 1: TLS + tools ----------
section "1/5 · TLS / prerequisites"
# A self-signed model server (or a corporate TLS-inspecting proxy) fails every
# curl below and inside omp's own installer. ~/.curlrc is read by both.
if ! [ -f "$HOME/.curlrc" ] || ! grep -qE '^[[:space:]]*insecure' "$HOME/.curlrc" 2>/dev/null; then
    printf "insecure\n" >> "$HOME/.curlrc"
    log_ok "appended 'insecure' to ~/.curlrc"
else
    log_ok "~/.curlrc already has 'insecure'"
fi
missing=""
for t in curl uname sha256sum; do
    if ! have "$t"; then
        [ "$t" = sha256sum ] && have shasum && continue
        missing="$missing $t"
    fi
done
if [ -n "$missing" ]; then
    log_err "missing required tool(s):$missing — install them and re-run."
    exit 1
fi
log_ok "curl $(curl --version | head -1 | cut -d' ' -f2), $(uname -s) $(uname -m)"

# Reach the server before installing anything: a wrong URL or key would
# otherwise surface only as an omp with no models.
http_code="$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 10 \
    -H "Authorization: Bearer $MODELSERVER_API_KEY" "$BASE_URL/v1/models" 2>/dev/null || echo 000)"
case "$http_code" in
    200) log_ok "model server reachable, key accepted" ;;
    401|403) log_err "the server rejected MODELSERVER_API_KEY (HTTP $http_code) — use a BEARER-mode key from the API Keys tab."; exit 1 ;;
    000) log_err "cannot reach $BASE_URL — check MODELSERVER_BASE_URL / the network."; exit 1 ;;
    *) log_warn "GET /v1/models answered HTTP $http_code (no model loaded?) — continuing." ;;
esac

# ---------- step 2: omp CLI ----------
section "2/5 · omp CLI"
export PATH="$OMP_BIN_DIR:$PATH"
omp_ver=""
if have omp; then omp_ver="$(omp --version 2>/dev/null | sed -n 's#^omp/##p' | head -1)"; fi
want_ref="${OMP_INSTALL_REF:-}"
if [ -n "$omp_ver" ] && [ -z "${OMP_INSTALL_FORCE:-}" ] && [ -z "$want_ref" ] && version_ge "$omp_ver" "$OMP_MIN_VERSION"; then
    log_ok "omp $omp_ver already installed ($(command -v omp))"
else
    [ -n "$omp_ver" ] && log_step "omp $omp_ver present — installing ${want_ref:-the latest release}"
    OMP_LOG="$(mktemp -t omp-install.XXXXXX 2>/dev/null || echo /tmp/omp-install.log)"
    installer="$(mktemp -t omp-installer.XXXXXX 2>/dev/null || echo /tmp/omp-installer.sh)"
    start_spinner "downloading omp (prebuilt binary, ~270 MB)"
    ok=0
    if curl -fsSL --connect-timeout 15 https://omp.sh/install -o "$installer" >>"$OMP_LOG" 2>&1; then
        # --binary: never route through a local bun/source build — the
        # prebuilt is checksum-verified and needs no toolchain.
        if [ -n "$want_ref" ]; then
            sh "$installer" --binary --ref "$want_ref" >>"$OMP_LOG" 2>&1 && ok=1
        else
            sh "$installer" --binary >>"$OMP_LOG" 2>&1 && ok=1
        fi
    fi
    stop_spinner
    rm -f "$installer"
    if [ "$ok" = 1 ] && [ -x "$OMP_BIN_DIR/omp" ]; then
        omp_ver="$("$OMP_BIN_DIR/omp" --version 2>/dev/null | sed -n 's#^omp/##p' | head -1)"
        log_ok "installed omp ${omp_ver:-?} → $OMP_BIN_DIR/omp"
        rm -f "$OMP_LOG" 2>/dev/null || true
    else
        log_err "the omp installer failed. Last lines:"
        tail -n 15 "$OMP_LOG" 2>/dev/null | sed 's/^/      /' >&2
        log_err "Full log: $OMP_LOG   (manual install: curl -fsSL https://omp.sh/install | sh)"
        if [ -z "$omp_ver" ]; then exit 1; fi
        log_warn "continuing with the existing omp $omp_ver"
    fi
fi

# ---------- step 3: the modelserver extension ----------
section "3/5 · modelserver extension"
say "${c_dim}$EXT_DIR${c_off}"
mkdir -p "$EXT_DIR"
for f in modelserver.ts package.json; do
    if ! authed_get "/api/omp/extension/$f" -o "$EXT_DIR/$f.tmp"; then
        rm -f "$EXT_DIR/$f.tmp"
        log_err "failed to download $f from $BASE_URL/api/omp/extension/$f"
        exit 1
    fi
    mv -f "$EXT_DIR/$f.tmp" "$EXT_DIR/$f"
done
# A Pi-era install left node_modules + a lockfile here; omp needs neither.
rm -rf "$EXT_DIR/node_modules" "$EXT_DIR/package-lock.json" 2>/dev/null || true
log_ok "extension files installed (no dependencies to fetch — omp bundles them)"

# ---------- step 4: config.yml ----------
section "4/5 · omp config"
mkdir -p "$AGENT_DIR"
# Model ids as the extension registers them: llama.cpp's /models/<name>/<file>
# path → <name>; sglang HF repo ids pass through.
models_json="$(authed_get /v1/models 2>/dev/null || true)"
model_ids="$(printf '%s' "$models_json" | grep -o '"id":"[^"]*"' | sed 's/"id":"//; s/"$//' \
    | sed -E 's#^/models/([^/]+)/.*#\1#' | grep -vx 'auto' || true)"
pair_json="$(authed_get /api/omp/pair 2>/dev/null || true)"
json_field() { printf '%s' "$pair_json" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/\"$1\":\"//; s/\"\$//"; }
fast="$(json_field primary)"; strong="$(json_field secondary)"
first_model="$(printf '%s\n' "$model_ids" | head -1)"
[ -n "$fast" ] || fast="$first_model"
[ -n "$strong" ] || strong="$fast"

current_default=""
if [ -f "$CONFIG" ]; then
    current_default="$(sed -n '/^modelRoles:/,/^[^[:space:]]/{s/^[[:space:]]*default:[[:space:]]*//p}' "$CONFIG" | head -1 | tr -d '"'"'")"
fi
if [ -z "$fast" ]; then
    log_warn "no model is loaded on the server — load one, then re-run (or pick it with /model inside omp)"
elif [ -n "$current_default" ] && [ "${current_default#modelserver/}" = "$current_default" ]; then
    log_ok "config.yml already defaults to $current_default — left alone (choose modelserver models with /model)"
else
    # default = the everyday (fast) model: the server moves substantial tasks
    # to the stronger model itself when two models are paired. smol is what
    # omp uses for titles/commit messages; slow is the strong model.
    roles="{\"default\":\"modelserver/$fast\",\"smol\":\"modelserver/$fast\",\"slow\":\"modelserver/$strong\"}"
    if omp config set modelRoles "$roles" >/dev/null 2>&1; then
        log_ok "modelRoles: default/smol → $fast, slow → $strong"
    else
        log_warn "could not write modelRoles with 'omp config set' — pick the model with /model inside omp"
    fi
fi
# omp probes ollama / llama.cpp / LM Studio on 127.0.0.1 at every start; on a
# machine that only talks to the model server those probes are pure delay.
if ! grep -q '^disabledProviders:' "$CONFIG" 2>/dev/null; then
    if omp config set disabledProviders '["ollama","llama.cpp","lm-studio"]' >/dev/null 2>&1; then
        log_ok "local-server auto-discovery off (ollama, llama.cpp, lm-studio)"
    fi
else
    log_ok "disabledProviders already set — left alone"
fi
say "${c_dim}$CONFIG${c_off}"

# ---------- step 5: shell rc ----------
section "5/5 · shell rc"
shell_rc=""
case "${SHELL:-/bin/bash}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    *)      shell_rc="$HOME/.bashrc" ;;
esac
[ -f "$shell_rc" ] || touch "$shell_rc"
if ! grep -q "omp-install: PATH" "$shell_rc"; then
    {
        printf '\n# omp-install: PATH (omp binary)\n'
        printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$OMP_BIN_DIR" "$OMP_BIN_DIR"
    } >> "$shell_rc"
    log_ok "added $OMP_BIN_DIR to PATH in $shell_rc"
fi
if grep -q '^export MODELSERVER_BASE_URL=' "$shell_rc"; then
    sed -i.bak "s#^export MODELSERVER_BASE_URL=.*#export MODELSERVER_BASE_URL=$(printf '%q' "$BASE_URL")#" "$shell_rc" && rm -f "$shell_rc.bak"
    log_ok "MODELSERVER_BASE_URL in $shell_rc → $BASE_URL"
else
    {
        printf '\n# omp-install: model server for the modelserver omp extension\n'
        printf 'export MODELSERVER_BASE_URL=%q\n' "$BASE_URL"
        printf '# Set MODELSERVER_API_KEY to your bearer-mode API key (created in the API Keys tab):\n'
        printf '# export MODELSERVER_API_KEY="..."\n'
    } >> "$shell_rc"
    log_ok "appended MODELSERVER_BASE_URL to $shell_rc"
fi

# ---------- old Pi (pi.dev) ----------
if [ -d "$HOME/.pi/agent/extensions/modelserver" ] || have pi; then
    if [ -n "${OMP_INSTALL_REMOVE_PI:-}" ]; then
        rm -rf "$HOME/.pi/agent/extensions/modelserver"
        if have pi && have npm; then npm uninstall -g @earendil-works/pi-coding-agent >/dev/null 2>&1 || true; fi
        log_ok "removed the old Pi CLI / modelserver Pi extension"
    else
        log_warn "an old Pi (pi.dev) install is still here — omp replaces it. Remove it with:"
        log_warn "    npm uninstall -g @earendil-works/pi-coding-agent && rm -rf ~/.pi/agent/extensions/modelserver"
        log_warn "  (or re-run this installer with OMP_INSTALL_REMOVE_PI=1)"
    fi
fi

# ---------- verification ----------
section "Install complete"
say "omp:        ${c_green}${omp_ver:-MISSING}${c_off}  ${c_dim}($OMP_BIN_DIR/omp)${c_off}"
say "Extension:  $EXT_DIR"
say "Config:     $CONFIG"
say "Base URL:   $BASE_URL"
n_models="$(printf '%s\n' "$model_ids" | grep -c . || true)"
say "Models:     ${n_models:-0} on the server${fast:+ — default modelserver/$fast}"

pair_summary="unknown (could not reach the server)"
if [ -n "$pair_json" ]; then
    if printf '%s' "$pair_json" | grep -q '"enabled":true'; then
        pair_summary="ACTIVE - $(json_field secondary) leads, $(json_field primary) assists (mode $(json_field mode))"
    else
        detail="$(json_field detail)"
        pair_summary="NOT ACTIVE - ${detail:-pairing is off}"
    fi
fi
case "$pair_summary" in
    ACTIVE*)       say "Two models: ${c_green}${pair_summary}${c_off}" ;;
    "NOT ACTIVE"*) say "Two models: ${c_yellow}${pair_summary}${c_off}" ;;
    *)             say "Two models: ${c_dim}${pair_summary}${c_off}" ;;
esac
echo ""
say "Activate in THIS shell, then run omp:"
say "  ${c_cyan}source $shell_rc${c_off}"
say "  ${c_cyan}export MODELSERVER_API_KEY=\"<your-bearer-key>\"${c_off}  ${c_dim}# if not already in your environment${c_off}"
say "  ${c_cyan}omp${c_off}            ${c_dim}# or: omp -p \"Reply with OK\"  for a one-shot check${c_off}"
echo ""
