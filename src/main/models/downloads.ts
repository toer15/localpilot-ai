import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadTask, LlamaRuntimeStatus, LocalModelFile } from '@shared/types'
import { settings } from '../settings'
import { getSecret } from '../secrets'
import { getPaths, safeFileName } from '../core/paths'
import { all, get, run } from '../db'
import { log } from '../core/logger'
import { recordActivity } from '../activity'
import { fetchJson, iterateNdjson } from '../providers/http'
import { llamaServer } from '../providers/llama'
import { detectHardware } from '../hardware'
import { runPowerShell, runProcess } from '../core/proc'

const tasks = new Map<string, DownloadTask>()
const controllers = new Map<string, AbortController>()

export function listDownloads(): DownloadTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function cancelDownload(id: string) {
  controllers.get(id)?.abort()
  const task = tasks.get(id)
  if (task && (task.status === 'running' || task.status === 'queued')) {
    task.status = 'cancelled'
    task.updatedAt = new Date().toISOString()
  }
}

function update(id: string, patch: Partial<DownloadTask>) {
  const current = tasks.get(id)
  if (!current) return
  tasks.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() })
}

const LLAMA_RELEASES_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10'

interface GitHubAsset {
  name: string
  browser_download_url: string
  size?: number
}

interface GitHubRelease {
  tag_name: string
  assets?: GitHubAsset[]
}

interface RuntimeMarker {
  tag?: string
  asset?: string
  variant?: string
  installedAt?: string
}

export function llamaRuntimeRoot() {
  return path.join(getPaths().userData, 'runtime', 'llama.cpp')
}

function runtimeMarkerPath() {
  return path.join(llamaRuntimeRoot(), 'runtime.json')
}

function readRuntimeMarker(): RuntimeMarker {
  try {
    return JSON.parse(fs.readFileSync(runtimeMarkerPath(), 'utf8')) as RuntimeMarker
  } catch {
    return {}
  }
}

/** Reports whether the app-managed or a user-configured llama-server.exe is usable. */
export async function llamaRuntimeStatus(): Promise<LlamaRuntimeStatus> {
  const resolved = await llamaServer.resolvePath()
  const marker = readRuntimeMarker()
  const root = llamaRuntimeRoot()
  return {
    installed: Boolean(resolved),
    running: llamaServer.running,
    path: resolved ?? undefined,
    version: marker.tag,
    variant: marker.variant,
    managed: resolved ? resolved.toLowerCase().startsWith(root.toLowerCase()) : false
  }
}

function findFileRecursive(dir: string, name: string): string | null {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, name)
      if (nested) return nested
    }
  }
  return null
}

function powerShellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Downloads the official llama.cpp Windows build into LocalPilot's own runtime
 * folder. No Ollama or external llama.cpp installation is required afterwards.
 */
export async function downloadLlamaRuntime(): Promise<DownloadTask> {
  const existing = listDownloads().find(
    (task) => task.kind === 'runtime' && (task.status === 'running' || task.status === 'queued')
  )
  if (existing) return existing

  const task: DownloadTask = {
    id: randomUUID(),
    name: 'llama.cpp local engine',
    kind: 'runtime',
    status: 'queued',
    progress: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  tasks.set(task.id, task)
  const controller = new AbortController()
  controllers.set(task.id, controller)

  void (async () => {
    update(task.id, { status: 'running' })
    const runtimeRoot = llamaRuntimeRoot()
    const runtimeParent = path.dirname(runtimeRoot)
    const zipPath = path.join(runtimeParent, `llama-runtime-${task.id}.zip`)
    const tempDir = path.join(runtimeParent, `llama-runtime-${task.id}`)
    let output: fs.WriteStream | null = null
    try {
      fs.mkdirSync(runtimeParent, { recursive: true })
      const releases = await fetchJson<GitHubRelease[]>(LLAMA_RELEASES_URL, {
        timeoutMs: 25000,
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'LocalPilotAI/0.1'
        }
      })
      const release = (releases ?? []).find((item) =>
        item.assets?.some((asset) => /-bin-win-(vulkan|cpu)-x64\.zip$/i.test(asset.name))
      )
      if (!release) throw new Error('No Windows llama.cpp build was found in the latest releases.')

      const hardware = await detectHardware()
      const preferred = hardware.acceleration.vulkan
        ? ['win-vulkan-x64.zip', 'win-cpu-x64.zip']
        : ['win-cpu-x64.zip', 'win-vulkan-x64.zip']
      let asset: GitHubAsset | undefined
      for (const suffix of preferred) {
        asset = release.assets?.find((candidate) => candidate.name.toLowerCase().endsWith(suffix))
        if (asset) break
      }
      if (!asset) throw new Error('The llama.cpp release has no Windows Vulkan or CPU build.')
      const variant = /vulkan/i.test(asset.name) ? 'Vulkan' : 'CPU'
      update(task.id, {
        name: `llama.cpp ${release.tag_name} (${variant})`,
        totalBytes: asset.size
      })

      const res = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'LocalPilotAI/0.1' },
        redirect: 'follow',
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`llama.cpp download failed (${res.status} ${res.statusText}).`)
      if (!res.body) throw new Error('llama.cpp download returned an empty response.')
      const total = Number(res.headers.get('content-length') ?? asset.size ?? 0)
      const reader = res.body.getReader()
      output = fs.createWriteStream(zipPath)
      let received = 0
      const started = Date.now()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (!output.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => output?.once('drain', () => resolve()))
        }
        update(task.id, {
          progress: total ? Math.min(96, Math.round((received / total) * 96)) : task.progress,
          receivedBytes: received,
          totalBytes: total || undefined,
          speedBps: received / Math.max(1, (Date.now() - started) / 1000)
        })
      }
      await new Promise<void>((resolve, reject) => {
        if (!output) return resolve()
        output.once('error', reject)
        output.end(() => resolve())
      })
      output = null
      if (controller.signal.aborted) throw new Error('Download cancelled.')

      update(task.id, { progress: 97 })
      fs.rmSync(tempDir, { recursive: true, force: true })
      fs.mkdirSync(tempDir, { recursive: true })
      const tar = await runProcess('tar', ['-xf', zipPath, '-C', tempDir], { timeoutMs: 120000 })
      if (tar.code !== 0) {
        const fallback = await runPowerShell(
          `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${powerShellQuote(zipPath)} -DestinationPath ${powerShellQuote(tempDir)} -Force`,
          { timeoutMs: 120000 }
        )
        if (fallback.code !== 0) {
          throw new Error(`Could not extract the llama.cpp archive. ${fallback.stderr.slice(0, 500)}`)
        }
      }
      if (controller.signal.aborted) throw new Error('Download cancelled.')

      const server = findFileRecursive(tempDir, 'llama-server.exe')
      if (!server) throw new Error('The llama.cpp archive did not contain llama-server.exe.')
      const sourceDir = path.dirname(server)
      fs.rmSync(runtimeRoot, { recursive: true, force: true })
      fs.mkdirSync(runtimeRoot, { recursive: true })
      for (const entry of fs.readdirSync(sourceDir)) {
        fs.cpSync(path.join(sourceDir, entry), path.join(runtimeRoot, entry), {
          recursive: true,
          force: true
        })
      }
      const marker: RuntimeMarker = {
        tag: release.tag_name,
        asset: asset.name,
        variant,
        installedAt: new Date().toISOString()
      }
      fs.writeFileSync(runtimeMarkerPath(), JSON.stringify(marker, null, 2), 'utf8')
      update(task.id, {
        status: 'done',
        progress: 100,
        filePath: path.join(runtimeRoot, 'llama-server.exe'),
        receivedBytes: received,
        totalBytes: total || received
      })
      recordActivity('runtime-install', `Installed llama.cpp ${release.tag_name} (${variant})`)
      log.info('downloads', `Installed managed llama.cpp ${release.tag_name} (${variant})`)
    } catch (err) {
      output?.destroy()
      const aborted = controller.signal.aborted
      update(task.id, {
        status: aborted ? 'cancelled' : 'error',
        error: aborted ? undefined : err instanceof Error ? err.message : String(err)
      })
      if (!aborted) log.warn('downloads', 'llama.cpp runtime download failed', String(err))
    } finally {
      try {
        fs.rmSync(zipPath, { force: true })
      } catch {
        // ignore
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      controllers.delete(task.id)
    }
  })()

  return task
}

export async function pullOllamaModel(name: string): Promise<DownloadTask> {
  const s = settings.get()
  const provider = s.models.providers.find((p) => p.id === 'ollama')
  if (!provider) throw new Error('Ollama provider is not configured')
  const task: DownloadTask = {
    id: randomUUID(),
    name,
    kind: 'ollama',
    status: 'queued',
    progress: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  tasks.set(task.id, task)
  const controller = new AbortController()
  controllers.set(task.id, controller)
  void (async () => {
    update(task.id, { status: 'running' })
    try {
      const res = await fetch(`${provider.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: controller.signal
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Ollama pull failed (${res.status}): ${detail.slice(0, 400)}`)
      }
      let total = 0
      let completed = 0
      for await (const chunk of iterateNdjson(res, controller.signal)) {
        if (chunk.error) throw new Error(String(chunk.error))
        const status = String(chunk.status ?? '')
        if (typeof chunk.total === 'number') total = Math.max(total, chunk.total)
        if (typeof chunk.completed === 'number') completed = Math.max(completed, chunk.completed)
        const progress = total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : task.progress
        update(task.id, { progress, receivedBytes: completed, totalBytes: total || undefined })
        if (status === 'success') {
          update(task.id, { status: 'done', progress: 100 })
        }
      }
      if (tasks.get(task.id)?.status !== 'cancelled') {
        update(task.id, { status: 'done', progress: 100 })
      }
      recordActivity('model-download', `Pulled Ollama model ${name}`)
    } catch (err) {
      const aborted = controller.signal.aborted
      update(task.id, {
        status: aborted ? 'cancelled' : 'error',
        error: aborted ? undefined : err instanceof Error ? err.message : String(err)
      })
      if (!aborted) log.warn('downloads', `Ollama pull failed for ${name}`, String(err))
    } finally {
      controllers.delete(task.id)
    }
  })()
  return task
}

export async function downloadGguf(repoId: string, file: string): Promise<DownloadTask> {
  const task: DownloadTask = {
    id: randomUUID(),
    name: `${repoId.split('/').pop()} / ${file}`,
    kind: 'gguf',
    status: 'queued',
    progress: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  tasks.set(task.id, task)
  const controller = new AbortController()
  controllers.set(task.id, controller)
  void (async () => {
    update(task.id, { status: 'running' })
    const dir = settings.get().models.modelsDir || getPaths().modelsDir
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, safeFileName(path.basename(file), 'model.gguf'))
    const part = `${target}.part`
    try {
      const headers: Record<string, string> = {}
      const token = getSecret('huggingface')
      if (token) headers.Authorization = `Bearer ${token}`
      const url = `https://huggingface.co/${repoId}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
      if (!res.ok) throw new Error(`Hugging Face returned ${res.status} ${res.statusText}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const out = fs.createWriteStream(part)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')
      let received = 0
      const started = Date.now()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        }
        const speed = received / Math.max(1, (Date.now() - started) / 1000)
        update(task.id, {
          progress: total ? Math.min(99, Math.round((received / total) * 100)) : task.progress,
          receivedBytes: received,
          totalBytes: total || undefined,
          speedBps: speed
        })
      }
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject)
        out.end(() => resolve())
      })
      fs.renameSync(part, target)
      const size = fs.statSync(target).size
      const id = randomUUID()
      run(
        'INSERT INTO local_models (id, name, file_path, size_bytes, quantization, context_length, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, path.basename(target), target, size, null, null, new Date().toISOString()]
      )
      update(task.id, { status: 'done', progress: 100, filePath: target, receivedBytes: size, totalBytes: size })
      recordActivity('model-download', `Downloaded ${path.basename(target)}`, { repoId, file, target })
    } catch (err) {
      try {
        if (fs.existsSync(part)) fs.unlinkSync(part)
      } catch {
        // ignore
      }
      const aborted = controller.signal.aborted
      update(task.id, {
        status: aborted ? 'cancelled' : 'error',
        error: aborted ? undefined : err instanceof Error ? err.message : String(err)
      })
      if (!aborted) log.warn('downloads', `GGUF download failed ${repoId}/${file}`, String(err))
    } finally {
      controllers.delete(task.id)
    }
  })()
  return task
}

export async function hfFiles(repoId: string): Promise<{ name: string; sizeBytes?: number }[]> {
  const headers: Record<string, string> = {}
  const token = getSecret('huggingface')
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`https://huggingface.co/api/models/${repoId}?blobs=true`, {
    headers,
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`Hugging Face model lookup failed: ${res.status}`)
  const data = (await res.json()) as {
    siblings?: { rfilename: string; size?: number; lfs?: { size?: number } }[]
  }
  return (data.siblings ?? [])
    .filter((f) => f.rfilename.toLowerCase().endsWith('.gguf'))
    .map((f) => ({ name: f.rfilename, sizeBytes: f.size ?? f.lfs?.size }))
    .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
}

export function importLocalModel(filePath: string): LocalModelFile | null {
  if (!fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  const existing = get<{ id: string }>('SELECT id FROM local_models WHERE file_path = ?', [filePath])
  if (existing) {
    return localModelRow(existing.id)
  }
  const id = randomUUID()
  const quant = /((?:I?Q\d|Q\d)[A-Z0-9_]*)/i.exec(path.basename(filePath))?.[1]
  run(
    'INSERT INTO local_models (id, name, file_path, size_bytes, quantization, context_length, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, path.basename(filePath), filePath, stat.size, quant ?? null, null, new Date().toISOString()]
  )
  recordActivity('model-import', `Imported local model ${path.basename(filePath)}`)
  return localModelRow(id)
}

function localModelRow(id: string): LocalModelFile | null {
  const row = get<{
    id: string
    name: string
    file_path: string
    size_bytes: number
    quantization: string | null
    context_length: number | null
    added_at: string
  }>('SELECT * FROM local_models WHERE id = ?', [id])
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    filePath: row.file_path,
    sizeBytes: row.size_bytes,
    quantization: row.quantization ?? undefined,
    contextLength: row.context_length ?? undefined,
    addedAt: row.added_at
  }
}

export function listLocalModels(): LocalModelFile[] {
  return all<{
    id: string
    name: string
    file_path: string
    size_bytes: number
    quantization: string | null
    context_length: number | null
    added_at: string
  }>('SELECT * FROM local_models ORDER BY added_at DESC').map((row) => ({
    id: row.id,
    name: row.name,
    filePath: row.file_path,
    sizeBytes: row.size_bytes,
    quantization: row.quantization ?? undefined,
    contextLength: row.context_length ?? undefined,
    addedAt: row.added_at
  }))
}

export function removeLocalModel(id: string) {
  run('DELETE FROM local_models WHERE id = ?', [id])
}
