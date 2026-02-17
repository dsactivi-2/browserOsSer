import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { PersistentSessionManager } from '../src/memory/persistent-session'

describe('PersistentSessionManager', () => {
  let db: Database
  let manager: PersistentSessionManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    manager = new PersistentSessionManager(db)
  })

  test('getOrCreate creates new session', () => {
    const session = manager.getOrCreate('conv-1')
    expect(session.conversationId).toBe('conv-1')
    expect(session.messageCount).toBe(0)
    expect(session.history).toEqual([])
  })

  test('getOrCreate returns existing session', () => {
    manager.getOrCreate('conv-2')
    manager.addMessage('conv-2', 'user', 'Hello')
    const session = manager.getOrCreate('conv-2')
    expect(session.messageCount).toBe(1)
  })

  test('addMessage persists messages', () => {
    manager.getOrCreate('conv-3')
    manager.addMessage('conv-3', 'user', 'Hello')
    manager.addMessage('conv-3', 'assistant', 'Hi there')
    const session = manager.getOrCreate('conv-3')
    expect(session.messageCount).toBe(2)
  })

  test('getRecentMessages returns last N in chronological order', () => {
    manager.getOrCreate('conv-4')
    for (let i = 0; i < 10; i++) {
      manager.addMessage('conv-4', 'user', `Message ${i}`)
    }
    const recent = manager.getRecentMessages('conv-4', 3)
    expect(recent.length).toBe(3)
    expect(recent[0].content).toBe('Message 7')
    expect(recent[2].content).toBe('Message 9')
  })

  test('getMessageCount', () => {
    manager.getOrCreate('conv-5')
    manager.addMessage('conv-5', 'user', 'A')
    manager.addMessage('conv-5', 'assistant', 'B')
    expect(manager.getMessageCount('conv-5')).toBe(2)
  })

  test('delete session', () => {
    manager.getOrCreate('conv-6')
    expect(manager.delete('conv-6')).toBe(true)
    expect(manager.count()).toBe(0)
  })

  test('listSessions', () => {
    manager.getOrCreate('a')
    manager.getOrCreate('b')
    const sessions = manager.listSessions()
    expect(sessions.length).toBe(2)
  })

  test('count', () => {
    manager.getOrCreate('x')
    manager.getOrCreate('y')
    expect(manager.count()).toBe(2)
  })
})
