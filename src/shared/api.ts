/** Typed bridge exposed by the preload script as window.localpilot. */
import type {
  ActivityItem,
  AgentEvent,
  AppInfo,
  AppSettings,
  AppUpdateStatus,
  BrowserState,
  CatalogPlugin,
  ChatSendResult,
  ComputerCapabilities,
  ConversationDetail,
  ConversationSummary,
  DownloadTask,
  HardwareInfo,
  LocalModelFile,
  McpServerConfig,
  MemoryItem,
  ModelCatalogItem,
  ModelInfo,
  PermissionRequest,
  PermissionResponse,
  PluginInfo,
  Project,
  ProviderStatus,
  RunRequest,
  RuntimeDependency,
  SelfTestReport,
  StoredMessage,
  TerminalSession,
  ToolSchema,
  UiElement
} from './types'

export interface LocalPilotApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    selectFolder(title?: string): Promise<string | null>
    selectFiles(filters?: { name: string; extensions: string[] }[]): Promise<string[]>
    window(action: 'minimize' | 'maximize' | 'close'): Promise<void>
    emergencyStop(): Promise<void>
    runSelfTest(): Promise<SelfTestReport>
  }
  updates: {
    status(): Promise<AppUpdateStatus>
    check(): Promise<AppUpdateStatus>
    install(): Promise<AppUpdateStatus>
    onStatus(listener: (status: AppUpdateStatus) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: unknown): Promise<AppSettings>
    reset(): Promise<AppSettings>
  }
  models: {
    providers(): Promise<ProviderStatus[]>
    discover(force?: boolean): Promise<ModelInfo[]>
    hardware(force?: boolean): Promise<HardwareInfo>
    startProvider(id: string): Promise<ProviderStatus>
    unload(modelId: string, providerId: string): Promise<boolean>
    delete(modelId: string, providerId: string): Promise<boolean>
    show(modelId: string): Promise<Record<string, unknown>>
    catalogSearch(query: string, source?: 'huggingface' | 'ollama'): Promise<ModelCatalogItem[]>
    hfFiles(repoId: string): Promise<{ name: string; sizeBytes?: number }[]>
    pullOllama(name: string): Promise<DownloadTask>
    downloadGguf(repoId: string, file: string): Promise<DownloadTask>
    downloads(): Promise<DownloadTask[]>
    cancelDownload(id: string): Promise<void>
    importGguf(): Promise<LocalModelFile | null>
    localModels(): Promise<LocalModelFile[]>
    removeLocalModel(id: string): Promise<void>
    launchLlama(filePath: string, extra?: { contextLength?: number; gpuLayers?: number }): Promise<ProviderStatus>
    stopLlama(): Promise<boolean>
    setApiKey(providerId: string, key: string): Promise<boolean>
    setEndpoint(providerId: string, baseUrl: string): Promise<ProviderStatus[]>
    addEndpoint(input: { name: string; baseUrl: string; type?: 'ollama' | 'openai' }): Promise<ProviderStatus[]>
    removeEndpoint(providerId: string): Promise<ProviderStatus[]>
    dependencies(): Promise<RuntimeDependency[]>
  }
  chat: {
    list(projectId?: string | null): Promise<ConversationSummary[]>
    create(input?: { title?: string; projectId?: string | null; providerId?: string | null; modelId?: string | null }): Promise<ConversationSummary>
    get(id: string): Promise<ConversationDetail | null>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    send(request: RunRequest): Promise<ChatSendResult>
    stop(runId?: string): Promise<void>
    onEvent(listener: (event: AgentEvent) => void): () => void
    activeRuns(): Promise<{ runId: string; conversationId: string }[]>
  }
  tools: {
    list(): Promise<ToolSchema[]>
    onPermission(listener: (request: PermissionRequest) => void): () => void
    respond(response: PermissionResponse): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: { name: string; path: string; instructions?: string }): Promise<Project>
    open(path: string, name?: string): Promise<Project>
    update(id: string, patch: { name?: string; instructions?: string; path?: string }): Promise<Project>
    remove(id: string, deleteFiles?: boolean): Promise<void>
    setActive(id: string | null): Promise<AppSettings>
    inspect(id: string): Promise<{ project: Project; files: { path: string; sizeBytes: number; modifiedAt: string }[]; git?: { branch: string; changes: number } }>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    catalog(): Promise<CatalogPlugin[]>
    install(id: string): Promise<PluginInfo>
    installFolder(): Promise<PluginInfo | null>
    uninstall(id: string): Promise<void>
    setEnabled(id: string, enabled: boolean): Promise<PluginInfo>
    configure(id: string, config: Record<string, unknown>): Promise<PluginInfo>
    mcpServers(): Promise<McpServerConfig[]>
    addMcpServer(config: Partial<McpServerConfig> & { name: string }): Promise<PluginInfo>
    updateMcpServer(id: string, patch: Partial<McpServerConfig>): Promise<PluginInfo>
    startMcp(id: string): Promise<PluginInfo>
    stopMcp(id: string): Promise<void>
    testMcp(id: string): Promise<{ ok: boolean; tools: number; error?: string }>
  }
  memory: {
    list(projectId?: string | null): Promise<MemoryItem[]>
    save(input: { scope: 'global' | 'project'; projectId?: string | null; key: string; value: string }): Promise<MemoryItem>
    update(id: string, patch: { key?: string; value?: string }): Promise<MemoryItem>
    remove(id: string): Promise<void>
  }
  activity: {
    list(limit?: number): Promise<ActivityItem[]>
    clear(): Promise<void>
    onUpdate(listener: (item: ActivityItem) => void): () => void
  }
  computer: {
    capabilities(): Promise<ComputerCapabilities>
    screenshot(): Promise<{ path: string; dataUrl?: string; width?: number; height?: number }>
    windows(): Promise<{ title: string; processName: string; pid: number; hwnd: number; minimized?: boolean }[]>
    uiTree(depth?: number): Promise<UiElement[]>
    testMode(
      action: 'start' | 'stop' | 'status' | 'move',
      point?: { x: number; y: number }
    ): Promise<{
      active: boolean
      stopKey: string
      shortcutRegistered: boolean
      label: string
    }>
  }
  terminal: {
    sessions(): Promise<TerminalSession[]>
    kill(id: string): Promise<void>
    onUpdate(listener: (session: TerminalSession) => void): () => void
  }
  browser: {
    state(): Promise<BrowserState>
    close(): Promise<void>
  }
}
