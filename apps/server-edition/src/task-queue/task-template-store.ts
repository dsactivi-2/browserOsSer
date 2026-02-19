import type { Database } from 'bun:sqlite'

export interface TemplateParameter {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  default?: string | number | boolean
  description?: string
}

export interface TaskTemplate {
  id: string
  name: string
  description: string
  instruction: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  parameters: TemplateParameter[]
  timeout?: number
  retryPolicy?: { maxRetries: number; backoffMs: number }
  llmConfig?: { provider?: string; model?: string }
  metadata?: Record<string, unknown>
  usageCount: number
  createdAt: string
  updatedAt: string
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export class TaskTemplateStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instruction TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        parameters TEXT NOT NULL DEFAULT '[]',
        timeout INTEGER,
        retry_policy TEXT,
        llm_config TEXT,
        metadata TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_templates_name ON task_templates(name);
    `)
  }

  create(
    template: Omit<
      TaskTemplate,
      'id' | 'usageCount' | 'createdAt' | 'updatedAt'
    >,
  ): string {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(`
        INSERT INTO task_templates (id, name, description, instruction, priority, parameters, timeout, retry_policy, llm_config, metadata, usage_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `)
      .run(
        id,
        template.name,
        template.description,
        template.instruction,
        template.priority,
        JSON.stringify(template.parameters),
        template.timeout ?? null,
        template.retryPolicy ? JSON.stringify(template.retryPolicy) : null,
        template.llmConfig ? JSON.stringify(template.llmConfig) : null,
        template.metadata ? JSON.stringify(template.metadata) : null,
        now,
        now,
      )

    return id
  }

  get(id: string): TaskTemplate | null {
    const row = this.db
      .prepare('SELECT * FROM task_templates WHERE id = ?')
      .get(id) as any
    if (!row) return null
    return this.rowToTemplate(row)
  }

  list(): TaskTemplate[] {
    const rows = this.db
      .prepare('SELECT * FROM task_templates ORDER BY created_at DESC')
      .all() as any[]
    return rows.map((row) => this.rowToTemplate(row))
  }

  update(
    id: string,
    updates: Partial<
      Pick<
        TaskTemplate,
        | 'name'
        | 'description'
        | 'instruction'
        | 'priority'
        | 'parameters'
        | 'timeout'
        | 'retryPolicy'
        | 'llmConfig'
        | 'metadata'
      >
    >,
  ): boolean {
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.name !== undefined) {
      fields.push('name = ?')
      values.push(updates.name)
    }
    if (updates.description !== undefined) {
      fields.push('description = ?')
      values.push(updates.description)
    }
    if (updates.instruction !== undefined) {
      fields.push('instruction = ?')
      values.push(updates.instruction)
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?')
      values.push(updates.priority)
    }
    if (updates.parameters !== undefined) {
      fields.push('parameters = ?')
      values.push(JSON.stringify(updates.parameters))
    }
    if ('timeout' in updates) {
      fields.push('timeout = ?')
      values.push(updates.timeout ?? null)
    }
    if ('retryPolicy' in updates) {
      fields.push('retry_policy = ?')
      values.push(
        updates.retryPolicy ? JSON.stringify(updates.retryPolicy) : null,
      )
    }
    if ('llmConfig' in updates) {
      fields.push('llm_config = ?')
      values.push(updates.llmConfig ? JSON.stringify(updates.llmConfig) : null)
    }
    if ('metadata' in updates) {
      fields.push('metadata = ?')
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null)
    }

    if (fields.length === 0) return false

    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    const result = this.db
      .prepare(`UPDATE task_templates SET ${fields.join(', ')} WHERE id = ?`)
      .run(...(values as string[]))

    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM task_templates WHERE id = ?')
      .run(id)
    return result.changes > 0
  }

  instantiate(id: string, params: Record<string, unknown>): object {
    const template = this.get(id)
    if (!template) throw new Error(`Template not found: ${id}`)

    const resolvedParams: Record<string, unknown> = {}

    for (const param of template.parameters) {
      const value = params[param.name] ?? param.default

      if (param.required && value === undefined) {
        throw new Error(`Missing required parameter: ${param.name}`)
      }

      if (value !== undefined) {
        if (param.type === 'number' && typeof value !== 'number') {
          const parsed = Number(value)
          if (Number.isNaN(parsed)) {
            throw new Error(
              `Parameter '${param.name}' must be a number, got: ${typeof value}`,
            )
          }
          resolvedParams[param.name] = parsed
        } else if (param.type === 'boolean' && typeof value !== 'boolean') {
          resolvedParams[param.name] = value === 'true' || value === true
        } else {
          resolvedParams[param.name] = value
        }
      }
    }

    let instruction = template.instruction
    for (const [key, value] of Object.entries(resolvedParams)) {
      instruction = instruction.replaceAll(`{{${key}}}`, String(value))
    }

    this.incrementUsage(id)

    return {
      instruction,
      priority: template.priority,
      ...(template.timeout !== undefined && { timeout: template.timeout }),
      ...(template.retryPolicy && { retryPolicy: template.retryPolicy }),
      ...(template.llmConfig && { llmConfig: template.llmConfig }),
      metadata: {
        ...(template.metadata ?? {}),
        templateId: id,
        templateName: template.name,
      },
    }
  }

  incrementUsage(id: string): void {
    this.db
      .prepare(
        'UPDATE task_templates SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), id)
  }

  private rowToTemplate(row: any): TaskTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instruction: row.instruction,
      priority: row.priority,
      parameters: safeJsonParse<TemplateParameter[]>(row.parameters, []),
      timeout: row.timeout ?? undefined,
      retryPolicy: safeJsonParse(row.retry_policy, undefined),
      llmConfig: safeJsonParse(row.llm_config, undefined),
      metadata: safeJsonParse(row.metadata, undefined),
      usageCount: row.usage_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
