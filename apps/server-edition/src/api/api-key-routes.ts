import { Hono } from 'hono'
import type { ApiKeyStore } from '../auth/api-key-store'

const VALID_ROLES = new Set(['admin', 'user', 'viewer'])

export interface ApiKeyRoutesDeps {
  apiKeyStore: ApiKeyStore
}

export function createApiKeyRoutes(deps: ApiKeyRoutesDeps) {
  const { apiKeyStore } = deps
  const app = new Hono()

  // POST / — Create a new API key
  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const body = raw as Record<string, unknown>

    if (
      !body.name ||
      typeof body.name !== 'string' ||
      body.name.trim() === ''
    ) {
      return c.json({ error: 'name is required' }, 400)
    }

    if (!body.role || !VALID_ROLES.has(body.role as string)) {
      return c.json({ error: 'role must be one of: admin, user, viewer' }, 400)
    }

    if (body.expiresAt !== undefined && typeof body.expiresAt !== 'string') {
      return c.json({ error: 'expiresAt must be an ISO 8601 string' }, 400)
    }

    const { key, id } = await apiKeyStore.create(
      body.name.trim(),
      body.role as 'admin' | 'user' | 'viewer',
      body.expiresAt as string | undefined,
    )

    return c.json({ id, key }, 201)
  })

  // GET / — List all API keys
  app.get('/', (c) => {
    const keys = apiKeyStore.list()
    return c.json({ keys })
  })

  // DELETE /:id — Revoke an API key
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    const revoked = apiKeyStore.revoke(id)

    if (!revoked) {
      return c.json({ error: 'API key not found or already revoked' }, 404)
    }

    return c.json({ id, revoked: true })
  })

  // DELETE /:id/permanent — Permanently delete an API key
  app.delete('/:id/permanent', (c) => {
    const id = c.req.param('id')
    const deleted = apiKeyStore.delete(id)

    if (!deleted) {
      return c.json({ error: 'API key not found' }, 404)
    }

    return c.json({ id, deleted: true })
  })

  return app
}
