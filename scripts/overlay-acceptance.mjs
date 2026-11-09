/**
 * AI App & Game Tester acceptance test.
 *
 * Installs the optional marketplace pack, verifies its tools, starts the
 * click-through overlay, verifies the AI cursor does not follow the real
 * pointer and does follow an AI mouse action, takes a visual artifact, presses
 * a real Esc key through Windows SendKeys, and verifies the overlay stopped.
 *
 * Usage: npm run build && node scripts/overlay-acceptance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const artifacts = path.join(process.cwd(), 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const scale = process.env.OVERLAY_SCALE
const scaleTag = scale ? `-scale-${scale.replace(/\./g, '_')}` : ''

let app
let page
let overlay
const errors = []
const log = (message) => console.log(`[overlay] ${message}`)

async function main() {
  log('launching app')
  const launchArgs = [path.join(process.cwd(), 'out/main/index.js')]
  if (scale) launchArgs.push(`--force-device-scale-factor=${scale}`)
  app = await electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    cwd: process.cwd(),
    env: { ...process.env, LOCALPILOT_ACCEPTANCE: '1' },
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
    const catalog = await api.plugins.catalog()
    if (!catalog.some((plugin) => plugin.id === 'app-tester')) {
      throw new Error('The AI App & Game Tester pack is missing from the marketplace catalog.')
    }
    const installed = await api.plugins.install('app-tester')
    const tools = await api.tools.list()
    const state = await api.computer.testMode('start')
    return {
      installed: { id: installed.id, enabled: installed.enabled, tools: installed.tools?.map((tool) => tool.name) },
      testingTools: tools.filter((tool) => tool.name.startsWith('testing.')).map((tool) => tool.name),
      state
    }
  })
  console.log(JSON.stringify(setup, null, 2))
  if (!setup.installed.enabled) throw new Error('The tester pack did not enable after install.')
  for (const name of ['testing.start', 'testing.stop', 'testing.status']) {
    if (!setup.testingTools.includes(name)) throw new Error(`Missing plugin tool ${name}.`)
  }
  if (!setup.state.active) throw new Error('AI test overlay did not become active.')
  if (!setup.state.shortcutRegistered) throw new Error('Esc could not be registered as the stop shortcut.')

  await page.waitForTimeout(900)
  for (const candidate of app.windows()) {
    if (candidate === page) continue
    const title = await candidate.title().catch(() => '')
    if (/AI Test Overlay/i.test(title)) {
      overlay = candidate
      break
    }
  }
  if (!overlay) throw new Error('The overlay window was not created.')
  const displayInfo = await app.evaluate(({ screen, BrowserWindow }) => ({
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor
    })),
    primaryId: screen.getPrimaryDisplay().id,
    overlayWindows: BrowserWindow.getAllWindows()
      .filter((win) => /AI Test Overlay/i.test(win.getTitle()))
      .map((win) => ({
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        isVisible: win.isVisible(),
        isAlwaysOnTop: win.isAlwaysOnTop()
      }))
  }))
  console.log(JSON.stringify(displayInfo, null, 2))
  await overlay.waitForSelector('#banner', { timeout: 10000 })
  const view = await overlay.evaluate(() => ({
    text: document.body.innerText,
    border: getComputedStyle(document.getElementById('frame')).borderTopColor,
    cursorVisible: Boolean(document.getElementById('ai-cursor')),
    cursorDisplay: getComputedStyle(document.getElementById('ai-cursor')).display,
    dpr: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    stopKey: document.getElementById('stop-key')?.textContent,
    label: document.getElementById('task-label')?.textContent
  }))
  console.log(JSON.stringify({ ...view, requestedScale: scale || '1' }, null, 2))
  if (!/Press Esc to stop testing/i.test(view.text)) throw new Error('The on-screen stop instruction is missing.')
  if (!view.cursorVisible || view.cursorDisplay === 'none') throw new Error('The green AI cursor is missing.')
  if (scale && Math.abs(view.dpr - Number(scale)) > 0.02) {
    throw new Error(`Overlay devicePixelRatio ${view.dpr} did not match requested scale ${scale}.`)
  }
  if (view.stopKey !== 'Esc') throw new Error(`Unexpected stop key on overlay: ${view.stopKey}`)
  if (!/34,\s*197,\s*94/.test(view.border)) throw new Error(`The takeover border is not green: ${view.border}`)

  const beforeAi = await overlay.evaluate(() => ({
    left: parseFloat(document.getElementById('ai-cursor').style.left),
    top: parseFloat(document.getElementById('ai-cursor').style.top)
  }))
  const dpr = view.dpr || 1
  const original = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output \"$($p.X),$($p.Y)\""],
    { encoding: 'utf8', timeout: 15000 }
  )
  const [originX, originY] = (original.stdout ?? '').trim().split(',').map(Number)
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) throw new Error('Could not read the pointer position.')
  const targetX = originX > 1280 ? 900 : 1700
  const targetY = originY > 720 ? 500 : 1000
  log(`moving the real pointer to ${targetX},${targetY}; the AI cursor must not follow it`)
  const moved = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${targetX}, ${targetY})`],
    { timeout: 15000 }
  )
  if (moved.status !== 0) throw new Error('Could not move the pointer for the independence check.')
  await page.waitForTimeout(600)
  const afterUserMove = await overlay.evaluate(() => ({
    left: parseFloat(document.getElementById('ai-cursor').style.left),
    top: parseFloat(document.getElementById('ai-cursor').style.top)
  }))
  const userMoveDelta = {
    x: afterUserMove.left - beforeAi.left,
    y: afterUserMove.top - beforeAi.top
  }
  log(`AI cursor delta after the user moved the pointer: ${userMoveDelta.x.toFixed(1)},${userMoveDelta.y.toFixed(1)}`)
  if (Math.abs(userMoveDelta.x) > 2 || Math.abs(userMoveDelta.y) > 2) {
    throw new Error('The green AI cursor followed the user pointer; it must be independent.')
  }

  log('moving to the same target through the normal AI mouse-action path')
  const pointState = await page.evaluate(
    ({ x, y }) => window.localpilot.computer.testMode('move', { x, y }),
    { x: targetX, y: targetY }
  )
  if (!pointState.active) throw new Error('The overlay stopped while positioning the AI cursor.')
  await page.waitForTimeout(300)
  const afterAiPoint = await overlay.evaluate(() => ({
    left: parseFloat(document.getElementById('ai-cursor').style.left),
    top: parseFloat(document.getElementById('ai-cursor').style.top)
  }))
  const aiDelta = {
    x: afterAiPoint.left - beforeAi.left,
    y: afterAiPoint.top - beforeAi.top
  }
  if (Math.abs(aiDelta.x) < 20 && Math.abs(aiDelta.y) < 20) {
    throw new Error('The green AI cursor did not move when an AI action positioned it.')
  }
  const pointerAfterAi = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output \"$($p.X),$($p.Y)\""],
    { encoding: 'utf8', timeout: 15000 }
  )
  const [pointerAiX, pointerAiY] = (pointerAfterAi.stdout ?? '').trim().split(',').map(Number)
  if (!Number.isFinite(pointerAiX) || !Number.isFinite(pointerAiY)) throw new Error('Could not read the pointer after positioning the AI cursor.')
  if (Math.abs(pointerAiX - targetX) > 2 || Math.abs(pointerAiY - targetY) > 2) {
    throw new Error('The AI mouse action did not place the real system pointer at its target.')
  }
  const primary = displayInfo.displays.find((display) => display.id === displayInfo.primaryId)
  const expectedX = (targetX - (primary?.bounds.x ?? 0)) / dpr
  const expectedY = (targetY - (primary?.bounds.y ?? 0)) / dpr
  log(
    `AI cursor actual=${afterAiPoint.left.toFixed(1)},${afterAiPoint.top.toFixed(1)} expected=${expectedX.toFixed(1)},${expectedY.toFixed(1)} dpr=${dpr}`
  )
  if (Math.abs(afterAiPoint.left - expectedX) > 40 || Math.abs(afterAiPoint.top - expectedY) > 40) {
    throw new Error(
      `DPI AI cursor mismatch: actual ${afterAiPoint.left.toFixed(1)},${afterAiPoint.top.toFixed(1)} vs expected ${expectedX.toFixed(1)},${expectedY.toFixed(1)} at dpr ${dpr}.`
    )
  }

  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${originX}, ${originY})`],
    { timeout: 15000 }
  )
  await page.waitForTimeout(600)
  const afterReturn = await overlay.evaluate(() => ({
    left: parseFloat(document.getElementById('ai-cursor').style.left),
    top: parseFloat(document.getElementById('ai-cursor').style.top)
  }))
  if (Math.abs(afterReturn.left - afterAiPoint.left) > 2 || Math.abs(afterReturn.top - afterAiPoint.top) > 2) {
    throw new Error('The green AI cursor moved when the user pointer returned; it must stay at the AI target.')
  }
  log('AI cursor stayed at the AI target while the real pointer moved independently')

  const screenshotPath = path.join(artifacts, `ai-test-overlay${scaleTag}.png`)
  await overlay.screenshot({ path: screenshotPath })
  log(`overlay screenshot: ${screenshotPath}`)

  log('sending a real global Esc key through Windows SendKeys')
  const sent = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')"],
    { timeout: 15000 }
  )
  if (sent.status !== 0) {
    throw new Error(`Could not send Esc: ${sent.stderr?.toString() ?? `exit ${sent.status}`}`)
  }

  let stopped = false
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(200)
    const status = await page.evaluate(() => window.localpilot.computer.testMode('status'))
    if (!status.active) {
      stopped = true
      break
    }
  }
  if (!stopped) throw new Error('Esc did not stop the AI test overlay.')

  const afterStop = await page.evaluate(async () => {
    const api = window.localpilot
    await api.plugins.uninstall('app-tester')
    const [tools, plugins] = await Promise.all([api.tools.list(), api.plugins.list()])
    return {
      testingTools: tools.filter((tool) => tool.name.startsWith('testing.')).map((tool) => tool.name),
      installed: plugins.some((plugin) => plugin.id === 'app-tester'),
      overlay: await api.computer.testMode('status')
    }
  })
  console.log(JSON.stringify(afterStop, null, 2))
  if (afterStop.testingTools.length) throw new Error('Uninstalling the pack did not revoke its tools.')
  if (afterStop.installed) throw new Error('The optional pack was not removed from the installed list.')
  if (afterStop.overlay.active) throw new Error('Overlay remained active after uninstall.')

  if (errors.length) throw new Error(errors.join('\n'))
  log('PASS: marketplace install, independent AI cursor/border overlay, real Esc stop, uninstall revocation')
}

main()
  .catch((err) => {
    console.error('[overlay] FAIL:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    if (page && !page.isClosed()) {
      await page.evaluate(() => window.localpilot.computer.testMode('stop')).catch(() => undefined)
      await page.evaluate(() => window.localpilot.plugins.uninstall('app-tester')).catch(() => undefined)
    }
    if (app) await app.close().catch(() => undefined)
  })
