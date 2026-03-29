import {spawnSync} from 'node:child_process';
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

function runVerify(args) {
  const result = spawnSync(process.execPath, [verifyScriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `verify-windows exited with status ${result.status ?? 1} for args: ${args.join(' ')}`,
    );
  }
}

async function main() {
  let registryRoot = null;
  let server = null;

  try {
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
    runVerify(commonArgs);

    log('running portable Windows public verify');
    runVerify([...commonArgs, '--launch=portable']);
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
