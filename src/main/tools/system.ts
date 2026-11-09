import { app } from 'electron'
import { appVersion } from '../core/paths'
import type { ToolDefinition } from './types'
import { ok } from './types'
import { detectHardware } from '../hardware'
import { providers } from '../providers/manager'
import { getPaths } from '../core/paths'
import { databaseSize } from '../db'
import { log } from '../core/logger'
import { formatBytes } from './fsutil'

export const systemTools: ToolDefinition[] = [
  {
    name: 'system.info',
    description: 'Show LocalPilot version, data locations, active model provider status and SQLite database size.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'system',
    group: 'system',
    source: 'builtin',
    handler: async () => {
      const paths = getPaths()
      const statuses = await providers.getStatuses().catch(() => [])
      return ok(
        [
          `LocalPilot AI ${appVersion()} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
          `Platform: ${process.platform} ${process.arch}`,
          `User data: ${paths.userData}`,
          `Models: ${providers.modelsDir()}`,
          `SQLite database: ${formatBytes(databaseSize())}`,
          `Providers:`,
          ...statuses.map(
            (s) =>
              `- ${s.name}: ${s.running ? `running (${s.modelCount ?? 0} models${s.version ? `, v${s.version}` : ''})` : `offline${s.error ? ` — ${s.error}` : ''}`}`
          )
        ].join('\n')
      )
    }
  },
  {
    name: 'system.hardware',
    description: 'Detect CPU, RAM, GPU, VRAM, acceleration backends and recommended local-model settings.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'system',
    group: 'system',
    source: 'builtin',
    handler: async () => {
      const hw = await detectHardware()
      return ok(
        [
          `OS: ${hw.os}`,
          `CPU: ${hw.cpu.model} (${hw.cpu.cores} cores / ${hw.cpu.threads} threads)`,
          `RAM: ${formatBytes(hw.ram.totalBytes)} total, ${formatBytes(hw.ram.availableBytes)} free`,
          `GPUs: ${hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramBytes ? ` (${formatBytes(g.vramBytes)} VRAM)` : ''}`).join('; ') : 'none detected'}`,
          `Acceleration: ${Object.entries(hw.acceleration).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ') || 'CPU only'}`,
          `Recommendation: ${hw.recommendations.summary}`
        ].join('\n'),
        hw
      )
    }
  },
  {
    name: 'system.dependencies',
    description: 'Check installed runtimes and browser engines (Ollama, llama.cpp, LM Studio, Edge) with setup links.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'system',
    group: 'system',
    source: 'builtin',
    handler: async () => {
      const deps = await providers.runtimeDependencies()
      return ok(
        deps
          .map(
            (d) =>
              `${d.installed ? (d.running ? '● running' : '● installed') : '○ missing'} · ${d.name}${d.path ? ` — ${d.path}` : ''}\n   ${d.note}${!d.installed ? `\n   Install: ${d.installUrl}` : ''}`
          )
          .join('\n'),
        deps
      )
    }
  },
  {
    name: 'system.logs',
    description: 'Read the latest LocalPilot application log lines for troubleshooting.',
    parameters: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'Default 100, max 300.' } }
    },
    risk: 'low',
    category: 'system',
    group: 'system',
    source: 'builtin',
    handler: async (args) => {
      const count = Math.min(Math.max(Number(args.lines) || 100, 1), 300)
      const lines = log.recent(count)
      return ok(lines.length ? lines.join('\n') : 'The log buffer is empty.')
    }
  }
]
