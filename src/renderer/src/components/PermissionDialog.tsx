import { useEffect } from 'react'
import type { PermissionRequest } from '@shared/types'
import { Icon } from './Icons'
import { safeJson } from '../lib/format'

interface Props {
  request: PermissionRequest
  onRespond: (decision: 'allow' | 'allow-session' | 'allow-always' | 'deny') => void
}

export function PermissionDialog({ request, onRespond }: Props) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRespond('deny')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onRespond])

  const riskLabel =
    request.risk === 'high' ? 'High-impact action' : request.risk === 'medium' ? 'Action needs your approval' : 'Low-risk action'

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="permission-title">
      <div className="modal narrow">
        <div className="modal-head">
          <div
            className="plugin-icon"
            style={{
              color: request.risk === 'high' ? 'var(--danger)' : 'var(--warn)',
              borderColor: request.risk === 'high' ? 'rgba(255,107,107,.3)' : undefined
            }}
          >
            <Icon name={request.risk === 'high' ? 'alert' : 'shield'} size={18} />
          </div>
          <div className="grow">
            <h3 id="permission-title">{request.title}</h3>
            <div className="sub">
              <span className={`badge ${request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warn' : 'ok'}`}>
                {riskLabel}
              </span>{' '}
              <span className="mono">{request.tool}</span>
            </div>
          </div>
        </div>
        <div className="modal-body">
          <div className={`risk-banner ${request.risk}`}>
            <Icon name="shield" size={15} style={{ marginTop: 1, flex: '0 0 auto' }} />
            <span>
              {request.risk === 'high'
                ? 'This action may be destructive or affect system state. Review the exact operation before allowing it.'
                : 'LocalPilot will perform this action with your Windows user privileges.'}{' '}
              Every tool call is logged in Activity history.
            </span>
          </div>
          <div className="permission-detail">{request.detail}</div>
          <div>
            <div className="field-label" style={{ marginBottom: 5 }}>
              Arguments
            </div>
            <pre className="permission-args">{safeJson(request.args)}</pre>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" type="button" onClick={() => onRespond('deny')}>
            Deny
          </button>
          <button className="btn" type="button" onClick={() => onRespond('allow-session')} title="Allow this tool/target until LocalPilot restarts">
            Allow for session
          </button>
          <button className="btn btn-primary" type="button" onClick={() => onRespond('allow')}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  )
}
