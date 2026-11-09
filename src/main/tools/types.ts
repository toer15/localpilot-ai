import type { Risk, ToolSchema, ToolSource } from '@shared/types'

export interface ToolContext {
  runId: string
  conversationId: string
  providerId: string
  modelId: string
  projectId: string | null
  projectName?: string
  projectPath: string | null
  signal: AbortSignal
  log: (message: string) => void
}

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: unknown
  images?: string[]
  durationMs?: number
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: Risk
  category: string
  group: string
  source: ToolSource
  pluginId?: string
  /** Some tools evaluate risk from their arguments (e.g. destructive shell commands). */
  riskFor?: (args: Record<string, unknown>) => Risk
  /** Human-readable preview shown in the approval dialog. */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => string
  /** Runtime availability, e.g. user disabled screenshots in settings. */
  enabled?: () => boolean
  /** Used to key session approvals. */
  sessionKey?: (args: Record<string, unknown>) => string
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecutionResult>
}

export interface ListedTool extends ToolSchema {
  source: ToolSource
}

export function schemaOf(tool: ToolDefinition, enabled: boolean): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    risk: tool.risk,
    category: tool.category,
    group: tool.group,
    source: tool.source,
    pluginId: tool.pluginId,
    enabled
  }
}

export function ok(content: string, data?: unknown, images?: string[]): ToolExecutionResult {
  return { ok: true, content, data, images }
}

export function fail(content: string, data?: unknown): ToolExecutionResult {
  return { ok: false, content, data }
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

export function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
  return fallback
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Parameter "${key}" is required.`)
  return value
}
