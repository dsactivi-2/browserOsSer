import type { Database } from 'bun:sqlite'
import { createMiddleware } from 'hono/factory'

export type Role = 'admin' | 'user' | 'viewer'

const ROLE_HIERARCHY: Record<Role, number> = {
  admin: 3,
  user: 2,
  viewer: 1,
}

export function createRoleGuard(minimumRole: Role) {
  return createMiddleware(async (c, next) => {
    const role = c.get('role') as Role | undefined

    if (!role) {
      return c.json({ error: 'No role assigned' }, 403)
    }

    if ((ROLE_HIERARCHY[role] ?? 0) < ROLE_HIERARCHY[minimumRole]) {
      return c.json(
        { error: `Insufficient permissions. Required: ${minimumRole}` },
        403,
      )
    }

    return next()
  })
}

export function roleFromApiKey(apiKey: string, db: Database): Role | null {
  // Strip 'bos_' prefix and take first 12 chars as key_prefix
  const stripped = apiKey.startsWith('bos_') ? apiKey.slice(4) : apiKey
  const prefix = stripped.slice(0, 12)

  const row = db
    .prepare('SELECT role FROM api_keys WHERE key_prefix = ? AND revoked = 0')
    .get(prefix) as { role: string } | null

  if (!row) return null

  const role = row.role as Role
  if (!(role in ROLE_HIERARCHY)) return null

  return role
}
