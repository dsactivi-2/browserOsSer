import { Hono } from 'hono'
import type { AuditStore } from '../audit/audit-store'

export interface AuditRoutesDeps {
  auditStore: AuditStore
}

export function createAuditRoutes(deps: AuditRoutesDeps) {
  const { auditStore } = deps
  const app = new Hono()

  app.get('/', (c) => {
    const q = c.req.query()

    const limit = q.limit ? parseInt(q.limit, 10) : 50
    const offset = q.offset ? parseInt(q.offset, 10) : 0

    if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
      return c.json({ error: 'limit must be a number between 1 and 1000' }, 400)
    }
    if (Number.isNaN(offset) || offset < 0) {
      return c.json({ error: 'offset must be a non-negative number' }, 400)
    }

    const result = auditStore.query({
      action: q.action,
      actor: q.actor,
      resource: q.resource,
      since: q.since,
      until: q.until,
      limit,
      offset,
    })

    return c.json(result)
  })

  app.get('/stats', (c) => {
    const { since } = c.req.query()
    const stats = auditStore.getStats(since)
    return c.json(stats)
  })

  return app
}
