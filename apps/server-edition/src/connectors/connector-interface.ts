export type ConnectorType =
  | 'rest'
  | 'webhook'
  | 'github'
  | 'slack'
  | 'linear'
  | 'n8n'
  | 'bullmq'

export interface ConnectorConfig {
  id: string
  type: ConnectorType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt: string
}

export interface ConnectorEvent {
  type:
    | 'task_completed'
    | 'task_failed'
    | 'batch_completed'
    | 'pattern_learned'
    | 'experiment_concluded'
  taskId?: string
  batchId?: string
  data: Record<string, unknown>
  timestamp: string
}

export interface Connector {
  readonly type: ConnectorType
  readonly name: string
  initialize(config: Record<string, unknown>): Promise<void>
  send(event: ConnectorEvent): Promise<boolean>
  healthCheck(): Promise<boolean>
  shutdown(): Promise<void>
}
