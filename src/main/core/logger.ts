import fs from 'node:fs'
import path from 'node:path'
import { getPaths } from './paths'

type Level = 'info' | 'warn' | 'error' | 'debug'

let logLevel: 'info' | 'debug' = 'info'
const buffer: string[] = []

export function setLogLevel(level: 'info' | 'debug') {
  logLevel = level
}

function write(level: Level, scope: string, message: string, extra?: unknown) {
  if (level === 'debug' && logLevel !== 'debug') return
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}`
  if (extra !== undefined) {
    try {
      line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
    } catch {
      line += ' [unserializable]'
    }
  }
  buffer.push(line)
  if (buffer.length > 800) buffer.shift()
  try {
    fs.appendFileSync(path.join(getPaths().logsDir, 'main.log'), line + '\n')
  } catch {
    // logging must never break the app
  }
  if (level === 'error') console.error(line)
  else if (logLevel === 'debug') console.log(line)
}

export const log = {
  info: (scope: string, message: string, extra?: unknown) => write('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => write('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => write('error', scope, message, extra),
  debug: (scope: string, message: string, extra?: unknown) => write('debug', scope, message, extra),
  recent: (limit = 200) => buffer.slice(-limit)
}
