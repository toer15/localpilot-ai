# Releasing and updates

LocalPilot AI publishes Windows x64 installers to [toer15/localpilot-ai](https://github.com/toer15/localpilot-ai). The repository is public because `electron-updater` reads release metadata and downloads installers without a token embedded in the app.

## What gets published

`electron-builder` produces:

- `LocalPilot AI-Setup-<version>-x64.exe` — per-user NSIS installer, also the update target.
- `LocalPilot-Portable-<version>.exe` — manual portable build, not self-updating.
- `latest.yml` and `.blockmap` — update metadata used by installed builds.

The packaged app contains `resources/app-update.yml`, generated from the `publish` block in `electron-builder.yml`.

## Normal release

1. Update the version in `package.json` (and keep `package-lock.json` in sync):

   ```bash
   npm version patch --no-git-tag-version
   ```

2. Run the local checks and package smoke test:

   ```bash
   npm run typecheck
   npm run build
   npm run dist
   npm run smoke:packaged
   ```

3. Commit the version and code, then push:

   ```bash
   git add -A
   git commit -m "Release v$(node -p "require('./package.json').version")"
   git push origin main
   ```

4. Create and push an annotated tag. The GitHub Actions workflow builds and publishes the release:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag -a "v$VERSION" -m "LocalPilot AI v$VERSION"
   git push origin "v$VERSION"
   ```

5. Watch the workflow:

   ```bash
   gh run watch
   ```

   The workflow verifies that the tag matches `package.json`, runs typecheck/build, packages NSIS and portable, then runs `scripts/publish-release.mjs` to upload `latest.yml`, the installer, its blockmap and the portable build. It fails rather than silently publishing a mismatched version.

6. Add or edit user-facing notes on the GitHub release if desired. The app shows the release body as **What’s new** when GitHub supplies it.

Installed copies of the previous version check shortly after launch and every four hours, download the NSIS package in the background, and prompt. Installation is explicit; **Settings → About → Check for updates** is the manual path.

## Manual publish

Build and upload from a machine with GitHub CLI authenticated:

```powershell
$env:GH_TOKEN = gh auth token
npm run release:github
```

This runs `electron-builder --publish never`, normalizes the asset names to match `latest.yml`, and uploads them through `gh release` (or creates the release with generated notes if it does not exist). Using `gh` avoids electron-builder's per-target GitHub publishers racing to create the same release. Do not embed a token in the app or commit one.

## Rules

- Never publish a tag whose version does not match `package.json`; the installed app compares semantic versions.
- Never move or delete a published release tag. Users may have downloaded it and the updater uses `latest.yml`.
- Keep the repository public or redesign update delivery; private assets cannot be downloaded anonymously by installed builds.
- The builds are unsigned. SmartScreen warnings are expected; do not describe a build as signed unless a certificate was actually used.
- Portable builds do not self-update. They are for users who do not want an installed app.
