import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import type {
  AppSettings,
  Attachment,
  ConversationDetail,
  ModelInfo,
  Project,
  ProviderStatus,
  ReasoningEffort,
  StoredMessage,
  ToolCallRecord
} from '@shared/types'
import type { LiveState, Page } from '../App'
import { Icon, type IconName } from './Icons'
import { Markdown, CopyButton } from './Markdown'
import { RightPanel } from './RightPanel'
import { safeJson, truncate } from '../lib/format'

const api = window.localpilot

interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
}

interface Props {
  settings: AppSettings
  conversation: ConversationDetail | null
  live: LiveState | null
  running: boolean
  models: ModelInfo[]
  providers: ProviderStatus[]
  selected: { providerId: string; modelId: string } | null
  activeModel: ModelInfo | null
  onSelectModel: (providerId: string, modelId: string) => void
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onEditMessage: (messageId: string, text: string) => Promise<void>
  onStop: () => Promise<void>
  onNavigate: (page: Page) => void
  onUpdateSettings: (patch: Record<string, unknown>) => Promise<AppSettings>
  rightOpen: boolean
  setRightOpen: (open: boolean) => void
  project: Project | null
  onNewConversation: () => void
}

const REASONING: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: 'No reasoning' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Maximum' },
  { value: 'ultra', label: 'Ultra (if supported)' }
]

const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the pasted image.'))
    reader.readAsDataURL(file)
  })
}

const SUGGESTIONS: { icon: IconName; title: string; sub: string; prompt: string }[] = [
  {
    icon: 'monitor',
    title: 'Inspect my desktop',
    sub: 'Screenshot, open windows and UI Automation',
    prompt:
      'Take a screenshot of my desktop, list the open windows, then describe what is on screen. Do not interact with anything yet.'
  },
  {
    icon: 'folder',
    title: 'Build a real application',
    sub: 'Files, dependencies, tests, desktop build',
    prompt:
      'Create a new Windows desktop application in the active project folder with a polished interface, settings persistence and a SQLite database. Install dependencies, build it, run it, test the main flows and fix every error you find. Show me evidence of the tests.'
  },
  {
    icon: 'globe',
    title: 'Automate a website',
    sub: 'Playwright browser automation',
    prompt:
      'Open Microsoft Edge with browser automation, navigate to https://example.com, take a screenshot, and report the page title and visible heading.'
  },
  {
    icon: 'gamepad',
    title: 'Develop and test a game',
    sub: 'Roblox Studio through the MCP plugin',
    prompt:
      'Inspect the currently open Roblox Studio place. Describe the Explorer hierarchy and existing scripts, then propose a small gameplay change and test it only after I approve.'
  }
]

function toolSummary(args: Record<string, unknown>): string {
  const preferred = ['path', 'command', 'query', 'url', 'name', 'title', 'text', 'app', 'pattern', 'modelId']
  for (const key of preferred) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return truncate(value.replace(/\s+/g, ' '), 90)
  }
  const first = Object.values(args).find((v) => typeof v === 'string')
  return typeof first === 'string' ? truncate(first, 90) : ''
}

function ToolCard({ call, onPreviewImage }: { call: ToolCallRecord; onPreviewImage: (src: string) => void }) {
  const [open, setOpen] = useState(call.status === 'running' || call.status === 'error')
  useEffect(() => {
    if (call.status === 'running' || call.status === 'error') setOpen(true)
  }, [call.status])

  const label =
    call.status === 'ok'
      ? 'done'
      : call.status === 'running'
        ? 'running'
        : call.status === 'denied'
          ? 'denied'
          : call.status === 'cancelled'
            ? 'stopped'
            : 'error'

  return (
    <div className={`tool-card ${call.status}`}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}>
        <span className="tool-icon">
          <Icon
            name={call.name.startsWith('computer.') || call.name.startsWith('screen.') ? 'monitor' : call.name.startsWith('files.') ? 'file' : call.name.startsWith('terminal.') ? 'terminal' : call.name.startsWith('browser.') ? 'globe' : 'wrench'}
            size={11}
          />
        </span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-arg-preview">{toolSummary(call.args)}</span>
        {call.durationMs ? <span className="tool-time">{call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}</span> : null}
        <span className={`status-chip ${label}`}>{label}</span>
        <Icon name="chevron" size={11} style={{ transform: open ? 'rotate(180deg)' : undefined, color: 'var(--faint)' }} />
      </div>
      {open ? (
        <div className="tool-body">
          <div className="tool-body-label">Arguments</div>
          <pre className="tool-pre">{safeJson(call.args)}</pre>
          {call.result ? (
            <>
              <div className="tool-body-label" style={{ marginTop: 9 }}>
                Result
              </div>
              <pre className="tool-pre">{call.result}</pre>
            </>
          ) : null}
          {call.images?.length ? (
            <div className="tool-images">
              {call.images.map((src, i) => (
                <img key={i} src={src} alt="Tool output" onClick={() => onPreviewImage(src)} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
  return (
    <span className="attachment-chip" title={attachment.path}>
      {attachment.dataUrl ? (
        <img src={attachment.dataUrl} alt={attachment.name} />
      ) : (
        <Icon name={attachment.kind === 'image' ? 'image' : 'file'} size={14} style={{ marginLeft: 2 }} />
      )}
      <span className="name">{attachment.name}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
          <Icon name="x" size={11} />
        </button>
      ) : null}
    </span>
  )
}

function UserMessage({ message, onEdit }: { message: StoredMessage; onEdit?: () => void }) {
  return (
    <div className="message user">
      <div className="msg-content">
        <div className="msg-meta" style={{ justifyContent: 'flex-end' }}>
          {onEdit ? (
            <button
              className="msg-edit"
              type="button"
              onClick={onEdit}
              title="Edit this message and drop everything after it"
            >
              <Icon name="edit" size={11} /> Edit
            </button>
          ) : null}
          <span className="name">You</span>
          <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="msg-user-bubble">
          {message.content}
          {message.attachments?.length ? (
            <div className="msg-attachments">
              {message.attachments.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="msg-avatar user">YOU</div>
    </div>
  )
}

function AssistantMessage({
  message,
  modelName,
  showReasoning,
  onPreviewImage,
  streaming
}: {
  message: StoredMessage
  modelName: string
  showReasoning: boolean
  onPreviewImage: (src: string) => void
  streaming?: boolean
}) {
  return (
    <div className="message assistant">
      <div className="msg-avatar assistant">
        <Icon name="zap" size={13} />
      </div>
      <div className="msg-content" style={{ flex: 1 }}>
        <div className="msg-meta">
          <span className="name">{modelName}</span>
          <span>{streaming ? 'generating' : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {message.reasoning ? <span className="badge">reasoning</span> : null}
        </div>
        {message.reasoning && showReasoning ? (
          <details className="reasoning-block">
            <summary>Reasoning trace · {message.reasoning.length.toLocaleString()} chars</summary>
            <div className="reasoning-text">{message.reasoning}</div>
          </details>
        ) : null}
        <div className="msg-assistant-body">
          {message.content ? <Markdown content={message.content} /> : null}
          {!message.content && message.toolCalls?.length ? (
            <div className="muted small">Working with tools…</div>
          ) : null}
        </div>
        {message.toolCalls?.length ? (
          <div className="tool-list">
            {message.toolCalls.map((call) => (
              <ToolCard key={call.id} call={call} onPreviewImage={onPreviewImage} />
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="msg-actions">
            <CopyButton text={message.content} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ChatView(props: Props) {
  const {
    settings,
    conversation,
    live,
    running,
    models,
    providers,
    selected,
    activeModel,
    onSelectModel,
    onSend,
    onEditMessage,
    onStop,
    onNavigate,
    onUpdateSettings,
    rightOpen,
    setRightOpen,
    project
  } = props

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const [composerError, setComposerError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dispatchingRef = useRef(false)

  const messages = conversation?.messages ?? []
  const hasContent = messages.length > 0 || !!live
  const chatModels = useMemo(() => models.filter((m) => m.kind === 'chat'), [models])
  const modelName = activeModel?.name ?? selected?.modelId ?? 'Local model'
  const toolsUnsupported = activeModel && !activeModel.capabilities.tools
  const visionUnsupported = activeModel && !activeModel.capabilities.vision

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [text])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, live?.text, live?.status, live?.phase])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && previewImage) setPreviewImage(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewImage])

  // A conversation change starts a fresh queue; never send an old follow-up
  // into a different chat.
  useEffect(() => {
    setQueued([])
    setEditing(null)
  }, [conversation?.id])

  // Dispatch one queued message after the current run finishes. The next run
  // must be running before this can fire again, so messages stay sequential.
  useEffect(() => {
    if (running || dispatchingRef.current || !queued.length || !selected) return
    const next = queued[0]
    dispatchingRef.current = true
    setQueued((prev) => prev.slice(1))
    setComposerError(null)
    stick.current = true
    void onSend(next.text, next.attachments)
      .catch((err) => setComposerError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        dispatchingRef.current = false
      })
  }, [queued, running, selected, onSend])

  const beginEdit = (message: StoredMessage) => {
    setEditing(message.id)
    setText(message.content)
    setAttachments(message.attachments ?? [])
    setQueued([])
    setComposerError(null)
    stick.current = true
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const cancelEdit = () => {
    setEditing(null)
    setText('')
    setAttachments([])
  }

  const submit = async (override?: string) => {
    const value = (override ?? text).trim()
    if ((!value && !attachments.length) || !selected) return
    if (editing) {
      if (!value) return
      const messageId = editing
      setEditing(null)
      setText('')
      setAttachments([])
      setComposerError(null)
      stick.current = true
      try {
        await onEditMessage(messageId, value)
      } catch (err) {
        setEditing(messageId)
        setText(value)
        setComposerError(`Could not edit the message: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }
    if (queued.length >= 20) {
      setComposerError('The queue is full (20 messages). Remove one or wait for the current task to finish.')
      return
    }
    const outgoing = attachments
    setText('')
    setAttachments([])
    setComposerError(null)
    stick.current = true
    if (running || queued.length) {
      setQueued((prev) => [
        ...prev,
        { id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: value, attachments: outgoing }
      ])
      return
    }
    await onSend(value, outgoing)
  }

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (!imageItems.length) return
    event.preventDefault()
    setComposerError(null)
    const next: Attachment[] = []
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      if (file.size > MAX_PASTED_IMAGE_BYTES) {
        setComposerError('Pasted image is larger than 12 MB. Copy a smaller screenshot and try again.')
        continue
      }
      try {
        const dataUrl = await readImageAsDataUrl(file)
        const extension = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] || 'png')
        next.push({
          id: crypto.randomUUID(),
          name: `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${extension}`,
          path: '',
          kind: 'image',
          mime: file.type,
          size: file.size,
          dataUrl
        })
      } catch (err) {
        setComposerError(`Could not paste image: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (next.length) setAttachments((prev) => [...prev, ...next])
  }

  const attachFiles = async () => {
    setComposerError(null)
    try {
      const paths = await api.app.selectFiles()
      if (!paths.length) return
      const next = paths.map((filePath) => {
        const name = filePath.split(/[\\/]/).pop() ?? filePath
        return {
          id: crypto.randomUUID(),
          name,
          path: filePath,
          kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? 'image' : 'file'
        } satisfies Attachment
      })
      setAttachments((prev) => [...prev, ...next])
    } catch (err) {
      setComposerError(`Could not attach file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const attachScreenshot = async () => {
    setCapturing(true)
    setComposerError(null)
    try {
      const shot = await api.computer.screenshot()
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: `Screenshot ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.png`,
          path: shot.path,
          kind: 'image',
          dataUrl: shot.dataUrl
        }
      ])
    } catch (err) {
      setComposerError(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCapturing(false)
    }
  }

  const profile = settings.agent.profiles.find((p) => p.id === settings.agent.activeProfileId)

  return (
    <div className="chat-shell">
      <div className="chat-main">
        <div className="chat-toolbar">
          <div className="chat-title">
            <h2>{conversation?.title ?? 'New task'}</h2>
            <div className="sub">
              {project ? (
                <>
                  <Icon name="folder" size={10} /> {project.name}
                  <span>·</span>
                </>
              ) : null}
              <Icon name="cpu" size={10} /> {providers.find((p) => p.running)?.name ?? 'local runtime'}
              {activeModel ? <span className={`badge ${activeModel.capabilities.tools ? 'ok' : 'warn'}`} style={{ marginLeft: 3 }}>{activeModel.capabilities.tools ? 'tools' : 'text tools'}</span> : null}
            </div>
          </div>
          <div className="toolbar-group">
            <select
              className="select select-sm model-select"
              value={selected ? `${selected.providerId}::${selected.modelId}` : ''}
              onChange={(e) => {
                const [providerId, modelId] = e.target.value.split('::')
                if (providerId && modelId) onSelectModel(providerId, modelId)
              }}
              title="Local model"
            >
              {!selected ? <option value="">Select a local model</option> : null}
              {providers.map((provider) => {
                const group = chatModels.filter((m) => m.providerId === provider.id)
                if (!group.length) return null
                return (
                  <optgroup key={provider.id} label={provider.name}>
                    {group.map((model) => (
                      <option key={`${model.providerId}::${model.id}`} value={`${model.providerId}::${model.id}`}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
            <select
              className="select select-sm model-select"
              style={{ minWidth: 120, maxWidth: 150 }}
              value={settings.agent.reasoningEffort}
              onChange={(e) => void onUpdateSettings({ agent: { reasoningEffort: e.target.value } })}
              title={activeModel?.capabilities.thinking ? 'Reasoning effort' : 'This model may not report thinking support; the setting will be passed but can be ignored by the runtime.'}
            >
              {REASONING.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
            <span className="divider" />
            <button
              className="icon-btn"
              type="button"
              title="New conversation"
              onClick={props.onNewConversation}
            >
              <Icon name="plus" size={15} />
            </button>
            <button
              className={`icon-btn ${rightOpen ? 'active' : ''}`}
              type="button"
              title={rightOpen ? 'Collapse workspace panel' : 'Show workspace panel'}
              onClick={() => setRightOpen(!rightOpen)}
            >
              <Icon name="panel" size={15} />
            </button>
          </div>
        </div>

        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
          }}
        >
          <div className="chat-inner">
            {!hasContent ? (
              <div className="welcome">
                <div className="welcome-mark">
                  <Icon name="zap" size={24} />
                </div>
                <div className="welcome-eyebrow">Local-first AI workstation</div>
                <h1 className="welcome-title">
                  What should we build <span className="dim">on this machine?</span>
                </h1>
                <p className="welcome-sub">
                  I can write and test software, run PowerShell, control Windows applications with your approval, automate
                  a browser, and use your local models. Nothing leaves this computer by default.
                </p>
                <div className="welcome-meta">
                  <span className="badge accent">
                    <Icon name="cpu" size={10} /> {modelName}
                  </span>
                  {activeModel?.contextLength ? (
                    <span className="badge">{Math.round(activeModel.contextLength / 1024)}k context</span>
                  ) : null}
                  <span className={`badge ${activeModel?.capabilities.tools ? 'ok' : 'warn'}`}>
                    {activeModel?.capabilities.tools ? 'native tools' : 'text tool protocol'}
                  </span>
                  <span className={`badge ${visionUnsupported ? 'warn' : 'ok'}`}>
                    {visionUnsupported ? 'no vision' : 'vision'}
                  </span>
                  {profile ? <span className="badge info">{profile.name} profile</span> : null}
                </div>
                {!selected ? (
                  <div className="notice-row error" style={{ maxWidth: 720, marginBottom: 16 }}>
                    <Icon name="alert" size={14} />
                    <span>
                      No local model selected. LocalPilot does not silently use a cloud model.{' '}
                      <button className="btn btn-sm btn-ghost" type="button" onClick={() => onNavigate('models')}>
                        Open Model library
                      </button>
                    </span>
                  </div>
                ) : null}
                <div className="suggestion-grid">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      className="suggestion"
                      type="button"
                      disabled={!selected || running}
                      onClick={() => void submit(suggestion.prompt)}
                    >
                      <span className="s-icon">
                        <Icon name={suggestion.icon} size={14} />
                      </span>
                      <span>
                        <div className="s-title">{suggestion.title}</div>
                        <div className="s-sub">{suggestion.sub}</div>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((message) =>
                  message.role === 'user' ? (
                    <UserMessage
                      key={message.id}
                      message={message}
                      onEdit={
                        message.id.startsWith('optimistic-') ? undefined : () => beginEdit(message)
                      }
                    />
                  ) : message.role === 'assistant' ? (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      modelName={modelName}
                      showReasoning={settings.general.showReasoning}
                      onPreviewImage={setPreviewImage}
                    />
                  ) : null
                )}

                {live ? (
                  <div className="message assistant">
                    <div className="msg-avatar assistant">
                      <Icon name="zap" size={13} />
                    </div>
                    <div className="msg-content" style={{ flex: 1 }}>
                      <div className="msg-meta">
                        <span className="name">{modelName}</span>
                        <span>{live.status}</span>
                      </div>
                      {live.reasoning && settings.general.showReasoning ? (
                        <details className="reasoning-block" open={!live.text}>
                          <summary>Reasoning trace · {live.reasoning.length.toLocaleString()} chars</summary>
                          <div className="reasoning-text">{live.reasoning}</div>
                        </details>
                      ) : null}
                      {live.text ? (
                        <div className="msg-assistant-body">
                          <Markdown content={live.text} />
                        </div>
                      ) : null}
                      <div className="live-status">
                        <span className="phase-dot" />
                        <span>{live.status}</span>
                        <span className="typing">
                          <span />
                          <span />
                          <span />
                        </span>
                      </div>
                      {live.notices.slice(-3).map((notice, i) => (
                        <div key={i} className={`notice-row ${notice.level === 'error' ? 'error' : notice.level === 'info' ? 'info' : ''}`} style={{ marginTop: 6 }}>
                          <Icon name="alert" size={12} />
                          <span>{notice.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            {editing ? (
              <div className="edit-banner">
                <Icon name="edit" size={12} />
                <span>Editing a sent message. Sending replaces it and deletes every message after it.</span>
                <span className="grow" />
                <button className="btn btn-sm btn-ghost" type="button" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            ) : null}
            {queued.length ? (
              <div className="queue-strip">
                <div className="queue-strip-head">
                  <Icon name="clock" size={12} />
                  <span>
                    {queued.length} message{queued.length === 1 ? '' : 's'} queued — sent after the current task
                  </span>
                </div>
                {queued.map((item) => (
                  <div className="queue-item" key={item.id}>
                    <span className="queue-item-text">
                      {item.text.trim() || `${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`}
                    </span>
                    {item.attachments.length ? (
                      <span className="badge">{item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}</span>
                    ) : null}
                    <button
                      className="icon-btn"
                      type="button"
                      title="Remove queued message"
                      onClick={() => setQueued((prev) => prev.filter((queuedItem) => queuedItem.id !== item.id))}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {attachments.length ? (
              <div className="attachments-row">
                {attachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                  />
                ))}
              </div>
            ) : null}
            <div className="composer-main">
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                placeholder={
                  editing
                    ? 'Edit your message and press Enter to resend…'
                    : running
                      ? 'Queue a follow-up — it sends when this task finishes…'
                      : selected
                        ? `Ask ${modelName} to do something on this PC…`
                        : 'Select a local model to begin…'
                }
                onChange={(e) => setText(e.target.value)}
                onPaste={(event) => void handlePaste(event)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submit()
                  }
                }}
              />
              <div className="composer-actions">
                <button className="icon-btn" type="button" title="Attach files" onClick={() => void attachFiles()}>
                  <Icon name="paperclip" size={15} />
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  title="Attach a visible desktop screenshot"
                  onClick={() => void attachScreenshot()}
                  disabled={capturing}
                >
                  {capturing ? <span className="spinner" /> : <Icon name="image" size={15} />}
                </button>
                {running ? (
                  <button className="stop-btn" type="button" onClick={() => void onStop()}>
                    <Icon name="stop" size={11} /> Stop
                  </button>
                ) : null}
                <button
                  className="send-btn"
                  type="button"
                  onClick={() => void submit()}
                  disabled={(!text.trim() && !attachments.length) || !selected}
                  title={editing ? 'Save the edit and resend' : running ? 'Queue message to send after this task' : 'Send'}
                >
                  <Icon name={running ? 'clock' : 'arrow-right'} size={15} />
                </button>
              </div>
            </div>
            <div className="composer-foot">
              <span className="hint">
                {running ? (
                  'You can queue another message; it sends when this task finishes.'
                ) : (
                  <>
                    <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>Ctrl</kbd>+<kbd>V</kbd> paste image
                  </>
                )}
              </span>
              <span className="grow" />
              {toolsUnsupported ? <span className="badge warn">native tools not reported</span> : null}
              <span
                className={`badge ${settings.computer.fullAccess ? 'ok' : ''}`}
                title={
                  settings.computer.fullAccess
                    ? 'All enabled tools and absolute file paths are available; approvals still apply.'
                    : 'File tools stay inside the active project and profile tool groups apply.'
                }
              >
                {settings.computer.fullAccess ? 'full PC' : 'project scope'}
              </span>
              <span className="badge" title="All inference is local">
                <span className="dot" style={{ background: 'var(--ok)' }} /> local only
              </span>
              <span>{profile?.name ?? 'Default'}</span>
            </div>
          </div>
          {composerError ? (
            <div className="notice-row error" style={{ maxWidth: 900, margin: '7px auto 0' }}>
              <Icon name="alert" size={12} /> {composerError}
            </div>
          ) : null}
          {toolsUnsupported ? (
            <div className="tiny faint" style={{ maxWidth: 900, margin: '6px auto 0', textAlign: 'center' }}>
              {activeModel?.providerName} did not report native tool support for this model. LocalPilot will use the text
              tool protocol; approval rules still apply.
            </div>
          ) : null}
        </div>
      </div>

      {rightOpen ? (
        <RightPanel
          conversation={conversation}
          live={live}
          project={project}
          activeModel={activeModel}
          onClose={() => setRightOpen(false)}
        />
      ) : null}

      {previewImage ? (
        <div className="overlay" onClick={() => setPreviewImage(null)}>
          <img
            src={previewImage}
            alt="Tool output preview"
            style={{ maxWidth: '92vw', maxHeight: '88vh', borderRadius: 10, border: '1px solid var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  )
}
