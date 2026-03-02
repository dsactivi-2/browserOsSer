import type { Database } from 'bun:sqlite'

export type KnowledgeCategory =
  | 'domain'
  | 'execution_pattern'
  | 'user_preference'
  | 'website_knowledge'
  | 'error_pattern'

export interface CrossSessionEntry {
  id: string
  category: KnowledgeCategory
  key: string
  value: string
  confidence: number
  usageCount: number
  lastUsedAt: string
  createdAt: string
  updatedAt: string
}

interface CrossSessionRow {
  id: string
  category: string
  key: string
  value: string
  confidence: number
  usage_count: number
  last_used_at: string
  created_at: string
  updated_at: string
}

interface CountRow {
  c: number
}

interface CategoryCountRow {
  category: string
  c: number
}

interface AvgRow {
  avg: number
}

export class CrossSessionStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cross_session_knowledge (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category, key)
      );
      CREATE INDEX IF NOT EXISTS idx_cross_category ON cross_session_knowledge(category);
      CREATE INDEX IF NOT EXISTS idx_cross_confidence ON cross_session_knowledge(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_cross_usage ON cross_session_knowledge(usage_count DESC);
    `)
  }

  // Store or update knowledge — increases confidence on repeated storage
  store(
    category: KnowledgeCategory,
    key: string,
    value: string,
    confidence?: number,
  ): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const conf = confidence ?? 0.5

    this.db
      .prepare(`
      INSERT INTO cross_session_knowledge (id, category, key, value, confidence, usage_count, last_used_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(category, key) DO UPDATE SET
        value = excluded.value,
        confidence = MIN(1.0, confidence + 0.1),
        usage_count = usage_count + 1,
        last_used_at = excluded.last_used_at,
        updated_at = excluded.updated_at
    `)
      .run(id, category, key, value, conf, now, now, now)

    return id
  }

  // Retrieve by category + key
  get(category: KnowledgeCategory, key: string): CrossSessionEntry | null {
    const row = this.db
      .prepare(
        'SELECT * FROM cross_session_knowledge WHERE category = ? AND key = ?',
      )
      .get(category, key) as CrossSessionRow | null
    if (!row) return null
    return this.rowToEntry(row)
  }

  // Search by category, sorted by confidence
  getByCategory(
    category: KnowledgeCategory,
    limit: number = 50,
  ): CrossSessionEntry[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM cross_session_knowledge WHERE category = ? ORDER BY confidence DESC, usage_count DESC LIMIT ?',
        )
        .all(category, limit) as CrossSessionRow[]
    ).map(this.rowToEntry)
  }

  // Search by keyword in key or value
  search(
    query: string,
    category?: KnowledgeCategory,
    limit: number = 20,
  ): CrossSessionEntry[] {
    const pattern = `%${query}%`
    if (category) {
      return (
        this.db
          .prepare(
            'SELECT * FROM cross_session_knowledge WHERE category = ? AND (key LIKE ? OR value LIKE ?) ORDER BY confidence DESC LIMIT ?',
          )
          .all(category, pattern, pattern, limit) as CrossSessionRow[]
      ).map(this.rowToEntry)
    }
    return (
      this.db
        .prepare(
          'SELECT * FROM cross_session_knowledge WHERE key LIKE ? OR value LIKE ? ORDER BY confidence DESC LIMIT ?',
        )
        .all(pattern, pattern, limit) as CrossSessionRow[]
    ).map(this.rowToEntry)
  }

  // Record usage (called when knowledge is retrieved and used)
  recordUsage(id: string): void {
    this.db
      .prepare(
        'UPDATE cross_session_knowledge SET usage_count = usage_count + 1, last_used_at = ?, confidence = MIN(1.0, confidence + 0.05) WHERE id = ?',
      )
      .run(new Date().toISOString(), id)
  }

  // Decay confidence for unused entries (run periodically)
  decayUnused(daysSinceLastUse: number = 30, decayRate: number = 0.1): number {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysSinceLastUse)
    const result = this.db
      .prepare(
        'UPDATE cross_session_knowledge SET confidence = MAX(0.0, confidence - ?) WHERE last_used_at < ?',
      )
      .run(decayRate, cutoff.toISOString())
    return result.changes
  }

  // Prune low-confidence entries
  prune(minConfidence: number = 0.1): number {
    const result = this.db
      .prepare('DELETE FROM cross_session_knowledge WHERE confidence < ?')
      .run(minConfidence)
    return result.changes
  }

  getStats(): {
    total: number
    byCategory: Record<string, number>
    avgConfidence: number
  } {
    const total =
      (
        this.db
          .prepare('SELECT COUNT(*) as c FROM cross_session_knowledge')
          .get() as CountRow | null
      )?.c ?? 0
    const catRows = this.db
      .prepare(
        'SELECT category, COUNT(*) as c FROM cross_session_knowledge GROUP BY category',
      )
      .all() as CategoryCountRow[]
    const byCategory: Record<string, number> = {}
    for (const row of catRows) byCategory[row.category] = row.c
    const avg =
      (
        this.db
          .prepare('SELECT AVG(confidence) as avg FROM cross_session_knowledge')
          .get() as AvgRow | null
      )?.avg ?? 0
    return { total, byCategory, avgConfidence: Math.round(avg * 100) / 100 }
  }

  close(): void {
    // DB lifecycle managed by DatabaseProvider — nothing to close here
  }

  private rowToEntry(row: CrossSessionRow): CrossSessionEntry {
    return {
      id: row.id,
      category: row.category,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      usageCount: row.usage_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
