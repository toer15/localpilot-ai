import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppUpdateStatus } from '@shared/types'
import { appVersion } from './core/paths'
import { log } from './core/logger'
import { broadcast } from './broadcast'

const INITIAL_CHECK_DELAY_MS = 12_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/**
 * Installed builds update themselves: when a download finishes, LocalPilot
 * installs it silently and restarts. The user never walks through the setup
 * wizard. A run that is still working may finish first.
 */
const AUTO_INSTALL_DELAY_MS = 6_000
const AUTO_INSTALL_RETRY_MS = 10_000

let initialized = false
let checking = false
let beforeInstall: (() => Promise<void> | void) | null = null
let autoInstallTimer: NodeJS.Timeout | null = null
let autoInstalling = false
let busyCheck: (() => boolean) | null = null
let status: AppUpdateStatus = {
  phase: 'idle',
  currentVersion: appVersion()
}

function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (typeof notes === 'string') {
    const text = notes.trim()
    return text ? text.slice(0, 12_000) : undefined
  }
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return String(entry ?? '')
        const note = entry as { version?: string; note?: string | null }
        return `${note.version ? `v${note.version}\n` : ''}${note.note ?? ''}`
      })
      .join('\n\n')
      .trim()
    return text ? text.slice(0, 12_000) : undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error:\s*/i, '').slice(0, 600) || 'The update check failed.'
}

function publish(patch: Partial<AppUpdateStatus>) {
  status = { ...status, ...patch, currentVersion: appVersion() }
  broadcast('updater:status', status)
}

function initEvents() {
  autoUpdater.on('checking-for-update', () => {
    publish({ phase: 'checking', message: 'Checking GitHub Releases…' })
  })
  autoUpdater.on('update-available', (info) => {
    log.info('updater', `Update available: ${info.version}`)
    publish({
      phase: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      message: `LocalPilot AI ${info.version} is available. Downloading the update…`
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    publish({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      message: 'Downloading the update…'
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('updater', `Update downloaded: ${info.version}`)
    publish({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      message: `LocalPilot AI ${info.version} is ready. Installing and restarting automatically…`
    })
    scheduleAutoInstall()
  })
  autoUpdater.on('update-not-available', () => {
    publish({
      phase: 'up-to-date',
      message: 'You are running the latest version of LocalPilot AI.'
    })
  })
  autoUpdater.on('update-cancelled', () => {
    publish({ phase: 'error', message: 'The update download was cancelled.' })
  })
  autoUpdater.on('error', (error) => {
    checking = false
    log.warn('updater', 'Update error', errorMessage(error))
    publish({ phase: 'error', message: errorMessage(error) })
  })
}

export function initUpdater(): AppUpdateStatus {
  if (initialized) return getUpdateStatus()
  initialized = true
  status = {
    phase: app.isPackaged ? 'idle' : 'unsupported',
    currentVersion: appVersion(),
    message: app.isPackaged ? undefined : 'Update checks are available in installed builds.'
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.logger = null
  initEvents()

  if (app.isPackaged) {
    const firstCheck = setTimeout(() => void checkForUpdates(false), INITIAL_CHECK_DELAY_MS)
    firstCheck.unref()
    const interval = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS)
    interval.unref()
  }
  return getUpdateStatus()
}

export function getUpdateStatus(): AppUpdateStatus {
  return { ...status, currentVersion: appVersion() }
}

export async function checkForUpdates(manual = true): Promise<AppUpdateStatus> {
  if (!app.isPackaged) {
    publish({
      phase: 'unsupported',
      message: 'Update checks are available in installed builds.'
    })
    return getUpdateStatus()
  }
  if (checking) return getUpdateStatus()
  checking = true
  if (status.phase !== 'downloading' && status.phase !== 'downloaded') {
    publish({ phase: 'checking', message: manual ? 'Checking GitHub Releases…' : 'Checking for updates…' })
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({ phase: 'error', message: errorMessage(error) })
  } finally {
    checking = false
  }
  return getUpdateStatus()
}

export function setUpdateInstallHandler(handler: () => Promise<void> | void) {
  beforeInstall = handler
}

/** Registered by the app so an update never interrupts a running agent task. */
export function setUpdateBusyCheck(check: () => boolean) {
  busyCheck = check
}

function scheduleAutoInstall(delay = AUTO_INSTALL_DELAY_MS) {
  if (autoInstalling) return
  if (autoInstallTimer) clearTimeout(autoInstallTimer)
  autoInstallTimer = setTimeout(() => void runAutoInstall(), delay)
  autoInstallTimer.unref()
}

async function runAutoInstall() {
  autoInstallTimer = null
  if (autoInstalling || status.phase !== 'downloaded') return
  if (busyCheck?.()) {
    publish({
      message: `LocalPilot AI ${status.version ?? 'update'} is ready. Waiting for the current task to finish, then restarting and installing…`
    })
    scheduleAutoInstall(AUTO_INSTALL_RETRY_MS)
    return
  }
  autoInstalling = true
  log.info('updater', `Installing ${status.version ?? 'the update'} automatically and restarting`)
  publish({
    phase: 'downloaded',
    percent: 100,
    message: status.version
      ? `Restarting to install LocalPilot AI ${status.version}…`
      : 'Restarting to install the update…'
  })
  try {
    await installUpdate()
  } catch (error) {
    autoInstalling = false
    log.warn('updater', 'Automatic install failed', errorMessage(error))
    publish({
      phase: 'error',
      message: `${errorMessage(error)} Use Settings → About → Install update to retry.`
    })
  }
}

export async function installUpdate(): Promise<AppUpdateStatus> {
  if (status.phase !== 'downloaded') {
    throw new Error('No downloaded update is ready to install.')
  }
  try {
    if (beforeInstall) await beforeInstall()
    // Silent install: NSIS runs without its wizard, then the app relaunches.
    autoUpdater.quitAndInstall(true, true)
  } catch (error) {
    const message = errorMessage(error)
    publish({ phase: 'error', message })
    throw new Error(message)
  }
  return getUpdateStatus()
}
