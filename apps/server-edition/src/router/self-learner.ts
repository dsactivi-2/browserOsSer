import type { Database } from 'bun:sqlite'
import { ROUTER_CONFIG } from '@browseros/shared/constants/router'
import type { RouterMetrics } from './router-metrics'
import type { RoutingTable } from './routing-table'
import type { AggregatedMetrics } from './types'

export interface SelfLearnerConfig {
  optimizationInterval: number
  downgradeTestInterval: number
  downgradeTestSampleSize: number
  minCallsForOptimization: number
}

export class SelfLearner {
  private db: Database
  private routingTable: RoutingTable
  private metrics: RouterMetrics
  private config: SelfLearnerConfig
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    db: Database,
    routingTable: RoutingTable,
    metrics: RouterMetrics,
    config?: Partial<SelfLearnerConfig>,
  ) {
    this.db = db
    this.routingTable = routingTable
    this.metrics = metrics
    this.config = {
      optimizationInterval: config?.optimizationInterval ?? 60_000,
      downgradeTestInterval:
        config?.downgradeTestInterval ?? ROUTER_CONFIG.DOWNGRADE_TEST_INTERVAL,
      downgradeTestSampleSize:
        config?.downgradeTestSampleSize ??
        ROUTER_CONFIG.DOWNGRADE_TEST_SAMPLE_SIZE,
      minCallsForOptimization: config?.minCallsForOptimization ?? 10,
    }
    this.initializeDb()
  }

  private initializeDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_optimizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        old_provider TEXT NOT NULL,
        old_model TEXT NOT NULL,
        new_provider TEXT NOT NULL,
        new_model TEXT NOT NULL,
        reason TEXT NOT NULL,
        old_success_rate REAL,
        new_success_rate REAL,
        cost_savings REAL,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS downgrade_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        test_provider TEXT NOT NULL,
        test_model TEXT NOT NULL,
        sample_size INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
    `)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(
      () => this.runOptimization(),
      this.config.optimizationInterval,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  runOptimization(): void {
    this.optimizeBySuccessRate()
    this.scheduleDowngradeTests()
    this.evaluateDowngradeTests()
  }

  private optimizeBySuccessRate(): void {
    const aggregated = this.metrics.getAggregated()
    const byTool = this.groupByTool(aggregated)

    for (const [toolName, toolMetrics] of byTool) {
      if (toolMetrics.length === 0) continue

      const current = this.routingTable.resolve(toolName)
      const currentMetrics = toolMetrics.find(
        (m) => m.provider === current.provider && m.model === current.model,
      )

      if (
        !currentMetrics ||
        currentMetrics.totalCalls < this.config.minCallsForOptimization
      )
        continue

      if (
        currentMetrics.successRate <
        ROUTER_CONFIG.SUCCESS_RATE_UPGRADE_THRESHOLD
      ) {
        this.upgradeModel(toolName, currentMetrics)
      }
    }
  }

  private scheduleDowngradeTests(): void {
    const totalCalls = this.metrics.getTotalCalls()
    if (totalCalls % this.config.downgradeTestInterval !== 0) return

    const pendingTests = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM downgrade_tests WHERE status = 'pending'",
      )
      .get() as any
    if (pendingTests?.c > 3) return

    const candidates = this.metrics
      .getAggregated()
      .filter((m) => m.successRate >= 0.95 && m.totalCalls >= 20)
      .filter((m) => m.model.includes('opus') || m.model.includes('sonnet'))

    for (const candidate of candidates.slice(0, 2)) {
      const cheaperModel = candidate.model.includes('opus')
        ? 'claude-sonnet-4-5-20250929'
        : 'claude-haiku-4-5-20251001'

      this.db
        .prepare(`
        INSERT INTO downgrade_tests (tool_name, test_provider, test_model, started_at)
        VALUES (?, ?, ?, ?)
      `)
        .run(
          candidate.toolName,
          candidate.provider,
          cheaperModel,
          new Date().toISOString(),
        )
    }
  }

  private evaluateDowngradeTests(): void {
    const tests = this.db
      .prepare(
        "SELECT * FROM downgrade_tests WHERE status = 'pending' AND sample_size >= ?",
      )
      .all(this.config.downgradeTestSampleSize) as any[]

    for (const test of tests) {
      const successRate =
        test.sample_size > 0 ? test.success_count / test.sample_size : 0

      if (successRate >= ROUTER_CONFIG.SUCCESS_RATE_KEEP_THRESHOLD) {
        this.routingTable.setOverride(
          test.tool_name,
          test.test_provider,
          test.test_model,
          `Downgrade test passed: ${(successRate * 100).toFixed(1)}% success`,
        )
        this.logOptimization(
          test.tool_name,
          '',
          '',
          test.test_provider,
          test.test_model,
          `Downgrade successful: ${(successRate * 100).toFixed(1)}%`,
          0,
          successRate,
          0,
        )
      }

      this.db
        .prepare(
          'UPDATE downgrade_tests SET status = ?, completed_at = ? WHERE id = ?',
        )
        .run(
          successRate >= ROUTER_CONFIG.SUCCESS_RATE_KEEP_THRESHOLD
            ? 'passed'
            : 'failed',
          new Date().toISOString(),
          test.id,
        )
    }
  }

  recordDowngradeTestResult(
    toolName: string,
    model: string,
    success: boolean,
  ): void {
    this.db
      .prepare(`
      UPDATE downgrade_tests SET sample_size = sample_size + 1, success_count = success_count + ?
      WHERE tool_name = ? AND test_model = ? AND status = 'pending'
    `)
      .run(success ? 1 : 0, toolName, model)
  }

  private upgradeModel(
    toolName: string,
    currentMetrics: AggregatedMetrics,
  ): void {
    let newModel = currentMetrics.model
    const newProvider = currentMetrics.provider

    if (currentMetrics.model.includes('haiku')) {
      newModel = 'claude-sonnet-4-5-20250929'
    } else if (currentMetrics.model.includes('sonnet')) {
      newModel = 'claude-opus-4-6'
    }

    if (newModel !== currentMetrics.model) {
      this.routingTable.setOverride(
        toolName,
        newProvider,
        newModel,
        `Auto-upgraded: success rate was ${(currentMetrics.successRate * 100).toFixed(1)}%`,
      )
      this.logOptimization(
        toolName,
        currentMetrics.provider,
        currentMetrics.model,
        newProvider,
        newModel,
        'Auto-upgrade due to low success rate',
        currentMetrics.successRate,
        0,
        0,
      )
    }
  }

  private logOptimization(
    toolName: string,
    oldProvider: string,
    oldModel: string,
    newProvider: string,
    newModel: string,
    reason: string,
    oldRate: number,
    newRate: number,
    savings: number,
  ): void {
    this.db
      .prepare(`
      INSERT INTO routing_optimizations (tool_name, old_provider, old_model, new_provider, new_model, reason, old_success_rate, new_success_rate, cost_savings, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        toolName,
        oldProvider,
        oldModel,
        newProvider,
        newModel,
        reason,
        oldRate,
        newRate,
        savings,
        new Date().toISOString(),
      )
  }

  getHistory(limit: number = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        'SELECT * FROM routing_optimizations ORDER BY timestamp DESC LIMIT ?',
      )
      .all(limit) as any[]
  }

  private groupByTool(
    metrics: AggregatedMetrics[],
  ): Map<string, AggregatedMetrics[]> {
    const map = new Map<string, AggregatedMetrics[]>()
    for (const m of metrics) {
      const list = map.get(m.toolName) ?? []
      list.push(m)
      map.set(m.toolName, list)
    }
    return map
  }
}
