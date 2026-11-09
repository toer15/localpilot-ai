import type { ToolDefinition } from './types'
import { fail, num, ok, requireString, str } from './types'
import { runProcess } from '../core/proc'
import type { ToolContext } from './types'

async function git(args: string[], ctx: ToolContext, timeoutMs = 30000) {
  if (!ctx.projectPath) throw new Error('No active project. Open a project folder first.')
  return runProcess('git', args, { cwd: ctx.projectPath, timeoutMs })
}

function outputOf(res: { stdout: string; stderr: string; code: number | null }, fallback = ''): string {
  const text = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n')
  return text || fallback
}

async function ensureRepo(ctx: ToolContext) {
  const res = await git(['rev-parse', '--is-inside-work-tree'], ctx, 8000)
  return res.code === 0 && res.stdout.includes('true')
}

export const gitTools: ToolDefinition[] = [
  {
    name: 'git.status',
    description: 'Show git branch and working-tree status for the active project.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'git',
    group: 'git',
    source: 'builtin',
    handler: async (_args, ctx) => {
      if (!(await ensureRepo(ctx))) return fail('The active project is not a git repository. Use git.init first.')
      const res = await git(['status', '--porcelain=v1', '-b'], ctx)
      return ok(outputOf(res, 'Working tree clean.'))
    }
  },
  {
    name: 'git.diff',
    description: 'Show unstaged or staged diffs. Review your own changes before reporting work complete.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean' },
        path: { type: 'string', description: 'Limit to a file or folder.' },
        statOnly: { type: 'boolean' }
      }
    },
    risk: 'low',
    category: 'git',
    group: 'git',
    source: 'builtin',
    handler: async (args, ctx) => {
      if (!(await ensureRepo(ctx))) return fail('The active project is not a git repository.')
      const gitArgs = ['diff']
      if (args.staged === true) gitArgs.push('--staged')
      if (args.statOnly === true) gitArgs.push('--stat')
      if (typeof args.path === 'string' && args.path) gitArgs.push('--', args.path)
      const res = await git(gitArgs, ctx, 45000)
      return ok(outputOf(res, 'No changes.'))
    }
  },
  {
    name: 'git.log',
    description: 'Show recent commits.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Default 15, max 50.' } }
    },
    risk: 'low',
    category: 'git',
    group: 'git',
    source: 'builtin',
    handler: async (args, ctx) => {
      if (!(await ensureRepo(ctx))) return fail('The active project is not a git repository.')
      const limit = Math.min(num(args.limit, 15), 50)
      const res = await git(['log', `-${limit}`, '--pretty=format:%h %ad %s (%an)', '--date=short'], ctx)
      return ok(outputOf(res, 'No commits yet.'))
    }
  },
  {
    name: 'git.branch',
    description: 'List branches, create a new branch, or switch branches.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        create: { type: 'boolean', description: 'Create and switch to the named branch.' }
      }
    },
    risk: 'medium',
    category: 'git',
    group: 'git',
    source: 'builtin',
    preview: (args) => (args.name ? `${args.create ? 'Create' : 'Switch to'} branch ${String(args.name)}` : 'List branches'),
    handler: async (args, ctx) => {
      if (!(await ensureRepo(ctx))) return fail('The active project is not a git repository. Use git.init first.')
      if (!args.name) {
        const res = await git(['branch', '--show-current'], ctx)
        const list = await git(['branch', '--format=%(refname:short)'], ctx)
        return ok(`Current: ${res.stdout.trim()}\n${outputOf(list)}`)
      }
      const name = requireString(args, 'name')
      if (/[\s~^:?*[\]\\]/.test(name)) return fail('Invalid branch name.')
      const res = await git(args.create === true ? ['checkout', '-b', name] : ['checkout', name], ctx)
      return { ok: res.code === 0, content: outputOf(res, 'Branch operation complete.') }
    }
  },
  {
    name: 'git.commit',
    description: 'Stage changes and create a commit. Always requires approval. Use a clear, specific message.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        all: { type: 'boolean', description: 'Stage all changes (default true).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional specific paths to stage.' }
      },
      required: ['message']
    },
    risk: 'high',
    category: 'git',
    group: 'git',
    source: 'builtin',
    sessionKey: () => 'repo',
    preview: (args) => `Commit changes with message:\n\n${str(args.message)}`,
    handler: async (args, ctx) => {
      if (!(await ensureRepo(ctx))) return fail('The active project is not a git repository.')
      const message = requireString(args, 'message')
      const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : []
      if (files.length) {
        const add = await git(['add', '--', ...files], ctx)
        if (add.code !== 0) return fail(outputOf(add))
      } else if (args.all !== false) {
        const add = await git(['add', '-A'], ctx)
        if (add.code !== 0) return fail(outputOf(add))
      }
      const res = await git(['commit', '-m', message], ctx, 60000)
      if (res.code !== 0) {
        return fail(
          `${outputOf(res)}\n\nIf git identity is missing, ask the user to configure user.name and user.email; do not invent an identity.`
        )
      }
      return ok(outputOf(res))
    }
  },
  {
    name: 'git.init',
    description: 'Initialise a git repository in the active project folder.',
    parameters: { type: 'object', properties: {} },
    risk: 'medium',
    category: 'git',
    group: 'git',
    source: 'builtin',
    preview: () => 'Initialise a git repository in the active project',
    handler: async (_args, ctx) => {
      if (!ctx.projectPath) return fail('No active project.')
      const res = await git(['init'], ctx)
      return { ok: res.code === 0, content: outputOf(res, 'Repository initialised.') }
    }
  }
]
