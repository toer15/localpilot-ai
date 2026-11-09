/**
 * Shared contracts between the Electron main process and the React renderer.
 * Everything in this file must stay dependency-free so both sides can import it.
 */

export type Risk = 'low' | 'medium' | 'high'
export type ThemeMode = 'dark' | 'light'
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max' | 'ultra'
export type ToolProtocol = 'auto' | 'native' | 'text'
export type ApprovalMode = 'ask' | 'session' | 'auto-safe'
export type ToolSource = 'builtin' | 'native' | 'mcp' | 'subagent'

export interface ProviderConfig {
  id: string
  name: string
  type: 'ollama' | 'openai'
  baseUrl: string
  enabled: boolean
  hasKey?: boolean
  managed?: boolean
  note?: string
}

export interface ModelCapabilities {
  tools: boolean
  vision: boolean
  thinking: boolean
  completion: boolean
  embeddings: boolean
}

export type CapabilitySource = 'reported' | 'inferred' | 'unknown'

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  kind: 'chat' | 'embedding' | 'unknown'
  sizeBytes?: number
  modifiedAt?: string
  family?: string
  parameterSize?: string
  quantization?: string
  contextLength?: number
  capabilities: ModelCapabilities
  capabilitySource: CapabilitySource
  loaded?: boolean
  vramBytes?: number
  filePath?: string
  source?: 'local' | 'download' | 'import'
}

export interface ProviderStatus extends ProviderConfig {
  running: boolean
  version?: string
  installed?: boolean | null
  error?: string
  modelCount?: number
}

export interface HardwareGpu {
  name: string
  vendor: string
  vramBytes?: number
  driver?: string
}

export interface HardwareInfo {
  os: string
  cpu: { model: string; cores: number; threads: number }
  ram: { totalBytes: number; availableBytes: number }
  gpus: HardwareGpu[]
  disks: { name: string; freeBytes?: number; totalBytes?: number }[]
  acceleration: { cuda: boolean; vulkan: boolean; rocm: boolean }
  recommendations: {
    gpuLayers: number
    contextLength: number
    quantization: string
    summary: string
  }
  capturedAt: string
}

export interface AgentProfile {
  id: string
  name: string
  description: string
  temperature: number
  topP: number
  maxTokens: number
  contextLength: number
  reasoningEffort: ReasoningEffort
  toolProtocol: ToolProtocol
  maxIterations: number
  allowedGroups: string[] | null
  systemSuffix: string
}

export interface AppSettings {
  general: {
    theme: ThemeMode
    language: string
    startMinimized: boolean
    notifications: boolean
    showReasoning: boolean
    density: 'comfortable' | 'compact'
    onboardingComplete: boolean
  }
  models: {
    providers: ProviderConfig[]
    defaultProviderId: string | null
    defaultModelId: string | null
    temperature: number
    topP: number
    maxTokens: number
    contextLength: number
    stream: boolean
    gpuLayers: number
    keepAlive: string
    modelsDir: string
    llamaServerPath: string
    llamaPort: number
    autoStartLlama: boolean
  }
  agent: {
    maxIterations: number
    toolCallLimit: number
    timeoutMs: number
    reasoningEffort: ReasoningEffort
    toolProtocol: ToolProtocol
    profiles: AgentProfile[]
    activeProfileId: string
    allowSubagents: boolean
    maxHistoryMessages: number
  }
  computer: {
    enabled: boolean
    fullAccess: boolean
    screenshots: boolean
    mouseKeyboard: boolean
    windowControl: boolean
    approvalMode: ApprovalMode
    allowlist: string[]
    stopShortcut: string
    automaticScreenshots: boolean
  }
  plugins: {
    autoUpdate: boolean
    allowNetworkPlugins: boolean
  }
  privacy: {
    localOnly: boolean
    storeConversations: boolean
    logCommands: boolean
    redactSecretsInMemory: boolean
  }
  advanced: {
    logLevel: 'info' | 'debug'
    customSystemPrompt: string
    requestTimeoutMs: number
    extraEndpoints: ProviderConfig[]
  }
  activeProjectId: string | null
}

export interface Project {
  id: string
  name: string
  path: string
  instructions: string
  createdAt: string
  updatedAt: string
}

export interface ConversationSummary {
  id: string
  title: string
  projectId: string | null
  providerId: string | null
  modelId: string | null
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface Attachment {
  id: string
  name: string
  path: string
  kind: 'image' | 'file'
  mime?: string
  size?: number
  dataUrl?: string
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'denied' | 'cancelled'
  result?: string
  data?: unknown
  images?: string[]
  durationMs?: number
  startedAt?: string
  finishedAt?: string
}

export interface StoredMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: ToolCallRecord[]
  attachments?: Attachment[]
  providerId?: string
  modelId?: string
  createdAt: string
  meta?: Record<string, unknown>
}

export interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[]
}

export interface RunRequest {
  conversationId: string
  text: string
  attachments?: Attachment[]
  providerId: string
  modelId: string
  projectId: string | null
  profileId?: string
  reasoningEffort?: ReasoningEffort
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Replace this user message and drop every turn after it instead of adding a new message. */
  replaceMessageId?: string
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: Risk
  category: string
  group: string
  source: ToolSource
  pluginId?: string
  enabled: boolean
}

export interface ToolExecutionResult {
  ok: boolean
  content: string
  data?: unknown
  images?: string[]
  durationMs?: number
}

export type PermissionDecision = 'allow' | 'allow-session' | 'allow-always' | 'deny'

export interface PermissionRequest {
  id: string
  runId: string
  tool: string
  args: Record<string, unknown>
  risk: Risk
  title: string
  detail: string
  sessionKey: string
  createdAt: string
}

export interface PermissionResponse {
  id: string
  decision: PermissionDecision
}

export type AgentPhase =
  | 'thinking'
  | 'streaming'
  | 'planning'
  | 'tool'
  | 'awaiting-permission'
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'error'

export type AgentEvent =
  | { type: 'run_start'; runId: string; conversationId: string; providerId: string; modelId: string }
  | { type: 'status'; runId: string; phase: AgentPhase; message: string }
  | { type: 'assistant_delta'; runId: string; text: string }
  | { type: 'reasoning_delta'; runId: string; text: string }
  | { type: 'assistant_message'; runId: string; message: StoredMessage }
  | { type: 'tool_call'; runId: string; call: ToolCallRecord }
  | { type: 'tool_update'; runId: string; call: ToolCallRecord }
  | { type: 'notice'; runId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'run_end'; runId: string; reason: 'complete' | 'stopped' | 'error' | 'limit'; error?: string; usage?: { inputTokens?: number; outputTokens?: number } }

export interface MemoryItem {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  key: string
  value: string
  createdAt: string
}

export interface ActivityItem {
  id: string
  kind: string
  summary: string
  detail?: unknown
  createdAt: string
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  autoStart?: boolean
  source?: string
  notes?: string
}

export type PluginSource = 'builtin' | 'native' | 'mcp'

export interface PluginInfo {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: string
  icon: string
  permissions: string[]
  os: string[]
  source: PluginSource
  enabled: boolean
  installed: boolean
  installedAt?: string
  sizeBytes?: number
  homepage?: string
  builtinGroups?: string[]
  tools?: { name: string; description: string; risk: Risk }[]
  mcp?: McpServerConfig
  config?: Record<string, unknown>
  error?: string
}

export interface CatalogPlugin {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: string
  icon: string
  featured?: boolean
  permissions: string[]
  os: string[]
  installKind: 'builtin' | 'mcp'
  builtinGroups?: string[]
  packageName?: string
  command?: string
  args?: string[]
  homepage?: string
  requirements?: string
  notes?: string
  remote?: boolean
}

export interface ModelCatalogItem {
  id: string
  name: string
  developer: string
  description: string
  tags: string[]
  downloads?: number
  likes?: number
  updatedAt?: string
  source: 'huggingface' | 'ollama' | 'curated'
  sizeBytes?: number
  gated?: boolean
  capabilities: ModelCapabilities
  capabilitySource: CapabilitySource
  files?: { name: string; sizeBytes?: number }[]
  pullName?: string
}

export interface DownloadTask {
  id: string
  name: string
  kind: 'ollama' | 'gguf' | 'runtime'
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBps?: number
  error?: string
  filePath?: string
  startedAt: string
  updatedAt: string
}

export interface LlamaRuntimeStatus {
  installed: boolean
  running: boolean
  path?: string
  version?: string
  variant?: string
  managed?: boolean
}

export interface LocalModelFile {
  id: string
  name: string
  filePath: string
  sizeBytes?: number
  addedAt: string
  quantization?: string
  contextLength?: number
}

export interface TerminalSession {
  id: string
  command: string
  cwd: string
  status: 'running' | 'exited' | 'killed' | 'error'
  pid?: number
  exitCode?: number | null
  startedAt: string
  endedAt?: string
  outputTail?: string
}

export interface BrowserState {
  open: boolean
  url?: string
  title?: string
  engine?: string
  error?: string
}

export interface UiElement {
  name: string
  automationId: string
  controlType: string
  className?: string
  enabled?: boolean
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface ComputerCapabilities {
  enabled: boolean
  screenshots: boolean
  mouseKeyboard: boolean
  windows: boolean
  automation: boolean
  lastError?: string
}

export interface SelfTestCheck {
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
  durationMs?: number
}

export interface SelfTestReport {
  startedAt: string
  finishedAt: string
  appVersion: string
  checks: SelfTestCheck[]
  environment: {
    platform: string
    release: string
    arch: string
    electron: string
    node: string
    userData: string
  }
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  userData: string
  dataDir: string
  modelsDir: string
  logsDir: string
  isPackaged: boolean
  toolsCount: number
  dbBytes: number
}

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export interface AppUpdateStatus {
  phase: AppUpdatePhase
  currentVersion: string
  version?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  message?: string
}

export interface ChatSendResult {
  runId: string
}

export interface SavedSecretInfo {
  key: string
  saved: boolean
}

export interface RuntimeDependency {
  id: string
  name: string
  kind: 'model-runtime' | 'browser' | 'tool'
  installed: boolean
  running?: boolean
  path?: string
  version?: string
  installUrl: string
  note: string
}

export interface GitHubReleaseInfo {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  notes?: string
}
