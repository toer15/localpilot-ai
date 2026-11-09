import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentPhase,
  AppInfo,
  AppSettings,
  AppUpdateStatus,
  Attachment,
  ConversationDetail,
  ConversationSummary,
  HardwareInfo,
  ModelInfo,
  PermissionRequest,
  Project,
  ProviderStatus,
  StoredMessage
} from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { PermissionDialog } from './components/PermissionDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { Onboarding } from './components/Onboarding'
import { ModelsPage } from './pages/ModelsPage'
import { PluginsPage } from './pages/PluginsPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { AgentsPage } from './pages/AgentsPage'
import { ActivityPage } from './pages/ActivityPage'
import { SettingsPage } from './pages/SettingsPage'
import { Icon } from './components/Icons'

export type Page = 'chat' | 'projects' | 'agents' | 'models' | 'plugins' | 'activity' | 'settings'

export interface LiveState {
  runId: string
  conversationId: string
  text: string
  reasoning: string
  phase: AgentPhase
  status: string
  notices: { level: 'info' | 'warn' | 'error'; message: string }[]
}

interface Toast {
  id: string
  message: string
  kind: 'info' | 'warn' | 'error'
}

const api = window.localpilot

function mergeMessage(conversation: ConversationDetail | null, message: StoredMessage): ConversationDetail | null {
  if (!conversation) return conversation
  const existing = conversation.messages.some((m) => m.id === message.id)
  return {
    ...conversation,
    messages: existing
      ? conversation.messages.map((m) => (m.id === message.id ? message : m))
      : [...conversation.messages, message]
  }
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<ConversationDetail | null>(null)
  const [selected, setSelected] = useState<{ providerId: string; modelId: string } | null>(null)
  const [page, setPage] = useState<Page>('chat')
  const [live, setLive] = useState<LiveState | null>(null)
  const [running, setRunning] = useState(false)
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loading, setLoading] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null)
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('localpilot.panel') !== 'closed')

  const activeIdRef = useRef<string | null>(null)
  const liveRef = useRef<LiveState | null>(null)
  const loadStarted = useRef(false)
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const addToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => [...prev.slice(-3), { id, message, kind }])
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      toastTimers.current.delete(id)
    }, 6000)
    toastTimers.current.set(id, timer)
  }, [])

  const installUpdate = useCallback(async () => {
    setInstallingUpdate(true)
    try {
      await api.updates.install()
    } catch (err) {
      setInstallingUpdate(false)
      addToast(`Could not install the update: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [addToast])

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current.values()) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('localpilot.panel', rightOpen ? 'open' : 'closed')
  }, [rightOpen])

  useEffect(() => {
    let active = true
    void api.updates
      .status()
      .then((next) => {
        if (active) setUpdateStatus(next)
      })
      .catch(() => undefined)
    const unsubscribe = api.updates.onStatus((next) => setUpdateStatus(next))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.chat.list())
    } catch {
      // sidebar refresh should never break the app
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.projects.list())
    } catch {
      // ignore
    }
  }, [])

  const refreshModels = useCallback(async () => {
    try {
      const [nextProviders, nextModels] = await Promise.all([api.models.providers(), api.models.discover(true)])
      setProviders(nextProviders)
      setModels(nextModels)
      setSelected((prev) => {
        if (prev && nextModels.some((m) => m.providerId === prev.providerId && m.id === prev.modelId)) return prev
        const configured = nextModels.find(
          (m) =>
            m.providerId === settings?.models.defaultProviderId && m.id === settings?.models.defaultModelId
        )
        const first = configured ?? nextModels.find((m) => m.kind === 'chat') ?? nextModels[0]
        return first ? { providerId: first.providerId, modelId: first.id } : null
      })
    } catch (err) {
      addToast(`Model discovery failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [addToast, settings?.models.defaultProviderId, settings?.models.defaultModelId])

  const refreshActiveConversation = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    try {
      const detail = await api.chat.get(id)
      if (detail && activeIdRef.current === detail.id) setActive(detail)
    } catch {
      // ignore
    }
  }, [])

  // Initial load
  useEffect(() => {
    if (loadStarted.current) return
    loadStarted.current = true
    void (async () => {
      try {
        const [nextSettings, nextProviders, nextModels, nextConversations, nextProjects, nextHardware, nextInfo] =
          await Promise.all([
            api.settings.get(),
            api.models.providers(),
            api.models.discover(true),
            api.chat.list(),
            api.projects.list(),
            api.models.hardware(true),
            api.app.info()
          ])
        setSettings(nextSettings)
        setProviders(nextProviders)
        setModels(nextModels)
        setConversations(nextConversations)
        setProjects(nextProjects)
        setHardware(nextHardware)
        setInfo(nextInfo)
        setShowOnboarding(!nextSettings.general.onboardingComplete)

        let nextSelection: { providerId: string; modelId: string } | null = null
        if (nextConversations.length) {
          const latest = nextConversations[0]
          const detail = await api.chat.get(latest.id)
          if (detail) {
            setActive(detail)
            activeIdRef.current = detail.id
            if (
              detail.providerId &&
              detail.modelId &&
              nextModels.some((m) => m.providerId === detail.providerId && m.id === detail.modelId)
            ) {
              nextSelection = { providerId: detail.providerId, modelId: detail.modelId }
            }
            const runs = await api.chat.activeRuns().catch(() => [])
            if (runs.some((r) => r.conversationId === detail.id)) setRunning(true)
          }
        }
        if (!nextSelection) {
          const configured = nextModels.find(
            (m) => m.providerId === nextSettings.models.defaultProviderId && m.id === nextSettings.models.defaultModelId
          )
          const fallback = configured ?? nextModels.find((m) => m.kind === 'chat') ?? nextModels[0]
          if (fallback) nextSelection = { providerId: fallback.providerId, modelId: fallback.id }
        }
        setSelected(nextSelection)
      } catch (err) {
        addToast(`LocalPilot could not finish loading: ${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [addToast])

  // Agent event stream
  useEffect(() => {
    const unsubscribe = api.chat.onEvent((event: AgentEvent) => {
      if (event.type === 'run_start') {
        if (event.conversationId !== activeIdRef.current) return
        const next: LiveState = {
          runId: event.runId,
          conversationId: event.conversationId,
          text: '',
          reasoning: '',
          phase: 'thinking',
          status: 'Starting…',
          notices: []
        }
        liveRef.current = next
        setLive(next)
        setRunning(true)
        return
      }

      if (event.type === 'assistant_message') {
        const message = event.message
        if (message.conversationId === activeIdRef.current) {
          setActive((prev) => mergeMessage(prev, message))
          const current = liveRef.current
          if (current && current.conversationId === message.conversationId) {
            const next = { ...current, text: '', reasoning: '' }
            liveRef.current = next
            setLive(next)
          }
        }
        void refreshConversations()
        return
      }

      if (event.type === 'tool_call' || event.type === 'tool_update') {
        if (!activeIdRef.current) return
        setActive((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            messages: prev.messages.map((message) =>
              message.toolCalls?.some((call) => call.id === event.call.id)
                ? {
                    ...message,
                    toolCalls: message.toolCalls.map((call) => (call.id === event.call.id ? event.call : call))
                  }
                : message
            )
          }
        })
        if (event.type === 'tool_call') {
          const current = liveRef.current
          if (current) {
            const next = { ...current, phase: 'tool' as AgentPhase, status: `Running ${event.call.name}…` }
            liveRef.current = next
            setLive(next)
          }
        }
        return
      }

      if (event.type === 'run_end') {
        const current = liveRef.current
        if (current?.runId === event.runId) {
          const convId = current.conversationId
          liveRef.current = null
          setLive(null)
          setRunning(false)
          if (convId === activeIdRef.current) {
            void refreshActiveConversation()
          }
        }
        void refreshConversations()
        if (event.reason === 'error') {
          addToast(event.error ?? 'The agent run failed.', 'error')
        } else if (event.reason === 'limit') {
          addToast('The agent reached its iteration limit.', 'warn')
        }
        return
      }

      const current = liveRef.current
      if (!current || current.runId !== event.runId) return

      if (event.type === 'status') {
        const next = { ...current, phase: event.phase, status: event.message }
        liveRef.current = next
        setLive(next)
      } else if (event.type === 'assistant_delta') {
        const next = { ...current, text: current.text + event.text }
        liveRef.current = next
        setLive(next)
      } else if (event.type === 'reasoning_delta') {
        const next = { ...current, reasoning: current.reasoning + event.text }
        liveRef.current = next
        setLive(next)
      } else if (event.type === 'notice') {
        const next = {
          ...current,
          notices: [...current.notices, { level: event.level, message: event.message }]
        }
        liveRef.current = next
        setLive(next)
        addToast(event.message, event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info')
      }
    })
    return unsubscribe
  }, [addToast, refreshActiveConversation, refreshConversations])

  // Approval queue
  useEffect(() => {
    return api.tools.onPermission((request) => {
      setPermissionQueue((prev) => (prev.some((p) => p.id === request.id) ? prev : [...prev, request]))
    })
  }, [])

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) {
        setPage('chat')
        return
      }
      try {
        const detail = await api.chat.get(id)
        if (!detail) return
        setActive(detail)
        activeIdRef.current = detail.id
        setPage('chat')
        liveRef.current = null
        setLive(null)
        if (
          detail.providerId &&
          detail.modelId &&
          models.some((m) => m.providerId === detail.providerId && m.id === detail.modelId)
        ) {
          setSelected({ providerId: detail.providerId, modelId: detail.modelId })
        }
        const runs = await api.chat.activeRuns().catch(() => [])
        setRunning(runs.some((r) => r.conversationId === detail.id))
      } catch (err) {
        addToast(`Could not open conversation: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
    [addToast, models]
  )

  const newConversation = useCallback(() => {
    setActive(null)
    activeIdRef.current = null
    liveRef.current = null
    setLive(null)
    setRunning(false)
    setPage('chat')
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        newConversation()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newConversation])

  const deleteConversation = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this conversation? This only removes the local chat history.')) return
      await api.chat.remove(id)
      if (activeIdRef.current === id) {
        setActive(null)
        activeIdRef.current = null
        liveRef.current = null
        setLive(null)
        setRunning(false)
      }
      await refreshConversations()
    },
    [refreshConversations]
  )

  const updateSettings = useCallback(async (patch: Record<string, unknown>) => {
    const next = await api.settings.update(patch)
    setSettings(next)
    return next
  }, [])

  const selectModel = useCallback(
    (providerId: string, modelId: string) => {
      setSelected({ providerId, modelId })
      void api.settings
        .update({ models: { defaultProviderId: providerId, defaultModelId: modelId } })
        .then((next) => setSettings(next))
        .catch(() => undefined)
    },
    []
  )

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!settings || !selected) {
        addToast('Select a local model before sending a message.', 'warn')
        setPage('models')
        return
      }
      if (running) {
        addToast('The agent is already working. Stop it first or wait for it to finish.', 'warn')
        return
      }
      setRunning(true)
      try {
        let conversation = active
        if (!conversation) {
          const summary = await api.chat.create({
            projectId: settings.activeProjectId,
            providerId: selected.providerId,
            modelId: selected.modelId
          })
          const detail = await api.chat.get(summary.id)
          if (!detail) throw new Error('Could not create the conversation.')
          conversation = detail
          setActive(detail)
          activeIdRef.current = detail.id
          setConversations((prev) => [summary, ...prev])
        }

        const optimistic: StoredMessage = {
          id: `optimistic-${Date.now()}`,
          conversationId: conversation.id,
          role: 'user',
          content: text,
          attachments,
          createdAt: new Date().toISOString()
        }
        setActive((prev) => (prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev))
        const pendingLive: LiveState = {
          runId: 'pending',
          conversationId: conversation.id,
          text: '',
          reasoning: '',
          phase: 'thinking',
          status: 'Sending to the local model…',
          notices: []
        }
        liveRef.current = pendingLive
        setLive(pendingLive)

        await api.chat.send({
          conversationId: conversation.id,
          text,
          attachments,
          providerId: selected.providerId,
          modelId: selected.modelId,
          projectId: settings.activeProjectId,
          profileId: settings.agent.activeProfileId,
          reasoningEffort: settings.agent.reasoningEffort
        })
        await refreshConversations()
      } catch (err) {
        setRunning(false)
        liveRef.current = null
        setLive(null)
        addToast(`Message failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
    [active, addToast, refreshConversations, running, selected, settings]
  )

  const stopRun = useCallback(async () => {
    await api.chat.stop(liveRef.current?.runId === 'pending' ? undefined : liveRef.current?.runId)
    setRunning(false)
  }, [])

  const emergencyStop = useCallback(async () => {
    await api.app.emergencyStop()
    liveRef.current = null
    setLive(null)
    setRunning(false)
    setPermissionQueue([])
    addToast('Emergency stop: agent activity and tool processes were halted.', 'warn')
  }, [addToast])

  const respondPermission = useCallback(
    async (decision: 'allow' | 'allow-session' | 'allow-always' | 'deny') => {
      const request = permissionQueue[0]
      if (!request) return
      setPermissionQueue((prev) => prev.slice(1))
      await api.tools.respond({ id: request.id, decision }).catch(() => undefined)
    },
    [permissionQueue]
  )

  const activeProject = projects.find((p) => p.id === settings?.activeProjectId) ?? null
  const activeModel = selected
    ? models.find((m) => m.providerId === selected.providerId && m.id === selected.modelId) ?? null
    : null
  const updatePrompt =
    updateStatus &&
    updateStatus.version &&
    updateStatus.version !== dismissedUpdateVersion &&
    ['available', 'downloading', 'downloaded'].includes(updateStatus.phase)
      ? updateStatus
      : null

  if (loading || !settings || !info) {
    return (
      <div className="loading-screen">
        <div className="mark">
          <Icon name="zap" size={22} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="spinner" />
          Detecting local runtimes, models and hardware…
        </div>
        <div className="tiny faint">Everything stays on this computer.</div>
      </div>
    )
  }

  return (
    <div className="app" data-theme={settings.general.theme}>
      <Sidebar
        page={page}
        onNavigate={setPage}
        conversations={conversations}
        activeId={active?.id ?? null}
        onSelect={selectConversation}
        onNew={newConversation}
        onDelete={deleteConversation}
        info={info}
        providers={providers}
        running={running}
        onEmergencyStop={emergencyStop}
      />

      <main className="workspace">
        {page === 'chat' ? (
          <ChatView
            settings={settings}
            conversation={active}
            live={live}
            running={running}
            models={models}
            providers={providers}
            selected={selected}
            activeModel={activeModel}
            onSelectModel={selectModel}
            onSend={sendMessage}
            onStop={stopRun}
            onNavigate={setPage}
            onUpdateSettings={updateSettings}
            rightOpen={rightOpen}
            setRightOpen={setRightOpen}
            project={activeProject}
            onNewConversation={newConversation}
          />
        ) : page === 'models' ? (
          <ModelsPage
            settings={settings}
            models={models}
            providers={providers}
            hardware={hardware}
            selected={selected}
            onSelectModel={selectModel}
            onRefresh={refreshModels}
            onUpdateSettings={updateSettings}
            onHardware={setHardware}
          />
        ) : page === 'plugins' ? (
          <PluginsPage />
        ) : page === 'projects' ? (
          <ProjectsPage
            projects={projects}
            settings={settings}
            onRefresh={refreshProjects}
            onUpdateSettings={updateSettings}
          />
        ) : page === 'agents' ? (
          <AgentsPage settings={settings} onUpdateSettings={updateSettings} />
        ) : page === 'activity' ? (
          <ActivityPage />
        ) : (
          <SettingsPage
            settings={settings}
            info={info}
            providers={providers}
            models={models}
            onUpdateSettings={updateSettings}
            onRefreshProviders={async () => {
              setProviders(await api.models.providers())
            }}
            onNavigate={setPage}
            onConversationsChanged={() => {
              void refreshConversations()
              if (!activeIdRef.current) return
              void api.chat.get(activeIdRef.current).then((detail) => {
                if (detail && activeIdRef.current === detail.id) setActive(detail)
              })
            }}
            onOpenOnboarding={() => setShowOnboarding(true)}
            onHardware={setHardware}
          />
        )}
      </main>

      {updatePrompt && !showOnboarding && !permissionQueue[0] ? (
        <UpdateDialog
          status={updatePrompt}
          installing={installingUpdate}
          onClose={() => setDismissedUpdateVersion(updatePrompt.version ?? null)}
          onInstall={() => void installUpdate()}
        />
      ) : null}

      {permissionQueue[0] ? (
        <PermissionDialog request={permissionQueue[0]} onRespond={respondPermission} />
      ) : null}

      {showOnboarding ? (
        <Onboarding
          settings={settings}
          providers={providers}
          models={models}
          hardware={hardware}
          onRefresh={async () => {
            await refreshModels()
            setHardware(await api.models.hardware(true))
          }}
          onComplete={async (selection) => {
            const next = await updateSettings({
              general: { onboardingComplete: true },
              ...(selection
                ? {
                    models: {
                      defaultProviderId: selection.providerId,
                      defaultModelId: selection.modelId
                    }
                  }
                : {})
            })
            setSettings(next)
            if (selection) setSelected(selection)
            setShowOnboarding(false)
          }}
        />
      ) : null}

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : toast.kind === 'warn' ? 'warn' : ''}`}>
            <Icon
              name={toast.kind === 'error' ? 'alert' : toast.kind === 'warn' ? 'alert' : 'check'}
              size={14}
              style={{ marginTop: 1, flex: '0 0 auto' }}
            />
            <span className="grow">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              aria-label="Dismiss"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
