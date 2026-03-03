FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./
ENV PATH=/usr/local/bin:$PATH

# Install system dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip jq \
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
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir huggingface-hub psutil

RUN npm install

# Install Playwright browsers (Chromium only for speed)
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/src/app/.playwright
RUN npx playwright install chromium

COPY . .
RUN npm run build

EXPOSE 3001

CMD [ "node", "server.js" ]
