import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Risk, TerminalSession } from '@shared/types'
import type { ToolDefinition } from './types'
import { fail, num, ok, requireString, str } from './types'
import { killTree, registerChild, runPowerShell } from '../core/proc'
import { recordActivity } from '../activity'
import { settings } from '../settings'
import { log } from '../core/logger'

interface InternalSession {
  meta: TerminalSession
  output: string
  child?: ReturnType<typeof spawn>
}

const sessions = new Map<string, InternalSession>()
export const terminalEvents = new EventEmitter()

function emit(session: TerminalSession) {
  terminalEvents.emit('update', session)
}

function pushOutput(session: InternalSession, chunk: string) {
  session.output = (session.output + chunk).slice(-300_000)
  session.meta.outputTail = session.output.slice(-6000)
  emit({ ...session.meta })
}

const DESTRUCTIVE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bformat(\.com)?\b/i, reason: 'disk formatting' },
  { re: /\bdiskpart\b/i, reason: 'disk partitioning' },
  { re: /\bbcdedit\b/i, reason: 'boot configuration' },
  { re: /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/i, reason: 'power state change' },
  { re: /remove-item[^\n]*-recurse/i, reason: 'recursive deletion' },
  { re: /\bdel\s+\/[a-z]*[sq]/i, reason: 'forced recursive deletion' },
  { re: /\brd\s+\/[a-z]*s/i, reason: 'recursive directory deletion' },
  { re: /\breg(\.exe)?\s+delete\b/i, reason: 'registry deletion' },
  { re: /\bregedit\b/i, reason: 'registry editor' },
  { re: /\btakeown\b|\bicacls\b/i, reason: 'permission changes' },
  { re: /\bnet\s+(user|localgroup)\b/i, reason: 'user/group modification' },
  { re: /\bsc(\.exe)?\s+delete\b/i, reason: 'service deletion' },
  { re: /\bwmic\b[^\n]*\bdelete\b/i, reason: 'WMI deletion' },
  { re: /\bset-executionpolicy\b/i, reason: 'PowerShell policy change' },
  { re: /\bstart-process[^\n]*-verb\s+runas\b/i, reason: 'administrator elevation' },
  { re: /\btaskkill[^\n]*\/f[^\n]*\/im\b/i, reason: 'force-killing all processes by name' }
]

export function commandRisk(command: string): { risk: Risk; reason?: string } {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.re.test(command)) return { risk: 'high', reason: pattern.reason }
  }
  return { risk: 'medium' }
}

export function listSessions(): TerminalSession[] {
  return [...sessions.values()].map((s) => ({ ...s.meta })).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function killSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session?.child) return false
  killTree(session.child as never)
  session.meta.status = 'killed'
  session.meta.endedAt = new Date().toISOString()
  pushOutput(session, '\n[killed by user]\n')
  emit({ ...session.meta })
  return true
}

export const terminalTools: ToolDefinition[] = [
  {
    name: 'terminal.run',
    description:
      'Run a PowerShell command and wait for it to finish. Returns stdout, stderr and the exit code. Use terminal.run_background for dev servers and long-running jobs.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the active project root.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000).' }
      },
      required: ['command']
    },
    risk: 'medium',
    riskFor: (args) => commandRisk(str(args.command)).risk,
    category: 'terminal',
    group: 'terminal',
    source: 'builtin',
    sessionKey: () => 'shell',
    preview: (args) => {
      const risk = commandRisk(str(args.command))
      return `PowerShell command${risk.reason ? ` (flagged: ${risk.reason})` : ''}:\n\n${str(args.command).slice(0, 3000)}\n\nWorking directory: ${str(args.cwd, '(active project)')}`
    },
    handler: async (args, ctx) => {
      const command = requireString(args, 'command')
      const cwd = str(args.cwd) || ctx.projectPath || undefined
      const timeoutMs = Math.min(Math.max(num(args.timeoutMs, 120000), 2000), 600000)
      const res = await runPowerShell(command, { cwd, timeoutMs, signal: ctx.signal })
      const output = [
        `$ ${command}`,
        `exit code: ${res.code ?? 'timeout'}${res.timedOut ? ' (timed out)' : ''} · ${res.durationMs}ms`,
        res.stdout.trim() ? `--- stdout ---\n${res.stdout.trim()}` : '',
        res.stderr.trim() ? `--- stderr ---\n${res.stderr.trim()}` : ''
      ]
        .filter(Boolean)
        .join('\n')
      if (settings.get().privacy.logCommands) {
        recordActivity('terminal', `Ran: ${command.slice(0, 160)}`, { cwd, code: res.code, timedOut: res.timedOut })
      }
      return {
        ok: res.code === 0 && !res.timedOut,
        content: output.slice(0, 24000),
        data: { exitCode: res.code, timedOut: res.timedOut }
      }
    }
  },
  {
    name: 'terminal.run_background',
    description:
      'Start a long-running PowerShell command (dev server, watcher, build) in the background. Returns a session id. Inspect output with terminal.logs.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Defaults to the active project root.' }
      },
      required: ['command']
    },
    risk: 'medium',
    riskFor: (args) => commandRisk(str(args.command)).risk,
    category: 'terminal',
    group: 'terminal',
    source: 'builtin',
    preview: (args) => `Start background process:\n\n${str(args.command).slice(0, 3000)}`,
    handler: async (args, ctx) => {
      const command = requireString(args, 'command')
      const cwd = str(args.cwd) || ctx.projectPath || process.env.USERPROFILE || process.cwd()
      const id = randomUUID()
      const meta: TerminalSession = {
        id,
        command,
        cwd,
        status: 'running',
        startedAt: new Date().toISOString()
      }
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
        cwd,
        windowsHide: true
      })
      registerChild(child as never)
      const session: InternalSession = { meta, output: '', child }
      sessions.set(id, session)
      meta.pid = child.pid
      child.stdout?.on('data', (b: Buffer) => pushOutput(session, b.toString('utf8')))
      child.stderr?.on('data', (b: Buffer) => pushOutput(session, b.toString('utf8')))
      child.on('error', (err) => {
        meta.status = 'error'
        meta.endedAt = new Date().toISOString()
        pushOutput(session, `\n[spawn error] ${err.message}\n`)
      })
      child.on('exit', (code) => {
        meta.status = meta.status === 'killed' ? 'killed' : 'exited'
        meta.exitCode = code
        meta.endedAt = new Date().toISOString()
        pushOutput(session, `\n[process exited with code ${code}]\n`)
      })
      emit({ ...meta })
      recordActivity('terminal', `Started background: ${command.slice(0, 160)}`, { cwd, pid: child.pid })
      await new Promise((r) => setTimeout(r, 700))
      return ok(
        `Started background session ${id} (pid ${child.pid ?? 'unknown'}).\nRecent output:\n${session.output.slice(-3000) || '(no output yet)'}`,
        { sessionId: id, pid: child.pid }
      )
    }
  },
  {
    name: 'terminal.logs',
    description: 'Read recent output from a background terminal session.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        chars: { type: 'number', description: 'How many trailing characters (default 6000).' }
      },
      required: ['sessionId']
    },
    risk: 'low',
    category: 'terminal',
    group: 'terminal',
    source: 'builtin',
    handler: async (args) => {
      const session = sessions.get(requireString(args, 'sessionId'))
      if (!session) return fail('Unknown terminal session id. Use terminal.list.')
      const chars = Math.min(num(args.chars, 6000), 30000)
      return ok(
        `Session ${session.meta.id} (${session.meta.status})\n$ ${session.meta.command}\n\n${session.output.slice(-chars) || '(no output yet)'}`,
        session.meta
      )
    }
  },
  {
    name: 'terminal.list',
    description: 'List background terminal sessions started by LocalPilot and their status.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'terminal',
    group: 'terminal',
    source: 'builtin',
    handler: async () => {
      const all = listSessions()
      if (!all.length) return ok('No background terminal sessions.')
      return ok(
        all
          .map(
            (s) =>
              `${s.id} · ${s.status} · pid ${s.pid ?? '?'} · ${s.command.slice(0, 140)}${s.exitCode !== undefined ? ` · exit ${s.exitCode}` : ''}`
          )
          .join('\n')
      )
    }
  },
  {
    name: 'terminal.kill',
    description: 'Stop a background terminal session and its child processes.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId']
    },
    risk: 'medium',
    category: 'terminal',
    group: 'terminal',
    source: 'builtin',
    preview: (args) => `Stop terminal session ${str(args.sessionId)}`,
    handler: async (args) => {
      const id = requireString(args, 'sessionId')
      if (!sessions.has(id)) return fail('Unknown terminal session id.')
      killSession(id)
      log.info('terminal', `Killed session ${id}`)
      return ok(`Stopped terminal session ${id}.`)
    }
  }
]
