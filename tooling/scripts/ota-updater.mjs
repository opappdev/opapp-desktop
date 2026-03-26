/**
 * OTA bundle updater for the desktop Windows host.
 *
 * Implements RFC-010 OTA Bundle Update, Phase 1 (Node.js tooling).
 * Downloads a new bundle version from a remote artifact registry into the
 * local OTA cache, then stages it into the native host Bundle directory so
 * the next application launch uses the updated bundle.
 *
 * Usage:
 *   node ota-updater.mjs --mode=check    --remote=<url> --platform=windows [--current-version=<ver>] [--bundle-id=<id>] [--channel=<name>]
 *   node ota-updater.mjs --mode=download --remote=<url> --platform=windows [--version=<ver>] [--bundle-id=<id>] [--force] [--channel=<name>]
 *   node ota-updater.mjs --mode=apply    --platform=windows [--bundle-id=<id>] [--version=<ver>] [--host-bundle-dir=<d>]
 *   node ota-updater.mjs --mode=update   --remote=<url> --platform=windows [--force] [--channel=<name>]
 *   node ota-updater.mjs --mode=rollback --platform=windows [--host-bundle-dir=<d>]
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
 * --mode=rollback  Restore the pre-apply snapshot from the OTA cache into
 *                  hostBundleDir, undoing the most recent apply.  Requires a
 *                  previous snapshot (created automatically by apply).
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
 *   --device-id=<id>        Override device ID used for staged rollout bucket
 *                           (RFC-014); useful for testing. Persisted in
 *                           <cacheDir>/device-id.json when auto-generated.
 *   --channel=<name>        Update channel name (RFC-015); e.g. 'stable', 'beta',
 *                           'nightly'.  Persisted to <cacheDir>/channel.json.
 *                           Defaults to the persisted channel choice, or 'stable'.
 */

import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
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
 * @property {{version: string|null, snapshotDir: string, snapshotAt: string}|null} [previousSnapshot]
 *   Snapshot of hostBundleDir taken immediately before the last apply.
 *   Consumed (set to undefined) by rollback.
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
 * When the registry index contains a `channels` map (RFC-015) and a channel is
 * selected (via the `channel` option or <cacheDir>/channel.json), the version
 * pinned to that channel is used instead of the overall latest version.  If the
 * requested channel is absent from the index, the check falls back to the
 * 'stable' channel entry, then to the overall lexicographically-latest version.
 *
 * When the registry index contains a `rolloutPercent` value < 100 for the
 * target bundle (RFC-014), a deterministic device-fingerprint bucket check is
 * performed.  If the device is outside the rollout window, `hasUpdate` is
 * returned as `false` even when a newer version exists.
 *
 * @param {object} options
 * @param {string} options.remoteBase - Remote registry base URL.
 * @param {string} options.platform - Target platform identifier.
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {string} [options.bundleId] - Bundle ID; auto-resolved when omitted.
 * @param {string} [options.currentVersion] - Currently active version; read
 *   from ota-state.json when omitted.
 * @param {string} [options.deviceId] - Device ID for rollout bucket computation
 *   (RFC-014); auto-generated and persisted when omitted.
 * @param {string} [options.channel] - Update channel name (RFC-015); persisted
 *   in <cacheDir>/channel.json when explicitly provided.  Defaults to the
 *   persisted channel, or 'stable' when no channel has been chosen.
 * @returns {Promise<{hasUpdate: boolean, inRollout: boolean, rolloutPercent: number|undefined, deviceId: string, currentVersion: string | null, latestVersion: string, bundleId: string, channel: string, channels?: Record<string,string>}>}
 */
export async function checkForUpdate({remoteBase, platform, cacheDir, bundleId, currentVersion, deviceId, channel}) {
  // RFC-015: resolve and persist channel choice.
  const resolvedChannel = channel ?? await _getOrCreateChannel(cacheDir);
  if (channel !== undefined) await _persistChannel(cacheDir, channel);

  const {bundleId: resolvedBundleId, latestVersion, rolloutPercent, channels} = await _fetchRemoteLatest(remoteBase, bundleId, resolvedChannel);

  let resolvedCurrentVersion = currentVersion ?? null;
  if (!resolvedCurrentVersion) {
    const state = await readOtaState(cacheDir);
    if (state && state.bundleId === resolvedBundleId && state.platform === platform) {
      resolvedCurrentVersion = state.version;
    }
  }

  // RFC-014: staged rollout — resolve device ID and compute bucket.
  const resolvedDeviceId = deviceId ?? await _getOrCreateDeviceId(cacheDir);
  let inRollout = true;
  if (typeof rolloutPercent === 'number' && rolloutPercent < 100) {
    const bucket = _computeRolloutBucket(resolvedBundleId, resolvedDeviceId);
    inRollout = bucket < rolloutPercent;
  }

  const hasUpdate =
    inRollout && (!resolvedCurrentVersion || latestVersion > resolvedCurrentVersion);

  return {
    hasUpdate,
    inRollout,
    ...(rolloutPercent !== undefined ? {rolloutPercent} : {}),
    deviceId: resolvedDeviceId,
    currentVersion: resolvedCurrentVersion,
    latestVersion,
    bundleId: resolvedBundleId,
    channel: resolvedChannel,
    ...(channels ? {channels} : {}),
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
 * @param {string} [options.channel] - Update channel name (RFC-015); used to
 *   resolve the channel-pinned version from the registry index when
 *   options.version is omitted.
 * @returns {Promise<{bundleId: string, version: string, manifestDir: string}>}
 */
export async function downloadOtaUpdate({remoteBase, platform, cacheDir, bundleId, version, force = false, channel}) {
  // RFC-015: if a channel is specified without an explicit version, resolve the
  // channel-pinned version from the remote registry index before downloading.
  let targetVersion = version;
  let targetBundleId = bundleId;
  if (!targetVersion && channel !== undefined) {
    const fetched = await _fetchRemoteLatest(remoteBase, bundleId, channel);
    targetVersion = fetched.latestVersion;
    if (!targetBundleId) targetBundleId = fetched.bundleId;
  }

  const source = new RemoteArtifactSource(remoteBase, cacheDir, {forceRefresh: force});
  const {manifest, manifestDir} = await source.resolve({platform, bundleId: targetBundleId, version: targetVersion});

  const resolvedBundleId = manifest.bundleId ?? targetBundleId;
  const resolvedVersion = manifest.version ?? targetVersion;

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

  const snapshot = await _snapshotCurrentBundle(cacheDir, hostBundleDir, resolvedBundleId, resolvedPlatform);

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
    previousSnapshot: snapshot ?? undefined,
  });

  return {bundleId: resolvedBundleId, version: resolvedVersion, stagedAt};
}

/**
 * Restore the pre-apply snapshot from the OTA cache into hostBundleDir,
 * undoing the most recent apply operation.
 *
 * The snapshot is created automatically by applyOtaUpdate() before it
 * overwrites the host bundle directory.  After rollback the previousSnapshot
 * entry is cleared from ota-state.json, so a second consecutive rollback will
 * correctly fail with a "no snapshot" error.
 *
 * @param {object} options
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {string} [options.hostBundleDir] - Override; read from ota-state.json when omitted.
 * @param {string} [options.bundleId] - Bundle ID; read from ota-state.json when omitted.
 * @param {string} [options.platform] - Platform; read from ota-state.json when omitted.
 * @returns {Promise<{bundleId: string, rolledBackToVersion: string|null, rolledBackAt: string}>}
 */
export async function rollbackOtaUpdate({cacheDir, hostBundleDir, bundleId, platform}) {
  const state = await readOtaState(cacheDir);
  const snapshot = state?.previousSnapshot;

  if (!snapshot?.snapshotDir) {
    throw new Error(
      'OtaUpdater: no previous snapshot found. Run --mode=apply first to create a snapshot.',
    );
  }

  const resolvedBundleId = bundleId ?? state?.bundleId;
  const resolvedPlatform = platform ?? state?.platform;
  const resolvedHostBundleDir = hostBundleDir ?? state?.hostBundleDir;

  if (!resolvedHostBundleDir) {
    throw new Error(
      'OtaUpdater: --host-bundle-dir is required for rollback when ota-state.json has no hostBundleDir.',
    );
  }

  await mkdir(resolvedHostBundleDir, {recursive: true});
  await cp(snapshot.snapshotDir, resolvedHostBundleDir, {recursive: true, force: true});

  const rolledBackAt = new Date().toISOString();
  await _writeOtaState(cacheDir, {
    ...state,
    bundleId: resolvedBundleId,
    version: snapshot.version,
    platform: resolvedPlatform,
    hostBundleDir: resolvedHostBundleDir,
    stagedAt: rolledBackAt,
    previousSnapshot: undefined,
  });

  return {bundleId: resolvedBundleId, rolledBackToVersion: snapshot.version, rolledBackAt};
}

/**
 * Snapshot the current contents of hostBundleDir to the OTA cache's previous/
 * subdirectory before an apply overwrites it.
 *
 * Returns null when hostBundleDir does not yet contain a valid bundle-manifest
 * (e.g., the very first apply), so the caller can safely skip recording a
 * previousSnapshot.
 *
 * @param {string} cacheDir
 * @param {string} hostBundleDir
 * @param {string} bundleId
 * @param {string} platform
 * @returns {Promise<{version: string|null, snapshotDir: string, snapshotAt: string} | null>}
 */
async function _snapshotCurrentBundle(cacheDir, hostBundleDir, bundleId, platform) {
  const manifestPath = path.join(hostBundleDir, 'bundle-manifest.json');
  let currentVersion = null;
  try {
    const m = JSON.parse(await readFile(manifestPath, 'utf8'));
    currentVersion = m.version ?? null;
  } catch {
    return null;
  }
  const snapshotDir = path.join(cacheDir, bundleId, 'previous', platform);
  const snapshotAt = new Date().toISOString();
  await mkdir(snapshotDir, {recursive: true});
  await cp(hostBundleDir, snapshotDir, {recursive: true, force: true});
  return {version: currentVersion, snapshotDir, snapshotAt};
}

async function _writeOtaState(cacheDir, state) {
  await mkdir(cacheDir, {recursive: true});
  await writeFile(
    path.join(cacheDir, OTA_STATE_FILENAME),
    JSON.stringify(state, null, 2) + '\n',
    'utf8',
  );
}

async function _fetchRemoteLatest(remoteBase, bundleId, channel) {
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
  const overallLatest = [...versions].sort().at(-1);

  // RFC-015: channel-aware version resolution.
  const channelMap =
    info.channels && typeof info.channels === 'object' && !Array.isArray(info.channels)
      ? info.channels
      : {};
  let latestVersion;
  if (channel) {
    if (typeof channelMap[channel] === 'string' && channelMap[channel]) {
      latestVersion = channelMap[channel];
    } else if (channel !== 'stable' && typeof channelMap['stable'] === 'string' && channelMap['stable']) {
      // Requested channel not in index — fall back to stable.
      latestVersion = channelMap['stable'];
    } else {
      latestVersion = overallLatest;
    }
  } else {
    latestVersion = overallLatest;
  }

  if (!latestVersion) {
    throw new Error(
      `OtaUpdater: no versions for '${resolvedBundleId}' in registry index at ${indexUrl}`,
    );
  }

  return {
    bundleId: resolvedBundleId,
    latestVersion,
    rolloutPercent: info.rolloutPercent,
    ...(Object.keys(channelMap).length > 0 ? {channels: channelMap} : {}),
  };
}

// ---------------------------------------------------------------------------
// RFC-014: Staged rollout helpers
// ---------------------------------------------------------------------------

/**
 * Read the persisted device ID from <cacheDir>/device-id.json, or generate
 * and persist a new UUID v4 if the file does not yet exist.
 *
 * @param {string} cacheDir
 * @returns {Promise<string>}
 */
async function _getOrCreateDeviceId(cacheDir) {
  const deviceIdPath = path.join(cacheDir, 'device-id.json');
  try {
    const data = JSON.parse(await readFile(deviceIdPath, 'utf8'));
    if (typeof data.deviceId === 'string' && data.deviceId) return data.deviceId;
  } catch {
    // File missing or corrupt — generate a new one below.
  }
  const deviceId = randomUUID();
  await mkdir(cacheDir, {recursive: true});
  await writeFile(
    deviceIdPath,
    JSON.stringify({deviceId, createdAt: new Date().toISOString()}, null, 2) + '\n',
    'utf8',
  );
  return deviceId;
}

/**
 * Compute a deterministic 0–99 rollout bucket for a (bundleId, deviceId) pair.
 *
 * Uses the first 4 bytes of SHA-256("<bundleId>:<deviceId>") interpreted as a
 * big-endian uint32, then takes mod 100.  The same pair always produces the
 * same bucket, ensuring stable rollout membership as rolloutPercent widens.
 *
 * @param {string} bundleId
 * @param {string} deviceId
 * @returns {number} Integer in [0, 99].
 */
function _computeRolloutBucket(bundleId, deviceId) {
  const hex = createHash('sha256').update(`${bundleId}:${deviceId}`).digest('hex');
  return parseInt(hex.slice(0, 8), 16) % 100;
}

// ---------------------------------------------------------------------------
// RFC-015: Update channel helpers
// ---------------------------------------------------------------------------

/**
 * Read the persisted channel choice from <cacheDir>/channel.json.
 * Returns 'stable' when the file is absent or contains no valid channel string.
 *
 * @param {string} cacheDir
 * @returns {Promise<string>}
 */
async function _getOrCreateChannel(cacheDir) {
  const channelPath = path.join(cacheDir, 'channel.json');
  try {
    const data = JSON.parse(await readFile(channelPath, 'utf8'));
    if (typeof data.channel === 'string' && data.channel) return data.channel;
  } catch {
    // File missing or corrupt — use default.
  }
  return 'stable';
}

/**
 * Persist the given channel name to <cacheDir>/channel.json.
 *
 * @param {string} cacheDir
 * @param {string} channel
 */
async function _persistChannel(cacheDir, channel) {
  const channelPath = path.join(cacheDir, 'channel.json');
  await mkdir(cacheDir, {recursive: true});
  await writeFile(
    channelPath,
    JSON.stringify({channel, updatedAt: new Date().toISOString()}, null, 2) + '\n',
    'utf8',
  );
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
  const deviceIdArg = _parseArg('device-id') ?? undefined;
  const channelArg = _parseArg('channel') ?? undefined;

  if (!['check', 'download', 'apply', 'update', 'rollback'].includes(modeArg)) {
    throw new Error(
      `OtaUpdater: unknown --mode='${modeArg}'. Valid modes: check, download, apply, update, rollback.`,
    );
  }

  if ((modeArg === 'check' || modeArg === 'download' || modeArg === 'update') && !remoteArg) {
    throw new Error(`OtaUpdater: --remote=<url> is required for --mode=${modeArg}.`);
  }

  if (modeArg === 'rollback') {
    const result = await rollbackOtaUpdate({
      cacheDir: cacheDirArg,
      hostBundleDir: hostBundleDirArg !== DEFAULT_HOST_BUNDLE_DIR ? hostBundleDirArg : undefined,
      platform: platformArg !== DEFAULT_PLATFORM ? platformArg : undefined,
      bundleId: bundleIdArg,
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (modeArg === 'check') {
    const result = await checkForUpdate({
      remoteBase: remoteArg,
      platform: platformArg,
      cacheDir: cacheDirArg,
      bundleId: bundleIdArg,
      currentVersion: currentVersionArg,
      deviceId: deviceIdArg,
      channel: channelArg,
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
      channel: channelArg,
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
    deviceId: deviceIdArg,
    channel: channelArg,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`[ota-updater] ${err.message}`);
    process.exit(1);
  });
}
