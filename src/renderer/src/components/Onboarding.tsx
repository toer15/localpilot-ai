import { useState } from 'react'
import type { AppSettings, HardwareInfo, ModelInfo, ProviderStatus } from '@shared/types'
import { Icon } from './Icons'
import { Spinner } from './ui'
import { formatBytes } from '../lib/format'

interface Props {
  settings: AppSettings
  providers: ProviderStatus[]
  models: ModelInfo[]
  hardware: HardwareInfo | null
  onRefresh: () => Promise<void>
  onComplete: (selection: { providerId: string; modelId: string } | null) => Promise<void>
}

const api = window.localpilot

export function Onboarding({ providers, models, hardware, onRefresh, onComplete }: Props) {
  const [step, setStep] = useState(0)
  const [selection, setSelection] = useState<{ providerId: string; modelId: string } | null>(() => {
    const first = models.find((m) => m.kind === 'chat') ?? models[0]
    return first ? { providerId: first.providerId, modelId: first.id } : null
  })
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)

  const startProvider = async (id: string) => {
    setStarting(id)
    try {
      await api.models.startProvider(id)
      await onRefresh()
    } catch {
      await onRefresh()
    } finally {
      setStarting(null)
    }
  }

  const finish = async () => {
    setBusy(true)
    try {
      await onComplete(selection)
    } finally {
      setBusy(false)
    }
  }

  const ollama = providers.find((p) => p.id === 'ollama')

  return (
    <div className="overlay">
      <div className="modal onboarding" role="dialog" aria-modal="true">
        <div className="onboarding-progress" style={{ paddingTop: 18 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'done' : ''} />
          ))}
        </div>
        <div className="modal-body" style={{ paddingTop: 10 }}>
          {step === 0 ? (
            <>
              <div className="welcome-mark" style={{ marginBottom: 14 }}>
                <Icon name="zap" size={24} />
              </div>
              <h2>Your computer, with a pilot.</h2>
              <p className="lead">
                LocalPilot is a local-first AI workstation. It runs the models already on your PC, uses tools to
                work inside real applications, and keeps conversations and project data in local SQLite.
              </p>
              <div className="grid-2" style={{ marginTop: 8 }}>
                <div className="setup-row">
                  <div className="icon-wrap">
                    <Icon name="cpu" size={16} />
                  </div>
                  <div>
                    <div className="title">{hardware?.gpus[0]?.name ?? hardware?.cpu.model ?? 'Detecting hardware'}</div>
                    <div className="sub">
                      {hardware
                        ? `${formatBytes(hardware.ram.totalBytes)} RAM · ${hardware.gpus[0]?.vramBytes ? `${formatBytes(hardware.gpus[0].vramBytes)} VRAM` : 'CPU inference'}`
                        : 'Hardware detection in progress'}
                    </div>
                  </div>
                </div>
                <div className="setup-row">
                  <div className="icon-wrap">
                    <Icon name="shield" size={16} />
                  </div>
                  <div>
                    <div className="title">No cloud account required</div>
                    <div className="sub">Prompts stay on this machine unless you enable a cloud tool.</div>
                  </div>
                </div>
              </div>
              <div className="plugin-note" style={{ marginTop: 4 }}>
                Computer Use can control your mouse, keyboard and applications — but only when you approve each action
                (or grant a session). Nothing is captured in the background.
              </div>
            </>
          ) : step === 1 ? (
            <>
              <h2>Find your local runtimes.</h2>
              <p className="lead">
                LocalPilot discovered these local model servers. You do not need to download any model again — existing
                Ollama and LM Studio models are used directly.
              </p>
              <div className="stack">
                {providers.map((provider) => (
                  <div className="setup-row" key={provider.id}>
                    <div className="icon-wrap">
                      <Icon name={provider.type === 'ollama' ? 'cpu' : 'monitor'} size={16} />
                    </div>
                    <div className="grow">
                      <div className="title">
                        {provider.name}{' '}
                        {provider.running ? (
                          <span className="badge ok">running</span>
                        ) : (
                          <span className="badge">offline</span>
                        )}
                      </div>
                      <div className="sub">
                        {provider.baseUrl}
                        {provider.running ? ` · ${provider.modelCount ?? 0} models${provider.version ? ` · v${provider.version}` : ''}` : provider.error ? ` · ${provider.error}` : ''}
                      </div>
                    </div>
                    {!provider.running && provider.id === 'ollama' ? (
                      <button className="btn btn-sm" type="button" disabled={starting === provider.id} onClick={() => void startProvider(provider.id)}>
                        {starting === provider.id ? <Spinner /> : <Icon name="play" size={11} />} Start
                      </button>
                    ) : null}
                    {!provider.running && provider.id !== 'ollama' ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        type="button"
                        onClick={() =>
                          void api.app.openExternal(
                            provider.id === 'lmstudio' ? 'https://lmstudio.ai/' : 'https://github.com/ggml-org/llama.cpp/releases'
                          )
                        }
                      >
                        Setup
                      </button>
                    ) : null}
                  </div>
                ))}
                {!ollama?.running ? (
                  <div className="plugin-note">
                    Ollama not running? Start it from this screen, or install it from{' '}
                    <a href="https://ollama.com/download" onClick={(e) => { e.preventDefault(); void api.app.openExternal('https://ollama.com/download/windows') }}>
                      ollama.com/download
                    </a>
                    . LocalPilot never downloads a model that is already installed.
                  </div>
                ) : null}
                <div className="row">
                  <button className="btn btn-sm" type="button" onClick={() => void onRefresh()}>
                    <Icon name="refresh" size={12} /> Refresh detection
                  </button>
                  <span className="tiny faint">LM Studio: start its local server on port 1234. llama.cpp: point Settings → Models at llama-server.exe.</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <h2>Choose your default model.</h2>
              <p className="lead">
                {models.length
                  ? 'These models are already installed. LocalPilot will show each model’s real tool and vision capabilities in chat.'
                  : 'No local models were found yet. You can finish setup now and add models in the Model library.'}
              </p>
              {models.length ? (
                <div className="model-pick-grid">
                  {models
                    .filter((m) => m.kind === 'chat')
                    .map((model) => {
                      const isSelected =
                        selection?.providerId === model.providerId && selection?.modelId === model.id
                      return (
                        <button
                          key={`${model.providerId}:${model.id}`}
                          type="button"
                          className={`model-pick ${isSelected ? 'selected' : ''}`}
                          onClick={() => setSelection({ providerId: model.providerId, modelId: model.id })}
                        >
                          <div className="name">{model.name}</div>
                          <div className="meta">
                            <span className="cap">{model.providerName}</span>
                            <span className={`cap ${model.capabilities.tools ? 'on' : ''}`}>
                              {model.capabilities.tools ? 'tools' : 'no native tools'}
                            </span>
                            <span className={`cap ${model.capabilities.vision ? 'on' : ''}`}>
                              {model.capabilities.vision ? 'vision' : 'text only'}
                            </span>
                            {model.contextLength ? <span className="cap">{Math.round(model.contextLength / 1024)}k ctx</span> : null}
                          </div>
                        </button>
                      )
                    })}
                </div>
              ) : null}
              {selection && models.find((m) => m.id === selection.modelId)?.capabilitySource !== 'reported' ? (
                <div className="plugin-note">
                  Capabilities for this provider are not reported. LocalPilot will use its text tool protocol if the model
                  does not support native function calling.
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" type="button" onClick={() => void finish()}>
            Skip setup
          </button>
          <span className="grow" />
          {step > 0 ? (
            <button className="btn" type="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          ) : null}
          {step < 2 ? (
            <button className="btn btn-primary" type="button" onClick={() => setStep((s) => s + 1)}>
              Continue <Icon name="arrow-right" size={13} />
            </button>
          ) : (
            <button className="btn btn-primary" type="button" onClick={() => void finish()} disabled={busy}>
              {busy ? <Spinner /> : <Icon name="check" size={13} />} Enter LocalPilot
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
