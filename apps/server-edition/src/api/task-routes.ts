/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  CreateBatchRequestSchema,
  CreateTaskRequestSchema,
  TaskListQuerySchema,
} from '@browseros/shared/schemas/task'
import { Hono } from 'hono'
import type { TaskScheduler } from '../task-queue/task-scheduler'
import type { TaskStore } from '../task-queue/task-store'

export interface TaskRoutesDeps {
  taskStore: TaskStore
  taskScheduler: TaskScheduler
}

export function createTaskRoutes(deps: TaskRoutesDeps) {
  const { taskStore, taskScheduler } = deps
  const app = new Hono()

  // POST /tasks — Submit a single task
  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const parsed = CreateTaskRequestSchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
    const body = parsed.data

    if (body.webhookUrl) {
      try {
        const parsedUrl = new URL(body.webhookUrl)
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          return c.json(
            { error: 'webhookUrl must use http or https protocol' },
            400,
          )
        }
      } catch {
        return c.json({ error: 'webhookUrl must be a valid URL' }, 400)
      }
    }

    const now = new Date().toISOString()
    const taskId = crypto.randomUUID()

    const task = {
      instruction: body.instruction,
      priority: body.priority ?? 'normal',
      dependsOn: body.dependsOn ?? [],
      retryPolicy: body.retryPolicy,
      timeout: body.timeout,
      webhookUrl: body.webhookUrl,
      metadata: body.metadata,
      llmConfig: body.llmConfig,
      id: taskId,
      state: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }

    taskStore.createTask(task)

    return c.json(
      {
        taskId,
        state: 'pending',
        createdAt: now,
      },
      201,
    )
  })

  // POST /tasks/batch — Submit a batch of tasks
  app.post('/batch', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400)
    }
    const parsed = CreateBatchRequestSchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
    const body = parsed.data

    if (body.webhookUrl) {
      try {
        const parsedUrl = new URL(body.webhookUrl)
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
          return c.json(
            { error: 'webhookUrl must use http or https protocol' },
            400,
          )
        }
      } catch {
        return c.json({ error: 'webhookUrl must be a valid URL' }, 400)
      }
    }

    const now = new Date().toISOString()
    const batchId = crypto.randomUUID()

    taskStore.createBatch(batchId, body.webhookUrl, body.parallelism)

    const taskIds: string[] = []
    for (const taskReq of body.tasks) {
      const taskId = crypto.randomUUID()
      taskIds.push(taskId)

      taskStore.createTask({
        ...taskReq,
        id: taskId,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
        batchId,
      })
    }

    return c.json(
      {
        batchId,
        taskIds,
        count: taskIds.length,
        createdAt: now,
      },
      201,
    )
  })

  // GET /tasks — List tasks with filters
  app.get('/', async (c) => {
    const rawQuery = c.req.query()
    const parsed = TaskListQuerySchema.safeParse(rawQuery)
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
    const query = parsed.data
    const tasks = taskStore.listTasks({
      state: query.state,
      priority: query.priority,
      batchId: query.batchId,
      limit: query.limit,
      offset: query.offset,
    })

    const stats = taskStore.getStats()

    return c.json({
      tasks: tasks.map((t) => ({
        taskId: t.id,
        instruction: t.instruction,
        priority: t.priority,
        state: t.state,
        batchId: t.batchId,
        retryCount: t.retryCount,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      total: stats.total,
      stats,
    })
  })

  // GET /tasks/stats — Queue statistics
  app.get('/stats', async (c) => {
    const stats = taskStore.getStats()
    return c.json(stats)
  })

  // GET /tasks/:taskId — Get task status + result
  app.get('/:taskId', async (c) => {
    const taskId = c.req.param('taskId')
    const result = taskStore.getResult(taskId)

    if (!result) {
      return c.json({ error: 'Task not found' }, 404)
    }

    return c.json(result)
  })

  // DELETE /tasks/:taskId — Cancel a task
  app.delete('/:taskId', async (c) => {
    const taskId = c.req.param('taskId')
    const task = taskStore.getTask(taskId)

    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const cancelled = taskScheduler.cancelTask(taskId)

    return c.json({
      taskId,
      cancelled,
      state: 'cancelled',
    })
  })

  // POST /tasks/:taskId/retry — Retry a failed task
  app.post('/:taskId/retry', async (c) => {
    const taskId = c.req.param('taskId')
    const task = taskStore.getTask(taskId)

    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    if (task.state !== 'failed' && task.state !== 'cancelled') {
      return c.json({ error: 'Can only retry failed or cancelled tasks' }, 400)
    }

    taskStore.updateState(taskId, 'pending')

    return c.json({
      taskId,
      state: 'pending',
      retryCount: task.retryCount,
    })
  })

  return app
}
