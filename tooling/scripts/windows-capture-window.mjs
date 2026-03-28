import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {parsePositiveIntegerArg} from './windows-args-common.mjs';
import {assertPngCaptureLooksOpaque} from './windows-image-inspection.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const tempRoot = process.env.TEMP || process.env.TMP || path.join(workspaceRoot, '.tmp');
const defaultOutputDir = path.join(tempRoot, 'OPApp', 'window-capture');
const wgcProjectPath = path.join(
  repoRoot,
  'tooling',
  'dotnet',
  'window-capture-wgc',
  'window-capture-wgc.csproj',
);

function printUsage() {
  console.log(`Usage:
  node ./tooling/scripts/windows-capture-window.mjs [selector] [options]

Selector:
  --foreground                    capture the current foreground top-level window
  --handle=<decimal|0xhex>        capture a specific top-level window handle
  --process-name=<name>           match process name (case-insensitive)
  --title-contains=<text>         match window title substring (case-insensitive)
  --title-exact=<text>            match window title exactly (case-insensitive)
  --class-name=<name>             match window class name (case-insensitive)

Options:
  --list                          list matching visible windows instead of capturing
  --activate                      restore + foreground the target window before capture
  --delay-ms=<ms>                 wait after activation (default: 400)
  --backend=auto|copy-screen|wgc  capture backend (default: auto; window => wgc)
  --region=client|window|monitor  capture client area, full window, or owning monitor (default: client)
  --format=png|jpg                output image format (default: png)
  --timeout-ms=<ms>               WGC frame wait timeout when backend=wgc (default: 5000)
  --include-cursor                include the cursor when backend=wgc
  --out=<absolute-or-relative>    explicit output path
  --inspect                       validate PNG opacity/content after capture
  --no-inspect                    skip PNG inspection
  --json                          print machine-readable JSON only
  --help                          show this help

Examples:
  npm run capture:windows:window -- --process-name=HeavenBurnsRed --region=window
  npm run capture:windows:window -- --foreground --region=window --format=jpg
  npm run capture:windows:window -- --process-name=HeavenBurnsRed --region=monitor --activate
  npm run capture:windows:window -- --process-name=HeavenBurnsRed --list
`);
}

function readValueArg(flagName) {
  const argument = process.argv.find(entry => entry.startsWith(`${flagName}=`));
  if (!argument) {
    return null;
  }

  return argument.slice(flagName.length + 1).trim() || null;
}

function readEnumArg(flagName, supportedValues, defaultValue) {
  const rawValue = readValueArg(flagName);
  if (!rawValue) {
    return defaultValue;
  }

  if (!supportedValues.includes(rawValue)) {
    throw new Error(
      `${flagName} must be one of ${supportedValues.join(', ')}, got "${rawValue}".`,
    );
  }

  return rawValue;
}

function readHandleArg() {
  const rawValue = readValueArg('--handle');
  if (!rawValue) {
    return null;
  }

  const parsedValue = rawValue.startsWith('0x')
    ? Number.parseInt(rawValue.slice(2), 16)
    : Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`--handle must be a positive decimal or 0x-prefixed hex number, got "${rawValue}".`);
  }

  return parsedValue;
}

function sanitizeFileStem(value) {
  const sanitized = value
    .replace(/[^0-9A-Za-z._ -]+/g, '-')
    .replace(/[ .]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  return sanitized || 'window-capture';
}

function buildDefaultOutputPath({processName, titleExact, titleContains, format}) {
  const date = new Date();
  const timestamp = [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, '0'),
    `${date.getDate()}`.padStart(2, '0'),
  ].join('') + `-${`${date.getHours()}`.padStart(2, '0')}${`${date.getMinutes()}`.padStart(2, '0')}${`${date.getSeconds()}`.padStart(2, '0')}`;
  const hint = processName || titleExact || titleContains || 'foreground-window';
  return path.join(defaultOutputDir, `${sanitizeFileStem(hint)}-${timestamp}.${format}`);
}

function buildSelectorOrThrow() {
  const selector = {
    foreground: process.argv.includes('--foreground'),
    handle: readHandleArg(),
    processName: readValueArg('--process-name'),
    titleContains: readValueArg('--title-contains'),
    titleExact: readValueArg('--title-exact'),
    className: readValueArg('--class-name'),
  };

  if (
    !selector.foreground &&
    !selector.handle &&
    !selector.processName &&
    !selector.titleContains &&
    !selector.titleExact &&
    !selector.className
  ) {
    throw new Error(
      'Provide at least one window selector (--foreground, --handle, --process-name, --title-contains, --title-exact, or --class-name).',
    );
  }

  return selector;
}

function createPowerShellScript() {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OpappWindowCaptureNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
}
"@
Add-Type -AssemblyName System.Drawing

function Convert-RectToObject {
  param([int]$Left, [int]$Top, [int]$Right, [int]$Bottom)
  [pscustomobject]@{
    left = $Left
    top = $Top
    right = $Right
    bottom = $Bottom
    width = $Right - $Left
    height = $Bottom - $Top
  }
}

function Convert-ClientRectToScreenRect {
  param([intptr]$Handle)
  $clientRect = New-Object OpappWindowCaptureNative+RECT
  if (-not [OpappWindowCaptureNative]::GetClientRect($Handle, [ref]$clientRect)) {
    return $null
  }

  $topLeft = New-Object OpappWindowCaptureNative+POINT
  $topLeft.X = $clientRect.Left
  $topLeft.Y = $clientRect.Top
  $bottomRight = New-Object OpappWindowCaptureNative+POINT
  $bottomRight.X = $clientRect.Right
  $bottomRight.Y = $clientRect.Bottom

  if (-not [OpappWindowCaptureNative]::ClientToScreen($Handle, [ref]$topLeft)) {
    return $null
  }
  if (-not [OpappWindowCaptureNative]::ClientToScreen($Handle, [ref]$bottomRight)) {
    return $null
  }

  return Convert-RectToObject -Left $topLeft.X -Top $topLeft.Y -Right $bottomRight.X -Bottom $bottomRight.Y
}

function Convert-MonitorRect {
  param([intptr]$Handle)
  $monitorHandle = [OpappWindowCaptureNative]::MonitorFromWindow($Handle, 2)
  if ($monitorHandle -eq [intptr]::Zero) {
    return $null
  }

  $monitorInfo = New-Object OpappWindowCaptureNative+MONITORINFOEX
  $monitorInfo.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'OpappWindowCaptureNative+MONITORINFOEX')
  if (-not [OpappWindowCaptureNative]::GetMonitorInfo($monitorHandle, [ref]$monitorInfo)) {
    return $null
  }

  return Convert-RectToObject -Left $monitorInfo.rcMonitor.Left -Top $monitorInfo.rcMonitor.Top -Right $monitorInfo.rcMonitor.Right -Bottom $monitorInfo.rcMonitor.Bottom
}

function Get-VisibleTopLevelWindows {
  param([pscustomobject]$Selector)

  $foregroundWindow = [OpappWindowCaptureNative]::GetAncestor([OpappWindowCaptureNative]::GetForegroundWindow(), 2)
  $items = [System.Collections.Generic.List[object]]::new()

  [OpappWindowCaptureNative]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [OpappWindowCaptureNative]::IsWindowVisible($hWnd)) {
      return $true
    }

    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][OpappWindowCaptureNative]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) {
      return $true
    }

    $classBuilder = New-Object System.Text.StringBuilder 256
    [void][OpappWindowCaptureNative]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)

    [uint32]$processId = 0
    [void][OpappWindowCaptureNative]::GetWindowThreadProcessId($hWnd, [ref]$processId)
    if ($processId -eq 0) {
      return $true
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      return $true
    }

    $windowRect = New-Object OpappWindowCaptureNative+RECT
    if (-not [OpappWindowCaptureNative]::GetWindowRect($hWnd, [ref]$windowRect)) {
      return $true
    }

    $windowRectObject = Convert-RectToObject -Left $windowRect.Left -Top $windowRect.Top -Right $windowRect.Right -Bottom $windowRect.Bottom
    $clientRectObject = Convert-ClientRectToScreenRect -Handle $hWnd
    $monitorRectObject = Convert-MonitorRect -Handle $hWnd
    $windowArea = [Math]::Max(0, $windowRectObject.width) * [Math]::Max(0, $windowRectObject.height)

    $items.Add([pscustomobject]@{
      handle = [int64]$hWnd
      handleHex = ('0x{0:X}' -f ([int64]$hWnd))
      processId = [int]$processId
      processName = [string]$process.ProcessName
      title = [string]$title
      className = [string]$classBuilder.ToString()
      isForeground = ([int64]$foregroundWindow -eq [int64]$hWnd)
      isMinimized = [bool][OpappWindowCaptureNative]::IsIconic($hWnd)
      windowArea = [int64]$windowArea
      windowRect = $windowRectObject
      clientRect = $clientRectObject
      monitorRect = $monitorRectObject
    }) | Out-Null
    return $true
  }, [IntPtr]::Zero) | Out-Null

  $filtered = $items

  if ($Selector.handle) {
    $filtered = $filtered | Where-Object { $_.handle -eq [int64]$Selector.handle }
  }
  if ($Selector.processName) {
    $needle = [string]$Selector.processName
    $filtered = $filtered | Where-Object { $_.processName -and $_.processName.Equals($needle, [System.StringComparison]::OrdinalIgnoreCase) }
  }
  if ($Selector.titleContains) {
    $needle = [string]$Selector.titleContains
    $filtered = $filtered | Where-Object { $_.title -and $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
  }
  if ($Selector.titleExact) {
    $needle = [string]$Selector.titleExact
    $filtered = $filtered | Where-Object { $_.title -and $_.title.Equals($needle, [System.StringComparison]::OrdinalIgnoreCase) }
  }
  if ($Selector.className) {
    $needle = [string]$Selector.className
    $filtered = $filtered | Where-Object { $_.className -and $_.className.Equals($needle, [System.StringComparison]::OrdinalIgnoreCase) }
  }
  if ($Selector.foreground) {
    $filtered = $filtered | Where-Object { $_.isForeground }
  }

  return @($filtered | Sort-Object -Property @(
    @{Expression = { if ($_.isForeground) { 0 } else { 1 } }; Ascending = $true},
    @{Expression = { if ($_.isMinimized) { 1 } else { 0 } }; Ascending = $true},
    @{Expression = { $_.windowArea }; Descending = $true},
    @{Expression = { $_.title }; Ascending = $true}
  ))
}

$payload = $env:OPAPP_WINDOW_CAPTURE_PAYLOAD | ConvertFrom-Json
$matches = Get-VisibleTopLevelWindows -Selector $payload.selector

if ($payload.listOnly) {
  @($matches) | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if ($matches.Count -eq 0) {
  throw 'No visible top-level window matched the requested selector.'
}

$target = $matches[0]
$targetHandle = [intptr]$target.handle

$activationRequested = [bool]$payload.activate
if ($activationRequested) {
  [void][OpappWindowCaptureNative]::ShowWindowAsync($targetHandle, 9)
  [void][OpappWindowCaptureNative]::BringWindowToTop($targetHandle)
  [void][OpappWindowCaptureNative]::SetForegroundWindow($targetHandle)
  Start-Sleep -Milliseconds ([int]$payload.activationDelayMs)
  $matches = Get-VisibleTopLevelWindows -Selector $payload.selector
  if ($matches.Count -gt 0) {
    $target = $matches[0]
  }
}

$captureRect = switch ($payload.region) {
  'window' { $target.windowRect; break }
  'monitor' { $target.monitorRect; break }
  default { $target.clientRect; break }
}
if ($null -eq $captureRect) {
  throw 'Unable to resolve the requested capture rectangle.'
}
if ($captureRect.width -le 0 -or $captureRect.height -le 0) {
  throw 'Requested capture rectangle is empty.'
}

if ($payload.selectOnly) {
  [pscustomobject]@{
    outputPath = $payload.outputPath
    format = $payload.format
    region = $payload.region
    activate = $activationRequested
    activationDelayMs = [int]$payload.activationDelayMs
    matchedCount = [int]@($matches).Count
    selectedWindow = $target
    captureRect = $captureRect
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

$directory = [System.IO.Path]::GetDirectoryName($payload.outputPath)
if ([string]::IsNullOrWhiteSpace($directory)) {
  throw 'Unable to resolve the capture output directory.'
}
[System.IO.Directory]::CreateDirectory($directory) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap $captureRect.width, $captureRect.height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen(
    $captureRect.left,
    $captureRect.top,
    0,
    0,
    $bitmap.Size,
    [System.Drawing.CopyPixelOperation]::SourceCopy
  )

  if ($payload.format -eq 'jpg') {
    $bitmap.Save($payload.outputPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } else {
    $bitmap.Save($payload.outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

[pscustomobject]@{
  outputPath = $payload.outputPath
  format = $payload.format
  region = $payload.region
  activate = $activationRequested
  activationDelayMs = [int]$payload.activationDelayMs
  matchedCount = [int]@($matches).Count
  selectedWindow = $target
  captureRect = $captureRect
} | ConvertTo-Json -Depth 8 -Compress
`;
}

function normalizeOutputPath(outputPath) {
  if (!outputPath) {
    return null;
  }

  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }

  return path.resolve(process.cwd(), outputPath);
}

function parseJsonOutputOrThrow(stdout, context) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${context} did not return any structured output.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }

  throw new Error(`${context} did not return parseable JSON. Raw output:\n${trimmed}`);
}

function runPowerShellCaptureOrThrow(payload) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', createPowerShellScript()],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        OPAPP_WINDOW_CAPTURE_PAYLOAD: JSON.stringify(payload),
      },
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || 'PowerShell exited with a non-zero status.';
    throw new Error(`Windows window capture failed. ${detail}`);
  }

  return parseJsonOutputOrThrow(result.stdout, 'Windows window capture');
}

function runWgcCaptureOrThrow({handle, outputPath, format, timeoutMs, includeCursor}) {
  const args = [
    'run',
    '--project',
    wgcProjectPath,
    '--',
    `--handle=${handle}`,
    `--out=${outputPath}`,
    `--format=${format}`,
    `--timeout-ms=${timeoutMs}`,
  ];
  if (includeCursor) {
    args.push('--include-cursor');
  }

  const result = spawnSync('dotnet', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      'dotnet window-capture-wgc exited with a non-zero status.';
    throw new Error(`Windows.Graphics.Capture failed. ${detail}`);
  }

  return parseJsonOutputOrThrow(result.stdout, 'Windows.Graphics.Capture helper');
}

function formatRect(rect) {
  if (!rect) {
    return '<unavailable>';
  }

  return `${rect.left},${rect.top} -> ${rect.right},${rect.bottom} (${rect.width}x${rect.height})`;
}

async function main() {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const listOnly = process.argv.includes('--list');
  const jsonOnly = process.argv.includes('--json');
  const activate = process.argv.includes('--activate');
  const format = readEnumArg('--format', ['png', 'jpg'], 'png');
  const region = readEnumArg('--region', ['client', 'window', 'monitor'], 'client');
  const requestedBackend = readEnumArg('--backend', ['auto', 'copy-screen', 'wgc'], 'auto');
  const selector = buildSelectorOrThrow();
  const activationDelayMs = parsePositiveIntegerArg(process.argv, '--delay-ms', 400);
  const timeoutMs = parsePositiveIntegerArg(process.argv, '--timeout-ms', 5000);
  const includeCursor = process.argv.includes('--include-cursor');
  const inspectRequested = process.argv.includes('--inspect');
  const inspectSkipped = process.argv.includes('--no-inspect');
  const inspectPng = !listOnly && format === 'png' && (inspectRequested || !inspectSkipped);
  const backend = requestedBackend === 'auto'
    ? (region === 'window' ? 'wgc' : 'copy-screen')
    : requestedBackend;

  if (!listOnly && backend === 'wgc' && region !== 'window') {
    throw new Error(
      'The WGC backend currently supports only --region=window. Use --backend=copy-screen for client or monitor captures.',
    );
  }

  const explicitOutputPath = normalizeOutputPath(readValueArg('--out'));
  const outputPath = listOnly
    ? null
    : explicitOutputPath ??
      buildDefaultOutputPath({
        processName: selector.processName,
        titleExact: selector.titleExact,
        titleContains: selector.titleContains,
        format,
      });

  if (outputPath) {
    await mkdir(path.dirname(outputPath), {recursive: true});
  }

  const payload = {
    selector,
    listOnly,
    activate,
    activationDelayMs,
    region,
    format,
    outputPath,
    selectOnly: !listOnly && backend === 'wgc',
  };

  const selectionResult = runPowerShellCaptureOrThrow(payload);

  if (listOnly) {
    const items = Array.isArray(selectionResult)
      ? selectionResult
      : selectionResult && typeof selectionResult === 'object'
        ? [selectionResult]
        : [];

    if (jsonOnly) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log('No visible top-level windows matched the selector.');
      return;
    }

    console.log(`Matched ${items.length} visible top-level window(s):`);
    for (const item of items) {
      console.log(
        `- ${item.handleHex} ${item.processName} "${item.title}" class=${item.className} foreground=${item.isForeground} minimized=${item.isMinimized}`,
      );
    }
    return;
  }

  const helperResult = backend === 'wgc'
    ? runWgcCaptureOrThrow({
        handle: selectionResult.selectedWindow.handleHex,
        outputPath,
        format,
        timeoutMs,
        includeCursor,
      })
    : null;

  const parsed = backend === 'wgc'
    ? {
        ...selectionResult,
        ...helperResult,
        outputPath: helperResult.outputPath,
        format: helperResult.format,
        region,
        backend,
        requestedBackend,
        captureSize: {
          width: helperResult.itemWidth,
          height: helperResult.itemHeight,
        },
      }
    : {
        ...selectionResult,
        backend,
        requestedBackend,
        captureSize: selectionResult.captureRect
          ? {
              width: selectionResult.captureRect.width,
              height: selectionResult.captureRect.height,
            }
          : null,
      };

  let inspectionStats = null;
  if (inspectPng) {
    inspectionStats = assertPngCaptureLooksOpaque(
      parsed.outputPath,
      'Windows target-window capture',
    );
  }

  const visibilityWarning =
    backend === 'copy-screen' &&
    !activate &&
    parsed?.selectedWindow &&
    parsed.selectedWindow.isForeground === false
      ? 'Target window was not foreground. This capture copied the currently visible desktop pixels in that region, so occlusion or overlap can leak into the result. Use --activate or manually bring the window to the front for a reliable target-window capture.'
      : null;

  if (jsonOnly) {
    console.log(
      JSON.stringify(
        {
          ...parsed,
          inspectionStats,
          visibilityWarning,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Captured ${parsed.selectedWindow.processName} "${parsed.selectedWindow.title}"`);
  console.log(`Handle: ${parsed.selectedWindow.handleHex}`);
  console.log(`Class: ${parsed.selectedWindow.className}`);
  console.log(`Backend: ${parsed.backend}`);
  console.log(`Region: ${parsed.region}`);
  console.log(`Capture rect: ${formatRect(parsed.captureRect)}`);
  if (parsed.captureSize) {
    console.log(`Capture size: ${parsed.captureSize.width}x${parsed.captureSize.height}`);
  }
  console.log(`Output: ${parsed.outputPath}`);
  if (inspectionStats) {
    console.log(
      `Inspection: opaque=${inspectionStats.opaqueSamples}/${inspectionStats.sampleCount} distinct=${inspectionStats.distinctSampleCount} averageAlpha=${inspectionStats.averageAlpha}`,
    );
  }
  if (visibilityWarning) {
    console.log(`Warning: ${visibilityWarning}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
