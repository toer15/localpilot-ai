import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project } from '@shared/types'
import { all, get, run } from './db'
import { settings } from './settings'
import { recordActivity } from './activity'
import { log } from './core/logger'

function rowToProject(row: {
  id: string
  name: string
  path: string
  instructions: string
  created_at: string
  updated_at: string
}): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listProjects(): Project[] {
  return all<{
    id: string
    name: string
    path: string
    instructions: string
    created_at: string
    updated_at: string
  }>('SELECT * FROM projects ORDER BY updated_at DESC').map(rowToProject)
}

export function getProject(id: string | null | undefined): Project | null {
  if (!id) return null
  const row = get<{
    id: string
    name: string
    path: string
    instructions: string
    created_at: string
    updated_at: string
  }>('SELECT * FROM projects WHERE id = ?', [id])
  return row ? rowToProject(row) : null
}

export function getActiveProject(): Project | null {
  return getProject(settings.get().activeProjectId)
}

export function createProject(input: { name: string; path: string; instructions?: string }): Project {
  const projectPath = path.resolve(input.path)
  if (!path.isAbsolute(projectPath)) throw new Error('Project path must be absolute.')
  fs.mkdirSync(projectPath, { recursive: true })
  const existing = get<{ id: string }>('SELECT id FROM projects WHERE path = ?', [projectPath])
  if (existing) {
    const project = getProject(existing.id)
    if (project) return project
  }
  const now = new Date().toISOString()
  const project: Project = {
    id: randomUUID(),
    name: input.name.trim() || path.basename(projectPath),
    path: projectPath,
    instructions: input.instructions ?? '',
    createdAt: now,
    updatedAt: now
  }
  run(
    'INSERT INTO projects (id, name, path, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [project.id, project.name, project.path, project.instructions, now, now]
  )
  // A small marker helps users recognise the folder and documents the tool boundary.
  try {
    const marker = path.join(projectPath, '.localpilot-project.json')
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(
        marker,
        JSON.stringify({ name: project.name, createdAt: now, managedBy: 'LocalPilot AI' }, null, 2),
        'utf8'
      )
    }
  } catch {
    // markers are optional
  }
  recordActivity('project', `Created project ${project.name}`, { path: project.path })
  return project
}

export function updateProject(
  id: string,
  patch: { name?: string; instructions?: string; path?: string }
): Project {
  const current = getProject(id)
  if (!current) throw new Error('Project not found.')
  let nextPath = current.path
  if (patch.path) {
    nextPath = path.resolve(patch.path)
    fs.mkdirSync(nextPath, { recursive: true })
  }
  const nextName = patch.name?.trim() || current.name
  const nextInstructions = patch.instructions ?? current.instructions
  run('UPDATE projects SET name = ?, path = ?, instructions = ?, updated_at = ? WHERE id = ?', [
    nextName,
    nextPath,
    nextInstructions,
    new Date().toISOString(),
    id
  ])
  return getProject(id)!
}

export function removeProject(id: string, deleteFiles = false) {
  const project = getProject(id)
  if (!project) return
  run('DELETE FROM projects WHERE id = ?', [id])
  if (settings.get().activeProjectId === id) {
    settings.update({ activeProjectId: null })
  }
  if (deleteFiles) {
    const resolved = path.resolve(project.path)
    const home = path.resolve(process.env.USERPROFILE ?? '')
    if (resolved === home || /^[A-Za-z]:\\?$/.test(resolved)) {
      log.warn('projects', 'Refusing to delete a drive root or home directory')
    } else {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  }
  recordActivity('project', `Removed project ${project.name}`, { path: project.path, deleteFiles })
}

export function touchProject(id: string) {
  run('UPDATE projects SET updated_at = ? WHERE id = ?', [new Date().toISOString(), id])
}

export function projectFiles(project: Project, limit = 120) {
  const out: { path: string; sizeBytes: number; modifiedAt: string }[] = []
  const skip = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.next', 'build', '.cache'])
  function walk(dir: string, depth: number) {
    if (out.length >= limit || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (skip.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, depth + 1)
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(abs)
          out.push({
            path: path.relative(project.path, abs).replace(/\\/g, '/'),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
          })
        } catch {
          // ignore
        }
      }
    }
  }
  walk(project.path, 0)
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
