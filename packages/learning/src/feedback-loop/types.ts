export interface TaskFeedback {
  id: string
  taskId: string
  patternId?: string
  rating: 'success' | 'partial' | 'failure'
  autoRating: boolean
  userFeedback?: string
  durationMs: number
  toolsUsed: string[]
  retryCount: number
  createdAt: string
}

export interface TrainingPair {
  input: string
  output: string
  rating: number
  metadata: Record<string, unknown>
}

export interface FeedbackStats {
  total: number
  successCount: number
  partialCount: number
  failureCount: number
  avgDurationMs: number
  autoRatedCount: number
}
