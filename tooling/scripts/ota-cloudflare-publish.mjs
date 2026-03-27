/**
 * Cloudflare OTA publish pipeline for Windows-first rollout.
 *
 * Flow:
 *   bundle -> local registry -> channel/rollout sidecars -> index merge -> Cloudflare upload
 *
 * Usage:
 *   node ota-cloudflare-publish.mjs \
 *     --bundle-id=<id> \
 *     --platform=windows \
 *     --version=<semver> \
 *     --remote-base=<https://public-host/path> \
 *     --channel=<stable|beta|nightly> \
 *     --rollout-percent=<0-100> \
 *     --cloudflare-bucket=<bucket-name> \
 *     [--source-dir=<frontend-dist-dir>] \
 *     [--registry-dir=.artifact-registry] \
 *     [--cloudflare-prefix=<object-prefix>] \
 *     [--wrangler-bin=<wrangler-command>] \
 *     [--wrangler-config=<path>] \
 *     [--skip-upload] [--dry-run]
 */

import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {
  generateRegistryIndex,
  publishToLocalRegistry,
} from './artifact-source.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..', '..');
const defaultRegistryDir = path.join(repoRoot, '.artifact-registry');
const defaultWranglerBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function parseArg(name) {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePercent(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`invalid rollout percent '${rawValue}'. Expected number in [0, 100].`);
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeVersions(entry) {
  const fromVersions = Array.isArray(entry?.versions)
    ? entry.versions.filter(version => typeof version === 'string' && version.length > 0)
    : [];
  const latest = typeof entry?.latestVersion === 'string' && entry.latestVersion.length > 0
    ? [entry.latestVersion]
    : [];
  return [...new Set([...fromVersions, ...latest])].sort();
}

function normalizeChannels(entry) {
  const channels = asObject(entry?.channels);
  return Object.fromEntries(
    Object.entries(channels).filter(
      ([channel, version]) =>
        typeof channel === 'string' &&
        channel.length > 0 &&
        typeof version === 'string' &&
        version.length > 0,
    ),
  );
}

function normalizeRolloutPercent(entry) {
  if (typeof entry?.rolloutPercent !== 'number' || !Number.isFinite(entry.rolloutPercent)) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(entry.rolloutPercent)));
  return clamped < 100 ? clamped : undefined;
}

export function mergeRegistryIndexes(remoteIndex, localIndex) {
  const remoteBundles = asObject(remoteIndex?.bundles);
  const localBundles = asObject(localIndex?.bundles);
  const bundleIds = [...new Set([...Object.keys(remoteBundles), ...Object.keys(localBundles)])].sort();

  const bundles = {};
  for (const bundleId of bundleIds) {
    const remoteEntry = asObject(remoteBundles[bundleId]);
    const localEntry = asObject(localBundles[bundleId]);
    const versions = [...new Set([...normalizeVersions(remoteEntry), ...normalizeVersions(localEntry)])].sort();
    const latestVersion = versions.at(-1) ?? null;
    const channels = {
      ...normalizeChannels(remoteEntry),
      ...normalizeChannels(localEntry),
    };
    const rolloutPercent = normalizeRolloutPercent(localEntry) ?? normalizeRolloutPercent(remoteEntry);
    const mergedEntry = {latestVersion, versions};
    if (Object.keys(channels).length > 0) mergedEntry.channels = channels;
    if (rolloutPercent !== undefined) mergedEntry.rolloutPercent = rolloutPercent;
    bundles[bundleId] = mergedEntry;
  }
  return {bundles};
}

export function applyBundlePublishOverrides(index, options) {
  const {bundleId, version, channel, rolloutPercent} = options;
  const bundles = asObject(index?.bundles);
  const currentEntry = asObject(bundles[bundleId]);
  const versions = [...new Set([...normalizeVersions(currentEntry), version])].sort();
  const channels = {
    ...normalizeChannels(currentEntry),
    [channel]: version,
  };

  const nextEntry = {
    latestVersion: versions.at(-1) ?? version,
    versions,
    channels,
  };

  if (rolloutPercent < 100) {
    nextEntry.rolloutPercent = rolloutPercent;
  }

  return {
    bundles: {
      ...bundles,
      [bundleId]: nextEntry,
    },
  };
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function joinObjectKey(prefix, relativePath) {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const cleanPath = relativePath.replace(/^\/+/, '');
  if (!cleanPrefix) return cleanPath;
  return `${cleanPrefix}/${cleanPath}`;
}

function derivePrefixFromRemoteBase(remoteBase) {
  try {
    const url = new URL(remoteBase);
    return url.pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    return '';
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function readFileSnapshot(filePath) {
  try {
    return {
      exists: true,
      content: await readFile(filePath, 'utf8'),
    };
  } catch {
    return {
      exists: false,
      content: null,
    };
  }
}

async function restoreFileSnapshot(filePath, snapshot) {
  if (snapshot.exists) {
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, snapshot.content ?? '', 'utf8');
    return;
  }
  await rm(filePath, {force: true, recursive: true});
}

export async function withFileRollback(filePaths, callback) {
  const uniquePaths = [...new Set(filePaths.map(filePath => path.resolve(filePath)))];
  const snapshots = new Map();
  for (const filePath of uniquePaths) {
    snapshots.set(filePath, await readFileSnapshot(filePath));
  }

  try {
    return await callback();
  } catch (error) {
    for (const filePath of uniquePaths) {
      await restoreFileSnapshot(filePath, snapshots.get(filePath));
    }
    throw error;
  }
}

export async function upsertBundleSidecars(registryRoot, bundleId, channel, version, rolloutPercent) {
  const bundleRoot = path.join(registryRoot, bundleId);
  await mkdir(bundleRoot, {recursive: true});

  const channelsPath = path.join(bundleRoot, 'channels.json');
  const rolloutPath = path.join(bundleRoot, 'rollout.json');
  await withFileRollback([channelsPath, rolloutPath], async () => {
    const currentChannels = asObject(await readJsonIfExists(channelsPath));
    currentChannels[channel] = version;
    await writeJsonFile(channelsPath, currentChannels);

    if (rolloutPercent >= 100) {
      await rm(rolloutPath, {force: true, recursive: true});
    } else {
      await writeJsonFile(rolloutPath, {percent: rolloutPercent, updatedAt: new Date().toISOString()});
    }
  });
}

async function ensureRegistryArtifact(registryRoot, bundleId, version, platform) {
  const artifactDir = path.join(registryRoot, bundleId, version, platform);
  const manifestPath = path.join(artifactDir, 'bundle-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`missing bundle-manifest.json in local registry: ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.bundleId && manifest.bundleId !== bundleId) {
    throw new Error(
      `manifest bundleId '${manifest.bundleId}' does not match --bundle-id='${bundleId}'.`,
    );
  }
  if (manifest.version && manifest.version !== version) {
    throw new Error(
      `manifest version '${manifest.version}' does not match --version='${version}'.`,
    );
  }
  if (manifest.platform && manifest.platform !== platform) {
    throw new Error(
      `manifest platform '${manifest.platform}' does not match --platform='${platform}'.`,
    );
  }
  if (!manifest.entryFile || typeof manifest.entryFile !== 'string') {
    throw new Error(`manifest entryFile is missing in ${manifestPath}.`);
  }
  const entryPath = path.join(artifactDir, manifest.entryFile);
  if (!existsSync(entryPath)) {
    throw new Error(`entry file '${manifest.entryFile}' is missing in ${artifactDir}.`);
  }

  const files = [
    {
      localPath: manifestPath,
      relativeRegistryPath: toPosix(path.relative(registryRoot, manifestPath)),
    },
    {
      localPath: entryPath,
      relativeRegistryPath: toPosix(path.relative(registryRoot, entryPath)),
    },
  ];
  const optionalPolicyPath = path.join(artifactDir, 'window-policy-registry.json');
  if (existsSync(optionalPolicyPath)) {
    files.push({
      localPath: optionalPolicyPath,
      relativeRegistryPath: toPosix(path.relative(registryRoot, optionalPolicyPath)),
    });
  }

  return {artifactDir, manifest, files};
}

async function fetchRemoteIndex(remoteBase) {
  const indexUrl = `${remoteBase.replace(/\/$/, '')}/index.json`;
  try {
    const response = await fetch(indexUrl);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function runCommand(command, args, cwd, dryRun) {
  if (dryRun) {
    return {code: 0};
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve({code: 0});
      } else {
        reject(new Error(`command failed (${code}): ${command} ${args.join(' ')}`));
      }
    });
  });
}

async function uploadFilesToCloudflare({
  files,
  bucket,
  objectPrefix,
  wranglerBin,
  wranglerConfig,
  dryRun,
}) {
  const uploadedKeys = [];
  for (const file of files) {
    const objectKey = joinObjectKey(objectPrefix, file.relativeRegistryPath);
    const wranglerArgs = [];
    if (wranglerBin === defaultWranglerBin) {
      wranglerArgs.push('wrangler');
    }
    wranglerArgs.push('r2', 'object', 'put', `${bucket}/${objectKey}`, '--file', file.localPath);
    if (wranglerConfig) {
      wranglerArgs.push('--config', wranglerConfig);
    }
    await runCommand(wranglerBin, wranglerArgs, repoRoot, dryRun);
    uploadedKeys.push(objectKey);
  }
  return uploadedKeys;
}

function printUsageAndExit(exitCode = 1) {
  console.error(
    'Usage:\n' +
      '  node ota-cloudflare-publish.mjs --bundle-id=<id> --platform=<platform> --version=<ver>\n' +
      '    --remote-base=<url> --channel=<name> --rollout-percent=<0-100>\n' +
      '    --cloudflare-bucket=<bucket> [--source-dir=<dir>] [--registry-dir=<dir>]\n' +
      '    [--cloudflare-prefix=<prefix>] [--wrangler-bin=<cmd>] [--wrangler-config=<path>]\n' +
      '    [--skip-upload] [--dry-run]\n',
  );
  process.exit(exitCode);
}

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printUsageAndExit(0);
  }

  const bundleId = parseArg('bundle-id');
  const platform = parseArg('platform') ?? 'windows';
  const version = parseArg('version');
  const remoteBase = parseArg('remote-base');
  const channel = parseArg('channel');
  const rolloutPercentArg = parseArg('rollout-percent');
  const cloudflareBucket = parseArg('cloudflare-bucket');
  const sourceDirArg = parseArg('source-dir');
  const registryDirArg = parseArg('registry-dir');
  const cloudflarePrefixArg = parseArg('cloudflare-prefix');
  const wranglerBin = parseArg('wrangler-bin') ?? defaultWranglerBin;
  const wranglerConfig = parseArg('wrangler-config');
  const skipUpload = hasFlag('skip-upload');
  const dryRun = hasFlag('dry-run');

  if (!bundleId || !version || !remoteBase || !channel || !rolloutPercentArg) {
    throw new Error(
      '--bundle-id, --version, --remote-base, --channel, and --rollout-percent are required.',
    );
  }
  if (!cloudflareBucket) {
    throw new Error('--cloudflare-bucket is required.');
  }

  const rolloutPercent = parsePercent(rolloutPercentArg);
  const registryRoot = registryDirArg
    ? path.resolve(repoRoot, registryDirArg)
    : defaultRegistryDir;
  const sourceDir = sourceDirArg ? path.resolve(repoRoot, sourceDirArg) : null;
  const objectPrefix = cloudflarePrefixArg ?? derivePrefixFromRemoteBase(remoteBase);

  let publishedRegistryPath = null;
  if (sourceDir) {
    publishedRegistryPath = await publishToLocalRegistry(sourceDir, registryRoot);
  }

  const artifact = await ensureRegistryArtifact(registryRoot, bundleId, version, platform);
  await upsertBundleSidecars(registryRoot, bundleId, channel, version, rolloutPercent);

  const localIndex = await generateRegistryIndex(registryRoot);
  const remoteIndex = await fetchRemoteIndex(remoteBase);
  const mergedIndex = applyBundlePublishOverrides(
    mergeRegistryIndexes(remoteIndex, localIndex),
    {
      bundleId,
      version,
      channel,
      rolloutPercent,
    },
  );

  const indexPath = path.join(registryRoot, 'index.json');
  await writeJsonFile(indexPath, mergedIndex);

  const uploadFiles = [
    ...artifact.files,
    {
      localPath: indexPath,
      relativeRegistryPath: 'index.json',
    },
  ];

  const uploadedKeys = skipUpload
    ? uploadFiles.map(file => joinObjectKey(objectPrefix, file.relativeRegistryPath))
    : await uploadFilesToCloudflare({
        files: uploadFiles,
        bucket: cloudflareBucket,
        objectPrefix,
        wranglerBin,
        wranglerConfig,
        dryRun,
      });

  console.log(
    JSON.stringify({
      bundleId,
      platform,
      version,
      channel,
      rolloutPercent,
      remoteBase,
      cloudflareBucket,
      objectPrefix,
      registryRoot,
      publishedRegistryPath,
      mergedFromRemote: remoteIndex !== null,
      uploadedCount: uploadedKeys.length,
      uploadedKeys,
      skipUpload,
      dryRun,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(`[ota-cloudflare-publish] ${error.message}`);
    process.exit(1);
  });
}
