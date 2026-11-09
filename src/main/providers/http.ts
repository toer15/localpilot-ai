import { log } from '../core/logger'

/**
 * Merge an external abort signal with an internal timeout.
 * Returns a fetch-ready signal and a dispose function.
 */
export function timedSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs)
  const onAbort = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}

export async function fetchJson<T>(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const { signal, dispose } = timedSignal(options.signal, options.timeoutMs ?? 15000)
  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 400)}` : ''}`)
    }
    return (await res.json()) as T
  } finally {
    dispose()
  }
}

export async function* iterateNdjson(
  res: Response,
  signal: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) throw new Error('Response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            yield JSON.parse(line) as Record<string, unknown>
          } catch {
            log.debug('http', 'Skipping malformed NDJSON line', line.slice(0, 200))
          }
        }
        index = buffer.indexOf('\n')
      }
    }
    const rest = buffer.trim()
    if (rest) {
      try {
        yield JSON.parse(rest) as Record<string, unknown>
      } catch {
        // ignored
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

export async function* iterateSse(
  res: Response,
  signal: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) throw new Error('Response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const rawLine = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        const line = rawLine.trim()
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              yield JSON.parse(payload) as Record<string, unknown>
            } catch {
              // Some servers send partial/comment lines; skip them.
            }
          }
        }
        index = buffer.indexOf('\n')
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

export function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? 'image/png'
}
