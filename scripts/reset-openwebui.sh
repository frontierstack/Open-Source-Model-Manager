#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=== Resetting OpenWebUI ==="
echo ""
echo "This will delete OpenWebUI's database and start fresh."
echo "You'll need to create a new account after this."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
fi

echo "Stopping OpenWebUI and Nginx..."
docker compose stop open-webui nginx

echo "Removing containers..."
docker compose rm -f open-webui nginx

echo "Removing OpenWebUI data volume..."
docker volume rm modelserver_openwebui_data 2>/dev/null || true

echo "Rebuilding OpenWebUI image (ensures latest fixes)..."
docker compose build open-webui

echo "Starting services fresh..."
docker compose up -d open-webui nginx

echo "Waiting for OpenWebUI to initialize..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    STATUS=$(docker inspect --format '{{.State.Health.Status}}' modelserver-open-webui-1 2>/dev/null || echo "starting")
    if [ "$STATUS" = "healthy" ]; then
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    echo "  Still initializing... ($WAITED seconds)"
done

if [ "$STATUS" != "healthy" ]; then
    echo ""
    echo "Warning: OpenWebUI may still be starting. Check logs with:"
    echo "  docker logs modelserver-open-webui-1"
fi

echo ""
echo "=== Reset Complete! ==="
echo ""
echo "OpenWebUI is now starting fresh with the correct environment variables."
echo "Wait 10 seconds, then go to: https://localhost:3002"
echo ""
echo "You'll need to:"
echo "  1. Create a new account (first user becomes admin)"
echo "  2. The API connection should be pre-configured"
echo "  3. Your model should appear automatically"
echo ""
