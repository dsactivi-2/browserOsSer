import type { Database } from 'bun:sqlite'

export type AuditAction =
  | 'task.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'router.call'
  | 'router.error'
  | 'auth.login'
  | 'auth.failed'
  | 'auth.key_created'
  | 'auth.key_revoked'
  | 'connector.created'
  | 'connector.deleted'
  | 'system.started'
  | 'system.stopped'
  | 'webhook.sent'
  | 'webhook.failed'

export interface AuditEntry {
  id: string
  action: AuditAction
  actor: string
  resource?: string
  details?: Record<string, unknown>
  ip?: string
  timestamp: string
}

export interface AuditQuery {
  action?: string
  actor?: string
  resource?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export class AuditStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        resource TEXT,
        details TEXT,
        ip TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource);
    `)
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (id, action, actor, resource, details, ip, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        crypto.randomUUID(),
        entry.action,
        entry.actor,
        entry.resource ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
        new Date().toISOString(),
      )
  }

  query(filters: AuditQuery): { entries: AuditEntry[]; total: number } {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.action) {
      conditions.push('action = ?')
      params.push(filters.action)
    }
    if (filters.actor) {
      conditions.push('actor = ?')
      params.push(filters.actor)
    }
    if (filters.resource) {
      conditions.push('resource = ?')
      params.push(filters.resource)
    }
    if (filters.since) {
      conditions.push('timestamp >= ?')
      params.push(filters.since)
    }
    if (filters.until) {
      conditions.push('timestamp <= ?')
      params.push(filters.until)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`)
      .get(...(params as string[])) as { count: number }

    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0
    const allParams = [...params, limit, offset]

    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      )
      .all(...(allParams as string[])) as any[]

    return {
      entries: rows.map((row) => this.rowToEntry(row)),
      total: countRow.count,
    }
  }

  getStats(since?: string): Record<AuditAction, number> {
    const where = since ? 'WHERE timestamp >= ?' : ''
    const params = since ? [since] : []

    const rows = this.db
      .prepare(
        `SELECT action, COUNT(*) as count FROM audit_log ${where} GROUP BY action`,
      )
      .all(...(params as string[])) as { action: string; count: number }[]

    const stats = {} as Record<AuditAction, number>
    for (const row of rows) {
      stats[row.action as AuditAction] = row.count
    }
    return stats
  }

  cleanup(olderThanDays: number): number {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    const result = this.db
      .prepare('DELETE FROM audit_log WHERE timestamp < ?')
      .run(cutoff)
    return result.changes
  }

  private rowToEntry(row: any): AuditEntry {
    return {
      id: row.id,
      action: row.action as AuditAction,
      actor: row.actor,
      resource: row.resource ?? undefined,
      details: safeJsonParse<Record<string, unknown> | undefined>(
        row.details,
        undefined,
      ),
      ip: row.ip ?? undefined,
      timestamp: row.timestamp,
    }
  }
}
