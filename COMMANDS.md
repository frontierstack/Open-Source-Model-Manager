# Command Reference

Complete command reference for Open Source Model Manager utilities, management scripts, and Koda CLI.

---

## Table of Contents

- [Service Management](#service-management)
- [Build System](#build-system)
- [Model Instance Management](#model-instance-management)
- [Monitoring & Debugging](#monitoring--debugging)
- [Koda CLI Commands](#koda-cli-commands)
- [Docker Commands](#docker-commands)
- [Troubleshooting Commands](#troubleshooting-commands)

---

## Service Management

### Start Services

```bash
./start.sh
```

Starts all services in detached mode:
- Webapp (port 3001)
- Open WebUI (port 3002)
- Base model containers (llamacpp, vllm)
- **Auto-provisions Open WebUI** with external web search configuration

**Auto-Provisioned Settings:**
- External search URL pointing to webapp's search endpoint
- RAG template with web search awareness
- Query generation template for aggressive time-sensitive searches
- Dynamic date/time injection in search results

**Note:** Only the API key needs to be set manually in Open WebUI (Admin > Settings > Web Search).

### Stop Services

```bash
./stop.sh
```

Stops all services and cleans up:
- Stops all Docker Compose services
- Removes dynamic model instances (llamacpp-*, vllm-*)
- Preserves data volumes (models, user data, sessions)

### Reload Services

Rebuild and restart services without data loss:

```bash
# Reload specific service
./reload.sh webapp              # Rebuild and restart webapp only
./reload.sh openwebui           # Update OpenWebUI to latest image
./reload.sh all                 # Rebuild and restart all services

# Examples
./reload.sh webapp              # After code changes to webapp
./reload.sh openwebui           # Update to latest Open WebUI version
```

**Use Cases:**
- Code changes to webapp
- Update Open WebUI to latest version
- Apply configuration changes

### Reset System

System reset with various options:

```bash
# Basic reset (preserves models)
./reset.sh

# Reset with options
./reset.sh --keep-openwebui     # Reset but keep Open WebUI data
./reset.sh --rebuild            # Reset and rebuild all images from scratch
./reset.sh --full               # Full factory reset (removes EVERYTHING including models)
./reset.sh --full -f            # Full factory reset without prompts

# Reset only Open WebUI
./reset-openwebui.sh            # Removes only Open WebUI data
```

**Reset Levels:**

| Option | Models | Webapp Users | Open WebUI | API Keys |
|--------|--------|--------------|------------|----------|
| `./reset.sh` | KEPT | Removed | Removed | Removed |
| `./reset.sh --keep-openwebui` | KEPT | Removed | KEPT | Removed |
| `./reset.sh --full` | Removed | Removed | Removed | Removed |

**Warning:** The `--full` flag will permanently delete all downloaded models!

### Update Webapp

Quick rebuild of webapp only (faster than full rebuild):

```bash
./update.sh
```

Rebuilds and restarts only the webapp service without affecting running models.

### Open WebUI Search Provisioning

The search provisioning script configures Open WebUI to use the webapp's external search endpoint:

```bash
# Run manually (normally runs automatically on start)
./scripts/provision-openwebui-search.sh
```

**What it configures:**
- External search engine URL: `http://host.docker.internal:3080/api/openwebui/search`
- RAG template with knowledge priority guidance (web search vs training knowledge)
- Query generation template that aggressively searches for time-sensitive queries
- Result count: 5 results per search

**Features:**
- **Dynamic Date/Time**: Every search includes current date/time in results
- **Smart Query Generation**: Automatically searches for date, time, news, current events
- **Knowledge Priority**: Model knows when to use search vs built-in knowledge
- **No Disclaimers**: Model won't claim it "can't search the web"

**Manual API Key Setup:**
After provisioning, set the API key in Open WebUI:
1. Admin > Settings > Web Search
2. Enter your API key (from webapp's API Keys tab)

---

## Build System

### Basic Build

```bash
# Build all images (parallel mode, incremental)
./build.sh

# View all options
./build.sh --help
```

### Build Options

```bash
# Parallel vs Sequential
./build.sh                      # Default: parallel builds (saves ~10-15 min)
./build.sh --no-parallel        # Sequential builds (for low RAM systems)

# Cache Control
./build.sh --no-cache           # Force rebuild without Docker cache
./build.sh --no-cleanup         # Skip Docker build cache cleanup after build

# Build State
./build.sh --no-resume          # Start fresh (ignore previous build state)
./build.sh --retry 5            # Set retry attempts on failure (default: 2)

# Combined Examples
./build.sh --no-parallel        # Sequential builds for low memory
./build.sh --no-cache --no-resume  # Complete fresh rebuild
./build.sh --retry 3            # Allow 3 retry attempts per image
```

### Build Features

- **Incremental Builds**: Automatically skips images that already exist
- **Build State Tracking**: Saves checksums in `.build-state/` directory
- **Dockerfile Change Detection**: Rebuilds only when Dockerfiles are modified
- **Parallel Builds**: Builds llamacpp and vllm simultaneously (default)
- **Resume Capability**: Interrupted builds automatically resume
- **Retry Logic**: Automatically retries failed builds (configurable)

### Build State Management

```bash
# Clear corrupted build state
rm -rf .build-state/

# Force rebuild all images
./build.sh --no-cache --no-resume

# Resume interrupted build
./build.sh                      # Automatically resumes
```

---

## Model Instance Management

### List Running Instances

```bash
# List all model instances
docker ps --filter "name=llamacpp"    # llama.cpp instances only
docker ps --filter "name=vllm"        # vLLM instances only
docker ps                             # All containers
```

### View Instance Logs

```bash
# Follow logs in real-time
docker logs -f llamacpp-{modelName}   # llama.cpp
docker logs -f vllm-{modelName}       # vLLM

# View last 100 lines
docker logs --tail 100 llamacpp-{modelName}

# View logs since specific time
docker logs --since 30m llamacpp-{modelName}
```

### Stop Instance

```bash
# Stop specific instance
docker stop llamacpp-{modelName}      # llama.cpp
docker stop vllm-{modelName}          # vLLM

# Stop all model instances
docker ps --filter "name=llamacpp" -q | xargs docker stop
docker ps --filter "name=vllm" -q | xargs docker stop
```

### Instance Resource Usage

```bash
# Real-time resource monitoring
docker stats llamacpp-{modelName}     # Single instance
docker stats                          # All containers

# One-time stats
docker stats --no-stream llamacpp-{modelName}
```

### Test Instance Health

```bash
# Test instance endpoint
curl http://localhost:8001/health

# Test model completion
curl http://localhost:8001/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "max_tokens": 10}'
```

---

## Monitoring & Debugging

### Service Status

```bash
# Check all services
docker compose ps

# Check specific service
docker compose ps webapp
docker compose ps openwebui

# Detailed container inspection
docker inspect webapp
```

### View Logs

```bash
# Follow logs (real-time)
docker compose logs -f webapp         # Webapp logs
docker compose logs -f openwebui      # Open WebUI logs
docker compose logs -f                # All services

# View last 100 lines
docker compose logs --tail 100 webapp

# View logs since specific time
docker compose logs --since 30m webapp

# Search logs
docker compose logs webapp | grep ERROR
docker compose logs webapp | grep -i "session"
```

### GPU Monitoring

```bash
# Real-time GPU monitoring
nvidia-smi                            # One-time snapshot
watch -n 1 nvidia-smi                 # Update every 1 second

# GPU process list
nvidia-smi pmon

# GPU utilization history
nvidia-smi dmon
```

### Network & Port Checks

```bash
# Check listening ports
netstat -tulpn | grep 3001            # Webapp
netstat -tulpn | grep 3002            # Open WebUI
netstat -tulpn | grep 8001            # First model instance

# Check port conflicts
lsof -i :3001
lsof -i :3002

# Test HTTPS endpoints
curl -sk https://localhost:3001
curl -sk https://localhost:3002
```

### Disk Usage

```bash
# Docker disk usage
docker system df

# Model storage usage
du -sh /home/webapp/lmstudio/models
du -sh /home/webapp/lmstudio/webapp/models

# Container volume usage
docker volume ls
docker volume inspect lmstudio_webapp_data
```

### Container Shell Access

```bash
# Access webapp shell
docker compose exec webapp bash

# Access running model instance
docker exec -it llamacpp-{modelName} sh
docker exec -it vllm-{modelName} bash

# Run commands in container
docker compose exec webapp ls -la /models
docker compose exec webapp cat /etc/os-release
```

---

## Koda CLI Commands

### Setup & Authentication

```bash
# Install Koda CLI
curl -sk https://localhost:3001/api/cli/install | bash

# Start Koda
koda

# Authenticate
/auth                           # Enter API credentials from webapp

# Initialize project analysis
/init                           # Creates koda.md with project context

# Check connection status
/status
```

### Mode Selection

```bash
/mode standalone                # Direct chat with AI (default)
/mode agent                     # Agent-specific context mode
/mode collab                    # Multi-agent collaboration mode
/mode standalone,websearch      # Chat mode with web search enabled
/mode agent,websearch           # Agent mode with web search enabled
```

### Agent Management

```bash
# List all agents
/agents

# Create new agent (interactive)
/create-agent

# View agent details
/agents                         # Shows ID, name, model, description
```

### Skills & Tasks

```bash
# List available skills
/skills

# List tasks
/tasks                          # All tasks
/tasks [agentId]                # Tasks for specific agent
```

### File Operations

```bash
# Read file
/file-read <path>
/file-read ./src/index.js
/file-read /home/user/document.txt

# Write file
/file-write <path> <content>
/file-write ./test.txt "Hello World"
/file-write ./config.json '{"key": "value"}'

# Delete file
/file-delete <path>
/file-delete ./temp.log
```

### Session Management

```bash
# Clear chat history
/clear

# Clear context but keep history visible
/clearsession

# Exit Koda
/quit
```

### Chat Features

**TAB Autocomplete:**
- Press TAB to cycle through commands
- Press TAB after partial command to autocomplete

**Command Menu:**
- Type `/` to see available commands
- Commands are color-coded by category

**Context Window Display:**
- Status bar shows: `Context: used/limit`
- Color-coded warnings (yellow: 80%, red: 95%)

**Autonomous Skill Execution:**
- AI can execute skills directly
- Format: `[SKILL:skill_name(param="value")]`
- Works in standalone, agent, and collab modes
- 55+ built-in skills including:
  - File operations (create, read, update, delete, list)
  - Email parsing (.eml and .msg Outlook format)
  - PDF generation and reading
  - Web scraping with Playwright
  - System commands (bash, PowerShell)
  - Git operations
  - And more...

---

## Docker Commands

### Container Management

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# Restart specific service
docker compose restart webapp
docker compose restart openwebui

# Remove all containers (preserves volumes)
docker compose down
```

### Image Management

```bash
# List images
docker images

# Remove unused images
docker image prune

# Remove specific image
docker rmi modelserver-webapp:latest
docker rmi modelserver-llamacpp:latest
docker rmi modelserver-vllm:latest

# Force remove image
docker rmi -f modelserver-webapp:latest
```

### Volume Management

```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect lmstudio_webapp_data

# Remove unused volumes
docker volume prune

# Backup volume
docker run --rm -v lmstudio_webapp_data:/data -v $(pwd):/backup \
  ubuntu tar czf /backup/webapp-data-backup.tar.gz /data
```

### Build Commands

```bash
# Build specific service
docker compose build webapp
docker compose build openwebui

# Build with no cache
docker compose build --no-cache webapp

# Build base images manually
docker build -t modelserver-llamacpp:latest ./llamacpp
docker build -t modelserver-vllm:latest ./vllm
docker build -t modelserver-webapp:latest ./webapp
```

### Cleanup

```bash
# Remove all stopped containers
docker container prune

# Remove all unused images
docker image prune -a

# Remove all unused volumes
docker volume prune

# Full system cleanup
docker system prune -a --volumes
```

---

## Troubleshooting Commands

### Webapp Crashes

**Check logs for errors:**
```bash
docker compose logs --tail 200 webapp | grep -i error
docker compose logs --tail 200 webapp | grep -i exception
```

**Check session corruption:**
```bash
# Delete corrupted sessions inside container
docker compose exec webapp bash -c "rm -rf /models/.modelserver/sessions/*"

# Restart webapp
docker compose restart webapp
```

**Monitor webapp stability:**
```bash
# Watch logs in real-time
docker compose logs -f webapp

# Check if webapp is responding
curl -sk https://localhost:3001/api/models
```

### Model Won't Load

**Check instance logs:**
```bash
docker logs llamacpp-{modelName}      # Look for OOM errors
docker logs vllm-{modelName}
```

**Common issues:**
```bash
# OOM (Out of Memory) - Reduce GPU layers
# Edit launch settings: GPU Layers = 20 (instead of -1)

# Wrong backend - Switch in Launch Settings UI
# llama.cpp: Maxwell 5.2+ (GTX 900+)
# vLLM: Pascal 6.0+ (GTX 1000+)
```

**Test model manually:**
```bash
curl http://localhost:8001/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Test", "max_tokens": 5}'
```

### GPU Not Detected

**Check GPU access:**
```bash
# Test GPU in container
docker run --rm --runtime=nvidia nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi

# Check GPU status
nvidia-smi

# Verify NVIDIA Container Toolkit
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

**If GPU not detected:**
```bash
# Reinstall NVIDIA Container Toolkit
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
```

### Build Failures

**Resume interrupted build:**
```bash
./build.sh                      # Automatically resumes
```

**Clear corrupted build state:**
```bash
rm -rf .build-state/
./build.sh
```

**Out of memory during build:**
```bash
./build.sh --no-parallel        # Build sequentially
```

**Force complete rebuild:**
```bash
./build.sh --no-cache --no-resume
```

**Increase retry attempts:**
```bash
./build.sh --retry 5
```

### Port Conflicts

**Check what's using ports:**
```bash
netstat -tulpn | grep 3001
netstat -tulpn | grep 3002
lsof -i :3001
lsof -i :3002
```

**Kill process using port:**
```bash
# Find PID
lsof -ti :3001

# Kill process
kill -9 $(lsof -ti :3001)
```

**Change ports (edit docker-compose.yml):**
```yaml
services:
  webapp:
    ports:
      - "3001:3001"   # Change first number (host port)
```

### Koda CLI Issues

**Koda command not found:**
```bash
# Add to PATH
export PATH="$HOME/.local/bin:$PATH"

# Make permanent
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Reinstall
curl -sk https://localhost:3001/api/cli/install | bash
```

**Authentication fails:**
```bash
# Generate new API key in webapp (API Keys tab)
# Run /auth in Koda
# Enter new credentials
```

**Connection refused:**
```bash
# Check webapp is running
docker compose ps webapp

# Check HTTPS endpoint
curl -sk https://localhost:3001

# Restart webapp
docker compose restart webapp
```

### Download Failures

**Check download logs:**
```bash
docker compose logs -f webapp | grep -i download
```

**HuggingFace authentication:**
```bash
# Verify token in .env file
cat .env | grep HUGGING_FACE_HUB_TOKEN

# Test token
curl -H "Authorization: Bearer $HUGGING_FACE_HUB_TOKEN" \
  https://huggingface.co/api/whoami
```

**Disk space:**
```bash
df -h /home/webapp/lmstudio/models
du -sh /home/webapp/lmstudio/models/*
```

### Performance Issues

**Check resource usage:**
```bash
# Container resources
docker stats

# GPU usage
nvidia-smi

# System resources
htop
free -h
```

**Optimize model settings:**
```bash
# In Launch Settings UI:
# - Enable Flash Attention
# - Use q8_0 or q4_0 cache type
# - Reduce context size (4096 -> 2048)
# - Reduce parallel slots (8 -> 1)
# - Reduce batch size
```

**Check logs for bottlenecks:**
```bash
docker compose logs webapp | grep -i slow
docker compose logs webapp | grep -i timeout
docker logs llamacpp-{modelName} | grep -i performance
```

---

## Advanced Usage

### Custom Docker Compose

```bash
# Use custom compose file
docker compose -f docker-compose.custom.yml up -d

# Override specific service
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

### Environment Variables

```bash
# Edit .env file
nano .env

# Add variables
HUGGING_FACE_HUB_TOKEN=hf_xxx
SESSION_SECRET=your-secret
HOST_IP=192.168.1.100

# Restart services to apply
docker compose down
docker compose up -d
```

### Database Backup

```bash
# Backup user data
docker compose exec webapp bash -c "tar czf /tmp/backup.tar.gz /models/.modelserver"
docker cp webapp:/tmp/backup.tar.gz ./webapp-backup-$(date +%Y%m%d).tar.gz

# Restore
docker cp ./webapp-backup.tar.gz webapp:/tmp/backup.tar.gz
docker compose exec webapp bash -c "tar xzf /tmp/backup.tar.gz -C /"
```

### SSL Certificate Renewal

```bash
# Generate new certificates
cd certs/
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout server.key -out server.crt \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

# Restart services
docker compose restart webapp openwebui
```

---

## Tips & Best Practices

### Performance

- Use **llama.cpp** for Maxwell 5.2+ GPUs (GTX 900, Quadro M series)
- Use **vLLM** for Pascal 6.0+ GPUs (GTX 1000+, Quadro P series)
- Enable Flash Attention for memory savings
- Use q8_0/q4_0 cache for low VRAM
- Monitor GPU with `watch -n 1 nvidia-smi`

### Debugging

- Always check logs first: `docker compose logs -f webapp`
- Test instances: `curl http://localhost:8001/health`
- Use `docker stats` to monitor resource usage
- Check GPU: `nvidia-smi`

### Maintenance

- Regularly clean Docker: `docker system prune`
- Monitor disk space: `df -h`
- Backup user data before major updates
- Keep HuggingFace token updated in .env

### Development

- Use `./reload.sh webapp` for quick webapp updates
- Use `./update.sh` for even faster webapp rebuilds
- Test changes with `docker compose logs -f webapp`
- Access container: `docker compose exec webapp bash`

---

## Support

For additional help:
- Check the main README.md for overview and setup
- Review CLAUDE.md for technical details
- Check logs: `docker compose logs -f`
- GitHub Issues: Report bugs and request features
