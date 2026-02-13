import { Hono } from 'hono'
import type { BrowserPool } from '../browser-runtime/browser-pool'

export interface BrowserRoutesDeps {
  browserPool: BrowserPool
}

export function createBrowserRoutes(deps: BrowserRoutesDeps) {
  const { browserPool } = deps
  const app = new Hono()

  // GET / — List browser instances
  app.get('/', (c) =>
    c.json({ instances: browserPool.getStatus(), total: browserPool.size }),
  )

  // POST / — Create new instance
  app.post('/', async (c) => {
    try {
      const id = await browserPool.createInstance()
      return c.json({ id, status: 'ready' }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return c.json({ error: message }, 400)
    }
  })

  // DELETE /:id — Destroy instance
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const destroyed = await browserPool.destroyInstance(id)
    if (!destroyed) return c.json({ error: 'Instance not found' }, 404)
    return c.json({ id, destroyed: true })
  })

  return app
}
