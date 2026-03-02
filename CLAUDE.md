# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

# modelserver

**Version:** 0.3.13

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

**Paste Support:** When pasting multi-line text (like articles or code), Koda automatically detects and combines all lines into a single message, displaying them in a clean bordered box format. No special formatting needed - just paste!

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
GET  /api/search?q=query&limit=10&timeRange=m  # Web search using DuckDuckGo
     # Parameters:
     #   q (required) - search query
     #   limit (optional, default 5) - max results
     #   timeRange (optional) - d/w/m/y for day/week/month/year
     # Auto-enhances "recent/latest" queries with current month/year
     # Returns: { query, enhancedQuery, results, count }

GET  /api/docs                         # Fetch documentation
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

Skills are JavaScript functions that agents can execute. Create via **Agents** tab > **Skills**.

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

### Version 0.3.13 (Current)
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
- **Skills Library**: 27+ default skills for file ops, web requests, data processing
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
