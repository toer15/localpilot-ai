import { BrowserWindow } from 'electron'

export function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // window may be closing
    }
  }
}
