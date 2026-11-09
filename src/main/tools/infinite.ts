import type { ToolDefinition } from './types'
import { fail, ok, requireString } from './types'
import { countCheckpoints, infiniteContextEnabled, listCheckpoints, saveCheckpoint } from '../plugins/infinite'
import { all, get } from '../db'
import { settings } from '../settings'

export const infiniteTools: ToolDefinition[] = [
  {
    name: 'infinite.checkpoint',
    description:
      'Save the current plan, decisions and facts to a durable checkpoint for this conversation. Checkpoints survive context compaction and are re-attached on every turn, so a long task keeps going after old turns are summarised. Use it when you start a plan, when the plan changes, and before long tool sequences.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The plan or facts to keep: goal, steps done, current step, what remains and any decisions.'
        }
      },
      required: ['note']
    },
    risk: 'low',
    category: 'context',
    group: 'infinite',
    source: 'builtin',
    handler: async (args, ctx) => {
      try {
        const checkpoint = saveCheckpoint(ctx.conversationId, requireString(args, 'note'))
        return ok(
          `Saved checkpoint (${countCheckpoints(ctx.conversationId)} active). It will be re-attached to every request, even after compaction.`,
          checkpoint
        )
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  },
  {
    name: 'infinite.recall',
    description:
      'Search the complete archived history of this conversation — including turns already compacted out of the model window — and its saved checkpoints. Use it whenever you need an earlier detail that is no longer visible in the prompt. Nothing is ever deleted from the archive.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a phrase to find, e.g. "the port number" or "failed migration".' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 25).' }
      },
      required: ['query']
    },
    risk: 'low',
    category: 'context',
    group: 'infinite',
    source: 'builtin',
    handler: async (args, ctx) => {
      const query = requireString(args, 'query').trim()
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10))
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 1)
        .slice(0, 6)
      if (!terms.length) return fail('Write at least one word to search the archive for.')
      const clauses = terms.map(() => 'LOWER(content) LIKE ?').join(' OR ')
      const rows = all<{ role: string; content: string; created_at: string }>(
        `SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND (${clauses}) ORDER BY rowid DESC LIMIT ?`,
        [ctx.conversationId, ...terms.map((term) => `%${term}%`), limit]
      )
      const notes = listCheckpoints(ctx.conversationId, 40).filter((note) =>
        terms.some((term) => note.note.toLowerCase().includes(term))
      )
      if (!rows.length && !notes.length) {
        return ok(`No archived turns or checkpoints match "${query}". The full conversation is still stored and can be searched with other words.`)
      }
      const blocks = [
        ...notes.slice(0, 5).map((note) => `[checkpoint ${note.createdAt}] ${note.note.slice(0, 800)}`),
        ...rows.map((row) => `[${row.role} ${row.created_at}] ${row.content.replace(/\s+/g, ' ').slice(0, 700)}`)
      ]
      return ok(
        `Archive matches for "${query}" (${rows.length} message(s), ${notes.length} checkpoint(s)):\n\n${blocks.join('\n\n')}`,
        { messages: rows.length, checkpoints: notes.length }
      )
    }
  },
  {
    name: 'infinite.status',
    description:
      'Report how the context window is managed: whether Infinite Context is active, the configured window, message count and saved checkpoints for this conversation.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'context',
    group: 'infinite',
    source: 'builtin',
    handler: async (_args, ctx) => {
      const s = settings.get()
      const messages = get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
        [ctx.conversationId]
      )
      const checkpoints = countCheckpoints(ctx.conversationId)
      return ok(
        [
          `Infinite Context: ${infiniteContextEnabled() ? 'active' : 'disabled'}.`,
          `Configured context window: ${s.models.contextLength.toLocaleString()} tokens; the selected model's own limit is still respected.`,
          `Messages in this conversation: ${Number(messages?.count ?? 0)}.`,
          `Durable checkpoints: ${checkpoints}.`,
            'Older turns are compacted into a summary instead of being dropped, checkpoints are always re-injected with the system prompt, and every turn stays searchable through infinite.recall.'
        ].join('\n'),
        { checkpoints, messages: Number(messages?.count ?? 0) }
      )
    }
  }
]
