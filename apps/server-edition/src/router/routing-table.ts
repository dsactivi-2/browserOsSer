import type { Database } from 'bun:sqlite'
import {
  DEFAULT_ROUTING_TABLE,
  type ToolModelMapping,
} from '@browseros/shared/constants/router'
import type { LLMProvider } from '@browseros/shared/schemas/llm'
import type { RouteDecision } from './types'

export class RoutingTable {
  private mappings: Map<string, ToolModelMapping>
  private overrides: Map<string, { provider: LLMProvider; model: string }>
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.mappings = new Map()
    this.overrides = new Map()
    this.initialize()
  }

  private initialize(): void {
    // Create overrides table for persisted routing changes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_overrides (
        tool_pattern TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL
      )
    `)

    // Load default mappings
    for (const mapping of DEFAULT_ROUTING_TABLE) {
      this.mappings.set(mapping.toolPattern, mapping)
    }

    // Load persisted overrides
    const rows = this.db
      .prepare('SELECT * FROM routing_overrides')
      .all() as any[]
    for (const row of rows) {
      this.overrides.set(row.tool_pattern, {
        provider: row.provider,
        model: row.model,
      })
    }
  }

  resolve(toolName: string): RouteDecision {
    // Check overrides first (learned optimizations)
    const override = this.findOverride(toolName)
    if (override) {
      return { ...override, reason: 'optimized' }
    }

    // Find matching default mapping
    const mapping = this.findMapping(toolName)
    if (mapping) {
      return {
        provider: mapping.defaultProvider,
        model: mapping.defaultModel,
        reason: 'default',
      }
    }

    // Fallback: standard tier
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      reason: 'fallback',
    }
  }

  setOverride(
    toolPattern: string,
    provider: LLMProvider,
    model: string,
    reason?: string,
  ): void {
    this.overrides.set(toolPattern, { provider, model })
    this.db
      .prepare(`
      INSERT INTO routing_overrides (tool_pattern, provider, model, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tool_pattern) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `)
      .run(
        toolPattern,
        provider,
        model,
        reason ?? null,
        new Date().toISOString(),
      )
  }

  removeOverride(toolPattern: string): void {
    this.overrides.delete(toolPattern)
    this.db
      .prepare('DELETE FROM routing_overrides WHERE tool_pattern = ?')
      .run(toolPattern)
  }

  getAll(): Array<{
    toolPattern: string
    provider: LLMProvider
    model: string
    category: string
    isOverride: boolean
  }> {
    const result: Array<{
      toolPattern: string
      provider: LLMProvider
      model: string
      category: string
      isOverride: boolean
    }> = []

    for (const [pattern, mapping] of this.mappings) {
      const override = this.overrides.get(pattern)
      result.push({
        toolPattern: pattern,
        provider: override?.provider ?? mapping.defaultProvider,
        model: override?.model ?? mapping.defaultModel,
        category: mapping.category,
        isOverride: !!override,
      })
    }

    return result
  }

  private findMapping(toolName: string): ToolModelMapping | undefined {
    // Exact match first
    const exact = this.mappings.get(toolName)
    if (exact) return exact

    // Wildcard match (e.g., "browser_tab_*" matches "browser_tab_close")
    for (const [pattern, mapping] of this.mappings) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1)
        if (toolName.startsWith(prefix)) return mapping
      }
    }

    return undefined
  }

  private findOverride(
    toolName: string,
  ): { provider: LLMProvider; model: string } | undefined {
    const exact = this.overrides.get(toolName)
    if (exact) return exact

    for (const [pattern, override] of this.overrides) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1)
        if (toolName.startsWith(prefix)) return override
      }
    }

    return undefined
  }
}
