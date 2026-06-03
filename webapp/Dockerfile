FROM node:18

# Build arguments for corporate proxy/SSL environments
# Pass these at build time: docker build --build-arg HTTP_PROXY=http://proxy:port ...
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1
ARG NODE_TLS_REJECT_UNAUTHORIZED
ARG PIP_TRUSTED_HOST
ARG PIP_CERT

# Set proxy environment variables if provided
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV no_proxy=${NO_PROXY}

# Node.js SSL configuration (set to 0 to disable SSL verification in corporate environments)
ENV NODE_TLS_REJECT_UNAUTHORIZED=${NODE_TLS_REJECT_UNAUTHORIZED:-1}

# Python/pip SSL configuration
ENV PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
ENV PIP_CERT=${PIP_CERT}

WORKDIR /usr/src/app

COPY package*.json .npmrc ./
ENV PATH=/usr/local/bin:$PATH

# Install system dependencies for Playwright Chromium and skill execution
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip jq \
    # Virtual display for headed mode (bypasses bot detection)
    xvfb \
    # Playwright Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    # PDF generation tools (create_pdf, html_to_pdf, read_pdf skills)
    wkhtmltopdf \
    poppler-utils \
    ghostscript \
    enscript \
    pandoc \
    # Image processing tools (ocr_image, convert_image skills)
    tesseract-ocr \
    imagemagick \
    # Database tools (sqlite_query, sqlite_list_tables skills)
    sqlite3 \
    # Video analysis tools (analyze_video skill)
    ffmpeg \
    # Archive extraction tools (extract_archive skill) — unzip/tar/gzip/bzip2/xz
    # are already pulled above; add 7z and unrar for .7z / .rar support.
    p7zip-full \
    unrar-free \
    && rm -rf /var/lib/apt/lists/*

# Install Python libraries for skills (pinned to major versions to prevent breaking changes)
RUN pip3 install --break-system-packages --no-cache-dir \
    huggingface-hub==0.27.* \
    psutil==6.1.* \
    # PDF generation (create_pdf skill)
    reportlab==4.2.* \
    # PDF reading (read_pdf skill)
    PyPDF2==3.0.* \
    # HTML to PDF conversion (html_to_pdf skill)
    weasyprint==63.* \
    # Web scraping with captcha evasion (Scrapling with all dependencies)
    "scrapling[all]>=0.2,<1.0" \
    # AIMem memory compression (TF-IDF dedup, lossy compression, relevance gating)
    tiktoken==0.9.* \
    numpy==2.2.* \
    scikit-learn==1.6.* \
    # Data-analysis skills (csv_describe, spreadsheet_query, chart_plot)
    pandas==2.2.* \
    duckdb==1.2.* \
    matplotlib==3.10.* \
    # Writing-quality skill (readability_score)
    textstat==0.7.* \
    # OCR Python wrapper for the tesseract-ocr binary installed above.
    # The ocr_image skill is NOT sandbox-flagged, so it runs in this
    # container — without pytesseract it fails with "pytesseract and/or
    # PIL not installed".
    pytesseract==0.3.* \
    # Cross-platform screenshot library used by the (non-sandbox)
    # screenshot skill. Tiny pure-Python wheel; harmless if unused.
    mss==9.0.* \
    # TOML reader for the parse_toml skill. Python 3.11+ also ships
    # tomllib in stdlib, but the skill imports tomli first.
    tomli==2.2.* \
    # Knowledge Base embeddings (kb_engine.py). model2vec gives fast static
    # CPU embeddings (pure numpy, no torch/onnx) for semantic retrieval.
    model2vec==0.8.*

# Pre-fetch the KB embedding model so the first query is fast and the image
# works offline. Non-fatal: if the download is unavailable at build time the
# engine fetches it at boot, or falls back to lexical hashing.
RUN python3 -c "from model2vec import StaticModel; StaticModel.from_pretrained('minishlab/potion-retrieval-32M'); print('[kb] embedding model cached')" \
    || echo "[kb] embedding model prefetch deferred to runtime"

# Install Playwright browsers for Python (shares with Node.js)
RUN python3 -m playwright install chromium

RUN npm install

# Install Playwright browsers (Chromium only for speed)
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/src/app/.playwright
RUN npx playwright install chromium

# Install Patchright's pinned Chromium. Patchright (used by scrapling's
# StealthyFetcher for bot-detection bypass) is pinned to a different chromium
# revision than playwright-core (currently 1217 vs 1208) and refuses to fall
# back to the playwright-installed binary. Without this, every StealthyFetcher
# call fails with `Executable doesn't exist at .playwright/chromium-1217/...`
# and the chat agent loses its strongest anti-bot fetch path.
RUN python3 -m patchright install chromium

COPY . .
RUN npm run build

# Security note: Running as root is required for Docker socket access (/var/run/docker.sock)
# To improve security, consider using a Docker API proxy with restricted permissions

EXPOSE 3001

CMD [ "node", "server.js" ]
