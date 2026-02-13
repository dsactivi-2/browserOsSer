import { Hono } from 'hono'

export interface HealthRoutesDeps {
  getUptime: () => number
  getVersion: () => string
  checks: Array<{ name: string; check: () => Promise<boolean> }>
}

export function createHealthRoutes(deps: HealthRoutesDeps) {
  const app = new Hono()

  // GET /health — Basic health check
  app.get('/', async (c) => {
    const results: Record<string, boolean> = {}
    let healthy = true

    for (const { name, check } of deps.checks) {
      try {
        results[name] = await check()
      } catch {
        results[name] = false
      }
      if (!results[name]) healthy = false
    }

    return c.json(
      {
        status: healthy ? 'healthy' : 'degraded',
        uptime: deps.getUptime(),
        version: deps.getVersion(),
        checks: results,
        timestamp: new Date().toISOString(),
      },
      healthy ? 200 : 503,
    )
  })

  // GET /health/ready — Readiness check
  app.get('/ready', (c) => c.json({ ready: true }))

  // GET /health/live — Liveness check
  app.get('/live', (c) => c.json({ live: true }))

  return app
}
