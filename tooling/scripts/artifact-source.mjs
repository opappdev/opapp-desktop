/**
 * Artifact resolution abstractions for desktop host bundle staging.
 *
 * Implements the ArtifactSource interface defined in RFC-004, Phase 2.
 * The interface allows the host staging and verification logic to be decoupled
 * from any particular artifact origin, making it straightforward to add
 * RegistryArtifactSource, CdnArtifactSource, or LocalCacheArtifactSource
 * in the future without changing the staging pipeline.
 */

import {readFile} from 'node:fs/promises';
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
 * Base class representing the ArtifactSource interface contract (RFC-004 §3).
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
