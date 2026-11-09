import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ModelInfo, ProviderStatus } from '@shared/types'
import { runProcess, which, registerChild } from '../core/proc'
import { settings } from '../settings'
import { log } from '../core/logger'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

class LlamaServerManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private modelPath: string | null = null
  private stderr = ''
  private starting = false

  detect(): string | null {
    const configured = settings.get().models.llamaServerPath
    const candidates = [
      configured,
      path.join(app.getPath('userData'), 'runtime', 'llama.cpp', 'llama-server.exe'),
      'C:\\llama.cpp\\build\\bin\\llama-server.exe',
      'C:\\llama.cpp\\llama-server.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'llama.cpp', 'llama-server.exe'),
      path.join(process.env.USERPROFILE ?? '', 'llama.cpp', 'llama-server.exe')
    ].filter(Boolean)
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // continue
      }
    }
    return null
  }

  async resolvePath(): Promise<string | null> {
    const direct = this.detect()
    if (direct) return direct
    return which('llama-server.exe')
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null)
  }

  get activeModelPath() {
    return this.modelPath
  }

  async start(
    modelPath: string,
    options: { contextLength?: number; gpuLayers?: number; port?: number }
  ): Promise<ProviderStatus> {
    const exe = await this.resolvePath()
    const s = settings.get()
    const port = options.port ?? s.models.llamaPort ?? 8080
    const baseUrl = `http://127.0.0.1:${port}`
    const status: ProviderStatus = {
      id: 'llamacpp',
      name: 'llama.cpp server',
      type: 'openai',
      baseUrl,
      enabled: true,
      managed: true,
      installed: Boolean(exe),
      running: false
    }
    if (!exe) {
      status.error =
        'The local engine is not installed. Open Model library → Local engine → Install local engine. Ollama is not required.'
      return status
    }
    if (!fs.existsSync(modelPath)) {
      status.error = `Model file not found: ${modelPath}`
      return status
    }
    if (this.running) await this.stop()
    this.starting = true
    this.stderr = ''
    const configuredLayers = settings.get().models.gpuLayers
    const gpuLayers = options.gpuLayers ?? (configuredLayers >= 0 ? configuredLayers : -1)
    const context = options.contextLength ?? settings.get().models.contextLength
    const args = [
      '-m',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      String(context),
      '-ngl',
      String(gpuLayers),
      '--metrics'
    ]
    log.info('llamacpp', `Starting ${exe} ${args.join(' ')}`)
    try {
      const child = registerChild(
        spawn(exe, args, {
          windowsHide: true,
          cwd: path.dirname(exe)
        }) as ChildProcessWithoutNullStreams
      )
      this.child = child
      this.modelPath = modelPath
      child.stdout.on('data', (b: Buffer) => log.debug('llamacpp', b.toString('utf8').trim().slice(0, 300)))
      child.stderr.on('data', (b: Buffer) => {
        const text = b.toString('utf8')
        this.stderr = (this.stderr + text).slice(-12000)
        log.debug('llamacpp', text.trim().slice(0, 300))
      })
      child.once('exit', (code) => {
        log.info('llamacpp', `llama-server exited with ${code}`)
        this.child = null
      })

      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break
        try {
          const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) })
          if (res.ok) {
            status.running = true
            status.modelCount = 1
            this.starting = false
            return status
          }
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      status.error = `llama-server did not become ready. ${this.stderr.split('\n').slice(-6).join(' ').slice(0, 800)}`
      this.starting = false
      return status
    } catch (err) {
      this.starting = false
      status.error = err instanceof Error ? err.message : String(err)
      return status
    }
  }

  async stop(): Promise<boolean> {
    if (!this.child) return false
    try {
      if (process.platform === 'win32' && this.child.pid) {
        await runProcess('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { timeoutMs: 8000 })
      } else {
        this.child.kill()
      }
    } catch {
      // best effort
    }
    this.child = null
    this.modelPath = null
    return true
  }

  async modelsFor(baseUrl: string): Promise<ModelInfo[]> {
    if (!this.running) return []
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return []
      const data = (await res.json()) as { data?: { id: string }[] }
      return (data.data ?? []).map((m) => ({
        id: m.id,
        name: this.modelPath ? path.basename(this.modelPath) : m.id,
        providerId: 'llamacpp',
        providerName: 'llama.cpp server',
        kind: 'chat',
        contextLength: settings.get().models.contextLength,
        capabilities: { tools: true, vision: false, thinking: false, completion: true, embeddings: false },
        capabilitySource: 'unknown',
        loaded: true,
        filePath: this.modelPath ?? undefined,
        source: 'local'
      }))
    } catch {
      return []
    }
  }

  get isStarting() {
    return this.starting
  }
}

export const llamaServer = new LlamaServerManager()
