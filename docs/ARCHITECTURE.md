# Architecture

LocalPilot AI is an Electron application with a strict main/renderer split. The renderer has no Node access; every privileged operation is a typed IPC call handled in the main process.

## Process model

```
Renderer (React, context-isolated)
  window.localpilot  ← contextBridge preload
        │ typed IPC
Main process (Node/Electron)
  ├─ SQLite (sql.js WASM)
  ├─ Agent runner ── providers (Ollama / OpenAI-compatible / llama.cpp)
  ├─ Tool registry ── built-ins, MCP tools, native plugin tools
  ├─ Computer engine (PowerShell + inline C# P/Invoke + UI Automation)
  ├─ AI test overlay (one always-on-top, click-through BrowserWindow per display + isolated preload)
  ├─ Browser (Playwright Core → installed Edge/Chrome)
  ├─ MCP clients (official SDK, stdio/HTTP)
  └─ Native plugin host (forked child process)
```

`contextIsolation: true`, `nodeIntegration: false`; the preload exposes a narrow API defined in `src/shared/api.ts`. Window navigation and new-window requests are denied and opened externally only for http(s). Renderer web permissions are denied except sanitized clipboard writes.

## Main modules

- `index.ts` — lifecycle, single-instance lock, window creation, graceful shutdown (DB flush, plugins, browser, llama.cpp, child processes).
- `updater.ts` — `electron-updater` with the public GitHub Releases provider: startup and four-hour checks, background download, status broadcasts, release notes, explicit install, and shutdown coordination for `quitAndInstall`.
- `ipc.ts` — all channels: app, updates, settings, models, chat, tools/permissions, projects, plugins, memory, activity, computer, terminal, browser.
- `db.ts` — sql.js database loaded from `data/localpilot.db`, schema migration, debounced atomic save (`.tmp` + rename).
- `settings.ts` — deep-merged settings store with default migration (legacy 8k context → 32k).
- `agent/` — loop, prompts, context fitting, run state, cancellation.
- `providers/` — capability discovery and chat transports; `llama.ts` manages a child `llama-server`.
- `models/` — Hugging Face GGUF search/download, Ollama pulls, local model registry, and the managed llama.cpp runtime installer. The runtime downloader resolves the latest official Windows release, selects Vulkan or CPU from hardware detection, streams the archive with progress/cancellation, extracts it, and places `llama-server.exe` plus its DLLs under `runtime/llama.cpp`.
- `tools/` — tool definitions and registry; `permissions.ts` implements approvals.
- `computer/` — desktop automation; `script.ts` contains the C# engine, `index.ts` maps actions.
- `computer/overlay.ts` — optional tester overlay: one window per display with DPI-correct bounds, primary-only banner, AI-owned green cursor positioned from mouse/UIA targets, target pulses, `moveTop()` z-order reassertion, global Esc registration and capture exclusion. It never polls the user's pointer. `src/preload/overlay.ts` is its isolated bridge.
- `plugins/` — built-in packs, MCP manager, native plugin host/manager, catalog.
- `browser.ts` — Playwright lifecycle and page automation.
- `conversations.ts`, `projects.ts`, `memory.ts`, `activity.ts`, `secrets.ts` — persistence features.
- `selftest.ts` — 12 diagnostic checks used by the UI and CLI.

## Agent loop

1. Resolve the profile and settings; load the conversation.
2. Discover model metadata and capabilities. Emit warnings for unknown models, non-vision attachments and non-thinking reasoning modes.
3. Build the system prompt (role, OS, model, capabilities, project instructions, memory, tool instructions).
4. Build history, then fit it to the context budget: reserve room for output and tool schemas, trim old messages, cap tool-result text.
5. Choose native tools only when the provider reports tool support (unless the protocol is forced).
6. Call the provider with streaming. Emit deltas and reasoning deltas.
7. Parse native tool calls or the text tool protocol. For each call: check enabled state, ask the permission broker, execute, cap the result, attach at most one screenshot for vision models.
8. Repeat until a final answer, iteration/tool/time limit, error, or user stop. Persist messages and tool metadata; emit `run_end`.
9. On stop, abort the provider request and kill child processes. The emergency stop additionally clears pending approvals, kills terminal sessions and closes the browser.

## Tools and permissions

Tools declare `name`, JSON Schema `parameters`, `risk`, `group`, `source`, an optional `enabled()` predicate, an optional `sessionKey()` and a preview. The registry filters by profile group, pack enablement, local-only policy and dynamic conditions (for example Computer Use settings). Native/MCP tools are added by their managers and removed with the plugin.

The permission broker keeps pending requests, session approvals and “always” approvals. High-risk tools always prompt. No window, timeout (10 minutes) or send failure resolves to deny. Every decision is recorded in Activity.

## Providers and local-only

- **Ollama** uses `/api/tags`, `/api/show`, `/api/chat` with NDJSON streaming; sends native tools and images; enables thinking only when requested and supported.
- **OpenAI-compatible** uses `/v1/models` and `/v1/chat/completions` with SSE streaming, tool calls and optional bearer token.
- **llama.cpp** is an OpenAI-compatible provider plus a managed process that can be launched with GPU layers/context and stopped. The Model library downloads and installs the official Windows engine into the app data directory on demand, so users do not need a separate Ollama or llama.cpp installation. The app resolves the release from the public GitHub API, prefers the Vulkan build when hardware detection reports Vulkan, and falls back to the CPU build.

`privacy.localOnly` is enforced in `ProviderManager`: non-loopback endpoints are marked blocked during discovery (no ping/model request), refused by `startProvider`, and rejected in `chat` with an explicit error. Web and browser tools report `enabled: false` and disappear from the registry. Loopback is `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`.

## Windows Computer Use

The engine runs a temporary UTF-8 BOM `.ps1` file (not `-EncodedCommand`, which exceeds Windows' 32k command-line limit) containing inline C# compiled with `Add-Type`. It uses Win32 P/Invoke for screen capture, mouse, keyboard and windows, and UI Automation for element trees, find/click and value setting. Actions return structured JSON. Screenshots are saved under `captures/`; image data is attached only for vision models.

The optional tester overlay is a separate click-through window per `screen` display. Each window re-applies its display bounds after showing (Windows otherwise clamps to the work area), receives AI cursor coordinates relative to that display, and is re-raised above topmost full-screen windows every 800ms without focus. The cursor position is stored in the overlay as AI-owned state and updated by Computer Use after mouse and UI Automation actions; it is not tied to the physical pointer. Only the primary display shows the banner. The global `Escape` shortcut is registered only while the overlay is active and invokes the emergency stop before hiding it.

## Plugins

- **Built-ins** are rows in the `plugins` table; their groups gate registry entries. The AI App & Game Tester is an optional built-in: it has no row until installed, `builtinEnabled` is false without a row, and uninstall deletes the row so the marketplace can install it again. Its `testing.start` tool opens the overlay; `testing.stop`/Esc close it.
- **MCP** uses the official SDK client. stdio servers are spawned; HTTP servers connect by URL. Tools are namespaced `mcp__<id>__<name>`.
- **Native** plugins are copied into `plugins/<id>` and executed in a forked host (`out/main/pluginHost.js`, unpacked from asar). The host receives the manifest/entry, exposes only tool arguments and `{ projectPath, log }`, and returns serialized results. This isolates crashes but is not an OS sandbox.

## Persistence

SQLite tables: `settings`, `conversations`, `messages`, `projects`, `memories`, `plugins`, `activity`, `local_models`, `secrets`. Messages cascade-delete with conversations. Secrets are encrypted with Electron `safeStorage` before storage. The database is exported and atomically replaced on a debounce; shutdown forces a save. The managed engine, model files and runtime marker live outside SQLite under `runtime/llama.cpp` and `models/`; they can be deleted independently.

## Security boundaries

- **Trusted:** main process, preload bridge, installed app code.
- **Semi-trusted:** model output (never executed directly; only parsed into tool calls that pass the registry and approvals).
- **Untrusted by default:** web content fetched or browsed, MCP servers, native plugins. Tool results are data, not instructions that can raise permissions.
- **User authorization:** high-risk tools require approval; the agent has no way to bypass the broker. The emergency shortcut is global. While the tester overlay is active, `Escape` is additionally registered globally and invokes the emergency stop before hiding the overlay.
- **Local-only:** blocks LocalPilot's own cloud providers and internet tools. It is not a firewall and cannot contain arbitrary plugin/MCP code.

## Packaging and updates

electron-builder creates a per-user NSIS installer and a portable executable for x64. `asar` is enabled; `sql.js` WASM and the native plugin host are unpacked. Renderer, preload and main bundles are built by electron-vite into `out/`. Builds are unsigned. The llama.cpp engine and model weights are not bundled; they are downloaded on demand so the installer stays smaller.

The `publish` configuration points at `toer15/localpilot-ai` on GitHub. Electron-builder writes `app-update.yml` into packaged resources and `latest.yml` next to the NSIS installer; `electron-updater` reads those through the GitHub Releases provider. The workflow in `.github/workflows/release.yml` builds and uploads those assets when a `v*` tag is pushed. Installed NSIS builds can therefore update; portable builds cannot install an NSIS update in place.
