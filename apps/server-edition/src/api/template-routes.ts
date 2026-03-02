import { Hono } from 'hono'
import type { TaskTemplateStore } from '../task-queue/task-template-store'

export interface TemplateRoutesDeps {
  templateStore: TaskTemplateStore
}

export function createTemplateRoutes(deps: TemplateRoutesDeps) {
  const { templateStore } = deps
  const app = new Hono()

  // GET /templates — List all templates
  app.get('/', (c) => {
    const templates = templateStore.list()
    return c.json({ templates, total: templates.length })
  })

  // POST /templates — Create a template
  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const data = body as Record<string, unknown>

    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      return c.json({ error: 'name is required' }, 400)
    }
    if (
      !data.instruction ||
      typeof data.instruction !== 'string' ||
      !data.instruction.trim()
    ) {
      return c.json({ error: 'instruction is required' }, 400)
    }

    const id = templateStore.create({
      name: data.name,
      description: typeof data.description === 'string' ? data.description : '',
      instruction: data.instruction,
      priority: (['low', 'normal', 'high', 'critical'] as const).includes(
        data.priority as any,
      )
        ? (data.priority as 'low' | 'normal' | 'high' | 'critical')
        : 'normal',
      parameters: Array.isArray(data.parameters)
        ? (data.parameters as any)
        : [],
      timeout: data.timeout !== undefined ? Number(data.timeout) : undefined,
      retryPolicy: data.retryPolicy ? (data.retryPolicy as any) : undefined,
      llmConfig: data.llmConfig ? (data.llmConfig as any) : undefined,
      metadata: data.metadata
        ? (data.metadata as Record<string, unknown>)
        : undefined,
    })

    const template = templateStore.get(id)
    return c.json(template, 201)
  })

  // GET /templates/:id — Get single template
  app.get('/:id', (c) => {
    const id = c.req.param('id')
    const template = templateStore.get(id)
    if (!template) return c.json({ error: 'Template not found' }, 404)
    return c.json(template)
  })

  // PUT /templates/:id — Update template
  app.put('/:id', async (c) => {
    const id = c.req.param('id')

    const existing = templateStore.get(id)
    if (!existing) return c.json({ error: 'Template not found' }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const data = body as Record<string, unknown>
    const updates: Parameters<typeof templateStore.update>[1] = {}

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || !data.name.trim()) {
        return c.json({ error: 'name must be a non-empty string' }, 400)
      }
      updates.name = data.name
    }
    if (data.description !== undefined) {
      updates.description = String(data.description)
    }
    if (data.instruction !== undefined) {
      if (typeof data.instruction !== 'string' || !data.instruction.trim()) {
        return c.json({ error: 'instruction must be a non-empty string' }, 400)
      }
      updates.instruction = data.instruction
    }
    if (data.priority !== undefined) {
      if (
        !(['low', 'normal', 'high', 'critical'] as const).includes(
          data.priority as any,
        )
      ) {
        return c.json(
          { error: 'priority must be low, normal, high, or critical' },
          400,
        )
      }
      updates.priority = data.priority as 'low' | 'normal' | 'high' | 'critical'
    }
    if (data.parameters !== undefined) {
      updates.parameters = Array.isArray(data.parameters)
        ? (data.parameters as any)
        : []
    }
    if ('timeout' in data) {
      updates.timeout = data.timeout !== null ? Number(data.timeout) : undefined
    }
    if ('retryPolicy' in data) {
      updates.retryPolicy = data.retryPolicy as any
    }
    if ('llmConfig' in data) {
      updates.llmConfig = data.llmConfig as any
    }
    if ('metadata' in data) {
      updates.metadata = data.metadata as any
    }

    templateStore.update(id, updates)
    const updated = templateStore.get(id)
    return c.json(updated)
  })

  // DELETE /templates/:id — Delete template
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    const deleted = templateStore.delete(id)
    if (!deleted) return c.json({ error: 'Template not found' }, 404)
    return c.json({ id, deleted: true })
  })

  // POST /templates/:id/instantiate — Create a task from template
  app.post('/:id/instantiate', async (c) => {
    const id = c.req.param('id')

    const existing = templateStore.get(id)
    if (!existing) return c.json({ error: 'Template not found' }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }

    const data = body as Record<string, unknown>
    const params =
      data.params &&
      typeof data.params === 'object' &&
      !Array.isArray(data.params)
        ? (data.params as Record<string, unknown>)
        : {}

    let task: object
    try {
      task = templateStore.instantiate(id, params)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Instantiation failed' },
        400,
      )
    }

    return c.json(task)
  })

  return app
}
