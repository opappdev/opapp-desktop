/**
 * Registry operations CLI for managing rollout and channel sidecar files.
 *
 * Provides read/write access to rollout.json (RFC-014) and channels.json
 * (RFC-015) sidecar files that live alongside bundle artifacts in a local
 * artifact registry.  Designed as an operational companion to registry-pruner.mjs
 * without requiring a new RFC (these are implementation tools for RFC-014/015).
 *
 * Usage:
 *   node registry-ops.mjs rollout --get   --bundle-id=<id> [--dir=<path>]
 *   node registry-ops.mjs rollout --set=<percent>  --bundle-id=<id> [--dir=<path>]
 *   node registry-ops.mjs channel --get   --bundle-id=<id> [--dir=<path>]
 *   node registry-ops.mjs channel --set=<name>=<version> --bundle-id=<id> [--dir=<path>]
 *   node registry-ops.mjs channel --unset=<name> --bundle-id=<id> [--dir=<path>]
 *
 * Subcommands:
 *   rollout   Read or write rollout.json for staged rollout configuration.
 *   channel   Read or write channels.json for channel-pinned version mapping.
 *
 * Flags (common):
 *   --dir=<path>       Registry root directory (default: .artifact-registry).
 *   --bundle-id=<id>   Target bundle identifier (required for write operations).
 *   --dry-run          Preview changes without writing to disk.
 *
 * Flags (rollout subcommand):
 *   --get              Print current rollout.json as JSON; exits with { "rolloutPercent": null }
 *                      when no rollout.json exists (= 100% / full rollout).
 *   --set=<0-100>      Write rolloutPercent to rollout.json.
 *                      When percent is 100 the file is deleted (treated as full rollout).
 *
 * Flags (channel subcommand):
 *   --get              Print current channels.json as JSON.
 *   --set=<n>=<v>      Upsert channel <n> with version <v> in channels.json.
 *   --unset=<n>        Remove channel <n> from channels.json.
 *                      Deletes channels.json when the last entry is removed.
 *
 * Each operation emits one JSON line to stdout, e.g.:
 *   {"op":"rollout-set","bundleId":"...","rolloutPercent":20,"dryRun":false}
 *   {"op":"channel-set","bundleId":"...","channel":"beta","version":"0.3.0-beta.1","channels":{...},"dryRun":false}
 */

import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const DEFAULT_DIR = path.join(repoRoot, '.artifact-registry');

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function _parseArg(name) {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
}

function _hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file; returns null when the file does not exist.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
async function _readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically write a JSON file, creating parent directories as needed.
 * @param {string} filePath
 * @param {object} data
 * @param {boolean} dryRun
 */
async function _writeJson(filePath, data, dryRun) {
  if (!dryRun) {
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Rollout operations (RFC-014)
// ---------------------------------------------------------------------------

/**
 * Get rollout configuration for a bundle.
 *
 * @param {string} registryRoot
 * @param {string} bundleId
 * @returns {Promise<{bundleId: string, rolloutPercent: number|null}>}
 */
async function rolloutGet(registryRoot, bundleId) {
  const filePath = path.join(registryRoot, bundleId, 'rollout.json');
  const data = await _readJson(filePath);
  const rolloutPercent =
    data !== null && typeof data.percent === 'number' ? data.percent : null;
  return {op: 'rollout-get', bundleId, rolloutPercent};
}

/**
 * Set rollout percentage for a bundle.
 * Deletes rollout.json when percent is 100 (full rollout = no file needed).
 *
 * @param {string} registryRoot
 * @param {string} bundleId
 * @param {number} percent  Integer 0–100.
 * @param {boolean} dryRun
 * @returns {Promise<object>}
 */
async function rolloutSet(registryRoot, bundleId, percent, dryRun) {
  const filePath = path.join(registryRoot, bundleId, 'rollout.json');

  if (percent === 100) {
    const existed = existsSync(filePath);
    if (existed && !dryRun) await rm(filePath, {force: true});
    return {op: 'rollout-set', bundleId, rolloutPercent: 100, deleted: existed, dryRun};
  }

  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  await _writeJson(filePath, {percent: clamped, updatedAt: new Date().toISOString()}, dryRun);
  return {op: 'rollout-set', bundleId, rolloutPercent: clamped, dryRun};
}

// ---------------------------------------------------------------------------
// Channel operations (RFC-015)
// ---------------------------------------------------------------------------

/**
 * Get channels configuration for a bundle.
 *
 * @param {string} registryRoot
 * @param {string} bundleId
 * @returns {Promise<object>}
 */
async function channelGet(registryRoot, bundleId) {
  const filePath = path.join(registryRoot, bundleId, 'channels.json');
  const data = await _readJson(filePath);
  const channels = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
  return {op: 'channel-get', bundleId, channels};
}

/**
 * Upsert a channel entry in channels.json.
 *
 * @param {string} registryRoot
 * @param {string} bundleId
 * @param {string} channelName
 * @param {string} version
 * @param {boolean} dryRun
 * @returns {Promise<object>}
 */
async function channelSet(registryRoot, bundleId, channelName, version, dryRun) {
  const filePath = path.join(registryRoot, bundleId, 'channels.json');
  const existing = await _readJson(filePath) ?? {};
  const updated = {
    ...existing,
    [channelName]: version,
  };
  await _writeJson(filePath, updated, dryRun);
  return {op: 'channel-set', bundleId, channel: channelName, version, channels: updated, dryRun};
}

/**
 * Remove a channel entry from channels.json.
 * Deletes channels.json when the last entry is removed.
 *
 * @param {string} registryRoot
 * @param {string} bundleId
 * @param {string} channelName
 * @param {boolean} dryRun
 * @returns {Promise<object>}
 */
async function channelUnset(registryRoot, bundleId, channelName, dryRun) {
  const filePath = path.join(registryRoot, bundleId, 'channels.json');
  const existing = await _readJson(filePath) ?? {};

  if (!(channelName in existing)) {
    return {op: 'channel-unset', bundleId, channel: channelName, notFound: true, dryRun};
  }

  const {[channelName]: _removed, ...updated} = existing;

  if (Object.keys(updated).length === 0) {
    if (!dryRun) await rm(filePath, {force: true});
    return {op: 'channel-unset', bundleId, channel: channelName, deleted: true, channels: {}, dryRun};
  }

  await _writeJson(filePath, updated, dryRun);
  return {op: 'channel-unset', bundleId, channel: channelName, channels: updated, dryRun};
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error(
      'Usage:\n' +
      '  node registry-ops.mjs rollout --get   --bundle-id=<id> [--dir=<path>]\n' +
      '  node registry-ops.mjs rollout --set=<percent>  --bundle-id=<id> [--dir=<path>]\n' +
      '  node registry-ops.mjs channel --get   --bundle-id=<id> [--dir=<path>]\n' +
      '  node registry-ops.mjs channel --set=<name>=<version> --bundle-id=<id> [--dir=<path>]\n' +
      '  node registry-ops.mjs channel --unset=<name> --bundle-id=<id> [--dir=<path>]',
    );
    process.exit(1);
  }

  if (subcommand !== 'rollout' && subcommand !== 'channel') {
    throw new Error(`registry-ops: unknown subcommand '${subcommand}'. Expected 'rollout' or 'channel'.`);
  }

  const dirArg = _parseArg('dir');
  const registryRoot = dirArg ? path.resolve(repoRoot, dirArg) : DEFAULT_DIR;
  const bundleId = _parseArg('bundle-id');
  const dryRun = _hasFlag('dry-run');

  let result;

  if (subcommand === 'rollout') {
    if (_hasFlag('get')) {
      if (!bundleId) throw new Error('registry-ops rollout --get requires --bundle-id=<id>.');
      result = await rolloutGet(registryRoot, bundleId);
    } else {
      const setArg = _parseArg('set');
      if (setArg === null) {
        throw new Error('registry-ops rollout: expected --get or --set=<0-100>.');
      }
      if (!bundleId) throw new Error('registry-ops rollout --set requires --bundle-id=<id>.');
      const percent = parseInt(setArg, 10);
      if (Number.isNaN(percent) || percent < 0 || percent > 100) {
        throw new Error(`registry-ops rollout --set: value must be 0–100, got '${setArg}'.`);
      }
      result = await rolloutSet(registryRoot, bundleId, percent, dryRun);
    }
  } else {
    // channel subcommand
    if (_hasFlag('get')) {
      if (!bundleId) throw new Error('registry-ops channel --get requires --bundle-id=<id>.');
      result = await channelGet(registryRoot, bundleId);
    } else {
      const setArg = _parseArg('set');
      const unsetArg = _parseArg('unset');

      if (setArg !== null) {
        if (!bundleId) throw new Error('registry-ops channel --set requires --bundle-id=<id>.');
        const eqIdx = setArg.indexOf('=');
        if (eqIdx < 1) {
          throw new Error(
            `registry-ops channel --set: expected format <name>=<version>, got '${setArg}'.`,
          );
        }
        const channelName = setArg.slice(0, eqIdx);
        const version = setArg.slice(eqIdx + 1);
        if (!version) {
          throw new Error(
            `registry-ops channel --set: version cannot be empty in '${setArg}'.`,
          );
        }
        result = await channelSet(registryRoot, bundleId, channelName, version, dryRun);
      } else if (unsetArg !== null) {
        if (!bundleId) throw new Error('registry-ops channel --unset requires --bundle-id=<id>.');
        result = await channelUnset(registryRoot, bundleId, unsetArg, dryRun);
      } else {
        throw new Error('registry-ops channel: expected --get, --set=<n>=<v>, or --unset=<n>.');
      }
    }
  }

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error(`[registry-ops] ${err.message}`);
  process.exit(1);
});
