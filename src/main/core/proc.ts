import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './logger'

const liveChildren = new Set<ChildProcessWithoutNullStreams>()

export interface ProcResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  durationMs: number
}

export function registerChild(child: ChildProcessWithoutNullStreams) {
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  return child
}

export function killAllChildren() {
  for (const child of liveChildren) {
    killTree(child)
  }
  liveChildren.clear()
}

export function killTree(child: ChildProcessWithoutNullStreams) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // best effort
  }
}

/** Encode a PowerShell script to avoid all shell quoting issues. */
export function encodePowerShell(script: string) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export interface RunPowerShellOptions {
  cwd?: string
  timeoutMs?: number
  sta?: boolean
  env?: Record<string, string>
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  track?: boolean
  signal?: AbortSignal
}

export function runPowerShell(script: string, options: RunPowerShellOptions = {}): Promise<ProcResult> {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  if (options.sta) args.push('-Sta')
  args.push('-EncodedCommand', encodePowerShell(script))
  return runProcess('powershell.exe', args, options)
}

/**
 * Run a large PowerShell script from a temporary file. Windows limits the whole
 * command line (including an -EncodedCommand payload) to 32767 characters, while
 * the Computer Use engine embeds a C# P/Invoke block that easily exceeds it.
 */
export async function runPowerShellFile(
  script: string,
  options: RunPowerShellOptions = {}
): Promise<ProcResult> {
  const file = path.join(os.tmpdir(), `localpilot-${randomUUID()}.ps1`)
  fs.writeFileSync(file, `\uFEFF${script}`, 'utf8')
  try {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
    if (options.sta) args.push('-Sta')
    args.push('-File', file)
    return await runProcess('powershell.exe', args, options)
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      // best effort cleanup
    }
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: RunPowerShellOptions = {}
): Promise<ProcResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env, ...(options.env ?? {}) }
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        code: null,
        timedOut: false,
        durationMs: Date.now() - started
      })
      return
    }
    if (options.track !== false) registerChild(child)

    const onAbort = () => {
      if (settled) return
      killTree(child)
      setTimeout(() => finish(null), 250)
    }
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - started })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // Give taskkill a moment, then resolve regardless.
      setTimeout(() => finish(null), 800)
    }, Math.max(1000, options.timeoutMs ?? 30000))

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      stdout += text
      options.onStdout?.(text)
      if (stdout.length > 4_000_000) stdout = stdout.slice(-3_000_000)
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      stderr += text
      options.onStderr?.(text)
      if (stderr.length > 1_000_000) stderr = stderr.slice(-800_000)
    })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const first = trimmed.search(/[[{]/)
    const last = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

export async function which(command: string): Promise<string | null> {
  const res = await runProcess('where.exe', [command], { timeoutMs: 5000 })
  if (res.code === 0) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first) return first
  }
  return null
}

export function logProc(scope: string, command: string, result: ProcResult) {
  log.debug(scope, `${command} exited ${result.code} in ${result.durationMs}ms`, {
    stderr: result.stderr.slice(0, 500)
  })
}
