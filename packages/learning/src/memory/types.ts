export type MemoryType = 'short_term' | 'long_term' | 'cross_session'

export interface MemoryEntry {
  id: string
  type: MemoryType
  sessionId: string
  content: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  metadata: Record<string, unknown>
  embedding?: number[]
  relevanceScore: number
  createdAt: string
  compressedAt?: string
  isCompressed: boolean
}

export interface MemoryQuery {
  query: string
  type?: MemoryType
  sessionId?: string
  limit?: number
  minRelevance?: number
  includeCompressed?: boolean
}

export interface MemorySearchResult {
  entry: MemoryEntry
  similarity: number
}

export interface TokenBudget {
  maxTokens: number
  usedTokens: number
  remainingTokens: number
  compressionThreshold: number
  messages: {
    total: number
    full: number
    compressed: number
    dropped: number
  }
}

export interface CompressionResult {
  originalTokens: number
  compressedTokens: number
  ratio: number
  summary: string
}

export interface MemoryAnalysisResult {
  timestamp: string
  totalEntries: number
  relevantEntries: number
  redundantEntries: number
  suggestedActions: MemoryAction[]
  tokenUsage: TokenBudget
}

export interface MemoryAction {
  type: 'compress' | 'drop' | 'promote' | 'demote'
  entryId: string
  reason: string
}

export interface MemoryStoreConfig {
  dbPath: string
  maxShortTermTokens: number
  compressionThreshold: number
  analysisInterval: number
  embeddingDimension: number
}

export interface ShortTermConfig {
  maxTokenBudget: number
  fullMessageWindow: number
  compressionRatio: number
  analysisEveryN: number
}

export interface LongTermConfig {
  categories: string[]
  maxEntriesPerCategory: number
  minRelevanceToKeep: number
}
