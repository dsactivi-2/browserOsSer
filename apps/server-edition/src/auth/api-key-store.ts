import type { Database } from 'bun:sqlite'

export interface ApiKey {
  id: string
  name: string
  keyHash: string
  keyPrefix: string
  role: 'admin' | 'user' | 'viewer'
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revoked: boolean
}

async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key)
  const buffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export class ApiKeyStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
      CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys(revoked);
    `)
  }

  async create(
    name: string,
    role: 'admin' | 'user' | 'viewer',
    expiresAt?: string,
  ): Promise<{ key: string; id: string }> {
    const id = crypto.randomUUID()
    const rawKey = `bos_${crypto.randomUUID().replace(/-/g, '')}`
    const keyPrefix = rawKey.slice(4, 12)
    const keyHash = await hashKey(rawKey)
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, role, created_at, last_used_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      )
      .run(id, name, keyHash, keyPrefix, role, now, expiresAt ?? null)

    return { key: rawKey, id }
  }

  async validate(key: string): Promise<ApiKey | null> {
    if (!key.startsWith('bos_')) return null

    const keyPrefix = key.slice(4, 12)
    const keyHash = await hashKey(key)

    const rows = this.db
      .prepare(`SELECT * FROM api_keys WHERE key_prefix = ? AND revoked = 0`)
      .all(keyPrefix) as any[]

    const row = rows.find((r) => r.key_hash === keyHash)
    if (!row) return null

    if (row.expires_at && new Date(row.expires_at) < new Date()) return null

    this.db
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id)

    return this.rowToApiKey({ ...row, last_used_at: new Date().toISOString() })
  }

  list(): Omit<ApiKey, 'keyHash'>[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`)
      .all() as any[]

    return rows.map((row) => {
      const { keyHash: _keyHash, ...rest } = this.rowToApiKey(row)
      return rest
    })
  }

  revoke(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0`)
      .run(id)
    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id)
    return result.changes > 0
  }

  private rowToApiKey(row: any): ApiKey {
    return {
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      role: row.role as ApiKey['role'],
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      expiresAt: row.expires_at ?? null,
      revoked: Boolean(row.revoked),
    }
  }
}
