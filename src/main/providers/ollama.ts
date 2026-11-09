import type { ModelInfo, ProviderConfig, ProviderStatus, ToolCallRequest } from '@shared/types'
import type { ChatProvider, ProviderChatRequest, ProviderChatResult, ProviderMessage, ProviderTool } from './types'
import { baseStatus, inferredCapabilities } from './types'
import { fetchJson, iterateNdjson, stripDataUrl } from './http'
import { which, runProcess } from '../core/proc'
import { log } from '../core/logger'

interface OllamaTag {
  name: string
  model?: string
  modified_at?: string
  size?: number
  digest?: string
  capabilities?: string[]
  details?: {
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
    context_length?: number
    format?: string
  }
}

interface OllamaShow {
  capabilities?: string[]
  model_info?: Record<string, unknown>
  details?: OllamaTag['details']
}

export class OllamaProvider implements ChatProvider {
  constructor(public config: ProviderConfig) {}

  async ping(): Promise<ProviderStatus> {
    const status = baseStatus(this.config)
    try {
      const version = await fetchJson<{ version: string }>(`${this.config.baseUrl}/api/version`, {
        timeoutMs: 2500
      })
      status.running = true
      status.version = version.version
      const models = await this.listModels()
      status.modelCount = models.length
    } catch (err) {
      status.error = cleanError(err)
    }
    status.installed = Boolean(await which('ollama'))
    return status
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await fetchJson<{ models?: OllamaTag[] }>(`${this.config.baseUrl}/api/tags`, {
      timeoutMs: 12000
    })
    const tags = data.models ?? []
    let running: Record<string, { size_vram?: number }> = {}
    try {
      const ps = await fetchJson<{ models?: { name: string; size_vram?: number }[] }>(
        `${this.config.baseUrl}/api/ps`,
        { timeoutMs: 3000 }
      )
      running = Object.fromEntries((ps.models ?? []).map((m) => [m.name, m]))
    } catch {
      // /api/ps is optional
    }

    const limited = tags.slice(0, 80)
    const enriched = await Promise.all(
      limited.map(async (tag) => {
        const reported = tag.capabilities
        const info: OllamaShow = { capabilities: reported, details: tag.details }
        if (!reported || !tag.details?.context_length) {
          try {
            const show = await fetchJson<OllamaShow>(`${this.config.baseUrl}/api/show`, {
              method: 'POST',
              body: { model: tag.name },
              timeoutMs: 6000
            })
            info.capabilities = show.capabilities ?? reported
            info.model_info = show.model_info
            if (show.details && !info.details) info.details = show.details
          } catch {
            // keep partial info
          }
        }
        const caps = info.capabilities ?? []
        const inferred = inferredCapabilities(tag.name)
        const contextFromInfo = Object.entries(info.model_info ?? {}).find(([key]) =>
          key.endsWith('.context_length')
        )?.[1]
        const embeddings = caps.includes('embedding') || caps.includes('embeddings')
        const completion = caps.length === 0 ? !inferred.embeddings : caps.includes('completion')
        return {
          id: tag.name,
          name: tag.name,
          providerId: this.config.id,
          providerName: this.config.name,
          kind: embeddings && !completion ? 'embedding' : 'chat',
          sizeBytes: tag.size,
          modifiedAt: tag.modified_at,
          family: tag.details?.family ?? tag.details?.families?.[0],
          parameterSize: tag.details?.parameter_size,
          quantization: tag.details?.quantization_level,
          contextLength:
            Number(contextFromInfo) ||
            tag.details?.context_length ||
            undefined,
          capabilities: {
            tools: caps.includes('tools') || (caps.length === 0 && inferred.tools),
            vision: caps.includes('vision') || (caps.length === 0 && inferred.vision),
            thinking: caps.includes('thinking') || (caps.length === 0 && inferred.thinking),
            completion,
            embeddings
          },
          capabilitySource: (caps.length ? 'reported' : 'inferred') as 'reported' | 'inferred',
          loaded: Boolean(running[tag.name]),
          vramBytes: running[tag.name]?.size_vram,
          source: 'local' as const
        } satisfies ModelInfo
      })
    )
    return enriched
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResult> {
    const nativeTools = hasNativeTools(request.modelInfo)
    const messages = request.messages.map((m) => this.mapMessage(m))
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      keep_alive: '30m',
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        num_predict: request.maxTokens,
        num_ctx: request.contextLength
      }
    }
    if (request.tools?.length && nativeTools !== false) {
      body.tools = request.tools.map(formatTool)
    }
    if (request.modelInfo?.capabilities.thinking) {
      // Explicitly disable thinking for "none". Omitting the field lets thinking
      // models reason anyway and can exhaust the output budget before an answer.
      body.think = request.reasoningEffort !== 'none'
    }

    let text = ''
    let reasoning = ''
    const toolCalls: ToolCallRequest[] = []
    let promptTokens: number | undefined
    let evalTokens: number | undefined

    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Ollama ${res.status}: ${detail.slice(0, 600) || res.statusText}`)
    }

    for await (const chunk of iterateNdjson(res, request.signal)) {
      if (chunk.error) throw new Error(String(chunk.error))
      const message = chunk.message as
        | { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }
        | undefined
      if (message?.content) {
        text += message.content
        request.onDelta?.(message.content)
      }
      if (message?.thinking) {
        reasoning += message.thinking
        request.onReasoning?.(message.thinking)
      }
      if (Array.isArray(message?.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call.function?.name) continue
          toolCalls.push({
            id: `ollama_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.function.name,
            arguments: normalizeArgs(call.function.arguments)
          })
        }
      }
      if (chunk.done) {
        promptTokens = numberOrUndefined(chunk.prompt_eval_count)
        evalTokens = numberOrUndefined(chunk.eval_count)
      }
    }

    log.debug('ollama', `Chat complete: ${text.length} chars, ${toolCalls.length} tool calls`)
    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage: { inputTokens: promptTokens, outputTokens: evalTokens }
    }
  }

  private mapMessage(message: ProviderMessage): Record<string, unknown> {
    const out: Record<string, unknown> = { role: message.role, content: message.content }
    if (message.images?.length) out.images = message.images.map(stripDataUrl)
    if (message.role === 'tool') {
      out.tool_name = message.name ?? 'tool'
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.tool_calls = message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.arguments }
      }))
    }
    return out
  }
}

function formatTool(tool: ProviderTool) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : { value: parsed }
    } catch {
      return { raw: value }
    }
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function numberOrUndefined(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function hasNativeTools(info?: ModelInfo) {
  if (!info) return undefined
  return info.capabilitySource === 'reported' ? info.capabilities.tools : undefined
}

function cleanError(err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || /timed out/i.test(err.message)) return 'Server did not respond'
    return err.message
  }
  return String(err)
}
