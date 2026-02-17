import type { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { Hono } from 'hono'

export interface AdminRoutesDeps {
  db: Database
  getUptime: () => number
  dbPath: string
}

function getDbFileSize(dbPath: string): number {
  try {
    return statSync(dbPath).size
  } catch {
    return 0
  }
}

function getWalFileSize(dbPath: string): number {
  try {
    return statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

export function createAdminRoutes(deps: AdminRoutesDeps) {
  const { db, getUptime, dbPath } = deps
  const app = new Hono()

  app.get('/system', (c) => {
    const mem = process.memoryUsage()
    const dbSize = getDbFileSize(dbPath)

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]

    const tableCounts: Record<string, number> = {}
    for (const { name } of tables) {
      const row = db
        .prepare(`SELECT COUNT(*) as count FROM "${name}"`)
        .get() as { count: number }
      tableCounts[name] = row.count
    }

    return c.json({
      uptime: getUptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      database: {
        sizeBytes: dbSize,
        tableCount: tables.length,
        tables: tableCounts,
      },
    })
  })

  app.post('/system/cleanup', async (c) => {
    let body: { olderThanDays?: number } = {}
    try {
      body = await c.req.json()
    } catch {
      // use defaults
    }

    const days =
      typeof body.olderThanDays === 'number' ? body.olderThanDays : 30
    if (days < 1) {
      return c.json({ error: 'olderThanDays must be at least 1' }, 400)
    }

    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString()

    const auditResult = db
      .prepare('DELETE FROM audit_logs WHERE created_at < ?')
      .run(cutoff)

    const metricsResult = db
      .prepare('DELETE FROM router_metrics WHERE timestamp < ?')
      .run(cutoff)

    const notifResult = db
      .prepare('DELETE FROM notification_logs WHERE created_at < ?')
      .run(cutoff)

    return c.json({
      deleted: {
        auditLogs: auditResult.changes,
        routerMetrics: metricsResult.changes,
        notificationLogs: notifResult.changes,
      },
      olderThanDays: days,
      cutoff,
    })
  })

  app.get('/system/db-stats', (c) => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]

    const tableCounts: Record<string, number> = {}
    for (const { name } of tables) {
      const row = db
        .prepare(`SELECT COUNT(*) as count FROM "${name}"`)
        .get() as { count: number }
      tableCounts[name] = row.count
    }

    return c.json({
      tables: tableCounts,
      tableCount: tables.length,
      dbSizeBytes: getDbFileSize(dbPath),
      walSizeBytes: getWalFileSize(dbPath),
    })
  })

  app.post('/system/vacuum', (c) => {
    db.exec('VACUUM')
    return c.json({
      ok: true,
      dbSizeBytes: getDbFileSize(dbPath),
    })
  })

  return app
}
