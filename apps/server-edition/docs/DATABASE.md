# BrowserOS Server Edition -- Database Schema

## Overview

BrowserOS Server Edition uses a single SQLite database file for all persistence. The default path is `./data/browseros-server.db`, configurable via the `DB_PATH` environment variable.

All database connections enable **WAL (Write-Ahead Logging)** mode for concurrent read/write performance:

```sql
PRAGMA journal_mode = WAL;
```

Foreign keys are enabled where applicable:

```sql
PRAGMA foreign_keys = ON;
```

Multiple classes open independent `Database` connections to the same file. SQLite WAL mode supports this safely -- multiple readers and one writer can operate concurrently.

---

## Table Overview

| Table                       | Owner Class                | Module         | Purpose                               |
|-----------------------------|----------------------------|----------------|---------------------------------------|
| `tasks`                     | `TaskStore`                | task-queue     | Task definitions and state            |
| `task_results`              | `TaskStore`                | task-queue     | Execution results per task            |
| `task_steps`                | `TaskStore`                | task-queue     | Individual tool execution steps       |
| `task_batches`              | `TaskStore`                | task-queue     | Batch groupings                       |
| `routing_overrides`         | `RoutingTable`             | router         | Learned routing overrides             |
| `router_metrics`            | `RouterMetrics`            | router         | Per-call performance metrics          |
| `routing_optimizations`     | `SelfLearner`              | router         | Optimization audit log                |
| `downgrade_tests`           | `SelfLearner`              | router         | Active downgrade experiments          |
| `memory_entries`            | `MemoryStore`              | learning       | 3-tier memory entries                 |
| `memory_vectors`            | `VectorDB`                 | learning       | Embedding vectors for similarity search|
| `sessions`                  | `PersistentSessionManager` | learning       | Conversation session metadata         |
| `session_messages`          | `PersistentSessionManager` | learning       | Per-session message history           |
| `cross_session_knowledge`   | `CrossSessionStore`        | learning       | Persistent knowledge base             |
| `optimization_snapshots`    | `AdaptiveTokenOptimizer`   | learning       | Optimizer run history                 |
| `adaptive_parameters`       | `AdaptiveTokenOptimizer`   | learning       | Current self-tuned parameters         |
| `connectors`                | `ConnectorManager`         | connectors     | Registered external connectors        |

---

## Schema Definitions

### Task Queue Tables

#### `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    instruction TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    state TEXT NOT NULL DEFAULT 'pending',
    depends_on TEXT NOT NULL DEFAULT '[]',
    retry_policy TEXT,
    timeout INTEGER,
    webhook_url TEXT,
    metadata TEXT,
    llm_config TEXT,
    batch_id TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
```

| Column         | Type    | Description                                                         |
|----------------|---------|---------------------------------------------------------------------|
| `id`           | TEXT PK | UUID v4                                                             |
| `instruction`  | TEXT    | Natural language task instruction                                   |
| `priority`     | TEXT    | `critical`, `high`, `normal`, `low`                                 |
| `state`        | TEXT    | `pending`, `queued`, `running`, `completed`, `failed`, `cancelled`, `waiting_dependency` |
| `depends_on`   | TEXT    | JSON array of task UUIDs                                            |
| `retry_policy` | TEXT    | JSON: `{ maxRetries, backoffMs, backoffMultiplier }` (nullable)     |
| `timeout`      | INTEGER | Task timeout in ms (nullable, default from config)                  |
| `webhook_url`  | TEXT    | Notification URL (nullable)                                         |
| `metadata`     | TEXT    | JSON object (nullable)                                              |
| `llm_config`   | TEXT    | JSON: LLM provider/model override (nullable)                       |
| `batch_id`     | TEXT    | FK to `task_batches.id` (nullable)                                  |
| `retry_count`  | INTEGER | Number of retries executed                                          |
| `created_at`   | TEXT    | ISO 8601 timestamp                                                  |
| `updated_at`   | TEXT    | ISO 8601 timestamp                                                  |

#### `task_results`

```sql
CREATE TABLE IF NOT EXISTS task_results (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    result TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    execution_time_ms INTEGER
);
```

| Column             | Type    | Description                                     |
|--------------------|---------|-------------------------------------------------|
| `task_id`          | TEXT PK | FK to `tasks.id`                                |
| `result`           | TEXT    | JSON-serialized result from the agent (nullable) |
| `error`            | TEXT    | Error message on failure (nullable)              |
| `started_at`       | TEXT    | ISO 8601 when execution began                   |
| `completed_at`     | TEXT    | ISO 8601 when execution finished                 |
| `execution_time_ms`| INTEGER | Wall-clock execution time in milliseconds        |

Uses `ON CONFLICT DO UPDATE` for upsert semantics -- the result row is created when a task starts (`started_at`) and updated when it completes.

#### `task_steps`

```sql
CREATE TABLE IF NOT EXISTS task_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    tool TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    error TEXT,
    duration_ms INTEGER,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);
```

Records individual tool invocations within a task for debugging and auditing.

#### `task_batches`

```sql
CREATE TABLE IF NOT EXISTS task_batches (
    id TEXT PRIMARY KEY,
    webhook_url TEXT,
    parallelism INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
```

Groups multiple tasks submitted via `POST /tasks/batch`.

---

### Router Tables

#### `routing_overrides`

```sql
CREATE TABLE IF NOT EXISTS routing_overrides (
    tool_pattern TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL
);
```

Persisted overrides that take precedence over the default routing table. Written by the `SelfLearner` or manually. Loaded into memory on startup.

#### `router_metrics`

```sql
CREATE TABLE IF NOT EXISTS router_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    success INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    estimated_cost REAL NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_router_metrics_tool ON router_metrics(tool_name);
CREATE INDEX IF NOT EXISTS idx_router_metrics_provider ON router_metrics(provider, model);
```

One row per LLM call. Used for aggregated reporting and self-learning optimization. Old entries are cleaned up via `RouterMetrics.cleanup()` (default: 30 days).

#### `routing_optimizations`

```sql
CREATE TABLE IF NOT EXISTS routing_optimizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    old_provider TEXT NOT NULL,
    old_model TEXT NOT NULL,
    new_provider TEXT NOT NULL,
    new_model TEXT NOT NULL,
    reason TEXT NOT NULL,
    old_success_rate REAL,
    new_success_rate REAL,
    cost_savings REAL,
    timestamp TEXT NOT NULL
);
```

Audit log for every routing optimization decision made by the `SelfLearner`.

#### `downgrade_tests`

```sql
CREATE TABLE IF NOT EXISTS downgrade_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    test_provider TEXT NOT NULL,
    test_model TEXT NOT NULL,
    sample_size INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT NOT NULL,
    completed_at TEXT
);
```

Tracks active A/B experiments where the self-learner tests whether a cheaper model can handle a tool's workload. Status: `pending`, `passed`, `failed`.

---

### Memory Tables

#### `memory_entries`

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('short_term', 'long_term', 'cross_session')),
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    role TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    relevance_score REAL NOT NULL DEFAULT 1.0,
    is_compressed INTEGER NOT NULL DEFAULT 0,
    compressed_at TEXT,
    original_token_count INTEGER,
    compressed_token_count INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_relevance ON memory_entries(relevance_score DESC);
```

Core memory storage for the 3-tier system. The `type` column determines the tier. Compressed entries have `is_compressed = 1` and their `content` is replaced with a summarized version.

#### `memory_vectors`

```sql
CREATE TABLE IF NOT EXISTS memory_vectors (
    id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    dimension INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_created ON memory_vectors(created_at);
```

Stores embedding vectors as raw `Float32Array` blobs. The `id` column maps to `memory_entries.id`. Used for cosine similarity search by `VectorDB`.

#### `sessions`

```sql
CREATE TABLE IF NOT EXISTS sessions (
    conversation_id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
);
```

Persistent session metadata. Each conversation gets one row.

#### `session_messages`

```sql
CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    token_count INTEGER,
    is_compressed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_messages_conv ON session_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_ts ON session_messages(conversation_id, timestamp);
```

Full message history per session. Supports compression marking -- old messages can be flagged as compressed while a summary message is inserted.

#### `cross_session_knowledge`

```sql
CREATE TABLE IF NOT EXISTS cross_session_knowledge (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(category, key)
);

CREATE INDEX IF NOT EXISTS idx_cross_category ON cross_session_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_cross_confidence ON cross_session_knowledge(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_cross_usage ON cross_session_knowledge(usage_count DESC);
```

Knowledge that persists across sessions. Categories: `domain`, `execution_pattern`, `user_preference`, `website_knowledge`, `error_pattern`. Confidence increases on repeated storage (via `ON CONFLICT DO UPDATE`) and decays for unused entries.

#### `optimization_snapshots`

```sql
CREATE TABLE IF NOT EXISTS optimization_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tokens_before INTEGER NOT NULL,
    tokens_after INTEGER NOT NULL,
    entries_compressed INTEGER NOT NULL DEFAULT 0,
    entries_dropped INTEGER NOT NULL DEFAULT 0,
    entries_promoted INTEGER NOT NULL DEFAULT 0,
    compression_trigger REAL NOT NULL,
    full_message_window INTEGER NOT NULL,
    min_relevance REAL NOT NULL,
    timestamp TEXT NOT NULL
);
```

History of adaptive optimizer runs. Pruned to the most recent 500 entries.

#### `adaptive_parameters`

```sql
CREATE TABLE IF NOT EXISTS adaptive_parameters (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL,
    updated_at TEXT NOT NULL
);
```

Stores the current self-tuned parameters: `compression_trigger`, `full_window`, `min_relevance`. Restored on startup so the optimizer does not lose its learned state.

---

### Connector Tables

#### `connectors`

```sql
CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
```

Persists registered connectors. The `config` column stores JSON with type-specific settings (URL, headers, secret, events).

---

## Table Relationships

```
tasks --------< task_results      (1:1, FK task_id -> tasks.id)
tasks --------< task_steps        (1:N, FK task_id -> tasks.id)
tasks >-------- task_batches      (N:1, batch_id -> task_batches.id, logical FK)

sessions -----< session_messages  (1:N, FK conversation_id, CASCADE DELETE)

memory_entries < memory_vectors   (1:1, id -> id, logical FK)
```

Note: The `tasks.batch_id` reference to `task_batches.id` is a logical foreign key (not enforced by a `REFERENCES` clause) since batch creation and task creation happen in the same transaction context.

## WAL Mode

All database connections set `PRAGMA journal_mode = WAL`. This provides:

- **Concurrent reads**: Multiple readers do not block each other or the writer.
- **Non-blocking writes**: Writers do not block readers.
- **Crash recovery**: WAL ensures durability even on unexpected shutdowns.
- **Better performance**: Particularly for read-heavy workloads with occasional writes.

WAL creates two additional files alongside the `.db` file:
- `browseros-server.db-wal` (write-ahead log)
- `browseros-server.db-shm` (shared memory)

These files are managed automatically by SQLite.

## Migration Strategy

The current schema uses `CREATE TABLE IF NOT EXISTS` for all tables. This provides a basic migration strategy:

1. **Additive changes**: New tables and indexes are created automatically on startup.
2. **Column additions**: Not handled automatically. Would require explicit `ALTER TABLE` statements.
3. **Breaking changes**: Require manual migration scripts or database recreation.

There is no versioned migration system at this time. The schema is considered stable for the initial release. Future versions may introduce a migration framework.

## Backup Recommendations

Since all data resides in a single SQLite file:

```bash
# Hot backup (safe while server is running due to WAL mode)
sqlite3 /app/data/browseros-server.db ".backup '/app/data/backup.db'"

# Or simply copy (ensure no active checkpoint)
cp /app/data/browseros-server.db /app/data/backup.db
cp /app/data/browseros-server.db-wal /app/data/backup.db-wal
cp /app/data/browseros-server.db-shm /app/data/backup.db-shm
```
