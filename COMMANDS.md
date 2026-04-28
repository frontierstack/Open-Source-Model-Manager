# Command Reference

Complete command reference for Open Source Model Manager utilities, management scripts, and Koda CLI.

---

## Table of Contents

- [Service Management](#service-management)
- [Build System](#build-system)
- [WSL2 Setup (Windows hosts without Docker Desktop)](#wsl2-setup-windows-hosts-without-docker-desktop)
- [Model Instance Management](#model-instance-management)
- [Monitoring & Debugging](#monitoring--debugging)
- [Koda CLI Commands](#koda-cli-commands)
- [Docker Commands](#docker-commands)
- [Troubleshooting Commands](#troubleshooting-commands)

---

## Service Management

> All utility scripts (`./start.sh`, `./stop.sh`, `./reload.sh`, `./reset.sh`, `./update.sh`, `./build.sh`) require root for Docker access. Run with `sudo` — the scripts will exit immediately otherwise. The top-level names are symlinks into `scripts/`.

### Start Services

```bash
sudo ./start.sh
```

Starts all services in detached mode:
- Webapp (port 3001) - Main management UI
- Chat (port 3002) - Lightweight chat-only UI
- Base model containers (llamacpp, vllm)

### Stop Services

```bash
sudo ./stop.sh
```

Stops all services and cleans up:
- Stops all Docker Compose services
- Removes dynamic model instances (llamacpp-*, vllm-*)
- Preserves data volumes (models, user data, sessions)

### Reload Services

Rebuild and restart services without data loss:

```bash
# Reload specific service
sudo ./reload.sh webapp         # Rebuild and restart webapp only
sudo ./reload.sh all            # Rebuild and restart all services

# Examples
sudo ./reload.sh webapp         # After code changes to webapp
```

**Use Cases:**
- Code changes to webapp
- Apply configuration changes

### Reset System

System reset with various options:

```bash
# Basic reset (preserves models)
sudo ./reset.sh

# Reset with options
sudo ./reset.sh --rebuild       # Reset and rebuild all images from scratch
sudo ./reset.sh --full          # Full factory reset (removes EVERYTHING including models)
sudo ./reset.sh --full -f       # Full factory reset without prompts
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
sudo ./update.sh
```

Rebuilds and restarts only the webapp service without affecting running models.

---

## Build System

### Basic Build

```bash
# Build all images (parallel mode, incremental)
sudo ./build.sh

# View all options
sudo ./build.sh --help
```

### Build Options

```bash
# Parallel vs Sequential
sudo ./build.sh                      # Default: parallel builds (saves ~10-15 min)
sudo ./build.sh --no-parallel        # Sequential builds (for low RAM systems)

# Cache Control
sudo ./build.sh --no-cache           # Force rebuild without Docker cache
sudo ./build.sh --no-cleanup         # Skip Docker build cache cleanup after build

# Build State
sudo ./build.sh --no-resume          # Start fresh (ignore previous build state)
sudo ./build.sh --retry 5            # Set retry attempts on failure (default: 2)

# Combined Examples
sudo ./build.sh --no-parallel        # Sequential builds for low memory
sudo ./build.sh --no-cache --no-resume  # Complete fresh rebuild
sudo ./build.sh --retry 3            # Allow 3 retry attempts per image
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
sudo ./build.sh --no-cache --no-resume

# Resume interrupted build
sudo ./build.sh                 # Automatically resumes
```

---

## WSL2 Setup (Windows hosts without Docker Desktop)

`wsl-setup.sh` installs a real systemd-managed Docker Engine inside the WSL distro so `./build.sh` and the gVisor sandbox both work without Docker Desktop. It is idempotent — re-running picks up where it left off, including across the `wsl --shutdown` that's required after enabling systemd.

### Setup

```bash
sudo ./wsl-setup.sh                  # Auto-detect GPU, install gVisor, run smoke tests
sudo ./wsl-setup.sh --gpu            # Force nvidia-container-toolkit install
sudo ./wsl-setup.sh --no-gpu         # Skip GPU container toolkit
sudo ./wsl-setup.sh --no-gvisor      # Skip gVisor (runsc) runtime install
sudo ./wsl-setup.sh --no-smoke       # Skip the GPU/Docker smoke test at the end
sudo ./wsl-setup.sh --help           # Full option reference
```

The script is run from inside WSL. If systemd isn't enabled yet, the first invocation writes `/etc/wsl.conf`, prints the `wsl --shutdown` PowerShell command, and exits. Run that from PowerShell, reopen the WSL terminal, and re-run `sudo ./wsl-setup.sh`.

### Cleanup Mode

```bash
sudo ./wsl-setup.sh --cleanup        # Wipe ALL containers/images/volumes/user networks/build cache
sudo ./wsl-setup.sh --cleanup -y     # Same, no confirmation prompt
```

**Destructive** — named-volume data (Postgres dirs, model server data, etc.) is permanently lost. Asks for an explicit `yes` confirmation unless `-y`/`--yes` is passed. After cleanup, rebuild from scratch with `sudo ./build.sh --no-resume`.

### LAN Access (other computers reaching the server)

By default WSL2 runs in NAT mode — services bound to `0.0.0.0` inside WSL are reachable from the Windows host via `localhost` only, not from the LAN. To expose `:3001` and `:3002` to other machines on the network, switch WSL to mirrored networking mode.

**Requires Windows 11 build 22621+ and WSL 2.0.0+.** Verify with `wsl --version` and `winver`.

1. On the Windows host, create `%UserProfile%\.wslconfig` (PowerShell):

   ```powershell
   @"
   [wsl2]
   networkingMode=mirrored
   firewall=true
   dnsTunneling=true
   autoProxy=true

   [experimental]
   hostAddressLoopback=true
   "@ | Out-File -Encoding ASCII -NoNewline $env:USERPROFILE\.wslconfig
   ```

2. Restart WSL:

   ```powershell
   wsl --shutdown
   Start-Sleep -Seconds 10
   ```

3. Verify mirrored mode is active. Inside WSL after restart:

   ```bash
   ip -4 addr | grep inet     # should show your Windows host's LAN IP, not just 172.x
   ```

4. Open the Windows firewall (Admin PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "ModelServer 3001" -Direction Inbound `
     -LocalPort 3001 -Protocol TCP -Profile Any -Action Allow
   New-NetFirewallRule -DisplayName "ModelServer 3002" -Direction Inbound `
     -LocalPort 3002 -Protocol TCP -Profile Any -Action Allow
   ```

5. If LAN access still fails, the Hyper-V firewall (separate from Windows Defender) may be gating WSL traffic. Open it (Admin PowerShell):

   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

6. Test from another LAN machine:

   ```bash
   curl -sk https://<windows-host-ip>:3001/api/has-users
   ```

**Older Windows fallback:** If mirrored mode isn't supported, use `netsh interface portproxy add v4tov4` rules instead. WSL's NAT IP changes on each restart, so the rules need to be rebuilt at boot via Task Scheduler.

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

# Start Koda (interactive REPL)
koda

# Resume the most recent session for the current directory
koda --continue                 # Same as: koda -c
koda --continue --yolo          # Resume + skip confirmations (combinable)

# Resume a specific session by id
koda --resume <session-id>      # Same as: koda -r <id>
koda --resume                   # No id → list candidates and exit

# Single-shot prompt (CI / scripting): run one prompt, print, exit
koda -p "summarize the failing test in tests/auth_test.js"
koda --continue -p "what was the file we discussed last?"

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

**Project guidance auto-loading:** on every launch, Koda looks for `KODA.md`, `koda.md`, `CLAUDE.md`, or `AGENTS.md` (first match wins) in the current directory and injects the contents into the model's system prompt for every turn. The file is re-read each turn, so edits take effect immediately without restarting Koda. Capped at 64 KB.

### Web Capabilities

There is no longer a `/mode` system or `/web`/`/ws` toggle (removed in commit `e8f61f1`). The chat model invokes `web_search`, `fetch_url`, `crawl_pages`, `playwright_fetch`, and similar native tools on its own whenever the query warrants it.

The following slash commands are still useful for one-shot, user-initiated lookups:

```bash
# One-shot web search (returns results inline; does not toggle anything)
/search <query>                 # Search the web
/search react hooks tutorial
/websearch <query>              # Alias for /search

# One-shot documentation lookup
/docs <topic>
/docs express middleware
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

### Session Management

```bash
# Clear chat history
/clear                          # Clears visible chat history

# Clear context but keep history visible
/clearsession                   # Resets session context, keeps history

# Cross-session persistence (auto — every assistant turn is saved)
/sessions                       # List saved sessions for the current directory
/resume <id>                    # Restore a session in-place (REPL)
                                # — also: relaunch with `koda --resume <id>`

# Cross-session memory (~/.koda/memory.md, plain markdown)
/memory                         # Show current memory file
/memory add <note>              # Append a note Koda will read on every launch
/memory clear                   # Wipe ~/.koda/memory.md
/memory edit                    # Print the file path so you can edit directly

# Approval-free mode (toggle in-session)
/yolo                           # Skip every confirmation prompt for this session
                                # — also: `koda --yolo` / `koda --dangerously-skip-permissions`
                                # — combinable with --continue

# Exit Koda
/quit                           # Exit the CLI
/exit                           # Alias for /quit
```

**How sessions work:** every assistant turn auto-saves the conversation to `~/.koda/sessions/<id>.json`, with an index at `~/.koda/sessions/index.json` for fast listing. Sessions are scoped to the directory you launched `koda` from; `koda --continue` picks the most-recent one for that cwd. The 200 most recent sessions are kept; older ones are pruned automatically.

**Confirmation-loop fix:** when the model's prior reply ended with a permission-seeking question (`Shall I…?`, `Would you like me to…?`, `proceed?`, etc.) and you reply with a short confirm phrase (`yes`, `continue`, `go ahead`, `do it`, `proceed`, `lgtm`, …), Koda prefixes the message with an explicit execution directive so the model stops re-asking and dispatches the proposed skill calls.

### Chat Features

**Live Command Completion:**
- Type `/` to see inline grayed suggestions
- Press TAB to complete commands

**Context Window Display:**
- Status bar shows: `Context: used/limit`
- Color-coded warnings (yellow: 80%, red: 95%)

**Autonomous Skill Execution:**
- AI executes skills automatically when needed (native tool calls; legacy `[SKILL:name(param="value")]` text fallback supported)
- 95+ default skills across 20+ categories including:
  - File operations (create, read, update, delete, list)
  - **Code navigation & editing** — `grep_code` (recursive content search), `outline_file` (function/class signatures with line numbers, multi-language), `replace_lines` (surgical line-range edits), `search_replace_file` (find/replace by string), `diff_files`
  - Email parsing (.eml and .msg) with nested attachment extraction
  - PDF generation and reading
  - Web scraping with Scrapling (CAPTCHA evasion) and Playwright
  - OCR for images and scanned documents (Tesseract)
  - Git operations (status, diff, log, blame, file_history, list_tree, show_commit)
  - System info and process management
  - And more...

**Working with large code files:** the model is encouraged to use `grep_code` or `outline_file` to navigate first, then `read_file(startLine, endLine)` to drill into a specific region, then `replace_lines` or `search_replace_file` for surgical edits — much cheaper than reading and rewriting the whole file. `outline_file` handles 10k+ line files in under 50ms.

**Web-Capable Native Tools:**
These are invoked by the model itself (no toggle, no mode); they're listed here so you know what Koda can reach when a question warrants it:
- `web_search` - Search the web (uses Scrapling for CAPTCHA evasion)
- `fetch_url` - Fetch a single URL (PDF/DOCX/HTML/text)
- `crawl_pages` - Multi-page crawl with depth/limit
- `playwright_fetch` - Fetch JS-rendered pages
- `playwright_interact` - Interact with web pages
- `scrapling_fetch` - CAPTCHA-evading fetch via StealthyFetcher
- `dns_lookup`, `virustotal_lookup` - Resolution and reputation lookups

**Web Search Fallback Chain:**
When performing web searches, the system uses a multi-engine fallback:
1. **DuckDuckGo** (primary) - Fast, no authentication required
2. **Scrapling** - CAPTCHA-evading fallback using StealthyFetcher
3. **Brave Search** - Secondary fallback with less aggressive bot detection
4. **Playwright** - Final fallback for JS-rendered content

---

## Chat UI Features

The Chat UI (https://localhost:3002) exposes enabled skills to the model as native tool calls and surfaces a handful of composer-level conveniences (attachments, clipboard paste, paste-as-file). Legacy globe/link toggles have been removed — web search and URL fetch are now invoked by the model on demand through the native tool interface.

### Native Tool Calling

Every enabled skill is surfaced to the chat model as a native tool. The model decides when to call them; the UI renders each invocation as a chip with the tool name, arguments, and (on click) the full result.

- **Tool catalog**: built from the server-side skill registry; toggling a skill off in Settings removes it from the catalog immediately.
- **Rendering**: tool calls stream as `native_tool_call` events from the server and appear inline in the message flow.
- **No user toggle required**: the model calls `web_search`, `fetch_url`, `crawl_pages`, etc. when the query warrants it. There is no longer a globe or link button to enable these.
- **Iteration cap**: a silent no-response path when the tool loop hit its cap was fixed in `d9bf5f5` — the model now always produces a final user-visible message.

**Notable native tools added recently:**
- `web_search` — fallback chain: DuckDuckGo → Scrapling → Brave → Playwright
- `fetch_url` — direct file download for PDF/DOCX/XLSX/CSV, then Scrapling → Playwright → axios for HTML
- `crawl_pages` — multi-page crawl with depth/limit controls
- `playwright_fetch` / `playwright_interact` — JS-rendered pages and scripted interactions
- `scrapling_fetch` — CAPTCHA-evading fetch via StealthyFetcher
- `virustotal_lookup` — indicator / hash / URL reputation lookup
- `base64_decode` — auto-invoked server-side on chat input and output; also callable as a tool in scan mode

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

Select from 6 layout options in Settings:
- **Default** - Classic chat layout
- **Centered** - Messages centered
- **Timeline** - Vertical timeline flow
- **Bubbles** - Rounded speech-bubble style
- **Slack** - Flat, left-aligned messages
- **Minimal** - Clean dividers, no bubbles
- Slack/Minimal layouts include a Message Borders slider (0-40%)

### Themes

18 themes available in Settings:
- **Standard**: dark, light
- **Nature**: ocean, sunset, sand
- **Warm Tones**: copper, mocha
- **Neutral**: slate, storm
- **Dev Classics**: solarized, kanagawa, palenight, ayu
- **Vibrant**: matrix, andromeda, poimandres, oxocarbon, crimson

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
