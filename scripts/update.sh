#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  Model Server Update"
echo "=========================================="
echo ""

# Parse arguments
STOP_INSTANCES=false
NO_CACHE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --stop-instances)
            STOP_INSTANCES=true
            shift
            ;;
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --stop-instances   Stop running llama.cpp instances before update"
            echo "  --no-cache         Rebuild without Docker cache"
            echo "  -h, --help         Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Optionally stop llama.cpp instances
if [ "$STOP_INSTANCES" = true ]; then
    echo ">>> Stopping llama.cpp instances..."
    docker ps --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
    docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true
fi

echo ">>> Rebuilding webapp image..."
if [ "$NO_CACHE" = true ]; then
    docker compose build webapp --no-cache
else
    docker compose build webapp
fi

echo ""
echo ">>> Recreating webapp container with new image..."
docker compose up -d webapp

echo ""
echo ">>> Waiting for webapp to start..."

# Wait for webapp to be ready
MAX_RETRIES=20
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Try HTTPS first, then HTTP
    if curl -sk https://localhost:3001/api/webapp-credentials 2>/dev/null | grep -q "apiKey"; then
        break
    elif curl -s http://localhost:3001/api/webapp-credentials 2>/dev/null | grep -q "apiKey"; then
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for webapp... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
    echo ""
    echo "=========================================="
    echo "  Update Complete!"
    echo "=========================================="
    echo ""
    echo "Webapp is running at: https://localhost:3001"
    echo ""
    echo "Hard refresh your browser (Ctrl+Shift+R) to see changes."
else
    echo ""
    echo ">>> Warning: Webapp may still be starting."
    echo ">>> Check logs with: docker compose logs -f webapp"
fi
