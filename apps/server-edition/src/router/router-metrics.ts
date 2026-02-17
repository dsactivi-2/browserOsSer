import type { Database } from 'bun:sqlite'
import type { LLMProvider } from '@browseros/shared/schemas/llm'
import type { AggregatedMetrics, RouterMetricEntry } from './types'

interface MetricsAggregatedRow {
  tool_name: string
  provider: string
  model: string
  total_calls: number
  success_count: number
  failure_count: number
  success_rate: number
  avg_latency_ms: number
  total_cost: number
  last_used: string
}

export class RouterMetrics {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
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
    `)
  }

  record(entry: RouterMetricEntry): void {
    this.db
      .prepare(`
      INSERT INTO router_metrics (tool_name, provider, model, success, latency_ms, estimated_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        entry.toolName,
        entry.provider,
        entry.model,
        entry.success ? 1 : 0,
        entry.latencyMs,
        entry.estimatedCost,
        entry.timestamp,
      )
  }

  getAggregated(toolName?: string, since?: string): AggregatedMetrics[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (toolName) {
      conditions.push('tool_name = ?')
      params.push(toolName)
    }
    if (since) {
      conditions.push('timestamp >= ?')
      params.push(since)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = this.db
      .prepare(`
      SELECT
        tool_name,
        provider,
        model,
        COUNT(*) as total_calls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
        CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as success_rate,
        AVG(latency_ms) as avg_latency_ms,
        SUM(estimated_cost) as total_cost,
        MAX(timestamp) as last_used
      FROM router_metrics
      ${where}
      GROUP BY tool_name, provider, model
      ORDER BY tool_name, success_rate DESC
    `)
      .all(...(params as string[])) as MetricsAggregatedRow[]

    return rows.map((row) => ({
      toolName: row.tool_name,
      provider: row.provider as LLMProvider,
      model: row.model,
      totalCalls: row.total_calls,
      successCount: row.success_count,
      failureCount: row.failure_count,
      successRate: row.success_rate,
      avgLatencyMs: Math.round(row.avg_latency_ms),
      totalCost: row.total_cost,
      lastUsed: row.last_used,
    }))
  }

  getTotalCalls(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM router_metrics')
      .get() as { count: number } | null
    return row?.count ?? 0
  }

  cleanup(olderThanDays: number = 30): number {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - olderThanDays)
    const result = this.db
      .prepare('DELETE FROM router_metrics WHERE timestamp < ?')
      .run(cutoff.toISOString())
    return result.changes
  }
}
