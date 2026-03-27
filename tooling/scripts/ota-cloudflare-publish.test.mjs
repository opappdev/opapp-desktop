import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {
  applyBundlePublishOverrides,
  mergeRegistryIndexes,
  upsertBundleSidecars,
  withFileRollback,
} from './ota-cloudflare-publish.mjs';

test('mergeRegistryIndexes unions versions and prefers local channel mapping', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.0',
        versions: ['0.0.9', '0.1.0'],
        channels: {
          stable: '0.1.0',
          beta: '0.1.0-beta.1',
        },
        rolloutPercent: 20,
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.1',
        versions: ['0.1.0', '0.1.1'],
        channels: {
          stable: '0.1.1',
        },
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  const entry = merged.bundles['companion-app'];
  assert.deepEqual(entry.versions, ['0.0.9', '0.1.0', '0.1.1']);
  assert.equal(entry.latestVersion, '0.1.1');
  assert.deepEqual(entry.channels, {
    stable: '0.1.1',
    beta: '0.1.0-beta.1',
  });
  assert.equal(entry.rolloutPercent, 20);
});

test('applyBundlePublishOverrides removes rolloutPercent for full rollout', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.0',
        versions: ['0.1.0'],
        rolloutPercent: 30,
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.1.1',
        versions: ['0.1.1'],
        rolloutPercent: 100,
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  const overridden = applyBundlePublishOverrides(merged, {
    bundleId: 'companion-app',
    version: '0.1.1',
    channel: 'stable',
    rolloutPercent: 100,
  });
  const entry = overridden.bundles['companion-app'];
  assert.equal(entry.latestVersion, '0.1.1');
  assert.equal('rolloutPercent' in entry, false);
  assert.equal(entry.channels.stable, '0.1.1');
});

test('mergeRegistryIndexes keeps remote-only bundles', () => {
  const remote = {
    bundles: {
      'companion-app': {
        latestVersion: '0.2.0',
        versions: ['0.2.0'],
      },
      'legacy-bundle': {
        latestVersion: '9.9.9',
        versions: ['9.9.9'],
      },
    },
  };
  const local = {
    bundles: {
      'companion-app': {
        latestVersion: '0.2.1',
        versions: ['0.2.1'],
      },
    },
  };

  const merged = mergeRegistryIndexes(remote, local);
  assert.equal(merged.bundles['legacy-bundle'].latestVersion, '9.9.9');
  assert.deepEqual(merged.bundles['legacy-bundle'].versions, ['9.9.9']);
});

test('upsertBundleSidecars writes channels and removes rollout for 100%', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-cloudflare-publish-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleId = 'companion-app';
  const bundleRoot = path.join(fixtureRoot, bundleId);
  const channelsPath = path.join(bundleRoot, 'channels.json');
  const rolloutPath = path.join(bundleRoot, 'rollout.json');

  await upsertBundleSidecars(fixtureRoot, bundleId, 'beta', '0.2.0', 35);

  const firstChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  const firstRollout = JSON.parse(await readFile(rolloutPath, 'utf8'));
  assert.deepEqual(firstChannels, {beta: '0.2.0'});
  assert.equal(firstRollout.percent, 35);
  assert.equal(typeof firstRollout.updatedAt, 'string');

  await upsertBundleSidecars(fixtureRoot, bundleId, 'stable', '0.2.1', 100);

  const secondChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  assert.deepEqual(secondChannels, {
    beta: '0.2.0',
    stable: '0.2.1',
  });
  await assert.rejects(access(rolloutPath));
});

test('withFileRollback restores sidecar snapshots after failure', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'ota-cloudflare-publish-rollback-'));
  t.after(async () => {
    await rm(fixtureRoot, {recursive: true, force: true});
  });

  const bundleRoot = path.join(fixtureRoot, 'companion-app');
  const channelsPath = path.join(bundleRoot, 'channels.json');
  const rolloutPath = path.join(bundleRoot, 'rollout.json');

  await mkdir(bundleRoot, {recursive: true});
  await writeFile(channelsPath, JSON.stringify({stable: '0.1.0'}, null, 2) + '\n', 'utf8');
  await writeFile(rolloutPath, JSON.stringify({percent: 20}, null, 2) + '\n', 'utf8');

  await assert.rejects(
    withFileRollback([channelsPath, rolloutPath], async () => {
      await writeFile(channelsPath, JSON.stringify({stable: '0.2.0'}, null, 2) + '\n', 'utf8');
      await rm(rolloutPath, {force: true});
      throw new Error('simulated sidecar write failure');
    }),
  );

  const restoredChannels = JSON.parse(await readFile(channelsPath, 'utf8'));
  const restoredRollout = JSON.parse(await readFile(rolloutPath, 'utf8'));
  assert.deepEqual(restoredChannels, {stable: '0.1.0'});
  assert.deepEqual(restoredRollout, {percent: 20});
});
