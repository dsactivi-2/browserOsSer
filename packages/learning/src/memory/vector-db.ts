import type { Database } from 'bun:sqlite'

export class VectorDB {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_created ON memory_vectors(created_at);
    `)
  }

  store(id: string, embedding: number[]): void {
    const buffer = new Float32Array(embedding).buffer
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memory_vectors (id, embedding, dimension, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, Buffer.from(buffer), embedding.length, new Date().toISOString())
  }

  search(
    queryEmbedding: number[],
    limit: number = 10,
    minSimilarity: number = 0.0,
  ): Array<{ id: string; similarity: number }> {
    const rows = this.db
      .prepare('SELECT id, embedding, dimension FROM memory_vectors')
      .all() as any[]

    const results: Array<{ id: string; similarity: number }> = []
    const queryNorm = this.norm(queryEmbedding)

    for (const row of rows) {
      const stored = new Float32Array(row.embedding.buffer)
      const sim = this.cosineSimilarity(
        queryEmbedding,
        Array.from(stored),
        queryNorm,
      )
      if (sim >= minSimilarity) {
        results.push({ id: row.id, similarity: sim })
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_vectors WHERE id = ?').run(id)
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM memory_vectors')
      .get() as any
    return row?.count ?? 0
  }

  private cosineSimilarity(a: number[], b: number[], aNorm?: number): number {
    if (a.length !== b.length) return 0
    let dot = 0
    let normB = 0
    const normA = aNorm ?? this.norm(a)
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normB += b[i] * b[i]
    }
    normB = Math.sqrt(normB)
    if (normA === 0 || normB === 0) return 0
    return dot / (normA * normB)
  }

  private norm(v: number[]): number {
    let sum = 0
    for (const x of v) sum += x * x
    return Math.sqrt(sum)
  }
}
