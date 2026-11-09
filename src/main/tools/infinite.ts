import type { ToolDefinition } from './types'
import { fail, ok, requireString } from './types'
import { countCheckpoints, infiniteContextEnabled, saveCheckpoint } from '../plugins/infinite'
import { get } from '../db'
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
          'Older turns are compacted into a summary instead of being dropped, and checkpoints are always re-injected with the system prompt.'
        ].join('\n'),
        { checkpoints, messages: Number(messages?.count ?? 0) }
      )
    }
  }
]
