# BrowserOS Server Edition -- Memory System

## Overview

The memory system provides persistent, tiered storage for conversation context. It prevents context window overflow through compression, manages relevance scoring, and learns across sessions via a cross-session knowledge base. An adaptive optimizer automatically tunes memory parameters every 2 minutes.

## Architecture

```
+----------------------------------------------------------------------+
|                          Memory System                                |
|                                                                       |
|  +-------------------+  +--------------------+  +------------------+ |
|  |  Short-term       |  |  Long-term         |  |  Cross-session   | |
|  |  (session context)|  |  (promoted facts)  |  |  (knowledge DB)  | |
|  |                   |  |                    |  |                  | |
|  |  Full messages    |  |  Compressed or     |  |  Key-value pairs | |
|  |  (recent 30)      |  |  promoted entries  |  |  with confidence | |
|  |                   |  |                    |  |  scoring          | |
|  +---------+---------+  +---------+----------+  +--------+---------+ |
|            |                      |                      |            |
|            +----------+-----------+----------+-----------+            |
|                       |                      |                        |
|              +--------v--------+    +--------v---------+             |
|              |  Memory Store   |    |  Cross-Session   |             |
|              |  (SQLite +      |    |  Store (SQLite)  |             |
|              |   Vector DB)    |    +--------+---------+             |
|              +--------+--------+             |                        |
|                       |                      |                        |
|  +--------------------+----------------------+-------------------+   |
|  |                                                               |   |
|  |  +------------------+  +-------------------+  +------------+  |   |
|  |  | Token Budget     |  | Memory Analyzer   |  | Memory     |  |   |
|  |  | Manager          |  | (relevance +      |  | Compressor |  |   |
|  |  | (200K context)   |  |  redundancy)      |  | (fact      |  |   |
|  |  +------------------+  +-------------------+  | preserving)|  |   |
|  |                                               +------------+  |   |
|  |  +---------------------------------------------------------+  |   |
|  |  |  Adaptive Token Optimizer (self-tuning, every 2 min)    |  |   |
|  |  +---------------------------------------------------------+  |   |
|  +---------------------------------------------------------------+   |
|                                                                       |
|  +-------------------+                                                |
|  | Persistent Session|  (session history, message compression)        |
|  | Manager           |                                                |
|  +-------------------+                                                |
+----------------------------------------------------------------------+
```

## 3-Tier Memory

### Tier 1: Short-term Memory

**Purpose**: Current session context. Keeps the most recent messages in full fidelity.

| Property                | Value                                    |
|-------------------------|------------------------------------------|
| Type tag                | `short_term`                             |
| Default retention       | Session lifetime                         |
| Full message window     | 30 most recent messages (tunable)        |
| Compression trigger     | 70% of token budget used (tunable)       |
| Max tokens              | 190,000 (configurable via `maxShortTermTokens`) |

Short-term entries are stored in `memory_entries` with `type = 'short_term'`. When the token budget reaches the compression threshold, older messages are compressed or dropped.

### Tier 2: Long-term Memory

**Purpose**: Important facts promoted from short-term storage. Persists across the session.

| Property                | Value                                    |
|-------------------------|------------------------------------------|
| Type tag                | `long_term`                              |
| Promotion criteria      | Relevance score >= 0.8 AND contains key facts |
| Storage                 | Same `memory_entries` table              |
| Compression             | Compressed when budget is tight          |
| Drop criteria           | Relevance < 0.3 AND already compressed   |

The `MemoryAnalyzer` suggests promotion via a `promote` action when it detects high-value short-term entries.

### Tier 3: Cross-session Knowledge

**Purpose**: Persistent knowledge that survives across sessions and conversations.

| Property                | Value                                    |
|-------------------------|------------------------------------------|
| Storage                 | `cross_session_knowledge` table          |
| Categories              | `domain`, `execution_pattern`, `user_preference`, `website_knowledge`, `error_pattern` |
| Confidence              | 0.0 -- 1.0, increases on repeated storage, decays when unused |
| Deduplication           | `UNIQUE(category, key)` -- repeated stores update existing entries |

**Knowledge Categories:**

| Category            | Examples                                                |
|---------------------|---------------------------------------------------------|
| `domain`            | "e-commerce site", "SPA with React", "requires login"  |
| `execution_pattern` | "Click cookie banner before navigation", "Wait 2s for AJAX" |
| `user_preference`   | "Prefer dark mode screenshots", "Always extract prices" |
| `website_knowledge` | "Login form uses #email and #password", "Cart is at /cart" |
| `error_pattern`     | "CAPTCHA appears after 3 requests", "Rate limit at 10 req/min" |

**Confidence Mechanics:**
- Initial confidence: 0.5 (or specified by caller)
- Each repeated store: `+0.1` (capped at 1.0)
- Each usage: `+0.05` (capped at 1.0)
- Decay: `-0.1` for entries unused for 30+ days
- Prune: Entries with confidence < 0.1 are deleted

---

## Token Budget Management

### Configuration

```typescript
{
  maxContextTokens: 200_000,       // Total context window (Claude)
  systemPromptTokens: 5_000,       // Reserved for system prompt
  responseReserveTokens: 4_096,    // Reserved for model response
  fullMessageWindow: 30,           // Messages kept in full (not compressed)
  compressionTriggerRatio: 0.7     // Start compressing at 70% usage
}
```

### Budget Calculation

```
Available Budget = maxContextTokens - systemPromptTokens - responseReserveTokens
                 = 200,000 - 5,000 - 4,096
                 = 190,904 tokens
```

### Token Estimation

Token count is estimated as `ceil(text.length / 4)` (approximately 4 characters per token for English text). This is a fast heuristic, not a precise tokenizer.

### Message Partitioning

When the budget is under pressure, the `TokenBudgetManager` partitions messages into three sets:

1. **Full** (recent N messages): Always kept at full fidelity.
2. **Compressed** (older messages that fit at ~20% size): Summarized, key facts preserved.
3. **Dropped** (oldest messages that exceed budget even compressed): Removed entirely.

```
Messages:  [oldest] ... [old] ... [recent-30] ... [newest]
            |            |          |               |
          dropped    compressed   full messages    full messages
```

Algorithm:
1. Always keep the most recent `fullMessageWindow` messages.
2. Working backwards from the window, try to fit older messages at full size (up to 85% budget).
3. If full size does not fit, try at 20% (compressed) up to 95% budget.
4. If neither fits, mark for drop.

---

## Memory Analysis

The `MemoryAnalyzer` evaluates all entries and suggests actions.

### Relevance Scoring

Each entry receives a score from 0.0 to 1.0 based on:

**Recency Boost:**
- Last hour: +0.2
- Last day: +0.1
- Older than 1 day: -0.1

**Content Signals (positive):**
- Contains `error` or `failed`: +0.15
- Contains URLs (`http://`, `https://`): +0.1
- Contains selectors (`selector`, `xpath`): +0.1
- Contains `password` or `credential`: +0.2
- Contains `important` or `critical`: +0.15

**Content Signals (negative):**
- Content < 20 characters: -0.2
- Starts with `ok`, `yes`, `no`, `sure`, `thanks`, `hi`, `hello`: -0.3

**Role Boost:**
- `system` role: +0.1
- `tool` role: +0.15

Score is clamped to [0.0, 1.0].

### Redundancy Detection

The analyzer compares all entry pairs using Jaccard similarity on word sets:

```
similarity = |words_A intersection words_B| / |words_A union words_B|
```

If similarity >= 0.9 (configurable), the older entry is marked as redundant and flagged for compression.

### Suggested Actions

| Action    | When                                              | Effect                          |
|-----------|---------------------------------------------------|---------------------------------|
| `compress`| Relevance < 0.3 AND not yet compressed            | Replace content with summary    |
| `drop`    | Relevance < 0.3 AND already compressed            | Delete entry entirely           |
| `promote` | Short-term AND relevance >= 0.8 AND has key facts | Increase relevance to 1.0       |

### Key Facts Detection

An entry "has key facts" if its content matches any of these patterns:
- URLs (`https?://...`)
- Error messages (`error`, `failed`, `exception`)
- CSS/XPath selectors
- API references
- Credentials
- Step/phase references (`step 1`, `phase 2`)

---

## Memory Compression

The `MemoryCompressor` reduces message size while preserving critical information.

### Preserved Patterns

These patterns are extracted and always kept in compressed output:

| Pattern                     | Example                              |
|-----------------------------|--------------------------------------|
| URLs                        | `https://example.com/login`          |
| Email addresses             | `user@example.com`                   |
| Error messages              | `Error: element not found`           |
| CSS selectors               | `selector: '#login-form'`            |
| Class names                 | `class="btn-primary"`                |
| Element IDs                 | `id="submit-button"`                 |
| IP addresses                | `192.168.1.100`                      |
| Multi-digit numbers         | `9100`, `120000` (ports, IDs, etc.)  |

### Compression Output

For messages longer than 200 characters:

```
[role] First line of content (max 200 chars)
... Last line of content (max 200 chars)
[preserved: https://example.com, #login-form, Error: not found]
```

Short messages (< 200 characters) are kept as-is.

### Batch Compression

Multiple messages can be compressed into a single summary:

```
[Summary of 15 messages]
Actions: User: Navigate to... | User: Click the login button
Results: Agent: Successfully navigated | Agent: Clicked element
Key facts: https://example.com, #email, #password, Error: timeout
```

---

## Adaptive Optimizer

The `AdaptiveTokenOptimizer` is a self-tuning system that adjusts memory parameters based on observed performance.

### How It Works

1. **Runs every 2 minutes** (configurable via `intervalMs`).
2. Collects all memory entries (or entries for a specific session).
3. Calculates current token usage ratio.
4. Runs the `MemoryAnalyzer` to get suggested actions.
5. Executes the actions (compress, drop, promote).
6. Adjusts parameters based on the usage delta.
7. Records a snapshot for historical tracking.

### Self-Tuning Parameters

| Parameter              | Initial Value | Range       | Description                          |
|------------------------|---------------|-------------|--------------------------------------|
| `compressionTrigger`   | 0.7           | 0.35 -- 0.85 | Token usage ratio that triggers compression. |
| `fullMessageWindow`    | 30            | 10 -- 50    | Number of recent messages kept in full.       |
| `minRelevance`         | 0.3           | 0.15 -- 0.70 | Below this score, entries get compressed/dropped. |
| `targetUsageRatio`     | 0.65          | (fixed)     | Desired token budget utilization.             |

### Adaptation Rules

```
learning_rate = 0.05

if (usageRatio > target + 0.10):
    // Over budget -- be more aggressive
    compressionTrigger -= learning_rate      (more eager compression)
    fullMessageWindow  -= 2                  (fewer full messages)
    minRelevance       += learning_rate      (higher bar for keeping)

else if (usageRatio < target - 0.15):
    // Under budget -- relax constraints
    compressionTrigger += learning_rate * 0.5  (less eager compression)
    fullMessageWindow  += 1                    (more full messages)
    minRelevance       -= learning_rate * 0.5  (lower bar for keeping)

if (savingsRatio < 5% AND usageRatio > target):
    // Optimization not effective -- emergency adjustment
    compressionTrigger -= learning_rate * 2
    minRelevance       += learning_rate * 2
```

### Parameter Persistence

Parameters are saved to `adaptive_parameters` (SQLite key-value table) after every adjustment. On startup, saved parameters are restored so the optimizer does not lose its learned state.

### Optimization Snapshots

Each run records a snapshot to `optimization_snapshots`:

```json
{
  "tokensBefore": 150000,
  "tokensAfter": 120000,
  "entriesCompressed": 8,
  "entriesDropped": 3,
  "entriesPromoted": 2,
  "compressionTriggerRatio": 0.62,
  "fullMessageWindow": 26,
  "minRelevanceScore": 0.38,
  "timestamp": "2025-01-15T10:36:00.000Z"
}
```

History is pruned to the most recent 500 entries.

### Efficiency Report

Available via `GET /learning/optimizer/status`:

```json
{
  "totalOptimizations": 45,
  "totalTokensSaved": 125000,
  "avgSavingsPerRun": 2778,
  "currentParameters": {
    "compressionTrigger": 0.62,
    "fullMessageWindow": 26,
    "minRelevance": 0.38,
    "targetUsageRatio": 0.65
  }
}
```

---

## Persistent Sessions

The `PersistentSessionManager` stores complete conversation histories in SQLite.

### Session Lifecycle

1. **Create/Get**: `getOrCreate(conversationId)` -- creates a new session or returns the cached one.
2. **Add Message**: `addMessage(conversationId, role, content)` -- appends to history, increments counter.
3. **Compress**: `compressMessages(conversationId, olderThanId, summary)` -- marks old messages as compressed, inserts a `[CONTEXT SUMMARY]` system message.
4. **Delete**: `delete(conversationId)` -- removes session and all messages (cascade).

### In-Memory Cache

Recent sessions are cached in a `Map` for fast access. The cache is populated on first `getOrCreate()` call and updated on `addMessage()`.

### Message Storage

Each message is stored with:
- `role`: `user`, `assistant`, `system`, `tool`
- `content`: Full text
- `timestamp`: ISO 8601
- `token_count`: Optional pre-computed token count
- `is_compressed`: Flag for compressed messages

---

## Vector Search

The `VectorDB` provides in-process semantic similarity search for memory entries.

### Storage

Embeddings are stored as raw `Float32Array` blobs in `memory_vectors`. Each vector is associated with a `memory_entries` row by ID.

### Search

```typescript
const results = memoryStore.searchByVector(queryEmbedding, limit)
// Returns: [{ entry: MemoryEntry, similarity: number }]
```

Search performs a brute-force cosine similarity scan over all stored vectors. This is acceptable for the expected data volume (hundreds to low thousands of entries per session).

### Cosine Similarity

```
similarity(a, b) = dot(a, b) / (||a|| * ||b||)
```

The query vector's norm is pre-computed for efficiency across multiple comparisons.

---

## Data Flow Example

A typical memory flow during a task execution:

1. User submits instruction: "Navigate to example.com and extract the title."
2. A new session is created or resumed. The instruction is stored as a `short_term` entry with role `user`.
3. The agent responds. Response stored as `short_term` with role `assistant`.
4. Tool results (navigation, extraction) are stored as `short_term` with role `tool`.
5. After 20 messages, the `MemoryAnalyzer` runs (via the adaptive optimizer's 2-minute cycle).
6. Low-relevance entries (e.g., "ok", "navigating...") are compressed.
7. Redundant entries are compressed.
8. High-value entries (with URLs, selectors) are promoted.
9. If the agent learns "example.com uses #page-title for its title", this is stored in cross-session knowledge as `website_knowledge`.
10. On the next session involving example.com, the cross-session knowledge is retrieved and added to the context.
