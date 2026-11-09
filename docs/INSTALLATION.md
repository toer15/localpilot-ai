# Installation

LocalPilot AI 0.1.3 supports Windows 10 and Windows 11 x64.

## Requirements

- Windows 10/11 x64, 8 GB RAM minimum (16 GB+ recommended), and enough disk for the managed engine and models.
- Internet access for the first engine and model download. After that, inference runs locally.
- **No Ollama installation is required.** LocalPilot can download and manage its own llama.cpp engine. Existing Ollama, LM Studio or llama.cpp servers are optional and auto-detected.
- Microsoft Edge or Google Chrome for built-in browser automation.
- Optional: Node.js for `npx`-based MCP presets; `uv`/`uvx` for the Git MCP preset.
- GPU acceleration is provided by the selected runtime. LocalPilot selects the official llama.cpp Vulkan build when available and otherwise uses the CPU build; it does not install CUDA, ROCm or Vulkan drivers and does not assume ROCm on AMD.

## Install with the NSIS installer

1. Run `release/LocalPilot AI-Setup-0.1.3-x64.exe`.
2. The installer is per-user and does not require administrator rights. Choose an install directory if you do not want the default.
3. Shortcuts are created for the desktop and Start Menu.
4. Launch **LocalPilot AI**.

The build is unsigned, so Windows SmartScreen may show “Windows protected your PC”. Choose **More info → Run anyway** only if you trust the source.

### Automatic updates

Installed NSIS builds check the public [GitHub Releases feed](https://github.com/toer15/localpilot-ai/releases) shortly after startup and every four hours. When a newer version is available, LocalPilot downloads it in the background and shows an in-app prompt. The installer runs only after you choose **Restart and install**; closing the prompt leaves the app running. You can also use **Settings → About → Check for updates** at any time.

The updater replaces the installed app. The portable executable does not self-update; download a newer portable build from the Releases page. The repository is public so installed copies can read release metadata without embedding a GitHub token in the app.

## Portable build

Run `release/LocalPilot-Portable-0.1.3.exe`. It unpacks and starts without an installation. Application data still lives under `%APPDATA%\LocalPilot AI` (portable mode does not redirect user data next to the executable). Portable builds do not use the in-app updater; replace the executable with a newer release when you want to upgrade.

## First run

1. The setup wizard checks for existing local runtimes and models. You can skip it; everything is also available in Settings and the Model library.
2. Open **Model library → Local engine → Install local engine**. LocalPilot downloads the official llama.cpp Windows build into `%APPDATA%\LocalPilot AI\runtime\llama.cpp`; no separate app needs to stay open.
3. In **Model library → Browse the model catalog**, choose a recommended GGUF model and press the green **Download** button. Choose a quantization in the dialog. A 7–8B Q4 model is comfortable on 8–12 GB VRAM; smaller models work on 8 GB systems. The model downloads to the configured models folder and appears under **Local GGUF files**.
4. Press **Load & use** on the downloaded model. LocalPilot starts the managed engine and selects the model in the chat toolbar. Send a prompt; the first load can take a few seconds while the model is read into memory.

If you already use Ollama, it is detected at `http://127.0.0.1:11434` and its models remain available. To pull through Ollama instead, choose the **Ollama library** source and use its Download button. LM Studio can be started on port 1234. An existing llama.cpp build can still be selected under **Settings → Models → llama-server.exe path**.

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
runtime\llama.cpp\          Managed llama.cpp engine downloaded by LocalPilot
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
