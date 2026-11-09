import { globalShortcut } from 'electron'
import { settings } from './settings'
import { emergencyStop } from './emergency'
import { aiOverlay } from './computer/overlay'
import { log } from './core/logger'

export function applyStopShortcut() {
  globalShortcut.unregisterAll()
  const accelerator = settings.get().computer.stopShortcut || 'Control+Alt+Shift+X'
  try {
    const ok = globalShortcut.register(accelerator, () => {
      void emergencyStop()
    })
    if (ok) log.info('shortcuts', `Emergency stop shortcut registered: ${accelerator}`)
    else log.warn('shortcuts', `Could not register emergency shortcut ${accelerator} (already in use?)`)
  } catch (err) {
    log.warn('shortcuts', `Invalid emergency shortcut "${accelerator}"`, String(err))
  }
  // unregisterAll() above also removed the overlay's Escape binding while a test is active.
  aiOverlay.refreshStopShortcut()
}

export function unregisterShortcuts() {
  globalShortcut.unregisterAll()
}
