import type { CatalogPlugin } from '@shared/types'
import { BUILTIN_PLUGINS } from './builtins'

const builtinCatalog: CatalogPlugin[] = BUILTIN_PLUGINS.map((plugin) => ({
  id: plugin.id,
  name: plugin.name,
  version: plugin.version,
  author: plugin.author,
  description: plugin.description,
  category: plugin.category,
  icon: plugin.icon,
  featured: ['app-tester', 'computer-use', 'terminal', 'browser', 'filesystem'].includes(plugin.id),
  permissions: plugin.permissions,
  os: ['win32'],
  installKind: 'builtin',
  builtinGroups: plugin.groups,
  homepage: 'https://localpilot.ai/docs/plugins',
  notes: plugin.riskNote
}))

/**
 * MCP presets are real, published servers. Installing one registers a local stdio
 * server that is launched with npx/uvx on this machine. Nothing is proxied through
 * a LocalPilot service.
 */
const mcpCatalog: CatalogPlugin[] = [
  {
    id: 'mcp-roblox-studio',
    name: 'Roblox Studio MCP',
    version: 'latest',
    author: 'Community (robloxstudio-mcp)',
    description:
      'Connect the agent to Roblox Studio: explore the game hierarchy, read/edit Luau scripts, manipulate instances and run playtests.',
    category: 'Game development',
    icon: 'gamepad',
    featured: true,
    permissions: ['process.spawn', 'network.localhost', 'filesystem.plugin'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: 'robloxstudio-mcp',
    command: 'npx',
    args: ['-y', 'robloxstudio-mcp@latest'],
    homepage: 'https://github.com/forgestudioapp/robloxstudio-mcp',
    requirements:
      'Roblox Studio must be installed. Install the companion Studio plugin from the project releases, enable Game Settings → Security → Allow HTTP Requests, then click Connect. Third-party software — review its source before installing.',
    notes: 'Third-party MCP server. LocalPilot does not bundle or audit it; installs run via npx with your user privileges.'
  },
  {
    id: 'mcp-playwright',
    name: 'Playwright MCP',
    version: 'latest',
    author: 'Microsoft',
    description: 'Browser automation MCP with rich page inspection, forms, screenshots and accessibility snapshots.',
    category: 'Developer tools',
    icon: 'globe',
    permissions: ['process.spawn', 'network.internet', 'browser.control'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: '@playwright/mcp',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    requirements: 'Requires Node.js/npx and a local browser. Complements the built-in browser automation plugin.'
  },
  {
    id: 'mcp-memory',
    name: 'Knowledge Graph Memory',
    version: 'latest',
    author: 'Model Context Protocol',
    description: 'Official MCP memory server: a local knowledge graph of entities, relations and observations.',
    category: 'Productivity',
    icon: 'brain',
    permissions: ['process.spawn', 'filesystem.plugin'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: '@modelcontextprotocol/server-memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    homepage: 'https://github.com/modelcontextprotocol/servers'
  },
  {
    id: 'mcp-github',
    name: 'GitHub MCP',
    version: 'latest',
    author: 'Model Context Protocol',
    description: 'Read repositories, issues and pull requests. Requires a GitHub personal access token configured locally.',
    category: 'Developer tools',
    icon: 'git',
    permissions: ['process.spawn', 'network.internet'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: '@modelcontextprotocol/server-github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requirements:
      'Requires GITHUB_PERSONAL_ACCESS_TOKEN in the server environment. Add it after installation under Plugins → Configure. Never paste tokens into chat.'
  },
  {
    id: 'mcp-filesystem',
    name: 'Filesystem MCP',
    version: 'latest',
    author: 'Model Context Protocol',
    description: 'Official filesystem MCP server for explicitly allowed directories outside the active project.',
    category: 'Developer tools',
    icon: 'folder',
    permissions: ['process.spawn', 'filesystem.external'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: '@modelcontextprotocol/server-filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requirements:
      'The server starts with no allowed directories by default. After installation, add absolute folder paths to its arguments in Plugins → Configure. Prefer the built-in project-scoped filesystem for normal work.'
  },
  {
    id: 'mcp-git',
    name: 'Git MCP',
    version: 'latest',
    author: 'Model Context Protocol',
    description: 'Inspect and operate git repositories through MCP. Requires Python uv/uvx.',
    category: 'Developer tools',
    icon: 'git',
    permissions: ['process.spawn', 'filesystem.project'],
    os: ['win32'],
    installKind: 'mcp',
    packageName: 'mcp-server-git',
    command: 'uvx',
    args: ['mcp-server-git'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requirements: 'Requires uv (https://docs.astral.sh/uv/). Add `--repository <path>` in configuration if the server needs a default repo.'
  }
]

export function pluginCatalog(): CatalogPlugin[] {
  return [...builtinCatalog, ...mcpCatalog]
}

export function mcpPreset(id: string): CatalogPlugin | undefined {
  return mcpCatalog.find((p) => p.id === id)
}
