import { useEffect, useMemo, useState } from 'react'
import type { CatalogPlugin, McpServerConfig, PluginInfo } from '@shared/types'
import { Icon, type IconName } from '../components/Icons'
import { EmptyState, Field, Section, Spinner } from '../components/ui'
import { truncate } from '../lib/format'

const api = window.localpilot

type Tab = 'explore' | 'installed' | 'mcp'

const CATEGORY_ICONS: Record<string, IconName> = {
  'Computer Use': 'monitor',
  Development: 'terminal',
  Browser: 'globe',
  'Game Development': 'gamepad',
  Productivity: 'sparkles',
  'File System': 'folder',
  Testing: 'monitor',
  MCP: 'plug',
  builtin: 'zap'
}

export function PluginsPage() {
  const [tab, setTab] = useState<Tab>('explore')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([])
  const [mcp, setMcp] = useState<McpServerConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [detail, setDetail] = useState<PluginInfo | CatalogPlugin | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; tools: number; error?: string }>>({})
  const [overlayState, setOverlayState] = useState<{ active: boolean; stopKey: string; shortcutRegistered: boolean; label: string } | null>(null)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [mcpCommand, setMcpCommand] = useState('npx')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpEnv, setMcpEnv] = useState('{}')

  const refresh = async () => {
    try {
      const [nextPlugins, nextCatalog, nextMcp] = await Promise.all([
        api.plugins.list(),
        api.plugins.catalog(),
        api.plugins.mcpServers()
      ])
      setPlugins(nextPlugins)
      setCatalog(nextCatalog)
      setMcp(nextMcp)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (detail?.id !== 'app-tester') {
      setOverlayState(null)
      return
    }
    void api.computer.testMode('status').then(setOverlayState).catch(() => undefined)
  }, [detail])

  const installedById = useMemo(() => new Map(plugins.map((p) => [p.id, p])), [plugins])

  const categories = useMemo(() => {
    const values = new Set(catalog.map((p) => p.category).filter(Boolean))
    return ['All', ...[...values].sort()]
  }, [catalog])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog.filter((plugin) => {
      if (category !== 'All' && plugin.category !== category) return false
      if (!q) return true
      return `${plugin.name} ${plugin.author} ${plugin.description} ${plugin.category}`.toLowerCase().includes(q)
    })
  }, [catalog, category, query])

  const act = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(success)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const install = (item: CatalogPlugin) =>
    act(`install-${item.id}`, () => api.plugins.install(item.id), `${item.name} installed and enabled.`)

  const controlOverlay = async (action: 'start' | 'stop') => {
    setBusy(`overlay-${action}`)
    setError(null)
    setNotice(null)
    try {
      const state = await api.computer.testMode(action)
      setOverlayState(state)
      if (action === 'start') {
        setDetail(null)
        setNotice(`AI test overlay active. Press ${state.stopKey} to stop.`)
      } else {
        setNotice('AI test overlay stopped. Any active run was cancelled.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggle = (plugin: PluginInfo, enabled: boolean) =>
    act(`toggle-${plugin.id}`, () => api.plugins.setEnabled(plugin.id, enabled), `${plugin.name} ${enabled ? 'enabled' : 'disabled'}.`)

  const uninstall = (plugin: PluginInfo) => {
    if (!window.confirm(`Uninstall ${plugin.name}? Its tools will be removed from the agent immediately.`)) return
    void act(`uninstall-${plugin.id}`, () => api.plugins.uninstall(plugin.id), `${plugin.name} uninstalled.`)
  }

  const manualInstall = async () => {
    setBusy('manual')
    setError(null)
    try {
      const plugin = await api.plugins.installFolder()
      if (plugin) {
        setNotice(`${plugin.name} installed from a local folder.`)
        await refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const addMcp = async () => {
    setError(null)
    let env: Record<string, string> = {}
    try {
      env = mcpEnv.trim() ? (JSON.parse(mcpEnv) as Record<string, string>) : {}
    } catch {
      setError('MCP environment must be a JSON object of string values.')
      return
    }
    setBusy('add-mcp')
    try {
      await api.plugins.addMcpServer({
        name: mcpName.trim() || 'Custom MCP server',
        transport: mcpTransport,
        command: mcpTransport === 'stdio' ? mcpCommand.trim() : undefined,
        args: mcpTransport === 'stdio' ? mcpArgs.split(/\s+/).filter(Boolean) : undefined,
        url: mcpTransport === 'http' ? mcpUrl.trim() : undefined,
        env,
        enabled: true,
        autoStart: true,
        source: 'manual'
      })
      setMcpOpen(false)
      setMcpName('')
      setMcpArgs('')
      setMcpUrl('')
      setMcpEnv('{}')
      setNotice('MCP server added. Start it from the MCP servers tab.')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Extensions</div>
            <h1 className="page-title">Plugin marketplace</h1>
            <p className="page-subtitle">
              Install real MCP servers and local plugin packs. Every plugin declares its permissions; disabling or
              uninstalling it removes its tools from the agent immediately. Packages are launched locally and are not
              vendors of LocalPilot.
            </p>
          </div>
          <div className="page-actions">
            <button className="btn" type="button" onClick={() => void refresh()}>
              <Icon name="refresh" size={13} /> Refresh
            </button>
            <button className="btn" type="button" disabled={busy === 'manual'} onClick={() => void manualInstall()}>
              {busy === 'manual' ? <Spinner /> : <Icon name="folder" size={13} />} Install from folder
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setMcpOpen(true)}>
              <Icon name="plus" size={13} /> Add MCP server
            </button>
          </div>
        </div>

        {error ? <div className="notice-row error" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /> {error}</div> : null}
        {notice ? <div className="notice-row info" style={{ marginBottom: 12 }}><Icon name="check" size={14} /> {notice}</div> : null}

        <div className="row" style={{ marginBottom: 16 }}>
          <div className="panel-tabs">
            <button className={`panel-tab ${tab === 'explore' ? 'active' : ''}`} type="button" onClick={() => setTab('explore')}>Explore</button>
            <button className={`panel-tab ${tab === 'installed' ? 'active' : ''}`} type="button" onClick={() => setTab('installed')}>Installed ({plugins.length})</button>
            <button className={`panel-tab ${tab === 'mcp' ? 'active' : ''}`} type="button" onClick={() => setTab('mcp')}>MCP servers ({mcp.length})</button>
          </div>
          <span className="grow" />
          {tab === 'explore' ? (
            <>
              <div className="search-box" style={{ margin: 0, width: 250 }}>
                <Icon name="search" size={13} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins" />
              </div>
              <select className="select select-sm" style={{ width: 160 }} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </>
          ) : null}
        </div>

        {loading ? (
          <div className="card"><Spinner /> <span className="tiny faint">Loading installed plugins…</span></div>
        ) : tab === 'explore' ? (
          <>
            <Section title="Featured and available" count={filtered.length}>
              {filtered.length ? (
                <div className="plugin-grid">
                  {filtered
                    .sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
                    .map((item) => {
                      const installed = installedById.get(item.id)
                      return (
                        <div className={`plugin-card ${item.featured ? 'featured' : ''}`} key={item.id}>
                          <div className="plugin-top">
                            <div className="plugin-icon"><Icon name={CATEGORY_ICONS[item.category] ?? 'plugin'} size={18} /></div>
                            <div className="grow">
                              <div className="plugin-name">{item.name}</div>
                              <div className="plugin-author">{item.author} · v{item.version} · {item.category}</div>
                            </div>
                            {item.featured ? <span className="badge accent">featured</span> : null}
                          </div>
                          <div className="plugin-desc">{item.description}</div>
                          <div className="plugin-perms">
                            {item.permissions.slice(0, 4).map((permission) => <span className="badge" key={permission}>{permission}</span>)}
                            {item.permissions.length > 4 ? <span className="badge">+{item.permissions.length - 4}</span> : null}
                            <span className="badge">{item.installKind === 'mcp' ? 'MCP' : 'built-in'}</span>
                          </div>
                          {item.requirements ? <div className="tiny faint">{truncate(item.requirements, 140)}</div> : null}
                          <div className="plugin-foot">
                            {installed ? (
                              <>
                                <span className={`badge ${installed.enabled ? 'ok' : 'warn'}`}>{installed.enabled ? 'enabled' : 'disabled'}</span>
                                <span className="grow" />
                                <button className="btn btn-sm" type="button" onClick={() => setDetail(installed)}>Manage</button>
                              </>
                            ) : (
                              <>
                                <button className="btn btn-sm btn-primary" type="button" disabled={busy === `install-${item.id}`} onClick={() => void install(item)}>
                                  {busy === `install-${item.id}` ? <Spinner /> : <Icon name="download" size={11} />} Install
                                </button>
                                <span className="grow" />
                                <button className="icon-btn" type="button" onClick={() => setDetail(item)} title="Details"><Icon name="eye" size={13} /></button>
                                {item.homepage ? <button className="icon-btn" type="button" title="Homepage" onClick={() => void api.app.openExternal(item.homepage!)}><Icon name="external" size={13} /></button> : null}
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                </div>
              ) : (
                <EmptyState icon="plugin" title="No matching plugins">Try a different search or category.</EmptyState>
              )}
            </Section>
            <Section title="How plugin permissions work">
              <div className="card">
                <p className="card-sub" style={{ lineHeight: 1.65 }}>
                  Built-in tools ship with LocalPilot and are governed by the approval broker. Native plugins run in a
                  separate child process with a declared permission manifest, but they are not OS-sandboxed — install only
                  plugins you trust. MCP servers are launched via <span className="mono">npx</span>/<span className="mono">uvx</span> using
                  their real packages; network access and credentials are theirs, not LocalPilot’s. Removing a plugin revokes
                  its tools immediately; tool calls in progress are stopped by <b>Stop</b> or the emergency shortcut.
                </p>
              </div>
            </Section>
          </>
        ) : tab === 'installed' ? (
          <Section title="Installed plugins" count={plugins.length}>
            {plugins.length ? (
              <div className="data-list">
                {plugins.map((plugin) => (
                  <div className="data-row" key={plugin.id}>
                    <div className="plugin-icon" style={{ width: 30, height: 30 }}>
                      <Icon name={CATEGORY_ICONS[plugin.category] ?? 'plugin'} size={15} />
                    </div>
                    <div className="data-main">
                      <div className="data-name">
                        {plugin.name}
                        <span className="badge">{plugin.version}</span>
                        <span className={`badge ${plugin.enabled ? 'ok' : 'warn'}`}>{plugin.enabled ? 'enabled' : 'disabled'}</span>
                        <span className="badge">{plugin.source}</span>
                        {plugin.error ? <span className="badge danger">error</span> : null}
                      </div>
                      <div className="data-sub">
                        <span>{plugin.author}</span>
                        <span>{plugin.tools?.length ?? 0} tools</span>
                        {plugin.permissions.slice(0, 3).map((p) => <span key={p}>{p}</span>)}
                      </div>
                      {plugin.error ? <div className="tiny text-danger" style={{ marginTop: 3 }}>{plugin.error}</div> : null}
                    </div>
                    <div className="data-actions">
                      <button className="btn btn-sm" type="button" onClick={() => setDetail(plugin)}>Details</button>
                      <button className="btn btn-sm btn-ghost" type="button" disabled={busy === `uninstall-${plugin.id}`} onClick={() => uninstall(plugin)}>Uninstall</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="plugin" title="No plugins installed">Install one from Explore, or add an MCP server.</EmptyState>
            )}
          </Section>
        ) : (
          <>
            <Section title="Configured MCP servers" count={mcp.length}
              actions={<button className="btn btn-sm" type="button" onClick={() => setMcpOpen(true)}><Icon name="plus" size={11} /> Add</button>}>
              {mcp.length ? (
                <div className="stack">
                  {mcp.map((server) => {
                    const plugin = plugins.find((p) => p.id === `mcp:${server.id}` || p.mcp?.id === server.id)
                    const test = testResults[server.id]
                    return (
                      <div className="card" key={server.id}>
                        <div className="row between" style={{ alignItems: 'flex-start' }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="card-title">
                              {server.name}
                              <span className="badge">{server.transport}</span>
                              <span className={`badge ${plugin?.enabled ? 'ok' : ''}`}>{plugin?.enabled ? 'connected/enabled' : 'stopped'}</span>
                            </div>
                            <div className="tiny faint mono" style={{ wordBreak: 'break-all' }}>
                              {server.transport === 'stdio' ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}` : server.url}
                            </div>
                            {server.notes ? <div className="tiny faint" style={{ marginTop: 4 }}>{server.notes}</div> : null}
                          </div>
                          <div className="row">
                            <button className="btn btn-sm" type="button" disabled={busy === `mcp-test-${server.id}`} onClick={() => void (async () => {
                              setBusy(`mcp-test-${server.id}`)
                              try {
                                const result = await api.plugins.testMcp(server.id)
                                setTestResults((prev) => ({ ...prev, [server.id]: result }))
                              } catch (err) {
                                setTestResults((prev) => ({ ...prev, [server.id]: { ok: false, tools: 0, error: err instanceof Error ? err.message : String(err) } }))
                              } finally {
                                setBusy(null)
                              }
                            })()}>
                              {busy === `mcp-test-${server.id}` ? <Spinner /> : <Icon name="plug" size={11} />} Test
                            </button>
                            <button className="btn btn-sm" type="button" disabled={busy === `mcp-start-${server.id}`} onClick={() => void act(`mcp-start-${server.id}`, () => api.plugins.startMcp(server.id), `${server.name} started.`)}>
                              {busy === `mcp-start-${server.id}` ? <Spinner /> : <Icon name="play" size={10} />} Start
                            </button>
                            <button className="btn btn-sm btn-ghost" type="button" onClick={() => void act(`mcp-stop-${server.id}`, () => api.plugins.stopMcp(server.id), `${server.name} stopped.`)}>Stop</button>
                          </div>
                        </div>
                        {test ? (
                          <div className={`notice-row ${test.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>
                            <Icon name={test.ok ? 'check' : 'alert'} size={12} />
                            <span>{test.ok ? `Connected — ${test.tools} tools discovered.` : test.error ?? 'MCP test failed.'}</span>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <EmptyState icon="plug" title="No MCP servers configured">
                  Add a real MCP package (for example Roblox Studio or Playwright) from the Explore catalog, or register a
                  server manually. LocalPilot launches the server process locally.
                </EmptyState>
              )}
            </Section>
            <Section title="Preset packages">
              <div className="grid-auto">
                {catalog.filter((p) => p.installKind === 'mcp').map((item) => {
                  const installed = installedById.get(item.id)
                  return (
                    <div className="card tight" key={item.id}>
                      <div className="card-title">{item.name} {installed ? <span className="badge ok">installed</span> : null}</div>
                      <p className="card-sub">{truncate(item.description, 160)}</p>
                      {item.requirements ? <div className="tiny faint mt-8">{item.requirements}</div> : null}
                      <div className="row mt-8">
                        {!installed ? (
                          <button className="btn btn-sm btn-primary" type="button" onClick={() => void install(item)} disabled={busy === `install-${item.id}`}>
                            {busy === `install-${item.id}` ? <Spinner /> : <Icon name="plus" size={11} />} Install preset
                          </button>
                        ) : <span className="tiny faint">Manage it in the list above.</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          </>
        )}
      </div>

      {mcpOpen ? (
        <div className="overlay" onClick={() => setMcpOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="grow">
                <h3>Add MCP server</h3>
                <div className="sub">Register a Model Context Protocol server. It will be launched as a local process or contacted at the URL you provide.</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setMcpOpen(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <Field label="Display name"><input className="input" value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="My MCP server" /></Field>
              <Field label="Transport">
                <select className="select" value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http')}>
                  <option value="stdio">stdio (local process)</option>
                  <option value="http">Streamable HTTP</option>
                </select>
              </Field>
              {mcpTransport === 'stdio' ? (
                <>
                  <Field label="Command" hint="e.g. npx, uvx, or an absolute executable path."><input className="input" value={mcpCommand} onChange={(e) => setMcpCommand(e.target.value)} /></Field>
                  <Field label="Arguments" hint="Space-separated package and flags."><input className="input" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem C:\\path" /></Field>
                </>
              ) : (
                <Field label="Server URL"><input className="input" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="http://127.0.0.1:3000/mcp" /></Field>
              )}
              <Field label="Environment (JSON)" hint="Optional. Values are stored in the local database; prefer the server’s own secret store where possible.">
                <textarea className="textarea mono" style={{ fontSize: 11 }} value={mcpEnv} onChange={(e) => setMcpEnv(e.target.value)} />
              </Field>
              <div className="plugin-note">Only connect MCP servers you trust. Their tools can access resources according to the server’s own permissions.</div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" type="button" onClick={() => setMcpOpen(false)}>Cancel</button>
              <button className="btn btn-primary" type="button" disabled={busy === 'add-mcp' || (mcpTransport === 'stdio' ? !mcpCommand.trim() : !mcpUrl.trim())} onClick={() => void addMcp()}>
                {busy === 'add-mcp' ? <Spinner /> : <Icon name="plus" size={12} />} Add server
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detail ? (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="grow">
                <h3>{detail.name}</h3>
                <div className="sub">{detail.author} · v{detail.version} · {(detail as PluginInfo).source ?? (detail as CatalogPlugin).installKind}</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setDetail(null)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <p className="permission-detail">{detail.description}</p>
              <div className="model-capabilities">
                {detail.permissions.map((permission) => <span className="badge" key={permission}>{permission}</span>)}
                {detail.os.map((osValue) => <span className="badge" key={osValue}>{osValue}</span>)}
              </div>
              {detail.id === 'app-tester' && 'enabled' in detail && detail.enabled ? (
                <div className="plugin-note">
                  <div className="field-label" style={{ marginBottom: 5 }}>AI takeover overlay</div>
                  <div className="tiny faint" style={{ lineHeight: 1.6 }}>
                    Preview the click-through testing overlay: a green AI cursor and a full-screen border show that
                    the AI has taken over. Press <b>Esc</b> at any time to stop the active run. The overlay asks Windows
                    to exclude it from captures so it does not hide the app or game under test.
                  </div>
                  <div className="row mt-8">
                    <button className="btn btn-sm btn-primary" type="button" disabled={busy === 'overlay-start'} onClick={() => void controlOverlay('start')}>
                      {busy === 'overlay-start' ? <Spinner /> : <Icon name="play" size={11} />} Preview overlay
                    </button>
                    <button className="btn btn-sm" type="button" disabled={busy === 'overlay-stop' || !overlayState?.active} onClick={() => void controlOverlay('stop')}>
                      {busy === 'overlay-stop' ? <Spinner /> : null} Stop overlay
                    </button>
                    {overlayState?.active ? <span className="badge ok">active · {overlayState.stopKey}</span> : null}
                  </div>
                </div>
              ) : null}
              {(detail as CatalogPlugin).requirements ? <div className="plugin-note">{(detail as CatalogPlugin).requirements}</div> : null}
              {(detail as CatalogPlugin).notes ? <div className="plugin-note">{(detail as CatalogPlugin).notes}</div> : null}
              {(detail as CatalogPlugin).remote ? <div className="plugin-note">This plugin may contact an external service. It is not local inference; check the vendor’s terms and fees.</div> : null}
              {(detail as PluginInfo).tools?.length ? (
                <div>
                  <div className="field-label" style={{ marginBottom: 7 }}>Tools contributed</div>
                  {(detail as PluginInfo).tools!.map((tool) => (
                    <div className="tool-row" key={tool.name}>
                      <span className="name">{tool.name}</span>
                      <span className={`badge ${tool.risk === 'high' ? 'danger' : tool.risk === 'medium' ? 'warn' : ''}`}>{tool.risk}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {(detail as PluginInfo).mcp ? (
                <div>
                  <div className="field-label" style={{ marginBottom: 7 }}>MCP server</div>
                  <pre className="permission-args">{JSON.stringify({
                    transport: (detail as PluginInfo).mcp?.transport,
                    command: (detail as PluginInfo).mcp?.command,
                    args: (detail as PluginInfo).mcp?.args,
                    url: (detail as PluginInfo).mcp?.url
                  }, null, 2)}</pre>
                </div>
              ) : null}
              {(detail as PluginInfo).homepage ? (
                <button className="btn btn-sm" type="button" onClick={() => void api.app.openExternal((detail as PluginInfo).homepage!)}>
                  <Icon name="external" size={11} /> Source / homepage
                </button>
              ) : null}
            </div>
            <div className="modal-foot">
              {'enabled' in detail ? (
                <>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => void act(`uninstall-${detail.id}`, () => api.plugins.uninstall(detail.id), `${detail.name} uninstalled.`).then(() => setDetail(null))}
                  >
                    Uninstall
                  </button>
                  <button
                    className={`btn ${detail.enabled ? '' : 'btn-primary'}`}
                    type="button"
                    disabled={busy === `toggle-${detail.id}`}
                    onClick={() => void toggle(detail as PluginInfo, !(detail as PluginInfo).enabled)}
                  >
                    {busy === `toggle-${detail.id}` ? <Spinner /> : null}
                    {(detail as PluginInfo).enabled ? 'Disable plugin' : 'Enable plugin'}
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy === `install-${detail.id}`}
                  onClick={() => void act(`install-${detail.id}`, () => api.plugins.install(detail.id), `${detail.name} installed.`).then(() => setDetail(null))}
                >
                  {busy === `install-${detail.id}` ? <Spinner /> : <Icon name="download" size={12} />} Install
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
