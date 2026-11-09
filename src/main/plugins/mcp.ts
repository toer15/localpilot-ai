import { randomUUID } from 'node:crypto'
import type { McpServerConfig, PluginInfo, Risk } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { all, get, run } from '../db'
import { log } from '../core/logger'
import { recordActivity } from '../activity'

interface McpRuntime {
  config: McpServerConfig
  client: unknown
  transport: unknown
  tools: ToolDefinition[]
  error?: string
  connectedAt?: string
}

const runtimes = new Map<string, McpRuntime>()
const connecting = new Map<string, Promise<McpRuntime>>()

function configFromRow(row: { id: string; manifest: string; enabled: number; config: string }): McpServerConfig | null {
  try {
    const manifest = JSON.parse(row.manifest) as { mcp?: McpServerConfig }
    const config = manifest.mcp ?? (JSON.parse(row.config || '{}') as McpServerConfig)
    if (!config?.id) return null
    return { ...config, enabled: Boolean(row.enabled) }
  } catch {
    return null
  }
}

export function listMcpServers(): McpServerConfig[] {
  return all<{ id: string; manifest: string; enabled: number; config: string }>(
    "SELECT id, manifest, enabled, config FROM plugins WHERE source = 'mcp'"
  )
    .map(configFromRow)
    .filter((c): c is McpServerConfig => Boolean(c))
}

export function saveMcpServer(config: McpServerConfig) {
  const existing = get<{ id: string }>('SELECT id FROM plugins WHERE id = ?', [config.id])
  const installedAt = new Date().toISOString()
  const manifest = { kind: 'mcp', mcp: config }
  if (existing) {
    run('UPDATE plugins SET enabled = ?, manifest = ?, config = ? WHERE id = ?', [
      config.enabled ? 1 : 0,
      JSON.stringify(manifest),
      JSON.stringify(config),
      config.id
    ])
  } else {
    run(
      "INSERT INTO plugins (id, name, version, enabled, source, manifest, config, installed_at) VALUES (?, ?, 'latest', ?, 'mcp', ?, ?, ?)",
      [config.id, config.name, config.enabled ? 1 : 0, JSON.stringify(manifest), JSON.stringify(config), installedAt]
    )
  }
}

export function createMcpServer(input: Partial<McpServerConfig> & { name: string }): McpServerConfig {
  const id = `mcp-${input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)}-${randomUUID().slice(0, 6)}`
  return {
    id,
    name: input.name.trim(),
    transport: input.transport ?? 'stdio',
    command: input.command ?? 'npx',
    args: input.args ?? [],
    env: input.env ?? {},
    url: input.url,
    enabled: input.enabled ?? true,
    autoStart: input.autoStart ?? true,
    source: input.source ?? 'manual',
    notes: input.notes
  }
}

function launchCommand(config: McpServerConfig): { command: string; args: string[] } {
  if (config.transport === 'http') {
    return { command: '', args: [] }
  }
  let command = config.command?.trim() || 'npx'
  let args = [...(config.args ?? [])]
  if (process.platform === 'win32' && /^(npx|npm|pnpm|yarn|uvx|bunx)(\.cmd)?$/i.test(command)) {
    args = ['/c', command, ...args]
    command = 'cmd.exe'
  }
  return { command, args }
}

export async function connectMcp(id: string): Promise<PluginInfo> {
  const existing = connecting.get(id)
  if (existing) {
    await existing.catch(() => undefined)
    return mcpPluginInfo(id)!
  }
  const config = listMcpServers().find((c) => c.id === id)
  if (!config) throw new Error('MCP server is not installed.')
  if (!config.enabled) throw new Error('MCP server is disabled.')
  if (runtimes.get(id)?.tools.length) return mcpPluginInfo(id)!
  const promise = (async (): Promise<McpRuntime> => {
    await disconnectMcp(id)
    const runtime: McpRuntime = { config, client: null, transport: null, tools: [] }
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const client = new Client({ name: 'localpilot-ai', version: '0.1.0' })
      let transport: unknown
      if (config.transport === 'http') {
        if (!config.url) throw new Error('HTTP MCP servers need a URL.')
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        transport = new StreamableHTTPClientTransport(new URL(config.url))
      } else {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        const { command, args } = launchCommand(config)
        transport = new StdioClientTransport({
          command,
          args,
          cwd: process.env.USERPROFILE,
          env: {
            ...(process.env as Record<string, string>),
            ...(config.env ?? {})
          }
        })
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timed out after 90 seconds. The server may still be downloading; try Connect again.')), 90000)
      )
      await Promise.race([
        client.connect(transport as never),
        timeout
      ])
      const listed = (await Promise.race([
        client.listTools(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP listTools timed out.')), 30000))
      ])) as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }
      const defs = (listed.tools ?? []).map((tool) => mcpToolDefinition(id, config.name, client, tool))
      runtime.client = client
      runtime.transport = transport
      runtime.tools = defs
      runtime.connectedAt = new Date().toISOString()
      runtimes.set(id, runtime)
      recordActivity('mcp', `Connected MCP server ${config.name} (${defs.length} tools)`)
      log.info('mcp', `Connected ${config.name}: ${defs.length} tools`)
      return runtime
    } catch (err) {
      runtime.error = err instanceof Error ? err.message : String(err)
      runtimes.set(id, runtime)
      log.warn('mcp', `Could not connect ${config.name}`, runtime.error)
      throw new Error(runtime.error)
    }
  })()
  connecting.set(id, promise)
  try {
    await promise
  } finally {
    connecting.delete(id)
  }
  return mcpPluginInfo(id)!
}

function mcpToolDefinition(
  serverId: string,
  serverName: string,
  client: unknown,
  tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }
): ToolDefinition {
  const risk: Risk = /delete|remove|drop|destroy|kill|shutdown|execute|run_command/i.test(tool.name)
    ? 'high'
    : 'medium'
  const callable = client as { callTool: (args: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> }
  return {
    name: `mcp__${serverId}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
    description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    risk,
    category: 'mcp',
    group: `mcp:${serverId}`,
    source: 'mcp',
    pluginId: serverId,
    handler: async (args) => {
      try {
        const raw = (await callable.callTool({ name: tool.name, arguments: args })) as {
          content?: { type: string; text?: string; data?: string; mimeType?: string }[]
          isError?: boolean
          structuredContent?: unknown
        }
        const texts: string[] = []
        const images: string[] = []
        for (const part of raw.content ?? []) {
          if (part.type === 'text' && part.text) texts.push(part.text)
          else if (part.type === 'image' && part.data && part.mimeType) {
            images.push(`data:${part.mimeType};base64,${part.data}`)
          } else if (part.type === 'resource' && part.text) texts.push(part.text)
        }
        if (raw.structuredContent) texts.push(JSON.stringify(raw.structuredContent, null, 2))
        return {
          ok: !raw.isError,
          content: texts.join('\n\n') || '(MCP tool returned no text content)',
          images: images.length ? images : undefined
        }
      } catch (err) {
        return { ok: false, content: `MCP tool failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
}

export async function disconnectMcp(id: string) {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtimes.delete(id)
  try {
    const client = runtime.client as { close?: () => Promise<void> }
    await client?.close?.()
  } catch {
    // ignore
  }
}

export function mcpTools(includeDisabled = false): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const [id, runtime] of runtimes) {
    if (!includeDisabled && !runtime.config.enabled) continue
    tools.push(...runtime.tools)
  }
  return tools
}

export function connectedCount(): number {
  return runtimes.size
}

export function mcpPluginInfo(id: string): PluginInfo | null {
  const config = listMcpServers().find((c) => c.id === id)
  if (!config) return null
  const runtime = runtimes.get(id)
  return {
    id: config.id,
    name: config.name,
    version: 'latest',
    author: config.source?.startsWith('catalog:') ? 'Third-party MCP server' : 'User configured',
    description:
      config.notes ??
      `MCP server over ${config.transport}. Tools are executed by ${config.command ?? config.url ?? 'the server'}.`,
    category: 'MCP',
    icon: 'plug',
    permissions: ['tools.external', 'process.spawn', 'network.internet'],
    os: ['win32'],
    source: 'mcp',
    enabled: config.enabled,
    installed: true,
    tools: runtime?.tools.map((t) => ({ name: t.name, description: t.description, risk: t.risk })),
    mcp: config,
    error: runtime?.error
  }
}

export async function startAutoMcpServers() {
  const servers = listMcpServers().filter((s) => s.enabled && s.autoStart)
  for (const server of servers) {
    void connectMcp(server.id).catch((err) => {
      log.warn('mcp', `Auto-connect failed for ${server.name}`, String(err))
    })
  }
}

export async function stopAllMcp() {
  for (const id of [...runtimes.keys()]) {
    await disconnectMcp(id)
  }
}

export function mcpInfoList(): PluginInfo[] {
  return listMcpServers()
    .map((s) => mcpPluginInfo(s.id))
    .filter((v): v is PluginInfo => Boolean(v))
}
