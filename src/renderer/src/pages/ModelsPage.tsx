import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  DownloadTask,
  HardwareInfo,
  LlamaRuntimeStatus,
  LocalModelFile,
  ModelCatalogItem,
  ModelInfo,
  ProviderConfig,
  ProviderStatus
} from '@shared/types'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Section, Spinner, Toggle } from '../components/ui'
import { formatBytes, formatNumber } from '../lib/format'

const api = window.localpilot

interface Props {
  settings: AppSettings
  models: ModelInfo[]
  providers: ProviderStatus[]
  hardware: HardwareInfo | null
  selected: { providerId: string; modelId: string } | null
  onSelectModel: (providerId: string, modelId: string) => void
  onRefresh: () => Promise<void>
  onUpdateSettings: (patch: Record<string, unknown>) => Promise<AppSettings>
  onHardware: (hardware: HardwareInfo) => void
}

export function ModelsPage({
  settings,
  models,
  providers,
  hardware,
  selected,
  onSelectModel,
  onRefresh,
  onUpdateSettings,
  onHardware
}: Props) {
  const [downloads, setDownloads] = useState<DownloadTask[]>([])
  const [localModels, setLocalModels] = useState<LocalModelFile[]>([])
  const [catalog, setCatalog] = useState<ModelCatalogItem[]>([])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogSource, setCatalogSource] = useState<'curated' | 'huggingface' | 'ollama'>('curated')
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ model: ModelInfo; data: Record<string, unknown> } | null>(null)
  const [hfItem, setHfItem] = useState<ModelCatalogItem | null>(null)
  const [hfFiles, setHfFiles] = useState<{ name: string; sizeBytes?: number }[]>([])
  const [hfBusy, setHfBusy] = useState(false)
  const [endpointOpen, setEndpointOpen] = useState(false)
  const [endpointName, setEndpointName] = useState('')
  const [endpointUrl, setEndpointUrl] = useState('http://127.0.0.1:8080/v1')
  const [endpointType, setEndpointType] = useState<'ollama' | 'openai'>('openai')
  const [llamaProvider, setLlamaProvider] = useState<ProviderStatus | null>(null)
  const [runtime, setRuntime] = useState<LlamaRuntimeStatus | null>(null)
  const [hardwareBusy, setHardwareBusy] = useState(false)
  const [dependencies, setDependencies] = useState<Awaited<ReturnType<typeof api.models.dependencies>>>([])

  const refreshDownloads = useCallback(async () => {
    try {
      setDownloads(await api.models.downloads())
    } catch {
      // ignore
    }
  }, [])

  const refreshLocal = useCallback(async () => {
    try {
      setLocalModels(await api.models.localModels())
    } catch {
      // ignore
    }
  }, [])

  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await api.models.llamaRuntime())
    } catch {
      // status is best-effort
    }
  }, [])

  useEffect(() => {
    void refreshDownloads()
    void refreshLocal()
    void refreshRuntime()
    void api.models.dependencies().then(setDependencies).catch(() => undefined)
    void api.models.providers().then((list) => setLlamaProvider(list.find((p) => p.id === 'llamacpp') ?? null)).catch(() => undefined)
    const timer = setInterval(() => {
      void refreshDownloads()
    }, 2000)
    return () => clearInterval(timer)
  }, [refreshDownloads, refreshLocal, refreshRuntime])

  const searchCatalog = async () => {
    setCatalogBusy(true)
    setCatalogError(null)
    try {
      setCatalog(await api.models.catalogSearch(catalogQuery, catalogSource))
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
    } finally {
      setCatalogBusy(false)
    }
  }

  useEffect(() => {
    void (async () => {
      setCatalogBusy(true)
      try {
        setCatalog(await api.models.catalogSearch('', 'curated'))
      } catch {
        // The curated list is local and should always load.
      } finally {
        setCatalogBusy(false)
      }
    })()
  }, [])

  const vram = hardware?.gpus[0]?.vramBytes
  const ram = hardware?.ram.totalBytes

  const runAction = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (success) setNotice(success)
      await onRefresh()
      await refreshDownloads()
      await refreshLocal()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const pull = async (item: ModelCatalogItem) => {
    const name = item.pullName ?? item.name
    setCatalogError(null)
    try {
      await api.models.pullOllama(name)
      await refreshDownloads()
      setNotice(`Ollama pull started for ${name}. Progress appears under Downloads.`)
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
    }
  }

  const openHf = async (item: ModelCatalogItem) => {
    setHfItem(item)
    setHfBusy(true)
    setCatalogError(null)
    try {
      setHfFiles(await api.models.hfFiles(item.id))
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
      setHfFiles([])
    } finally {
      setHfBusy(false)
    }
  }

  const downloadHf = async (file: string) => {
    if (!hfItem) return
    try {
      await api.models.downloadGguf(hfItem.id, file)
      setHfItem(null)
      await refreshDownloads()
      setNotice(`Download started: ${file}. It will appear under Local GGUF files when it finishes.`)
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
    }
  }

  const installRuntime = async () => {
    setBusy('runtime-install')
    setError(null)
    setNotice(null)
    try {
      await api.models.installLlamaRuntime()
      await refreshDownloads()
      setNotice('Downloading the local engine. Progress appears under Downloads.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const startLocalEngine = async (file: LocalModelFile) => {
    setBusy(file.id)
    setError(null)
    setNotice(null)
    try {
      const status = await api.models.launchLlama(file.filePath, {
        contextLength: hardware?.recommendations.contextLength,
        gpuLayers: hardware?.recommendations.gpuLayers
      })
      if (!status.running) throw new Error(status.error ?? 'The local engine did not start.')
      const discovered = await api.models.discover(true)
      const loaded = discovered.find((model) => model.providerId === 'llamacpp')
      await onRefresh()
      await refreshRuntime()
      if (loaded) {
        onSelectModel(loaded.providerId, loaded.id)
        setNotice(`${file.name} is loaded and selected. No Ollama process is needed.`)
      } else {
        setNotice(`${file.name} is loaded. The engine is running locally.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const addEndpoint = async () => {
    setBusy('endpoint')
    setError(null)
    try {
      await api.models.addEndpoint({ name: endpointName.trim() || 'Custom local endpoint', baseUrl: endpointUrl.trim(), type: endpointType })
      setEndpointOpen(false)
      setEndpointName('')
      await onRefresh()
      setNotice('Custom local endpoint added.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const activeDownloads = downloads.filter((d) => d.status === 'running' || d.status === 'queued')
  const runtimeTask = downloads.find((task) => task.kind === 'runtime')
  const runtimeTaskKey = runtimeTask ? `${runtimeTask.id}:${runtimeTask.status}` : ''
  const completedGguf = downloads.find((task) => task.kind === 'gguf' && task.status === 'done')
  const completedGgufKey = completedGguf?.id ?? ''
  const chatModels = useMemo(() => models.filter((m) => m.kind === 'chat'), [models])

  useEffect(() => {
    if (!runtimeTaskKey.endsWith(':done') && !runtimeTaskKey.endsWith(':error') && !runtimeTaskKey.endsWith(':cancelled')) return
    void refreshRuntime()
    void api.models.dependencies().then(setDependencies).catch(() => undefined)
    if (runtimeTaskKey.endsWith(':done')) void onRefresh()
  }, [runtimeTaskKey, refreshRuntime, onRefresh])

  useEffect(() => {
    if (!completedGgufKey) return
    void refreshLocal()
    setNotice(`Download finished: ${completedGguf?.name ?? 'model'}. Use Load & use under Local GGUF files.`)
  }, [completedGgufKey, completedGguf?.name, refreshLocal])

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Local inference</div>
            <h1 className="page-title">Model library</h1>
            <p className="page-subtitle">
              Download a model and run it with LocalPilot’s own engine. Ollama and LM Studio are optional; LocalPilot
              never silently switches to a cloud provider.
            </p>
          </div>
          <div className="page-actions">
            <button className="btn" type="button" onClick={() => void onRefresh()}>
              <Icon name="refresh" size={13} /> Detect runtimes
            </button>
            <button className="btn" type="button" onClick={() => void runAction('import', async () => {
              const file = await api.models.importGguf()
              if (file) setNotice(`Imported ${file.name}. Launch it with llama.cpp below.`)
            })} disabled={busy === 'import'}>
              {busy === 'import' ? <Spinner /> : <Icon name="upload" size={13} />} Import GGUF
            </button>
          </div>
        </div>

        {error ? (
          <div className="notice-row error" style={{ marginBottom: 14 }}>
            <Icon name="alert" size={14} /> <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="notice-row info" style={{ marginBottom: 14 }}>
            <Icon name="check" size={14} /> <span>{notice}</span>
          </div>
        ) : null}

        <Section title="Hardware" hint={hardware ? `Captured ${new Date(hardware.capturedAt).toLocaleTimeString()}` : 'Detecting…'}
          actions={
            <button className="btn btn-sm" type="button" disabled={hardwareBusy} onClick={() => void (async () => {
              setHardwareBusy(true)
              try {
                onHardware(await api.models.hardware(true))
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setHardwareBusy(false)
              }
            })()}>
              {hardwareBusy ? <Spinner /> : <Icon name="refresh" size={11} />} Refresh
            </button>
          }>
          {hardware ? (
            <>
              <div className="grid-3">
                <div className="card tight">
                  <div className="panel-label">GPU</div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{hardware.gpus[0]?.name ?? 'No discrete GPU detected'}</div>
                  <div className="tiny faint mt-8">
                    {hardware.gpus[0]?.vramBytes ? `${formatBytes(hardware.gpus[0].vramBytes)} VRAM` : 'CPU inference'}
                    {hardware.gpus[0]?.driver ? ` · driver ${hardware.gpus[0].driver}` : ''}
                  </div>
                  <div className="row wrap" style={{ marginTop: 8 }}>
                    <span className={`badge ${hardware.acceleration.cuda ? 'ok' : ''}`}>CUDA {hardware.acceleration.cuda ? 'detected' : 'no'}</span>
                    <span className={`badge ${hardware.acceleration.vulkan ? 'ok' : ''}`}>Vulkan {hardware.acceleration.vulkan ? 'available' : 'unknown'}</span>
                    <span className={`badge ${hardware.acceleration.rocm ? 'warn' : ''}`}>ROCm {hardware.acceleration.rocm ? 'assumed' : 'not assumed'}</span>
                  </div>
                </div>
                <div className="card tight">
                  <div className="panel-label">CPU & memory</div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{hardware.cpu.model}</div>
                  <div className="tiny faint mt-8">
                    {hardware.cpu.cores} cores / {hardware.cpu.threads} threads · {formatBytes(hardware.ram.totalBytes)} RAM
                    {hardware.ram.availableBytes ? ` (${formatBytes(hardware.ram.availableBytes)} free)` : ''}
                  </div>
                  <div className="tiny faint mt-8">{hardware.disks.map((d) => `${d.name}: ${formatBytes(d.freeBytes)} free`).join(' · ')}</div>
                </div>
                <div className="card tight">
                  <div className="panel-label">Recommendation</div>
                  <div className="tiny" style={{ lineHeight: 1.55 }}>{hardware.recommendations.summary}</div>
                  <div className="row wrap" style={{ marginTop: 8 }}>
                    <span className="badge accent">{hardware.recommendations.gpuLayers} GPU layers</span>
                    <span className="badge">{Math.round(hardware.recommendations.contextLength / 1024)}k ctx</span>
                    <span className="badge">{hardware.recommendations.quantization}</span>
                  </div>
                </div>
              </div>
              <div className="tiny faint" style={{ marginTop: 8 }}>
                AMD GPUs use Vulkan where a llama.cpp Vulkan build is configured. LocalPilot does not assume ROCm is
                available on Windows; CUDA is used when the runtime reports it.
              </div>
            </>
          ) : (
            <div className="card tight tiny faint">Hardware detection has not completed.</div>
          )}
        </Section>

        <Section title="Providers" count={providers.length}
          actions={<button className="btn btn-sm" type="button" onClick={() => setEndpointOpen(true)}><Icon name="plus" size={11} /> Add endpoint</button>}>
          <div className="provider-grid">
            {providers.map((provider) => (
              <div className="provider-card" key={provider.id}>
                <div className="provider-head">
                  <div className="provider-logo">
                    <Icon name={provider.type === 'ollama' ? 'cpu' : 'monitor'} size={15} />
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="name">{provider.name}</div>
                    <div className="url" title={provider.baseUrl}>{provider.baseUrl}</div>
                  </div>
                  <span className={`badge ${provider.running ? 'ok' : 'warn'}`}>{provider.running ? 'online' : 'offline'}</span>
                </div>
                <div className="provider-stats">
                  <span className="badge">{provider.running ? `${provider.modelCount ?? 0} models` : provider.installed === false ? 'not installed' : 'not running'}</span>
                  {provider.version ? <span className="badge mono">v{provider.version}</span> : null}
                  <span className="badge">{provider.type}</span>
                </div>
                {!provider.running && provider.error ? <div className="tiny faint" style={{ lineHeight: 1.4 }}>{provider.error}</div> : null}
                <div className="actions">
                  <button className="btn btn-sm" type="button" disabled={busy === `provider-${provider.id}`} onClick={() => void runAction(`provider-${provider.id}`, () => api.models.startProvider(provider.id), `${provider.name} started.`)}>
                    {busy === `provider-${provider.id}` ? <Spinner /> : <Icon name="play" size={10} />} Start
                  </button>
                  {!provider.managed ? (
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => void runAction(`remove-${provider.id}`, () => api.models.removeEndpoint(provider.id), 'Endpoint removed.')}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Local engine" hint="Managed llama.cpp · no Ollama required">
          <div className="card">
            <div className="row between wrap" style={{ alignItems: 'flex-start', gap: 14 }}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="icon-wrap"><Icon name="cpu" size={16} /></div>
                <div>
                  <div className="card-title" style={{ margin: 0 }}>
                    Run GGUF models inside LocalPilot
                    <span className={`badge ${runtime?.installed ? 'ok' : runtime?.running ? 'ok' : 'warn'}`}>
                      {runtime?.running ? 'running' : runtime?.installed ? 'installed' : 'not installed'}
                    </span>
                  </div>
                  <div className="card-sub" style={{ maxWidth: 620 }}>
                    LocalPilot downloads and starts its own llama.cpp engine. You do not need to install Ollama or keep
                    another app open on this PC.
                  </div>
                  {runtime?.path ? (
                    <div className="tiny faint mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
                      {runtime.variant ? `${runtime.variant} build · ` : ''}{runtime.path}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="row wrap">
                {runtime?.installed ? (
                  <button
                    className="btn btn-success"
                    type="button"
                    disabled={!localModels.length || runtime.running || busy === localModels[0]?.id}
                    onClick={() => localModels[0] ? void startLocalEngine(localModels[0]) : undefined}
                    title={!localModels.length ? 'Download a model from the catalog first' : undefined}
                  >
                    {busy === localModels[0]?.id ? <Spinner /> : <Icon name={runtime.running ? 'check' : 'play'} size={12} />}
                    {runtime.running ? 'Engine running' : 'Start local engine'}
                  </button>
                ) : (
                  <button
                    className="btn btn-success"
                    type="button"
                    disabled={busy === 'runtime-install' || runtimeTask?.status === 'running' || runtimeTask?.status === 'queued'}
                    onClick={() => void installRuntime()}
                  >
                    {busy === 'runtime-install' || runtimeTask?.status === 'running' || runtimeTask?.status === 'queued' ? <Spinner /> : <Icon name="download" size={12} />}
                    Install local engine
                  </button>
                )}
              </div>
            </div>
            {runtimeTask && (runtimeTask.status === 'running' || runtimeTask.status === 'queued') ? (
              <div style={{ marginTop: 12 }}>
                <div className="row between tiny faint">
                  <span>{runtimeTask.name}</span>
                  <span>{formatBytes(runtimeTask.receivedBytes ?? 0)} / {formatBytes(runtimeTask.totalBytes ?? 0)}</span>
                </div>
                <div className="progress mt-8"><span style={{ width: `${Math.max(2, Math.min(100, runtimeTask.progress))}%` }} /></div>
              </div>
            ) : null}
            {runtimeTask?.status === 'error' && runtimeTask.error ? (
              <div className="notice-row error" style={{ marginTop: 10 }}>
                <Icon name="alert" size={12} /> {runtimeTask.error}
              </div>
            ) : null}
            {!localModels.length ? (
              <div className="tiny faint" style={{ marginTop: 10 }}>
                After installing the engine, download a model below. Green Download buttons open the available quantizations.
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Installed models" count={chatModels.length}
          hint={settings.models.defaultModelId ? `default: ${settings.models.defaultModelId}` : 'No default model yet'}>
          {models.length ? (
            <div className="data-list">
              {models.map((model) => {
                const size = model.sizeBytes ?? 0
                const fitsVram = vram ? size > 0 && size <= vram * 0.95 : false
                const likelyTooLarge = ram && size > 0 && size > ram * 0.8
                return (
                  <div className="data-row" key={`${model.providerId}:${model.id}`}>
                    <div className="data-main">
                      <div className="data-name">
                        {model.name}
                        {selected?.providerId === model.providerId && selected?.modelId === model.id ? <span className="badge accent">selected</span> : null}
                        {model.loaded ? <span className="badge ok">loaded</span> : null}
                        {likelyTooLarge ? <span className="badge danger">may not fit RAM</span> : vram && size > 0 && !fitsVram ? <span className="badge warn">partial GPU offload</span> : null}
                      </div>
                      <div className="data-sub">
                        <span>{model.providerName}</span>
                        <span>{formatBytes(size)}</span>
                        {model.parameterSize ? <span>{model.parameterSize}</span> : null}
                        {model.quantization ? <span>{model.quantization}</span> : null}
                        {model.contextLength ? <span>{formatNumber(model.contextLength)} ctx</span> : null}
                        {model.loaded && model.vramBytes ? <span>{formatBytes(model.vramBytes)} VRAM</span> : null}
                      </div>
                      <div className="model-capabilities">
                        <span className={`cap ${model.capabilities.tools ? 'reported' : ''}`}>{model.capabilities.tools ? 'tools' : 'no tools'}</span>
                        <span className={`cap ${model.capabilities.vision ? 'reported' : ''}`}>{model.capabilities.vision ? 'vision' : 'text'}</span>
                        <span className={`cap ${model.capabilities.thinking ? 'reported' : ''}`}>{model.capabilities.thinking ? 'thinking' : 'no thinking'}</span>
                        <span className="cap">{model.capabilitySource}</span>
                        {model.family ? <span className="cap">{model.family}</span> : null}
                      </div>
                    </div>
                    <div className="data-actions">
                      <button className="btn btn-sm" type="button" onClick={() => onSelectModel(model.providerId, model.id)} disabled={selected?.providerId === model.providerId && selected?.modelId === model.id}>
                        {selected?.providerId === model.providerId && selected?.modelId === model.id ? 'In use' : 'Use'}
                      </button>
                      <button className="icon-btn" type="button" title="Model metadata" onClick={() => void (async () => {
                        try {
                          setDetail({ model, data: await api.models.show(model.id) })
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err))
                        }
                      })()}>
                        <Icon name="eye" size={13} />
                      </button>
                      {model.loaded ? (
                        <button className="icon-btn" type="button" title="Unload from memory" onClick={() => void runAction(`unload-${model.id}`, () => api.models.unload(model.id, model.providerId), `${model.name} unloaded.`)}>
                          <Icon name="stop" size={12} />
                        </button>
                      ) : null}
                      {model.filePath ? (
                        <button className="icon-btn" type="button" title="Show model file" onClick={() => void api.app.showItemInFolder(model.filePath!)}>
                          <Icon name="folder" size={13} />
                        </button>
                      ) : null}
                      <button className="icon-btn danger" type="button" title="Delete model from disk" onClick={() => {
                        if (window.confirm(`Delete ${model.name} from ${model.providerName}? This removes the model files from disk.`)) {
                          void runAction(`delete-${model.id}`, () => api.models.delete(model.id, model.providerId), `${model.name} deleted.`)
                        }
                      }}>
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <EmptyState icon="cpu" title="No local models discovered">
              Install the local engine and download a model from the catalog below; Ollama is optional. No cloud key is
              required.
            </EmptyState>
          )}
        </Section>

        <Section title="Downloads" count={activeDownloads.length ? `${activeDownloads.length} active` : undefined}>
          {downloads.length ? (
            <div className="data-list">
              {downloads.slice(0, 10).map((task) => (
                <div className="data-row" key={task.id}>
                  <div className="data-main">
                    <div className="data-name">
                      {task.name}
                      <span className={`badge ${task.status === 'done' ? 'ok' : task.status === 'error' ? 'danger' : task.status === 'running' ? 'accent' : ''}`}>{task.status}</span>
                    </div>
                    <div className="data-sub">
                      <span>{task.kind === 'runtime' ? 'Local engine install' : task.kind === 'ollama' ? 'Ollama pull' : 'GGUF download'}</span>
                      <span>{formatBytes(task.receivedBytes)} / {formatBytes(task.totalBytes)}</span>
                      {task.speedBps ? <span>{formatBytes(task.speedBps)}/s</span> : null}
                      {task.error ? <span className="text-danger">{task.error}</span> : null}
                    </div>
                    {task.status === 'running' || task.status === 'queued' ? (
                      <div className="progress mt-8"><span style={{ width: `${Math.max(2, Math.min(100, task.progress))}%` }} /></div>
                    ) : null}
                  </div>
                  {task.status === 'running' || task.status === 'queued' ? (
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => void api.models.cancelDownload(task.id).then(refreshDownloads)}>Cancel</button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="card tight tiny faint">No downloads have been started in this session.</div>
          )}
        </Section>

        <Section title="Local GGUF files" count={localModels.length}
          hint="Downloaded and imported models · runs with the local engine"
          actions={<button className="btn btn-sm" type="button" onClick={() => void runAction('import2', () => api.models.importGguf())}><Icon name="upload" size={11} /> Import</button>}>
          {localModels.length ? (
            <>
              <div className="data-list">
                {localModels.map((file) => (
                  <div className="data-row" key={file.id}>
                    <div className="data-main">
                      <div className="data-name">{file.name}</div>
                      <div className="data-sub">
                        <span>{formatBytes(file.sizeBytes)}</span>
                        <span className="mono">{file.filePath}</span>
                      </div>
                    </div>
                    <div className="data-actions">
                      <button className="btn btn-sm btn-success" type="button" disabled={busy === file.id || !runtime?.installed} onClick={() => void startLocalEngine(file)}>
                        {busy === file.id ? <Spinner /> : <Icon name="play" size={10} />} Load & use
                      </button>
                      <button className="icon-btn" type="button" title="Show file" onClick={() => void api.app.showItemInFolder(file.filePath)}>
                        <Icon name="folder" size={13} />
                      </button>
                      <button className="icon-btn danger" type="button" title="Remove from registry" onClick={() => void runAction(`local-${file.id}`, () => api.models.removeLocalModel(file.id), 'Removed from the local registry.')}>
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row mt-8">
                <button className="btn btn-sm" type="button" onClick={() => void api.models.stopLlama().then(onRefresh)}>
                  <Icon name="stop" size={10} /> Stop llama.cpp server
                </button>
                <span className="tiny faint">
                  llama.cpp provider: {llamaProvider?.running ? `running at ${llamaProvider.baseUrl}` : 'not running'}
                  {settings.models.llamaServerPath ? ` · ${settings.models.llamaServerPath}` : ' · set llama-server.exe path in Settings → Models'}
                </span>
              </div>
            </>
          ) : (            <div className="card tight tiny faint">
              Download a model from the catalog, or import an existing .gguf file. Start the local engine above first;
              LocalPilot handles the Vulkan or CPU build for you.
            </div>
          )}
        </Section>

        <Section title="Runtime configuration">
          <div className="card">
            <div className="form-row">
              <Field label="Temperature" hint="Sampling temperature passed to local runtimes.">
                <input className="input" type="number" step="0.05" min="0" max="2" value={settings.models.temperature}
                  onChange={(e) => void onUpdateSettings({ models: { temperature: Number(e.target.value) } })} />
              </Field>
              <Field label="Top P">
                <input className="input" type="number" step="0.05" min="0" max="1" value={settings.models.topP}
                  onChange={(e) => void onUpdateSettings({ models: { topP: Number(e.target.value) } })} />
              </Field>
              <Field label="Max output tokens">
                <input className="input" type="number" min="64" value={settings.models.maxTokens}
                  onChange={(e) => void onUpdateSettings({ models: { maxTokens: Number(e.target.value) } })} />
              </Field>
              <Field label="Context length" hint="Capped by the model’s real context window.">
                <input className="input" type="number" min="1024" value={settings.models.contextLength}
                  onChange={(e) => void onUpdateSettings({ models: { contextLength: Number(e.target.value) } })} />
              </Field>
              <Field label="GPU layers" hint="-1 lets the runtime decide; 0 forces CPU.">
                <input className="input" type="number" min="-1" value={settings.models.gpuLayers}
                  onChange={(e) => void onUpdateSettings({ models: { gpuLayers: Number(e.target.value) } })} />
              </Field>
              <Field label="Ollama keep-alive">
                <input className="input" value={settings.models.keepAlive}
                  onChange={(e) => void onUpdateSettings({ models: { keepAlive: e.target.value } })} />
              </Field>
            </div>
            <div className="setting-row mt-16">
              <div className="info">
                <div className="t">Stream responses</div>
                <div className="d">Stream tokens from the local runtime as they are generated.</div>
              </div>
              <Toggle checked={settings.models.stream} onChange={(v) => void onUpdateSettings({ models: { stream: v } })} />
            </div>
          </div>
        </Section>

        <Section title="Browse the model catalog" hint="Recommended GGUF models · green Download · Ollama optional">
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="search-box grow" style={{ margin: 0 }}>
              <Icon name="search" size={13} />
              <input value={catalogQuery} onChange={(e) => setCatalogQuery(e.target.value)} placeholder="Search qwen, llama, deepseek, roblox…" onKeyDown={(e) => { if (e.key === 'Enter') void searchCatalog() }} />
            </div>
            <select className="select select-sm" style={{ width: 190 }} value={catalogSource} onChange={(e) => setCatalogSource(e.target.value as 'curated' | 'huggingface' | 'ollama')}>
              <option value="curated">Recommended GGUF</option>
              <option value="huggingface">Hugging Face GGUF</option>
              <option value="ollama">Ollama library</option>
            </select>
            <button className="btn btn-sm" type="button" onClick={() => void searchCatalog()} disabled={catalogBusy}>
              {catalogBusy ? <Spinner /> : <Icon name="search" size={12} />} Search
            </button>
          </div>
          {catalogError ? <div className="notice-row error" style={{ marginBottom: 10 }}><Icon name="alert" size={12} /> {catalogError}</div> : null}
          {catalogBusy && !catalog.length ? <div className="card tight"><Spinner /> <span className="tiny faint">Querying the catalog…</span></div> : null}
          {catalog.length ? (
            <div className="grid-auto">
              {catalog.map((item) => (
                <div className="card card-hover" key={item.id}>
                  <div className="row between" style={{ alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="card-title" style={{ wordBreak: 'break-word' }}>{item.name}</div>
                      <div className="tiny faint">{item.developer} · {item.pullName ? 'Ollama' : item.source === 'huggingface' ? 'Hugging Face' : 'Local-ready GGUF'}</div>
                    </div>
                    <span className="badge">{item.pullName ? 'Ollama' : 'GGUF'}</span>
                  </div>
                  <p className="card-sub" style={{ marginTop: 7, lineHeight: 1.5 }}>{item.description || 'No catalog description provided.'}</p>
                  <div className="model-capabilities">
                    <span className={`cap ${item.capabilities.tools ? 'on' : ''}`}>tools</span>
                    <span className={`cap ${item.capabilities.vision ? 'on' : ''}`}>vision</span>
                    {item.sizeBytes ? <span className="cap">{formatBytes(item.sizeBytes)}</span> : null}
                    {item.downloads ? <span className="cap">{formatNumber(item.downloads)} downloads</span> : null}
                  </div>
                  <div className="row mt-8" style={{ marginTop: 10 }}>
                    <button className="btn btn-sm btn-success" type="button" onClick={() => item.pullName ? void pull(item) : void openHf(item)}>
                      <Icon name="download" size={11} /> Download
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      title="Open source page"
                      onClick={() =>
                        void api.app.openExternal(
                          item.pullName
                            ? `https://ollama.com/library/${encodeURIComponent(item.pullName.split(':')[0])}`
                            : `https://huggingface.co/${item.id}`
                        )
                      }
                    >
                      <Icon name="external" size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : !catalogBusy ? (
            <div className="card tight tiny faint">No catalog results. Check your network connection or search a different term.</div>
          ) : null}
        </Section>

        <Section title="Runtime dependencies">
          <div className="grid-3">
            {dependencies.map((dep) => (
              <div className="card tight" key={dep.id}>
                <div className="row between">
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{dep.name}</div>
                  <span className={`badge ${dep.installed ? 'ok' : 'warn'}`}>{dep.running ? 'running' : dep.installed ? 'installed' : 'missing'}</span>
                </div>
                <div className="tiny faint mt-8" style={{ lineHeight: 1.5 }}>{dep.note}</div>
                {dep.path ? <div className="tiny faint mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>{dep.path}</div> : null}
                {!dep.installed ? (
                  dep.id === 'llamacpp' ? (
                    <button className="btn btn-sm btn-success mt-8" type="button" onClick={() => void installRuntime()} disabled={busy === 'runtime-install'}>
                      {busy === 'runtime-install' ? <Spinner /> : <Icon name="download" size={11} />} Install in app
                    </button>
                  ) : (
                    <button className="btn btn-sm mt-8" type="button" onClick={() => void api.app.openExternal(dep.installUrl)}>
                      <Icon name="external" size={11} /> Setup guide
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      </div>

      {endpointOpen ? (
        <div className="overlay">
          <div className="modal narrow">
            <div className="modal-head">
              <div className="grow">
                <h3>Add a local endpoint</h3>
                <div className="sub">Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server on this machine or your LAN.</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setEndpointOpen(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <Field label="Display name">
                <input className="input" value={endpointName} onChange={(e) => setEndpointName(e.target.value)} placeholder="My local server" />
              </Field>
              <Field label="Base URL" hint="Use the API base, e.g. http://127.0.0.1:1234/v1 for LM Studio or http://127.0.0.1:8080/v1 for llama.cpp.">
                <input className="input" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
              </Field>
              <Field label="API type">
                <select className="select" value={endpointType} onChange={(e) => setEndpointType(e.target.value as 'ollama' | 'openai')}>
                  <option value="openai">OpenAI-compatible</option>
                  <option value="ollama">Ollama API</option>
                </select>
              </Field>
              <div className="plugin-note">
                Only add endpoints you control. A remote endpoint is not local inference — LocalPilot labels it as a custom
                provider and never makes it the default silently.
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" type="button" onClick={() => setEndpointOpen(false)}>Cancel</button>
              <button className="btn btn-primary" type="button" disabled={!endpointUrl.trim() || busy === 'endpoint'} onClick={() => void addEndpoint()}>
                {busy === 'endpoint' ? <Spinner /> : <Icon name="plus" size={12} />} Add endpoint
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
                <h3>{detail.model.name}</h3>
                <div className="sub">{detail.model.providerName} · raw runtime metadata</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setDetail(null)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <div className="grid-2">
                <div className="kv"><span className="k">Model ID</span><span className="v mono">{detail.model.id}</span></div>
                <div className="kv"><span className="k">Family</span><span className="v">{detail.model.family ?? '—'}</span></div>
                <div className="kv"><span className="k">Parameters</span><span className="v">{detail.model.parameterSize ?? '—'}</span></div>
                <div className="kv"><span className="k">Quantization</span><span className="v">{detail.model.quantization ?? '—'}</span></div>
                <div className="kv"><span className="k">Context</span><span className="v">{detail.model.contextLength ? formatNumber(detail.model.contextLength) : '—'}</span></div>
                <div className="kv"><span className="k">Capabilities</span><span className="v">{detail.model.capabilitySource}</span></div>
              </div>
              <pre className="permission-args">{JSON.stringify(detail.data, null, 2)}</pre>
            </div>
            <div className="modal-foot">
              {detail.model.filePath ? <button className="btn" type="button" onClick={() => void api.app.showItemInFolder(detail.model.filePath!)}><Icon name="folder" size={12} /> Show file</button> : null}
              <button className="btn btn-primary" type="button" onClick={() => { onSelectModel(detail.model.providerId, detail.model.id); setDetail(null) }}>Use this model</button>
            </div>
          </div>
        </div>
      ) : null}

      {hfItem ? (
        <div className="overlay" onClick={() => setHfItem(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="grow">
                <h3>Choose a quantization</h3>
                <div className="sub">{hfItem.id} · files from the Hugging Face repository</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setHfItem(null)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              {hfBusy ? <div><Spinner /> Loading file list…</div> : null}
              {hfFiles.length ? hfFiles.map((file) => (
                <div className="setup-row" key={file.name}>
                  <div className="icon-wrap"><Icon name="file" size={14} /></div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title mono" style={{ wordBreak: 'break-all', fontSize: 11 }}>{file.name}</div>
                    <div className="sub">{formatBytes(file.sizeBytes)} · GGUF</div>
                  </div>
                  <button className="btn btn-sm btn-success" type="button" onClick={() => void downloadHf(file.name)}>
                    <Icon name="download" size={11} /> Download
                  </button>
                </div>
              )) : !hfBusy ? <div className="tiny faint">No GGUF files were found in this repository.</div> : null}
              <div className="plugin-note">Downloads are saved to the configured models folder. Install the local engine above, then use Load &amp; use on the downloaded file. No Ollama installation is required.</div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" type="button" onClick={() => setHfItem(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
