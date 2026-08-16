#!/bin/bash
# ============================================================================
# netaccess.sh — shared network / certificate helpers
# ----------------------------------------------------------------------------
# Sourced by start.sh, build.sh and reset.sh. Everything here is idempotent and
# side-effect free unless the function name says otherwise.
#
# Why this exists: the services publish on 0.0.0.0 inside their host (compose
# maps 3001/3002/3080 without a bind address), but the scripts only ever told
# the user about https://localhost — so on a fresh install, and especially
# under WSL2's NAT networking, "it only works on localhost" looked like a bug
# in the app when it is really a host-networking / firewall / certificate-SAN
# problem. These helpers detect the real reachable addresses, put them in the
# TLS certificate, and print them with a live reachability check.
# ============================================================================

# --- guards ---------------------------------------------------------------
[ -n "${_MS_NETACCESS_SOURCED:-}" ] && return 0
_MS_NETACCESS_SOURCED=1

# --- WSL ------------------------------------------------------------------
ms_is_wsl() {
    [ "${MODELSERVER_FAKE_WSL:-0}" = "1" ] && return 0
    grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && return 0
    grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && return 0
    return 1
}

# "mirrored" | "nat" | "unknown". Mirrored networking (WSL >= 2.0.0) gives the
# distro the Windows adapters' own addresses, so LAN access works with just a
# firewall rule; NAT needs portproxy (see ./wsl-expose.sh).
ms_wsl_networking_mode() {
    ms_is_wsl || { echo "n/a"; return; }
    local conf=""
    if command -v wslpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then
        local up
        up=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r')
        [ -n "$up" ] && conf=$(wslpath -u "$up" 2>/dev/null)/.wslconfig
    fi
    if [ -n "$conf" ] && [ -f "$conf" ] \
       && grep -qiE '^[[:space:]]*networkingMode[[:space:]]*=[[:space:]]*mirrored' "$conf" 2>/dev/null; then
        echo "mirrored"; return
    fi
    # Heuristic fallback: the NAT vNIC always lands in 172.16/12 with a 172.x
    # default gateway; a mirrored distro carries the host's real LAN address.
    local gw
    gw=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}' || true)
    case "$gw" in
        172.1[6-9].*|172.2[0-9].*|172.3[01].*) echo "nat"; return ;;
        "") echo "unknown"; return ;;
    esac
    echo "unknown"
}

# --- addresses ------------------------------------------------------------
# Non-loopback IPv4s that a browser on another machine could plausibly use.
# Docker/libvirt bridges and VPN tun devices are excluded — they are never the
# answer. Tailscale IS kept: 100.x is a real, stable way people reach the box.
ms_host_ipv4s() {
    ip -4 -o addr show scope global 2>/dev/null \
        | awk '{print $2" "$4}' \
        | grep -vE '^(docker[0-9]*|br-[0-9a-f]+|veth|virbr[0-9]*|tun[0-9]*) ' \
        | awk '{print $2}' | cut -d/ -f1 \
        | grep -vE '^(127\.|169\.254\.)' \
        | sort -u || true
    return 0
}

ms_primary_ipv4() {
    # The address the kernel would actually source traffic from, when routable.
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)
    if [ -n "$ip" ] && ! echo "$ip" | grep -qE '^(127\.|169\.254\.)'; then
        echo "$ip"; return
    fi
    ms_host_ipv4s | head -1
    return 0
}

# Windows' own LAN address, as seen from inside WSL (NAT mode). Empty when
# interop is disabled or we aren't on WSL.
ms_windows_lan_ip() {
    ms_is_wsl || return 0
    command -v powershell.exe >/dev/null 2>&1 || return 0
    powershell.exe -NoProfile -Command \
        '(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null} | Select-Object -First 1).IPv4Address.IPAddress' \
        2>/dev/null | tr -d '\r' | head -1 || true
    return 0
}

# --- certificates ---------------------------------------------------------
# One definition of the SAN list, used by every script that can create certs.
# Without the host's own IPs in here a browser hitting https://192.168.x.y:3001
# gets ERR_CERT_COMMON_NAME_INVALID on top of the expected self-signed warning,
# and some clients (curl --cacert pinning, mobile browsers, WebView) refuse it
# outright with no "proceed anyway".
ms_cert_san_list() {
    local sans="DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1"
    local h; h=$(hostname -s 2>/dev/null || true)
    if [ -n "$h" ] && [ "$h" != "localhost" ]; then sans="$sans,DNS:$h"; fi
    local ip
    while read -r ip; do
        [ -n "$ip" ] && sans="$sans,IP:$ip"
    done < <(ms_host_ipv4s)
    local wip; wip=$(ms_windows_lan_ip || true)
    if [ -n "$wip" ] && ! echo "$sans" | grep -q "IP:$wip"; then sans="$sans,IP:$wip"; fi
    echo "$sans"
    return 0
}

# 0 when the existing cert already covers every current address.
ms_cert_is_current() {
    local crt="$1"
    [ -f "$crt" ] || return 1
    local have ip
    have=$(openssl x509 -in "$crt" -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 || true)
    [ -n "$have" ] || return 1
    while read -r ip; do
        [ -z "$ip" ] && continue
        echo "$have" | grep -q "IP Address:$ip\b" || return 1
    done < <(ms_host_ipv4s)
    return 0
}

# ms_generate_certs <certs_dir>  — writes server.key/server.crt with the full
# SAN list. Callers decide *when*; this decides *what*.
ms_generate_certs() {
    local dir="$1"
    mkdir -p "$dir"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$dir/server.key" \
        -out "$dir/server.crt" \
        -subj "/C=US/ST=Local/L=Local/O=ModelServer/OU=Development/CN=localhost" \
        -addext "subjectAltName=$(ms_cert_san_list)" >/dev/null 2>&1 || return 1
    chmod 600 "$dir/server.key"
    chmod 644 "$dir/server.crt"
    return 0
}

# --- .env -----------------------------------------------------------------
# HOST_IP is read by the webapp (getHostIp) for host-facing URLs. It was
# documented as auto-detected but nothing ever wrote it.
ms_seed_env_host_ip() {
    local env_file="$1" ip
    ip=$(ms_primary_ipv4 || true)
    [ -z "$ip" ] && return 0
    [ -f "$env_file" ] || touch "$env_file"
    if grep -q '^HOST_IP=' "$env_file" 2>/dev/null; then
        local cur; cur=$(grep '^HOST_IP=' "$env_file" | head -1 | cut -d= -f2-)
        [ -n "$cur" ] && return 0            # user-set value wins
        sed -i "s|^HOST_IP=.*|HOST_IP=$ip|" "$env_file"
    else
        echo "HOST_IP=$ip" >> "$env_file"
    fi
    echo "$ip"
}

# --- reachability ---------------------------------------------------------
ms_port_open() {  # host port [timeout]
    local host="$1" port="$2" t="${3:-2}"
    if command -v curl >/dev/null 2>&1; then
        curl -sk --max-time "$t" -o /dev/null "https://$host:$port/" 2>/dev/null && return 0
        # A TLS handshake that completes but 404s still proves the port is open.
        [ "$(curl -sk --max-time "$t" -o /dev/null -w '%{http_code}' "https://$host:$port/" 2>/dev/null)" != "000" ] && return 0
        return 1
    fi
    (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && return 0
    return 1
}

# Local firewall that would block a LAN client even though the port is bound.
ms_firewall_warning() {
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
        local rules; rules=$(ufw status 2>/dev/null || true)
        if ! echo "$rules" | grep -qE '(^|[^0-9])3001'; then
            echo "ufw is active and no rule allows 3001/3002 — run: sudo ufw allow 3001/tcp && sudo ufw allow 3002/tcp"
        fi
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        if ! firewall-cmd --list-ports 2>/dev/null | grep -q '3001/tcp'; then
            echo "firewalld is active and no rule allows 3001/3002 — run: sudo firewall-cmd --add-port=3001/tcp --add-port=3002/tcp --permanent && sudo firewall-cmd --reload"
        fi
    fi
    return 0
}


# --- publish binding ------------------------------------------------------
# Confirms the compose port mappings really landed on 0.0.0.0. A binding of
# 127.0.0.1 (a stale BIND_ADDR, an edited compose file, or a Docker rootless
# default) makes the service unreachable from anywhere but the host, which is
# indistinguishable from "the app is broken" without this check.
ms_publish_binding_warning() {
    command -v docker >/dev/null 2>&1 || return 0
    local out name port
    for name in modelserver-webapp-1 modelserver-chat-1; do
        out=$(docker port "$name" 2>/dev/null || true)
        [ -z "$out" ] && continue
        if echo "$out" | grep -q '127\.0\.0\.1:'; then
            port=$(echo "$out" | grep '127\.0\.0\.1:' | head -1 | sed 's/.*127\.0\.0\.1://')
            echo "$name publishes port $port on 127.0.0.1 only — check the 'ports:' entries in docker-compose.yml (they should read \"3001:3001\", not \"127.0.0.1:3001:3001\")"
            return 0
        fi
    done
    return 0
}

# --- summary --------------------------------------------------------------
# Prints the "Ready" access block. Expects the caller's colour vars (BOLD/DIM/
# NC/GREEN/YELLOW) to exist; falls back to empty strings when they don't.
ms_print_access_urls() {
    local BOLD="${BOLD:-}" DIM="${DIM:-}" NC="${NC:-}" GREEN="${GREEN:-}" YELLOW="${YELLOW:-}" CYAN="${CYAN:-}"
    local ip primary mode wip

    echo -e "  ${BOLD}This machine${NC}"
    echo -e "    Webapp   https://localhost:3001"
    echo -e "    Chat UI  https://localhost:3002"

    primary=$(ms_primary_ipv4 || true)
    if [ -n "$primary" ]; then
        echo ""
        echo -e "  ${BOLD}Other devices on your network${NC}"
        while read -r ip; do
            [ -z "$ip" ] && continue
            local mark="${GREEN}✓${NC}"
            ms_port_open "$ip" 3001 2 || mark="${YELLOW}!${NC}"
            echo -e "    $mark Webapp   https://$ip:3001"
            echo -e "      Chat UI  https://$ip:3002"
        done < <(ms_host_ipv4s)
    fi

    if ms_is_wsl; then
        mode=$(ms_wsl_networking_mode || true)
        wip=$(ms_windows_lan_ip || true)
        echo ""
        if [ "$mode" = "mirrored" ]; then
            echo -e "  ${BOLD}WSL${NC} ${DIM}(mirrored networking)${NC}"
            if [ -n "$wip" ]; then echo -e "    Other devices:  https://$wip:3001  ·  https://$wip:3002"; fi
            echo -e "    ${DIM}If they can't connect, Windows Firewall is blocking it:${NC}"
            echo -e "    ${DIM}  sudo ./wsl-expose.sh          (adds the inbound rule)${NC}"
        else
            echo -e "  ${BOLD}WSL${NC} ${DIM}(NAT networking — the default)${NC}"
            echo -e "    ${DIM}Windows forwards only 'localhost' into WSL, so the addresses above${NC}"
            echo -e "    ${DIM}are reachable from this distro but NOT from other machines.${NC}"
            echo -e "    To expose them on your LAN:  ${BOLD}sudo ./wsl-expose.sh${NC}"
            if [ -n "$wip" ]; then echo -e "    ${DIM}Afterwards other devices use:  https://$wip:3001  ·  https://$wip:3002${NC}"; fi
        fi
    fi

    local bind; bind=$(ms_publish_binding_warning || true)
    if [ -n "$bind" ]; then
        echo ""
        echo -e "  ${YELLOW}!${NC}  $bind"
    fi

    local fw; fw=$(ms_firewall_warning || true)
    if [ -n "$fw" ]; then
        echo ""
        echo -e "  ${YELLOW}!${NC}  $fw"
    fi
    return 0
}
