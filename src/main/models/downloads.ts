import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadTask, LocalModelFile } from '@shared/types'
import { settings } from '../settings'
import { getSecret } from '../secrets'
import { getPaths, safeFileName } from '../core/paths'
import { all, get, run } from '../db'
import { log } from '../core/logger'
import { recordActivity } from '../activity'
import { iterateNdjson } from '../providers/http'

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
