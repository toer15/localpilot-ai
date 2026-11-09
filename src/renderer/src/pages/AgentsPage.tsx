import { useEffect, useMemo, useState } from 'react'
import type { AgentProfile, AppSettings, ReasoningEffort, ToolSchema, ToolProtocol } from '@shared/types'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Section, Spinner, Toggle } from '../components/ui'

const api = window.localpilot

interface Props {
  settings: AppSettings
  onUpdateSettings: (patch: Record<string, unknown>) => Promise<AppSettings>
}

const REASONING: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'max', 'ultra']
const PROTOCOLS: { value: ToolProtocol; label: string }[] = [
  { value: 'auto', label: 'Auto (native when reported)' },
  { value: 'native', label: 'Native function calling' },
  { value: 'text', label: 'Text tool protocol' }
]

export function AgentsPage({ settings, onUpdateSettings }: Props) {
  const profiles = settings.agent.profiles
  const [activeId, setActiveId] = useState(settings.agent.activeProfileId)
  const [draft, setDraft] = useState<AgentProfile | null>(() => profiles.find((p) => p.id === settings.agent.activeProfileId) ?? profiles[0] ?? null)
  const [limitedTools, setLimitedTools] = useState(() => !!draft?.allowedGroups)
  const [selectedGroups, setSelectedGroups] = useState<string[]>(draft?.allowedGroups ?? [])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.tools.list().then(setTools).catch(() => undefined)
  }, [])

  const groups = useMemo(() => [...new Set(tools.map((t) => t.group))].sort(), [tools])
  const active = profiles.find((p) => p.id === activeId) ?? null

  const selectProfile = (profile: AgentProfile) => {
    setActiveId(profile.id)
    setDraft({ ...profile })
    setLimitedTools(!!profile.allowedGroups)
    setSelectedGroups(profile.allowedGroups ?? [])
    setMessage(null)
    setError(null)
  }

  const persistProfiles = async (next: AgentProfile[], activeProfileId = activeId) => {
    await onUpdateSettings({ agent: { profiles: next, activeProfileId } })
    setMessage('Agent profiles saved.')
  }

  const saveDraft = async () => {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Profile name cannot be empty.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const normalized = { ...draft, allowedGroups: limitedTools ? selectedGroups : null }
      const next = profiles.map((p) => (p.id === normalized.id ? normalized : p))
      await persistProfiles(next, normalized.id)
      setActiveId(normalized.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const activate = async (profile: AgentProfile) => {
    setActiveId(profile.id)
    await onUpdateSettings({ agent: { activeProfileId: profile.id } })
    setMessage(`${profile.name} is now the active profile.`)
  }

  const duplicate = async () => {
    if (!draft) return
    const copy: AgentProfile = {
      ...draft,
      id: `profile-${crypto.randomUUID()}`,
      name: `${draft.name} copy`,
      allowedGroups: draft.allowedGroups ? [...draft.allowedGroups] : null
    }
    const next = [...profiles, copy]
    await persistProfiles(next)
    selectProfile(copy)
  }

  const remove = async () => {
    if (!draft || profiles.length <= 1) return
    if (!window.confirm(`Delete the “${draft.name}” profile?`)) return
    const next = profiles.filter((p) => p.id !== draft.id)
    const nextActive = activeId === draft.id ? next[0].id : activeId
    await persistProfiles(next, nextActive)
    selectProfile(next.find((p) => p.id === nextActive) ?? next[0])
  }

  const toolGroupsLimited = limitedTools && selectedGroups.length === 0

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Orchestration</div>
            <h1 className="page-title">Agents</h1>
            <p className="page-subtitle">
              Profiles configure sampling, reasoning, tool protocol, iteration limits and which tool groups the agent may
              use. They tune the same local model — they do not add capabilities the model does not have.
            </p>
          </div>
          <div className="page-actions">
            <span className="badge accent">active: {active?.name ?? 'none'}</span>
            <button className="btn" type="button" disabled={!draft} onClick={() => void duplicate()}>
              <Icon name="copy" size={12} /> Duplicate
            </button>
          </div>
        </div>

        {message ? <div className="notice-row info" style={{ marginBottom: 12 }}><Icon name="check" size={14} /> {message}</div> : null}
        {error ? <div className="notice-row error" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /> {error}</div> : null}

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div>
            <Section title="Profiles" count={profiles.length}>
              <div className="stack">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`card card-hover ${draft?.id === profile.id ? '' : ''}`}
                    style={{
                      textAlign: 'left',
                      borderColor: draft?.id === profile.id ? 'var(--accent-line)' : undefined,
                      background: draft?.id === profile.id ? 'var(--accent-soft)' : undefined,
                      cursor: 'pointer',
                      padding: 14
                    }}
                    onClick={() => selectProfile(profile)}
                  >
                    <div className="row between">
                      <div className="card-title" style={{ margin: 0 }}>
                        {profile.name}
                        {settings.agent.activeProfileId === profile.id ? <span className="badge accent">active</span> : null}
                      </div>
                      <span className="badge">{profile.reasoningEffort} reasoning</span>
                    </div>
                    <div className="tiny faint" style={{ marginTop: 4 }}>{profile.description || 'No description.'}</div>
                    <div className="model-capabilities" style={{ marginTop: 8 }}>
                      <span className="cap">temp {profile.temperature}</span>
                      <span className="cap">{profile.maxIterations} steps</span>
                      <span className="cap">{profile.toolProtocol} tools</span>
                      <span className="cap">{profile.allowedGroups ? `${profile.allowedGroups.length} groups` : 'all tools'}</span>
                    </div>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Agent runtime limits">
              <div className="card">
                <div className="form-stack">
                  <Field label="Maximum iterations per run" hint="The agent stops after this many model/tool cycles and reports what remains.">
                    <input className="input" type="number" min="1" max="200" value={settings.agent.maxIterations}
                      onChange={(e) => void onUpdateSettings({ agent: { maxIterations: Number(e.target.value) } })} />
                  </Field>
                  <Field label="Tool calls per run">
                    <input className="input" type="number" min="1" max="500" value={settings.agent.toolCallLimit}
                      onChange={(e) => void onUpdateSettings({ agent: { toolCallLimit: Number(e.target.value) } })} />
                  </Field>
                  <Field label="Run timeout (ms)">
                    <input className="input" type="number" min="10000" step="1000" value={settings.agent.timeoutMs}
                      onChange={(e) => void onUpdateSettings({ agent: { timeoutMs: Number(e.target.value) } })} />
                  </Field>
                  <Field label="History messages sent to the model" hint="Older messages are trimmed from context, never deleted from local storage.">
                    <input className="input" type="number" min="2" max="200" value={settings.agent.maxHistoryMessages}
                      onChange={(e) => void onUpdateSettings({ agent: { maxHistoryMessages: Number(e.target.value) } })} />
                  </Field>
                  <div className="setting-row">
                    <div className="info">
                      <div className="t">Allow subagents</div>
                      <div className="d">The main agent can delegate research or review tasks to isolated subagent runs with a restricted tool set.</div>
                    </div>
                    <Toggle checked={settings.agent.allowSubagents} onChange={(v) => void onUpdateSettings({ agent: { allowSubagents: v } })} />
                  </div>
                </div>
              </div>
            </Section>
          </div>

          <div>
            {draft ? (
              <Section
                title={`Edit · ${draft.name}`}
                actions={
                  <div className="row">
                    {activeId !== draft.id ? <button className="btn btn-sm" type="button" onClick={() => void activate(draft)}>Set active</button> : null}
                    <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => void saveDraft()}>
                      {busy ? <Spinner /> : <Icon name="check" size={11} />} Save
                    </button>
                  </div>
                }
              >
                <div className="card">
                  <div className="form-stack">
                    <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                    <Field label="Description"><input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
                    <div className="form-row">
                      <Field label="Temperature"><input className="input" type="number" step="0.05" min="0" max="2" value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} /></Field>
                      <Field label="Top P"><input className="input" type="number" step="0.05" min="0" max="1" value={draft.topP} onChange={(e) => setDraft({ ...draft, topP: Number(e.target.value) })} /></Field>
                      <Field label="Max output tokens"><input className="input" type="number" min="64" value={draft.maxTokens} onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) })} /></Field>
                      <Field label="Context length"><input className="input" type="number" min="1024" value={draft.contextLength} onChange={(e) => setDraft({ ...draft, contextLength: Number(e.target.value) })} /></Field>
                      <Field label="Max iterations"><input className="input" type="number" min="1" max="200" value={draft.maxIterations} onChange={(e) => setDraft({ ...draft, maxIterations: Number(e.target.value) })} /></Field>
                      <Field label="Reasoning effort">
                        <select className="select" value={draft.reasoningEffort} onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value as ReasoningEffort })}>
                          {REASONING.map((r) => <option key={r} value={r}>{r === 'max' ? 'maximum' : r === 'ultra' ? 'ultra (if supported)' : r}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="Tool protocol" hint="Auto uses native function calling only when the provider reports it; otherwise the text tool protocol is used.">
                      <select className="select" value={draft.toolProtocol} onChange={(e) => setDraft({ ...draft, toolProtocol: e.target.value as ToolProtocol })}>
                        {PROTOCOLS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </Field>
                    <Field label="System suffix" hint="Appended to the system prompt for this profile. Do not include secrets.">
                      <textarea className="textarea" rows={3} value={draft.systemSuffix} onChange={(e) => setDraft({ ...draft, systemSuffix: e.target.value })} />
                    </Field>
                    <div className="divider" />
                    <div className="setting-row">
                      <div className="info">
                        <div className="t">Restrict tool groups</div>
                        <div className="d">When off, the profile can use every enabled tool (permission approval still applies).</div>
                      </div>
                      <Toggle checked={limitedTools} onChange={(v) => { setLimitedTools(v); if (v && !selectedGroups.length) setSelectedGroups(groups.slice(0, 1)) }} />
                    </div>
                    {limitedTools ? (
                      <div className="row wrap">
                        {groups.map((group) => (
                          <label key={group} className="badge" style={{ cursor: 'pointer', padding: '4px 8px' }}>
                            <input
                              type="checkbox"
                              checked={selectedGroups.includes(group)}
                              onChange={(e) => setSelectedGroups((prev) => e.target.checked ? [...prev, group] : prev.filter((g) => g !== group))}
                              style={{ accentColor: 'var(--accent)', marginRight: 4 }}
                            />
                            {group}
                          </label>
                        ))}
                        {!groups.length ? <span className="tiny faint">Tool registry not loaded yet.</span> : null}
                      </div>
                    ) : null}
                    {toolGroupsLimited ? <div className="notice-row error"><Icon name="alert" size={12} /> Select at least one tool group or turn off group restriction.</div> : null}
                    <div className="row">
                      <button className="btn btn-danger btn-sm" type="button" onClick={() => void remove()} disabled={profiles.length <= 1}>Delete profile</button>
                      <span className="grow" />
                      <button className="btn btn-sm" type="button" onClick={() => { setDraft({ ...draft }); setMessage(null) }}>Reset changes</button>
                    </div>
                  </div>
                </div>
                <div className="tiny faint" style={{ marginTop: 8 }}>
                  Profiles can be saved as coding, deep reasoning, general assistant, computer control or game development
                  configurations. New profiles start from the current draft.
                </div>
              </Section>
            ) : (
              <EmptyState icon="users" title="No profile selected">Create or select a profile to edit it.</EmptyState>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
