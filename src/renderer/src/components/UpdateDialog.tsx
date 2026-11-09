import type { AppUpdateStatus } from '@shared/types'
import { Icon } from './Icons'
import { Spinner } from './ui'

interface Props {
  status: AppUpdateStatus
  installing: boolean
  onClose: () => void
  onInstall: () => void
}

function plainNotes(notes?: string): string {
  return (notes ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function UpdateDialog({ status, installing, onClose, onInstall }: Props) {
  const ready = status.phase === 'downloaded'
  const percent = Math.round(status.percent ?? 0)
  const version = status.version ?? 'new version'
  const notes = plainNotes(status.releaseNotes)

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
      <div className="modal narrow">
        <div className="modal-head">
          <div className="brand-mark" style={{ width: 34, height: 34, borderRadius: 10, flex: '0 0 auto' }}>
            <Icon name={ready ? 'check' : 'download'} size={17} />
          </div>
          <div className="grow">
            <h3 id="update-dialog-title">{ready ? 'Update ready to install' : 'A new LocalPilot version is available'}</h3>
            <div className="sub">
              Version {version} is available for LocalPilot AI {status.currentVersion}.
            </div>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close update prompt">
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="modal-body">
          <div className="risk-banner low">
            <Icon name={ready ? 'check' : 'download'} size={15} style={{ marginTop: 1, flex: '0 0 auto' }} />
            <span>
              {ready
                ? 'The installer has been downloaded and verified. Restart LocalPilot to finish installing it.'
                : 'The update downloads in the background. You can keep working; LocalPilot will ask before restarting.'}
            </span>
          </div>

          {ready ? null : (
            <div>
              <div className="row between tiny faint" style={{ marginBottom: 6 }}>
                <span>Download progress</span>
                <span>{percent}%</span>
              </div>
              <div className="progress" aria-label={`Update download ${percent}% complete`}>
                <span style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {notes ? (
            <div>
              <div className="field-label">What’s new</div>
              <div
                className="permission-args"
                style={{
                  maxHeight: 180,
                  fontFamily: 'var(--font)',
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: 'var(--muted)',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {notes}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          <div className="grow tiny faint">
            {ready ? 'LocalPilot will close briefly while the update installs.' : 'Auto-checks run at launch and every four hours.'}
          </div>
          <button className="btn" type="button" onClick={onClose} disabled={installing}>
            {ready ? 'Later' : 'Not now'}
          </button>
          {ready ? (
            <button className="btn btn-primary" type="button" onClick={onInstall} disabled={installing}>
              {installing ? <Spinner /> : <Icon name="refresh" size={13} />}
              Restart and install
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
