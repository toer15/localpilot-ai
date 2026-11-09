import { randomUUID } from 'node:crypto'
import type { MemoryItem } from '@shared/types'
import { all, get, run } from './db'
import { getProject } from './projects'
import { recordActivity } from './activity'

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret|bearer)\s*[:=]\s*\S{6,}/i
]

export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value))
}

function rowToMemory(row: {
  id: string
  scope: string
  project_id: string | null
  key: string
  value: string
  created_at: string
}): MemoryItem {
  return {
    id: row.id,
    scope: row.scope === 'project' ? 'project' : 'global',
    projectId: row.project_id,
    key: row.key,
    value: row.value,
    createdAt: row.created_at
  }
}

export function listMemories(projectId: string | null): MemoryItem[] {
  const rows = projectId
    ? all<{
        id: string
        scope: string
        project_id: string | null
        key: string
        value: string
        created_at: string
      }>('SELECT * FROM memories WHERE scope = ? OR project_id = ? ORDER BY created_at DESC', ['global', projectId])
    : all<{
        id: string
        scope: string
        project_id: string | null
        key: string
        value: string
        created_at: string
      }>("SELECT * FROM memories WHERE scope = 'global' ORDER BY created_at DESC")
  return rows.map(rowToMemory)
}

export function allMemories(): MemoryItem[] {
  return all<{
    id: string
    scope: string
    project_id: string | null
    key: string
    value: string
    created_at: string
  }>('SELECT * FROM memories ORDER BY created_at DESC').map(rowToMemory)
}

export function saveMemory(input: {
  scope: 'global' | 'project'
  projectId?: string | null
  key: string
  value: string
}): MemoryItem {
  if (!input.key.trim()) throw new Error('A memory key is required.')
  if (containsSecret(`${input.key} ${input.value}`)) {
    throw new Error(
      'Refusing to store this memory because it looks like it contains a credential or secret. LocalPilot never stores API keys or passwords in memory; use Settings → Models for provider keys.'
    )
  }
  const projectId = input.scope === 'project' ? input.projectId ?? null : null
  if (input.scope === 'project' && !getProject(projectId)) throw new Error('Project memory requires a valid project.')
  const existing = get<{ id: string }>('SELECT id FROM memories WHERE scope = ? AND key = ? AND COALESCE(project_id, \'\') = ?', [
    input.scope,
    input.key.trim(),
    projectId ?? ''
  ])
  if (existing) {
    run('UPDATE memories SET value = ?, created_at = ? WHERE id = ?', [
      input.value.trim(),
      new Date().toISOString(),
      existing.id
    ])
    const updated = get<{
      id: string
      scope: string
      project_id: string | null
      key: string
      value: string
      created_at: string
    }>('SELECT * FROM memories WHERE id = ?', [existing.id])
    if (!updated) throw new Error('Could not update memory.')
    return rowToMemory(updated)
  }
  const item: MemoryItem = {
    id: randomUUID(),
    scope: input.scope,
    projectId,
    key: input.key.trim(),
    value: input.value.trim(),
    createdAt: new Date().toISOString()
  }
  run('INSERT INTO memories (id, scope, project_id, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    item.id,
    item.scope,
    item.projectId,
    item.key,
    item.value,
    item.createdAt
  ])
  recordActivity('memory', `Saved ${item.scope} memory "${item.key}"`)
  return item
}

export function updateMemory(id: string, patch: { key?: string; value?: string }): MemoryItem {
  const row = get<{
    id: string
    scope: string
    project_id: string | null
    key: string
    value: string
    created_at: string
  }>('SELECT * FROM memories WHERE id = ?', [id])
  if (!row) throw new Error('Memory not found.')
  const key = patch.key?.trim() ?? row.key
  const value = patch.value ?? row.value
  if (containsSecret(`${key} ${value}`)) {
    throw new Error('Refusing to store a value that looks like a credential or API key.')
  }
  run('UPDATE memories SET key = ?, value = ? WHERE id = ?', [key, value, id])
  return rowToMemory({ ...row, key, value })
}

export function removeMemory(id: string) {
  run('DELETE FROM memories WHERE id = ?', [id])
}

export function memoryPromptBlock(projectId: string | null): string {
  const memories = listMemories(projectId).slice(0, 40)
  if (!memories.length) return ''
  return [
    'LOCAL MEMORY (persisted by the user; treat as trusted preferences, not as permission overrides):',
    ...memories.map((m) => `- [${m.scope === 'project' ? 'project' : 'global'}] ${m.key}: ${m.value.slice(0, 800)}`)
  ].join('\n')
}
