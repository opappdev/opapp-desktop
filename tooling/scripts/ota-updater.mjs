/**
 * OTA bundle updater for the desktop Windows host.
 *
 * Implements RFC-010 OTA Bundle Update, Phase 1 (Node.js tooling).
 * Downloads a new bundle version from a remote artifact registry into the
 * local OTA cache, then stages it into the native host Bundle directory so
 * the next application launch uses the updated bundle.
 *
 * Usage:
 *   node ota-updater.mjs --mode=check    --remote=<url> --platform=windows [--current-version=<ver>] [--bundle-id=<id>]
 *   node ota-updater.mjs --mode=download --remote=<url> --platform=windows [--version=<ver>] [--bundle-id=<id>] [--force]
 *   node ota-updater.mjs --mode=apply    --platform=windows [--bundle-id=<id>] [--version=<ver>] [--host-bundle-dir=<d>]
 *   node ota-updater.mjs --mode=update   --remote=<url> --platform=windows [--force]
 *
 * All modes output a single JSON line to stdout for easy integration with
 * CI pipelines and automation scripts.
 *
 * --mode=check     Compare remote latest version against the current active
 *                  version (read from ota-state.json or --current-version).
 * --mode=download  Download the latest (or --version) bundle from remote to
 *                  the OTA cache directory (.ota-cache/).
 * --mode=apply     Stage the cached OTA bundle into the host Bundle directory.
 *                  Reads bundle-id/version/platform from ota-state.json when
 *                  not explicitly provided.
 * --mode=update    Atomically executes check + download + apply.  Exits with
 *                  status 'up-to-date' JSON when no update is available.
 *
 * Flags:
 *   --remote=<url>          Remote registry base URL (required for check/download/update).
 *   --platform=<p>          Target platform identifier (default: 'windows').
 *   --bundle-id=<id>        Bundle ID; auto-resolved from remote index when omitted.
 *   --version=<ver>         Target version; auto-resolved to latest when omitted.
 *   --current-version=<ver> Currently active version for check mode comparison.
 *   --force                 Bypass OTA cache; re-download even if already cached.
 *   --cache-dir=<d>         OTA cache directory (default: <repoRoot>/.ota-cache).
 *   --host-bundle-dir=<d>   Override for host bundle directory (apply step).
 */

import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {LocalRegistryArtifactSource, RemoteArtifactSource} from './artifact-source.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const DEFAULT_PLATFORM = 'windows';
const DEFAULT_CACHE_DIR = path.join(repoRoot, '.ota-cache');
const DEFAULT_HOST_BUNDLE_DIR = path.join(
  repoRoot,
  'hosts',
  'windows-host',
  'windows',
  'OpappWindowsHost',
  'Bundle',
);
const OTA_STATE_FILENAME = 'ota-state.json';

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Read the persisted OTA state from the cache directory.
 *
 * @param {string} cacheDir - OTA cache directory path.
 * @returns {Promise<OtaState | null>}
 *
 * @typedef {Object} OtaState
 * @property {string} bundleId
 * @property {string} version
 * @property {string} platform
 * @property {string} manifestDir
 * @property {string} downloadedAt - ISO 8601 timestamp.
 * @property {string} [stagedAt]   - ISO 8601 timestamp; set after apply.
 * @property {string} [hostBundleDir] - Absolute path used during apply.
 */
export async function readOtaState(cacheDir) {
  try {
    return JSON.parse(await readFile(path.join(cacheDir, OTA_STATE_FILENAME), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check whether a newer bundle version is available on the remote registry.
 *
 * The version comparison uses lexicographic ordering, consistent with
 * LocalRegistryArtifactSource and RemoteArtifactSource (RFC-007 / RFC-008).
 *
 * @param {object} options
 * @param {string} options.remoteBase - Remote registry base URL.
 * @param {string} options.platform - Target platform identifier.
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {string} [options.bundleId] - Bundle ID; auto-resolved when omitted.
 * @param {string} [options.currentVersion] - Currently active version; read
 *   from ota-state.json when omitted.
 * @returns {Promise<{hasUpdate: boolean, currentVersion: string | null, latestVersion: string, bundleId: string}>}
 */
export async function checkForUpdate({remoteBase, platform, cacheDir, bundleId, currentVersion}) {
  const {bundleId: resolvedBundleId, latestVersion} = await _fetchRemoteLatest(remoteBase, bundleId);

  let resolvedCurrentVersion = currentVersion ?? null;
  if (!resolvedCurrentVersion) {
    const state = await readOtaState(cacheDir);
    if (state && state.bundleId === resolvedBundleId && state.platform === platform) {
      resolvedCurrentVersion = state.version;
    }
  }

  const hasUpdate =
    !resolvedCurrentVersion || latestVersion > resolvedCurrentVersion;

  return {
    hasUpdate,
    currentVersion: resolvedCurrentVersion,
    latestVersion,
    bundleId: resolvedBundleId,
  };
}

/**
 * Download a bundle from the remote registry into the OTA cache.
 *
 * Delegates to RemoteArtifactSource (RFC-008), which handles caching and
 * checksum verification (RFC-009) automatically.
 *
 * @param {object} options
 * @param {string} options.remoteBase - Remote registry base URL.
 * @param {string} options.platform - Target platform identifier.
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {string} [options.bundleId] - Bundle ID; auto-resolved when omitted.
 * @param {string} [options.version] - Target version; auto-resolved when omitted.
 * @param {boolean} [options.force=false] - Re-download even if cached.
 * @returns {Promise<{bundleId: string, version: string, manifestDir: string}>}
 */
export async function downloadOtaUpdate({remoteBase, platform, cacheDir, bundleId, version, force = false}) {
  const source = new RemoteArtifactSource(remoteBase, cacheDir, {forceRefresh: force});
  const {manifest, manifestDir} = await source.resolve({platform, bundleId, version});

  const resolvedBundleId = manifest.bundleId ?? bundleId;
  const resolvedVersion = manifest.version ?? version;

  await _writeOtaState(cacheDir, {
    bundleId: resolvedBundleId,
    version: resolvedVersion,
    platform,
    manifestDir,
    downloadedAt: new Date().toISOString(),
  });

  return {bundleId: resolvedBundleId, version: resolvedVersion, manifestDir};
}

/**
 * Stage a downloaded OTA bundle into the native host Bundle directory.
 *
 * Mirrors the staging logic in windows-release-smoke.mjs:
 *   1. LocalRegistryArtifactSource.resolve() (includes checksum verification)
 *   2. Copy artifact directory to hostBundleDir
 *   3. Overwrite sourceKind in staged bundle-manifest.json to 'sibling-staging'
 *
 * @param {object} options
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {string} options.hostBundleDir - Host Bundle directory to stage into.
 * @param {string} options.platform - Target platform identifier.
 * @param {string} [options.bundleId] - Bundle ID; read from ota-state.json when omitted.
 * @param {string} [options.version] - Version; read from ota-state.json when omitted.
 * @returns {Promise<{bundleId: string, version: string, stagedAt: string}>}
 */
export async function applyOtaUpdate({cacheDir, hostBundleDir, platform, bundleId, version}) {
  const state = await readOtaState(cacheDir);
  const resolvedBundleId = bundleId ?? state?.bundleId;
  const resolvedVersion = version ?? state?.version;
  const resolvedPlatform = platform ?? state?.platform;

  if (!resolvedBundleId || !resolvedVersion || !resolvedPlatform) {
    throw new Error(
      'OtaUpdater: cannot apply — bundleId, version, and platform are required. ' +
        'Run --mode=download first, or provide --bundle-id, --version, and --platform.',
    );
  }

  const source = new LocalRegistryArtifactSource(cacheDir);
  const {manifestDir} = await source.resolve({
    platform: resolvedPlatform,
    bundleId: resolvedBundleId,
    version: resolvedVersion,
  });

  await mkdir(hostBundleDir, {recursive: true});
  await cp(manifestDir, hostBundleDir, {recursive: true, force: true});

  const stagedManifestPath = path.join(hostBundleDir, 'bundle-manifest.json');
  const stagedManifest = JSON.parse(await readFile(stagedManifestPath, 'utf8'));
  stagedManifest.sourceKind = 'sibling-staging';
  await writeFile(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n', 'utf8');

  const stagedAt = new Date().toISOString();
  await _writeOtaState(cacheDir, {
    ...(state ?? {}),
    bundleId: resolvedBundleId,
    version: resolvedVersion,
    platform: resolvedPlatform,
    manifestDir,
    stagedAt,
    hostBundleDir,
  });

  return {bundleId: resolvedBundleId, version: resolvedVersion, stagedAt};
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

async function _writeOtaState(cacheDir, state) {
  await mkdir(cacheDir, {recursive: true});
  await writeFile(
    path.join(cacheDir, OTA_STATE_FILENAME),
    JSON.stringify(state, null, 2) + '\n',
    'utf8',
  );
}

async function _fetchRemoteLatest(remoteBase, bundleId) {
  const base = remoteBase.replace(/\/$/, '');
  const indexUrl = `${base}/index.json`;
  let resp;
  try {
    resp = await fetch(indexUrl);
  } catch (err) {
    throw new Error(`OtaUpdater: network error fetching ${indexUrl}: ${err.message}`);
  }
  if (!resp.ok) {
    throw new Error(`OtaUpdater: HTTP ${resp.status} fetching ${indexUrl}`);
  }
  const index = await resp.json();
  const bundles = index?.bundles ?? {};
  const bundleIds = Object.keys(bundles);

  let resolvedBundleId = bundleId;
  if (!resolvedBundleId) {
    if (bundleIds.length === 0) {
      throw new Error(`OtaUpdater: no bundles in registry index at ${indexUrl}`);
    }
    if (bundleIds.length > 1) {
      throw new Error(
        `OtaUpdater: multiple bundles in registry; specify --bundle-id. ` +
          `Available: ${bundleIds.join(', ')}`,
      );
    }
    resolvedBundleId = bundleIds[0];
  }

  const info = bundles[resolvedBundleId];
  if (!info) {
    throw new Error(
      `OtaUpdater: bundleId '${resolvedBundleId}' not found in registry index at ${indexUrl}`,
    );
  }

  const versions = Array.isArray(info.versions) ? info.versions : [];
  // Lexicographic sort — consistent with LocalRegistryArtifactSource / RemoteArtifactSource.
  const latestVersion = [...versions].sort().at(-1);
  if (!latestVersion) {
    throw new Error(
      `OtaUpdater: no versions for '${resolvedBundleId}' in registry index at ${indexUrl}`,
    );
  }

  return {bundleId: resolvedBundleId, latestVersion};
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function _parseArg(name) {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
}

async function main() {
  const modeArg = _parseArg('mode') ?? 'update';
  const remoteArg = _parseArg('remote');
  const platformArg = _parseArg('platform') ?? DEFAULT_PLATFORM;
  const bundleIdArg = _parseArg('bundle-id') ?? undefined;
  const versionArg = _parseArg('version') ?? undefined;
  const currentVersionArg = _parseArg('current-version') ?? undefined;
  const forceFlag = process.argv.includes('--force');
  const cacheDirArg = _parseArg('cache-dir') ?? DEFAULT_CACHE_DIR;
  const hostBundleDirArg = _parseArg('host-bundle-dir') ?? DEFAULT_HOST_BUNDLE_DIR;

  if (!['check', 'download', 'apply', 'update'].includes(modeArg)) {
    throw new Error(
      `OtaUpdater: unknown --mode='${modeArg}'. Valid modes: check, download, apply, update.`,
    );
  }

  if ((modeArg === 'check' || modeArg === 'download' || modeArg === 'update') && !remoteArg) {
    throw new Error(`OtaUpdater: --remote=<url> is required for --mode=${modeArg}.`);
  }

  if (modeArg === 'check') {
    const result = await checkForUpdate({
      remoteBase: remoteArg,
      platform: platformArg,
      cacheDir: cacheDirArg,
      bundleId: bundleIdArg,
      currentVersion: currentVersionArg,
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (modeArg === 'download') {
    const result = await downloadOtaUpdate({
      remoteBase: remoteArg,
      platform: platformArg,
      cacheDir: cacheDirArg,
      bundleId: bundleIdArg,
      version: versionArg,
      force: forceFlag,
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (modeArg === 'apply') {
    const result = await applyOtaUpdate({
      cacheDir: cacheDirArg,
      hostBundleDir: hostBundleDirArg,
      platform: platformArg,
      bundleId: bundleIdArg,
      version: versionArg,
    });
    console.log(JSON.stringify(result));
    return;
  }

  // mode === 'update': atomically check + download + apply
  const checkResult = await checkForUpdate({
    remoteBase: remoteArg,
    platform: platformArg,
    cacheDir: cacheDirArg,
    bundleId: bundleIdArg,
    currentVersion: currentVersionArg,
  });

  if (!checkResult.hasUpdate) {
    console.log(JSON.stringify({status: 'up-to-date', ...checkResult}));
    return;
  }

  const downloadResult = await downloadOtaUpdate({
    remoteBase: remoteArg,
    platform: platformArg,
    cacheDir: cacheDirArg,
    bundleId: checkResult.bundleId,
    version: checkResult.latestVersion,
    force: forceFlag,
  });

  const applyResult = await applyOtaUpdate({
    cacheDir: cacheDirArg,
    hostBundleDir: hostBundleDirArg,
    platform: platformArg,
    bundleId: downloadResult.bundleId,
    version: downloadResult.version,
  });

  console.log(
    JSON.stringify({
      status: 'updated',
      previousVersion: checkResult.currentVersion,
      ...applyResult,
    }),
  );
}

main().catch(err => {
  console.error(`[ota-updater] ${err.message}`);
  process.exit(1);
});
