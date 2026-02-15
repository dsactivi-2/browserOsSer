# BrowserOS Server Edition -- Task Queue

## Overview

The task queue enables asynchronous, prioritized, and dependency-aware execution of browser automation tasks. Tasks are submitted via REST API, persisted in SQLite, and executed by a poll-based scheduler that dispatches work to the BrowserOS Core agent.

## Architecture

```
                     POST /tasks
                         |
                         v
                  +------+-------+
                  |  TaskStore   |
                  |  (SQLite)    |
                  +------+-------+
                         |
           +-------------+-------------+
           |                           |
           v                           v
    +------+-------+          +--------+----------+
    | Dependency    |          | Task Scheduler    |
    | Resolver      |          | (polls every 1s)  |
    +------+-------+          +--------+----------+
           |                           |
           +---------------------------+
                         |
                         v
                  +------+-------+
                  | Task Executor|
                  | POST /chat   |
                  +------+-------+
                         |
                    +----+-----+
                    |          |
                    v          v
               completed    failed
                    |          |
                    |     +----+------+
                    |     | Retry     |
                    |     | Manager   |
                    |     +----+------+
                    |          |
                    v          v
               task_results   re-queue
                    |
                    v
               webhook (if configured)
```

## Task Lifecycle

A task transitions through these states:

```
pending --> queued --> running --> completed
   |          |          |
   |          |          +--> failed --> pending (retry)
   |          |                   |
   |          |                   +--> failed (max retries)
   |          |
   +--> waiting_dependency
   |
   +--> cancelled
```

### State Definitions

| State                | Description                                                       |
|----------------------|-------------------------------------------------------------------|
| `pending`            | Submitted, waiting to be picked up by the scheduler.              |
| `queued`             | Selected by scheduler, about to be dispatched to executor.        |
| `running`            | Actively being executed. Instruction sent to `/chat` endpoint.    |
| `completed`          | Execution finished successfully. Result stored in `task_results`. |
| `failed`             | Execution failed. May be retried based on retry policy.           |
| `cancelled`          | Manually cancelled or auto-cancelled due to failed dependency.    |
| `waiting_dependency` | Has unmet dependencies. Will be re-evaluated on next poll.        |

## Dependency Resolution

Tasks can declare dependencies on other tasks via `dependsOn` (array of task UUIDs).

### Rules

1. A task can only execute when **all** dependencies are in the `completed` state.
2. If any dependency is `failed` or `cancelled`, the dependent task is automatically cancelled.
3. Circular dependencies are detected by the `DependencyResolver.detectCycle()` method (DFS-based cycle detection).
4. Missing dependencies (referencing a non-existent task ID) block execution indefinitely -- the task stays in `waiting_dependency`.

### Resolution Algorithm

On each poll cycle, the scheduler:

1. Fetches candidate tasks (status `pending` or `queued`), sorted by priority then creation time.
2. For each candidate:
   a. Check `hasFailedDependency()` -- if true, cancel the task.
   b. Check `canExecute()` -- if all dependencies are `completed`, proceed.
   c. Otherwise, set state to `waiting_dependency`.

### Example

```json
{
  "tasks": [
    { "instruction": "Navigate to https://example.com", "dependsOn": [] },
    { "instruction": "Extract page title", "dependsOn": ["<task-1-id>"] },
    { "instruction": "Take screenshot", "dependsOn": ["<task-1-id>"] }
  ]
}
```

Task 2 and Task 3 both depend on Task 1. They will execute (potentially in parallel if `maxConcurrent > 1`) only after Task 1 completes.

---

## Retry Strategy

### Default Configuration

| Parameter           | Default | Source Constant                      |
|---------------------|---------|--------------------------------------|
| Max retries         | 3       | `TASK_QUEUE.DEFAULT_MAX_RETRIES`     |
| Base backoff        | 1,000ms | `TASK_QUEUE.DEFAULT_BACKOFF_MS`      |
| Backoff multiplier  | 2x      | `TASK_QUEUE.DEFAULT_BACKOFF_MULTIPLIER` |
| Max backoff         | 60,000ms| `TASK_QUEUE.MAX_BACKOFF_MS`          |

### Per-Task Override

Each task can specify a custom retry policy:

```json
{
  "instruction": "...",
  "retryPolicy": {
    "maxRetries": 5,
    "backoffMs": 2000,
    "backoffMultiplier": 3
  }
}
```

### Backoff Formula

```
delay = min(backoffMs * multiplier^retryCount, MAX_BACKOFF_MS)
```

| Retry # | Delay (defaults) |
|---------|------------------|
| 1       | 1,000ms          |
| 2       | 2,000ms          |
| 3       | 4,000ms          |
| 4       | 8,000ms          |
| 5       | 16,000ms         |
| ...     | up to 60,000ms   |

### Retry Flow

1. Task execution fails (exception, timeout, or non-2xx response from `/chat`).
2. `TaskScheduler.handleEvent()` receives a `task.failed` event.
3. `RetryManager.shouldRetry()` checks `retryCount < maxRetries`.
4. If retryable: increment `retry_count`, wait for backoff delay, reset state to `pending`.
5. If max retries exceeded: task remains in `failed` state. Webhook is sent.

---

## Concurrency Control

### Configuration

| Parameter                   | Default | Description                              |
|-----------------------------|---------|------------------------------------------|
| `TASK_QUEUE_MAX_CONCURRENT` | 1       | Max tasks executing simultaneously.      |
| `TASK_QUEUE.POLL_INTERVAL_MS`| 1,000ms| How often the scheduler checks for work. |

### Scheduling Algorithm

```
Every 1 second:
  if (activeTaskCount >= maxConcurrent) return  // at capacity
  if (pollPromise !== null) return               // already polling

  available = maxConcurrent - activeTaskCount
  candidates = getNextPendingTasks(available * 2)  // fetch 2x for buffer

  for each candidate:
    if (activeTaskCount >= maxConcurrent) break
    if (hasFailedDependency) cancel
    if (!canExecute) set waiting_dependency
    else:
      activeTaskCount++
      state = queued
      executor.execute(task)  // async, non-blocking
        .finally(() => activeTaskCount--)
```

Key behaviors:

- The scheduler is single-threaded (one poll at a time via `pollPromise` guard).
- Tasks are dispatched asynchronously -- the scheduler does not wait for completion.
- The `activeTaskCount` is decremented in the `.finally()` handler, ensuring accurate tracking.

### Priority Ordering

Tasks are dequeued by priority (descending weight) then creation time (ascending):

```sql
ORDER BY CASE priority
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 3
END, created_at ASC
```

| Priority   | Weight | Description                                    |
|------------|--------|------------------------------------------------|
| `critical` | 0      | Immediate execution. Pre-empts other tasks.    |
| `high`     | 1      | High priority, processed before normal tasks.  |
| `normal`   | 2      | Default priority.                              |
| `low`      | 3      | Background tasks. Processed last.              |

---

## Task Execution

### How Tasks Run

The `TaskExecutor` does not execute browser commands directly. Instead, it sends the task instruction to the BrowserOS Core `/chat` endpoint as a POST request:

```
POST http://127.0.0.1:{serverPort}/chat
Content-Type: application/json

{
  "conversationId": "<new-uuid>",
  "message": "<task.instruction>",
  "isScheduledTask": true,
  "mode": "agent",
  "supportsImages": false,
  "provider": "browseros"
}
```

If the task has a custom `llmConfig`, its fields are merged into the request body (overriding `provider`).

### Response Handling

The `/chat` endpoint returns Server-Sent Events (SSE). The executor:

1. Reads the full response text.
2. Parses SSE `data:` lines as JSON.
3. Takes the last event as the final result.
4. Stores the result in `task_results`.

### Timeout

Each task has a timeout (default: 120,000ms, configurable per task or globally). Implemented via `AbortController`:

```typescript
const abortController = new AbortController()
setTimeout(() => abortController.abort(), timeoutMs)
fetch(url, { signal: abortController.signal })
```

### Cancellation

When a task is cancelled via `DELETE /tasks/:taskId`:

1. If `running`: The `AbortController` for that task is aborted, which causes the fetch to throw.
2. State is set to `cancelled` in the database.

---

## Webhooks

Tasks and batches can specify a `webhookUrl`. On completion or failure, a POST request is sent:

```json
{
  "taskId": "...",
  "state": "completed",
  "result": { ... },
  "executionTimeMs": 4000
}
```

Or on failure:

```json
{
  "taskId": "...",
  "state": "failed",
  "error": "Chat API returned 500: Internal Server Error",
  "executionTimeMs": 2000
}
```

Webhook delivery is best-effort:
- Timeout: 10,000ms (`TASK_QUEUE.WEBHOOK_TIMEOUT_MS`)
- No retries on failure
- Failures are silently ignored (non-critical)

---

## Task Events

The scheduler emits events via the `TaskEventHandler` callback system:

| Event Type       | When                          | Payload Fields                        |
|------------------|-------------------------------|---------------------------------------|
| `task.created`   | Task submitted                | `taskId`, `state`, `timestamp`        |
| `task.started`   | Execution begins              | `taskId`, `batchId`, `state`, `timestamp` |
| `task.completed` | Execution succeeds            | `taskId`, `batchId`, `state`, `result`, `timestamp` |
| `task.failed`    | Execution fails               | `taskId`, `batchId`, `state`, `error`, `timestamp` |
| `task.cancelled` | Task cancelled                | `taskId`, `state`, `timestamp`        |

Register handlers via `taskScheduler.onEvent(handler)`. Handlers are called sequentially. Errors in handlers are caught and ignored.

---

## Batches

Batches group multiple tasks submitted together:

- Each task in a batch gets the same `batchId`.
- Batch metadata (webhook URL, parallelism) is stored in `task_batches`.
- Tasks within a batch can still have individual dependencies, priorities, and retry policies.
- Batch `parallelism` is stored but enforcement depends on the global `maxConcurrent` setting.

---

## Constants Reference

From `@browseros/shared/constants/task-queue`:

```typescript
export const TASK_QUEUE = {
  MAX_CONCURRENT_TASKS: 1,
  MAX_BATCH_SIZE: 100,
  MAX_BATCH_PARALLELISM: 10,
  DEFAULT_TIMEOUT_MS: 120_000,      // 2 minutes
  MAX_TIMEOUT_MS: 600_000,          // 10 minutes
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_BACKOFF_MS: 1_000,        // 1 second
  DEFAULT_BACKOFF_MULTIPLIER: 2,
  MAX_BACKOFF_MS: 60_000,           // 1 minute
  POLL_INTERVAL_MS: 1_000,          // 1 second
  WEBHOOK_TIMEOUT_MS: 10_000,       // 10 seconds
  TASK_RETENTION_DAYS: 30,
}
```
