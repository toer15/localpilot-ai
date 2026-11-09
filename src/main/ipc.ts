import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  McpServerConfig,
  PermissionResponse,
  RunRequest
} from '@shared/types'
import { appVersion, getPaths } from './core/paths'
import { databaseSize } from './db'
import { settings } from './settings'
import { setLogLevel, log } from './core/logger'
import { detectHardware } from './hardware'
import { providers } from './providers/manager'
import { llamaServer } from './providers/llama'
import { getSecret, hasSecret, setSecret } from './secrets'
import { toolRegistry } from './tools'
import { agentRunner } from './agent/agent'
import { addMessage, autoTitle, createConversation, deleteConversation, getConversation, listConversations, replaceUserMessage, setConversationModel, setConversationTitle, truncateAfterMessage } from './conversations'
import { createProject, getActiveProject, getProject, listProjects, projectFiles, removeProject, updateProject } from './projects'
import { listMemories, removeMemory, saveMemory, updateMemory } from './memory'
import { listActivity, clearActivity } from './activity'
import { pluginManager } from './plugins/manager'
import { listDownloads, pullOllamaModel, downloadGguf, cancelDownload, hfFiles, importLocalModel, listLocalModels, removeLocalModel, llamaRuntimeStatus, downloadLlamaRuntime } from './models/downloads'
import { catalogSearch } from './models/catalog'
import { respondPermission } from './permissions'
import { applyStopShortcut } from './shortcuts'
import { emergencyStop } from './emergency'
import { browserManager } from './browser'
import { captureScreen, listWindows, mouseAction, uiTree } from './computer'
import { aiOverlay } from './computer/overlay'
import { killSession, listSessions } from './tools/terminal'
import { runSelfTest } from './selftest'
import { checkForUpdates, getUpdateStatus, installUpdate } from './updater'
import { recordActivity } from './activity'
import { runProcess } from './core/proc'

const CHANNELS = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset'
}

export function registerIpc() {
  // ---------- app ----------
  ipcMain.handle('app:info', () => ({
    version: appVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    userData: getPaths().userData,
    dataDir: getPaths().dataDir,
    modelsDir: providers.modelsDir(),
    logsDir: getPaths().logsDir,
    isPackaged: app.isPackaged,
    toolsCount: toolRegistry.list().length,
    dbBytes: databaseSize()
  }))

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.')
    await shell.openExternal(url)
  })
  ipcMain.handle('app:showItemInFolder', (_e, target: string) => {
    shell.showItemInFolder(target)
  })
  ipcMain.handle('app:selectFolder', async (_e, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? 'Select a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('app:selectFiles', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: filters?.length ? filters : [{ name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('app:window', (event, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize())
    else win.close()
  })
  ipcMain.handle('app:emergencyStop', async () => {
    await emergencyStop()
  })
  ipcMain.handle('app:runSelfTest', async () => {
    return runSelfTest({ fullChat: true, screenshot: true })
  })

  // ---------- updates ----------
  ipcMain.handle('updater:status', () => getUpdateStatus())
  ipcMain.handle('updater:check', () => checkForUpdates(true))
  ipcMain.handle('updater:install', () => installUpdate())

  // ---------- settings ----------
  ipcMain.handle(CHANNELS.settingsGet, () => settings.get())
  ipcMain.handle(CHANNELS.settingsUpdate, (_e, patch: unknown) => {
    const next = settings.update(patch)
    setLogLevel(next.advanced.logLevel)
    providers.invalidate()
    applyStopShortcut()
    return next
  })
  ipcMain.handle(CHANNELS.settingsReset, () => {
    const next = settings.reset()
    providers.invalidate()
    applyStopShortcut()
    return next
  })

  // ---------- models ----------
  ipcMain.handle('models:providers', () => providers.getStatuses(true))
  ipcMain.handle('models:discover', (_e, force?: boolean) => providers.listModels(Boolean(force)))
  ipcMain.handle('models:hardware', (_e, force?: boolean) => detectHardware(Boolean(force)))
  ipcMain.handle('models:startProvider', async (_e, id: string) => {
    const status = await providers.startProvider(id)
    providers.invalidate()
    return status
  })
  ipcMain.handle('models:unload', async (_e, modelId: string, providerId: string) => {
    if (providerId !== 'ollama') throw new Error('Unloading is only supported for Ollama models. Stop the llama.cpp server instead.')
    const provider = settings.get().models.providers.find((p) => p.id === 'ollama')
    if (!provider) throw new Error('Ollama is not configured.')
    const res = await fetch(`${provider.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: 0 }),
      signal: AbortSignal.timeout(15000)
    })
    providers.invalidate()
    return res.ok
  })
  ipcMain.handle('models:delete', async (_e, modelId: string, providerId: string) => {
    if (providerId !== 'ollama') {
      throw new Error('Only Ollama models can be deleted here. Remove imported GGUF files from the local model list instead.')
    }
    const provider = settings.get().models.providers.find((p) => p.id === 'ollama')
    if (!provider) throw new Error('Ollama is not configured.')
    const res = await fetch(`${provider.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) throw new Error(`Ollama delete failed: ${res.status} ${await res.text()}`)
    providers.invalidate()
    recordActivity('model', `Deleted Ollama model ${modelId}`)
    return true
  })
  ipcMain.handle('models:show', async (_e, modelId: string) => {
    const provider = settings.get().models.providers.find((p) => p.id === 'ollama')
    if (!provider) throw new Error('Ollama is not configured.')
    const res = await fetch(`${provider.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId })
    })
    if (!res.ok) throw new Error(`Ollama show failed: ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  })
  ipcMain.handle('models:catalogSearch', (_e, query: string, source?: 'curated' | 'huggingface' | 'ollama') =>
    catalogSearch(query, source)
  )
  ipcMain.handle('models:hfFiles', (_e, repoId: string) => hfFiles(repoId))
  ipcMain.handle('models:pullOllama', (_e, name: string) => pullOllamaModel(name))
  ipcMain.handle('models:downloadGguf', (_e, repoId: string, file: string) => downloadGguf(repoId, file))
  ipcMain.handle('models:llamaRuntime', () => llamaRuntimeStatus())
  ipcMain.handle('models:installLlamaRuntime', async () => {
    const task = await downloadLlamaRuntime()
    providers.invalidate()
    return task
  })
  ipcMain.handle('models:downloads', () => listDownloads())
  ipcMain.handle('models:cancelDownload', (_e, id: string) => cancelDownload(id))
  ipcMain.handle('models:importGguf', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importLocalModel(result.filePaths[0])
  })
  ipcMain.handle('models:localModels', () => listLocalModels())
  ipcMain.handle('models:removeLocalModel', (_e, id: string) => removeLocalModel(id))
  ipcMain.handle('models:launchLlama', async (_e, filePath: string, extra?: { contextLength?: number; gpuLayers?: number }) => {
    const status = await llamaServer.start(filePath, extra ?? {})
    providers.invalidate()
    return status
  })
  ipcMain.handle('models:stopLlama', async () => {
    const stopped = await llamaServer.stop()
    providers.invalidate()
    return stopped
  })
  ipcMain.handle('models:setApiKey', (_e, providerId: string, key: string) => {
    const secretId = providerId === 'huggingface' ? 'huggingface' : `provider:${providerId}`
    const ok = setSecret(secretId, String(key ?? '').trim())
    providers.invalidate()
    return ok
  })
  ipcMain.handle('models:setEndpoint', async (_e, providerId: string, baseUrl: string) => {
    const clean = String(baseUrl ?? '').trim().replace(/\/$/, '')
    if (!/^https?:\/\//.test(clean)) throw new Error('Endpoint must start with http:// or https://')
    const current = settings.get()
    const providersList = current.models.providers.map((p) =>
      p.id === providerId ? { ...p, baseUrl: clean } : p
    )
    const extra = (current.advanced.extraEndpoints ?? []).map((p) =>
      p.id === providerId ? { ...p, baseUrl: clean } : p
    )
    settings.update({ models: { providers: providersList }, advanced: { extraEndpoints: extra } })
    if (providerId === 'llamacpp') {
      try {
        const port = Number(new URL(clean).port) || 8080
        settings.update({ models: { llamaPort: port } })
      } catch {
        // ignore invalid port
      }
    }
    providers.invalidate()
    return providers.getStatuses(true)
  })
  ipcMain.handle('models:addEndpoint', async (_e, input: { name: string; baseUrl: string; type?: 'ollama' | 'openai' }) => {
    const name = String(input?.name ?? '').trim()
    const baseUrl = String(input?.baseUrl ?? '').trim().replace(/\/$/, '')
    if (!name) throw new Error('Give the endpoint a name.')
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Endpoint must start with http:// or https://')
    const config = {
      id: `custom-${randomUUID().slice(0, 8)}`,
      name,
      type: input.type === 'ollama' ? ('ollama' as const) : ('openai' as const),
      baseUrl,
      enabled: true
    }
    settings.update({ advanced: { extraEndpoints: [...(settings.get().advanced.extraEndpoints ?? []), config] } })
    providers.invalidate()
    return providers.getStatuses(true)
  })
  ipcMain.handle('models:removeEndpoint', async (_e, providerId: string) => {
    settings.update({
      advanced: {
        extraEndpoints: (settings.get().advanced.extraEndpoints ?? []).filter((p) => p.id !== providerId)
      }
    })
    providers.invalidate()
    return providers.getStatuses(true)
  })
  ipcMain.handle('models:dependencies', () => providers.runtimeDependencies())
  ipcMain.handle('models:hasSecret', (_e, id: string) => hasSecret(id === 'huggingface' ? 'huggingface' : `provider:${id}`))

  // ---------- chat ----------
  ipcMain.handle('chat:list', (_e, projectId?: string | null) =>
    listConversations(projectId === undefined ? undefined : projectId)
  )
  ipcMain.handle('chat:create', (_e, input?: { title?: string; projectId?: string | null; providerId?: string | null; modelId?: string | null }) => {
    const s = settings.get()
    return createConversation({
      title: input?.title,
      projectId: input?.projectId ?? s.activeProjectId,
      providerId: input?.providerId ?? s.models.defaultProviderId,
      modelId: input?.modelId ?? s.models.defaultModelId
    })
  })
  ipcMain.handle('chat:get', (_e, id: string) => getConversation(id))
  ipcMain.handle('chat:rename', (_e, id: string, title: string) => setConversationTitle(id, title))
  ipcMain.handle('chat:remove', (_e, id: string) => deleteConversation(id))
  ipcMain.handle('chat:activeRuns', () => agentRunner.active())
  ipcMain.handle('chat:stop', (_e, runId?: string) => agentRunner.stop(runId))

  ipcMain.handle('chat:send', async (_e, request: RunRequest) => {
    if (!request?.conversationId) throw new Error('Missing conversation.')
    const conversation = getConversation(request.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const text = String(request.text ?? '').trim()
    if (!text && !request.attachments?.length) throw new Error('Write a message or attach a file first.')
    agentRunner.stopConversation(request.conversationId)

    let finalText = text
    for (const attachment of request.attachments ?? []) {
      if (attachment.kind === 'file') {
        try {
          const stat = fs.statSync(attachment.path)
          if (stat.size <= 200_000) {
            finalText += `\n\n<attached-file name="${attachment.name}">\n${fs.readFileSync(attachment.path, 'utf8')}\n</attached-file>`
          } else {
            finalText += `\n\n[Attached file ${attachment.name} at ${attachment.path} — too large to inline (${stat.size} bytes).]`
          }
        } catch {
          finalText += `\n\n[Attached file could not be read: ${attachment.name}]`
        }
      }
    }

    const replaceId = typeof request.replaceMessageId === 'string' ? request.replaceMessageId : null
    if (replaceId) {
      // Editing a sent message rewinds the conversation: the edited turn becomes
      // the newest message and every later turn is discarded.
      const replaced = replaceUserMessage(request.conversationId, replaceId, finalText, request.attachments)
      if (!replaced) throw new Error('That message can no longer be edited. Reopen the conversation and try again.')
      truncateAfterMessage(request.conversationId, replaceId)
    } else {
      addMessage(request.conversationId, {
        role: 'user',
        content: finalText,
        attachments: request.attachments,
        providerId: request.providerId,
        modelId: request.modelId
      })
    }
    setConversationModel(request.conversationId, request.providerId, request.modelId)
    autoTitle(request.conversationId, text)
    settings.update({
      models: { defaultProviderId: request.providerId, defaultModelId: request.modelId },
      activeProjectId: request.projectId ?? settings.get().activeProjectId
    })
    const { runId } = await agentRunner.start(request)
    return { runId }
  })

  // ---------- permissions & tools ----------
  ipcMain.handle('tools:list', () => toolRegistry.list())
  ipcMain.handle('permissions:respond', (_e, response: PermissionResponse) => {
    if (!response?.id) return false
    return respondPermission(response.id, response.decision)
  })

  // ---------- projects ----------
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, input: { name: string; path: string; instructions?: string }) => createProject(input))
  ipcMain.handle('projects:open', (_e, projectPath: string, name?: string) => {
    const project = createProject({ name: name ?? path.basename(projectPath), path: projectPath })
    settings.update({ activeProjectId: project.id })
    return project
  })
  ipcMain.handle('projects:update', (_e, id: string, patch: { name?: string; instructions?: string; path?: string }) =>
    updateProject(id, patch)
  )
  ipcMain.handle('projects:remove', (_e, id: string, deleteFiles?: boolean) => removeProject(id, Boolean(deleteFiles)))
  ipcMain.handle('projects:setActive', (_e, id: string | null) => {
    if (id && !getProject(id)) throw new Error('Project not found.')
    return settings.update({ activeProjectId: id })
  })
  ipcMain.handle('projects:inspect', async (_e, id: string) => {
    const project = getProject(id)
    if (!project) throw new Error('Project not found.')
    const files = projectFiles(project)
    let git: { branch: string; changes: number } | undefined
    if (fs.existsSync(path.join(project.path, '.git'))) {
      const res = await runProcess('git', ['-C', project.path, 'status', '--porcelain=v1', '-b'], { timeoutMs: 10000 })
      if (res.code === 0) {
        const lines = res.stdout.split(/\r?\n/).filter(Boolean)
        const header = lines.shift() ?? ''
        const branch = header.replace(/^##\s*/, '').split('...')[0] || 'unknown'
        git = { branch, changes: lines.length }
      }
    }
    return { project, files, git }
  })

  // ---------- plugins ----------
  ipcMain.handle('plugins:list', () => pluginManager.list())
  ipcMain.handle('plugins:catalog', () => pluginManager.catalog())
  ipcMain.handle('plugins:install', (_e, id: string) => pluginManager.install(id))
  ipcMain.handle('plugins:installFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a LocalPilot plugin folder (plugin.json + index.js)',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return pluginManager.installFolder(result.filePaths[0])
  })
  ipcMain.handle('plugins:uninstall', (_e, id: string) => pluginManager.uninstall(id))
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) => pluginManager.setEnabled(id, enabled))
  ipcMain.handle('plugins:configure', (_e, id: string, config: Record<string, unknown>) =>
    pluginManager.configure(id, config)
  )
  ipcMain.handle('plugins:mcpServers', () => pluginManager.mcpServers())
  ipcMain.handle('plugins:addMcp', (_e, config: Partial<McpServerConfig> & { name: string }) =>
    pluginManager.addMcpServer(config)
  )
  ipcMain.handle('plugins:updateMcp', (_e, id: string, patch: Partial<McpServerConfig>) =>
    pluginManager.updateMcpServer(id, patch)
  )
  ipcMain.handle('plugins:startMcp', (_e, id: string) => pluginManager.startMcp(id))
  ipcMain.handle('plugins:stopMcp', (_e, id: string) => pluginManager.stopMcp(id))
  ipcMain.handle('plugins:testMcp', (_e, id: string) => pluginManager.testMcp(id))

  // ---------- memory ----------
  ipcMain.handle('memory:list', (_e, projectId?: string | null) => listMemories(projectId ?? getActiveProject()?.id ?? null))
  ipcMain.handle('memory:save', (_e, input: { scope: 'global' | 'project'; projectId?: string | null; key: string; value: string }) =>
    saveMemory({ ...input, projectId: input.projectId ?? getActiveProject()?.id ?? null })
  )
  ipcMain.handle('memory:update', (_e, id: string, patch: { key?: string; value?: string }) => updateMemory(id, patch))
  ipcMain.handle('memory:remove', (_e, id: string) => removeMemory(id))

  // ---------- activity ----------
  ipcMain.handle('activity:list', (_e, limit?: number) => listActivity(limit))
  ipcMain.handle('activity:clear', () => clearActivity())

  // ---------- computer ----------
  ipcMain.handle('computer:capabilities', () => {
    const s = settings.get()
    return {
      enabled: s.computer.enabled,
      screenshots: s.computer.screenshots,
      mouseKeyboard: s.computer.mouseKeyboard,
      windows: s.computer.windowControl,
      automation: true
    }
  })
  ipcMain.handle('computer:screenshot', async () => {
    const shot = await captureScreen()
    return { path: shot.path, dataUrl: shot.dataUrl, width: shot.width, height: shot.height }
  })
  ipcMain.handle('computer:windows', () => listWindows())
  ipcMain.handle('computer:uiTree', (_e, depth?: number) => uiTree(depth ?? 3))
  ipcMain.handle(
    'computer:testMode',
    async (
      _e,
      action: 'start' | 'stop' | 'status' | 'move',
      point?: { x: number; y: number }
    ) => {
      if (action === 'start') await aiOverlay.start({ onStop: () => emergencyStop() })
      else if (action === 'stop') {
        // This is the user-facing stop control; Esc takes the same path. The
        // model's testing.stop tool only hides the overlay so it can summarize.
        if (aiOverlay.status().active) await emergencyStop()
        else aiOverlay.hide()
      } else if (action === 'move') {
        // Test-only hook: exercise the same mouse path as the AI so acceptance
        // can prove the overlay cursor is driven by actions, not the user pointer.
        if (process.env.LOCALPILOT_ACCEPTANCE !== '1') throw new Error('Test movement is unavailable.')
        const x = Number(point?.x)
        const y = Number(point?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Valid cursor coordinates are required.')
        if (!aiOverlay.isActive) throw new Error('AI test overlay is not active.')
        const result = await mouseAction({ action: 'move', x, y })
        if (!result.ok) throw new Error(result.error ?? 'Test mouse action failed.')
      }
      return aiOverlay.status()
    }
  )

  // ---------- terminal ----------
  ipcMain.handle('terminal:sessions', () => listSessions())
  ipcMain.handle('terminal:kill', (_e, id: string) => killSession(id))

  // ---------- browser ----------
  ipcMain.handle('browser:state', () => browserManager.state())
  ipcMain.handle('browser:close', () => browserManager.close())

  log.info('ipc', 'IPC handlers registered')
}

// Keep imports referenced for future channels without tree-shaking confusion.
void getSecret
void app
