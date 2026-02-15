import { Database } from 'bun:sqlite'
import type { FeedbackStats, TaskFeedback } from './types'

export class FeedbackCollector {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_feedback (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        pattern_id TEXT,
        rating TEXT NOT NULL CHECK(rating IN ('success', 'partial', 'failure')),
        auto_rating INTEGER NOT NULL DEFAULT 1,
        user_feedback TEXT,
        duration_ms INTEGER NOT NULL,
        tools_used TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_task ON task_feedback(task_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON task_feedback(rating);
    `)
  }

  autoRate(
    taskId: string,
    success: boolean,
    durationMs: number,
    toolsUsed: string[],
    retryCount: number,
    patternId?: string,
  ): string {
    const id = crypto.randomUUID()
    let rating: 'success' | 'partial' | 'failure'

    if (success && retryCount === 0) rating = 'success'
    else if (success) rating = 'partial'
    else rating = 'failure'

    this.db
      .prepare(`
      INSERT INTO task_feedback (id, task_id, pattern_id, rating, auto_rating, duration_ms, tools_used, retry_count, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `)
      .run(
        id,
        taskId,
        patternId ?? null,
        rating,
        durationMs,
        JSON.stringify(toolsUsed),
        retryCount,
        new Date().toISOString(),
      )

    return id
  }

  addUserFeedback(
    taskId: string,
    rating: 'success' | 'partial' | 'failure',
    feedback: string,
  ): string {
    const id = crypto.randomUUID()
    this.db
      .prepare(`
      INSERT INTO task_feedback (id, task_id, rating, auto_rating, user_feedback, duration_ms, tools_used, created_at)
      VALUES (?, ?, ?, 0, ?, 0, '[]', ?)
    `)
      .run(id, taskId, rating, feedback, new Date().toISOString())
    return id
  }

  getForTask(taskId: string): TaskFeedback[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM task_feedback WHERE task_id = ? ORDER BY created_at DESC',
        )
        .all(taskId) as any[]
    ).map(this.rowToFeedback)
  }

  getRecent(limit: number = 50, rating?: string): TaskFeedback[] {
    if (rating) {
      return (
        this.db
          .prepare(
            'SELECT * FROM task_feedback WHERE rating = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(rating, limit) as any[]
      ).map(this.rowToFeedback)
    }
    return (
      this.db
        .prepare('SELECT * FROM task_feedback ORDER BY created_at DESC LIMIT ?')
        .all(limit) as any[]
    ).map(this.rowToFeedback)
  }

  getStats(): FeedbackStats {
    const total =
      (this.db.prepare('SELECT COUNT(*) as c FROM task_feedback').get() as any)
        ?.c ?? 0
    const success =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM task_feedback WHERE rating = 'success'",
          )
          .get() as any
      )?.c ?? 0
    const partial =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM task_feedback WHERE rating = 'partial'",
          )
          .get() as any
      )?.c ?? 0
    const failure =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM task_feedback WHERE rating = 'failure'",
          )
          .get() as any
      )?.c ?? 0
    const avgDuration =
      (
        this.db
          .prepare('SELECT AVG(duration_ms) as a FROM task_feedback')
          .get() as any
      )?.a ?? 0
    const autoRated =
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM task_feedback WHERE auto_rating = 1',
          )
          .get() as any
      )?.c ?? 0

    return {
      total,
      successCount: success,
      partialCount: partial,
      failureCount: failure,
      avgDurationMs: Math.round(avgDuration),
      autoRatedCount: autoRated,
    }
  }

  close(): void {
    this.db.close()
  }

  private rowToFeedback(row: any): TaskFeedback {
    return {
      id: row.id,
      taskId: row.task_id,
      patternId: row.pattern_id,
      rating: row.rating,
      autoRating: row.auto_rating === 1,
      userFeedback: row.user_feedback,
      durationMs: row.duration_ms,
      toolsUsed: JSON.parse(row.tools_used),
      retryCount: row.retry_count,
      createdAt: row.created_at,
    }
  }
}
