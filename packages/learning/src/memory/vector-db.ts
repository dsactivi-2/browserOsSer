import type { Database } from 'bun:sqlite'

interface CacheEntry {
  id: string
  embedding: Float32Array
  norm: number
}

export class VectorDB {
  private db: Database
  private cache: Map<string, CacheEntry>
  private readonly MAX_CACHE_SIZE = 500

  constructor(db: Database) {
    this.db = db
    this.cache = new Map()
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_created ON memory_vectors(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_session ON memory_vectors(session_id);
    `)
  }

  store(id: string, embedding: number[], sessionId?: string): void {
    const buffer = new Float32Array(embedding).buffer
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memory_vectors (id, embedding, dimension, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        id,
        Buffer.from(buffer),
        embedding.length,
        sessionId ?? null,
        new Date().toISOString(),
      )
    this.invalidateCache()
  }

  search(
    queryEmbedding: number[],
    limit: number = 10,
    minSimilarity: number = 0.0,
    sessionId?: string,
  ): Array<{ id: string; similarity: number }> {
    const BATCH_LIMIT = 1000

    let query = 'SELECT id, embedding, dimension FROM memory_vectors'
    const params: unknown[] = []

    if (sessionId) {
      query += ' WHERE session_id = ?'
      params.push(sessionId)
    }

    query += ' ORDER BY created_at DESC LIMIT ?'
    params.push(BATCH_LIMIT)

    const rows = this.db.prepare(query).all(...params) as any[]

    const results: Array<{ id: string; similarity: number }> = []
    const queryVec = new Float32Array(queryEmbedding)
    const queryNorm = this.normFast(queryVec)

    for (const row of rows) {
      let cached = this.cache.get(row.id)

      if (!cached) {
        const storedVec = new Float32Array(row.embedding.buffer)
        const storedNorm = this.normFast(storedVec)
        cached = { id: row.id, embedding: storedVec, norm: storedNorm }
        this.addToCache(cached)
      }

      const sim = this.cosineSimilarityFast(
        queryVec,
        cached.embedding,
        queryNorm,
        cached.norm,
      )

      if (sim >= minSimilarity) {
        results.push({ id: row.id, similarity: sim })
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_vectors WHERE id = ?').run(id)
    this.cache.delete(id)
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM memory_vectors')
      .get() as any
    return row?.count ?? 0
  }

  private cosineSimilarityFast(
    a: Float32Array,
    b: Float32Array,
    aNorm: number,
    bNorm: number,
  ): number {
    if (a.length !== b.length || aNorm === 0 || bNorm === 0) return 0
    let dot = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
    }
    return dot / (aNorm * bNorm)
  }

  private normFast(v: Float32Array): number {
    let sum = 0
    for (let i = 0; i < v.length; i++) {
      sum += v[i] * v[i]
    }
    return Math.sqrt(sum)
  }

  private addToCache(entry: CacheEntry): void {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(entry.id, entry)
  }

  private invalidateCache(): void {
    this.cache.clear()
  }
}
