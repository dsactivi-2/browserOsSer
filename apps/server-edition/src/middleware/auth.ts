import { timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'

export interface AuthConfig {
  apiKeys: string[]
  excludePaths: string[]
}

function timingSafeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length)
  const bufA = Buffer.alloc(maxLen)
  const bufB = Buffer.alloc(maxLen)
  bufA.write(a)
  bufB.write(b)
  return a.length === b.length && timingSafeEqual(bufA, bufB)
}

export function createAuthMiddleware(config: AuthConfig) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path
    if (config.excludePaths.some((p) => path.startsWith(p))) {
      return next()
    }

    const apiKey =
      c.req.header('X-API-Key') ??
      c.req.header('Authorization')?.replace('Bearer ', '')

    if (!apiKey || !config.apiKeys.some((k) => timingSafeCompare(k, apiKey))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    return next()
  })
}
