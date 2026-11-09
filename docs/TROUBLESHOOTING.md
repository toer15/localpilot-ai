# Troubleshooting

Start with **Settings → Advanced → Run self-test** and check `%APPDATA%\LocalPilot AI\logs\main.log`. The self-test report is written to `%APPDATA%\LocalPilot AI\data\selftest-report.json`.

## No models are discovered

- Confirm the runtime is running. For Ollama: `ollama list` and `ollama serve`. Open `http://127.0.0.1:11434/api/tags` in a browser.
- LocalPilot auto-detects Ollama on 11434, LM Studio on 1234 and llama.cpp on 8080. If yours uses another port, edit the endpoint under Settings → Models & endpoints.
- If Ollama runs on another host or port, set `OLLAMA_HOST` for Ollama and update the endpoint in LocalPilot. A non-loopback endpoint is blocked while local-only mode is on.
- Click **Refresh** in Models & endpoints after starting a runtime.

## The model selector is empty or the model is “not found”

Pull a chat model first (`ollama pull qwen3:8b`) and refresh discovery. If a conversation references a removed model, choose another in the chat toolbar. The agent warns and continues with unknown capabilities when a model is not found; it may then use the text tool protocol.

## “Request exceeds the available context size”

The agent budgets context, but a very long conversation or a small-context model can still overflow. Raise **Context length** in Settings (32k default), start a new conversation, or switch to a model with a larger context. Legacy 8k settings are migrated to 32k automatically. Screenshots and tool output are capped by the agent.

## Inference is slow or runs out of VRAM

- Use a smaller quantization or a smaller model.
- Lower context length; KV cache grows with context.
- In Ollama, keep a model loaded with `keep_alive`; the first request after idle reloads it.
- For llama.cpp, lower GPU layers if the model does not fit, and use a Vulkan build on AMD Radeon. LocalPilot does not assume ROCm on Windows.
- Close other GPU-heavy applications. The Hardware diagnostics panel reports detected VRAM and a recommendation, but cannot guarantee a fit.

## llama.cpp will not start

- Set the exact `llama-server.exe` path in Settings. Use a CUDA build for NVIDIA or Vulkan for AMD.
- The configured port must be free; change it in Settings.
- Import a GGUF file first. llama.cpp starts with the newest imported file when started from the model page.
- Check the main log for the launched command and server stderr.

## PowerShell or Computer Use fails

- The engine runs PowerShell scripts from temporary `.ps1` files. Corporate policy, antivirus or Constrained Language Mode may block them.
- Screenshots require an interactive desktop session; locked or disconnected sessions fail.
- For Notepad or other apps, focus the target window first. Prefer `uia.inspect`/`uia.find` over guessing coordinates. Apps that expose no UI Automation require screenshots and coordinates.
- High-risk actions always prompt. If no window is available, the permission broker denies the action. Pending approvals time out after 10 minutes.
- Use the emergency shortcut (`Ctrl+Alt+Shift+X` by default) to stop an agent and kill running tool processes.

## Browser automation fails

- Install Microsoft Edge or Google Chrome. Playwright Core uses the installed browser; it does not download one.
- Close a stale automation window or call `browser.close`.
- The browser uses its own profile under `%APPDATA%\LocalPilot AI\browser`; existing cookies from your normal browser are not present.
- Local-only mode removes web and browser tools. Disable it only if you intend to use the internet.

## Local-only mode blocks my request

Local-only mode permits only loopback endpoints and removes internet tools. The error names the provider and endpoint. Disable **Settings → Privacy → Local-only mode** to allow a remote provider, understanding that requests will leave the machine. MCP servers and native plugins are not contained by this setting.

## MCP server installation or test fails

- Presets use `npx` or `uvx`; confirm `node`/`npx` or `uv` is installed and on `PATH`.
- Open **Plugins → Configure** and check the command, arguments, environment and URL. Start the server, then use **Test**.
- GitHub MCP requires `GITHUB_PERSONAL_ACCESS_TOKEN` in the server environment. Filesystem MCP starts with no allowed directories unless you add paths to its arguments.
- Third-party servers can be broken or changed upstream. Read their source before installing. Removal unregisters the server and its tools.

## A native plugin does not load

- `plugin.json` and its entry file must be in the same folder. The manifest requires `id`, `name`, `version` and at least one tool with `name`, `description` and `parameters`.
- The example uses CommonJS: `module.exports = { tools: { ... } }`.
- Check the manifest permissions and the main log. Reinstall the folder after changes.
- Native plugins are not OS-sandboxed; install only trusted code.

## The installer or portable exe is blocked

The builds are unsigned. SmartScreen may warn. Do not disable Windows security globally; verify the source and build hash, then use **More info → Run anyway** if you trust it. A corporate policy may block unsigned executables entirely.

## Reset the app

- **Settings → Advanced → Reset settings** restores defaults without deleting conversations or projects.
- **Settings → Privacy** can delete conversations or the activity log.
- For a full reset, quit LocalPilot and rename/delete `%APPDATA%\LocalPilot AI`. This removes the database, models, plugins, captures and logs.

## Logs and diagnostics

`logs/main.log` is the main-process log. Activity in the app records tool and permission summaries. The self-test exercises database, hardware, providers, local inference, tools, file guards, PowerShell, screenshot, Playwright, MCP and local-only prerequisites. Include the report and the exact failing command when requesting help; remove secrets and personal paths first.
