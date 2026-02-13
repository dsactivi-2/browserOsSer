import type { ServerEditionEnv } from './env'

export interface ServerEditionConfig {
  mode: 'local' | 'server'

  // Browser Runtime
  xvfb: {
    display: string
    resolution: string
  }
  vnc: {
    enabled: boolean
    port: number
    password?: string
  }
  chromium: {
    path?: string
    cdpPort: number
    extensionPort: number
    extensionDir: string
  }

  // Server
  serverPort: number

  // Database
  dbPath: string

  // Task Queue
  taskQueue: {
    maxConcurrent: number
    maxRetries: number
    defaultTimeoutMs: number
  }

  auth: {
    apiKeys: string[]
    enabled: boolean
  }
  browserPool: {
    maxInstances: number
  }

  // Optional override for controller extension path
  extensionPath?: string
}

export function createConfig(
  env: ServerEditionEnv,
  cliMode?: string,
): ServerEditionConfig {
  return {
    mode: (cliMode as 'local' | 'server') ?? env.BROWSEROS_MODE,

    xvfb: {
      display: env.XVFB_DISPLAY,
      resolution: env.XVFB_RESOLUTION,
    },
    vnc: {
      enabled: env.VNC_ENABLED,
      port: env.VNC_PORT,
      password: env.VNC_PASSWORD,
    },
    chromium: {
      path: env.CHROMIUM_PATH,
      cdpPort: env.CDP_PORT,
      extensionPort: env.EXTENSION_PORT,
      extensionDir: env.EXTENSION_DIR,
    },

    serverPort: env.SERVER_PORT,
    dbPath: env.DB_PATH,

    taskQueue: {
      maxConcurrent: env.TASK_QUEUE_MAX_CONCURRENT,
      maxRetries: env.TASK_QUEUE_MAX_RETRIES,
      defaultTimeoutMs: env.TASK_DEFAULT_TIMEOUT_MS,
    },

    auth: {
      apiKeys: env.API_KEYS ? env.API_KEYS.split(',').filter(Boolean) : [],
      enabled: env.API_KEYS !== '',
    },
    browserPool: {
      maxInstances: env.BROWSER_POOL_MAX,
    },

    extensionPath: env.EXTENSION_PATH || undefined,
  }
}
