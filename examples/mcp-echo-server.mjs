/**
 * Minimal real MCP server used by LocalPilot's acceptance test and as an SDK example.
 * It speaks the official Model Context Protocol over stdio and needs no network.
 *
 * Register it in LocalPilot → Plugin marketplace → Add MCP server:
 *   transport: stdio
 *   command:   node
 *   arguments: <absolute path to this file>
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'localpilot-echo', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the text passed in the text argument, prefixed with ECHO:',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo.' }
        },
        required: ['text']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
  }
  const text = String(request.params.arguments?.text ?? '')
  return { content: [{ type: 'text', text: `ECHO: ${text}` }] }
})

await server.connect(new StdioServerTransport())
