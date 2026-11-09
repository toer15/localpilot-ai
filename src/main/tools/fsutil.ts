import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { settings } from '../settings'
import type { ToolContext } from './types'

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'out',
  'dist',
  'release',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vs',
  'coverage',
  'target',
  'bin',
  'obj'
])

export function fullAccessEnabled(): boolean {
  return settings.get().computer.fullAccess === true
}

export function projectRoot(ctx: ToolContext): string {
  if (ctx.projectPath) return path.resolve(ctx.projectPath)
  if (fullAccessEnabled()) return os.homedir()
  throw new Error(
    'No project folder is open. Open a project, or enable Full PC access in Settings → Computer Use to work with files anywhere on this PC.'
  )
}

export function resolveProjectPath(input: unknown, ctx: ToolContext): string {
  const fullAccess = fullAccessEnabled()
  const root = ctx.projectPath
    ? path.resolve(ctx.projectPath)
    : fullAccess
      ? os.homedir()
      : projectRoot(ctx)
  const rel = typeof input === 'string' && input.trim() ? input.trim() : '.'
  const target = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel)
  if (!fullAccess && ctx.projectPath) {
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Path "${rel}" is outside the active project folder (${root}). Enable Full PC access in Settings → Computer Use, or use a path inside the project.`
      )
    }
  }
  return target
}

export function relativeToProject(target: string, ctx: ToolContext): string {
  const root = projectRoot(ctx)
  const relative = path.relative(root, target)
  if (!relative) return '.'
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.resolve(target).replace(/\\/g, '/')
  }
  return relative.replace(/\\/g, '/')
}

/** Refuse the handful of delete targets that would break the OS or the user profile. */
export function isProtectedDeleteTarget(target: string): boolean {
  const resolved = path.resolve(target).toLowerCase()
  if (resolved === path.parse(resolved).root.toLowerCase()) return true
  const protectedPaths = [
    process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    os.homedir(),
    path.join(path.parse(os.homedir()).root, 'Users')
  ].filter(Boolean) as string[]
  return protectedPaths.some((candidate) => path.resolve(candidate).toLowerCase() === resolved)
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

export function walkProject(
  root: string,
  options: { maxDepth?: number; limit?: number } = {}
): { path: string; isDir: boolean; size: number; modifiedAt: string }[] {
  const maxDepth = options.maxDepth ?? 10
  const limit = options.limit ?? 1500
  const out: { path: string; isDir: boolean; size: number; modifiedAt: string }[] = []

  function walk(dir: string, depth: number) {
    if (out.length >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= limit) break
      if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue
      if (IGNORED_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        out.push({ path: rel, isDir: true, size: 0, modifiedAt: '' })
        if (depth < maxDepth) walk(abs, depth + 1)
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(abs)
          out.push({ path: rel, isDir: false, size: stat.size, modifiedAt: stat.mtime.toISOString() })
        } catch {
          // ignore unreadable file
        }
      }
    }
  }

  walk(root, 0)
  return out
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`
}

/** Apply a standard unified diff to a text file. */
export function applyUnifiedDiff(original: string, patch: string): string {
  const originalLines = original.split(/\r?\n/)
  const patchLines = patch.split(/\r?\n/)
  const output: string[] = []
  let cursor = 0
  let hunks = 0
  let i = 0
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  while (i < patchLines.length) {
    const match = hunkHeader.exec(patchLines[i])
    if (!match) {
      i++
      continue
    }
    hunks++
    const oldStart = Number(match[1]) - 1
    const oldCount = Number(match[2] ?? '1')
    i++
    const body: string[] = []
    while (i < patchLines.length && !hunkHeader.test(patchLines[i]) && !patchLines[i].startsWith('--- ')) {
      body.push(patchLines[i])
      i++
    }
    while (cursor < oldStart && cursor < originalLines.length) {
      output.push(originalLines[cursor++])
    }
    let consumed = 0
    for (const line of body) {
      if (line.startsWith('\\ No newline')) continue
      const prefix = line[0]
      const text = line.slice(1)
      if (prefix === ' ') {
        output.push(text)
        cursor++
        consumed++
      } else if (prefix === '-') {
        cursor++
        consumed++
      } else if (prefix === '+') {
        output.push(text)
      } else if (line === '') {
        output.push('')
        cursor++
        consumed++
      }
    }
    if (consumed < oldCount && cursor < originalLines.length) {
      // tolerate slightly malformed counts from models
    }
  }
  if (hunks === 0) throw new Error('No @@ hunks found. Provide a standard unified diff with @@ -a,b +c,d @@ headers.')
  while (cursor < originalLines.length) output.push(originalLines[cursor++])
  return output.join('\n')
}

export function summariseDiff(before: string, after: string, file: string): string {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let added = 0
  let removed = 0
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) removed++
    if (b[i] !== undefined) added++
  }
  return `${file}: +${added} / -${removed} lines (${b.length} lines total)`
}
