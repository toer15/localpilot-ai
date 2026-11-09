import type { ModelInfo, ProviderConfig, ProviderStatus, ToolCallRequest } from '@shared/types'
import type { ChatProvider, ProviderChatRequest, ProviderChatResult, ProviderMessage, ProviderTool } from './types'
import { baseStatus, inferredCapabilities } from './types'
import { fetchJson, iterateSse, mimeFromDataUrl } from './http'
import { getSecret } from '../secrets'
import { log } from '../core/logger'

interface OpenAiModel {
  id: string
  object?: string
  owned_by?: string
  context_length?: number
  max_context_length?: number
}

interface StreamToolCall {
  index: number
  id?: string
  name?: string
  arguments: string
}

export class OpenAiCompatibleProvider implements ChatProvider {
  constructor(public config: ProviderConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    const key = getSecret(`provider:${this.config.id}`)
    if (key) headers.Authorization = `Bearer ${key}`
    return headers
  }

  private apiBase() {
    return `${this.config.baseUrl.replace(/\/$/, '')}/v1`
  }

  async ping(): Promise<ProviderStatus> {
    const status = baseStatus(this.config)
    try {
      const data = await fetchJson<{ data?: OpenAiModel[] }>(`${this.apiBase()}/models`, {
        timeoutMs: 2500,
        headers: this.headers()
      })
      status.running = true
      status.modelCount = data.data?.length ?? 0
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err)
    }
    if (this.config.id === 'lmstudio') {
      try {
        const { which } = await import('../core/proc')
        status.installed = Boolean(await which('lms'))
      } catch {
        status.installed = null
      }
    }
    return status
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await fetchJson<{ data?: OpenAiModel[] }>(`${this.apiBase()}/models`, {
      timeoutMs: 10000,
      headers: this.headers()
    })
    return (data.data ?? []).map((model) => {
      const inferred = inferredCapabilities(model.id)
      return {
        id: model.id,
        name: model.id,
        providerId: this.config.id,
        providerName: this.config.name,
        kind: inferred.embeddings ? 'embedding' : 'chat',
        contextLength: model.context_length ?? model.max_context_length,
        capabilities: {
          tools: false,
          vision: inferred.vision,
          thinking: inferred.thinking,
          completion: !inferred.embeddings,
          embeddings: inferred.embeddings
        },
        capabilitySource: 'unknown' as const,
        source: 'local' as const
      } satisfies ModelInfo
    })
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => this.mapMessage(m, Boolean(request.modelInfo?.capabilities.vision))),
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: true
    }
    if (request.tools?.length) {
      body.tools = request.tools.map(formatTool)
      body.tool_choice = 'auto'
    }
    if (request.reasoningEffort !== 'none') {
      // Local servers vary in their support; only send when the model actually reports thinking.
      if (request.modelInfo?.capabilities.thinking && request.modelInfo.capabilitySource === 'reported') {
        body.reasoning_effort = request.reasoningEffort === 'ultra' ? 'high' : request.reasoningEffort
      }
    }

    const doRequest = async (withTools: boolean) => {
      const payload = { ...body }
      if (!withTools) {
        delete payload.tools
        delete payload.tool_choice
      }
      return fetch(`${this.apiBase()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(payload),
        signal: request.signal
      })
    }

    let res = await doRequest(Boolean(body.tools))
    if (!res.ok && body.tools) {
      const detail = await res.text().catch(() => '')
      // Some local servers reject tool schemas; retry once without native tools so the
      // text protocol fallback can still work.
      if (res.status === 400 || res.status === 422) {
        log.warn('openai', `Tool request rejected by ${this.config.name}, retrying without tools`)
        res = await doRequest(false)
      } else {
        throw new Error(`${this.config.name} ${res.status}: ${detail.slice(0, 600)}`)
      }
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${this.config.name} ${res.status}: ${detail.slice(0, 600) || res.statusText}`)
    }

    let text = ''
    let reasoning = ''
    let finishReason: string | undefined
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    const pendingTools = new Map<number, StreamToolCall>()

    for await (const chunk of iterateSse(res, request.signal)) {
      if (chunk.error) {
        const err = chunk.error as { message?: string }
        throw new Error(err.message ?? JSON.stringify(err))
      }
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
      if (usage) {
        inputTokens = usage.prompt_tokens
        outputTokens = usage.completion_tokens
      }
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
      if (!choice) continue
      finishReason = (choice.finish_reason as string | null) ?? finishReason ?? undefined
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) continue
      const content = delta.content
      if (typeof content === 'string' && content) {
        text += content
        request.onDelta?.(content)
      }
      const reasoningDelta =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : ''
      if (reasoningDelta) {
        reasoning += reasoningDelta
        request.onReasoning?.(reasoningDelta)
      }
      const toolDeltas = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined
      if (Array.isArray(toolDeltas)) {
        for (const t of toolDeltas) {
          const index = t.index ?? 0
          const existing = pendingTools.get(index) ?? { index, arguments: '' }
          if (t.id) existing.id = t.id
          if (t.function?.name) existing.name = t.function.name
          if (t.function?.arguments) existing.arguments += t.function.arguments
          pendingTools.set(index, existing)
        }
      }
    }

    const toolCalls: ToolCallRequest[] = []
    for (const call of [...pendingTools.values()].sort((a, b) => a.index - b.index)) {
      if (!call.name) continue
      toolCalls.push({
        id: call.id ?? `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`,
        name: call.name,
        arguments: parseArguments(call.arguments)
      })
    }

    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      finishReason,
      usage: { inputTokens, outputTokens }
    }
  }

  private mapMessage(message: ProviderMessage, allowImages: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { role: message.role }
    if (message.role === 'tool') {
      out.content = message.content
      if (message.toolCallId) out.tool_call_id = message.toolCallId
      if (message.name) out.name = message.name
      return out
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.content = message.content || null
      out.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
      return out
    }
    if (message.images?.length && allowImages) {
      out.content = [
        { type: 'text', text: message.content || 'Describe this image.' },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${mimeFromDataUrl(image)};base64,${image}` }
        }))
      ]
    } else {
      out.content = message.content
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

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}
