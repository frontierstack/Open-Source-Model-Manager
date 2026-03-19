# Commands Reference

Quick reference for common operations in Open Source Model Manager.

## Build & Setup

```bash
# Initial build (parallel, recommended)
./build.sh

# Sequential build (low memory systems, <16GB RAM)
./build.sh --no-parallel

# Force rebuild (ignore cache)
./build.sh --no-cache --no-resume

# Resume interrupted build
./build.sh

# Build with SSL bypass (corporate networks)
NODE_TLS_REJECT_UNAUTHORIZED=0 ./build.sh
```

## Service Management

```bash
# Start all services
./start.sh

# Stop all services
./stop.sh

# Reload specific service (quick restart)
./reload.sh webapp
./reload.sh chat
./reload.sh all

# Update webapp (rebuild + restart)
./update.sh

# Reset all data (destructive)
./reset.sh
```

## Development Workflow

### After Code Changes

```bash
# Rebuild and restart (picks up code changes)
docker compose up -d --build webapp
docker compose up -d --build chat
docker compose up -d --build webapp chat  # Both

# Quick restart (NO code changes, just restart process)
docker compose restart webapp
```

### Frontend Build (on host)

```bash
# Webapp React UI
cd webapp && npm run build

# Chat React UI
cd chat && npm run build
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f webapp
docker compose logs -f chat

# Model instance logs
docker logs -f <container-name>

# Last 100 lines
docker compose logs --tail=100 webapp
```

## Environment Configuration

### .env File Options

Create `.env` in project root (gitignored):

```bash
# HuggingFace token for model downloads
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx

# SSL bypass for corporate proxy/SSL inspection
NODE_TLS_REJECT_UNAUTHORIZED=0

# Manual host IP (usually auto-detected)
HOST_IP=192.168.1.100

# Manual models path override (Windows+WSL edge cases)
HOST_MODELS_PATH=/mnt/d/models
```

### SSL/TLS Corporate Proxy Bypass

For networks with SSL inspection (MITM proxies):

```bash
# Option 1: Environment variable (one-time)
NODE_TLS_REJECT_UNAUTHORIZED=0 ./start.sh

# Option 2: Add to .env (persistent)
echo "NODE_TLS_REJECT_UNAUTHORIZED=0" >> .env
docker compose up -d webapp

# Option 3: build.sh auto-detects and configures
./build.sh  # Automatically detects SSL inspection
```

When active, logs show:
```
[SSL] Corporate proxy bypass enabled
[Scrapling] SSL bypass enabled for corporate proxy environment
```

## Troubleshooting

### Build Issues

```bash
# Clear build state
rm -rf .build-state/

# Rebuild from scratch
./build.sh --no-cache --no-resume

# Check Docker disk space
docker system df
docker system prune -a  # Clean unused images (destructive)
```

### Service Issues

```bash
# Check service status
docker compose ps

# Restart problematic service
docker compose restart webapp

# Full rebuild if issues persist
docker compose up -d --build webapp

# Check GPU access
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

### Port Conflicts

```bash
# Check what's using port 3001
netstat -tulpn | grep 3001
lsof -i :3001

# Change port in docker-compose.yml if needed
```

### Model Loading Issues

```bash
# Check webapp logs for errors
docker compose logs -f webapp | grep -i error

# Verify host path detection
docker compose logs webapp | grep "Host models path"

# Manual path override (add to .env)
HOST_MODELS_PATH=/absolute/path/to/models
```

## API Testing

```bash
# Health check
curl -sk https://localhost:3001/api/health

# List models (requires auth)
curl -sk https://localhost:3001/api/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# Chat completion
curl -sk https://localhost:3001/api/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "model": "your-model-name"}'

# URL fetch test
curl -sk https://localhost:3001/api/url/fetch \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com"]}'
```

## Koda CLI

```bash
# Install CLI
curl -sk https://localhost:3001/api/cli/install | bash

# Run CLI
koda

# CLI commands (inside koda)
/auth           # Authenticate with API key
/help           # Show all commands
/agents         # List agents
/skills         # List skills
/models         # List loaded models
```

## Docker Commands

```bash
# View running containers
docker compose ps

# Enter container shell
docker compose exec webapp bash
docker compose exec chat sh

# View container resource usage
docker stats

# Remove all stopped containers
docker container prune

# View network
docker network ls
docker network inspect modelserver_default
```

## Data Locations

| Data | Location |
|------|----------|
| Models | `./models/` |
| User data, agents, skills | `./models/.modelserver/` |
| Conversations | `./models/.modelserver/conversations/` |
| SSL certificates | `./certs/` |
| Build state | `./.build-state/` |
| Session data | `webapp_data` Docker volume |

## Quick Reference

| Task | Command |
|------|---------|
| Start services | `./start.sh` |
| Stop services | `./stop.sh` |
| Rebuild webapp | `docker compose up -d --build webapp` |
| View logs | `docker compose logs -f webapp` |
| Check GPU | `nvidia-smi` |
| Reset data | `./reset.sh` |
| SSL bypass | `NODE_TLS_REJECT_UNAUTHORIZED=0 ./start.sh` |
