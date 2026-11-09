/**
 * Real Electron UI smoke test.
 *
 * Launches the built app with Playwright's Electron driver, completes onboarding,
 * selects the discovered local model, sends a prompt through the real composer and
 * verifies the persisted conversation was produced by the local provider.
 *
 * Usage: npm run build && node scripts/ui-smoke.mjs
 * Set SMOKE_TOOLS=1 to additionally exercise an agent tool workflow.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const artifacts = path.join(process.cwd(), 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })

const errors = []
let app
let page

function logStep(message) {
  console.log(`[ui-smoke] ${message}`)
}

async function saveShot(name) {
  const target = path.join(artifacts, name)
  await page.screenshot({ path: target })
  logStep(`screenshot: ${target}`)
}

async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 60000
  })
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    if (/error|exception|failed/i.test(text)) console.log(`[main-stderr] ${text.trim().slice(0, 600)}`)
  })
  page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  await page.waitForSelector('.app', { timeout: 60000 })
}

async function dismissOnboarding() {
  const skip = page.getByRole('button', { name: 'Skip setup' })
  if (await skip.isVisible().catch(() => false)) {
    logStep('first run: skipping onboarding wizard')
    await skip.click()
    await page.waitForSelector('.overlay', { state: 'detached', timeout: 15000 })
  }
}

async function main() {
  logStep(`launching ${electronPath}`)
  await launch()
  await dismissOnboarding()
  await page.waitForTimeout(800)
  await saveShot('ui-home.png')

  const info = await page.evaluate(async () => {
    const api = window.localpilot
    const [appInfo, models, providers] = await Promise.all([
      api.app.info(),
      api.models.discover(false),
      api.models.providers()
    ])
    return {
      appInfo,
      models: models.map((m) => ({
        name: m.name,
        providerId: m.providerId,
        tools: m.capabilities.tools,
        vision: m.capabilities.vision
      })),
      providers: providers.map((p) => ({ id: p.id, running: p.running, models: p.modelCount }))
    }
  })
  logStep(`app ${info.appInfo.version}; providers: ${info.providers.map((p) => `${p.id}:${p.running ? 'online' : 'offline'}`).join(', ')}`)
  logStep(`models: ${info.models.map((m) => `${m.name}${m.tools ? ' [tools]' : ''}`).join(', ') || 'none'}`)
  if (!info.models.length) throw new Error('No local models were discovered.')

  const modelValue = await page.locator('.chat-toolbar select').first().inputValue()
  if (!modelValue) throw new Error('Model selector is empty.')
  logStep(`model selector: ${modelValue}`)

  const reasoning = page.locator('.chat-toolbar select').nth(1)
  if (await reasoning.isVisible().catch(() => false)) await reasoning.selectOption('none')

  await page.locator('.composer textarea').fill('Reply with exactly: UI_READY')
  await page.locator('.send-btn').click()
  logStep('prompt sent; waiting for the local model (cold load can take a while)…')

  await page.waitForFunction(
    () =>
      !document.querySelector('.live-status') &&
      (document.querySelectorAll('.message.assistant').length > 0 ||
        document.querySelectorAll('.toast.error').length > 0),
    undefined,
    { timeout: 300000 }
  )
  await page.waitForTimeout(500)
  await saveShot('ui-chat.png')

  const result = await page.evaluate(async () => {
    const api = window.localpilot
    const conversations = await api.chat.list()
    const latest = conversations[0] ? await api.chat.get(conversations[0].id) : null
    return {
      assistantText: [...document.querySelectorAll('.message.assistant .msg-assistant-body')]
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .join('\n'),
      toast: document.querySelector('.toast.error')?.textContent ?? null,
      latest: latest
        ? {
            title: latest.title,
            providerId: latest.providerId,
            modelId: latest.modelId,
            messages: latest.messages.map((m) => ({ role: m.role, content: m.content.slice(0, 300) }))
          }
        : null,
      toolCount: (await api.tools.list()).length
    }
  })

  console.log(JSON.stringify(result, null, 2))
  if (result.toast) throw new Error(`UI error toast: ${result.toast}`)
  if (!result.latest) throw new Error('No conversation was persisted.')
  if (result.latest.providerId !== 'ollama') {
    throw new Error(`Expected local Ollama provider, got ${result.latest.providerId}`)
  }
  if (!result.assistantText) throw new Error('No assistant reply was rendered.')
  logStep(`local reply verified through SQLite: ${JSON.stringify(result.latest.messages.at(-1)?.content.slice(0, 120))}`)

  if (process.env.SMOKE_TOOLS === '1') {
    await runToolWorkflow()
  }

  if (process.env.SMOKE_PERSIST === '1') {
    logStep('restarting the app to verify persistence')
    await app.close()
    await launch()
    await page.waitForSelector('.app', { timeout: 30000 })
    const persisted = await page.evaluate(async () => {
      const api = window.localpilot
      const [settings, conversations, projects] = await Promise.all([
        api.settings.get(),
        api.chat.list(),
        api.projects.list()
      ])
      return {
        theme: settings.general.theme,
        onboardingComplete: settings.general.onboardingComplete,
        defaultProviderId: settings.models.defaultProviderId,
        defaultModelId: settings.models.defaultModelId,
        conversations: conversations.length,
        projects: projects.length
      }
    })
    logStep(`persisted: ${JSON.stringify(persisted)}`)
    if (!persisted.onboardingComplete) throw new Error('Onboarding completion did not persist.')
    if (persisted.conversations < 1) throw new Error('Conversations did not persist across restart.')
  }

  if (errors.length) {
    console.error('Renderer errors:\n' + errors.join('\n'))
    throw new Error(`${errors.length} renderer error(s) captured`)
  }
  logStep('PASS')
}

async function runToolWorkflow() {
  logStep('creating a scoped project through the real IPC API')
  const projectDir = path.join(artifacts, `smoke-project-${Date.now()}`)
  fs.mkdirSync(projectDir, { recursive: true })
  const project = await page.evaluate(async (dir) => {
    const api = window.localpilot
    const created = await api.projects.create({
      name: 'UI tool smoke',
      path: dir,
      instructions: 'This is an automated smoke-test project.'
    })
    await api.projects.setActive(created.id)
    return created
  }, projectDir)
  await page.reload()
  await page.waitForSelector('.app', { timeout: 30000 })
  await page.waitForTimeout(1200)

  const approvalLoop = (async () => {
    while (!page.isClosed()) {
      const allow = page.getByRole('button', { name: 'Allow for session' })
      if (await allow.isVisible().catch(() => false)) {
        logStep('approving a tool permission')
        await allow.click().catch(() => undefined)
      }
      await page.waitForTimeout(400).catch(() => undefined)
    }
  })()
  void approvalLoop

  await page.locator('.composer textarea').fill(
    'Use the files.write tool to create smoke.txt in the active project with exactly UI_TOOL_OK, then use files.read to read it back. You must use both tools before answering.'
  )
  await page.locator('.send-btn').click()
  await page.waitForFunction(
    () => !document.querySelector('.live-status') && document.querySelectorAll('.message.assistant').length > 0,
    undefined,
    { timeout: 300000 }
  )
  await page.waitForTimeout(800)
  await saveShot('ui-tools.png')
  const toolCards = await page.locator('.tool-card').count()
  const response = await page.locator('.message.assistant .msg-assistant-body').last().textContent()
  const file = path.join(projectDir, 'smoke.txt')
  const exists = fs.existsSync(file)
  const content = exists ? fs.readFileSync(file, 'utf8') : ''
  logStep(`tool cards: ${toolCards}; file exists: ${exists}; content: ${JSON.stringify(content)}`)
  console.log(JSON.stringify({ project, toolCards, response: response?.slice(0, 600), exists, content }, null, 2))
  if (!exists || !content.includes('UI_TOOL_OK')) {
    throw new Error('The agent did not create the requested project file through tools.')
  }
  await page.evaluate(async (id) => {
    await window.localpilot.projects.remove(id)
  }, project.id)
  fs.rmSync(projectDir, { recursive: true, force: true })
}

main()
  .catch(async (err) => {
    console.error('[ui-smoke] FAIL:', err instanceof Error ? err.message : String(err))
    if (page) {
      await saveShot('ui-failure.png').catch(() => undefined)
      console.error('[ui-smoke] last body text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 3000))
    }
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) await app.close().catch(() => undefined)
  })
