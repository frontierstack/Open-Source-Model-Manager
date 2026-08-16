#!/bin/bash
# WSL LAN Exposure
# ----------------
# Makes the Model Server (webapp :3001, chat :3002) reachable from OTHER
# machines on the LAN when the stack runs inside WSL2 on Windows.
#
# Why this is needed: WSL2's default networking mode is NAT. The containers
# publish on 0.0.0.0 *inside the WSL VM*, and Windows forwards only
# `localhost` into that VM — so the site works at https://localhost:3001 on
# the Windows box itself and is invisible to every other machine on the LAN.
#
# Two fixes exist:
#   NAT      -> Windows `netsh interface portproxy` rules + an inbound
#               firewall rule. Works today, but the WSL VM's IP changes on
#               every `wsl --shutdown`, which silently breaks the forwards.
#   mirrored -> WSL >= 2.0.0 `networkingMode=mirrored` in %USERPROFILE%\.wslconfig.
#               The VM shares the Windows network stack, so LAN access needs
#               nothing but a firewall allow. This is the durable fix.
#
# This script detects which mode you are in, does the right thing, and is
# safe to re-run. It never edits any other project script.
#
# Testing aid: set MODELSERVER_FAKE_WSL=1 to make the WSL detection pass on a
# non-WSL box. It ONLY affects detection — every Windows-side command still
# has to find powershell.exe/netsh.exe, so on plain Linux the script degrades
# to printing what it would do. Harmless, and used by --dry-run reviews.

# Deliberately NOT `set -e`: several Windows calls (netsh delete with no rule,
# powershell.exe when interop is off) exit non-zero as normal operation.
set -uo pipefail

SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Shared helpers (ms_is_wsl / ms_windows_lan_ip / ms_wsl_networking_mode ...).
# Optional: this script stays self-contained if the lib is absent.
if [ -r "$SCRIPT_DIR/lib/netaccess.sh" ]; then
    # shellcheck source=lib/netaccess.sh
    . "$SCRIPT_DIR/lib/netaccess.sh"
fi

# sudo's secure_path drops the Windows interop directories from PATH, so a
# `sudo ./wsl-expose.sh` would lose powershell.exe/netsh.exe and fall back to
# "interop unavailable". Put the standard Windows dirs back if they exist.
if ! command -v powershell.exe >/dev/null 2>&1; then
    for _wd in /mnt/c/Windows/System32 \
               /mnt/c/Windows/System32/WindowsPowerShell/v1.0 \
               /mnt/c/Windows; do
        [ -d "$_wd" ] && case ":$PATH:" in *":$_wd:"*) ;; *) PATH="$PATH:$_wd" ;; esac
    done
    export PATH
    unset _wd
fi

# ============================================================================
# TERMINAL OUTPUT HELPERS  (mirrors build.sh / wsl-setup.sh styling)
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
# ARGUMENTS
# ============================================================================

MODE=setup                 # setup | status | undo | mirrored
DRY_RUN=false
WITH_HTTP_REDIRECT=false
ALLOW_PUBLIC=false
PORTS_OVERRIDE=""
RULE_NAME="ModelServer (WSL)"
# Mirrored mode: firewall rule ONLY. Never portproxy — in mirrored networking the
# WSL IP *is* the Windows IP, so 0.0.0.0:p -> sameIP:p forwards a port to itself.
PS_FIREWALL_ONLY=false
PS_HEADLINE="WSL port forwarding"

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Makes the Model Server reachable from other machines on your LAN when it runs
inside WSL2. Detects WSL's networking mode and applies the right fix.

Actions (default: set up forwarding):
  --status              Show current WSL IP, existing portproxy entries, the
                        firewall rule, and flag stale entries. Changes nothing.
  --undo                Remove the portproxy entries and the firewall rule.
  --use-mirrored        Write networkingMode=mirrored into %USERPROFILE%\\.wslconfig
                        (backs up + preserves existing keys), then tell you to
                        run 'wsl --shutdown'. The durable fix — after this, no
                        portproxy is needed and the WSL IP no longer matters.

Options:
  --ports 3001,3002     Ports to forward/allow (default: 3001,3002)
  --with-http-redirect  Also forward 3080 (the webapp's plain-HTTP -> HTTPS
                        redirect). Off by default; HTTPS is the real entrypoint.
  --allow-public        Include the Windows "Public" firewall profile. Off by
                        default (Private,Domain only) — use it only if Windows
                        has classified your network as Public.
  --dry-run             Print every command and the generated PowerShell
                        without running or changing anything.
  -h, --help            Show this help

Environment overrides (testing / unusual setups):
  MODELSERVER_FAKE_WSL=1     Force the WSL detection to pass (used to review
                             --dry-run output on a non-WSL box). Detection only.
  MODELSERVER_WSLCONFIG=path Use this .wslconfig instead of the auto-detected
                             %USERPROFILE%\.wslconfig.

Notes:
  * The Windows-side changes need Administrator rights. The script launches an
    elevated PowerShell for you; Windows will show a UAC prompt — accept it.
  * In NAT mode the WSL VM's IP changes on every 'wsl --shutdown', which
    silently breaks the forwards. Re-run this script after a restart, or
    switch to mirrored networking with --use-mirrored.
  * The server's certificate is self-signed, so the browser warning on
    https://<lan-ip>:3001 is expected.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --status)             MODE=status;             shift ;;
        --undo)               MODE=undo;               shift ;;
        --use-mirrored)       MODE=mirrored;           shift ;;
        --dry-run)            DRY_RUN=true;            shift ;;
        --with-http-redirect) WITH_HTTP_REDIRECT=true; shift ;;
        --allow-public)       ALLOW_PUBLIC=true;       shift ;;
        --ports)
            PORTS_OVERRIDE="${2:-}"
            if [ -z "$PORTS_OVERRIDE" ]; then
                echo "  --ports needs a value, e.g. --ports 3001,3002" >&2
                exit 1
            fi
            shift 2 ;;
        --ports=*)            PORTS_OVERRIDE="${1#*=}"; shift ;;
        -h|--help)            usage; exit 0 ;;
        *)
            echo "  Unknown option: $1" >&2
            echo "  Try: $0 --help" >&2
            exit 1 ;;
    esac
done

# ---- port list ------------------------------------------------------------
PORTS=()
if [ -n "$PORTS_OVERRIDE" ]; then
    IFS=',' read -r -a PORTS <<< "$(echo "$PORTS_OVERRIDE" | tr -d ' ')"
else
    PORTS=(3001 3002)
    [ "$WITH_HTTP_REDIRECT" = true ] && PORTS+=(3080)
fi
for p in "${PORTS[@]}"; do
    if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
        echo "  Invalid port: '$p'" >&2
        exit 1
    fi
done
PORTS_CSV="$(IFS=,; echo "${PORTS[*]}")"

if [ "$ALLOW_PUBLIC" = true ]; then
    FW_PROFILES="Private,Domain,Public"
else
    FW_PROFILES="Private,Domain"
fi

echo ""
echo -e "  ${BOLD}Model Server — WSL LAN Exposure${NC}"
echo -e "  ${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"

# ============================================================================
# WSL DETECTION
# ============================================================================

is_wsl() {
    if declare -F ms_is_wsl >/dev/null 2>&1; then ms_is_wsl; return $?; fi
    [ "${MODELSERVER_FAKE_WSL:-0}" = "1" ] && return 0
    grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && return 0
    grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && return 0
    return 1
}

if ! is_wsl; then
    section "Environment"
    log_info "Not running under WSL — nothing to do."
    echo ""
    echo "  This script only exists to work around WSL2's NAT networking, which"
    echo "  hides published container ports from the rest of the LAN."
    echo ""
    echo "  On a normal Linux host the containers already listen on 0.0.0.0, so"
    echo "  other machines can reach them directly at:"
    echo ""
    lan_guess="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -z "$lan_guess" ] && lan_guess="<this-host-ip>"
    echo -e "       ${CYAN}https://${lan_guess}:3001${NC}   (webapp)"
    echo -e "       ${CYAN}https://${lan_guess}:3002${NC}   (chat UI)"
    echo ""
    echo -e "  ${DIM}If they are not reachable, check the host firewall (ufw/firewalld),${NC}"
    echo -e "  ${DIM}not this script.${NC}"
    echo ""
    exit 0
fi
log_success "Running inside WSL"

# ============================================================================
# WINDOWS INTEROP HELPERS
#   Every value read back from a Windows command MUST be stripped of CR.
# ============================================================================

HAVE_PWSH=false
HAVE_NETSH=false
command -v powershell.exe >/dev/null 2>&1 && HAVE_PWSH=true
command -v netsh.exe      >/dev/null 2>&1 && HAVE_NETSH=true

# ps_out <powershell-expression>  -> stdout, CR-stripped, trailing blank lines gone
ps_out() {
    [ "$HAVE_PWSH" = true ] || return 1
    powershell.exe -NoProfile -NonInteractive -Command "$1" 2>/dev/null \
        | tr -d '\r' | sed -e 's/[[:space:]]*$//' -e '/^$/d'
}

interop_warning() {
    log_warning "Windows interop is unavailable (powershell.exe not on PATH)."
    log_info    "WSL interop may be disabled in /etc/wsl.conf ([interop] enabled=false)"
    log_info    "or PATH appending is off. Re-enable it, or run the printed commands"
    log_info    "yourself in an elevated PowerShell on Windows."
}

# ---- current WSL VM IP ----------------------------------------------------
wsl_ip() {
    local ip
    ip="$(ip -4 -o addr show dev eth0 scope global 2>/dev/null \
            | awk '{print $4}' | cut -d/ -f1 | head -1)"
    if [ -z "$ip" ]; then
        ip="$(ip -4 -o addr show scope global 2>/dev/null \
                | awk '{print $4}' | cut -d/ -f1 | head -1)"
    fi
    [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "$ip"
}

# ---- Windows LAN IP (the address other machines should use) ---------------
win_lan_ip() {
    local ip=""
    if declare -F ms_windows_lan_ip >/dev/null 2>&1; then
        ip="$(ms_windows_lan_ip 2>/dev/null | tr -d '\r' | head -1)"
    fi
    if [ -z "$ip" ] && [ "$HAVE_PWSH" = true ]; then
        ip="$(ps_out '(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1).IPv4Address.IPAddress' | head -1)"
    fi
    if [ -z "$ip" ] && command -v ipconfig.exe >/dev/null 2>&1; then
        # Fallback: first non-WSL IPv4 in ipconfig output
        ip="$(ipconfig.exe 2>/dev/null | tr -d '\r' \
                | grep -iE 'IPv4 Address' | awk -F: '{print $2}' \
                | tr -d ' ' | grep -vE '^(127\.|169\.254\.)' | head -1)"
    fi
    echo "$ip"
}

# ---- Windows %USERPROFILE% as a Linux path --------------------------------
win_userprofile_linux() {
    local up=""
    if [ "$HAVE_PWSH" = true ]; then
        up="$(ps_out '$env:USERPROFILE' | head -1)"
    fi
    if [ -z "$up" ] && command -v cmd.exe >/dev/null 2>&1; then
        up="$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' | head -1)"
    fi
    [ -z "$up" ] && return 1
    wslpath -u "$up" 2>/dev/null
}

# ---- Windows %TEMP% -------------------------------------------------------
# Returns "<linux-path>|<windows-path>"
win_temp_paths() {
    local wt lt
    if [ "$HAVE_PWSH" = true ]; then
        wt="$(ps_out '$env:TEMP' | head -1)"
    fi
    [ -z "${wt:-}" ] && return 1
    lt="$(wslpath -u "$wt" 2>/dev/null)"
    [ -z "$lt" ] && return 1
    echo "${lt}|${wt}"
}

WSL_IP="$(wsl_ip)"

# ============================================================================
# NETWORKING-MODE DETECTION
# ============================================================================

# MODELSERVER_WSLCONFIG overrides the auto-detected path (odd profile
# locations, and used by the test runs on non-WSL boxes).
WSLCONFIG_LINUX="${MODELSERVER_WSLCONFIG:-}"
if [ -z "$WSLCONFIG_LINUX" ] && wp="$(win_userprofile_linux)"; then
    WSLCONFIG_LINUX="${wp}/.wslconfig"
fi

wslconfig_says_mirrored() {
    [ -n "$WSLCONFIG_LINUX" ] && [ -f "$WSLCONFIG_LINUX" ] || return 1
    tr -d '\r' < "$WSLCONFIG_LINUX" \
        | grep -qiE '^[[:space:]]*networkingMode[[:space:]]*=[[:space:]]*mirrored[[:space:]]*$'
}

# In mirrored mode the WSL interface holds the SAME IPv4 as the Windows LAN
# adapter — a reliable heuristic that needs no config file at all.
ips_match_windows() {
    local wip="$1"
    [ -n "$wip" ] || return 1
    ip -4 -o addr show scope global 2>/dev/null \
        | awk '{print $4}' | cut -d/ -f1 | grep -qx "$wip"
}

WIN_LAN_IP="$(win_lan_ip)"

NET_MODE="nat"
NET_MODE_SOURCE="default (no mirrored evidence)"
if wslconfig_says_mirrored; then
    NET_MODE="mirrored"
    NET_MODE_SOURCE=".wslconfig networkingMode=mirrored"
elif ips_match_windows "$WIN_LAN_IP"; then
    NET_MODE="mirrored"
    NET_MODE_SOURCE="WSL interface shares the Windows LAN IP ($WIN_LAN_IP)"
fi

# ============================================================================
# POWERSHELL GENERATION
# ============================================================================

# ps_ports_literal -> "@(3001,3002)"
ps_ports_literal() {
    local joined
    joined="$(IFS=,; echo "${PORTS[*]}")"
    echo "@(${joined})"
}

# generate_setup_ps1 <outfile>
generate_setup_ps1() {
    local out="$1"
    local PS_CLOSING_NOTE
    if [ "$PS_FIREWALL_ONLY" = true ]; then
        PS_CLOSING_NOTE="Write-Host '  Mirrored networking: no portproxy needed, and the address does not' -ForegroundColor Green
Write-Host '  change when WSL restarts.'"
    else
        PS_CLOSING_NOTE="Write-Host '  NOTE: the WSL VM IP changes on every \"wsl --shutdown\".' -ForegroundColor Yellow
Write-Host '        Re-run ./wsl-expose.sh inside WSL after a restart, or switch'
Write-Host '        to mirrored networking (./wsl-expose.sh --use-mirrored).'"
    fi
    cat > "$out" <<EOF
# ---------------------------------------------------------------------------
# Model Server - expose WSL2 ports to the LAN   (generated $(date '+%Y-%m-%d %H:%M:%S'))
# Idempotent: deletes any existing rules for these ports, then re-adds them.
# Regenerate by re-running  ./wsl-expose.sh  inside WSL.
# ---------------------------------------------------------------------------
\$ErrorActionPreference = 'Continue'

\$ports    = $(ps_ports_literal)
\$wslIp    = '${WSL_IP}'
\$ruleName = '${RULE_NAME}'

Write-Host ''
Write-Host '  Model Server - ${PS_HEADLINE}' -ForegroundColor Cyan
Write-Host ('  WSL VM IP: {0}' -f \$wslIp)
Write-Host ('  Ports    : {0}' -f (\$ports -join ', '))
Write-Host ''

# Must be elevated (netsh portproxy + firewall both require it)
\$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not \$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '  This window is NOT running as Administrator.' -ForegroundColor Red
    Write-Host '  Re-open PowerShell with "Run as administrator" and run this file again:'
    Write-Host ('    powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f \$PSCommandPath)
    Read-Host '  Press Enter to close'
    exit 1
}

EOF

    if [ "$PS_FIREWALL_ONLY" = true ]; then
        cat >> "$out" <<EOF
# --- portproxy: NOT USED in mirrored networking ----------------------------
# The WSL VM shares the Windows network stack, so its IP IS the Windows IP;
# a portproxy would forward each port to itself. Any leftover entries from a
# previous NAT-mode run are removed here.
foreach (\$p in \$ports) {
    Write-Host ('  [portproxy] mirrored mode - clearing any leftover entry for port {0}' -f \$p)
    & netsh.exe interface portproxy delete v4tov4 listenport=\$p listenaddress=0.0.0.0 2>&1 | Out-Null
}

# --- WSL's own Hyper-V firewall -------------------------------------------
# In mirrored mode inbound traffic is ALSO gated by the Hyper-V firewall of the
# WSL VM, independently of the normal Windows firewall rule below. Without this
# the LAN still cannot connect even though everything else looks right.
# The GUID is the fixed WSL VM creator id; the cmdlet only exists on
# Windows 11 22H2+ / WSL 2.0.0+, hence -ErrorAction SilentlyContinue.
Write-Host '  [hyper-v]   allowing inbound to the WSL VM firewall'
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' \`
    -DefaultInboundAction Allow -ErrorAction SilentlyContinue
if (-not \$?) {
    Write-Host '    (Set-NetFirewallHyperVVMSetting unavailable - needs Windows 11 22H2+ / WSL 2.0.0+)' -ForegroundColor Yellow
}
EOF
    else
        cat >> "$out" <<EOF
# --- IP Helper -------------------------------------------------------------
# netsh portproxy is implemented by the "IP Helper" service (iphlpsvc). When it
# is disabled the rules are accepted and stored but nothing is ever forwarded —
# the failure is completely silent, which is the worst possible way to debug
# "the port is open but I can't connect".
\$svc = Get-Service -Name iphlpsvc -ErrorAction SilentlyContinue
if (\$svc -and \$svc.Status -ne 'Running') {
    Write-Host '  [iphlpsvc]  IP Helper is stopped — portproxy cannot work without it; starting'
    if (\$svc.StartType -eq 'Disabled') { Set-Service -Name iphlpsvc -StartupType Manual -ErrorAction SilentlyContinue }
    Start-Service -Name iphlpsvc -ErrorAction SilentlyContinue
    if ((Get-Service -Name iphlpsvc).Status -ne 'Running') {
        Write-Host '    could not start IP Helper — port forwarding will not work until it runs' -ForegroundColor Red
    } else {
        Write-Host '    IP Helper started' -ForegroundColor Green
    }
}

# --- portproxy -------------------------------------------------------------
foreach (\$p in \$ports) {
    Write-Host ('  [portproxy] port {0}' -f \$p)
    # Delete first so re-runs cannot stack duplicates. A missing rule makes
    # netsh return non-zero; that is expected and ignored.
    & netsh.exe interface portproxy delete v4tov4 listenport=\$p listenaddress=0.0.0.0 2>&1 | Out-Null
    & netsh.exe interface portproxy add v4tov4 listenport=\$p listenaddress=0.0.0.0 connectport=\$p connectaddress=\$wslIp 2>&1 | Out-Null
    if (\$LASTEXITCODE -ne 0) {
        Write-Host ('    failed to add portproxy for port {0} (netsh exit {1})' -f \$p, \$LASTEXITCODE) -ForegroundColor Red
    }
}
EOF
    fi

    cat >> "$out" <<EOF

# --- firewall --------------------------------------------------------------
Write-Host ('  [firewall]  rule "{0}" -> TCP {1} (profiles: ${FW_PROFILES})' -f \$ruleName, (\$ports -join ','))
Remove-NetFirewallRule -DisplayName \$ruleName -ErrorAction SilentlyContinue
try {
    New-NetFirewallRule -DisplayName \$ruleName \`
        -Description 'Inbound access to the Model Server running in WSL2' \`
        -Direction Inbound -Action Allow -Protocol TCP \`
        -LocalPort \$ports -Profile ${FW_PROFILES} -Enabled True | Out-Null
    Write-Host '    firewall rule created' -ForegroundColor Green
} catch {
    Write-Host ('    failed to create firewall rule: {0}' -f \$_.Exception.Message) -ForegroundColor Red
}

# --- result ----------------------------------------------------------------
Write-Host ''
Write-Host '  Current portproxy table:' -ForegroundColor Cyan
& netsh.exe interface portproxy show v4tov4
Write-Host ''
${PS_CLOSING_NOTE}
Write-Host ''
Read-Host '  Press Enter to close this window'
EOF
}

# generate_undo_ps1 <outfile>
generate_undo_ps1() {
    local out="$1"
    cat > "$out" <<EOF
# ---------------------------------------------------------------------------
# Model Server - REMOVE WSL2 LAN exposure   (generated $(date '+%Y-%m-%d %H:%M:%S'))
# ---------------------------------------------------------------------------
\$ErrorActionPreference = 'Continue'

\$ports    = $(ps_ports_literal)
\$ruleName = '${RULE_NAME}'

Write-Host ''
Write-Host '  Model Server - removing WSL port forwarding' -ForegroundColor Cyan

\$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not \$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '  This window is NOT running as Administrator.' -ForegroundColor Red
    Read-Host '  Press Enter to close'
    exit 1
}

foreach (\$p in \$ports) {
    Write-Host ('  [portproxy] deleting port {0}' -f \$p)
    & netsh.exe interface portproxy delete v4tov4 listenport=\$p listenaddress=0.0.0.0 2>&1 | Out-Null
}

Write-Host ('  [firewall]  removing rule "{0}"' -f \$ruleName)
Remove-NetFirewallRule -DisplayName \$ruleName -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  Remaining portproxy table:' -ForegroundColor Cyan
& netsh.exe interface portproxy show v4tov4
Write-Host ''
Read-Host '  Press Enter to close this window'
EOF
}

# run_elevated <linux-ps1> <windows-ps1>
run_elevated() {
    local win_ps1="$2"
    log_step "Launching an elevated PowerShell on Windows"
    log_warning "Windows will show a UAC prompt — click Yes / accept it."
    log_info    "A PowerShell window opens, applies the rules, prints the table and waits"
    log_info    "for you to press Enter. Read it, then close it and come back here."
    echo ""
    # The -File element is wrapped in embedded double quotes: Start-Process
    # joins -ArgumentList with plain spaces, so an unquoted path containing a
    # space (a Windows username with a space in %TEMP%) would split.
    powershell.exe -NoProfile -Command \
        "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"${win_ps1}\"'" \
        >/dev/null 2>&1
    local rc=$?
    if [ $rc -ne 0 ]; then
        log_error "Could not launch the elevated PowerShell (exit $rc)."
        log_info  "Run this yourself in an elevated PowerShell on Windows:"
        echo ""
        echo -e "       ${CYAN}powershell -NoProfile -ExecutionPolicy Bypass -File \"${win_ps1}\"${NC}"
        echo ""
        return 1
    fi
    log_success "Elevated PowerShell launched"
    return 0
}

# stage_and_run <setup|undo>
#   Writes the .ps1 to the WINDOWS temp dir (a \\wsl$\... UNC path can fail to
#   resolve in an elevated context, so never hand Start-Process a Linux path)
#   and launches it elevated. In --dry-run it prints the script instead.
stage_and_run() {
    local kind="$1"
    local base="modelserver-wsl-expose-${kind}.ps1"
    local staged_linux staged_win tmp_pair

    if tmp_pair="$(win_temp_paths)"; then
        staged_linux="${tmp_pair%%|*}/${base}"
        staged_win="${tmp_pair##*|}\\${base}"
    else
        staged_linux="$(mktemp -d)/${base}"
        staged_win=""
    fi

    if [ "$kind" = undo ]; then
        generate_undo_ps1 "$staged_linux"
    else
        generate_setup_ps1 "$staged_linux"
    fi

    if [ "$DRY_RUN" = true ]; then
        echo ""
        echo -e "  ${DIM}── generated PowerShell (${staged_win:-$staged_linux}) ──────────────${NC}"
        sed 's/^/    /' "$staged_linux"
        echo -e "  ${DIM}────────────────────────────────────────────────────────────${NC}"
        echo ""
        log_info "Would launch:"
        printf '       \033[0;36m%s\033[0m\n' \
            "powershell.exe -NoProfile -Command \"Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"${staged_win:-<windows-temp>\\$base}\"'\""
        echo ""
        return 0
    fi

    if [ "$HAVE_PWSH" != true ] || [ -z "$staged_win" ]; then
        interop_warning
        echo ""
        log_info "The PowerShell script was written to: $staged_linux"
        log_info "Copy it to Windows and run it from an elevated PowerShell."
        echo ""
        return 1
    fi

    log_success "Staged PowerShell script: $staged_win"
    run_elevated "$staged_linux" "$staged_win"
}

# ============================================================================
# STATUS
# ============================================================================

print_portproxy_status() {
    if [ "$HAVE_NETSH" != true ]; then
        log_warning "netsh.exe not reachable — cannot read the portproxy table"
        return
    fi
    local table
    table="$(netsh.exe interface portproxy show v4tov4 2>/dev/null | tr -d '\r')"
    local entries
    entries="$(echo "$table" | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/ {print $1, $2, $3, $4}')"

    if [ -z "$entries" ]; then
        log_info "No IPv4 portproxy entries configured"
        return
    fi

    echo ""
    printf "      %-16s %-8s %-16s %-8s %s\n" "LISTEN ADDR" "PORT" "CONNECT ADDR" "PORT" "STATE"
    local stale=0
    while read -r la lp ca cp; do
        [ -z "${la:-}" ] && continue
        local state
        if [ "$ca" = "$WSL_IP" ]; then
            state="$(echo -e "${GREEN}current${NC}")"
        else
            state="$(echo -e "${YELLOW}STALE (WSL is now $WSL_IP)${NC}")"
            stale=$((stale + 1))
        fi
        printf "      %-16s %-8s %-16s %-8s %b\n" "$la" "$lp" "$ca" "$cp" "$state"
    done <<< "$entries"
    echo ""
    if [ "$stale" -gt 0 ]; then
        log_warning "$stale stale entry/entries — the WSL VM IP changed since they were added"
        log_info    "Fix with:  $PROJECT_DIR/wsl-expose.sh"
    else
        log_success "All portproxy entries point at the current WSL IP"
    fi
}

print_firewall_status() {
    if [ "$HAVE_PWSH" != true ]; then
        log_warning "powershell.exe not reachable — cannot check the firewall rule"
        return
    fi
    local out
    out="$(ps_out "(Get-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1).Enabled")"
    if [ -z "$out" ]; then
        log_warning "Firewall rule '${RULE_NAME}' not found"
    else
        log_success "Firewall rule '${RULE_NAME}' present (Enabled: $out)"
        local prof
        prof="$(ps_out "(Get-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1).Profile")"
        [ -n "$prof" ] && log_info "Profiles: $prof"
    fi
}

print_hyperv_status() {
    # Mirrored networking gates inbound traffic on the WSL VM's own Hyper-V
    # firewall as well as the normal Windows firewall.
    if [ "$HAVE_PWSH" != true ]; then
        log_warning "powershell.exe not reachable — cannot check the WSL Hyper-V firewall"
        return
    fi
    local act
    act="$(ps_out "(Get-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -ErrorAction SilentlyContinue).DefaultInboundAction" | head -1)"
    if [ -z "$act" ]; then
        log_info "WSL Hyper-V firewall setting unavailable (needs Windows 11 22H2+ / WSL 2.0.0+)"
    elif [ "$act" = "Allow" ]; then
        log_success "WSL Hyper-V firewall: DefaultInboundAction = Allow"
    else
        log_warning "WSL Hyper-V firewall: DefaultInboundAction = $act — inbound LAN traffic is blocked"
        log_info    "Fix (elevated PowerShell, or just re-run $PROJECT_DIR/wsl-expose.sh):"
        echo -e "       ${CYAN}Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow${NC}"
    fi
}

# ============================================================================
# .wslconfig WRITER (--use-mirrored)
# ============================================================================

# The recommended block (matches README): mirrored networking + the WSL
# firewall/DNS/proxy integration, plus loopback from Windows to the distro.
MIRRORED_WSL2_KEYS=(
    "networkingMode=mirrored"
    "firewall=true"
    "dnsTunneling=true"
    "autoProxy=true"
)
MIRRORED_EXPERIMENTAL_KEYS=(
    "hostAddressLoopback=true"
)

mirrored_snippet() {
    echo "[wsl2]"
    printf '%s\n' "${MIRRORED_WSL2_KEYS[@]}"
    echo ""
    echo "[experimental]"
    printf '%s\n' "${MIRRORED_EXPERIMENTAL_KEYS[@]}"
}

_ini_key() {  # "  Foo = bar " -> "foo"
    local k="${1%%=*}"
    k="${k#"${k%%[![:space:]]*}"}"
    k="${k%"${k##*[![:space:]]}"}"
    printf '%s' "$(echo "$k" | tr '[:upper:]' '[:lower:]')"
}

# Merge the desired keys into an existing .wslconfig WITHOUT touching any other
# key or section: existing managed keys are rewritten in place, missing ones are
# appended at the end of their section, and absent sections are created.
merge_wslconfig() {  # <infile-or-empty> <outfile>
    local infile="$1" outfile="$2"
    declare -A W=() E=() seenW=() seenE=()
    local kv k
    for kv in "${MIRRORED_WSL2_KEYS[@]}";         do W["$(_ini_key "$kv")"]="$kv"; done
    for kv in "${MIRRORED_EXPERIMENTAL_KEYS[@]}"; do E["$(_ini_key "$kv")"]="$kv"; done

    local out="" sec="" sawW=0 sawE=0 line raw

    _flush_section() {
        case "$1" in
            wsl2)
                for kv in "${MIRRORED_WSL2_KEYS[@]}"; do
                    k="$(_ini_key "$kv")"
                    [ -n "${seenW[$k]:-}" ] || { out+="$kv"$'\n'; seenW[$k]=1; }
                done ;;
            experimental)
                for kv in "${MIRRORED_EXPERIMENTAL_KEYS[@]}"; do
                    k="$(_ini_key "$kv")"
                    [ -n "${seenE[$k]:-}" ] || { out+="$kv"$'\n'; seenE[$k]=1; }
                done ;;
        esac
    }

    if [ -n "$infile" ] && [ -f "$infile" ]; then
        while IFS= read -r raw || [ -n "$raw" ]; do
            line="${raw%$'\r'}"                       # CRLF files are normal here
            if [[ "$line" =~ ^[[:space:]]*\[(.*)\][[:space:]]*$ ]]; then
                _flush_section "$sec"
                sec="$(echo "${BASH_REMATCH[1]}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
                [ "$sec" = wsl2 ]         && sawW=1
                [ "$sec" = experimental ] && sawE=1
                out+="$line"$'\n'
                continue
            fi
            if [[ "$line" == *=* ]]; then
                k="$(_ini_key "$line")"
                if [ "$sec" = wsl2 ] && [ -n "${W[$k]:-}" ]; then
                    out+="${W[$k]}"$'\n'; seenW[$k]=1; continue
                fi
                if [ "$sec" = experimental ] && [ -n "${E[$k]:-}" ]; then
                    out+="${E[$k]}"$'\n'; seenE[$k]=1; continue
                fi
            fi
            out+="$line"$'\n'
        done < "$infile"
        _flush_section "$sec"
    fi

    if [ "$sawW" = 0 ]; then
        out+=$'\n[wsl2]\n'
        for kv in "${MIRRORED_WSL2_KEYS[@]}"; do out+="$kv"$'\n'; done
    fi
    if [ "$sawE" = 0 ]; then
        out+=$'\n[experimental]\n'
        for kv in "${MIRRORED_EXPERIMENTAL_KEYS[@]}"; do out+="$kv"$'\n'; done
    fi

    # No leading blank lines when the file was empty/new
    while [ "${out:0:1}" = $'\n' ]; do out="${out:1}"; done
    printf '%s' "$out" > "$outfile"
}

write_mirrored_config() {
    if [ -z "$WSLCONFIG_LINUX" ]; then
        if [ "$DRY_RUN" = true ]; then
            log_warning "Could not locate %USERPROFILE% (no interop) — would write this to"
            log_warning "C:\\Users\\<you>\\.wslconfig:"
            echo ""
            mirrored_snippet | sed 's/^/       /'
            echo ""
            return 0
        fi
        log_error "Could not locate %USERPROFILE% — cannot find .wslconfig"
        interop_warning
        echo ""
        log_info "Create C:\\Users\\<you>\\.wslconfig by hand containing:"
        echo ""
        mirrored_snippet | sed 's/^/       /'
        echo ""
        return 1
    fi

    log_info "Target: $WSLCONFIG_LINUX"

    if [ "$DRY_RUN" = true ]; then
        local preview
        preview="$(mktemp)"
        if [ -f "$WSLCONFIG_LINUX" ]; then
            merge_wslconfig "$WSLCONFIG_LINUX" "$preview"
        else
            merge_wslconfig "" "$preview"
        fi
        log_info "Would back up the existing file and write:"
        echo ""
        sed 's/^/       /' "$preview"
        echo ""
        rm -f "$preview"
        return 0
    fi

    if [ ! -f "$WSLCONFIG_LINUX" ]; then
        log_step "Creating $WSLCONFIG_LINUX"
        merge_wslconfig "" "$WSLCONFIG_LINUX" || { log_error "Write failed"; return 1; }
        log_success ".wslconfig created with mirrored networking"
        return 0
    fi

    local tmp
    tmp="$(mktemp)"
    merge_wslconfig "$WSLCONFIG_LINUX" "$tmp" || { log_error "Merge failed"; return 1; }

    if cmp -s "$tmp" "$WSLCONFIG_LINUX"; then
        rm -f "$tmp"
        log_success "Already configured for mirrored networking — no change needed"
        return 0
    fi

    local backup="${WSLCONFIG_LINUX}.bak.$(date +%s)"
    cp "$WSLCONFIG_LINUX" "$backup" || { log_error "Backup failed"; rm -f "$tmp"; return 1; }
    log_step "Backed up existing .wslconfig to $(basename "$backup")"
    if cat "$tmp" > "$WSLCONFIG_LINUX"; then
        rm -f "$tmp"
        log_success ".wslconfig updated (all other keys and sections preserved)"
    else
        log_error "Write failed — your original is at $backup"
        rm -f "$tmp"
        return 1
    fi
    return 0
}

print_mirrored_next_steps() {
    echo ""
    echo -e "  ${BOLD}Finish the switch to mirrored networking${NC}"
    echo -e "  ${DIM}────────────────────────────────────────${NC}"
    echo ""
    echo "  1. Close this WSL terminal, then run in PowerShell (normal, not Admin):"
    echo ""
    echo -e "       ${CYAN}wsl --shutdown${NC}"
    echo ""
    echo "  2. Reopen WSL and start the stack:  ./start.sh"
    echo "  3. Allow the ports through the Windows firewall (still required):"
    echo ""
    echo -e "       ${CYAN}$PROJECT_DIR/wsl-expose.sh --status${NC}"
    echo ""
    echo -e "  ${DIM}Mirrored mode needs WSL >= 2.0.0 (Windows 11 22H2+). Check with:${NC}"
    echo -e "  ${DIM}  wsl.exe --version${NC}"
    echo ""
}

# ============================================================================
# FINAL URL SUMMARY
# ============================================================================

print_urls() {
    section "Reach it from another machine"
    local ip="$WIN_LAN_IP"
    if [ -z "$ip" ]; then
        log_warning "Could not determine the Windows LAN IP"
        log_info    "Find it with:  ipconfig.exe   (IPv4 Address of your active adapter)"
        ip="<windows-lan-ip>"
    fi
    echo ""
    for p in "${PORTS[@]}"; do
        case "$p" in
            3001) echo -e "       ${CYAN}https://${ip}:3001${NC}   ${DIM}webapp${NC}" ;;
            3002) echo -e "       ${CYAN}https://${ip}:3002${NC}   ${DIM}chat UI${NC}" ;;
            3080) echo -e "       ${CYAN}http://${ip}:3080${NC}    ${DIM}redirects to HTTPS${NC}" ;;
            *)    echo -e "       ${CYAN}https://${ip}:${p}${NC}" ;;
        esac
    done
    echo ""
    log_info "The certificate is self-signed — the browser warning is expected."
    log_info "Click 'Advanced' → 'Proceed'. Nothing is broken."
    echo ""
}

# ============================================================================
# MAIN
# ============================================================================

section "Environment"
log_info "WSL VM IP     : ${WSL_IP:-unknown}"
log_info "Windows LAN IP: ${WIN_LAN_IP:-unknown}"
log_info "Ports         : ${PORTS_CSV}"
if [ "$NET_MODE" = mirrored ]; then
    log_success "Networking mode: mirrored — ${NET_MODE_SOURCE}"
else
    log_info "Networking mode: NAT — ${NET_MODE_SOURCE}"
fi
[ "$HAVE_PWSH" != true ] && interop_warning
[ "$DRY_RUN" = true ] && log_warning "--dry-run: nothing will be changed"

case "$MODE" in

    status)
        section "Port forwarding (netsh portproxy)"
        print_portproxy_status
        section "Windows firewall"
        print_firewall_status
        if [ "$NET_MODE" = mirrored ]; then
            echo ""
            print_hyperv_status
        fi
        if [ "$NET_MODE" = mirrored ]; then
            echo ""
            log_success "Mirrored networking is active — portproxy entries are not needed."
            log_info    "Only the firewall rule matters. Stale entries above are harmless."
        else
            echo ""
            log_warning "NAT mode: the WSL VM IP changes on every 'wsl --shutdown',"
            log_warning "which silently breaks the forwards above."
            log_info    "Durable fix:  $PROJECT_DIR/wsl-expose.sh --use-mirrored"
        fi
        print_urls
        exit 0
        ;;

    undo)
        section "Removing LAN exposure"
        log_info "Ports: ${PORTS_CSV}   Firewall rule: ${RULE_NAME}"
        stage_and_run undo
        echo ""
        log_info "After the elevated window finishes, verify with:  $0 --status"
        echo ""
        exit 0
        ;;

    mirrored)
        section "Switching to mirrored networking"
        echo ""
        echo "  Mirrored mode makes the WSL VM share the Windows network stack, so"
        echo "  the LAN reaches the containers directly — no portproxy, and no"
        echo "  breakage when the VM IP changes (there is no separate VM IP)."
        echo ""
        echo -e "  ${DIM}The snippet being written:${NC}"
        mirrored_snippet | sed 's/^/       /'
        echo ""
        write_mirrored_config || exit 1
        print_mirrored_next_steps
        log_info "You still need the firewall rule. After the restart run:"
        echo -e "       ${CYAN}$PROJECT_DIR/wsl-expose.sh${NC}"
        echo ""
        exit 0
        ;;

    setup)
        if [ "$NET_MODE" = mirrored ]; then
            section "Mirrored networking detected"
            log_success "No port forwarding needed — the WSL VM shares the Windows network stack."
            log_info    "The only remaining requirement is the Windows firewall allowing"
            log_info    "TCP ${PORTS_CSV} inbound (profiles: ${FW_PROFILES})."
            echo ""
            log_step "Applying the firewall rule only — no portproxy (in mirrored mode the"
            log_step "WSL IP IS the Windows IP, so a portproxy would forward a port to itself)."
            log_step "Any leftover NAT-mode entries for these ports get cleared."
            PS_FIREWALL_ONLY=true
            PS_HEADLINE="LAN access (mirrored networking)"
            stage_and_run setup
            print_urls
            exit 0
        fi

        section "NAT networking — setting up port forwarding"
        echo ""
        echo "  What will happen on the Windows side:"
        echo "    1. netsh portproxy: delete + re-add v4tov4 rules for ${PORTS_CSV}"
        echo "       0.0.0.0:<port>  ->  ${WSL_IP}:<port>"
        echo "    2. Firewall: remove + re-add inbound rule '${RULE_NAME}'"
        echo "       TCP ${PORTS_CSV}, profiles ${FW_PROFILES}"
        echo ""
        if [ "$ALLOW_PUBLIC" != true ]; then
            log_info "The Public firewall profile is deliberately excluded. If Windows has"
            log_info "classified your network as Public, re-run with --allow-public."
        fi
        stage_and_run setup || exit 1
        echo ""
        log_warning "NAT mode caveat: the WSL VM IP (${WSL_IP}) changes on every"
        log_warning "'wsl --shutdown' — the forwards above then point at nothing."
        log_info    "Check anytime with:   $0 --status"
        log_info    "Durable fix:          $0 --use-mirrored"
        print_urls
        exit 0
        ;;
esac
