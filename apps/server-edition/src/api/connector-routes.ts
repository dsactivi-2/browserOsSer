import { Hono } from 'hono'
import type { ConnectorManager } from '../connectors/connector-manager'

export interface ConnectorRoutesDeps {
  connectorManager: ConnectorManager
}

export function createConnectorRoutes(deps: ConnectorRoutesDeps) {
  const { connectorManager } = deps
  const app = new Hono()

  app.get('/', (c) => c.json(connectorManager.listConnectors()))

  app.post('/', async (c) => {
    const { type, name, config } = await c.req.json()
    try {
      const id = await connectorManager.addConnector(type, name, config ?? {})
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
    const { enabled } = await c.req.json()
    connectorManager.setEnabled(id, enabled)
    return c.json({ id, enabled })
  })

  return app
}
