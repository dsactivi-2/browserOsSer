import type {
  Connector,
  ConnectorEvent,
  ConnectorType,
} from '../connector-interface'

export class WebhookConnector implements Connector {
  readonly type: ConnectorType = 'webhook'
  readonly name = 'Webhook'
  private url = ''
  private secret = ''
  private events: string[] = []

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.url = config.url as string
    this.secret = (config.secret as string) ?? ''
    this.events = (config.events as string[]) ?? []
  }

  async send(event: ConnectorEvent): Promise<boolean> {
    if (this.events.length > 0 && !this.events.includes(event.type)) return true

    const body = JSON.stringify(event)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.secret) {
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(this.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(body),
      )
      headers['X-Signature-256'] =
        `sha256=${Buffer.from(signature).toString('hex')}`
    }

    const response = await fetch(this.url, { method: 'POST', headers, body })
    return response.ok
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.url, { method: 'HEAD' })
      return response.ok
    } catch {
      return false
    }
  }

  async shutdown(): Promise<void> {}
}
