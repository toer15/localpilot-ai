import type { CatalogPlugin, McpServerConfig, PluginInfo } from '@shared/types'
import { all, get, run } from '../db'
import {
  BUILTIN_PLUGINS,
  builtinEnabled,
  builtinPluginInfos,
  ensureBuiltinPlugins,
  removeOptionalBuiltin,
  setBuiltinEnabled
} from './builtins'
import { pluginCatalog, mcpPreset } from './catalog'
import {
  allNativeTools,
  installedNativePlugins,
  installFromFolder,
  nativePluginInfo,
  removeNativePlugin,
  startEnabledPlugins,
  startPlugin,
  stopPlugin
} from './native'
import {
  connectMcp,
  createMcpServer,
  disconnectMcp,
  listMcpServers,
  mcpInfoList,
  mcpPluginInfo,
  mcpTools,
  saveMcpServer,
  startAutoMcpServers,
  stopAllMcp
} from './mcp'
import { recordActivity } from '../activity'
import { log } from '../core/logger'
import { toolRegistry } from '../tools/registry'
import { aiOverlay } from '../computer/overlay'

class PluginManager {
  async init() {
    ensureBuiltinPlugins()
    await startEnabledPlugins()
    void startAutoMcpServers()
  }

  list(): PluginInfo[] {
    const builtins = builtinPluginInfos().map((plugin) => ({
      ...plugin,
      tools: this.builtinToolsFor(plugin.id)
    }))
    const native = installedNativePlugins().map((p) => nativePluginInfo(p.manifest, p.enabled) ?? null).filter(Boolean)
    return [...builtins, ...native, ...mcpInfoList()] as PluginInfo[]
  }

  catalog(): CatalogPlugin[] {
    return pluginCatalog()
  }

  private builtinToolsFor(id: string) {
    const def = BUILTIN_PLUGINS.find((p) => p.id === id)
    if (!def) return []
    return toolRegistry
      .all()
      .filter((t) => def.groups.includes(t.group) && t.source === 'builtin')
      .map((t) => ({ name: t.name, description: t.description, risk: t.risk }))
  }

  async install(catalogId: string): Promise<PluginInfo> {
    const entry = pluginCatalog().find((p) => p.id === catalogId)
    if (!entry) throw new Error('Unknown plugin.')
    if (entry.installKind === 'builtin') {
      setBuiltinEnabled(entry.id, true)
      recordActivity('plugin', `Enabled built-in plugin ${entry.name}`)
      return this.list().find((p) => p.id === entry.id)!
    }
    const existing = mcpPluginInfo(entry.id)
    if (existing) {
      // Reconnect using the preset (also acts as "install/update").
      await disconnectMcp(entry.id)
      const info = await connectMcp(entry.id).catch((err) => {
        log.warn('plugins', `MCP preset ${entry.id} installed but not connected`, String(err))
        return mcpPluginInfo(entry.id)!
      })
      return info
    }
    const config = createMcpServer({
      name: entry.name,
      transport: 'stdio',
      command: entry.command ?? 'npx',
      args: entry.args ?? ['-y', `${entry.packageName ?? entry.id}@latest`],
      env: {},
      enabled: true,
      autoStart: true,
      source: `catalog:${entry.id}`,
      notes: entry.requirements ?? entry.notes
    })
    config.id = entry.id
    saveMcpServer(config)
    recordActivity('plugin', `Installed MCP plugin ${entry.name}`, {
      packageName: entry.packageName,
      command: entry.command
    })
    const info = await connectMcp(config.id).catch((err) => {
      log.warn('plugins', `Installed MCP plugin ${entry.name} but connection failed`, String(err))
      return mcpPluginInfo(config.id)!
    })
    return info
  }

  async installFolder(folder: string): Promise<PluginInfo> {
    return installFromFolder(folder)
  }

  async uninstall(id: string): Promise<void> {
    const builtin = BUILTIN_PLUGINS.find((p) => p.id === id)
    if (builtin) {
      if (builtin.optional) {
        removeOptionalBuiltin(id)
        aiOverlay.hide()
        recordActivity('plugin', `Uninstalled optional built-in plugin ${builtin.name}`)
        return
      }
      setBuiltinEnabled(id, false)
      aiOverlay.hide()
      recordActivity('plugin', `Disabled built-in plugin ${builtin.name}`)
      return
    }
    const row = get<{ source: string }>('SELECT source FROM plugins WHERE id = ?', [id])
    if (!row) throw new Error('Plugin not installed.')
    if (row.source === 'native') {
      removeNativePlugin(id)
      return
    }
    if (row.source === 'mcp') {
      await disconnectMcp(id)
      run('DELETE FROM plugins WHERE id = ?', [id])
      recordActivity('plugin', `Uninstalled MCP plugin ${id}`)
      return
    }
    throw new Error('Unknown plugin source.')
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const builtin = BUILTIN_PLUGINS.find((p) => p.id === id)
    if (builtin) {
      setBuiltinEnabled(id, enabled)
      if (!enabled) aiOverlay.hide()
      return this.list().find((p) => p.id === id)!
    }
    const row = get<{ source: string; manifest: string }>('SELECT source, manifest FROM plugins WHERE id = ?', [id])
    if (!row) throw new Error('Plugin not found.')
    if (row.source === 'native') {
      run('UPDATE plugins SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id])
      if (enabled) await startPlugin(id)
      else await stopPlugin(id)
      return this.list().find((p) => p.id === id)!
    }
    const server = listMcpServers().find((s) => s.id === id)
    if (!server) throw new Error('MCP server not found.')
    saveMcpServer({ ...server, enabled })
    if (enabled) {
      await connectMcp(id).catch(() => undefined)
    } else {
      await disconnectMcp(id)
    }
    return this.list().find((p) => p.id === id)!
  }

  configure(id: string, config: Record<string, unknown>): PluginInfo {
    const row = get<{ source: string; manifest: string }>('SELECT source, manifest FROM plugins WHERE id = ?', [id])
    if (!row) throw new Error('Plugin not found.')
    if (row.source === 'mcp') {
      const server = listMcpServers().find((s) => s.id === id)
      if (!server) throw new Error('MCP server not found.')
      const next: McpServerConfig = {
        ...server,
        ...(typeof config.args !== 'undefined' && Array.isArray(config.args) ? { args: config.args.map(String) } : {}),
        ...(typeof config.command === 'string' ? { command: config.command } : {}),
        ...(typeof config.url === 'string' ? { url: config.url } : {}),
        ...(typeof config.transport === 'string' && (config.transport === 'stdio' || config.transport === 'http')
          ? { transport: config.transport }
          : {}),
        ...(config.env && typeof config.env === 'object'
          ? { env: Object.fromEntries(Object.entries(config.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
          : {})
      }
      saveMcpServer(next)
      void disconnectMcp(id).then(() => (next.enabled ? connectMcp(id) : undefined)).catch(() => undefined)
      return mcpPluginInfo(id)!
    }
    run('UPDATE plugins SET config = ? WHERE id = ?', [JSON.stringify(config), id])
    return this.list().find((p) => p.id === id)!
  }

  mcpServers(): McpServerConfig[] {
    return listMcpServers()
  }

  addMcpServer(input: Partial<McpServerConfig> & { name: string }): PluginInfo {
    const config = createMcpServer(input)
    saveMcpServer(config)
    void connectMcp(config.id).catch(() => undefined)
    return mcpPluginInfo(config.id)!
  }

  updateMcpServer(id: string, patch: Partial<McpServerConfig>): PluginInfo {
    const server = listMcpServers().find((s) => s.id === id)
    if (!server) throw new Error('MCP server not found.')
    saveMcpServer({ ...server, ...patch, id })
    void disconnectMcp(id)
      .then(() => (patch.enabled === false ? undefined : connectMcp(id)))
      .catch(() => undefined)
    return mcpPluginInfo(id)!
  }

  async startMcp(id: string): Promise<PluginInfo> {
    return connectMcp(id)
  }

  async stopMcp(id: string): Promise<void> {
    await disconnectMcp(id)
  }

  async testMcp(id: string): Promise<{ ok: boolean; tools: number; error?: string }> {
    try {
      await disconnectMcp(id)
      const info = await connectMcp(id)
      return { ok: true, tools: info.tools?.length ?? 0 }
    } catch (err) {
      return { ok: false, tools: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }

  externalTools() {
    return [...allNativeTools(), ...mcpTools()]
  }

  async shutdown() {
    await stopAllMcp()
    for (const plugin of installedNativePlugins()) {
      await stopPlugin(plugin.manifest.id)
    }
  }

  async rescan() {
    await startEnabledPlugins()
    for (const server of listMcpServers().filter((s) => s.enabled)) {
      void connectMcp(server.id).catch(() => undefined)
    }
  }
}

export const pluginManager = new PluginManager()

export function registerPluginToolProvider() {
  toolRegistry.addExternalProvider(() => pluginManager.externalTools())
}

export function describeMissingCatalogEntry(id: string) {
  return mcpPreset(id)?.name ?? id
}
