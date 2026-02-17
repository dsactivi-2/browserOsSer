import type { Database } from 'bun:sqlite'

export type NotificationChannel = 'slack' | 'discord' | 'webhook' | 'email'
export type NotificationEvent =
  | 'task.failed'
  | 'task.completed'
  | 'task.timeout'
  | 'system.error'
  | 'system.degraded'
  | 'security.auth_failed'
  | 'security.rate_limit'

export interface NotificationTarget {
  id: string
  name: string
  channel: NotificationChannel
  url: string
  events: NotificationEvent[]
  enabled: boolean
  createdAt: string
}

export interface NotificationLog {
  id: string
  targetId: string
  event: NotificationEvent
  payload: Record<string, unknown>
  success: boolean
  responseStatus?: number
  error?: string
  timestamp: string
}

function buildSlackPayload(
  event: NotificationEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    text: `*${event}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Event:* ${event}\n*Timestamp:* ${new Date().toISOString()}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`${JSON.stringify(payload, null, 2)}\`\`\``,
        },
      },
    ],
  }
}

function buildDiscordPayload(
  event: NotificationEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    embeds: [
      {
        title: event,
        description: JSON.stringify(payload, null, 2),
        timestamp: new Date().toISOString(),
        color: event.startsWith('security')
          ? 0xff0000
          : event.startsWith('system')
            ? 0xffa500
            : 0x0099ff,
      },
    ],
  }
}

function buildEmailPayload(
  event: NotificationEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    subject: `Notification: ${event}`,
    body: JSON.stringify(payload, null, 2),
  }
}

function buildPayload(
  channel: NotificationChannel,
  event: NotificationEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (channel) {
    case 'slack':
      return buildSlackPayload(event, payload)
    case 'discord':
      return buildDiscordPayload(event, payload)
    case 'email':
      return buildEmailPayload(event, payload)
    case 'webhook':
      return { event, payload, timestamp: new Date().toISOString() }
  }
}

export class NotificationManager {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_logs (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        success INTEGER NOT NULL,
        response_status INTEGER,
        error TEXT,
        timestamp TEXT NOT NULL
      )
    `)
  }

  addTarget(target: Omit<NotificationTarget, 'id' | 'createdAt'>): string {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO notification_targets (id, name, channel, url, events, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      target.name,
      target.channel,
      target.url,
      JSON.stringify(target.events),
      target.enabled ? 1 : 0,
      createdAt,
    )
    return id
  }

  removeTarget(id: string): boolean {
    const stmt = this.db.prepare(
      'DELETE FROM notification_targets WHERE id = ?',
    )
    const result = stmt.run(id)
    return result.changes > 0
  }

  listTargets(): NotificationTarget[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_targets')
      .all() as Array<{
      id: string
      name: string
      channel: string
      url: string
      events: string
      enabled: number
      created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      channel: row.channel as NotificationChannel,
      url: row.url,
      events: JSON.parse(row.events) as NotificationEvent[],
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    }))
  }

  toggleTarget(id: string, enabled: boolean): void {
    const stmt = this.db.prepare(
      'UPDATE notification_targets SET enabled = ? WHERE id = ?',
    )
    stmt.run(enabled ? 1 : 0, id)
  }

  async notify(
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const targets = this.listTargets().filter(
      (t) => t.enabled && t.events.includes(event),
    )

    await Promise.all(
      targets.map(async (target) => {
        const logId = crypto.randomUUID()
        const timestamp = new Date().toISOString()
        const body = buildPayload(target.channel, event, payload)

        let success = false
        let responseStatus: number | undefined
        let error: string | undefined

        try {
          const response = await fetch(target.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          responseStatus = response.status
          success = response.ok
          if (!response.ok) {
            error = `HTTP ${response.status}: ${response.statusText}`
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }

        const stmt = this.db.prepare(`
          INSERT INTO notification_logs (id, target_id, event, payload, success, response_status, error, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
          logId,
          target.id,
          event,
          JSON.stringify(payload),
          success ? 1 : 0,
          responseStatus ?? null,
          error ?? null,
          timestamp,
        )
      }),
    )
  }

  getLog(limit = 100, targetId?: string): NotificationLog[] {
    let rows: Array<{
      id: string
      target_id: string
      event: string
      payload: string
      success: number
      response_status: number | null
      error: string | null
      timestamp: string
    }>

    if (targetId) {
      const stmt = this.db.prepare(
        'SELECT * FROM notification_logs WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      rows = stmt.all(targetId, limit) as typeof rows
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM notification_logs ORDER BY timestamp DESC LIMIT ?',
      )
      rows = stmt.all(limit) as typeof rows
    }

    return rows.map((row) => ({
      id: row.id,
      targetId: row.target_id,
      event: row.event as NotificationEvent,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      success: row.success === 1,
      responseStatus: row.response_status ?? undefined,
      error: row.error ?? undefined,
      timestamp: row.timestamp,
    }))
  }
}
