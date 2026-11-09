import type { PluginInfo } from '@shared/types'
import { all, get, run } from '../db'

export interface BuiltinPluginDef {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: string
  icon: string
  groups: string[]
  permissions: string[]
  riskNote: string
  /** Optional packs are not installed until the user installs them from the marketplace. */
  optional?: boolean
}

/**
 * Built-in capability packs. Tools declare a group; disabling a pack removes those tools
 * from the model's tool list entirely (verified by the agent's tool registry).
 */
export const BUILTIN_PLUGINS: BuiltinPluginDef[] = [
  {
    id: 'computer-use',
    name: 'Computer Use',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Screenshots, mouse, keyboard, Windows UI Automation and window control.',
    category: 'Computer control',
    icon: 'monitor',
    groups: ['computer', 'windows', 'uia'],
    permissions: ['screen.capture', 'input.control', 'windows.manage', 'uia.read'],
    riskNote: 'High impact. Approved per action or per session.'
  },
  {
    id: 'app-tester',
    name: 'AI App & Game Tester',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description:
      'Downloadable testing pack with a green AI cursor, full-screen takeover border and an on-screen Esc stop prompt for testing games and desktop apps.',
    category: 'Testing',
    icon: 'monitor',
    groups: ['testing'],
    permissions: ['screen.overlay', 'screen.capture', 'input.control'],
    riskNote: 'Shows a click-through overlay. Press Esc to stop testing and cancel the active run.',
    optional: true
  },
  {
    id: 'terminal',
    name: 'Terminal & PowerShell',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Run PowerShell commands, start background processes and manage them.',
    category: 'Developer tools',
    icon: 'terminal',
    groups: ['terminal'],
    permissions: ['process.execute'],
    riskNote: 'Commands run with your user privileges. Destructive commands always ask.'
  },
  {
    id: 'filesystem',
    name: 'File System & Projects',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Read, write, search, patch and organise files inside the active project folder.',
    category: 'Developer tools',
    icon: 'folder',
    groups: ['files', 'projects'],
    permissions: ['filesystem.project'],
    riskNote: 'Restricted to the active project folder.'
  },
  {
    id: 'browser',
    name: 'Browser Automation',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Navigate and test websites with Playwright using local Edge/Chrome; fetch web pages.',
    category: 'Developer tools',
    icon: 'globe',
    groups: ['browser', 'web'],
    permissions: ['network.internet', 'browser.control'],
    riskNote: 'Uses your installed browser profile. Web access is blocked in local-only mode.'
  },
  {
    id: 'git-dev',
    name: 'Git & Development',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Git status, diff, branches, commits with approval, and repository inspection.',
    category: 'Developer tools',
    icon: 'git',
    groups: ['git'],
    permissions: ['git.read', 'git.write'],
    riskNote: 'Commits always require approval.'
  },
  {
    id: 'memory',
    name: 'Local Memory',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Persistent user and project memory stored in your local SQLite database.',
    category: 'Productivity',
    icon: 'brain',
    groups: ['memory'],
    permissions: ['storage.local'],
    riskNote: 'Refuses to store credentials or API keys.'
  },
  {
    id: 'subagents',
    name: 'Agent Roles',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Delegate focused review, architecture, testing or research passes to a second agent.',
    category: 'AI',
    icon: 'users',
    groups: ['agents'],
    permissions: ['model.local'],
    riskNote: 'Uses the selected local model and can optionally search the web.'
  },
  {
    id: 'system',
    name: 'System Diagnostics',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description: 'Detect hardware, runtimes and LocalPilot diagnostics.',
    category: 'System',
    icon: 'cpu',
    groups: ['system'],
    permissions: ['system.read'],
    riskNote: 'Read-only system information.'
  },
  {
    id: 'infinite-context',
    name: 'Infinite Context',
    version: '1.0.0',
    author: 'LocalPilot AI',
    description:
      'Keeps local models working past their context window: old turns are compacted into a running summary, the plan survives in durable checkpoints, and the agent step ceiling is removed.',
    category: 'AI',
    icon: 'refresh',
    groups: ['infinite'],
    permissions: ['model.local', 'storage.local'],
    riskNote:
      'Compaction replaces old turns with a summary. Save important facts with infinite.checkpoint so nothing you need is lost.'
  }
]

export function ensureBuiltinPlugins() {
  for (const plugin of BUILTIN_PLUGINS) {
    if (plugin.optional) continue
    const existing = get<{ id: string }>('SELECT id FROM plugins WHERE id = ?', [plugin.id])
    if (!existing) {
      run(
        'INSERT INTO plugins (id, name, version, enabled, source, manifest, config, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          plugin.id,
          plugin.name,
          plugin.version,
          1,
          'builtin',
          JSON.stringify(plugin),
          '{}',
          new Date().toISOString()
        ]
      )
    }
  }
}

export function builtinEnabled(id: string): boolean {
  const row = get<{ enabled: number }>('SELECT enabled FROM plugins WHERE id = ?', [id])
  if (row) return Boolean(row.enabled)
  return !BUILTIN_PLUGINS.find((plugin) => plugin.id === id)?.optional
}

export function groupEnabled(group: string): boolean {
  const def = BUILTIN_PLUGINS.find((p) => p.groups.includes(group))
  if (!def) return true
  return builtinEnabled(def.id)
}

export function builtinPluginInfos(): PluginInfo[] {
  const rows = all<{ id: string; enabled: number; installed_at: string }>(
    "SELECT id, enabled, installed_at FROM plugins WHERE source = 'builtin'"
  )
  return BUILTIN_PLUGINS.filter((def) => !def.optional || rows.some((row) => row.id === def.id)).map((def) => {
    const row = rows.find((r) => r.id === def.id)
    return {
      id: def.id,
      name: def.name,
      version: def.version,
      author: def.author,
      description: def.description,
      category: def.category,
      icon: def.icon,
      permissions: def.permissions,
      os: ['win32'],
      source: 'builtin' as const,
      enabled: row ? Boolean(row.enabled) : true,
      installed: true,
      installedAt: row?.installed_at,
      builtinGroups: def.groups,
      tools: []
    }
  })
}

export function setBuiltinEnabled(id: string, enabled: boolean) {
  const plugin = BUILTIN_PLUGINS.find((p) => p.id === id)
  if (!plugin) return
  run(
    "INSERT INTO plugins (id, name, version, enabled, source, manifest, config, installed_at) VALUES (?, ?, ?, ?, 'builtin', ?, '{}', ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, name = excluded.name, version = excluded.version, manifest = excluded.manifest",
    [plugin.id, plugin.name, plugin.version, enabled ? 1 : 0, JSON.stringify(plugin), new Date().toISOString()]
  )
}

/** Remove an optional built-in pack so it can be installed again from the marketplace. */
export function removeOptionalBuiltin(id: string): boolean {
  const plugin = BUILTIN_PLUGINS.find((p) => p.id === id)
  if (!plugin?.optional) return false
  run('DELETE FROM plugins WHERE id = ?', [id])
  return true
}

export function groupForPluginId(id: string): string[] {
  return BUILTIN_PLUGINS.find((p) => p.id === id)?.groups ?? []
}
