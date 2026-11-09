import type { ToolDefinition } from './types'
import { fail, ok, requireString, str } from './types'
import { listMemories, removeMemory, saveMemory } from '../memory'
import { getActiveProject } from '../projects'

export const memoryTools: ToolDefinition[] = [
  {
    name: 'memory.save',
    description:
      'Persist a user preference or project convention to local memory. Never store credentials, API keys or passwords — this is enforced.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short label, e.g. "preferred test command".' },
        value: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Project uses the active project.' }
      },
      required: ['key', 'value']
    },
    risk: 'low',
    category: 'memory',
    group: 'memory',
    source: 'builtin',
    handler: async (args) => {
      const scope = args.scope === 'project' ? 'project' : 'global'
      const project = getActiveProject()
      if (scope === 'project' && !project) return fail('There is no active project to attach this memory to.')
      try {
        const item = saveMemory({
          scope,
          projectId: project?.id ?? null,
          key: requireString(args, 'key'),
          value: requireString(args, 'value')
        })
        return ok(`Saved ${scope} memory "${item.key}".`, item)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  },
  {
    name: 'memory.list',
    description: 'List saved global and active-project memories, optionally filtered by key/value text.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } }
    },
    risk: 'low',
    category: 'memory',
    group: 'memory',
    source: 'builtin',
    handler: async (args) => {
      const project = getActiveProject()
      const items = listMemories(project?.id ?? null)
      const query = str(args.query).toLowerCase()
      const filtered = query
        ? items.filter((m) => `${m.key} ${m.value}`.toLowerCase().includes(query))
        : items
      if (!filtered.length) return ok('No matching memories.')
      return ok(filtered.map((m) => `[${m.id.slice(0, 8)}] (${m.scope}) ${m.key}: ${m.value}`).join('\n'))
    }
  },
  {
    name: 'memory.delete',
    description: 'Delete a memory by its id prefix shown in memory.list.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    risk: 'medium',
    category: 'memory',
    group: 'memory',
    source: 'builtin',
    preview: (args) => `Delete memory ${str(args.id)}`,
    handler: async (args) => {
      const idPrefix = requireString(args, 'id')
      const project = getActiveProject()
      const item = listMemories(project?.id ?? null).find((m) => m.id.startsWith(idPrefix))
      if (!item) return fail('Memory not found.')
      removeMemory(item.id)
      return ok(`Deleted memory "${item.key}".`)
    }
  }
]
