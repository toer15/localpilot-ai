import { safeStorage } from 'electron'
import { get, run } from './db'
import { log } from './core/logger'

/**
 * API keys are encrypted with Windows DPAPI through Electron safeStorage.
 * Stored values never leave the main process; only "is saved" flags reach the UI.
 */
export function setSecret(id: string, value: string): boolean {
  try {
    if (!value) {
      run('DELETE FROM secrets WHERE id = ?', [id])
      return true
    }
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString('base64')
      : `plain:${Buffer.from(value, 'utf8').toString('base64')}`
    run(
      'INSERT INTO secrets (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [id, encrypted, new Date().toISOString()]
    )
    return true
  } catch (err) {
    log.error('secrets', `Could not save secret ${id}`, String(err))
    return false
  }
}

export function getSecret(id: string): string | null {
  try {
    const row = get<{ value: string }>('SELECT value FROM secrets WHERE id = ?', [id])
    if (!row) return null
    if (row.value.startsWith('plain:')) {
      return Buffer.from(row.value.slice(6), 'base64').toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
  } catch (err) {
    log.warn('secrets', `Could not read secret ${id}`, String(err))
    return null
  }
}

export function hasSecret(id: string): boolean {
  return Boolean(get<{ id: string }>('SELECT id FROM secrets WHERE id = ?', [id]))
}

export function deleteSecret(id: string) {
  run('DELETE FROM secrets WHERE id = ?', [id])
}
