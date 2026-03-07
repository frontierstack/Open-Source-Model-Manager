# Custom Open WebUI image with additional Python packages and patches
FROM ghcr.io/open-webui/open-webui:main

# All modifications as root
USER root

# Install system dependencies for QR code detection (pyzbar requires libzbar0)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzbar0 \
    && rm -rf /var/lib/apt/lists/*

# Install additional Python packages for enhanced email parsing:
# - extract_msg, olefile: Parse Outlook .msg email files
# - pyzbar, Pillow: QR code detection from images
# - PyPDF2: PDF text extraction
# - python-docx: DOCX text extraction
# - openpyxl: XLSX spreadsheet parsing
RUN pip install --no-cache-dir \
    extract_msg \
    olefile \
    pyzbar \
    Pillow \
    PyPDF2 \
    python-docx \
    openpyxl

# Copy the patched MSG loader
COPY msg_loader_patch.py /app/backend/open_webui/retrieval/loaders/msg_loader_patch.py

# Patch the main loader to use our fixed OutlookMessageLoader
RUN sed -i 's/from langchain_community.document_loaders import (/from langchain_community.document_loaders import (\n    # OutlookMessageLoader,  # Replaced with patched version/' \
    /app/backend/open_webui/retrieval/loaders/main.py && \
    sed -i 's/    OutlookMessageLoader,/    # OutlookMessageLoader,  # Using patched version instead/' \
    /app/backend/open_webui/retrieval/loaders/main.py && \
    sed -i '/^from open_webui.retrieval.loaders.mistral/a from open_webui.retrieval.loaders.msg_loader_patch import PatchedOutlookMessageLoader' \
    /app/backend/open_webui/retrieval/loaders/main.py && \
    sed -i 's/loader = OutlookMessageLoader(file_path)/loader = PatchedOutlookMessageLoader(file_path)/' \
    /app/backend/open_webui/retrieval/loaders/main.py

# NOTE: Do NOT switch to USER 1000 here.
# The base Open WebUI image is designed to run as root.
# Switching users causes permission errors on fresh installs
# when writing to the data volume and static files.

# Set environment variables (can be overridden in docker-compose)
ENV ENABLE_OLLAMA_API=false
ENV ENABLE_OPENAI_API=true
ENV HOST=0.0.0.0
