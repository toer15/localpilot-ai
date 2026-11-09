import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from './types'
import { fail, ok, requireString } from './types'
import { createProject, getActiveProject, listProjects, updateProject } from '../projects'
import { settings } from '../settings'

export const projectTools: ToolDefinition[] = [
  {
    name: 'projects.list',
    description: 'List the LocalPilot projects and show which one is active.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'projects',
    group: 'projects',
    source: 'builtin',
    handler: async () => {
      const active = settings.get().activeProjectId
      const projects = listProjects()
      if (!projects.length) return ok('No projects yet. Ask the user to create one, or use projects.create.')
      return ok(
        projects
          .map((p) => `${p.id === active ? '● ACTIVE ' : '○ '}${p.name} — ${p.path}${p.instructions ? `\n   instructions: ${p.instructions.slice(0, 160)}` : ''}`)
          .join('\n')
      )
    }
  },
  {
    name: 'projects.create',
    description:
      'Create (or reuse) a project folder, register it and make it active. Use this when the user asks for a new application or codebase.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string', description: 'Absolute folder path for the new project.' },
        instructions: { type: 'string', description: 'Optional project-specific guidance.' }
      },
      required: ['name', 'path']
    },
    risk: 'medium',
    category: 'projects',
    group: 'projects',
    source: 'builtin',
    preview: (args) => `Create project "${String(args.name)}" at ${String(args.path)}`,
    handler: async (args) => {
      const name = requireString(args, 'name')
      const target = requireString(args, 'path')
      if (!path.isAbsolute(target)) return fail('Project path must be absolute.')
      const project = createProject({ name, path: target, instructions: typeof args.instructions === 'string' ? args.instructions : '' })
      settings.update({ activeProjectId: project.id })
      return ok(`Project "${project.name}" is active at ${project.path}. File tools now operate inside this folder.`, project)
    }
  },
  {
    name: 'projects.set_instructions',
    description: 'Update the active project guidance that is injected into every agent run.',
    parameters: {
      type: 'object',
      properties: { instructions: { type: 'string' } },
      required: ['instructions']
    },
    risk: 'low',
    category: 'projects',
    group: 'projects',
    source: 'builtin',
    handler: async (args) => {
      const project = getActiveProject()
      if (!project) return fail('No active project.')
      const updated = updateProject(project.id, { instructions: requireString(args, 'instructions') })
      return ok(`Updated instructions for ${updated.name}.`)
    }
  },
  {
    name: 'projects.info',
    description: 'Show details about the active project, including its instructions and root file listing.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'projects',
    group: 'projects',
    source: 'builtin',
    handler: async (_args, ctx) => {
      const project = getActiveProject()
      if (!project) return fail('No active project. The agent cannot touch project files until one is opened.')
      let entries: string[] = []
      try {
        entries = fs.readdirSync(project.path).filter((name) => !name.startsWith('.')).slice(0, 40)
      } catch {
        // ignore
      }
      return ok(
        `Project: ${project.name}\nPath: ${project.path}\nInstructions: ${project.instructions || '(none)'}\nTop-level entries: ${entries.join(', ') || '(empty folder)'}`,
        project
      )
    }
  }
]
