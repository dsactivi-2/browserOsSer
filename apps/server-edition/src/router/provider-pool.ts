import type { LLMConfig, LLMProvider } from '@browseros/shared/schemas/llm'

export interface ProviderCredentials {
  provider: LLMProvider
  apiKey?: string
  baseUrl?: string
  resourceName?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export class ProviderPool {
  private credentials = new Map<string, ProviderCredentials>()

  register(creds: ProviderCredentials): void {
    this.credentials.set(creds.provider, creds)
  }

  registerMultiple(credsList: ProviderCredentials[]): void {
    for (const creds of credsList) {
      this.register(creds)
    }
  }

  get(provider: LLMProvider): ProviderCredentials | undefined {
    return this.credentials.get(provider)
  }

  isAvailable(provider: LLMProvider): boolean {
    return this.credentials.has(provider)
  }

  getAvailableProviders(): LLMProvider[] {
    return Array.from(this.credentials.keys()) as LLMProvider[]
  }

  buildLLMConfig(provider: LLMProvider, model: string): LLMConfig | null {
    const creds = this.credentials.get(provider)
    if (!creds) return null

    return {
      provider,
      model,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      resourceName: creds.resourceName,
      region: creds.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }
  }
}
