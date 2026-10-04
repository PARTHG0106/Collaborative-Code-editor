FROM node:22-bookworm-slim

# This image belongs to exactly one workspace. The API and other workspaces
# are separate Hugging Face containers; no control-plane credential enters it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gcc g++ make default-jdk-headless \
    python3 python3-venv python3-pip nano procps unzip zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global tsx typescript

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs runtime.mjs safe-files.py ./
RUN mkdir /workspace && chown node:node /workspace

WORKDIR /workspace
ENV PORT=7860 HOME=/workspace WORKSPACE_ROOT=/workspace
# The small broker retains root only to create PTYs/processes as uid/gid 1000.
# User commands never run as root and cannot read its scoped connection token.
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
