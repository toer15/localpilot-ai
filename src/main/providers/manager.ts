import type { ModelInfo, ProviderConfig, ProviderStatus, RunRequest } from '@shared/types'
import type { ChatProvider, ProviderChatRequest, ProviderChatResult } from './types'
import { OllamaProvider } from './ollama'
import { OpenAiCompatibleProvider } from './openai'
import { llamaServer } from './llama'
import { settings } from '../settings'
import { hasSecret } from '../secrets'
import { runProcess, which } from '../core/proc'
import { log } from '../core/logger'
import { getPaths } from '../core/paths'
import fs from 'node:fs'
import path from 'node:path'

interface CacheEntry {
  at: number
  models: ModelInfo[]
  statuses: ProviderStatus[]
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(parsed.hostname)
  } catch {
    return true
  }
}

function localOnlyBlock(config: ProviderConfig): string | null {
  if (!settings.get().privacy.localOnly) return null
  if (isLoopbackUrl(config.baseUrl)) return null
  return `Blocked by local-only mode: ${config.name} uses the non-local endpoint ${config.baseUrl}. Nothing was sent. Disable local-only mode in Settings → Privacy to allow cloud providers.`
}

class ProviderManager {
  private cache: CacheEntry | null = null

  buildProviders(): ChatProvider[] {
    const s = settings.get()
    const configs: ProviderConfig[] = [...s.models.providers, ...(s.advanced.extraEndpoints ?? [])]
    return configs
      .filter((c) => c.enabled)
      .map((config) => {
        const enriched = { ...config, hasKey: hasSecret(`provider:${config.id}`) }
        return config.type === 'ollama'
          ? new OllamaProvider(enriched)
          : new OpenAiCompatibleProvider(enriched)
      })
  }

  get(providerId: string): ChatProvider | null {
    return this.buildProviders().find((p) => p.config.id === providerId) ?? null
  }

  findModel(models: ModelInfo[], providerId: string, modelId: string) {
    return models.find((m) => m.providerId === providerId && m.id === modelId) ?? null
  }

  invalidate() {
    this.cache = null
  }

  async refresh(force = false): Promise<CacheEntry> {
    if (!force && this.cache && Date.now() - this.cache.at < 8000) return this.cache
    const providers = this.buildProviders()
    const statuses = await Promise.all(
      providers.map(async (provider) => {
        const blocked = localOnlyBlock(provider.config)
        if (blocked) {
          return {
            ...provider.config,
            running: false,
            error: blocked
          } satisfies ProviderStatus
        }
        try {
          return await provider.ping()
        } catch (err) {
          return {
            ...provider.config,
            running: false,
            error: err instanceof Error ? err.message : String(err)
          } satisfies ProviderStatus
        }
      })
    )

    // llama.cpp status is managed separately because it can be launched on demand.
    const llamaStatus = statuses.find((s) => s.id === 'llamacpp')
    if (llamaStatus && llamaServer.running) {
      llamaStatus.running = true
      llamaStatus.managed = true
      llamaStatus.modelCount = 1
      llamaStatus.error = undefined
    }
    if (llamaStatus) llamaStatus.installed = Boolean(await llamaServer.resolvePath())

    const allModels: ModelInfo[] = []
    await Promise.all(
      providers.map(async (provider) => {
        const status = statuses.find((s) => s.id === provider.config.id)
        if (!status?.running) return
        try {
          const models = await provider.listModels()
          if (provider.config.id === 'llamacpp') {
            const managed = await llamaServer.modelsFor(provider.config.baseUrl)
            if (managed.length) {
              allModels.push(...managed)
              return
            }
          }
          allModels.push(...models)
        } catch (err) {
          log.warn('providers', `Model discovery failed for ${provider.config.name}`, String(err))
          status.error = err instanceof Error ? err.message : String(err)
        }
      })
    )

    // Local GGUF files are always visible as importable assets even when no server is running.
    this.cache = { at: Date.now(), models: allModels, statuses }
    return this.cache
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    return (await this.refresh(force)).models
  }

  getStatuses(force = false): Promise<ProviderStatus[]> {
    return this.refresh(force).then((c) => c.statuses)
  }

  async chat(providerId: string, request: ProviderChatRequest): Promise<ProviderChatResult> {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`Provider "${providerId}" is not configured or enabled.`)
    const blocked = localOnlyBlock(provider.config)
    if (blocked) throw new Error(blocked)
    return provider.chat(request)
  }

  async startProvider(providerId: string): Promise<ProviderStatus> {
    const s = settings.get()
    const config = [...s.models.providers, ...s.advanced.extraEndpoints].find((p) => p.id === providerId)
    if (!config) throw new Error(`Unknown provider: ${providerId}`)
    const blocked = localOnlyBlock(config)
    if (blocked) return { ...config, running: false, error: blocked }

    if (providerId === 'ollama') {
      const exe = await which('ollama')
      if (!exe) {
        return {
          ...config,
          running: false,
          installed: false,
          error: 'Ollama is not installed. Install it from https://ollama.com/download, then refresh.'
        }
      }
      const already = await this.pingProvider(config)
      if (already.running) return already
      try {
        const { spawn } = await import('node:child_process')
        const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        log.info('providers', 'Started ollama serve')
      } catch (err) {
        return { ...config, running: false, installed: true, error: String(err) }
      }
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 600))
        const status = await this.pingProvider(config)
        if (status.running) return status
      }
      return {
        ...config,
        running: false,
        installed: true,
        error: 'Ollama was launched but its local API did not answer. Check the Ollama tray icon.'
      }
    }

    if (providerId === 'llamacpp') {
      const files = await this.localModelFiles()
      if (!files.length) {
        return {
          ...config,
          running: false,
          installed: Boolean(await llamaServer.resolvePath()),
          error: 'Import a GGUF file in the Model Library first, then load it with llama.cpp.'
        }
      }
      return llamaServer.start(files[0].filePath, {})
    }

    return this.pingProvider(config)
  }

  async pingProvider(config: ProviderConfig): Promise<ProviderStatus> {
    const provider =
      config.type === 'ollama'
        ? new OllamaProvider({ ...config, hasKey: hasSecret(`provider:${config.id}`) })
        : new OpenAiCompatibleProvider({ ...config, hasKey: hasSecret(`provider:${config.id}`) })
    return provider.ping()
  }

  async localModelFiles() {
    const { all } = await import('../db')
    return all<{ id: string; name: string; file_path: string; size_bytes: number }>(
      'SELECT id, name, file_path, size_bytes FROM local_models ORDER BY added_at DESC'
    ).map((row) => ({
      id: row.id,
      name: row.name,
      filePath: row.file_path,
      sizeBytes: row.size_bytes,
      addedAt: ''
    }))
  }

  async runtimeDependencies() {
    const s = settings.get()
    const ollamaPath = await which('ollama')
    const llamaPath = await llamaServer.resolvePath()
    const edgePath = [
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].find((p) => p && fs.existsSync(p))
    const ollamaStatus = await this.pingProvider(s.models.providers.find((p) => p.id === 'ollama')!).catch(() => null)
    return [
      {
        id: 'ollama',
        name: 'Ollama',
        kind: 'model-runtime' as const,
        installed: Boolean(ollamaPath),
        running: Boolean(ollamaStatus?.running),
        path: ollamaPath ?? undefined,
        version: ollamaStatus?.version,
        installUrl: 'https://ollama.com/download/windows',
        note: 'Easiest way to run local GGUF models on Windows. LocalPilot discovers existing models automatically.'
      },
      {
        id: 'llamacpp',
        name: 'llama.cpp server',
        kind: 'model-runtime' as const,
        installed: Boolean(llamaPath),
        running: llamaServer.running,
        path: llamaPath ?? undefined,
        installUrl: 'https://github.com/ggml-org/llama.cpp/releases',
        note: 'Use a Vulkan build for AMD Radeon GPUs, or a CUDA build for NVIDIA. Point Settings → Models at llama-server.exe.'
      },
      {
        id: 'lmstudio',
        name: 'LM Studio',
        kind: 'model-runtime' as const,
        installed: null,
        running: false,
        installUrl: 'https://lmstudio.ai/',
        note: 'Start LM Studio’s local server on port 1234 and LocalPilot will discover its models.'
      },
      {
        id: 'edge',
        name: 'Microsoft Edge (browser automation)',
        kind: 'browser' as const,
        installed: Boolean(edgePath),
        path: edgePath,
        installUrl: 'https://www.microsoft.com/edge',
        note: 'Playwright drives Edge/Chrome locally. No browser download is required when Edge is installed.'
      }
    ]
  }

  modelsDir() {
    return settings.get().models.modelsDir || getPaths().modelsDir
  }

  /** Used by the agent to resolve capability warnings. */
  async modelFor(request: Pick<RunRequest, 'providerId' | 'modelId'>): Promise<ModelInfo | null> {
    const models = await this.listModels()
    return (
      models.find((m) => m.providerId === request.providerId && m.id === request.modelId) ??
      (llamaServer.running
        ? (await llamaServer.modelsFor('http://127.0.0.1:8080')).find((m) => m.id === request.modelId) ?? null
        : null)
    )
  }
}

export const providers = new ProviderManager()
