#!/usr/bin/env bun

if (typeof Bun === 'undefined') {
  console.error('Error: BrowserOS Server Edition requires Bun runtime.')
  console.error('Install from https://bun.sh and run with: bun src/index.ts')
  process.exit(1)
}

import fs from 'node:fs'
import path from 'node:path'
import { createConfig } from './config'
import { loadEnv } from './env'
import { ServerEdition } from './server-edition'

function parseMode(): string | undefined {
  const modeIndex = process.argv.indexOf('--mode')
  if (modeIndex !== -1 && process.argv[modeIndex + 1]) {
    return process.argv[modeIndex + 1]
  }
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))
  if (modeArg) {
    return modeArg.split('=')[1]
  }
  return undefined
}

const env = loadEnv()
const config = createConfig(env, parseMode())

const dataDir = path.dirname(config.dbPath)
fs.mkdirSync(dataDir, { recursive: true })

const serverEdition = new ServerEdition(config)

try {
  await serverEdition.start()
} catch (error) {
  console.error('Failed to start BrowserOS Server Edition:', error)
  process.exit(1)
}

async function shutdown() {
  try {
    await serverEdition.stop()
  } catch (error) {
    console.error('Error during shutdown:', error)
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
