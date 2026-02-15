import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browseros', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  onLog: (callback: (message: string) => void) => {
    const handler = (_event: unknown, message: string) => callback(message)
    ipcRenderer.on('log', handler)
    return () => ipcRenderer.removeListener('log', handler)
  },

  onStatus: (callback: (status: ServerStatus) => void) => {
    const handler = (_event: unknown, status: ServerStatus) => callback(status)
    ipcRenderer.on('status', handler)
    return () => ipcRenderer.removeListener('status', handler)
  },
})

interface ServerStatus {
  running: boolean
  port: number
  cdpPort: number
  pid: number | null
}
