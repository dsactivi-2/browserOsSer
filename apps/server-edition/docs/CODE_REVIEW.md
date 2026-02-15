# Code Review: Server Edition

**Reviewed:** 2026-02-13
**Scope:** `/apps/server-edition/src/` (33 TypeScript files) + `Dockerfile`
**Reviewer:** Code Review Agent (claude-opus-4-6)

---

## Summary

The Server Edition is a well-structured application that orchestrates a headless Chromium browser
runtime with a task queue, LLM router, memory system, and connector framework -- all exposed via a
Hono-based HTTP API. The codebase shows strong architectural separation (browser-runtime, task-queue,
router, connectors, API routes) and consistent use of typed interfaces.

Overall code quality is **good**, with a few critical security issues and several areas that would
benefit from hardening.

### Key Metrics

| Metric              | Value |
|---------------------|-------|
| Files reviewed      | 34    |
| Critical issues     | 5     |
| Warnings            | 12    |
| Suggestions         | 14    |

---

## Critical Issues

### C-1: API Key Comparison Vulnerable to Timing Attacks

**File:** `/apps/server-edition/src/middleware/auth.ts`, line 20

```typescript
if (!apiKey || !config.apiKeys.includes(apiKey)) {
```

`Array.includes()` uses standard string equality which is vulnerable to timing side-channel
attacks. An attacker can statistically determine individual characters of valid API keys by
measuring response times. Use a constant-time comparison instead.

**Impact:** An attacker with network access could recover valid API keys over many requests.

---

### C-2: Connector Route Accepts Arbitrary JSON Without Validation

**File:** `/apps/server-edition/src/api/connector-routes.ts`, lines 14-16

```typescript
app.post('/', async (c) => {
    const { type, name, config } = await c.req.json()
    try {
      const id = await connectorManager.addConnector(type, name, config ?? {})
```

The `type`, `name`, and `config` fields from the request body are destructured and used directly
with zero validation. There is no Zod schema (unlike the task routes which properly validate input).
An attacker could:

- Pass an invalid `type` value (handled by the factory check downstream, but leaks internal error
  messages).
- Pass a `null` or non-string `name`, causing unexpected behavior in SQLite.
- Pass arbitrary data in `config` which flows into connector `initialize()` and is stored in the
  database.

Similarly, the toggle endpoint at line 40 does not validate that `enabled` is a boolean:

```typescript
const { enabled } = await c.req.json()
connectorManager.setEnabled(id, enabled)
```

**Impact:** Potential injection through unvalidated connector config, unexpected database state.

---

### C-3: Webhook URL Is User-Controlled and Unvalidated (SSRF)

**File:** `/apps/server-edition/src/task-queue/task-executor.ts`, lines 63-69 and 91-98
**File:** `/apps/server-edition/src/api/task-routes.ts`, line 41

When creating a task, the `webhookUrl` field from the request body is stored and later used in
`fetch()` calls:

```typescript
// task-executor.ts line 170-183
private async sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TASK_QUEUE.WEBHOOK_TIMEOUT_MS),
      })
```

The `url` is never validated. An attacker could supply:
- `http://169.254.169.254/...` (cloud metadata endpoint -- SSRF)
- `http://127.0.0.1:9222/...` (internal CDP endpoint)
- `file:///etc/passwd` (depending on the fetch implementation)

**Impact:** Server-Side Request Forgery allowing access to internal services and cloud metadata.

---

### C-4: VNC Password Passed on Command Line (Visible in Process List)

**File:** `/apps/server-edition/src/browser-runtime/vnc-proxy.ts`, lines 37-38

```typescript
if (this.config.password) {
    args.push('-passwd', this.config.password)
```

The VNC password is passed as a command-line argument to `x11vnc`. Any user on the system can see
process arguments via `ps aux` or `/proc/[pid]/cmdline`. The `x11vnc` tool supports reading
passwords from a file (`-rfbauth`) which would be more secure.

**Impact:** VNC password leakage to any local user or monitoring system that logs process arguments.

---

### C-5: Multiple SQLite Database Connections to Same File Without Coordination

**File:** `/apps/server-edition/src/server-edition.ts`, lines 155, 181, 218, 265

Four separate `Database` instances are opened against the same `dbPath`:

1. `TaskStore` constructor (line 155 via `new TaskStore(this.config.dbPath)`)
2. `LLMRouter` constructor (line 181 via `new LLMRouter({ dbPath: ... })`)
3. `this.optimizerDb` (line 218 via `new Database(this.config.dbPath)`)
4. `ConnectorManager` constructor (line 265 via `new ConnectorManager(this.config.dbPath)`)

While WAL mode mitigates some issues, having four independent connections to the same SQLite file
creates risk of:
- `SQLITE_BUSY` errors under concurrent write load
- Inconsistent reads if one connection has uncommitted changes
- Resource leaks if any close() fails partway through shutdown

A single shared database connection (or a connection pool) would be safer and more resource-efficient.

**Impact:** Potential `SQLITE_BUSY` errors, data inconsistency, and resource leaks under load.

---

## Warnings

### W-1: Middleware Applied After Server Startup Creates a Race Window

**File:** `/apps/server-edition/src/server-edition.ts`, lines 58-61

```typescript
await this.startBrowserOSServer()    // Server begins accepting requests
this.applyMiddleware()                // Auth/logging added AFTER
```

The HTTP server is started and begins accepting connections before authentication middleware is
applied. There is a window (however brief) where unauthenticated requests can reach the server.
Middleware should be applied before `this.application.start()`.

---

### W-2: Health Checks Do Not Verify Actual Health

**File:** `/apps/server-edition/src/server-edition.ts`, lines 289-294

```typescript
checks: [
    { name: 'chromium', check: async () => this.chromium !== null },
    { name: 'taskQueue', check: async () => this.taskStore !== null },
    { name: 'router', check: async () => this.llmRouter !== null },
    { name: 'memory', check: async () => this.memoryStore !== null },
],
```

These checks only verify that the object reference is non-null, not that the underlying resource
is actually healthy. For example, `this.chromium !== null` is true even if the Chromium process has
crashed. A meaningful health check for Chromium would hit the CDP endpoint; for the database, it
would execute a trivial query.

---

### W-3: Browser Pool Port Collision Risk

**File:** `/apps/server-edition/src/browser-runtime/browser-pool.ts`, line 29

```typescript
const port = this.config.basePort + this.instances.size
```

Port is calculated from current `Map.size`, but after destroying an instance, `size` decreases.
The next instance created would reuse a port number that may still be in TIME_WAIT state or
occupied by a non-pool process. Use a monotonically increasing counter instead.

---

### W-4: `any` Casts in Database Query Results

**Files:**
- `/apps/server-edition/src/task-queue/task-store.ts`, lines 99, 137, 157, 215-218, 276
- `/apps/server-edition/src/router/router-metrics.ts`, lines 82, 101
- `/apps/server-edition/src/router/self-learner.ts`, lines 127, 159, 281

Database query results are consistently cast to `any[]` without runtime validation:

```typescript
const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any
```

This bypasses TypeScript's type safety entirely. If the database schema drifts from expectations
(migration issue, manual tampering), the code will produce incorrect results silently rather than
failing fast.

---

### W-5: `RouteDecision.reason` Type Mismatch

**File:** `/apps/server-edition/src/router/types.ts`, line 30

The `reason` field is typed as:
```typescript
reason: 'default' | 'optimized' | 'fallback' | 'downgrade_test'
```

But in `/apps/server-edition/src/router/llm-router.ts`, line 66, the string `'no_available_provider'`
is assigned to `reason`:

```typescript
return {
    ...decision,
    reason: 'no_available_provider',  // Not in union type
}
```

This should cause a compile error if strict type checking is enabled. If it does not, that indicates
`strict` is off in tsconfig, which is itself a concern.

---

### W-6: Chromium `stop()` Can Resolve Twice

**File:** `/apps/server-edition/src/browser-runtime/chromium-launcher.ts`, lines 126-141

```typescript
async stop(): Promise<void> {
    if (!this.process) return
    return new Promise((resolve) => {
      this.process!.on('exit', () => {     // resolve #1
        this.process = null
        resolve()
      })
      this.process!.kill('SIGTERM')
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL')
          this.process = null
          resolve()                        // resolve #2
        }
      }, 10000)
    })
}
```

If the process exits cleanly before the 10-second timeout, the `exit` handler resolves the
promise. The timeout will still fire. If the process was set to null in the exit handler but the
GC has not collected it, the timeout check `if (this.process)` catches this. However, if the
process exits between SIGKILL and the null assignment, `resolve()` could be called twice. While
harmless in practice (second resolve is ignored), this pattern also leaks the timeout -- it is
never cleared.

The same pattern exists in:
- `/apps/server-edition/src/browser-runtime/vnc-proxy.ts`, lines 100-141
- `/apps/server-edition/src/browser-runtime/xvfb-manager.ts`, lines 71-91

---

### W-7: `TaskScheduler.poll()` Silently Swallows Errors

**File:** `/apps/server-edition/src/task-queue/task-scheduler.ts`, lines 68-79

The `poll()` method catches and discards all errors from `doPoll()` via the `finally` block.
If `doPoll()` throws (e.g., database corruption, out of memory), the scheduler will silently
continue polling without any error reporting. At minimum, errors should be logged.

---

### W-8: XvfbManager Does Not Validate Display Format

**File:** `/apps/server-edition/src/browser-runtime/xvfb-manager.ts`, line 21

```typescript
const [width, height, depth] = this.config.resolution.split('x')
```

No validation that the resolution string matches the expected `WIDTHxHEIGHTxDEPTH` format.
A malformed value like `1920x1080` (missing depth) would silently pass `undefined` as the
depth to Xvfb.

---

### W-9: `RestConnector.initialize()` Does Not Validate `baseUrl`

**File:** `/apps/server-edition/src/connectors/rest/rest-connector.ts`, lines 13-16

```typescript
async initialize(config: Record<string, unknown>): Promise<void> {
    this.baseUrl = config.baseUrl as string
    this.headers = (config.headers as Record<string, string>) ?? {}
}
```

`baseUrl` is cast to `string` without checking if it is actually a string or a valid URL.
If `config.baseUrl` is `undefined`, `this.baseUrl` will be the string `"undefined"`, and all
subsequent HTTP calls will silently fail against that address. Same issue exists in
`WebhookConnector` with `config.url`.

---

### W-10: Self-Learner Downgrade Test Scheduling Uses Modular Arithmetic on Total Calls

**File:** `/apps/server-edition/src/router/self-learner.ts`, lines 120-121

```typescript
const totalCalls = this.metrics.getTotalCalls()
if (totalCalls % this.config.downgradeTestInterval !== 0) return
```

This logic only triggers when totalCalls is exactly divisible by the interval. Since the
optimization runs on a timer (not on every call), it is very likely to miss the exact moment
when the count hits a multiple. The test scheduling will rarely if ever trigger.

---

### W-11: `LLMRouter.close()` Calls `stopSelfLearning()` Twice

**File:** `/apps/server-edition/src/router/llm-router.ts`, lines 109-115

```typescript
close(): void {
    this.stopSelfLearning()
    if (this.selfLearner) {
      this.selfLearner.stop()  // Already called inside stopSelfLearning()
    }
    this.db.close()
}
```

`stopSelfLearning()` already calls `this.selfLearner.stop()`. The redundant call is harmless
but indicates copy-paste or incomplete refactoring.

---

### W-12: Shutdown Order May Cause Errors During Active Task Execution

**File:** `/apps/server-edition/src/server-edition.ts`, lines 302-367

During shutdown, resources are closed in this order:
1. Connectors
2. Adaptive optimizer + optimizer DB
3. Memory store
4. Session manager / cross-session store
5. LLM router
6. Task scheduler
7. Task store
8. VNC / Chromium / Xvfb

However, running tasks (step 6-7) may still be executing API calls against the BrowserOS server
(Chromium, step 8). The BrowserOS `Application` server is never explicitly stopped, which means
the underlying Hono server may keep processing requests. Also, if the task scheduler has active
tasks referencing the LLM router (already closed at step 5), those tasks will fail with closed
database errors rather than a clean cancellation.

---

## Suggestions

### S-1: Add Input Validation Schemas to All API Routes

The task routes properly use Zod schemas (`CreateTaskRequestSchema`, `TaskListQuerySchema`) for
input validation. Apply the same pattern to:
- Connector routes (POST /, POST /:id/toggle)
- Learning routes (POST /knowledge, POST /memory/analyze, POST /optimizer/run)
- Router routes (no write endpoints currently, but route parameters should still be validated)

---

### S-2: Create a Shared Database Connection

Instead of opening 4 separate `Database` instances against the same file, create a single
`Database` in `ServerEdition` and pass it to all subsystems. This simplifies resource management,
avoids busy errors, and ensures a single point of WAL pragma configuration.

---

### S-3: Add Structured Logging

**File:** `/apps/server-edition/src/server-edition.ts` (throughout)

The server uses `console.log()` for all logging. The `request-logger.ts` middleware outputs
structured JSON, but the rest of the application uses plain strings. Consider using a structured
logger throughout for consistency and to enable log aggregation tools.

---

### S-4: Dockerfile Should Use a Non-Root User

**File:** `/apps/server-edition/Dockerfile`

The container runs as root by default. Add:
```dockerfile
RUN groupadd -r browseros && useradd -r -g browseros browseros
RUN chown -R browseros:browseros /app
USER browseros
```

This limits the blast radius of any container escape or process compromise.

---

### S-5: Dockerfile Copies Entire `node_modules`

**File:** `/apps/server-edition/Dockerfile`, line 40

```dockerfile
COPY --from=builder /app/node_modules ./node_modules
```

This copies the full development `node_modules` including devDependencies, test tools, etc.
Consider running `bun install --production` in a separate stage or using `--frozen-lockfile`
with a production-only install.

---

### S-6: `ServerEdition.application` Is Typed as `any`

**File:** `/apps/server-edition/src/server-edition.ts`, line 32

```typescript
private application: any = null
```

This loses all type safety for the core application object. Import and use the actual
`Application` type from `@browseros/server/main`.

---

### S-7: `learning-routes.ts` Defines Local Interface Types That May Already Exist

**File:** `/apps/server-edition/src/api/learning-routes.ts`, lines 18-46

The file defines `MemoryEntry`, `SessionEntry`, and `KnowledgeEntry` interfaces locally.
These likely duplicate types already exported from the `@browseros/learning` package.
Import them instead to avoid drift.

---

### S-8: `BrowserPool` Is Defined But Never Used in `ServerEdition`

**File:** `/apps/server-edition/src/browser-runtime/browser-pool.ts`
**File:** `/apps/server-edition/src/api/browser-routes.ts`

`BrowserPool` and `createBrowserRoutes` exist but are never instantiated or mounted in
`ServerEdition.start()`. This is dead code. Either wire it in or remove it.

---

### S-9: VNC Internal Port 5900 Is Hardcoded

**File:** `/apps/server-edition/src/browser-runtime/vnc-proxy.ts`, line 34 and 75

The x11vnc RFB port is hardcoded to `5900`. This should be configurable or at least defined
as a named constant to avoid conflicts.

---

### S-10: `env.ts` Has Excellent Validation -- Extend It

**File:** `/apps/server-edition/src/env.ts`

The Zod-based environment validation is a strong pattern. Consider adding:
- Port range validation (`.min(1024).max(65535)`)
- `DB_PATH` path format validation
- `VNC_PASSWORD` minimum length when VNC is enabled

---

### S-11: Duplicate `ChromiumConfig` and `VncConfig` Type Definitions

**File:** `/apps/server-edition/src/browser-runtime/types.ts`, lines 17-25 and 27-32
**File:** `/apps/server-edition/src/browser-runtime/chromium-launcher.ts`, lines 5-13
**File:** `/apps/server-edition/src/browser-runtime/vnc-proxy.ts`, lines 3-8

`ChromiumConfig` is defined in both `types.ts` and `chromium-launcher.ts`. `VncConfig` is
defined in both `types.ts` and `vnc-proxy.ts`. The `types.ts` versions are unused. Consolidate
to a single definition.

---

### S-12: Consider Rate Limiting on Public API Endpoints

No rate limiting is applied to any API endpoint. The auth middleware protects against
unauthorized access, but an authenticated client (or when auth is disabled) can flood the
task queue or trigger unlimited connector operations. Consider adding rate limiting middleware
especially on POST endpoints.

---

### S-13: `config.ts` Should Validate `cliMode` Parameter

**File:** `/apps/server-edition/src/config.ts`, line 53

```typescript
mode: (cliMode as 'local' | 'server') ?? env.BROWSEROS_MODE,
```

The `cliMode` parameter from CLI argument parsing is cast without validation. If a user passes
`--mode foobar`, the mode will be `'foobar'` at runtime, bypassing the Zod enum validation
on the env variable.

---

### S-14: Add Graceful Drain for Active Tasks During Shutdown

The `TaskScheduler.stop()` method only stops polling and waits for the current poll to finish.
It does not wait for actively running tasks to complete. Consider adding a drain period where
the scheduler stops accepting new tasks but waits (with a timeout) for running tasks to finish.

---

## File-by-File Notes

### `/apps/server-edition/src/index.ts`
- Clean entrypoint with proper signal handling.
- `shutdown()` calls `process.exit(0)` even on errors (line 48) -- consider exit(1) if stop() throws.

### `/apps/server-edition/src/server-edition.ts`
- Largest file (391 lines) but within acceptable limits.
- `application: any` (line 32) -- type this properly (see S-6).
- Start sequence comments are numbered 5-9 but steps 1-4 are not labeled (lines 53-66).

### `/apps/server-edition/src/config.ts`
- Clean config factory pattern.
- `cliMode` cast bypasses validation (see S-13).

### `/apps/server-edition/src/env.ts`
- Excellent use of Zod for env validation. Model file for the project.

### `/apps/server-edition/src/middleware/auth.ts`
- Timing-vulnerable comparison (see C-1).
- `Authorization` header parsing only handles `Bearer` prefix (line 18). No harm, but consider
  documenting this explicitly.

### `/apps/server-edition/src/middleware/request-logger.ts`
- Well-structured JSON logging.
- No issues found.

### `/apps/server-edition/src/api/task-routes.ts`
- Good: Uses Zod schemas for all input validation.
- Task creation constructs the ID inline; this is clean.

### `/apps/server-edition/src/api/connector-routes.ts`
- Missing input validation on all endpoints (see C-2).

### `/apps/server-edition/src/api/health-routes.ts`
- `/ready` and `/live` always return true -- they are not meaningful probes (see W-2).

### `/apps/server-edition/src/api/router-routes.ts`
- Read-only routes, no major issues.

### `/apps/server-edition/src/api/learning-routes.ts`
- `Number.parseInt(limitStr, 10)` is correct and safe.
- POST `/knowledge` validates required fields but uses a hardcoded category list (lines 225-231).
  Consider deriving this from the `KnowledgeCategory` type.

### `/apps/server-edition/src/api/browser-routes.ts`
- Dead code: Not mounted by `ServerEdition` (see S-8).

### `/apps/server-edition/src/browser-runtime/chromium-launcher.ts`
- `launch()` wraps spawn in a Promise but the `on('error')` handler sets `this.process = null`
  while `waitForCdp` may still be running. No crash, but worth noting.
- `stop()` has double-resolve potential (see W-6).
- `detectChromiumPath()` is platform-aware -- good.

### `/apps/server-edition/src/browser-runtime/xvfb-manager.ts`
- `stop()` has double-resolve potential and leaked timeout (see W-6).
- No display format validation (see W-8).

### `/apps/server-edition/src/browser-runtime/vnc-proxy.ts`
- Password on command line (see C-4).
- `stop()` methods have the same double-resolve pattern (see W-6).

### `/apps/server-edition/src/browser-runtime/browser-pool.ts`
- Port collision risk (see W-3).
- `createInstance()` error handling sets status to `'error'` but does not clean up the
  launcher (line 44-46). The failed instance stays in the map permanently.

### `/apps/server-edition/src/browser-runtime/types.ts`
- Contains duplicate type definitions (see S-11).

### `/apps/server-edition/src/connectors/connector-interface.ts`
- Clean interface design.

### `/apps/server-edition/src/connectors/connector-manager.ts`
- `removeConnector()` deletes from DB even if connector was not in the in-memory map (line 86-89).
  This is actually correct behavior for handling stale DB records, but the return value only
  reflects DB deletion, not runtime removal.

### `/apps/server-edition/src/connectors/rest/rest-connector.ts`
- No URL or config validation (see W-9).
- `send()` does not handle fetch exceptions -- they propagate to the caller (ConnectorManager
  catches them in `broadcast()`, so this is acceptable).

### `/apps/server-edition/src/connectors/webhook/webhook-connector.ts`
- HMAC signature implementation is correct.
- Same URL validation concern as RestConnector.

### `/apps/server-edition/src/router/llm-router.ts`
- Double `stop()` call in `close()` (see W-11).
- `'no_available_provider'` not in `RouteDecision.reason` union (see W-5).

### `/apps/server-edition/src/router/routing-table.ts`
- Wildcard matching is simple but effective.
- `resolve()` fallback hardcodes model string (line 76-77). Consider using a constant.

### `/apps/server-edition/src/router/provider-pool.ts`
- Clean implementation.
- `buildLLMConfig()` exposes `secretAccessKey` and `sessionToken` in the returned object.
  Ensure these are never logged or returned in API responses.

### `/apps/server-edition/src/router/router-metrics.ts`
- SQL is well-structured with parameterized queries -- no injection risk.
- `any` casts on query results (see W-4).

### `/apps/server-edition/src/router/self-learner.ts`
- Downgrade test scheduling logic is unlikely to trigger (see W-10).
- `runOptimization()` is synchronous but calls methods that interact with the database. No
  async error handling.

### `/apps/server-edition/src/task-queue/task-store.ts`
- Well-structured schema with indexes.
- `(task as any).batchId` on line 90 -- the type already extends with `batchId?: string` in the
  function signature, so the `as any` cast is unnecessary.
- `listTasks()` uses parameterized queries -- safe.

### `/apps/server-edition/src/task-queue/task-scheduler.ts`
- `poll()` guard at line 70 prevents concurrent polls -- good.
- Error swallowing concern (see W-7).
- `cancelTask()` updates state to `cancelled` even for already-completed tasks (line 158).

### `/apps/server-edition/src/task-queue/task-executor.ts`
- SSRF via unvalidated webhookUrl (see C-3).
- `executeViaApi()` makes HTTP call to self (localhost) -- this is the intended architecture but
  should be documented clearly for security auditors.

### `/apps/server-edition/src/task-queue/dependency-resolver.ts`
- Cycle detection algorithm is correct but the reconstructed cycle path (lines 57-59) may be
  incomplete -- it only adds the first node encountered twice, not the full cycle.

### `/apps/server-edition/src/task-queue/retry-manager.ts`
- Clean exponential backoff with max cap. No issues.

### `/apps/server-edition/src/task-queue/types.ts`
- Clean type definitions. No issues.

### `/apps/server-edition/Dockerfile`
- Multi-stage build -- good.
- Runs as root (see S-4).
- Copies full `node_modules` (see S-5).
- HEALTHCHECK is properly configured with start-period.
- Uses `oven/bun:1.3` which is a specific minor version -- good for reproducibility. Consider
  pinning to a specific patch version or SHA for production.
- `apt-get` layer uses `--no-install-recommends` and cleans up lists -- good practice.
