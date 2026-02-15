import { type ChildProcess, spawn } from 'node:child_process'

export interface XvfbConfig {
  display: string
  resolution: string
}

export class XvfbManager {
  private process: ChildProcess | null = null
  private config: XvfbConfig

  constructor(config: XvfbConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Xvfb is already running')
    }

    const [width, height, depth] = this.config.resolution.split('x')
    const screenArg = `${width}x${height}x${depth}`

    return new Promise((resolve, reject) => {
      this.process = spawn(
        'Xvfb',
        [
          this.config.display,
          '-screen',
          '0',
          screenArg,
          '-ac', // disable access control
          '-nolisten',
          'tcp',
          '+extension',
          'RANDR',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )

      const timeout = setTimeout(() => {
        resolve() // Xvfb doesn't output on success, so we wait briefly
      }, 1000)

      this.process.on('error', (err) => {
        clearTimeout(timeout)
        this.process = null
        reject(new Error(`Failed to start Xvfb: ${err.message}`))
      })

      this.process.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout)
          this.process = null
          reject(new Error(`Xvfb exited with code ${code}`))
        }
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString()
        if (msg.includes('Server is already active')) {
          clearTimeout(timeout)
          reject(new Error(`Display ${this.config.display} is already in use`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.process) return

    const proc = this.process
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL')
        }
      }, 5000)

      proc.on('exit', () => {
        clearTimeout(killTimer)
        this.process = null
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  getDisplay(): string {
    return this.config.display
  }
}
