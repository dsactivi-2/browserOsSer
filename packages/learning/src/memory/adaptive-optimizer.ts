import type { Database } from 'bun:sqlite'
import type { MemoryAnalyzer } from './memory-analyzer'
import { MemoryCompressor } from './memory-compressor'
import type { MemoryStore } from './memory-store'
import type { TokenBudgetManager } from './token-budget-manager'
import type { MemoryAction, MemoryEntry } from './types'

export interface AdaptiveOptimizerConfig {
  intervalMs: number
  minEntriesForOptimization: number
  targetUsageRatio: number
  learningRate: number
  maxHistoryEntries: number
}

interface OptimizationSnapshot {
  tokensBefore: number
  tokensAfter: number
  entriesCompressed: number
  entriesDropped: number
  entriesPromoted: number
  compressionTriggerRatio: number
  fullMessageWindow: number
  minRelevanceScore: number
  timestamp: string
}

export class AdaptiveTokenOptimizer {
  private db: Database
  private memoryStore: MemoryStore
  private analyzer: MemoryAnalyzer
  private budgetManager: TokenBudgetManager
  private compressor: MemoryCompressor
  private config: AdaptiveOptimizerConfig
  private timer: ReturnType<typeof setInterval> | null = null

  private currentCompressionTrigger: number
  private currentFullWindow: number
  private currentMinRelevance: number

  constructor(
    db: Database,
    memoryStore: MemoryStore,
    analyzer: MemoryAnalyzer,
    budgetManager: TokenBudgetManager,
    config?: Partial<AdaptiveOptimizerConfig>,
  ) {
    this.db = db
    this.memoryStore = memoryStore
    this.analyzer = analyzer
    this.budgetManager = budgetManager
    this.compressor = new MemoryCompressor()

    this.config = {
      intervalMs: config?.intervalMs ?? 120_000,
      minEntriesForOptimization: config?.minEntriesForOptimization ?? 10,
      targetUsageRatio: config?.targetUsageRatio ?? 0.65,
      learningRate: config?.learningRate ?? 0.05,
      maxHistoryEntries: config?.maxHistoryEntries ?? 500,
    }

    const budgetConfig = this.budgetManager.getConfig()
    this.currentCompressionTrigger = budgetConfig.compressionTriggerRatio
    this.currentFullWindow = budgetConfig.fullMessageWindow
    this.currentMinRelevance = 0.3

    this.initializeDb()
    this.restoreParameters()
  }

  private initializeDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS optimization_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tokens_before INTEGER NOT NULL,
        tokens_after INTEGER NOT NULL,
        entries_compressed INTEGER NOT NULL DEFAULT 0,
        entries_dropped INTEGER NOT NULL DEFAULT 0,
        entries_promoted INTEGER NOT NULL DEFAULT 0,
        compression_trigger REAL NOT NULL,
        full_message_window INTEGER NOT NULL,
        min_relevance REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adaptive_parameters (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  private restoreParameters(): void {
    const rows = this.db
      .prepare('SELECT key, value FROM adaptive_parameters')
      .all() as Array<{ key: string; value: number }>

    for (const row of rows) {
      switch (row.key) {
        case 'compression_trigger':
          this.currentCompressionTrigger = row.value
          break
        case 'full_window':
          this.currentFullWindow = Math.round(row.value)
          break
        case 'min_relevance':
          this.currentMinRelevance = row.value
          break
      }
    }
  }

  private saveParameter(key: string, value: number): void {
    this.db
      .prepare(`
      INSERT INTO adaptive_parameters (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
      .run(key, value, new Date().toISOString())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(
      () => this.runOptimization(),
      this.config.intervalMs,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  runOptimization(sessionId?: string): OptimizationSnapshot | null {
    const entries = sessionId
      ? this.memoryStore.getBySession(sessionId)
      : this.getAllEntries()

    if (entries.length < this.config.minEntriesForOptimization) return null

    const tokensBefore = this.calculateTotalTokens(entries)
    const budget = this.budgetManager.getAvailableBudget()
    const usageRatio = tokensBefore / budget

    const currentBudget = {
      maxTokens: budget,
      usedTokens: tokensBefore,
      remainingTokens: budget - tokensBefore,
      compressionThreshold: this.currentCompressionTrigger,
      messages: {
        total: entries.length,
        full: entries.filter((e) => !e.isCompressed).length,
        compressed: entries.filter((e) => e.isCompressed).length,
        dropped: 0,
      },
    }

    const analysis = this.analyzer.analyze(entries, currentBudget)
    const executed = this.executeActions(analysis.suggestedActions)

    const tokensAfter = this.calculateTotalTokens(
      sessionId
        ? this.memoryStore.getBySession(sessionId)
        : this.getAllEntries(),
    )

    this.adaptParameters(usageRatio, tokensBefore, tokensAfter, budget)

    const snapshot: OptimizationSnapshot = {
      tokensBefore,
      tokensAfter,
      entriesCompressed: executed.compressed,
      entriesDropped: executed.dropped,
      entriesPromoted: executed.promoted,
      compressionTriggerRatio: this.currentCompressionTrigger,
      fullMessageWindow: this.currentFullWindow,
      minRelevanceScore: this.currentMinRelevance,
      timestamp: new Date().toISOString(),
    }

    this.recordSnapshot(snapshot)
    this.pruneHistory()

    return snapshot
  }

  private executeActions(actions: MemoryAction[]): {
    compressed: number
    dropped: number
    promoted: number
  } {
    let compressed = 0
    let dropped = 0
    let promoted = 0

    for (const action of actions) {
      const entry = this.memoryStore.get(action.entryId)
      if (!entry) continue

      switch (action.type) {
        case 'compress': {
          if (entry.isCompressed) break
          const result = this.compressor.compressMessage(
            entry.content,
            entry.role,
          )
          this.memoryStore.compress(
            entry.id,
            result.compressedContent,
            result.compressedTokens,
          )
          compressed++
          break
        }
        case 'drop': {
          this.memoryStore.delete(entry.id)
          dropped++
          break
        }
        case 'promote': {
          this.memoryStore.updateRelevance(entry.id, 1.0)
          promoted++
          break
        }
      }
    }

    return { compressed, dropped, promoted }
  }

  private adaptParameters(
    usageRatio: number,
    tokensBefore: number,
    tokensAfter: number,
    budget: number,
  ): void {
    const target = this.config.targetUsageRatio
    const lr = this.config.learningRate
    const diff = usageRatio - target

    if (diff > 0.1) {
      this.currentCompressionTrigger = Math.max(
        0.4,
        this.currentCompressionTrigger - lr,
      )
      this.currentFullWindow = Math.max(10, this.currentFullWindow - 2)
      this.currentMinRelevance = Math.min(0.6, this.currentMinRelevance + lr)
    } else if (diff < -0.15) {
      this.currentCompressionTrigger = Math.min(
        0.85,
        this.currentCompressionTrigger + lr * 0.5,
      )
      this.currentFullWindow = Math.min(50, this.currentFullWindow + 1)
      this.currentMinRelevance = Math.max(
        0.15,
        this.currentMinRelevance - lr * 0.5,
      )
    }

    const savings = tokensBefore - tokensAfter
    const savingsRatio = tokensBefore > 0 ? savings / tokensBefore : 0

    if (savingsRatio < 0.05 && usageRatio > target) {
      this.currentCompressionTrigger = Math.max(
        0.35,
        this.currentCompressionTrigger - lr * 2,
      )
      this.currentMinRelevance = Math.min(
        0.7,
        this.currentMinRelevance + lr * 2,
      )
    }

    this.saveParameter('compression_trigger', this.currentCompressionTrigger)
    this.saveParameter('full_window', this.currentFullWindow)
    this.saveParameter('min_relevance', this.currentMinRelevance)
  }

  private calculateTotalTokens(entries: MemoryEntry[]): number {
    return entries.reduce(
      (sum, e) => sum + this.budgetManager.estimateTokens(e.content),
      0,
    )
  }

  private getAllEntries(): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    const sessions = this.db
      .prepare(
        'SELECT DISTINCT session_id FROM memory_entries ORDER BY created_at DESC LIMIT 20',
      )
      .all() as Array<{ session_id: string }>

    for (const row of sessions) {
      entries.push(...this.memoryStore.getBySession(row.session_id))
    }
    return entries
  }

  private recordSnapshot(snapshot: OptimizationSnapshot): void {
    this.db
      .prepare(`
      INSERT INTO optimization_snapshots
        (tokens_before, tokens_after, entries_compressed, entries_dropped, entries_promoted,
         compression_trigger, full_message_window, min_relevance, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        snapshot.tokensBefore,
        snapshot.tokensAfter,
        snapshot.entriesCompressed,
        snapshot.entriesDropped,
        snapshot.entriesPromoted,
        snapshot.compressionTriggerRatio,
        snapshot.fullMessageWindow,
        snapshot.minRelevanceScore,
        snapshot.timestamp,
      )
  }

  private pruneHistory(): void {
    this.db
      .prepare(`
      DELETE FROM optimization_snapshots WHERE id NOT IN (
        SELECT id FROM optimization_snapshots ORDER BY timestamp DESC LIMIT ?
      )
    `)
      .run(this.config.maxHistoryEntries)
  }

  getHistory(limit: number = 20): OptimizationSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM optimization_snapshots ORDER BY timestamp DESC LIMIT ?',
      )
      .all(limit) as Array<{
      tokens_before: number
      tokens_after: number
      entries_compressed: number
      entries_dropped: number
      entries_promoted: number
      compression_trigger: number
      full_message_window: number
      min_relevance: number
      timestamp: string
    }>

    return rows.map((r) => ({
      tokensBefore: r.tokens_before,
      tokensAfter: r.tokens_after,
      entriesCompressed: r.entries_compressed,
      entriesDropped: r.entries_dropped,
      entriesPromoted: r.entries_promoted,
      compressionTriggerRatio: r.compression_trigger,
      fullMessageWindow: r.full_message_window,
      minRelevanceScore: r.min_relevance,
      timestamp: r.timestamp,
    }))
  }

  getCurrentParameters(): {
    compressionTrigger: number
    fullMessageWindow: number
    minRelevance: number
    targetUsageRatio: number
  } {
    return {
      compressionTrigger: this.currentCompressionTrigger,
      fullMessageWindow: this.currentFullWindow,
      minRelevance: this.currentMinRelevance,
      targetUsageRatio: this.config.targetUsageRatio,
    }
  }

  getEfficiencyReport(): {
    totalOptimizations: number
    totalTokensSaved: number
    avgSavingsPerRun: number
    currentParameters: ReturnType<typeof this.getCurrentParameters>
  } {
    const history = this.getHistory(100)
    const totalSaved = history.reduce(
      (sum, s) => sum + (s.tokensBefore - s.tokensAfter),
      0,
    )

    return {
      totalOptimizations: history.length,
      totalTokensSaved: totalSaved,
      avgSavingsPerRun:
        history.length > 0 ? Math.round(totalSaved / history.length) : 0,
      currentParameters: this.getCurrentParameters(),
    }
  }
}
