/**
 * Artifact resolution abstractions for desktop host bundle staging.
 *
 * Implements the ArtifactSource interface defined in RFC-004, Phase 2.
 * The interface allows the host staging and verification logic to be decoupled
 * from any particular artifact origin, making it straightforward to add
 * RegistryArtifactSource, CdnArtifactSource, or LocalCacheArtifactSource
 * in the future without changing the staging pipeline.
 */

import {readFile, readdir, cp, mkdir} from 'node:fs/promises';
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