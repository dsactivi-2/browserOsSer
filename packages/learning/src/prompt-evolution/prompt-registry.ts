import type { Database } from 'bun:sqlite'
import type { PromptVariant } from './types'

interface PromptVariantRow {
  id: string
  template_name: string
  version: number
  content: string
  is_active: number
  is_winner: number
  success_rate: number
  total_uses: number
  success_count: number
  failure_count: number
  avg_latency_ms: number
  created_at: string
  promoted_at: string | null
}

export class PromptRegistry {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_variants (
        id TEXT PRIMARY KEY,
        template_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_winner INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0.0,
        total_uses INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        avg_latency_ms REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL,
        promoted_at TEXT,
        UNIQUE(template_name, version)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_template ON prompt_variants(template_name);
      CREATE INDEX IF NOT EXISTS idx_prompt_active ON prompt_variants(is_active);
    `)
  }

  register(templateName: string, content: string): PromptVariant {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const nextVersion = this.getNextVersion(templateName)

    this.db
      .prepare(`
      INSERT INTO prompt_variants (id, template_name, version, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(id, templateName, nextVersion, content, now)

    return this.get(id)!
  }

  getActive(templateName: string): PromptVariant | null {
    const winner = this.db
      .prepare(
        'SELECT * FROM prompt_variants WHERE template_name = ? AND is_winner = 1 AND is_active = 1',
      )
      .get(templateName) as PromptVariantRow | null
    if (winner) return this.rowToVariant(winner)

    const latest = this.db
      .prepare(
        'SELECT * FROM prompt_variants WHERE template_name = ? AND is_active = 1 ORDER BY version DESC LIMIT 1',
      )
      .get(templateName) as PromptVariantRow | null
    return latest ? this.rowToVariant(latest) : null
  }

  get(id: string): PromptVariant | null {
    const row = this.db
      .prepare('SELECT * FROM prompt_variants WHERE id = ?')
      .get(id) as PromptVariantRow | null
    return row ? this.rowToVariant(row) : null
  }

  recordOutcome(id: string, success: boolean, latencyMs: number): void {
    const variant = this.get(id)
    if (!variant) return

    const newTotal = variant.totalUses + 1
    const newSuccess = variant.successCount + (success ? 1 : 0)
    const newFailure = variant.failureCount + (success ? 0 : 1)
    const newRate = newTotal > 0 ? newSuccess / newTotal : 0
    const newLatency =
      (variant.avgLatencyMs * variant.totalUses + latencyMs) / newTotal

    this.db
      .prepare(`
      UPDATE prompt_variants SET total_uses = ?, success_count = ?, failure_count = ?, success_rate = ?, avg_latency_ms = ? WHERE id = ?
    `)
      .run(newTotal, newSuccess, newFailure, newRate, newLatency, id)
  }

  promote(id: string): void {
    const variant = this.get(id)
    if (!variant) return

    this.db
      .prepare(
        'UPDATE prompt_variants SET is_winner = 0 WHERE template_name = ? AND is_winner = 1',
      )
      .run(variant.templateName)

    this.db
      .prepare(
        'UPDATE prompt_variants SET is_winner = 1, promoted_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), id)
  }

  listVariants(templateName: string): PromptVariant[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM prompt_variants WHERE template_name = ? ORDER BY version DESC',
        )
        .all(templateName) as PromptVariantRow[]
    ).map(this.rowToVariant)
  }

  listTemplates(): string[] {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT template_name FROM prompt_variants ORDER BY template_name',
      )
      .all() as { template_name: string }[]
    return rows.map((r) => r.template_name)
  }

  close(): void {
    // DB lifecycle managed by DatabaseProvider
  }

  private getNextVersion(templateName: string): number {
    const row = this.db
      .prepare(
        'SELECT MAX(version) as max_v FROM prompt_variants WHERE template_name = ?',
      )
      .get(templateName) as { max_v: number | null } | null
    return (row?.max_v ?? 0) + 1
  }

  private rowToVariant(row: PromptVariantRow): PromptVariant {
    return {
      id: row.id,
      templateName: row.template_name,
      version: row.version,
      content: row.content,
      isActive: row.is_active === 1,
      isWinner: row.is_winner === 1,
      successRate: row.success_rate,
      totalUses: row.total_uses,
      successCount: row.success_count,
      failureCount: row.failure_count,
      avgLatencyMs: row.avg_latency_ms,
      createdAt: row.created_at,
      promotedAt: row.promoted_at,
    }
  }
}
