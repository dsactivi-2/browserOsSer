# Stage 1: Build
FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY package.json bun.lockb* ./
COPY apps/server-edition/package.json apps/server-edition/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-sdk/package.json packages/agent-sdk/
RUN bun install --frozen-lockfile

COPY . .
RUN bun build apps/server-edition/src/index.ts \
  --outdir apps/server-edition/dist \
  --target bun \
  --minify

# Stage 2: Runtime
FROM oven/bun:1.3

# Install Xvfb, Chromium, VNC tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    chromium \
    x11vnc \
    novnc \
    websockify \
    fonts-liberation \
    fonts-noto-color-emoji \
    dbus-x11 \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built application and necessary runtime files
COPY --from=builder /app/apps/server-edition/dist ./dist
COPY --from=builder /app/apps/server-edition/package.json ./package.json
COPY --from=builder /app/apps/controller-ext/dist ./apps/controller-ext/dist
COPY --from=builder /app/node_modules ./node_modules

# Create data directory
RUN mkdir -p /app/data

# Environment defaults
ENV BROWSEROS_MODE=server
ENV XVFB_DISPLAY=:99
ENV XVFB_RESOLUTION=1920x1080x24
ENV VNC_ENABLED=true
ENV VNC_PORT=6080
ENV CDP_PORT=9222
ENV EXTENSION_PORT=9101
ENV SERVER_PORT=9100
ENV DB_PATH=/app/data/browseros-server.db
ENV DISPLAY=:99
ENV NODE_ENV=production

# Expose ports
EXPOSE 9100 6080 5900

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:9100/health || exit 1

ENTRYPOINT ["bun", "dist/index.js"]
