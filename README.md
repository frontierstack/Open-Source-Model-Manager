# Open Source Model Manager

> **A Production-Ready MLOps Platform for Large Language Models**

Containerized platform for serving and managing LLMs with dual backend support, web UI, and autonomous AI agent system.

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

- Seamless backend switching per model
- Optimized for GGUF quantized models

### Core Capabilities

- **HuggingFace Integration** — Search and download GGUF models directly
- **Auto-Configuration** — Optimal settings based on hardware detection
- **Real-time Monitoring** — WebSocket-based live logs and status
- **Multi-User Support** — Authentication with session management
- **OpenAI-Compatible API** — Drop-in replacement for OpenAI endpoints
- **Production-Ready** — Comprehensive error handling prevents crashes

### Koda — AI Agent System

Your autonomous AI project assistant with direct skill execution:

```
  ██╗  ██╗ ██████╗ ██████╗  █████╗
  ██║ ██╔╝██╔═══██╗██╔══██╗██╔══██╗
  █████╔╝ ██║   ██║██║  ██║███████║
  ██╔═██╗ ██║   ██║██║  ██║██╔══██║
  ██║  ██╗╚██████╔╝██████╔╝██║  ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
  Your AI project assistant

[2:18:15 PM] You: Hello Koda!
[2:18:16 PM] Koda: Hi! I'm ready to help with your project.
```

**Key Features:**
- Autonomous skill execution (55+ built-in skills)
- Multi-agent collaboration for complex tasks
- Email parsing (.eml and .msg Outlook format)
- AES-256 encrypted credentials
- Cross-platform (Linux, macOS, Windows)

---

## Prerequisites

### Required

- **Docker** 24.0+ with Compose v2
- **Linux** (Ubuntu 20.04+)
- **4GB RAM** minimum (8GB+ recommended)

### Optional

- **NVIDIA GPU** with Container Toolkit
- **HuggingFace Token** (for gated models)

---

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/frontierstack/Open-Source-Model-Manager.git
cd Open-Source-Model-Manager

# 2. Create environment file
cat > .env << EOF
HUGGING_FACE_HUB_TOKEN=your_token_here
EOF

# 3. Build and start
./build.sh    # Parallel build (~20-25 min)
./start.sh    # Start services (auto-generates SSL certs)
```

**Access:** https://localhost:3001

### Build Options

```bash
./build.sh                         # Parallel build (default)
./build.sh --no-parallel           # Sequential (low memory)
./build.sh --no-cache --no-resume  # Force rebuild
```

---

## Usage

### Web Interface

1. Navigate to https://localhost:3001
2. Register account (first user = admin)
3. **Discover** → Search/download models
4. **My Models** → Launch instances
5. **API Keys** → Generate access tokens

### Koda CLI

```bash
# Install
curl -sk https://localhost:3001/api/cli/install | bash

# Start and authenticate
koda
/auth    # Enter API key from Web UI
/init    # Analyze project

# Common commands
/help              # Show all commands
/file-read <path>  # Read file
/agents            # List agents
/quit              # Exit
```

See [COMMANDS.md](COMMANDS.md) for complete command reference.

### API Usage

```bash
# OpenAI-compatible endpoint
curl -sk https://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "model-name", "messages": [{"role": "user", "content": "Hello!"}]}'
```

```python
# Python OpenAI SDK
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
HUGGING_FACE_HUB_TOKEN=hf_xxx    # For model downloads
SESSION_SECRET=your-secret        # Auto-generated if not set
HOST_IP=192.168.1.100            # Container networking
```

### Ports

| Service | Port | Purpose |
|---------|------|---------|
| Webapp | 3001 | HTTPS Web UI & API |
| Webapp | 3080 | HTTP Internal API |
| Models | 8001+ | Dynamic model instances |

### Backend Settings

**llama.cpp** — Best for older GPUs, CPU offload
```
GPU Layers: -1 (all)
Context: 4096
Cache Type: f16/q8_0/q4_0
Parallel Slots: 1-8
```

**vLLM** — Best for newer GPUs, high throughput
```
Max Model Len: 4096
GPU Memory: 0.9
Tensor Parallel: 1
Max Seqs: 256
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Client Layer                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User Browser                          Terminal (Koda CLI)          │
│       │                                       │                     │
│       └── HTTPS (3001) ──→ Web UI             │                     │
│                                               │                     │
│                                        API (HTTPS/3001)             │
│                                               │                     │
└───────────────────────────────────────────────┼─────────────────────┘
                                                │
┌───────────────────────────────────────────────┼─────────────────────┐
│                         Application Layer                           │
├─────────────────────────────────────────────────────────────────────┤
│                                               │                     │
│                    ┌──────────────────────────▼──────────────────┐  │
│                    │        Webapp Container (3001/3080)         │  │
│                    │  ┌──────────────────────────────────────┐   │  │
│                    │  │  React Frontend (Web UI)             │   │  │
│                    │  └──────────────────────────────────────┘   │  │
│                    │  ┌──────────────────────────────────────┐   │  │
│                    │  │  Express API Server                  │   │  │
│                    │  │  • Authentication & Sessions         │   │  │
│                    │  │  • Model Management                  │   │  │
│                    │  │  • Agent & Skills System (55+ skills)│   │  │
│                    │  │  • Docker API Integration            │   │  │
│                    │  │  • OpenAI-Compatible Endpoints       │   │  │
│                    │  └──────────────────────────────────────┘   │  │
│                    └─────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────┼───────────────────────────────────┐
│                        Container Orchestration                      │
├─────────────────────────────────────────────────────────────────────┤
│                                 │                                   │
│                    ┌────────────▼──────────────┐                    │
│                    │   Docker Engine API       │                    │
│                    └────────────┬──────────────┘                    │
│                                 │                                   │
│         ┌───────────────────────┴────────────────────┐              │
│         │                                            │              │
│    ┌────▼──────┐                              ┌─────▼──────┐        │
│    │llamacpp-* │ (ports 8001+)                │  vllm-*    │        │
│    │Container  │                              │  Container │        │
│    │           │                              │            │        │
│    │ • CUDA    │                              │ • Python   │        │
│    │ • Maxwell │                              │ • Pascal   │        │
│    │   5.2+    │                              │   6.0+     │        │
│    │ • GGUF    │                              │ • GGUF     │        │
│    └─────┬─────┘                              └──────┬─────┘        │
│          │                                           │              │
│          └───────────────────┬───────────────────────┘              │
│                              │                                      │
│                      ┌───────▼────────┐                             │
│                      │  NVIDIA GPU(s) │                             │
│                      │  • Shared VRAM │                             │
│                      │  • CUDA 12.1   │                             │
│                      └────────────────┘                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

**Client Layer**
- **Web UI (Browser)** — React-based management interface for models, agents, and settings
- **Koda CLI (Terminal)** — Cross-platform AI assistant with autonomous skill execution

**Application Layer**
- **Webapp Container**
  - **React Frontend** — Model discovery, launch configuration, API key management
  - **Express Backend** — RESTful API, authentication, session management
  - **Skills System** — Skill execution engine (55+ skills)
  - **Docker Integration** — Dynamic model instance creation and management
  - **OpenAI Compatibility** — `/v1/chat/completions` and `/v1/completions` endpoints

**Container Orchestration**
- **Docker Engine** — Container lifecycle management, networking, volume management
- **llama.cpp Instances** — CUDA-enabled C++ inference (Maxwell 5.2+)
- **vLLM Instances** — High-throughput Python inference (Pascal 6.0+)

**Hardware Layer**
- **NVIDIA GPU** — Shared across all model instances with automatic VRAM management

---

## Troubleshooting

### Build Issues
```bash
./build.sh                # Resume interrupted build
./build.sh --no-parallel  # Low memory systems
rm -rf .build-state/      # Clear corrupted state
```

### Model Issues
- **OOM errors** — Reduce GPU layers, use q8_0/q4_0 cache
- **Wrong backend** — Switch between llama.cpp and vLLM
- **VLM crashes** — Some models unsupported (Qwen3-VL, Qwen2-VL)

### Service Issues
```bash
docker compose restart webapp       # Restart webapp
docker compose logs -f webapp       # View logs
nvidia-smi                          # Check GPU
```

### Common Solutions
- **Port conflicts** — Check `netstat -tulpn | grep 3001`
- **GPU not detected** — Reinstall NVIDIA Container Toolkit
- **Koda not found** — `export PATH="$HOME/.local/bin:$PATH"`

---

## Documentation

- **[COMMANDS.md](COMMANDS.md)** — Complete command reference
- **[API Documentation](https://localhost:3001)** — Interactive API docs in Web UI

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — LLM inference in C++
- [vLLM](https://github.com/vllm-project/vllm) — High-throughput serving
- [HuggingFace](https://huggingface.co/) — Model hosting
- [Material-UI](https://mui.com/) — React components

---

## Support

- **Issues**: [GitHub Issues](https://github.com/frontierstack/Open-Source-Model-Manager/issues)
- **Discussions**: [GitHub Discussions](https://github.com/frontierstack/Open-Source-Model-Manager/discussions)

---

<div align="center">

**Built for the Open Source AI Community**

[Back to Top](#open-source-model-manager)

</div>
