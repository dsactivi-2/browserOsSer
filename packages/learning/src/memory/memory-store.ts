import type { Database } from 'bun:sqlite'
import type {
  MemoryEntry,
  MemorySearchResult,
  MemoryStoreConfig,
} from './types'
import { VectorDB } from './vector-db'

interface MemoryEntryRow {
  id: string
  type: string
  session_id: string
  content: string
  role: string
  metadata: string
  relevance_score: number
  is_compressed: number
  compressed_at: string | null
  original_token_count: number | null
  compressed_token_count: number | null
  created_at: string
  updated_at: string
}

interface CountRow {
  c: number
}

interface TypeCountRow {
  type: string
  c: number
}

export class MemoryStore {
  private db: Database
  private vectorDb: VectorDB
  private config: MemoryStoreConfig

  constructor(db: Database, config: MemoryStoreConfig) {
    this.config = config
    this.db = db
    this.vectorDb = new VectorDB(this.db)
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('short_term', 'long_term', 'cross_session')),
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        role TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        relevance_score REAL NOT NULL DEFAULT 1.0,
        is_compressed INTEGER NOT NULL DEFAULT 0,
        compressed_at TEXT,
        original_token_count INTEGER,
        compressed_token_count INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
      CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_relevance ON memory_entries(relevance_score DESC);
    `)
  }

  add(entry: Omit<MemoryEntry, 'id'>): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(`
      INSERT INTO memory_entries (id, type, session_id, content, role, metadata, relevance_score, is_compressed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        entry.type,
        entry.sessionId,
        entry.content,
        entry.role,
        JSON.stringify(entry.metadata),
        entry.relevanceScore,
        entry.isCompressed ? 1 : 0,
        now,
        now,
      )

    if (entry.embedding) {
      this.vectorDb.store(id, entry.embedding, entry.sessionId)
    }
    return id
  }

  get(id: string): MemoryEntry | null {
    const row = this.db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id) as MemoryEntryRow | null
    if (!row) return null
    return this.rowToEntry(row)
  }

  getBySession(
    sessionId: string,
    type?: string,
    limit?: number,
  ): MemoryEntry[] {
    let query = 'SELECT * FROM memory_entries WHERE session_id = ?'
    const params: unknown[] = [sessionId]
    if (type) {
      query += ' AND type = ?'
      params.push(type)
    }
    query += ' ORDER BY created_at ASC'
    if (limit) {
      query += ' LIMIT ?'
      params.push(limit)
    }
    return (
      this.db.prepare(query).all(...(params as string[])) as MemoryEntryRow[]
    ).map(this.rowToEntry)
  }

  searchByVector(
    queryEmbedding: number[],
    limit: number = 10,
    minSimilarity: number = 0.0,
    sessionId?: string,
  ): MemorySearchResult[] {
    const vectorResults = this.vectorDb.search(
      queryEmbedding,
      limit,
      minSimilarity,
      sessionId,
    )
    return vectorResults
      .map((vr) => ({
        entry: this.get(vr.id)!,
        similarity: vr.similarity,
      }))
      .filter((r) => r.entry !== null)
  }

  updateRelevance(id: string, score: number): void {
    this.db
      .prepare(
        'UPDATE memory_entries SET relevance_score = ?, updated_at = ? WHERE id = ?',
      )
      .run(score, new Date().toISOString(), id)
  }

  compress(
    id: string,
    compressedContent: string,
    compressedTokens: number,
  ): void {
    this.db
      .prepare(`
      UPDATE memory_entries SET content = ?, is_compressed = 1, compressed_at = ?, compressed_token_count = ?, updated_at = ? WHERE id = ?
    `)
      .run(
        compressedContent,
        new Date().toISOString(),
        compressedTokens,
        new Date().toISOString(),
        id,
      )
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id)
    this.vectorDb.delete(id)
  }

  getStats(sessionId?: string): {
    total: number
    byType: Record<string, number>
    compressed: number
  } {
    const where = sessionId ? 'WHERE session_id = ?' : ''
    const params = sessionId ? [sessionId] : []

    const total =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM memory_entries ${where}`)
          .get(...(params as string[])) as CountRow | null
      )?.c ?? 0
    const compressed =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM memory_entries ${where} ${where ? 'AND' : 'WHERE'} is_compressed = 1`,
          )
          .get(...(params as string[])) as CountRow | null
      )?.c ?? 0

    const typeRows = this.db
      .prepare(
        `SELECT type, COUNT(*) as c FROM memory_entries ${where} GROUP BY type`,
      )
      .all(...(params as string[])) as TypeCountRow[]
    const byType: Record<string, number> = {}
    for (const row of typeRows) byType[row.type] = row.c

    return { total, byType, compressed }
  }

  close(): void {
    // DB lifecycle managed by DatabaseProvider — nothing to close here
  }

  private rowToEntry(row: MemoryEntryRow): MemoryEntry {
    return {
      id: row.id,
      type: row.type,
      sessionId: row.session_id,
      content: row.content,
      role: row.role,
      metadata: JSON.parse(row.metadata),
      relevanceScore: row.relevance_score,
      isCompressed: row.is_compressed === 1,
      compressedAt: row.compressed_at,
      createdAt: row.created_at,
    }
  }
}
