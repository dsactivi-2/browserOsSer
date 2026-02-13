import type {
  Connector,
  ConnectorEvent,
  ConnectorType,
} from '../connector-interface'

export class RestConnector implements Connector {
  readonly type: ConnectorType = 'rest'
  readonly name = 'REST'
  private baseUrl = ''
  private headers: Record<string, string> = {}

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.baseUrl = config.baseUrl as string
    this.headers = (config.headers as Record<string, string>) ?? {}
  }

  async send(event: ConnectorEvent): Promise<boolean> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(event),
    })
    return response.ok
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl, { method: 'HEAD' })
      return response.ok
    } catch {
      return false
    }
  }

  async shutdown(): Promise<void> {}
}
