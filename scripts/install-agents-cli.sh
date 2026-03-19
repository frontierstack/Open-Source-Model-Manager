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

# Get API URL from environment (set by server) or use localhost as fallback
API_URL="${KODA_API_URL:-https://localhost:3001}"
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
    # First check based on current shell
    if [ -n "$ZSH_VERSION" ]; then
        # Zsh user
        if [ -f "$HOME/.zshrc" ]; then
            echo "$HOME/.zshrc"
            return
        elif [ -f "$HOME/.zprofile" ]; then
            echo "$HOME/.zprofile"
            return
        fi
    elif [ -n "$BASH_VERSION" ]; then
        # Bash user - check OS for appropriate config
        if [ "$OS" = "macos" ]; then
            # macOS prefers .bash_profile for login shells
            if [ -f "$HOME/.bash_profile" ]; then
                echo "$HOME/.bash_profile"
                return
            elif [ -f "$HOME/.bashrc" ]; then
                echo "$HOME/.bashrc"
                return
            elif [ -f "$HOME/.profile" ]; then
                echo "$HOME/.profile"
                return
            fi
        else
            # Linux prefers .bashrc
            if [ -f "$HOME/.bashrc" ]; then
                echo "$HOME/.bashrc"
                return
            elif [ -f "$HOME/.bash_profile" ]; then
                echo "$HOME/.bash_profile"
                return
            elif [ -f "$HOME/.profile" ]; then
                echo "$HOME/.profile"
                return
            fi
        fi
    fi

    # Fallback: check common files in order
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile"; do
        if [ -f "$rc" ]; then
            echo "$rc"
            return
        fi
    done

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

# Install dependencies
echo ">>> Installing dependencies..."
cd "$CLI_DIR"
if npm install --production 2>&1; then
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

# Check if install directory is in PATH and auto-add if needed
PATH_SETUP_SUCCESS=false
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ">>> Adding $INSTALL_DIR to PATH..."

    if [ -n "$SHELL_RC" ]; then
        # Check if PATH export already exists
        if ! grep -q "export PATH=\"\$HOME/.local/bin:\$PATH\"" "$SHELL_RC" 2>/dev/null; then
            # Attempt to add PATH to shell config
            if { echo "" >> "$SHELL_RC" && \
                 echo "# Added by koda installer" >> "$SHELL_RC" && \
                 echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"; } 2>/dev/null; then
                echo "✓ Added to $SHELL_RC"
                PATH_SETUP_SUCCESS=true
            else
                echo "⚠️  Could not write to $SHELL_RC (permission denied)"
            fi
        else
            echo "✓ PATH already configured in $SHELL_RC"
            PATH_SETUP_SUCCESS=true
        fi
    else
        echo "⚠️  Could not detect shell configuration file"
    fi
else
    echo "✓ $INSTALL_DIR is already in your PATH"
    PATH_SETUP_SUCCESS=true
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
    echo "Please add the following to your shell configuration file:"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    case "$OS" in
        linux)
            echo "Common config files for Linux:"
            echo "  - ~/.bashrc (Bash)"
            echo "  - ~/.zshrc (Zsh)"
            ;;
        macos)
            echo "Common config files for macOS:"
            echo "  - ~/.bash_profile (Bash)"
            echo "  - ~/.zshrc (Zsh - default on macOS Catalina+)"
            echo "  - ~/.zprofile (Zsh login shell)"
            ;;
        windows)
            echo "For Git Bash/MSYS2/Cygwin:"
            echo "  - ~/.bashrc"
            echo "  - ~/.bash_profile"
            ;;
    esac
    echo ""
    echo "After adding, restart your terminal or run: source <config-file>"
    echo ""
fi

echo "To get started:"
if [ "$PATH_SETUP_SUCCESS" = true ] && [ -n "$SHELL_RC" ]; then
    echo "  1. Restart your shell or run: source $SHELL_RC"
    echo "  2. Run: koda"
else
    echo "  1. Complete PATH setup (see instructions above)"
    echo "  2. Restart your terminal"
    echo "  3. Run: koda"
fi
echo "  - Authenticate: /auth"
echo "  - Analyze project: /init"
echo "  - Get help: /help"
echo ""
echo "You'll need API credentials from $API_URL (API Keys tab)"
echo ""
