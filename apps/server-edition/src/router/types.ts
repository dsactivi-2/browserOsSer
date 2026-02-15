import type { LLMProvider } from '@browseros/shared/schemas/llm'

export interface RouterMetricEntry {
  toolName: string
  provider: LLMProvider
  model: string
  success: boolean
  latencyMs: number
  estimatedCost: number
  timestamp: string
}

export interface AggregatedMetrics {
  toolName: string
  provider: LLMProvider
  model: string
  totalCalls: number
  successCount: number
  failureCount: number
  successRate: number
  avgLatencyMs: number
  totalCost: number
  lastUsed: string
}

export interface RouteDecision {
  provider: LLMProvider
  model: string
  reason:
    | 'default'
    | 'optimized'
    | 'fallback'
    | 'downgrade_test'
    | 'no_available_provider'
}
