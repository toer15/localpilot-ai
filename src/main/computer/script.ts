/**
 * Windows computer-use engine.
 *
 * Implemented as a self-contained PowerShell script with inline C# P/Invoke.
 * Every call is an explicit tool invocation; there is no background capture.
 * Output is always a single JSON object on stdout.
 */

const BASE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { Add-Type -AssemblyName System.Windows.Forms } catch {}
try { Add-Type -AssemblyName System.Drawing } catch {}
try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class LP {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public static void TypeText(string text) {
    foreach (char c in text) {
      INPUT[] inputs = new INPUT[2];
      inputs[0].type = 1;
      inputs[0].u.ki.wScan = c;
      inputs[0].u.ki.dwFlags = 4;
      inputs[1].type = 1;
      inputs[1].u.ki.wScan = c;
      inputs[1].u.ki.dwFlags = 6;
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  public static string ForegroundTitle() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  public static long ForegroundHandle() { return GetForegroundWindow().ToInt64(); }
}
"@

[void][LP]::SetProcessDPIAware()
$Action = '__ACTION__'
$PayloadB64 = '__PAYLOAD__'
$payload = @{}
if ($PayloadB64) {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  if ($json.Trim()) { $payload = $json | ConvertFrom-Json }
}

function Respond($obj) {
  $obj | ConvertTo-Json -Depth 8 -Compress
  exit 0
}
function Fail($msg) {
  [pscustomobject]@{ ok = $false; error = [string]$msg } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
function Get-WindowByHwnd($hwnd) {
  $h = [IntPtr][long]$hwnd
  if ($h -ne [IntPtr]::Zero) { return $h }
  return [IntPtr]::Zero
}
function Find-Window() {
  if ($payload.hwnd) {
    $h = [IntPtr][long]$payload.hwnd
    if ($h -ne [IntPtr]::Zero) { return $h }
  }
  $title = [string]$payload.title
  $app = [string]$payload.processName
  $procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })
  if ($title) {
    $found = $procs | Where-Object { $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
    if ($found) { return $found.MainWindowHandle }
  }
  if ($app) {
    $needle = $app -replace '\.exe$',''
    $found = $procs | Where-Object { $_.ProcessName -like "*$needle*" } | Select-Object -First 1
    if ($found) { return $found.MainWindowHandle }
  }
  return [IntPtr]::Zero
}
function Set-KeyState([int]$vk, [bool]$down) {
  $flags = if ($down) { 0 } else { 2 }
  [LP]::keybd_event([byte]$vk, 0, [uint32]$flags, [UIntPtr]::Zero)
}
function Get-Vk([string]$key) {
  $k = $key.ToLowerInvariant()
  $map = @{
    ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; lwin = 0x5B; rwin = 0x5C;
    enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20;
    backspace = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D; home = 0x24; end = 0x23;
    pageup = 0x21; pagedown = 0x22; up = 0x26; down = 0x28; left = 0x25; right = 0x27;
    capslock = 0x14; printscreen = 0x2C
  }
  if ($map.ContainsKey($k)) { return [int]$map[$k] }
  if ($k -match '^f([1-9]|1[0-2])$') { return 0x70 + ([int]$Matches[1] - 1) }
  if ($k.Length -eq 1) {
    $ch = $k.ToUpperInvariant()[0]
    if ($ch -match '[A-Z]') { return [int][char]$ch }
    if ($ch -match '[0-9]') { return [int][char]$ch }
  }
  throw "Unsupported key: $key"
}

try {
  switch ($Action) {
    'screenshot' {
      $path = [string]$payload.path
      if (-not $path) { Fail 'A screenshot output path is required.' }
      $dir = Split-Path -Parent $path
      if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap ([int]$bounds.Width), ([int]$bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Respond ([pscustomobject]@{ ok = $true; path = $path; width = [int]$bounds.Width; height = [int]$bounds.Height })
    }
    'display' {
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      Respond ([pscustomobject]@{ ok = $true; width = [int]$bounds.Width; height = [int]$bounds.Height; x = [int]$bounds.X; y = [int]$bounds.Y; foreground = [LP]::ForegroundTitle() })
    }
    'list_windows' {
      $items = @()
      foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
        $items += [pscustomobject]@{
          title = [string]$p.MainWindowTitle
          processName = [string]$p.ProcessName
          pid = [int]$p.Id
          hwnd = [string]$p.MainWindowHandle.ToInt64()
          minimized = [bool][LP]::IsIconic($p.MainWindowHandle)
        }
      }
      Respond ([pscustomobject]@{ ok = $true; windows = @($items); foreground = [LP]::ForegroundTitle() })
    }
    'active_window' {
      $h = [LP]::GetForegroundWindow()
      $title = [LP]::ForegroundTitle()
      Respond ([pscustomobject]@{ ok = $true; hwnd = [string]$h.ToInt64(); title = $title })
    }
    'focus' {
      $h = Find-Window
      if ($h -eq [IntPtr]::Zero) { Fail 'No matching window found.' }
      [void][LP]::ShowWindowAsync($h, 9)
      Start-Sleep -Milliseconds 250
      [void][LP]::SetForegroundWindow($h)
      Respond ([pscustomobject]@{ ok = $true; hwnd = [string]$h.ToInt64(); title = [LP]::ForegroundTitle() })
    }
    'minimize' {
      $h = Find-Window
      if ($h -eq [IntPtr]::Zero) { Fail 'No matching window found.' }
      [void][LP]::ShowWindowAsync($h, 6)
      Respond ([pscustomobject]@{ ok = $true; hwnd = [string]$h.ToInt64() })
    }
    'maximize' {
      $h = Find-Window
      if ($h -eq [IntPtr]::Zero) { Fail 'No matching window found.' }
      [void][LP]::ShowWindowAsync($h, 3)
      Respond ([pscustomobject]@{ ok = $true; hwnd = [string]$h.ToInt64() })
    }
    'close_window' {
      $h = Find-Window
      if ($h -eq [IntPtr]::Zero) { Fail 'No matching window found.' }
      [void][LP]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      Respond ([pscustomobject]@{ ok = $true; hwnd = [string]$h.ToInt64() })
    }
    'launch' {
      $file = [string]$payload.path
      if (-not $file) { Fail 'path is required' }
      $arguments = [string]$payload.arguments
      if ($arguments) {
        $p = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
      } else {
        $p = Start-Process -FilePath $file -PassThru
      }
      Start-Sleep -Milliseconds 500
      Respond ([pscustomobject]@{ ok = $true; pid = [int]$p.Id; processName = [string]$p.ProcessName })
    }
    'mouse' {
      $act = [string]$payload.action
      $x = [int]$payload.x
      $y = [int]$payload.y
      $button = [string]$payload.button
      if ($button -eq '') { $button = 'left' }
      $downFlag = 0x0002; $upFlag = 0x0004
      if ($button -eq 'right') { $downFlag = 0x0008; $upFlag = 0x0010 }
      if ($button -eq 'middle') { $downFlag = 0x0020; $upFlag = 0x0040 }
      if ($act -eq 'scroll') {
        if ($payload.x -ne $null) { [void][LP]::SetCursorPos($x, $y) }
        $amount = [int]$payload.amount
        if ($amount -eq 0) { $amount = 3 }
        [LP]::mouse_event(0x0800, 0, 0, ($amount * 120), [UIntPtr]::Zero)
      } else {
        [void][LP]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 40
        switch ($act) {
          'move' { }
          'click' {
            [LP]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 30
            [LP]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
          }
          'double' {
            [LP]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
            [LP]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 90
            [LP]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
            [LP]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
          }
          'down' { [LP]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero) }
          'up' { [LP]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero) }
          'drag' {
            $toX = [int]$payload.toX
            $toY = [int]$payload.toY
            [LP]::mouse_event($downFlag, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
            $steps = 12
            for ($i = 1; $i -le $steps; $i++) {
              $ix = $x + [int](($toX - $x) * $i / $steps)
              $iy = $y + [int](($toY - $y) * $i / $steps)
              [void][LP]::SetCursorPos($ix, $iy)
              Start-Sleep -Milliseconds 25
            }
            [LP]::mouse_event($upFlag, 0, 0, 0, [UIntPtr]::Zero)
          }
          default { Fail "Unsupported mouse action: $act" }
        }
      }
      Respond ([pscustomobject]@{ ok = $true; action = $act; x = [int]$payload.x; y = [int]$payload.y })
    }
    'keyboard' {
      $act = [string]$payload.action
      if ($act -eq 'type') {
        $text = [string]$payload.text
        if (-not $text) { Fail 'text is required' }
        [LP]::TypeText($text)
        Respond ([pscustomobject]@{ ok = $true; typed = $text.Length })
      }
      $combo = [string]$payload.keys
      if (-not $combo) { $combo = [string]$payload.key }
      if (-not $combo) { Fail 'keys is required' }
      $keys = @($combo.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $vks = @()
      foreach ($k in $keys) { $vks += Get-Vk $k }
      foreach ($vk in $vks) { Set-KeyState $vk $true }
      Start-Sleep -Milliseconds 60
      for ($i = $vks.Count - 1; $i -ge 0; $i--) { Set-KeyState $vks[$i] $false }
      Respond ([pscustomobject]@{ ok = $true; keys = $combo })
    }
    'uia_tree' {
      if (-not ('System.Windows.Automation.AutomationElement' -as [type])) { Fail 'UI Automation is not available on this system.' }
      $AE = [System.Windows.Automation.AutomationElement]
      $root = $AE::RootElement
      if ($payload.hwnd) {
        $root = $AE::FromHandle([IntPtr][long]$payload.hwnd)
      } else {
        $fg = [LP]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) { $root = $AE::FromHandle($fg) }
      }
      $maxDepth = 3
      if ($payload.depth) { $maxDepth = [int]$payload.depth }
      $script:items = New-Object System.Collections.ArrayList
      $script:limit = 500
      function Walk-Uia($el, $level) {
        if ($script:items.Count -ge $script:limit -or $level -gt $maxDepth) { return }
        try {
          $r = $el.Current.BoundingRectangle
          $null = $script:items.Add([pscustomobject]@{
            name = [string]$el.Current.Name
            automationId = [string]$el.Current.AutomationId
            controlType = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')
            className = [string]$el.Current.ClassName
            enabled = [bool]$el.Current.IsEnabled
            x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y)
            width = [int][math]::Round($r.Width); height = [int][math]::Round($r.Height)
          })
        } catch {}
        try {
          $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
          $child = $walker.GetFirstChild($el)
          while ($child -ne $null) {
            Walk-Uia $child ($level + 1)
            if ($script:items.Count -ge $script:limit) { break }
            $child = $walker.GetNextSibling($child)
          }
        } catch {}
      }
      Walk-Uia $root 0
      Respond ([pscustomobject]@{ ok = $true; window = [LP]::ForegroundTitle(); elements = @($script:items) })
    }
    'uia_find' {
      $AE = [System.Windows.Automation.AutomationElement]
      $root = $AE::RootElement
      if ($payload.hwnd) { $root = $AE::FromHandle([IntPtr][long]$payload.hwnd) }
      else {
        $fg = [LP]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) { $root = $AE::FromHandle($fg) }
      }
      $name = [string]$payload.name
      $automationId = [string]$payload.automationId
      $controlType = [string]$payload.controlType
      $items = New-Object System.Collections.ArrayList
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      for ($i = 0; $i -lt $all.Count -and $items.Count -lt 25; $i++) {
        try {
          $el = $all.Item($i)
          $n = [string]$el.Current.Name
          $aid = [string]$el.Current.AutomationId
          $ct = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')
          $nameOk = (-not $name) -or ($n.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          $idOk = (-not $automationId) -or ($aid -eq $automationId) -or ($aid.IndexOf($automationId, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          $typeOk = (-not $controlType) -or ($ct -eq $controlType)
          if ($nameOk -and $idOk -and $typeOk -and ($name -or $automationId -or $controlType)) {
            $r = $el.Current.BoundingRectangle
            $null = $items.Add([pscustomobject]@{
              name = $n; automationId = $aid; controlType = $ct
              enabled = [bool]$el.Current.IsEnabled
              x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y)
              width = [int][math]::Round($r.Width); height = [int][math]::Round($r.Height)
              index = [int]$i
            })
          }
        } catch {}
      }
      Respond ([pscustomobject]@{ ok = $true; matches = @($items); count = $items.Count })
    }
    'uia_click' {
      $AE = [System.Windows.Automation.AutomationElement]
      $root = $AE::RootElement
      if ($payload.hwnd) { $root = $AE::FromHandle([IntPtr][long]$payload.hwnd) }
      else {
        $fg = [LP]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) { $root = $AE::FromHandle($fg) }
      }
      $name = [string]$payload.name
      $automationId = [string]$payload.automationId
      $controlType = [string]$payload.controlType
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $target = $null
      for ($i = 0; $i -lt $all.Count; $i++) {
        try {
          $el = $all.Item($i)
          $n = [string]$el.Current.Name
          $aid = [string]$el.Current.AutomationId
          $ct = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')
          $nameOk = (-not $name) -or ($n.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          $idOk = (-not $automationId) -or ($aid -eq $automationId) -or ($aid.IndexOf($automationId, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          $typeOk = (-not $controlType) -or ($ct -eq $controlType)
          if ($nameOk -and $idOk -and $typeOk -and ($name -or $automationId -or $controlType)) { $target = $el; break }
        } catch {}
      }
      if ($target -eq $null) { Fail 'No matching UI Automation element found.' }
      $bounds = $target.Current.BoundingRectangle
      $cx = [int][math]::Round($bounds.X + $bounds.Width / 2)
      $cy = [int][math]::Round($bounds.Y + $bounds.Height / 2)
      $used = ''
      $pattern = $null
      if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); $used = 'invoke'
      } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select(); $used = 'select'
      } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $pattern.Toggle(); $used = 'toggle'
      } else {
        [void][LP]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 60
        [LP]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        [LP]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        $used = 'mouse'
      }
      Start-Sleep -Milliseconds 200
      Respond ([pscustomobject]@{
        ok = $true; method = $used
        name = [string]$target.Current.Name; automationId = [string]$target.Current.AutomationId
        x = $cx; y = $cy
        width = [int][math]::Round($bounds.Width); height = [int][math]::Round($bounds.Height)
      })
    }
    'uia_set_value' {
      $AE = [System.Windows.Automation.AutomationElement]
      $root = $AE::RootElement
      if ($payload.hwnd) { $root = $AE::FromHandle([IntPtr][long]$payload.hwnd) }
      else {
        $fg = [LP]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) { $root = $AE::FromHandle($fg) }
      }
      $name = [string]$payload.name
      $automationId = [string]$payload.automationId
      $value = [string]$payload.value
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $target = $null
      for ($i = 0; $i -lt $all.Count; $i++) {
        try {
          $el = $all.Item($i)
          $n = [string]$el.Current.Name
          $aid = [string]$el.Current.AutomationId
          $nameOk = (-not $name) -or ($n.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          $idOk = (-not $automationId) -or ($aid -eq $automationId) -or ($aid.IndexOf($automationId, [StringComparison]::OrdinalIgnoreCase) -ge 0)
          if ($nameOk -and $idOk -and ($name -or $automationId)) { $target = $el; break }
        } catch {}
      }
      if ($target -eq $null) { Fail 'No matching UI Automation element found.' }
      $bounds = $target.Current.BoundingRectangle
      $cx = [int][math]::Round($bounds.X + $bounds.Width / 2)
      $cy = [int][math]::Round($bounds.Y + $bounds.Height / 2)
      $pattern = $null
      if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        Fail 'The matched element does not support the Value pattern. Focus it and type instead.'
      }
      $pattern.SetValue($value)
      Start-Sleep -Milliseconds 150
      Respond ([pscustomobject]@{
        ok = $true; value = $value
        x = $cx; y = $cy
        width = [int][math]::Round($bounds.Width); height = [int][math]::Round($bounds.Height)
      })
    }
    default { Fail "Unknown computer action: $Action" }
  }
} catch {
  Fail $_.Exception.Message
}
`

export function computerScript(action: string, payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return BASE.replace('__ACTION__', action.replace(/'/g, "''")).replace('__PAYLOAD__', encoded)
}
