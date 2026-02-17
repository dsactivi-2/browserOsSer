import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'

export interface TimelineRoutesDeps {
  db: Database
}

export interface TimelineEvent {
  id: string
  type: 'task' | 'router' | 'connector' | 'system'
  action: string
  summary: string
  details?: Record<string, unknown>
  timestamp: string
}

interface TaskRow {
  id: string
  state: string
  instruction: string
  updated_at: string
}

interface RouterMetricRow {
  id: number
  tool_name: string
  provider: string
  model: string
  success: number
  latency_ms: number
  estimated_cost: number
  timestamp: string
}

interface TaskStepRow {
  id: number
  task_id: string
  tool: string
  duration_ms: number | null
  timestamp: string
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw ? parseInt(raw, 10) : 50
  if (Number.isNaN(parsed) || parsed < 1) return 50
  return Math.min(parsed, 200)
}

function queryTaskEvents(
  db: Database,
  since: string | undefined,
  limit: number,
): TimelineEvent[] {
  const conditions: string[] = []
  const params: string[] = []

  if (since) {
    conditions.push('updated_at >= ?')
    params.push(since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT id, state, instruction, updated_at FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...(params as string[]), limit) as TaskRow[]

  return rows.map((row) => ({
    id: row.id,
    type: 'task' as const,
    action: row.state,
    summary: row.instruction.slice(0, 100),
    timestamp: row.updated_at,
  }))
}

function queryRouterEvents(
  db: Database,
  since: string | undefined,
  limit: number,
): TimelineEvent[] {
  const conditions: string[] = []
  const params: string[] = []

  if (since) {
    conditions.push('timestamp >= ?')
    params.push(since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT id, tool_name, provider, model, success, latency_ms, estimated_cost, timestamp FROM router_metrics ${where} ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...(params as string[]), limit) as RouterMetricRow[]

  return rows.map((row) => ({
    id: `rm-${row.id}`,
    type: 'router' as const,
    action: row.success === 1 ? 'success' : 'error',
    summary: `${row.tool_name} via ${row.provider}`,
    details: {
      model: row.model,
      latencyMs: row.latency_ms,
      cost: row.estimated_cost,
    },
    timestamp: row.timestamp,
  }))
}

function queryStepEvents(
  db: Database,
  since: string | undefined,
  limit: number,
): TimelineEvent[] {
  const conditions: string[] = []
  const params: string[] = []

  if (since) {
    conditions.push('timestamp >= ?')
    params.push(since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT id, task_id, tool, duration_ms, timestamp FROM task_steps ${where} ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...(params as string[]), limit) as TaskStepRow[]

  return rows.map((row) => ({
    id: `step-${row.id}`,
    type: 'task' as const,
    action: 'step',
    summary: `${row.tool} (task ${row.task_id})`,
    details: { taskId: row.task_id, durationMs: row.duration_ms },
    timestamp: row.timestamp,
  }))
}

function mergeAndSort(
  events: TimelineEvent[][],
  limit: number,
): TimelineEvent[] {
  return events
    .flat()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, limit)
}

function formatSSEMessage(event: TimelineEvent, lastTimestamp: string): string {
  return `event: timeline\nid: ${lastTimestamp}\ndata: ${JSON.stringify(event)}\n\n`
}

export function createTimelineRoutes(deps: TimelineRoutesDeps) {
  const { db } = deps
  const app = new Hono()

  app.get('/', (c) => {
    const limit = clampLimit(c.req.query('limit'))
    const since = c.req.query('since')
    const typeFilter = c.req.query('type')

    let events: TimelineEvent[]

    if (typeFilter === 'task') {
      const taskEvents = queryTaskEvents(db, since, limit)
      const stepEvents = queryStepEvents(db, since, limit)
      events = mergeAndSort([taskEvents, stepEvents], limit)
    } else if (typeFilter === 'router') {
      events = queryRouterEvents(db, since, limit)
    } else {
      const taskEvents = queryTaskEvents(db, since, limit)
      const routerEvents = queryRouterEvents(db, since, limit)
      const stepEvents = queryStepEvents(db, since, limit)
      events = mergeAndSort([taskEvents, routerEvents, stepEvents], limit)
    }

    return c.json({ events, count: events.length })
  })

  app.get('/stream', (c) => {
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')

    let lastTimestamp = new Date().toISOString()
    let intervalId: ReturnType<typeof setInterval> | null = null
    let closed = false

    const stream = new ReadableStream({
      start(controller) {
        const ping = `: ping\n\n`
        controller.enqueue(new TextEncoder().encode(ping))

        intervalId = setInterval(() => {
          if (closed) return

          try {
            const taskEvents = queryTaskEvents(db, lastTimestamp, 50)
            const routerEvents = queryRouterEvents(db, lastTimestamp, 50)
            const newEvents = mergeAndSort([taskEvents, routerEvents], 50)

            for (const event of newEvents) {
              if (event.timestamp > lastTimestamp) {
                lastTimestamp = event.timestamp
              }
              const message = formatSSEMessage(event, lastTimestamp)
              controller.enqueue(new TextEncoder().encode(message))
            }
          } catch {
            // DB error — skip this tick
          }
        }, 2000)
      },
      cancel() {
        closed = true
        if (intervalId !== null) {
          clearInterval(intervalId)
          intervalId = null
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  app.get('/stats', (c) => {
    const now = new Date()
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const weekAgo = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString()

    const taskCountsRaw = db
      .prepare(
        `SELECT
          SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) as last_hour,
          SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) as last_day,
          SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) as last_week
        FROM tasks`,
      )
      .get(hourAgo, dayAgo, weekAgo) as {
      last_hour: number
      last_day: number
      last_week: number
    } | null

    const routerCountsRaw = db
      .prepare(
        `SELECT
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_hour,
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_day,
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_week
        FROM router_metrics`,
      )
      .get(hourAgo, dayAgo, weekAgo) as {
      last_hour: number
      last_day: number
      last_week: number
    } | null

    const stepCountsRaw = db
      .prepare(
        `SELECT
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_hour,
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_day,
          SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as last_week
        FROM task_steps`,
      )
      .get(hourAgo, dayAgo, weekAgo) as {
      last_hour: number
      last_day: number
      last_week: number
    } | null

    return c.json({
      byType: {
        task: {
          lastHour: taskCountsRaw?.last_hour ?? 0,
          lastDay: taskCountsRaw?.last_day ?? 0,
          lastWeek: taskCountsRaw?.last_week ?? 0,
        },
        router: {
          lastHour: routerCountsRaw?.last_hour ?? 0,
          lastDay: routerCountsRaw?.last_day ?? 0,
          lastWeek: routerCountsRaw?.last_week ?? 0,
        },
        step: {
          lastHour: stepCountsRaw?.last_hour ?? 0,
          lastDay: stepCountsRaw?.last_day ?? 0,
          lastWeek: stepCountsRaw?.last_week ?? 0,
        },
      },
      generatedAt: now.toISOString(),
    })
  })

  return app
}
