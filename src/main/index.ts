import { app, BrowserWindow, Menu, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { initDatabase, saveNow, closeDatabase } from './db'
import { settings } from './settings'
import { setLogLevel, log } from './core/logger'
import { getPaths } from './core/paths'
import { registerIpc } from './ipc'
import { registerBuiltinTools } from './tools'
import { ensureBuiltinPlugins } from './plugins/builtins'
import { pluginManager, registerPluginToolProvider } from './plugins/manager'
import { applyStopShortcut, unregisterShortcuts } from './shortcuts'
import { killAllChildren } from './core/proc'
import { llamaServer } from './providers/llama'
import { browserManager } from './browser'
import { activityEvents } from './activity'
import { broadcast } from './broadcast'
import { terminalEvents } from './tools/terminal'
import { runSelfTest } from './selftest'
import { aiOverlay } from './computer/overlay'
import { initUpdater, setUpdateBusyCheck, setUpdateInstallHandler } from './updater'
import { agentRunner } from './agent/agent'

const isSelfTest = process.argv.includes('--self-test')
let mainWindow: BrowserWindow | null = null
let shuttingDown = false

app.setAppUserModelId('ai.localpilot.desktop')
app.setName('LocalPilot AI')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock && !isSelfTest) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('LocalPilot failed to start', err)
    log.error('main', 'Startup failed', String(err))
    app.exit(1)
  })
}

async function bootstrap() {
  const paths = getPaths()
  await initDatabase()
  const s = settings.init()
  setLogLevel(s.advanced.logLevel)
  ensureBuiltinPlugins()
  registerBuiltinTools()
  registerPluginToolProvider()
  registerIpc()

  activityEvents.on('activity', (item) => broadcast('activity:update', item))
  terminalEvents.on('update', (session) => broadcast('terminal:update', session))

  await pluginManager.init().catch((err) => log.warn('plugins', 'Plugin startup failed', String(err)))
  applyStopShortcut()

  log.info('main', `LocalPilot AI started (Electron ${process.versions.electron}, data ${paths.userData})`)

  if (isSelfTest) {
    try {
      const report = await runSelfTest({ fullChat: true, screenshot: true })
      process.stdout.write(`\nSELFTEST_JSON_BEGIN\n${JSON.stringify(report, null, 2)}\nSELFTEST_JSON_END\n`)
      const failed = report.checks.filter((c) => c.status === 'fail')
      process.stdout.write(
        `SELFTEST_SUMMARY: ${report.checks.length} checks, ${failed.length} failed\n`
      )
      if (failed.length) process.exitCode = 1
    } catch (err) {
      console.error('SELF-TEST FAILED', err)
      process.exitCode = 1
    } finally {
      await shutdown()
      app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
    }
    return
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // The renderer needs no web permissions; computer use is explicit IPC.
    if (permission === 'clipboard-sanitized-write') callback(true)
    else callback(false)
  })

  createWindow()
  setUpdateInstallHandler(shutdown)
  // Never restart for an update in the middle of an agent task.
  setUpdateBusyCheck(() => agentRunner.active().length > 0)
  initUpdater()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0b0e',
    autoHideMenuBar: true,
    title: 'LocalPilot AI',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      devTools: true
    }
  })

  Menu.setApplicationMenu(null)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (process.env.LOCALPILOT_DEVTOOLS === '1') mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    saveNow()
    await pluginManager.shutdown()
  } catch (err) {
    log.warn('main', 'Plugin shutdown error', String(err))
  }
  aiOverlay.dispose()
  try {
    await browserManager.close()
  } catch {
    // ignore
  }
  try {
    await llamaServer.stop()
  } catch {
    // ignore
  }
  killAllChildren()
  closeDatabase()
  unregisterShortcuts()
}

app.on('window-all-closed', () => {
  if (!isSelfTest) app.quit()
})

app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  void shutdown().finally(() => {
    app.exit(0)
  })
})

app.on('activate', () => {
  if (!mainWindow && !isSelfTest) createWindow()
})

process.on('uncaughtException', (err) => {
  log.error('main', 'Uncaught exception', err.stack ?? String(err))
})
process.on('unhandledRejection', (reason) => {
  log.error('main', 'Unhandled rejection', String(reason))
})
