export interface PromptVariant {
  id: string
  templateName: string
  version: number
  content: string
  isActive: boolean
  isWinner: boolean
  successRate: number
  totalUses: number
  successCount: number
  failureCount: number
  avgLatencyMs: number
  createdAt: string
  promotedAt?: string
}

export interface ABExperiment {
  id: string
  templateName: string
  variantAId: string
  variantBId: string
  trafficSplitPercent: number
  minSampleSize: number
  status: 'running' | 'concluded' | 'cancelled'
  winnerId?: string
  startedAt: string
  concludedAt?: string
}

export interface PromptRegistryConfig {
  minSampleSize: number
  significanceThreshold: number
  autoPromoteEnabled: boolean
}
