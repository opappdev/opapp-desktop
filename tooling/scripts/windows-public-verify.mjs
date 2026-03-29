import {spawn, spawnSync} from 'node:child_process';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const frontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const verifyScriptPath = path.join(repoRoot, 'tooling', 'scripts', 'verify-windows.mjs');
const verifyScenarioFilter = 'launcher-provenance';
const publicVerifyScenarioTimeoutMs = 40_000;
const frontendPublicVerifyContractChecks = [
  {
    filePath: path.join(frontendRoot, 'framework', 'windowing', 'src', 'index.ts'),
    markers: ['getCachedOtaRemoteCatalog', 'CachedOtaRemoteCatalogSnapshot'],
  },
  {
    filePath: path.join(frontendRoot, 'apps', 'companion-app', 'src', 'BundleLauncherScreen.tsx'),
    markers: [
      'getCachedOtaRemoteCatalog',
      'bundle-launcher.remote-catalog.summary',
      'cachedRemoteUrl === normalizedRemoteUrl',
    ],
  },
];
const launcherProvenanceFixture = {
  mainBundleId: 'opapp.companion.main',
  mainSurfaceIds: [
    'companion.main',
    'companion.settings',
    'companion.view-shot',
    'companion.window-capture',
  ],
  nativeApplied: {
    bundleId: 'opapp.hbr.workspace',
    version: '0.9.2',
    surfaceIds: ['hbr.challenge-advisor'],
  },
  versionDrift: {
    bundleId: 'opapp.hbr.archive',
    versions: ['0.8.0', '0.9.0'],
    latestVersion: '0.9.0',
    surfaceIds: ['hbr.archive-advisor'],
  },
};

function log(message) {
  console.log(`[windows-public-verify] ${message}`);
}

async function assertFrontendPublicVerifyContract() {
  for (const {filePath, markers} of frontendPublicVerifyContractChecks) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? error.message
          : String(error);
      throw new Error(
        `Windows public verify requires a readable opapp-frontend checkout, but could not read ${filePath}: ${reason}`,
      );
    }

    for (const marker of markers) {
      if (!content.includes(marker)) {
        throw new Error(
          `Windows public verify requires an opapp-frontend checkout with the launcher cache bridge contract. Missing marker '${marker}' in ${filePath}. Update the checkout or pin tooling/config/opapp-frontend-ref.txt (or OPAPP_FRONTEND_REF) to a compatible frontend ref.`,
        );
      }
    }
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function writeSyntheticRemoteBundle({
  registryRoot,
  bundleId,
  sourceKind = 'windows-public-verify-fixture',
  surfaces,
  version,
}) {
  const artifactRoot = path.join(registryRoot, bundleId, version, 'windows');
  const entryFile = 'bundle.js';
  await mkdir(artifactRoot, {recursive: true});
  await writeFile(
    path.join(artifactRoot, entryFile),
    `// synthetic public verify bundle: ${bundleId}@${version}\n`,
    'utf8',
  );
  await writeJsonFile(path.join(artifactRoot, 'bundle-manifest.json'), {
    bundleId,
    version,
    platform: 'windows',
    entryFile,
    surfaces,
    sourceKind,
  });
}

async function startRegistryServer(registryRoot) {
  return await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = path.join(
        registryRoot,
        ...requestPath.split('/').filter(Boolean),
      );
      try {
        const content = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': filePath.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(content);
      } catch {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Registry server did not expose a numeric port.'));
          return;
        }

        resolve({
          server,
          baseUrl: `http://127.0.0.1:${address.port}`,
        });
      } catch (error) {
        reject(error);
      }
    });

    server.on('error', reject);
  });
}

async function closeRegistryServer(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve(undefined);
    });
  });
}

async function createRegistryFixtureRoot() {
  const registryRoot = path.join(
    tmpdir(),
    `opapp-windows-public-verify-${Date.now()}`,
  );
  const frontendPackageJson = JSON.parse(
    await readFile(path.join(frontendRoot, 'package.json'), 'utf8'),
  );
  const mainVersion = frontendPackageJson.version;
  if (typeof mainVersion !== 'string' || !mainVersion) {
    throw new Error('Could not resolve opapp-frontend package version.');
  }

  await writeSyntheticRemoteBundle({
    registryRoot,
    bundleId: launcherProvenanceFixture.mainBundleId,
    surfaces: launcherProvenanceFixture.mainSurfaceIds,
    version: mainVersion,
  });
  await writeSyntheticRemoteBundle({
    registryRoot,
    bundleId: launcherProvenanceFixture.nativeApplied.bundleId,
    surfaces: launcherProvenanceFixture.nativeApplied.surfaceIds,
    version: launcherProvenanceFixture.nativeApplied.version,
  });
  await writeSyntheticRemoteBundle({
    registryRoot,
    bundleId: launcherProvenanceFixture.versionDrift.bundleId,
    surfaces: launcherProvenanceFixture.versionDrift.surfaceIds,
    version: launcherProvenanceFixture.versionDrift.latestVersion,
  });
  await writeJsonFile(path.join(registryRoot, 'index.json'), {
    bundles: {
      [launcherProvenanceFixture.mainBundleId]: {
        latestVersion: mainVersion,
        versions: [mainVersion],
        channels: {
          stable: mainVersion,
        },
      },
      [launcherProvenanceFixture.nativeApplied.bundleId]: {
        latestVersion: launcherProvenanceFixture.nativeApplied.version,
        versions: [launcherProvenanceFixture.nativeApplied.version],
        channels: {
          stable: launcherProvenanceFixture.nativeApplied.version,
        },
      },
      [launcherProvenanceFixture.versionDrift.bundleId]: {
        latestVersion: launcherProvenanceFixture.versionDrift.latestVersion,
        versions: launcherProvenanceFixture.versionDrift.versions,
        channels: {
          stable: launcherProvenanceFixture.versionDrift.latestVersion,
        },
      },
    },
  });

  return registryRoot;
}

async function runVerify(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifyScriptPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    });

    child.once('error', reject);
    child.once('exit', status => {
      if (status !== 0) {
        reject(
          new Error(
            `verify-windows exited with status ${status ?? 1} for args: ${args.join(' ')}`,
          ),
        );
        return;
      }

      resolve(undefined);
    });
  });
}

function runPowerShellOrThrow(commandText) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      commandText,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `PowerShell exited with status ${result.status ?? 1} while preparing Windows public verify.`,
    );
  }
}

async function resolveWindowsAppRuntimeVersion() {
  const packagesLockPath = path.join(
    repoRoot,
    'hosts',
    'windows-host',
    'windows',
    'OpappWindowsHost',
    'packages.lock.json',
  );
  const packagesLock = JSON.parse(await readFile(packagesLockPath, 'utf8'));
  const dependencySections = Object.values(packagesLock.dependencies ?? {});

  for (const section of dependencySections) {
    const runtimePackage = section?.['Microsoft.WindowsAppSDK.Runtime'];
    if (typeof runtimePackage?.resolved === 'string' && runtimePackage.resolved) {
      return runtimePackage.resolved;
    }
  }

  throw new Error(
    `Could not resolve Microsoft.WindowsAppSDK.Runtime from ${packagesLockPath}.`,
  );
}

function resolveNugetPackagesRoot() {
  const configuredRoot = process.env.NUGET_PACKAGES?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, '.nuget', 'packages');
  }

  throw new Error(
    'Could not resolve the NuGet global-packages folder. Set NUGET_PACKAGES or USERPROFILE before running Windows public verify.',
  );
}

function resolvePortableRuntimePackageDirSpecs() {
  switch (process.arch) {
    case 'x64':
      return [
        {
          packageDirName: 'win10-x86',
          requiredPatterns: [
            {
              label: 'framework-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.\d+\.\d+\.msix$/,
            },
            {
              label: 'ddlm-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.DDLM\.\d+\.\d+\.msix$/,
            },
          ],
        },
        {
          packageDirName: 'win10-x64',
          requiredPatterns: [
            {
              label: 'framework-x64',
              pattern: /^Microsoft\.WindowsAppRuntime\.\d+\.\d+\.msix$/,
            },
            {
              label: 'ddlm-x64',
              pattern: /^Microsoft\.WindowsAppRuntime\.DDLM\.\d+\.\d+\.msix$/,
            },
            {
              label: 'main-x64',
              pattern: /^Microsoft\.WindowsAppRuntime\.Main\.\d+\.\d+\.msix$/,
            },
            {
              label: 'singleton-x64',
              pattern: /^Microsoft\.WindowsAppRuntime\.Singleton\.\d+\.\d+\.msix$/,
            },
          ],
        },
      ];
    case 'ia32':
      return [
        {
          packageDirName: 'win10-x86',
          requiredPatterns: [
            {
              label: 'framework-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.\d+\.\d+\.msix$/,
            },
            {
              label: 'ddlm-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.DDLM\.\d+\.\d+\.msix$/,
            },
            {
              label: 'main-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.Main\.\d+\.\d+\.msix$/,
            },
            {
              label: 'singleton-x86',
              pattern: /^Microsoft\.WindowsAppRuntime\.Singleton\.\d+\.\d+\.msix$/,
            },
          ],
        },
      ];
    case 'arm64':
      return [
        {
          packageDirName: 'win10-arm64',
          requiredPatterns: [
            {
              label: 'framework-arm64',
              pattern: /^Microsoft\.WindowsAppRuntime\.\d+\.\d+\.msix$/,
            },
            {
              label: 'ddlm-arm64',
              pattern: /^Microsoft\.WindowsAppRuntime\.DDLM\.\d+\.\d+\.msix$/,
            },
            {
              label: 'main-arm64',
              pattern: /^Microsoft\.WindowsAppRuntime\.Main\.\d+\.\d+\.msix$/,
            },
            {
              label: 'singleton-arm64',
              pattern: /^Microsoft\.WindowsAppRuntime\.Singleton\.\d+\.\d+\.msix$/,
            },
          ],
        },
      ];
    default:
      throw new Error(
        `Unsupported process.arch '${process.arch}' for Windows App Runtime installation.`,
      );
  }
}

async function readPortableRuntimePackageSpecs({
  runtimePackageRoot,
  packageDirName,
  requiredPatterns,
}) {
  const packageDir = path.join(runtimePackageRoot, 'tools', 'MSIX', packageDirName);
  const inventoryPath = path.join(packageDir, 'MSIX.inventory');
  const inventoryContent = await readFile(inventoryPath, 'utf8');
  const inventoryEntries = inventoryContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) {
        throw new Error(
          `Invalid MSIX inventory entry '${line}' in ${inventoryPath}.`,
        );
      }

      return {
        fileName: line.slice(0, separatorIndex),
        packageFullName: line.slice(separatorIndex + 1),
      };
    });

  return requiredPatterns.map(({label, pattern}) => {
    const entry = inventoryEntries.find(candidate => pattern.test(candidate.fileName));
    if (!entry) {
      throw new Error(
        `Windows public verify could not find the ${label} package in ${inventoryPath}.`,
      );
    }

    return {
      label,
      fileName: entry.fileName,
      packageFullName: entry.packageFullName,
      packageName: entry.packageFullName.split('_')[0],
      minimumVersion: entry.packageFullName.split('_')[1] ?? null,
      architecture: entry.packageFullName.split('_')[2] ?? null,
      path: path.join(packageDir, entry.fileName),
    };
  });
}

async function ensurePortableWindowsAppRuntimePackages() {
  const runtimeVersion = await resolveWindowsAppRuntimeVersion();
  const runtimePackageRoot = path.join(
    resolveNugetPackagesRoot(),
    'microsoft.windowsappsdk.runtime',
    runtimeVersion,
  );
  const packageDirSpecs = resolvePortableRuntimePackageDirSpecs();
  const packageSpecs = (
    await Promise.all(
      packageDirSpecs.map(spec =>
        readPortableRuntimePackageSpecs({
          runtimePackageRoot,
          packageDirName: spec.packageDirName,
          requiredPatterns: spec.requiredPatterns,
        }),
      ),
    )
  ).flat();

  log(
    `ensuring Windows App Runtime packages for portable verify from ${runtimePackageRoot}`,
  );

  const packageSpecsJson = JSON.stringify(packageSpecs, null, 2);
  const powerShellCommand =
    `$ErrorActionPreference = 'Stop'; ` +
    `$packages = @'\n${packageSpecsJson}\n'@ | ConvertFrom-Json; ` +
    `foreach ($package in $packages) { ` +
    `  $installed = Get-AppxPackage -Name $package.packageName | Where-Object { ` +
    `    $_.Architecture.ToString().ToUpperInvariant() -eq $package.architecture.ToUpperInvariant() -and ` +
    `    [version]$_.Version -ge [version]$package.minimumVersion ` +
    `  }; ` +
    `  if ($installed) { ` +
    `    $resolvedVersion = ($installed | Sort-Object Version -Descending | Select-Object -First 1).Version; ` +
    `    Write-Host "[windows-public-verify] runtime package already satisfied: $($package.packageName) arch=$($package.architecture) installedVersion=$resolvedVersion requiredVersion=$($package.minimumVersion)"; ` +
    `    continue; ` +
    `  }; ` +
    `  Write-Host "[windows-public-verify] installing runtime package: $($package.packageFullName)"; ` +
    `  Add-AppxPackage -Path $package.path -ErrorAction Stop; ` +
    `};`;

  runPowerShellOrThrow(powerShellCommand);
}

async function main() {
  let registryRoot = null;
  let server = null;

  try {
    await assertFrontendPublicVerifyContract();
    registryRoot = await createRegistryFixtureRoot();
    const serverHandle = await startRegistryServer(registryRoot);
    server = serverHandle.server;
    const commonArgs = [
      `--scenario=${verifyScenarioFilter}`,
      `--ota-remote=${serverHandle.baseUrl}`,
      '--ota-channel=stable',
      '--ota-expected-status=up-to-date',
      `--scenario-ms=${publicVerifyScenarioTimeoutMs}`,
    ];

    log(`registryRoot=${registryRoot}`);
    log(`otaRemote=${serverHandle.baseUrl}`);
    log(`scenarioFilter=${verifyScenarioFilter}`);

    log('running packaged Windows public verify');
    await runVerify(commonArgs);

    await ensurePortableWindowsAppRuntimePackages();

    log('running portable Windows public verify');
    await runVerify([...commonArgs, '--launch=portable']);
  } finally {
    await closeRegistryServer(server);
    if (registryRoot) {
      await rm(registryRoot, {recursive: true, force: true});
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
