import { useEffect, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  AppUpdateStatus,
  HardwareInfo,
  MemoryItem,
  ModelInfo,
  ProviderStatus,
  SelfTestReport
} from '@shared/types'
import type { Page } from '../App'
import { Icon, type IconName } from '../components/Icons'
import { Field, Section, Spinner, Toggle } from '../components/ui'
import { formatBytes, formatNumber } from '../lib/format'

const api = window.localpilot

interface Props {
  settings: AppSettings
  info: AppInfo
  providers: ProviderStatus[]
  models: ModelInfo[]
  onUpdateSettings: (patch: Record<string, unknown>) => Promise<AppSettings>
  onRefreshProviders: () => Promise<void>
  onNavigate: (page: Page) => void
  onConversationsChanged: () => void
  onOpenOnboarding: () => void
  onHardware: (hardware: HardwareInfo) => void
}

type Tab = 'general' | 'models' | 'agents' | 'computer' | 'memory' | 'plugins' | 'privacy' | 'advanced' | 'about'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'models', label: 'Models & endpoints', icon: 'cpu' },
  { id: 'agents', label: 'Agent behavior', icon: 'users' },
  { id: 'computer', label: 'Computer Use', icon: 'monitor' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'plugins', label: 'Plugins', icon: 'plugin' },
  { id: 'privacy', label: 'Privacy & security', icon: 'shield' },
  { id: 'advanced', label: 'Advanced', icon: 'wrench' },
  { id: 'about', label: 'About', icon: 'zap' }
]

function updateSummary(status: AppUpdateStatus | null, currentVersion: string): string {
  if (!status) return `Current version ${currentVersion}.`
  if (status.phase === 'checking') return 'Checking GitHub Releases…'
  if (status.phase === 'up-to-date') return `Up to date (${status.currentVersion}).`
  if (status.phase === 'available') return `Version ${status.version ?? 'new'} is available; downloading…`
  if (status.phase === 'downloading') return `Downloading ${status.version ?? 'update'} — ${Math.round(status.percent ?? 0)}%.`
  if (status.phase === 'downloaded') return `Version ${status.version ?? 'new'} is downloaded and ready.`
  if (status.phase === 'error') return status.message ?? 'The update check failed.'
  if (status.phase === 'unsupported') return status.message ?? 'Update checks are available in installed builds.'
  return `Current version ${currentVersion}. Automatic checks run at launch and every four hours.`
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(parsed.hostname)
  } catch {
    return true
  }
}

export function SettingsPage({
  settings,
  info,
  providers,
  models,
  onUpdateSettings,
  onRefreshProviders,
  onNavigate,
  onConversationsChanged,
  onOpenOnboarding,
  onHardware
}: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [endpointDrafts, setEndpointDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(providers.map((p) => [p.id, p.baseUrl]))
  )
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [allowlistDraft, setAllowlistDraft] = useState(settings.computer.allowlist.join(', '))
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<typeof api.computer.capabilities>> | null>(null)
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null)
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [pluginsCount, setPluginsCount] = useState<number | null>(null)
  const [mcpCount, setMcpCount] = useState<number | null>(null)
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [memoryKey, setMemoryKey] = useState('')
  const [memoryValue, setMemoryValue] = useState('')
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [editMemoryKey, setEditMemoryKey] = useState('')
  const [editMemoryValue, setEditMemoryValue] = useState('')
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null)

  useEffect(() => {
    setEndpointDrafts(Object.fromEntries(providers.map((p) => [p.id, p.baseUrl])))
  }, [providers])

  useEffect(() => {
    setAllowlistDraft(settings.computer.allowlist.join(', '))
  }, [settings.computer.allowlist])

  useEffect(() => {
    let active = true
    void api.updates
      .status()
      .then((next) => {
        if (active) setUpdateStatus(next)
      })
      .catch(() => undefined)
    const unsubscribe = api.updates.onStatus((next) => setUpdateStatus(next))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (tab === 'computer') void api.computer.capabilities().then(setCapabilities).catch(() => undefined)
    if (tab === 'memory') {
      void api.memory
        .list(null)
        .then((list) => setMemories(list.filter((m) => m.scope === 'global')))
        .catch(() => undefined)
    }
    if (tab === 'plugins') {
      void api.plugins.list().then((p) => setPluginsCount(p.filter((x) => x.enabled).length)).catch(() => undefined)
      void api.plugins.mcpServers().then((m) => setMcpCount(m.length)).catch(() => undefined)
    }
  }, [tab])

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])

  const update = async (patch: Record<string, unknown>) => {
    setError(null)
    try {
      await onUpdateSettings(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const saveEndpoint = async (provider: ProviderStatus) => {
    setBusy(`endpoint-${provider.id}`)
    setError(null)
    try {
      await api.models.setEndpoint(provider.id, endpointDrafts[provider.id] ?? provider.baseUrl)
      await onRefreshProviders()
      setMessage(`${provider.name} endpoint updated.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (provider: ProviderStatus) => {
    const value = keyDrafts[provider.id]?.trim()
    if (!value) return
    setBusy(`key-${provider.id}`)
    try {
      await api.models.setApiKey(provider.id, value)
      setKeyDrafts((prev) => ({ ...prev, [provider.id]: '' }))
      await onRefreshProviders()
      setMessage(`API key stored for ${provider.name} using Windows DPAPI.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const checkForUpdates = async () => {
    setBusy('update-check')
    setError(null)
    try {
      const next = await api.updates.check()
      setUpdateStatus(next)
      if (next.phase === 'up-to-date') setMessage('LocalPilot AI is up to date.')
      else if (next.phase === 'unsupported') setMessage(next.message ?? 'Update checks are available in installed builds.')
      else if (next.phase === 'error') setError(next.message ?? 'The update check failed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const installUpdate = async () => {
    setBusy('update-install')
    setError(null)
    try {
      await api.updates.install()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  const refreshHardware = async () => {
    setBusy('hardware')
    try {
      const hw = await api.models.hardware(true)
      setHardware(hw)
      onHardware(hw)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runSelfTest = async () => {
    setBusy('selftest')
    setError(null)
    try {
      setReport(await api.app.runSelfTest())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const addGlobalMemory = async () => {
    if (!memoryKey.trim() || !memoryValue.trim()) return
    setBusy('memory-add')
    setError(null)
    try {
      const item = await api.memory.save({ scope: 'global', key: memoryKey.trim(), value: memoryValue.trim() })
      setMemories((prev) => [...prev, item])
      setMemoryKey('')
      setMemoryValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveEditedMemory = async (id: string) => {
    setBusy(`memory-${id}`)
    try {
      const updated = await api.memory.update(id, { key: editMemoryKey, value: editMemoryValue })
      setMemories((prev) => prev.map((m) => (m.id === id ? updated : m)))
      setEditingMemoryId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const removeGlobalMemory = async (id: string) => {
    if (!window.confirm('Delete this global memory entry?')) return
    try {
      await api.memory.remove(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Configuration</div>
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">
              Everything is stored locally. Changes are applied to new runs immediately; some provider changes take effect
              on the next request.
            </p>
          </div>
          <div className="page-actions">
            <span className="badge ok">{settings.privacy.localOnly ? 'local-only mode' : 'local default'}</span>
          </div>
        </div>

        {message ? <div className="notice-row info" style={{ marginBottom: 12 }}><Icon name="check" size={14} /> {message}</div> : null}
        {error ? <div className="notice-row error" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /> {error}</div> : null}

        <div className="settings-layout">
          <nav className="settings-nav">
            {TABS.map((item) => (
              <button key={item.id} type="button" className={`settings-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
                <Icon name={item.icon} size={14} /> {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {tab === 'general' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Appearance</h4><p>Dark by default; light mode keeps the same hierarchy.</p></div>
                  <div className="settings-section-body">
                    <div className="row">
                      <button className={`btn ${settings.general.theme === 'dark' ? 'btn-primary' : ''}`} type="button" onClick={() => void update({ general: { theme: 'dark' } })}><Icon name="moon" size={13} /> Dark</button>
                      <button className={`btn ${settings.general.theme === 'light' ? 'btn-primary' : ''}`} type="button" onClick={() => void update({ general: { theme: 'light' } })}><Icon name="sun" size={13} /> Light</button>
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Compact density</div><div className="d">Tighter spacing for smaller displays.</div></div>
                      <select className="select select-sm" style={{ width: 140 }} value={settings.general.density} onChange={(e) => void update({ general: { density: e.target.value } })}>
                        <option value="comfortable">Comfortable</option>
                        <option value="compact">Compact</option>
                      </select>
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Show reasoning traces</div><div className="d">Display thinking output when the model reports it. This does not make a non-thinking model reason.</div></div>
                      <Toggle checked={settings.general.showReasoning} onChange={(v) => void update({ general: { showReasoning: v } })} />
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Startup & interface</h4></div>
                  <div className="settings-section-body">
                    <div className="setting-row">
                      <div className="info"><div className="t">Start minimized</div><div className="d">Launch to the tray instead of showing the window.</div></div>
                      <Toggle checked={settings.general.startMinimized} onChange={(v) => void update({ general: { startMinimized: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Notifications</div><div className="d">Notify when a long agent run completes.</div></div>
                      <Toggle checked={settings.general.notifications} onChange={(v) => void update({ general: { notifications: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Language</div><div className="d">Interface language (English ships first).</div></div>
                      <select className="select select-sm" style={{ width: 140 }} value={settings.general.language} onChange={(e) => void update({ general: { language: e.target.value } })}>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div className="row">
                      <button className="btn btn-sm" type="button" onClick={onOpenOnboarding}>Run setup wizard again</button>
                    </div>
                  </div>
                </div>
              </>
            ) : tab === 'models' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Default local model</h4><p>Used for new conversations. Local inference requires no API key.</p></div>
                  <div className="settings-section-body">
                    <Field label="Provider / model">
                      <select
                        className="select"
                        value={`${settings.models.defaultProviderId ?? ''}::${settings.models.defaultModelId ?? ''}`}
                        onChange={(e) => {
                          const [providerId, modelId] = e.target.value.split('::')
                          void update({
                            models: {
                              defaultProviderId: providerId || null,
                              defaultModelId: modelId || null
                            }
                          })
                        }}
                      >
                        <option value="::">Not configured</option>
                        {models.filter((m) => m.kind === 'chat').map((model) => (
                          <option key={`${model.providerId}::${model.id}`} value={`${model.providerId}::${model.id}`}>
                            {model.providerName} — {model.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="tiny faint">
                      Installed models: {providers.reduce((sum, p) => sum + (p.modelCount ?? 0), 0)}. Model metadata and
                      capabilities are read from the local runtime.
                    </div>
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-head"><h4>Local endpoints</h4><p>Ollama, LM Studio, llama.cpp and OpenAI-compatible servers.</p></div>
                  <div className="settings-section-body">
                    {providers.map((provider) => {
                      const url = endpointDrafts[provider.id] ?? provider.baseUrl
                      const remote = !isLocalUrl(url)
                      return (
                        <div key={provider.id} className="card tight" style={{ background: 'var(--bg-soft)' }}>
                          <div className="row between">
                            <div className="row">
                              <span className={`status-dot ${provider.running ? 'online' : ''}`} />
                              <span style={{ fontSize: 12, fontWeight: 600 }}>{provider.name}</span>
                              <span className="badge">{provider.type}</span>
                              {remote ? <span className="badge danger">remote / cloud</span> : <span className="badge ok">local</span>}
                            </div>
                            <span className="tiny faint">{provider.running ? `${provider.modelCount ?? 0} models` : provider.installed === false ? 'not installed' : 'offline'}</span>
                          </div>
                          <div className="row mt-8">
                            <input className="input" value={url} onChange={(e) => setEndpointDrafts((prev) => ({ ...prev, [provider.id]: e.target.value }))} />
                            <button className="btn btn-sm" type="button" disabled={busy === `endpoint-${provider.id}`} onClick={() => void saveEndpoint(provider)}>
                              {busy === `endpoint-${provider.id}` ? <Spinner /> : 'Save'}
                            </button>
                          </div>
                          {remote ? <div className="plugin-note" style={{ marginTop: 7 }}>This endpoint is not loopback. Requests leave this computer; make sure you intend to use a cloud service and understand its fees. LocalPilot will not make it the default silently.</div> : null}
                          {provider.type === 'openai' ? (
                            <div className="row mt-8">
                              <input className="input" type="password" placeholder={provider.hasKey ? 'API key stored (DPAPI) — enter to replace' : 'API key (optional for local servers)'} value={keyDrafts[provider.id] ?? ''} onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [provider.id]: e.target.value }))} />
                              <button className="btn btn-sm" type="button" disabled={!keyDrafts[provider.id]?.trim() || busy === `key-${provider.id}`} onClick={() => void saveKey(provider)}>
                                {busy === `key-${provider.id}` ? <Spinner /> : 'Store key'}
                              </button>
                            </div>
                          ) : null}
                          {provider.error ? <div className="tiny text-warn" style={{ marginTop: 6 }}>{provider.error}</div> : null}
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-head"><h4>Model runtime</h4><p>Applied to local requests and llama.cpp launches.</p></div>
                  <div className="settings-section-body">
                    <div className="form-row">
                      <Field label="Temperature"><input className="input" type="number" step="0.05" value={settings.models.temperature} onChange={(e) => void update({ models: { temperature: Number(e.target.value) } })} /></Field>
                      <Field label="Top P"><input className="input" type="number" step="0.05" value={settings.models.topP} onChange={(e) => void update({ models: { topP: Number(e.target.value) } })} /></Field>
                      <Field label="Max output tokens"><input className="input" type="number" value={settings.models.maxTokens} onChange={(e) => void update({ models: { maxTokens: Number(e.target.value) } })} /></Field>
                      <Field label="Context length"><input className="input" type="number" value={settings.models.contextLength} onChange={(e) => void update({ models: { contextLength: Number(e.target.value) } })} /></Field>
                      <Field label="GPU layers"><input className="input" type="number" value={settings.models.gpuLayers} onChange={(e) => void update({ models: { gpuLayers: Number(e.target.value) } })} /></Field>
                      <Field label="llama.cpp port"><input className="input" type="number" value={settings.models.llamaPort} onChange={(e) => void update({ models: { llamaPort: Number(e.target.value) } })} /></Field>
                    </div>
                    <Field label="Models folder">
                      <div className="row">
                        <input className="input" value={settings.models.modelsDir} readOnly />
                        <button className="btn btn-sm" type="button" onClick={() => void (async () => {
                          const folder = await api.app.selectFolder('Choose a models folder')
                          if (folder) await update({ models: { modelsDir: folder } })
                        })()}>Browse…</button>
                      </div>
                    </Field>
                    <Field label="llama-server.exe path" hint="Leave empty to use the local engine installed from the Model library. A custom Vulkan or CUDA build can be selected here; AMD on Windows should use Vulkan.">
                      <div className="row">
                        <input className="input" value={settings.models.llamaServerPath} readOnly placeholder="No llama-server.exe selected" />
                        <button className="btn btn-sm" type="button" onClick={() => void (async () => {
                          const files = await api.app.selectFiles([{ name: 'Executable', extensions: ['exe'] }])
                          if (files[0]) await update({ models: { llamaServerPath: files[0] } })
                        })()}>Browse…</button>
                      </div>
                    </Field>
                    <div className="setting-row">
                      <div className="info"><div className="t">Auto-start llama.cpp</div><div className="d">Allow the managed engine to start automatically when a GGUF model is loaded.</div></div>
                      <Toggle checked={settings.models.autoStartLlama} onChange={(v) => void update({ models: { autoStartLlama: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Stream tokens</div><div className="d">Local runtimes stream over SSE/NDJSON.</div></div>
                      <Toggle checked={settings.models.stream} onChange={(v) => void update({ models: { stream: v } })} />
                    </div>
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-head"><h4>Hardware diagnostics</h4></div>
                  <div className="settings-section-body">
                    <div className="row">
                      <button className="btn btn-sm" type="button" disabled={busy === 'hardware'} onClick={() => void refreshHardware()}>
                        {busy === 'hardware' ? <Spinner /> : <Icon name="refresh" size={11} />} Detect hardware
                      </button>
                      <span className="tiny faint">{hardware ? `${hardware.gpus[0]?.name ?? hardware.cpu.model} · ${formatBytes(hardware.ram.totalBytes)} RAM` : 'Run detection to see GPU, VRAM and acceleration.'}</span>
                    </div>
                    {hardware ? (
                      <div className="tiny faint">
                        CUDA {hardware.acceleration.cuda ? 'yes' : 'no'} · Vulkan {hardware.acceleration.vulkan ? 'detected' : 'unknown'} · ROCm {hardware.acceleration.rocm ? 'assumed' : 'not assumed'} · {hardware.recommendations.summary}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : tab === 'agents' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Execution limits</h4></div>
                  <div className="settings-section-body">
                    <Field label="Maximum agent iterations"><input className="input short" type="number" value={settings.agent.maxIterations} onChange={(e) => void update({ agent: { maxIterations: Number(e.target.value) } })} /></Field>
                    <Field label="Maximum tool calls"><input className="input short" type="number" value={settings.agent.toolCallLimit} onChange={(e) => void update({ agent: { toolCallLimit: Number(e.target.value) } })} /></Field>
                    <Field label="Run timeout (ms)"><input className="input short" type="number" step="1000" value={settings.agent.timeoutMs} onChange={(e) => void update({ agent: { timeoutMs: Number(e.target.value) } })} /></Field>
                    <Field label="Default reasoning effort">
                      <select className="select" style={{ width: 200 }} value={settings.agent.reasoningEffort} onChange={(e) => void update({ agent: { reasoningEffort: e.target.value } })}>
                        {['none', 'low', 'medium', 'high', 'max', 'ultra'].map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </Field>
                    <Field label="Tool protocol">
                      <select className="select" style={{ width: 260 }} value={settings.agent.toolProtocol} onChange={(e) => void update({ agent: { toolProtocol: e.target.value } })}>
                        <option value="auto">Auto (native when reported)</option>
                        <option value="native">Native function calling</option>
                        <option value="text">Text tool protocol</option>
                      </select>
                    </Field>
                    <div className="setting-row">
                      <div className="info"><div className="t">Allow subagents</div><div className="d">Delegated runs inherit the current project scope and permission broker.</div></div>
                      <Toggle checked={settings.agent.allowSubagents} onChange={(v) => void update({ agent: { allowSubagents: v } })} />
                    </div>
                    <div className="row">
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('agents')}>Edit agent profiles <Icon name="arrow-right" size={11} /></button>
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Active profile</h4></div>
                  <div className="settings-section-body">
                    <select className="select" value={settings.agent.activeProfileId} onChange={(e) => void update({ agent: { activeProfileId: e.target.value } })}>
                      {settings.agent.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                    <div className="tiny faint">
                      {settings.agent.profiles.find((p) => p.id === settings.agent.activeProfileId)?.description}
                    </div>
                  </div>
                </div>
              </>
            ) : tab === 'computer' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Computer Use</h4><p>The agent can control your actual Windows desktop when authorized.</p></div>
                  <div className="settings-section-body">
                    <div className="setting-row">
                      <div className="info"><div className="t">Enable Computer Use</div><div className="d">If disabled, all mouse, keyboard, window and screenshot tools are revoked.</div></div>
                      <Toggle checked={settings.computer.enabled} onChange={(v) => void update({ computer: { enabled: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Screenshots</div><div className="d">Allow visible screen capture. There is no hidden continuous capture.</div></div>
                      <Toggle checked={settings.computer.screenshots} onChange={(v) => void update({ computer: { screenshots: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Mouse & keyboard</div><div className="d">Typing, clicking and shortcuts are high-impact tools and always require approval unless session-approved.</div></div>
                      <Toggle checked={settings.computer.mouseKeyboard} onChange={(v) => void update({ computer: { mouseKeyboard: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Window control</div><div className="d">Focus, minimize and close windows.</div></div>
                      <Toggle checked={settings.computer.windowControl} onChange={(v) => void update({ computer: { windowControl: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Automatic screenshots during Computer Use</div><div className="d">Include a screenshot after interactions when the model supports vision.</div></div>
                      <Toggle checked={settings.computer.automaticScreenshots} onChange={(v) => void update({ computer: { automaticScreenshots: v } })} />
                    </div>
                    <Field label="Approval policy">
                      <select className="select" style={{ width: 260 }} value={settings.computer.approvalMode} onChange={(e) => void update({ computer: { approvalMode: e.target.value } })}>
                        <option value="ask">Ask before every sensitive action</option>
                        <option value="session">Session approvals available</option>
                        <option value="auto-safe">Automatically approve low-risk reads</option>
                      </select>
                    </Field>
                    <Field label="Application allowlist" hint="Comma-separated executable names that may be launched with lower friction. High-risk actions still require approval.">
                      <input className="input" value={allowlistDraft} onChange={(e) => setAllowlistDraft(e.target.value)} onBlur={() => void update({ computer: { allowlist: allowlistDraft.split(',').map((s) => s.trim()).filter(Boolean) } })} />
                    </Field>
                    <Field label="Emergency stop shortcut">
                      <input className="input" style={{ width: 260 }} value={settings.computer.stopShortcut} onChange={(e) => void update({ computer: { stopShortcut: e.target.value } })} />
                    </Field>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Capability check</h4></div>
                  <div className="settings-section-body">
                    <div className="row wrap">
                      {capabilities ? (
                        <>
                          <span className={`badge ${capabilities.enabled ? 'ok' : 'warn'}`}>engine {capabilities.enabled ? 'ready' : 'disabled'}</span>
                          <span className={`badge ${capabilities.screenshots ? 'ok' : ''}`}>screenshots</span>
                          <span className={`badge ${capabilities.mouseKeyboard ? 'ok' : ''}`}>input</span>
                          <span className={`badge ${capabilities.windows ? 'ok' : ''}`}>windows</span>
                          <span className={`badge ${capabilities.automation ? 'ok' : ''}`}>UIA</span>
                        </>
                      ) : <span className="tiny faint">Checking PowerShell/C# automation…</span>}
                      <button className="btn btn-sm" type="button" onClick={() => void api.computer.capabilities().then(setCapabilities)}>Check again</button>
                      <button className="btn btn-sm" type="button" onClick={() => void (async () => {
                        try {
                          const shot = await api.computer.screenshot()
                          setScreenshotPath(shot.path)
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err))
                        }
                      })()}>Test screenshot</button>
                    </div>
                    {screenshotPath ? <div className="tiny faint mono" style={{ wordBreak: 'break-all' }}>Captured: {screenshotPath}</div> : null}
                    {capabilities?.lastError ? <div className="notice-row error"><Icon name="alert" size={12} /> {capabilities.lastError}</div> : null}
                  </div>
                </div>
              </>
            ) : tab === 'memory' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head">
                    <h4>Global memory</h4>
                    <p>Preferences and conventions the assistant should remember across projects. Stored in local SQLite; injected into agent context. Never store passwords or API keys here.</p>
                  </div>
                  <div className="settings-section-body">
                    <div className="form-row">
                      <Field label="Key"><input className="input" value={memoryKey} onChange={(e) => setMemoryKey(e.target.value)} placeholder="e.g. preferred shell" /></Field>
                      <Field label="Value"><input className="input" value={memoryValue} onChange={(e) => setMemoryValue(e.target.value)} placeholder="e.g. Use PowerShell 7 for scripts" /></Field>
                    </div>
                    <div className="row">
                      <button className="btn btn-sm btn-primary" type="button" disabled={busy === 'memory-add' || !memoryKey.trim() || !memoryValue.trim()} onClick={() => void addGlobalMemory()}>
                        {busy === 'memory-add' ? <Spinner /> : <Icon name="plus" size={11} />} Add global memory
                      </button>
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('projects')}>Project memory <Icon name="arrow-right" size={11} /></button>
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Saved memories</h4><p>{memories.length} global entr{memories.length === 1 ? 'y' : 'ies'} in this profile.</p></div>
                  <div className="settings-section-body">
                    {memories.length ? (
                      <div className="data-list">
                        {memories.map((memory) => (
                          <div className="data-row" key={memory.id}>
                            <div className="data-main">
                              {editingMemoryId === memory.id ? (
                                <>
                                  <input className="input" value={editMemoryKey} onChange={(e) => setEditMemoryKey(e.target.value)} />
                                  <textarea className="textarea" rows={2} value={editMemoryValue} onChange={(e) => setEditMemoryValue(e.target.value)} />
                                  <div className="row">
                                    <button className="btn btn-sm btn-primary" type="button" disabled={busy === `memory-${memory.id}`} onClick={() => void saveEditedMemory(memory.id)}>
                                      {busy === `memory-${memory.id}` ? <Spinner /> : <Icon name="check" size={11} />} Save
                                    </button>
                                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditingMemoryId(null)}>Cancel</button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="data-name">{memory.key}</div>
                                  <div className="data-sub"><span className="pre-wrap">{memory.value}</span></div>
                                </>
                              )}
                            </div>
                            {editingMemoryId !== memory.id ? (
                              <div className="data-actions">
                                <button className="icon-btn" type="button" title="Edit memory" onClick={() => { setEditingMemoryId(memory.id); setEditMemoryKey(memory.key); setEditMemoryValue(memory.value) }}>
                                  <Icon name="edit" size={13} />
                                </button>
                                <button className="icon-btn danger" type="button" title="Delete memory" onClick={() => void removeGlobalMemory(memory.id)}>
                                  <Icon name="trash" size={13} />
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="card tight tiny faint">No global memories yet. Project-specific instructions and memory are managed from Projects.</div>
                    )}
                  </div>
                </div>
              </>
            ) : tab === 'plugins' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Plugin runtime</h4><p>Plugins extend the agent’s tools. Every plugin declares permissions.</p></div>
                  <div className="settings-section-body">
                    <div className="setting-row">
                      <div className="info"><div className="t">Automatic update checks</div><div className="d">Check catalog versions for installed plugins. Updates are never installed without your action.</div></div>
                      <Toggle checked={settings.plugins.autoUpdate} onChange={(v) => void update({ plugins: { autoUpdate: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Allow network-capable plugins</div><div className="d">When off, plugins declaring network permissions remain disabled.</div></div>
                      <Toggle checked={settings.plugins.allowNetworkPlugins} onChange={(v) => void update({ plugins: { allowNetworkPlugins: v } })} />
                    </div>
                    <div className="row">
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('plugins')}>Open Plugin marketplace <Icon name="arrow-right" size={11} /></button>
                    </div>
                    <div className="tiny faint">
                      {pluginsCount !== null ? `${pluginsCount} enabled plugin(s) · ${mcpCount ?? 0} configured MCP server(s).` : 'Loading plugin state…'}
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Native plugin isolation</h4></div>
                  <div className="settings-section-body">
                    <div className="tiny faint" style={{ lineHeight: 1.6 }}>
                      Native plugins execute in a forked Electron child process with an explicit manifest and only the IPC
                      channel for tool results. This isolates crashes and prevents direct access to the main process object,
                      but it is not an OS-level security sandbox. Install plugins from sources you trust.
                    </div>
                  </div>
                </div>
              </>
            ) : tab === 'privacy' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Local-first guarantees</h4></div>
                  <div className="settings-section-body">
                    <div className="setting-row">
                      <div className="info"><div className="t">Local-only mode</div><div className="d">Blocks cloud AI providers. Local endpoints, local tools and local plugins continue to work.</div></div>
                      <Toggle checked={settings.privacy.localOnly} onChange={(v) => void update({ privacy: { localOnly: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Store conversations</div><div className="d">Persist messages in local SQLite. Disabling stops new messages from being stored.</div></div>
                      <Toggle checked={settings.privacy.storeConversations} onChange={(v) => void update({ privacy: { storeConversations: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Log tool commands</div><div className="d">Record command summaries in Activity. Output can contain sensitive data; review before sharing logs.</div></div>
                      <Toggle checked={settings.privacy.logCommands} onChange={(v) => void update({ privacy: { logCommands: v } })} />
                    </div>
                    <div className="setting-row">
                      <div className="info"><div className="t">Redact secrets in memory</div><div className="d">Best-effort removal of likely credentials before memory is shown to the model.</div></div>
                      <Toggle checked={settings.privacy.redactSecretsInMemory} onChange={(v) => void update({ privacy: { redactSecretsInMemory: v } })} />
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Credentials</h4></div>
                  <div className="settings-section-body">
                    <div className="tiny faint" style={{ lineHeight: 1.6 }}>
                      Optional API keys are encrypted with Electron safeStorage, which uses Windows DPAPI for your Windows
                      user. They are never written to conversations or logs. Local servers generally need no key.
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Delete local data</h4><p>These actions cannot be undone.</p></div>
                  <div className="settings-section-body">
                    <div className="row wrap">
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => {
                        if (!window.confirm('Delete all conversations from local SQLite? Projects and files are untouched.')) return
                        void (async () => {
                          const conversations = await api.chat.list()
                          for (const conversation of conversations) await api.chat.remove(conversation.id)
                          onConversationsChanged()
                          setMessage('All conversations deleted.')
                        })()
                      }}>Delete all conversations</button>
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => {
                        if (!window.confirm('Clear the local activity log?')) return
                        void api.activity.clear().then(() => setMessage('Activity log cleared.'))
                      }}>Clear activity log</button>
                      <button className="btn btn-sm" type="button" onClick={() => void api.app.openExternal('https://support.microsoft.com/windows/delete-and-manage-your-information-49f4c4b5-cd1f-a2c9-37c6-0e1a2b6e4e4c')}>Windows privacy settings</button>
                    </div>
                  </div>
                </div>
              </>
            ) : tab === 'advanced' ? (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Runtime</h4></div>
                  <div className="settings-section-body">
                    <Field label="Log level">
                      <select className="select" style={{ width: 160 }} value={settings.advanced.logLevel} onChange={(e) => void update({ advanced: { logLevel: e.target.value } })}>
                        <option value="info">Info</option>
                        <option value="debug">Debug</option>
                      </select>
                    </Field>
                    <Field label="Request timeout (ms)"><input className="input" style={{ width: 180 }} type="number" step="1000" value={settings.advanced.requestTimeoutMs} onChange={(e) => void update({ advanced: { requestTimeoutMs: Number(e.target.value) } })} /></Field>
                    <Field label="Custom system prompt" hint="Appended after LocalPilot’s safety and tool instructions. Tool permissions cannot be overridden here.">
                      <textarea className="textarea" rows={4} value={settings.advanced.customSystemPrompt} onChange={(e) => void update({ advanced: { customSystemPrompt: e.target.value } })} />
                    </Field>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Diagnostics</h4></div>
                  <div className="settings-section-body">
                    <div className="row wrap">
                      <button className="btn btn-sm" type="button" disabled={busy === 'selftest'} onClick={() => void runSelfTest()}>
                        {busy === 'selftest' ? <Spinner /> : <Icon name="play" size={11} />} Run self-test
                      </button>
                      <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(info.dataDir)}>Open data folder</button>
                      <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(info.logsDir)}>Open logs</button>
                      <button className="btn btn-sm" type="button" onClick={() => void refreshHardware()}>Refresh hardware</button>
                    </div>
                    {report ? (
                      <div className="data-list">
                        {report.checks.map((check) => (
                          <div className="data-row" key={check.name} style={{ padding: '8px 10px' }}>
                            <span className={`badge ${check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'danger' : 'warn'}`}>{check.status}</span>
                            <div className="data-main">
                              <div className="tiny" style={{ fontWeight: 600 }}>{check.name}</div>
                              <div className="tiny faint">{check.detail}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : <div className="tiny faint">Self-test exercises database, hardware detection, provider discovery, tools, PowerShell, screenshot, Playwright and MCP SDK. Results are saved locally.</div>}
                    <div className="divider" />
                    <button className="btn btn-danger btn-sm" type="button" onClick={() => {
                      if (!window.confirm('Reset all settings to defaults? Conversations, projects and files are not deleted.')) return
                      void api.settings.reset().then(() => window.location.reload())
                    }}>Reset settings</button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>LocalPilot AI {info.version}</h4><p>Local-first AI workstation for Windows.</p></div>
                  <div className="settings-section-body">
                    <div className="grid-2">
                      <div className="kv"><span className="k">Platform</span><span className="v">{info.platform} {info.arch}</span></div>
                      <div className="kv"><span className="k">Electron</span><span className="v">{info.electron}</span></div>
                      <div className="kv"><span className="k">Node</span><span className="v">{info.node}</span></div>
                      <div className="kv"><span className="k">Packaged</span><span className="v">{info.isPackaged ? 'installer build' : 'development'}</span></div>
                      <div className="kv"><span className="k">Tools registered</span><span className="v">{info.toolsCount}</span></div>
                      <div className="kv"><span className="k">Database</span><span className="v">{formatBytes(info.dbBytes)}</span></div>
                      <div className="kv"><span className="k">Local-only</span><span className="v">{settings.privacy.localOnly ? 'enforced' : 'available'}</span></div>
                    </div>
                    <div className="tiny faint pre-wrap mono" style={{ lineHeight: 1.6 }}>
                      data: {info.dataDir}{'\n'}models: {info.modelsDir}{'\n'}logs: {info.logsDir}
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head">
                    <h4>Software updates</h4>
                    <p>Installed builds check GitHub Releases at launch and every four hours. Updates download in the background and never restart without your action.</p>
                  </div>
                  <div className="settings-section-body">
                    <div className="row wrap">
                      <button className="btn btn-sm" type="button" disabled={busy === 'update-check'} onClick={() => void checkForUpdates()}>
                        {busy === 'update-check' ? <Spinner /> : <Icon name="refresh" size={11} />} Check for updates
                      </button>
                      {updateStatus?.phase === 'downloaded' ? (
                        <button className="btn btn-sm btn-primary" type="button" disabled={busy === 'update-install'} onClick={() => void installUpdate()}>
                          {busy === 'update-install' ? <Spinner /> : <Icon name="download" size={11} />} Restart and install {updateStatus.version}
                        </button>
                      ) : null}
                      <span className="tiny faint">{updateSummary(updateStatus, info.version)}</span>
                    </div>
                    {updateStatus?.phase === 'downloading' ? (
                      <div className="progress" aria-label={`Update download ${Math.round(updateStatus.percent ?? 0)}% complete`}>
                        <span style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent ?? 0))}%` }} />
                      </div>
                    ) : null}
                    {updateStatus?.releaseNotes ? (
                      <div className="tiny faint pre-wrap" style={{ maxHeight: 160, overflowY: 'auto', lineHeight: 1.55 }}>
                        {updateStatus.releaseNotes.replace(/<[^>]+>/g, ' ').trim()}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Runtime dependencies</h4></div>
                  <div className="settings-section-body">
                    <div className="tiny faint" style={{ lineHeight: 1.6 }}>
                      Local inference needs a local runtime (Ollama, LM Studio, llama.cpp) or a compatible endpoint.
                      Browser automation needs Microsoft Edge or Google Chrome installed. MCP presets use npx/uvx. Install
                      dependencies from the Model library and Plugin marketplace.
                    </div>
                    <div className="row">
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('models')}>Model library</button>
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('plugins')}>Plugins</button>
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-head"><h4>Safety</h4></div>
                  <div className="settings-section-body">
                    <div className="tiny faint" style={{ lineHeight: 1.6 }}>
                      Computer Use acts on the real desktop. Destructive tools require explicit approval. Press the
                      emergency shortcut ({settings.computer.stopShortcut}) to stop agent runs and kill tool processes.
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
