import { toolRegistry } from './registry'
import { filesTools } from './files'
import { projectTools } from './projects'
import { terminalTools } from './terminal'
import { gitTools } from './git'
import { webTools } from './web'
import { browserTools } from './browser'
import { computerTools } from './computer'
import { memoryTools } from './memory'
import { systemTools } from './system'
import { agentTools } from './agents'
import { testerTools } from './tester'
import { infiniteTools } from './infinite'
import type { ToolDefinition } from './types'

let registered = false

export function registerBuiltinTools() {
  if (registered) return
  registered = true
  const tools: ToolDefinition[] = [
    ...filesTools,
    ...projectTools,
    ...terminalTools,
    ...gitTools,
    ...webTools,
    ...browserTools,
    ...computerTools,
    ...memoryTools,
    ...systemTools,
    ...agentTools,
    ...testerTools,
    ...infiniteTools
  ]
  toolRegistry.register(tools)
}

export { toolRegistry }
export type { ToolDefinition, ToolContext, ToolExecutionResult } from './types'
