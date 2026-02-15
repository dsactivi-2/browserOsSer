import { Database } from 'bun:sqlite'
import type { ABExperiment } from './types'

export class ABTester {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ab_experiments (
        id TEXT PRIMARY KEY,
        template_name TEXT NOT NULL,
        variant_a_id TEXT NOT NULL,
        variant_b_id TEXT NOT NULL,
        traffic_split_percent INTEGER NOT NULL DEFAULT 50,
        min_sample_size INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'concluded', 'cancelled')),
        winner_id TEXT,
        started_at TEXT NOT NULL,
        concluded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ab_template ON ab_experiments(template_name);
      CREATE INDEX IF NOT EXISTS idx_ab_status ON ab_experiments(status);
    `)
  }

  startExperiment(
    templateName: string,
    variantAId: string,
    variantBId: string,
    trafficSplit: number = 50,
    minSamples: number = 50,
  ): ABExperiment {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(`
      INSERT INTO ab_experiments (id, template_name, variant_a_id, variant_b_id, traffic_split_percent, min_sample_size, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        templateName,
        variantAId,
        variantBId,
        trafficSplit,
        minSamples,
        now,
      )

    return this.get(id)!
  }

  selectVariant(experimentId: string): string | null {
    const exp = this.get(experimentId)
    if (!exp || exp.status !== 'running') return null

    const random = Math.random() * 100
    return random < exp.trafficSplitPercent ? exp.variantAId : exp.variantBId
  }

  conclude(experimentId: string, winnerId: string): void {
    this.db
      .prepare(
        'UPDATE ab_experiments SET status = ?, winner_id = ?, concluded_at = ? WHERE id = ?',
      )
      .run('concluded', winnerId, new Date().toISOString(), experimentId)
  }

  cancel(experimentId: string): void {
    this.db
      .prepare(
        'UPDATE ab_experiments SET status = ?, concluded_at = ? WHERE id = ?',
      )
      .run('cancelled', new Date().toISOString(), experimentId)
  }

  getActive(templateName: string): ABExperiment | null {
    const row = this.db
      .prepare(
        "SELECT * FROM ab_experiments WHERE template_name = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(templateName) as any
    return row ? this.rowToExperiment(row) : null
  }

  get(id: string): ABExperiment | null {
    const row = this.db
      .prepare('SELECT * FROM ab_experiments WHERE id = ?')
      .get(id) as any
    return row ? this.rowToExperiment(row) : null
  }

  listExperiments(status?: string, limit: number = 50): ABExperiment[] {
    if (status) {
      return (
        this.db
          .prepare(
            'SELECT * FROM ab_experiments WHERE status = ? ORDER BY started_at DESC LIMIT ?',
          )
          .all(status, limit) as any[]
      ).map(this.rowToExperiment)
    }
    return (
      this.db
        .prepare(
          'SELECT * FROM ab_experiments ORDER BY started_at DESC LIMIT ?',
        )
        .all(limit) as any[]
    ).map(this.rowToExperiment)
  }

  close(): void {
    this.db.close()
  }

  private rowToExperiment(row: any): ABExperiment {
    return {
      id: row.id,
      templateName: row.template_name,
      variantAId: row.variant_a_id,
      variantBId: row.variant_b_id,
      trafficSplitPercent: row.traffic_split_percent,
      minSampleSize: row.min_sample_size,
      status: row.status,
      winnerId: row.winner_id,
      startedAt: row.started_at,
      concludedAt: row.concluded_at,
    }
  }
}
