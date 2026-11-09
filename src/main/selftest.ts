import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SelfTestCheck, SelfTestReport } from '@shared/types'
import { appVersion, getPaths } from './core/paths'
import { databaseSize, get } from './db'
import { settings } from './settings'
import { detectHardware } from './hardware'
import { providers } from './providers/manager'
import { toolRegistry } from './tools'
import { filesTools } from './tools/files'
import { captureScreen } from './computer'
import { runPowerShell } from './core/proc'
import { resolveProjectPath } from './tools/fsutil'
import { log } from './core/logger'

const PS_OK = 'LOCALPILOT_PS_OK'

interface Options {
  fullChat?: boolean
  screenshot?: boolean
}

async function check(
  checks: SelfTestCheck[],
  name: string,
  fn: () => Promise<{ detail: string; status?: 'pass' | 'fail' | 'skip' }>
) {
  const started = Date.now()
  try {
    const result = await fn()
    checks.push({
      name,
      status: result.status ?? 'pass',
      detail: result.detail,
      durationMs: Date.now() - started
    })
  } catch (err) {
    checks.push({
      name,
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started
    })
  }
}

export async function runSelfTest(options: Options = {}): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = []
  const startedAt = new Date().toISOString()
  const paths = getPaths()

  await check(checks, 'SQLite database accessible', async () => {
    const row = get<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')
    const fileExists = fs.existsSync(paths.dbFile)
    if (!fileExists) throw new Error(`Database file not found at ${paths.dbFile}`)
    return {
      detail: `DB at ${paths.dbFile}, ${databaseSize()} bytes, ${row?.count ?? 0} conversations, ${settings.get().models.providers.length} providers configured.`
    }
  })

  await check(checks, 'Hardware detection', async () => {
    const hw = await detectHardware(true)
    if (!hw.cpu.model || hw.cpu.model === 'Unknown CPU') throw new Error('CPU could not be detected.')
    return {
      detail: `${hw.cpu.model}; ${(hw.ram.totalBytes / 1024 ** 3).toFixed(1)} GB RAM; ${hw.gpus.map((g) => g.name).join(', ') || 'no GPU'}; ${hw.recommendations.summary}`
    }
  })

  await check(checks, 'Local provider discovery', async () => {
    const statuses = await providers.getStatuses(true)
    const ollama = statuses.find((s) => s.id === 'ollama')
    if (!ollama) throw new Error('Ollama provider is not configured.')
    if (!ollama.running) {
      throw new Error(
        `Ollama is not reachable at its configured address (${ollama.baseUrl}). ${ollama.error ?? 'Start Ollama and retry.'}`
      )
    }
    return {
      detail: statuses
        .map(
          (s) =>
            `${s.name}: ${s.running ? `running, ${s.modelCount ?? 0} models${s.version ? `, v${s.version}` : ''}` : `offline${s.error ? ` (${s.error.slice(0, 120)})` : ''}`}`
        )
        .join(' · ')
    }
  })

  let availableModels: Awaited<ReturnType<typeof providers.listModels>> = []
  await check(checks, 'Installed local models discovered', async () => {
    availableModels = await providers.listModels(true)
    if (!availableModels.length) throw new Error('No local models were discovered. Pull a model in Ollama or add a provider.')
    const sample = availableModels
      .slice(0, 5)
      .map((m) => `${m.name} (${m.capabilities.tools ? 'tools' : 'no tools'}, ${m.capabilities.vision ? 'vision' : 'no vision'})`)
      .join('; ')
    return { detail: `${availableModels.length} model(s): ${sample}${availableModels.length > 5 ? '…' : ''}` }
  })

  await check(checks, 'Local inference round-trip', async () => {
    if (!options.fullChat) {
      return { status: 'skip', detail: 'Chat round-trip skipped for this run.' }
    }
    const ollamaModel = availableModels.find((m) => m.providerId === 'ollama' && m.kind === 'chat')
    if (!ollamaModel) {
      return { status: 'skip', detail: 'No Ollama chat model available for a real inference test.' }
    }
    const provider = providers.get('ollama')
    if (!provider) throw new Error('Ollama provider could not be constructed.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      const result = await provider.chat({
        model: ollamaModel.id,
        modelInfo: ollamaModel,
        messages: [
          { role: 'system', content: 'You are a diagnostics probe. Follow the instruction exactly.' },
          { role: 'user', content: 'Reply with exactly: READY' }
        ],
        temperature: 0,
        topP: 0.9,
        maxTokens: 512,
        contextLength: 4096,
        reasoningEffort: 'none',
        stream: true,
        signal: controller.signal
      })
      const text = result.text.trim()
      if (!text) {
        return {
          status: 'fail',
          detail: `Model ${ollamaModel.id} produced no final text (reasoning chars: ${result.reasoning?.length ?? 0}). The model may be a thinking model that needs a larger token budget.`
        }
      }
      return {
        detail: `Model ${ollamaModel.id} responded locally: "${text.replace(/\s+/g, ' ').slice(0, 160)}"${
          result.usage?.outputTokens ? ` (${result.usage.outputTokens} output tokens)` : ''
        }`
      }
    } finally {
      clearTimeout(timer)
    }
  })

  await check(checks, 'Tool registry', async () => {
    const tools = toolRegistry.list()
    if (!tools.length) throw new Error('No tools are enabled.')
    const names = tools.map((t) => t.name)
    const required = ['files.read', 'files.write', 'terminal.run', 'screen.screenshot', 'browser.open', 'git.status', 'web.fetch']
    const missing = required.filter((r) => !names.includes(r))
    if (missing.length) throw new Error(`Required built-in tools missing: ${missing.join(', ')}`)
    return { detail: `${tools.length} enabled tools across ${new Set(tools.map((t) => t.group)).size} groups.` }
  })

  await check(checks, 'File path access guard', async () => {
    const projectDir = path.join(paths.userData, 'selftest', 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const ctx = {
      runId: 'selftest',
      conversationId: 'selftest',
      providerId: 'ollama',
      modelId: 'selftest',
      projectId: 'selftest',
      projectName: 'Self-test project',
      projectPath: projectDir,
      signal: new AbortController().signal,
      log: () => undefined
    }
    const writeTool = filesTools.find((t) => t.name === 'files.write')!
    const readTool = filesTools.find((t) => t.name === 'files.read')!
    const marker = `SELFTEST_${Date.now()}`
    const originalFullAccess = settings.get().computer.fullAccess
    try {
      const write = await writeTool.handler({ path: 'notes/probe.txt', content: `LocalPilot self-test ${marker}\n` }, ctx)
      if (!write.ok) throw new Error(write.content)
      const read = await readTool.handler({ path: 'notes/probe.txt' }, ctx)
      if (!read.content.includes(marker)) throw new Error('Written file could not be read back with the expected contents.')

      settings.update({ computer: { fullAccess: false } })
      let escaped = false
      try {
        resolveProjectPath('../../outside.txt', ctx)
        escaped = true
      } catch {
        escaped = false
      }
      if (escaped) throw new Error('Project path guard failed to block a traversal attempt with Full PC access off.')

      settings.update({ computer: { fullAccess: true } })
      const absoluteProbe = path.join(paths.userData, 'selftest', 'absolute-probe.txt')
      const resolved = resolveProjectPath(absoluteProbe, ctx)
      if (resolved !== path.resolve(absoluteProbe)) {
        throw new Error('Full PC access did not allow an absolute path outside the active project.')
      }
      return {
        detail: `Wrote and read ${path.join(projectDir, 'notes', 'probe.txt')}; traversal guard blocked with Full PC access off and absolute paths allowed with it on.`
      }
    } finally {
      settings.update({ computer: { fullAccess: originalFullAccess } })
    }
  })

  await check(checks, 'PowerShell execution', async () => {
    const res = await runPowerShell(`Write-Output "${PS_OK}"`, { timeoutMs: 15000 })
    if (!res.stdout.includes(PS_OK)) {
      throw new Error(`PowerShell did not return the expected marker. stderr: ${res.stderr.slice(0, 300)}`)
    }
    return { detail: `PowerShell ${PS_OK} in ${res.durationMs}ms.` }
  })

  await check(checks, 'Desktop screenshot capture', async () => {
    if (options.screenshot === false) return { status: 'skip', detail: 'Screenshot check disabled.' }
    const shot = await captureScreen()
    const exists = fs.existsSync(shot.path)
    if (!exists) throw new Error('Screenshot file was not created.')
    return {
      detail: `Captured ${shot.width ?? '?'}×${shot.height ?? '?'} px to ${shot.path} (${shot.bytes ?? 0} bytes).`
    }
  })

  await check(checks, 'Playwright browser automation', async () => {
    const edge = [
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].find((p) => p && fs.existsSync(p))
    if (!edge) return { status: 'skip', detail: 'Microsoft Edge was not found; Playwright browser launch was not tested.' }
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 30000 })
    try {
      const page = await browser.newPage()
      await page.setContent('<html><title>LocalPilot Browser Test</title><body><h1>ok</h1></body></html>')
      const title = await page.title()
      if (title !== 'LocalPilot Browser Test') throw new Error(`Unexpected page title: ${title}`)
      return { detail: `Launched Microsoft Edge headlessly via Playwright and read the page title "${title}".` }
    } finally {
      await browser.close()
    }
  })

  await check(checks, 'MCP SDK available', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const client = new Client({ name: 'selftest', version: '0.1.0' })
    if (!client) throw new Error('MCP client could not be created.')
    return { detail: 'Official @modelcontextprotocol/sdk client loaded successfully.' }
  })

  await check(checks, 'Local-only inference prerequisites', async () => {
    const s = settings.get()
    const hasCloudKeyRequirement = s.models.providers.some((p) => p.id !== 'ollama' && p.id !== 'lmstudio' && p.id !== 'llamacpp')
    return {
      detail: hasCloudKeyRequirement
        ? 'Custom endpoints exist, but the default configuration uses only local providers and requires no API key.'
        : `No cloud provider or API key is required. Local-only mode is ${s.privacy.localOnly ? 'enabled' : 'available in Privacy settings'}.`
    }
  })

  const finishedAt = new Date().toISOString()
  const report: SelfTestReport = {
    startedAt,
    finishedAt,
    appVersion: appVersion(),
    checks,
    environment: {
      platform: process.platform,
      release: process.getSystemVersion?.() ?? '',
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      userData: paths.userData
    }
  }
  try {
    fs.writeFileSync(path.join(paths.dataDir, 'selftest-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (err) {
    log.warn('selftest', 'Could not write report file', String(err))
  }
  log.info('selftest', `Completed: ${checks.filter((c) => c.status === 'pass').length} pass, ${checks.filter((c) => c.status === 'fail').length} fail, ${checks.filter((c) => c.status === 'skip').length} skip`)
  return report
}
