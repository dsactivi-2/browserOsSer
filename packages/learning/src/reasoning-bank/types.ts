export interface ExecutionPattern {
  id: string
  taskType: string
  toolSequence: string[]
  inputSummary: string
  outputSummary: string
  success: boolean
  durationMs: number
  toolCount: number
  retryCount: number
  confidence: number
  createdAt: string
}

export interface PatternMatch {
  pattern: ExecutionPattern
  similarity: number
  relevance: number
}

export interface PatternQuery {
  taskDescription: string
  toolName?: string
  minConfidence?: number
  limit?: number
}
