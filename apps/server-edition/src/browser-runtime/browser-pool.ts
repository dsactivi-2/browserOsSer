import { ChromiumLauncher } from './chromium-launcher'
import type { BrowserInstance } from './types'

export interface BrowserPoolConfig {
  maxInstances: number
  basePort: number
  extensionPath: string
  chromiumPath?: string
  display?: string
}

export class BrowserPool {
  private config: BrowserPoolConfig
  private instances = new Map<
    string,
    { launcher: ChromiumLauncher; status: BrowserInstance['status'] }
  >()

  constructor(config: BrowserPoolConfig) {
    this.config = config
  }

  async createInstance(id?: string): Promise<string> {
    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(`Pool limit reached (${this.config.maxInstances})`)
    }

    const instanceId = id ?? crypto.randomUUID()
    const port = this.config.basePort + this.instances.size

    const launcher = new ChromiumLauncher({
      executablePath: this.config.chromiumPath,
      cdpPort: port,
      extensionPort: port + 1000,
      display: this.config.display,
      extensionPath: this.config.extensionPath,
    })

    this.instances.set(instanceId, { launcher, status: 'starting' })

    try {
      await launcher.launch()
      this.instances.get(instanceId)!.status = 'ready'
    } catch {
      this.instances.get(instanceId)!.status = 'error'
    }

    return instanceId
  }

  async destroyInstance(instanceId: string): Promise<boolean> {
    const instance = this.instances.get(instanceId)
    if (!instance) return false

    instance.status = 'stopped'
    await instance.launcher.stop()
    this.instances.delete(instanceId)
    return true
  }

  getStatus(): Array<{ id: string; status: string; cdpPort?: number }> {
    return Array.from(this.instances.entries()).map(([id, inst]) => ({
      id,
      status: inst.status,
    }))
  }

  getAvailable(): string | null {
    for (const [id, inst] of this.instances) {
      if (inst.status === 'ready') return id
    }
    return null
  }

  async destroyAll(): Promise<void> {
    for (const [id] of this.instances) {
      await this.destroyInstance(id)
    }
  }

  get size(): number {
    return this.instances.size
  }
}
