/**
 * Sandboxed-ish plugin host.
 *
 * Runs a native LocalPilot plugin inside its own child process. The plugin gets only
 * the arguments and a minimal context object — no Electron APIs and no direct IPC to
 * the renderer. Communication is JSON messages over the child-process IPC channel.
 */
import path from 'node:path'

interface PluginTool {
  description?: string
  handler?: (args: Record<string, unknown>, ctx: PluginContext) => unknown
  execute?: (args: Record<string, unknown>, ctx: PluginContext) => unknown
}

interface PluginContext {
  projectPath: string | null
  log: (message: string) => void
}

interface HostMessage {
  type: 'call'
  id: string
  tool: string
  args: Record<string, unknown>
  projectPath: string | null
}

const pluginDirEnv = process.env.LOCALPILOT_PLUGIN_DIR
if (!pluginDirEnv) {
  console.error('LOCALPILOT_PLUGIN_DIR is not set')
  process.exit(1)
}
const pluginDir: string = pluginDirEnv

function send(message: unknown) {
  if (process.send) process.send(message)
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(pluginDir, 'index.js'))
  const plugin = mod?.default ?? mod
  const tools: Record<string, PluginTool> = plugin?.tools ?? {}
  send({
    type: 'ready',
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description ?? '',
      hasHandler: typeof tool.handler === 'function' || typeof tool.execute === 'function'
    }))
  })

  process.on('message', async (message: HostMessage) => {
    if (!message || message.type !== 'call') return
    const tool = tools[message.tool]
    const handler = tool?.handler ?? tool?.execute
    if (!handler) {
      send({ type: 'result', id: message.id, ok: false, error: `Plugin tool "${message.tool}" is not implemented.` })
      return
    }
    try {
      const ctx: PluginContext = {
        projectPath: message.projectPath,
        log: (text: string) => send({ type: 'log', message: String(text).slice(0, 4000) })
      }
      const result = await handler(message.args ?? {}, ctx)
      if (result && typeof result === 'object' && 'content' in result) {
        const obj = result as { content?: unknown; data?: unknown; images?: unknown }
        send({
          type: 'result',
          id: message.id,
          ok: true,
          content: String(obj.content ?? ''),
          data: obj.data,
          images: Array.isArray(obj.images) ? obj.images.slice(0, 3) : undefined
        })
      } else if (typeof result === 'string') {
        send({ type: 'result', id: message.id, ok: true, content: result })
      } else {
        send({ type: 'result', id: message.id, ok: true, content: JSON.stringify(result, null, 2) })
      }
    } catch (err) {
      send({
        type: 'result',
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  process.on('uncaughtException', (err) => {
    send({ type: 'fatal', error: err.message })
    process.exit(1)
  })
}

void main().catch((err) => {
  send({ type: 'fatal', error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
