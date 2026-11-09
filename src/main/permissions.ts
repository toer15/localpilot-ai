import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PermissionDecision, PermissionRequest, Risk } from '@shared/types'
import { settings } from './settings'
import { recordActivity } from './activity'
import { log } from './core/logger'

interface PendingPermission {
  request: PermissionRequest
  resolve: (decision: PermissionDecision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingPermission>()
const sessionApprovals = new Set<string>()
const trusted = new Set<string>()

export interface PermissionCheck {
  tool: string
  args: Record<string, unknown>
  risk: Risk
  runId: string
  title: string
  detail: string
  sessionKey: string
}

export async function ensurePermission(check: PermissionCheck): Promise<PermissionDecision> {
  const mode = settings.get().computer.approvalMode

  // Destructive actions always require explicit approval, regardless of policy.
  if (trusted.has(check.sessionKey)) return 'allow'
  if (sessionApprovals.has(check.sessionKey) && check.risk !== 'high') return 'allow'
  if (check.risk === 'high') {
    // fall through to ask
  } else if (mode === 'auto-safe' && check.risk === 'low') {
    return 'allow'
  }

  if (check.risk !== 'high' && check.sessionKey.startsWith('computer:')) {
    // A trusted application session can be approved once via the dialog.
  }

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) {
    log.warn('permissions', `No UI available to approve ${check.tool}; denying`)
    return 'deny'
  }

  const request: PermissionRequest = {
    id: randomUUID(),
    runId: check.runId,
    tool: check.tool,
    args: check.args,
    risk: check.risk,
    title: check.title,
    detail: check.detail,
    sessionKey: check.sessionKey,
    createdAt: new Date().toISOString()
  }

  return new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id)
      recordActivity('permission', `Timed out waiting for approval: ${check.tool}`, { risk: check.risk })
      resolve('deny')
    }, 10 * 60 * 1000)
    pending.set(request.id, { request, resolve, timer })
    try {
      win.webContents.send('permission:request', request)
      win.show()
      win.focus()
    } catch (err) {
      clearTimeout(timer)
      pending.delete(request.id)
      log.error('permissions', 'Could not show approval request', String(err))
      resolve('deny')
    }
  })
}

export function respondPermission(id: string, decision: PermissionDecision): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(id)
  if (decision === 'allow-session') sessionApprovals.add(entry.request.sessionKey)
  if (decision === 'allow-always') trusted.add(entry.request.sessionKey)
  recordActivity(
    'permission',
    `${decision === 'deny' ? 'Denied' : 'Approved'} ${entry.request.tool}`,
    { risk: entry.request.risk, decision }
  )
  entry.resolve(decision)
  return true
}

export function pendingPermissions(): PermissionRequest[] {
  return [...pending.values()].map((p) => p.request)
}

export function clearPermissionState() {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.resolve('deny')
  }
  pending.clear()
  sessionApprovals.clear()
  trusted.clear()
}

export function revokeSession(key: string) {
  sessionApprovals.delete(key)
}

export function permissionSnapshot() {
  return { session: [...sessionApprovals], trusted: [...trusted], pending: pending.size }
}
