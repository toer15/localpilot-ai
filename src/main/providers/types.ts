import type { ModelInfo, ProviderConfig, ProviderStatus, ReasoningEffort, ToolCallRequest } from '@shared/types'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** base64 without a data: prefix */
  images?: string[]
  toolCalls?: ToolCallRequest[]
  toolCallId?: string
  name?: string
}

export interface ProviderTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ProviderChatRequest {
  model: string
  modelInfo?: ModelInfo
  messages: ProviderMessage[]
  tools?: ProviderTool[]
  temperature: number
  topP: number
  maxTokens: number
  contextLength: number
  reasoningEffort: ReasoningEffort
  stream: boolean
  signal: AbortSignal
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
}

export interface ProviderChatResult {
  text: string
  reasoning?: string
  toolCalls: ToolCallRequest[]
  finishReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ChatProvider {
  config: ProviderConfig
  ping(): Promise<ProviderStatus>
  listModels(): Promise<ModelInfo[]>
  chat(request: ProviderChatRequest): Promise<ProviderChatResult>
}

export function baseStatus(config: ProviderConfig): ProviderStatus {
  return { ...config, running: false }
}

export function inferredCapabilities(name: string) {
  const n = name.toLowerCase()
  const vision =
    /vision|vl|llava|bakllava|gemma3|pixtral|qwen2\.5-vl|qwen3-vl|moondream|minicpm-v|internvl/.test(n)
  const tools = /qwen|hermes|mistral|devstral|llama3\.[13]|granite|command-r|functionary|phi-4|deepseek/.test(n)
  const thinking = /qwen3|reason|thinking|r1|qwq|magistral/.test(n)
  return { tools, vision, thinking, completion: true, embeddings: /embed|bge|nomic|e5-/.test(n) }
}
