# BrowserOS Server Edition -- API Reference

Base URL: `http://127.0.0.1:9100`

## Authentication

When `API_KEYS` environment variable is set, all endpoints except `/health` require authentication.

Provide the API key via one of:
- Header: `X-API-Key: <your-key>`
- Header: `Authorization: Bearer <your-key>`

Unauthenticated requests return:

```json
{ "error": "Unauthorized" }
```

Status: `401`

---

## Tasks

### POST /tasks

Submit a single task for execution.

**Request Body:**

```json
{
  "instruction": "Navigate to https://example.com and extract the page title",
  "priority": "normal",
  "dependsOn": [],
  "retryPolicy": {
    "maxRetries": 3,
    "backoffMs": 1000,
    "backoffMultiplier": 2
  },
  "timeout": 120000,
  "webhookUrl": "https://my-server.com/webhook",
  "metadata": { "project": "demo" },
  "llmConfig": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5-20250929"
  }
}
```

| Field         | Type     | Required | Default    | Description                                   |
|---------------|----------|----------|------------|-----------------------------------------------|
| `instruction` | string   | Yes      | --         | Natural language instruction for the agent.    |
| `priority`    | string   | No       | `"normal"` | One of: `critical`, `high`, `normal`, `low`.  |
| `dependsOn`   | string[] | No       | `[]`       | Array of task UUIDs that must complete first.  |
| `retryPolicy` | object   | No       | --         | Custom retry configuration.                    |
| `timeout`     | number   | No       | `120000`   | Task timeout in milliseconds (min: 1000).      |
| `webhookUrl`  | string   | No       | --         | URL to receive POST notifications on completion/failure. |
| `metadata`    | object   | No       | --         | Arbitrary key-value metadata.                  |
| `llmConfig`   | object   | No       | --         | Override LLM provider/model for this task.     |

**Response:** `201 Created`

```json
{
  "taskId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "state": "pending",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

**Example:**

```bash
curl -X POST http://127.0.0.1:9100/tasks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-secret-key" \
  -d '{"instruction": "Go to https://example.com and take a screenshot"}'
```

---

### POST /tasks/batch

Submit multiple tasks in a single request.

**Request Body:**

```json
{
  "tasks": [
    { "instruction": "Navigate to https://example.com" },
    { "instruction": "Extract all links from the page", "priority": "high" }
  ],
  "webhookUrl": "https://my-server.com/batch-done",
  "parallelism": 2
}
```

| Field         | Type     | Required | Default | Description                              |
|---------------|----------|----------|---------|------------------------------------------|
| `tasks`       | array    | Yes      | --      | 1-100 task objects (same schema as POST /tasks body). |
| `webhookUrl`  | string   | No       | --      | Webhook for batch-level events.           |
| `parallelism` | number   | No       | `1`     | Max parallel tasks within batch (1-10).   |

**Response:** `201 Created`

```json
{
  "batchId": "b1c2d3e4-f5a6-7890-abcd-ef1234567890",
  "taskIds": [
    "a1b2c3d4-...",
    "e5f6a7b8-..."
  ],
  "count": 2,
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

---

### GET /tasks

List tasks with optional filters.

**Query Parameters:**

| Parameter  | Type   | Default | Description                                   |
|------------|--------|---------|-----------------------------------------------|
| `state`    | string | --      | Filter by state: `pending`, `queued`, `running`, `completed`, `failed`, `cancelled`, `waiting_dependency`. |
| `priority` | string | --      | Filter by priority: `critical`, `high`, `normal`, `low`. |
| `batchId`  | string | --      | Filter by batch UUID.                          |
| `limit`    | number | `50`    | Max results (1-100).                           |
| `offset`   | number | `0`     | Pagination offset.                             |

**Response:** `200 OK`

```json
{
  "tasks": [
    {
      "taskId": "a1b2c3d4-...",
      "instruction": "Navigate to https://example.com",
      "priority": "normal",
      "state": "completed",
      "batchId": null,
      "retryCount": 0,
      "createdAt": "2025-01-15T10:30:00.000Z",
      "updatedAt": "2025-01-15T10:30:05.000Z"
    }
  ],
  "total": 42,
  "stats": {
    "total": 42,
    "pending": 5,
    "queued": 2,
    "running": 1,
    "completed": 30,
    "failed": 3,
    "cancelled": 1
  }
}
```

**Example:**

```bash
curl "http://127.0.0.1:9100/tasks?state=running&limit=10" \
  -H "X-API-Key: my-secret-key"
```

---

### GET /tasks/stats

Get queue statistics without task listing.

**Response:** `200 OK`

```json
{
  "total": 42,
  "pending": 5,
  "queued": 2,
  "running": 1,
  "completed": 30,
  "failed": 3,
  "cancelled": 1
}
```

---

### GET /tasks/:taskId

Get a task's status and result (including execution steps).

**Response:** `200 OK`

```json
{
  "taskId": "a1b2c3d4-...",
  "state": "completed",
  "result": { "title": "Example Domain" },
  "startedAt": "2025-01-15T10:30:01.000Z",
  "completedAt": "2025-01-15T10:30:05.000Z",
  "retryCount": 0,
  "executionTimeMs": 4000,
  "steps": [
    {
      "tool": "browser_navigate",
      "args": { "url": "https://example.com" },
      "result": { "success": true },
      "durationMs": 1200,
      "timestamp": "2025-01-15T10:30:02.000Z"
    }
  ]
}
```

**Error:** `404 Not Found`

```json
{ "error": "Task not found" }
```

---

### DELETE /tasks/:taskId

Cancel a task. Running tasks are aborted.

**Response:** `200 OK`

```json
{
  "taskId": "a1b2c3d4-...",
  "cancelled": true,
  "state": "cancelled"
}
```

---

### POST /tasks/:taskId/retry

Retry a failed or cancelled task. Resets state to `pending`.

**Response:** `200 OK`

```json
{
  "taskId": "a1b2c3d4-...",
  "state": "pending",
  "retryCount": 1
}
```

**Error:** `400 Bad Request`

```json
{ "error": "Can only retry failed or cancelled tasks" }
```

---

## Router

### GET /router

Get the full routing table (default mappings + learned overrides).

**Response:** `200 OK`

```json
{
  "routes": [
    {
      "toolPattern": "browser_navigate",
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "category": "simple",
      "isOverride": false
    },
    {
      "toolPattern": "browser_extract_*",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "category": "standard",
      "isOverride": true
    }
  ]
}
```

---

### GET /router/metrics

Get aggregated metrics for all tools or a specific tool.

**Query Parameters:**

| Parameter | Type   | Description                    |
|-----------|--------|--------------------------------|
| `tool`    | string | Filter by tool name (optional).|

**Response:** `200 OK`

```json
{
  "metrics": [
    {
      "toolName": "browser_navigate",
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "totalCalls": 150,
      "successCount": 145,
      "failureCount": 5,
      "successRate": 0.967,
      "avgLatencyMs": 450,
      "totalCost": 0.012,
      "lastUsed": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

**Example:**

```bash
curl "http://127.0.0.1:9100/router/metrics?tool=browser_navigate" \
  -H "X-API-Key: my-secret-key"
```

---

### GET /router/route/:toolName

Test which provider/model would be selected for a tool.

**Response:** `200 OK`

```json
{
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "reason": "default"
}
```

Possible `reason` values: `default`, `optimized`, `fallback`, `no_providers_available`.

---

### GET /router/config/:toolName

Get the full LLMConfig (with credentials) for a tool. Returns `404` if no provider is configured.

**Response:** `200 OK`

```json
{
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "apiKey": "sk-ant-..."
}
```

---

## Learning / Memory

### GET /learning/memory/stats

Get memory store statistics.

**Query Parameters:**

| Parameter   | Type   | Description                   |
|-------------|--------|-------------------------------|
| `sessionId` | string | Filter by session (optional). |

**Response:** `200 OK`

```json
{
  "total": 150,
  "byType": {
    "short_term": 80,
    "long_term": 50,
    "cross_session": 20
  },
  "compressed": 35
}
```

---

### GET /learning/memory

Get memory entries for a session.

**Query Parameters:**

| Parameter   | Type   | Required | Description                                           |
|-------------|--------|----------|-------------------------------------------------------|
| `sessionId` | string | Yes      | Session UUID.                                         |
| `type`      | string | No       | Filter: `short_term`, `long_term`, `cross_session`.   |
| `limit`     | number | No       | Max entries.                                          |

**Response:** `200 OK`

```json
{
  "sessionId": "sess-123",
  "type": "all",
  "count": 25,
  "entries": [
    {
      "id": "entry-uuid",
      "type": "short_term",
      "content": "User asked to navigate to example.com",
      "role": "user",
      "metadata": {},
      "relevanceScore": 0.85,
      "isCompressed": false,
      "compressedAt": null,
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

---

### GET /learning/memory/budget

Get the current token budget status for a session.

**Query Parameters:**

| Parameter   | Type   | Required | Description   |
|-------------|--------|----------|---------------|
| `sessionId` | string | Yes      | Session UUID. |

**Response:** `200 OK`

```json
{
  "budget": 190904,
  "used": 45000,
  "remaining": 145904,
  "usagePercent": 24,
  "shouldCompress": false,
  "config": {
    "maxContextTokens": 200000,
    "systemPromptTokens": 5000,
    "responseReserveTokens": 4096,
    "fullMessageWindow": 30,
    "compressionTriggerRatio": 0.7
  }
}
```

---

### POST /learning/memory/analyze

Trigger a memory self-analysis for a session.

**Request Body:**

```json
{ "sessionId": "sess-123" }
```

**Response:** `200 OK`

```json
{
  "timestamp": "2025-01-15T10:35:00.000Z",
  "totalEntries": 50,
  "relevantEntries": 35,
  "redundantEntries": 5,
  "suggestedActions": [
    { "type": "compress", "entryId": "entry-1", "reason": "Low relevance (0.15)" },
    { "type": "drop", "entryId": "entry-2", "reason": "Low relevance (0.10) and already compressed" },
    { "type": "promote", "entryId": "entry-3", "reason": "High relevance (0.92) with key facts" }
  ],
  "tokenUsage": {
    "maxTokens": 190904,
    "usedTokens": 45000,
    "remainingTokens": 145904,
    "compressionThreshold": 0.7,
    "messages": { "total": 50, "full": 35, "compressed": 15, "dropped": 0 }
  }
}
```

---

### GET /learning/sessions

List all persistent sessions.

**Query Parameters:**

| Parameter | Type   | Default | Description    |
|-----------|--------|---------|----------------|
| `limit`   | number | `50`    | Max sessions.  |

**Response:** `200 OK`

```json
{
  "count": 5,
  "sessions": [
    {
      "conversationId": "conv-uuid",
      "messageCount": 42,
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:35:00.000Z"
    }
  ]
}
```

---

### GET /learning/sessions/:conversationId

Get session details with full message history.

**Response:** `200 OK`

```json
{
  "conversationId": "conv-uuid",
  "history": [
    { "role": "user", "content": "Go to example.com", "timestamp": "..." },
    { "role": "assistant", "content": "Navigating...", "timestamp": "..." }
  ],
  "metadata": {},
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:35:00.000Z",
  "messageCount": 42
}
```

---

### GET /learning/knowledge

Search the cross-session knowledge base.

**Query Parameters:**

| Parameter  | Type   | Required | Default | Description                                           |
|------------|--------|----------|---------|-------------------------------------------------------|
| `q`        | string | Yes      | --      | Search term (matches key or value).                    |
| `category` | string | No       | --      | Filter: `domain`, `execution_pattern`, `user_preference`, `website_knowledge`, `error_pattern`. |
| `limit`    | number | No       | `20`    | Max results.                                           |

**Response:** `200 OK`

```json
{
  "query": "login",
  "category": "all",
  "count": 3,
  "results": [
    {
      "id": "kn-uuid",
      "category": "website_knowledge",
      "key": "example.com/login",
      "value": "Login form uses #email and #password selectors",
      "confidence": 0.9,
      "usageCount": 5,
      "lastUsedAt": "2025-01-15T10:30:00.000Z",
      "createdAt": "2025-01-10T08:00:00.000Z"
    }
  ]
}
```

**Example:**

```bash
curl "http://127.0.0.1:9100/learning/knowledge?q=login&category=website_knowledge" \
  -H "X-API-Key: my-secret-key"
```

---

### GET /learning/knowledge/stats

Get cross-session knowledge statistics.

**Response:** `200 OK`

```json
{
  "total": 150,
  "byCategory": {
    "domain": 30,
    "execution_pattern": 45,
    "user_preference": 15,
    "website_knowledge": 50,
    "error_pattern": 10
  },
  "avgConfidence": 0.72
}
```

---

### POST /learning/knowledge

Store a cross-session knowledge entry. Repeated stores with the same `category` + `key` increase confidence.

**Request Body:**

```json
{
  "category": "website_knowledge",
  "key": "example.com/login",
  "value": "Login form uses #email and #password selectors",
  "confidence": 0.8
}
```

**Response:** `201 Created`

```json
{
  "id": "kn-uuid",
  "category": "website_knowledge",
  "key": "example.com/login",
  "stored": true
}
```

---

### GET /learning/optimizer/status

Get the adaptive optimizer's current parameters and efficiency report.

**Response:** `200 OK`

```json
{
  "parameters": {
    "compressionTrigger": 0.65,
    "fullMessageWindow": 28,
    "minRelevance": 0.35,
    "targetUsageRatio": 0.65
  },
  "efficiency": {
    "totalOptimizations": 45,
    "totalTokensSaved": 125000,
    "avgSavingsPerRun": 2778,
    "currentParameters": { "..." : "..." }
  }
}
```

---

### POST /learning/optimizer/run

Trigger a manual optimization run.

**Request Body (optional):**

```json
{ "sessionId": "sess-123" }
```

**Response:** `200 OK`

```json
{
  "tokensBefore": 50000,
  "tokensAfter": 42000,
  "entriesCompressed": 5,
  "entriesDropped": 2,
  "entriesPromoted": 1,
  "compressionTriggerRatio": 0.65,
  "fullMessageWindow": 28,
  "minRelevanceScore": 0.35,
  "timestamp": "2025-01-15T10:36:00.000Z"
}
```

---

### GET /learning/optimizer/history

Get the optimization run history.

**Query Parameters:**

| Parameter | Type   | Default | Description        |
|-----------|--------|---------|--------------------|
| `limit`   | number | `20`    | Max history entries.|

---

## Connectors

### GET /connectors

List all registered connectors.

**Response:** `200 OK`

```json
[
  {
    "id": "conn-uuid",
    "type": "webhook",
    "name": "Slack Webhook",
    "enabled": true,
    "config": { "url": "https://hooks.slack.com/...", "secret": "..." },
    "createdAt": "2025-01-15T10:00:00.000Z"
  }
]
```

---

### POST /connectors

Register a new connector.

**Request Body:**

```json
{
  "type": "webhook",
  "name": "Slack Notifications",
  "config": {
    "url": "https://hooks.slack.com/services/...",
    "secret": "my-webhook-secret",
    "events": ["task_completed", "task_failed"]
  }
}
```

| Field    | Type   | Required | Description                                              |
|----------|--------|----------|----------------------------------------------------------|
| `type`   | string | Yes      | Connector type: `rest` or `webhook`.                     |
| `name`   | string | Yes      | Display name.                                            |
| `config` | object | No       | Type-specific configuration (see Connector Types below). |

**Connector Types:**

- **rest**: `{ "baseUrl": "https://api.example.com/events", "headers": { "Authorization": "Bearer ..." } }`
- **webhook**: `{ "url": "https://...", "secret": "hmac-secret", "events": ["task_completed"] }`

**Response:** `201 Created`

```json
{ "id": "conn-uuid", "type": "webhook", "name": "Slack Notifications" }
```

---

### DELETE /connectors/:id

Remove a connector.

**Response:** `200 OK`

```json
{ "id": "conn-uuid", "removed": true }
```

---

### GET /connectors/:id/health

Check connector health.

**Response:** `200 OK`

```json
{ "id": "conn-uuid", "healthy": true }
```

---

### POST /connectors/:id/toggle

Enable or disable a connector.

**Request Body:**

```json
{ "enabled": false }
```

**Response:** `200 OK`

```json
{ "id": "conn-uuid", "enabled": false }
```

---

## Health

### GET /health

Comprehensive health check. Returns `503` if any component is unhealthy.

**Response:** `200 OK` (or `503 Service Unavailable`)

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0",
  "checks": {
    "chromium": true,
    "taskQueue": true,
    "router": true,
    "memory": true
  },
  "timestamp": "2025-01-15T11:00:00.000Z"
}
```

**Note:** The `/health` endpoint is excluded from API key authentication.

**Example:**

```bash
curl http://127.0.0.1:9100/health
```

---

### GET /health/ready

Kubernetes-style readiness probe.

**Response:** `200 OK`

```json
{ "ready": true }
```

---

### GET /health/live

Kubernetes-style liveness probe.

**Response:** `200 OK`

```json
{ "live": true }
```

---

## Common Error Responses

| Status | Meaning                 | Body                                          |
|--------|-------------------------|-----------------------------------------------|
| 400    | Validation error        | `{ "error": { "fieldErrors": {...}, ... } }`  |
| 401    | Unauthorized            | `{ "error": "Unauthorized" }`                 |
| 404    | Resource not found      | `{ "error": "Task not found" }`               |
| 503    | Service degraded        | Health response with `"status": "degraded"`   |

## Request Headers

Every response includes:

| Header         | Description                                     |
|----------------|-------------------------------------------------|
| `X-Request-ID` | Unique request identifier (generated if not provided). |

Provide `X-Request-ID` in requests for distributed tracing correlation.
