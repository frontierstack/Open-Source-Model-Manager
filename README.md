# Open Source Model Manager

> **A Production-Ready MLOps Platform for Large Language Models**

Containerized platform for serving and managing LLMs with dual backend support, web UI, and autonomous AI agent system.

[![Docker](https://img.shields.io/badge/Docker-24.0%2B-blue?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CUDA](https://img.shields.io/badge/CUDA-12.1-76B900?logo=nvidia)](https://developer.nvidia.com/cuda-toolkit)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org/)

---

## 🌟 Features

### 🚀 Dual Backend Support
- **llama.cpp**: Works with older GPUs (Maxwell 5.2+: GTX 900 series, Quadro M4000)
- **vLLM**: High-performance inference for newer GPUs (Pascal 6.0+: GTX 1000 series+)
- Seamless backend switching per model
- Optimized for GGUF quantized models

### 🎯 Core Capabilities
- **HuggingFace Integration**: Search and download GGUF models directly
- **Auto-Configuration**: Optimal settings based on hardware detection
- **Real-time Monitoring**: WebSocket-based live logs and status
- **Multi-User Support**: Authentication with session management
- **OpenAI-Compatible API**: Drop-in replacement for OpenAI endpoints
- **Production-Ready**: Comprehensive error handling prevents crashes

### 🤖 Koda - AI Agent System

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
                    I can execute skills, manage files, and work
                    with other agents. What would you like to do?
```

**Key Features:**
- ✨ Autonomous skill execution (88+ built-in skills for file ops, API calls, email parsing, PDF generation)
- 🔄 Multi-agent collaboration for complex tasks
- 📧 Email parsing (.eml and .msg Outlook format support)
- 🔐 AES-256 encrypted credentials
- 🌐 Cross-platform (Linux, macOS, Windows)

---

## 📋 Prerequisites

### Required
- **Docker** 24.0+ with Compose v2
- **Linux** (Ubuntu 20.04+)
- **4GB RAM** minimum (8GB+ recommended)

### Optional
- **NVIDIA GPU** with Container Toolkit (for GPU acceleration)
- **HuggingFace Token** (for gated models)

### GPU Support

| Backend | Min Compute | Example GPUs |
|---------|-------------|--------------|
| **llama.cpp** | 5.2 (Maxwell) | GTX 900, Quadro M4000, GTX 1000+ |
| **vLLM** | 6.0 (Pascal) | GTX 1000+, Quadro P, RTX 2000+ |

---

## 🚀 Quick Start

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
./start.sh    # Start all services (auto-generates SSL certs)
```

**Note:** SSL certificates are automatically generated on first run. To manually generate:
```bash
mkdir -p certs && openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
```

**Access:**
- 🌐 Web UI: https://localhost:3001
- 💬 Open WebUI: https://localhost:3002

### Build Options

```bash
./build.sh                      # Parallel build (default)
./build.sh --no-parallel        # Sequential (low memory)
./build.sh --no-cache --no-resume  # Force rebuild
```

---

## 🐳 Manual Installation

<details>
<summary><b>Click to expand manual Docker installation steps</b></summary>

### Build Base Images

```bash
docker build -t modelserver-llamacpp:latest ./llamacpp
docker build -t modelserver-vllm:latest ./vllm
docker build -t modelserver-webapp:latest ./webapp
```

### Start Services

```bash
docker compose up -d
```

### Verify

```bash
docker compose ps
docker compose logs -f webapp
```

</details>

---

## 📖 Usage

### Web Interface

1. Navigate to https://localhost:3001
2. Register account (first user = admin)
3. **Discover** → Search/download models
4. **My Models** → Launch instances
5. **Apps** → Manage Open WebUI
6. **API Keys** → Generate access tokens

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

## ⚙️ Configuration

### Environment Variables

```bash
HUGGING_FACE_HUB_TOKEN=hf_xxx    # For model downloads
SESSION_SECRET=your-secret        # Auto-generated if not set
HOST_IP=192.168.1.100            # Container networking
```

### Ports

| Service | Port | Purpose |
|---------|------|---------|
| Webapp | 3001 | HTTPS Web UI |
| Webapp | 3080 | HTTP Internal API |
| Open WebUI | 3002 | HTTPS Chat Interface |
| Models | 8001+ | Dynamic model instances |

### Backend Settings

**llama.cpp** - Best for older GPUs, CPU offload
```
GPU Layers: -1 (all)
Context: 4096
Cache Type: f16/q8_0/q4_0
Parallel Slots: 1-8
```

**vLLM** - Best for newer GPUs, high throughput
```
Max Model Len: 4096
GPU Memory: 0.9
Tensor Parallel: 1
Max Seqs: 256
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Client Layer                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User Browser                          Terminal (Koda CLI)         │
│       │                                       │                     │
│       ├── HTTPS (3001) ──→ Web UI            │                     │
│       │                                       │                     │
│       └── HTTPS (3002) ──→ Open WebUI        │                     │
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
│                    │        Webapp Container (3001/3080)        │  │
│                    │  ┌──────────────────────────────────────┐  │  │
│                    │  │  React Frontend (Web UI)             │  │  │
│                    │  └──────────────────────────────────────┘  │  │
│                    │  ┌──────────────────────────────────────┐  │  │
│                    │  │  Express API Server                  │  │  │
│                    │  │  • Authentication & Sessions         │  │  │
│                    │  │  • Model Management                  │  │  │
│                    │  │  • Agent & Skills System (41+ skills)│  │  │
│                    │  │  • Docker API Integration            │  │  │
│                    │  │  • OpenAI-Compatible Endpoints       │  │  │
│                    │  └──────────────────────────────────────┘  │  │
│                    └───────────────────┬──────────────────────────┘  │
│                                        │                             │
│                    ┌───────────────────▼──────────────────┐          │
│                    │    Nginx Reverse Proxy (3002)       │          │
│                    │    • SSL Termination                │          │
│                    │    • Open WebUI Routing             │          │
│                    └─────────────────────────────────────┘          │
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
│    ┌────▼──────┐                              ┌─────▼──────┐       │
│    │llamacpp-* │ (ports 8001+)                │  vllm-*    │       │
│    │Container  │                              │  Container │       │
│    │           │                              │            │       │
│    │ • CUDA    │                              │ • Python   │       │
│    │ • Maxwell │                              │ • Pascal   │       │
│    │   5.2+    │                              │   6.0+     │       │
│    │ • GGUF    │                              │ • GGUF     │       │
│    └─────┬─────┘                              └──────┬─────┘       │
│          │                                           │             │
│          └───────────────────┬───────────────────────┘             │
│                              │                                     │
│                      ┌───────▼────────┐                            │
│                      │  NVIDIA GPU(s) │                            │
│                      │  • Shared VRAM │                            │
│                      │  • CUDA 12.1   │                            │
│                      └────────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

#### Client Layer
- **Web UI (Browser)**: React-based management interface for models, agents, and settings
- **Open WebUI (Browser)**: Pre-built chat interface for model interactions
- **Koda CLI (Terminal)**: Cross-platform AI assistant with autonomous skill execution
  - 88+ built-in skills (file ops, Windows/Linux commands, OCR, email parsing, PDF generation, web scraping, etc.)
  - Email parsing with .eml and .msg (Outlook) format support
  - Multi-agent collaboration support
  - AES-256 encrypted credential storage
  - Real-time streaming responses

#### Application Layer
- **Webapp Container**:
  - **React Frontend**: Model discovery, launch configuration, API key management
  - **Express Backend**: RESTful API, authentication, session management
  - **Skills System**: Python-based skill execution engine (88+ skills: file I/O, networking, email parsing, PDF generation, web scraping)
  - **Docker Integration**: Dynamic model instance creation and management
  - **OpenAI Compatibility**: `/v1/chat/completions` and `/v1/completions` endpoints
- **Nginx Reverse Proxy**: SSL/TLS termination, Open WebUI routing

#### Container Orchestration
- **Docker Engine**: Container lifecycle management, networking, volume management
- **llama.cpp Instances**: CUDA-enabled C++ inference (Maxwell 5.2+)
  - Optimized for GGUF quantization
  - CPU offload support
  - Flash attention compatible
- **vLLM Instances**: High-throughput Python inference (Pascal 6.0+)
  - Tensor parallelism
  - PagedAttention memory optimization
  - Continuous batching

#### Hardware Layer
- **NVIDIA GPU**: Shared across all model instances with automatic VRAM management

---

## 🔍 Troubleshooting

### Build Issues
```bash
./build.sh                # Resume interrupted build
./build.sh --no-parallel  # Low memory systems
rm -rf .build-state/      # Clear corrupted state
```

### Model Issues
- **OOM errors**: Reduce GPU layers, use q8_0/q4_0 cache
- **Wrong backend**: Switch between llama.cpp and vLLM
- **VLM crashes**: Some models unsupported (Qwen3-VL, Qwen2-VL)

### Service Issues
```bash
docker compose restart webapp       # Restart webapp
docker compose logs -f webapp       # View logs
nvidia-smi                          # Check GPU
```

### Common Solutions
- **Port conflicts**: Check `netstat -tulpn | grep 3001`
- **GPU not detected**: Reinstall NVIDIA Container Toolkit
- **Koda not found**: `export PATH="$HOME/.local/bin:$PATH"`

---

## 📚 Documentation

- **[COMMANDS.md](COMMANDS.md)** - Complete command reference
- **[API Documentation](https://localhost:3001)** - Interactive API docs in Web UI

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) - LLM inference in C++
- [vLLM](https://github.com/vllm-project/vllm) - High-throughput serving
- [Open WebUI](https://github.com/open-webui/open-webui) - Chat interface
- [HuggingFace](https://huggingface.co/) - Model hosting
- [Material-UI](https://mui.com/) - React components

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/frontierstack/Open-Source-Model-Manager/issues)
- **Discussions**: [GitHub Discussions](https://github.com/frontierstack/Open-Source-Model-Manager/discussions)

---

<div align="center">

**Built with ❤️ for the Open Source AI Community**

[⬆ Back to Top](#open-source-model-manager)

</div>
