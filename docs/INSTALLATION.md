# Installation

LocalPilot AI 0.1.0 supports Windows 10 and Windows 11 x64.

## Requirements

- Windows 10/11 x64, 8 GB RAM minimum (16 GB+ recommended), and enough disk for models.
- A local inference runtime. **Ollama** is recommended and auto-detected at `http://127.0.0.1:11434`.
- Microsoft Edge or Google Chrome for built-in browser automation.
- Optional: Node.js for `npx`-based MCP presets; `uv`/`uvx` for the Git MCP preset.
- GPU acceleration is provided by your runtime. LocalPilot does not install CUDA, ROCm or Vulkan drivers and does not assume ROCm on AMD.

## Install with the NSIS installer

1. Run `release/LocalPilot AI-Setup-0.1.0-x64.exe`.
2. The installer is per-user and does not require administrator rights. Choose an install directory if you do not want the default.
3. Shortcuts are created for the desktop and Start Menu.
4. Launch **LocalPilot AI**.

The build is unsigned, so Windows SmartScreen may show “Windows protected your PC”. Choose **More info → Run anyway** only if you trust the source.

### Automatic updates

Installed NSIS builds check the public [GitHub Releases feed](https://github.com/toer15/localpilot-ai/releases) shortly after startup and every four hours. When a newer version is available, LocalPilot downloads it in the background and shows an in-app prompt. The installer runs only after you choose **Restart and install**; closing the prompt leaves the app running. You can also use **Settings → About → Check for updates** at any time.

The updater replaces the installed app. The portable executable does not self-update; download a newer portable build from the Releases page. The repository is public so installed copies can read release metadata without embedding a GitHub token in the app.

## Portable build

Run `release/LocalPilot-Portable-0.1.0.exe`. It unpacks and starts without an installation. Application data still lives under `%APPDATA%\LocalPilot AI` (portable mode does not redirect user data next to the executable). Portable builds do not use the in-app updater; replace the executable with a newer release when you want to upgrade.

## First run

1. The setup wizard checks for local runtimes and models. You can skip it and configure everything later in Settings.
2. Install or start Ollama:

   ```powershell
   ollama serve
   ollama pull qwen3:8b
   ```

   Model choice depends on hardware: a 7–8B Q4 model is comfortable on 8–12 GB VRAM; larger models need more memory. The app can also pull models from its Model library.
3. In LocalPilot, open **Models & endpoints** if the model is not detected, then refresh. Select the model in the chat toolbar.
4. Send a short prompt. The first load can take tens of seconds while the model is read into memory.

If you use LM Studio, start its local server on port 1234. For llama.cpp, point **Settings → Models & endpoints → llama-server.exe path** at a `llama-server.exe` build (a Vulkan build for AMD Radeon), import a GGUF in the Model library, then load it.

## Building from source

Prerequisites: Node.js 20+ (tested with Node 26.13), npm, Windows.

```powershell
npm install
npm run typecheck
npm run dev
```

Production and packaging:

```powershell
npm run build          # out/
npm run dist           # release/ NSIS + portable
npm run dist:dir       # release/win-unpacked only
npm run selftest       # Electron --self-test
```

`npm run dist` downloads Electron and NSIS tooling on first use. No code-signing certificate is configured; artifacts are unsigned.

## Data location and uninstall

Application data is stored under `%APPDATA%\LocalPilot AI`:

```
data\localpilot.db          SQLite database
data\selftest-report.json   Latest self-test report
logs\main.log               Main-process log
models\                     Imported/downloaded GGUF files
plugins\                    Installed native plugins
captures\                   Screenshots
browser\                    Browser automation profile
```

Uninstalling through Windows Settings removes the application. The NSIS configuration keeps application data by default (`deleteAppDataOnUninstall: false`). To remove everything, quit the app and delete `%APPDATA%\LocalPilot AI` manually.

## Verifying the installation

- Settings → Advanced → **Run self-test** checks SQLite, hardware, providers, models, real local inference, tools, file guards, PowerShell, screenshots, Playwright, MCP and local-only prerequisites.
- Settings → About shows version, Electron/Node versions, data paths, tool count, database size and **Check for updates**.
- The command-line self-test is `npx electron out/main/index.js --self-test`; it exits non-zero if any check fails.

See [CONFIGURATION.md](CONFIGURATION.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) next.
