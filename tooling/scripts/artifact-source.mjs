/**
 * Artifact resolution abstractions for desktop host bundle staging.
 *
 * Implements the ArtifactSource interface defined in RFC-004, Phase 2.
 * The interface allows the host staging and verification logic to be decoupled
 * from any particular artifact origin, making it straightforward to add
 * RegistryArtifactSource, CdnArtifactSource, or LocalCacheArtifactSource
 * in the future without changing the staging pipeline.
 */

import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, cp, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} ArtifactResolveOptions
 * @property {string} platform - Target platform identifier (e.g. 'windows').
 * @property {string} [bundleId] - Optional bundle ID filter; defaults to the first
 *   available bundle in the source.
 * @property {string} [version] - Optional version filter; defaults to the latest
 *   available version in the source.
 */

/**
 * @typedef {Object} ArtifactResolveResult
 * @property {Object} manifest - Parsed bundle-manifest.json contents.
 * @property {string} bundlePath - Absolute path to the resolved bundle file.
 * @property {string} manifestDir - Absolute path to the directory containing the
 *   manifest and bundle artifact (suitable for use as a staging source root).
 */

/**
 * Base class representing the ArtifactSource interface contract (RFC-004 3).
 *
 * Subclasses override resolve() to provide artifacts from different origins
 * (sibling repo, registry, CDN, local cache, etc.) without requiring changes
 * to host staging or smoke verification logic.
 */
export class ArtifactSource {
  /**
   * Resolve an artifact matching the given options.
   * @param {ArtifactResolveOptions} _options
   * @returns {Promise<ArtifactResolveResult>}
   */
  async resolve(_options) {
    throw new Error('ArtifactSource.resolve() must be implemented by subclasses.');
  }
}

/**
 * Resolves artifacts from a sibling frontend repository's local build output.
 *
 * Reads bundle-manifest.json from the configured manifest directory (the
 * frontend's dist output path), validates it, and returns the resolved
 * artifact metadata. The manifestDir in the result is the staging source root
 * that can be copied directly into the host's Bundle directory.
 */
export class SiblingArtifactSource extends ArtifactSource {
  /**
   * @param {string} manifestDir - Absolute path to the frontend dist directory
   *   that contains bundle-manifest.json and the bundle artifact file.
   */
  constructor(manifestDir) {
    super();
    /** @type {string} */
    this.manifestDir = manifestDir;
  }

  /**
   * @param {ArtifactResolveOptions} options
   * @returns {Promise<ArtifactResolveResult>}
   */
  async resolve(options) {
    const manifestPath = path.join(this.manifestDir, 'bundle-manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error(
        `SiblingArtifactSource: bundle-manifest.json not found at ${manifestPath}. ` +
          'Ensure the frontend bundle step completed successfully before staging.',
      );
    }

    if (options.platform && manifest.platform !== options.platform) {
      throw new Error(
        `SiblingArtifactSource: manifest platform '${manifest.platform}' does not match ` +
          `requested platform '${options.platform}'.`,
      );
    }

    if (!manifest.entryFile) {
      throw new Error(
        'SiblingArtifactSource: bundle-manifest.json is missing required entryFile field.',
      );
    }

    const bundlePath = path.join(this.manifestDir, manifest.entryFile);
    if (!existsSync(bundlePath)) {
      throw new Error(
        `SiblingArtifactSource: entryFile '${manifest.entryFile}' not found at ${bundlePath}. ` +
          'The bundle artifact may not have been generated successfully.',
      );
    }

    await _verifyBundleChecksum(manifest, bundlePath);
    return {manifest, bundlePath, manifestDir: this.manifestDir};
  }
}

/**
 * Resolves artifacts from a versioned local artifact registry directory.
 *
 * Registry layout (RFC-007):
 *   <registryRoot>/
 *     <bundleId>/
 *       <version>/
 *         <platform>/
 *           bundle-manifest.json
 *           <entryFile>
 *           window-policy-registry.json   (optional)
 *
 * When bundleId or version are omitted in ArtifactResolveOptions, the source
 * auto-selects the only available option (or throws if there are multiple
 * choices for bundleId, or picks the lexicographically latest for version).
 */
export class LocalRegistryArtifactSource extends ArtifactSource {
  /**
   * @param {string} registryRoot - Absolute path to the artifact registry root.
   */
  constructor(registryRoot) {
    super();
    /** @type {string} */
    this.registryRoot = registryRoot;
  }

  /**
   * @param {ArtifactResolveOptions} options
   * @returns {Promise<ArtifactResolveResult>}
   */
  async resolve(options) {
    const {platform, bundleId, version} = options;
    if (!platform) {
      throw new Error('LocalRegistryArtifactSource.resolve() requires options.platform.');
    }

    // Resolve bundleId
    let resolvedBundleId = bundleId;
    if (!resolvedBundleId) {
      let entries;
      try {
        entries = (await readdir(this.registryRoot, {withFileTypes: true}))
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch {
        throw new Error(
          `LocalRegistryArtifactSource: registry root not found or unreadable: ${this.registryRoot}`,
        );
      }
      if (entries.length === 0) {
        throw new Error(
          `LocalRegistryArtifactSource: no bundles found in registry: ${this.registryRoot}`,
        );
      }
      if (entries.length > 1) {
        throw new Error(
          `LocalRegistryArtifactSource: multiple bundles found; specify bundleId. ` +
            `Available: ${entries.join(', ')}`,
        );
      }
      resolvedBundleId = entries[0];
    }

    const bundleIdDir = path.join(this.registryRoot, resolvedBundleId);

    // Resolve version (pick lexicographically latest when omitted)
    let resolvedVersion = version;
    if (!resolvedVersion) {
      let versions;
      try {
        versions = (await readdir(bundleIdDir, {withFileTypes: true}))
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch {
        throw new Error(
          `LocalRegistryArtifactSource: bundle '${resolvedBundleId}' not found in registry: ${this.registryRoot}`,
        );
      }
      if (versions.length === 0) {
        throw new Error(
          `LocalRegistryArtifactSource: no versions for bundle '${resolvedBundleId}' in registry: ${this.registryRoot}`,
        );
      }
      resolvedVersion = versions.sort().at(-1);
    }

    const manifestDir = path.join(bundleIdDir, resolvedVersion, platform);
    const manifestPath = path.join(manifestDir, 'bundle-manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error(
        `LocalRegistryArtifactSource: bundle-manifest.json not found at ${manifestPath}. ` +
          `Ensure artifacts for bundleId='${resolvedBundleId}' version='${resolvedVersion}' ` +
          `platform='${platform}' have been published to the registry (see publishToLocalRegistry).`,
      );
    }

    if (manifest.platform !== platform) {
      throw new Error(
        `LocalRegistryArtifactSource: manifest platform '${manifest.platform}' does not match ` +
          `requested platform '${platform}'.`,
      );
    }

    if (!manifest.entryFile) {
      throw new Error(
        `LocalRegistryArtifactSource: bundle-manifest.json is missing required entryFile field at ${manifestPath}.`,
      );
    }

    const bundlePath = path.join(manifestDir, manifest.entryFile);
    if (!existsSync(bundlePath)) {
      throw new Error(
        `LocalRegistryArtifactSource: entryFile '${manifest.entryFile}' not found at ${bundlePath}.`,
      );
    }

    await _verifyBundleChecksum(manifest, bundlePath);
    return {manifest, bundlePath, manifestDir};
  }
}

/**
 * Publishes a frontend build artifact to the local registry (RFC-007).
 *
 * Reads bundle-manifest.json from sourceDir to determine bundleId, version,
 * platform, and entryFile, then copies all relevant files to the target
 * registry directory: <registryRoot>/<bundleId>/<version>/<platform>/
 *
 * The manifest sourceKind is NOT modified here  it remains 'local-build'.
 * The host-side staging step (smoke scripts) is responsible for overwriting
 * sourceKind to 'sibling-staging' after copying to the host project directory.
 *
 * @param {string} sourceDir - Absolute path to the frontend dist directory
 *   containing bundle-manifest.json and the bundle artifact.
 * @param {string} registryRoot - Absolute path to the artifact registry root.
 * @returns {Promise<string>} The absolute path of the created registry entry directory.
 */
export async function publishToLocalRegistry(sourceDir, registryRoot) {
  const manifestPath = path.join(sourceDir, 'bundle-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `publishToLocalRegistry: bundle-manifest.json not found at ${manifestPath}. ` +
        'Ensure the frontend bundle step completed successfully before publishing.',
    );
  }

  const {bundleId, version, platform, entryFile} = manifest;
  if (!bundleId || !version || !platform || !entryFile) {
    throw new Error(
      'publishToLocalRegistry: manifest is missing required fields ' +
        '(bundleId, version, platform, entryFile).',
    );
  }

  const targetDir = path.join(registryRoot, bundleId, version, platform);
  await mkdir(targetDir, {recursive: true});

  await cp(
    path.join(sourceDir, 'bundle-manifest.json'),
    path.join(targetDir, 'bundle-manifest.json'),
    {force: true},
  );
  await cp(
    path.join(sourceDir, entryFile),
    path.join(targetDir, entryFile),
    {force: true},
  );

  const policyRegistrySrc = path.join(sourceDir, 'window-policy-registry.json');
  if (existsSync(policyRegistrySrc)) {
    await cp(
      policyRegistrySrc,
      path.join(targetDir, 'window-policy-registry.json'),
      {force: true},
    );
  }

  return targetDir;
}

/**
 * Resolves artifacts from a remote HTTP artifact registry (RFC-008).
 *
 * Downloads artifacts from a URL that mirrors the local registry layout (RFC-007):
 *   <baseUrl>/index.json
 *   <baseUrl>/<bundleId>/<version>/<platform>/bundle-manifest.json
 *   <baseUrl>/<bundleId>/<version>/<platform>/<entryFile>
 *   <baseUrl>/<bundleId>/<version>/<platform>/window-policy-registry.json  (optional)
 *
 * Downloaded artifacts are cached to a local directory (same format as
 * LocalRegistryArtifactSource), so subsequent calls for the same artifact
 * serve from the cache without network access.
 *
 * @example
 * const source = new RemoteArtifactSource(
 *   'https://artifacts.example.com',
 *   '/workspace/.artifact-registry',
 * );
 * const {manifest, bundlePath} = await source.resolve({platform: 'windows'});
 */
export class RemoteArtifactSource extends ArtifactSource {
  /**
   * @param {string} baseUrl - Base URL of the remote artifact registry.
   * @param {string} cacheDir - Local cache directory (RFC-007 registry format).
   * @param {object} [options]
   * @param {boolean} [options.forceRefresh=false] - When true, bypass local cache
   *   and re-download from remote even if artifacts are already cached.
   */
  constructor(baseUrl, cacheDir, options = {}) {
    super();
    /** @type {string} */
    this.baseUrl = baseUrl.replace(/\/$/, '');
    /** @type {string} */
    this.cacheDir = cacheDir;
    /** @type {boolean} */
    this.forceRefresh = options.forceRefresh ?? false;
  }

  /**
   * @param {ArtifactResolveOptions} options
   * @returns {Promise<ArtifactResolveResult>}
   */
  async resolve(options) {
    const {platform} = options;
    if (!platform) {
      throw new Error('RemoteArtifactSource.resolve() requires options.platform.');
    }

    let {bundleId, version} = options;

    // Auto-resolve bundleId / version from remote index when omitted
    if (!bundleId || !version) {
      const indexUrl = `${this.baseUrl}/index.json`;
      const index = await _fetchRemoteJson(indexUrl);
      const bundles = index?.bundles ?? {};
      const bundleIds = Object.keys(bundles);

      if (!bundleId) {
        if (bundleIds.length === 0) {
          throw new Error(
            `RemoteArtifactSource: no bundles in registry index at ${indexUrl}`,
          );
        }
        if (bundleIds.length > 1) {
          throw new Error(
            `RemoteArtifactSource: multiple bundles in registry; specify bundleId. ` +
              `Available: ${bundleIds.join(', ')}`,
          );
        }
        bundleId = bundleIds[0];
      }

      if (!version) {
        const bundleInfo = bundles[bundleId];
        if (!bundleInfo) {
          throw new Error(
            `RemoteArtifactSource: bundleId '${bundleId}' not found in registry index at ${indexUrl}`,
          );
        }
        const versions = Array.isArray(bundleInfo.versions) ? bundleInfo.versions : [];
        if (versions.length === 0) {
          throw new Error(
            `RemoteArtifactSource: no versions for bundle '${bundleId}' in registry index at ${indexUrl}`,
          );
        }
        // Consistent with LocalRegistryArtifactSource: lexicographically latest
        version = [...versions].sort().at(-1);
      }
    }

    // Check local cache first (unless forceRefresh)
    const cachedManifestPath = path.join(
      this.cacheDir,
      bundleId,
      version,
      platform,
      'bundle-manifest.json',
    );
    if (!this.forceRefresh && existsSync(cachedManifestPath)) {
      const localSource = new LocalRegistryArtifactSource(this.cacheDir);
      return localSource.resolve({platform, bundleId, version});
    }

    // Download from remote
    const remoteBase = `${this.baseUrl}/${bundleId}/${version}/${platform}`;
    const targetDir = path.join(this.cacheDir, bundleId, version, platform);
    await mkdir(targetDir, {recursive: true});

    // Fetch manifest first to discover entryFile
    const manifest = await _fetchRemoteJson(`${remoteBase}/bundle-manifest.json`);
    if (!manifest.entryFile) {
      throw new Error(
        `RemoteArtifactSource: bundle-manifest.json at ${remoteBase}/bundle-manifest.json ` +
          'is missing required entryFile field.',
      );
    }
    await writeFile(
      path.join(targetDir, 'bundle-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    // Download bundle file
    await _downloadRemoteFile(
      `${remoteBase}/${manifest.entryFile}`,
      path.join(targetDir, manifest.entryFile),
    );

    // Download window-policy-registry.json (optional; 404 is silently ignored)
    try {
      await _downloadRemoteFile(
        `${remoteBase}/window-policy-registry.json`,
        path.join(targetDir, 'window-policy-registry.json'),
      );
    } catch (err) {
      if (!err.message.includes('HTTP 404')) {
        throw err;
      }
    }

    const bundlePath = path.join(targetDir, manifest.entryFile);
    await _verifyBundleChecksum(manifest, bundlePath);
    return {manifest, bundlePath, manifestDir: targetDir};
  }
}

/**
 * Generates a registry index object from a local artifact registry directory.
 *
 * The returned object matches the remote registry index.json format (RFC-008)
 * and can be serialised and served alongside the registry artifacts:
 *
 * @example
 * const index = await generateRegistryIndex('/workspace/.artifact-registry');
 * await fs.writeFile('.artifact-registry/index.json', JSON.stringify(index, null, 2), 'utf8');
 *
 * @param {string} registryRoot - Absolute path to the artifact registry root.
 * @returns {Promise<{bundles: Object}>} Registry index structure.
 */
export async function generateRegistryIndex(registryRoot) {
  let bundleDirs;
  try {
    bundleDirs = (await readdir(registryRoot, {withFileTypes: true}))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    throw new Error(
      `generateRegistryIndex: registry root not found or unreadable: ${registryRoot}`,
    );
  }

  const bundles = {};
  for (const bundleId of bundleDirs) {
    const bundleIdDir = path.join(registryRoot, bundleId);
    let versions;
    try {
      versions = (await readdir(bundleIdDir, {withFileTypes: true}))
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      versions = [];
    }
    bundles[bundleId] = {
      latestVersion: versions.at(-1) ?? null,
      versions,
    };
  }

  return {bundles};
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Verifies the bundle file integrity against the checksum recorded in the
 * manifest (RFC-009). Only 'sha256' is supported. If the manifest has no
 * checksum field the function returns immediately (backward-compatible with
 * bundles built before RFC-009).
 *
 * @param {Object} manifest - Parsed bundle-manifest.json.
 * @param {string} bundlePath - Absolute path to the bundle file to verify.
 */
async function _verifyBundleChecksum(manifest, bundlePath) {
  if (!manifest.checksum) return;
  const {algorithm, value} = manifest.checksum;
  if (algorithm !== 'sha256') {
    throw new Error(
      `ArtifactSource: unsupported checksum algorithm '${algorithm}' in manifest.`,
    );
  }
  const buffer = await readFile(bundlePath);
  const computed = createHash('sha256').update(buffer).digest('hex');
  if (computed !== value) {
    throw new Error(
      `ArtifactSource: bundle checksum mismatch for ${bundlePath}.\n` +
        `  expected: ${value}\n` +
        `  computed: ${computed}`,
    );
  }
}

async function _fetchRemoteJson(url) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`RemoteArtifactSource: network error fetching ${url}: ${err.message}`);
  }
  if (!resp.ok) {
    throw new Error(`RemoteArtifactSource: HTTP ${resp.status} fetching ${url}`);
  }
  return resp.json();
}

async function _downloadRemoteFile(url, destPath) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`RemoteArtifactSource: network error downloading ${url}: ${err.message}`);
  }
  if (!resp.ok) {
    throw new Error(`RemoteArtifactSource: HTTP ${resp.status} downloading ${url}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(destPath, buffer);
}