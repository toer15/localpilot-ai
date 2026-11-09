import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
      {label ? <span>{label}</span> : null}
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <div className="field-label">{label}</div>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner ${large ? 'large' : ''}`} />
}

export function EmptyState({
  icon = 'sparkles',
  title,
  children
}: {
  icon?: IconName
  title: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {children}
    </div>
  )
}

export function Section({
  title,
  count,
  actions,
  hint,
  children
}: {
  title: string
  count?: number | string
  actions?: ReactNode
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="section">
      <div className="section-head">
        <h3 className="section-title">
          {title}
          {count !== undefined ? <span className="count">{count}</span> : null}
        </h3>
        <div className="row">
          {hint ? <span className="section-hint">{hint}</span> : null}
          {actions}
        </div>
      </div>
      {children}
    </div>
  )
}

export function RiskBadge({ risk }: { risk: string }) {
  return (
    <span className={`badge ${risk === 'high' ? 'danger' : risk === 'medium' ? 'warn' : 'ok'}`}>
      {risk === 'high' ? 'High risk' : risk === 'medium' ? 'Care' : 'Low risk'}
    </span>
  )
}

export function CopyIconButton({ text }: { text: string }) {
  return (
    <button
      className="icon-btn"
      type="button"
      title="Copy"
      onClick={() => void navigator.clipboard.writeText(text)}
    >
      <Icon name="copy" size={13} />
    </button>
  )
}
