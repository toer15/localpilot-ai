import { agentRunner } from './agent/agent'
import { clearPermissionState } from './permissions'
import { killSession, listSessions } from './tools/terminal'
import { browserManager } from './browser'
import { broadcast } from './broadcast'
import { recordActivity } from './activity'
import { log } from './core/logger'

let stopping = false

export async function emergencyStop(): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    const stopped = agentRunner.stop().stopped
    try {
      const { aiOverlay } = await import('./computer/overlay')
      aiOverlay.hide()
    } catch {
      // overlay may not be initialised
    }
    clearPermissionState()
    let sessions = 0
    for (const session of listSessions()) {
      if (session.status === 'running') {
        killSession(session.id)
        sessions++
      }
    }
    await browserManager.close().catch(() => undefined)
    recordActivity('emergency-stop', `Emergency stop: halted ${stopped} agent run(s) and ${sessions} process(es)`)
    log.warn('emergency', 'Emergency stop triggered')
    broadcast('emergency:stop', { at: new Date().toISOString(), stoppedRuns: stopped, stoppedSessions: sessions })
  } finally {
    stopping = false
  }
}
