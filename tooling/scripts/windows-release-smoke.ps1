Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$workspaceRoot = Split-Path $repoRoot -Parent
$frontendRoot = Join-Path $workspaceRoot 'opapp-frontend'
$frontendBundleRoot = Join-Path $frontendRoot '.dist\bundles\companion-app\windows'
$hostRoot = Join-Path $repoRoot 'hosts\windows-host'
$hostBundleRoot = Join-Path $hostRoot 'windows\OpappWindowsHost\Bundle'
$logPath = Join-Path $env:TEMP 'opapp-windows-host.log'
$cliPath = Join-Path $hostRoot 'node_modules\@react-native-community\cli\build\bin.js'
$successMarkers = @(
  'InstanceLoaded failed=false',
  'NativeLogger[1] Running "OpappWindowsHost"',
  'NativeLogger[1] [frontend-companion] render',
  'NativeLogger[1] [frontend-companion] mounted'
)
$failureMarkers = @(
  'InstanceLoaded failed=true',
  'RedBox.ShowNewError',
  'RedBox.Message=',
  'NativeLogger[3]'
)

Write-Host "[smoke] repoRoot=$repoRoot"
Write-Host "[smoke] frontendRoot=$frontendRoot"
Write-Host "[smoke] hostRoot=$hostRoot"
Write-Host "[smoke] hostBundleRoot=$hostBundleRoot"
Write-Host "[smoke] logPath=$logPath"
Write-Host "[smoke] cliPath=$cliPath"

if (-not (Test-Path $frontendRoot)) {
  throw "Frontend repo not found at $frontendRoot"
}

Get-Process OpappWindowsHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

Push-Location $frontendRoot
try {
  Write-Host '[smoke] bundling frontend Windows artifact'
  $env:COREPACK_HOME = 'D:\code\opappdev\.corepack'
  $env:PNPM_HOME = 'D:\code\opappdev\.pnpm'
  $env:TEMP = 'D:\code\opappdev\.tmp'
  $env:TMP = 'D:\code\opappdev\.tmp'
  $env:npm_config_cache = 'D:\code\opappdev\.npm-cache'
  & corepack pnpm bundle:companion:windows
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend bundle failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path $frontendBundleRoot)) {
  throw "Expected frontend bundle output at $frontendBundleRoot"
}

Write-Host '[smoke] staging frontend bundle into native host project'
Remove-Item $hostBundleRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $hostBundleRoot -Force | Out-Null
Copy-Item (Join-Path $frontendBundleRoot '*') $hostBundleRoot -Recurse -Force

Push-Location $hostRoot
try {
  Write-Host '[smoke] building packaged release app'
  & node $cliPath run-windows --release --no-packager --no-launch --logging --no-telemetry
  if ($LASTEXITCODE -ne 0) {
    throw "Release build failed with exit code $LASTEXITCODE"
  }

  Write-Host '[smoke] launching packaged release app'
  & node $cliPath run-windows --release --no-build --no-packager --logging --no-telemetry
  if ($LASTEXITCODE -ne 0) {
    throw "Release launch failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1

  if (-not (Test-Path $logPath)) {
    continue
  }

  $log = Get-Content $logPath -Raw

  foreach ($failureMarker in $failureMarkers) {
    if ($log.Contains($failureMarker)) {
      Write-Host '[smoke] failure log tail:'
      Get-Content $logPath -Tail 120
      throw "Windows release smoke failed: found '$failureMarker'"
    }
  }

  $allSuccessMarkersPresent = $true
  foreach ($successMarker in $successMarkers) {
    if (-not $log.Contains($successMarker)) {
      $allSuccessMarkersPresent = $false
      break
    }
  }

  if ($allSuccessMarkersPresent) {
    Write-Host '[smoke] success log tail:'
    Get-Content $logPath -Tail 80
    exit 0
  }
}

if (Test-Path $logPath) {
  Write-Host '[smoke] timeout log tail:'
  Get-Content $logPath -Tail 120
}

throw 'Windows release smoke timed out before all success markers appeared.'
