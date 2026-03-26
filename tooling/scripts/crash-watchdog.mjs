/**
 * OTA crash watchdog for the desktop Windows host (RFC-013).
 *
 * Maintains a crash counter in the OTA cache directory.  The native host
 * calls `--mode=guard` synchronously on every startup (before loading the
 * JS bundle) and `--mode=heartbeat` once the JS instance has loaded
 * successfully.
 *
 * If the application crashes before the heartbeat is received, the next
 * guard invocation increments the crash counter.  Once the counter reaches
 * the threshold (default: 3) and a rollback snapshot is available, the
 * watchdog triggers an OTA rollback automatically and exits with code 2 so
 * the host knows a rollback was performed.
 *
 * Usage:
 *   node crash-watchdog.mjs --mode=guard     [--cache-dir=<d>] [--threshold=<N>] [--platform=<p>] [--host-bundle-dir=<d>]
 *   node crash-watchdog.mjs --mode=heartbeat [--cache-dir=<d>]
 *
 * Exit codes:
 *   0  Normal startup; host should proceed as usual.
 *   2  Rollback was performed; the current launch will use the rolled-back bundle.
 *   1  Fatal error (unexpected failure).
 *
 * Output: a single JSON line to stdout describing the action taken:
 *   {"action":"guard","crashCount":1}
 *   {"action":"rollback","crashCount":0}
 *   {"action":"threshold-no-snapshot","crashCount":0}
 *   {"action":"heartbeat","crashCount":0}
 */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {readOtaState, rollbackOtaUpdate} from './ota-updater.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const DEFAULT_CACHE_DIR = path.join(repoRoot, '.ota-cache');
const DEFAULT_THRESHOLD = 3;
const DEFAULT_PLATFORM = 'windows';
const DEFAULT_HOST_BUNDLE_DIR = path.join(
  repoRoot,
  'hosts',
  'windows-host',
  'windows',
  'OpappWindowsHost',
  'Bundle',
);

const WATCHDOG_FILENAME = 'crash-watchdog.json';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _readWatchdogState(cacheDir) {
  try {
    return JSON.parse(await readFile(path.join(cacheDir, WATCHDOG_FILENAME), 'utf8'));
  } catch {
    return null;
  }
}

async function _writeWatchdogState(cacheDir, state) {
  await mkdir(cacheDir, {recursive: true});
  await writeFile(path.join(cacheDir, WATCHDOG_FILENAME), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Guard: called by the native host synchronously before loading the JS bundle.
 *
 * If the previous startup did not complete (inProgress is still true), the
 * crash counter is incremented.  When the counter reaches the threshold and
 * a rollback snapshot is available, rollback is triggered and the function
 * returns {action: 'rollback'}.  On rollback the caller should exit with
 * code 2 so the native host logs the event appropriately.
 *
 * @param {object} options
 * @param {string} options.cacheDir - OTA cache directory.
 * @param {number} options.threshold - Crash count that triggers rollback.
 * @param {string} options.platform - Target platform identifier.
 * @param {string} options.hostBundleDir - Host bundle directory for rollback.
 * @returns {Promise<{action: string, crashCount: number}>}
 */
export async function runWatchdogGuard({cacheDir, threshold, platform, hostBundleDir}) {
  const state = (await _readWatchdogState(cacheDir)) ?? {inProgress: false, crashCount: 0};

  const now = new Date().toISOString();

  if (state.inProgress) {
    state.crashCount = (state.crashCount ?? 0) + 1;
  }

  state.inProgress = true;
  state.lastGuardAt = now;

  if (state.crashCount >= threshold) {
    const otaState = await readOtaState(cacheDir);
    if (otaState?.previousSnapshot?.snapshotDir) {
      try {
        await rollbackOtaUpdate({
          cacheDir,
          hostBundleDir,
          bundleId: otaState.bundleId,
          platform,
        });
        state.inProgress = false;
        state.crashCount = 0;
        state.lastRollbackAt = now;
        await _writeWatchdogState(cacheDir, state);
        return {action: 'rollback', crashCount: 0};
      } catch (rollbackErr) {
        // Rollback failed — reset counter to avoid looping, then re-throw
        // so the caller logs the error and exits with code 1.
        state.crashCount = 0;
        await _writeWatchdogState(cacheDir, state);
        throw rollbackErr;
      }
    }

    // Threshold reached but no snapshot available: reset counter and proceed.
    state.crashCount = 0;
    await _writeWatchdogState(cacheDir, state);
    return {action: 'threshold-no-snapshot', crashCount: 0};
  }

  await _writeWatchdogState(cacheDir, state);
  return {action: 'guard', crashCount: state.crashCount};
}

/**
 * Heartbeat: called by the native host after the JS bundle has loaded
 * successfully.
 *
 * Resets inProgress and crashCount, signalling that the application started
 * without a crash.
 *
 * @param {object} options
 * @param {string} options.cacheDir - OTA cache directory.
 * @returns {Promise<{action: string, crashCount: number}>}
 */
export async function sendWatchdogHeartbeat({cacheDir}) {
  const state = (await _readWatchdogState(cacheDir)) ?? {inProgress: false, crashCount: 0};

  state.inProgress = false;
  state.crashCount = 0;
  state.lastHeartbeatAt = new Date().toISOString();

  await _writeWatchdogState(cacheDir, state);
  return {action: 'heartbeat', crashCount: 0};
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function _parseArg(name) {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
}

async function main() {
  const mode = _parseArg('mode');
  if (!mode) {
    throw new Error('crash-watchdog: --mode is required (guard|heartbeat).');
  }

  const cacheDir = _parseArg('cache-dir') ?? DEFAULT_CACHE_DIR;

  if (mode === 'guard') {
    const thresholdArg = _parseArg('threshold');
    const threshold = thresholdArg !== null ? parseInt(thresholdArg, 10) : DEFAULT_THRESHOLD;
    if (Number.isNaN(threshold) || threshold < 1) {
      throw new Error(`crash-watchdog: --threshold must be a positive integer, got '${thresholdArg}'.`);
    }
    const platform = _parseArg('platform') ?? DEFAULT_PLATFORM;
    const hostBundleDir = _parseArg('host-bundle-dir') ?? DEFAULT_HOST_BUNDLE_DIR;

    const result = await runWatchdogGuard({cacheDir, threshold, platform, hostBundleDir});
    console.log(JSON.stringify(result));
    if (result.action === 'rollback') {
      process.exit(2);
    }
  } else if (mode === 'heartbeat') {
    const result = await sendWatchdogHeartbeat({cacheDir});
    console.log(JSON.stringify(result));
  } else {
    throw new Error(`crash-watchdog: unknown --mode '${mode}'. Valid modes: guard, heartbeat.`);
  }
}

main().catch(err => {
  console.error(`[crash-watchdog] ${err.message}`);
  process.exit(1);
});
