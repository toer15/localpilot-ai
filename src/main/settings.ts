import { get, run } from './db'
import { defaultSettings } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import { getPaths } from './core/paths'
import { log } from './core/logger'

const SETTINGS_KEY = 'app'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    return (patch === undefined ? base : (patch as T))
  }
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

class SettingsStore {
  private current: AppSettings | null = null

  init(): AppSettings {
    const defaults = defaultSettings(getPaths().modelsDir)
    const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])
    if (!row) {
      this.current = defaults
      this.persist()
      return this.current
    }
    try {
      const stored = JSON.parse(row.value) as Partial<AppSettings>
      this.current = deepMerge(defaults, stored)
    } catch (err) {
      log.error('settings', 'Corrupt settings, resetting to defaults', String(err))
      this.current = defaults
    }
    // Keep model download directory aligned with the real userData path if it was never customised.
    if (!this.current.models.modelsDir) this.current.models.modelsDir = getPaths().modelsDir
    let upgraded = false
    // The original 8k default could not hold the tool schema set plus a screenshot.
    if (this.current.models.contextLength === 8192) {
      this.current.models.contextLength = 32768
      upgraded = true
    }
    for (const profile of this.current.agent.profiles) {
      if (profile.contextLength === 8192) {
        profile.contextLength = 32768
        upgraded = true
      }
    }
    if (upgraded) {
      this.persist()
      log.info('settings', 'Raised legacy 8k context to 32k for tool and vision headroom')
    }
    return this.current
  }

  get(): AppSettings {
    if (!this.current) return this.init()
    return this.current
  }

  update(patch: unknown): AppSettings {
    const merged = deepMerge(this.get(), patch)
    this.current = merged
    this.persist()
    return merged
  }

  replace(next: AppSettings): AppSettings {
    this.current = next
    this.persist()
    return next
  }

  reset(): AppSettings {
    this.current = defaultSettings(getPaths().modelsDir)
    this.persist()
    return this.current
  }

  private persist() {
    if (!this.current) return
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [SETTINGS_KEY, JSON.stringify(this.current)]
    )
  }
}

export const settings = new SettingsStore()
