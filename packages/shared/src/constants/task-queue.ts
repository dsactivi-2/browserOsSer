/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Task queue configuration constants
 */

export const TASK_QUEUE = {
  MAX_CONCURRENT_TASKS: 1,
  MAX_BATCH_SIZE: 100,
  MAX_BATCH_PARALLELISM: 10,
  DEFAULT_TIMEOUT_MS: 120_000,
  MAX_TIMEOUT_MS: 600_000,
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_BACKOFF_MS: 1_000,
  DEFAULT_BACKOFF_MULTIPLIER: 2,
  MAX_BACKOFF_MS: 60_000,
  POLL_INTERVAL_MS: 1_000,
  WEBHOOK_TIMEOUT_MS: 10_000,
  TASK_RETENTION_DAYS: 30,
} as const

export const TASK_PRIORITY_WEIGHTS = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
} as const
