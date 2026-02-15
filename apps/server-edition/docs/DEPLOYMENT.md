# BrowserOS Server Edition -- Deployment

## Port Overview

| Port | Protocol | Service              | Mode          | Description                          |
|------|----------|----------------------|---------------|--------------------------------------|
| 9100 | HTTP     | BrowserOS API        | local + server| Main HTTP API and MCP server         |
| 9222 | WS/HTTP  | Chrome DevTools (CDP)| local + server| Chrome DevTools Protocol endpoint    |
| 9101 | WS       | Extension Bridge     | local + server| WebSocket for controller extension   |
| 6080 | HTTP/WS  | noVNC Viewer         | server only   | Web-based VNC client                 |
| 5900 | TCP      | VNC Server (x11vnc)  | server only   | Raw VNC protocol (internal)          |

---

## Docker Deployment

### Prerequisites

- Docker 20.10+
- Docker Compose v2+
- At least 4 GB available RAM

### Build

The Dockerfile uses a multi-stage build. The build context must be the monorepo root (not the `apps/server-edition/` directory) because the build needs access to all workspace packages.

```bash
# From monorepo root
docker build -t browseros-server -f apps/server-edition/Dockerfile .
```

### Run (Docker)

```bash
docker run -d \
  --name browseros \
  -p 9100:9100 \
  -p 6080:6080 \
  -e BROWSEROS_MODE=server \
  -e VNC_ENABLED=true \
  -e VNC_PASSWORD=my-password \
  -e API_KEYS=sk-my-api-key \
  -v browseros-data:/app/data \
  --memory=4g \
  browseros-server
```

### Run (Docker Compose)

```bash
# From apps/server-edition/
docker compose up -d

# With custom VNC password
VNC_PASSWORD=my-password docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Stop and remove data volume
docker compose down -v
```

### Docker Health Check

The container includes a built-in health check:

```
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3
  CMD curl -f http://localhost:9100/health || exit 1
```

Check health status:

```bash
docker inspect --format='{{.State.Health.Status}}' browseros
```

### Accessing the Browser (VNC)

When `VNC_ENABLED=true`, you can view the browser in real-time:

1. Open `http://localhost:6080/vnc.html` in your browser.
2. Enter the VNC password (if set).
3. You will see the Chromium instance running inside the container.

This is useful for debugging automation tasks and verifying visual state.

### Docker Image Contents

The runtime image (`oven/bun:1.3` base) includes:

| Package             | Purpose                                     |
|---------------------|---------------------------------------------|
| `xvfb`              | Virtual X11 framebuffer                     |
| `chromium`          | Browser engine                              |
| `x11vnc`            | X11 to VNC bridge                           |
| `novnc`             | HTML5 VNC client                            |
| `websockify`        | WebSocket to TCP proxy (for noVNC)          |
| `fonts-liberation`  | Standard web fonts                          |
| `fonts-noto-color-emoji` | Emoji support                          |
| `dbus-x11`          | D-Bus for Chromium IPC                      |
| `procps`            | Process management utilities                |

### Volume Mount

The `browseros-data` volume is mounted at `/app/data` and stores:

- `browseros-server.db` -- SQLite database (all tables)
- `browseros-server.db-wal` -- WAL file
- `browseros-server.db-shm` -- Shared memory file
- `chromium-profile/` -- Chromium user data (cookies, cache, etc.)

---

## macOS Desktop App (Electron)

### Prerequisites

- macOS 12+ (Monterey or later)
- Bun 1.3+
- Node.js 22+ (for electron-builder)

### Build from Source

```bash
# From monorepo root
cd apps/desktop

# Install dependencies
bun install

# Development mode
bun run dev

# Build for distribution
bun run dist:dmg
```

### DMG Installation

1. Open the generated DMG from `apps/desktop/release/`.
2. Drag `BrowserOS.app` to `/Applications`.
3. On first launch, right-click and select "Open" to bypass Gatekeeper (unsigned build).

### Desktop App Architecture

The Electron app bundles:
- Server Edition source (`apps/server-edition/src`)
- BrowserOS Core (`apps/server/src`)
- Controller Extension (`apps/controller-ext/dist`)
- Shared packages (`packages/`)

It runs in `local` mode (no Xvfb, no VNC). Chromium is launched using the system-installed Chrome or the bundled BrowserOS browser.

### Supported Architectures

- macOS arm64 (Apple Silicon -- M1/M2/M3/M4)
- macOS x64 (Intel)

---

## Local Development Setup

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- Google Chrome or Chromium installed
- macOS, Linux, or WSL2

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd BrowserOS-agent

# Install all workspace dependencies
bun install

# Build the controller extension
cd apps/controller-ext
bun run build
cd ../..
```

### Running

```bash
# Option 1: From monorepo root
bun run --filter @browseros/server-edition start

# Option 2: From server-edition directory
cd apps/server-edition
bun src/index.ts

# Option 3: Explicit local mode
bun src/index.ts --mode=local
```

### Development with Hot Reload

There is no built-in hot reload. Restart the server after code changes:

```bash
# Ctrl+C to stop, then:
bun src/index.ts
```

### Running Tests

```bash
cd apps/server-edition
bun test tests/
```

### Type Checking

```bash
cd apps/server-edition
bun run typecheck
```

### Build

```bash
cd apps/server-edition
bun run build
# Output: dist/index.js
```

---

## Production Checklist

Before deploying to production:

1. **Set API keys**: `API_KEYS=sk-your-production-key-1,sk-your-production-key-2`
2. **Set VNC password**: `VNC_PASSWORD=strong-random-password` (if VNC is enabled)
3. **Persistent storage**: Mount a Docker volume at `/app/data` for database durability.
4. **Memory limits**: Allocate at least 2 GB, recommended 4 GB.
5. **Health monitoring**: Use `/health` endpoint for monitoring and alerting.
6. **Network isolation**: Do not expose port 9222 (CDP) or 5900 (VNC raw) to the public internet.
7. **TLS termination**: Place a reverse proxy (nginx, Caddy, Traefik) in front of port 9100 for HTTPS.

### Reverse Proxy Example (Caddy)

```
browseros.example.com {
    reverse_proxy localhost:9100
}

vnc.browseros.example.com {
    reverse_proxy localhost:6080
}
```

### Resource Requirements

| Metric       | Minimum | Recommended | Heavy Load          |
|-------------|---------|-------------|---------------------|
| CPU         | 1 core  | 2 cores     | 4 cores             |
| RAM         | 1 GB    | 4 GB        | 8 GB                |
| Disk        | 1 GB    | 10 GB       | 50 GB (with cache)  |
| Concurrency | 1 task  | 1-3 tasks   | 3-5 tasks           |

RAM usage is dominated by Chromium. Each additional browser pool instance adds approximately 500 MB - 1 GB.
