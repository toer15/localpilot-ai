import { BrowserWindow, globalShortcut, screen, type Display } from 'electron'
import path from 'node:path'
import { log } from '../core/logger'

export interface AiOverlayStatus {
  active: boolean
  stopKey: string
  shortcutRegistered: boolean
  label: string
}

export interface AiOverlayStartOptions {
  label?: string
  onStop?: () => void | Promise<void>
}

interface OverlayEntry {
  displayId: number
  win: BrowserWindow
  loaded: boolean
}

const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>AI Test Overlay</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; font-family: "Segoe UI", system-ui, sans-serif; }
  #frame {
    position: fixed; inset: 0; border: 3px solid rgba(34, 197, 94, .95); border-radius: 8px;
    box-shadow: inset 0 0 70px rgba(34, 197, 94, .22), inset 0 0 0 1px rgba(134, 239, 172, .55);
    animation: frame-breathe 2.8s ease-in-out infinite; pointer-events: none;
  }
  #frame::before, #frame::after {
    content: ""; position: absolute; width: 64px; height: 64px; border: 3px solid #4ade80;
    filter: drop-shadow(0 0 8px rgba(34, 197, 94, .8));
  }
  #frame::before { left: -3px; top: -3px; border-right: none; border-bottom: none; border-radius: 8px 0 0 0; }
  #frame::after { right: -3px; bottom: -3px; border-left: none; border-top: none; border-radius: 0 0 8px 0; }
  #banner {
    position: fixed; top: 22px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 11px; align-items: flex-start; min-width: 340px; max-width: min(680px, 82vw);
    padding: 12px 17px 12px 14px; border-radius: 13px;
    border: 1px solid rgba(74, 222, 128, .6);
    background: linear-gradient(145deg, rgba(5, 26, 15, .96), rgba(6, 40, 22, .94));
    box-shadow: 0 10px 40px rgba(0, 0, 0, .55), 0 0 28px rgba(34, 197, 94, .25);
    color: #dcfce7; backdrop-filter: blur(8px); pointer-events: none;
  }
  .pulse-dot {
    width: 10px; height: 10px; margin-top: 4px; flex: 0 0 auto; border-radius: 50%;
    background: #22c55e; box-shadow: 0 0 0 0 rgba(34, 197, 94, .7); animation: dot-pulse 1.5s infinite;
  }
  .banner-copy { min-width: 0; }
  .banner-title { font-size: 14px; font-weight: 650; letter-spacing: .01em; }
  .banner-sub { margin-top: 4px; font-size: 12px; color: #86efac; }
  .stop-key {
    display: inline-block; min-width: 27px; padding: 1px 6px; margin: 0 2px; text-align: center;
    border: 1px solid #4ade80; border-radius: 5px; background: #14532d; color: #fff;
    font-size: 11px; font-weight: 700; letter-spacing: .03em;
  }
  .task { margin-top: 5px; font-size: 11px; color: #bbf7d0; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #ai-cursor { position: fixed; left: 50%; top: 50%; width: 0; height: 0; z-index: 10; transition: left .09s linear, top .09s linear; }
  .halo {
    position: absolute; left: -25px; top: -25px; width: 50px; height: 50px; border-radius: 50%;
    border: 2px solid rgba(74, 222, 128, .9);
    box-shadow: 0 0 22px rgba(34, 197, 94, .85), inset 0 0 14px rgba(34, 197, 94, .45);
    animation: halo-pulse 1.8s ease-in-out infinite;
  }
  .ai-arrow { position: absolute; left: 13px; top: 8px; filter: drop-shadow(0 0 7px rgba(34, 197, 94, .95)); }
  .ripple {
    position: fixed; width: 16px; height: 16px; border: 2px solid #4ade80; border-radius: 50%;
    transform: translate(-50%, -50%); pointer-events: none; z-index: 9;
    animation: ripple .65s ease-out forwards;
  }
  #footer {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    padding: 6px 13px; border-radius: 999px; border: 1px solid rgba(74, 222, 128, .35);
    background: rgba(4, 20, 12, .78); color: #86efac; font-size: 10px; font-weight: 650;
    letter-spacing: .16em; text-transform: uppercase; pointer-events: none;
  }
  @keyframes frame-breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }
  @keyframes dot-pulse { 0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .65); } 70% { box-shadow: 0 0 0 9px rgba(34, 197, 94, 0); } 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); } }
  @keyframes halo-pulse { 0%, 100% { transform: scale(.92); opacity: .8; } 50% { transform: scale(1.1); opacity: 1; } }
  @keyframes ripple { from { width: 14px; height: 14px; opacity: .95; } to { width: 82px; height: 82px; opacity: 0; } }
</style>
</head>
<body>
  <div id="frame"></div>
  <div id="banner" style="display:none">
    <span class="pulse-dot"></span>
    <div class="banner-copy">
      <div class="banner-title">AI has taken over this screen</div>
      <div class="banner-sub">Press <span id="stop-key" class="stop-key">Esc</span> to stop testing</div>
      <div id="task-label" class="task">AI cursor is independent of your mouse</div>
    </div>
  </div>
  <div id="ai-cursor" style="display:none">
    <div class="halo"></div>
    <svg class="ai-arrow" width="23" height="26" viewBox="0 0 23 26" aria-hidden="true">
      <path d="M2.2 1.2 L2.2 20.1 L7.7 15.1 L11.1 23.4 L15.4 21.6 L12.1 13.4 L19.6 12.6 Z"
        fill="#22c55e" stroke="#052e16" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>
  </div>
  <div id="footer" style="display:none">AI test mode &middot; Escape stops the run</div>
<script>
  (function () {
    var cursor = document.getElementById('ai-cursor');
    var banner = document.getElementById('banner');
    var footer = document.getElementById('footer');
    var stopKey = document.getElementById('stop-key');
    var task = document.getElementById('task-label');
    var lastX = window.innerWidth / 2;
    var lastY = window.innerHeight / 2;
    function ripple(x, y) {
      var el = document.createElement('div');
      el.className = 'ripple';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 700);
    }
    function apply(state) {
      if (!state) return;
      if (state.cursor === null) {
        cursor.style.display = 'none';
      } else if (state.cursor) {
        cursor.style.display = 'block';
        lastX = state.cursor.x;
        lastY = state.cursor.y;
        cursor.style.left = lastX + 'px';
        cursor.style.top = lastY + 'px';
      }
      if (state.stopKey) stopKey.textContent = state.stopKey;
      if (typeof state.label === 'string') {
        task.textContent = state.label || 'AI cursor is independent of your mouse';
      }
      if (typeof state.primary === 'boolean') {
        banner.style.display = state.primary ? 'flex' : 'none';
        footer.style.display = state.primary ? 'block' : 'none';
      }
      if (state.pulse) ripple(lastX, lastY);
    }
    if (window.aiOverlay && window.aiOverlay.onUpdate) window.aiOverlay.onUpdate(apply);
  })();
</script>
</body>
</html>`

class AiTestOverlay {
  private windows = new Map<number, OverlayEntry>()
  private active = false
  private label = ''
  private stopKey = 'Esc'
  private shortcutRegistered = false
  private escRegistered = false
  private stopHandler: (() => void | Promise<void>) | null = null
  private zOrder: NodeJS.Timeout | null = null
  private aiPoint: { x: number; y: number } | null = null
  private lastPointDisplayId: number | null = null
  private displayListenersBound = false

  private readonly onDisplaysChanged = () => {
    if (!this.active) return
    this.syncWindows()
    this.sendCursor()
    this.sendState()
  }

  get isActive() {
    return this.active
  }

  status(): AiOverlayStatus {
    return {
      active: this.active,
      stopKey: this.stopKey,
      shortcutRegistered: this.shortcutRegistered,
      label: this.label
    }
  }

  /** Move the AI-owned cursor. This is the only source of its screen position. */
  setCursor(point: { x: number; y: number }, pulse = true): void {
    if (!this.active) return
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    this.aiPoint = { x: point.x, y: point.y }
    this.sendCursor()
    if (pulse) this.sendPulse()
  }

  /** Position from physical screen pixels, as returned by mouse and UIA actions. */
  setCursorFromScreen(x: number, y: number, pulse = true): void {
    if (!this.active || !Number.isFinite(x) || !Number.isFinite(y)) return
    let point = { x, y }
    try {
      const dip = screen.screenToDipPoint({ x: Math.round(x), y: Math.round(y) })
      if (Number.isFinite(dip.x) && Number.isFinite(dip.y)) point = { x: dip.x, y: dip.y }
    } catch {
      // Fall back to interpreting the action coordinates as DIP.
    }
    this.setCursor(point, pulse)
  }

  /** Keep the AI cursor still and animate a click ripple at its current target. */
  pulse(): void {
    if (!this.active || !this.aiPoint) return
    this.sendCursor()
    this.sendPulse()
  }

  async start(options: AiOverlayStartOptions = {}): Promise<AiOverlayStatus> {
    if (typeof options.label === 'string' && options.label.trim()) this.label = options.label.trim().slice(0, 160)
    if (options.onStop) this.stopHandler = options.onStop
    if (this.active) {
      this.sendState()
      this.sendCursor()
      return this.status()
    }

    this.active = true
    if (!this.aiPoint) {
      const primary = screen.getPrimaryDisplay()
      this.aiPoint = {
        x: primary.bounds.x + primary.bounds.width / 2,
        y: primary.bounds.y + primary.bounds.height / 2
      }
    }
    this.ensureDisplayListeners()
    this.syncWindows()
    this.registerEsc()
    this.startZOrder()
    for (const entry of this.windows.values()) {
      if (!entry.win.isDestroyed()) entry.win.showInactive()
    }
    // Windows can clamp the initial frameless window to the work area; re-apply
    // the full display bounds after it is shown so the border covers the taskbar.
    this.syncWindows()
    this.sendState()
    this.sendCursor()
    log.info('overlay', `AI test overlay started (stop key: ${this.stopKey})`)
    return this.status()
  }

  hide(): void {
    const wasActive = this.active
    this.active = false
    this.stopHandler = null
    this.stopZOrder()
    this.unregisterEsc()
    this.aiPoint = null
    this.lastPointDisplayId = null
    for (const entry of this.windows.values()) {
      if (entry.win.isDestroyed()) continue
      try {
        if (entry.loaded) entry.win.webContents.send('overlay:update', { active: false, cursor: null })
        entry.win.hide()
      } catch {
        // window may be closing
      }
    }
    if (wasActive) log.info('overlay', 'AI test overlay hidden')
  }

  refreshStopShortcut(): void {
    if (!this.active) return
    this.unregisterEsc()
    this.registerEsc()
    this.sendState()
  }

  dispose(): void {
    this.hide()
    this.unbindDisplayListeners()
    for (const entry of this.windows.values()) {
      if (!entry.win.isDestroyed()) entry.win.destroy()
    }
    this.windows.clear()
    this.label = ''
  }

  private ensureDisplayListeners() {
    if (this.displayListenersBound) return
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
    this.displayListenersBound = true
  }

  private unbindDisplayListeners() {
    if (!this.displayListenersBound) return
    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
    this.displayListenersBound = false
  }

  private createWindow(display: Display) {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      title: 'AI Test Overlay',
      webPreferences: {
        preload: path.join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false
      }
    })

    const entry: OverlayEntry = { displayId: display.id, win, loaded: false }
    this.windows.set(display.id, entry)
    win.setAlwaysOnTop(true, 'screen-saver', 1)
    win.setIgnoreMouseEvents(true)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setSkipTaskbar(true)
    win.setFullScreenable(false)
    try {
      win.setContentProtection(true)
    } catch {
      // Older Windows builds may not support capture exclusion.
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('did-finish-load', () => {
      entry.loaded = true
      this.sendState(entry)
      this.sendCursor()
    })
    win.on('closed', () => {
      if (this.windows.get(display.id)?.win === win) this.windows.delete(display.id)
      if (![...this.windows.values()].some((candidate) => !candidate.win.isDestroyed())) {
        this.active = false
        this.aiPoint = null
        this.stopZOrder()
        this.unregisterEsc()
      }
    })
    void win
      .loadURL(`data:text/html;base64,${Buffer.from(OVERLAY_HTML).toString('base64')}`)
      .catch((err) => log.warn('overlay', 'Could not load overlay UI', String(err)))
  }

  private syncWindows() {
    if (!this.active) return
    const displays = screen.getAllDisplays()
    const displayIds = new Set<number>()
    for (const display of displays) {
      if (display.bounds.width <= 0 || display.bounds.height <= 0) continue
      displayIds.add(display.id)
      const existing = this.windows.get(display.id)
      if (!existing || existing.win.isDestroyed()) {
        this.createWindow(display)
        const created = this.windows.get(display.id)
        if (created && !created.win.isDestroyed()) {
          created.win.showInactive()
          created.win.setBounds(display.bounds)
        }
        continue
      }
      const bounds = existing.win.getBounds()
      if (
        bounds.x !== display.bounds.x ||
        bounds.y !== display.bounds.y ||
        bounds.width !== display.bounds.width ||
        bounds.height !== display.bounds.height
      ) {
        existing.win.setBounds(display.bounds)
      }
      if (!existing.win.isVisible()) existing.win.showInactive()
    }
    for (const [displayId, entry] of [...this.windows]) {
      if (displayIds.has(displayId)) continue
      this.windows.delete(displayId)
      if (!entry.win.isDestroyed()) entry.win.destroy()
      if (this.lastPointDisplayId === displayId) this.lastPointDisplayId = null
    }
  }

  private startZOrder() {
    this.stopZOrder()
    this.zOrder = setInterval(() => this.raiseWindows(), 800)
  }

  private stopZOrder() {
    if (this.zOrder) clearInterval(this.zOrder)
    this.zOrder = null
  }

  private raiseWindows() {
    if (!this.active) return
    for (const entry of this.windows.values()) {
      if (entry.win.isDestroyed() || !entry.win.isVisible()) continue
      try {
        // Full-screen games are often topmost themselves. Re-raise the overlay
        // without focusing it so it stays above the game as the z-order changes.
        entry.win.moveTop()
      } catch {
        // ignore transient teardown
      }
    }
  }

  private sendCursor() {
    if (!this.active || !this.aiPoint) return
    const point = this.aiPoint
    try {
      const display = screen.getDisplayNearestPoint(point)
      if (this.lastPointDisplayId !== null && this.lastPointDisplayId !== display.id) {
        const previous = this.windows.get(this.lastPointDisplayId)
        if (previous?.loaded && !previous.win.isDestroyed()) {
          previous.win.webContents.send('overlay:update', { cursor: null })
        }
      }
      const entry = this.windows.get(display.id)
      if (!entry) return
      this.lastPointDisplayId = display.id
      if (!entry.loaded || entry.win.isDestroyed()) return
      entry.win.webContents.send('overlay:update', {
        cursor: { x: point.x - display.bounds.x, y: point.y - display.bounds.y }
      })
    } catch {
      // display changes can race with a cursor update
    }
  }

  private sendPulse() {
    if (!this.active || !this.aiPoint) return
    try {
      const display = screen.getDisplayNearestPoint(this.aiPoint)
      const entry = this.windows.get(display.id)
      if (entry?.loaded && !entry.win.isDestroyed()) {
        entry.win.webContents.send('overlay:update', { pulse: true })
      }
    } catch {
      // ignore display or teardown races
    }
  }

  private sendState(target?: OverlayEntry) {
    const entries = target ? [target] : [...this.windows.values()]
    let primaryId: number | null = null
    try {
      primaryId = screen.getPrimaryDisplay().id
    } catch {
      // screen may be unavailable during shutdown
    }
    for (const entry of entries) {
      if (!entry.loaded || entry.win.isDestroyed()) continue
      try {
        entry.win.webContents.send('overlay:update', {
          active: this.active,
          label: this.label,
          stopKey: this.stopKey,
          shortcutRegistered: this.shortcutRegistered,
          primary: primaryId === entry.displayId
        })
      } catch {
        // ignore transient teardown
      }
    }
  }

  private registerEsc() {
    if (this.escRegistered) return
    let registered = false
    try {
      registered = globalShortcut.register('Escape', () => {
        void this.stopByUser()
      })
    } catch (err) {
      log.warn('overlay', 'Escape shortcut registration failed', String(err))
    }
    this.escRegistered = registered
    this.shortcutRegistered = registered
    this.stopKey = registered ? 'Esc' : 'Ctrl+Alt+Shift+X'
    if (!registered) {
      log.warn('overlay', 'Escape is unavailable; fallback stop shortcut is the configured emergency shortcut')
    }
  }

  private unregisterEsc() {
    if (!this.escRegistered) return
    try {
      globalShortcut.unregister('Escape')
    } catch {
      // ignore
    }
    this.escRegistered = false
    this.shortcutRegistered = false
  }

  private async stopByUser() {
    const handler = this.stopHandler
    this.hide()
    if (!handler) return
    try {
      await handler()
    } catch (err) {
      log.warn('overlay', 'Overlay stop handler failed', String(err))
    }
  }
}

export const aiOverlay = new AiTestOverlay()
