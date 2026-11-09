import { contextBridge, ipcRenderer } from 'electron'

interface OverlayUpdate {
  active?: boolean
  label?: string
  stopKey?: string
  shortcutRegistered?: boolean
  cursor?: { x: number; y: number }
  pulse?: boolean
}

contextBridge.exposeInMainWorld('aiOverlay', {
  onUpdate(listener: (state: OverlayUpdate) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, state: OverlayUpdate) => listener(state)
    ipcRenderer.on('overlay:update', wrapped)
    return () => ipcRenderer.removeListener('overlay:update', wrapped)
  }
})
