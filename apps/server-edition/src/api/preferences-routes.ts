import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'

export interface PreferencesRoutesDeps {
  db: Database
}

export function createPreferencesRoutes(deps: PreferencesRoutesDeps) {
  const { db } = deps
  const app = new Hono()

  const getKeyPrefix = (c: any) => {
    return c.req.header('X-API-Key')?.slice(0, 12) ?? 'default'
  }

  const initTable = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        key_prefix TEXT NOT NULL,
        preference_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key_prefix, preference_key)
      );
    `)
  }

  initTable()

  app.get('/', (c) => {
    const keyPrefix = getKeyPrefix(c)

    const rows = db
      .prepare(
        'SELECT preference_key, value FROM user_preferences WHERE key_prefix = ?',
      )
      .all(keyPrefix) as Array<{ preference_key: string; value: string }>

    const preferences: Record<string, any> = {}
    for (const row of rows) {
      try {
        preferences[row.preference_key] = JSON.parse(row.value)
      } catch {
        preferences[row.preference_key] = row.value
      }
    }

    return c.json(preferences)
  })

  app.put('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const body = raw as Record<string, unknown>
    const keyPrefix = getKeyPrefix(c)
    const now = new Date().toISOString()

    const allowedKeys = new Set(['theme', 'pageSize', 'timezone'])
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO user_preferences (key_prefix, preference_key, value, updated_at) VALUES (?, ?, ?, ?)',
    )

    for (const [key, value] of Object.entries(body)) {
      if (!allowedKeys.has(key)) {
        return c.json({ error: `Unknown preference key: ${key}` }, 400)
      }

      if (key === 'theme' && !['dark', 'light'].includes(value as string)) {
        return c.json({ error: 'theme must be "dark" or "light"' }, 400)
      }

      if (
        key === 'pageSize' &&
        (typeof value !== 'number' || value < 1 || value > 1000)
      ) {
        return c.json(
          { error: 'pageSize must be a number between 1 and 1000' },
          400,
        )
      }

      if (key === 'timezone' && typeof value !== 'string') {
        return c.json({ error: 'timezone must be a string' }, 400)
      }

      const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
      stmt.run(keyPrefix, key, valueStr, now)
    }

    return c.json({ success: true })
  })

  app.get('/:key', (c) => {
    const key = c.req.param('key')
    const keyPrefix = getKeyPrefix(c)

    const row = db
      .prepare(
        'SELECT value FROM user_preferences WHERE key_prefix = ? AND preference_key = ?',
      )
      .get(keyPrefix, key) as { value: string } | undefined

    if (!row) {
      return c.json({ error: 'Preference not found' }, 404)
    }

    try {
      return c.json({ value: JSON.parse(row.value) })
    } catch {
      return c.json({ value: row.value })
    }
  })

  app.delete('/:key', (c) => {
    const key = c.req.param('key')
    const keyPrefix = getKeyPrefix(c)

    const stmt = db.prepare(
      'DELETE FROM user_preferences WHERE key_prefix = ? AND preference_key = ?',
    )
    const info = stmt.run(keyPrefix, key)

    if (info.changes === 0) {
      return c.json({ error: 'Preference not found' }, 404)
    }

    return c.json({ success: true })
  })

  return app
}
