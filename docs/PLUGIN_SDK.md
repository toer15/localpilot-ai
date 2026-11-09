# Plugin SDK and MCP

LocalPilot has three extension types:

1. **Built-in packs** — capability bundles shipped with the app; they can be enabled or disabled. The AI tester is an optional pack that must be installed from the marketplace.
2. **MCP servers** — external processes or HTTP endpoints using the Model Context Protocol.
3. **Native plugins** — a folder with `plugin.json` and a CommonJS module executed in a forked host process.

All plugins are local unless their code makes network requests. Signed marketplace hosting does not exist; install from sources you trust.

## Built-in packs

| Pack | Tool groups | Effect when disabled |
| --- | --- | --- |
| AI App & Game Tester (optional) | `testing` | Uninstalling removes `testing.start/stop/status`; disabling hides the overlay and removes the tools. |
| Computer Use | `computer`, `windows`, `uia` | All screenshot, input, window and UIA tools are removed. |
| Terminal & PowerShell | `terminal` | Terminal process tools are removed. |
| File System & Projects | `files`, `projects` | Project file tools are removed. |
| Browser Automation | `browser`, `web` | Browser and web tools are removed. |
| Git & Development | `git` | Git tools are removed. |
| Local Memory | `memory` | Memory tools are removed. |
| Agent Roles | `agents` | Subagent delegation is removed. |
| System Diagnostics | `system` | System/diagnostic tools are removed. |

Disabling a pack immediately removes its tools from the model's list. Re-enabling restores them. This was verified with Computer Use (57 → 43 → 57 tools).

## AI App & Game Tester overlay

The **AI App & Game Tester** pack is optional and appears in **Plugin marketplace → Explore** under **Testing**. Install it to add three tools and a testing overlay:

| Tool | Purpose |
| --- | --- |
| `testing.start` | Show the takeover overlay before testing a game or app. Accepts an optional label. |
| `testing.stop` | Hide the overlay and return control. |
| `testing.status` | Report whether the overlay is active and which key stops it. |

When active, LocalPilot creates one always-on-top, click-through Electron window per display, with DPI-correct bounds and a primary-only banner:

- A 3px green border around each display and an “AI has taken over this screen” banner on the primary display. Windows initially clamps a frameless window to the work area, so LocalPilot re-applies the full display bounds after showing each overlay.
- An independent green AI cursor on the display containing the AI's current target; it is cleared from the other displays and pulses on mouse, keyboard and UI Automation actions. It is positioned only by AI actions and does not follow the user's physical mouse. For UI Automation Invoke/Select/Toggle, which do not move the real pointer, the overlay still shows the matched element's center.
- The overlay re-raises itself above topmost full-screen games every 800ms without activating or taking focus. Rocket League at 2560×1440 was verified with the overlay above it in the native z-order.
- “Press **Esc** to stop testing” on screen. `Escape` is registered globally only while the overlay is active. Pressing it hides the overlay and triggers the emergency stop (cancels the agent run, clears approvals, kills terminal sessions and closes the automation browser). The configured emergency shortcut remains a fallback if Escape cannot be registered.
- The window ignores mouse input, does not take focus, is skipped in the taskbar, and requests Windows capture exclusion so it does not normally obscure screenshots taken by the agent.

The pack is a built-in capability bundle, not third-party code. Installing it from the marketplace is a local database operation; uninstalling removes its rows and tools. The plugin details dialog has **Preview overlay** and **Stop overlay** buttons for trying it without asking the model. `npm run acceptance:overlay` verifies installation, the DOM/border/cursor, cursor independence from the real pointer, AI-driven positioning, a real Esc stop, and uninstall revocation; set `OVERLAY_SCALE=1.25` or `1.5` for a forced-DPI run. `npm run acceptance:fullscreen` launches the installed Rocket League, verifies the overlay is above the topmost full-screen game without focus theft, and checks that Esc stops the overlay while the game survives. The test machine had one display, so actual multi-monitor movement remains unverified; the per-display architecture and forced-DPI math were exercised.

The overlay is a visual indication, not a security boundary. It cannot prevent a game from receiving input or constrain a native plugin.

## MCP servers

LocalPilot uses the official `@modelcontextprotocol/sdk`. Supported transports:

- **stdio** — `{ name, transport: "stdio", command, args, env, enabled, autoStart }`
- **HTTP** — `{ name, transport: "http", url, enabled, autoStart }`

Configure under **Plugins**. Start, test and stop a server; discovered tools are registered as `mcp__<pluginId>__<toolName>` and removed on stop/uninstall. A **Test** returns `{ ok, tools, error? }`.

Published presets:

| Preset | Launcher | Requirements |
| --- | --- | --- |
| Roblox Studio MCP | `npx -y robloxstudio-mcp@latest` | Roblox Studio, companion Studio plugin, HTTP requests enabled. Third-party. |
| Playwright MCP | `npx -y @playwright/mcp@latest` | Node/npx and a browser. |
| Knowledge Graph Memory | `npx -y @modelcontextprotocol/server-memory` | Node/npx. Local file storage. |
| GitHub MCP | `npx -y @modelcontextprotocol/server-github` | `GITHUB_PERSONAL_ACCESS_TOKEN` in the server environment. |
| Filesystem MCP | `npx -y @modelcontextprotocol/server-filesystem` | Add allowed directories to arguments after install. |
| Git MCP | `uvx mcp-server-git` | Python `uv`/`uvx`. |

You can add any stdio or HTTP MCP server manually. Tokens belong in the server environment, not in chat, the manifest or source control. MCP servers are not audited by LocalPilot and run with your user privileges; local-only mode cannot restrict their own network access.

A minimal local stdio test server is included at `examples/mcp-echo-server.mjs` (tool `echo`). The acceptance test installs it with `node <path>`, starts it, verifies the tool, then removes it.

## Native plugin SDK

### Folder layout

```
my-plugin/
  plugin.json
  index.js
```

Install via **Plugins → Install from folder**. The app copies the folder to `%APPDATA%\LocalPilot AI\plugins\<id>` and starts a plugin host child process. The entry defaults to `index.js`.

### Manifest

```json
{
  "id": "localpilot-hello-plugin",
  "name": "LocalPilot Hello Plugin",
  "version": "1.0.0",
  "description": "Example native plugin.",
  "author": "You",
  "category": "Example",
  "icon": "sparkles",
  "os": ["win32"],
  "permissions": ["project.read"],
  "tools": [
    {
      "name": "hello",
      "description": "Return a greeting and the active project folder.",
      "parameters": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "risk": "low"
    }
  ]
}
```

Required: `id`, `name`, `version`, and at least one tool with `name`, `description` and a JSON Schema `parameters` object. `risk` should be `low`, `medium` or `high`; high-risk tools will require explicit approval outside the plugin. `permissions` are declarative strings shown in the marketplace — they are not enforced by an OS sandbox.

### Module contract (CommonJS)

```js
module.exports = {
  tools: {
    hello: {
      handler(args, ctx) {
        ctx.log(`hello called for ${args.name}`)
        return {
          content: `Hello, ${args.name}.`,
          data: { projectPath: ctx.projectPath }
        }
      }
    }
  }
}
```

- The handler receives parsed tool arguments and `ctx`.
- `ctx.projectPath` is the active project root or `null`.
- `ctx.log(message)` writes to the plugin host log.
- Return a string or `{ content, data?, images? }`. `content` is sent to the model; `data` is structured metadata; `images` is reserved for data URLs and only forwarded to vision models.
- Throw on failure; the tool result becomes an error. Do not hang indefinitely.
- The host has no Electron APIs and no renderer access. Only tool arguments and the minimal context cross the IPC boundary.

A complete example is in [`examples/hello-plugin`](../examples/hello-plugin). The host is a forked Electron child process: it isolates crashes and the main process object, but it is **not** an OS security sandbox. Plugin code can use Node.js APIs and the filesystem with your privileges. Review source before installing.

### Lifecycle and storage

Install → enable → tool registration; disable/uninstall removes tools. Plugin files persist under the app's `plugins` directory. The manifest and tool schemas are shown in the UI; there is no signing, review or automatic update.

## Tool result and approval behavior

Built-in and plugin tools declare risk and may provide a preview. Sensitive built-ins go through the permission broker: high-risk actions always prompt, session approvals cover non-high actions, and no UI means deny. Native and MCP tools execute in their own process; LocalPilot does not intercept their internal file or network operations. Keep destructive behavior behind explicit tool names and descriptions so the user understands what will happen.

## Testing your plugin

1. Keep `plugin.json` and the entry module together.
2. Install the folder, enable it, and ask the agent to call the tool.
3. If it fails, inspect `logs/main.log` and reinstall after changes.
4. For MCP, use the Plugins page **Test** action or `examples/mcp-echo-server.mjs`.

The native plugin example was added as SDK documentation; the packaged host is exercised by the build but the example was not installed through the UI in the recorded acceptance run. MCP installation/discovery/removal was tested with a real local stdio server.
