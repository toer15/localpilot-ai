import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import packageJson from '../../../package.json'

let cached: ReturnType<typeof compute> | null = null

function compute() {
  const userData = app.getPath('userData')
  const dataDir = path.join(userData, 'data')
  const modelsDir = path.join(userData, 'models')
  const logsDir = path.join(userData, 'logs')
  const captureDir = path.join(userData, 'captures')
  const pluginsDir = path.join(userData, 'plugins')
  const browserDir = path.join(userData, 'browser')
  for (const dir of [dataDir, modelsDir, logsDir, captureDir, pluginsDir, browserDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return {
    userData,
    dataDir,
    modelsDir,
    logsDir,
    captureDir,
    pluginsDir,
    browserDir,
    dbFile: path.join(dataDir, 'localpilot.db'),
    logFile: path.join(logsDir, 'main.log')
  }
}

export function getPaths() {
  if (!cached) cached = compute()
  return cached
}

/** Packaged builds report the installer version; dev must not report Electron's version. */
export function appVersion(): string {
  return app.isPackaged ? app.getVersion() : packageJson.version
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function safeFileName(input: string, fallback = 'file') {
  const cleaned = input.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/, '').trim()
  return cleaned.length ? cleaned.slice(0, 120) : fallback
}
