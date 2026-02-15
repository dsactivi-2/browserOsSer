import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverProcess: ChildProcess | null = null
let serverLogs: string[] = []

const SERVER_PORT = 3000
const CDP_PORT = 9222

function getResourcePath(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath)
    : path.join(__dirname, '..')
  return path.join(base, ...parts)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 600,
    minHeight: 400,
    title: 'BrowserOS',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  mainWindow.on('close', (event) => {
    if (serverProcess) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray(): void {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('BrowserOS')

  const updateMenu = () => {
    const isRunning = serverProcess !== null
    const contextMenu = Menu.buildFromTemplate([
      {
        label: `BrowserOS — ${isRunning ? 'Running' : 'Stopped'}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        },
      },
      { type: 'separator' },
      {
        label: isRunning ? 'Stop Server' : 'Start Server',
        click: () => {
          if (isRunning) stopServer()
          else startServer()
          updateMenu()
        },
      },
      { type: 'separator' },
      {
        label: 'Quit BrowserOS',
        click: () => {
          stopServer()
          app.quit()
        },
      },
    ])
    tray?.setContextMenu(contextMenu)
  }

  updateMenu()

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  ipcMain.on('server-state-changed', () => updateMenu())
}

function startServer(): void {
  if (serverProcess) return

  serverLogs = []
  appendLog('Starting BrowserOS server...')

  const bunPath = process.env.BUN_PATH ?? 'bun'
  const entryPoint = app.isPackaged
    ? getResourcePath('server-edition', 'index.ts')
    : path.join(__dirname, '..', '..', 'server-edition', 'src', 'index.ts')

  const env = {
    ...process.env,
    BROWSEROS_MODE: 'local',
    SERVER_PORT: String(SERVER_PORT),
    CDP_PORT: String(CDP_PORT),
    DB_PATH: path.join(app.getPath('userData'), 'browseros.db'),
  }

  serverProcess = spawn(bunPath, [entryPoint, '--mode=local'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    for (const line of lines) appendLog(line)
  })

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    for (const line of lines) appendLog(`[stderr] ${line}`)
  })

  serverProcess.on('error', (err) => {
    appendLog(`Server error: ${err.message}`)
    serverProcess = null
    sendStatus()
  })

  serverProcess.on('exit', (code) => {
    appendLog(`Server exited with code ${code}`)
    serverProcess = null
    sendStatus()
  })

  sendStatus()
}

function stopServer(): void {
  if (!serverProcess) return

  appendLog('Stopping server...')
  const proc = serverProcess
  serverProcess = null

  proc.kill('SIGTERM')
  setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL')
  }, 5000)

  sendStatus()
}

function appendLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString()
  const entry = `[${timestamp}] ${message}`
  serverLogs.push(entry)
  if (serverLogs.length > 500) serverLogs.shift()
  mainWindow?.webContents.send('log', entry)
}

function sendStatus(): void {
  const status = {
    running: serverProcess !== null,
    port: SERVER_PORT,
    cdpPort: CDP_PORT,
    pid: serverProcess?.pid ?? null,
    uptime: 0,
  }
  mainWindow?.webContents.send('status', status)
  ipcMain.emit('server-state-changed')
}

// IPC handlers
ipcMain.handle('get-status', () => ({
  running: serverProcess !== null,
  port: SERVER_PORT,
  cdpPort: CDP_PORT,
  pid: serverProcess?.pid ?? null,
}))

ipcMain.handle('get-logs', () => serverLogs)
ipcMain.handle('start-server', () => startServer())
ipcMain.handle('stop-server', () => stopServer())
ipcMain.handle('get-version', () => app.getVersion())

// App lifecycle
app.whenReady().then(() => {
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  // Keep running in tray on macOS
})

app.on('before-quit', () => {
  stopServer()
  tray?.destroy()
})
