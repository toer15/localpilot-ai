/**
 * Full-screen game acceptance for the AI tester overlay.
 *
 * Starts LocalPilot and the overlay, hides the LocalPilot window, launches
 * Rocket League with -fullscreen, verifies the game owns the full display and
 * the overlay is topmost, then sends a real Esc and verifies both the overlay
 * stop and the game's survival.
 *
 * Usage: npm run build && node scripts/fullscreen-acceptance.mjs
 * Set ROCKET_LEAGUE_PATH to override the default installation path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const artifacts = path.join(process.cwd(), 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const gameExe =
  process.env.ROCKET_LEAGUE_PATH ?? 'C:\\Program Files\\Epic Games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe'

let lpApp
let lpPage
let gamePid
let existingGamePids = []

const log = (message) => console.log(`[fullscreen] ${message}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PS_HELPER = `
$ErrorActionPreference = "Stop"
$src = @"
using System;
using System.Runtime.InteropServices;
public class NativeWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -TypeDefinition $src
Add-Type -AssemblyName System.Windows.Forms
function Get-GameProcess {
  Get-Process RocketLeague -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
`

function ps(script, timeout = 30000) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`PowerShell failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`)
  }
  return (result.stdout ?? '').trim()
}

function gameIds() {
  const output = ps(
    '(Get-Process RocketLeague -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ","'
  )
  return output
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function gameStatus() {
  const output = ps(`${PS_HELPER}
$p = Get-GameProcess
if (-not $p) { Write-Output '{"found":false}'; exit 0 }
$rect = New-Object NativeWin+RECT
[NativeWin]::GetWindowRect($p.MainWindowHandle, [ref]$rect) | Out-Null
$foreground = [NativeWin]::GetForegroundWindow()
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[pscustomobject]@{
  found = $true
  pid = $p.Id
  hwnd = $p.MainWindowHandle.ToInt64()
  title = $p.MainWindowTitle
  left = $rect.Left
  top = $rect.Top
  width = ($rect.Right - $rect.Left)
  height = ($rect.Bottom - $rect.Top)
  visible = [NativeWin]::IsWindowVisible($p.MainWindowHandle)
  topmost = (([NativeWin]::GetWindowLong($p.MainWindowHandle, -20) -band 0x8) -ne 0)
  foreground = ($foreground -eq $p.MainWindowHandle)
  screenWidth = $screen.Width
  screenHeight = $screen.Height
} | ConvertTo-Json -Compress`)
  const lines = output.split(/\r?\n/).filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function focusGame() {
  ps(`${PS_HELPER}
$p = Get-GameProcess
if (-not $p) { Write-Output "no-game"; exit 0 }
[NativeWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[NativeWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
try {
  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($p.Id) | Out-Null
} catch {}
Write-Output "focused"
`)
}

function sendEsc() {
  ps(
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')`,
    15000
  )
}

function killNewGameProcesses() {
  const before = existingGamePids.join(',')
  try {
    ps(`${PS_HELPER}
$before = @(${before})
Get-Process RocketLeague -ErrorAction SilentlyContinue |
  Where-Object { $before -notcontains $_.Id } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output "cleanup"
`)
  } catch (err) {
    console.error('[fullscreen] Stop-Process cleanup failed:', err instanceof Error ? err.message : String(err))
  }
  let remaining = []
  try {
    remaining = gameIds().filter((id) => !existingGamePids.includes(id))
  } catch (err) {
    console.error('[fullscreen] Could not inspect remaining game processes:', err instanceof Error ? err.message : String(err))
    return
  }
  for (const id of remaining) {
    const result = spawnSync('taskkill', ['/PID', String(id), '/T', '/F'], { encoding: 'utf8', timeout: 15000 })
    log(`taskkill ${id}: exit ${result.status} ${(result.stdout || result.stderr || '').trim()}`)
  }
}

function isOverlayAboveGame(gameHwnd, overlayHwnd) {
  const output = ps(`${PS_HELPER}
$game = [IntPtr]${gameHwnd}
$target = [IntPtr]${overlayHwnd}
$current = [NativeWin]::GetWindow($game, 3)
$above = $false
$steps = 0
while ($current -ne [IntPtr]::Zero -and $steps -lt 200) {
  if ($current -eq $target) { $above = $true; break }
  $current = [NativeWin]::GetWindow($current, 3)
  $steps++
}
[pscustomobject]@{ above = $above; steps = $steps } | ConvertTo-Json -Compress`)
  const lines = output.split(/\r?\n/).filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function isFullscreenComputer(status) {
  return (
    status.found &&
    status.visible &&
    status.left <= 0 &&
    status.top <= 0 &&
    status.width >= status.screenWidth - 2 &&
    status.height >= status.screenHeight - 2
  )
}

async function waitForOverlayWindow(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let overlay = null
  while (Date.now() < deadline) {
    for (const candidate of lpApp.windows()) {
      if (candidate === lpPage) continue
      const title = await candidate.title().catch(() => '')
      if (/AI Test Overlay/i.test(title)) {
        overlay = candidate
        break
      }
    }
    if (overlay) return overlay
    await sleep(300)
  }
  return null
}

async function main() {
  if (!fs.existsSync(gameExe)) throw new Error(`Rocket League executable not found at ${gameExe}`)
  existingGamePids = gameIds()
  if (existingGamePids.length) {
    throw new Error(`Close the existing Rocket League process first (PID ${existingGamePids.join(', ')}).`)
  }

  log('launching LocalPilot and starting the overlay')
  lpApp = await electron.launch({
    executablePath: electronPath,
    args: [path.join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: { ...process.env },
    timeout: 60000
  })
  lpPage = await lpApp.firstWindow({ timeout: 60000 })
  await lpPage.waitForSelector('.app', { timeout: 60000 })
  const skip = lpPage.getByRole('button', { name: 'Skip setup' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await lpPage.waitForTimeout(500)
  const started = await lpPage.evaluate(async () => {
    const api = window.localpilot
    await api.plugins.install('app-tester')
    return api.computer.testMode('start')
  })
  if (!started.active || !started.shortcutRegistered) {
    throw new Error(`Overlay did not start with a working Esc shortcut: ${JSON.stringify(started)}`)
  }
  const overlayPage = await waitForOverlayWindow()
  if (!overlayPage) throw new Error('The overlay window was not created.')
  await overlayPage.waitForSelector('#banner', { timeout: 10000 })

  const hidden = await lpApp.evaluate(({ BrowserWindow }) => {
    const hiddenTitles = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (/AI Test Overlay/i.test(win.getTitle())) continue
      win.hide()
      hiddenTitles.push(win.getTitle())
    }
    return hiddenTitles
  })
  log(`hid LocalPilot window(s): ${hidden.join(', ') || '(none)'}`)

  log('launching Rocket League full-screen')
  const child = spawn(gameExe, ['-fullscreen'], {
    cwd: path.dirname(gameExe),
    detached: true,
    stdio: 'ignore'
  })
  gamePid = child.pid
  child.unref()

  let game = null
  let toggledFullscreen = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(1500)
    game = gameStatus()
    if (isFullscreenComputer(game)) break
    if (!toggledFullscreen && game.found && attempt >= 8) {
      log('game window is not full-screen yet; sending Alt+Enter')
      ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{ENTER}')")
      toggledFullscreen = true
    }
  }
  console.log(JSON.stringify({ game }, null, 2))
  if (!isFullscreenComputer(game)) {
    throw new Error(`Rocket League did not reach full-screen bounds: ${JSON.stringify(game)}`)
  }
  gamePid = game.pid
  if (game.topmost) log('Rocket League is topmost; verifying actual z-order instead')


  log('bringing the game to the foreground')
  focusGame()
  await sleep(800)
  game = gameStatus()
  if (!game.foreground) throw new Error(`Rocket League did not take the foreground: ${JSON.stringify(game)}`)

  const overlayInfo = await lpApp.evaluate(({ BrowserWindow, screen }) => ({
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor
    })),
    overlays: BrowserWindow.getAllWindows()
      .filter((win) => /AI Test Overlay/i.test(win.getTitle()))
      .map((win) => ({
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        isVisible: win.isVisible(),
        isFocused: win.isFocused(),
        isAlwaysOnTop: win.isAlwaysOnTop()
      }))
  }))
  console.log(JSON.stringify(overlayInfo, null, 2))
  const { displays, overlays } = overlayInfo
  if (overlays.length !== displays.length) {
    throw new Error(`Expected one overlay window per display (${displays.length}), found ${overlays.length}.`)
  }
  for (const display of displays) {
    const overlay = overlays.find(
      (candidate) =>
        candidate.bounds.x === display.bounds.x &&
        candidate.bounds.y === display.bounds.y &&
        candidate.bounds.width === display.bounds.width &&
        candidate.bounds.height === display.bounds.height
    )
    if (!overlay) throw new Error(`No overlay window matches display ${display.id}.`)
    if (!overlay.isVisible) throw new Error(`Overlay window for display ${display.id} is not visible.`)
    if (!overlay.isAlwaysOnTop) throw new Error(`Overlay window for display ${display.id} is not topmost.`)
    if (overlay.isFocused) throw new Error(`Overlay window for display ${display.id} stole focus.`)
  }

  await sleep(1200)
  const overlayHandles = await lpApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => /AI Test Overlay/i.test(win.getTitle()))
      .map((win) => win.getNativeWindowHandle().readBigUInt64LE().toString())
  )
  const zOrder = isOverlayAboveGame(game.hwnd, overlayHandles[0])
  console.log(JSON.stringify({ zOrder, overlayHandles }, null, 2))
  if (!zOrder.above) throw new Error('The overlay is not above the full-screen game in the native z-order.')

  await overlayPage.screenshot({ path: path.join(artifacts, 'ai-test-overlay-fullscreen.png') })
  log('sending Esc while Rocket League is full-screen and foreground')
  sendEsc()

  let stopped = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(200)
    const status = await lpPage.evaluate(() => window.localpilot.computer.testMode('status'))
    if (!status.active) {
      stopped = true
      break
    }
  }
  if (!stopped) throw new Error('Esc did not stop the overlay while the full-screen game was foreground.')

  await sleep(800)
  const after = gameStatus()
  console.log(JSON.stringify({ afterStop: after }, null, 2))
  if (!after.found || !after.visible) throw new Error('The game did not survive the overlay stop.')
  if (!isFullscreenComputer(after)) throw new Error(`The game lost full-screen after Esc: ${JSON.stringify(after)}`)
  if (!after.foreground) throw new Error(`The game lost the foreground after Esc: ${JSON.stringify(after)}`)

  log('PASS: Rocket League full-screen, overlay topmost with no focus theft, real Esc stopped it, game survived')
}

main()
  .catch((err) => {
    console.error('[fullscreen] FAIL:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    if (lpPage && !lpPage.isClosed()) {
      await lpPage.evaluate(() => window.localpilot.computer.testMode('stop')).catch(() => undefined)
      await lpPage.evaluate(() => window.localpilot.plugins.uninstall('app-tester')).catch(() => undefined)
    }
    if (lpApp) await lpApp.close().catch(() => undefined)
    try {
      killNewGameProcesses()
    } catch (err) {
      console.error('[fullscreen] game cleanup failed:', err instanceof Error ? err.message : String(err))
    }
    try {
      const remaining = gameIds()
      if (remaining.length) console.error(`[fullscreen] cleanup left Rocket League PIDs: ${remaining.join(', ')}`)
    } catch {
      // best effort
    }
  })
