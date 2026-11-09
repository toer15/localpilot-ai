import { randomUUID } from 'node:crypto'
import { all, get, run } from '../db'
import { builtinEnabled } from './builtins'

export const INFINITE_PLUGIN_ID = 'infinite-context'

export interface ContextCheckpoint {
  id: string
  note: string
  createdAt: string
}

/**
 * Infinite Context keeps a local model working past its context window: older
 * turns are compacted into a summary, and the agent's plan survives in durable
 * checkpoints that are re-attached to every request.
 */
export function infiniteContextEnabled(): boolean {
  return builtinEnabled(INFINITE_PLUGIN_ID)
}

export function listCheckpoints(conversationId: string, limit = 20): ContextCheckpoint[] {
  return all<{ id: string; note: string; created_at: string }>(
    'SELECT id, note, created_at FROM context_checkpoints WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    [conversationId, limit]
  ).map((row) => ({ id: row.id, note: row.note, createdAt: row.created_at }))
}

export function saveCheckpoint(conversationId: string, note: string): ContextCheckpoint {
  const clean = note.trim().slice(0, 8000)
  if (!clean) throw new Error('Write the plan or facts to keep before saving a checkpoint.')
  const checkpoint: ContextCheckpoint = {
    id: randomUUID(),
    note: clean,
    createdAt: new Date().toISOString()
  }
  run('INSERT INTO context_checkpoints (id, conversation_id, note, created_at) VALUES (?, ?, ?, ?)', [
    checkpoint.id,
    conversationId,
    checkpoint.note,
    checkpoint.createdAt
  ])
  run(
    'DELETE FROM context_checkpoints WHERE conversation_id = ? AND id NOT IN (SELECT id FROM context_checkpoints WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 40)',
    [conversationId, conversationId]
  )
  return checkpoint
}

export function countCheckpoints(conversationId: string): number {
  const row = get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM context_checkpoints WHERE conversation_id = ?',
    [conversationId]
  )
  return Number(row?.count ?? 0)
}

/** Checkpoints injected into the system prompt so compaction cannot lose the plan. */
export function checkpointPromptBlock(conversationId: string): string {
  const items = listCheckpoints(conversationId, 20).reverse()
  if (!items.length) return ''
  return [
    'Durable checkpoints saved with infinite.checkpoint. They survive context compaction, so treat them as the authoritative plan:',
    ...items.map((item, index) => `${index + 1}. ${item.note}`)
  ].join('\n')
}
