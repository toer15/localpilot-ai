# Testing and acceptance results

All checks below were run on Windows 11 x64 with Ollama 0.40.15, model `qwen3.6:27b`, Electron 45.2.3 and Node 26.13.0. They drive the real Electron app and the real local model; nothing is mocked except the local MCP echo server used to test the MCP SDK path.

## Commands

```powershell
npm run typecheck
npm run build
npx electron out/main/index.js --self-test
npm run smoke
SMOKE_TOOLS=1 node scripts/ui-smoke.mjs
SMOKE_PERSIST=1 node scripts/ui-smoke.mjs
npm run acceptance
npm run acceptance:localonly
npm run acceptance:notepad
npm run acceptance:overlay
npm run acceptance:fullscreen
npm run smoke:packaged
npm run dist
```

`npm run acceptance` builds first. The individual scripts assume `out/` is current unless invoked via their npm script.

## Results (9 November 2026)

### Typecheck and build — PASS

`npm run typecheck` passed for `tsconfig.node.json` and `tsconfig.web.json`. `npm run build` produced main, preload and renderer bundles in `out/`. Two expected Vite warnings note ineffective dynamic imports; they are informational.

### Self-test — PASS (12/12)

`npx electron out/main/index.js --self-test` exited 0:

| Check | Detail |
| --- | --- |
| SQLite | 6,430,720-byte database, 5 conversations, 3 providers |
| Hardware | Ryzen 7 9800X3D, 31.2 GB RAM, RX 9070 XT 15.9 GB, Vulkan guidance |
| Local providers | Ollama running v0.40.15 with 1 model; LM Studio and llama.cpp offline |
| Models | `qwen3.6:27b` (tools, vision) |
| Local inference | Real Ollama round-trip returned `READY` (2 output tokens) |
| Tool registry | 57 tools across 12 groups |
| Project files | Wrote/read a project file; traversal guard blocked escape |
| PowerShell | Marker returned in 163 ms |
| Screenshot | 2560×1440 PNG captured |
| Playwright | Headless Edge read the test page title |
| MCP SDK | Official client loaded |
| Local-only prerequisites | No cloud provider or API key required |

### UI chat and persistence — PASS

`SMOKE_PERSIST=1 node scripts/ui-smoke.mjs` launched the real window, skipped onboarding, discovered the Ollama provider and `qwen3.6:27b`, sent a prompt through the composer, streamed `UI_READY`, verified the stored conversation has `providerId: ollama`, restarted the app and confirmed: dark theme, onboarding complete, default provider `ollama`, default model `qwen3.6:27b`, 3 conversations.

An earlier `SMOKE_TOOLS=1` run approved `files.write` and `files.read`, created `smoke.txt` containing `UI_TOOL_OK`, and then removed the test project. A previous stop-test conversation was still present in the database; this is expected test residue.

### Agent acceptance — PASS

`npm run acceptance` verified:

- Browser: `browser.open`, `browser.snapshot`, `browser.screenshot` against `https://example.com`, including “Example Domain”.
- Stop: pressed Stop during a 120-second PowerShell command; no active runs remained and the tool status reflected cancellation.
- MCP: installed `examples/mcp-echo-server.mjs` as a stdio server, started it, tested it, discovered `mcp__<id>__echo`, then uninstalled it and confirmed removal.
- Plugin revocation: disabling Computer Use removed `screen.screenshot` and reduced tools 57 → 43; re-enabling restored 57.

### Local-only enforcement — PASS

`npm run acceptance:localonly` added a remote OpenAI-compatible endpoint (`https://example.com/v1`), enabled local-only mode, and verified:

- Provider discovery marked it `Blocked by local-only mode` without a successful ping.
- `startProvider` refused it with the same clear error.
- `web.fetch`, `web.search` and `browser.open` were absent from the tool list.
- An agent run ended with reason `error`, message “Blocked by local-only mode … Nothing was sent”, and no active run.

The test removes the endpoint and conversation it creates. A duplicate endpoint left by the first failed run (before the browser-tool guard) was removed manually and verified absent.

### Notepad Computer Use — PASS

`npm run acceptance:notepad` sent a prompt through the UI and approved permission prompts. The agent called `apps.launch`, `windows.focus`, four `input.keyboard` actions and two `screen.screenshot` actions. It was re-run after the independent AI cursor change and still passed. Notepad had restored an existing `config.vdf` buffer; the agent selected all, deleted it and typed the marker. The screenshot at `artifacts/notepad-interaction.png` shows exactly `LOCALPILOT_NOTEPAD_OK` on line 1 (21 characters). The test closed the Notepad instance it opened without saving. This was a real desktop interaction, not a simulation.

### AI App & Game Tester overlay — PASS

`npm run acceptance:overlay` verified the optional marketplace pack:

- The catalog contains **AI App & Game Tester**; installing it enabled the pack and registered `testing.start`, `testing.stop` and `testing.status` (57 → 60 tools when installed).
- The per-display overlay covered the full 2560×1440 display, including the taskbar area; the first implementation stopped at the 1392px work area and was fixed by re-applying display bounds after showing each window.
- The overlay rendered “AI has taken over this screen”, “Press Esc to stop testing”, the text “AI cursor is independent of your mouse”, a green `rgba(34, 197, 94, 0.95)` border and the green AI cursor element.
- Moving the real Windows pointer to 900,500 produced a 0,0 delta in the AI cursor, proving it does not follow the user's pointer.
- A normal AI mouse action, invoked through a test-only IPC guarded by `LOCALPILOT_ACCEPTANCE=1`, placed both the real pointer and the AI cursor exactly at 900,500.
- Moving the real pointer back to its original position left the AI cursor at 900,500, proving the two cursors are independent.
- A real global `Esc` sent through Windows SendKeys stopped the overlay; the IPC status reported `active: false`.
- Uninstalling the pack removed all `testing.*` tools, removed it from the installed list, and left the overlay inactive.

Artifact: `artifacts/ai-test-overlay.png`. The overlay is a real always-on-top, click-through window; the capture shows the green border, banner, footer and cursor on a transparent desktop.

### Tester DPI scaling — PASS (forced app scale)

The same acceptance test was rerun with Electron's `--force-device-scale-factor`:

```powershell
$env:OVERLAY_SCALE="1.25"; node scripts/overlay-acceptance.mjs
$env:OVERLAY_SCALE="1.5"; node scripts/overlay-acceptance.mjs
Remove-Item Env:OVERLAY_SCALE
```

| Requested scale | Overlay dpr | AI target (physical) | AI cursor position (CSS) | User-pointer move | Result |
| --- | --- | --- | --- | --- | --- |
| 1.0 | 1 | 900×500 | 900×500 | 0,0 | Pass |
| 1.25 | 1.25 | 900×500 | 720×400 | 0,0 | Pass |
| 1.5 | 1.5 | 900×500 | 600×333.3 | 0,0 | Pass |

The overlay rendered, kept the AI cursor independent of the real pointer, placed it at the AI mouse target, stopped on Esc and uninstalled cleanly at all scales. This was a forced app scale, not an OS-level per-monitor scale change; the test machine had one 2560×1440 display at 100%. Actual multi-monitor movement and Windows per-monitor scaling remain unverified.

Artifacts: `ai-test-overlay-scale-1_25.png`, `ai-test-overlay-scale-1_5.png`.

### Rocket League full-screen — PASS

`npm run acceptance:fullscreen` launched LocalPilot and the overlay first, hid the LocalPilot window, then launched the installed Rocket League with `-fullscreen` (Alt+Enter was sent once because the initial window was not yet full-screen). Verified:

- Rocket League reached 2560×1440 at 0,0, was visible, foreground and marked topmost.
- The overlay was 2560×1440, visible, topmost and **not focused**; native z-order walking found the overlay above the Rocket League window (2 windows up in this run).
- A visual desktop capture with a temporary no-capture-exclusion test build showed the green border, banner, footer and cursor over the game. The temporary build was then reverted to `setContentProtection(true)` and the game capture was deleted.
- A real global `Esc` stopped the overlay; Rocket League remained running, full-screen and foreground after the stop.
- Cleanup closed the Rocket League process launched by the test; no game process remained.

The game displayed its own “SAVE FAILURE” dialog during the run, unrelated to the overlay. No actual multi-monitor hardware was available.

### Final regression re-run — PASS

After the tester integration, `npx electron out/main/index.js --self-test` reported **12 checks, 0 failed**. `SMOKE_PERSIST=1 npm run smoke` streamed `UI_READY`, exercised the 57-tool registry with the optional pack uninstalled, restarted the app, and verified the dark theme, completed onboarding, default Ollama model and conversations persisted.

### Installer, portable and packaged app — BUILT / packaged launch PASS

`npm run dist` exited 0 and produced:

- `release/LocalPilot AI-Setup-0.1.0-x64.exe` — 137,079,440 bytes.
- `release/LocalPilot-Portable-0.1.0.exe` — 119,727,356 bytes.
- `release/win-unpacked/` — unpacked application.

`npm run smoke:packaged` launched `release/win-unpacked/LocalPilot AI.exe`: `isPackaged: true`, version 0.1.0, 57 tools, 9,035,776-byte database, renderer mounted, no page errors; the AI test overlay started and stopped (1 overlay window). Screenshot: `artifacts/packaged-home.png`.

The NSIS installer was not installed/uninstalled on a clean machine, and the portable executable was not launched directly.

## Artifacts

| File | Content |
| --- | --- |
| `artifacts/ui-home.png` | Home/chat UI |
| `artifacts/ui-chat.png` | Streamed local reply |
| `artifacts/ui-tools.png` | Approved file tool cards |
| `artifacts/ui-browser.png` | Browser automation result |
| `artifacts/ui-stopped.png` | Cancelled run |
| `artifacts/notepad-interaction.png` | Real Notepad with typed marker |
| `artifacts/ai-test-overlay.png` | AI tester overlay: independent green AI cursor, border, Esc prompt |
| `artifacts/ai-test-overlay-fullscreen.png` | Overlay UI captured during the full-screen game test |
| `artifacts/ai-test-overlay-scale-1_25.png` | Overlay at forced 125% scale |
| `artifacts/ai-test-overlay-scale-1_5.png` | Overlay at forced 150% scale |
| `artifacts/packaged-home.png` | Packaged app launched |
| `artifacts/acceptance-failure.png` | Earlier failure retained from development |

Artifacts contain real test conversations and desktop content; review before sharing. `notepad-interaction.png` is a full desktop capture.

## Side effects

- Conversations, messages and activity remain in `%APPDATA%\LocalPilot AI\data\localpilot.db`.
- Screenshots accumulate in `%APPDATA%\LocalPilot AI\captures`.
- The self-test writes `data/selftest-report.json` and a probe file under `%APPDATA%\LocalPilot AI\selftest`.
- The Notepad test closes only the Notepad process it detected as new.
- The local-only test cleans up its endpoint and conversation.
- The overlay and DPI tests move the real pointer, exercise the guarded test-only AI mouse action, restore the pointer, and uninstall the tester pack after verifying revocation.
- The full-screen test launches the installed Rocket League, sends Alt+Enter if needed, and closes only the process it started. Rocket League displayed its own save-failure dialog; the test did not interact with it.

## Not covered

- Clean-machine NSIS install, upgrade, uninstall and data retention.
- Portable executable direct launch.
- Windows 10, Chrome, actual multi-monitor hardware and OS-level per-monitor DPI scaling (forced app scaling was used).
- LM Studio, llama.cpp/Vulkan and cloud provider runtime behavior.
- Capability-warning branches (the test model reports tools, vision and thinking).
- Native plugin installation through the UI (the example and host build exist; the MCP path was exercised).
- Other full-screen games/engines; the exact exclusive/borderless mode used by Rocket League was not identified. Whether third-party capture tools honor Windows capture exclusion.
- Roblox Studio MCP, production MCP servers, long-running stability and concurrent runs.

Report these as unverified rather than assuming they work. See [DEVELOPMENT_STATUS.md](../DEVELOPMENT_STATUS.md).
