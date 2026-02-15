# BrowserOS Server Edition -- LLM Router

## Overview

The LLM Router determines which LLM provider and model handles each browser tool invocation. It uses a three-layer resolution strategy (default, override, fallback) and includes a self-learning mechanism that automatically upgrades models with low success rates and tests cheaper alternatives for high-performing tools.

## Architecture

```
                   route("browser_navigate")
                            |
                            v
                   +--------+--------+
                   |  Routing Table  |
                   |                 |
                   |  1. Override?   +----> (learned optimization)
                   |  2. Default?   +----> (DEFAULT_ROUTING_TABLE)
                   |  3. Fallback   +----> (anthropic/sonnet)
                   +--------+--------+
                            |
                            v
                   +--------+--------+
                   |  Provider Pool  |
                   |                 |
                   |  Available?     +----> fallback provider
                   |  Build config   +----> LLMConfig
                   +--------+--------+
                            |
                            v
                    RouteDecision {
                      provider, model, reason
                    }

               (after execution)
                            |
                            v
                   +--------+--------+
                   | Router Metrics  |
                   | (SQLite)        |
                   +--------+--------+
                            |
                   +--------+--------+
                   |  Self-Learner   |
                   |  (every 60s)    |
                   |                 |
                   |  - Upgrade low  |
                   |    success rate |
                   |  - Test cheaper |
                   |    alternatives |
                   +-----------------+
```

## Routing Logic

The routing resolution follows this priority chain:

### 1. Override (Highest Priority)

Check `routing_overrides` table (in-memory + persisted in SQLite). These are created by:
- The self-learner's automatic optimizations
- Manual overrides via the routing table API (not yet exposed)

Overrides support wildcard patterns: `browser_tab_*` matches `browser_tab_close`, `browser_tab_new`, etc.

**Resolution**: Exact match first, then wildcard match.

### 2. Default Mapping

If no override exists, consult the `DEFAULT_ROUTING_TABLE` from `@browseros/shared/constants/router`. This maps tool name patterns to categories and default provider/model:

| Tool Pattern              | Category | Default Provider | Default Model              |
|---------------------------|----------|------------------|----------------------------|
| `browser_navigate`        | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_click`           | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_fill`            | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_scroll_*`        | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_tab_*`           | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_go_back`         | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_go_forward`      | simple   | anthropic        | claude-haiku-4-5-20251001  |
| `browser_extract_*`       | standard | anthropic        | claude-sonnet-4-5-20250929 |
| `browser_get_page_content`| standard | anthropic        | claude-sonnet-4-5-20250929 |
| `browser_get_console_*`   | standard | anthropic        | claude-sonnet-4-5-20250929 |
| `browser_execute_javascript`| standard | anthropic      | claude-sonnet-4-5-20250929 |
| `browser_get_interactive_elements`| standard | anthropic | claude-sonnet-4-5-20250929 |
| `browser_multi_act`       | complex  | anthropic        | claude-opus-4-6            |
| `browser_get_screenshot`  | vision   | google           | gemini-2.5-pro             |
| `browser_snapshot`        | vision   | google           | gemini-2.5-pro             |

**Categories:**
- **simple** -- Fast, cheap models for atomic browser actions (click, navigate, fill).
- **standard** -- Mid-tier models for content extraction and JavaScript execution.
- **complex** -- Top-tier models for multi-step reasoning and planning.
- **vision** -- Models with image understanding for screenshots and visual snapshots.

### 3. Fallback (Lowest Priority)

If no override or default mapping matches, the router falls back to:

```typescript
{
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  reason: 'fallback'
}
```

### Provider Availability Check

After resolution, the router checks if the chosen provider has credentials in the `ProviderPool`. If not:

1. Iterate over all available providers.
2. Select the first alternative provider.
3. Return with `reason: 'fallback'`.

If no providers are available at all: `reason: 'no_providers_available'`.

---

## Provider Pool Management

The `ProviderPool` holds API credentials for each LLM provider. Providers are registered at startup.

### Supported Providers

| Provider           | Key          | Required Credentials                     |
|--------------------|--------------|------------------------------------------|
| Anthropic          | `anthropic`  | `apiKey`                                 |
| OpenAI             | `openai`     | `apiKey`                                 |
| Google             | `google`     | `apiKey`                                 |
| OpenRouter         | `openrouter` | `apiKey`                                 |
| Azure OpenAI       | `azure`      | `apiKey`, `baseUrl`, `resourceName`      |
| Ollama             | `ollama`     | `baseUrl`                                |
| LM Studio          | `lmstudio`   | `baseUrl`                                |
| AWS Bedrock        | `bedrock`    | `region`, `accessKeyId`, `secretAccessKey`|
| BrowserOS (local)  | `browseros`  | (none -- uses internal routing)          |
| OpenAI Compatible  | `openai-compatible` | `apiKey`, `baseUrl`               |

### LLMConfig Output

When `buildConfigForTool()` is called, the router resolves the provider/model and returns a full `LLMConfig` object:

```typescript
{
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: 'sk-ant-...',
  baseUrl: undefined,
  resourceName: undefined,
  region: undefined,
  accessKeyId: undefined,
  secretAccessKey: undefined,
  sessionToken: undefined
}
```

---

## Metrics

### Recording

Every LLM call should record a metric entry:

```typescript
llmRouter.recordMetric({
  toolName: 'browser_navigate',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  success: true,
  latencyMs: 450,
  estimatedCost: 0.00008,
  timestamp: new Date().toISOString()
})
```

### Aggregation

The `GET /router/metrics` endpoint returns per-tool, per-provider/model aggregates:

```sql
SELECT
  tool_name, provider, model,
  COUNT(*) as total_calls,
  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
  CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as success_rate,
  AVG(latency_ms) as avg_latency_ms,
  SUM(estimated_cost) as total_cost,
  MAX(timestamp) as last_used
FROM router_metrics
GROUP BY tool_name, provider, model
ORDER BY tool_name, success_rate DESC
```

### Cleanup

Old metrics are periodically cleaned (default: entries older than 30 days):

```typescript
routerMetrics.cleanup(30) // Delete entries older than 30 days
```

---

## Self-Learning Mechanism

The `SelfLearner` runs an optimization cycle every 60 seconds (configurable). It performs three operations:

### 1. Upgrade by Success Rate

For each tool with sufficient data (10+ calls):

- If the current model's success rate drops below **70%** (`SUCCESS_RATE_UPGRADE_THRESHOLD`):
  - Haiku -> upgraded to Sonnet
  - Sonnet -> upgraded to Opus

```
haiku success rate = 65%  -->  Override: use sonnet
sonnet success rate = 60% -->  Override: use opus
```

The override is persisted in `routing_overrides` and an audit entry is written to `routing_optimizations`.

### 2. Schedule Downgrade Tests

Every 500 calls (`DOWNGRADE_TEST_INTERVAL`), the self-learner identifies candidates for downgrade testing:

**Criteria:**
- Current success rate >= 95%
- At least 20 calls
- Currently using Opus or Sonnet

**Action:**
- Create a `downgrade_tests` entry with the cheaper model
- Sample size threshold: 10 calls (`DOWNGRADE_TEST_SAMPLE_SIZE`)

Max 3 pending tests at a time. Max 2 new tests per cycle.

### 3. Evaluate Downgrade Tests

For pending tests that have reached the sample size threshold:

- If success rate >= **90%** (`SUCCESS_RATE_KEEP_THRESHOLD`): **Downgrade approved.** Set a routing override to the cheaper model.
- If success rate < 90%: **Downgrade rejected.** Remove the test, keep the current model.

### Optimization Flow

```
                     High success rate (>=95%)
                     with expensive model?
                            |
                     YES    |    NO
                     |      |     |
                     v      |     v
              Schedule      |   Low success rate (<70%)?
              downgrade     |         |
              test          |    YES  |    NO
                     |      |     |   |     |
                     v      |     v   |     v
              Run 10 sample |  Upgrade|   (no action)
              calls         |  model  |
                     |      |         |
              +-----------+ |         |
              | >= 90%    | |         |
              | success?  | |         |
              +-----+-----+|         |
              YES   |   NO  |         |
              |     |    |  |         |
              v     |    v  |         |
           Apply    | Reject|         |
           override | test  |         |
```

### Configuration

| Parameter                     | Default   | Description                             |
|-------------------------------|-----------|-----------------------------------------|
| `optimizationInterval`        | 60,000ms  | How often the self-learner runs.        |
| `minCallsForOptimization`     | 10        | Min calls before optimizing a tool.     |
| `SUCCESS_RATE_UPGRADE_THRESHOLD` | 0.7    | Below this, upgrade to stronger model.  |
| `SUCCESS_RATE_KEEP_THRESHOLD`    | 0.9    | Above this, downgrade test passes.      |
| `DOWNGRADE_TEST_INTERVAL`        | 500    | Schedule tests every N total calls.     |
| `DOWNGRADE_TEST_SAMPLE_SIZE`     | 10     | Calls needed to evaluate a test.        |

### Audit Trail

All optimization decisions are logged to `routing_optimizations`:

```sql
SELECT * FROM routing_optimizations ORDER BY timestamp DESC LIMIT 10;
```

Each entry records: tool name, old/new provider and model, reason, success rates, and cost savings.

---

## RouteDecision

The `route()` method returns a `RouteDecision` object:

```typescript
interface RouteDecision {
  provider: LLMProvider
  model: string
  reason: 'default' | 'optimized' | 'fallback' | 'downgrade_test' | 'no_providers_available'
}
```

| Reason                   | Meaning                                                  |
|--------------------------|----------------------------------------------------------|
| `default`                | Matched a default routing table entry.                   |
| `optimized`              | Using a learned override (from self-learning).           |
| `fallback`               | No matching rule. Using global fallback (sonnet).        |
| `downgrade_test`         | Temporarily routing to a cheaper model for A/B testing.  |
| `no_providers_available` | No providers have credentials. Cannot route.             |
