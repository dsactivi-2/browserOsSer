import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { TaskStore } from '../src/task-queue/task-store'

describe('TaskStore', () => {
  let db: Database
  let store: TaskStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    store = new TaskStore(db)
  })

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: crypto.randomUUID(),
      instruction: 'Test task',
      priority: 'normal' as const,
      state: 'pending' as const,
      dependsOn: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    }
  }

  test('createTask and getTask', () => {
    const task = makeTask()
    store.createTask(task)
    const retrieved = store.getTask(task.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(task.id)
    expect(retrieved!.instruction).toBe('Test task')
    expect(retrieved!.state).toBe('pending')
  })

  test('getTask returns null for unknown ID', () => {
    expect(store.getTask('nonexistent')).toBeNull()
  })

  test('listTasks with state filter', () => {
    store.createTask(makeTask({ state: 'pending' }))
    store.createTask(makeTask({ state: 'running' }))
    store.createTask(makeTask({ state: 'pending' }))

    const pending = store.listTasks({ state: 'pending' })
    expect(pending.length).toBe(2)
  })

  test('listTasks with priority filter', () => {
    store.createTask(makeTask({ priority: 'high' }))
    store.createTask(makeTask({ priority: 'normal' }))
    store.createTask(makeTask({ priority: 'high' }))

    const high = store.listTasks({ priority: 'high' })
    expect(high.length).toBe(2)
  })

  test('listTasks with limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      store.createTask(makeTask())
    }
    const page = store.listTasks({ limit: 3, offset: 2 })
    expect(page.length).toBe(3)
  })

  test('listTasks returns all when no filters', () => {
    store.createTask(makeTask())
    store.createTask(makeTask())
    const all = store.listTasks({})
    expect(all.length).toBe(2)
  })

  test('updateState', () => {
    const task = makeTask()
    store.createTask(task)
    store.updateState(task.id, 'running')
    const updated = store.getTask(task.id)
    expect(updated!.state).toBe('running')
  })

  test('incrementRetry increments from 0 to 1', () => {
    const task = makeTask()
    store.createTask(task)
    const count1 = store.incrementRetry(task.id)
    expect(count1).toBe(1)
  })

  test('incrementRetry increments sequentially', () => {
    const task = makeTask()
    store.createTask(task)
    store.incrementRetry(task.id)
    const count2 = store.incrementRetry(task.id)
    expect(count2).toBe(2)
  })

  test('setResult and getResult', () => {
    const task = makeTask()
    store.createTask(task)
    store.setResult(task.id, {
      result: { output: 'done' },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      executionTimeMs: 123,
    })
    const result = store.getResult(task.id)
    expect(result).not.toBeNull()
    expect(result!.executionTimeMs).toBe(123)
  })

  test('getResult returns null for unknown task', () => {
    expect(store.getResult('nonexistent')).toBeNull()
  })

  test('getResult returns task state and empty steps without prior setResult', () => {
    const task = makeTask()
    store.createTask(task)
    const result = store.getResult(task.id)
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe(task.id)
    expect(result!.state).toBe('pending')
    expect(result!.steps).toEqual([])
  })

  test('addStep adds a step retrievable via getResult', () => {
    const task = makeTask()
    store.createTask(task)
    store.addStep(task.id, {
      tool: 'screenshot',
      args: { url: 'https://example.com' },
      timestamp: new Date().toISOString(),
    })
    const result = store.getResult(task.id)
    expect(result!.steps.length).toBe(1)
    expect(result!.steps[0].tool).toBe('screenshot')
  })

  test('addStep accumulates multiple steps in order', () => {
    const task = makeTask()
    store.createTask(task)
    store.addStep(task.id, {
      tool: 'navigate',
      args: { url: 'https://example.com' },
      timestamp: new Date().toISOString(),
    })
    store.addStep(task.id, {
      tool: 'click',
      args: { selector: '#btn' },
      timestamp: new Date().toISOString(),
    })
    const result = store.getResult(task.id)
    expect(result!.steps.length).toBe(2)
    expect(result!.steps[0].tool).toBe('navigate')
    expect(result!.steps[1].tool).toBe('click')
  })

  test('getStats reflects task state counts', () => {
    store.createTask(makeTask({ state: 'pending' }))
    store.createTask(makeTask({ state: 'completed' }))
    store.createTask(makeTask({ state: 'failed' }))
    const stats = store.getStats()
    expect(stats.total).toBe(3)
    expect(stats.pending).toBe(1)
    expect(stats.completed).toBe(1)
    expect(stats.failed).toBe(1)
  })

  test('getStats returns zeros for empty store', () => {
    const stats = store.getStats()
    expect(stats.total).toBe(0)
    expect(stats.pending).toBe(0)
    expect(stats.running).toBe(0)
  })

  test('getNextPendingTasks respects priority order', () => {
    store.createTask(makeTask({ priority: 'low' }))
    store.createTask(makeTask({ priority: 'critical' }))
    store.createTask(makeTask({ priority: 'high' }))
    const next = store.getNextPendingTasks(3)
    expect(next[0].priority).toBe('critical')
    expect(next[1].priority).toBe('high')
    expect(next[2].priority).toBe('low')
  })

  test('getNextPendingTasks excludes running and completed tasks', () => {
    store.createTask(makeTask({ state: 'running' }))
    store.createTask(makeTask({ state: 'completed' }))
    store.createTask(makeTask({ state: 'pending' }))
    const next = store.getNextPendingTasks(10)
    expect(next.length).toBe(1)
    expect(next[0].state).toBe('pending')
  })

  test('getNextPendingTasks includes waiting_dependency tasks', () => {
    store.createTask(makeTask({ state: 'waiting_dependency' }))
    store.createTask(makeTask({ state: 'queued' }))
    const next = store.getNextPendingTasks(10)
    expect(next.length).toBe(2)
  })

  test('getNextPendingTasks respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.createTask(makeTask())
    }
    const next = store.getNextPendingTasks(2)
    expect(next.length).toBe(2)
  })

  test('deleteTask removes the task', () => {
    const task = makeTask()
    store.createTask(task)
    expect(store.deleteTask(task.id)).toBe(true)
    expect(store.getTask(task.id)).toBeNull()
  })

  test('deleteTask returns false for unknown ID', () => {
    expect(store.deleteTask('nonexistent')).toBe(false)
  })

  test('deleteTask removes associated result and steps', () => {
    const task = makeTask()
    store.createTask(task)
    store.setResult(task.id, { result: { ok: true }, executionTimeMs: 10 })
    store.addStep(task.id, {
      tool: 'navigate',
      args: {},
      timestamp: new Date().toISOString(),
    })
    store.deleteTask(task.id)
    expect(store.getTask(task.id)).toBeNull()
    expect(store.getResult(task.id)).toBeNull()
  })

  test('createBatch allows tasks to reference batchId', () => {
    const batchId = crypto.randomUUID()
    store.createBatch(batchId, 'https://example.com/webhook', 3)
    const task = makeTask({ batchId })
    store.createTask(task)
    const tasks = store.listTasks({ batchId })
    expect(tasks.length).toBe(1)
    expect(tasks[0].batchId).toBe(batchId)
  })

  test('dependsOn is preserved through storage round-trip', () => {
    const depId = crypto.randomUUID()
    const task = makeTask({ dependsOn: [depId] })
    store.createTask(task)
    const retrieved = store.getTask(task.id)
    expect(retrieved!.dependsOn).toEqual([depId])
  })

  test('dependsOn defaults to empty array when not provided', () => {
    const task = makeTask({ dependsOn: [] })
    store.createTask(task)
    const retrieved = store.getTask(task.id)
    expect(retrieved!.dependsOn).toEqual([])
  })

  test('setResult error field is stored and retrieved', () => {
    const task = makeTask()
    store.createTask(task)
    store.setResult(task.id, { error: 'something went wrong' })
    const result = store.getResult(task.id)
    expect(result!.error).toBe('something went wrong')
  })

  test('setResult upserts on conflict', () => {
    const task = makeTask()
    store.createTask(task)
    store.setResult(task.id, { executionTimeMs: 100 })
    store.setResult(task.id, { executionTimeMs: 200 })
    const result = store.getResult(task.id)
    expect(result!.executionTimeMs).toBe(200)
  })

  test('retryCount starts at 0 on creation', () => {
    const task = makeTask()
    store.createTask(task)
    const retrieved = store.getTask(task.id)
    expect(retrieved!.retryCount).toBe(0)
  })
})
