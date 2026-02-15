import type {
  MemoryAction,
  MemoryAnalysisResult,
  MemoryEntry,
  TokenBudget,
} from './types'

export interface AnalyzerConfig {
  analysisEveryN: number // Run analysis every N messages (default: 20)
  minRelevanceScore: number // Below this, entry gets flagged for action
  redundancySimilarityThreshold: number // Above this cosine sim = redundant
}

export class MemoryAnalyzer {
  private config: AnalyzerConfig
  private messagesSinceLastAnalysis: number = 0

  constructor(config: Partial<AnalyzerConfig> = {}) {
    this.config = {
      analysisEveryN: config.analysisEveryN ?? 20,
      minRelevanceScore: config.minRelevanceScore ?? 0.3,
      redundancySimilarityThreshold:
        config.redundancySimilarityThreshold ?? 0.9,
    }
  }

  // Record a message and check if analysis should run
  recordMessage(): boolean {
    this.messagesSinceLastAnalysis++
    return this.messagesSinceLastAnalysis >= this.config.analysisEveryN
  }

  // Reset counter after analysis runs
  resetCounter(): void {
    this.messagesSinceLastAnalysis = 0
  }

  // Full analysis of memory entries
  analyze(
    entries: MemoryEntry[],
    currentTokenBudget: TokenBudget,
  ): MemoryAnalysisResult {
    const actions: MemoryAction[] = []
    let relevantCount = 0
    let redundantCount = 0

    // Score each entry for relevance
    const scored = entries.map((entry) => ({
      entry,
      score: this.scoreRelevance(entry),
    }))

    // Identify actions
    for (const { entry, score } of scored) {
      if (score >= this.config.minRelevanceScore) {
        relevantCount++
      } else {
        // Low relevance — suggest compression or drop
        if (entry.isCompressed) {
          actions.push({
            type: 'drop',
            entryId: entry.id,
            reason: `Low relevance (${score.toFixed(2)}) and already compressed`,
          })
        } else {
          actions.push({
            type: 'compress',
            entryId: entry.id,
            reason: `Low relevance (${score.toFixed(2)})`,
          })
        }
      }
    }

    // Detect redundancy — entries with very similar content
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (this.isRedundant(entries[i].content, entries[j].content)) {
          redundantCount++
          // Keep the newer one, flag older for compression
          const older =
            entries[i].createdAt < entries[j].createdAt
              ? entries[i]
              : entries[j]
          if (!actions.some((a) => a.entryId === older.id)) {
            actions.push({
              type: 'compress',
              entryId: older.id,
              reason: 'Redundant with newer entry',
            })
          }
        }
      }
    }

    // Promote high-value short-term entries to long-term
    for (const { entry, score } of scored) {
      if (
        entry.type === 'short_term' &&
        score >= 0.8 &&
        this.containsKeyFacts(entry.content)
      ) {
        actions.push({
          type: 'promote',
          entryId: entry.id,
          reason: `High relevance (${score.toFixed(2)}) with key facts`,
        })
      }
    }

    this.resetCounter()

    return {
      timestamp: new Date().toISOString(),
      totalEntries: entries.length,
      relevantEntries: relevantCount,
      redundantEntries: redundantCount,
      suggestedActions: actions,
      tokenUsage: currentTokenBudget,
    }
  }

  // Score relevance of an entry (0.0 - 1.0)
  private scoreRelevance(entry: MemoryEntry): number {
    let score = entry.relevanceScore

    // Recency boost — more recent = more relevant
    const ageMs = Date.now() - new Date(entry.createdAt).getTime()
    const ageHours = ageMs / (1000 * 60 * 60)
    if (ageHours < 1)
      score += 0.2 // Last hour
    else if (ageHours < 24)
      score += 0.1 // Last day
    else score -= 0.1 // Older than a day

    // Content-based scoring
    const content = entry.content.toLowerCase()

    // High-value indicators
    if (content.includes('error') || content.includes('failed')) score += 0.15
    if (content.includes('http') || content.includes('://')) score += 0.1
    if (content.includes('selector') || content.includes('xpath')) score += 0.1
    if (content.includes('password') || content.includes('credential'))
      score += 0.2
    if (content.includes('important') || content.includes('critical'))
      score += 0.15

    // Low-value indicators
    if (content.length < 20) score -= 0.2
    if (/^(ok|yes|no|sure|thanks|hi|hello)/i.test(content)) score -= 0.3

    // Role-based scoring
    if (entry.role === 'system') score += 0.1
    if (entry.role === 'tool') score += 0.15

    return Math.max(0, Math.min(1, score))
  }

  // Simple redundancy check based on content overlap
  private isRedundant(a: string, b: string): boolean {
    if (a.length < 50 || b.length < 50) return false

    // Jaccard similarity on word sets
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = new Set(b.toLowerCase().split(/\s+/))
    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++
    }
    const union = wordsA.size + wordsB.size - intersection
    return (
      union > 0 &&
      intersection / union >= this.config.redundancySimilarityThreshold
    )
  }

  // Check if content contains key facts worth preserving
  private containsKeyFacts(content: string): boolean {
    const patterns = [
      /https?:\/\/[^\s]+/,
      /error|failed|exception/i,
      /selector|xpath|css/i,
      /\bapi\b|endpoint/i,
      /password|token|key/i,
      /step \d|phase \d/i,
    ]
    return patterns.some((p) => p.test(content))
  }

  getConfig(): AnalyzerConfig {
    return { ...this.config }
  }
}
