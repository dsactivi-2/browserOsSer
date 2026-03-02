import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { ReasoningBank } from '../src/reasoning-bank/reasoning-bank'

describe('ReasoningBank', () => {
  let db: Database
  let bank: ReasoningBank

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    bank = new ReasoningBank(db)
  })

  test('store and getByType', () => {
    bank.store({
      taskType: 'navigation',
      toolSequence: ['navigate', 'screenshot'],
      inputSummary: 'Go to google',
      outputSummary: 'Navigated to google.com',
      success: true,
      durationMs: 1500,
      toolCount: 2,
      retryCount: 0,
      confidence: 0.8,
      createdAt: new Date().toISOString(),
    })
    const patterns = bank.getByType('navigation')
    expect(patterns.length).toBe(1)
    expect(patterns[0].toolSequence).toEqual(['navigate', 'screenshot'])
  })

  test('findSimilar returns matching patterns', () => {
    bank.store({
      taskType: 'search',
      toolSequence: ['navigate', 'type', 'click'],
      inputSummary: 'Search for cats on google',
      outputSummary: 'Found cat results',
      success: true,
      durationMs: 2000,
      toolCount: 3,
      retryCount: 0,
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    })
    const results = bank.findSimilar({
      taskDescription: 'search for cats',
      limit: 10,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].similarity).toBeGreaterThan(0)
  })

  test('boostConfidence and reduceConfidence', () => {
    const id = bank.store({
      taskType: 'test',
      toolSequence: ['a'],
      inputSummary: 'x',
      outputSummary: 'y',
      success: true,
      durationMs: 100,
      toolCount: 1,
      retryCount: 0,
      confidence: 0.5,
      createdAt: new Date().toISOString(),
    })
    bank.boostConfidence(id, 0.2)
    let patterns = bank.getByType('test')
    expect(patterns[0].confidence).toBeCloseTo(0.7, 1)

    bank.reduceConfidence(id, 0.3)
    patterns = bank.getByType('test')
    expect(patterns[0].confidence).toBeCloseTo(0.4, 1)
  })

  test('getStats', () => {
    bank.store({
      taskType: 'a',
      toolSequence: [],
      inputSummary: 'x',
      outputSummary: 'y',
      success: true,
      durationMs: 100,
      toolCount: 0,
      retryCount: 0,
      confidence: 0.8,
      createdAt: new Date().toISOString(),
    })
    bank.store({
      taskType: 'b',
      toolSequence: [],
      inputSummary: 'x',
      outputSummary: 'y',
      success: false,
      durationMs: 100,
      toolCount: 0,
      retryCount: 0,
      confidence: 0.3,
      createdAt: new Date().toISOString(),
    })
    const stats = bank.getStats()
    expect(stats.total).toBe(2)
    expect(stats.successful).toBe(1)
    expect(stats.byType).toHaveProperty('a')
    expect(stats.byType).toHaveProperty('b')
  })
})
