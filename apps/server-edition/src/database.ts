import { Database } from 'bun:sqlite'

let instance: Database | null = null

export const DatabaseProvider = {
  create(dbPath: string): Database {
    if (instance) return instance
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    instance = db
    return db
  },

  close(): void {
    if (instance) {
      instance.close()
      instance = null
    }
  },

  get(): Database | null {
    return instance
  },
}
