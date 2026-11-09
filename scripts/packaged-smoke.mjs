/**
 * Packaged build smoke test.
 *
 * Launches the unpacked production app from release/win-unpacked, verifies it is
 * genuinely packaged, that SQLite and the tool registry initialised, and that the
 * renderer mounted. This does not replace installing the NSIS package.
 *
 * Usage: npm run dist:dir && node scripts/packaged-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const exe = path.join(process.cwd(), 'release', 'win-unpacked', 'LocalPilot AI.exe')
const artifacts = path.join(process.cwd(), 'artifacts')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version
fs.mkdirSync(artifacts, { recursive: true })

let app
const errors = []
const log = (message) => console.log(`[packaged] ${message}`)

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`Packaged executable not found at ${exe}. Run npm run dist first.`)
  log(`launching ${exe}`)
  app = await electron.launch({ executablePath: exe, timeout: 60000 })
  const page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  await page.waitForSelector('.app', { timeout: 60000 })
  await page.waitForTimeout(1200)
  const info = await page.evaluate(async () => {
    const api = window.localpilot
    const [appInfo, tools, settings] = await Promise.all([api.app.info(), api.tools.list(), api.settings.get()])
    return {
      appInfo,
      tools: tools.length,
      theme: settings.general.theme,
      onboardingComplete: settings.general.onboardingComplete
    }
  })
  console.log(JSON.stringify(info, null, 2))
  if (!info.appInfo.isPackaged) throw new Error('Packaged executable reported isPackaged=false.')
  if (info.appInfo.version !== expectedVersion) throw new Error(`Unexpected packaged version: ${info.appInfo.version}`)
  if (!info.appInfo.toolsCount || !info.tools) throw new Error('Tool registry is empty in the packaged app.')
  if (!info.appInfo.dbBytes) throw new Error('SQLite database was not created in the packaged app.')

  const overlayState = await page.evaluate(() => window.localpilot.computer.testMode('start'))
  await page.waitForTimeout(800)
  const overlayWindows = []
  for (const candidate of app.windows()) {
    if (candidate === page) continue
    const title = await candidate.title().catch(() => '')
    if (/AI Test Overlay/i.test(title)) overlayWindows.push(title)
  }
  if (!overlayState.active) throw new Error('The packaged app could not start the AI test overlay.')
  if (!overlayWindows.length) throw new Error('The packaged overlay window is missing (preload path may be wrong).')
  await page.evaluate(() => window.localpilot.computer.testMode('stop'))
  log(`AI test overlay started and stopped in the packaged app (${overlayWindows.length} overlay window).`)

  await page.screenshot({ path: path.join(artifacts, 'packaged-home.png') })
  if (errors.length) throw new Error(errors.join('\n'))
  log(`PASS: packaged app ${info.appInfo.version}, ${info.tools} tools, database ${info.appInfo.dbBytes} bytes`)
}

main()
  .catch((err) => {
    console.error('[packaged] FAIL:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) await app.close().catch(() => undefined)
  })
