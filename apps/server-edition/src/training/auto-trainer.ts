import type { Database } from 'bun:sqlite'

export interface TrainingPattern {
  id: string
  patternType: 'success' | 'failure' | 'optimization'
  instruction: string
  provider: string
  model: string
  avgLatencyMs: number
  successRate: number
  sampleSize: number
  recommendation: string
  confidence: number
  createdAt: string
  updatedAt: string
}

export interface TrainingStats {
  totalPatterns: number
  byType: Record<string, number>
  avgConfidence: number
  lastTrainedAt: string | null
}

interface TaskMetricsRow {
  instruction_prefix: string
  provider: string
  model: string
  sample_size: number
  success_count: number
  avg_latency_ms: number
}

interface PatternRow {
  id: string
  pattern_type: string
  instruction: string
  provider: string
  model: string
  avg_latency_ms: number
  success_rate: number
  sample_size: number
  recommendation: string
  confidence: number
  created_at: string
  updated_at: string
}

export class AutoTrainer {
  private db: Database
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS training_patterns (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        instruction TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        avg_latency_ms INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        sample_size INTEGER NOT NULL DEFAULT 0,
        recommendation TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_training_patterns_type ON training_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_training_patterns_instruction ON training_patterns(instruction);
    `)
  }

  train(): TrainingStats {
    // Query completed tasks joined with router metrics, grouped by instruction prefix + provider/model
    const rows = this.db
      .prepare(`
        SELECT
          SUBSTR(t.instruction, 1, 50) AS instruction_prefix,
          rm.provider,
          rm.model,
          COUNT(*) AS sample_size,
          SUM(CASE WHEN t.state = 'completed' THEN 1 ELSE 0 END) AS success_count,
          CAST(AVG(tr.execution_time_ms) AS INTEGER) AS avg_latency_ms
        FROM tasks t
        LEFT JOIN task_results tr ON tr.task_id = t.id
        LEFT JOIN router_metrics rm ON rm.tool_name = SUBSTR(t.instruction, 1, 50)
        WHERE t.state IN ('completed', 'failed')
          AND rm.provider IS NOT NULL
          AND rm.model IS NOT NULL
          AND tr.execution_time_ms IS NOT NULL
        GROUP BY instruction_prefix, rm.provider, rm.model
        HAVING COUNT(*) >= 3
      `)
      .all() as TaskMetricsRow[]

    const now = new Date().toISOString()

    for (const row of rows) {
      const successRate =
        row.sample_size > 0 ? row.success_count / row.sample_size : 0
      const confidence = Math.min(row.sample_size / 20, 1)

      let patternType: TrainingPattern['patternType']
      if (successRate >= 0.8) {
        patternType = 'success'
      } else if (successRate < 0.5) {
        patternType = 'failure'
      } else {
        patternType = 'optimization'
      }

      const recommendation =
        `Use ${row.provider}/${row.model} for "${row.instruction_prefix}" — ` +
        `${(successRate * 100).toFixed(1)}% success, ${row.avg_latency_ms}ms avg`

      const existing = this.db
        .prepare(
          'SELECT id FROM training_patterns WHERE instruction = ? AND provider = ? AND model = ?',
        )
        .get(row.instruction_prefix, row.provider, row.model) as {
        id: string
      } | null

      if (existing) {
        this.db
          .prepare(`
            UPDATE training_patterns SET
              pattern_type = ?,
              avg_latency_ms = ?,
              success_rate = ?,
              sample_size = ?,
              recommendation = ?,
              confidence = ?,
              updated_at = ?
            WHERE id = ?
          `)
          .run(
            patternType,
            row.avg_latency_ms,
            successRate,
            row.sample_size,
            recommendation,
            confidence,
            now,
            existing.id,
          )
      } else {
        this.db
          .prepare(`
            INSERT INTO training_patterns (id, pattern_type, instruction, provider, model, avg_latency_ms, success_rate, sample_size, recommendation, confidence, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            crypto.randomUUID(),
            patternType,
            row.instruction_prefix,
            row.provider,
            row.model,
            row.avg_latency_ms,
            successRate,
            row.sample_size,
            recommendation,
            confidence,
            now,
            now,
          )
      }
    }

    return this.getStats()
  }

  getPatterns(limit = 50, type?: string): TrainingPattern[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (type) {
      conditions.push('pattern_type = ?')
      params.push(type)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT * FROM training_patterns ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      )
      .all(...(params as string[])) as PatternRow[]

    return rows.map(this.rowToPattern)
  }

  getRecommendation(instruction: string): TrainingPattern | null {
    const prefix = instruction.slice(0, 50)

    const row = this.db
      .prepare(`
        SELECT * FROM training_patterns
        WHERE instruction = ? AND pattern_type = 'success'
        ORDER BY confidence DESC, success_rate DESC
        LIMIT 1
      `)
      .get(prefix) as PatternRow | null

    if (row) return this.rowToPattern(row)

    // Fallback: partial prefix match using LIKE
    const partialRow = this.db
      .prepare(`
        SELECT * FROM training_patterns
        WHERE ? LIKE instruction || '%' AND pattern_type = 'success'
        ORDER BY confidence DESC, success_rate DESC
        LIMIT 1
      `)
      .get(prefix) as PatternRow | null

    return partialRow ? this.rowToPattern(partialRow) : null
  }

  getStats(): TrainingStats {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM training_patterns')
        .get() as { count: number }
    ).count

    const typeRows = this.db
      .prepare(
        'SELECT pattern_type, COUNT(*) as count FROM training_patterns GROUP BY pattern_type',
      )
      .all() as { pattern_type: string; count: number }[]

    const byType: Record<string, number> = {}
    for (const row of typeRows) {
      byType[row.pattern_type] = row.count
    }

    const avgRow = this.db
      .prepare('SELECT AVG(confidence) as avg FROM training_patterns')
      .get() as { avg: number | null }

    const lastRow = this.db
      .prepare('SELECT MAX(updated_at) as last FROM training_patterns')
      .get() as { last: string | null }

    return {
      totalPatterns: total,
      byType,
      avgConfidence: avgRow.avg ?? 0,
      lastTrainedAt: lastRow.last,
    }
  }

  deletePattern(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM training_patterns WHERE id = ?')
      .run(id)
    return result.changes > 0
  }

  startAutoTraining(intervalMs = 300_000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.train(), intervalMs)
  }

  stopAutoTraining(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private rowToPattern(row: PatternRow): TrainingPattern {
    return {
      id: row.id,
      patternType: row.pattern_type as TrainingPattern['patternType'],
      instruction: row.instruction,
      provider: row.provider,
      model: row.model,
      avgLatencyMs: row.avg_latency_ms,
      successRate: row.success_rate,
      sampleSize: row.sample_size,
      recommendation: row.recommendation,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
