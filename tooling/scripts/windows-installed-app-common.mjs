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
