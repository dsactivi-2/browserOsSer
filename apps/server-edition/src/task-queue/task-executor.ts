import { TASK_QUEUE } from '@browseros/shared/constants/task-queue'
import type { TaskStore } from './task-store'
import type { StoredTask, TaskEvent } from './types'

export interface TaskExecutorDeps {
  taskStore: TaskStore
  serverPort: number
  onEvent?: (event: TaskEvent) => Promise<void>
}

export class TaskExecutor {
  private deps: TaskExecutorDeps
  private abortControllers = new Map<string, AbortController>()

  constructor(deps: TaskExecutorDeps) {
    this.deps = deps
  }

  async execute(task: StoredTask): Promise<void> {
    const { taskStore, onEvent } = this.deps
    const startTime = Date.now()

    const abortController = new AbortController()
    this.abortControllers.set(task.id, abortController)

    const timeoutMs = task.timeout ?? TASK_QUEUE.DEFAULT_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Task timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      taskStore.updateState(task.id, 'running')
      taskStore.setResult(task.id, { startedAt: new Date().toISOString() })

      await onEvent?.({
        type: 'task.started',
        taskId: task.id,
        batchId: task.batchId,
        state: 'running',
        timestamp: new Date().toISOString(),
      })

      const result = await this.executeViaApi(task, abortController.signal)

      const executionTimeMs = Date.now() - startTime

      taskStore.updateState(task.id, 'completed')
      taskStore.setResult(task.id, {
        result,
        completedAt: new Date().toISOString(),
        executionTimeMs,
      })

      await onEvent?.({
        type: 'task.completed',
        taskId: task.id,
        batchId: task.batchId,
        state: 'completed',
        result,
        timestamp: new Date().toISOString(),
      })

      if (task.webhookUrl) {
        this.sendWebhook(task.webhookUrl, {
          taskId: task.id,
          state: 'completed',
          result,
          executionTimeMs,
        }).catch((err) => {
          console.warn(
            `Webhook delivery failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }
    } catch (error) {
      const executionTimeMs = Date.now() - startTime
      const errorMsg = error instanceof Error ? error.message : String(error)

      taskStore.updateState(task.id, 'failed')
      taskStore.setResult(task.id, {
        error: errorMsg,
        completedAt: new Date().toISOString(),
        executionTimeMs,
      })

      await onEvent?.({
        type: 'task.failed',
        taskId: task.id,
        batchId: task.batchId,
        state: 'failed',
        error: errorMsg,
        timestamp: new Date().toISOString(),
      })

      if (task.webhookUrl) {
        this.sendWebhook(task.webhookUrl, {
          taskId: task.id,
          state: 'failed',
          error: errorMsg,
          executionTimeMs,
        }).catch((err) => {
          console.warn(
            `Webhook delivery failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }
    } finally {
      clearTimeout(timeoutId)
      this.abortControllers.delete(task.id)
    }
  }

  cancelTask(taskId: string): void {
    const controller = this.abortControllers.get(taskId)
    if (controller) {
      controller.abort(new Error('Task cancelled by user'))
    }
  }

  private async executeViaApi(
    task: StoredTask,
    signal: AbortSignal,
  ): Promise<unknown> {
    const conversationId = crypto.randomUUID()
    const url = `http://127.0.0.1:${this.deps.serverPort}/chat`

    const body: Record<string, unknown> = {
      conversationId,
      message: task.instruction,
      isScheduledTask: true,
      mode: 'agent',
      supportsImages: false,
    }

    if (task.llmConfig) {
      Object.assign(body, task.llmConfig)
    } else {
      body.provider = 'browseros'
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Chat API returned ${response.status}: ${text}`)
    }

    const text = await response.text()
    return this.parseSSEResponse(text)
  }

  private parseSSEResponse(sseText: string): unknown {
    const events: unknown[] = []
    const lines = sseText.split('\n')

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          events.push(data)
        } catch {
          // Skip non-JSON data lines
        }
      }
    }

    if (events.length > 0) {
      return events[events.length - 1]
    }
    return { raw: sseText.slice(0, 1000) }
  }

  private isAllowedWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        return false
      const hostname = parsed.hostname
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname.startsWith('10.') ||
        hostname.match(/^172\.(1[6-9]|2\d|3[0-1])\./) ||
        hostname.startsWith('192.168.') ||
        hostname === '169.254.169.254' ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')
      ) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  private async sendWebhook(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isAllowedWebhookUrl(url)) return
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TASK_QUEUE.WEBHOOK_TIMEOUT_MS),
      })
    } catch {
      // Webhook failures are non-critical
    }
  }
}
