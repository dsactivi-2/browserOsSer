import type { Database } from 'bun:sqlite'
import type {
  Connector,
  ConnectorConfig,
  ConnectorEvent,
  ConnectorType,
} from './connector-interface'

export class ConnectorManager {
  private db: Database
  private connectors = new Map<string, Connector>()
  private configs = new Map<string, ConnectorConfig>()

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `)
  }

  private factories = new Map<
    ConnectorType,
    (config: Record<string, unknown>) => Connector
  >()

  registerFactory(
    type: ConnectorType,
    factory: (config: Record<string, unknown>) => Connector,
  ): void {
    this.factories.set(type, factory)
  }

  async addConnector(
    type: ConnectorType,
    name: string,
    config: Record<string, unknown>,
  ): Promise<string> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    const factory = this.factories.get(type)
    if (!factory) throw new Error(`No factory for connector type: ${type}`)

    const connector = factory(config)
    await connector.initialize(config)

    this.connectors.set(id, connector)
    const connConfig: ConnectorConfig = {
      id,
      type,
      name,
      enabled: true,
      config,
      createdAt: now,
    }
    this.configs.set(id, connConfig)

    this.db
      .prepare(
        'INSERT INTO connectors (id, type, name, config, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, type, name, JSON.stringify(config), now)

    return id
  }

  async removeConnector(id: string): Promise<boolean> {
    const connector = this.connectors.get(id)
    if (connector) {
      await connector.shutdown()
      this.connectors.delete(id)
      this.configs.delete(id)
    }
    const result = this.db
      .prepare('DELETE FROM connectors WHERE id = ?')
      .run(id)
    return result.changes > 0
  }

  async broadcast(event: ConnectorEvent): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    for (const [id, connector] of this.connectors) {
      const config = this.configs.get(id)
      if (!config?.enabled) continue
      try {
        const success = await connector.send(event)
        results.set(id, success)
      } catch {
        results.set(id, false)
      }
    }
    return results
  }

  listConnectors(): ConnectorConfig[] {
    return Array.from(this.configs.values())
  }

  async getHealth(id: string): Promise<boolean> {
    const connector = this.connectors.get(id)
    if (!connector) return false
    try {
      return await connector.healthCheck()
    } catch {
      return false
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    const config = this.configs.get(id)
    if (config) config.enabled = enabled
    this.db
      .prepare('UPDATE connectors SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id)
  }

  async shutdownAll(): Promise<void> {
    for (const connector of this.connectors.values()) {
      await connector.shutdown().catch((err) => {
        console.warn(
          'Connector shutdown error:',
          err instanceof Error ? err.message : err,
        )
      })
    }
    this.connectors.clear()
    // DB lifecycle managed by DatabaseProvider — nothing to close here
  }
}
