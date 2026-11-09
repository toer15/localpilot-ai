/**
 * Native LocalPilot plugin example (CommonJS).
 *
 * The plugin runs in a dedicated child process. It receives no Electron APIs and
 * no renderer access — only tool arguments plus a minimal context object.
 */
module.exports = {
  tools: {
    hello: {
      handler(args, ctx) {
        const name = String(args.name || 'there')
        const project = ctx.projectPath ? ` Active project: ${ctx.projectPath}.` : ' No project is active.'
        ctx.log(`hello plugin called for ${name}`)
        return {
          content: `Hello, ${name}.${project}`,
          data: { name, projectPath: ctx.projectPath }
        }
      }
    }
  }
}
