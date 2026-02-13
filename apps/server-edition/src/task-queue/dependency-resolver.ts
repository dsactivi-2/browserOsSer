import type { StoredTask } from './types'

export class DependencyResolver {
  canExecute(task: StoredTask, allTasks: Map<string, StoredTask>): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return true

    return task.dependsOn.every((depId) => {
      const dep = allTasks.get(depId)
      return dep?.state === 'completed'
    })
  }

  hasFailedDependency(
    task: StoredTask,
    allTasks: Map<string, StoredTask>,
  ): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return false

    return task.dependsOn.some((depId) => {
      const dep = allTasks.get(depId)
      return dep?.state === 'failed' || dep?.state === 'cancelled'
    })
  }

  detectCycle(tasks: StoredTask[]): string[] | null {
    const graph = new Map<string, string[]>()
    for (const task of tasks) {
      graph.set(task.id, task.dependsOn ?? [])
    }

    const visited = new Set<string>()
    const inStack = new Set<string>()
    const cycle: string[] = []

    const dfs = (node: string): boolean => {
      visited.add(node)
      inStack.add(node)

      for (const neighbor of graph.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) {
            cycle.push(neighbor)
            return true
          }
        } else if (inStack.has(neighbor)) {
          cycle.push(neighbor)
          return true
        }
      }

      inStack.delete(node)
      return false
    }

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) {
          cycle.push(tasks.find((t) => t.id === cycle[0])?.id ?? '')
          return cycle.reverse()
        }
      }
    }

    return null
  }

  getExecutableTaskIds(tasks: StoredTask[]): string[] {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    return tasks
      .filter((t) => t.state === 'pending' || t.state === 'queued')
      .filter((t) => this.canExecute(t, taskMap))
      .map((t) => t.id)
  }
}
