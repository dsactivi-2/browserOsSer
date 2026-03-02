import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { CrossSessionStore } from '../src/memory/cross-session-store'

describe('CrossSessionStore', () => {
  let db: Database
  let store: CrossSessionStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    store = new CrossSessionStore(db)
  })

  test('store and get', () => {
    store.store('domain', 'test-key', 'test-value')
    const entry = store.get('domain', 'test-key')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('test-value')
    expect(entry!.confidence).toBe(0.5)
  })

  test('store same key increases confidence', () => {
    store.store('domain', 'key', 'val1')
    store.store('domain', 'key', 'val2')
    const entry = store.get('domain', 'key')
    expect(entry!.confidence).toBeCloseTo(0.6, 1)
    expect(entry!.value).toBe('val2')
  })

  test('getByCategory', () => {
    store.store('domain', 'k1', 'v1')
    store.store('domain', 'k2', 'v2')
    store.store('error_pattern', 'k3', 'v3')
    const domain = store.getByCategory('domain')
    expect(domain.length).toBe(2)
  })

  test('search by keyword', () => {
    store.store('domain', 'login-page', 'The login page URL')
    store.store('domain', 'home-page', 'The home page URL')
    const results = store.search('login')
    expect(results.length).toBe(1)
    expect(results[0].key).toBe('login-page')
  })

  test('search with category filter', () => {
    store.store('domain', 'test', 'value')
    store.store('error_pattern', 'test', 'error value')
    const results = store.search('test', 'domain')
    expect(results.length).toBe(1)
    expect(results[0].category).toBe('domain')
  })

  test('recordUsage increases count and confidence', () => {
    store.store('domain', 'k', 'v')
    const before = store.get('domain', 'k')!
    store.recordUsage(before.id)
    const after = store.get('domain', 'k')!
    expect(after.usageCount).toBe(before.usageCount + 1)
    expect(after.confidence).toBeGreaterThan(before.confidence)
  })

  test('prune removes low-confidence entries', () => {
    store.store('domain', 'low', 'val', 0.05)
    store.store('domain', 'high', 'val', 0.9)
    const pruned = store.prune(0.1)
    expect(pruned).toBe(1)
    expect(store.get('domain', 'low')).toBeNull()
    expect(store.get('domain', 'high')).not.toBeNull()
  })

  test('getStats', () => {
    store.store('domain', 'a', 'b')
    store.store('error_pattern', 'c', 'd')
    const stats = store.getStats()
    expect(stats.total).toBe(2)
    expect(stats.byCategory.domain).toBe(1)
    expect(stats.byCategory.error_pattern).toBe(1)
  })
})
