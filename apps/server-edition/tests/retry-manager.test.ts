import { describe, expect, test } from 'bun:test'
import { RetryManager } from '../src/task-queue/retry-manager'

// Default constants from @browseros/shared/constants/task-queue:
//   DEFAULT_MAX_RETRIES: 3
//   DEFAULT_BACKOFF_MS: 1_000
//   DEFAULT_BACKOFF_MULTIPLIER: 2
//   MAX_BACKOFF_MS: 60_000

describe('RetryManager', () => {
  const manager = new RetryManager()

  // shouldRetry — default policy (maxRetries = 3)

  test('shouldRetry returns true when retryCount is 0', () => {
    expect(manager.shouldRetry(0)).toBe(true)
  })

  test('shouldRetry returns true when retryCount is below default max (2)', () => {
    expect(manager.shouldRetry(2)).toBe(true)
  })

  test('shouldRetry returns false when retryCount equals default max (3)', () => {
    expect(manager.shouldRetry(3)).toBe(false)
  })

  test('shouldRetry returns false when retryCount exceeds default max', () => {
    expect(manager.shouldRetry(5)).toBe(false)
  })

  test('shouldRetry returns true at count 1 with default policy', () => {
    expect(manager.shouldRetry(1)).toBe(true)
  })

  // shouldRetry — custom policy

  test('shouldRetry respects custom maxRetries — allows when under limit', () => {
    const policy = { maxRetries: 5, backoffMs: 1000, backoffMultiplier: 2 }
    expect(manager.shouldRetry(4, policy)).toBe(true)
  })

  test('shouldRetry respects custom maxRetries — blocks when at limit', () => {
    const policy = { maxRetries: 5, backoffMs: 1000, backoffMultiplier: 2 }
    expect(manager.shouldRetry(5, policy)).toBe(false)
  })

  test('shouldRetry allows zero retries with maxRetries: 0', () => {
    const policy = { maxRetries: 0, backoffMs: 1000, backoffMultiplier: 2 }
    expect(manager.shouldRetry(0, policy)).toBe(false)
  })

  test('shouldRetry allows single retry with maxRetries: 1', () => {
    const policy = { maxRetries: 1, backoffMs: 1000, backoffMultiplier: 2 }
    expect(manager.shouldRetry(0, policy)).toBe(true)
    expect(manager.shouldRetry(1, policy)).toBe(false)
  })

  // getBackoffMs — default policy (base=1000, multiplier=2, cap=60_000)

  test('getBackoffMs returns base value at retryCount 0', () => {
    expect(manager.getBackoffMs(0)).toBe(1000)
  })

  test('getBackoffMs doubles at retryCount 1', () => {
    expect(manager.getBackoffMs(1)).toBe(2000)
  })

  test('getBackoffMs quadruples at retryCount 2', () => {
    expect(manager.getBackoffMs(2)).toBe(4000)
  })

  test('getBackoffMs is strictly increasing with each retry', () => {
    const ms0 = manager.getBackoffMs(0)
    const ms1 = manager.getBackoffMs(1)
    const ms2 = manager.getBackoffMs(2)
    expect(ms1).toBeGreaterThan(ms0)
    expect(ms2).toBeGreaterThan(ms1)
  })

  test('getBackoffMs caps at MAX_BACKOFF_MS (60_000) for large counts', () => {
    expect(manager.getBackoffMs(100)).toBe(60_000)
  })

  test('getBackoffMs caps correctly just above cap boundary', () => {
    // 2^6 * 1000 = 64_000 which exceeds 60_000
    expect(manager.getBackoffMs(6)).toBe(60_000)
  })

  test('getBackoffMs does not exceed cap for any input', () => {
    for (const n of [10, 20, 50, 100]) {
      expect(manager.getBackoffMs(n)).toBeLessThanOrEqual(60_000)
    }
  })

  // getBackoffMs — custom policy

  test('getBackoffMs uses custom backoffMs as base at retryCount 0', () => {
    const policy = { maxRetries: 3, backoffMs: 500, backoffMultiplier: 3 }
    expect(manager.getBackoffMs(0, policy)).toBe(500)
  })

  test('getBackoffMs applies custom multiplier at retryCount 1', () => {
    const policy = { maxRetries: 3, backoffMs: 500, backoffMultiplier: 3 }
    expect(manager.getBackoffMs(1, policy)).toBe(1500)
  })

  test('getBackoffMs applies custom multiplier at retryCount 2', () => {
    const policy = { maxRetries: 3, backoffMs: 500, backoffMultiplier: 3 }
    expect(manager.getBackoffMs(2, policy)).toBe(4500)
  })

  test('getBackoffMs with custom policy still caps at MAX_BACKOFF_MS', () => {
    const policy = { maxRetries: 10, backoffMs: 10_000, backoffMultiplier: 10 }
    expect(manager.getBackoffMs(10, policy)).toBe(60_000)
  })

  test('getBackoffMs with multiplier 1 returns flat base value', () => {
    const policy = { maxRetries: 5, backoffMs: 2000, backoffMultiplier: 1 }
    expect(manager.getBackoffMs(0, policy)).toBe(2000)
    expect(manager.getBackoffMs(3, policy)).toBe(2000)
    expect(manager.getBackoffMs(5, policy)).toBe(2000)
  })
})
