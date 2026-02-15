import type { Database } from 'bun:sqlite'
import type {
  TaskDefinition,
  TaskPriority,
  TaskResult,
  TaskState,
  TaskStep,
} from '@browseros/shared/schemas/task'
import type { StoredTask, TaskQueueStats } from './types'

export class TaskStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        instruction TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        state TEXT NOT NULL DEFAULT 'pending',
        depends_on TEXT NOT NULL DEFAULT '[]',
        retry_policy TEXT,
        timeout INTEGER,
        webhook_url TEXT,
        metadata TEXT,
        llm_config TEXT,
        batch_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        result TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        execution_time_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS task_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        tool TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        duration_ms INTEGER,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_batches (
        id TEXT PRIMARY KEY,
        webhook_url TEXT,
        parallelism INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
      CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);
    `)
  }

  createTask(task: TaskDefinition & { batchId?: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, instruction, priority, state, depends_on, retry_policy, timeout, webhook_url, metadata, llm_config, batch_id, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)
    stmt.run(
      task.id,
      task.instruction,
      task.priority,
      task.state,
      JSON.stringify(task.dependsOn),
      task.retryPolicy ? JSON.stringify(task.retryPolicy) : null,
      task.timeout ?? null,
      task.webhookUrl ?? null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.llmConfig ? JSON.stringify(task.llmConfig) : null,
      (task as any).batchId ?? null,
      task.createdAt,
      task.updatedAt,
    )
  }

  getTask(taskId: string): StoredTask | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as any
    if (!row) return null
    return this.rowToTask(row)
  }

  listTasks(filters: {
    state?: TaskState
    priority?: TaskPriority
    batchId?: string
    limit?: number
    offset?: number
  }): StoredTask[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.state) {
      conditions.push('state = ?')
      params.push(filters.state)
    }
    if (filters.priority) {
      conditions.push('priority = ?')
      params.push(filters.priority)
    }
    if (filters.batchId) {
      conditions.push('batch_id = ?')
      params.push(filters.batchId)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    const allParams = [...params, limit, offset]
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...(allParams as string[])) as any[]

    return rows.map((row) => this.rowToTask(row))
  }

  updateState(taskId: string, state: TaskState): void {
    this.db
      .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), taskId)
  }

  incrementRetry(taskId: string): number {
    this.db
      .prepare(
        'UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), taskId)

    const row = this.db
      .prepare('SELECT retry_count FROM tasks WHERE id = ?')
      .get(taskId) as any
    return row?.retry_count ?? 0
  }

  setResult(
    taskId: string,
    result: {
      result?: unknown
      error?: string
      startedAt?: string
      completedAt?: string
      executionTimeMs?: number
    },
  ): void {
    this.db
      .prepare(`
      INSERT INTO task_results (task_id, result, error, started_at, completed_at, execution_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        result = excluded.result,
        error = excluded.error,
        started_at = COALESCE(excluded.started_at, task_results.started_at),
        completed_at = excluded.completed_at,
        execution_time_ms = excluded.execution_time_ms
    `)
      .run(
        taskId,
        result.result !== undefined ? JSON.stringify(result.result) : null,
        result.error ?? null,
        result.startedAt ?? null,
        result.completedAt ?? null,
        result.executionTimeMs ?? null,
      )
  }

  addStep(taskId: string, step: TaskStep): void {
    this.db
      .prepare(`
      INSERT INTO task_steps (task_id, tool, args, result, error, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        taskId,
        step.tool,
        JSON.stringify(step.args),
        step.result !== undefined ? JSON.stringify(step.result) : null,
        step.error ?? null,
        step.durationMs ?? null,
        step.timestamp,
      )
  }

  getResult(taskId: string): TaskResult | null {
    const task = this.getTask(taskId)
    if (!task) return null

    const resultRow = this.db
      .prepare('SELECT * FROM task_results WHERE task_id = ?')
      .get(taskId) as any
    const stepRows = this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY id')
      .all(taskId) as any[]

    return {
      taskId,
      state: task.state,
      result: resultRow?.result ? JSON.parse(resultRow.result) : undefined,
      error: resultRow?.error ?? undefined,
      startedAt: resultRow?.started_at ?? undefined,
      completedAt: resultRow?.completed_at ?? undefined,
      retryCount: task.retryCount,
      executionTimeMs: resultRow?.execution_time_ms ?? undefined,
      steps: stepRows.map((row) => ({
        tool: row.tool,
        args: JSON.parse(row.args),
        result: row.result ? JSON.parse(row.result) : undefined,
        error: row.error ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        timestamp: row.timestamp,
      })),
    }
  }

  getStats(): TaskQueueStats {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) as count FROM tasks GROUP BY state')
      .all() as { state: string; count: number }[]

    const stats: TaskQueueStats = {
      total: 0,
      pending: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }
    for (const row of rows) {
      stats[row.state as keyof TaskQueueStats] = row.count
      stats.total += row.count
    }
    return stats
  }

  getNextPendingTasks(limit: number): StoredTask[] {
    const priorityOrder = `CASE priority
      WHEN 'critical' THEN 0
      WHEN 'high' THEN 1
      WHEN 'normal' THEN 2
      WHEN 'low' THEN 3
    END`

    const rows = this.db
      .prepare(`
      SELECT * FROM tasks
      WHERE state IN ('pending', 'queued', 'waiting_dependency')
      ORDER BY ${priorityOrder}, created_at ASC
      LIMIT ?
    `)
      .all(limit) as any[]

    return rows.map((row) => this.rowToTask(row))
  }

  createBatch(
    batchId: string,
    webhookUrl?: string,
    parallelism?: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO task_batches (id, webhook_url, parallelism, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        batchId,
        webhookUrl ?? null,
        parallelism ?? 1,
        new Date().toISOString(),
      )
  }

  deleteTask(taskId: string): boolean {
    this.db.prepare('DELETE FROM task_steps WHERE task_id = ?').run(taskId)
    this.db.prepare('DELETE FROM task_results WHERE task_id = ?').run(taskId)
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    return result.changes > 0
  }

  close(): void {
    // DB lifecycle managed by DatabaseProvider — nothing to close here
  }

  private rowToTask(row: any): StoredTask {
    return {
      id: row.id,
      instruction: row.instruction,
      priority: row.priority,
      state: row.state,
      dependsOn: JSON.parse(row.depends_on),
      retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) : undefined,
      timeout: row.timeout ?? undefined,
      webhookUrl: row.webhook_url ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      llmConfig: row.llm_config ? JSON.parse(row.llm_config) : undefined,
      batchId: row.batch_id ?? undefined,
      retryCount: row.retry_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
