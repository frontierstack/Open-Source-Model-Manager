#!/bin/bash
set -e

# Resolve symlinks to get actual script location
SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  Model Server Start"
echo "=========================================="
echo ""

# Check if core images exist
echo ">>> Checking required Docker images..."
REQUIRED_IMAGES=("modelserver-webapp:latest" "modelserver-llamacpp:latest" "modelserver-vllm:latest")
MISSING_IMAGES=()

for img in "${REQUIRED_IMAGES[@]}"; do
    if [[ -z $(docker images -q $img 2>/dev/null) ]]; then
        MISSING_IMAGES+=("$img")
    fi
done

if [ ${#MISSING_IMAGES[@]} -gt 0 ]; then
    echo ""
    echo "Error: Missing required Docker images:"
    for img in "${MISSING_IMAGES[@]}"; do
        echo "  - $img"
    done
    echo ""
    echo "Please run ./build.sh to build the missing images."
    echo ""
    exit 1
fi

echo ">>> All required images found"

# Ensure SSL certificates exist
echo ""
echo ">>> Checking SSL certificates..."
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
            -subj "/C=US/ST=Local/L=Local/O=ModelServer/OU=Development/CN=localhost" \
            -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" 2>/dev/null
        chmod 600 "$PROJECT_DIR/certs/server.key"
        chmod 644 "$PROJECT_DIR/certs/server.crt"
        echo ">>> SSL certificates generated"
    fi
else
    echo ">>> SSL certificates found"
fi

echo ""
echo ">>> Starting services..."
docker compose up -d

echo ""
echo ">>> Waiting for services to start..."

# Wait for webapp to be ready
MAX_RETRIES=20
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Check if webapp is responding (HTTPS)
    if curl -sk https://localhost:3001/api/models 2>/dev/null > /dev/null; then
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 2
done

echo ""
echo "=========================================="
echo "  Model Server Started!"
echo "=========================================="
echo ""
echo "Access URLs (all HTTPS):"
echo ""
echo "  Webapp:     https://localhost:3001"
echo "  Open WebUI: https://localhost:3002"
echo ""
echo "HTTP requests are automatically redirected to HTTPS."
echo ""
echo "Note: Your browser will show a security warning for the"
echo "self-signed certificate - this is expected for local development."
echo ""
echo "View logs:    docker compose logs -f"
echo "Stop:         ./stop.sh"
echo ""
