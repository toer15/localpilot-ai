# AGENTS.md — working on LocalPilot AI

This file is for coding agents and contributors. It documents commands, architecture, conventions and verification rules that are not obvious from the code.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Electron + Vite development with renderer hot reload. |
| `npm run typecheck` | TypeScript for main/preload (`tsconfig.node.json`) and renderer (`tsconfig.web.json`). |
| `npm run build` | Production bundles into `out/` (main, preload, renderer). |
| `npm run dist` | Build and package NSIS installer + portable x64 into `release/`. |
| `npm run dist:dir` | Unpacked packaged app only (`release/win-unpacked`), faster for smoke checks. |
| `npm run release:github` | Build and publish NSIS/portable + `latest.yml` to GitHub Releases; requires `GH_TOKEN`. Prefer pushing a `v*` tag to run the workflow. |
| `npm run selftest` | Build, then run Electron with `--self-test` (12 checks, exits non-zero on failure). |
| `npm run smoke` | Build, then launch the real Electron UI via Playwright and verify a local chat. |
| `SMOKE_TOOLS=1 npm run smoke` | Also exercise the agent writing/reading a project file (approves prompts). |
| `SMOKE_PERSIST=1 npm run smoke` | Restart the app and verify settings/conversations persisted. |
| `npm run acceptance` | Browser automation, stop, MCP install/tool discovery/removal, plugin revocation. |
| `npm run acceptance:localonly` | Remote endpoint and internet-tool blocking in local-only mode. |
| `npm run acceptance:notepad` | Real Notepad launch/typing/screenshot, then closes the test instance. |
| `npm run acceptance:overlay` | Install the optional AI tester pack, verify the independent AI cursor/border overlay, a real Esc stop, and uninstall revocation. Use `OVERLAY_SCALE=1.25` for a forced-DPI run. |
| `npm run acceptance:fullscreen` | Launch Rocket League full-screen, verify the overlay is above it without focus theft, press real Esc, and confirm the game survives. |
| `npm run smoke:packaged` | Launch `release/win-unpacked/LocalPilot AI.exe` and verify packaged startup and overlay preload. |
| `npm run update:check` | Open Settings → About in the packaged app and verify the live GitHub update check reports the installed version up to date. Run after `npm run dist` and a published release. |

The acceptance scripts need Ollama running with at least one chat model, plus Edge/Chrome for browser tests. They create conversations in the real app database and PNGs in `artifacts/`.

## Architecture map

- `src/main/index.ts` — app lifecycle, window, single-instance lock, shutdown, `--self-test`.
- `src/main/updater.ts` — `electron-updater` service: startup/four-hour checks, auto-download, status broadcasts, and explicit install coordinated with `shutdown()`.
- `src/main/ipc.ts` — every privileged IPC handler. Renderer access must go through here.
- `src/preload/index.ts` — `contextBridge` API; mirrored by `src/shared/api.ts`. Keep all three in sync.
- `src/preload/overlay.ts` + `src/main/computer/overlay.ts` — isolated bridge and one overlay window per display for the optional AI tester overlay, including DPI bounds, z-order and Esc handling.
- `src/main/agent/agent.ts` — agent loop, tool execution, approvals, context budget, screenshots, cancellation.
- `src/main/agent/prompt.ts` — system prompt and capability statements.
- `src/main/providers/` — `ollama.ts` (native NDJSON), `openai.ts` (SSE), `llama.ts` (managed server), `manager.ts` (discovery and the local-only guard).
- `src/main/tools/` — tool definitions; `registry.ts` filters by group and `enabled()`.
- `src/main/computer/` — PowerShell/C# desktop engine; scripts run from a temp `.ps1` file, not `-EncodedCommand`.
- `src/main/plugins/` — `builtins.ts` packs, `mcp.ts` official SDK connections, `native.ts` forked host, `manager.ts` install/enable lifecycle.
- `src/main/db.ts` — sql.js (WASM) SQLite with debounced atomic saves.
- `src/shared/` — types, default settings/profiles, API surface.
- `src/renderer/` — React pages and components; no Node APIs.

## Conventions and invariants

- **Local-first.** No silent cloud fallback. A remote endpoint is used only when configured and selected. Local-only mode must block every non-loopback provider in discovery, `startProvider` and `chat`, and internet tools must disappear from the registry.
- **Renderer security.** `contextIsolation: true`, `nodeIntegration: false`, no remote module. Add privileged operations as typed IPC handlers, never by exposing `ipcRenderer` or Node.
- **Approvals.** High-risk tools always ask, even with session approvals. Tools must declare realistic `risk`, `sessionKey` and `preview`. Do not bypass `ensurePermission`.
- **Project scope.** Filesystem tools must use `resolveProjectPath`; do not accept absolute or `..` paths that escape the active project.
- **Secrets.** API keys go through `safeStorage` (Windows DPAPI). Never log, echo into chat, store in settings plaintext, or commit them. `settings` and conversations are plain SQLite.
- **Tool results.** Cap large outputs before sending them back to the model. One screenshot per iteration; tool result text is capped in the agent.
- **Context.** Default context is 32k (legacy 8k settings are migrated). `fitMessagesToContext` reserves output and tool schema space. Do not assume a model's full advertised context is usable.
- **Plugin tooling.** Built-in pack IDs and groups are stable; disabling a pack must remove its tools. Native plugin examples are CommonJS `module.exports`.
- **No new dependencies without need.** Match the existing stack (Electron, React, TS, sql.js, Playwright, MCP SDK). Avoid native modules that complicate packaging.
- **Packaging.** sql.js WASM and `out/main/pluginHost.js` are `asarUnpack`ed. If you add a runtime file read by path, add it to `electron-builder.yml`.
- **UI.** Dark is the default; light mode must keep contrast. Reuse `src/renderer/src/components/ui.tsx` and existing CSS classes rather than adding a new design system.

## Verification rules

1. After editing TypeScript, run `npm run typecheck` and `npm run build`.
2. After changing agent, provider, tools, permissions or packaging, run the relevant real check:
   - provider/model changes: `npx electron out/main/index.js --self-test`
   - agent/UI changes: `npm run smoke` (and `SMOKE_PERSIST=1`)
   - computer-use changes: `npm run acceptance:notepad`
   - tester overlay or optional pack changes: `npm run acceptance:overlay`; for full-screen/z-order changes also `npm run acceptance:fullscreen`
   - local-only/privacy changes: `npm run acceptance:localonly`
   - plugin/MCP changes: `npm run acceptance`
   - packaging changes: `npm run dist` then `npm run smoke:packaged`
3. Do not report a check as passing unless you ran it. Report skipped checks, model/runtime dependencies and side effects honestly.
4. Update `DEVELOPMENT_STATUS.md`, `docs/TESTING.md` and `docs/RELEASING.md` when behavior or evidence changes.
5. For update changes, build and run the packaged app, verify `Settings → About → Check for updates` against the real GitHub release, and never claim an update prompt was exercised without a newer published version.

## Gotchas

- PowerShell inline C# scripts exceed the 32k command-line limit; `runComputer` uses `runPowerShellFile`. Do not switch it back.
- Electron single-instance lock is per user data directory. Run acceptance scripts sequentially, not in parallel.
- The app writes real data to `%APPDATA%\LocalPilot AI`. Tests intentionally leave conversations and screenshots.
- `npm run dist` is unsigned. SmartScreen warnings are expected; do not describe the build as signed.
- There is no git repository initialised in this workspace. Do not assume history or run destructive git commands.
- The native plugin host is a child process with only IPC, **not** an OS sandbox. Permissions in manifests are declarative, not enforced.
- Third-party MCP presets run real `npx`/`uvx` servers with the user's privileges; local-only mode cannot contain them.
- The AI tester overlay is one always-on-top, click-through window per display with `setContentProtection(true)`; it registers the global `Escape` shortcut only while active. Its green cursor is AI-owned: never poll `screen.getCursorScreenPoint()` or follow the user's pointer; position it only from AI mouse/UIA targets. Keep its preload at `out/preload/overlay.js` and do not add Node access to it.
- Windows initially clamps a frameless overlay window to the work area. Re-apply `display.bounds` after showing it, or the taskbar is left outside the takeover border.
- Full-screen games are often topmost. The overlay re-raises itself with `moveTop()` every 800ms while active; do not replace this with focus-stealing activation.
- The tester pack is optional: `ensureBuiltinPlugins()` must not recreate it after uninstall, and `builtinEnabled('app-tester')` is false without a row. `acceptance:fullscreen` launches and closes only the Rocket League process it started.
