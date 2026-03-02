import { Hono } from 'hono'
import { z } from 'zod'
import type { ConnectorManager } from '../connectors/connector-manager'

const CreateConnectorSchema = z.object({
  type: z.enum(['rest', 'webhook']),
  name: z.string().min(1).max(100),
  config: z.record(z.unknown()).optional().default({}),
})

const ToggleConnectorSchema = z.object({
  enabled: z.boolean(),
})

export interface ConnectorRoutesDeps {
  connectorManager: ConnectorManager
}

export function createConnectorRoutes(deps: ConnectorRoutesDeps) {
  const { connectorManager } = deps
  const app = new Hono()

  app.get('/', (c) => c.json(connectorManager.listConnectors()))

  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const parsed = CreateConnectorSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0].message }, 400)
    }

    const { type, name, config } = parsed.data
    try {
      const id = await connectorManager.addConnector(type, name, config)
      return c.json({ id, type, name }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return c.json({ error: message }, 400)
    }
  })

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await connectorManager.removeConnector(id)
    if (!removed) return c.json({ error: 'Connector not found' }, 404)
    return c.json({ id, removed: true })
  })

  app.get('/:id/health', async (c) => {
    const id = c.req.param('id')
    const healthy = await connectorManager.getHealth(id)
    return c.json({ id, healthy })
  })

  app.post('/:id/toggle', async (c) => {
    const id = c.req.param('id')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const parsed = ToggleConnectorSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0].message }, 400)
    }

    connectorManager.setEnabled(id, parsed.data.enabled)
    return c.json({ id, enabled: parsed.data.enabled })
  })

  return app
}
