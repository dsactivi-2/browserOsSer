import type { TaskDefinition, TaskState } from '@browseros/shared/schemas/task'

export interface StoredTask extends TaskDefinition {
  batchId?: string
  retryCount: number
}

export interface TaskQueueStats {
  total: number
  pending: number
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
}

export interface TaskEvent {
  type:
    | 'task.created'
    | 'task.started'
    | 'task.completed'
    | 'task.failed'
    | 'task.cancelled'
  taskId: string
  batchId?: string
  state: TaskState
  result?: unknown
  error?: string
  timestamp: string
}

export type TaskEventHandler = (event: TaskEvent) => Promise<void>
