import { Hono } from 'hono'
import type { ConnectorType } from '../connectors/connector-interface'
import type { ConnectorManager } from '../connectors/connector-manager'

export interface ConnectorRoutesDeps {
  connectorManager: ConnectorManager
}

const VALID_CONNECTOR_TYPES: ConnectorType[] = ['rest', 'webhook']

export function createConnectorRoutes(deps: ConnectorRoutesDeps) {
  const { connectorManager } = deps
  const app = new Hono()

  app.get('/', (c) => c.json(connectorManager.listConnectors()))

  app.post('/', async (c) => {
    const body = await c.req.json()
    const { type, name, config } = body

    if (!type || typeof type !== 'string') {
      return c.json({ error: 'type is required and must be a string' }, 400)
    }
    if (!VALID_CONNECTOR_TYPES.includes(type as ConnectorType)) {
      return c.json(
        {
          error: `Invalid type. Must be one of: ${VALID_CONNECTOR_TYPES.join(', ')}`,
        },
        400,
      )
    }
    if (!name || typeof name !== 'string' || name.length > 100) {
      return c.json({ error: 'name is required (string, max 100 chars)' }, 400)
    }

    try {
      const id = await connectorManager.addConnector(
        type as ConnectorType,
        name,
        config ?? {},
      )
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
    const body = await c.req.json()
    const { enabled } = body

    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }

    connectorManager.setEnabled(id, enabled)
    return c.json({ id, enabled })
  })

  return app
}
