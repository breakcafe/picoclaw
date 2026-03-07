# ================================================================
# NanoClaw Lite — Single Container Serverless Agent
# ================================================================

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir \
    requests \
    numpy \
    pandas \
    matplotlib

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g \
    agent-browser \
    @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci && npm prune --omit=dev

COPY dist/ ./dist/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN mkdir -p \
    /data/memory/global \
    /data/memory/conversations \
    /data/skills \
    /data/store \
    /data/sessions/.claude/skills

RUN chown -R node:node /app /data /home/node
USER node

ENV NODE_ENV=production
ENV PORT=9000
ENV MAX_EXECUTION_MS=300000

ARG ENABLE_LAMBDA_ADAPTER=false
USER root
RUN if [ "$ENABLE_LAMBDA_ADAPTER" = "true" ]; then \
      mkdir -p /opt/extensions && \
      curl -Lo /opt/extensions/lambda-adapter \
        https://github.com/awslabs/aws-lambda-web-adapter/releases/latest/download/lambda-adapter-x86_64 && \
      chmod +x /opt/extensions/lambda-adapter; \
    fi
USER node

EXPOSE ${PORT}
ENTRYPOINT ["/app/entrypoint.sh"]
