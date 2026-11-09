import fs from 'node:fs'
import path from 'node:path'
import { getPaths, safeFileName } from '../core/paths'
import { runPowerShellFile, parseJsonLoose, runProcess } from '../core/proc'
import { computerScript } from '../computer/script'
import { log } from '../core/logger'
import type { UiElement } from '@shared/types'
import { aiOverlay } from './overlay'

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

export interface ComputerResult<T = Record<string, unknown>> {
  ok: boolean
  data: T
  error?: string
}

export async function runComputer<T = Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30000
): Promise<ComputerResult<T>> {
  const script = computerScript(action, payload)
  const res = await runPowerShellFile(script, { timeoutMs, sta: true })
  const parsed = parseJsonLoose<{ ok?: boolean; error?: string } & Record<string, unknown>>(res.stdout)
  if (!parsed) {
    log.warn('computer', `Action ${action} returned no JSON`, {
      stdout: res.stdout.slice(0, 300),
      stderr: res.stderr.slice(0, 500)
    })
    return {
      ok: false,
      data: {} as T,
      error:
        res.timedOut
          ? `Computer action timed out after ${timeoutMs}ms.`
          : res.stderr.trim().slice(0, 800) || 'PowerShell returned no result.'
    }
  }
  if (parsed.ok === false) {
    return { ok: false, data: parsed as T, error: String(parsed.error ?? 'Computer action failed.') }
  }
  const data = parsed as T & Record<string, unknown>
  const inputAction = String(payload.action ?? '')
  let target: { x: number; y: number } | null = null
  if (action === 'mouse') {
    const x = finiteNumber(inputAction === 'drag' ? payload.toX : data.x ?? payload.x)
    const y = finiteNumber(inputAction === 'drag' ? payload.toY : data.y ?? payload.y)
    if (x !== null && y !== null) target = { x, y }
  } else if (action === 'uia_click' || action === 'uia_set_value') {
    const x = finiteNumber(data.x)
    const y = finiteNumber(data.y)
    const width = finiteNumber(data.width)
    const height = finiteNumber(data.height)
    if (x !== null && y !== null && (width === null || width > 0) && (height === null || height > 0)) {
      target = { x, y }
    }
  }
  if (target) aiOverlay.setCursorFromScreen(target.x, target.y)
  else if (action === 'keyboard' || action === 'uia_click' || action === 'uia_set_value') aiOverlay.pulse()
  return { ok: true, data: parsed as T }
}

export interface ScreenshotResult {
  path: string
  width?: number
  height?: number
  dataUrl?: string
  bytes?: number
}

export async function captureScreen(): Promise<ScreenshotResult> {
  const file = path.join(
    getPaths().captureDir,
    `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  )
  const res = await runComputer<{ path: string; width: number; height: number }>(
    'screenshot',
    { path: file },
    20000
  )
  if (!res.ok) throw new Error(res.error ?? 'Screenshot failed')
  const finalPath = res.data.path || file
  if (!fs.existsSync(finalPath)) throw new Error('Screenshot was not written to disk')
  const bytes = fs.statSync(finalPath).size
  let dataUrl: string | undefined
  if (bytes < 8_000_000) {
    dataUrl = `data:image/png;base64,${fs.readFileSync(finalPath).toString('base64')}`
  }
  return {
    path: finalPath,
    width: res.data.width,
    height: res.data.height,
    bytes,
    dataUrl
  }
}

export interface WindowInfo {
  title: string
  processName: string
  pid: number
  hwnd: number
  minimized?: boolean
}

export async function listWindows(): Promise<WindowInfo[]> {
  const res = await runComputer<{ windows: (WindowInfo & { hwnd: string | number })[] }>('list_windows')
  if (!res.ok) throw new Error(res.error ?? 'Could not list windows')
  return (res.data.windows ?? []).map((w) => ({ ...w, hwnd: Number(w.hwnd) }))
}

export async function activeWindow(): Promise<{ hwnd: number; title: string }> {
  const res = await runComputer<{ hwnd: string; title: string }>('active_window')
  if (!res.ok) throw new Error(res.error ?? 'Could not read the active window')
  return { hwnd: Number(res.data.hwnd), title: res.data.title }
}

export async function focusWindow(target: { hwnd?: number; title?: string; processName?: string }) {
  return runComputer('focus', target)
}

export async function windowAction(action: 'minimize' | 'maximize' | 'close_window', target: { hwnd?: number; title?: string; processName?: string }) {
  return runComputer(action, target)
}

export async function launchExecutable(exePath: string, args?: string) {
  const res = await runComputer<{ pid: number; processName: string }>('launch', {
    path: exePath,
    arguments: args ?? ''
  })
  if (!res.ok) return res
  return res
}

export async function mouseAction(payload: Record<string, unknown>) {
  return runComputer('mouse', payload)
}

export async function keyboardAction(payload: Record<string, unknown>) {
  return runComputer('keyboard', payload)
}

export async function uiTree(depth = 3): Promise<UiElement[]> {
  const res = await runComputer<{ elements: UiElement[] }>('uia_tree', { depth })
  if (!res.ok) throw new Error(res.error ?? 'UI Automation tree failed')
  return res.data.elements ?? []
}

export async function uiaFind(query: Record<string, unknown>) {
  return runComputer<{ matches: UiElement[]; count: number }>('uia_find', query, 30000)
}

/** Resolve friendly app names to installed Windows executables, with Roblox Studio detection. */
export function resolveApp(name: string): string | null {
  const clean = name.trim()
  if (!clean) return null
  if (fs.existsSync(clean)) return clean
  const lower = clean.toLowerCase().replace(/\.exe$/, '')
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const userProfile = process.env.USERPROFILE ?? ''
  const known: Record<string, string[]> = {
    notepad: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')],
    calculator: ['calc.exe', path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'calc.exe')],
    paint: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mspaint.exe')],
    explorer: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')],
    'windows terminal': ['wt.exe'],
    terminal: ['wt.exe'],
    powershell: ['powershell.exe'],
    cmd: ['cmd.exe'],
    'visual studio code': [
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe')
    ],
    code: [path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')],
    'visual studio': [
      path.join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'devenv.exe')
    ],
    edge: [path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    chrome: [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ],
    'file explorer': [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')]
  }
  if (known[lower]) {
    for (const candidate of known[lower]) {
      if (!candidate.includes(path.sep) || fs.existsSync(candidate)) return candidate
    }
  }
  if (lower.includes('roblox')) {
    const versionsDir = path.join(localAppData, 'Roblox', 'Versions')
    try {
      const found = fs
        .readdirSync(versionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(versionsDir, d.name, 'RobloxStudioBeta.exe'))
        .find((p) => fs.existsSync(p))
      if (found) return found
    } catch {
      // not installed
    }
  }
  return clean
}

export async function appInstalled(exePath: string): Promise<boolean> {
  if (!path.isAbsolute(exePath)) {
    const res = await runProcess('where.exe', [exePath], { timeoutMs: 4000 })
    return res.code === 0
  }
  return fs.existsSync(exePath)
}

export function screenshotName(prefix = 'screen') {
  return path.join(
    getPaths().captureDir,
    safeFileName(`${prefix}-${Date.now()}.png`, 'capture.png')
  )
}
