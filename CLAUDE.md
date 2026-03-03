# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

# modelserver

**Version:** 0.5.1

## Overview

A containerized MLOps platform for serving and managing large language models. Features include:
- **Dual Backend Support**: llama.cpp (works with older GPUs) and vLLM (for newer GPUs)
- Dynamic model instance management with GPU acceleration
- Web UI for model discovery, download, and configuration (HuggingFace integration)
- **Optimal Settings**: Auto-configure launch parameters based on hardware (GPU VRAM, CPU cores)
- **Thinking Model Detection**: Visual tags for reasoning/thinking models (QwQ, DeepSeek R1, etc.)
- Open WebUI chat interface
- AI agent management system with skills and tasks
- **Autonomous Skill Execution**: Koda CLI executes skills directly without manual intervention
- **Advanced Web Scraping**: Playwright-powered content fetching with stealth mode and bot detection avoidance
- Cross-platform CLI (koda) for terminal-based agent interaction
- OpenAI-compatible API with authentication and rate limiting
- **Production-Ready Stability**: Comprehensive error handling prevents crashes from model failures, download errors, or corrupted data

---

## Quick Start

### Prerequisites
- Docker 24.0+ with Compose v2
- Node.js (for CLI)
- Optional: NVIDIA GPU + Container Toolkit for acceleration
- Optional: HuggingFace token for gated models

### Installation
```bash
# 1. Clone and configure
git clone <repository-url> && cd lmstudio
echo "HUGGING_FACE_HUB_TOKEN=your_token_here" > .env

# 2. Build images (parallel mode: ~20-25 min total)
#    - llamacpp: 20-30 min (CUDA compilation)
#    - vllm: 10-15 min (Python dependencies)
#    Both build in parallel by default
./build.sh

# 3. Start services
./start.sh

# Services available at:
# - Webapp: https://localhost:3001
# - Open WebUI: https://localhost:3002
```

**Build Features:**
- Parallel builds enabled by default (saves ~10-15 minutes)
- Automatic resume if build is interrupted
- Incremental builds (skips existing images)
- Use `./build.sh --help` for all options

### Using Models
1. Open `https://localhost:3001`
2. **Discover** tab → Search HuggingFace → Download GGUF
3. **My Models** tab → Configure launch settings → Start instance
4. **Apps** tab → Start Open WebUI → Chat with models

### CLI Installation
```bash
# Install koda CLI
curl -sk https://localhost:3001/api/cli/install | bash

# Configure
koda
/auth  # Enter API credentials from webapp (API Keys tab)
```

---

## Architecture

### Services
- **llama.cpp Base Image**: CUDA-enabled build for GPU acceleration (supports Maxwell 5.2+)
- **vLLM Base Image**: Python-based inference server (requires Pascal 6.0+ for GGUF)
- **Webapp** (Port 3001): React + Express for model/agent management
- **Dynamic Model Instances**: On-demand containers (ports 8001+)
- **Open WebUI** (Port 3002): Pre-built chat interface
- **Nginx**: HTTPS reverse proxy for Open WebUI

### Backend Selection
| Backend | GPU Requirement | Best For |
|---------|-----------------|----------|
| **llama.cpp** | Maxwell 5.2+ (GTX 900, Quadro M series) | GGUF models, older GPUs |
| **vLLM** | Pascal 6.0+ (GTX 1000, Quadro P series) | Newer GPUs, HuggingFace models |

### Port Allocation
| Port | Service | Protocol |
|------|---------|----------|
| 3001 | Webapp | HTTPS |
| 3002 | Open WebUI | HTTPS |
| 8001+ | Model instances (llamacpp-* or vllm-*) | HTTP (internal) |

---

## Web UI Features

### Tabs Overview
| Tab | Purpose |
|-----|---------|
| **Discover** | Search/download GGUF models from HuggingFace |
| **My Models** | View models, launch instances, configure settings |
| **System Prompts** | Set per-model system prompts |
| **API Keys** | Create/manage API keys with permissions & rate limits |
| **Apps** | Manage Open WebUI (start/stop/restart) |
| **Docs** | API documentation with code builder |
| **Logs** | Real-time logs for downloads and instances |

### Launch Settings (My Models)
- **Backend Toggle**: Select llama.cpp (default) or vLLM
  - llama.cpp: Works with Maxwell 5.2+ GPUs (Quadro M4000, GTX 900 series)
  - vLLM: Requires Pascal 6.0+ GPUs (GTX 1000 series, Quadro P series)

**llama.cpp Settings:**
- **GPU & Context**: GPU layers (-1=all), context size (512-128K)
- **KV Cache**: Cache types (f16/q8_0/q4_0), flash attention
- **Performance**: Threads, parallel slots, batch size, micro-batch size
- **Repetition Control**: Repeat penalty, repeat last N, presence/frequency penalties

**vLLM Settings:**
- **Model & Context**: Max model length, CPU offload
- **GPU Memory**: GPU memory utilization, KV cache dtype
- **Performance**: Tensor parallel size, max sequences
- **Advanced**: Trust remote code, enforce eager mode

### Model Tags (My Models)
- **Thinking**: Shown for reasoning models (QwQ, DeepSeek R1, o1, o3, etc.)
- **Quantization**: Shows Q4_0, Q8_0, F16, etc.
- **Size**: Shows parameter count (7B, 13B, 30B, etc.)

---

## Koda CLI

### Features
- Interactive terminal chat with AI models
- **Autonomous Skill Execution**: AI executes skills directly (create files, read files, etc.)
- **Clean Skill Messages**: Concise, professional output for all skill executions (no verbose JSON)
- Agent creation and management
- **Agent Collaboration Mode**: Multiple agents work together on tasks
- File operations (read/write/delete)
- Task tracking
- Chat history with timestamps
- Visual UI with color-coded messages
- Context window tracking with color-coded warnings

### Modes
- **Standalone**: Direct chat with AI, autonomous tool execution
- **Agent**: Task-aware mode with specific agent context
- **Collab**: Multiple agents collaborate on complex tasks
- **Websearch**: Enable automatic web search (combine with any mode)

### Commands
```bash
# Setup
/auth              # Authenticate with API credentials
/init              # Analyze project and create koda.md
/project <name>    # Create a project directory structure
/cwd               # Show current working directory

# Mode Selection
/mode standalone              # Direct chat with AI (default)
/mode agent                   # Agent-specific context mode
/mode agent collab            # Multi-agent collaboration mode
/mode standalone,websearch    # Chat mode with web search enabled
/mode agent,websearch         # Agent mode with web search enabled

# Session Management
/clear             # Clear chat history
/clearsession      # Clear context but keep history visible
/help              # Show all available commands
/quit              # Exit koda
```

**Note:** Koda has automatic access to:
- File operations (create, read, update, delete, list)
- Code analysis and quality metrics
- Refactoring suggestions
- Web search and documentation lookup
- Multi-file context management

Just ask naturally - Koda will use the appropriate tools automatically!

**Paste Support:** When pasting multi-line text (like articles or code), Koda automatically detects the paste and displays it in a clean bordered box format. After pasting, press Enter to send the message to the AI. You can also type a command instead to cancel the paste and execute the command. Single-line input continues to work as before (press Enter to send).

### Chat Interface
```
  ██╗  ██╗ ██████╗ ██████╗  █████╗
  ██║ ██╔╝██╔═══██╗██╔══██╗██╔══██╗
  █████╔╝ ██║   ██║██║  ██║███████║
  ██╔═██╗ ██║   ██║██║  ██║██╔══██║
  ██║  ██╗╚██████╔╝██████╔╝██║  ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
  Your AI project assistant
  Type /help for commands | /quit to exit

[2:18:12 PM] System: Connected! Type a message or /help
[2:18:15 PM] You: Hello!
[2:18:16 PM] Assistant: Hi! How can I help?

>
```

---

## API Reference

### Authentication
**All API endpoints require authentication.** Three authentication methods are supported:

1. **Session Authentication** (Webapp UI)
   - Automatic session-based auth via Passport.js
   - No additional headers needed when using the web UI

2. **API Key + Secret** (External API)
   - Required headers:
     ```bash
     X-API-Key: your_api_key
     X-API-Secret: your_api_secret
     ```

3. **Bearer Token** (OpenWebUI & API)
   - Required header:
     ```bash
     Authorization: Bearer your_token
     ```

**Important:** Unauthenticated requests will receive `401 Unauthorized` error.

### Security Notes

**Production Deployment:**
- Always set `NODE_ENV=production` to prevent error details from leaking
- Use strong, unique passwords for user accounts
- Rotate API keys regularly
- Enable HTTPS (default in this setup)
- Monitor API usage and logs for suspicious activity

**Error Handling:**
- Production mode returns generic error messages to prevent information disclosure
- Stack traces are never sent to clients in production
- 404 errors return generic "Invalid request" message to prevent endpoint discovery

**Rate Limiting:**
- API keys have configurable rate limits (requests per hour, tokens per day)
- Web search endpoint includes permission checks and error handling
- Failed authentication attempts are logged

### Permissions
- `query` - Inference/chat
- `models` - Model management
- `instances` - Instance control
- `agents` - Agent/skill/task management
- `admin` - API keys, system operations

### Key Endpoints

**Chat & Completion**
```bash
POST /api/chat            # Simplified chat (auto-routes to first model)
POST /api/chat/stream     # Streaming chat with Server-Sent Events
POST /api/complete        # Text completion
```

**Authentication** (Session-based and API Key)
```bash
POST /api/auth/register   # Create new user account
POST /api/auth/login      # Login with username/password
POST /api/auth/logout     # Logout current session
GET  /api/auth/me         # Get current user info
PUT  /api/auth/password   # Change password (requires authentication)
```

**Models**
```bash
GET    /api/models                    # List models
POST   /api/models/pull               # Download from HuggingFace
POST   /api/models/:name/load         # Create llama.cpp or vLLM instance
DELETE /api/models/:name              # Delete model
GET    /api/huggingface/search        # Search HuggingFace
```

**Backend Management**
```bash
GET  /api/backend/active               # Get active backend (llama.cpp or vLLM)
POST /api/backend/active               # Set active backend
```

**Instances** (Both llama.cpp and vLLM)
```bash
GET    /api/vllm/instances             # List running vLLM instances
DELETE /api/vllm/instances/:name       # Stop vLLM instance
GET    /api/llamacpp/instances         # List running llama.cpp instances
DELETE /api/llamacpp/instances/:name   # Stop llama.cpp instance
```

**Search & Documentation**
```bash
GET  /api/search?q=query&limit=10&timeRange=m&fetchContent=true&contentLimit=3
     # Web search using DuckDuckGo with optional content fetching
     # Parameters:
     #   q (required) - search query
     #   limit (optional, default 5) - max results
     #   timeRange (optional) - d/w/m/y for day/week/month/year
     #   fetchContent (optional, default false) - fetch actual page content from URLs
     #   contentLimit (optional, default 3) - number of URLs to fetch content from
     # Auto-enhances "recent/latest/news" queries with current month/year
     # Returns: { query, enhancedQuery, results, count, contentFetchedCount }
     # When fetchContent=true, results include extracted page content (title, summary, headings, paragraphs)

GET  /api/docs                         # Fetch documentation
```

**Playwright (Advanced Web Scraping)**
```bash
POST /api/playwright/fetch             # Fetch URL(s) with stealth mode
     # Body: { url: string, urls: string[], timeout: 15000, waitForJS: true,
     #         includeLinks: false, screenshot: false, maxLength: 8000 }
     # Uses browser pooling, fingerprint randomization, bot detection avoidance
     # Falls back to axios if Playwright unavailable

POST /api/playwright/interact          # Interact with page before extraction
     # Body: { url: string, actions: [...], timeout: 30000, maxLength: 8000 }
     # Actions: { type: 'click'|'type'|'wait'|'scroll'|'waitForNavigation',
     #            selector: string, text: string, timeout: number }

GET  /api/playwright/status            # Check Playwright availability
     # Returns: { enabled, status, browserPool: { size, inUse, available } }
```

**Agents**
```bash
GET    /api/agents                    # List agents
POST   /api/agents                    # Create agent
PUT    /api/agents/:id                # Update agent
DELETE /api/agents/:id                # Delete agent
GET    /api/skills                    # List skills
POST   /api/skills                    # Create skill
GET    /api/tasks                     # List tasks
POST   /api/tasks                     # Create task
```

**File Operations (Agents)**
```bash
POST /api/agent/file/read    # Read file
POST /api/agent/file/write   # Write file
POST /api/agent/file/delete  # Delete file
POST /api/agent/file/list    # List directory
POST /api/agent/file/move    # Move/rename file
```

**System**
```bash
GET  /api/system/resources         # Get hardware info (CPU, RAM, GPU)
POST /api/system/optimal-settings  # Calculate optimal settings for a model
POST /api/system/reset             # Reset system
```

**Admin**
```bash
GET    /api/api-keys           # List API keys
POST   /api/api-keys           # Create API key
PUT    /api/api-keys/:id       # Update key
DELETE /api/api-keys/:id       # Delete key
```

### Example Usage

**cURL**
```bash
curl -sk https://localhost:3001/api/chat \
  -H "X-API-Key: your_key" \
  -H "X-API-Secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "maxTokens": 100}'
```

**Python**
```python
import requests
requests.post(
    'https://localhost:3001/api/chat',
    headers={'X-API-Key': 'key', 'X-API-Secret': 'secret'},
    json={'message': 'Hello!', 'maxTokens': 100},
    verify=False
)
```

---

## Docker Commands

### Build System
The advanced build system supports incremental builds, parallel compilation, build state tracking, and automatic resume.

```bash
# Basic usage
./build.sh                    # Build all images (parallel mode, incremental)

# Build options
./build.sh --no-cache         # Force rebuild all images without Docker cache
./build.sh --no-cleanup       # Skip Docker build cache cleanup
./build.sh --no-parallel      # Build sequentially instead of parallel
./build.sh --no-resume        # Start fresh (ignore build state)
./build.sh --retry 3          # Set retry attempts on failure (default: 2)

# Examples
./build.sh --no-parallel      # Sequential builds (useful for low RAM)
./build.sh --no-cache --no-resume  # Complete fresh rebuild
```

**Features:**
- **Incremental Builds**: Automatically skips images that already exist
- **Build State Tracking**: Saves build state in `.build-state/` directory
- **Dockerfile Change Detection**: Rebuilds only when Dockerfiles are modified
- **Parallel Builds**: Builds llamacpp and vllm simultaneously (saves ~10-15 minutes)
- **Resume Capability**: Interrupted builds automatically resume where they left off
- **Retry Logic**: Automatically retries failed builds (configurable)
- **Build Timing**: Shows total build time and per-image timing
- **Color-Coded Output**: INFO (blue), SUCCESS (green), WARNING (yellow), ERROR (red)

**Build State:**
- Build checksums stored in `.build-state/`
- Automatically detects Dockerfile changes
- Use `--no-resume` to clear state and start fresh
- State is preserved between builds for optimal performance

### Service Management
```bash
./start.sh                      # Start all services
./stop.sh                       # Stop all services
./update.sh                     # Rebuild webapp only (quick updates)

# Reload scripts (restart without data loss)
./reload.sh webapp              # Rebuild and restart webapp only
./reload.sh openwebui           # Update OpenWebUI to latest image
./reload.sh all                 # Rebuild and restart all services

# Reset scripts (clean slate)
./reset.sh                      # Full reset (removes all data except models)
./reset.sh --keep-openwebui     # Reset but keep Open WebUI data
./reset.sh --rebuild            # Reset and rebuild images from scratch
./reset-openwebui.sh            # Reset only Open WebUI data

# Docker Compose commands
docker compose ps               # Check service status
docker compose logs -f webapp   # View webapp logs (follow mode)
docker compose restart webapp   # Restart webapp service
docker compose down             # Stop and remove all containers
docker compose up -d            # Start all services in background
```

### Instance Management
```bash
# List all model instances (both backends)
docker ps --filter "name=llamacpp"    # llama.cpp instances
docker ps --filter "name=vllm"        # vLLM instances

# View logs
docker logs llamacpp-{modelName}      # llama.cpp
docker logs vllm-{modelName}          # vLLM

# Stop instance
docker stop llamacpp-{modelName}      # llama.cpp
docker stop vllm-{modelName}          # vLLM
```

### Debugging
```bash
docker compose exec webapp bash     # Shell into webapp
docker stats llamacpp-{modelName}   # Resource usage
curl http://localhost:8001/health   # Test instance
nvidia-smi                          # Check GPU
```

---

## Creating Custom Skills

Skills are Python functions that agents can execute. Create via **Open Model Agents** tab > **Skills** (in webapp) or manage agents via Koda CLI using agents.md.

### Skill Structure
```javascript
// Function that agents execute
async function execute(params) {
    // Available: fs, path, Buffer, require, execPromise

    if (!params.required) {
        throw new Error('Missing required parameter');
    }

    // Do work...

    return {
        success: true,
        data: result
    };
}
```

### Example: File Processing
```javascript
// Skill: count_lines
// Type: function
// Parameters: { filePath: 'string' }

async function execute(params) {
    const content = await fs.readFile(params.filePath, 'utf8');
    const lines = content.split('\n').length;

    return {
        success: true,
        filePath: params.filePath,
        lineCount: lines
    };
}
```

### Skill Types
- **function**: Data processing, transformations
- **tool**: API calls, web requests
- **command**: Shell execution (disabled by default)

### Available Default Skills (85+)

**File Operations (9 skills)**
- `create_file` - Create new files
- `read_file` - Read file contents
- `update_file` - Update existing files
- `delete_file` - Delete files
- `create_directory` - Create directories (with automatic parent directory creation)
- `delete_directory` - Delete directories and all contents recursively
- `list_directory` - List directory contents
- `move_file` - Move or rename files
- `copy_file` - Copy files

**File Content Operations (5 skills)**
- `append_to_file` - Append content to existing files
- `tail_file` - Read last N lines of a file
- `head_file` - Read first N lines of a file
- `search_replace_file` - Search and replace text in files
- `diff_files` - Compare two files and show differences

**Archive Operations (5 skills)**
- `unzip_file` - Extract ZIP archives
- `zip_files` - Create ZIP archives
- `tar_extract` - Extract tar/tar.gz/tar.bz2 archives
- `tar_create` - Create tar archives with optional compression
- `extract_archive` - Universal archive extraction (auto-detects format)

**File Management (3 skills)**
- `get_file_metadata` - Get file size, dates, permissions
- `search_files` - Search for files by pattern
- `download_file` - Download files from URLs

**Process Management (3 skills)**
- `list_processes` - List running processes with CPU/memory usage
- `kill_process` - Terminate a process by PID or name
- `start_process` - Start a new process/application

**Network & Web (9 skills)**
- `fetch_url` - Fetch content from URLs
- `http_request` - Make custom HTTP requests (GET, POST, PUT, DELETE)
- `dns_lookup` - Perform DNS lookups
- `check_port` - Check if a port is open
- `ping_host` - Ping a host to check connectivity
- `get_public_ip` - Get public IP address and geolocation
- `list_network_interfaces` - List network interfaces with IP addresses
- `traceroute` - Trace route to a host
- `curl_request` - Advanced HTTP requests with headers/auth

**Playwright Web Scraping (3 skills)**
- `playwright_fetch` - Fetch webpage(s) with stealth mode and bot detection avoidance (handles JS-rendered pages)
- `playwright_interact` - Interact with pages (click, type, scroll) before extracting content
- `web_search` - Search the web with optional Playwright content fetching (returns actual page content)

**Git Operations (4 skills)**
- `git_status` - Get git repository status
- `git_diff` - Show git diff for staged/unstaged changes
- `git_log` - Show git commit history
- `git_branch` - List, create, or switch git branches

**Environment & Shell (3 skills)**
- `get_env_var` - Get environment variable value
- `set_env_var` - Set environment variable (session)
- `which_command` - Find location of executable

**JSON/Config Operations (4 skills)**
- `json_get` - Extract value from JSON using JSONPath
- `json_set` - Set value in JSON file using JSONPath
- `yaml_parse` - Parse YAML files
- `ini_parse` - Parse INI/config files

**Database Operations (2 skills)**
- `sqlite_query` - Execute SQL queries on SQLite databases
- `sqlite_list_tables` - List tables in SQLite database

**PDF Operations (3 skills)**
- `read_pdf` - Extract text from PDF files
- `pdf_page_count` - Get number of pages in PDF
- `pdf_to_images` - Convert PDF pages to images

**Clipboard Operations (2 skills)**
- `clipboard_read` - Read from system clipboard
- `clipboard_write` - Write to system clipboard

**Email Operations (1 skill)**
- `read_email_file` - Read and parse saved email files (.eml format) with full attachment inspection

**Windows-Specific (5 skills)**
- `run_powershell` - Execute PowerShell commands
- `run_cmd` - Execute cmd.exe commands
- `get_windows_services` - List Windows services and status
- `get_registry_value` - Read Windows registry values
- `set_registry_value` - Write Windows registry values (requires admin)

**Linux/macOS Commands (2 skills)**
- `run_bash` - Execute bash commands
- `run_python` - Execute Python code

**Image Processing (3 skills)**
- `ocr_image` - Extract text from images using OCR
- `screenshot` - Take screenshots
- `convert_image` - Convert image formats (PNG, JPG, BMP, GIF)

**Data Processing (7 skills)**
- `parse_json` - Parse and validate JSON
- `parse_csv` - Parse CSV data
- `base64_encode` - Encode data to Base64
- `base64_decode` - Decode Base64 data
- `hash_data` - Generate hashes (MD5, SHA1, SHA256, SHA512)
- `compress_data` - Compress data using gzip
- `decompress_data` - Decompress gzip data

**Code Analysis (2 skills)**
- `analyze_code` - Analyze code for metrics (lines, comments, etc.)
- `find_patterns` - Search for regex patterns in text

**System Information (8 skills)**
- `system_info` - Get system information (CPU, memory, disk)
- `disk_usage` - Get disk usage for specific paths
- `list_services` - List system services (systemd/Windows)
- `get_uptime` - Get system uptime
- `list_ports` - List open ports and listening services
- `generate_uuid` - Generate UUIDs
- `get_timestamp` - Get timestamps in various formats
- `count_words` - Count words and characters in text

**Note:** Command-type skills (bash, PowerShell, cmd, Python execution) are disabled by default for security. Enable them in the Skills tab when needed.

---

## Troubleshooting

### Build Issues

**Build interrupted or failed:**
```bash
./build.sh          # Resume build automatically
./build.sh --retry 5   # Increase retry attempts
```

**Build won't restart after Dockerfile changes:**
```bash
./build.sh --no-resume    # Clear build state and rebuild
```

**Out of memory during parallel build:**
```bash
./build.sh --no-parallel  # Build sequentially
```

**Build state corrupted:**
```bash
rm -rf .build-state/      # Clear build state
./build.sh                # Rebuild from scratch
```

**Force complete rebuild:**
```bash
./build.sh --no-cache --no-resume
```

### "Request exceeds context size"
Increase context size in Launch Settings and reload model.

### Model Won't Load
```bash
docker logs llamacpp-{modelName}     # Check for errors
# Common: OOM → reduce GPU layers, use q8_0 cache, enable flash attention
```

### Webapp Not Responding
```bash
docker compose restart webapp
docker compose logs -f webapp        # Check for errors
```

### Webapp Crashes or Restarts Frequently
If the webapp crashes with "Encrypted session was tampered with!" errors (fixed in v0.3.9):

```bash
# 1. Check if you're running the latest version
docker compose images webapp

# 2. If not on v0.3.9+, rebuild the webapp
docker compose build webapp
docker compose restart webapp

# 3. If issue persists, clean session files
docker compose exec webapp bash -c "rm -rf /models/.modelserver/sessions/*"
docker compose restart webapp
```

**Note:** Session cleanup is now disabled by default in v0.3.9+ to prevent crashes from corrupted files.

### GPU Not Detected
```bash
docker run --rm --runtime=nvidia nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
# If fails: reinstall NVIDIA Container Toolkit
```

### Koda CLI Not Found
```bash
export PATH="$HOME/.local/bin:$PATH"
source ~/.bashrc
```

### VLM Models Crash
Current llama.cpp version doesn't support some VLM architectures (Qwen3-VL, Qwen2-VL). Use LLaVA variants or rebuild with newer llama.cpp.

---

## Model Configuration

### Launch Settings Tooltips
All settings in **My Models** > **Launch Settings** have hover tooltips explaining their purpose.

### Recommended Settings

**Default (Most models)**
```
GPU Layers: -1
Context: 4096
Flash Attention: OFF
Cache: f16
Parallel Slots: 1
```

**Memory-Constrained**
```
GPU Layers: -1
Context: 2048
Flash Attention: ON
Cache: q8_0 or q4_0
Parallel Slots: 1
```

**High Performance**
```
GPU Layers: -1
Context: 8192+
Flash Attention: ON
Cache: f16
Parallel Slots: 4-8
Batch: 4096+
```

**Repetitive Output Fix**
```
Repeat Penalty: 1.1-1.2
Repeat Last N: 128-256
Presence Penalty: 0.2
```

---

## Environment Variables

### Required
- `HUGGING_FACE_HUB_TOKEN` - For downloading models

### llama.cpp Instance Variables (set via Launch Settings UI)
- `LLAMA_N_GPU_LAYERS` - GPU layers (-1 = all)
- `LLAMA_CTX_SIZE` - Context window (default: 4096)
- `LLAMA_THREADS` - CPU threads (0 = auto)
- `LLAMA_CACHE_TYPE_K/V` - KV cache quantization (f16/q8_0/q4_0)
- `LLAMA_FLASH_ATTN` - Flash attention toggle
- `LLAMA_PARALLEL` - Concurrent slots
- `LLAMA_BATCH_SIZE` - Batch size
- `LLAMA_UBATCH_SIZE` - Micro-batch size
- `LLAMA_REPEAT_PENALTY` - Repetition penalty
- `LLAMA_REPEAT_LAST_N` - Tokens for repeat penalty
- `LLAMA_PRESENCE_PENALTY` - Presence penalty
- `LLAMA_FREQUENCY_PENALTY` - Frequency penalty

### vLLM Instance Variables (set via Launch Settings UI)
- `VLLM_MAX_MODEL_LEN` - Maximum context length
- `VLLM_CPU_OFFLOAD_GB` - CPU offload in GB
- `VLLM_GPU_MEMORY_UTILIZATION` - GPU memory fraction (0.0-1.0)
- `VLLM_TENSOR_PARALLEL_SIZE` - Number of GPUs for tensor parallel
- `VLLM_MAX_NUM_SEQS` - Maximum concurrent sequences
- `VLLM_KV_CACHE_DTYPE` - KV cache data type (auto/fp8)
- `VLLM_TRUST_REMOTE_CODE` - Trust remote code from model repo
- `VLLM_ENFORCE_EAGER` - Disable CUDA graphs

---

## Files & Directories

### Core
- `docker-compose.yml` - Service definitions
- `.env` - Environment variables (not committed)
- `.build-state/` - Build tracking directory (auto-generated, git-ignored)

### Management Scripts
- `build.sh` - Advanced build system with parallel builds and state tracking
- `start.sh` - Start all services
- `stop.sh` - Stop all services and cleanup containers
- `update.sh` - Quick rebuild of webapp only
- `reload.sh` - Rebuild and restart services without data loss
- `reset.sh` - Full system reset (removes all data except models)
- `reset-openwebui.sh` - Reset only Open WebUI data

### Services
- `webapp/` - React + Express application
- `llamacpp/` - llama.cpp CUDA build (supports Maxwell 5.2+)
- `vllm/` - vLLM inference server (requires Pascal 6.0+ for GGUF)
- `agents-cli/` - Koda CLI source
- `scripts/` - Utility scripts
- `nginx/` - Reverse proxy config

### Data
- `webapp/models/` - Downloaded model files
- `webapp/data/` - Agents, skills, tasks, API keys
- `~/.koda/config.json` - CLI configuration (AES-256 encrypted)

---

## Recent Updates

### Version 0.5.1 (Current)
- **Koda CLI Newline Fix**:
  - **Fixed File Content Newlines**: Skill bracket format `[SKILL:create_file(...)]` now properly converts `\n` to actual newlines
  - **Root Cause**: Parameter regex captured literal `\n` strings without converting to newline characters
  - **Solution**: Added `unescapeString()` helper function to process escape sequences (`\n`, `\t`, `\r`, `\\`, `\"`)
  - **Affected Skills**: `create_file`, `update_file`, `append_to_file` (when using bracket format)
  - **JSON Formats Unaffected**: JSON patterns already used `JSON.parse()` which handles escapes correctly
- **Koda CLI Version**: 3.1.1

### Version 0.5.0
- **Playwright-Powered Web Scraping**:
  - **Advanced Bot Detection Avoidance**: Browser fingerprint randomization, stealth mode, and human-like behavior
  - **JavaScript-Rendered Pages**: Handles dynamic content that requires JS execution (React, Vue, Angular sites)
  - **Browser Pooling**: Fast execution with reusable browser instances (max 3 concurrent)
  - **Smart Content Extraction**: Removes ads, navigation, and noise - extracts article content, headings, and paragraphs
  - **Page Interaction**: Click, type, scroll, and wait actions for complex sites requiring user interaction
  - **Screenshot Capability**: Optional page screenshots for visual content
  - **Graceful Fallback**: Falls back to axios for simple HTML pages if Playwright unavailable
- **New Playwright API Endpoints**:
  - `POST /api/playwright/fetch` - Fetch single or multiple URLs with stealth mode
  - `POST /api/playwright/interact` - Interact with pages (click, type, scroll) before extraction
  - `GET /api/playwright/status` - Check Playwright availability and browser pool status
- **New Koda CLI Skills**:
  - `playwright_fetch` - Fetch webpage content with bot detection avoidance
  - `playwright_interact` - Interact with complex sites requiring user actions
  - `web_search` - Enhanced search skill with Playwright content fetching
- **Stealth Features**:
  - Randomized User-Agent, viewport, locale, timezone, and device scale factor
  - WebDriver detection bypass, Chrome runtime spoofing
  - Plugin array spoofing, WebGL vendor masking
  - Random delays to simulate human behavior
  - Blocks unnecessary resources (images, fonts) for speed
- **Infrastructure**:
  - Chromium installed in webapp Docker image with all dependencies
  - Browser pool with automatic cleanup (5-minute idle timeout)
  - Concurrent fetching support (up to 3 simultaneous browsers)
- **Koda CLI Version**: 3.1.0

### Version 0.4.1
- **Enhanced Web Search with Content Fetching**:
  - **Actual Page Content**: Search now fetches real HTML content from result URLs, not just snippets
  - **Smart Content Extraction**: Extracts title, meta description, headings, and paragraphs from pages
  - **New API Parameters**: `fetchContent=true` and `contentLimit=N` for `/api/search` endpoint
  - **URL Deduplication**: Prevents duplicate results in search output
  - **Improved Query Enhancement**: Added "news" to triggers for auto-enhancing with current date
  - **Better AI Instructions**: Koda websearch mode now tells AI to use fetched content and cite sources
- **Koda CLI Websearch Improvements**:
  - Automatically fetches content from top 5 URLs when websearch mode is enabled
  - Shows "Found X results (Y with content)" status
  - Provides actual article text to AI for accurate summaries and answers
  - Clear instructions prevent AI from saying "I can't access web content"

### Version 0.4.0
- **100% Client-Side Skill Execution** - Koda is now a fully standalone CLI tool:
  - **No Server Dependency**: All 80 skills execute locally on user's machine
  - **No Docker Container Execution**: Skills never run inside Docker containers
  - **True CLI Experience**: Like Claude Code and Gemini CLI, Koda runs entirely client-side
- **New Skill Execution Functions** (12 categories):
  - `executeNetworkSkill`: fetch_url, dns_lookup, check_port, ping_host, http_request, get_public_ip, list_network_interfaces, traceroute, curl_request
  - `executeDataSkill`: parse_json, parse_csv, base64_encode/decode, hash_data, generate_uuid, get_timestamp, count_words, find_patterns, analyze_code, compress/decompress_data, json_get/set, yaml_parse, ini_parse
  - `executeArchiveSkill`: unzip_file, zip_files, tar_extract, tar_create, extract_archive
  - `executeCommandSkill`: run_bash, run_python, run_powershell, run_cmd
  - `executeFileExtraSkill`: copy_file, get_file_metadata, search_files, download_file, search_replace_file, diff_files
  - `executeClipboardSkill`: clipboard_read, clipboard_write
  - `executeDatabaseSkill`: sqlite_query, sqlite_list_tables
  - `executePdfSkill`: read_pdf, pdf_page_count, pdf_to_images
  - `executeImageSkill`: ocr_image, screenshot, convert_image
  - `executeWindowsSkill`: get_windows_services, get_registry_value, set_registry_value
  - `executeEmailSkill`: read_email_file
- **Removed Server-Side Fallback**: API skill execution removed - all skills are local
- **Cross-Platform**: All skills work on Linux, macOS, and Windows
- **Koda CLI Version**: 3.0.0

### Version 0.3.21
- **Comprehensive Client-Side Skill Execution**:
  - **All System Skills Client-Side**: `system_info`, `disk_usage`, `get_uptime`, `list_ports`, `list_services` now show actual user system info
  - **All Git Skills Client-Side**: `git_status`, `git_diff`, `git_log`, `git_branch` now access user's actual repositories
  - **All Environment Skills Client-Side**: `get_env_var`, `set_env_var`, `which_command` now access user's actual environment
  - **Cross-Platform Support**: All skills work on Linux, macOS, and Windows with native commands
  - **Clean Output Messages**: All new skills display concise, color-coded status messages
- **Skills Now Run Locally**: 26 skills now execute client-side for accurate results:
  - File Operations (11): create_file, read_file, update_file, delete_file, create_directory, delete_directory, list_directory, move_file, append_to_file, tail_file, head_file
  - Process Management (3): list_processes, kill_process, start_process
  - System Info (5): system_info, disk_usage, get_uptime, list_ports, list_services
  - Git Operations (4): git_status, git_diff, git_log, git_branch
  - Environment (3): get_env_var, set_env_var, which_command
- **Koda CLI Version**: 2.9.0

### Version 0.3.20
- **Process Skills Client-Side Execution**:
  - **Fixed Process Listing**: `list_processes` now executes client-side, showing user's actual system processes instead of Docker container processes
  - **Client-Side Process Management**: `list_processes`, `kill_process`, and `start_process` all execute locally for accurate results
  - **Cross-Platform Support**: Works on Linux, macOS, and Windows using native system commands (`ps aux`, `tasklist`, etc.)
  - **Sorting Options**: `list_processes` supports sorting by `pid`, `cpu`, `memory`, or `name`
  - **Result Limits**: Configurable limit parameter to control number of returned processes
  - **Clean Output Messages**: Process skill results display concise, color-coded status messages
- **Skills Integration**:
  - Added process skills to default-skills.json for consistency
  - Updated system prompt to include process skill examples
  - Process skills now appear in skill availability list
- **Koda CLI Version**: 2.8.0

### Version 0.3.19
- **Massive Skills Library Expansion** (37 new skills, 80+ total):
  - **Process Management**: `list_processes`, `kill_process`, `start_process` - Full process control
  - **File Content Operations**: `append_to_file`, `tail_file`, `head_file`, `search_replace_file`, `diff_files` - Advanced file manipulation
  - **Environment & Shell**: `get_env_var`, `set_env_var`, `which_command` - Environment variable and command path utilities
  - **Git Operations**: `git_status`, `git_diff`, `git_log`, `git_branch` - Native git integration
  - **JSON/Config Operations**: `json_get`, `json_set`, `yaml_parse`, `ini_parse` - Configuration file manipulation
  - **Archive Formats**: `tar_extract`, `tar_create`, `extract_archive` - Universal archive support
  - **Network Diagnostics**: `get_public_ip`, `list_network_interfaces`, `traceroute`, `curl_request` - Advanced network tools
  - **Clipboard Operations**: `clipboard_read`, `clipboard_write` - System clipboard access
  - **PDF Operations**: `read_pdf`, `pdf_page_count`, `pdf_to_images` - PDF processing capabilities
  - **Database Operations**: `sqlite_query`, `sqlite_list_tables` - SQLite database access
  - **System Info Enhancements**: `disk_usage`, `list_services`, `get_uptime`, `list_ports` - Comprehensive system monitoring
- **Cross-Platform Support**: All new skills automatically detect OS (Windows/Linux/macOS) and use appropriate commands
- **Client-Side Execution**: File content operations (`append_to_file`, `tail_file`, `head_file`) execute locally for better performance
- **Skills Organization**: Reorganized skills into 18 logical categories for better discoverability

### Version 0.3.18
- **Koda CLI Smarter Skill Execution**:
  - **Fixed Infinite Looping**: AI no longer loops after successful task completion - stops when skills succeed
  - **Smart Completion Detection**: Feedback message now explicitly tells AI "TASK COMPLETE. DO NOT execute any more skills" when all skills succeed
  - **Skill Availability Awareness**: System prompt now lists exact available skills, preventing attempts to use non-existent skills
  - **New `create_directory` Skill**: Added client-side and server-side support for creating directories
  - **Better Error Recovery**: When a skill isn't found, clear guidance provided on available skills
  - **Reduced Repetition**: AI no longer unnecessarily verifies work with read_file/list_directory after successful operations
  - **Clearer Stop Conditions**: Critical rule added: "STOP LOOPING: After skills execute successfully, respond with a brief natural language confirmation"
- **Skills Library Update**:
  - **New Skill: `create_directory`** - Create directories with automatic parent directory creation
  - **Total Skills: 44** - Added create_directory and delete_directory to server-side skills.json

### Version 0.3.17
- **Koda CLI Skill Execution Improvements**:
  - **Clean Skill Messages**: Removed verbose JSON output from all skill execution feedback
  - **Universal Clean Formatting**: All 42+ skills now display concise, user-friendly messages
  - **Directory Deletion Enhancement**: `delete_directory` now shows "✓ Directory deleted: <path>" instead of generic message
  - **Consistent File Operation Messages**: All file operations (create, read, update, delete, list, move) have clean, color-highlighted output
  - **Simplified AI Feedback**: Reduced verbose "[SKILL EXECUTION RESULTS]" to clean "[SKILL RESULTS]" with minimal text
  - **Future-Proof**: Fallback handling ensures any new skills automatically use clean message formatting
  - **Better UX**: Users see professional, readable output like "✓ File deleted: ./path" instead of raw JSON structures
- **Enhanced Skills Library**:
  - **Expanded from 27 to 42+ default skills** for comprehensive automation capabilities
  - **Windows-Specific Skills**: PowerShell execution, cmd.exe commands, Windows services management, registry read/write
  - **Archive Operations**: ZIP file extraction and creation (`unzip_file`, `zip_files`)
  - **Email File Parsing**: Read and parse saved .eml email files with full attachment inspection (`read_email_file`)
  - **OCR Capabilities**: Text extraction from images using pytesseract
  - **Image Processing**: Screenshot capture, image format conversion (PNG, JPG, BMP, GIF)
  - **File Management**: File metadata retrieval, pattern-based file search, URL-based file downloads
  - **Cross-Platform Support**: Skills automatically detect OS and provide appropriate error messages
- **UI Improvements**:
  - **Removed Agents Tab**: Agent management now handled exclusively via Koda CLI and agents.md
  - **Streamlined Interface**: Open Model Agents section now shows only Skills and Permissions tabs
  - **Cleaner Workflow**: Focus on skill management and permissions in webapp, agent management in CLI

### Version 0.3.16
- **Token Tracking Fix for Streaming Endpoints**:
  - **Fixed Critical Bug**: Token usage was not updating for streaming chat requests (`/api/chat/stream`)
  - **Root Cause**: `requireAuth` middleware intercepted `res.send()` calls, but streaming endpoints use `res.write()` and `res.end()`
  - **Solution**: Added manual token tracking in streaming endpoint before `res.end()` calls
  - **Impact**: Affects Koda CLI (uses streaming by default), web UI streaming chat, and all API clients using streaming
  - **Token Stats**: Now properly tracked for both `[DONE]` marker events and stream end events
  - **Rate Limiting**: Token-based rate limits now work correctly with streaming requests
  - **Dashboard**: API Keys tab now displays accurate token usage percentages for all request types

### Version 0.3.15
- **Koda CLI Paste Behavior Improvements**:
  - **Confirmation Before Send**: Multi-line pastes now display in a bordered box and wait for Enter key to confirm sending
  - **Command Override**: Users can type a command instead of pressing Enter to cancel the paste and execute the command
  - **Buffer Cleanup**: Fixed text bleeding issue where paste content would appear in the readline prompt
  - **Single-Line Preserved**: Single-line input continues to work as before (immediate send on Enter)
  - **Better UX**: Users now have control over when pasted content is sent, preventing accidental submissions
  - **Visual Feedback**: Clear "Press Enter to send, or type a command..." message shown after paste detection

### Version 0.3.14
- **Koda CLI Skill Display Improvements**:
  - **Real-time Skill Syntax Cleaning**: Raw `[SKILL:...]` syntax now hidden during streaming responses
  - **Cleaner Streaming**: Created `cleanSkillSyntax()` helper function to filter skill calls from all displayed text
  - **No More Raw Syntax**: Users see clean, natural language responses instead of technical skill invocation format
  - **Better State Tracking**: Added `lastCleanedMessage` variable to track cleaned responses during streaming
- **Enhanced Skill Execution Behavior**:
  - **Directive Feedback Messages**: Skill result messages now explicitly guide AI to execute update_file when fixes are needed
  - **Action-Oriented Prompts**: Updated system prompt with critical execution rules:
    - "If you say 'let me fix that', you MUST execute update_file, not just display code"
    - "When you identify bugs in code you created, use update_file to fix them"
    - Clear instructions to recognize topic switches and respond to new requests
  - **Reduced Over-Analysis**: AI now provides brief confirmations instead of lengthy explanations after successful skill execution
- **Improved Context Switching**:
  - **Topic Recognition**: Added explicit instruction for AI to recognize when user switches topics (e.g., from coding to summarizing articles)
  - **New Request Handling**: AI instructed to respond to new, unrelated requests instead of continuing previous tasks
  - **Better Context Awareness**: System prompt now includes 6 critical execution rules for consistent behavior
- **User Experience Enhancements**:
  - Skill execution now appears seamless with no technical noise
  - AI focuses on executing tasks rather than just describing them
  - Cleaner, more professional output for file operations
  - Better handling of multi-turn conversations with topic changes

### Version 0.3.13
- **Koda CLI Critical Bug Fixes**:
  - **Double Character Input Fix**:
    - Fixed y/n/s confirmations showing doubled characters (yy, nn, skip)
    - Root cause: Multiple readline interfaces capturing input simultaneously
    - Solution: Replaced readline.createInterface() with stdin.once() listeners
    - Properly manages terminal raw mode state to prevent conflicts
  - **Client-Side File Operations**:
    - Fixed files being created in Docker container overlay paths instead of user's directory
    - Files now created in user's actual working directory (e.g., /home/test instead of /var/lib/docker/...)
    - Added executeFileOperationSkill() function for local file execution
    - Supports: create_file, update_file, read_file, delete_file, list_directory, move_file
    - Better security: Files execute with user permissions, not container permissions
  - **Response Formatting Cleanup**:
    - Removed raw [SKILL:...] syntax from displayed chat responses
    - Users now see clean, readable AI explanations
    - Skill execution status shown separately with clear icons (✓ ✗ ⊘)
    - Improves user experience by hiding technical implementation details
- **Testing**: All 16 automated tests passed
  - File Operations: 6/6 passed
  - Confirmation Prompt: 3/3 passed
  - Response Formatting: 7/7 passed
- **Impact**:
  - Improved UX: No more confusing double characters or raw syntax
  - Performance: Client-side file execution faster than API calls
  - Backward compatible: No breaking changes

### Version 0.3.12
- **Koda CLI Paste Detection**:
  - Automatic paste detection combines multi-line input into single messages
  - Multi-line messages displayed in clean bordered box format
  - Eliminates messy output with multiple "You:" prefixes when pasting articles or code
  - 50ms buffering window automatically detects paste vs. manual typing
  - Single-line messages continue to display inline as before

### Version 0.3.11
- **Koda CLI Critical Fix**:
  - **ACTUALLY Fixed** message duplication issue in websearch and streaming modes (was incorrectly marked as fixed in 0.3.10)
  - Rewrote `updateStreamingMessage()` to use incremental token writing instead of line clearing
  - Eliminated race conditions and line-counting issues that caused 30+ duplicate messages
  - Streaming now properly appends new tokens without rewriting entire message
  - Fixed terminal width wrapping issues that caused duplication
- **Web Search Enhancements**:
  - **Smart Query Enhancement**: Automatically adds current month and year to "recent", "latest", "current", or "new" queries
  - **Date Filtering**: Automatically applies DuckDuckGo's "past month" filter to recent queries
  - **Time Range Parameter**: Optional `timeRange` parameter (d/w/m/y for day/week/month/year)
  - **Enhanced Results**: Queries like "recent cybersecurity news" now return actual March 2026 articles instead of general news sites
  - Returns both original query and enhanced query in response for transparency

### Version 0.3.10
- **Critical Security Fixes**:
  - Fixed `/api/auth/password` endpoint missing `requireAuth` middleware (CRITICAL)
  - Updated 404 handler to return generic "Invalid request" instead of revealing endpoint information
  - Production mode now uses generic error messages to prevent information leakage
  - Removed stack trace exposure in production environments
- **Web Search Enhancements**:
  - Added permission check (`query` permission required) to `/api/search` endpoint
  - Improved error handling with specific, user-friendly messages
  - Added cache size limits (max 1000 entries) to prevent memory leaks
  - Better error messages distinguishing timeout, service unavailable, and rate limit errors
  - Added `retryable` flag to error responses for client-side retry logic
- **Koda CLI Improvements**:
  - Improved websearch error handling with retry suggestions
  - Better formatting of search results for AI consumption
  - Increased search result limit from 5 to 10 for better coverage
- **API Documentation Updates**:
  - Added authentication endpoints to CLAUDE.md
  - Added streaming chat endpoint documentation
  - Added backend management endpoint documentation
  - Added web search and docs endpoint documentation
  - Added comprehensive security notes section

### Version 0.3.9
- **Critical Stability Fix**:
  - Fixed webapp crashes caused by corrupted session files
  - Disabled automatic session cleanup to prevent unhandled exceptions
  - Session cleanup now handled safely with proper error handling
  - Webapp no longer crashes when downloads fail or models exit unexpectedly
- **Comprehensive Error Handling**:
  - Added global process error handlers (unhandledRejection, uncaughtException)
  - WebSocket broadcast operations now wrapped in try-catch blocks
  - Child process error handlers for download operations
  - Container log stream error handling to isolate Docker errors
  - Global Express error middleware catches all route errors
  - 404 handler for unknown endpoints
- **Resilience Improvements**:
  - Webapp continues running even if models crash
  - Download failures no longer cause server crashes
  - WebSocket errors isolated to individual clients
  - Container operations failures are logged but non-fatal
  - Malformed data handled gracefully without crashing
- **Developer Experience**:
  - Better error logging with stack traces
  - Error messages broadcast to connected clients
  - Non-fatal errors clearly marked in logs
  - Improved debugging with detailed error context

### Version 0.3.8
- **Dual Backend Support**:
  - Added llama.cpp backend alongside vLLM for GPU compatibility
  - llama.cpp: Works with Maxwell 5.2+ GPUs (Quadro M4000, GTX 900 series)
  - vLLM: Requires Pascal 6.0+ GPUs for GGUF quantization
  - Backend toggle in Launch Settings panel
  - Backend-specific configuration options
- **llama.cpp Docker Image**:
  - Multi-stage build with CUDA support for architectures 52-90
  - Includes Maxwell, Pascal, Volta, Turing, Ampere, Ada Lovelace, Hopper
  - Smaller runtime image for faster deployment
- **UI Enhancements**:
  - Backend badge on running instances (llama.cpp / vLLM)
  - Backend-specific config display (GPU layers vs tensor parallel)
  - Updated launch settings with backend-specific sections
- **Advanced Build System**:
  - Parallel builds (llamacpp + vllm simultaneously, saves ~10-15 minutes)
  - Build state tracking with automatic resume on interruption
  - Dockerfile change detection (rebuild only when needed)
  - Retry logic for transient build failures
  - Build timing with color-coded progress indicators
  - Options: --no-parallel, --no-resume, --retry, --no-cache, --no-cleanup
- **Infrastructure Updates**:
  - `build.sh` now builds both llama.cpp and vLLM images
  - `stop.sh` cleans up both llamacpp-* and vllm-* containers
  - Optimized Dockerfiles with --no-cache-dir and --no-install-recommends
  - Enhanced .dockerignore for faster builds
  - Build state stored in .build-state/ (git-ignored)

### Version 0.3.7
- **Optimal Settings Calculator**:
  - Auto-detect hardware (GPU VRAM, CPU cores, RAM)
  - Calculate optimal launch settings per model
  - Settings include: GPU layers, context size, KV cache type, flash attention, threads, batch/micro-batch sizes, parallel slots, repetition control
  - One-click "Apply Optimal" in Launch Settings panel
- **Thinking Model Tags**:
  - Visual "Thinking" tag for reasoning models in My Models
  - Tooltip explaining model capabilities
  - Detection: QwQ, DeepSeek R1, o1, o3, and models with "think" or "reason" in name
- **Autonomous Skill Execution (Koda)**:
  - AI agents can now execute skills directly (create_file, read_file, etc.)
  - Skill format: `[SKILL:skill_name(param1="value1")]`
  - Works in standalone, agent, and collab modes
  - Iterative execution loop with result feedback
- **Backend Improvements**:
  - Fixed skill execution with multi-line content (newlines in file content)
  - Multi-GPU detection and parallel slot optimization
  - Webapp container now has GPU access for hardware detection

### Version 0.3.6
- **Security Enhancements**:
  - **BREAKING CHANGE**: All API endpoints now require authentication (session, API key, or Bearer token)
  - Previously unauthenticated endpoints now return `401 Unauthorized`
  - Enhanced `requireAuth` and `requireAdmin` middleware with proper session checks
- **Koda CLI Enhancements**:
  - **Config Encryption**: Credentials now encrypted with AES-256-CBC (machine-specific key)
  - **Context Window Display**: Status bar now shows `Context: used/limit` alongside token stats
  - **TAB Autocomplete**: Press TAB to cycle through commands and options
  - **Inline Authentication**: `/auth` command now works inline without exiting koda
  - Improved command menu navigation
- **llama.cpp Updates**:
  - Removed unsupported `--ctx-shift-percent` argument (compatibility fix)
- **UI Improvements**:
  - Removed "Common Issues & Solutions" section from Docs tab
  - Expanded microbatch size options (16 to 8192)

### Version 0.3.5
- **API Improvements**:
  - Removed hard-coded token limits (respects API key settings)
  - Better error messages: "Not enough tokens", "Not enough context window", "Token rate limit exceeded"
  - Fixed reasoning model support (handles empty content with reasoning_content fallback)
  - Context window and rate limit detection
- **Koda CLI Enhancements**:
  - Changed "Assistant:" to "Koda:" for branding
  - Added code block formatting with bordered boxes
  - Syntax highlighting for code (language label in header)
  - Better visual distinction for code vs. text

### Version 0.3.4
- **Koda CLI Enhancements**:
  - Improved chat interface with message history
  - Messages appear at top, input stays at bottom
  - Color-coded timestamps for all messages
  - New commands: `/create-agent`, `/file-read`, `/file-write`, `/file-delete`, `/clear`
  - Visual chat UI with persistent history (max 50 messages)
  - Enhanced error handling with chat history integration

### Version 0.3.3
- **Open Model Agents System**: Full agent management with CRUD API
- **Skills Library**: 42+ default skills for file ops, web requests, data processing, Windows management, OCR, email parsing, and more
- **Task Tracking**: Dashboard with status management
- **Cross-Platform CLI**: Interactive shell (koda) for Linux/macOS/Windows
- **File Operations API**: Complete file management for agents
- **Permission System**: Global controls for agent capabilities

### Version 0.3.2
- **Custom Provider Management**: Add external LLM providers (OpenAI, Anthropic, etc.)
- **Enhanced Security**: Added permission checks to model management endpoints

### Version 0.3.0
- **Apps Management Tab**: Centralized service control
- **Concurrent Downloads**: Download multiple models simultaneously
- **Improved Error Handling**: Better user feedback

---

## Support

### Documentation
- Full docs in **Docs** tab (includes API code builder)
- Generate code examples in cURL, Python, PowerShell, JavaScript

### Common Issues
- Self-signed certificates: Use `-k` flag with curl, `verify=False` with requests
- Port conflicts: Check with `netstat -tulpn | grep 300`
- Model compatibility: Check HuggingFace page for llama.cpp support

### Tips
- Use API Code Builder in Docs tab for examples
- Check Logs tab for real-time debugging
- Monitor GPU with `watch -n 1 nvidia-smi`
- Test instances with `curl http://localhost:8001/health`
