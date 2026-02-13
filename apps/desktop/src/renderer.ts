declare global {
  interface Window {
    browseros: {
      getStatus: () => Promise<ServerStatus>
      getLogs: () => Promise<string[]>
      startServer: () => Promise<void>
      stopServer: () => Promise<void>
      getVersion: () => Promise<string>
      onLog: (callback: (message: string) => void) => () => void
      onStatus: (callback: (status: ServerStatus) => void) => () => void
    }
  }
}

interface ServerStatus {
  running: boolean
  port: number
  cdpPort: number
  pid: number | null
}

const statusDot = document.getElementById('statusDot')!
const statusTitle = document.getElementById('statusTitle')!
const statusSub = document.getElementById('statusSub')!
const actionBtn = document.getElementById('actionBtn')!
const apiUrl = document.getElementById('apiUrl')!
const cdpUrl = document.getElementById('cdpUrl')!
const pidValue = document.getElementById('pidValue')!
const logContainer = document.getElementById('logContainer')!
const versionText = document.getElementById('versionText')!

let isRunning = false

function updateUI(status: ServerStatus) {
  isRunning = status.running

  if (status.running) {
    statusDot.classList.add('running')
    statusTitle.textContent = 'Running'
    statusSub.textContent = `Server active on port ${status.port}`
    actionBtn.textContent = 'Stop'
    actionBtn.className = 'btn btn-stop'
    apiUrl.textContent = `localhost:${status.port}`
    cdpUrl.textContent = `${status.cdpPort}`
    pidValue.textContent = status.pid ? String(status.pid) : '—'
  } else {
    statusDot.classList.remove('running')
    statusTitle.textContent = 'Stopped'
    statusSub.textContent = 'Click Start to launch the server'
    actionBtn.textContent = 'Start'
    actionBtn.className = 'btn btn-start'
    apiUrl.textContent = '—'
    cdpUrl.textContent = '—'
    pidValue.textContent = '—'
  }
}

function addLog(message: string) {
  const line = document.createElement('div')
  line.className = 'log-line'

  if (message.includes('error') || message.includes('stderr')) {
    line.classList.add('error')
  } else if (
    message.includes('running') ||
    message.includes('started') ||
    message.includes('ready')
  ) {
    line.classList.add('success')
  }

  line.textContent = message
  logContainer.appendChild(line)
  logContainer.scrollTop = logContainer.scrollHeight
}

// @ts-expect-error - called from onclick in HTML
window.toggleServer = async function toggleServer() {
  actionBtn.disabled = true
  if (isRunning) {
    await window.browseros.stopServer()
  } else {
    await window.browseros.startServer()
  }
  actionBtn.disabled = false
}

// Subscribe to events
window.browseros.onLog((message) => addLog(message))
window.browseros.onStatus((status) => updateUI(status))

// Initial load
async function init() {
  const [status, logs, version] = await Promise.all([
    window.browseros.getStatus(),
    window.browseros.getLogs(),
    window.browseros.getVersion(),
  ])

  updateUI(status)
  for (const log of logs) addLog(log)
  versionText.textContent = `BrowserOS Desktop v${version}`
}

init()
