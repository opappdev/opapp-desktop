/**
 * Cloudflare OTA publish pipeline for Windows-first rollout.
 *
 * Flow:
 *   optional frontend build -> local registry -> channel/rollout sidecars -> index merge -> Cloudflare upload
 *
 * Usage:
 *   node ota-cloudflare-publish.mjs \
 *     [--build] \
 *     [--env-file=<path-to-.env>] \
 *     [--bundle-id=<id>] \
 *     [--platform=windows] \
 *     [--version=<semver>] \
 *     [--remote-base=<https://public-host/path>] \
 *     --channel=<stable|beta|nightly> \
 *     --rollout-percent=<0-100> \
 *     [--cloudflare-bucket=<bucket-name>] \
 *     [--source-dir=<frontend-dist-dir>] \
 *     [--registry-dir=.artifact-registry] \
 *     [--cloudflare-prefix=<object-prefix>] \
 *     [--upload-mode=<r2-s3|wrangler>] \
 *     [--r2-endpoint=<endpoint>] \
 *     [--r2-access-key-id=<key>] \
 *     [--r2-secret-access-key=<secret>] \
 *     [--r2-account-id=<account-id>] \
 *     [--r2-jurisdiction=<default|eu|fedramp>] \
 *     [--frontend-root=<path>] \
 *     [--wrangler-bin=<wrangler-command>] \
 *     [--wrangler-config=<path>] \
 *     [--skip-upload] [--dry-run]
 */

import {spawn} from 'node:child_process';
import {createHash, createHmac} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
  generateRegistryIndex,
  publishToLocalRegistry,
} from './artifact-source.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const defaultRegistryDir = path.join(repoRoot, '.artifact-registry');
const defaultEnvFile = path.join(workspaceRoot, '.env.r2.local');
const defaultFrontendRoot = path.join(workspaceRoot, 'opapp-frontend');
const defaultWranglerBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const defaultCorepackBin = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const defaultPlatform = 'windows';

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

function formatRfc3986Segment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createSignatureKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update(service).digest();
  return createHmac('sha256', serviceKey).update('aws4_request').digest();
}

function formatAmzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function deriveR2Endpoint({accountId, endpoint, jurisdiction = 'default'}) {
  if (endpoint) {
    return endpoint;
  }
  if (!accountId) {
    return null;
  }
  const normalizedJurisdiction =
    typeof jurisdiction === 'string' && jurisdiction.length > 0 ? jurisdiction : 'default';
  const jurisdictionSegment =
    normalizedJurisdiction === 'default' ? '' : `${normalizedJurisdiction}.`;
  return `https://${accountId}.${jurisdictionSegment}r2.cloudflarestorage.com`;
}

export function createSignedR2Request({
  endpoint,
  bucket,
  objectKey,
  method,
  accessKeyId,
  secretAccessKey,
  body = null,
  now = new Date(),
}) {
  const upperMethod = method.toUpperCase();
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/g, '');
  const encodedPath = [bucket, ...objectKey.split('/').filter(Boolean)]
    .map(formatRfc3986Segment)
    .join('/');
  url.pathname = `${basePath}/${encodedPath}`.replace(/\/+/g, '/');
  url.search = '';

  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    upperMethod,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac(
    'sha256',
    createSignatureKey(secretAccessKey, dateStamp, 'auto', 's3'),
  )
    .update(stringToSign)
    .digest('hex');

  return {
    method: upperMethod,
    url: url.toString(),
    body: payload.length > 0 ? payload : undefined,
    headers: {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

export function parseEnvText(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readEnvFileValues(envFilePath) {
  const resolvedPath = path.resolve(envFilePath);
  try {
    const content = await readFile(resolvedPath, 'utf8');
    return {
      resolvedPath,
      exists: true,
      values: parseEnvText(content),
    };
  } catch {
    return {
      resolvedPath,
      exists: false,
      values: {},
    };
  }
}

function pickSetting(optionValue, envName, envFileValues) {
  return optionValue ?? process.env[envName] ?? envFileValues[envName] ?? null;
}

function resolveAbsolutePath(rootPath, maybeRelativePath) {
  if (!maybeRelativePath) {
    return null;
  }
  return path.isAbsolute(maybeRelativePath)
    ? path.normalize(maybeRelativePath)
    : path.resolve(rootPath, maybeRelativePath);
}

function formatDisplayPath(rootPath, targetPath) {
  if (!targetPath) {
    return null;
  }
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  const relativePath = path.relative(normalizedRoot, normalizedTarget);
  if (
    relativePath &&
    relativePath !== '.' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return toPosix(relativePath);
  }
  return path.basename(normalizedTarget);
}

function createFrontendBuildCommand(platform) {
  if (platform !== 'windows') {
    throw new Error(`--build currently supports only platform='windows'. Received '${platform}'.`);
  }
  return {
    command: defaultCorepackBin,
    args: ['pnpm', 'bundle:companion:windows'],
  };
}

function defaultFrontendSourceDir(frontendRoot, platform) {
  if (platform !== 'windows') {
    throw new Error(`No default frontend dist directory is defined for platform '${platform}'.`);
  }
  return path.join(frontendRoot, '.dist', 'bundles', 'companion-app', 'windows');
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

async function readSourceArtifactManifest(sourceDir) {
  const manifestPath = path.join(sourceDir, 'bundle-manifest.json');
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `source bundle-manifest.json not found at ${manifestPath}. ` +
        'Ensure the frontend bundle step completed successfully before publishing.',
    );
  }
}

function assertManifestIdentityMatches(manifest, options) {
  const {bundleId, version, platform} = options;
  if (bundleId && manifest.bundleId && manifest.bundleId !== bundleId) {
    throw new Error(
      `source manifest bundleId '${manifest.bundleId}' does not match --bundle-id='${bundleId}'.`,
    );
  }
  if (version && manifest.version && manifest.version !== version) {
    throw new Error(
      `source manifest version '${manifest.version}' does not match --version='${version}'.`,
    );
  }
  if (platform && manifest.platform && manifest.platform !== platform) {
    throw new Error(
      `source manifest platform '${manifest.platform}' does not match --platform='${platform}'.`,
    );
  }
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

async function runCommand(command, args, cwd, dryRun, options = {}) {
  if (dryRun) {
    return {code: 0};
  }

  const resolvedCommand =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
      ? process.env.ComSpec ?? 'cmd.exe'
      : command;
  const resolvedArgs =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
      ? ['/d', '/s', '/c', command, ...args]
      : args;

  return await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve({code: 0});
      } else {
        reject(new Error(`command failed (${code}): ${resolvedCommand} ${resolvedArgs.join(' ')}`));
      }
    });
  });
}

function createWranglerArgs({wranglerBin, wranglerConfig, bucket, objectKey, mode, localPath}) {
  const wranglerArgs = [];
  if (wranglerBin === defaultWranglerBin) {
    wranglerArgs.push('wrangler');
  }
  wranglerArgs.push('r2', 'object', mode, `${bucket}/${objectKey}`);
  if (mode === 'put') {
    wranglerArgs.push('--file', localPath);
  }
  if (wranglerConfig) {
    wranglerArgs.push('--config', wranglerConfig);
  }
  return wranglerArgs;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function deleteUploadedKeysViaWrangler({
  uploadedKeys,
  bucket,
  wranglerBin,
  wranglerConfig,
  dryRun,
  executeCommand,
  reportCompensationEvent,
}) {
  const cleanupFailures = [];
  for (const objectKey of [...uploadedKeys].reverse()) {
    try {
      const deleteArgs = createWranglerArgs({
        wranglerBin,
        wranglerConfig,
        bucket,
        objectKey,
        mode: 'delete',
      });
      await executeCommand(wranglerBin, deleteArgs, repoRoot, dryRun);
      reportCompensationEvent({
        phase: 'cleanup-delete',
        objectKey,
        status: 'deleted',
      });
    } catch (error) {
      const message = errorMessage(error);
      cleanupFailures.push({
        objectKey,
        message,
      });
      reportCompensationEvent({
        phase: 'cleanup-delete',
        objectKey,
        status: 'failed',
        message,
      });
    }
  }
  return cleanupFailures;
}

async function uploadFilesWithWrangler({
  files,
  bucket,
  objectPrefix,
  wranglerBin,
  wranglerConfig,
  dryRun,
  executeCommand = runCommand,
  reportCompensationEvent = () => {},
}) {
  const uploadedKeys = [];
  try {
    for (const file of files) {
      const objectKey = joinObjectKey(objectPrefix, file.relativeRegistryPath);
      const wranglerArgs = createWranglerArgs({
        wranglerBin,
        wranglerConfig,
        bucket,
        objectKey,
        mode: 'put',
        localPath: file.localPath,
      });
      await executeCommand(wranglerBin, wranglerArgs, repoRoot, dryRun);
      uploadedKeys.push(objectKey);
    }
  } catch (uploadError) {
    const uploadErrorText = errorMessage(uploadError);
    reportCompensationEvent({
      phase: 'cleanup-start',
      uploadError: uploadErrorText,
      attemptedDeletes: uploadedKeys.length,
    });
    const cleanupFailures = await deleteUploadedKeysViaWrangler({
      uploadedKeys,
      bucket,
      wranglerBin,
      wranglerConfig,
      dryRun,
      executeCommand,
      reportCompensationEvent,
    });
    reportCompensationEvent({
      phase: 'cleanup-summary',
      attemptedDeletes: uploadedKeys.length,
      cleanedCount: uploadedKeys.length - cleanupFailures.length,
      failedCount: cleanupFailures.length,
    });
    if (cleanupFailures.length === 0) {
      throw uploadError;
    }

    const cleanupSummary = cleanupFailures
      .map(failure => `${failure.objectKey}: ${failure.message}`)
      .join('; ');
    throw new Error(
      `upload failed and cleanup was partial. upload error: ${uploadErrorText}. cleanup errors: ${cleanupSummary}`,
    );
  }
  return uploadedKeys;
}

async function executeSignedR2ObjectRequest({
  endpoint,
  bucket,
  objectKey,
  method,
  accessKeyId,
  secretAccessKey,
  body,
  dryRun,
  fetchImpl = fetch,
}) {
  if (dryRun) {
    return {ok: true, status: 200};
  }

  const request = createSignedR2Request({
    endpoint,
    bucket,
    objectKey,
    method,
    accessKeyId,
    secretAccessKey,
    body,
  });
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  if (response.ok) {
    return response;
  }

  const detail = await response.text().catch(() => '');
  throw new Error(
    `R2 ${request.method} failed (${response.status}) for ${bucket}/${objectKey}` +
      (detail ? `: ${detail.slice(0, 300)}` : '.'),
  );
}

async function deleteUploadedKeysFromR2({
  uploadedKeys,
  bucket,
  r2Endpoint,
  r2AccessKeyId,
  r2SecretAccessKey,
  dryRun,
  executeObjectRequest,
  reportCompensationEvent,
}) {
  const cleanupFailures = [];
  for (const objectKey of [...uploadedKeys].reverse()) {
    try {
      await executeObjectRequest({
        endpoint: r2Endpoint,
        bucket,
        objectKey,
        method: 'DELETE',
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        body: null,
        dryRun,
      });
      reportCompensationEvent({
        phase: 'cleanup-delete',
        objectKey,
        status: 'deleted',
      });
    } catch (error) {
      const message = errorMessage(error);
      cleanupFailures.push({
        objectKey,
        message,
      });
      reportCompensationEvent({
        phase: 'cleanup-delete',
        objectKey,
        status: 'failed',
        message,
      });
    }
  }
  return cleanupFailures;
}

export async function uploadFilesToR2({
  files,
  bucket,
  objectPrefix,
  r2Endpoint,
  r2AccessKeyId,
  r2SecretAccessKey,
  dryRun,
  executeObjectRequest = executeSignedR2ObjectRequest,
  reportCompensationEvent = () => {},
}) {
  const uploadedKeys = [];
  try {
    for (const file of files) {
      const objectKey = joinObjectKey(objectPrefix, file.relativeRegistryPath);
      const body = await readFile(file.localPath);
      await executeObjectRequest({
        endpoint: r2Endpoint,
        bucket,
        objectKey,
        method: 'PUT',
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        body,
        dryRun,
      });
      uploadedKeys.push(objectKey);
    }
  } catch (uploadError) {
    const uploadErrorText = errorMessage(uploadError);
    reportCompensationEvent({
      phase: 'cleanup-start',
      uploadError: uploadErrorText,
      attemptedDeletes: uploadedKeys.length,
    });
    const cleanupFailures = await deleteUploadedKeysFromR2({
      uploadedKeys,
      bucket,
      r2Endpoint,
      r2AccessKeyId,
      r2SecretAccessKey,
      dryRun,
      executeObjectRequest,
      reportCompensationEvent,
    });
    reportCompensationEvent({
      phase: 'cleanup-summary',
      attemptedDeletes: uploadedKeys.length,
      cleanedCount: uploadedKeys.length - cleanupFailures.length,
      failedCount: cleanupFailures.length,
    });
    if (cleanupFailures.length === 0) {
      throw uploadError;
    }

    const cleanupSummary = cleanupFailures
      .map(failure => `${failure.objectKey}: ${failure.message}`)
      .join('; ');
    throw new Error(
      `upload failed and cleanup was partial. upload error: ${uploadErrorText}. cleanup errors: ${cleanupSummary}`,
    );
  }
  return uploadedKeys;
}

export async function uploadFilesToCloudflare({
  uploadMode = 'wrangler',
  executeObjectRequest,
  ...options
}) {
  if (uploadMode === 'r2-s3') {
    return uploadFilesToR2({
      ...options,
      executeObjectRequest,
    });
  }

  if (uploadMode !== 'wrangler') {
    throw new Error(`unsupported upload mode '${uploadMode}'. Expected 'r2-s3' or 'wrangler'.`);
  }

  return uploadFilesWithWrangler(options);
}

function printUsageAndExit(exitCode = 1) {
  console.error(
    'Usage:\n' +
      '  node ota-cloudflare-publish.mjs [--build] [--env-file=<path>] [--bundle-id=<id>]\n' +
      '    [--platform=<platform>] [--version=<ver>] [--source-dir=<dir>]\n' +
      '    [--remote-base=<url>] --channel=<name> --rollout-percent=<0-100>\n' +
      '    [--cloudflare-bucket=<bucket>] [--registry-dir=<dir>] [--cloudflare-prefix=<prefix>]\n' +
      '    [--upload-mode=<r2-s3|wrangler>] [--r2-endpoint=<url>] [--r2-access-key-id=<id>]\n' +
      '    [--r2-secret-access-key=<secret>] [--r2-account-id=<id>] [--r2-jurisdiction=<value>]\n' +
      '    [--frontend-root=<dir>] [--wrangler-bin=<cmd>] [--wrangler-config=<path>]\n' +
      '    [--skip-upload] [--dry-run]\n',
  );
  process.exit(exitCode);
}

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printUsageAndExit(0);
  }

  const envFileArg = parseArg('env-file');
  const envFile = await readEnvFileValues(envFileArg ?? defaultEnvFile);
  const envValues = envFile.values;

  const build = hasFlag('build');
  const sourceDirArg = parseArg('source-dir');
  const registryDirArg = parseArg('registry-dir');
  const bundleIdArg = parseArg('bundle-id');
  const versionArg = parseArg('version');
  const platformArg = parseArg('platform') ?? defaultPlatform;
  const remoteBase = pickSetting(parseArg('remote-base'), 'R2_PUBLIC_BASE_URL', envValues);
  const channel = parseArg('channel');
  const rolloutPercentArg = parseArg('rollout-percent');
  const cloudflareBucket = pickSetting(parseArg('cloudflare-bucket'), 'R2_BUCKET', envValues);
  const uploadModeArg = parseArg('upload-mode');
  const cloudflarePrefixArg = parseArg('cloudflare-prefix');
  const wranglerBin = parseArg('wrangler-bin') ?? defaultWranglerBin;
  const wranglerConfig = parseArg('wrangler-config');
  const frontendRoot = resolveAbsolutePath(
    repoRoot,
    parseArg('frontend-root') ?? defaultFrontendRoot,
  );
  const r2Jurisdiction = pickSetting(parseArg('r2-jurisdiction'), 'R2_JURISDICTION', envValues) ?? 'default';
  const r2Endpoint = deriveR2Endpoint({
    accountId: pickSetting(parseArg('r2-account-id'), 'R2_ACCOUNT_ID', envValues),
    endpoint: pickSetting(parseArg('r2-endpoint'), 'R2_ENDPOINT', envValues),
    jurisdiction: r2Jurisdiction,
  });
  const r2AccessKeyId = pickSetting(parseArg('r2-access-key-id'), 'R2_ACCESS_KEY_ID', envValues);
  const r2SecretAccessKey = pickSetting(
    parseArg('r2-secret-access-key'),
    'R2_SECRET_ACCESS_KEY',
    envValues,
  );
  const skipUpload = hasFlag('skip-upload');
  const dryRun = hasFlag('dry-run');

  if (!channel || !rolloutPercentArg) {
    throw new Error('--channel and --rollout-percent are required.');
  }
  if (!remoteBase) {
    throw new Error(
      '--remote-base is required. You can also provide R2_PUBLIC_BASE_URL in the env file.',
    );
  }
  if (!cloudflareBucket) {
    throw new Error(
      '--cloudflare-bucket is required. You can also provide R2_BUCKET in the env file.',
    );
  }

  const rolloutPercent = parsePercent(rolloutPercentArg);
  const registryRoot = registryDirArg
    ? resolveAbsolutePath(repoRoot, registryDirArg)
    : defaultRegistryDir;
  let workingRegistryRoot = registryRoot;
  let tempRegistryRoot = null;

  let sourceDir = sourceDirArg ? resolveAbsolutePath(repoRoot, sourceDirArg) : null;
  let buildSourceDir = null;
  if (build) {
    const buildCommand = createFrontendBuildCommand(platformArg);
    await runCommand(buildCommand.command, buildCommand.args, frontendRoot, false);
    buildSourceDir = defaultFrontendSourceDir(frontendRoot, platformArg);
    sourceDir = sourceDir ?? buildSourceDir;
  }

  let sourceManifest = null;
  if (sourceDir) {
    sourceManifest = await readSourceArtifactManifest(sourceDir);
    assertManifestIdentityMatches(sourceManifest, {
      bundleId: bundleIdArg,
      version: versionArg,
      platform: platformArg,
    });
  }

  const bundleId = bundleIdArg ?? sourceManifest?.bundleId ?? null;
  const version = versionArg ?? sourceManifest?.version ?? null;
  const platform = sourceManifest?.platform ?? platformArg;
  if (!bundleId || !version) {
    throw new Error(
      '--bundle-id and --version are required unless they can be resolved from --source-dir.',
    );
  }

  const uploadMode =
    uploadModeArg ??
    (r2Endpoint && r2AccessKeyId && r2SecretAccessKey ? 'r2-s3' : 'wrangler');
  if (uploadMode === 'r2-s3') {
    if (!r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
      throw new Error(
        "upload mode 'r2-s3' requires R2 endpoint, access key ID, and secret access key.",
      );
    }
  } else if (uploadMode !== 'wrangler') {
    throw new Error(`unsupported upload mode '${uploadMode}'. Expected 'r2-s3' or 'wrangler'.`);
  }

  const objectPrefix = cloudflarePrefixArg ?? derivePrefixFromRemoteBase(remoteBase);

  const reportCompensationEvent = event => {
    console.warn(
      `[ota-cloudflare-publish] ${JSON.stringify({
        event: 'upload-compensation',
        ...event,
      })}`,
    );
  };

  try {
    if (dryRun && sourceDir) {
      tempRegistryRoot = await mkdtemp(path.join(os.tmpdir(), 'opapp-ota-publish-dry-run-'));
      workingRegistryRoot = tempRegistryRoot;
    }

    let publishedRegistryPath = null;
    if (sourceDir) {
      publishedRegistryPath = await publishToLocalRegistry(sourceDir, workingRegistryRoot);
    }

    const artifact = await ensureRegistryArtifact(workingRegistryRoot, bundleId, version, platform);
    const indexPath = path.join(workingRegistryRoot, 'index.json');
    const sidecarPaths = [
      path.join(workingRegistryRoot, bundleId, 'channels.json'),
      path.join(workingRegistryRoot, bundleId, 'rollout.json'),
      indexPath,
    ];

    const executePublishPipeline = async () => {
      await upsertBundleSidecars(workingRegistryRoot, bundleId, channel, version, rolloutPercent);

      const localIndex = await generateRegistryIndex(workingRegistryRoot);
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
            uploadMode,
            files: uploadFiles,
            bucket: cloudflareBucket,
            objectPrefix,
            wranglerBin,
            wranglerConfig,
            r2Endpoint,
            r2AccessKeyId,
            r2SecretAccessKey,
            dryRun,
            reportCompensationEvent,
          });

      return {
        remoteIndex,
        uploadedKeys,
        publishedRegistryPath,
      };
    };

    const publishResult =
      dryRun && !tempRegistryRoot
        ? await withFileRollback(sidecarPaths, executePublishPipeline)
        : await executePublishPipeline();

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
        workingRegistryRoot,
        sourceDir,
        build,
        buildSourceDir,
        uploadMode,
        envFileUsed: envFile.exists ? formatDisplayPath(workspaceRoot, envFile.resolvedPath) : null,
        publishedRegistryPath: publishResult.publishedRegistryPath,
        mergedFromRemote: publishResult.remoteIndex !== null,
        uploadedCount: publishResult.uploadedKeys.length,
        uploadedKeys: publishResult.uploadedKeys,
        skipUpload,
        dryRun,
      }),
    );
  } finally {
    if (tempRegistryRoot) {
      await rm(tempRegistryRoot, {recursive: true, force: true});
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(`[ota-cloudflare-publish] ${error.message}`);
    process.exit(1);
  });
}
