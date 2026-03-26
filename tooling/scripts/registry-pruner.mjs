/**
 * Registry version pruner for desktop host (RFC-012).
 *
 * Removes old artifact versions from a local registry directory, keeping only
 * the latest N versions per bundle.  Works identically for
 * `.artifact-registry/` and `.ota-cache/`.
 *
 * Usage:
 *   node tooling/scripts/registry-pruner.mjs [--dir=<path>] [--keep=<N>] [--bundle-id=<id>] [--dry-run]
 *
 * --dir=<path>       Registry root directory (default: .artifact-registry).
 *                    Use --dir=.ota-cache to prune the OTA cache.
 * --keep=<N>         Number of latest versions to keep per bundle (default: 3).
 * --bundle-id=<id>   Prune only the specified bundle; prune all when omitted.
 * --dry-run          Preview removals without deleting anything.
 *
 * Each pruned bundle emits one JSON line:
 *   {"bundleId":"...","removedVersions":[...],"keptVersions":[...],"dryRun":false}
 */

import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {pruneLocalRegistry} from './artifact-source.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const DEFAULT_DIR = path.join(repoRoot, '.artifact-registry');

function _parseArg(name) {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
}

async function main() {
  const dirArg = _parseArg('dir');
  const registryRoot = dirArg
    ? path.resolve(repoRoot, dirArg)
    : DEFAULT_DIR;

  const keepArg = _parseArg('keep');
  const keepVersions = keepArg !== null ? parseInt(keepArg, 10) : 3;
  if (Number.isNaN(keepVersions) || keepVersions < 0) {
    throw new Error(`registry-pruner: --keep must be a non-negative integer, got '${keepArg}'.`);
  }

  const bundleIdArg = _parseArg('bundle-id') ?? undefined;
  const dryRun = process.argv.includes('--dry-run');

  const results = await pruneLocalRegistry(registryRoot, {
    bundleId: bundleIdArg,
    keepVersions,
    dryRun,
  });

  for (const entry of results) {
    console.log(JSON.stringify({...entry, dryRun}));
  }
}

main().catch(err => {
  console.error(`[registry-pruner] ${err.message}`);
  process.exit(1);
});
