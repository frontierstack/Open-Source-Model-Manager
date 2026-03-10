#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  OpenSourceModelManager Reset - Clean Slate"
echo "=========================================="
echo ""

# Parse arguments
FORCE_RESET=false
REBUILD_IMAGES=false
FULL_WIPE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_RESET=true
            shift
            ;;
        --rebuild)
            REBUILD_IMAGES=true
            shift
            ;;
        --full)
            FULL_WIPE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -f, --force        Skip confirmation prompts"
            echo "  --rebuild          Rebuild Docker images from scratch"
            echo "  --full             Full factory reset (removes EVERYTHING including models)"
            echo "  -h, --help         Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                      # Reset API keys, settings, users"
            echo "  $0 --full -f            # Complete factory reset (no prompts)"
            echo "  $0 --rebuild            # Reset and rebuild all Docker images"
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
    if [ "$FULL_WIPE" = true ]; then
        echo "WARNING: This is a FULL FACTORY RESET!"
        echo "This will permanently delete:"
        echo "  - All downloaded models"
        echo "  - All user accounts"
        echo "  - All API keys and sessions"
        echo "  - All agents, skills, and tasks"
        echo ""
        read -p "Are you absolutely sure? Type 'YES' to confirm: " -r
        echo ""
        if [ "$REPLY" != "YES" ]; then
            echo "Reset cancelled."
            exit 0
        fi
    else
        read -p "This will remove ALL API keys, settings, and llama.cpp instances. Continue? [y/N] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Reset cancelled."
            exit 0
        fi
    fi
fi

echo ""
echo ">>> Step 1: Stopping all services..."

# Stop all llama.cpp instances
echo ">>> Stopping llama.cpp instances..."
docker ps --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker ps -a --filter "name=llamacpp-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true

# Stop all vLLM instances
echo ">>> Stopping vLLM instances..."
docker ps --filter "name=vllm-" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker ps -a --filter "name=vllm-" -q 2>/dev/null | xargs -r docker rm 2>/dev/null || true

# Stop docker-compose services
docker compose down 2>/dev/null || true

echo ""
echo ">>> Step 2: Removing webapp data..."
# Try both possible volume names (with and without project prefix)
docker volume rm modelserver_webapp_data 2>/dev/null || \
docker volume rm opensourcemodelmanager_webapp_data 2>/dev/null || \
docker volume rm webapp_data 2>/dev/null || true

# Handle full wipe (delete models)
if [ "$FULL_WIPE" = true ]; then
    echo ""
    echo ">>> Step 2.5: Removing all downloaded models..."

    # Remove models directory contents
    if [ -d "$PROJECT_DIR/models" ]; then
        echo ">>> Clearing models directory..."
        rm -rf "$PROJECT_DIR/models"/* 2>/dev/null || true
        rm -rf "$PROJECT_DIR/models"/.* 2>/dev/null || true
        echo ">>> Models directory cleared"
    fi

    # Also remove .modelserver directory if it exists in models
    if [ -d "$PROJECT_DIR/models/.modelserver" ]; then
        rm -rf "$PROJECT_DIR/models/.modelserver" 2>/dev/null || true
    fi

    echo ">>> All models deleted"
fi

# Rebuild images if requested
if [ "$REBUILD_IMAGES" = true ]; then
    echo ""
    echo ">>> Step 3: Rebuilding Docker images..."
    echo ">>> This may take 20-30 minutes for llama.cpp compilation..."

    # Build llamacpp base image
    docker compose --profile build-only build llamacpp --no-cache

    # Build vLLM base image
    docker compose --profile build-only build vllm --no-cache

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
            -subj "/C=US/ST=Local/L=Local/O=OpenSourceModelManager/OU=Development/CN=localhost" \
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

echo ""
echo "=========================================="
echo "  Reset Complete!"
echo "=========================================="
echo ""

if [ "$FULL_WIPE" = true ]; then
    echo "Factory reset completed. All data has been removed."
    echo ""
fi

echo "Services are running. Access URL:"
echo ""
echo "  Webapp: https://localhost:3001"
echo ""
echo "HTTP requests are automatically redirected to HTTPS."
echo ""
echo "Note: Your browser will show a security warning for the"
echo "self-signed certificate - this is expected for local development."
echo ""
