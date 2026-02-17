import { Hono } from 'hono'
import type {
  NotificationChannel,
  NotificationEvent,
  NotificationManager,
} from '../notifications/notification-manager'

const VALID_CHANNELS: NotificationChannel[] = [
  'slack',
  'discord',
  'webhook',
  'email',
]
const VALID_EVENTS: NotificationEvent[] = [
  'task.failed',
  'task.completed',
  'task.timeout',
  'system.error',
  'system.degraded',
  'security.auth_failed',
  'security.rate_limit',
]

function validateUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function validateChannel(raw: unknown): raw is NotificationChannel {
  return typeof raw === 'string' && (VALID_CHANNELS as string[]).includes(raw)
}

function validateEvents(raw: unknown): raw is NotificationEvent[] {
  if (!Array.isArray(raw) || raw.length === 0) return false
  return raw.every(
    (e) => typeof e === 'string' && (VALID_EVENTS as string[]).includes(e),
  )
}

export function createNotificationRoutes(
  notificationManager: NotificationManager,
) {
  const app = new Hono()

  app.get('/targets', (c) => {
    const targets = notificationManager.listTargets()
    return c.json({ targets })
  })

  app.post('/targets', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Request body must be an object' }, 400)
    }

    const { name, channel, url, events, enabled } = body as Record<
      string,
      unknown
    >

    if (typeof name !== 'string' || name.trim() === '') {
      return c.json(
        { error: 'name is required and must be a non-empty string' },
        400,
      )
    }
    if (!validateChannel(channel)) {
      return c.json(
        { error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` },
        400,
      )
    }
    if (!validateUrl(url)) {
      return c.json({ error: 'url must be a valid http or https URL' }, 400)
    }
    if (!validateEvents(events)) {
      return c.json(
        {
          error: `events must be a non-empty array of valid event types: ${VALID_EVENTS.join(', ')}`,
        },
        400,
      )
    }

    const id = notificationManager.addTarget({
      name: name.trim(),
      channel,
      url,
      events,
      enabled: enabled !== false,
    })

    return c.json({ id }, 201)
  })

  app.delete('/targets/:id', (c) => {
    const id = c.req.param('id')
    const removed = notificationManager.removeTarget(id)
    if (!removed) {
      return c.json({ error: 'Notification target not found' }, 404)
    }
    return c.json({ id, removed: true })
  })

  app.post('/targets/:id/toggle', async (c) => {
    const id = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Request body must be an object' }, 400)
    }

    const { enabled } = body as Record<string, unknown>
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }

    const targets = notificationManager.listTargets()
    const target = targets.find((t) => t.id === id)
    if (!target) {
      return c.json({ error: 'Notification target not found' }, 404)
    }

    notificationManager.toggleTarget(id, enabled)
    return c.json({ id, enabled })
  })

  app.post('/targets/:id/test', async (c) => {
    const id = c.req.param('id')
    const targets = notificationManager.listTargets()
    const target = targets.find((t) => t.id === id)
    if (!target) {
      return c.json({ error: 'Notification target not found' }, 404)
    }

    await notificationManager.notify('system.degraded', {
      test: true,
      targetId: id,
      message: 'Test notification',
      timestamp: new Date().toISOString(),
    })

    return c.json({ id, sent: true })
  })

  app.get('/log', (c) => {
    const limitRaw = c.req.query('limit')
    const targetId = c.req.query('targetId') || undefined
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 50

    if (Number.isNaN(limit) || limit < 1) {
      return c.json({ error: 'limit must be a positive integer' }, 400)
    }

    const log = notificationManager.getLog(limit, targetId)
    return c.json({ log })
  })

  return app
}
