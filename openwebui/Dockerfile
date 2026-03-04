# Custom Open WebUI image with additional Python packages
FROM ghcr.io/open-webui/open-webui:main

# Install additional Python packages for enhanced functionality
# - extract_msg: Parse Outlook .msg email files
# - olefile: Required by extract_msg for OLE file parsing
RUN pip install --no-cache-dir extract_msg olefile

# Set environment variables (can be overridden in docker-compose)
ENV ENABLE_OLLAMA_API=false
ENV ENABLE_OPENAI_API=true
ENV HOST=0.0.0.0
