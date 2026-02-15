import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ChromiumConfig {
  executablePath?: string
  cdpPort: number
  extensionPort: number
  display?: string
  extensionPath: string
  userDataDir?: string
  additionalArgs?: string[]
}

export class ChromiumLauncher {
  private process: ChildProcess | null = null
  private config: ChromiumConfig

  constructor(config: ChromiumConfig) {
    this.config = config
  }

  async launch(): Promise<void> {
    if (this.process) {
      throw new Error('Chromium is already running')
    }

    const execPath = this.config.executablePath ?? this.detectChromiumPath()
    if (!execPath) {
      throw new Error(
        'Chromium executable not found. Set CHROMIUM_PATH or install chromium.',
      )
    }

    const userDataDir =
      this.config.userDataDir ??
      path.join(process.cwd(), 'data', 'chromium-profile')
    fs.mkdirSync(userDataDir, { recursive: true })

    const args = [
      `--remote-debugging-port=${this.config.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${this.config.extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      ...(this.config.additionalArgs ?? []),
    ]

    // In server mode, add headless-adjacent flags (but NOT --headless, because we need the extension)
    if (this.config.display) {
      args.push('--disable-gpu')
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    }
    if (this.config.display) {
      env.DISPLAY = this.config.display
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(execPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        detached: false,
      })

      this.process.stderr?.on('data', () => {
        // Drain stderr to prevent buffer overflow
      })

      this.process.on('error', (err) => {
        this.process = null
        reject(new Error(`Failed to launch Chromium: ${err.message}`))
      })

      // Wait for CDP to be available
      this.waitForCdp(this.config.cdpPort, 30000)
        .then(() => resolve())
        .catch((err) => {
          this.stop()
          reject(err)
        })
    })
  }

  private async waitForCdp(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now()
    const url = `http://127.0.0.1:${port}/json/version`

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(url)
        if (response.ok) return
      } catch {
        // CDP not ready yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`)
  }

  private detectChromiumPath(): string | undefined {
    const candidates =
      process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/BrowserOS.app/Contents/MacOS/BrowserOS',
          ]
        : [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
          ]

    return candidates.find((p) => fs.existsSync(p))
  }

  async stop(): Promise<void> {
    if (!this.process) return

    const proc = this.process
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGKILL')
        }
      }, 10000)

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

  getPid(): number | undefined {
    return this.process?.pid ?? undefined
  }
}
