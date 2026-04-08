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
- Webapp (port 3001) - Main management UI
- Chat (port 3002) - Lightweight chat-only UI
- Base model containers (llamacpp, vllm)

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
./reload.sh all                 # Rebuild and restart all services

# Examples
./reload.sh webapp              # After code changes to webapp
```

**Use Cases:**
- Code changes to webapp
- Apply configuration changes

### Reset System

System reset with various options:

```bash
# Basic reset (preserves models)
./reset.sh

# Reset with options
./reset.sh --rebuild            # Reset and rebuild all images from scratch
./reset.sh --full               # Full factory reset (removes EVERYTHING including models)
./reset.sh --full -f            # Full factory reset without prompts
```

**Reset Levels:**

| Option | Models | Webapp Users | API Keys |
|--------|--------|--------------|----------|
| `./reset.sh` | KEPT | Removed | Removed |
| `./reset.sh --full` | Removed | Removed | Removed |

**Warning:** The `--full` flag will permanently delete all downloaded models!

### Update Webapp

Quick rebuild of webapp only (faster than full rebuild):

```bash
./update.sh
```

Rebuilds and restarts only the webapp service without affecting running models.

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

# Detailed container inspection
docker inspect webapp
```

### View Logs

```bash
# Follow logs (real-time)
docker compose logs -f webapp         # Webapp logs
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
netstat -tulpn | grep 8001            # First model instance

# Check port conflicts
lsof -i :3001

# Test HTTPS endpoints
curl -sk https://localhost:3001
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

### Setup & Configuration

```bash
# Install Koda CLI
curl -sk https://localhost:3001/api/cli/install | bash

# Start Koda
koda

# Authenticate with API credentials
/auth                           # Interactive setup (URL, key, secret)

# Initialize project analysis
/init                           # Analyzes project and creates koda.md context

# Create project directory
/project <name>                 # Creates a project directory structure
/project my_app
/project data_analysis

# Show current working directory
/cwd                            # Displays CWD and first 10 items
```

### Mode & Web Search

```bash
# Switch modes
/mode standalone                # Direct chat with AI (default)
/mode agent                     # Agent-specific context mode
/mode agent collab              # Multi-agent collaboration mode

# Combine mode with web search
/mode standalone,websearch      # Chat mode with web search enabled
/mode agent,websearch           # Agent mode with web search enabled

# Toggle web search independently
/web                            # Toggle web search on/off
/websearch                      # Alias for /web
/ws                             # Short alias for /web
```

### Working Files & Focus

```bash
# View files in working set
/files                          # Shows files currently in context

# Add/remove files from working set
/add-file <path>                # Add file to context
/add-file ./src/index.js
/remove-file <path>             # Remove file from context

# Focus on specific file
/focus <path>                   # Set focus to a file
/clear-focus                    # Clear file focus
```

### Code Analysis & Refactoring

```bash
# Code quality analysis
/quality <path>                 # Analyze code quality metrics
/quality ./src/app.js

# Refactoring commands
/refactor extract <path>        # Extract code suggestions
/refactor rename <path>         # Rename suggestions
/refactor move <path>           # Move suggestions
```

### Search & Documentation

```bash
# Web search (requires /web enabled or ,websearch in mode)
/search <query>                 # Search the web
/search react hooks tutorial

# Documentation lookup
/docs <topic>                   # Fetch documentation
/docs express middleware
```

### Session Management

```bash
# Clear chat history
/clear                          # Clears visible chat history

# Clear context but keep history visible
/clearsession                   # Resets session context, keeps history

# Exit Koda
/quit                           # Exit the CLI
/exit                           # Alias for /quit
```

### Chat Features

**Live Command Completion:**
- Type `/` to see inline grayed suggestions
- Press TAB to complete commands
- Press TAB to cycle through mode options (`/mode ` + TAB)

**Context Window Display:**
- Status bar shows: `Context: used/limit`
- Color-coded warnings (yellow: 80%, red: 95%)

**Autonomous Skill Execution:**
- AI executes skills automatically when needed
- Format: `[SKILL:skill_name(param="value")]`
- Works in standalone, agent, and collab modes
- 77 built-in skills across 20 categories including:
  - File operations (create, read, update, delete, list)
  - Email parsing (.eml and .msg) with nested attachment extraction
  - PDF generation and reading
  - Web scraping with Scrapling (CAPTCHA evasion) and Playwright
  - OCR for images and scanned documents (Tesseract)
  - Git operations (status, diff, log)
  - System info and process management
  - And more...

**Web-Dependent Skills:**
The following skills require `/web` mode to be enabled:
- `threat_intel` - Query threat intelligence sources
- `web_search` - Search the web (uses Scrapling for CAPTCHA evasion)
- `playwright_fetch` - Fetch JS-rendered pages
- `playwright_interact` - Interact with web pages

**Web Search Fallback Chain:**
When performing web searches, the system uses a multi-engine fallback:
1. **DuckDuckGo** (primary) - Fast, no authentication required
2. **Scrapling** - CAPTCHA-evading fallback using StealthyFetcher
3. **Brave Search** - Secondary fallback with less aggressive bot detection
4. **Playwright** - Final fallback for JS-rendered content

---

## Chat UI Features

The Chat UI (https://localhost:3002) includes several intelligent features that can be toggled via buttons in the input bar.

### Web Search Toggle (Globe Icon)

When enabled, the AI will search the web for relevant information before responding:
- Click the globe icon (🌐) to toggle
- Searches multiple engines (DuckDuckGo, Scrapling, Brave Search)
- Results are included as context for the model

### URL Fetch Toggle (Link Icon)

When enabled, URLs pasted in your message will be automatically fetched and included as context:
- Click the link icon (🔗) to toggle
- Automatically detects URLs in your message (up to 3 per message)
- Fetches page content using Scrapling/Playwright/axios fallback chain
- Direct file download for known file types (PDF, DOCX, XLSX, CSV, etc.) - up to 50,000 chars
- HTML page content up to 12,000 chars per URL
- Fetched content is included in the model context
- Map-reduce chunking handles overflow if content exceeds model context window

**Example usage:**
```
[URL fetch enabled]
User: Summarize this article: https://example.com/news/article

The system will:
1. Detect the URL
2. Fetch the page content
3. Include the content as context
4. Model responds with a summary of the actual article
```

### File Attachments (Paperclip Icon)

Upload files to include in the conversation:
- Images (PNG, JPG, etc.) - sent to vision-capable models with OCR text extraction
- Documents (PDF, DOCX, TXT, MD)
- Email files (.eml, .msg) with nested attachment extraction
- Code files (JS, PY, etc.)
- Drag-and-drop or click to browse
- GIF/BMP/TIFF images auto-converted to PNG for vision API compatibility

### Clipboard Image Paste

Paste images directly from your clipboard into the chat:
- Screenshots (PrtSc/Cmd+Shift+4) paste automatically
- Copied images from other applications paste automatically
- Pasted images are uploaded as file attachments with OCR text extraction
- Non-vision models receive OCR-extracted text instead of the image

### Paste-as-File (Large Text)

When pasting 500+ characters, text is automatically converted to a file attachment:
- Creates a `pasted-text-{timestamp}.txt` file
- Keeps the chat input clean for large pastes (code blocks, logs, documents)
- Short pastes (< 500 chars) work normally as inline text

### Vision Model Support

Send images to vision-capable models:
- Images included using OpenAI vision format (base64 data URLs)
- Non-vision models automatically receive OCR-extracted text instead
- Prevents errors when switching between vision and non-vision models

### Thinking Model Support

Models that use `<think>` tags (Qwen, DeepSeek R1, etc.):
- Reasoning content displayed in a collapsible "thinking" area
- Supports both streaming and final message processing
- Continue button for length-limited responses

### Chat Layouts

Select from 7 layout options in Settings:
- **Default** - Classic chat layout
- **Centered** - Messages centered
- **Wide** - Full width messages
- **Timeline** - Vertical timeline flow
- **Terminal** - Monospace, flat style
- **Slack** - Flat, left-aligned messages
- **Minimal** - Clean dividers, no bubbles
- Slack/Minimal layouts include a Message Borders slider (0-40%)

### Themes

20 themes available in Settings:
- **Standard**: dark, light, midnight
- **Nature**: ocean, sunset, sand
- **Warm Tones**: copper, vesper
- **Neutral**: slate, storm
- **Dev Classics**: solarized, kanagawa, palenight, ayu
- **Vibrant**: matrix, andromeda, poimandres, oxocarbon, crimson, synthwave

### Background Streaming

If you refresh the page or switch conversations during model generation:
- The server continues processing in the background
- Response is saved to the conversation when complete
- You see the completed response when returning to the conversation

### Auto-Continuation

When a model response is cut off due to length limits:
- Server automatically continues generation (up to 8 times)
- Continue button shown as fallback UI
- Partial responses preserved if continuation fails

### System Prompts (Document Icon)

Select from saved system prompts to customize the AI's behavior:
- Click the scroll icon to select a prompt
- Create/edit prompts in Settings

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
lsof -i :3001
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

### SSL/TLS Corporate Proxy Issues

Corporate networks often use SSL inspection (MITM proxies) that break certificate verification.

**Symptoms:**
- `curl: (60) SSL certificate problem: unable to get local issuer certificate`
- `UNABLE_TO_VERIFY_LEAF_SIGNATURE` errors
- Web search/URL fetch failures

**Auto-detection:**
```bash
# build.sh automatically detects SSL inspection and configures bypass
./build.sh
```

**Manual bypass:**
```bash
# Option 1: One-time (for current session)
NODE_TLS_REJECT_UNAUTHORIZED=0 ./start.sh

# Option 2: Persistent (add to .env)
echo "NODE_TLS_REJECT_UNAUTHORIZED=0" >> .env
docker compose up -d webapp

# Option 3: Test manually in container
docker compose exec webapp bash -c 'NODE_TLS_REJECT_UNAUTHORIZED=0 python3 /usr/src/app/services/scrapling_fetch.py --action fetch --url "https://example.com"'
```

**When bypass is active, logs show:**
```
[SSL] Corporate proxy bypass enabled - SSL verification disabled
[Scrapling] SSL bypass enabled for corporate proxy environment
[Scrapling] curl_cffi SSL verification disabled
```

**Note:** SSL bypass only activates when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Normal environments use standard SSL verification.

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

The `.env` file in project root configures runtime behavior. It's gitignored and auto-created by `build.sh` when needed.

**Available Settings:**

| Variable | Default | Description |
|----------|---------|-------------|
| `HUGGING_FACE_HUB_TOKEN` | (none) | HuggingFace API token for model downloads |
| `HOST_IP` | auto-detected | Host IP for container networking |
| `HOST_MODELS_PATH` | auto-detected | Override models directory path (Windows+WSL) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` to bypass SSL verification (corporate proxies) |
| `SESSION_SECRET` | auto-generated | Session encryption key |

**Example .env files:**

```bash
# Minimal (most users)
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx

# Corporate network with SSL inspection
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
NODE_TLS_REJECT_UNAUTHORIZED=0

# Windows+WSL with custom paths
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
HOST_MODELS_PATH=/mnt/d/models
HOST_IP=192.168.1.100

# Full example with all options
HUGGING_FACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
NODE_TLS_REJECT_UNAUTHORIZED=0
HOST_IP=192.168.1.100
HOST_MODELS_PATH=/mnt/d/models
SESSION_SECRET=my-custom-secret-key
```

**Applying changes:**
```bash
# After editing .env, restart services
docker compose up -d webapp
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
docker compose restart webapp
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
- Check logs: `docker compose logs -f`
- GitHub Issues: Report bugs and request features
