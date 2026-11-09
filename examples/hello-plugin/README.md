# LocalPilot Hello Plugin

A minimal native plugin that adds a `hello` tool to the agent.

## Install

1. Keep `plugin.json` and `index.js` in the same folder (rename the folder if you like).
2. Open **Plugin marketplace → Install from folder** and select this folder.
3. Enable the plugin, then ask the agent to "say hello to Ada".

LocalPilot copies the folder into `%APPDATA%\LocalPilot AI\plugins\<id>` and starts a plugin host child process.

## Shape

```js
module.exports = {
  tools: {
    toolName: {
      handler(args, ctx) {
        // return { content, data?, images? } or a string
      }
    }
  }
}
```

`ctx.projectPath` is the active project root or `null`. `ctx.log(message)` writes to the plugin host log.

## Manifest

`plugin.json` requires `id`, `name`, `version`, and at least one tool with `name`,
`description`, and a JSON Schema `parameters` object. Permissions are declarative
and shown in the marketplace; they are not an OS sandbox. Install only plugins
whose source you trust.
