import { Database } from 'bun:sqlite'

export interface SessionData {
  conversationId: string
  history: Array<{ role: string; content: string; timestamp: string }>
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  messageCount: number
}

export class PersistentSessionManager {
  private db: Database
  private cache = new Map<string, SessionData>()

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        token_count INTEGER,
        is_compressed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_conv ON session_messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_session_messages_ts ON session_messages(conversation_id, timestamp);
    `)
  }

  // Create or get session — returns full history
  getOrCreate(conversationId: string): SessionData {
    const cached = this.cache.get(conversationId)
    if (cached) return cached

    const row = this.db
      .prepare('SELECT * FROM sessions WHERE conversation_id = ?')
      .get(conversationId) as any

    if (row) {
      const messages = this.db
        .prepare(
          'SELECT role, content, timestamp FROM session_messages WHERE conversation_id = ? ORDER BY id ASC',
        )
        .all(conversationId) as any[]

      const data: SessionData = {
        conversationId: row.conversation_id,
        history: messages,
        metadata: JSON.parse(row.metadata),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
      }
      this.cache.set(conversationId, data)
      return data
    }

    // Create new session
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO sessions (conversation_id, created_at, updated_at) VALUES (?, ?, ?)',
      )
      .run(conversationId, now, now)

    const data: SessionData = {
      conversationId,
      history: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    this.cache.set(conversationId, data)
    return data
  }

  // Append message to session (persists immediately)
  addMessage(
    conversationId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO session_messages (conversation_id, role, content, timestamp, token_count) VALUES (?, ?, ?, ?, ?)',
      )
      .run(conversationId, role, content, now, tokenCount ?? null)

    this.db
      .prepare(
        'UPDATE sessions SET updated_at = ?, message_count = message_count + 1 WHERE conversation_id = ?',
      )
      .run(now, conversationId)

    // Update cache
    const cached = this.cache.get(conversationId)
    if (cached) {
      cached.history.push({ role, content, timestamp: now })
      cached.messageCount += 1
      cached.updatedAt = now
    }
  }

  // Get recent messages (last N)
  getRecentMessages(
    conversationId: string,
    limit: number,
  ): Array<{ role: string; content: string; timestamp: string }> {
    return this.db
      .prepare(
        'SELECT role, content, timestamp FROM session_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(conversationId, limit)
      .reverse() as any[]
  }

  // Get full message count
  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare('SELECT message_count FROM sessions WHERE conversation_id = ?')
      .get(conversationId) as any
    return row?.message_count ?? 0
  }

  // Mark old messages as compressed
  compressMessages(
    conversationId: string,
    olderThanId: number,
    summary: string,
  ): void {
    this.db
      .prepare(
        'UPDATE session_messages SET is_compressed = 1 WHERE conversation_id = ? AND id <= ?',
      )
      .run(conversationId, olderThanId)

    // Insert summary message
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO session_messages (conversation_id, role, content, timestamp, is_compressed) VALUES (?, ?, ?, ?, 0)',
      )
      .run(conversationId, 'system', `[CONTEXT SUMMARY]\n${summary}`, now)
  }

  // Delete session
  delete(conversationId: string): boolean {
    this.cache.delete(conversationId)
    const result = this.db
      .prepare('DELETE FROM sessions WHERE conversation_id = ?')
      .run(conversationId)
    return result.changes > 0
  }

  // List all sessions
  listSessions(limit: number = 50): Array<{
    conversationId: string
    messageCount: number
    createdAt: string
    updatedAt: string
  }> {
    return this.db
      .prepare(
        'SELECT conversation_id, message_count, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?',
      )
      .all(limit) as any[]
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as c FROM sessions')
      .get() as any
    return row?.c ?? 0
  }

  close(): void {
    this.db.close()
  }
}
