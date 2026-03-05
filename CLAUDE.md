# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

# modelserver

**Version:** 0.5.13

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
- **Live Command Completion**: Type `/` to see inline suggestions with Tab completion
- **Animated UI**: Modern spinners for thinking/waiting states with multiple styles
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

# Web Search
/web               # Toggle web search on/off (works in any mode)
/websearch         # Alias for /web
/ws                # Short alias for /web

# Session Management
/clear             # Clear chat history
/clearsession      # Clear context but keep history visible
/help              # Show all available commands
/quit              # Exit koda
```

**Command Completion:** Type `/` and start typing to see inline suggestions. Press Tab to complete.

**Note:** Koda has automatic access to:
- File operations (create, read, update, delete, list)
- Code analysis and quality metrics
- Refactoring suggestions
- Web search and documentation lookup
- Multi-file context management

Just ask naturally - Koda will use the appropriate tools automatically!

**Paste Support:** Multi-line pastes auto-detect and display in a bordered box. Press Enter to send or type a command to cancel.

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
```bash
./build.sh                    # Build all images (parallel, incremental, auto-resume)
./build.sh --no-cache         # Force rebuild without Docker cache
./build.sh --no-parallel      # Sequential builds (for low RAM)
./build.sh --no-resume        # Clear build state, start fresh
./build.sh --retry 3          # Set retry attempts (default: 2)
```
Features: parallel builds, state tracking in `.build-state/`, Dockerfile change detection, auto-retry.

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

# User account management
./scripts/manage-users.sh       # Interactive user management menu
```

### User Account Management
```bash
./scripts/manage-users.sh     # Interactive menu: list/create/delete users, reset passwords
```

### Docker Compose
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

### Available Default Skills (55+)

| Category | Count | Key Skills |
|----------|-------|------------|
| File Operations | 9 | create/read/update/delete_file, create/delete_directory, list_directory, move/copy_file |
| File Content | 5 | append_to_file, tail/head_file, search_replace_file, diff_files |
| Archives | 5 | zip/unzip_file, tar_extract/create, extract_archive |
| File Management | 3 | get_file_metadata, search_files, download_file |
| Process Mgmt | 3 | list/kill/start_process |
| Network & Web | 9 | fetch_url, http_request, dns_lookup, check_port, ping_host, curl_request |
| Playwright | 3 | playwright_fetch/interact, web_search (with content fetching) |
| Git | 4 | git_status, git_diff, git_log, git_branch |
| Environment | 3 | get/set_env_var, which_command |
| JSON/Config | 4 | json_get/set, yaml_parse, ini_parse |
| Database | 2 | sqlite_query, sqlite_list_tables |
| PDF | 6 | read_pdf, pdf_page_count, pdf_to_images, create_pdf, html_to_pdf, markdown_to_html |
| Clipboard | 2 | clipboard_read/write |
| Email | 1 | read_email_file |
| Windows | 5 | run_powershell, run_cmd, get_windows_services, get/set_registry_value |
| Linux/macOS | 2 | run_bash, run_python |
| Image | 3 | ocr_image, screenshot, convert_image |
| Data Processing | 7 | parse_json/csv, base64_encode/decode, hash_data, compress/decompress_data |
| Code Analysis | 2 | analyze_code, find_patterns |
| System Info | 8 | system_info, disk_usage, list_services, get_uptime, list_ports, generate_uuid |

**Note:** Shell execution skills (bash, PowerShell, cmd, Python) are disabled by default for security.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Build interrupted | `./build.sh` (auto-resumes) |
| Build won't restart | `./build.sh --no-resume` |
| OOM during build | `./build.sh --no-parallel` |
| Force fresh rebuild | `./build.sh --no-cache --no-resume` |
| Context size exceeded | Increase context in Launch Settings, reload model |
| Model won't load | Check `docker logs llamacpp-{model}`. Try: reduce GPU layers, use q8_0 cache, enable flash attention |
| Model not found (WSL) | Set `HOST_MODELS_PATH` in `.env`, restart webapp |
| Webapp not responding | `docker compose restart webapp` |
| Session crashes | Rebuild webapp (`docker compose build webapp`) |
| GPU not detected | Reinstall NVIDIA Container Toolkit |
| Koda CLI not found | `export PATH="$HOME/.local/bin:$PATH"` |
| VLM models crash | Use LLaVA variants (Qwen3-VL, Qwen2-VL unsupported)

---

## Model Configuration

All settings in **My Models** > **Launch Settings** have hover tooltips.

| Profile | GPU Layers | Context | Flash Attn | Cache | Slots |
|---------|-----------|---------|------------|-------|-------|
| Default | -1 | 4096 | OFF | f16 | 1 |
| Memory-Constrained | -1 | 2048 | ON | q8_0/q4_0 | 1 |
| High Performance | -1 | 8192+ | ON | f16 | 4-8 |

**Repetitive Output Fix:** Repeat Penalty 1.1-1.2, Repeat Last N 128-256, Presence Penalty 0.2

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
- `scripts/manage-users.sh` - Interactive user account management (list, reset password, delete, create admin)

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

### Version 0.5.13 (Current)
- **Skill Display Fix**: Fixed `[SKILL -` verbose syntax showing in chat by adding regex patterns for variant formats
- **Retry Animation**: Show animation for all skill retry iterations, not just the first one
- **File Save Optimization**: Skip redundant web search when user asks to save previously generated content to file

### Version 0.5.12
- **Command Completion Fix**: Fixed `/mode ` (with space) incorrectly suggesting ` standalone` instead of `standalone`

### Version 0.5.11
- **Live Command Completion**: Type `/` to see inline grayed suggestions; Tab completes commands and mode options
- **Web Search Toggle**: New `/web` command (aliases: `/websearch`, `/ws`) to toggle web search independently of mode

### Version 0.5.10
- **Modern Animated CLI**: Koda now features animated spinners for thinking/waiting states with multiple styles (dots, pulse, arc)
- **User-Friendly Skill Output**: Replaced verbose skill messages with compact animated indicators (e.g., "Creating file" instead of "Executing skill: create_file...")
- **Disabled Skill Protection**: Added client-side check to prevent execution of disabled skills
- **UI Fix**: Fixed user message not displaying when web search starts

### Version 0.5.4
- **Cross-Platform Model Path Detection**: Fixed models failing to load on Windows+WSL and non-standard install paths. Auto-detects host models path from container mounts. Set `HOST_MODELS_PATH` in `.env` for edge cases.

### Version 0.5.3
- **PDF & Report Generation Skills**: New `create_pdf`, `html_to_pdf`, `markdown_to_html` skills

### Version 0.5.2
- **Koda CLI Skill Parsing**: Fixed incomplete skill display during streaming, improved parameter parsing with escape handling

### Version 0.5.1
- **Koda CLI Newline Fix**: Fixed `\n` not converting to actual newlines in skill bracket format

### Version 0.5.0
- **Playwright Web Scraping**: Bot detection avoidance, JS-rendered page support, browser pooling
- **New Skills**: `playwright_fetch`, `playwright_interact`, `web_search` with content fetching

### Version 0.4.x
- **0.4.1**: Enhanced web search with actual page content fetching
- **0.4.0**: 100% client-side skill execution (80+ skills run locally, no server dependency)

### Version 0.3.x (Summary)
- **0.3.21**: All system/git/environment skills now client-side
- **0.3.19-20**: Skills library expanded to 80+ with process management, archives, PDF, database support
- **0.3.17-18**: Clean skill messages, fixed infinite looping, smart completion detection
- **0.3.13-16**: Client-side file operations, token tracking for streaming, paste detection
- **0.3.10-12**: Security fixes (auth middleware), web search enhancements, streaming fixes
- **0.3.9**: Critical stability fix for session crashes, comprehensive error handling
- **0.3.8**: Dual backend support (llama.cpp + vLLM), advanced build system with parallel builds
- **0.3.7**: Optimal settings calculator, thinking model tags, autonomous skill execution
- **0.3.6**: All API endpoints now require authentication, Koda config encryption
- **0.3.3-5**: Open Model Agents system, 42+ skills, cross-platform CLI, API improvements
- **0.3.0-2**: Apps tab, concurrent downloads, custom provider management

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
