import { type ChildProcess, spawn } from 'node:child_process'

export interface VncConfig {
  enabled: boolean
  port: number
  password?: string
  display: string
}

export class VncProxy {
  private x11vnc: ChildProcess | null = null
  private websockify: ChildProcess | null = null
  private config: VncConfig

  constructor(config: VncConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return

    await this.startX11vnc()
    await this.startWebsockify()
  }

  private async startX11vnc(): Promise<void> {
    const args = [
      '-display',
      this.config.display,
      '-forever', // don't exit after first client disconnects
      '-shared', // allow multiple clients
      '-noxdamage', // compatibility
      '-rfbport',
      '5900',
    ]

    if (this.config.password) {
      args.push('-passwd', this.config.password)
    } else {
      args.push('-nopw') // no password required
    }

    return new Promise((resolve, reject) => {
      this.x11vnc = spawn('x11vnc', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const timeout = setTimeout(() => resolve(), 2000)

      this.x11vnc.on('error', (err) => {
        clearTimeout(timeout)
        this.x11vnc = null
        reject(new Error(`Failed to start x11vnc: ${err.message}`))
      })

      this.x11vnc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout)
          this.x11vnc = null
          reject(new Error(`x11vnc exited with code ${code}`))
        }
      })
    })
  }

  private async startWebsockify(): Promise<void> {
    // websockify bridges WebSocket (noVNC) to the VNC server on port 5900
    return new Promise((resolve, reject) => {
      this.websockify = spawn(
        'websockify',
        [
          '--web',
          '/usr/share/novnc/',
          String(this.config.port), // WebSocket port (default 6080)
          'localhost:5900', // VNC server
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )

      const timeout = setTimeout(() => resolve(), 2000)

      this.websockify.on('error', (err) => {
        clearTimeout(timeout)
        this.websockify = null
        reject(new Error(`Failed to start websockify: ${err.message}`))
      })

      this.websockify.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout)
          this.websockify = null
          reject(new Error(`websockify exited with code ${code}`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    const promises: Promise<void>[] = []

    if (this.websockify) {
      const ws = this.websockify
      promises.push(
        new Promise((resolve) => {
          ws.on('exit', () => {
            this.websockify = null
            resolve()
          })
          ws.kill('SIGTERM')
          setTimeout(() => {
            if (this.websockify) {
              this.websockify.kill('SIGKILL')
              this.websockify = null
              resolve()
            }
          }, 5000)
        }),
      )
    }

    if (this.x11vnc) {
      const vnc = this.x11vnc
      promises.push(
        new Promise((resolve) => {
          vnc.on('exit', () => {
            this.x11vnc = null
            resolve()
          })
          vnc.kill('SIGTERM')
          setTimeout(() => {
            if (this.x11vnc) {
              this.x11vnc.kill('SIGKILL')
              this.x11vnc = null
              resolve()
            }
          }, 5000)
        }),
      )
    }

    await Promise.all(promises)
  }

  isRunning(): boolean {
    if (!this.config.enabled) return false
    return (
      this.x11vnc !== null &&
      this.x11vnc.exitCode === null &&
      this.websockify !== null &&
      this.websockify.exitCode === null
    )
  }

  getUrl(): string | null {
    if (!this.config.enabled || !this.isRunning()) return null
    return `http://localhost:${this.config.port}/vnc.html`
  }
}
