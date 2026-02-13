export interface BrowserInstance {
  id: string
  pid: number
  cdpPort: number
  extensionPort: number
  displayNumber: string
  status: 'starting' | 'ready' | 'busy' | 'error' | 'stopped'
  currentTaskId?: string
  createdAt: Date
}

export interface XvfbConfig {
  display: string
  resolution: string // e.g. "1920x1080x24"
}

export interface ChromiumConfig {
  executablePath?: string
  cdpPort: number
  extensionPort: number
  display?: string // Xvfb display, e.g. ":99"
  extensionPath: string // Path to controller-ext dist
  userDataDir?: string
  additionalArgs?: string[]
}

export interface VncConfig {
  enabled: boolean
  port: number
  password?: string
  display: string
}

export interface BrowserRuntimeConfig {
  mode: 'local' | 'server'
  xvfb: XvfbConfig
  chromium: ChromiumConfig
  vnc: VncConfig
}
