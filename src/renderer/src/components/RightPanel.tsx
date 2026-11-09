import { useEffect, useMemo, useState } from 'react'
import type {
  ActivityItem,
  ConversationDetail,
  ModelInfo,
  Project,
  TerminalSession,
  ToolSchema
} from '@shared/types'
import type { LiveState } from '../App'
import { Icon } from './Icons'
import { relativeTime, truncate } from '../lib/format'

const api = window.localpilot

interface Props {
  conversation: ConversationDetail | null
  live: LiveState | null
  project: Project | null
  activeModel: ModelInfo | null
  onClose: () => void
}

type Tab = 'overview' | 'tools' | 'activity'

export function RightPanel({ conversation, live, project, activeModel, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [browser, setBrowser] = useState<{ open: boolean; url?: string; title?: string } | null>(null)

  useEffect(() => {
    void api.tools.list().then(setTools).catch(() => undefined)
    void api.terminal.sessions().then(setSessions).catch(() => undefined)
    void api.activity.list(60).then(setActivity).catch(() => undefined)
    void api.browser.state().then(setBrowser).catch(() => undefined)
    const offTerminal = api.terminal.onUpdate((session) => {
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === session.id)
        return exists ? prev.map((s) => (s.id === session.id ? session : s)) : [session, ...prev]
      })
    })
    const offActivity = api.activity.onUpdate((item) => {
      setActivity((prev) => [item, ...prev].slice(0, 60))
    })
    return () => {
      offTerminal()
      offActivity()
    }
  }, [])

  const calls = useMemo(() => {
    const list = (conversation?.messages ?? []).flatMap((m) => m.toolCalls ?? [])
    return list.slice(-8).reverse()
  }, [conversation])

  const files = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of conversation?.messages ?? []) {
      for (const call of message.toolCalls ?? []) {
        for (const key of ['path', 'file', 'filePath', 'destination']) {
          const value = call.args?.[key]
          if (typeof value === 'string' && value) found.set(value, call.name)
        }
      }
    }
    return [...found.entries()].slice(-12)
  }, [conversation])

  const toolGroups = useMemo(() => {
    const groups = new Map<string, ToolSchema[]>()
    for (const tool of tools) {
      const list = groups.get(tool.group) ?? []
      list.push(tool)
      groups.set(tool.group, list)
    }
    return [...groups.entries()]
  }, [tools])

  return (
    <aside className="right-panel">
      <div className="panel-head">
        <div className="panel-tabs">
          <button className={`panel-tab ${tab === 'overview' ? 'active' : ''}`} type="button" onClick={() => setTab('overview')}>
            Workspace
          </button>
          <button className={`panel-tab ${tab === 'tools' ? 'active' : ''}`} type="button" onClick={() => setTab('tools')}>
            Tools {tools.length ? `(${tools.length})` : ''}
          </button>
          <button className={`panel-tab ${tab === 'activity' ? 'active' : ''}`} type="button" onClick={() => setTab('activity')}>
            Activity
          </button>
        </div>
        <span className="grow" />
        <button className="icon-btn" type="button" title="Collapse panel" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="panel-body">
        {tab === 'overview' ? (
          <>
            <div className="panel-card">
              <div className="panel-label">
                <span>Active run</span>
                {live ? <span className="badge accent">live</span> : <span className="badge">idle</span>}
              </div>
              <div className="kv">
                <span className="k">Model</span>
                <span className="v mono" style={{ fontSize: 10 }}>
                  {activeModel?.name ?? '—'}
                </span>
              </div>
              <div className="kv">
                <span className="k">Provider</span>
                <span className="v">{activeModel?.providerName ?? '—'}</span>
              </div>
              <div className="kv">
                <span className="k">Context</span>
                <span className="v">{activeModel?.contextLength ? `${Math.round(activeModel.contextLength / 1024)}k` : '—'}</span>
              </div>
              <div className="kv">
                <span className="k">Phase</span>
                <span className="v">{live?.phase ?? 'idle'}</span>
              </div>
              {live ? (
                <div className="tiny faint mt-8" style={{ lineHeight: 1.5 }}>
                  {truncate(live.status, 140)}
                </div>
              ) : null}
              <div className="model-capabilities" style={{ marginTop: 8 }}>
                <span className={`cap ${activeModel?.capabilities.tools ? 'on' : ''}`}>tools</span>
                <span className={`cap ${activeModel?.capabilities.vision ? 'on' : ''}`}>vision</span>
                <span className={`cap ${activeModel?.capabilities.thinking ? 'on' : ''}`}>thinking</span>
                <span className="cap">{activeModel?.capabilitySource ?? 'unknown'}</span>
              </div>
            </div>

            <div className="panel-card">
              <div className="panel-label">
                <span>Project</span>
                {project ? <span className="badge accent">active</span> : null}
              </div>
              {project ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{project.name}</div>
                  <div className="tiny faint mono pre-wrap" style={{ marginTop: 3 }}>
                    {project.path}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn btn-sm" type="button" onClick={() => void api.app.showItemInFolder(project.path)}>
                      <Icon name="folder" size={11} /> Open folder
                    </button>
                  </div>
                </>
              ) : (
                <div className="tiny faint">No project attached. File tools remain restricted to project folders; attach one in Projects.</div>
              )}
            </div>

            <div className="panel-card">
              <div className="panel-label">
                <span>Files touched</span>
                <span>{files.length}</span>
              </div>
              {files.length ? (
                <div className="file-list">
                  {files.map(([file, tool]) => (
                    <button
                      key={file}
                      className="file-item"
                      type="button"
                      title={`${tool} · ${file}`}
                      onClick={() => void api.app.showItemInFolder(file)}
                      style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <Icon name="file" size={11} className="icon" />
                      {file}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="tiny faint">Files read or written by tools will appear here.</div>
              )}
            </div>

            <div className="panel-card">
              <div className="panel-label">
                <span>Terminal sessions</span>
                <span>{sessions.filter((s) => s.status === 'running').length} running</span>
              </div>
              {sessions.length ? (
                sessions.slice(0, 5).map((session) => (
                  <div className="session-row" key={session.id}>
                    <span className={`status-dot ${session.status === 'running' ? 'online' : session.status === 'exited' ? 'online' : ''}`} />
                    <span className="cmd" title={`${session.cwd}\n${session.outputTail ?? ''}`}>
                      {session.command}
                    </span>
                    <span className="badge">{session.status}</span>
                    {session.status === 'running' ? (
                      <button className="icon-btn danger" type="button" style={{ width: 22, height: 22 }} title="Kill session" onClick={() => void api.terminal.kill(session.id)}>
                        <Icon name="x" size={11} />
                      </button>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="tiny faint">No PowerShell sessions started.</div>
              )}
            </div>

            <div className="panel-card">
              <div className="panel-label">
                <span>Browser</span>
                <span className={`badge ${browser?.open ? 'ok' : ''}`}>{browser?.open ? 'open' : 'closed'}</span>
              </div>
              {browser?.open ? (
                <>
                  <div className="tiny" style={{ wordBreak: 'break-word' }}>{browser.title || browser.url || 'Browser session'}</div>
                  <div className="row" style={{ marginTop: 7 }}>
                    <button className="btn btn-sm" type="button" onClick={() => void api.browser.close()}>
                      Close browser
                    </button>
                  </div>
                </>
              ) : (
                <div className="tiny faint">
                  The Browser Automation plugin launches Edge or Chrome via Playwright on demand.
                </div>
              )}
            </div>

            {calls.length ? (
              <div className="panel-card">
                <div className="panel-label">
                  <span>Recent tool calls</span>
                  <span>{calls.length}</span>
                </div>
                {calls.map((call) => (
                  <div className="tool-row" key={call.id}>
                    <span className={`status-dot ${call.status === 'ok' ? 'online' : call.status === 'error' ? 'busy' : ''}`} />
                    <span className="name">{call.name}</span>
                    <span className="group">{call.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : tab === 'tools' ? (
          <>
            <div className="panel-card">
              <div className="panel-label">
                <span>Available to this model</span>
                <span>{tools.length} tools</span>
              </div>
              <div className="tiny faint" style={{ lineHeight: 1.5 }}>
                Tools enabled by the permission registry. High-risk calls always require approval; revoked plugins
                disappear from this list immediately.
              </div>
            </div>
            {toolGroups.length ? (
              toolGroups.map(([group, list]) => (
                <div className="panel-card" key={group}>
                  <div className="panel-label">
                    <span>{group}</span>
                    <span>{list.length}</span>
                  </div>
                  {list.map((tool) => (
                    <div className="tool-row" key={tool.name}>
                      <span className="name" title={tool.description}>
                        {tool.name}
                      </span>
                      <span className={`badge ${tool.risk === 'high' ? 'danger' : tool.risk === 'medium' ? 'warn' : ''}`}>{tool.risk}</span>
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <div className="panel-card">
                <div className="tiny faint">Loading tool registry… If this persists, check Activity for registry errors.</div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="panel-card">
              <div className="panel-label">
                <span>Recent activity</span>
                <button
                  className="mini-btn"
                  type="button"
                  onClick={() => {
                    void api.activity.clear().then(() => setActivity([]))
                  }}
                >
                  Clear
                </button>
              </div>
              {activity.length ? (
                activity.slice(0, 40).map((item) => (
                  <div className="tool-row" key={item.id} style={{ alignItems: 'flex-start' }}>
                    <Icon name="activity" size={11} style={{ marginTop: 3, color: 'var(--faint)', flex: '0 0 auto' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="tiny" style={{ display: 'block', color: 'var(--text-2)', lineHeight: 1.4 }}>
                        {truncate(item.summary, 120)}
                      </span>
                      <span className="tiny faint">{relativeTime(item.createdAt)} · {item.kind}</span>
                    </span>
                  </div>
                ))
              ) : (
                <div className="tiny faint">No activity recorded yet.</div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
