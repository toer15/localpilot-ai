import { useEffect, useMemo, useState } from 'react'
import type { ActivityItem, SelfTestReport } from '@shared/types'
import { Icon } from '../components/Icons'
import { EmptyState, Section, Spinner } from '../components/ui'
import { fullDate, relativeTime, safeJson, truncate } from '../lib/format'

const api = window.localpilot

export function ActivityPage() {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const load = async () => {
    try {
      setItems(await api.activity.list(400))
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void load()
    const off = api.activity.onUpdate((item) => {
      setItems((prev) => [item, ...prev].slice(0, 400))
    })
    return off
  }, [])

  const kinds = useMemo(() => ['all', ...new Set(items.map((i) => i.kind))].sort(), [items])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false
      if (!q) return true
      return `${item.summary} ${item.kind} ${JSON.stringify(item.detail ?? '')}`.toLowerCase().includes(q)
    })
  }, [items, kind, query])

  const runTest = async () => {
    setTesting(true)
    setTestError(null)
    try {
      setReport(await api.app.runSelfTest())
      await load()
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const counts = report
    ? {
        pass: report.checks.filter((c) => c.status === 'pass').length,
        fail: report.checks.filter((c) => c.status === 'fail').length,
        skip: report.checks.filter((c) => c.status === 'skip').length
      }
    : null

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Evidence</div>
            <h1 className="page-title">Activity & diagnostics</h1>
            <p className="page-subtitle">
              A local audit trail of tool executions, approvals, plugin changes and agent runs. Diagnostics perform real
              checks against your runtimes, PowerShell, screen capture, Playwright and MCP SDK.
            </p>
          </div>
          <div className="page-actions">
            <button className="btn" type="button" disabled={testing} onClick={() => void runTest()}>
              {testing ? <Spinner /> : <Icon name="play" size={13} />} Run self-test
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => {
                if (!window.confirm('Clear all activity history? Conversations, projects and settings are not affected.')) return
                void api.activity.clear().then(() => setItems([]))
              }}
            >
              <Icon name="trash" size={13} /> Clear log
            </button>
          </div>
        </div>

        {testing ? (
          <div className="notice-row info" style={{ marginBottom: 12 }}>
            <Spinner /> <span>Running real diagnostics — screen capture, PowerShell, SQLite, provider discovery, Playwright and MCP may take up to a minute.</span>
          </div>
        ) : null}
        {testError ? <div className="notice-row error" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /> Self-test failed to start: {testError}</div> : null}

        {report ? (
          <Section
            title={`Self-test · ${report.appVersion}`}
            hint={`${report.environment.platform} ${report.environment.release} · Electron ${report.environment.electron} · completed ${new Date(report.finishedAt).toLocaleTimeString()}`}
            actions={
              <div className="row">
                {counts ? (
                  <>
                    <span className="badge ok">{counts.pass} pass</span>
                    <span className="badge danger">{counts.fail} fail</span>
                    <span className="badge warn">{counts.skip} skip</span>
                  </>
                ) : null}
                <button className="icon-btn" type="button" title="Copy report JSON" onClick={() => void navigator.clipboard.writeText(JSON.stringify(report, null, 2))}>
                  <Icon name="copy" size={13} />
                </button>
              </div>
            }
          >
            <div className="data-list">
              {report.checks.map((check) => (
                <div className="data-row" key={check.name}>
                  <span className={`badge ${check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'danger' : 'warn'}`}>{check.status}</span>
                  <div className="data-main">
                    <div className="data-name" style={{ fontFamily: 'var(--font)', fontSize: 12 }}>{check.name}</div>
                    <div className="data-sub"><span style={{ lineHeight: 1.55 }}>{check.detail}</span></div>
                  </div>
                  {check.durationMs ? <span className="tiny faint">{check.durationMs}ms</span> : null}
                </div>
              ))}
            </div>
            <div className="tiny faint" style={{ marginTop: 7 }}>
              Report file: {report.environment.userData}\data\selftest-report.json
            </div>
          </Section>
        ) : null}

        <Section title="Activity history" count={filtered.length}>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="search-box grow" style={{ margin: 0 }}>
              <Icon name="search" size={13} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by tool, summary or detail…" />
            </div>
            <select className="select select-sm" style={{ width: 150 }} value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => <option key={k} value={k}>{k === 'all' ? 'All kinds' : k}</option>)}
            </select>
          </div>
          {filtered.length ? (
            <div className="data-list">
              {filtered.map((item) => (
                <div key={item.id}>
                  <div className="activity-row" style={{ paddingLeft: 14, paddingRight: 14, cursor: 'pointer' }} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                    <div className="activity-icon"><Icon name={item.kind === 'tool' ? 'wrench' : item.kind === 'permission' ? 'shield' : item.kind === 'terminal' ? 'terminal' : item.kind === 'plugin' ? 'plugin' : 'activity'} size={13} /></div>
                    <div className="activity-main">
                      <div className="activity-summary">{truncate(item.summary, 220)}</div>
                      <div className="activity-meta">
                        <span>{relativeTime(item.createdAt)}</span>
                        <span>{item.kind}</span>
                        <span>{fullDate(item.createdAt)}</span>
                      </div>
                      {expanded === item.id && item.detail !== undefined ? (
                        <pre className="activity-detail">{safeJson(item.detail)}</pre>
                      ) : null}
                    </div>
                    <Icon name={expanded === item.id ? 'chevron' : 'chevron-right'} size={13} style={{ color: 'var(--faint)' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="activity" title="No activity recorded">
              Tool calls, approval decisions, plugin installs and shell commands will appear here as the agent works.
            </EmptyState>
          )}
        </Section>

        <Section title="Diagnostic environment">
          <div className="grid-3">
            <div className="card tight">
              <div className="panel-label">Electron</div>
              <div className="mono tiny">{report?.environment.electron ?? '—'}</div>
              <div className="panel-label" style={{ marginTop: 11 }}>Node</div>
              <div className="mono tiny">{report?.environment.node ?? '—'}</div>
              <div className="panel-label" style={{ marginTop: 11 }}>Architecture</div>
              <div className="mono tiny">{report?.environment.arch ?? '—'}</div>
            </div>
            <div className="card tight">
              <div className="panel-label">Local data</div>
              <div className="tiny faint pre-wrap mono">{report?.environment.userData ?? 'Run the self-test to view local paths.'}</div>
            </div>
            <div className="card tight">
              <div className="panel-label">Privacy</div>
              <div className="tiny faint">Activity is stored only in local SQLite. No telemetry is sent. Tool execution logs can be disabled in Privacy settings.</div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}
