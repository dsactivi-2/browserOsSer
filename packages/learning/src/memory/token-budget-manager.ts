export interface TokenBudgetConfig {
  maxContextTokens: number // Total context window (e.g., 200000 for Claude)
  systemPromptTokens: number // Reserved for system prompt
  responseReserveTokens: number // Reserved for model response
  fullMessageWindow: number // Number of most recent messages kept in full (not compressed)
  compressionTriggerRatio: number // Start compressing at this ratio (e.g., 0.7 = 70% full)
}

export interface TokenEstimate {
  text: string
  tokens: number
}

export class TokenBudgetManager {
  private config: TokenBudgetConfig
  private currentUsage: number = 0

  constructor(config: Partial<TokenBudgetConfig> = {}) {
    this.config = {
      maxContextTokens: config.maxContextTokens ?? 200_000,
      systemPromptTokens: config.systemPromptTokens ?? 5_000,
      responseReserveTokens: config.responseReserveTokens ?? 4_096,
      fullMessageWindow: config.fullMessageWindow ?? 30,
      compressionTriggerRatio: config.compressionTriggerRatio ?? 0.7,
    }
  }

  // Estimate tokens for text (rough: ~4 chars per token for English)
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  // Available budget for conversation messages
  getAvailableBudget(): number {
    return (
      this.config.maxContextTokens -
      this.config.systemPromptTokens -
      this.config.responseReserveTokens
    )
  }

  // Check if compression should be triggered
  shouldCompress(currentTokens: number): boolean {
    const available = this.getAvailableBudget()
    return currentTokens / available >= this.config.compressionTriggerRatio
  }

  // Partition messages into "keep full" and "compress" sets
  // Returns: { fullMessages: indices[], compressMessages: indices[] }
  partitionMessages(
    messages: Array<{ content: string; role: string; tokenCount?: number }>,
  ): {
    fullIndices: number[]
    compressIndices: number[]
    dropIndices: number[]
    totalTokens: number
  } {
    const budget = this.getAvailableBudget()
    const estimates = messages.map((m, i) => ({
      index: i,
      tokens: m.tokenCount ?? this.estimateTokens(m.content),
      role: m.role,
      content: m.content,
    }))

    // Always keep the most recent `fullMessageWindow` messages
    const recentCount = Math.min(this.config.fullMessageWindow, messages.length)
    const recentStart = messages.length - recentCount

    let usedTokens = 0
    const fullIndices: number[] = []
    const compressIndices: number[] = []
    const dropIndices: number[] = []

    // First pass: count tokens for recent full messages
    for (let i = recentStart; i < messages.length; i++) {
      usedTokens += estimates[i].tokens
      fullIndices.push(i)
    }

    // Second pass: older messages — try to keep as many as fit
    for (let i = recentStart - 1; i >= 0; i--) {
      const est = estimates[i]
      if (usedTokens + est.tokens <= budget * 0.85) {
        // Can keep full
        usedTokens += est.tokens
        fullIndices.unshift(i)
      } else if (usedTokens + Math.ceil(est.tokens * 0.2) <= budget * 0.95) {
        // Compress (assume ~20% of original size after summarization)
        usedTokens += Math.ceil(est.tokens * 0.2)
        compressIndices.unshift(i)
      } else {
        // Drop (too expensive even compressed)
        dropIndices.unshift(i)
      }
    }

    return {
      fullIndices,
      compressIndices,
      dropIndices,
      totalTokens: usedTokens,
    }
  }

  // Get current budget status
  getStatus(currentTokens: number): {
    budget: number
    used: number
    remaining: number
    usagePercent: number
    shouldCompress: boolean
    config: TokenBudgetConfig
  } {
    const budget = this.getAvailableBudget()
    return {
      budget,
      used: currentTokens,
      remaining: budget - currentTokens,
      usagePercent: Math.round((currentTokens / budget) * 100),
      shouldCompress: this.shouldCompress(currentTokens),
      config: this.config,
    }
  }

  getConfig(): TokenBudgetConfig {
    return { ...this.config }
  }
}
