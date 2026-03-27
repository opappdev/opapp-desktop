/**
 * OTA end-to-end smoke test (RFC-010 through RFC-015).
 *
 * Self-contained: creates a synthetic local artifact registry in a temp
 * directory, spins up an ephemeral localhost HTTP server, then drives the full
 * OTA pipeline to verify that rollout bucketing (RFC-014) and channel
 * resolution (RFC-015) behave correctly in combination.
 *
 * What is tested:
 *   1. generateRegistryIndex() emits versions, rolloutPercent, channels
 *   2. stable channel resolves the stable-pinned version
 *   3. beta channel resolves the beta-pinned version
 *   4. Device outside the 50 % rollout window → inRollout=false, hasUpdate=false
 *   5. Device inside  the 50 % rollout window → inRollout=true,  hasUpdate=true
 *   6. rolloutPercent absent (full rollout) → every device inRollout=true
 *   7. Unknown channel falls back to the stable channel entry
 *   8. No channels.json (absent) → RFC-010 backward-compat (overallLatest)
 *   9. apply / rollback replace directories cleanly without leaving stale files
 *
 * Usage:
 *   node ota-smoke.mjs
 *
 * Exit code 0 = all assertions passed.
 * Exit code 1 = one or more assertions failed (details written to stderr).
 */

import {createHash} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {generateRegistryIndex} from './artifact-source.mjs';
import {applyOtaUpdate, checkForUpdate, downloadOtaUpdate, readOtaState, rollbackOtaUpdate} from './ota-updater.mjs';

const _scriptDir = path.dirname(fileURLToPath(import.meta.url));

const BUNDLE_ID = 'opapp.smoke.bundle';
const PLATFORM = 'smoke';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;

function ok(cond, label) {
  if (cond) {
    process.stdout.write(`  \u2713  ${label}\n`);
    _passed++;
  } else {
    process.stderr.write(`  \u2717  ${label}\n`);
    _failed++;
  }
}

function eq(actual, expected, label) {
  const pass = actual === expected;
  if (pass) {
    process.stdout.write(`  \u2713  ${label} \u2192 ${JSON.stringify(actual)}\n`);
  } else {
    process.stderr.write(
      `  \u2717  ${label}\n` +
      `       expected ${JSON.stringify(expected)}\n` +
      `       actual   ${JSON.stringify(actual)}\n`,
    );
  }
  pass ? _passed++ : _failed++;
}

// ---------------------------------------------------------------------------
// Registry setup helpers
// ---------------------------------------------------------------------------

async function _createFakeBundle(registryRoot, bundleId, version, platform) {
  const dir = path.join(registryRoot, bundleId, version, platform);
  await mkdir(dir, {recursive: true});
  const entryFile = 'bundle.js';
  await writeFile(
    path.join(dir, entryFile),
    `// OTA smoke bundle: ${bundleId}@${version} [${platform}]\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, 'bundle-manifest.json'),
    JSON.stringify(
      {bundleId, version, platform, entryFile, sourceKind: 'local-build'},
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function _writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function _exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ephemeral local HTTP server (serves files from registryRoot)
// ---------------------------------------------------------------------------

async function _startServer(registryRoot) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(registryRoot, ...urlPath.split('/').filter(Boolean));
      try {
        const content = await readFile(filePath);
        const ct = filePath.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
        res.writeHead(200, {'Content-Type': ct});
        res.end(content);
      } catch {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      resolve({server, baseUrl: `http://127.0.0.1:${port}`});
    });

    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Rollout bucket (mirrors ota-updater.mjs _computeRolloutBucket exactly)
// ---------------------------------------------------------------------------

function _rolloutBucket(bundleId, deviceId) {
  const hex = createHash('sha256').update(`${bundleId}:${deviceId}`).digest('hex');
  return parseInt(hex.slice(0, 8), 16) % 100;
}

function _findDeviceInRollout(bundleId, threshold) {
  for (let i = 0; i < 10_000; i++) {
    const id = `smoke-device-${String(i).padStart(4, '0')}`;
    if (_rolloutBucket(bundleId, id) < threshold) return id;
  }
  throw new Error(`[ota-smoke] No device ID found inside rollout window (threshold=${threshold})`);
}

function _findDeviceOutOfRollout(bundleId, threshold) {
  for (let i = 0; i < 10_000; i++) {
    const id = `smoke-device-${String(i).padStart(4, '0')}`;
    if (_rolloutBucket(bundleId, id) >= threshold) return id;
  }
  throw new Error(`[ota-smoke] No device ID found outside rollout window (threshold=${threshold})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tmpBase = path.join(tmpdir(), `ota-smoke-${Date.now()}`);
  const registryRoot = path.join(tmpBase, 'registry');
  const cacheBase = path.join(tmpBase, 'cache');
  let server;

  process.stdout.write('OTA smoke test (RFC-010 \u2013 RFC-015)\n');

  try {
    // ── 1. Build synthetic registry ──────────────────────────────────────
    process.stdout.write('\n1. Build synthetic registry\n');

    await _createFakeBundle(registryRoot, BUNDLE_ID, '0.1.0', PLATFORM);
    await _createFakeBundle(registryRoot, BUNDLE_ID, '0.2.0', PLATFORM);

    await _writeJson(
      path.join(registryRoot, BUNDLE_ID, 'channels.json'),
      {stable: '0.1.0', beta: '0.2.0'},
    );
    await _writeJson(
      path.join(registryRoot, BUNDLE_ID, 'rollout.json'),
      {percent: 50, updatedAt: new Date().toISOString()},
    );

    // ── 2. generateRegistryIndex ──────────────────────────────────────────
    process.stdout.write('\n2. generateRegistryIndex (RFC-007 / RFC-014 / RFC-015)\n');

    const index = await generateRegistryIndex(registryRoot);
    const entry = index.bundles[BUNDLE_ID];

    ok(entry != null, 'bundle entry exists in index');
    eq(entry.latestVersion, '0.2.0', 'latestVersion = lexicographic-latest');
    ok(Array.isArray(entry.versions), 'versions is array');
    ok(entry.versions.includes('0.1.0'), 'versions includes 0.1.0');
    ok(entry.versions.includes('0.2.0'), 'versions includes 0.2.0');
    eq(entry.rolloutPercent, 50, 'rolloutPercent = 50 (from rollout.json)');
    eq(entry.channels?.stable, '0.1.0', 'channels.stable = 0.1.0');
    eq(entry.channels?.beta, '0.2.0', 'channels.beta = 0.2.0');

    await _writeJson(path.join(registryRoot, 'index.json'), index);

    // ── 3. Start local HTTP server ────────────────────────────────────────
    process.stdout.write('\n3. Start localhost registry server\n');

    ({server} = await _startServer(registryRoot));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.stdout.write(`   Listening at ${baseUrl}\n`);

    // Pre-compute device IDs that land inside / outside the 50 % window.
    const inDevice = _findDeviceInRollout(BUNDLE_ID, 50);
    const outDevice = _findDeviceOutOfRollout(BUNDLE_ID, 50);
    const inBucket = _rolloutBucket(BUNDLE_ID, inDevice);
    const outBucket = _rolloutBucket(BUNDLE_ID, outDevice);

    // ── 4. Channel resolution (RFC-015) ──────────────────────────────────
    process.stdout.write('\n4. checkForUpdate – channel resolution (RFC-015)\n');

    const stableResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'stable'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: inDevice,
      channel: 'stable',
    });
    eq(stableResult.channel, 'stable', 'resolved channel = stable');
    eq(stableResult.latestVersion, '0.1.0', 'stable channel → pinned version 0.1.0');
    ok(stableResult.hasUpdate === true, 'stable: hasUpdate=true (0.0.0 < 0.1.0, in rollout)');

    const betaResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'beta'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: inDevice,
      channel: 'beta',
    });
    eq(betaResult.channel, 'beta', 'resolved channel = beta');
    eq(betaResult.latestVersion, '0.2.0', 'beta channel → pinned version 0.2.0');
    ok(betaResult.hasUpdate === true, 'beta: hasUpdate=true (0.0.0 < 0.2.0, in rollout)');

    // ── 5. Staged rollout bucketing (RFC-014) ─────────────────────────────
    process.stdout.write('\n5. checkForUpdate – staged rollout bucketing (50 %)\n');

    const outResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'out'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: outDevice,
      channel: 'stable',
    });
    ok(
      outResult.inRollout === false,
      `out-of-rollout device (bucket=${outBucket} >= 50): inRollout=false`,
    );
    ok(outResult.hasUpdate === false, 'out-of-rollout device: hasUpdate=false');

    const inResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'in'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: inDevice,
      channel: 'stable',
    });
    ok(
      inResult.inRollout === true,
      `in-rollout device (bucket=${inBucket} < 50): inRollout=true`,
    );
    ok(inResult.hasUpdate === true, 'in-rollout device: hasUpdate=true');

    // ── 6. Full rollout (rolloutPercent absent) ───────────────────────────
    process.stdout.write('\n6. Full rollout: rollout.json deleted → all devices inRollout=true\n');

    await rm(path.join(registryRoot, BUNDLE_ID, 'rollout.json'), {force: true});
    const fullIndex = await generateRegistryIndex(registryRoot);
    await _writeJson(path.join(registryRoot, 'index.json'), fullIndex);

    ok(
      fullIndex.bundles[BUNDLE_ID].rolloutPercent === undefined,
      'rolloutPercent absent from index when rollout.json deleted',
    );

    const fullOutResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'full-out'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: outDevice,
      channel: 'stable',
    });
    ok(
      fullOutResult.inRollout === true,
      'full rollout: previously excluded device now inRollout=true',
    );
    ok(fullOutResult.hasUpdate === true, 'full rollout: hasUpdate=true for all devices');

    // ── 7. Channel fallback chain (RFC-015) ───────────────────────────────
    process.stdout.write('\n7. Channel fallback: unknown channel \u2192 stable \u2192 overallLatest\n');

    // Restore rollout.json so rollout checks remain meaningful.
    await _writeJson(
      path.join(registryRoot, BUNDLE_ID, 'rollout.json'),
      {percent: 50},
    );
    await _writeJson(
      path.join(registryRoot, 'index.json'),
      await generateRegistryIndex(registryRoot),
    );

    // 'nightly' is not in channels.json → falls back to 'stable' entry (0.1.0).
    const nightlyResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'nightly'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: inDevice,
      channel: 'nightly',
    });
    eq(
      nightlyResult.latestVersion,
      '0.1.0',
      'nightly (unknown) falls back to stable channel version (0.1.0)',
    );

    // ── 8. Backward compat: no channels.json → RFC-010 behaviour ──────────
    process.stdout.write('\n8. Backward compat: no channels.json \u2192 RFC-010 behaviour\n');

    await rm(path.join(registryRoot, BUNDLE_ID, 'channels.json'), {force: true});
    await rm(path.join(registryRoot, BUNDLE_ID, 'rollout.json'), {force: true});
    await _writeJson(
      path.join(registryRoot, 'index.json'),
      await generateRegistryIndex(registryRoot),
    );

    const compatResult = await checkForUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: path.join(cacheBase, 'compat'),
      bundleId: BUNDLE_ID,
      currentVersion: '0.0.0',
      deviceId: inDevice,
      // channel omitted → defaults to 'stable' → no channels map → overallLatest
    });
    eq(compatResult.latestVersion, '0.2.0', 'no channels.json → overallLatest (0.2.0)');
    ok(compatResult.inRollout === true, 'no rollout.json → always inRollout=true');
    ok(compatResult.hasUpdate === true, 'backward compat: hasUpdate=true');

    // ── 9. Apply / rollback replace directories cleanly ────────────────────
    process.stdout.write('\n9. apply / rollback replace directories cleanly\n');

    const applyCacheDir = path.join(tmpBase, 'apply-cache');
    const hostBundleDir = path.join(tmpBase, 'host-bundle');
    const v2Dir = path.join(applyCacheDir, BUNDLE_ID, '0.2.0', PLATFORM);
    const v3Dir = path.join(applyCacheDir, BUNDLE_ID, '0.3.0', PLATFORM);

    await _createFakeBundle(applyCacheDir, BUNDLE_ID, '0.2.0', PLATFORM);
    await _createFakeBundle(applyCacheDir, BUNDLE_ID, '0.3.0', PLATFORM);
    await mkdir(hostBundleDir, {recursive: true});
    await writeFile(
      path.join(hostBundleDir, 'bundle-manifest.json'),
      JSON.stringify(
        {
          bundleId: BUNDLE_ID,
          version: '0.1.0',
          platform: PLATFORM,
          entryFile: 'bundle.js',
          sourceKind: 'local-build',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await writeFile(path.join(hostBundleDir, 'bundle.js'), '// host bundle: 0.1.0\n', 'utf8');
    await writeFile(path.join(hostBundleDir, 'only-in-v1.txt'), 'v1\n', 'utf8');
    await writeFile(path.join(v2Dir, 'only-in-v2.txt'), 'v2\n', 'utf8');

    await applyOtaUpdate({
      cacheDir: applyCacheDir,
      hostBundleDir,
      platform: PLATFORM,
      bundleId: BUNDLE_ID,
      version: '0.2.0',
    });
    ok(
      !(await _exists(path.join(hostBundleDir, 'only-in-v1.txt'))),
      'apply removes files that exist only in the previous host bundle',
    );
    ok(
      await _exists(path.join(hostBundleDir, 'only-in-v2.txt')),
      'apply keeps files that belong to the staged target version',
    );
    eq(
      JSON.parse(await readFile(path.join(hostBundleDir, 'bundle-manifest.json'), 'utf8')).sourceKind,
      'sibling-staging',
      'apply rewrites sourceKind on the clean staged copy',
    );

    await applyOtaUpdate({
      cacheDir: applyCacheDir,
      hostBundleDir,
      platform: PLATFORM,
      bundleId: BUNDLE_ID,
      version: '0.3.0',
    });
    ok(
      !(await _exists(path.join(hostBundleDir, 'only-in-v2.txt'))),
      'second apply removes files that are absent from the newer version',
    );

    await rollbackOtaUpdate({
      cacheDir: applyCacheDir,
      hostBundleDir,
      bundleId: BUNDLE_ID,
      platform: PLATFORM,
    });
    ok(
      await _exists(path.join(hostBundleDir, 'only-in-v2.txt')),
      'rollback restores files from the immediately previous snapshot',
    );
    ok(
      !(await _exists(path.join(hostBundleDir, 'only-in-v1.txt'))),
      'rollback does not leak files from older snapshots into the restored bundle',
    );

    // ── 10. download → apply → rollback (full HTTP end-to-end) ────────────
    process.stdout.write('\n10. download \u2192 apply \u2192 rollback (full HTTP end-to-end)\n');

    // The registry still has BUNDLE_ID@0.1.0 and @0.2.0 with no channels/rollout
    // (state from section 8). Use a fresh cache and host dir for isolation.
    const dlCacheDir = path.join(tmpBase, 'dl-cache');
    const dlHostDir = path.join(tmpBase, 'dl-host');

    // Simulate a host that already has version 0.1.0 installed.
    await mkdir(dlHostDir, {recursive: true});
    await writeFile(
      path.join(dlHostDir, 'bundle-manifest.json'),
      JSON.stringify(
        {bundleId: BUNDLE_ID, version: '0.1.0', platform: PLATFORM, entryFile: 'bundle.js', sourceKind: 'sibling-staging'},
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await writeFile(path.join(dlHostDir, 'bundle.js'), '// host 0.1.0\n', 'utf8');
    await writeFile(path.join(dlHostDir, 'only-in-v1.txt'), 'v1\n', 'utf8');

    // download: pull latest from the local HTTP server into dlCacheDir
    const dlResult = await downloadOtaUpdate({
      remoteBase: baseUrl,
      platform: PLATFORM,
      cacheDir: dlCacheDir,
      bundleId: BUNDLE_ID,
    });
    eq(dlResult.bundleId, BUNDLE_ID, 'download: bundleId matches');
    eq(dlResult.version, '0.2.0', 'download: resolves to latest version 0.2.0');
    ok(
      await _exists(path.join(dlCacheDir, BUNDLE_ID, '0.2.0', PLATFORM, 'bundle-manifest.json')),
      'download: bundle-manifest.json written to local cache',
    );
    ok(
      await _exists(path.join(dlCacheDir, BUNDLE_ID, '0.2.0', PLATFORM, 'bundle.js')),
      'download: bundle.js written to local cache',
    );

    // ota-state.json should record the downloaded version
    const dlState = await readOtaState(dlCacheDir);
    eq(dlState?.bundleId, BUNDLE_ID, 'download: ota-state records bundleId');
    eq(dlState?.version, '0.2.0', 'download: ota-state records version 0.2.0');

    // apply: stage the downloaded bundle into the host dir
    const dlApplyResult = await applyOtaUpdate({
      cacheDir: dlCacheDir,
      hostBundleDir: dlHostDir,
      platform: PLATFORM,
    });
    eq(dlApplyResult.version, '0.2.0', 'apply (post-download): version = 0.2.0');
    ok(
      !(await _exists(path.join(dlHostDir, 'only-in-v1.txt'))),
      'apply (post-download): stale v0.1.0 file removed from host dir',
    );
    eq(
      JSON.parse(await readFile(path.join(dlHostDir, 'bundle-manifest.json'), 'utf8')).sourceKind,
      'sibling-staging',
      'apply (post-download): sourceKind = sibling-staging',
    );

    // rollback: restore the pre-apply snapshot (v0.1.0)
    const dlRbResult = await rollbackOtaUpdate({
      cacheDir: dlCacheDir,
      hostBundleDir: dlHostDir,
      bundleId: BUNDLE_ID,
      platform: PLATFORM,
    });
    eq(dlRbResult.rolledBackToVersion, '0.1.0', 'rollback (post-download-apply): restores to 0.1.0');
    ok(
      await _exists(path.join(dlHostDir, 'only-in-v1.txt')),
      'rollback (post-download-apply): v0.1.0 file restored',
    );
    eq(
      JSON.parse(await readFile(path.join(dlHostDir, 'bundle-manifest.json'), 'utf8')).version,
      '0.1.0',
      'rollback (post-download-apply): bundle-manifest.json version reverts to 0.1.0',
    );

    // ── Summary ───────────────────────────────────────────────────────────
    process.stdout.write(`\n${'─'.repeat(48)}\n`);
    process.stdout.write(`  Results: ${_passed} passed, ${_failed} failed\n`);

    if (_failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (server) server.close();
    await rm(tmpBase, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  process.stderr.write(`[ota-smoke] Fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
