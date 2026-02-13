import { z } from 'zod'

export const ServerEditionEnvSchema = z.object({
  // Mode: 'local' (macOS, no Xvfb) or 'server' (headless with Xvfb)
  BROWSEROS_MODE: z.enum(['local', 'server']).default('local'),

  // Display configuration (server mode only)
  XVFB_DISPLAY: z.string().default(':99'),
  XVFB_RESOLUTION: z.string().default('1920x1080x24'),

  // VNC
  VNC_ENABLED: z.coerce.boolean().default(false),
  VNC_PORT: z.coerce.number().int().default(6080),
  VNC_PASSWORD: z.string().optional(),

  // Chromium
  CHROMIUM_PATH: z.string().optional(),
  CDP_PORT: z.coerce.number().int().default(9222),
  EXTENSION_PORT: z.coerce.number().int().default(9101),
  EXTENSION_DIR: z.string().default('apps/controller-ext/dist'),

  // Server
  SERVER_PORT: z.coerce.number().int().default(9100),

  // Database
  DB_PATH: z.string().default('./data/browseros-server.db'),

  // Task Queue
  TASK_QUEUE_MAX_CONCURRENT: z.coerce.number().int().min(1).default(1),
  TASK_QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  TASK_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),

  // Auth
  API_KEYS: z.string().default(''),

  // Browser Pool
  BROWSER_POOL_MAX: z.coerce.number().int().min(1).default(1),

  // Extension path override
  EXTENSION_PATH: z.string().optional(),
})

export type ServerEditionEnv = z.infer<typeof ServerEditionEnvSchema>

export function loadEnv(): ServerEditionEnv {
  return ServerEditionEnvSchema.parse(process.env)
}
