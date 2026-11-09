import fs from 'node:fs'
import path from 'node:path'
import type { Risk } from '@shared/types'
import type { ToolDefinition } from './types'
import { fail, num, ok, requireString, str } from './types'
import {
  activeWindow,
  appInstalled,
  captureScreen,
  focusWindow,
  keyboardAction,
  launchExecutable,
  listWindows,
  mouseAction,
  resolveApp,
  runComputer,
  uiTree,
  uiaFind,
  windowAction
} from '../computer'
import { settings } from '../settings'
import { recordActivity } from '../activity'

function enabledScreenshots() {
  const s = settings.get()
  return s.computer.enabled && s.computer.screenshots
}
function enabledWindows() {
  const s = settings.get()
  return s.computer.enabled && s.computer.windowControl
}
function enabledInput() {
  const s = settings.get()
  return s.computer.enabled && s.computer.mouseKeyboard
}

function launchRisk(args: Record<string, unknown>): Risk {
  const app = str(args.name)
  const resolved = resolveApp(app)
  if (!resolved) return 'medium'
  const base = path.basename(resolved).toLowerCase()
  const allow = settings.get().computer.allowlist.map((a) => a.toLowerCase())
  return allow.includes(base) ? 'medium' : 'high'
}

export const computerTools: ToolDefinition[] = [
  {
    name: 'screen.screenshot',
    description:
      'Capture the entire virtual desktop to a PNG. Screenshots are taken only when this tool is called. The image is attached for vision models.',
    parameters: { type: 'object', properties: {} },
    risk: 'medium',
    category: 'computer',
    group: 'computer',
    source: 'builtin',
    enabled: enabledScreenshots,
    sessionKey: () => 'screen',
    preview: () => 'Capture your screen once and show it to the model.',
    handler: async () => {
      if (!settings.get().computer.screenshots) return fail('Screenshots are disabled in Settings → Computer Use.')
      const shot = await captureScreen()
      recordActivity('computer', 'Captured a screenshot')
      return ok(
        `Screenshot captured: ${shot.width ?? '?'}×${shot.height ?? '?'} px, saved to ${shot.path}. The image is attached for vision-capable models. Inspect it before your next action.`,
        { path: shot.path, width: shot.width, height: shot.height },
        shot.dataUrl ? [shot.dataUrl] : undefined
      )
    }
  },
  {
    name: 'screen.windows',
    description: 'List visible top-level windows with their title, process, pid and window handle.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'computer',
    group: 'computer',
    source: 'builtin',
    enabled: enabledScreenshots,
    sessionKey: () => 'screen',
    handler: async () => {
      const windows = await listWindows()
      const fg = await activeWindow().catch(() => null)
      return ok(
        `Open windows (${windows.length})${fg ? ` · foreground: "${fg.title}"` : ''}:\n${windows
          .map(
            (w) =>
              `- "${w.title}" · ${w.processName} (pid ${w.pid}, hwnd ${w.hwnd})${w.minimized ? ' [minimized]' : ''}`
          )
          .join('\n')}`,
        windows
      )
    }
  },
  {
    name: 'screen.active_window',
    description: 'Show the title and handle of the currently focused window.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'computer',
    group: 'computer',
    source: 'builtin',
    enabled: enabledScreenshots,
    handler: async () => {
      const fg = await activeWindow()
      return ok(`Foreground window: "${fg.title}" (hwnd ${fg.hwnd})`, fg)
    }
  },
  {
    name: 'windows.focus',
    description: 'Bring a window to the foreground by title, process name or handle.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title.' },
        processName: { type: 'string', description: 'Process name, e.g. notepad.' },
        hwnd: { type: 'number' }
      }
    },
    risk: 'medium',
    category: 'windows',
    group: 'windows',
    source: 'builtin',
    enabled: enabledWindows,
    sessionKey: (args) => str(args.processName) || str(args.title) || 'window',
    preview: (args) => `Focus window ${str(args.title) || str(args.processName) || str(args.hwnd)}`,
    handler: async (args) => {
      if (!args.title && !args.processName && !args.hwnd) return fail('Provide title, processName or hwnd.')
      const res = await focusWindow({
        title: str(args.title) || undefined,
        processName: str(args.processName) || undefined,
        hwnd: args.hwnd ? num(args.hwnd, 0) : undefined
      })
      return res.ok
        ? ok(`Focused window "${str(res.data.title)}".`, res.data)
        : fail(res.error ?? 'Could not focus the window.')
    }
  },
  {
    name: 'windows.minimize',
    description: 'Minimize a window by title, process name or handle.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, processName: { type: 'string' }, hwnd: { type: 'number' } }
    },
    risk: 'medium',
    category: 'windows',
    group: 'windows',
    source: 'builtin',
    enabled: enabledWindows,
    handler: async (args) => {
      const res = await windowAction('minimize', {
        title: str(args.title) || undefined,
        processName: str(args.processName) || undefined,
        hwnd: args.hwnd ? num(args.hwnd, 0) : undefined
      })
      return res.ok ? ok('Window minimized.') : fail(res.error ?? 'Could not minimize the window.')
    }
  },
  {
    name: 'windows.maximize',
    description: 'Maximize a window by title, process name or handle.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, processName: { type: 'string' }, hwnd: { type: 'number' } }
    },
    risk: 'medium',
    category: 'windows',
    group: 'windows',
    source: 'builtin',
    enabled: enabledWindows,
    handler: async (args) => {
      const res = await windowAction('maximize', {
        title: str(args.title) || undefined,
        processName: str(args.processName) || undefined,
        hwnd: args.hwnd ? num(args.hwnd, 0) : undefined
      })
      return res.ok ? ok('Window maximized.') : fail(res.error ?? 'Could not maximize the window.')
    }
  },
  {
    name: 'windows.close',
    description: 'Ask a window to close (WM_CLOSE). May prompt the application to save changes. Requires explicit approval.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, processName: { type: 'string' }, hwnd: { type: 'number' } }
    },
    risk: 'high',
    category: 'windows',
    group: 'windows',
    source: 'builtin',
    enabled: enabledWindows,
    preview: (args) => `Close window ${str(args.title) || str(args.processName) || str(args.hwnd)}. Unsaved work may be lost.`,
    handler: async (args) => {
      const res = await windowAction('close_window', {
        title: str(args.title) || undefined,
        processName: str(args.processName) || undefined,
        hwnd: args.hwnd ? num(args.hwnd, 0) : undefined
      })
      return res.ok ? ok('Close request sent to the window.') : fail(res.error ?? 'Could not close the window.')
    }
  },
  {
    name: 'apps.launch',
    description:
      'Launch an installed Windows application by friendly name or executable path, e.g. "Notepad", "Visual Studio Code", "Roblox Studio".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Friendly name or absolute .exe path.' },
        arguments: { type: 'string', description: 'Optional command-line arguments.' }
      },
      required: ['name']
    },
    risk: 'medium',
    riskFor: launchRisk,
    category: 'windows',
    group: 'windows',
    source: 'builtin',
    enabled: enabledWindows,
    sessionKey: (args) => path.basename(resolveApp(str(args.name)) ?? str(args.name)).toLowerCase(),
    preview: (args) => {
      const resolved = resolveApp(str(args.name))
      const base = resolved ? path.basename(resolved).toLowerCase() : ''
      const trusted = settings.get().computer.allowlist.map((a) => a.toLowerCase()).includes(base)
      return `Launch ${str(args.name)}${resolved && resolved !== str(args.name) ? ` → ${resolved}` : ''}${
        trusted ? ' (trusted application)' : ' — this application is not on the trusted allowlist.'
      }${args.arguments ? `\nArguments: ${str(args.arguments)}` : ''}`
    },
    handler: async (args) => {
      const requested = requireString(args, 'name')
      const resolved = resolveApp(requested)
      if (!resolved) return fail(`Could not resolve application "${requested}".`)
      if (path.isAbsolute(resolved) && !fs.existsSync(resolved)) {
        return fail(
          `Application not found at ${resolved}. Check the install location or add the executable to the trusted app allowlist.`
        )
      }
      if (!(await appInstalled(resolved))) {
        return fail(`Application "${requested}" could not be found in PATH.`)
      }
      const res = await launchExecutable(resolved, str(args.arguments) || undefined)
      if (!res.ok) return fail(res.error ?? 'Application launch failed.')
      recordActivity('computer', `Launched ${path.basename(resolved)}`, { pid: res.data.pid })
      await new Promise((r) => setTimeout(r, 900))
      const windows = await listWindows().catch(() => [])
      const processBase = path.basename(resolved, '.exe').toLowerCase()
      const matching = windows.filter((w) => w.processName.toLowerCase().includes(processBase.slice(0, 12)))
      return ok(
        `Launched ${requested} (pid ${res.data.pid}, process ${res.data.processName}).${
          matching.length ? `\nWindows: ${matching.map((w) => `"${w.title}" (hwnd ${w.hwnd})`).join(', ')}` : ''
        }\nUse uia.inspect or screen.screenshot to see the interface before interacting.`,
        res.data
      )
    }
  },
  {
    name: 'uia.inspect',
    description:
      'Read Windows UI Automation elements of the foreground window: names, automation ids, control types and screen rectangles. Prefer this over guessing coordinates.',
    parameters: {
      type: 'object',
      properties: { depth: { type: 'number', description: 'Tree depth 1–6. Default 3.' } }
    },
    risk: 'medium',
    category: 'uia',
    group: 'uia',
    source: 'builtin',
    preview: () => 'Read the accessibility tree of the foreground window.',
    handler: async (args) => {
      const elements = await uiTree(Math.min(num(args.depth, 3), 6))
      const meaningful = elements.filter((e) => e.name || e.automationId)
      const lines = meaningful.slice(0, 160).map((e) => {
        const rect = e.width && e.height ? ` @${e.x ?? 0},${e.y ?? 0} ${e.width}×${e.height}` : ''
        return `${e.controlType}${e.name ? ` "${e.name.slice(0, 100)}"` : ''}${e.automationId ? ` #${e.automationId}` : ''}${
          e.enabled === false ? ' (disabled)' : ''
        }${rect}`
      })
      return ok(
        `UI Automation tree (${meaningful.length} named elements):\n${lines.join('\n') || '(no accessibility elements found; the app may not expose UI Automation)'}\n\nUse uia.click / uia.set_value with name or automationId.`,
        { count: meaningful.length }
      )
    }
  },
  {
    name: 'uia.find',
    description: 'Find UI Automation elements in the foreground window by name, automationId or control type.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        automationId: { type: 'string' },
        controlType: { type: 'string', description: 'e.g. Button, Edit, MenuItem' }
      }
    },
    risk: 'low',
    category: 'uia',
    group: 'uia',
    source: 'builtin',
    handler: async (args) => {
      if (!args.name && !args.automationId && !args.controlType) return fail('Provide name, automationId or controlType.')
      const res = await uiaFind({
        name: str(args.name) || undefined,
        automationId: str(args.automationId) || undefined,
        controlType: str(args.controlType) || undefined
      })
      if (!res.ok) return fail(res.error ?? 'Element search failed.')
      const matches = res.data.matches ?? []
      return ok(
        matches.length
          ? `Found ${matches.length} match(es):\n${matches
              .map(
                (m, i) =>
                  `${i + 1}. ${m.controlType} "${m.name}"${m.automationId ? ` #${m.automationId}` : ''}${
                    m.x !== undefined ? ` @${m.x},${m.y} ${m.width}×${m.height}` : ''
                  }${m.enabled === false ? ' (disabled)' : ''}`
              )
              .join('\n')}`
          : 'No matching UI Automation elements. The window may not expose accessibility data; use a screenshot and coordinates instead.',
        matches
      )
    }
  },
  {
    name: 'uia.click',
    description:
      'Activate a UI Automation element by name/automationId/control type using Invoke, Select or Toggle patterns (mouse fallback).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        automationId: { type: 'string' },
        controlType: { type: 'string' }
      }
    },
    risk: 'high',
    category: 'uia',
    group: 'uia',
    source: 'builtin',
    preview: (args) =>
      `Click UI element ${str(args.name) || str(args.automationId) || str(args.controlType)} in the foreground window.`,
    handler: async (args) => {
      if (!args.name && !args.automationId && !args.controlType) return fail('Provide an element identifier.')
      const res = await runComputer<{ method: string; name: string }>('uia_click', {
        name: str(args.name) || undefined,
        automationId: str(args.automationId) || undefined,
        controlType: str(args.controlType) || undefined
      })
      if (!res.ok) return fail(res.error ?? 'UI Automation click failed.')
      return ok(`Activated "${res.data.name}" using ${res.data.method}. Take a screenshot or re-inspect to verify the result.`)
    }
  },
  {
    name: 'uia.set_value',
    description: 'Set the value of a UI Automation edit/combobox element. Fall back to keyboard typing when unsupported.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        automationId: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['value']
    },
    risk: 'high',
    category: 'uia',
    group: 'uia',
    source: 'builtin',
    preview: (args) => `Set UI field ${str(args.name) || str(args.automationId)} to "${str(args.value).slice(0, 200)}"`,
    handler: async (args) => {
      if (!args.name && !args.automationId) return fail('Provide name or automationId.')
      const res = await runComputer('uia_set_value', {
        name: str(args.name) || undefined,
        automationId: str(args.automationId) || undefined,
        value: str(args.value)
      })
      return res.ok ? ok('Field value set.') : fail(res.error ?? 'Could not set the field value.')
    }
  },
  {
    name: 'input.mouse',
    description: 'Control the physical mouse: move, click, double-click, right-click, drag or scroll at screen coordinates.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'double', 'down', 'up', 'drag', 'scroll'] },
        x: { type: 'number' },
        y: { type: 'number' },
        toX: { type: 'number', description: 'Drag destination X.' },
        toY: { type: 'number', description: 'Drag destination Y.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        amount: { type: 'number', description: 'Scroll amount; positive is up, negative down.' }
      },
      required: ['action', 'x', 'y']
    },
    risk: 'high',
    category: 'computer',
    group: 'computer',
    source: 'builtin',
    enabled: enabledInput,
    sessionKey: () => 'desktop',
    preview: (args) =>
      `Mouse ${str(args.action)} at (${str(args.x)}, ${str(args.y)})${
        args.action === 'drag' ? ` to (${str(args.toX)}, ${str(args.toY)})` : ''
      }${args.button ? ` with ${str(args.button)} button` : ''}.`,
    handler: async (args) => {
      const action = requireString(args, 'action')
      if (!['move', 'click', 'double', 'down', 'up', 'drag', 'scroll'].includes(action)) return fail('Unsupported mouse action.')
      if (action === 'drag' && (args.toX === undefined || args.toY === undefined)) {
        return fail('drag requires toX and toY.')
      }
      const res = await mouseAction({
        action,
        x: num(args.x, 0),
        y: num(args.y, 0),
        toX: num(args.toX, 0),
        toY: num(args.toY, 0),
        button: str(args.button, 'left'),
        amount: num(args.amount, 3)
      })
      return res.ok ? ok(`Mouse ${action} completed.`) : fail(res.error ?? 'Mouse action failed.')
    }
  },
  {
    name: 'input.keyboard',
    description:
      'Type text into the focused application or send a key/shortcut such as "ctrl+s", "Enter", "Alt+Tab". Focus the target window first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type', 'keys'] },
        text: { type: 'string', description: 'Text for action=type.' },
        keys: { type: 'string', description: 'Key combination for action=keys, e.g. ctrl+shift+s.' }
      },
      required: ['action']
    },
    risk: 'high',
    category: 'computer',
    group: 'computer',
    source: 'builtin',
    enabled: enabledInput,
    sessionKey: () => 'desktop',
    preview: (args) =>
      args.action === 'type'
        ? `Type ${str(args.text).length} characters into the focused window:\n\n${str(args.text).slice(0, 500)}`
        : `Send keyboard shortcut ${str(args.keys)} to the focused window.`,
    handler: async (args) => {
      const action = requireString(args, 'action')
      if (action === 'type') {
        const text = requireString(args, 'text')
        if (text.length > 20000) return fail('Text is too long for one action (max 20,000 characters).')
        const res = await keyboardAction({ action: 'type', text })
        return res.ok ? ok(`Typed ${text.length} characters into the focused window.`) : fail(res.error ?? 'Typing failed.')
      }
      const keys = requireString(args, 'keys')
      const res = await keyboardAction({ action: 'keys', keys })
      return res.ok ? ok(`Sent ${keys}.`) : fail(res.error ?? 'Key sequence failed.')
    }
  }
]
