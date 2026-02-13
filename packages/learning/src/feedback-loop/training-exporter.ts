import { Database } from 'bun:sqlite'
import type { TrainingPair } from './types'

export class TrainingExporter {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
  }

  exportTrainingPairs(
    minRating: string = 'success',
    limit: number = 1000,
  ): TrainingPair[] {
    const ratingFilter =
      minRating === 'success'
        ? "rating = 'success'"
        : "rating IN ('success', 'partial')"

    const rows = this.db
      .prepare(`
      SELECT
        f.task_id, f.rating, f.tools_used, f.duration_ms,
        p.input_summary, p.output_summary, p.tool_sequence
      FROM task_feedback f
      LEFT JOIN execution_patterns p ON f.pattern_id = p.id
      WHERE ${ratingFilter}
      ORDER BY f.created_at DESC
      LIMIT ?
    `)
      .all(limit) as any[]

    return rows
      .filter((r) => r.input_summary && r.output_summary)
      .map((row) => ({
        input: row.input_summary,
        output: row.output_summary,
        rating: row.rating === 'success' ? 1.0 : 0.5,
        metadata: {
          taskId: row.task_id,
          toolsUsed: JSON.parse(row.tools_used || '[]'),
          toolSequence: JSON.parse(row.tool_sequence || '[]'),
          durationMs: row.duration_ms,
        },
      }))
  }

  exportAsJsonl(minRating: string = 'success', limit: number = 1000): string {
    const pairs = this.exportTrainingPairs(minRating, limit)
    return pairs.map((p) => JSON.stringify(p)).join('\n')
  }

  close(): void {
    this.db.close()
  }
}
