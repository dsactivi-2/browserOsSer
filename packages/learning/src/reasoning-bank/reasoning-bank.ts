import { Database } from 'bun:sqlite'
import type { ExecutionPattern, PatternMatch, PatternQuery } from './types'

interface PatternRow {
  id: string
  task_type: string
  tool_sequence: string
  input_summary: string
  output_summary: string
  success: number
  duration_ms: number
  tool_count: number
  retry_count: number
  confidence: number
  embedding: Buffer | null
  created_at: string
}

export class ReasoningBank {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_patterns (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        tool_sequence TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_summary TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tool_count INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.5,
        embedding BLOB,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON execution_patterns(task_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_success ON execution_patterns(success);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON execution_patterns(confidence DESC);
    `)
  }

  store(pattern: Omit<ExecutionPattern, 'id'>): string {
    const id = crypto.randomUUID()
    this.db
      .prepare(`
      INSERT INTO execution_patterns (id, task_type, tool_sequence, input_summary, output_summary, success, duration_ms, tool_count, retry_count, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        pattern.taskType,
        JSON.stringify(pattern.toolSequence),
        pattern.inputSummary,
        pattern.outputSummary,
        pattern.success ? 1 : 0,
        pattern.durationMs,
        pattern.toolCount,
        pattern.retryCount,
        pattern.confidence,
        pattern.createdAt,
      )
    return id
  }

  findSimilar(query: PatternQuery): PatternMatch[] {
    const conditions: string[] = ['success = 1']
    const params: (string | number)[] = []

    if (query.toolName) {
      conditions.push('tool_sequence LIKE ?')
      params.push(`%"${query.toolName}"%`)
    }
    if (query.minConfidence) {
      conditions.push('confidence >= ?')
      params.push(query.minConfidence)
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = query.limit ?? 10

    const rows = this.db
      .prepare(`
      SELECT * FROM execution_patterns ${where} ORDER BY confidence DESC, created_at DESC LIMIT ?
    `)
      .all(...params, limit) as PatternRow[]

    const queryWords = new Set(query.taskDescription.toLowerCase().split(/\s+/))

    return rows
      .map((row) => {
        const pattern = this.rowToPattern(row)
        const patternWords = new Set(
          `${pattern.inputSummary} ${pattern.outputSummary} ${pattern.taskType}`
            .toLowerCase()
            .split(/\s+/),
        )
        let overlap = 0
        for (const w of queryWords) {
          if (patternWords.has(w)) overlap++
        }
        const similarity = queryWords.size > 0 ? overlap / queryWords.size : 0

        return {
          pattern,
          similarity,
          relevance: similarity * pattern.confidence,
        }
      })
      .filter((m) => m.similarity > 0)
      .sort((a, b) => b.relevance - a.relevance)
  }

  getByType(taskType: string, limit: number = 20): ExecutionPattern[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM execution_patterns WHERE task_type = ? ORDER BY confidence DESC LIMIT ?',
        )
        .all(taskType, limit) as PatternRow[]
    ).map(this.rowToPattern)
  }

  boostConfidence(id: string, boost: number = 0.1): void {
    this.db
      .prepare(
        'UPDATE execution_patterns SET confidence = MIN(1.0, confidence + ?) WHERE id = ?',
      )
      .run(boost, id)
  }

  reduceConfidence(id: string, penalty: number = 0.2): void {
    this.db
      .prepare(
        'UPDATE execution_patterns SET confidence = MAX(0.0, confidence - ?) WHERE id = ?',
      )
      .run(penalty, id)
  }

  getStats(): {
    total: number
    successful: number
    avgConfidence: number
    byType: Record<string, number>
  } {
    const total =
      (
        this.db.prepare('SELECT COUNT(*) as c FROM execution_patterns').get() as
          | { c: number }
          | undefined
      )?.c ?? 0
    const successful =
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM execution_patterns WHERE success = 1',
          )
          .get() as { c: number } | undefined
      )?.c ?? 0
    const avg =
      (
        this.db
          .prepare('SELECT AVG(confidence) as a FROM execution_patterns')
          .get() as { a: number } | undefined
      )?.a ?? 0
    const types = this.db
      .prepare(
        'SELECT task_type, COUNT(*) as c FROM execution_patterns GROUP BY task_type',
      )
      .all() as Array<{ task_type: string; c: number }>
    const byType: Record<string, number> = {}
    for (const t of types) byType[t.task_type] = t.c
    return {
      total,
      successful,
      avgConfidence: Math.round(avg * 100) / 100,
      byType,
    }
  }

  close(): void {
    this.db.close()
  }

  private rowToPattern(row: PatternRow): ExecutionPattern {
    return {
      id: row.id,
      taskType: row.task_type,
      toolSequence: JSON.parse(row.tool_sequence),
      inputSummary: row.input_summary,
      outputSummary: row.output_summary,
      success: row.success === 1,
      durationMs: row.duration_ms,
      toolCount: row.tool_count,
      retryCount: row.retry_count,
      confidence: row.confidence,
      createdAt: row.created_at,
    }
  }
}
