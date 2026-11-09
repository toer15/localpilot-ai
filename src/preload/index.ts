import { contextBridge, ipcRenderer } from 'electron'
import type { LocalPilotApi } from '@shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void) {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: LocalPilotApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    showItemInFolder: (target) => ipcRenderer.invoke('app:showItemInFolder', target),
    selectFolder: (title) => ipcRenderer.invoke('app:selectFolder', title),
    selectFiles: (filters) => ipcRenderer.invoke('app:selectFiles', filters),
    window: (action) => ipcRenderer.invoke('app:window', action),
    emergencyStop: () => ipcRenderer.invoke('app:emergencyStop'),
    runSelfTest: () => ipcRenderer.invoke('app:runSelfTest')
  },
  updates: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (listener) => subscribe('updater:status', listener)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    reset: () => ipcRenderer.invoke('settings:reset')
  },
  models: {
    providers: () => ipcRenderer.invoke('models:providers'),
    discover: (force) => ipcRenderer.invoke('models:discover', force),
    hardware: (force) => ipcRenderer.invoke('models:hardware', force),
    startProvider: (id) => ipcRenderer.invoke('models:startProvider', id),
    unload: (modelId, providerId) => ipcRenderer.invoke('models:unload', modelId, providerId),
    delete: (modelId, providerId) => ipcRenderer.invoke('models:delete', modelId, providerId),
    show: (modelId) => ipcRenderer.invoke('models:show', modelId),
    catalogSearch: (query, source) => ipcRenderer.invoke('models:catalogSearch', query, source),
    hfFiles: (repoId) => ipcRenderer.invoke('models:hfFiles', repoId),
    pullOllama: (name) => ipcRenderer.invoke('models:pullOllama', name),
    downloadGguf: (repoId, file) => ipcRenderer.invoke('models:downloadGguf', repoId, file),
    downloads: () => ipcRenderer.invoke('models:downloads'),
    cancelDownload: (id) => ipcRenderer.invoke('models:cancelDownload', id),
    importGguf: () => ipcRenderer.invoke('models:importGguf'),
    localModels: () => ipcRenderer.invoke('models:localModels'),
    removeLocalModel: (id) => ipcRenderer.invoke('models:removeLocalModel', id),
    launchLlama: (filePath, extra) => ipcRenderer.invoke('models:launchLlama', filePath, extra),
    stopLlama: () => ipcRenderer.invoke('models:stopLlama'),
    setApiKey: (providerId, key) => ipcRenderer.invoke('models:setApiKey', providerId, key),
    setEndpoint: (providerId, baseUrl) => ipcRenderer.invoke('models:setEndpoint', providerId, baseUrl),
    addEndpoint: (input) => ipcRenderer.invoke('models:addEndpoint', input),
    removeEndpoint: (providerId) => ipcRenderer.invoke('models:removeEndpoint', providerId),
    dependencies: () => ipcRenderer.invoke('models:dependencies')
  },
  chat: {
    list: (projectId) => ipcRenderer.invoke('chat:list', projectId),
    create: (input) => ipcRenderer.invoke('chat:create', input),
    get: (id) => ipcRenderer.invoke('chat:get', id),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chat:remove', id),
    send: (request) => ipcRenderer.invoke('chat:send', request),
    stop: (runId) => ipcRenderer.invoke('chat:stop', runId),
    activeRuns: () => ipcRenderer.invoke('chat:activeRuns'),
    onEvent: (listener) => subscribe('agent:event', listener)
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    onPermission: (listener) => subscribe('permission:request', listener),
    respond: (response) => ipcRenderer.invoke('permissions:respond', response)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    open: (projectPath, name) => ipcRenderer.invoke('projects:open', projectPath, name),
    update: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
    remove: (id, deleteFiles) => ipcRenderer.invoke('projects:remove', id, deleteFiles),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    inspect: (id) => ipcRenderer.invoke('projects:inspect', id)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    catalog: () => ipcRenderer.invoke('plugins:catalog'),
    install: (id) => ipcRenderer.invoke('plugins:install', id),
    installFolder: () => ipcRenderer.invoke('plugins:installFolder'),
    uninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    configure: (id, config) => ipcRenderer.invoke('plugins:configure', id, config),
    mcpServers: () => ipcRenderer.invoke('plugins:mcpServers'),
    addMcpServer: (config) => ipcRenderer.invoke('plugins:addMcp', config),
    updateMcpServer: (id, patch) => ipcRenderer.invoke('plugins:updateMcp', id, patch),
    startMcp: (id) => ipcRenderer.invoke('plugins:startMcp', id),
    stopMcp: (id) => ipcRenderer.invoke('plugins:stopMcp', id),
    testMcp: (id) => ipcRenderer.invoke('plugins:testMcp', id)
  },
  memory: {
    list: (projectId) => ipcRenderer.invoke('memory:list', projectId),
    save: (input) => ipcRenderer.invoke('memory:save', input),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memory:remove', id)
  },
  activity: {
    list: (limit) => ipcRenderer.invoke('activity:list', limit),
    clear: () => ipcRenderer.invoke('activity:clear'),
    onUpdate: (listener) => subscribe('activity:update', listener)
  },
  computer: {
    capabilities: () => ipcRenderer.invoke('computer:capabilities'),
    screenshot: () => ipcRenderer.invoke('computer:screenshot'),
    windows: () => ipcRenderer.invoke('computer:windows'),
    uiTree: (depth) => ipcRenderer.invoke('computer:uiTree', depth),
    testMode: (action, point) => ipcRenderer.invoke('computer:testMode', action, point)
  },
  terminal: {
    sessions: () => ipcRenderer.invoke('terminal:sessions'),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onUpdate: (listener) => subscribe('terminal:update', listener)
  },
  browser: {
    state: () => ipcRenderer.invoke('browser:state'),
    close: () => ipcRenderer.invoke('browser:close')
  }
}

contextBridge.exposeInMainWorld('localpilot', api)
