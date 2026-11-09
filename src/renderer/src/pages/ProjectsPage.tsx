import { useEffect, useState } from 'react'
import type { AppSettings, MemoryItem, Project } from '@shared/types'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Section, Spinner } from '../components/ui'
import { formatBytes, relativeTime } from '../lib/format'

const api = window.localpilot

interface Props {
  projects: Project[]
  settings: AppSettings
  onRefresh: () => Promise<void>
  onUpdateSettings: (patch: Record<string, unknown>) => Promise<AppSettings>
}

export function ProjectsPage({ projects, settings, onRefresh, onUpdateSettings }: Props) {
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<Project | null>(null)
  const [inspect, setInspect] = useState<Awaited<ReturnType<typeof api.projects.inspect>> | null>(null)
  const [inspectBusy, setInspectBusy] = useState(false)
  const [draftInstructions, setDraftInstructions] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [memoryKey, setMemoryKey] = useState('')
  const [memoryValue, setMemoryValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const active = projects.find((p) => p.id === settings.activeProjectId) ?? null

  const chooseFolder = async () => {
    const selected = await api.app.selectFolder('Choose a project folder')
    if (!selected) return
    setFolder(selected)
    if (!name) setName(selected.split(/[\\/]/).filter(Boolean).pop() ?? 'Project')
  }

  const createProject = async () => {
    if (!folder) {
      setError('Choose a project folder first.')
      return
    }
    setBusy('create')
    setError(null)
    try {
      const project = await api.projects.create({ name: name.trim() || 'Untitled project', path: folder, instructions })
      await onUpdateSettings({ activeProjectId: project.id })
      await onRefresh()
      setCreateOpen(false)
      setName('')
      setFolder('')
      setInstructions('')
      setNotice(`${project.name} is now the active project.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const openExisting = async () => {
    const selected = await api.app.selectFolder('Open an existing project folder')
    if (!selected) return
    setBusy('open')
    setError(null)
    try {
      const project = await api.projects.open(selected)
      await onUpdateSettings({ activeProjectId: project.id })
      await onRefresh()
      setNotice(`${project.name} opened.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const openDetail = async (project: Project) => {
    setDetail(project)
    setDraftInstructions(project.instructions)
    setInspect(null)
    setInspectBusy(true)
    setMemories([])
    try {
      const [info, memories] = await Promise.all([api.projects.inspect(project.id), api.memory.list(project.id)])
      setInspect(info)
      setMemories(memories)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspectBusy(false)
    }
  }

  const saveInstructions = async () => {
    if (!detail) return
    setBusy('instructions')
    try {
      const updated = await api.projects.update(detail.id, { instructions: draftInstructions })
      setDetail(updated)
      await onRefresh()
      setNotice('Project instructions saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveMemory = async () => {
    if (!detail || !memoryKey.trim() || !memoryValue.trim()) return
    setBusy('memory')
    try {
      const item = await api.memory.save({ scope: 'project', projectId: detail.id, key: memoryKey.trim(), value: memoryValue.trim() })
      setMemories((prev) => [...prev, item])
      setMemoryKey('')
      setMemoryValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Workspace</div>
            <h1 className="page-title">Projects</h1>
            <p className="page-subtitle">
              A project gives the agent a filesystem scope, persistent instructions and its own memory. File tools are
              restricted to the active project — no path outside it is writable.
            </p>
          </div>
          <div className="page-actions">
            <button className="btn" type="button" disabled={busy === 'open'} onClick={() => void openExisting()}>
              {busy === 'open' ? <Spinner /> : <Icon name="folder" size={13} />} Open folder
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={13} /> New project
            </button>
          </div>
        </div>

        {error ? <div className="notice-row error" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /> {error}</div> : null}
        {notice ? <div className="notice-row info" style={{ marginBottom: 12 }}><Icon name="check" size={14} /> {notice}</div> : null}

        {active ? (
          <div className="card" style={{ marginBottom: 20, borderColor: 'var(--accent-line)' }}>
            <div className="row between">
              <div className="row" style={{ minWidth: 0 }}>
                <div className="provider-logo" style={{ color: 'var(--accent)' }}><Icon name="folder" size={16} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="card-title" style={{ margin: 0 }}>{active.name} <span className="badge accent">active project</span></div>
                  <div className="tiny faint mono" style={{ wordBreak: 'break-all' }}>{active.path}</div>
                </div>
              </div>
              <div className="row">
                <button className="btn btn-sm" type="button" onClick={() => void openDetail(active)}>Details</button>
                <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(active.path)}>
                  <Icon name="folder" size={11} /> Open in Explorer
                </button>
                <button className="btn btn-sm btn-ghost" type="button" onClick={() => void onUpdateSettings({ activeProjectId: null })}>Detach</button>
              </div>
            </div>
          </div>
        ) : null}

        <Section title="All projects" count={projects.length}>
          {projects.length ? (
            <div className="grid-auto">
              {projects.map((project) => (
                <div className={`card card-hover ${project.id === settings.activeProjectId ? 'selected' : ''}`} key={project.id}>
                  <div className="row between" style={{ alignItems: 'flex-start' }}>
                    <div className="plugin-icon" style={{ width: 32, height: 32 }}><Icon name="folder" size={16} /></div>
                    <div className="row">
                      {project.id === settings.activeProjectId ? <span className="badge accent">active</span> : null}
                      <span className="badge">{relativeTime(project.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="card-title" style={{ marginTop: 10 }}>{project.name}</div>
                  <div className="tiny faint mono" style={{ wordBreak: 'break-all', lineHeight: 1.5 }}>{project.path}</div>
                  <p className="card-sub" style={{ marginTop: 7, minHeight: 32 }}>
                    {project.instructions ? project.instructions.slice(0, 130) : 'No project instructions yet.'}
                  </p>
                  <div className="row" style={{ marginTop: 10 }}>
                    {project.id !== settings.activeProjectId ? (
                      <button className="btn btn-sm btn-primary" type="button" onClick={() => void onUpdateSettings({ activeProjectId: project.id })}>Set active</button>
                    ) : (
                      <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(project.path)}>Open folder</button>
                    )}
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => void openDetail(project)}>Manage</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="folder" title="No projects yet">
              Create a project to let the agent read and write code inside a scoped folder, run tests there, and remember
              project-specific conventions.
            </EmptyState>
          )}
        </Section>

        <Section title="Project scoping rules">
          <div className="grid-2">
            <div className="card tight">
              <div className="card-title"><Icon name="shield" size={14} /> Filesystem boundary</div>
              <p className="card-sub">Reads and writes resolve inside the active project path. Traversal and absolute paths escaping the project are rejected by the tool layer.</p>
            </div>
            <div className="card tight">
              <div className="card-title"><Icon name="brain" size={14} /> Project memory</div>
              <p className="card-sub">Instructions and memory entries are injected into the agent’s context. Passwords, API keys and tokens should never be saved as memories.</p>
            </div>
          </div>
        </Section>
      </div>

      {createOpen ? (
        <div className="overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="grow">
                <h3>New project</h3>
                <div className="sub">Choose an empty folder or an existing codebase. Files are only modified with tool approvals.</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setCreateOpen(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <Field label="Project name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My application" /></Field>
              <Field label="Folder" hint="This folder becomes the filesystem scope for the project.">
                <div className="row">
                  <input className="input" value={folder} readOnly placeholder="No folder selected" />
                  <button className="btn" type="button" onClick={() => void chooseFolder()}>Browse…</button>
                </div>
              </Field>
              <Field label="Project instructions" hint="Conventions, architecture notes, commands the agent should use. Injected into every run for this project.">
                <textarea className="textarea" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Use pnpm, run tests with vitest, keep components in src/components…" />
              </Field>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="btn btn-primary" type="button" onClick={() => void createProject()} disabled={busy === 'create' || !folder}>
                {busy === 'create' ? <Spinner /> : <Icon name="plus" size={12} />} Create project
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detail ? (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="grow">
                <h3>{detail.name}</h3>
                <div className="sub mono" style={{ wordBreak: 'break-all' }}>{detail.path}</div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setDetail(null)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              {inspect?.git ? (
                <div className="row wrap">
                  <span className="badge info"><Icon name="git" size={10} /> {inspect.git.branch}</span>
                  <span className="badge">{inspect.git.changes} changed files</span>
                  <span className="badge">{inspect?.files.length ?? 0} files indexed</span>
                </div>
              ) : null}
              <Field label="Project instructions">
                <textarea className="textarea" rows={4} value={draftInstructions} onChange={(e) => setDraftInstructions(e.target.value)} />
              </Field>
              <div className="row">
                <button className="btn btn-sm btn-primary" type="button" disabled={busy === 'instructions'} onClick={() => void saveInstructions()}>
                  {busy === 'instructions' ? <Spinner /> : <Icon name="check" size={11} />} Save instructions
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void onUpdateSettings({ activeProjectId: detail.id }).then(() => setNotice('Project is now active.'))}>
                  Set as active
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(detail.path)}>Open folder</button>
              </div>

              <div className="divider" />

              <div className="section-head">
                <h3 className="section-title">Files <span className="count">{inspect?.files.length ?? 0}</span></h3>
                <span className="section-hint">Files touched here are visible to the agent</span>
              </div>
              {inspectBusy ? <div><Spinner /> <span className="tiny faint">Inspecting project…</span></div> : inspect?.files.length ? (
                <div className="data-list" style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {inspect.files.slice(0, 80).map((file) => (
                    <div className="data-row" key={file.path} style={{ padding: '7px 10px' }}>
                      <Icon name="file" size={12} style={{ color: 'var(--faint)' }} />
                      <div className="data-main">
                        <div className="tiny mono" style={{ wordBreak: 'break-all' }}>{file.path}</div>
                      </div>
                      <span className="tiny faint">{formatBytes(file.sizeBytes)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tiny faint">No files were found in this project folder.</div>
              )}

              <div className="divider" />

              <div className="section-head">
                <h3 className="section-title">Project memory <span className="count">{memories.length}</span></h3>
              </div>
              <div className="grid-2">
                <input className="input" value={memoryKey} onChange={(e) => setMemoryKey(e.target.value)} placeholder="Key (e.g. test command)" />
                <input className="input" value={memoryValue} onChange={(e) => setMemoryValue(e.target.value)} placeholder="Value" />
              </div>
              <div className="row">
                <button className="btn btn-sm" type="button" disabled={busy === 'memory' || !memoryKey.trim() || !memoryValue.trim()} onClick={() => void saveMemory()}>
                  {busy === 'memory' ? <Spinner /> : <Icon name="plus" size={11} />} Add memory
                </button>
                <span className="tiny faint">Never store secrets here. Entries persist in local SQLite.</span>
              </div>
              {memories.length ? (
                <div className="data-list">
                  {memories.map((memory) => (
                    <div className="data-row" key={memory.id} style={{ padding: '8px 10px' }}>
                      <div className="data-main">
                        <div className="tiny" style={{ fontWeight: 600 }}>{memory.key}</div>
                        <div className="tiny faint pre-wrap">{memory.value}</div>
                      </div>
                      <button className="icon-btn danger" type="button" title="Delete memory" onClick={() => void api.memory.remove(memory.id).then(() => setMemories((prev) => prev.filter((m) => m.id !== memory.id)))}>
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : <div className="tiny faint">No project memory entries.</div>}
            </div>
            <div className="modal-foot">
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => {
                  if (!window.confirm(`Remove ${detail.name} from LocalPilot? The folder and its files are not deleted.`)) return
                  void (async () => {
                    await api.projects.remove(detail.id)
                    if (settings.activeProjectId === detail.id) await onUpdateSettings({ activeProjectId: null })
                    setDetail(null)
                    await onRefresh()
                  })()
                }}
              >
                Remove project
              </button>
              <span className="grow" />
              <button className="btn btn-primary" type="button" onClick={() => setDetail(null)}>Done</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
