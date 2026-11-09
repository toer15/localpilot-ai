# Configuration

Open **Settings** from the bottom of the sidebar. Settings are stored locally in SQLite and applied to new runs immediately unless noted.

## General

Theme (dark default/light), density, reasoning-trace display, start minimized, notifications, language and the setup wizard. Hiding reasoning traces does not disable a model's internal reasoning; it only hides reported thinking output.

## Models and endpoints

Default endpoints:

| Provider | Type | Default URL | Notes |
| --- | --- | --- | --- |
| Ollama | native | `http://127.0.0.1:11434` | Auto-discovers installed models, native tools, vision, thinking. |
| LM Studio | OpenAI-compatible | `http://127.0.0.1:1234` | Start LM Studio's local server first. |
| llama.cpp server | OpenAI-compatible | `http://127.0.0.1:8080` | LocalPilot can install and manage its own engine from the Model library; an external `llama-server.exe` can still be configured. |

You can add custom OpenAI-compatible or Ollama endpoints. The default provider/model for new conversations is selectable here; the chat toolbar can override it per conversation.

**Remote endpoints** are marked “remote / cloud” and are never made the default silently. Requests to them leave the computer. If you paste an API key for an OpenAI-compatible provider, it is encrypted with Electron `safeStorage`, which uses Windows DPAPI for your Windows user. Keys are not written to conversations or logs.

**Model runtime** settings apply to requests and managed llama.cpp launches: temperature, top-p, max output tokens, context length (default 32768), GPU layers (`-1` means all), llama.cpp port, models folder, `llama-server.exe` path, auto-start and streaming. Leave the path empty to use the engine installed by LocalPilot.

The **Model library** has a **Local engine** card that installs the official llama.cpp Windows Vulkan or CPU build on demand. No Ollama installation or running background app is required for downloaded GGUF files. The recommended GGUF catalog has green **Download** buttons; choosing a file opens the available quantizations. **Load & use** starts the managed engine and selects the model. Downloads, engine installs and Ollama pulls show progress and can be cancelled. The library also discovers installed models, searches Hugging Face, imports local GGUF files, and can pull from the Ollama library when Ollama is available.

The context setting is a ceiling, not a guarantee. The agent fits system prompt, tool schemas, output budget and history into the configured/model context. Legacy 8k settings are migrated to 32k automatically.

## Agent behavior

- **Maximum iterations** — default 25; profile-specific values go up to 60.
- **Maximum tool calls**, run timeout (default 180 s), default reasoning effort and tool protocol.
- **Tool protocol** — `auto` uses native function calling only when the model reports tool support from the provider; otherwise the text protocol. `native` forces native calls; `text` forces the text protocol.
- **Subagents** — allowed by default and inherit project scope and approvals.
- **Profiles** — General, Coding, Deep reasoning, Computer control and Game development. Profiles set temperature, context, reasoning, iterations, allowed tool groups and a system-prompt suffix. **Full PC access** (default on) overrides profile tool-group limits; turn it off if you want a profile's tool groups to be restrictive.
- **Queued follow-ups** — while a run is active, the composer stays available. Sending adds the message to a queue above the composer instead of interrupting the run. It starts automatically when the current task ends. Use the small × on a queued row to remove it. The queue is per conversation; **Stop** interrupts the current run and the next queued message starts afterward.

## Computer Use

Computer Use is enabled by default but sensitive actions require approval.

- **Full PC access** is on by default. It exposes every enabled tool group and lets file tools read, write, search, move and delete using absolute paths anywhere on this PC, whether or not a project is open. Profile tool-group limits are bypassed. High-risk actions still prompt, and delete refuses drive roots, Windows, Program Files, ProgramData and the user-profile root. Turn it off to restore project-scoped file tools and profile-restricted tool groups.
- Disable Computer Use to revoke all screenshot, mouse, keyboard, window and UIA tools.
- Screenshots, mouse/keyboard and window control can be disabled independently.
- **Approval policy**: `ask` prompts for sensitive actions; `session` allows approving a tool session; `auto-safe` automatically approves low-risk reads only. **High-risk actions always prompt**, even with a session approval.
- **Application allowlist** (default `notepad.exe`, `explorer.exe`, `mspaint.exe`) lowers friction for known apps; it is not a security boundary.
- **Emergency stop shortcut** defaults to `Ctrl+Alt+Shift+X`. It stops agent runs, denies pending approvals, kills running terminal sessions, closes the automation browser and broadcasts an emergency-stop event. Settings changes re-register the shortcut; an invalid or already-used shortcut is logged and ignored.
- Screenshots are taken when the `screen.screenshot` tool is called, not continuously. The *automatic screenshots* preference is stored for future use; current agent iterations use explicit screenshot tool calls.

## Memory

Global memory entries are stored in SQLite and injected into agent context across projects. Add, edit or delete them under **Settings → Memory**. Project memory is managed from Projects. Do not store passwords or API keys; best-effort secret redaction is a safeguard, not a vault.

## Plugins

- **AI App & Game Tester** — install this optional pack from **Plugin marketplace → Explore → Testing**. It adds `testing.start/stop/status`, one DPI-correct overlay per display, an independent green AI cursor that moves only when the AI acts, a full-screen takeover border and an on-screen **Press Esc to stop testing** prompt. The AI cursor does not follow your physical mouse. It re-raises above topmost full-screen games without taking focus; Rocket League full-screen was verified. Pressing Esc cancels the active run and hides the overlay. The plugin details dialog can preview and stop the overlay without involving the model.
- **Plugin automatic update checks** are off by default; plugin updates are never installed without action.
- **Allow network-capable plugins** is off by default. It is a policy flag for declaring network-capable plugins; permissions are declarative, not an OS sandbox.
- Native plugins run in a forked child process; read [PLUGIN_SDK.md](PLUGIN_SDK.md) before installing untrusted code.

## Privacy and security

- **Local-only mode** — blocks non-loopback AI endpoints during provider discovery, startup and chat, and removes web/browser tools from the agent. Loopback means `localhost`, `127.0.0.1`, `::1` or `0.0.0.0`; a LAN inference server counts as non-local. It does not contain code inside an enabled MCP server or native plugin.
- **Store conversations** — when off, new messages are not persisted.
- **Log tool commands** — records command summaries in Activity. Output can contain sensitive data.
- **Redact secrets in memory** — best-effort filtering before memory reaches the model.
- **Delete local data** — delete all conversations or clear the activity log. These cannot be undone. Projects and files are untouched.
- Credentials use DPAPI-encrypted `safeStorage`. There is no cloud account and no telemetry.

## Software updates

Installed NSIS builds use `electron-updater` with the public GitHub Releases feed at `https://github.com/toer15/localpilot-ai/releases`. Checks run shortly after startup and every four hours. Downloads happen in the background; when one finishes, LocalPilot installs it silently and restarts on its own, with no installer wizard. If an agent run is still active, the install waits for it to finish first. **Settings → About → Check for updates** performs a manual check and shows the current version, download progress and any release notes; **Restart now** installs immediately. The portable executable and development runs do not use the updater.

The update check requests release metadata from GitHub. It does not send conversations, prompts, project files, API keys or settings. The repository is public by design so the app does not need a bundled GitHub token.

## Advanced

Log level, request timeout (default 240000 ms), custom system prompt appended after LocalPilot's safety/tool instructions (it cannot override permissions), diagnostics, data/log folder shortcuts, hardware refresh and settings reset. `LOCALPILOT_DEVTOOLS=1` opens detached DevTools when running the built app from source.

## Files and ports

- Data: `%APPDATA%\LocalPilot AI` (`data\localpilot.db`, `logs\main.log`, `models\`, `runtime\llama.cpp\`, `captures\`, `plugins\`, `browser\`).
- Ollama `11434`, LM Studio `1234`, llama.cpp `8080` by default. Change llama.cpp's port in Settings if it conflicts.
- MCP stdio servers are child processes; MCP HTTP servers use their configured URL. GitHub MCP needs `GITHUB_PERSONAL_ACCESS_TOKEN` in its server environment; never paste it into chat.
