import fs from 'node:fs'
import path from 'node:path'
import type { BrowserState } from '@shared/types'
import { getPaths } from './core/paths'
import { log } from './core/logger'
import type { Browser, BrowserContext, Page } from 'playwright-core'

class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private engine = ''
  private lastError = ''
  private opening: Promise<Page> | null = null

  state(): BrowserState {
    return {
      open: Boolean(this.page && !this.page.isClosed()),
      url: this.page && !this.page.isClosed() ? this.page.url() : undefined,
      title: undefined,
      engine: this.engine || undefined,
      error: this.lastError || undefined
    }
  }

  async title(): Promise<string | undefined> {
    try {
      return this.page && !this.page.isClosed() ? await this.page.title() : undefined
    } catch {
      return undefined
    }
  }

  private async launch(): Promise<Browser> {
    const { chromium } = await import('playwright-core')
    const attempts: { label: string; options: Record<string, unknown> }[] = [
      { label: 'Microsoft Edge', options: { channel: 'msedge' } },
      { label: 'Google Chrome', options: { channel: 'chrome' } }
    ]
    const edgeCandidates = [
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter((p) => p && fs.existsSync(p))
    for (const candidate of edgeCandidates) {
      attempts.push({ label: candidate, options: { executablePath: candidate } })
    }
    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        const browser = await chromium.launch({
          ...attempt.options,
          headless: false,
          timeout: 30000,
          args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
        })
        this.engine = String(attempt.options.channel ?? attempt.label)
        log.info('browser', `Launched ${this.engine}`)
        return browser
      } catch (err) {
        errors.push(`${attempt.label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
    throw new Error(
      `Could not launch a local browser. Install Microsoft Edge or Google Chrome, or install Playwright browsers with "npx playwright install chromium".\n${errors.join('\n')}`
    )
  }

  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return this.page
    if (this.opening) return this.opening
    this.opening = (async () => {
      this.lastError = ''
      try {
        this.browser = await this.launch()
        this.context = await this.browser.newContext({
          viewport: null,
          acceptDownloads: false
        })
        this.page = await this.context.newPage()
        this.page.setDefaultTimeout(12000)
        this.page.on('crash', () => {
          this.lastError = 'The browser tab crashed.'
        })
        return this.page
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        await this.close().catch(() => undefined)
        throw err
      } finally {
        this.opening = null
      }
    })()
    return this.opening
  }

  async open(url: string): Promise<Page> {
    const page = await this.ensurePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    return page
  }

  async close() {
    try {
      await this.context?.close()
    } catch {
      // ignore
    }
    try {
      await this.browser?.close()
    } catch {
      // ignore
    }
    this.context = null
    this.browser = null
    this.page = null
    this.engine = ''
  }

  async screenshot(dir?: string): Promise<{ path: string; dataUrl?: string }> {
    const page = await this.ensurePage()
    const targetDir = dir ?? path.join(getPaths().browserDir, 'screenshots')
    fs.mkdirSync(targetDir, { recursive: true })
    const file = path.join(targetDir, `page-${Date.now()}.png`)
    const buffer = await page.screenshot({ fullPage: false })
    fs.writeFileSync(file, buffer)
    return {
      path: file,
      dataUrl: buffer.length < 8_000_000 ? `data:image/png;base64,${buffer.toString('base64')}` : undefined
    }
  }

  async snapshot(maxChars = 14000): Promise<string> {
    const page = await this.ensurePage()
    let text = ''
    try {
      const aria = await page.locator('body').ariaSnapshot({ timeout: 5000 })
      text = aria
    } catch {
      text = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')
    }
    const title = await page.title().catch(() => '')
    const url = page.url()
    return `URL: ${url}\nTitle: ${title}\n\n${text.slice(0, maxChars)}${
      text.length > maxChars ? `\n\n[snapshot truncated: ${text.length - maxChars} more characters]` : ''
    }`
  }
}

export const browserManager = new BrowserManager()
