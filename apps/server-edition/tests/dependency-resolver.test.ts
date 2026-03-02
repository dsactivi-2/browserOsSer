import { describe, expect, test } from 'bun:test'
import { DependencyResolver } from '../src/task-queue/dependency-resolver'
import type { StoredTask } from '../src/task-queue/types'

describe('DependencyResolver', () => {
  const resolver = new DependencyResolver()

  function makeTask(overrides: Partial<StoredTask> = {}): StoredTask {
    return {
      id: crypto.randomUUID(),
      instruction: 'test',
      priority: 'normal',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    }
  }

  // canExecute

  test('canExecute returns true when task has no dependencies', () => {
    const task = makeTask()
    expect(resolver.canExecute(task, new Map())).toBe(true)
  })

  test('canExecute returns true when all dependencies are completed', () => {
    const dep = makeTask({ state: 'completed' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(true)
  })

  test('canExecute returns false when a dependency is pending', () => {
    const dep = makeTask({ state: 'pending' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(false)
  })

  test('canExecute returns false when a dependency is running', () => {
    const dep = makeTask({ state: 'running' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(false)
  })

  test('canExecute returns false when a dependency is failed', () => {
    const dep = makeTask({ state: 'failed' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(false)
  })

  test('canExecute returns false when a dependency is missing from map', () => {
    const task = makeTask({ dependsOn: ['missing-id'] })
    expect(resolver.canExecute(task, new Map([[task.id, task]]))).toBe(false)
  })

  test('canExecute returns false when one of multiple dependencies is not completed', () => {
    const dep1 = makeTask({ state: 'completed' })
    const dep2 = makeTask({ state: 'running' })
    const task = makeTask({ dependsOn: [dep1.id, dep2.id] })
    const map = new Map([
      [dep1.id, dep1],
      [dep2.id, dep2],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(false)
  })

  test('canExecute returns true when all of multiple dependencies are completed', () => {
    const dep1 = makeTask({ state: 'completed' })
    const dep2 = makeTask({ state: 'completed' })
    const task = makeTask({ dependsOn: [dep1.id, dep2.id] })
    const map = new Map([
      [dep1.id, dep1],
      [dep2.id, dep2],
      [task.id, task],
    ])
    expect(resolver.canExecute(task, map)).toBe(true)
  })

  // hasFailedDependency

  test('hasFailedDependency returns false when task has no dependencies', () => {
    const task = makeTask()
    expect(resolver.hasFailedDependency(task, new Map())).toBe(false)
  })

  test('hasFailedDependency returns false when dependency is completed', () => {
    const dep = makeTask({ state: 'completed' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.hasFailedDependency(task, map)).toBe(false)
  })

  test('hasFailedDependency returns true when a dependency has failed', () => {
    const dep = makeTask({ state: 'failed' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.hasFailedDependency(task, map)).toBe(true)
  })

  test('hasFailedDependency returns true when a dependency is cancelled', () => {
    const dep = makeTask({ state: 'cancelled' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.hasFailedDependency(task, map)).toBe(true)
  })

  test('hasFailedDependency returns false when dependency is pending', () => {
    const dep = makeTask({ state: 'pending' })
    const task = makeTask({ dependsOn: [dep.id] })
    const map = new Map([
      [dep.id, dep],
      [task.id, task],
    ])
    expect(resolver.hasFailedDependency(task, map)).toBe(false)
  })

  test('hasFailedDependency returns true when one of multiple dependencies is failed', () => {
    const dep1 = makeTask({ state: 'completed' })
    const dep2 = makeTask({ state: 'failed' })
    const task = makeTask({ dependsOn: [dep1.id, dep2.id] })
    const map = new Map([
      [dep1.id, dep1],
      [dep2.id, dep2],
      [task.id, task],
    ])
    expect(resolver.hasFailedDependency(task, map)).toBe(true)
  })

  // detectCycle

  test('detectCycle returns null for a single task with no deps', () => {
    const a = makeTask({ id: 'a', dependsOn: [] })
    expect(resolver.detectCycle([a])).toBeNull()
  })

  test('detectCycle returns null for an acyclic linear chain', () => {
    const a = makeTask({ id: 'a', dependsOn: [] })
    const b = makeTask({ id: 'b', dependsOn: ['a'] })
    const c = makeTask({ id: 'c', dependsOn: ['b'] })
    expect(resolver.detectCycle([a, b, c])).toBeNull()
  })

  test('detectCycle returns null for an acyclic diamond graph', () => {
    const a = makeTask({ id: 'a', dependsOn: [] })
    const b = makeTask({ id: 'b', dependsOn: ['a'] })
    const c = makeTask({ id: 'c', dependsOn: ['a'] })
    const d = makeTask({ id: 'd', dependsOn: ['b', 'c'] })
    expect(resolver.detectCycle([a, b, c, d])).toBeNull()
  })

  test('detectCycle detects a direct two-node cycle', () => {
    const a = makeTask({ id: 'a', dependsOn: ['b'] })
    const b = makeTask({ id: 'b', dependsOn: ['a'] })
    const result = resolver.detectCycle([a, b])
    expect(result).not.toBeNull()
  })

  test('detectCycle detects a three-node cycle', () => {
    const a = makeTask({ id: 'a', dependsOn: ['c'] })
    const b = makeTask({ id: 'b', dependsOn: ['a'] })
    const c = makeTask({ id: 'c', dependsOn: ['b'] })
    const result = resolver.detectCycle([a, b, c])
    expect(result).not.toBeNull()
  })

  test('detectCycle returns array of node IDs involved in cycle', () => {
    const a = makeTask({ id: 'a', dependsOn: ['b'] })
    const b = makeTask({ id: 'b', dependsOn: ['a'] })
    const result = resolver.detectCycle([a, b])
    expect(Array.isArray(result)).toBe(true)
    expect(result!.length).toBeGreaterThan(0)
  })

  // getExecutableTaskIds

  test('getExecutableTaskIds returns empty array for empty list', () => {
    expect(resolver.getExecutableTaskIds([])).toEqual([])
  })

  test('getExecutableTaskIds returns pending tasks with no deps', () => {
    const task = makeTask({ id: 'a', state: 'pending', dependsOn: [] })
    const result = resolver.getExecutableTaskIds([task])
    expect(result).toContain('a')
  })

  test('getExecutableTaskIds returns queued tasks with satisfied deps', () => {
    const dep = makeTask({ id: 'dep', state: 'completed' })
    const task = makeTask({ id: 'task', state: 'queued', dependsOn: ['dep'] })
    const result = resolver.getExecutableTaskIds([dep, task])
    expect(result).toContain('task')
  })

  test('getExecutableTaskIds excludes completed tasks', () => {
    const task = makeTask({ id: 'a', state: 'completed', dependsOn: [] })
    const result = resolver.getExecutableTaskIds([task])
    expect(result).not.toContain('a')
  })

  test('getExecutableTaskIds excludes running tasks', () => {
    const task = makeTask({ id: 'a', state: 'running', dependsOn: [] })
    const result = resolver.getExecutableTaskIds([task])
    expect(result).not.toContain('a')
  })

  test('getExecutableTaskIds excludes tasks with unsatisfied deps', () => {
    const dep = makeTask({ id: 'dep', state: 'running' })
    const task = makeTask({ id: 'task', state: 'pending', dependsOn: ['dep'] })
    const result = resolver.getExecutableTaskIds([dep, task])
    expect(result).not.toContain('task')
  })

  test('getExecutableTaskIds handles mixed ready and blocked tasks', () => {
    const a = makeTask({ id: 'a', state: 'completed' })
    const b = makeTask({ id: 'b', state: 'pending', dependsOn: ['a'] })
    const c = makeTask({ id: 'c', state: 'pending', dependsOn: ['b'] })
    const result = resolver.getExecutableTaskIds([a, b, c])
    expect(result).toContain('b')
    expect(result).not.toContain('c')
    expect(result).not.toContain('a')
  })
})
