import path from 'node:path'
import type { ServerEditionConfig } from '../config'
import { ChromiumLauncher } from './chromium-launcher'
import { VncProxy } from './vnc-proxy'
import { XvfbManager } from './xvfb-manager'

export class BrowserRuntimeManager {
  private xvfb: XvfbManager | null = null
  private chromium: ChromiumLauncher | null = null
  private vnc: VncProxy | null = null
  private config: ServerEditionConfig

  constructor(config: ServerEditionConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.config.mode === 'server') {
      await this.startXvfb()
    }
    await this.launchChromium()
    if (this.config.mode === 'server' && this.config.vnc.enabled) {
      await this.startVnc()
    }
  }

  async stop(): Promise<void> {
    if (this.vnc) {
      await this.vnc.stop()
      console.log('VNC stopped')
    }
    if (this.chromium) {
      await this.chromium.stop()
      console.log('Chromium stopped')
    }
    if (this.xvfb) {
      await this.xvfb.stop()
      console.log('Xvfb stopped')
    }
  }

  isChromiumRunning(): boolean {
    return this.chromium !== null
  }

  isVncRunning(): boolean {
    return this.vnc?.isRunning() ?? false
  }

  getVncUrl(): string | null {
    return this.vnc?.isRunning() ? this.vnc.getUrl() : null
  }

  private async startXvfb(): Promise<void> {
    console.log(`Starting Xvfb on display ${this.config.xvfb.display}...`)
    this.xvfb = new XvfbManager({
      display: this.config.xvfb.display,
      resolution: this.config.xvfb.resolution,
    })
    await this.xvfb.start()
    console.log(`Xvfb running on display ${this.config.xvfb.display}`)
  }

  private async launchChromium(): Promise<void> {
    const extensionPath =
      this.config.extensionPath ??
      path.resolve(
        process.cwd(),
        this.config.chromium.extensionDir ?? 'apps/controller-ext/dist',
      )

    console.log(
      `Launching Chromium (CDP port: ${this.config.chromium.cdpPort})...`,
    )
    this.chromium = new ChromiumLauncher({
      executablePath: this.config.chromium.path,
      cdpPort: this.config.chromium.cdpPort,
      extensionPort: this.config.chromium.extensionPort,
      display:
        this.config.mode === 'server' ? this.config.xvfb.display : undefined,
      extensionPath,
    })
    await this.chromium.launch()
    console.log('Chromium launched and CDP available')
  }

  private async startVnc(): Promise<void> {
    console.log(`Starting VNC proxy on port ${this.config.vnc.port}...`)
    this.vnc = new VncProxy({
      enabled: true,
      port: this.config.vnc.port,
      password: this.config.vnc.password,
      display: this.config.xvfb.display,
    })
    await this.vnc.start()
    console.log(
      `VNC available at http://localhost:${this.config.vnc.port}/vnc.html`,
    )
  }
}
