import type { ToolDefinition } from './types'
import { fail, num, ok, requireString, str } from './types'
import { browserManager } from '../browser'
import { settings } from '../settings'

const onlineEnabled = () => !settings.get().privacy.localOnly

function onlineBlocked() {
  return settings.get().privacy.localOnly
    ? 'Local-only mode blocks internet access. Disable it in Settings → Privacy to use browser tools.'
    : null
}

function validUrl(input: string): string {
  let url = input.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are allowed.')
  return parsed.toString()
}

export const browserTools: ToolDefinition[] = [
  {
    name: 'browser.open',
    enabled: onlineEnabled,
    description:
      'Open a URL in a real local Edge/Chrome window controlled by Playwright. Use browser.snapshot afterwards to read the page.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    preview: (args) => `Open a browser window at ${String(args.url)}`,
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      const url = validUrl(requireString(args, 'url'))
      const page = await browserManager.open(url)
      const title = await page.title().catch(() => '')
      return ok(`Opened ${page.url()}\nTitle: ${title || '(no title)'}`, { url: page.url(), title })
    }
  },
  {
    name: 'browser.navigate',
    enabled: onlineEnabled,
    description: 'Navigate the current browser tab to another URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    preview: (args) => `Navigate the browser to ${String(args.url)}`,
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      const url = validUrl(requireString(args, 'url'))
      const page = await browserManager.open(url)
      return ok(`Navigated to ${page.url()}`)
    }
  },
  {
    name: 'browser.snapshot',
    enabled: onlineEnabled,
    description:
      'Read the current page as an accessibility tree (or visible text fallback). Use it to find selectors and verify navigation.',
    parameters: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: 'Default 14000, max 30000.' } }
    },
    risk: 'low',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      try {
        return ok(await browserManager.snapshot(Math.min(num(args.maxChars, 14000), 30000)))
      } catch (err) {
        return fail(`Browser snapshot failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  },
  {
    name: 'browser.click',
    enabled: onlineEnabled,
    description: 'Click an element by CSS selector or visible text. Waits for the element to become actionable.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector. Optional if text is provided.' },
        text: { type: 'string', description: 'Visible text to click.' }
      }
    },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    preview: (args) => `Click ${str(args.selector) || `"${str(args.text)}"`} in the browser`,
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      const selector = str(args.selector)
      const text = str(args.text)
      if (!selector && !text) return fail('Provide selector or text.')
      try {
        const page = await browserManager.ensurePage()
        const target = selector ? page.locator(selector).first() : page.getByText(text, { exact: false }).first()
        await target.click({ timeout: 12000 })
        await page.waitForTimeout(600)
        return ok(`Clicked ${selector || `"${text}"`}. Now at ${page.url()}`)
      } catch (err) {
        return fail(`Click failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
  },
  {
    name: 'browser.type',
    enabled: onlineEnabled,
    description: 'Type text into a form field identified by CSS selector, or into the focused element.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' }
      },
      required: ['text']
    },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    preview: (args) => `Type ${str(args.text).slice(0, 160)} into the browser`,
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      const text = requireString(args, 'text')
      try {
        const page = await browserManager.ensurePage()
        if (args.selector) {
          await page.locator(str(args.selector)).first().fill(text, { timeout: 12000 })
        } else {
          await page.keyboard.type(text)
        }
        if (args.submit === true) {
          await page.keyboard.press('Enter')
          await page.waitForTimeout(700)
        }
        return ok(`Typed ${text.length} characters${args.selector ? ` into ${str(args.selector)}` : ''}.`)
      } catch (err) {
        return fail(`Typing failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
  },
  {
    name: 'browser.press',
    enabled: onlineEnabled,
    description: 'Press a key or shortcut in the current browser page, e.g. "Enter", "Control+A".',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key']
    },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    handler: async (args) => {
      const blocked = onlineBlocked()
      if (blocked) return fail(blocked)
      const key = requireString(args, 'key')
      await (await browserManager.ensurePage()).keyboard.press(key)
      return ok(`Pressed ${key}.`)
    }
  },
  {
    name: 'browser.screenshot',
    enabled: onlineEnabled,
    description: 'Capture a screenshot of the current browser page for visual verification.',
    parameters: { type: 'object', properties: {} },
    risk: 'medium',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    sessionKey: () => 'browser',
    handler: async () => {
      try {
        const shot = await browserManager.screenshot()
        return ok(
          `Browser screenshot saved to ${shot.path}. ${shot.dataUrl ? 'The image is attached for vision-capable models.' : ''}`,
          { path: shot.path },
          shot.dataUrl ? [shot.dataUrl] : undefined
        )
      } catch (err) {
        return fail(`Browser screenshot failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  },
  {
    name: 'browser.close',
    description: 'Close the automation browser and all its tabs.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'browser',
    group: 'browser',
    source: 'builtin',
    handler: async () => {
      await browserManager.close()
      return ok('Browser closed.')
    }
  }
]
