import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database as SqlDatabase, type SqlValue } from 'sql.js'
import { getPaths } from './core/paths'
import { log } from './core/logger'

export interface SqlRunResult {
  lastInsertRowid: number
  changes: number
}

let db: SqlDatabase | null = null
let dbFile = ''
let saveTimer: NodeJS.Timeout | null = null
let dirty = false

function locateWasm(): string {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      // continue
    }
  }
  return candidates[candidates.length - 1]
}

export async function initDatabase(customFile?: string): Promise<void> {
  const paths = getPaths()
  dbFile = customFile ?? paths.dbFile
  const SQL = await initSqlJs({ locateFile: () => locateWasm() })
  let data: Uint8Array | undefined
  try {
    if (fs.existsSync(dbFile)) data = new Uint8Array(fs.readFileSync(dbFile))
  } catch (err) {
    log.warn('db', 'Could not read existing database, starting fresh', String(err))
  }
  db = data ? new SQL.Database(data) : new SQL.Database()
  db.run('PRAGMA foreign_keys = ON;')
  migrate()
  saveNow()
  log.info('db', `SQLite ready at ${dbFile}`)
}

function migrate() {
  const d = requireDb()
  d.run(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT,
      provider_id TEXT, model_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      reasoning TEXT, tool_calls TEXT, attachments TEXT,
      provider_id TEXT, model_id TEXT, meta TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT,
      key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
      manifest TEXT, config TEXT, installed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL,
      detail TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_models (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL,
      size_bytes INTEGER, quantization TEXT, context_length INTEGER, added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
}

function requireDb(): SqlDatabase {
  if (!db) throw new Error('Database is not initialised')
  return db
}

export function scheduleSave() {
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveNow(), 400)
}

export function saveNow() {
  if (!db || !dbFile) return
  try {
    const data = db.export()
    const dir = path.dirname(dbFile)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${dbFile}.tmp`
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, dbFile)
    dirty = false
  } catch (err) {
    log.error('db', 'Failed to persist database', String(err))
  }
}

export function closeDatabase() {
  if (saveTimer) clearTimeout(saveTimer)
  if (dirty) saveNow()
  db?.close()
  db = null
}

export function run(sql: string, params: SqlValue[] = []): SqlRunResult {
  const d = requireDb()
  d.run(sql, params)
  scheduleSave()
  const row = d.exec('SELECT last_insert_rowid() AS id, changes() AS changes')[0]?.values?.[0]
  return { lastInsertRowid: Number(row?.[0] ?? 0), changes: Number(row?.[1] ?? 0) }
}

export function all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
  const d = requireDb()
  const stmt = d.prepare(sql)
  try {
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
    return rows
  } finally {
    stmt.free()
  }
}

export function get<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null {
  return all<T>(sql, params)[0] ?? null
}

export function exec(sql: string) {
  requireDb().run(sql)
  scheduleSave()
}

export function databaseSize(): number {
  try {
    if (dbFile && fs.existsSync(dbFile)) return fs.statSync(dbFile).size
  } catch {
    // ignore
  }
  return 0
}
