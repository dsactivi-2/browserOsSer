import { Hono } from 'hono'

export interface MetricsRoutesDeps {
  db: import('bun:sqlite').Database
  getUptime: () => number
}

export function createMetricsRoutes(deps: MetricsRoutesDeps) {
  const { db, getUptime } = deps
  const app = new Hono()

  app.get('/', (c) => {
    const stateRows = db
      .prepare('SELECT state, COUNT(*) as count FROM tasks GROUP BY state')
      .all() as { state: string; count: number }[]

    const taskStats: Record<string, number> = { total: 0 }
    for (const row of stateRows) {
      taskStats[row.state] = row.count
      taskStats.total += row.count
    }
    const completed = taskStats.completed ?? 0
    const completionRate = taskStats.total > 0 ? completed / taskStats.total : 0

    const routerRow = db
      .prepare(
        'SELECT COUNT(*) as total_calls, AVG(latency_ms) as avg_latency, SUM(estimated_cost) as total_cost FROM router_metrics',
      )
      .get() as {
      total_calls: number
      avg_latency: number | null
      total_cost: number | null
    } | null

    const mem = process.memoryUsage()

    return c.json({
      tasks: {
        ...taskStats,
        completionRate,
      },
      router: {
        totalLlmCalls: routerRow?.total_calls ?? 0,
        avgLatencyMs:
          routerRow?.avg_latency != null
            ? Math.round(routerRow.avg_latency)
            : null,
        totalCost: routerRow?.total_cost ?? 0,
      },
      system: {
        uptimeSeconds: getUptime(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
      },
    })
  })

  app.get('/tasks', (c) => {
    const since = c.req.query('since')

    const sinceCondition = since ? 'WHERE t.created_at >= ?' : ''
    const params: unknown[] = since ? [since] : []

    const stateRows = db
      .prepare(
        `SELECT state, COUNT(*) as count FROM tasks t ${sinceCondition} GROUP BY state`,
      )
      .all(...(params as string[])) as { state: string; count: number }[]

    const priorityRows = db
      .prepare(`
        SELECT
          t.priority,
          COUNT(*) as total,
          SUM(CASE WHEN t.state = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN t.state = 'failed' THEN 1 ELSE 0 END) as failed,
          AVG(tr.execution_time_ms) as avg_execution_time_ms
        FROM tasks t
        LEFT JOIN task_results tr ON t.id = tr.task_id
        ${sinceCondition}
        GROUP BY t.priority
      `)
      .all(...(params as string[])) as {
      priority: string
      total: number
      completed: number
      failed: number
      avg_execution_time_ms: number | null
    }[]

    return c.json({
      byState: stateRows.map((r) => ({ state: r.state, count: r.count })),
      byPriority: priorityRows.map((r) => ({
        priority: r.priority,
        total: r.total,
        completed: r.completed,
        failed: r.failed,
        successRate: r.total > 0 ? r.completed / r.total : 0,
        avgExecutionTimeMs:
          r.avg_execution_time_ms != null
            ? Math.round(r.avg_execution_time_ms)
            : null,
      })),
      since: since ?? null,
    })
  })

  app.get('/router', (c) => {
    const since = c.req.query('since')
    const tool = c.req.query('tool')

    const conditions: string[] = []
    const params: unknown[] = []

    if (since) {
      conditions.push('timestamp >= ?')
      params.push(since)
    }
    if (tool) {
      conditions.push('tool_name = ?')
      params.push(tool)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db
      .prepare(`
        SELECT
          provider,
          model,
          COUNT(*) as total_calls,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
          CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as success_rate,
          AVG(latency_ms) as avg_latency_ms,
          SUM(estimated_cost) as total_cost
        FROM router_metrics
        ${where}
        GROUP BY provider, model
        ORDER BY total_calls DESC
      `)
      .all(...(params as string[])) as {
      provider: string
      model: string
      total_calls: number
      success_count: number
      success_rate: number
      avg_latency_ms: number
      total_cost: number
    }[]

    return c.json({
      metrics: rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        totalCalls: r.total_calls,
        successCount: r.success_count,
        successRate: r.success_rate,
        avgLatencyMs: Math.round(r.avg_latency_ms),
        totalCost: r.total_cost,
      })),
      filters: { since: since ?? null, tool: tool ?? null },
    })
  })

  app.get('/timeline', (c) => {
    const taskEvents = db
      .prepare(`
        SELECT
          'task' as type,
          t.id,
          t.state as action,
          t.updated_at as timestamp,
          t.priority,
          t.instruction
        FROM tasks t
        ORDER BY t.updated_at DESC
        LIMIT 100
      `)
      .all() as {
      type: string
      id: string
      action: string
      timestamp: string
      priority: string
      instruction: string
    }[]

    const routerEvents = db
      .prepare(`
        SELECT
          'router' as type,
          CAST(id AS TEXT) as id,
          tool_name as action,
          timestamp,
          provider,
          model,
          success,
          latency_ms
        FROM router_metrics
        ORDER BY timestamp DESC
        LIMIT 100
      `)
      .all() as {
      type: string
      id: string
      action: string
      timestamp: string
      provider: string
      model: string
      success: number
      latency_ms: number
    }[]

    const timeline = [
      ...taskEvents.map((e) => ({
        type: e.type,
        id: e.id,
        action: e.action,
        timestamp: e.timestamp,
        details: { priority: e.priority, instruction: e.instruction },
      })),
      ...routerEvents.map((e) => ({
        type: e.type,
        id: e.id,
        action: e.action,
        timestamp: e.timestamp,
        details: {
          provider: e.provider,
          model: e.model,
          success: e.success === 1,
          latencyMs: e.latency_ms,
        },
      })),
    ]
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 100)

    return c.json({ events: timeline, count: timeline.length })
  })

  return app
}
