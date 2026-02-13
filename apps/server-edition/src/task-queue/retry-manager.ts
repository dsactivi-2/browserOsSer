import { TASK_QUEUE } from '@browseros/shared/constants/task-queue'
import type { RetryPolicy } from '@browseros/shared/schemas/task'

export class RetryManager {
  shouldRetry(retryCount: number, policy?: RetryPolicy): boolean {
    const maxRetries = policy?.maxRetries ?? TASK_QUEUE.DEFAULT_MAX_RETRIES
    return retryCount < maxRetries
  }

  getBackoffMs(retryCount: number, policy?: RetryPolicy): number {
    const base = policy?.backoffMs ?? TASK_QUEUE.DEFAULT_BACKOFF_MS
    const multiplier =
      policy?.backoffMultiplier ?? TASK_QUEUE.DEFAULT_BACKOFF_MULTIPLIER
    const backoff = base * multiplier ** retryCount
    return Math.min(backoff, TASK_QUEUE.MAX_BACKOFF_MS)
  }

  async waitForRetry(retryCount: number, policy?: RetryPolicy): Promise<void> {
    const delayMs = this.getBackoffMs(retryCount, policy)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}
