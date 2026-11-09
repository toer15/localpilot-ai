import type { AgentProfile, AppSettings } from './types'

export const DEFAULT_PROFILES: AgentProfile[] = [
  {
    id: 'general',
    name: 'General assistant',
    description: 'Everyday tasks with the full built-in toolkit.',
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 32768,
    reasoningEffort: 'medium',
    toolProtocol: 'auto',
    maxIterations: 25,
    allowedGroups: null,
    systemSuffix: 'Be concise, practical and honest about what you verified.'
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Project-aware software engineering with verification.',
    temperature: 0.25,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 32768,
    reasoningEffort: 'high',
    toolProtocol: 'auto',
    maxIterations: 40,
    allowedGroups: ['files', 'terminal', 'git', 'projects', 'memory', 'web', 'browser', 'agents'],
    systemSuffix:
      'Work like a senior engineer. Read before editing, keep changes scoped, run the build/tests after edits, and never claim something works unless you observed it working. Report exact commands and results.'
  },
  {
    id: 'reasoning',
    name: 'Deep reasoning',
    description: 'Longer deliberation, low temperature, minimal tooling.',
    temperature: 0.4,
    topP: 0.95,
    maxTokens: 8192,
    contextLength: 65536,
    reasoningEffort: 'max',
    toolProtocol: 'auto',
    maxIterations: 20,
    allowedGroups: ['files', 'memory', 'web', 'agents'],
    systemSuffix: 'Reason carefully. State assumptions and uncertainty explicitly.'
  },
  {
    id: 'computer',
    name: 'Computer control',
    description: 'Desktop automation with UI Automation and visual verification.',
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 32768,
    reasoningEffort: 'medium',
    toolProtocol: 'auto',
    maxIterations: 40,
    allowedGroups: ['computer', 'terminal', 'files', 'windows', 'uia', 'testing', 'memory'],
    systemSuffix:
      'Prefer Windows UI Automation over blind clicking. Take a screenshot before and after a desktop interaction, and describe what changed. Use testing.start before a test and testing.stop when it ends. Stop and ask if the screen shows something unexpected.'
  },
  {
    id: 'gamedev',
    name: 'Game development',
    description: 'Roblox Studio and game workflows with playtest loops.',
    temperature: 0.35,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 32768,
    reasoningEffort: 'high',
    toolProtocol: 'auto',
    maxIterations: 60,
    allowedGroups: ['computer', 'windows', 'uia', 'testing', 'files', 'terminal', 'git', 'projects', 'mcp', 'browser', 'web', 'memory', 'agents'],
    systemSuffix:
      'Build, playtest, read the output window, fix errors and retest. Use testing.start before playtesting a game or app, and testing.stop afterwards. Use the Roblox Studio MCP tools when connected; never fabricate playtest results.'
  }
]

export function defaultSettings(modelsDir: string): AppSettings {
  return {
    general: {
      theme: 'dark',
      language: 'en',
      startMinimized: false,
      notifications: true,
      showReasoning: true,
      density: 'comfortable',
      onboardingComplete: false
    },
    models: {
      providers: [
        {
          id: 'ollama',
          name: 'Ollama',
          type: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          enabled: true
        },
        {
          id: 'lmstudio',
          name: 'LM Studio',
          type: 'openai',
          baseUrl: 'http://127.0.0.1:1234',
          enabled: true
        },
        {
          id: 'llamacpp',
          name: 'llama.cpp server',
          type: 'openai',
          baseUrl: 'http://127.0.0.1:8080',
          enabled: true
        }
      ],
      defaultProviderId: null,
      defaultModelId: null,
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      contextLength: 32768,
      stream: true,
      gpuLayers: -1,
      keepAlive: '30m',
      modelsDir,
      llamaServerPath: '',
      llamaPort: 8080,
      autoStartLlama: false
    },
    agent: {
      maxIterations: 25,
      toolCallLimit: 60,
      timeoutMs: 180000,
      reasoningEffort: 'medium',
      toolProtocol: 'auto',
      profiles: DEFAULT_PROFILES,
      activeProfileId: 'general',
      allowSubagents: true,
      maxHistoryMessages: 40
    },
    computer: {
      enabled: true,
      // The agent is meant to operate this PC, not just chat. Profiles can
      // still narrow tools when the user turns full access off.
      fullAccess: true,
      screenshots: true,
      mouseKeyboard: true,
      windowControl: true,
      approvalMode: 'ask',
      allowlist: ['notepad.exe', 'explorer.exe', 'mspaint.exe'],
      stopShortcut: 'Control+Alt+Shift+X',
      automaticScreenshots: false
    },
    plugins: {
      autoUpdate: false,
      allowNetworkPlugins: false
    },
    privacy: {
      localOnly: false,
      storeConversations: true,
      logCommands: true,
      redactSecretsInMemory: true
    },
    advanced: {
      logLevel: 'info',
      customSystemPrompt: '',
      requestTimeoutMs: 240000,
      extraEndpoints: []
    },
    activeProjectId: null
  }
}

export const APP_NAME = 'LocalPilot AI'
export const APP_ID = 'ai.localpilot.desktop'

export const RISK_LABEL: Record<string, string> = {
  low: 'Low risk',
  medium: 'Needs care',
  high: 'High risk'
}
