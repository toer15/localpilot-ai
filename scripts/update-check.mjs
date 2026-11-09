/**
 * Packaged update-check acceptance.
 *
 * Launches the unpacked packaged app, opens Settings → About, clicks the real
 * Check for updates control and verifies the installed version is reported as
 * up to date against the public GitHub release. Run npm run dist first.
 *
 * Usage: npm run update:check
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

try {
  if (!fs.existsSync(exe)) throw new Error(`Packaged executable not found at ${exe}. Run npm run dist first.`)
  console.log(`[updates] launching ${exe}`)
  app = await electron.launch({ executablePath: exe, timeout: 60000 })
  const page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  await page.waitForSelector('.app', { timeout: 60000 })
  await page.waitForTimeout(1000)

  const before = await page.evaluate(() => window.localpilot.updates.status())
  console.log('[updates] status before:', JSON.stringify(before))

  await page.locator('.nav-item', { hasText: 'Settings' }).click()
  await page.waitForSelector('.settings-tab', { timeout: 15000 })
  await page.locator('.settings-tab', { hasText: 'About' }).click()
  const section = page.locator('.settings-section', { hasText: 'Software updates' })
  await section.waitFor({ timeout: 10000 })
  console.log('[updates] section:\n' + (await section.innerText()))

  await page.getByRole('button', { name: /Check for updates/ }).click()
  await page.waitForFunction(
    () => {
      const text = document.body.innerText
      return text.includes('Up to date') || text.includes('Update check failed')
    },
    undefined,
    { timeout: 90000 }
  )
  await page.waitForTimeout(1000)
  const after = await page.evaluate(() => window.localpilot.updates.status())
  const sectionAfter = await section.innerText()
  console.log('[updates] status after:', JSON.stringify(after))
  console.log('[updates] section after:\n' + sectionAfter)
  await page.screenshot({ path: path.join(artifacts, 'update-settings.png') })

  if (after.currentVersion !== expectedVersion) {
    throw new Error(`Update status version ${after.currentVersion} does not match package ${expectedVersion}`)
  }
  if (after.phase !== 'up-to-date') {
    throw new Error(`Expected up-to-date for the running version, got ${after.phase}: ${after.message ?? ''}`)
  }
  if (!sectionAfter.includes('Up to date')) throw new Error('Settings did not render the up-to-date result.')
  if ((await page.locator('[role="dialog"]').count()) !== 0) {
    throw new Error('An update modal appeared even though the installed version is current.')
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`[updates] PASS: packaged ${expectedVersion} is up to date against GitHub Releases`)
} catch (error) {
  console.error('[updates] FAIL:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => undefined)
}
