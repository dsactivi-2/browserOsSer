# BrowserOS Server Edition -- Configuration

## Environment Variables

All configuration is loaded from environment variables, validated by Zod at startup. Invalid values cause an immediate exit with a descriptive error.

Bun automatically loads `.env` files (no `dotenv` package needed).

### Complete Variable Reference

| Variable                    | Type    | Default                        | Description                                    |
|-----------------------------|---------|--------------------------------|------------------------------------------------|
| `BROWSEROS_MODE`            | string  | `local`                        | Deployment mode: `local` or `server`.          |
| `XVFB_DISPLAY`             | string  | `:99`                          | X11 display number (server mode only).         |
| `XVFB_RESOLUTION`          | string  | `1920x1080x24`                 | Virtual framebuffer resolution (WxHxD).        |
| `VNC_ENABLED`              | boolean | `false`                        | Enable VNC/noVNC access (server mode).         |
| `VNC_PORT`                 | number  | `6080`                         | WebSocket port for noVNC viewer.               |
| `VNC_PASSWORD`             | string  | _(none)_                       | VNC password. Empty = no password.             |
| `CHROMIUM_PATH`            | string  | _(auto-detect)_                | Path to Chromium/Chrome executable.            |
| `CDP_PORT`                 | number  | `9222`                         | Chrome DevTools Protocol debug port.           |
| `EXTENSION_PORT`           | number  | `9101`                         | Port for extension WebSocket communication.    |
| `EXTENSION_DIR`            | string  | `apps/controller-ext/dist`     | Path to the built controller extension.        |
| `SERVER_PORT`              | number  | `9100`                         | HTTP API server port.                          |
| `DB_PATH`                  | string  | `./data/browseros-server.db`   | SQLite database file path.                     |
| `TASK_QUEUE_MAX_CONCURRENT`| number  | `1`                            | Max concurrent task executions (min: 1).       |
| `TASK_QUEUE_MAX_RETRIES`   | number  | `3`                            | Default max retries for failed tasks (min: 0). |
| `TASK_DEFAULT_TIMEOUT_MS`  | number  | `120000`                       | Default task timeout in ms (min: 1000).        |
| `API_KEYS`                 | string  | `""` (empty = auth disabled)   | Comma-separated API keys. Empty disables auth. |
| `BROWSER_POOL_MAX`         | number  | `1`                            | Max browser instances in the pool (min: 1).    |

### Chromium Auto-Detection

When `CHROMIUM_PATH` is not set, the launcher searches these paths in order:

**macOS:**
1. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
2. `/Applications/Chromium.app/Contents/MacOS/Chromium`
3. `/Applications/BrowserOS.app/Contents/MacOS/BrowserOS`

**Linux:**
1. `/usr/bin/chromium`
2. `/usr/bin/chromium-browser`
3. `/usr/bin/google-chrome`
4. `/usr/bin/google-chrome-stable`

### Authentication

Authentication is controlled entirely by `API_KEYS`:

- **Empty string** (default): Authentication is disabled. All endpoints are open.
- **Non-empty**: Authentication is enabled. Provide one or more keys separated by commas.

When enabled, every request except `/health` must include either:
- `X-API-Key: <key>` header
- `Authorization: Bearer <key>` header

---

## Example `.env` File

### Local Development (macOS)

```env
# Mode
BROWSEROS_MODE=local

# Server
SERVER_PORT=9100

# Browser
CDP_PORT=9222
EXTENSION_PORT=9101
EXTENSION_DIR=apps/controller-ext/dist

# Database
DB_PATH=./data/browseros-server.db

# Task Queue
TASK_QUEUE_MAX_CONCURRENT=1
TASK_QUEUE_MAX_RETRIES=3
TASK_DEFAULT_TIMEOUT_MS=120000

# Auth (disabled for local dev)
API_KEYS=
```

### Production Server (Docker)

```env
# Mode
BROWSEROS_MODE=server

# Virtual Display
XVFB_DISPLAY=:99
XVFB_RESOLUTION=1920x1080x24

# VNC
VNC_ENABLED=true
VNC_PORT=6080
VNC_PASSWORD=my-secure-vnc-password

# Server
SERVER_PORT=9100

# Browser
CDP_PORT=9222
CHROMIUM_PATH=/usr/bin/chromium
EXTENSION_PORT=9101
EXTENSION_DIR=apps/controller-ext/dist

# Database
DB_PATH=/app/data/browseros-server.db

# Task Queue
TASK_QUEUE_MAX_CONCURRENT=3
TASK_QUEUE_MAX_RETRIES=5
TASK_DEFAULT_TIMEOUT_MS=300000

# Auth
API_KEYS=sk-prod-key-1,sk-prod-key-2

# Browser Pool
BROWSER_POOL_MAX=3
```

---

## Docker Compose Configuration

The `docker-compose.yml` provides a production-ready setup:

```yaml
version: '3.8'

services:
  browseros-server:
    build:
      context: ../..
      dockerfile: apps/server-edition/Dockerfile
    ports:
      - "9100:9100"    # HTTP API
      - "6080:6080"    # noVNC web viewer
    environment:
      - BROWSEROS_MODE=server
      - VNC_ENABLED=true
      - VNC_PASSWORD=${VNC_PASSWORD:-}
    volumes:
      - browseros-data:/app/data
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 4g
        reservations:
          memory: 1g

volumes:
  browseros-data:
    driver: local
```

### Key Docker Configuration

| Setting              | Value     | Reason                                             |
|----------------------|-----------|----------------------------------------------------|
| Memory limit         | 4 GB      | Chromium + Node/Bun runtime + SQLite               |
| Memory reservation   | 1 GB      | Minimum for stable operation                       |
| Restart policy       | `unless-stopped` | Auto-restart on crashes, not on manual stop  |
| Volume               | `browseros-data` | Persist database across container restarts   |
| Health check         | `curl -f http://localhost:9100/health` | 30s interval, 30s start period |
| Build context        | `../..` (monorepo root) | Needs access to all workspace packages     |

### Exposed Ports (Docker)

The Dockerfile `EXPOSE`s three ports:
- `9100` -- HTTP API
- `6080` -- noVNC WebSocket
- `5900` -- Raw VNC (not mapped in docker-compose by default)

---

## Differences: Local vs Server Mode

| Feature                | Local                         | Server                               |
|------------------------|-------------------------------|--------------------------------------|
| Xvfb                   | Not started                   | Started on `XVFB_DISPLAY`           |
| Chromium display        | Host display (native)         | Virtual display (`:99`)             |
| VNC proxy              | Not started                   | Started if `VNC_ENABLED=true`       |
| GPU acceleration       | Available (host GPU)          | Disabled (`--disable-gpu`)          |
| Chromium `DISPLAY` env | Not set                       | Set to `XVFB_DISPLAY` value        |
| Intended platform       | macOS (desktop / Electron)   | Linux (Docker / headless server)    |
| Default extension dir   | `apps/controller-ext/dist`   | Same (bundled in container)         |

### What Stays the Same

Regardless of mode, these components behave identically:

- HTTP API on `SERVER_PORT`
- Task queue (scheduling, execution, retry)
- LLM router (routing, metrics, self-learning)
- Memory system (all tiers, adaptive optimizer)
- Connector system
- Authentication middleware
- Database operations

---

## CLI Arguments

The only supported CLI argument is `--mode`:

```bash
# Explicit mode override (takes precedence over BROWSEROS_MODE env var)
bun src/index.ts --mode=local
bun src/index.ts --mode=server

# Also supports = syntax
bun src/index.ts --mode server
```

If `--mode` is not provided, the `BROWSEROS_MODE` environment variable is used (default: `local`).

---

## Derived Configuration

Some configuration values are computed from environment variables:

| Derived Value          | Source                        | Logic                                |
|------------------------|-------------------------------|--------------------------------------|
| `auth.enabled`         | `API_KEYS`                    | `true` if `API_KEYS` is non-empty   |
| `auth.apiKeys`         | `API_KEYS`                    | Split by comma, filter empty strings |
| Extension path         | `EXTENSION_DIR`               | Resolved to absolute path via `path.resolve(process.cwd(), ...)` |
| Data directory         | `DB_PATH`                     | Parent directory created with `mkdirSync` on startup             |
