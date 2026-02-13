import { createMiddleware } from 'hono/factory'

export interface AuthConfig {
  apiKeys: string[]
  excludePaths: string[]
}

export function createAuthMiddleware(config: AuthConfig) {
  return createMiddleware(async (c, next) => {
    // Skip auth for excluded paths (health check, etc.)
    const path = c.req.path
    if (config.excludePaths.some((p) => path.startsWith(p))) {
      return next()
    }

    const apiKey =
      c.req.header('X-API-Key') ??
      c.req.header('Authorization')?.replace('Bearer ', '')

    if (!apiKey || !config.apiKeys.includes(apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    return next()
  })
}
