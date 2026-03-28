import {spawnSync} from 'node:child_process';

function buildPowerShellPathLiteral(filePath) {
  return `'${filePath.replace(/'/g, "''")}'`;
}

export function inspectPngSampleStats(imagePath) {
  const script = `
$ErrorActionPreference = 'Stop'
$path = ${buildPowerShellPathLiteral(imagePath)}
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new($path)
try {
  $stepX = [Math]::Max(1, [int]($bitmap.Width / 40))
  $stepY = [Math]::Max(1, [int]($bitmap.Height / 40))
  $sampleCount = 0
  $transparentSamples = 0
  $opaqueSamples = 0
  $alphaSum = 0
  $colors = [System.Collections.Generic.HashSet[string]]::new()
  for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
    for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
      $pixel = $bitmap.GetPixel($x, $y)
      $sampleCount += 1
      $alphaSum += $pixel.A
      if ($pixel.A -eq 0) {
        $transparentSamples += 1
      }
      if ($pixel.A -ge 250) {
        $opaqueSamples += 1
      }
      [void]$colors.Add("$($pixel.R),$($pixel.G),$($pixel.B),$($pixel.A)")
    }
  }
  @{
    width = $bitmap.Width
    height = $bitmap.Height
    sampleCount = $sampleCount
    transparentSamples = $transparentSamples
    opaqueSamples = $opaqueSamples
    distinctSampleCount = $colors.Count
    averageAlpha = if ($sampleCount -gt 0) { [Math]::Round($alphaSum / $sampleCount, 2) } else { 0 }
  } | ConvertTo-Json -Compress
}
finally {
  $bitmap.Dispose()
}
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {encoding: 'utf8'},
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `Unable to inspect PNG capture '${imagePath}'. ${stderr || stdout || 'PowerShell exited with a non-zero status.'}`,
    );
  }

  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Unable to parse PNG inspection output for '${imagePath}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertPngCaptureLooksOpaque(imagePath, scopeLabel) {
  const stats = inspectPngSampleStats(imagePath);
  if (!Number.isFinite(stats.width) || !Number.isFinite(stats.height) || stats.width <= 0 || stats.height <= 0) {
    throw new Error(`${scopeLabel} produced an invalid PNG image size.`);
  }

  if (!Number.isFinite(stats.sampleCount) || stats.sampleCount <= 0) {
    throw new Error(`${scopeLabel} produced an unreadable PNG sample grid.`);
  }

  if (!Number.isFinite(stats.averageAlpha) || stats.averageAlpha < 200) {
    throw new Error(
      `${scopeLabel} produced a PNG whose sampled alpha stayed too low (averageAlpha=${stats.averageAlpha}).`,
    );
  }

  if (!Number.isFinite(stats.opaqueSamples) || stats.opaqueSamples < Math.ceil(stats.sampleCount * 0.9)) {
    throw new Error(
      `${scopeLabel} produced a PNG whose sampled alpha was not predominantly opaque (opaqueSamples=${stats.opaqueSamples}/${stats.sampleCount}).`,
    );
  }

  if (!Number.isFinite(stats.distinctSampleCount) || stats.distinctSampleCount < 4) {
    throw new Error(
      `${scopeLabel} produced a PNG with too little sampled color variation (distinctSampleCount=${stats.distinctSampleCount}).`,
    );
  }

  return stats;
}
