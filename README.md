# Open Source Model Manager

> **A Production-Ready MLOps Platform for Large Language Models**

Containerized platform for serving and managing LLMs with dual backend support, web UI, chat interface, and an autonomous AI agent system.

<p align="center">
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-24.0%2B-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="License"></a>
  <a href="https://developer.nvidia.com/cuda-toolkit"><img src="https://img.shields.io/badge/CUDA-12.1-76B900?style=flat-square&logo=nvidia&logoColor=white" alt="CUDA"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python"></a>
</p>

---

## Features

### Dual Backend Support

| Backend | GPU Requirement | Best For |
|---------|-----------------|----------|
| **llama.cpp** | Maxwell 5.2+ (GTX 900, Quadro M4000) | GGUF models, older GPUs, CPU offload |
| **vLLM** | Pascal 6.0+ (GTX 1000+, Quadro P+) | High throughput, newer GPUs |

### Core Capabilities

- **HuggingFace Integration** — Search and download GGUF models directly
- **Auto-Configuration** — Optimal settings based on hardware detection
- **Real-time Monitoring** — WebSocket-based live logs, status, and download progress
- **Multi-User Support** — Authentication with session management and API keys
- **OpenAI-Compatible API** — Drop-in replacement for OpenAI endpoints
- **Vision Models** — Send images to vision-capable models (LLaVA, Qwen-VL) with OCR fallback for non-vision models
- **Thinking Models** — Parse and display reasoning from models like DeepSeek R1 and Qwen QwQ
- **Map-Reduce Chunking** — Automatically splits large content across multiple model calls and synthesizes results
- **AIMem Memory Compression** — Compresses older conversation history to reduce token usage, speeding up inference and lowering VRAM consumption during long conversations
- **Background Streaming** — Responses continue server-side if you navigate away, saved on completion
- **Auto-Continuation** — Automatically continues truncated responses up to 8 times

### Native Tool Calling

The chat model can invoke tools on its own via OpenAI-style function calls. Every enabled skill in your workspace is surfaced to the model as a named tool; the UI renders each call as an inline chip showing the tool name, arguments, and (on click) the full result. There are no "web search" or "URL fetch" toggles anymore — the model decides when to reach for them.

- **Catalog built from your skill registry** — toggling a skill off in Settings removes it from the tool catalog the model sees on the next turn
- **Streamed tool chips** — `native_tool_call` events render live below the assistant message while the model works
- **Multi-round reasoning** — the model can call several tools in sequence and see each result before responding
- **Shipped tools include** — `web_search` (DuckDuckGo → Scrapling → Brave → Playwright fallback chain), `fetch_url` (direct file download for PDF/DOCX/XLSX then Scrapling/Playwright/axios for HTML), `crawl_pages`, `playwright_fetch` / `playwright_interact` for JS-rendered pages, `scrapling_fetch` for CAPTCHA-evading fetches, `dns_lookup`, `virustotal_lookup`, `base64_decode`, plus every built-in skill (file ops, git, system info, OCR, PDF, email parsing, and more)
- **No silent dead-ends** — if the tool-iteration cap is reached, the model still returns a final user-visible message

### Web Scraping & Search

- **[Scrapling](https://github.com/D4Vinci/Scrapling) Integration** — CAPTCHA-evading web scraping with StealthyFetcher
- **Multi-Engine Search** — DuckDuckGo → Scrapling → Brave Search → Playwright
- **Smart Content Extraction** — Playwright SPA/XHR interception, direct file download for PDFs/DOCX/XLSX

### AIMem — Memory Compression

Long conversations consume increasing amounts of context window and VRAM. AIMem compresses older messages before they're sent to the model, reducing token count while preserving all factual content.

- **4-stage pipeline** — Semantic deduplication, lossy prompt compression, symbolic shorthand, and relevance-gated retrieval
- **~48% token reduction** with 100% fact retention (benchmarked across 47 strategy combinations)
- **Faster responses** — Fewer input tokens means faster time-to-first-token and lower VRAM pressure
- **Transparent** — Enable per-model via the "Compress Memory" toggle in the model manager; all clients (Chat UI, Koda, API) respect the setting automatically
- **Smart triggering** — Only activates when conversations have 6+ messages and input exceeds 60% of available context, keeping short conversations untouched

### Chat Interface

Lightweight React + Tailwind CSS chat UI at `https://localhost:3002`:

- Native tool-call chips rendered inline with each assistant message
- 18 themes and 6 chat layouts (Default, Centered, Timeline, Bubbles, Slack, Minimal)
- 54 font choices with dynamic Google Fonts loading
- Clipboard image paste and drag-and-drop file attachments
- Paste-as-file for large text (500+ chars auto-converted to attachment)
- Email file parsing (.eml, .msg) with nested attachment extraction
- OCR text extraction for uploaded images via Tesseract

<p align="center">
  <img src="docs/images/chat-ui.png" alt="Chat UI with native tool-call chips (web_search, scrapling_fetch) rendered inline with the assistant response" width="800">
</p>

<p align="center">
  <em>The model decides to call <code>web_search</code>, reads the results, and follows up with <code>scrapling_fetch</code> to pull a full page — each call appears as a clickable chip below the response.</em>
</p>

### Koda — AI Agent TUI

Your autonomous AI project assistant running as an interactive terminal user interface:

```
  ██╗  ██╗ ██████╗ ██████╗  █████╗
  ██║ ██╔╝██╔═══██╗██╔══██╗██╔══██╗
  █████╔╝ ██║   ██║██║  ██║███████║
  ██╔═██╗ ██║   ██║██║  ██║██╔══██║
  ██║  ██╗╚██████╔╝██████╔╝██║  ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
  Your AI project assistant
```

- 74 default skills across 20 categories (file ops, git, web, email, OCR, PDF, system info, and more)
- Multi-agent collaboration for complex tasks
- Autonomous skill execution with false-completion detection
- AES-256 encrypted credentials
- Cross-platform (Linux, macOS, Windows)

---

## Prerequisites

**Required:** Docker 24.0+ with Compose v2, Linux (Ubuntu 20.04+), 4GB RAM minimum (8GB+ recommended)

**Optional:** NVIDIA GPU with Container Toolkit, HuggingFace token (for gated models)

---

## Quick Start

```bash
# Clone and build
git clone https://github.com/frontierstack/Open-Source-Model-Manager.git
cd Open-Source-Model-Manager

# Optional: set HuggingFace token
echo "HUGGING_FACE_HUB_TOKEN=hf_xxx" > .env

# Build and start (~20-25 min first time)
./build.sh && ./start.sh
```

| Interface | URL |
|-----------|-----|
| Web UI | https://localhost:3001 |
| Chat UI | https://localhost:3002 |

### Build Options

```bash
./build.sh                         # Parallel build (default)
./build.sh --no-parallel           # Sequential (low memory)
./build.sh --no-cache --no-resume  # Force full rebuild
```

---

## Usage

### Web Interface

1. Navigate to https://localhost:3001
2. Register account (first user = admin)
3. **Discover** — Search and download models
4. **My Models** — Launch and manage instances
5. **API Keys** — Generate access tokens
6. **Docs** — API code builder with 70+ endpoints in 4 languages

### Koda TUI

```bash
# Install and start
curl -sk https://localhost:3001/api/cli/install | bash
koda

# Authenticate and initialize
/auth    # Enter API key from Web UI
/init    # Analyze project structure

# Pick up where you left off
koda --continue              # resume the most recent session for this directory
koda --resume <session-id>   # resume a specific session (no id → list)
koda --yolo                  # skip every confirmation (combinable with --continue)

# Key commands
/help              # Show all commands
/files             # Show files Koda has loaded into context
/sessions          # List saved sessions
/memory add <note> # Save a note Koda remembers across launches
/yolo              # Skip every confirmation prompt this session
/quit              # Exit
```

Koda also auto-loads a `KODA.md`, `koda.md`, `CLAUDE.md`, or `AGENTS.md` from the current directory and injects it into every prompt as project guidance — drop in your conventions and Koda picks them up without restarting.

See [COMMANDS.md](COMMANDS.md) for complete command reference.

### API

OpenAI-compatible endpoints work with any OpenAI SDK client:

```bash
curl -sk https://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "model-name", "messages": [{"role": "user", "content": "Hello!"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://localhost:3001/v1", api_key="YOUR_API_KEY")
response = client.chat.completions.create(
    model="model-name",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

---

## Configuration

### Environment Variables

```bash
HUGGING_FACE_HUB_TOKEN=hf_xxx         # For gated model downloads
HOST_IP=192.168.1.100                  # Container networking (auto-detected)
HOST_MODELS_PATH=/mnt/d/models         # Override models path (Windows+WSL)
NODE_TLS_REJECT_UNAUTHORIZED=0         # SSL bypass for corporate proxies
SESSION_SECRET=your-secret             # Auto-generated if not set
```

### Ports

| Service | Port | Purpose |
|---------|------|---------|
| Webapp | 3001 | HTTPS — Management UI, REST API, WebSocket, OpenAI-compatible endpoints |
| Chat | 3002 | HTTPS — Lightweight chat-only interface (proxies to Webapp API) |
| Models | 8001+ | Model inference instances, bound to localhost only (not network-exposed) |

---

## Architecture

```
                    ┌───────────┐  ┌───────────┐  ┌───────────┐
                    │  Browser  │  │  Browser  │  │ Terminal  │
                    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
                          │              │              │
                        HTTPS          HTTPS          HTTPS
                          │              │              │
          ┌───────────────┼──────────────┼──────────────┼───────────────┐
          │               ▼              ▼              ▼               │
          │  ┌────────────────────┐ ┌──────────┐ ┌───────────────┐     │
          │  │   Webapp  :3001   │ │Chat :3002│ │  Koda TUI     │     │
          │  │                    │ │          │ │  (API client) │     │
          │  │  React Frontend    │ │ React +  │ └───────┬───────┘     │
          │  │  Express API       │ │ Tailwind │         │             │
          │  │  WebSocket Server  │ │ 18 Themes│   :3001/api           │
          │  │  74 Skills Engine  │ │ 6 Layouts│         │             │
          │  │  Native Tool Calls │ │Tool Chips│         │             │
          │  │  OpenAI Endpoints  │ │ OCR/File │         │             │
          │  │  Web Scraping      │ │ Uploads  │         │             │
          │  │  Map-Reduce        │ └────┬─────┘         │             │
          │  │  Docker Integration│      │               │             │
          │  └─────────┬──────────┘      │               │             │
          │            │◄────────────────┘───────────────┘             │
          │            │                                               │
          │            ▼                                               │
          │  ┌──────────────────┐                                      │
          │  │  Docker Engine   │                                      │
          │  └────────┬─────────┘                                      │
          │           │                                                │
          │     ┌─────┴──────┐                                         │
          │     ▼            ▼                                         │
          │  ┌────────┐  ┌────────┐                                    │
          │  │llamacpp│  │  vllm  │  Dynamic instances on :8001+       │
          │  │Maxwell │  │Pascal  │  Bound to localhost only           │
          │  │ 5.2+   │  │ 6.0+  │  Models mounted read-only          │
          │  └────┬───┘  └───┬────┘                                    │
          │       └─────┬────┘                                         │
          │             ▼                                               │
          │  ┌──────────────────┐                                      │
          │  │  NVIDIA GPU(s)   │                                      │
          │  │  CUDA 12.1       │                                      │
          │  │  Shared VRAM     │                                      │
          │  └──────────────────┘                                      │
          └────────────────────────────────────────────────────────────┘
```

**Data Persistence:** All user data stored in `./models/.modelserver/` as JSON files (agents, skills, conversations, API keys with AES-256-GCM encryption). Model containers mount `./models` read-only.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Build fails / interrupted | `./build.sh` (auto-resumes) |
| Out of memory during build | `./build.sh --no-parallel` |
| Corrupted build state | `rm -rf .build-state/ && ./build.sh` |
| Model OOM errors | Reduce GPU layers, use q8_0/q4_0 cache type |
| Port 3001 in use | `netstat -tulpn \| grep 3001` to find conflict |
| GPU not detected | Reinstall NVIDIA Container Toolkit, test with `nvidia-smi` |
| Koda not found | `export PATH="$HOME/.local/bin:$PATH"` |
| SSL/corporate proxy errors | `echo "NODE_TLS_REJECT_UNAUTHORIZED=0" >> .env` |

```bash
# Common diagnostic commands
docker compose logs -f webapp       # View webapp logs
docker compose ps                   # Check service status
nvidia-smi                          # Check GPU
docker stats                        # Container resource usage
```

---

## Documentation

- **[COMMANDS.md](COMMANDS.md)** — Complete command and feature reference
- **[Docs Tab](https://localhost:3001)** — Interactive API code builder (70+ endpoints, 4 languages)

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/name`)
3. Commit and push changes
4. Open Pull Request

---

## License

MIT License — see [LICENSE](LICENSE).

## Acknowledgments

[llama.cpp](https://github.com/ggerganov/llama.cpp) | [vLLM](https://github.com/vllm-project/vllm) | [HuggingFace](https://huggingface.co/) | [Scrapling](https://github.com/D4Vinci/Scrapling) | [Playwright](https://playwright.dev/) | [Material-UI](https://mui.com/)

---

## Support

[GitHub Issues](https://github.com/frontierstack/Open-Source-Model-Manager/issues) | [GitHub Discussions](https://github.com/frontierstack/Open-Source-Model-Manager/discussions)

<div align="center">

**Built for the Open Source AI Community**

[Back to Top](#open-source-model-manager)

</div>
