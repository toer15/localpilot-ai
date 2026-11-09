import type { ToolDefinition } from './types'
import { fail, num, ok, requireString, str } from './types'
import { providers } from '../providers/manager'
import { settings } from '../settings'
import { searchWeb } from './web'
import type { ProviderMessage } from '../providers/types'

const ROLES: Record<string, { title: string; prompt: string }> = {
  reviewer: {
    title: 'Code reviewer',
    prompt:
      'You are a rigorous senior code reviewer. Find concrete bugs, security issues, broken edge cases and missing tests. Be specific, cite file/line where possible, and rank findings by severity. Do not rewrite the entire project.'
  },
  architect: {
    title: 'Software architect',
    prompt:
      'You are a pragmatic software architect. Evaluate tradeoffs, propose the simplest robust design, identify risks and list concrete next steps. Prefer boring, maintainable technology.'
  },
  tester: {
    title: 'QA engineer',
    prompt:
      'You are a QA engineer. Design focused test cases and acceptance checks for the described feature. Include exact commands, inputs and expected results. Call out what cannot be tested locally.'
  },
  debugger: {
    title: 'Debugger',
    prompt:
      'You are an expert debugger. Form competing hypotheses, identify the cheapest discriminating observation, and give a concrete debugging sequence. Never assert a root cause without evidence.'
  },
  researcher: {
    title: 'Researcher',
    prompt:
      'You are a technical researcher. Summarise the provided evidence, distinguish local facts from external claims, cite URLs inline, and state uncertainty. Do not invent sources.'
  }
}

export const agentTools: ToolDefinition[] = [
  {
    name: 'agents.delegate',
    description:
      'Delegate a focused analysis to a second agent role (reviewer, architect, tester, debugger, researcher) using the current local model. Returns its report. No tools are given to the subagent; set browse=true to include web search context for researcher tasks.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: Object.keys(ROLES) },
        task: { type: 'string', description: 'Exactly what the subagent should analyse or produce.' },
        context: { type: 'string', description: 'Relevant code, diffs, errors or findings to analyse.' },
        browse: { type: 'boolean', description: 'Allow a web search to supply context (requires internet).' }
      },
      required: ['role', 'task']
    },
    risk: 'low',
    category: 'agents',
    group: 'agents',
    source: 'builtin',
    enabled: () => settings.get().agent.allowSubagents,
    sessionKey: (args) => str(args.role),
    handler: async (args, ctx) => {
      const roleKey = requireString(args, 'role')
      const role = ROLES[roleKey]
      if (!role) return fail(`Unknown role. Available: ${Object.keys(ROLES).join(', ')}`)
      const task = requireString(args, 'task')
      const contextText = str(args.context).slice(0, 40000)
      let research = ''
      if (args.browse === true) {
        if (settings.get().privacy.localOnly) {
          return fail('browse=true requires internet access, but local-only mode is enabled.')
        }
        try {
          const results = await searchWeb(task, 6)
          research = `\n\nWEB SEARCH RESULTS (external, unverified):\n${results
            .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet ?? ''}`)
            .join('\n\n')}`
        } catch (err) {
          research = `\n\n(Web search failed: ${err instanceof Error ? err.message : String(err)})`
        }
      }
      const provider = providers.get(ctx.providerId)
      if (!provider) return fail(`Provider ${ctx.providerId} is unavailable.`)
      const modelInfo = await providers.modelFor({ providerId: ctx.providerId, modelId: ctx.modelId }).catch(() => null)
      const s = settings.get()
      const messages: ProviderMessage[] = [
        {
          role: 'system',
          content: `${role.prompt}\nYou are a subagent inside LocalPilot AI. The primary agent will read your report. Be concise (max ~700 words), concrete and honest.\n\nUser task:\n${task}${
            contextText ? `\n\nContext supplied by the primary agent:\n${contextText}` : ''
          }${research}`
        },
        { role: 'user', content: 'Produce your report now.' }
      ]
      try {
        const result = await providers.chat(ctx.providerId, {
          model: ctx.modelId,
          modelInfo: modelInfo ?? undefined,
          messages,
          temperature: 0.3,
          topP: 0.9,
          maxTokens: 1600,
          contextLength: Math.min(s.models.contextLength, 32768),
          reasoningEffort: s.agent.reasoningEffort,
          stream: false,
          signal: ctx.signal
        })
        return ok(
          `${role.title} report (${ctx.modelId}):\n\n${result.text || '(the subagent returned no text)'}`,
          { role, usage: result.usage }
        )
      } catch (err) {
        return fail(`Subagent failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  },
  {
    name: 'agents.roles',
    description: 'List available subagent roles and what each is for.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'agents',
    group: 'agents',
    source: 'builtin',
    enabled: () => settings.get().agent.allowSubagents,
    handler: async () =>
      ok(
        Object.entries(ROLES)
          .map(([key, role]) => `${key} — ${role.title}: ${role.prompt.split('.')[0]}.`)
          .join('\n')
      )
  }
]
