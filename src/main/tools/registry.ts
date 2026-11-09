import type { PermissionDecision, ToolSchema } from '@shared/types'
import type { ToolContext, ToolDefinition, ToolExecutionResult } from './types'
import { schemaOf } from './types'
import { ensurePermission } from '../permissions'
import { groupEnabled } from '../plugins/builtins'
import { recordActivity } from '../activity'
import { settings } from '../settings'
import { log } from '../core/logger'

type ExternalProvider = () => ToolDefinition[]

class ToolRegistry {
  private builtins = new Map<string, ToolDefinition>()
  private externalProviders: ExternalProvider[] = []

  register(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.builtins.has(tool.name)) {
        log.warn('tools', `Duplicate tool registration ignored: ${tool.name}`)
        continue
      }
      this.builtins.set(tool.name, tool)
    }
  }

  addExternalProvider(provider: ExternalProvider) {
    this.externalProviders.push(provider)
  }

  private externalTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    for (const provider of this.externalProviders) {
      try {
        tools.push(...provider())
      } catch (err) {
        log.warn('tools', 'External tool provider failed', String(err))
      }
    }
    return tools
  }

  private isEnabled(tool: ToolDefinition): boolean {
    if (tool.enabled && !tool.enabled()) return false
    if (tool.source === 'builtin') {
      if (tool.group === 'computer' || tool.group === 'windows' || tool.group === 'uia') {
        if (!settings.get().computer.enabled) return false
      }
      return groupEnabled(tool.group)
    }
    return true
  }

  all(): ToolDefinition[] {
    return [...this.builtins.values(), ...this.externalTools()]
  }

  list(allowedGroups?: string[] | null): ToolSchema[] {
    return this.all()
      .filter((tool) => this.isEnabled(tool))
      .filter((tool) => !allowedGroups || allowedGroups.includes(tool.group))
      .map((tool) => schemaOf(tool, true))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): ToolDefinition | undefined {
    const builtin = this.builtins.get(name)
    if (builtin) return this.isEnabled(builtin) ? builtin : undefined
    const external = this.externalTools().find((t) => t.name === name)
    return external
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolExecutionResult & { denied?: boolean }> {
    const tool = this.get(name)
    if (!tool) {
      const available = this.list().slice(0, 12).map((t) => t.name).join(', ')
      return {
        ok: false,
        content: `TOOL UNAVAILABLE: "${name}" is not installed, is disabled, or is not permitted for this profile. Available tools include: ${available}. Do not retry this tool.`
      }
    }

    const started = Date.now()
    const risk = tool.riskFor?.(args) ?? tool.risk
    let decision: PermissionDecision = 'allow'
    if (settings.get().computer.approvalMode !== 'auto-safe' || risk !== 'low' || tool.source !== 'builtin') {
      decision = await ensurePermission({
        tool: tool.name,
        args,
        risk,
        runId: ctx.runId,
        title: friendlyTitle(tool, args, risk),
        detail: tool.preview?.(args, ctx) ?? `${tool.description}\n\n${JSON.stringify(args, null, 2).slice(0, 2400)}`,
        sessionKey: `${tool.name}:${tool.sessionKey?.(args) ?? tool.group}`
      })
    }

    if (decision === 'deny') {
      recordActivity('tool', `Denied ${tool.name}`, { args: sanitise(args) })
      return {
        ok: false,
        denied: true,
        content: `PERMISSION DENIED by the user for ${tool.name}. Do not retry the same action; explain what you would need and ask the user how to proceed.`
      }
    }

    ctx.log(`Running ${tool.name}`)
    recordActivity('tool', `${tool.name}`, { args: sanitise(args) })
    try {
      const timeout = tool.category === 'browser' ? 120_000 : 300_000
      const result = await withTimeout(tool.handler(args, ctx), timeout, ctx.signal)
      const durationMs = Date.now() - started
      const content =
        result.content.length > 24000
          ? `${result.content.slice(0, 24000)}\n\n[output truncated: ${result.content.length - 24000} more characters]`
          : result.content
      recordActivity('tool-result', `${tool.name} ${result.ok ? 'succeeded' : 'failed'} in ${durationMs}ms`, {
        preview: result.content.slice(0, 300)
      })
      return { ...result, content, durationMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('tools', `${tool.name} threw`, message)
      recordActivity('tool-error', `${tool.name} failed: ${message.slice(0, 200)}`)
      return {
        ok: false,
        content: `TOOL ERROR (${tool.name}): ${message}`,
        durationMs: Date.now() - started
      }
    }
  }
}

function friendlyTitle(tool: ToolDefinition, args: Record<string, unknown>, risk: string): string {
  if (risk === 'high' && tool.name !== 'screen.screenshot') {
    return `High-risk action: allow ${tool.name}?`
  }
  switch (tool.name) {
    case 'screen.screenshot':
      return 'Capture your screen?'
    case 'input.keyboard':
      return args.action === 'type' ? 'Type text into the active window?' : 'Send a keyboard shortcut?'
    case 'input.mouse':
      return `Control the mouse (${String(args.action ?? 'click')})?`
    case 'apps.launch':
      return `Open ${String(args.name ?? args.path ?? 'an application')}?`
    case 'terminal.run':
      return 'Run a PowerShell command?'
    case 'files.write':
      return `Write file ${String(args.path ?? '')}?`
    case 'files.delete':
      return `Delete ${String(args.path ?? '')}?`
    case 'git.commit':
      return 'Create a git commit?'
    case 'windows.close':
      return `Close window ${String(args.title ?? args.processName ?? '')}?`
    default:
      return `Allow ${tool.name}?`
  }
}

function sanitise(args: Record<string, unknown>) {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (/key|token|password|secret/i.test(key)) copy[key] = '[redacted]'
    else if (typeof value === 'string' && value.length > 300) copy[key] = value.slice(0, 300) + '…'
    else copy[key] = value
  }
  return copy
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled by user'))
      return
    }
    const timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Cancelled by user'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

export const toolRegistry = new ToolRegistry()
