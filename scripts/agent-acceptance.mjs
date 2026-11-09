/**
 * Extra acceptance checks against the real app and real local model.
 *
 *  - browser automation through the agent (browser.open/snapshot/screenshot)
 *  - cancel a running agent while a PowerShell command is active
 *  - MCP server installation, connection, tool discovery and removal
 *  - plugin disabling revokes its tools from the registry immediately
 *
 * Usage: npm run build && node scripts/agent-acceptance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const artifacts = path.join(process.cwd(), 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })

let app
let page
const errors = []
let approving = true

const log = (message) => console.log(`[acceptance] ${message}`)

async function launch() {
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
  await page.waitForTimeout(700)
  const reasoning = page.locator('.chat-toolbar select').nth(1)
  if (await reasoning.isVisible().catch(() => false)) await reasoning.selectOption('none')
}

function startApprovalLoop() {
  approving = true
  void (async () => {
    while (approving && !page.isClosed()) {
      const allow = page.getByRole('button', { name: 'Allow for session' })
      if (await allow.isVisible().catch(() => false)) {
        log('approving tool permission')
        await allow.click().catch(() => undefined)
      }
      await page.waitForTimeout(350).catch(() => undefined)
    }
  })()
}

async function newConversation() {
  await page.getByRole('button', { name: /New conversation/ }).first().click()
  await page.waitForTimeout(400)
}

async function sendPrompt(prompt) {
  const before = await page.locator('.message.assistant').count()
  await page.locator('.composer textarea').fill(prompt)
  await page.locator('.send-btn').click()
  await page.waitForSelector('.stop-btn', { timeout: 30000 })
  await page.waitForFunction(
    (count) =>
      !document.querySelector('.live-status') &&
      (document.querySelectorAll('.message.assistant').length > count ||
        document.querySelectorAll('.toast.error').length > 0),
    before,
    { timeout: 300000 }
  )
  await page.waitForTimeout(500)
  return page.evaluate(() => ({
    tools: [...document.querySelectorAll('.message.assistant .tool-name')].map((el) => el.textContent),
    text: [...document.querySelectorAll('.message.assistant .msg-assistant-body')]
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .join('\n'),
    toast: document.querySelector('.toast.error')?.textContent ?? null,
    statuses: [...document.querySelectorAll('.tool-card .status-chip')].map((el) => el.textContent)
  }))
}

async function browserStage() {
  log('stage: browser automation through the agent')
  await newConversation()
  startApprovalLoop()
  const result = await sendPrompt(
    'Use browser.open to open https://example.com, then browser.snapshot and browser.screenshot. Verify the page title and heading. You must use the browser tools; do not answer without them.'
  )
  await page.screenshot({ path: path.join(artifacts, 'ui-browser.png') })
  console.log(JSON.stringify(result, null, 2))
  if (result.toast) throw new Error(result.toast)
  for (const required of ['browser.open', 'browser.snapshot', 'browser.screenshot']) {
    if (!result.tools.includes(required)) throw new Error(`Agent did not call ${required}. Tools: ${result.tools.join(', ')}`)
  }
  if (!/example domain/i.test(result.text)) throw new Error(`Agent did not verify the page: ${result.text}`)
  await page.evaluate(() => window.localpilot.browser.close())
  log('browser automation PASS')
}

async function stopStage() {
  log('stage: cancel a running agent during a PowerShell command')
  await newConversation()
  startApprovalLoop()
  await page.locator('.composer textarea').fill(
    'Use terminal.run with the exact command Start-Sleep -Seconds 120; Write-Output STOP_TEST_DONE and wait for it to finish. Do not use any other tool.'
  )
  await page.locator('.send-btn').click()
  await page.waitForSelector('.tool-card.running', { timeout: 180000 })
  const stop = page.locator('.stop-btn')
  if (!(await stop.isVisible().catch(() => false))) throw new Error('Stop button is not visible while the agent runs.')
  log('agent is inside terminal.run; pressing Stop')
  await stop.click()
  await page.waitForFunction(() => !document.querySelector('.live-status'), undefined, { timeout: 30000 })
  await page.waitForTimeout(1500)
  const active = await page.evaluate(() => window.localpilot.chat.activeRuns())
  if (active.length) throw new Error(`Agent remained active after Stop: ${JSON.stringify(active)}`)
  const statuses = await page.locator('.tool-card .status-chip').allTextContents()
  log(`tool statuses after stop: ${statuses.join(', ')}`)
  await page.screenshot({ path: path.join(artifacts, 'ui-stopped.png') })
  log('agent stop PASS')
}

async function mcpStage() {
  log('stage: MCP installation, tool discovery and removal')
  const serverPath = path.join(process.cwd(), 'examples', 'mcp-echo-server.mjs')
  const result = await page.evaluate(async (scriptPath) => {
    const api = window.localpilot
    const plugin = await api.plugins.addMcpServer({
      name: 'LocalPilot Echo Acceptance',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      env: {},
      enabled: true,
      autoStart: false
    })
    await api.plugins.startMcp(plugin.id)
    const test = await api.plugins.testMcp(plugin.id)
    const tools = await api.tools.list()
    const discovered = tools.filter((t) => t.name.startsWith(`mcp__${plugin.id}__`)).map((t) => t.name)
    await api.plugins.uninstall(plugin.id)
    const remaining = (await api.plugins.mcpServers()).some((s) => s.id === plugin.id)
    return { id: plugin.id, test, discovered, remaining }
  }, serverPath)
  console.log(JSON.stringify(result, null, 2))
  if (!result.test.ok || result.test.tools < 1) throw new Error(`MCP test failed: ${result.test.error ?? 'no tools'}`)
  if (!result.discovered.some((name) => name.endsWith('__echo'))) throw new Error('MCP tool was not registered.')
  if (result.remaining) throw new Error('MCP server was not removed.')
  log('MCP PASS')
}

async function pluginRevocationStage() {
  log('stage: disabling a built-in plugin revokes its tools')
  const result = await page.evaluate(async () => {
    const api = window.localpilot
    const before = await api.tools.list()
    await api.plugins.setEnabled('computer-use', false)
    const disabled = await api.tools.list()
    await api.plugins.setEnabled('computer-use', true)
    const restored = await api.tools.list()
    return {
      before: before.some((t) => t.name === 'screen.screenshot'),
      disabled: disabled.some((t) => t.name === 'screen.screenshot'),
      restored: restored.some((t) => t.name === 'screen.screenshot'),
      beforeCount: before.length,
      disabledCount: disabled.length,
      restoredCount: restored.length
    }
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.before || !result.restored) throw new Error('Computer Use tools were not present before/after the test.')
  if (result.disabled) throw new Error('screen.screenshot remained available while its plugin was disabled.')
  log('plugin revocation PASS')
}

async function main() {
  log('launching app')
  await launch()
  await browserStage()
  await stopStage()
  await mcpStage()
  await pluginRevocationStage()
  if (errors.length) {
    console.error(errors.join('\n'))
    throw new Error(`${errors.length} renderer errors captured`)
  }
  log('ALL PASS')
}

main()
  .catch(async (err) => {
    console.error('[acceptance] FAIL:', err instanceof Error ? err.message : String(err))
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'acceptance-failure.png') }).catch(() => undefined)
      console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 3000))
    }
    process.exitCode = 1
  })
  .finally(async () => {
    approving = false
    if (app) await app.close().catch(() => undefined)
  })
