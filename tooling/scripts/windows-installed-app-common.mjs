import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function escapePowerShellSingleQuotedString(value) {
  return String(value).replace(/'/g, "''");
}

function runPowerShell(command, {cwd} = {}) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

export function getInstalledPackageFamilyNameOrThrow({
  packageName,
  cwd,
  missingPackageMessage,
}) {
  const result = runPowerShell(
    `(Get-AppxPackage -Name '${escapePowerShellSingleQuotedString(packageName)}' | Select-Object -First 1 -ExpandProperty PackageFamilyName)`,
    {cwd},
  );
  const packageFamilyName = (result.stdout ?? '').trim();

  if (result.status !== 0 || !packageFamilyName) {
    const detail = (result.stderr ?? '').trim();
    const message = missingPackageMessage ?? `Could not resolve PackageFamilyName for ${packageName}.`;
    throw new Error(detail ? `${message} ${detail}` : message);
  }

  return packageFamilyName;
}

export function resolveInstalledPackageLogPathCandidates({
  packageName,
  fileName = 'opapp-windows-host.log',
} = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = candidatePath => {
    if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
      return;
    }

    const normalizedPath = path.normalize(candidatePath);
    const dedupeKey = process.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    candidates.push(normalizedPath);
  };

  addCandidate(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), fileName));

  if (typeof packageName !== 'string' || packageName.length === 0) {
    return candidates;
  }

  const localAppDataRoot = process.env.LOCALAPPDATA;
  if (!localAppDataRoot) {
    return candidates;
  }

  const packagesRoot = path.join(localAppDataRoot, 'Packages');
  try {
    for (const entry of fs.readdirSync(packagesRoot, {withFileTypes: true})) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${packageName}_`)) {
        continue;
      }

      addCandidate(path.join(packagesRoot, entry.name, 'LocalCache', fileName));
      addCandidate(path.join(packagesRoot, entry.name, 'TempState', fileName));
    }
  } catch {
    // Best-effort lookup only; fall back to the user temp log path.
  }

  return candidates;
}

export function launchInstalledAppOrThrow({
  packageName,
  applicationId,
  cwd,
  missingPackageMessage,
  launchFailureMessage,
}) {
  const packageFamilyName = getInstalledPackageFamilyNameOrThrow({
    packageName,
    cwd,
    missingPackageMessage,
  });
  const appUserModelId = `${packageFamilyName}!${applicationId}`;
  const shellTarget = `shell:AppsFolder\\${appUserModelId}`;
  const result = runPowerShell(
    `Start-Process '${escapePowerShellSingleQuotedString(shellTarget)}'`,
    {cwd},
  );

  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    const message =
      launchFailureMessage ?? `Could not launch installed app ${appUserModelId}.`;
    throw new Error(detail ? `${message} ${detail}` : message);
  }

  return {
    packageFamilyName,
    appUserModelId,
    shellTarget,
  };
}
