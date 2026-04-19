#!/bin/bash

# koda CLI Installer (Remote)
# Supports Linux, macOS, and Windows (via WSL or Git Bash)
#
# Corporate Proxy/SSL Configuration:
#   Set these environment variables before running:
#   - KODA_INSECURE=1         : Skip all SSL verification (use with caution)
#   - KODA_CA_CERT=/path/cert : Use custom CA certificate for SSL
#   - HTTPS_PROXY=http://...  : HTTP(S) proxy URL
#   - HTTP_PROXY=http://...   : HTTP proxy URL
#
# Example for corporate environment:
#   KODA_INSECURE=1 curl -sk https://localhost:3001/api/cli/install | bash
#
# Or with custom CA certificate:
#   KODA_CA_CERT=/etc/ssl/corporate-ca.crt curl -sk https://localhost:3001/api/cli/install | bash

set -e

# -----------------------------------------------------------------------------
# Resolve HOME robustly.
#
# In minimal WSL distros, plain `sh` / dash shells, and some container
# environments, HOME can be empty or literally "/". That silently turned
# $HOME/.local/bin into "//.local/bin" or "/.local/bin" — a real directory
# nobody has in their PATH, so `koda` ended up "installed" somewhere the shell
# could never find. Fix this before computing any derived paths.
# -----------------------------------------------------------------------------
resolve_home() {
    if [ -n "$HOME" ] && [ "$HOME" != "/" ] && [ -d "$HOME" ]; then
        # Strip trailing slash so derived paths never get "//" in them.
        HOME="${HOME%/}"
        export HOME
        return 0
    fi

    echo "Note: HOME is empty or '/' — resolving automatically..." >&2

    # 1. Ask the OS what home dir the current user should have.
    local current_user
    current_user=$(id -un 2>/dev/null || whoami 2>/dev/null || true)
    if [ -n "$current_user" ] && command -v getent >/dev/null 2>&1; then
        local resolved
        resolved=$(getent passwd "$current_user" 2>/dev/null | cut -d: -f6 || true)
        if [ -n "$resolved" ] && [ "$resolved" != "/" ] && [ -d "$resolved" ]; then
            HOME="${resolved%/}"
            export HOME
            echo "  -> Resolved HOME to $HOME" >&2
            return 0
        fi
    fi

    # 2. Root fallback: /root exists on essentially every Linux system.
    if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then
        mkdir -p /root
        HOME="/root"
        export HOME
        echo "  -> Defaulting HOME to /root" >&2
        return 0
    fi

    # 3. Give up with a clear message rather than silently corrupting paths.
    echo "" >&2
    echo "Error: HOME environment variable is not set and could not be resolved." >&2
    echo "" >&2
    echo "Please set it manually and rerun the installer:" >&2
    echo "  export HOME=\"/path/to/your/home\"" >&2
    echo "  curl -sk $API_URL/api/cli/install | bash" >&2
    echo "" >&2
    echo "If you're running via sudo, try 'sudo -i' first to get a login shell." >&2
    exit 1
}

# Get API URL from environment (set by server) or use localhost as fallback
API_URL="${KODA_API_URL:-https://localhost:3001}"

resolve_home

INSTALL_DIR="$HOME/.local/bin"
CLI_DIR="$HOME/.local/lib/koda-cli"

# SSL/Proxy configuration
KODA_INSECURE="${KODA_INSECURE:-0}"
KODA_CA_CERT="${KODA_CA_CERT:-}"

# Build curl options based on environment
build_curl_opts() {
    local opts="-s"

    # Always add -k for self-signed certs (localhost)
    if [[ "$API_URL" == *"localhost"* ]] || [[ "$API_URL" == *"127.0.0.1"* ]]; then
        opts="$opts -k"
    fi

    # Full insecure mode for corporate proxy environments
    if [ "$KODA_INSECURE" = "1" ]; then
        opts="$opts -k"
    fi

    # Custom CA certificate
    if [ -n "$KODA_CA_CERT" ] && [ -f "$KODA_CA_CERT" ]; then
        opts="$opts --cacert $KODA_CA_CERT"
    fi

    # Proxy settings (curl respects HTTPS_PROXY/HTTP_PROXY automatically,
    # but we can be explicit)
    if [ -n "$HTTPS_PROXY" ]; then
        opts="$opts --proxy $HTTPS_PROXY"
    elif [ -n "$HTTP_PROXY" ]; then
        opts="$opts --proxy $HTTP_PROXY"
    fi

    echo "$opts"
}

CURL_OPTS=$(build_curl_opts)

# Function to download with retry and fallback
download_file() {
    local url="$1"
    local output="$2"
    local description="$3"

    echo "  - $description"

    # Try HTTPS first
    if curl $CURL_OPTS "$url" -o "$output" 2>/dev/null; then
        return 0
    fi

    # If HTTPS failed and we have an HTTPS URL, try HTTP fallback on port 3080
    if [[ "$url" == https://* ]]; then
        local http_url="${url/https:\/\//http://}"
        http_url="${http_url/:3001/:3080}"

        echo "    (Trying HTTP fallback...)"
        if curl $CURL_OPTS "$http_url" -o "$output" 2>/dev/null; then
            return 0
        fi
    fi

    # Both failed - provide helpful error message
    echo ""
    echo "Error: Failed to download $description"
    echo ""
    echo "This may be caused by:"
    echo "  1. Corporate SSL inspection/proxy intercepting HTTPS"
    echo "  2. Network connectivity issues"
    echo "  3. Server not running"
    echo ""
    echo "Try one of these solutions:"
    echo ""
    echo "  Option 1: Skip SSL verification (corporate proxy)"
    echo "    KODA_INSECURE=1 curl -sk $API_URL/api/cli/install | bash"
    echo ""
    echo "  Option 2: Use custom CA certificate"
    echo "    KODA_CA_CERT=/path/to/corporate-ca.crt curl -sk $API_URL/api/cli/install | bash"
    echo ""
    echo "  Option 3: Configure proxy"
    echo "    HTTPS_PROXY=http://proxy:port curl -sk $API_URL/api/cli/install | bash"
    echo ""
    return 1
}

echo "=========================================="
echo "  koda CLI Installer"
echo "=========================================="
echo ""

# Show SSL configuration if non-default
if [ "$KODA_INSECURE" = "1" ]; then
    echo "Mode: Insecure (SSL verification disabled)"
fi
if [ -n "$KODA_CA_CERT" ]; then
    echo "CA Certificate: $KODA_CA_CERT"
fi
if [ -n "$HTTPS_PROXY" ] || [ -n "$HTTP_PROXY" ]; then
    echo "Proxy: ${HTTPS_PROXY:-$HTTP_PROXY}"
fi
echo ""

# Detect OS
OS="unknown"
case "$(uname -s)" in
    Linux*)     OS="linux";;
    Darwin*)    OS="macos";;
    CYGWIN*|MINGW*|MSYS*)    OS="windows";;
    *)          OS="unknown";;
esac

echo "Detected OS: $OS"
echo ""

# Detect shell config file based on OS and shell
SHELL_RC=""
detect_shell_config() {
    # Determine which shell the user actually runs. The installer is normally
    # executed via `curl | bash`, so BASH_VERSION is set inside this process —
    # but $SHELL still points at the user's login shell, which is what we
    # actually want to configure.
    local login_shell=""
    if [ -n "$SHELL" ]; then
        login_shell=$(basename "$SHELL")
    fi

    # Priority 1: match the user's login shell.
    case "$login_shell" in
        zsh)
            for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
                [ -f "$rc" ] && { echo "$rc"; return; }
            done
            ;;
        bash)
            if [ "$OS" = "macos" ]; then
                for rc in "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
                    [ -f "$rc" ] && { echo "$rc"; return; }
                done
            else
                for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
                    [ -f "$rc" ] && { echo "$rc"; return; }
                done
            fi
            ;;
        fish)
            if [ -f "$HOME/.config/fish/config.fish" ]; then
                echo "$HOME/.config/fish/config.fish"
                return
            fi
            ;;
        sh|dash|ash|ksh)
            # POSIX-ish shells read ~/.profile on login.
            [ -f "$HOME/.profile" ] && { echo "$HOME/.profile"; return; }
            ;;
    esac

    # Priority 2: interpreter-of-this-process hints (BASH_VERSION / ZSH_VERSION).
    if [ -n "$ZSH_VERSION" ]; then
        for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
            [ -f "$rc" ] && { echo "$rc"; return; }
        done
    elif [ -n "$BASH_VERSION" ]; then
        for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
            [ -f "$rc" ] && { echo "$rc"; return; }
        done
    fi

    # Priority 3: any common file that already exists.
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile"; do
        if [ -f "$rc" ]; then
            echo "$rc"
            return
        fi
    done

    # Priority 4: nothing exists yet — create ~/.profile, which every POSIX
    # login shell (bash, dash, sh, ksh) reads. This is the most widely
    # compatible fallback and avoids the "Manual PATH Setup Required" dead end.
    if touch "$HOME/.profile" 2>/dev/null; then
        echo "$HOME/.profile"
        return
    fi

    echo ""
}

SHELL_RC=$(detect_shell_config)
echo "Shell config: ${SHELL_RC:-none detected}"
echo ""

# Check for Node.js and attempt to install if missing
install_nodejs() {
    echo ">>> Node.js not found. Attempting to install..."

    if [ "$OS" = "linux" ]; then
        # Check for package manager and install Node.js
        if command -v apt-get &> /dev/null; then
            echo "  Using apt to install Node.js..."
            sudo apt-get update -qq
            sudo apt-get install -y nodejs npm
        elif command -v dnf &> /dev/null; then
            echo "  Using dnf to install Node.js..."
            sudo dnf install -y nodejs npm
        elif command -v yum &> /dev/null; then
            echo "  Using yum to install Node.js..."
            sudo yum install -y nodejs npm
        elif command -v pacman &> /dev/null; then
            echo "  Using pacman to install Node.js..."
            sudo pacman -S --noconfirm nodejs npm
        else
            echo "Error: Could not detect package manager."
            echo "Please install Node.js manually from https://nodejs.org/"
            exit 1
        fi
    elif [ "$OS" = "macos" ]; then
        if command -v brew &> /dev/null; then
            echo "  Using Homebrew to install Node.js..."
            brew install node
        else
            echo "Error: Homebrew not found."
            echo "Please install Node.js from https://nodejs.org/"
            echo "Or install Homebrew first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            exit 1
        fi
    else
        echo "Error: Cannot auto-install Node.js on this system."
        echo "Please install Node.js from https://nodejs.org/"
        exit 1
    fi

    # Verify installation
    if ! command -v node &> /dev/null; then
        echo "Error: Node.js installation failed."
        echo "Please install Node.js manually from https://nodejs.org/"
        exit 1
    fi

    echo "  Node.js installed successfully!"
}

if ! command -v node &> /dev/null; then
    install_nodejs
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    if [ "$OS" = "linux" ]; then
        echo "Try: sudo apt install npm"
    fi
    exit 1
fi
echo "npm version: $(npm --version)"
echo ""

# Create installation directories
echo ">>> Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$CLI_DIR"
mkdir -p "$CLI_DIR/bin"

# Download CLI files from API
echo ">>> Downloading CLI files from $API_URL..."

# Download package.json
if ! download_file "$API_URL/api/cli/files/package.json" "$CLI_DIR/package.json" "package.json"; then
    exit 1
fi

# Download koda.js
if ! download_file "$API_URL/api/cli/files/koda.js" "$CLI_DIR/bin/koda.js" "koda.js"; then
    exit 1
fi

# Make executable
chmod +x "$CLI_DIR/bin/koda.js"

# Install dependencies. Wipe any leftover lockfile from a prior install
# so npm re-resolves against the freshly downloaded package.json (and
# honours the `overrides` block) instead of pinning older transitives
# from an earlier session. --omit=dev is the modern flag name; fall back
# to --production for older npm.
echo ">>> Installing dependencies..."
cd "$CLI_DIR"
rm -f package-lock.json
if npm install --omit=dev 2>&1 || npm install --production 2>&1; then
    echo "  Dependencies installed successfully"
else
    echo ""
    echo "Error: Failed to install dependencies."
    echo "Try running manually: cd $CLI_DIR && npm install"
    exit 1
fi
cd - > /dev/null

# Create symlink
echo ">>> Creating launcher..."
ln -sf "$CLI_DIR/bin/koda.js" "$INSTALL_DIR/koda"

echo ""
echo "=========================================="
echo "  Installation Complete!"
echo "=========================================="
echo ""
echo "The CLI has been installed to: $INSTALL_DIR"
echo ""

# Check if install directory is in PATH and auto-add if needed.
# We write the LITERAL $INSTALL_DIR (already resolved to an absolute path), not
# the "$HOME/.local/bin" string — that way even if the user's shell has a
# different HOME later, the PATH entry still points at the actual install.
PATH_SETUP_SUCCESS=false
PATH_EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ">>> Adding $INSTALL_DIR to PATH..."

    if [ -n "$SHELL_RC" ]; then
        # Check if PATH export already exists (matches either the literal
        # path or the $HOME-relative form from older installs).
        if grep -qF "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null ||
           grep -q 'export PATH="\$HOME/\.local/bin:\$PATH"' "$SHELL_RC" 2>/dev/null; then
            echo "✓ PATH already configured in $SHELL_RC"
            PATH_SETUP_SUCCESS=true
        else
            if { echo "" >> "$SHELL_RC" && \
                 echo "# Added by koda installer" >> "$SHELL_RC" && \
                 echo "$PATH_EXPORT_LINE" >> "$SHELL_RC"; } 2>/dev/null; then
                echo "✓ Added to $SHELL_RC"
                PATH_SETUP_SUCCESS=true
            else
                echo "⚠️  Could not write to $SHELL_RC (permission denied)"
            fi
        fi
    else
        echo "⚠️  Could not detect or create a shell configuration file"
    fi
else
    echo "✓ $INSTALL_DIR is already in your PATH"
    PATH_SETUP_SUCCESS=true
fi

# Also try to symlink into a system-wide bin when running as root, so the
# binary is immediately usable without touching PATH at all. This is a belt-
# and-suspenders measure for WSL/container environments where shell configs
# don't reliably get sourced.
SYSTEM_SYMLINK=""
if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then
    for sys_bin in /usr/local/bin /usr/bin; do
        if [ -d "$sys_bin" ] && [ -w "$sys_bin" ]; then
            if ln -sf "$INSTALL_DIR/koda" "$sys_bin/koda" 2>/dev/null; then
                SYSTEM_SYMLINK="$sys_bin/koda"
                echo "✓ Also linked into $sys_bin/koda (system-wide)"
                break
            fi
        fi
    done
fi

# Show appropriate next steps based on PATH setup result
echo ""
if [ "$PATH_SETUP_SUCCESS" = true ]; then
    if [ -n "$SHELL_RC" ] && [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo "⚠️  Please restart your shell or run:"
        echo "  source $SHELL_RC"
        echo ""
    fi
else
    echo "==========================================="
    echo "  Manual PATH Setup Required"
    echo "==========================================="
    echo ""
    echo "Koda was installed successfully, but PATH could not be configured automatically."
    echo ""
    echo "Run this in your current shell to use koda right now:"
    echo ""
    echo "  $PATH_EXPORT_LINE"
    echo ""
    echo "And add the same line to your shell config file to make it permanent:"
    case "$OS" in
        linux)
            echo "  - ~/.bashrc (Bash)"
            echo "  - ~/.zshrc  (Zsh)"
            echo "  - ~/.profile (sh/dash/ksh)"
            ;;
        macos)
            echo "  - ~/.zshrc     (default on macOS Catalina+)"
            echo "  - ~/.zprofile  (Zsh login shell)"
            echo "  - ~/.bash_profile (Bash)"
            ;;
        windows)
            echo "  - ~/.bashrc (Git Bash / MSYS2 / Cygwin)"
            ;;
    esac
    echo ""
    echo "Or just run koda directly via its full path:"
    echo "  $INSTALL_DIR/koda"
    echo ""
fi

echo "To get started:"
if [ -n "$SYSTEM_SYMLINK" ]; then
    echo "  1. Run: koda    (available now — no restart needed)"
elif [ "$PATH_SETUP_SUCCESS" = true ] && [ -n "$SHELL_RC" ]; then
    echo "  1. Restart your shell or run: source $SHELL_RC"
    echo "  2. Run: koda"
else
    echo "  1. Run this in your current shell:  $PATH_EXPORT_LINE"
    echo "  2. Run: koda"
    echo "  (Or use the full path directly: $INSTALL_DIR/koda)"
fi
echo "  - Authenticate: /auth"
echo "  - Analyze project: /init"
echo "  - Get help: /help"
echo ""
echo "You'll need API credentials from $API_URL (API Keys tab)"
echo ""
