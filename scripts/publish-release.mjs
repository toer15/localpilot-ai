/**
 * Publish the current version to GitHub Releases.
 *
 * Electron-builder produces the files; this script normalizes the asset names
 * to match latest.yml and uploads them through gh. Using gh avoids a race
 * between electron-builder's per-target GitHub publishers.
 *
 * Usage: npm run release:github
 * Requires an authenticated gh CLI (or GH_TOKEN).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const releaseDir = path.join(root, 'release')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const tag = `v${version}`
const uploadDir = path.join(releaseDir, 'upload')

const assets = [
  [`LocalPilot AI-Setup-${version}-x64.exe`, `LocalPilot-AI-Setup-${version}-x64.exe`],
  [`LocalPilot AI-Setup-${version}-x64.exe.blockmap`, `LocalPilot-AI-Setup-${version}-x64.exe.blockmap`],
  [`LocalPilot-Portable-${version}.exe`, `LocalPilot-Portable-${version}.exe`],
  ['latest.yml', 'latest.yml']
]

for (const [source] of assets) {
  const file = path.join(releaseDir, source)
  if (!fs.existsSync(file)) throw new Error(`Missing release asset: ${file}`)
}

fs.rmSync(uploadDir, { recursive: true, force: true })
fs.mkdirSync(uploadDir, { recursive: true })
for (const [source, target] of assets) {
  fs.copyFileSync(path.join(releaseDir, source), path.join(uploadDir, target))
}

const uploadPaths = assets.map(([, target]) => path.join(uploadDir, target))
const gh = process.platform === 'win32' ? 'gh.exe' : 'gh'
let releaseExists = false
try {
  execFileSync(gh, ['release', 'view', tag], { stdio: 'ignore', env: process.env })
  releaseExists = true
} catch {
  releaseExists = false
}

if (releaseExists) {
  console.log(`[publish] adding assets to existing release ${tag}`)
  execFileSync(gh, ['release', 'upload', tag, ...uploadPaths, '--clobber'], {
    stdio: 'inherit',
    env: process.env
  })
} else {
  console.log(`[publish] creating release ${tag}`)
  execFileSync(
    gh,
    [
      'release',
      'create',
      tag,
      ...uploadPaths,
      '--verify-tag',
      '--title',
      `LocalPilot AI ${version}`,
      '--generate-notes'
    ],
    { stdio: 'inherit', env: process.env }
  )
}

fs.rmSync(uploadDir, { recursive: true, force: true })
console.log(`[publish] published ${tag}`)
