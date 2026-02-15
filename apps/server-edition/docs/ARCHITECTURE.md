# BrowserOS Server Edition -- Architecture

## System Overview

BrowserOS Server Edition is a headless browser automation server that wraps the core BrowserOS engine with enterprise features: a persistent task queue, an LLM router with self-learning capabilities, a 3-tier memory system, and an external connector framework. It runs in two modes -- **local** (macOS desktop, no virtual display) and **server** (headless Linux with Xvfb + VNC).

```
+-----------------------------------------------------------------------+
|                        BrowserOS Server Edition                        |
|                                                                        |
|  +------------------+    +-----------------+    +-------------------+  |
|  |   Hono HTTP API  |    |  Task Scheduler |    |    LLM Router     |  |
|  |  (port 9100)     |    |  (poll-based)   |    |  (self-learning)  |  |
|  +--------+---------+    +--------+--------+    +---------+---------+  |
|           |                       |                       |            |
|           v                       v                       |            |
|  +------------------+    +-----------------+              |            |
|  |  Middleware       |    |  Task Executor  +--------------+            |
|  |  - Auth (API Key) |    |  (HTTP -> /chat)|                          |
|  |  - Request Logger |    +--------+--------+                          |
|  +--------+---------+             |                                    |
|           |                       v                                    |
|           |              +-----------------+    +-------------------+  |
|           +------------->|  BrowserOS Core |    |  Memory System    |  |
|                          |  (Application)  |    |  (@browseros/     |  |
|                          |  MCP + Agent    |    |   learning)       |  |
|                          +--------+--------+    +---------+---------+  |
|                                   |                       |            |
|                                   v                       v            |
|                          +-----------------+    +-------------------+  |
|                          | Browser Runtime |    |  SQLite Database  |  |
|                          | - Chromium/CDP  |    |  (WAL mode)       |  |
|                          | - Xvfb (server) |    +-------------------+  |
|                          | - VNC proxy     |                           |
|                          +-----------------+    +-------------------+  |
|                                                 |  Connector System |  |
|                                                 |  - REST           |  |
|                                                 |  - Webhook        |  |
|                                                 +-------------------+  |
+-----------------------------------------------------------------------+
```

## Module Structure

### `apps/server-edition` -- Server Edition (this package)

The main orchestration layer that assembles all subsystems.

| Directory              | Responsibility                                             |
|------------------------|------------------------------------------------------------|
| `src/server-edition.ts`| Top-level orchestrator. Initializes and wires all modules. |
| `src/index.ts`         | Entry point. Parses CLI args, loads env, starts server.    |
| `src/config.ts`        | Configuration interface and factory from environment.      |
| `src/env.ts`           | Zod-validated environment variable schema with defaults.   |
| `src/api/`             | Hono route factories (tasks, router, learning, connectors, health, browser). |
| `src/task-queue/`      | Task store (SQLite), scheduler, executor, retry, dependency resolution.      |
| `src/router/`          | LLM routing table, provider pool, metrics, self-learning optimizer.          |
| `src/connectors/`      | Pluggable connector framework (REST, Webhook). Factory-based registration.   |
| `src/browser-runtime/` | Chromium launcher, Xvfb manager, VNC proxy, browser pool.                    |
| `src/middleware/`       | Auth middleware (API key) and structured request logger.                     |

### `apps/server` -- BrowserOS Core

The upstream MCP server that exposes browser automation tools. Server Edition embeds it via `new Application(config)`.

| Component         | Responsibility                                            |
|-------------------|-----------------------------------------------------------|
| `src/tools/`      | MCP tool definitions (CDP-based and controller-based).    |
| `src/http/`       | Hono HTTP server with MCP, health, and provider routes.   |
| `src/agent/`      | AI agent (Gemini adapter, rate limiting, sessions).       |
| `src/controller-server/` | WebSocket bridge to the browser extension.         |

### `packages/learning` -- Learning & Memory Package

Provides the 3-tier memory system, compression, analysis, and adaptive optimization.

| Module                   | Responsibility                                         |
|--------------------------|--------------------------------------------------------|
| `memory/memory-store.ts`     | Core CRUD for memory entries with vector search.   |
| `memory/cross-session-store.ts` | Persistent knowledge base across sessions.      |
| `memory/persistent-session.ts`  | Session persistence with message history.       |
| `memory/token-budget-manager.ts`| Token budget calculation and message partitioning. |
| `memory/memory-analyzer.ts`    | Relevance scoring, redundancy detection, action suggestions. |
| `memory/memory-compressor.ts`  | Content compression preserving key facts (URLs, selectors, errors). |
| `memory/adaptive-optimizer.ts` | Self-tuning optimizer that adjusts parameters every 2 minutes.     |
| `memory/vector-db.ts`         | In-process vector storage with cosine similarity search.           |

### `packages/shared` -- Shared Constants & Schemas

Single source of truth for types, constants, and validation schemas.

| Module                  | Responsibility                                          |
|-------------------------|---------------------------------------------------------|
| `schemas/task.ts`       | Zod schemas for tasks, batches, priorities, states.     |
| `schemas/llm.ts`        | LLM provider enum and config schema.                    |
| `constants/task-queue.ts`| Task queue configuration (timeouts, retries, backoff). |
| `constants/router.ts`   | Default routing table and router config thresholds.     |
| `constants/ports.ts`    | Default port numbers.                                   |
| `constants/timeouts.ts` | Timeout constants.                                      |
| `constants/limits.ts`   | Rate limits and pagination constants.                   |

### `apps/desktop` -- Desktop App (Electron)

Native macOS wrapper that bundles Server Edition into a `.dmg` distributable.

| Component        | Responsibility                                             |
|------------------|------------------------------------------------------------|
| `src/main.ts`    | Electron main process. Launches Server Edition in `local` mode. |
| `src/preload.ts` | Preload script for renderer security isolation.            |
| `src/renderer.ts`| Renderer process (UI).                                     |

### `apps/controller-ext` -- Browser Extension

Chrome extension that receives commands from the server via WebSocket.

| Component            | Responsibility                                          |
|----------------------|---------------------------------------------------------|
| `src/background/`    | Extension background script (`BrowserOSController`).    |
| `src/actions/`       | Action handlers (browser, tab, bookmark, history).      |
| `src/adapters/`      | Chrome API adapters.                                    |
| `src/websocket/`     | WebSocket client connecting to the server.              |

## Communication Flow

```
External Client               Server Edition                   Browser
      |                             |                             |
      |  POST /tasks                |                             |
      |  (or POST /chat)            |                             |
      +---------------------------->|                             |
      |                             |                             |
      |                    +--------v---------+                   |
      |                    | Task Scheduler   |                   |
      |                    | polls pending    |                   |
      |                    | tasks every 1s   |                   |
      |                    +--------+---------+                   |
      |                             |                             |
      |                    +--------v---------+                   |
      |                    | Task Executor    |                   |
      |                    | POST /chat       |                   |
      |                    | (internal HTTP)  |                   |
      |                    +--------+---------+                   |
      |                             |                             |
      |                    +--------v---------+                   |
      |                    | BrowserOS Core   |                   |
      |                    | (MCP Agent)      |                   |
      |                    +--+----------+----+                   |
      |                       |          |                        |
      |              CDP (ws) |          | WebSocket              |
      |                       v          v                        |
      |              +--------+--+  +----+-------+                |
      |              | Chromium   |  | Extension  |                |
      |              | DevTools   |  | (actions)  |                |
      |              +-----+------+  +-----+------+               |
      |                    |               |                      |
      |                    +-------+-------+                      |
      |                            |                              |
      |                    +-------v--------+                     |
      |                    |   Chrome APIs  |                     |
      |                    |   / Web Pages  |                     |
      |                    +----------------+                     |
```

### Data Flow

1. **Inbound**: External client submits a task via REST API (`POST /tasks`).
2. **Scheduling**: `TaskScheduler` polls the `tasks` SQLite table every second, resolves dependencies, respects concurrency limits, and dispatches ready tasks to `TaskExecutor`.
3. **Execution**: `TaskExecutor` calls the internal `/chat` endpoint (BrowserOS Core) with the task instruction as a message. The core agent reasons about the instruction and calls browser tools.
4. **Browser Tools**: Tools execute either via CDP (direct DevTools Protocol for network, console, emulation) or via the extension WebSocket (for navigation, clicks, screenshots, tabs).
5. **Result**: The SSE response from `/chat` is parsed and stored in `task_results`. Webhook notifications are sent if configured.
6. **Learning**: The LLM router records metrics for each tool invocation. The self-learner periodically analyzes success rates and adjusts routing overrides.
7. **Memory**: Session context is managed by the memory system -- short-term entries are compressed or promoted based on relevance scoring.

## Deployment Modes

### Local Mode (`--mode=local`)

- No Xvfb (uses native display)
- No VNC proxy
- Chromium launches on the host display
- Intended for macOS desktop use (via Electron wrapper or direct CLI)
- Default mode

### Server Mode (`--mode=server`)

- Xvfb provides a virtual X11 display (`:99`, 1920x1080x24)
- Chromium renders into the virtual framebuffer
- x11vnc + websockify expose the display via noVNC at port 6080
- Designed for Docker / Linux headless servers
- Set via `BROWSEROS_MODE=server` environment variable

## Tech Stack

| Component       | Technology                                                   |
|-----------------|--------------------------------------------------------------|
| Runtime         | [Bun](https://bun.sh) (required, not Node.js compatible)    |
| HTTP Framework  | [Hono](https://hono.dev) v4.6+                              |
| Database        | SQLite via `bun:sqlite` (WAL mode)                           |
| Validation      | [Zod](https://zod.dev) v3.24+                                |
| Browser         | Chromium with Chrome DevTools Protocol (CDP)                 |
| Extension       | Chrome Manifest V3 extension                                 |
| Desktop         | [Electron](https://electronjs.org) v33                       |
| Packaging       | electron-builder (DMG for macOS arm64 + x64)                 |
| Container       | Docker (Debian-based, `oven/bun:1.3`)                        |
| Virtual Display | Xvfb + x11vnc + websockify + noVNC                          |
| Logging         | Structured JSON via middleware (request ID, duration, status) |

## Startup Sequence

The `ServerEdition.start()` method executes these steps in order:

1. **Xvfb** (server mode only) -- Start virtual X11 display.
2. **Chromium** -- Launch browser with CDP and extension.
3. **BrowserOS Core** -- Start the MCP server (`Application`).
4. **Middleware** -- Apply request logger and API key auth.
5. **VNC** (server mode + enabled) -- Start x11vnc and websockify.
6. **Task Queue** -- Initialize SQLite store, mount `/tasks` routes, start scheduler.
7. **LLM Router** -- Initialize routing table and metrics, mount `/router` routes, start self-learning.
8. **Memory System** -- Initialize memory store, sessions, cross-session knowledge, token budget, adaptive optimizer. Mount `/learning` routes.
9. **Connectors** -- Register REST and Webhook factories, mount `/connectors` routes.
10. **Health** -- Mount `/health` routes with component checks.

## Shutdown Sequence

Graceful shutdown on `SIGINT` / `SIGTERM`:

1. Connectors shut down (close external connections).
2. Adaptive optimizer stops (clear interval).
3. Optimizer database closes.
4. Memory store closes.
5. Session manager closes.
6. Cross-session store closes.
7. LLM router closes (stops self-learning, closes DB).
8. Task scheduler stops (clear poll interval).
9. Task store closes (close DB).
10. VNC proxy stops (kill x11vnc + websockify).
11. Chromium stops (SIGTERM, then SIGKILL after 10s).
12. Xvfb stops (SIGTERM, then SIGKILL after 5s).
