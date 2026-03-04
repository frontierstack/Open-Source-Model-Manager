# Custom Open WebUI image with additional Python packages and patches
FROM ghcr.io/open-webui/open-webui:main

# Install additional Python packages for enhanced functionality
# - extract_msg: Parse Outlook .msg email files
# - olefile: Required by extract_msg for OLE file parsing
RUN pip install --no-cache-dir extract_msg olefile

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

# Set environment variables (can be overridden in docker-compose)
ENV ENABLE_OLLAMA_API=false
ENV ENABLE_OPENAI_API=true
ENV HOST=0.0.0.0
