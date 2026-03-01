# scripts/Dockerfile
FROM python:3.9-slim

# Install dependencies
RUN apt-get update && apt-get install -y git wget build-essential curl cmake

# Install Ollama CLI
RUN curl -L https://ollama.ai/download/ollama-linux-amd64 -o /usr/bin/ollama && chmod +x /usr/bin/ollama

# Clone llama.cpp and compile it
RUN git clone https://github.com/ggerganov/llama.cpp.git /opt/llama.cpp
RUN cd /opt/llama.cpp && mkdir -p build && cd build && cmake .. && cmake --build . --config Release

# Install Python libraries
RUN pip install huggingface-hub transformers torch sentencepiece

# Set the working directory
WORKDIR /scripts
