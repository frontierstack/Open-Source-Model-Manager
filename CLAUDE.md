# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Open Source Model Manager is a containerized MLOps platform for serving and managing LLMs with dual backend support (llama.cpp and vLLM), a web UI, and an autonomous AI agent system (Koda).

### Key Components

- **webapp/** - Main Express backend (model management, agents, skills system, OpenAI-compatible API)
- **chat/** - Lightweight React chat-only frontend (proxies to webapp)
- **agents-cli/** - Koda CLI terminal-based AI agent interface
- **llamacpp/** - llama.cpp base Docker image (GGUF support, older GPUs)
- **vllm/** - vLLM base Docker image (HuggingFace + GGUF, newer GPUs)

## Common Development Commands

### Build System

```bash
# Initial build (parallel, ~20-25 minutes)
./build.sh

# Sequential build (low memory systems)
./build.sh --no-parallel

# Force rebuild (ignore cache and previous state)
./build.sh --no-cache --no-resume

# Resume interrupted build
./build.sh
```

The build system tracks state in `.build-state/` and only rebuilds when Dockerfiles change.

**Docker Build Notes:**
- `.dockerignore` files in `webapp/` and `chat/` prevent host `node_modules` from being copied
- This ensures `npm install` runs fresh inside the container with correct dependencies
- Critical for avoiding version mismatches between host and container packages

### Starting/Stopping Services

```bash
# Start all services
./start.sh

# Stop all services
./stop.sh

# Reload webapp only (quick restart after code changes)
./reload.sh webapp

# Reload all services (preserves data)
./reload.sh all

# Update webapp (rebuild and restart webapp container)
./update.sh
```

### Development Workflow

**IMPORTANT: Restart vs Rebuild**

- `docker compose restart <service>` - Only restarts the container with the EXISTING image. Does NOT pick up code changes.
- `docker compose up -d --build <service>` - Rebuilds the image and restarts. USE THIS after code changes.

**Frontend changes (webapp React UI):**
```bash
cd webapp
npm run build                         # Build React bundle on host
docker compose up -d --build webapp   # Rebuild image and restart container
```

**Backend changes (webapp server.js):**
```bash
docker compose up -d --build webapp   # Rebuild image and restart container
```

**Chat frontend changes:**
```bash
cd chat
npm run build                       # Build React bundle on host
docker compose up -d --build chat   # Rebuild image and restart container
```

**Quick reference:**
```bash
# After ANY code change to webapp or chat:
docker compose up -d --build webapp chat

# View rebuild progress:
docker compose up --build webapp 2>&1 | tail -20
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
```

### Running a Single Test

This project does not currently have automated tests. Testing is done manually through:
- Web UI at https://localhost:3001
- Chat UI at https://localhost:3002
- API testing via curl or Postman
- Koda CLI testing via `koda` command

## Architecture

### Multi-Tier Microservices Design

**Backend API Layer (webapp):**
- Monolithic Express application in `webapp/server.js` (334KB file)
- Handles authentication, model management, agent/skill orchestration, OpenAI-compatible endpoints
- Integrates with Docker API via `dockerode` for dynamic model container creation
- WebSocket server for real-time logs, progress updates, and streaming

**Frontend Layers:**
- **Main UI**: React + Material-UI (`webapp/src/`) - full management interface
- **Chat UI**: React + Tailwind CSS (`chat/src/`) - lightweight chat-only interface

**Dynamic Model Services:**
- Model instances run as auto-created Docker containers (vLLM or llama.cpp)
- Each instance gets unique port allocation (starting from 5000+)
- Containers communicate on `modelserver_default` Docker network
- Model files mounted read-only from `./models` directory

### Data Persistence

All application data stored in `/models/.modelserver/` as JSON files:
- `agents.json` - Agent definitions
- `skills.json` - Skill definitions and Python code
- `tasks.json` - Task records
- `api-keys.json` - Generated API credentials
- `conversations/` - Chat conversation history

**Caching Strategy:**
- 5-minute TTL in-memory cache for frequently-read data
- Cache invalidated immediately on write operations
- Graceful degradation (returns `[]` if file missing)

### Agent & Skills System

**Skills** are JSON definitions with Python code:
```javascript
{
  id: string,
  name: string,
  code: string,  // Python code executed in subprocess
  parameters: {...},
  enabled: boolean
}
```

**Skill Execution:**
1. Python code written to `/tmp/skill_*.py`
2. Parameters passed via JSON file (avoids shell escaping)
3. Executed with 30s timeout, 10MB buffer limit
4. JSON output parsed and returned

**File Chunking for Large Files:**
The `read_file` skill supports chunking for files that exceed context limits:
- `startLine`/`endLine`: Read specific line ranges
- `chunkIndex`/`chunkSize`: Read file in chunks (default 500 lines/chunk)
- Returns `FILE_TOO_LARGE` warning with metadata when content exceeds limits
- Agent can then request specific chunks to read incrementally

**Agents** are autonomous entities that orchestrate skills:
```javascript
{
  id: UUID,
  name: string,
  modelName: string,        // Model to use for reasoning
  systemPrompt: string,
  skills: string[],         // Array of skill names
  permissions: string[],    // e.g., 'agents', 'skills', 'models', 'query'
  apiKey: string
}
```

### Authentication Architecture

**Three authentication methods** (all handled by `requireAuth()` middleware):

1. **Session-based** (Passport + file store) - Web UI
   - Cookies: `modelserver.sid`
   - 7-day TTL, shared between webapp and chat containers

2. **API Key + Secret headers** - Programmatic access
   - Headers: `X-API-Key`, `X-API-Secret`
   - Stored in `api-keys.json`

3. **Bearer token** - API clients
   - Header: `Authorization: Bearer <api-key>`

**Permission System:**
- Permissions: `agents`, `skills`, `models`, `query`, `query_web`, `admin`
- Checked via `hasPermission(keyObj, requiredPermission)`
- Stored in `agent-permissions.json`

### Model Management

**Dual Backend Architecture:**
- **llama.cpp**: GGUF models, Maxwell 5.2+ GPUs, CPU offload support
- **vLLM**: HuggingFace + GGUF models, Pascal 6.0+ GPUs, high throughput

**Model Instance Lifecycle:**
1. User requests load via `POST /api/models/:modelName/load`
2. Backend selects primary GGUF file (handles split models)
3. Allocates unique port and generates container name
4. Creates Docker container with:
   - Environment variables (model path, config params)
   - GPU access (nvidia runtime)
   - Volume mounts (read-only models directory)
   - Network mode `modelserver_default`
5. Stores instance metadata in `modelInstances` Map
6. Monitors health and streams logs via WebSocket

**Context Window Management:**
- Estimates tokens (1 token ≈ 4 characters)
- Reserves 20% for response (configurable)
- Context shifting truncates input if needed
- Pre-emptive checks prevent OOM errors

**Map-Reduce Chunking for Large Content:**
When content exceeds the model's context window, the system automatically uses a map-reduce strategy:

1. **Detection**: Content tokens > available context triggers chunking
2. **Condensation**: Query-focused extraction reduces content by ~60% (optional)
3. **Splitting**: Content split into overlapping chunks (300 token overlap)
4. **Map Phase**: Chunks processed in parallel (max 8 concurrent)
5. **Reduce Phase**: Partial responses synthesized into coherent final response

Configuration in `webapp/server.js`:
```javascript
const CHUNKING_CONFIG = {
    enabled: true,
    minTokensForChunking: 2000,  // Minimum tokens to trigger map-reduce
    overlapTokens: 300,          // Token overlap between chunks (reduced for speed)
    maxParallelChunks: 8,        // Concurrent chunk processing (increased for speed)
    synthesisPromptReserve: 500, // Tokens reserved for synthesis
    chunkTimeout: 300000,        // 5 minute timeout per chunk
    maxRetries: 3,               // Retry failed chunks with exponential backoff
    enableCondensation: true,    // Pre-condense content using query-focused extraction
    condensationRatio: 0.4,      // Keep 40% of content (60% reduction target)
    minSentencesToKeep: 50,      // Minimum sentences to retain
};
```

**Content Condensation:**
Before chunking, content can be condensed using query-focused extractive summarization:
- Extracts keywords from user's query
- Scores sentences by relevance to query keywords
- Keeps most relevant sentences (default: 40% of content)
- May avoid chunking entirely if condensed content fits context window

API parameter: `chunkingStrategy: 'auto' | 'map-reduce' | 'truncate' | 'none'`

SSE events during map-reduce:
- `{ type: 'chunking_progress', phase: 'chunking|map|reduce|complete', ... }`
- Final event includes: `{ mapReduce: { enabled: true, chunkCount, synthesized, failedChunks } }`

### Frontend State Management (Zustand)

**Main webapp stores** (`webapp/src/stores/`):
- `useAuthStore` - Authentication state, user info
- `useAppStore` - UI state (tabs, dialogs, snackbars, theme)
- `useModelsStore` - Models, instances, downloads
- `useAgentsStore` - Agents, skills, tasks
- `useChatStore` - Conversations, messages, streaming state

**Chat webapp store** (`chat/src/`):
- Single store for conversations and settings
- Persisted to localStorage
- Settings include: model, temperature, topP, maxTokens, fontSize, fontFamily

**Chat UI Settings (`chat/src/components/chat/ChatSettings.jsx`):**
- Temperature slider with tooltip (0.0-2.0)
- Top P slider with tooltip (0.0-1.0)
- Max tokens presets (512, 1024, 2048, 4096, 8192)
- Font size selection (small, medium, large)
- Font family selection (50+ fonts: Sans-serif, Serif, Monospace categories)
- Theme selection (25+ themes including nature, dev, warm tones, neutral)
- System prompt textarea (resizable)
- Modal size: 720px width, 90vh max height

**Background Streaming:**
- If user refreshes page or switches conversations during model generation, the server continues processing in background
- Response is saved to conversation when complete
- User sees the completed response when returning to the conversation
- Server tracks active streams via `activeStreamingJobs` Map
- Client polls `/api/conversations/:id/streaming` for status updates
- Logs: `[Chat Stream] Client disconnected... continuing in background`

### WebSocket Integration

**Connection:** `wss://localhost:3001` (upgraded from HTTP)

**Message Types:**
- `{ type: 'log', message, level }` - Container/system logs
- `{ type: 'status', message }` - Status updates
- `{ type: 'progress', downloadId, progress, speed }` - Download progress
- `{ type: 'download_removed', downloadId }` - Download completed/failed

**Per-User Broadcasting:**
- User ID extracted from session/auth
- Messages filtered by `targetUserId`
- Used for model loading logs, download progress

### Key API Routes

**Authentication:**
- `POST /api/auth/register` - Create first admin (subsequent users are regular users)
- `POST /api/auth/login` - Session login
- `GET /api/auth/me` - Current user info

**Model Management:**
- `POST /api/models/pull` - Download from HuggingFace
- `GET /api/models` - List available models
- `POST /api/models/:modelName/load` - Launch model instance
- `POST /api/system/optimal-settings` - Hardware-based recommendations

**Chat & Query:**
- `POST /api/chat/stream` - Streaming chat completions (SSE)
- `POST /api/chat` - Single message (delegates to stream if needed)
- `POST /api/chat/upload` - Upload files for chat (images, PDFs, text files)

**Vision Model Support:**
- Chat UI supports sending images to vision-capable models using OpenAI vision format
- Images are converted to base64 data URLs and included in message content array
- Format: `{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }`

**Thinking Model Support:**
- Chat UI parses `<think>` tags from thinking models (Qwen, DeepSeek R1, etc.)
- Reasoning content is separated and displayed in a collapsible "thinking" area
- Supports both streaming and final message processing
- Continue button for interrupted responses (when `finish_reason: 'length'`)
- Automatically detects cut-off responses and offers to continue generation

**Web Scraping (Scrapling Integration):**
- Scrapling (`webapp/services/scraplingService.js`) provides CAPTCHA-evading web scraping
- Uses Python's `StealthyFetcher` for anti-bot detection bypass
- Fallback chain: Scrapling → Playwright → axios
- Search fallback chain: DuckDuckGo → Scrapling → Brave Search
- Files: `webapp/services/scrapling_fetch.py` (Python), `webapp/services/scraplingService.js` (Node.js wrapper)

**URL Fetch (Chat Feature):**
- `POST /api/url/fetch` - Fetch content from URLs in chat messages
- Accepts `{ urls: string[], maxLength?: number, timeout?: number }`
- Limited to 3 URLs per request
- Uses same fallback chain as web scraping (Scrapling → Playwright → axios)
- Returns `{ results: [{ url, success, content, title, source, error }] }`
- Chat UI toggle: Link icon (🔗) enables automatic URL detection and fetching
- Fetched content is included as context for the model

**Email Parsing (Nested Attachments):**
- Supports `.eml` and `.msg` file formats via `mailparser` and `msgreader`
- Recursive extraction of nested attachments (emails within emails)
- Extracts PDF, DOCX, images, and text from attachments up to 3 levels deep
- OCR support for images in attachments via Tesseract

**Agent & Skills:**
- `GET /api/agents` - List user's agents
- `POST /api/agents` - Create agent
- `GET /api/skills` - List available skills
- `POST /api/skills` - Create skill
- `POST /api/skills/:skillName/execute` - Execute skill (requires 'agents' permission)

**System:**
- `GET /api/system/resources` - GPU/CPU/RAM stats (nvidia-smi)
- `GET /api/huggingface/search` - Search HuggingFace models

### Docker Integration

**Container Spawn Process:**
```javascript
// Backend allocates next available port
port = findNextAvailablePort(); // Starting from 5000

// Creates container with pre-built base image
docker.createContainer({
  Image: 'modelserver-vllm:latest',
  name: 'vllm-modelname',
  Env: [
    'VLLM_MODEL_PATH=/models/modelname/model.gguf',
    'VLLM_PORT=5000',
    'VLLM_MAX_MODEL_LEN=4096',
    // ...config parameters
  ],
  HostConfig: {
    Binds: ['/host/models:/models:ro'],
    NetworkMode: 'modelserver_default',
    DeviceRequests: [{
      Driver: 'nvidia',
      Count: -1,  // All GPUs
      Capabilities: [['gpu']]
    }]
  }
});
```

**Host Path Detection:**
- `detectHostModelsPath()` inspects webapp container mounts
- Extracts source path for `/models` destination
- Needed to create new containers with correct bindings
- Fallback to `HOST_MODELS_PATH` env var if inspection fails

### Koda CLI System

**Entry point:** `agents-cli/bin/koda.js` (324KB monolithic file)

**Key features:**
- Interactive REPL with command-based interface (`/help`, `/agents`, `/skills`)
- Code analysis via `@babel/parser` for JavaScript/Python
- Multi-file working set tracking (MAX 20 files)
- Skill execution and agent collaboration
- File operations with git-aware changes
- Web capabilities (search, scrape, email parsing)

**Installation:**
```bash
curl -sk https://localhost:3001/api/cli/install | bash
koda
/auth    # Enter API key from Web UI
```

## Important Patterns & Conventions

### Optimistic Updates

Frontend stores update immediately, then sync with server:
```javascript
// UI: Instant feedback
store.addSkill(skill);

// Background: Async API call
POST /api/skills
  .then(/* server confirms */)
  .catch(() => store.removeSkill()); // Rollback on error
```

### In-Memory Model Registry

`modelInstances` Map provides O(1) lookup instead of querying Docker API repeatedly:
```javascript
modelInstances.set(modelName, {
  containerId,
  containerName,
  port,
  status: 'starting',
  config,
  backend: 'vllm' | 'llamacpp'
});
```

### SSE for Streaming Responses

OpenAI-compatible streaming via Server-Sent Events:
```javascript
// Backend
res.setHeader('Content-Type', 'text/event-stream');
res.write(`data: ${JSON.stringify(chunk)}\n\n`);

// Client
EventSource or fetch with text/event-stream
```

### Code Location Reference Format

When referencing code locations, use the pattern `file_path:line_number`:
```
Example: "Error handling is in webapp/server.js:1234"
```

## Security Considerations

**Implemented:**
- Helmet HTTP security headers (CSP, X-Frame-Options, etc.)
- bcryptjs password hashing (cost 10)
- Rate limiting on auth (15min/10 attempts) and API (60s/100 requests)
- Permission-based access control
- HttpOnly, Secure, SameSite=Lax cookies

**Known Gaps:**
- No email verification (TODO comments in code)
- No audit logging
- Flat JSON file storage (no encryption)
- SSL certificate validation disabled in Python skill execution
- Input sanitization needed for Playwright/shell execution in skills

## Common Troubleshooting

### Build Issues
```bash
./build.sh                # Resume interrupted build
./build.sh --no-parallel  # Low memory systems
rm -rf .build-state/      # Clear corrupted state
```

### Service Issues
```bash
docker compose up -d --build webapp   # Rebuild and restart webapp (after code changes)
docker compose restart webapp         # Quick restart (NO code changes, just restart process)
docker compose logs -f webapp         # View logs
nvidia-smi                            # Check GPU
```

### Model Loading Issues
- Check logs: `docker compose logs -f webapp`
- Verify GPU access: `docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi`
- Check host path detection in webapp logs
- For Windows+WSL, may need to set `HOST_MODELS_PATH` in docker-compose.yml

### Port Conflicts
```bash
netstat -tulpn | grep 3001
# If port in use, stop conflicting service or change port in docker-compose.yml
```

## Project-Specific Notes

### No Automated Testing

This project does not have a test suite. Testing is manual:
- Web UI testing at https://localhost:3001
- API testing via curl/Postman
- Model inference testing through chat interfaces

### Environment Variables

Create `.env` file in project root:
```bash
HUGGING_FACE_HUB_TOKEN=hf_xxx    # For model downloads
SESSION_SECRET=auto-generated    # Auto-generated if not set
HOST_IP=192.168.1.100            # Optional: for container networking
# HOST_MODELS_PATH=/host/path/to/models  # Optional: manual path override
```

### SSL Certificates

Self-signed certificates auto-generated by `./build.sh` or `./start.sh`:
- Located in `./certs/`
- Valid for 365 days
- Browser will show security warning (expected for local development)

### Data Persistence

User data, agents, skills, and conversations persist in:
- `./models/.modelserver/` (flat JSON files)
- `webapp_data` Docker volume (for sessions)

To reset all data:
```bash
./reset.sh
```

### Backend Image Build Times

- **llamacpp**: 20-30 minutes (CUDA compilation)
- **vllm**: 10-15 minutes (Python packages)
- **webapp**: 2-5 minutes (npm install + webpack)

Parallel builds (`./build.sh` default) run llamacpp + vllm simultaneously.

### Code Style

- Backend: Node.js with ES6+ features, no TypeScript
- Frontend: JSX with Material-UI (webapp) or Tailwind CSS (chat)
- No linting configuration present
- Code comments are sparse; rely on code structure and this document
