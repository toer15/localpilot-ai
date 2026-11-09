import type { ToolDefinition } from './types'
import { ok, str } from './types'
import { aiOverlay } from '../computer/overlay'
import { settings } from '../settings'

function enabled() {
  return settings.get().computer.enabled
}

export const testerTools: ToolDefinition[] = [
  {
    name: 'testing.start',
    description:
      'Start AI app/game testing mode. Shows an independent green AI cursor that moves only when the AI acts, a full-screen takeover border and an on-screen "Press Esc to stop" prompt. Call this before launching or testing a game or desktop app, and use testing.stop when the test is finished.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short description of what is being tested, shown on the overlay.' }
      }
    },
    risk: 'medium',
    category: 'computer',
    group: 'testing',
    source: 'builtin',
    enabled,
    preview: (args) =>
      `Turn on the AI test overlay${str(args.label).trim() ? ` for "${str(args.label).trim()}"` : ''}.\n\nA separate green AI cursor and a full-screen border will be visible. The cursor shows AI targets and does not follow your mouse. Press Esc to stop.`,
    sessionKey: () => 'testing',
    handler: async (args) => {
      const label = str(args.label).trim().slice(0, 160)
      const status = await aiOverlay.start({
        label,
        onStop: async () => {
          const { emergencyStop } = await import('../emergency')
          await emergencyStop()
        }
      })
      const stop = status.shortcutRegistered ? 'Press Esc to stop' : 'Press Ctrl+Alt+Shift+X to stop'
      return ok(
        `AI test mode is active${label ? ` for "${label}"` : ''}. A separate green AI cursor, positioned by AI actions, and a full-screen takeover border are visible. ${stop} at any time; it cancels the run and hides the overlay.`,
        status
      )
    }
  },
  {
    name: 'testing.stop',
    description: 'Stop AI app/game testing mode and remove the green cursor and takeover border.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'computer',
    group: 'testing',
    source: 'builtin',
    enabled,
    handler: async () => {
      aiOverlay.hide()
      return ok('AI test mode stopped. The overlay and takeover border were removed.')
    }
  },
  {
    name: 'testing.status',
    description: 'Check whether AI test mode is active and which key stops it.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'computer',
    group: 'testing',
    source: 'builtin',
    enabled,
    handler: async () => {
      const status = aiOverlay.status()
      return ok(
        status.active
          ? `AI test mode is active${status.label ? `: ${status.label}` : ''}. Stop key: ${status.stopKey}.`
          : 'AI test mode is not active.',
        status
      )
    }
  }
]
