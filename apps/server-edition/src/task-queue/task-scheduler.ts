import { TASK_QUEUE } from '@browseros/shared/constants/task-queue'
import { DependencyResolver } from './dependency-resolver'
import { RetryManager } from './retry-manager'
import { TaskExecutor, type TaskExecutorDeps } from './task-executor'
import type { TaskStore } from './task-store'
import type { StoredTask, TaskEvent, TaskEventHandler } from './types'

export interface TaskSchedulerConfig {
  maxConcurrent: number
  pollIntervalMs?: number
}

export class TaskScheduler {
  private store: TaskStore
  private executor: TaskExecutor
  private resolver: DependencyResolver
  private retryManager: RetryManager
  private config: TaskSchedulerConfig
  private running = false
  private activeTaskCount = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private eventHandlers: TaskEventHandler[] = []

  constructor(
    store: TaskStore,
    executorDeps: Omit<TaskExecutorDeps, 'taskStore' | 'onEvent'>,
    config: TaskSchedulerConfig,
  ) {
    this.store = store
    this.config = config
    this.resolver = new DependencyResolver()
    this.retryManager = new RetryManager()
    this.executor = new TaskExecutor({
      ...executorDeps,
      taskStore: store,
      onEvent: (event) => this.handleEvent(event),
    })
  }

  start(): void {
    if (this.running) return
    this.running = true

    this.pollTimer = setInterval(
      () => this.poll(),
      this.config.pollIntervalMs ?? TASK_QUEUE.POLL_INTERVAL_MS,
    )

    this.poll()
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  onEvent(handler: TaskEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private async poll(): Promise<void> {
    if (!this.running) return
    if (this.activeTaskCount >= this.config.maxConcurrent) return

    const available = this.config.maxConcurrent - this.activeTaskCount
    const candidates = this.store.getNextPendingTasks(available * 2)

    if (candidates.length === 0) return

    const taskMap = new Map<string, StoredTask>()
    for (const task of candidates) {
      taskMap.set(task.id, task)
    }

    for (const task of candidates) {
      for (const depId of task.dependsOn ?? []) {
        if (!taskMap.has(depId)) {
          const dep = this.store.getTask(depId)
          if (dep) taskMap.set(depId, dep)
        }
      }
    }

    for (const task of candidates) {
      if (this.activeTaskCount >= this.config.maxConcurrent) break

      if (this.resolver.hasFailedDependency(task, taskMap)) {
        this.store.updateState(task.id, 'cancelled')
        continue
      }

      if (!this.resolver.canExecute(task, taskMap)) {
        if (task.state !== 'waiting_dependency') {
          this.store.updateState(task.id, 'waiting_dependency')
        }
        continue
      }

      this.activeTaskCount++
      this.store.updateState(task.id, 'queued')

      this.executor.execute(task).finally(() => {
        this.activeTaskCount--
      })
    }
  }

  private async handleEvent(event: TaskEvent): Promise<void> {
    if (event.type === 'task.failed') {
      const task = this.store.getTask(event.taskId)
      if (
        task &&
        this.retryManager.shouldRetry(task.retryCount, task.retryPolicy)
      ) {
        const newCount = this.store.incrementRetry(event.taskId)
        await this.retryManager.waitForRetry(newCount, task.retryPolicy)
        this.store.updateState(event.taskId, 'pending')
        return
      }
    }

    for (const handler of this.eventHandlers) {
      try {
        await handler(event)
      } catch {
        // Event handler errors are non-critical
      }
    }
  }

  cancelTask(taskId: string): boolean {
    const task = this.store.getTask(taskId)
    if (!task) return false

    if (task.state === 'running') {
      this.executor.cancelTask(taskId)
    }

    this.store.updateState(taskId, 'cancelled')
    return true
  }
}
