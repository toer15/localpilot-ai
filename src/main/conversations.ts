import { randomUUID } from 'node:crypto'
import type { ConversationDetail, ConversationSummary, StoredMessage, ToolCallRecord } from '@shared/types'
import { all, get, run } from './db'
import { recordActivity } from './activity'

interface ConversationRow {
  id: string
  title: string
  project_id: string | null
  provider_id: string | null
  model_id: string | null
  created_at: string
  updated_at: string
  message_count?: number
}

function summaryFromRow(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0)
  }
}

export function listConversations(projectId?: string | null): ConversationSummary[] {
  const rows =
    projectId === undefined || projectId === null
      ? all<ConversationRow>(
          'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c ORDER BY c.updated_at DESC LIMIT 200'
        )
      : all<ConversationRow>(
          'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.project_id = ? ORDER BY c.updated_at DESC LIMIT 200',
          [projectId]
        )
  return rows.map(summaryFromRow)
}

export function createConversation(input?: {
  title?: string
  projectId?: string | null
  providerId?: string | null
  modelId?: string | null
}): ConversationSummary {
  const now = new Date().toISOString()
  const id = randomUUID()
  const title = input?.title?.trim() || 'New conversation'
  run(
    'INSERT INTO conversations (id, title, project_id, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, title, input?.projectId ?? null, input?.providerId ?? null, input?.modelId ?? null, now, now]
  )
  return summaryFromRow({
    id,
    title,
    project_id: input?.projectId ?? null,
    provider_id: input?.providerId ?? null,
    model_id: input?.modelId ?? null,
    created_at: now,
    updated_at: now,
    message_count: 0
  })
}

export function getConversation(id: string): ConversationDetail | null {
  const row = get<ConversationRow>(
    'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.id = ?',
    [id]
  )
  if (!row) return null
  const messages = all<{
    id: string
    conversation_id: string
    role: StoredMessage['role']
    content: string
    reasoning: string | null
    tool_calls: string | null
    attachments: string | null
    provider_id: string | null
    model_id: string | null
    meta: string | null
    created_at: string
  }>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC', [id]).map((m) => ({
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    toolCalls: m.tool_calls ? safeParse<ToolCallRecord[]>(m.tool_calls, []) : undefined,
    attachments: m.attachments ? safeParse(m.attachments, []) : undefined,
    providerId: m.provider_id ?? undefined,
    modelId: m.model_id ?? undefined,
    createdAt: m.created_at,
    meta: m.meta ? safeParse<Record<string, unknown>>(m.meta, {}) : undefined
  }))
  return { ...summaryFromRow(row), messages }
}

export function addMessage(
  conversationId: string,
  input: Partial<StoredMessage> & Pick<StoredMessage, 'role' | 'content'>
): StoredMessage {
  const message: StoredMessage = {
    id: randomUUID(),
    conversationId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning,
    toolCalls: input.toolCalls,
    attachments: input.attachments,
    providerId: input.providerId,
    modelId: input.modelId,
    createdAt: new Date().toISOString(),
    meta: input.meta
  }
  run(
    'INSERT INTO messages (id, conversation_id, role, content, reasoning, tool_calls, attachments, provider_id, model_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      message.id,
      conversationId,
      message.role,
      message.content,
      message.reasoning ?? null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.providerId ?? null,
      message.modelId ?? null,
      message.meta ? JSON.stringify(message.meta) : null,
      message.createdAt
    ]
  )
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', [message.createdAt, conversationId])
  return message
}

export function updateMessageToolCalls(messageId: string, toolCalls: ToolCallRecord[]) {
  run('UPDATE messages SET tool_calls = ? WHERE id = ?', [JSON.stringify(toolCalls), messageId])
}

/** Replace the text of a sent user message. Only user turns are editable. */
export function replaceUserMessage(
  conversationId: string,
  messageId: string,
  content: string,
  attachments?: StoredMessage['attachments']
): boolean {
  const row = get<{ role: string; conversation_id: string }>(
    'SELECT role, conversation_id FROM messages WHERE id = ?',
    [messageId]
  )
  if (!row || row.role !== 'user' || row.conversation_id !== conversationId) return false
  if (attachments === undefined) {
    run('UPDATE messages SET content = ? WHERE id = ?', [content, messageId])
  } else {
    run('UPDATE messages SET content = ?, attachments = ? WHERE id = ?', [
      content,
      attachments.length ? JSON.stringify(attachments) : null,
      messageId
    ])
  }
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', [new Date().toISOString(), conversationId])
  return true
}

/**
 * Rewind a conversation to `messageId`: every later message is deleted so an
 * edited turn becomes the newest message again.
 */
export function truncateAfterMessage(conversationId: string, messageId: string): number {
  const anchor = get<{ rowid: number }>(
    'SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  )
  if (!anchor) return 0
  const result = run('DELETE FROM messages WHERE conversation_id = ? AND rowid > ?', [
    conversationId,
    Number(anchor.rowid)
  ])
  if (result.changes) {
    run('UPDATE conversations SET updated_at = ? WHERE id = ?', [new Date().toISOString(), conversationId])
  }
  return result.changes
}

export function setConversationTitle(id: string, title: string) {
  const clean = title.trim().slice(0, 120) || 'Conversation'
  run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [clean, new Date().toISOString(), id])
}

export function setConversationModel(id: string, providerId: string, modelId: string) {
  run('UPDATE conversations SET provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?', [
    providerId,
    modelId,
    new Date().toISOString(),
    id
  ])
}

export function deleteConversation(id: string) {
  run('DELETE FROM messages WHERE conversation_id = ?', [id])
  run('DELETE FROM conversations WHERE id = ?', [id])
  recordActivity('conversation', 'Deleted a conversation')
}

export function autoTitle(conversationId: string, firstUserText: string) {
  const row = get<{ title: string; count: number }>(
    'SELECT c.title, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = \'user\') AS count FROM conversations c WHERE c.id = ?',
    [conversationId]
  )
  if (!row) return
  if (Number(row.count) <= 1 && (!row.title || row.title === 'New conversation')) {
    setConversationTitle(
      conversationId,
      firstUserText.replace(/\s+/g, ' ').trim().slice(0, 70) || 'New conversation'
    )
  }
}

function safeParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
