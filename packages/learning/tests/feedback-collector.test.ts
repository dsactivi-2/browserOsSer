import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { FeedbackCollector } from '../src/feedback-loop/feedback-collector'

describe('FeedbackCollector', () => {
  let db: Database
  let collector: FeedbackCollector

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    collector = new FeedbackCollector(db)
  })

  test('autoRate creates feedback with success rating', () => {
    const id = collector.autoRate('task-1', true, 500, ['screenshot'], 0)
    expect(id).toBeTruthy()
    const feedback = collector.getForTask('task-1')
    expect(feedback.length).toBe(1)
    expect(feedback[0].rating).toBe('success')
    expect(feedback[0].autoRating).toBe(true)
  })

  test('autoRate creates partial when retried', () => {
    collector.autoRate('task-2', true, 1000, ['click', 'nav'], 2)
    const feedback = collector.getForTask('task-2')
    expect(feedback[0].rating).toBe('partial')
  })

  test('autoRate creates failure when not successful', () => {
    collector.autoRate('task-3', false, 2000, ['screenshot'], 0)
    const feedback = collector.getForTask('task-3')
    expect(feedback[0].rating).toBe('failure')
  })

  test('addUserFeedback', () => {
    const id = collector.addUserFeedback('task-4', 'success', 'Great job')
    expect(id).toBeTruthy()
    const feedback = collector.getForTask('task-4')
    expect(feedback[0].autoRating).toBe(false)
    expect(feedback[0].userFeedback).toBe('Great job')
  })

  test('getRecent with limit', () => {
    for (let i = 0; i < 5; i++) {
      collector.autoRate(`task-${i}`, true, 100, ['t'], 0)
    }
    const recent = collector.getRecent(3)
    expect(recent.length).toBe(3)
  })

  test('getRecent with rating filter', () => {
    collector.autoRate('t1', true, 100, ['a'], 0)
    collector.autoRate('t2', false, 100, ['b'], 0)
    const failures = collector.getRecent(50, 'failure')
    expect(failures.length).toBe(1)
    expect(failures[0].rating).toBe('failure')
  })

  test('getStats', () => {
    collector.autoRate('t1', true, 100, ['a'], 0)
    collector.autoRate('t2', true, 200, ['b'], 1)
    collector.autoRate('t3', false, 300, ['c'], 0)
    const stats = collector.getStats()
    expect(stats.total).toBe(3)
    expect(stats.successCount).toBe(1)
    expect(stats.partialCount).toBe(1)
    expect(stats.failureCount).toBe(1)
    expect(stats.autoRatedCount).toBe(3)
  })
})
