#!/bin/bash

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "lmstudio Reload Script"
echo "=========================================="
echo "This will rebuild and restart services without data loss"
echo ""

# Check what to reload
if [ "$1" == "webapp" ]; then
    echo "Reloading webapp only..."
    ./update.sh
    exit 0
fi

if [ "$1" == "openwebui" ]; then
    echo "Reloading OpenWebUI only..."
    echo ""
    echo "Step 1: Stopping OpenWebUI..."
    docker compose stop open-webui

    echo ""
    echo "Step 2: Removing OpenWebUI container..."
    docker compose rm -f open-webui

    echo ""
    echo "Step 3: Pulling latest OpenWebUI image..."
    docker pull ghcr.io/open-webui/open-webui:main

    echo ""
    echo "Step 4: Starting OpenWebUI..."
    docker compose up -d open-webui

    echo ""
    echo "OpenWebUI reloaded!"
    echo "Access at: http://localhost:3002"
    exit 0
fi

if [ "$1" == "all" ]; then
    echo "Reloading all services..."
    echo ""
    echo "Step 1: Stopping all services..."
    docker compose down

    echo ""
    echo "Step 2: Rebuilding webapp..."
    docker compose build webapp

    echo ""
    echo "Step 3: Pulling latest OpenWebUI..."
    docker pull ghcr.io/open-webui/open-webui:main

    echo ""
    echo "Step 4: Starting all services..."
    docker compose up -d

    echo ""
    echo "Step 5: Displaying logs..."
    sleep 5
    docker compose logs webapp --tail 30

    echo ""
    echo "All services reloaded!"
    exit 0
fi

# Default: show usage
echo "Usage:"
echo "  ./reload.sh webapp     - Rebuild and restart webapp only (quick)"
echo "  ./reload.sh openwebui  - Restart OpenWebUI with latest image"
echo "  ./reload.sh all        - Rebuild and restart all services"
echo ""
echo "Examples:"
echo "  ./reload.sh webapp     # After code changes"
echo "  ./reload.sh openwebui  # Update OpenWebUI to latest"
echo "  ./reload.sh all        # Full reload (preserves data)"
echo ""
