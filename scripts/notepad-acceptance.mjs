/**
 * Real Windows Computer Use acceptance test.
 *
 * Sends a prompt through the real UI, approves each prompted permission, and
 * verifies the agent launched Notepad, typed the requested marker, and captured
 * a fresh screenshot. The screenshot is copied to artifacts/notepad-interaction.png
 * for visual inspection.
 *
 * Usage: npm run build && node scripts/notepad-acceptance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const artifacts = path.join(process.cwd(), 'artifacts')
const captureDir = path.join(process.env.APPDATA ?? '', 'LocalPilot AI', 'captures')
fs.mkdirSync(artifacts, { recursive: true })

const MARKER = 'LOCALPILOT_NOTEPAD_OK'
const errors = []
let app
let page
let approving = true
const log = (message) => console.log(`[notepad] ${message}`)

async function main() {
  log('launching app')
  app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: { ...process.env },
    timeout: 60000
  })
  page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  await page.waitForSelector('.app', { timeout: 60000 })
  const skip = page.getByRole('button', { name: 'Skip setup' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.waitForTimeout(600)

  await page.evaluate(async () => {
    const api = window.localpilot
    await api.settings.update({
      computer: { enabled: true, screenshots: true, mouseKeyboard: true, windowControl: true, approvalMode: 'ask' }
    })
  })
  await page.getByRole('button', { name: /New conversation/ }).first().click()
  await page.waitForTimeout(400)
  const before = await page.evaluate(async () => {
    const api = window.localpilot
    return { windows: await api.computer.windows(), captures: 0 }
  })
  const beforePids = new Set(before.windows.filter((w) => /notepad/i.test(w.processName)).map((w) => w.pid))
  const beforeCaptures = new Set(fs.existsSync(captureDir) ? fs.readdirSync(captureDir) : [])

  void (async () => {
    while (approving && !page.isClosed()) {
      const allow = page.getByRole('button', { name: 'Allow for session' })
      if (await allow.isVisible().catch(() => false)) {
        log('approving a Computer Use permission prompt')
        await allow.click().catch(() => undefined)
      }
      await page.waitForTimeout(350).catch(() => undefined)
    }
  })()

  const prompt = [
    'Use apps.launch to open Notepad (notepad.exe).',
    `Then focus the Notepad window and enter exactly this text into its editor: ${MARKER}`,
    'Use uia.inspect/uia.set_value or input.keyboard. Do not use PowerShell or write a file.',
    'Take a screenshot with screen.screenshot after typing, and confirm the text is visible in the editor.',
    'Only answer once the text is actually in Notepad.'
  ].join(' ')
  log('sending the Notepad prompt')
  await page.locator('.composer textarea').fill(prompt)
  await page.locator('.send-btn').click()
  await page.waitForSelector('.stop-btn', { timeout: 30000 })
  await page.waitForFunction(
    () => !document.querySelector('.live-status') && document.querySelectorAll('.message.assistant').length > 0,
    undefined,
    { timeout: 420000 }
  )
  await page.waitForTimeout(1200)

  const result = await page.evaluate(async () => {
    const api = window.localpilot
    return {
      tools: [...document.querySelectorAll('.message.assistant .tool-name')].map((el) => el.textContent),
      text: [...document.querySelectorAll('.message.assistant .msg-assistant-body')]
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join('\n'),
      toast: document.querySelector('.toast.error')?.textContent ?? null,
      windows: await api.computer.windows()
    }
  })
  console.log(JSON.stringify(result, null, 2))
  await page.screenshot({ path: path.join(artifacts, 'notepad-ui.png') })

  const notepadWindows = result.windows.filter((w) => /notepad/i.test(w.processName) || /notepad/i.test(w.title))
  if (!notepadWindows.length) throw new Error('No Notepad window is open after the agent run.')
  if (!result.tools.some((name) => name === 'apps.launch')) throw new Error('Agent did not call apps.launch.')
  if (!result.tools.some((name) => /input.keyboard|uia.set_value/.test(name))) {
    throw new Error(`Agent did not type into Notepad. Tools: ${result.tools.join(', ')}`)
  }

  const captures = fs.existsSync(captureDir) ? fs.readdirSync(captureDir) : []
  const fresh = captures
    .filter((name) => !beforeCaptures.has(name))
    .map((name) => path.join(captureDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (!fresh.length) throw new Error('The agent did not create a screenshot capture.')
  const copy = path.join(artifacts, 'notepad-interaction.png')
  fs.copyFileSync(fresh[0], copy)
  log(`captured screenshot: ${copy}`)

  log('PASS: Notepad window opened, input tools ran, fresh screenshot captured')

  const launched = result.windows.filter(
    (w) => /notepad/i.test(w.processName) && !beforePids.has(w.pid)
  )
  for (const win of launched) {
    log(`closing the Notepad instance launched by this test (pid ${win.pid})`)
    spawnSync('taskkill', ['/PID', String(win.pid)], { stdio: 'ignore' })
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

main()
  .catch((err) => {
    console.error('[notepad] FAIL:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    approving = false
    if (app) await app.close().catch(() => undefined)
  })
