import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PluginInfo, Risk } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { getPaths } from '../core/paths'
import { all, get, run } from '../db'
import { log } from '../core/logger'
import { recordActivity } from '../activity'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  category?: string
  icon?: string
  os?: string[]
  permissions?: string[]
  tools: {
    name: string
    description: string
    parameters: Record<string, unknown>
    risk?: Risk
  }[]
}

interface Runtime {
  id: string
  child: ChildProcess
  tools: PluginManifest['tools']
  pending: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>
  logLines: string[]
  ready: Promise<void>
}

const runtimes = new Map<string, Runtime>()

function pluginsRoot() {
  return getPaths().pluginsDir
}

export function isValidPluginId(id: string) {
  return /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)
}

function readManifest(dir: string): PluginManifest {
  const manifestPath = path.join(dir, 'plugin.json')
  if (!fs.existsSync(manifestPath)) throw new Error('plugin.json not found in the selected folder.')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest
  if (!manifest.id || !isValidPluginId(manifest.id)) throw new Error('plugin.json has an invalid id.')
  if (!manifest.name || !manifest.version) throw new Error('plugin.json requires name and version.')
  if (!Array.isArray(manifest.tools) || !manifest.tools.length) throw new Error('plugin.json must declare at least one tool.')
  for (const tool of manifest.tools) {
    if (!tool.name || !tool.description || !tool.parameters) {
      throw new Error(`Tool "${tool.name ?? '?'}" needs name, description and parameters.`)
    }
  }
  if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error('index.js not found in the selected plugin folder.')
  return manifest
}

export function installedNativePlugins(): { manifest: PluginManifest; enabled: boolean; installedAt: string }[] {
  const rows = all<{ id: string; enabled: number; manifest: string; installed_at: string }>(
    "SELECT id, enabled, manifest, installed_at FROM plugins WHERE source = 'native'"
  )
  return rows
    .map((row) => {
      try {
        return {
          manifest: JSON.parse(row.manifest) as PluginManifest,
          enabled: Boolean(row.enabled),
          installedAt: row.installed_at
        }
      } catch {
        return null
      }
    })
    .filter((v): v is { manifest: PluginManifest; enabled: boolean; installedAt: string } => Boolean(v))
}

export async function installFromFolder(folder: string): Promise<PluginInfo> {
  const manifest = readManifest(folder)
  const target = path.join(pluginsRoot(), manifest.id)
  if (target !== path.resolve(folder)) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const src = path.join(folder, entry.name)
      const dest = path.join(target, entry.name)
      fs.cpSync(src, dest, { recursive: true })
    }
  }
  run(
    "INSERT INTO plugins (id, name, version, enabled, source, manifest, config, installed_at) VALUES (?, ?, ?, 1, 'native', ?, '{}', ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, manifest = excluded.manifest, installed_at = excluded.installed_at",
    [manifest.id, manifest.name, manifest.version, JSON.stringify(manifest), new Date().toISOString()]
  )
  recordActivity('plugin', `Installed native plugin ${manifest.name}`, { permissions: manifest.permissions })
  await stopPlugin(manifest.id)
  await startPlugin(manifest.id)
  return nativePluginInfo(manifest, true)!
}

export function nativePluginInfo(manifest: PluginManifest, enabled: boolean): PluginInfo {
  const runtime = runtimes.get(manifest.id)
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author ?? 'Unknown author',
    description: manifest.description ?? '',
    category: manifest.category ?? 'Native plugin',
    icon: manifest.icon ?? 'plugin',
    permissions: manifest.permissions ?? [],
    os: manifest.os ?? ['win32'],
    source: 'native',
    enabled,
    installed: true,
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk ?? 'medium'
    })),
    error: runtime ? undefined : undefined
  }
}

export async function startPlugin(id: string): Promise<void> {
  if (runtimes.has(id)) return
  const info = installedNativePlugins().find((p) => p.manifest.id === id)
  if (!info) throw new Error('Plugin is not installed.')
  if (!info.enabled) throw new Error('Plugin is disabled.')
  const dir = path.join(pluginsRoot(), id)
  if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error('Plugin files are missing from the plugins folder. Reinstall it.')
  const bundledHostPath = path.join(__dirname, 'pluginHost.js')
  const hostPath = app.isPackaged
    ? bundledHostPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : bundledHostPath
  if (!fs.existsSync(hostPath)) throw new Error('Plugin host bundle is missing. Rebuild LocalPilot.')
  const child = fork(hostPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LOCALPILOT_PLUGIN_DIR: dir
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const runtime: Runtime = {
    id,
    child,
    tools: info.manifest.tools,
    pending: new Map(),
    logLines: [],
    ready: Promise.resolve()
  }
  runtimes.set(id, runtime)
  runtime.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopPlugin(id)
      reject(new Error('Plugin did not become ready within 20 seconds.'))
    }, 20000)
    child.on('message', (message: unknown) => {
      const msg = message as {
        type?: string
        tools?: PluginManifest['tools']
        id?: string
        ok?: boolean
        content?: string
        error?: string
        data?: unknown
        images?: string[]
      }
      if (msg.type === 'ready') {
        clearTimeout(timer)
        resolve()
      } else if (msg.type === 'result' && msg.id) {
        const pending = runtime.pending.get(msg.id)
        if (!pending) return
        clearTimeout(pending.timer)
        runtime.pending.delete(msg.id)
        if (msg.ok === false) pending.reject(new Error(msg.error ?? 'Plugin tool failed.'))
        else
          pending.resolve({
            ok: true,
            content: msg.content ?? '',
            data: msg.data,
            images: msg.images
          })
      } else if (msg.type === 'fatal') {
        clearTimeout(timer)
        reject(new Error(msg.error ?? 'Plugin crashed.'))
      }
    })
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    runtime.logLines.push(text)
    if (runtime.logLines.length > 200) runtime.logLines.shift()
    log.warn('plugin', `[${id}] ${text.slice(0, 500)}`)
  })
  child.stdout?.on('data', (buf: Buffer) => {
    log.debug('plugin', `[${id}] ${buf.toString('utf8').slice(0, 300)}`)
  })
  child.once('exit', (code) => {
    log.info('plugin', `Plugin ${id} exited (${code})`)
    for (const pending of runtime.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Plugin process exited.'))
    }
    runtime.pending.clear()
    runtimes.delete(id)
  })
  await runtime.ready
}

export async function stopPlugin(id: string): Promise<void> {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtimes.delete(id)
  try {
    runtime.child.kill()
  } catch {
    // ignore
  }
  for (const pending of runtime.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Plugin stopped.'))
  }
  runtime.pending.clear()
}

export function pluginTools(id: string): ToolDefinition[] {
  const runtime = runtimes.get(id)
  const info = installedNativePlugins().find((p) => p.manifest.id === id)
  if (!runtime || !info || !info.enabled) return []
  return runtime.tools.map((tool) => ({
    name: `plugin__${id}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
    description: `[${info.manifest.name}] ${tool.description}`,
    parameters: tool.parameters,
    risk: tool.risk ?? 'medium',
    category: 'plugin',
    group: `plugin:${id}`,
    source: 'native' as const,
    pluginId: id,
    handler: async (args: Record<string, unknown>, ctx) => {
      const target = runtimes.get(id)
      if (!target) return { ok: false, content: 'Plugin process is not running.' }
      const callId = randomUUID()
      const resultPromise = new Promise<{
        ok: boolean
        content: string
        data?: unknown
        images?: string[]
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          target.pending.delete(callId)
          reject(new Error('Plugin tool timed out after 120 seconds.'))
        }, 120000)
        target.pending.set(callId, { resolve: resolve as (value: unknown) => void, reject, timer })
        target.child.send?.({
          type: 'call',
          id: callId,
          tool: tool.name,
          args,
          projectPath: ctx.projectPath
        })
      })
      const result = (await resultPromise) as {
        ok: boolean
        content: string
        data?: unknown
        images?: string[]
      }
      return result
    }
  }))
}

export function allNativeTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const plugin of installedNativePlugins()) {
    if (!plugin.enabled) continue
    tools.push(...pluginTools(plugin.manifest.id))
  }
  return tools
}

export function removeNativePlugin(id: string) {
  const row = get<{ source: string }>('SELECT source FROM plugins WHERE id = ?', [id])
  if (!row || row.source !== 'native') throw new Error('Not a native plugin.')
  void stopPlugin(id)
  run('DELETE FROM plugins WHERE id = ?', [id])
  const dir = path.join(pluginsRoot(), id)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    log.warn('plugin', 'Could not remove plugin files', String(err))
  }
  recordActivity('plugin', `Uninstalled plugin ${id}`)
}

export async function startEnabledPlugins() {
  for (const plugin of installedNativePlugins()) {
    if (!plugin.enabled) continue
    try {
      await startPlugin(plugin.manifest.id)
    } catch (err) {
      log.warn('plugin', `Could not start plugin ${plugin.manifest.id}`, String(err))
    }
  }
}
