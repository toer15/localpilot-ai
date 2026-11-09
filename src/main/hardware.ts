import type { HardwareInfo } from '@shared/types'
import { runPowerShell, parseJsonLoose } from './core/proc'
import { log } from './core/logger'

interface RawHardware {
  os?: string
  cpuModel?: string
  cores?: number
  threads?: number
  ramTotal?: number
  ramFree?: number
  gpus?: { name?: string; vendor?: string; vram?: number; driver?: string }[]
  disks?: { name?: string; free?: number; total?: number }[]
  vulkan?: boolean
  cuda?: boolean
  rocm?: boolean
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$regBase = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
$regSizes = @{}
Get-ChildItem $regBase | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  $size = $p.'HardwareInformation.qwMemorySize'
  if ($size -and $p.DriverDesc) { $regSizes[[string]$p.DriverDesc] = [double]$size }
}
$gpuList = @()
Get-CimInstance Win32_VideoController | ForEach-Object {
  $vram = $regSizes[[string]$_.Name]
  if (-not $vram) { $vram = [double]$_.AdapterRAM }
  if ($vram -lt 0) { $vram = [math]::Abs($vram) }
  $gpuList += [pscustomobject]@{ name = [string]$_.Name; vendor = [string]$_.AdapterCompatibility; vram = $vram; driver = [string]$_.DriverVersion }
}
$disks = @()
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object {
  $disks += [pscustomobject]@{ name = [string]$_.Name; free = [double]$_.Free; total = ([double]$_.Free + [double]$_.Used) }
}
$vulkan = Test-Path (Join-Path $env:SystemRoot 'System32\\vulkan-1.dll')
$cuda = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $cuda = $true }
$rocm = Test-Path (Join-Path $env:SystemRoot 'System32\\amdhip64.dll')
[pscustomobject]@{
  os = [string]($os.Caption + ' ' + $os.Version)
  cpuModel = [string]$cpu.Name
  cores = [int]$cpu.NumberOfCores
  threads = [int]$cpu.NumberOfLogicalProcessors
  ramTotal = ([double]$os.TotalVisibleMemorySize * 1024)
  ramFree = ([double]$os.FreePhysicalMemory * 1024)
  gpus = $gpuList
  disks = $disks
  vulkan = $vulkan
  cuda = $cuda
  rocm = $rocm
} | ConvertTo-Json -Depth 6 -Compress
`

let cached: { at: number; info: HardwareInfo } | null = null

export async function detectHardware(force = false): Promise<HardwareInfo> {
  if (!force && cached && Date.now() - cached.at < 60000) return cached.info
  const res = await runPowerShell(SCRIPT, { timeoutMs: 20000 })
  const raw = parseJsonLoose<RawHardware>(res.stdout)
  if (!raw) {
    log.warn('hardware', 'PowerShell hardware query returned no JSON', { stderr: res.stderr.slice(0, 500) })
    const fallback: HardwareInfo = {
      os: `${process.platform} ${process.arch}`,
      cpu: { model: 'Unknown CPU', cores: 0, threads: 0 },
      ram: { totalBytes: 0, availableBytes: 0 },
      gpus: [],
      disks: [],
      acceleration: { cuda: false, vulkan: false, rocm: false },
      recommendations: {
        gpuLayers: 0,
        contextLength: 4096,
        quantization: 'Q4_K_M',
        summary: 'Hardware detection failed. You can still point LocalPilot at a running local model server.'
      },
      capturedAt: new Date().toISOString()
    }
    return fallback
  }

  const gpus = (raw.gpus ?? []).map((g) => ({
    name: g.name ?? 'Unknown GPU',
    vendor: g.vendor ?? '',
    vramBytes: Number(g.vram) && Number(g.vram) > 0 && Number(g.vram) < 1e12 ? Number(g.vram) : undefined,
    driver: g.driver
  }))
  const primary = gpus.reduce<{ vramBytes?: number }>((best, gpu) => {
    if ((gpu.vramBytes ?? 0) > (best.vramBytes ?? 0)) return gpu
    return best
  }, {})
  const vramGb = (primary.vramBytes ?? 0) / 1024 ** 3
  const ramGb = (raw.ramTotal ?? 0) / 1024 ** 3
  let gpuLayers = 0
  let contextLength = 4096
  let quantization = 'Q4_K_M'
  if (vramGb >= 24) {
    gpuLayers = -1
    contextLength = 32768
  } else if (vramGb >= 16) {
    gpuLayers = -1
    contextLength = 24576
  } else if (vramGb >= 10) {
    gpuLayers = -1
    contextLength = 16384
  } else if (vramGb >= 6) {
    gpuLayers = 28
    contextLength = 8192
    quantization = 'Q4_K_M'
  } else if (vramGb > 0) {
    gpuLayers = 12
    contextLength = 4096
    quantization = 'Q4_0'
  } else if (ramGb >= 32) {
    gpuLayers = 0
    contextLength = 8192
  }
  const accel = []
  if (raw.cuda) accel.push('CUDA')
  if (raw.vulkan) accel.push('Vulkan')
  if (raw.rocm) accel.push('ROCm')
  const amd = gpus.some((g) => /amd|radeon/i.test(`${g.vendor} ${g.name}`))

  const info: HardwareInfo = {
    os: raw.os ?? `${process.platform}`,
    cpu: {
      model: raw.cpuModel ?? 'Unknown CPU',
      cores: raw.cores ?? 0,
      threads: raw.threads ?? 0
    },
    ram: { totalBytes: raw.ramTotal ?? 0, availableBytes: raw.ramFree ?? 0 },
    gpus,
    disks: (raw.disks ?? []).map((d) => ({
      name: `${d.name ?? '?'}:`,
      freeBytes: d.free,
      totalBytes: d.total
    })),
    acceleration: {
      cuda: Boolean(raw.cuda),
      vulkan: Boolean(raw.vulkan),
      rocm: Boolean(raw.rocm)
    },
    recommendations: {
      gpuLayers,
      contextLength,
      quantization,
      summary:
        gpus.length === 0
          ? 'No discrete GPU detected. CPU inference will work but be slower; prefer 4–8B Q4 models.'
          : `${gpus[0].name}${primary.vramBytes ? ` · ${vramGb.toFixed(1)} GB VRAM` : ''}${
              amd ? ' — use a llama.cpp Vulkan build; ROCm on Windows is not assumed.' : ''
            } ${accel.length ? `Backends: ${accel.join(', ')}.` : ''} Recommended: ${contextLength.toLocaleString()} context, ${gpuLayers === -1 ? 'all' : gpuLayers} GPU layers, ${quantization}.`
    },
    capturedAt: new Date().toISOString()
  }
  cached = { at: Date.now(), info }
  return info
}
