/**
 * Local-only mode acceptance test.
 *
 * Adds a deliberately remote OpenAI-compatible endpoint, enables local-only mode,
 * and verifies that: provider discovery/pings do not contact it, `startProvider`
 * refuses it, web/browser tools disappear, and an agent run is stopped with a
 * clear local-only error instead of silently sending data to the endpoint.
 *
 * Usage: npm run build && node scripts/localonly-acceptance.mjs
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

let app
let page
const errors = []
const log = (message) => console.log(`[localonly] ${message}`)

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

  const setup = await page.evaluate(async () => {
    const api = window.localpilot
    await api.settings.update({ privacy: { localOnly: false } })
    const providers = await api.models.addEndpoint({
      name: 'Acceptance Remote',
      baseUrl: 'https://example.com/v1',
      type: 'openai'
    })
    const remote = providers.find((p) => p.name === 'Acceptance Remote')
    if (!remote) throw new Error('Could not add the remote acceptance endpoint.')
    await api.settings.update({ privacy: { localOnly: true } })
    const statuses = await api.models.providers()
    const remoteStatus = statuses.find((p) => p.id === remote.id)
    const started = await api.models.startProvider(remote.id)
    const tools = await api.tools.list()
    const conversation = await api.chat.create({
      title: 'Local-only acceptance',
      providerId: remote.id,
      modelId: 'gpt-4o-mini'
    })
    return {
      remoteId: remote.id,
      remoteStatus,
      started,
      webTools: tools
        .filter((t) => ['web.fetch', 'web.search', 'browser.open'].includes(t.name))
        .map((t) => t.name),
      conversationId: conversation.id
    }
  })
  console.log(JSON.stringify(setup, null, 2))

  if (!setup.remoteStatus?.error?.toLowerCase().includes('local-only')) {
    throw new Error(`Remote provider was not flagged during discovery: ${JSON.stringify(setup.remoteStatus)}`)
  }
  if (!setup.started?.error?.toLowerCase().includes('local-only')) {
    throw new Error(`startProvider did not refuse the remote endpoint: ${JSON.stringify(setup.started)}`)
  }
  if (setup.webTools.length) throw new Error(`Internet tools remained enabled in local-only mode: ${setup.webTools.join(', ')}`)

  const run = await page.evaluate(
    async ({ conversationId, remoteId }) => {
      const api = window.localpilot
      const events = []
      const off = api.chat.onEvent((event) => events.push(event))
      await api.chat.send({
        conversationId,
        text: 'This request must never leave the machine.',
        providerId: remoteId,
        modelId: 'gpt-4o-mini',
        reasoningEffort: 'none'
      })
      const startedAt = Date.now()
      while (Date.now() - startedAt < 20000) {
        if (events.some((e) => e.type === 'run_end')) break
        await new Promise((r) => setTimeout(r, 200))
      }
      off()
      return {
        events: events.map((e) => ({
          type: e.type,
          reason: e.reason,
          error: e.error,
          message: e.message,
          level: e.level
        })),
        activeRuns: await api.chat.activeRuns()
      }
    },
    { conversationId: setup.conversationId, remoteId: setup.remoteId }
  )
  console.log(JSON.stringify(run, null, 2))

  const end = run.events.find((e) => e.type === 'run_end')
  const blockedMessage = [
    end?.error,
    ...run.events.filter((e) => e.type === 'notice').map((e) => e.message)
  ]
    .filter(Boolean)
    .join('\n')
  if (!/local-only/i.test(blockedMessage)) {
    throw new Error(`Agent run was not blocked with a local-only error: ${blockedMessage || 'no diagnostics emitted'}`)
  }
  if (run.activeRuns.length) throw new Error('Local-only blocked run remained active.')

  await page.evaluate(
    async ({ conversationId, remoteId }) => {
      const api = window.localpilot
      await api.settings.update({ privacy: { localOnly: false } })
      await api.models.removeEndpoint(remoteId)
      await api.chat.remove(conversationId)
    },
    { conversationId: setup.conversationId, remoteId: setup.remoteId }
  )

  if (errors.length) throw new Error(errors.join('\n'))
  log('PASS: remote endpoint blocked; web tools revoked; nothing sent')
}

main()
  .catch((err) => {
    console.error('[localonly] FAIL:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) await app.close().catch(() => undefined)
  })
