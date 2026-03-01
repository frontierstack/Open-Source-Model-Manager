#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  LMStudio Reset - Clean Slate"
echo "=========================================="
echo ""

# Parse arguments
FORCE_RESET=false
KEEP_OPENWEBUI=false
REBUILD_IMAGES=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_RESET=true
            shift
            ;;
        --keep-openwebui)
            KEEP_OPENWEBUI=true
            shift
            ;;
        --rebuild)
            REBUILD_IMAGES=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -f, --force        Skip confirmation prompts"
            echo "  --keep-openwebui   Keep Open WebUI data (users, chat history)"
            echo "  --rebuild          Rebuild Docker images from scratch"
            echo "  -h, --help         Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Confirm reset
if [ "$FORCE_RESET" = false ]; then
    read -p "This will remove ALL API keys, settings, and llama.cpp instances. Continue? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Reset cancelled."
        exit 0
    fi
fi

echo ""
echo ">>> Step 1: Stopping all services..."

# Stop all llama.cpp instances
echo ">>> Stopping llama.cpp instances..."
docker ps --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true

# Stop docker-compose services
docker compose down 2>/dev/null || true

echo ""
echo ">>> Step 2: Removing webapp data..."
docker volume rm lmstudio_webapp_data 2>/dev/null || true

# Handle OpenWebUI data
if [ "$KEEP_OPENWEBUI" = false ]; then
    if [ "$FORCE_RESET" = false ]; then
        read -p "Also reset Open WebUI data (users, chat history)? [y/N] " -n 1 -r
        echo ""
    else
        REPLY="y"
    fi
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo ">>> Removing Open WebUI data volume..."
        docker volume rm lmstudio_openwebui_data 2>/dev/null || true
    fi
fi

# Rebuild images if requested
if [ "$REBUILD_IMAGES" = true ]; then
    echo ""
    echo ">>> Step 3: Rebuilding Docker images..."
    echo ">>> This may take 20-30 minutes for llama.cpp compilation..."

    # Build llamacpp base image
    docker compose --profile build-only build llamacpp --no-cache

    # Build webapp
    docker compose build webapp --no-cache
fi

# Ensure SSL certificates exist
echo ""
echo ">>> Step 3: Checking SSL certificates..."
if [ ! -f "$PROJECT_DIR/certs/server.key" ] || [ ! -f "$PROJECT_DIR/certs/server.crt" ]; then
    echo ">>> Generating SSL certificates..."
    mkdir -p "$PROJECT_DIR/certs"
    if [ -f "$PROJECT_DIR/certs/generate-certs.sh" ]; then
        chmod +x "$PROJECT_DIR/certs/generate-certs.sh"
        "$PROJECT_DIR/certs/generate-certs.sh"
    else
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout "$PROJECT_DIR/certs/server.key" \
            -out "$PROJECT_DIR/certs/server.crt" \
            -subj "/C=US/ST=Local/L=Local/O=LMStudio/OU=Development/CN=localhost" \
            -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" 2>/dev/null
        chmod 600 "$PROJECT_DIR/certs/server.key"
        chmod 644 "$PROJECT_DIR/certs/server.crt"
    fi
else
    echo ">>> SSL certificates already exist"
fi

echo ""
echo ">>> Step 4: Starting fresh services..."
docker compose up -d

echo ""
echo ">>> Step 5: Waiting for webapp to initialize..."

# Wait for webapp to be ready and fetch credentials
MAX_RETRIES=30
RETRY_COUNT=0
CREDS=""

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Try HTTPS first, then HTTP
    CREDS=$(curl -sk https://localhost:3001/api/webapp-credentials 2>/dev/null || curl -s http://localhost:3001/api/webapp-credentials 2>/dev/null || echo "")
    if [ -n "$CREDS" ] && [ "$CREDS" != "{}" ] && [ "$CREDS" != '{"error"' ]; then
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for webapp... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

# Get Bearer token from logs
echo ""
echo ">>> Step 6: Fetching credentials..."
sleep 3

BEARER_TOKEN=$(docker compose logs webapp 2>/dev/null | grep "Bearer Token:" | tail -1 | awk '{print $NF}' || echo "")

echo ""
echo "=========================================="
echo "  Reset Complete!"
echo "=========================================="
echo ""
echo "Services are running. Access URLs (all HTTPS):"
echo ""
echo "  Webapp:     https://localhost:3001"
echo "  Open WebUI: https://localhost:3002"
echo ""

if [ -n "$BEARER_TOKEN" ]; then
    echo "Open WebUI Bearer Token:"
    echo "  $BEARER_TOKEN"
    echo ""
    echo "To configure Open WebUI:"
    echo "  1. Go to https://localhost:3002"
    echo "  2. Settings -> Connections"
    echo "  3. Add OpenAI API connection:"
    echo "     - API Base URL: https://host.docker.internal:3001/v1"
    echo "     - API Key: $BEARER_TOKEN"
else
    echo "View credentials with:"
    echo "  docker compose logs webapp | grep -A5 'Bearer Token'"
fi

echo ""
echo "HTTP requests are automatically redirected to HTTPS."
echo ""
echo "Note: Your browser will show a security warning for the"
echo "self-signed certificate - this is expected for local development."
echo ""
