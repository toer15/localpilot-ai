import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition, ToolExecutionResult } from './types'
import { fail, num, ok, requireString, str } from './types'
import {
  applyUnifiedDiff,
  formatBytes,
  isProbablyBinary,
  isProtectedDeleteTarget,
  relativeToProject,
  resolveProjectPath,
  summariseDiff,
  walkProject
} from './fsutil'
import { recordActivity } from '../activity'

const MAX_READ = 2 * 1024 * 1024
const MAX_WRITE = 8 * 1024 * 1024

function readText(target: string): string {
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('Path is not a file.')
  if (stat.size > MAX_READ) throw new Error(`File is too large to read (${formatBytes(stat.size)}; limit 2 MB). Use files.search instead.`)
  const buffer = fs.readFileSync(target)
  if (isProbablyBinary(buffer)) throw new Error('File appears to be binary and cannot be read as text.')
  return buffer.toString('utf8')
}

export const filesTools: ToolDefinition[] = [
  {
    name: 'files.read',
    description:
      'Read a UTF-8 text file. Absolute paths are allowed with Full PC access; otherwise paths are relative to the active project. Use line offsets for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path; absolute when Full PC access is on, otherwise relative to the active project.'
        },
        offset: { type: 'number', description: '1-based first line to return. Optional.' },
        limit: { type: 'number', description: 'Maximum number of lines. Optional; default all (max 4000).' }
      },
      required: ['path']
    },
    risk: 'low',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Read ${str(args.path)}`,
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      const raw = readText(target)
      const lines = raw.split(/\r?\n/)
      const offset = Math.max(1, num(args.offset, 1))
      const limit = Math.max(1, Math.min(num(args.limit, 4000), 4000))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((line, idx) => `${String(offset + idx).padStart(5)}│ ${line}`).join('\n')
      return ok(
        `File: ${relativeToProject(target, ctx)} (${lines.length} lines, ${formatBytes(Buffer.byteLength(raw))})${
          slice.length < lines.length ? ` — showing lines ${offset}–${Math.min(lines.length, offset + limit - 1)}` : ''
        }\n${numbered}`,
        { path: target, lines: lines.length }
      )
    }
  },
  {
    name: 'files.write',
    description:
      'Create or overwrite a UTF-8 text file. Absolute paths are allowed with Full PC access; otherwise paths are relative to the active project. Creates missing parent folders. Read existing files before overwriting them.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path; absolute when Full PC access is on, otherwise relative to the active project.'
        },
        content: { type: 'string', description: 'Complete new file content.' }
      },
      required: ['path', 'content']
    },
    risk: 'medium',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Write ${str(args.path)} (${formatBytes(Buffer.byteLength(str(args.content)))})`,
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      const content = str(args.content)
      if (Buffer.byteLength(content) > MAX_WRITE) return fail('Content exceeds the 8 MB write limit.')
      let before = ''
      const existed = fs.existsSync(target)
      if (existed) before = readText(target).slice(0, 500_000)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf8')
      recordActivity('file-write', `Wrote ${relativeToProject(target, ctx)}`)
      return ok(
        `${existed ? 'Overwrote' : 'Created'} ${relativeToProject(target, ctx)} (${content.split(/\r?\n/).length} lines, ${formatBytes(Buffer.byteLength(content))}).${
          existed ? ' ' + summariseDiff(before, content, relativeToProject(target, ctx)) : ''
        }`,
        { path: target, bytes: Buffer.byteLength(content) }
      )
    }
  },
  {
    name: 'files.edit',
    description:
      'Edit a text file by replacing an exact block of text. Absolute paths are allowed with Full PC access. Read the file first and include enough surrounding context so the old text is unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string', description: 'Exact existing text to replace.' },
        newText: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' }
      },
      required: ['path', 'oldText', 'newText']
    },
    risk: 'medium',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Edit ${str(args.path)}`,
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      const oldText = str(args.oldText)
      if (!oldText) return fail('oldText must not be empty.')
      const original = readText(target)
      const count = original.split(oldText).length - 1
      if (count === 0) {
        return fail(
          'The oldText was not found exactly. Re-read the file and copy the exact text, including whitespace and line endings.'
        )
      }
      const replaceAll = args.replaceAll === true
      if (count > 1 && !replaceAll) {
        return fail(`oldText occurs ${count} times. Add more context to make it unique, or set replaceAll:true.`)
      }
      const updated = replaceAll ? original.split(oldText).join(str(args.newText)) : original.replace(oldText, str(args.newText))
      fs.writeFileSync(target, updated, 'utf8')
      recordActivity('file-edit', `Edited ${relativeToProject(target, ctx)}`)
      return ok(
        `Edited ${relativeToProject(target, ctx)} (${count} replacement${count === 1 ? '' : 's'}). ${summariseDiff(
          original,
          updated,
          relativeToProject(target, ctx)
        )}`,
        { path: target }
      )
    }
  },
  {
    name: 'files.apply_patch',
    description:
      'Apply a standard unified diff (@@ hunks) to a text file. Absolute paths are allowed with Full PC access. Useful for multi-line edits produced by a diff tool.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        patch: { type: 'string', description: 'Unified diff content including @@ -a,b +c,d @@ headers.' }
      },
      required: ['path', 'patch']
    },
    risk: 'medium',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Apply patch to ${str(args.path)}`,
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      const original = readText(target)
      const updated = applyUnifiedDiff(original, str(args.patch))
      fs.writeFileSync(target, updated, 'utf8')
      recordActivity('file-patch', `Patched ${relativeToProject(target, ctx)}`)
      return ok(`Patched ${relativeToProject(target, ctx)}. ${summariseDiff(original, updated, relativeToProject(target, ctx))}`)
    }
  },
  {
    name: 'files.list',
    description:
      'List files and folders as a compact tree. Absolute paths are allowed with Full PC access; otherwise paths are relative to the active project. Hidden build folders are skipped.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subfolder, optional.' },
        depth: { type: 'number', description: 'Maximum recursion depth (default 3).' },
        limit: { type: 'number', description: 'Maximum entries (default 400).' }
      }
    },
    risk: 'low',
    category: 'files',
    group: 'files',
    source: 'builtin',
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      if (!fs.existsSync(target)) return fail('Folder does not exist.')
      if (!fs.statSync(target).isDirectory()) return fail('Path is not a directory.')
      const entries = walkProject(target, {
        maxDepth: num(args.depth, 3),
        limit: Math.min(num(args.limit, 400), 1200)
      })
      const root = relativeToProject(target, ctx)
      const lines = entries.map((entry) => `${entry.isDir ? '📁' : '  '} ${entry.path}${entry.isDir ? '/' : `  (${formatBytes(entry.size)})`}`)
      return ok(
        `Location: ${root === '.' ? projectRootLabel(ctx) : root}\n${entries.length} entries\n\n${lines.join('\n')}`,
        { count: entries.length }
      )
    }
  },
  {
    name: 'files.search',
    description:
      'Search file contents within a folder. Absolute paths are allowed with Full PC access. Skips node_modules and build output.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        path: { type: 'string', description: 'Optional subfolder to search.' },
        regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'number', description: 'Default 100, max 300.' }
      },
      required: ['query']
    },
    risk: 'low',
    category: 'files',
    group: 'files',
    source: 'builtin',
    handler: async (args, ctx) => {
      const query = requireString(args, 'query')
      const base = resolveProjectPath(args.path, ctx)
      const caseSensitive = args.caseSensitive === true
      let matcher: RegExp
      try {
        matcher = args.regex
          ? new RegExp(query, caseSensitive ? 'g' : 'gi')
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
      } catch (err) {
        return fail(`Invalid regular expression: ${String(err)}`)
      }
      const maxResults = Math.min(num(args.maxResults, 100), 300)
      const files = walkProject(base, { maxDepth: 12, limit: 6000 }).filter((f) => !f.isDir && f.size < 1_000_000)
      const results: string[] = []
      for (const file of files) {
        if (results.length >= maxResults) break
        try {
          const raw = fs.readFileSync(path.join(base, file.path), 'utf8')
          const lines = raw.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            matcher.lastIndex = 0
            if (matcher.test(lines[i])) {
              results.push(`${file.path}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
              if (results.length >= maxResults) break
            }
          }
        } catch {
          // binary/unreadable
        }
      }
      return ok(
        results.length
          ? `Found ${results.length} match(es)${results.length >= maxResults ? ' (limit reached)' : ''}:\n${results.join('\n')}`
          : `No matches for "${query}" in ${relativeToProject(base, ctx)}.`,
        { count: results.length }
      )
    }
  },
  {
    name: 'files.mkdir',
    description: 'Create a folder. Absolute paths are allowed with Full PC access; otherwise the path is relative to the active project.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    risk: 'low',
    category: 'files',
    group: 'files',
    source: 'builtin',
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      fs.mkdirSync(target, { recursive: true })
      return ok(`Created folder ${relativeToProject(target, ctx)}.`)
    }
  },
  {
    name: 'files.delete',
    description:
      'Delete a file or folder. Absolute paths are allowed with Full PC access. Requires approval and is irreversible; drive roots, Windows, Program Files, ProgramData and the user-profile root are refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Required for non-empty folders.' }
      },
      required: ['path']
    },
    risk: 'high',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Permanently delete ${str(args.path)}${args.recursive ? ' (and everything inside)' : ''}.`,
    handler: async (args, ctx) => {
      const target = resolveProjectPath(args.path, ctx)
      if (!fs.existsSync(target)) return fail('Path does not exist.')
      if (ctx.projectPath && path.resolve(target).toLowerCase() === path.resolve(ctx.projectPath).toLowerCase()) {
        return fail('Refusing to delete the project root.')
      }
      if (isProtectedDeleteTarget(target)) {
        return fail('Refusing to delete a protected system or user-profile root. Choose a specific file or subfolder.')
      }
      fs.rmSync(target, { recursive: args.recursive === true, force: false })
      recordActivity('file-delete', `Deleted ${relativeToProject(target, ctx)}`)
      return ok(`Deleted ${relativeToProject(target, ctx)}.`)
    }
  },
  {
    name: 'files.move',
    description:
      'Move or rename a file or folder. Absolute paths are allowed with Full PC access; otherwise paths are relative to the active project.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' }
      },
      required: ['from', 'to']
    },
    risk: 'high',
    category: 'files',
    group: 'files',
    source: 'builtin',
    preview: (args) => `Move ${str(args.from)} → ${str(args.to)}`,
    handler: async (args, ctx) => {
      const from = resolveProjectPath(args.from, ctx)
      const to = resolveProjectPath(args.to, ctx)
      if (!fs.existsSync(from)) return fail('Source does not exist.')
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, to)
      recordActivity('file-move', `Moved ${relativeToProject(from, ctx)} to ${relativeToProject(to, ctx)}`)
      return ok(`Moved ${relativeToProject(from, ctx)} → ${relativeToProject(to, ctx)}.`)
    }
  }
]

function projectRootLabel(ctx: { projectName?: string; projectPath?: string | null }) {
  return ctx.projectName || ctx.projectPath || 'home folder'
}
