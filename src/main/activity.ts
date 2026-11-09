import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { all, run } from './db'
import { log } from './core/logger'
import type { ActivityItem } from '@shared/types'

export const activityEvents = new EventEmitter()

export function recordActivity(kind: string, summary: string, detail?: unknown): ActivityItem {
  const item: ActivityItem = {
    id: randomUUID(),
    kind,
    summary: summary.slice(0, 500),
    detail,
    createdAt: new Date().toISOString()
  }
  try {
    run('INSERT INTO activity (id, kind, summary, detail, created_at) VALUES (?, ?, ?, ?, ?)', [
      item.id,
      item.kind,
      item.summary,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 20000),
      item.createdAt
    ])
    activityEvents.emit('activity', item)
  } catch (err) {
    log.warn('activity', 'Could not record activity', String(err))
  }
  return item
}

export function listActivity(limit = 200): ActivityItem[] {
  const rows = all<{ id: string; kind: string; summary: string; detail: string | null; created_at: string }>(
    'SELECT * FROM activity ORDER BY created_at DESC LIMIT ?',
    [Math.max(1, Math.min(limit, 1000))]
  )
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ? safeParse(row.detail) : undefined,
    createdAt: row.created_at
  }))
}

export function clearActivity() {
  run('DELETE FROM activity')
}

function safeParse(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
