import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { RouterMetrics } from '../src/router/router-metrics'

describe('RouterMetrics', () => {
  let db: Database
  let metrics: RouterMetrics

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    metrics = new RouterMetrics(db)
  })

  test('record and getTotalCalls', () => {
    metrics.record({
      toolName: 'screenshot',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      success: true,
      latencyMs: 1500,
      estimatedCost: 0.003,
      timestamp: new Date().toISOString(),
    })
    expect(metrics.getTotalCalls()).toBe(1)
  })

  test('getAggregated groups by tool+provider+model', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'nav',
      provider: 'anthropic',
      model: 'sonnet',
      success: true,
      latencyMs: 100,
      estimatedCost: 0.001,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'nav',
      provider: 'anthropic',
      model: 'sonnet',
      success: true,
      latencyMs: 200,
      estimatedCost: 0.001,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'nav',
      provider: 'anthropic',
      model: 'sonnet',
      success: false,
      latencyMs: 300,
      estimatedCost: 0.001,
      timestamp: ts,
    })

    const agg = metrics.getAggregated('nav')
    expect(agg.length).toBe(1)
    expect(agg[0].totalCalls).toBe(3)
    expect(agg[0].successCount).toBe(2)
    expect(agg[0].failureCount).toBe(1)
    expect(agg[0].successRate).toBeCloseTo(2 / 3, 2)
    expect(agg[0].avgLatencyMs).toBe(200)
  })

  test('getAggregated with since filter', () => {
    const old = '2024-01-01T00:00:00Z'
    const recent = new Date().toISOString()
    metrics.record({
      toolName: 'click',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 100,
      estimatedCost: 0,
      timestamp: old,
    })
    metrics.record({
      toolName: 'click',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 100,
      estimatedCost: 0,
      timestamp: recent,
    })
    const agg = metrics.getAggregated('click', '2025-01-01T00:00:00Z')
    expect(agg[0].totalCalls).toBe(1)
  })

  test('cleanup removes old entries', () => {
    const old = '2020-01-01T00:00:00Z'
    metrics.record({
      toolName: 'x',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 1,
      estimatedCost: 0,
      timestamp: old,
    })
    const removed = metrics.cleanup(1)
    expect(removed).toBe(1)
    expect(metrics.getTotalCalls()).toBe(0)
  })

  test('empty metrics returns zero', () => {
    expect(metrics.getTotalCalls()).toBe(0)
    expect(metrics.getAggregated().length).toBe(0)
  })

  test('multiple tools are tracked independently', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'navigate',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 50,
      estimatedCost: 0.001,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'screenshot',
      provider: 'google',
      model: 'gemini-2.5-pro',
      success: true,
      latencyMs: 800,
      estimatedCost: 0.002,
      timestamp: ts,
    })

    expect(metrics.getTotalCalls()).toBe(2)

    const navAgg = metrics.getAggregated('navigate')
    expect(navAgg.length).toBe(1)
    expect(navAgg[0].toolName).toBe('navigate')
    expect(navAgg[0].provider).toBe('anthropic')

    const shotAgg = metrics.getAggregated('screenshot')
    expect(shotAgg.length).toBe(1)
    expect(shotAgg[0].toolName).toBe('screenshot')
    expect(shotAgg[0].provider).toBe('google')
  })

  test('getAggregated without filter returns all tools', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'tool_a',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 10,
      estimatedCost: 0,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'tool_b',
      provider: 'anthropic',
      model: 'sonnet',
      success: false,
      latencyMs: 20,
      estimatedCost: 0,
      timestamp: ts,
    })

    const agg = metrics.getAggregated()
    expect(agg.length).toBe(2)
  })

  test('totalCost is summed correctly', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'x',
      provider: 'anthropic',
      model: 'opus',
      success: true,
      latencyMs: 100,
      estimatedCost: 0.01,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'x',
      provider: 'anthropic',
      model: 'opus',
      success: true,
      latencyMs: 100,
      estimatedCost: 0.02,
      timestamp: ts,
    })

    const agg = metrics.getAggregated('x')
    expect(agg[0].totalCost).toBeCloseTo(0.03, 5)
  })

  test('success rate is 0 when all calls fail', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'bad',
      provider: 'anthropic',
      model: 'haiku',
      success: false,
      latencyMs: 50,
      estimatedCost: 0,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'bad',
      provider: 'anthropic',
      model: 'haiku',
      success: false,
      latencyMs: 50,
      estimatedCost: 0,
      timestamp: ts,
    })

    const agg = metrics.getAggregated('bad')
    expect(agg[0].successRate).toBe(0)
    expect(agg[0].successCount).toBe(0)
    expect(agg[0].failureCount).toBe(2)
  })

  test('cleanup returns 0 when no entries match cutoff', () => {
    const recent = new Date().toISOString()
    metrics.record({
      toolName: 'y',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 10,
      estimatedCost: 0,
      timestamp: recent,
    })
    const removed = metrics.cleanup(1)
    expect(removed).toBe(0)
    expect(metrics.getTotalCalls()).toBe(1)
  })

  test('avgLatencyMs is rounded to nearest integer', () => {
    const ts = new Date().toISOString()
    metrics.record({
      toolName: 'z',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 100,
      estimatedCost: 0,
      timestamp: ts,
    })
    metrics.record({
      toolName: 'z',
      provider: 'anthropic',
      model: 'haiku',
      success: true,
      latencyMs: 101,
      estimatedCost: 0,
      timestamp: ts,
    })

    const agg = metrics.getAggregated('z')
    // avg of 100 and 101 = 100.5, Math.round => 101
    expect(Number.isInteger(agg[0].avgLatencyMs)).toBe(true)
    expect(agg[0].avgLatencyMs).toBe(101)
  })
})
