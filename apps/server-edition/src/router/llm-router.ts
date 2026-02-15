import type { Database } from 'bun:sqlite'
import type { LLMConfig } from '@browseros/shared/schemas/llm'
import { type ProviderCredentials, ProviderPool } from './provider-pool'
import { RouterMetrics } from './router-metrics'
import { RoutingTable } from './routing-table'
import { SelfLearner } from './self-learner'
import type {
  AggregatedMetrics,
  RouteDecision,
  RouterMetricEntry,
} from './types'

export interface LLMRouterConfig {
  db: Database
  providers?: ProviderCredentials[]
  enableSelfLearning?: boolean
}

export class LLMRouter {
  private routingTable: RoutingTable
  private providerPool: ProviderPool
  private metrics: RouterMetrics
  private db: Database
  private enableSelfLearning: boolean
  private selfLearner: SelfLearner | null = null

  constructor(config: LLMRouterConfig) {
    this.db = config.db

    this.routingTable = new RoutingTable(this.db)
    this.providerPool = new ProviderPool()
    this.metrics = new RouterMetrics(this.db)
    this.enableSelfLearning = config.enableSelfLearning ?? false

    if (this.enableSelfLearning) {
      this.selfLearner = new SelfLearner(
        this.db,
        this.routingTable,
        this.metrics,
      )
    }

    if (config.providers) {
      this.providerPool.registerMultiple(config.providers)
    }
  }

  route(toolName: string): RouteDecision {
    const decision = this.routingTable.resolve(toolName)

    if (!this.providerPool.isAvailable(decision.provider)) {
      const availableProviders = this.providerPool.getAvailableProviders()
      const fallback = availableProviders.find((p) => p !== decision.provider)

      if (fallback) {
        return {
          provider: fallback,
          model: decision.model,
          reason: 'fallback',
        }
      }

      return {
        ...decision,
        reason: 'no_available_provider',
      }
    }

    return decision
  }

  buildConfigForTool(toolName: string): LLMConfig | null {
    const decision = this.route(toolName)
    return this.providerPool.buildLLMConfig(decision.provider, decision.model)
  }

  recordMetric(entry: RouterMetricEntry): void {
    this.metrics.record(entry)
  }

  getMetrics(toolName?: string): AggregatedMetrics[] {
    return this.metrics.getAggregated(toolName)
  }

  getRoutingTable() {
    return this.routingTable.getAll()
  }

  registerProvider(creds: ProviderCredentials): void {
    this.providerPool.register(creds)
  }

  startSelfLearning(): void {
    if (!this.enableSelfLearning || !this.selfLearner) return
    this.selfLearner.start()
  }

  stopSelfLearning(): void {
    if (this.selfLearner) {
      this.selfLearner.stop()
    }
  }

  getSelfLearner(): SelfLearner | null {
    return this.selfLearner
  }

  close(): void {
    this.stopSelfLearning()
  }
}
