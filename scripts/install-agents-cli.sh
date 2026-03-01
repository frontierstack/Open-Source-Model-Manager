#!/bin/bash

# koda CLI Installer (Remote)
# Supports Linux, macOS, and Windows (via WSL or Git Bash)

set -e

# Get API URL from environment (set by server) or use localhost as fallback
API_URL="${KODA_API_URL:-https://localhost:3001}"
INSTALL_DIR="$HOME/.local/bin"
CLI_DIR="$HOME/.local/lib/koda-cli"

echo "=========================================="
echo "  koda CLI Installer"
echo "=========================================="
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

# Detect shell
SHELL_RC=""
if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -n "$ZSH_VERSION" ] && [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
fi

echo "Shell config: ${SHELL_RC:-none}"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"
echo ""

# Create installation directories
echo ">>> Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$CLI_DIR"
mkdir -p "$CLI_DIR/bin"

# Download CLI files from API
echo ">>> Downloading CLI files from $API_URL..."

# Download package.json
echo "  - package.json"
curl -sk "$API_URL/api/cli/files/package.json" -o "$CLI_DIR/package.json"
if [ $? -ne 0 ]; then
    echo "Error: Failed to download package.json"
    exit 1
fi

# Download koda.js
echo "  - koda.js"
curl -sk "$API_URL/api/cli/files/koda.js" -o "$CLI_DIR/bin/koda.js"
if [ $? -ne 0 ]; then
    echo "Error: Failed to download koda.js"
    exit 1
fi

# Make executable
chmod +x "$CLI_DIR/bin/koda.js"

# Install dependencies
echo ">>> Installing dependencies..."
cd "$CLI_DIR"
npm install --production --quiet 2>&1 | grep -v "npm WARN"
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo "Warning: Some dependencies may not have installed correctly"
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
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ">>> Adding $INSTALL_DIR to PATH..."

    if [ -n "$SHELL_RC" ]; then
        # Check if PATH export already exists
        if ! grep -q "export PATH=\"\$HOME/.local/bin:\$PATH\"" "$SHELL_RC"; then
            echo "" >> "$SHELL_RC"
            echo "# Added by koda installer" >> "$SHELL_RC"
            echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
            echo "✓ Added to $SHELL_RC"
            echo ""
            echo "⚠️  Please restart your shell or run:"
            echo "  source $SHELL_RC"
            echo ""
        else
            echo "✓ PATH already configured in $SHELL_RC"
            echo ""
        fi
    else
        echo "⚠️  Could not detect shell configuration file"
        echo "Please manually add this to your shell config:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
    fi
else
    echo "✓ $INSTALL_DIR is already in your PATH"
    echo ""
fi

echo "To get started:"
echo "  1. Restart your shell or run: source $SHELL_RC"
echo "  2. Run: koda"
echo "  3. Authenticate: /auth"
echo "  4. Analyze project: /init"
echo "  5. Get help: /help"
echo ""
echo "You'll need API credentials from $API_URL (API Keys tab)"
echo ""
