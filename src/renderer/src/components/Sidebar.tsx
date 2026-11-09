import { useMemo, useState } from 'react'
import type { AppInfo, ConversationSummary, ProviderStatus } from '@shared/types'
import type { Page } from '../App'
import { Icon, type IconName } from './Icons'
import { groupConversations, relativeTime } from '../lib/format'

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  info: AppInfo
  providers: ProviderStatus[]
  running: boolean
  onEmergencyStop: () => void
}

const NAV: { id: Page; label: string; icon: IconName }[] = [
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'agents', label: 'Agents', icon: 'users' },
  { id: 'models', label: 'Model library', icon: 'cpu' },
  { id: 'plugins', label: 'Plugin marketplace', icon: 'plugin' },
  { id: 'activity', label: 'Activity history', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

export function Sidebar({
  page,
  onNavigate,
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  info,
  providers,
  running,
  onEmergencyStop
}: Props) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations
  }, [conversations, search])
  const groups = useMemo(() => groupConversations(filtered), [filtered])
  const online = providers.filter((p) => p.running)
  const statusLabel = running
    ? 'Agent working'
    : online.length
      ? `${online[0].name}${online.length > 1 ? ` +${online.length - 1}` : ''}`
      : 'No local runtime online'

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="zap" size={17} />
        </div>
        <div>
          <div className="brand-name">LocalPilot AI</div>
          <div className="brand-sub">Local workstation</div>
        </div>
      </div>

      <div className="sidebar-scroll">
        <button className="new-chat" type="button" onClick={onNew}>
          <Icon name="plus" size={15} />
          New conversation
          <kbd>Ctrl N</kbd>
        </button>

        <nav className="nav" aria-label="Workspace">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
              {item.id === 'projects' && conversations.length ? null : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Recent</span>
            <span>{conversations.length}</span>
          </div>
          <div className="search-box">
            <Icon name="search" size={13} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
            />
          </div>
          {groups.length === 0 ? (
            <div className="tiny faint" style={{ padding: '6px 8px' }}>
              {search ? 'No matching conversations.' : 'Your conversations will appear here.'}
            </div>
          ) : (
            groups.map((group) => (
              <div className="convo-group" key={group.label}>
                <div className="convo-group-label">{group.label}</div>
                {group.items.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={`convo-item ${activeId === conversation.id && page === 'chat' ? 'active' : ''}`}
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                  >
                    <Icon name="chat" size={13} style={{ opacity: 0.65, flex: '0 0 auto' }} />
                    <span className="convo-text">
                      <span className="convo-title">{conversation.title}</span>
                      <span className="convo-meta">
                        {relativeTime(conversation.updatedAt)} · {conversation.messageCount} msg
                      </span>
                    </span>
                    <span
                      className="convo-delete"
                      role="button"
                      title="Delete conversation"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(conversation.id)
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <span className={`status-dot ${running ? 'busy' : online.length ? 'online' : ''}`} />
        <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {statusLabel}
        </span>
        {running ? (
          <button className="icon-btn danger" type="button" title="Emergency stop" onClick={onEmergencyStop}>
            <Icon name="stop" size={13} />
          </button>
        ) : null}
        <span className="ver">v{info.version}</span>
      </div>
    </aside>
  )
}
