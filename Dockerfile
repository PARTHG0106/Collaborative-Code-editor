FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates python3 make g++
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run db:generate --workspace=apps/server
RUN npm run build --workspace=apps/server
RUN cp -r apps/server/src/generated apps/server/dist/generated

FROM node:20-bookworm-slim AS sandbox-toolchain
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    bash openssl ca-certificates curl git gcc g++ make default-jdk-headless \
    python3 python3-venv python3-pip nano less procps unzip zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global tsx typescript
COPY apps/server/sandbox/launcher.c /build/launcher.c
RUN gcc -O2 -std=c11 -Wall -Wextra -Werror /build/launcher.c -o /usr/local/bin/syncscript-sandbox
COPY apps/server/sandbox/tsx-offline.sh /build/tsx-offline.sh
RUN rm /usr/local/bin/tsx && install -m 755 /build/tsx-offline.sh /usr/local/bin/tsx
COPY apps/workspace-runtime/safe-files.py /usr/local/lib/syncscript/safe-files.py
RUN find /usr -perm /6000 -exec chmod a-s {} + \
    && chmod -R a-w /usr

FROM sandbox-toolchain
WORKDIR /app
COPY --from=builder /app ./
RUN mkdir -p /var/lib/syncscript/workspaces \
    && chmod 711 /var/lib/syncscript /var/lib/syncscript/workspaces
EXPOSE 7860
ENV PORT=7860
ENV RUNTIME_PROVIDER=local

# Liveness probe against the DB-free health route so a listening-but-wedged
# process (dead DB adapter, crash loop) is reported unhealthy rather than
# looking fine just because the port is open. Node 20 ships a global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/api/health/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form with `exec node` so node becomes the process that receives signals.
# The previous shell-form CMD left /bin/sh as PID 1; sh does not forward
# SIGTERM, so the SIGTERM/SIGINT graceful-shutdown handlers in index.ts never
# ran on a Hugging Face stop/restart and node was SIGKILLed with the DB still
# connected.
# `migrate deploy` applies the committed migrations and nothing else. The
# previous `db push --accept-data-loss` reshaped the live database on every boot
# and was permitted to drop data to do it.
CMD ["sh", "apps/server/scripts/start-server.sh"]
